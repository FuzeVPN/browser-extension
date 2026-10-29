// SPDX-License-Identifier: MPL-2.0

import { ApiError, NetworkError } from "../../src/core/api/client";
import { SafetyError } from "../../src/core/background/network-safety";
import { ALARM_EXPIRY, ALARM_RECONNECT, ALARM_REFRESH } from "../../src/core/shared/config";
import { DEFAULT_SECURITY_STATE } from "../../src/core/shared/security";
import { AUTH, NOW, authenticatedState, createHarness, proxySession } from "./helpers";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function connected() {
  const harness = createHarness({ persisted: authenticatedState() });
  await harness.controller.initialize();
  await harness.controller.connect("frankfurt-01");
  expect(harness.controller.getSnapshot().protected).toBe(true);
  return harness;
}

describe("network protection lifecycle", () => {
  it("arms both protections before asking the server for connection credentials", async () => {
    const harness = createHarness({ persisted: authenticatedState() });
    await harness.controller.initialize();
    const create = harness.api.createProxySession.bind(harness.api);
    vi.spyOn(harness.api, "createProxySession").mockImplementation(async (...args) => {
      expect(harness.safety.status).toEqual({
        trafficBlocked: true,
        filterActive: true,
        webRtcProtected: true,
      });
      expect(harness.securityStorage.state?.protectionRequested).toBe(true);
      return create(...args);
    });
    await harness.controller.connect("frankfurt-01");
    expect(harness.controller.getSnapshot()).toMatchObject({
      status: "connected",
      protected: true,
      trafficBlocked: false,
      webRtcProtected: true,
      securityPreferences: { killSwitchEnabled: true, webRtcProtectionEnabled: true },
    });
  });

  it("blocks during complete-browser restoration until credentials have been rebuilt", async () => {
    const wait = deferred();
    const harness = createHarness({
      persisted: authenticatedState({ autoConnect: true }),
      activeProxy: proxySession("old-browser-session"),
    });
    harness.api.createWait = wait.promise;
    const restoring = harness.controller.initialize();
    await vi.waitFor(() => expect(harness.api.proofs).toHaveLength(1));
    expect(harness.safety.status.trafficBlocked).toBe(true);
    expect(harness.controller.getSnapshot().protected).toBe(false);
    wait.resolve();
    await restoring;
    expect(harness.controller.getSnapshot()).toMatchObject({
      protected: true,
      trafficBlocked: false,
    });
  });

  it("retains an armed guard with an expired API account and enables explicit release without login", async () => {
    const harness = createHarness({
      persisted: authenticatedState({
        auth: { ...AUTH, expiresAt: new Date(NOW - 1).toISOString() },
      }),
      security: {
        ...DEFAULT_SECURITY_STATE,
        protectionRequested: true,
        selectedLocationId: "frankfurt-01",
      },
      activeProxy: proxySession(),
    });
    await harness.controller.initialize();
    expect(harness.storage.persisted.auth).toBeNull();
    expect(harness.controller.getSnapshot()).toMatchObject({
      status: "blocked",
      trafficBlocked: true,
      protected: false,
      nextRetryAt: null,
    });
    expect(harness.proxy.active).not.toBeNull();
    await harness.controller.disconnect();
    expect(harness.controller.getSnapshot()).toMatchObject({
      status: "logged_out",
      protectionRequested: false,
      trafficBlocked: false,
      webRtcProtected: false,
    });
    expect(harness.proxy.active).toBeNull();
  });

  it("does not apply late server credentials after explicit disconnect (SEC-02)", async () => {
    const harness = createHarness({ persisted: authenticatedState() });
    await harness.controller.initialize();
    const wait = deferred();
    harness.api.createWait = wait.promise;
    harness.api.ignoreCreateAbort = true;
    const connecting = harness.controller.connect("frankfurt-01");
    await vi.waitFor(() => expect(harness.api.proofs).toHaveLength(1));
    await harness.controller.disconnect();
    wait.resolve();
    await connecting;
    expect(harness.proxy.active).toBeNull();
    expect(harness.proxy.applyCalls).toBe(0);
    expect(harness.controller.getSnapshot()).toMatchObject({
      protected: false,
      protectionRequested: false,
      trafficBlocked: false,
    });
    expect(harness.api.revoked).toContain("proxy-session-1");
  });

  it("serializes disconnect behind an already-running proxy write (SEC-02)", async () => {
    const harness = createHarness({ persisted: authenticatedState() });
    await harness.controller.initialize();
    const wait = deferred();
    harness.proxy.applyWait = wait.promise;
    const connecting = harness.controller.connect("frankfurt-01");
    await vi.waitFor(() => expect(harness.proxy.applyCalls).toBe(1));
    const disconnecting = harness.controller.disconnect();
    await vi.waitFor(() => expect(harness.controller.getSnapshot().status).toBe("disconnecting"));
    wait.resolve();
    await Promise.all([connecting, disconnecting]);
    expect(harness.proxy.active).toBeNull();
    expect(harness.safety.status.trafficBlocked).toBe(false);
    expect(harness.controller.getSnapshot()).toMatchObject({
      protected: false,
      protectionRequested: false,
      status: "disconnected",
    });
  });

  it("cannot resurrect a renewed session after the expiry alarm has revoked authorization (SEC-01)", async () => {
    const harness = await connected();
    const wait = deferred();
    harness.api.createWait = wait.promise;
    harness.api.ignoreCreateAbort = true;
    harness.api.sessions = [
      proxySession("late-renewal", "frankfurt-01", "2026-08-26T12:08:00Z", "2026-08-26T12:20:00Z"),
    ];
    const renewing = harness.controller.handleAlarm(ALARM_REFRESH);
    await vi.waitFor(() => expect(harness.api.proofs).toHaveLength(2));
    harness.setNow(Date.parse("2026-08-26T12:10:01Z"));
    await harness.controller.handleAlarm(ALARM_EXPIRY);
    wait.resolve();
    await renewing;
    expect(harness.controller.getSnapshot()).toMatchObject({
      protected: false,
      trafficBlocked: true,
      status: "blocked",
    });
    expect(await harness.controller.getActiveSession()).toBeNull();
    expect(harness.proxy.active?.id).not.toBe("late-renewal");
    expect(harness.api.revoked).toContain("late-renewal");
  });

  it("keeps a valid old session authorized after an ambiguous refresh response", async () => {
    const harness = await connected();
    harness.api.createError = new NetworkError("network");
    await harness.controller.handleAlarm(ALARM_REFRESH);
    expect(harness.controller.getSnapshot()).toMatchObject({
      protected: true,
      trafficBlocked: false,
      status: "connected",
      error: "proxy_creation_uncertain",
    });
    expect(harness.proxy.active?.id).toBe("proxy-session-1");
  });

  it("ignores an isolated failed request but blocks a proxy certificate failure", async () => {
    const harness = await connected();
    const clears = harness.proxy.clearCalls;
    await harness.controller.handleProxyError("net::ERR_CONNECTION_RESET", true);
    expect(harness.controller.getSnapshot()).toMatchObject({
      protected: true,
      trafficBlocked: false,
    });
    await harness.controller.handleProxyError("net::ERR_PROXY_CERTIFICATE_INVALID", true);
    expect(harness.controller.getSnapshot()).toMatchObject({
      protected: false,
      trafficBlocked: true,
      nextRetryAt: NOW + 30_000,
    });
    expect(harness.proxy.clearCalls).toBe(clears);
    expect(await harness.controller.getActiveSession()).toBeNull();
  });

  it("uses persistent reconnect backoff of 30, 60, 120, then 300 seconds", async () => {
    const harness = createHarness({ persisted: authenticatedState() });
    await harness.controller.initialize();
    vi.spyOn(harness.api, "getProfile").mockRejectedValue(new NetworkError("network"));
    await harness.controller.connect("frankfurt-01");
    let now = NOW;
    for (const delay of [30_000, 60_000, 120_000, 300_000, 300_000]) {
      expect(harness.alarms.reconnectAt).toBe(now + delay);
      expect(harness.securityStorage.state?.nextRetryAt).toBe(now + delay);
      expect(harness.controller.getSnapshot().trafficBlocked).toBe(true);
      now += delay;
      harness.setNow(now);
      await harness.controller.handleAlarm(ALARM_RECONNECT);
    }
  });

  it("respects a longer server retry delay", async () => {
    const harness = createHarness({ persisted: authenticatedState() });
    await harness.controller.initialize();
    harness.api.createError = new ApiError("rate_limited", 429, 700);
    await harness.controller.connect("frankfurt-01");
    expect(harness.alarms.reconnectAt).toBe(NOW + 700_000);
  });

  it.each([
    "device_limit",
    "device_identity_revoked",
    "email_verification_required",
    "subscription_required",
  ])("keeps the guard and suspends retries when user action is needed: %s", async (code) => {
    const harness = createHarness({ persisted: authenticatedState() });
    await harness.controller.initialize();
    harness.api.createError = new ApiError(code, 403);
    await harness.controller.connect("frankfurt-01");
    expect(harness.controller.getSnapshot()).toMatchObject({
      trafficBlocked: true,
      protected: false,
      nextRetryAt: null,
      error: code === "device_identity_revoked" ? "proxy_unavailable" : code,
    });
    if (code === "device_identity_revoked") {
      expect(harness.api.proofs).toHaveLength(2);
      expect(harness.api.enrollCalls).toBe(2);
      expect(harness.snapshots.some((snapshot) => snapshot.error === code)).toBe(false);
    }
    expect(harness.alarms.reconnectAt).toBeNull();
  });

  it("erases an invalid account while retaining requested protection", async () => {
    const harness = await connected();
    vi.spyOn(harness.api, "getProfile").mockRejectedValue(new ApiError("unauthorized", 401));
    await harness.controller.refreshAccount();
    expect(harness.storage.persisted.auth).toBeNull();
    expect(harness.storage.persisted.profile).toBeNull();
    expect(harness.controller.getSnapshot()).toMatchObject({
      trafficBlocked: true,
      protectionRequested: true,
      protected: false,
      nextRetryAt: null,
    });
  });

  it("preserves independent preference choices after voluntary account logout", async () => {
    const harness = await connected();
    await harness.controller.updateSecurityPreferences(false, true);
    await harness.controller.logout();
    expect(harness.securityStorage.state).toMatchObject({
      killSwitchEnabled: false,
      webRtcProtectionEnabled: true,
      protectionRequested: false,
    });
    expect(harness.controller.getSnapshot()).toMatchObject({
      status: "logged_out",
      trafficBlocked: false,
      webRtcProtected: false,
    });
  });

  it("reopens ordinary navigation when the kill switch is disabled during a failed connection", async () => {
    const harness = createHarness({ persisted: authenticatedState() });
    await harness.controller.initialize();
    harness.api.createError = new NetworkError("network");
    await harness.controller.connect("frankfurt-01");
    await harness.controller.updateSecurityPreferences(false, true);
    expect(harness.controller.getSnapshot()).toMatchObject({
      trafficBlocked: false,
      webRtcProtected: true,
      protected: false,
    });
    expect(harness.safety.status.filterActive).toBe(true);
    expect(harness.proxy.active).toBeNull();
  });

  it("applies WebRTC preferences independently while a valid session stays protected", async () => {
    const harness = await connected();
    await harness.controller.updateSecurityPreferences(true, false);
    expect(harness.controller.getSnapshot()).toMatchObject({
      protected: true,
      trafficBlocked: false,
      webRtcProtected: false,
    });
    await harness.controller.updateSecurityPreferences(true, true);
    expect(harness.controller.getSnapshot()).toMatchObject({
      protected: true,
      trafficBlocked: false,
      webRtcProtected: true,
    });
  });

  it("fails closed if persisted protection intent cannot be read", async () => {
    const harness = createHarness({ persisted: authenticatedState(), activeProxy: proxySession() });
    vi.spyOn(harness.securityStorage, "read").mockRejectedValue(
      new Error("security_storage_failed"),
    );
    await harness.controller.initialize();
    expect(harness.controller.getSnapshot()).toMatchObject({
      protected: false,
      trafficBlocked: true,
      protectionRequested: true,
    });
    expect(harness.proxy.clearCalls).toBe(0);
  });

  it("does not claim protection when the rule API rejected the guard", async () => {
    const harness = createHarness({ persisted: authenticatedState() });
    await harness.controller.initialize();
    vi.spyOn(harness.safety, "block").mockRejectedValue(new SafetyError("traffic_guard_failed"));
    await harness.controller.connect("frankfurt-01");
    expect(harness.controller.getSnapshot()).toMatchObject({
      protected: false,
      trafficBlocked: false,
      error: "traffic_guard_failed",
    });
    expect(harness.safety.events).not.toContain("allow");
    expect(harness.api.proofs).toHaveLength(0);
  });

  it("retains the guard when security preferences cannot be persisted", async () => {
    const harness = createHarness({ persisted: authenticatedState() });
    await harness.controller.initialize();
    vi.spyOn(harness.securityStorage, "write").mockRejectedValue(new Error("disk unavailable"));
    await harness.controller.connect("frankfurt-01");
    expect(harness.controller.getSnapshot()).toMatchObject({
      protected: false,
      trafficBlocked: true,
      error: "traffic_guard_failed",
      nextRetryAt: null,
    });
    expect(harness.api.proofs).toHaveLength(0);
  });

  it("blocks and suspends retries if Chrome no longer permits the requested WebRTC setting", async () => {
    const harness = await connected();
    harness.safety.status.webRtcProtected = false;
    vi.spyOn(harness.safety, "setWebRtc").mockRejectedValue(
      new SafetyError("webrtc_control_unavailable"),
    );
    await harness.controller.handlePrivacyChange();
    expect(harness.controller.getSnapshot()).toMatchObject({
      protected: false,
      trafficBlocked: false,
      blockingScope: "unverified",
      webRtcProtected: false,
      error: "webrtc_control_unavailable",
      nextRetryAt: null,
    });
    expect(harness.safety.status.filterActive).toBe(true);
  });

  it("does not claim protection merely because an account refresh interrupted a pending proxy write", async () => {
    const harness = createHarness({ persisted: authenticatedState() });
    await harness.controller.initialize();
    const wait = deferred();
    harness.proxy.applyWait = wait.promise;
    const connecting = harness.controller.connect("frankfurt-01");
    await vi.waitFor(() => expect(harness.proxy.applyCalls).toBe(1));
    const refreshing = harness.controller.refreshAccount();
    // Let refreshAccount reach its operation boundary before completing the proxy write.
    await Promise.resolve();
    wait.resolve();
    await Promise.all([connecting, refreshing]);
    const snapshot = harness.controller.getSnapshot();
    expect(snapshot.protected && snapshot.trafficBlocked).toBe(false);
    if (snapshot.protected) expect(harness.safety.events).toContain("allow");
  });

  it("keeps a user-action retry suspension across a browser restart", async () => {
    const harness = createHarness({
      persisted: authenticatedState(),
      security: {
        ...DEFAULT_SECURITY_STATE,
        protectionRequested: true,
        retrySuspended: true,
        selectedLocationId: "frankfurt-01",
      },
    });
    await harness.controller.initialize();
    expect(harness.api.proofs).toHaveLength(0);
    expect(harness.controller.getSnapshot()).toMatchObject({
      protected: false,
      trafficBlocked: true,
      nextRetryAt: null,
    });
    await harness.controller.retryConnection();
    expect(harness.controller.getSnapshot()).toMatchObject({
      protected: true,
      trafficBlocked: false,
    });
    expect(harness.securityStorage.state?.retrySuspended).toBe(false);
  });

  it("restores a pending reconnect time without retrying ahead of it", async () => {
    const harness = createHarness({
      persisted: authenticatedState(),
      security: {
        ...DEFAULT_SECURITY_STATE,
        protectionRequested: true,
        selectedLocationId: "frankfurt-01",
        reconnectAttempts: 3,
        nextRetryAt: NOW + 120_000,
      },
    });
    await harness.controller.initialize();
    expect(harness.api.proofs).toHaveLength(0);
    expect(harness.alarms.reconnectAt).toBe(NOW + 120_000);
    await harness.controller.handleAlarm(ALARM_RECONNECT);
    expect(harness.api.proofs).toHaveLength(0);
    harness.setNow(NOW + 120_000);
    await harness.controller.handleAlarm(ALARM_RECONNECT);
    expect(harness.controller.getSnapshot().protected).toBe(true);
    expect(harness.securityStorage.state?.reconnectAttempts).toBe(0);
    expect(harness.securityStorage.state?.nextRetryAt).toBeNull();
  });

  it("preserves a refresh Retry-After deadline when the old session later expires", async () => {
    const harness = await connected();
    harness.api.createError = new ApiError("rate_limited", 429, 900);
    await harness.controller.handleAlarm(ALARM_REFRESH);
    expect(harness.controller.getSnapshot().protected).toBe(true);
    expect(harness.securityStorage.state?.retryNotBefore).toBe(NOW + 900_000);
    harness.setNow(NOW + 601_000);
    await harness.controller.handleAlarm(ALARM_EXPIRY);
    expect(harness.controller.getSnapshot()).toMatchObject({
      protected: false,
      trafficBlocked: true,
    });
    expect(harness.alarms.reconnectAt).toBe(NOW + 900_000);
  });

  it("does not authorize a session that expired while Chrome acknowledged its allowance", async () => {
    const harness = createHarness({ persisted: authenticatedState() });
    await harness.controller.initialize();
    const allow = harness.safety.allow.bind(harness.safety);
    vi.spyOn(harness.safety, "allow").mockImplementation(async () => {
      await allow();
      harness.setNow(NOW + 601_000);
    });
    await harness.controller.connect("frankfurt-01");
    expect(harness.controller.getSnapshot()).toMatchObject({
      protected: false,
      trafficBlocked: true,
    });
    expect(harness.snapshots.some((snapshot) => snapshot.protected)).toBe(false);
  });

  it("keeps an honest blocking state when Chrome fails to release the guard on logout", async () => {
    const harness = await connected();
    vi.spyOn(harness.safety, "release").mockRejectedValue(new SafetyError("traffic_guard_failed"));
    await harness.controller.logout();
    expect(harness.storage.persisted.auth).toBeNull();
    expect(harness.controller.getSnapshot()).toMatchObject({
      protected: false,
      trafficBlocked: true,
      error: "traffic_guard_failed",
    });
    expect(harness.securityStorage.state?.protectionRequested).toBe(true);
    expect(harness.alarms.reconnectAt).toBeNull();
  });

  it("restarts connection safely when preferences interrupt an unverified proxy write", async () => {
    const harness = createHarness({ persisted: authenticatedState() });
    await harness.controller.initialize();
    harness.api.sessions = [
      proxySession("cancelled-staged-session"),
      proxySession("authorized-replacement"),
    ];
    const wait = deferred();
    harness.proxy.applyWait = wait.promise;
    const connecting = harness.controller.connect("frankfurt-01");
    await vi.waitFor(() => expect(harness.proxy.applyCalls).toBe(1));
    const changing = harness.controller.updateSecurityPreferences(true, false);
    await Promise.resolve();
    harness.proxy.applyWait = null;
    wait.resolve();
    await Promise.all([connecting, changing]);
    expect(harness.controller.getSnapshot()).toMatchObject({
      protected: true,
      trafficBlocked: false,
      webRtcProtected: false,
    });
    expect(harness.proxy.active?.id).toBe("authorized-replacement");
    expect(harness.api.revoked).toContain("cancelled-staged-session");
    expect(harness.api.revoked).not.toContain("authorized-replacement");
  });

  it("does not fall back to a staged session revoked by an interrupted connect", async () => {
    const harness = createHarness({ persisted: authenticatedState() });
    await harness.controller.initialize();
    harness.api.sessions = [proxySession("cancelled-staged-session")];
    const wait = deferred();
    harness.proxy.applyWait = wait.promise;
    const connecting = harness.controller.connect("frankfurt-01");
    await vi.waitFor(() => expect(harness.proxy.applyCalls).toBe(1));
    harness.api.createError = new NetworkError("network");
    const changing = harness.controller.changeLocation("frankfurt-02");
    await Promise.resolve();
    wait.resolve();
    await Promise.all([connecting, changing]);
    expect(harness.controller.getSnapshot()).toMatchObject({
      protected: false,
      trafficBlocked: true,
    });
    expect(harness.api.revoked).toContain("cancelled-staged-session");
  });

  it("does not cancel a browser connection when deleting a different account device", async () => {
    const harness = createHarness({ persisted: authenticatedState() });
    await harness.controller.initialize();
    const wait = deferred();
    harness.api.createWait = wait.promise;
    const connecting = harness.controller.connect("frankfurt-01");
    await vi.waitFor(() => expect(harness.api.proofs).toHaveLength(1));
    await harness.controller.deleteDevice("some-other-device");
    wait.resolve();
    await connecting;
    expect(harness.controller.getSnapshot()).toMatchObject({
      protected: true,
      trafficBlocked: false,
    });
    expect(harness.api.revoked).not.toContain(harness.proxy.active?.id);
  });
});
