// SPDX-License-Identifier: MPL-2.0

import { ApiError, NetworkError } from "../../src/core/api/client";
import { ALARM_REFRESH } from "../../src/core/shared/config";
import {
  ACTIVE_SUBSCRIPTION,
  AUTH,
  INACTIVE_SUBSCRIPTION,
  NOW,
  PROFILE,
  authenticatedState,
  createHarness,
  proxySession,
} from "./helpers";

describe("connection state machine", () => {
  it("restores an authenticated disconnected account", async () => {
    const harness = createHarness({ persisted: authenticatedState() });
    await harness.controller.initialize();
    expect(harness.controller.getSnapshot()).toMatchObject({
      status: "disconnected",
      profile: PROFILE,
      subscription: ACTIVE_SUBSCRIPTION,
    });
    expect(harness.storage.trustedConfigured).toBe(true);
  });

  it("expires an API token and clears a dangling proxy", async () => {
    const session = proxySession();
    const harness = createHarness({
      persisted: authenticatedState({ auth: { ...AUTH, expiresAt: "2026-08-26T11:59:59Z" } }),
      transient: { proxySession: session, refreshAttempts: 0, retiredSessions: [] },
      activeProxy: session,
    });
    await harness.controller.initialize();
    expect(harness.controller.getSnapshot().status).toBe("logged_out");
    expect(harness.storage.transient.proxySession).toBeNull();
    expect(harness.proxy.active).toBeNull();
  });

  it("refuses proxy creation when the subscription has no access", async () => {
    const harness = createHarness({ persisted: authenticatedState() });
    harness.api.subscription = INACTIVE_SUBSCRIPTION;
    await harness.controller.initialize();
    await harness.controller.connect("frankfurt-01");
    expect(harness.controller.getSnapshot()).toMatchObject({
      status: "blocked",
      protected: false,
      trafficBlocked: true,
      error: "subscription_required",
    });
    expect(harness.storage.transient.proxySession).toBeNull();
  });

  it("refreshes a subscription after it changes outside the extension", async () => {
    const harness = createHarness({ persisted: authenticatedState() });
    harness.api.subscription = INACTIVE_SUBSCRIPTION;
    await harness.controller.initialize();
    // Local startup no longer waits for the best-effort remote account refresh.
    await vi.waitFor(() =>
      expect(harness.controller.getSnapshot().subscription?.hasAccess).toBe(false),
    );

    harness.api.subscription = ACTIVE_SUBSCRIPTION;
    await harness.controller.refreshAccount();

    expect(harness.controller.getSnapshot()).toMatchObject({
      status: "disconnected",
      subscription: ACTIVE_SUBSCRIPTION,
      error: null,
    });
    expect(harness.storage.persisted.subscription).toEqual(ACTIVE_SUBSCRIPTION);
  });

  it("creates a session, applies the proxy and persists only transient credentials", async () => {
    const harness = createHarness({ persisted: authenticatedState() });
    const session = proxySession();
    harness.api.sessions = [session];
    await harness.controller.initialize();
    await harness.controller.connect("frankfurt-01");
    expect(harness.controller.getSnapshot()).toMatchObject({
      status: "connected",
      protected: true,
      activeLocationId: "frankfurt-01",
      autoConnect: true,
    });
    expect(harness.proxy.active?.id).toBe(session.id);
    expect(harness.storage.transient.proxySession?.password).toBe(session.password);
    expect(JSON.stringify(harness.storage.persisted)).not.toContain(session.password);
  });

  it("enrolls one browser device on first use and reuses it for later sessions", async () => {
    const harness = createHarness({ persisted: authenticatedState() });
    harness.api.sessions = [proxySession("first"), proxySession("second")];
    await harness.controller.initialize();

    await harness.controller.connect("frankfurt-01");
    await harness.controller.disconnect();
    await harness.controller.connect("frankfurt-01");

    expect(harness.api.enrollCalls).toBe(1);
    expect(harness.identity.keyGenerations).toBe(1);
    expect(harness.identity.deviceId).toBe("browser-device-1");
    expect(harness.api.proofs).toHaveLength(2);
    expect(harness.api.proofs.every(({ deviceId }) => deviceId === "browser-device-1")).toBe(true);
  });

  it("retries a replayed device proof once with a fresh nonce", async () => {
    const harness = createHarness({ persisted: authenticatedState() });
    harness.api.replayProofOnce = true;
    await harness.controller.initialize();

    await harness.controller.connect("frankfurt-01");

    expect(harness.controller.getSnapshot().status).toBe("connected");
    expect(harness.api.proofs).toHaveLength(2);
    expect(harness.api.proofs[0]?.deviceNonce).not.toBe(harness.api.proofs[1]?.deviceNonce);
  });

  it("reports the two-device quota without persisting a device id", async () => {
    const harness = createHarness({ persisted: authenticatedState() });
    harness.api.enrollError = new ApiError("device_limit", 409);
    await harness.controller.initialize();

    await harness.controller.connect("frankfurt-01");

    expect(harness.controller.getSnapshot()).toMatchObject({
      status: "blocked",
      protected: false,
      trafficBlocked: true,
      error: "device_limit",
    });
    expect(harness.identity.deviceId).toBeNull();
  });

  it("lists devices and clears the local identity when deleting the current browser device", async () => {
    const session = proxySession();
    const harness = createHarness({
      persisted: authenticatedState({ autoConnect: true }),
      transient: { proxySession: session, refreshAttempts: 0, retiredSessions: [] },
      activeProxy: session,
    });
    harness.identity.deviceId = "browser-device-1";
    harness.api.devices = {
      limit: 2,
      devices: [
        {
          deviceId: "browser-device-1",
          name: "Chrome",
          kind: "browser_extension",
          profiles: [
            {
              protocol: "browser_proxy",
              status: "active",
              createdAt: "2026-08-26T12:00:00Z",
              expiresAt: null,
            },
          ],
          createdAt: "2026-08-26T12:00:00Z",
        },
      ],
    };
    await harness.controller.initialize();
    await harness.controller.refreshDevices();
    expect(harness.controller.getSnapshot()).toMatchObject({
      deviceLimit: 2,
      currentDeviceId: "browser-device-1",
    });

    await harness.controller.deleteDevice("browser-device-1");

    expect(harness.proxy.active).toBeNull();
    expect(harness.api.revoked).toContain(session.id);
    expect(harness.api.deletedDevices).toContain("browser-device-1");
    expect(harness.identity.deviceId).toBeNull();
    expect(harness.identity.clearCalls).toBe(1);
    expect(harness.controller.getSnapshot()).toMatchObject({
      devices: [],
      currentDeviceId: null,
      protected: false,
    });
  });

  it("restores a live proxy after a service-worker restart", async () => {
    const session = proxySession();
    const harness = createHarness({
      persisted: authenticatedState({ autoConnect: true }),
      transient: {
        proxySession: session,
        refreshAttempts: 0,
        retiredSessions: [{ sessionId: "retired-session", expiresAt: "2026-08-26T12:09:00Z" }],
      },
      activeProxy: session,
    });
    await harness.controller.initialize();
    expect(harness.controller.getSnapshot()).toMatchObject({
      status: "connected",
      protected: true,
      activeLocationId: "frankfurt-01",
    });
    expect(harness.alarms.session?.id).toBe(session.id);
    expect(harness.api.revoked).not.toContain("retired-session");
  });

  it("rebuilds browser-restart credentials before completing initialization", async () => {
    const staleSession = proxySession("stale-browser-session");
    const replacement = proxySession("replacement-browser-session");
    const harness = createHarness({
      persisted: authenticatedState({ autoConnect: true }),
      activeProxy: staleSession,
    });
    harness.api.sessions = [replacement];
    let releaseCreation!: () => void;
    harness.api.createWait = new Promise<void>((resolve) => {
      releaseCreation = resolve;
    });

    const initialization = harness.controller.initialize();
    const credentials = harness.controller.getActiveSession();
    let credentialsReady = false;
    void credentials.then(() => {
      credentialsReady = true;
    });

    await vi.waitFor(() => expect(harness.api.proofs).toHaveLength(1));
    expect(credentialsReady).toBe(false);
    expect(harness.proxy.active?.id).toBe(staleSession.id);
    expect(harness.proxy.clearCalls).toBe(0);

    releaseCreation();
    await initialization;

    await expect(credentials).resolves.toMatchObject({ id: replacement.id });
    expect(harness.controller.getSnapshot()).toMatchObject({
      status: "connected",
      protected: true,
      activeLocationId: replacement.locationId,
    });
    expect(harness.storage.transient.proxySession?.id).toBe(replacement.id);
    expect(harness.proxy.active?.id).toBe(replacement.id);
    expect(harness.proxy.clearCalls).toBe(0);
  });

  it("retains and blocks a stale browser proxy when restart credential rebuilding fails", async () => {
    const staleSession = proxySession("stale-browser-session");
    const harness = createHarness({
      persisted: authenticatedState({ autoConnect: true }),
      activeProxy: staleSession,
    });
    harness.api.createError = new NetworkError("network");

    await harness.controller.initialize();

    expect(harness.controller.getSnapshot()).toMatchObject({
      status: "blocked",
      protected: false,
      trafficBlocked: true,
      activeLocationId: null,
      error: "proxy_creation_uncertain",
    });
    expect(harness.storage.transient.proxySession).toBeNull();
    expect(harness.proxy.active?.id).toBe(staleSession.id);
    expect(harness.proxy.clearCalls).toBe(0);
  });

  it("serves proxy credentials while full controller initialization is still blocked", async () => {
    const session = proxySession();
    const harness = createHarness({
      persisted: authenticatedState({ autoConnect: true }),
      transient: { proxySession: session, refreshAttempts: 0, retiredSessions: [] },
      activeProxy: session,
    });
    let releasePersisted!: (state: ReturnType<typeof authenticatedState>) => void;
    const blockedPersisted = new Promise<ReturnType<typeof authenticatedState>>((resolve) => {
      releasePersisted = resolve;
    });
    vi.spyOn(harness.storage, "readPersisted").mockReturnValue(blockedPersisted);

    const initialization = harness.controller.initialize();
    await expect(harness.controller.getActiveSession()).resolves.toMatchObject({ id: session.id });

    releasePersisted(authenticatedState({ autoConnect: true }));
    await initialization;
  });

  it("renews before expiration and lets the old session expire naturally", async () => {
    const oldSession = proxySession("old-session");
    const refreshNow = Date.parse("2026-08-26T12:08:30Z");
    const replacement = proxySession(
      "new-session",
      "frankfurt-01",
      "2026-08-26T12:08:30Z",
      "2026-08-26T12:18:30Z",
    );
    const harness = createHarness({
      persisted: authenticatedState({ autoConnect: true }),
      transient: {
        proxySession: oldSession,
        refreshAttempts: 0,
        retiredSessions: [{ sessionId: "already-expired", expiresAt: "2026-08-26T12:00:01Z" }],
      },
      activeProxy: oldSession,
    });
    harness.api.sessions = [replacement];
    await harness.controller.initialize();
    harness.setNow(refreshNow);
    await harness.controller.handleAlarm(ALARM_REFRESH);
    expect(harness.controller.getSnapshot().status).toBe("connected");
    expect(harness.storage.transient.proxySession?.id).toBe("new-session");
    expect(harness.api.revoked).not.toContain("old-session");
    expect(harness.storage.transient.retiredSessions).toEqual([
      { sessionId: "old-session", expiresAt: oldSession.expiresAt },
    ]);
    harness.setNow(Date.parse(oldSession.expiresAt) + 1);
    expect(harness.api.revoked).not.toContain("old-session");
  });

  it("keeps the old session during bounded refresh failures", async () => {
    const oldSession = proxySession("old-session");
    const harness = createHarness({
      persisted: authenticatedState({ autoConnect: true }),
      transient: { proxySession: oldSession, refreshAttempts: 0, retiredSessions: [] },
      activeProxy: oldSession,
    });
    harness.api.createError = new ApiError("rate_limited", 429);
    await harness.controller.initialize();
    await harness.controller.handleAlarm(ALARM_REFRESH);
    expect(harness.controller.getSnapshot()).toMatchObject({
      status: "refreshing",
      protected: true,
    });
    expect(harness.storage.transient.proxySession?.id).toBe("old-session");
    expect(harness.storage.transient.refreshAttempts).toBe(1);
    expect(harness.alarms.retryAt).toBe(NOW + 30_000);
  });

  it("never reactivates the proxy when disconnect supersedes an in-flight refresh", async () => {
    const oldSession = proxySession("old-session");
    const replacement = proxySession("stale-refresh-session");
    const harness = createHarness({
      persisted: authenticatedState({ autoConnect: true }),
      transient: { proxySession: oldSession, refreshAttempts: 0, retiredSessions: [] },
      activeProxy: oldSession,
    });
    let releaseRefresh!: () => void;
    harness.api.createWait = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    harness.api.ignoreCreateAbort = true;
    harness.api.sessions = [replacement];
    await harness.controller.initialize();

    const refresh = harness.controller.handleAlarm(ALARM_REFRESH);
    await vi.waitFor(() => expect(harness.api.proofs).toHaveLength(1));
    await harness.controller.disconnect();
    releaseRefresh();
    await refresh;
    await vi.waitFor(() => expect(harness.api.revoked).toContain(replacement.id));

    expect(harness.controller.getSnapshot()).toMatchObject({
      status: "disconnected",
      protected: false,
      autoConnect: false,
      activeLocationId: null,
    });
    expect(harness.proxy.active).toBeNull();
    expect(harness.storage.transient.proxySession).toBeNull();
  });

  it("keeps disconnect final when refresh is already applying the replacement proxy", async () => {
    const oldSession = proxySession("old-session");
    const replacement = proxySession("replacement-being-applied");
    const harness = createHarness({
      persisted: authenticatedState({ autoConnect: true }),
      transient: { proxySession: oldSession, refreshAttempts: 0, retiredSessions: [] },
      activeProxy: oldSession,
    });
    let releaseApply!: () => void;
    harness.proxy.applyWait = new Promise<void>((resolve) => {
      releaseApply = resolve;
    });
    harness.api.sessions = [replacement];
    await harness.controller.initialize();

    const refresh = harness.controller.handleAlarm(ALARM_REFRESH);
    await vi.waitFor(() => expect(harness.proxy.applyCalls).toBe(1));
    const disconnect = harness.controller.disconnect();
    await vi.waitFor(() =>
      expect(harness.controller.getSnapshot()).toMatchObject({
        status: "disconnecting",
        protected: false,
      }),
    );
    releaseApply();
    await Promise.all([refresh, disconnect]);

    expect(harness.controller.getSnapshot()).toMatchObject({
      status: "disconnected",
      protected: false,
      autoConnect: false,
      activeLocationId: null,
    });
    expect(harness.proxy.active).toBeNull();
    expect(harness.storage.transient.proxySession).toBeNull();
    expect(harness.api.revoked).toContain(replacement.id);
  });

  it("never restores a refreshed proxy after logout", async () => {
    const oldSession = proxySession("old-session");
    const replacement = proxySession("stale-refresh-session");
    const harness = createHarness({
      persisted: authenticatedState({ autoConnect: true }),
      transient: { proxySession: oldSession, refreshAttempts: 0, retiredSessions: [] },
      activeProxy: oldSession,
    });
    let releaseRefresh!: () => void;
    harness.api.createWait = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    harness.api.ignoreCreateAbort = true;
    harness.api.sessions = [replacement];
    await harness.controller.initialize();

    const refresh = harness.controller.handleAlarm(ALARM_REFRESH);
    await vi.waitFor(() => expect(harness.api.proofs).toHaveLength(1));
    await harness.controller.logout();
    releaseRefresh();
    await refresh;

    expect(harness.controller.getSnapshot()).toMatchObject({
      status: "logged_out",
      protected: false,
      activeLocationId: null,
    });
    expect(harness.proxy.active).toBeNull();
    expect(harness.storage.transient.proxySession).toBeNull();
  });

  it("keeps a user-requested location change when an older refresh completes later", async () => {
    const oldSession = proxySession("old-session");
    const staleRefresh = proxySession("stale-refresh-session");
    const selectedSession = proxySession("selected-session", "frankfurt-02");
    const harness = createHarness({
      persisted: authenticatedState({ autoConnect: true }),
      transient: { proxySession: oldSession, refreshAttempts: 0, retiredSessions: [] },
      activeProxy: oldSession,
    });
    let releaseRefresh!: () => void;
    harness.api.createWait = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    harness.api.ignoreCreateAbort = true;
    harness.api.sessions = [staleRefresh, selectedSession];
    await harness.controller.initialize();

    const refresh = harness.controller.handleAlarm(ALARM_REFRESH);
    await vi.waitFor(() => expect(harness.api.proofs).toHaveLength(1));
    harness.api.createWait = null;
    await harness.controller.changeLocation("frankfurt-02");
    releaseRefresh();
    await refresh;
    await vi.waitFor(() => expect(harness.api.revoked).toContain(staleRefresh.id));

    expect(harness.controller.getSnapshot()).toMatchObject({
      status: "connected",
      protected: true,
      activeLocationId: "frankfurt-02",
    });
    expect(harness.proxy.active?.id).toBe(selectedSession.id);
    expect(harness.storage.transient.proxySession?.id).toBe(selectedSession.id);
  });

  it("changes location only after the replacement is available", async () => {
    const oldSession = proxySession("old-session");
    const harness = createHarness({
      persisted: authenticatedState({ autoConnect: true }),
      transient: { proxySession: oldSession, refreshAttempts: 0, retiredSessions: [] },
      activeProxy: oldSession,
    });
    harness.api.createError = new NetworkError("network");
    await harness.controller.initialize();
    await harness.controller.changeLocation("frankfurt-02");
    expect(harness.controller.getSnapshot()).toMatchObject({
      status: "error",
      protected: true,
      activeLocationId: "frankfurt-01",
    });
    expect(harness.proxy.active?.id).toBe("old-session");
  });

  it("revokes the active and draining sessions immediately after a location change", async () => {
    const oldSession = proxySession("old-session");
    const replacement = proxySession("new-location-session", "frankfurt-02");
    const harness = createHarness({
      persisted: authenticatedState({ autoConnect: true }),
      transient: {
        proxySession: oldSession,
        refreshAttempts: 0,
        retiredSessions: [{ sessionId: "retired-session", expiresAt: "2026-08-26T12:09:00Z" }],
      },
      activeProxy: oldSession,
    });
    harness.api.sessions = [replacement];
    await harness.controller.initialize();

    await harness.controller.changeLocation("frankfurt-02");

    expect(harness.controller.getSnapshot()).toMatchObject({
      status: "connected",
      protected: true,
      activeLocationId: "frankfurt-02",
    });
    expect(harness.api.revoked).toEqual(expect.arrayContaining([oldSession.id, "retired-session"]));
    expect(harness.storage.transient.retiredSessions).toEqual([]);
  });

  it("disconnects locally before best-effort revocation and clears auto-connect", async () => {
    const session = proxySession();
    const harness = createHarness({
      persisted: authenticatedState({ autoConnect: true }),
      transient: {
        proxySession: session,
        refreshAttempts: 0,
        retiredSessions: [{ sessionId: "retired-session", expiresAt: "2026-08-26T12:09:00Z" }],
      },
      activeProxy: session,
    });
    await harness.controller.initialize();
    await harness.controller.disconnect();
    expect(harness.controller.getSnapshot()).toMatchObject({
      status: "disconnected",
      protected: false,
      autoConnect: false,
    });
    expect(harness.proxy.active).toBeNull();
    expect(harness.storage.transient.proxySession).toBeNull();
    expect(harness.api.revoked).toContain(session.id);
    expect(harness.api.revoked).toContain("retired-session");
  });

  it("revokes active and draining sessions before logging out remotely", async () => {
    const session = proxySession();
    const harness = createHarness({
      persisted: authenticatedState({ autoConnect: true }),
      transient: {
        proxySession: session,
        refreshAttempts: 0,
        retiredSessions: [{ sessionId: "retired-session", expiresAt: "2026-08-26T12:09:00Z" }],
      },
      activeProxy: session,
    });
    await harness.controller.initialize();

    await harness.controller.logout();

    expect(harness.api.revoked).toEqual(expect.arrayContaining([session.id, "retired-session"]));
    expect(harness.api.logoutCalls).toBe(1);
    expect(harness.controller.getSnapshot().status).toBe("logged_out");
  });

  it("stops when another extension controls the proxy", async () => {
    const harness = createHarness({ persisted: authenticatedState() });
    harness.proxy.level = "controlled_by_other_extensions";
    await harness.controller.initialize();
    await harness.controller.connect("frankfurt-01");
    expect(harness.controller.getSnapshot()).toMatchObject({
      status: "blocked",
      protected: false,
      trafficBlocked: true,
      error: "proxy_controlled_by_extension",
    });
  });

  it("keeps the active proxy after an isolated fatal request error", async () => {
    const session = proxySession();
    const harness = createHarness({
      persisted: authenticatedState({ autoConnect: true }),
      transient: { proxySession: session, refreshAttempts: 0, retiredSessions: [] },
      activeProxy: session,
    });
    await harness.controller.initialize();

    await harness.controller.handleProxyError("net::ERR_TUNNEL_CONNECTION_FAILED", true);

    expect(harness.controller.getSnapshot()).toMatchObject({
      status: "connected",
      protected: true,
      activeLocationId: session.locationId,
    });
    expect(harness.proxy.active?.id).toBe(session.id);
    expect(harness.storage.transient.proxySession?.id).toBe(session.id);
    expect(harness.api.revoked).not.toContain(session.id);
  });

  it("ignores a stale proxy-control event after confirming current ownership", async () => {
    const session = proxySession();
    const harness = createHarness({
      persisted: authenticatedState({ autoConnect: true }),
      transient: { proxySession: session, refreshAttempts: 0, retiredSessions: [] },
      activeProxy: session,
    });
    await harness.controller.initialize();

    await harness.controller.handleProxyControlLost("controllable_by_this_extension");

    expect(harness.controller.getSnapshot()).toMatchObject({
      status: "connected",
      protected: true,
      activeLocationId: session.locationId,
    });
    expect(harness.proxy.active?.id).toBe(session.id);
    expect(harness.storage.transient.proxySession?.id).toBe(session.id);
  });

  it("never escalates repeated transaction failures to a global proxy failure", async () => {
    const session = proxySession();
    const harness = createHarness({
      persisted: authenticatedState({ autoConnect: true }),
      transient: { proxySession: session, refreshAttempts: 0, retiredSessions: [] },
      activeProxy: session,
    });
    await harness.controller.initialize();

    await harness.controller.handleProxyError("net::ERR_PROXY_CONNECTION_FAILED", true);
    await harness.controller.handleProxyError("net::ERR_PROXY_CONNECTION_FAILED", true);
    await harness.controller.handleProxyError("net::ERR_PROXY_CONNECTION_FAILED", true);
    await harness.controller.handleProxyError("net::ERR_PROXY_CONNECTION_FAILED", true);

    expect(harness.controller.getSnapshot()).toMatchObject({
      status: "connected",
      protected: true,
      error: null,
    });
    expect(harness.proxy.active?.id).toBe(session.id);
    expect(harness.storage.transient.proxySession?.id).toBe(session.id);
    expect(harness.api.revoked).not.toContain(session.id);
  });

  it("blocks immediately when the HTTPS proxy certificate is invalid", async () => {
    const session = proxySession();
    const harness = createHarness({
      persisted: authenticatedState({ autoConnect: true }),
      transient: { proxySession: session, refreshAttempts: 0, retiredSessions: [] },
      activeProxy: session,
    });
    await harness.controller.initialize();

    await harness.controller.handleProxyError("net::ERR_PROXY_CERTIFICATE_INVALID", true);

    expect(harness.controller.getSnapshot()).toMatchObject({
      status: "blocked",
      protected: false,
      trafficBlocked: true,
      activeLocationId: null,
      error: "proxy_certificate_invalid",
    });
    expect(harness.proxy.active?.id).toBe(session.id);
    expect(harness.storage.transient.proxySession).toBeNull();
  });

  it("never places account or proxy passwords in persistent storage or logs", async () => {
    const log = vi.spyOn(console, "log");
    const error = vi.spyOn(console, "error");
    const harness = createHarness();
    const session = proxySession();
    harness.api.sessions = [session];
    await harness.controller.initialize();
    await harness.controller.login("client@example.com", "account-password-must-not-persist");
    await harness.controller.connect("frankfurt-01");
    const persisted = JSON.stringify(harness.storage.persisted);
    expect(persisted).not.toContain("account-password-must-not-persist");
    expect(persisted).not.toContain(session.username);
    expect(persisted).not.toContain(session.password);
    expect(log).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    log.mockRestore();
    error.mockRestore();
  });
});
