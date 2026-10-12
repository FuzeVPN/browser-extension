// SPDX-License-Identifier: MPL-2.0

import { ApiError, NetworkError } from "../../src/core/api/client";
import type { Device } from "../../src/core/api/types";
import { AppController } from "../../src/core/background/state-machine";
import { ExtensionAlarmService } from "../../src/core/background/session-refresh";
import { ProxyControlError } from "../../src/core/background/proxy-controller";
import { ALARM_EXPIRY, ALARM_REFRESH } from "../../src/core/shared/config";
import { AUTH, NOW, PROFILE, authenticatedState, createHarness, proxySession } from "./helpers";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const device = (deviceId: string): Device => ({
  deviceId,
  name: deviceId,
  kind: "browser_extension",
  profiles: [],
  createdAt: new Date(NOW).toISOString(),
});

describe("renewal deadlines across worker restarts", () => {
  let now: number;
  let alarms: Map<string, number>;
  beforeEach(() => {
    now = NOW;
    alarms = new Map();
    vi.spyOn(Date, "now").mockImplementation(() => now);
    vi.stubGlobal("browser", {
      alarms: {
        create: async (name: string, info: { when: number }) => {
          alarms.set(name, info.when);
        },
        get: async (name: string) => {
          const scheduledTime = alarms.get(name);
          return scheduledTime === undefined ? undefined : { name, scheduledTime };
        },
        clear: async (name: string) => alarms.delete(name),
      },
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function setup() {
    const session = {
      ...proxySession("restored", "frankfurt-01", new Date(NOW - 120_000).toISOString()),
      refreshAfterSeconds: 60,
    };
    const h = createHarness({
      persisted: authenticatedState({ autoConnect: true }),
      transient: { proxySession: session, refreshAttempts: 0, retiredSessions: [] },
      activeProxy: session,
    });
    const restart = () =>
      new AppController({
        api: h.api,
        storage: h.storage,
        identity: h.identity,
        proxy: h.proxy,
        safety: h.safety,
        securityStorage: h.securityStorage,
        alarms: new ExtensionAlarmService(),
        now: () => now,
        onStateChanged: () => {},
      });
    return { h, restart, session };
  }

  it.each([30, 120])(
    "keeps a %i-second retry deadline and rejects an early alarm",
    async (seconds) => {
      const { h, restart, session } = setup();
      h.api.createError = new ApiError("rate_limited", 429, seconds);
      let controller = restart();
      await controller.initialize();
      now = alarms.get(ALARM_REFRESH)!;
      await controller.handleAlarm(ALARM_REFRESH);
      const deadline = now + seconds * 1000;
      expect(h.storage.transient.refreshRetryAt).toBe(deadline);
      now += 10_000;
      controller = restart();
      await controller.initialize();
      expect(alarms.get(ALARM_REFRESH)).toBe(deadline);
      expect(alarms.get(ALARM_EXPIRY)).toBe(Date.parse(session.expiresAt));
      await controller.handleAlarm(ALARM_REFRESH);
      expect(h.api.proofs).toHaveLength(1);
      expect(controller.getSnapshot().protected).toBe(true);
      now = deadline;
      await controller.handleAlarm(ALARM_REFRESH);
      expect(h.api.proofs).toHaveLength(2);
    },
  );

  it("keeps the attempt limit after restart while retaining the expiry alarm", async () => {
    const { h, restart, session } = setup();
    h.api.createError = new ApiError("rate_limited", 429);
    let controller = restart();
    await controller.initialize();
    for (let attempt = 0; attempt < 3; attempt++) {
      now = alarms.get(ALARM_REFRESH)!;
      await controller.handleAlarm(ALARM_REFRESH);
    }
    expect(h.api.proofs).toHaveLength(3);
    expect(alarms.has(ALARM_REFRESH)).toBe(false);
    now += 31_000;
    controller = restart();
    await controller.initialize();
    await controller.handleAlarm(ALARM_REFRESH);
    expect(h.api.proofs).toHaveLength(3);
    expect(alarms.has(ALARM_REFRESH)).toBe(false);
    expect(alarms.get(ALARM_EXPIRY)).toBe(Date.parse(session.expiresAt));
    now = Date.parse(session.expiresAt);
    await controller.handleAlarm(ALARM_EXPIRY);
    expect(controller.getSnapshot()).toMatchObject({ protected: false, trafficBlocked: true });
  });

  it("waits conservatively when restoring an old retry record without a deadline", async () => {
    const { h, restart } = setup();
    h.storage.transient.refreshAttempts = 1;
    const controller = restart();
    await controller.initialize();
    expect(alarms.get(ALARM_REFRESH)).toBe(NOW + 30_000);
    expect(h.storage.transient.refreshRetryAt).toBe(NOW + 30_000);
    await controller.handleAlarm(ALARM_REFRESH);
    expect(h.api.proofs).toHaveLength(0);
  });
});

describe("abandoned location sessions", () => {
  it("keeps cleanup after both application and fallback fail, including worker restart", async () => {
    const h = createHarness({ persisted: authenticatedState() });
    await h.controller.initialize();
    await h.controller.connect("frankfurt-01");
    h.api.sessions = [proxySession("abandoned", "frankfurt-02")];
    vi.spyOn(h.proxy, "isActiveConfiguration").mockResolvedValue(false);
    vi.spyOn(h.proxy, "apply").mockRejectedValue(new ProxyControlError("configuration_rejected"));
    const revoke = vi
      .spyOn(h.api, "revokeProxySession")
      .mockRejectedValueOnce(new NetworkError("network"));
    await h.controller.changeLocation("frankfurt-02");
    expect(h.controller.getSnapshot()).toMatchObject({ protected: false, trafficBlocked: true });
    expect(h.storage.transient.proxySession).toBeNull();
    expect(h.storage.transient.retiredSessions.map(({ sessionId }) => sessionId)).toContain(
      "abandoned",
    );
    const restarted = new AppController({
      api: h.api,
      storage: h.storage,
      identity: h.identity,
      proxy: h.proxy,
      safety: h.safety,
      securityStorage: h.securityStorage,
      alarms: h.alarms,
      now: () => NOW,
      onStateChanged: () => {},
    });
    await restarted.initialize();
    await restarted.disconnect();
    expect(revoke.mock.calls.filter(([, id]) => id === "abandoned")).toHaveLength(2);
  });

  it("revokes a replacement when effective proxy verification fails after application", async () => {
    const h = createHarness({ persisted: authenticatedState() });
    await h.controller.initialize();
    await h.controller.connect("frankfurt-01");
    h.api.sessions = [proxySession("unverified", "frankfurt-02")];
    const inspect = h.proxy.isActiveConfiguration.bind(h.proxy);
    vi.spyOn(h.proxy, "isActiveConfiguration").mockImplementation((session) =>
      session.id === "unverified" ? Promise.resolve(false) : inspect(session),
    );
    const revoke = vi.spyOn(h.api, "revokeProxySession");
    await h.controller.changeLocation("frankfurt-02");
    expect(revoke).toHaveBeenCalledWith(AUTH.accessToken, "unverified");
    expect(h.controller.getSnapshot()).toMatchObject({
      protected: true,
      activeLocationId: "frankfurt-01",
    });
  });

  it("revokes a rejected replacement, and retries cleanup on disconnect if needed", async () => {
    const h = createHarness({ persisted: authenticatedState() });
    h.api.sessions = [proxySession("original"), proxySession("replacement", "frankfurt-02")];
    await h.controller.initialize();
    await h.controller.connect("frankfurt-01");
    vi.spyOn(h.proxy, "apply").mockRejectedValueOnce(
      new ProxyControlError("configuration_rejected"),
    );
    const revoke = vi
      .spyOn(h.api, "revokeProxySession")
      .mockRejectedValueOnce(new NetworkError("network"));
    await h.controller.changeLocation("frankfurt-02");
    expect(h.controller.getSnapshot()).toMatchObject({
      protected: true,
      activeLocationId: "frankfurt-01",
    });
    expect(revoke).toHaveBeenCalledWith(AUTH.accessToken, "replacement");
    await h.controller.disconnect();
    expect(h.api.revoked).toEqual(expect.arrayContaining(["original", "replacement"]));
  });

  it("uses the creating account token to revoke a late replacement after another login", async () => {
    const h = createHarness({ persisted: authenticatedState() });
    await h.controller.initialize();
    await h.controller.connect("frankfurt-01");
    const pending = deferred<undefined>();
    h.api.createWait = pending.promise;
    h.api.ignoreCreateAbort = true;
    h.api.sessions = [proxySession("late-replacement", "frankfurt-02")];
    const change = h.controller.changeLocation("frankfurt-02");
    await vi.waitFor(() => expect(h.api.proofs).toHaveLength(2));
    await h.controller.logout();
    h.api.auth = { ...AUTH, accessToken: "account-b-token" };
    h.api.profile = { ...PROFILE, userId: "account-b" };
    await h.controller.login("b@example.invalid", "synthetic");
    const revoke = vi.spyOn(h.api, "revokeProxySession");
    pending.resolve(undefined);
    await change;
    expect(revoke).toHaveBeenCalledWith(AUTH.accessToken, "late-replacement");
    expect(h.controller.getSnapshot().profile?.userId).toBe("account-b");
  });
});

describe("device ownership and list ordering", () => {
  it("reuses each account's own identity during A/B/A without additional enrollment", async () => {
    const h = createHarness({ persisted: authenticatedState() });
    const enroll = vi.spyOn(h.api, "enrollBrowserDevice").mockImplementation(async (token) => ({
      deviceId: token === AUTH.accessToken ? "device-a" : "device-b",
      name: "Chrome",
      kind: "browser_extension",
      createdAt: new Date(NOW).toISOString(),
    }));
    await h.controller.initialize();
    await h.controller.connect("frankfurt-01");
    await h.controller.logout();
    h.api.auth = { ...AUTH, accessToken: "account-b-token" };
    h.api.profile = { ...PROFILE, userId: "account-b" };
    await h.controller.login("b@example.invalid", "synthetic");
    expect(h.controller.getSnapshot().currentDeviceId).toBeNull();
    await h.controller.connect("frankfurt-01");
    await h.controller.logout();
    h.api.auth = AUTH;
    h.api.profile = PROFILE;
    await h.controller.login(PROFILE.email, "synthetic");
    await h.controller.connect("frankfurt-01");
    expect(h.api.proofs.map((proof) => proof.deviceId)).toEqual([
      "device-a",
      "device-b",
      "device-a",
    ]);
    expect(enroll).toHaveBeenCalledTimes(2);
    expect(h.identity.keyGenerations).toBe(2);
  });

  it("preserves legacy A while B connects, then migrates it only after A's ownership is confirmed", async () => {
    const h = createHarness({ persisted: authenticatedState() });
    h.identity.legacyDeviceId = "legacy-a";
    h.api.profile = { ...PROFILE, userId: "account-b" };
    await h.controller.initialize();
    await h.controller.connect("frankfurt-01");
    expect(h.identity.legacyDeviceId).toBe("legacy-a");
    expect(h.api.proofs[0]?.deviceId).not.toBe("legacy-a");
    await h.controller.logout();
    h.api.profile = PROFILE;
    h.api.devices = { limit: 2, devices: [device("legacy-a")] };
    await h.controller.login(PROFILE.email, "synthetic");
    await h.controller.connect("frankfurt-01");
    expect(h.api.proofs[1]?.deviceId).toBe("legacy-a");
    expect(h.api.enrollCalls).toBe(1);
    expect(h.identity.legacyDeviceId).toBeNull();
  });

  it("discards a completed old signature before submitting it after logout", async () => {
    const h = createHarness({ persisted: authenticatedState() });
    await h.controller.initialize();
    const proof = h.identity.createProof.bind(h.identity);
    const paused = deferred<undefined>();
    const signing = vi.spyOn(h.identity, "createProof").mockImplementation(async (...args) => {
      await paused.promise;
      return proof(...args);
    });
    const connect = h.controller.connect("frankfurt-01");
    await vi.waitFor(() => expect(signing).toHaveBeenCalled());
    await h.controller.logout();
    paused.resolve(undefined);
    await connect;
    expect(h.api.proofs).toHaveLength(0);
    expect(h.controller.getSnapshot().profile).toBeNull();
  });

  it.each(["before", "during"])("ignores a stale list started %s deletion", async (when) => {
    const h = createHarness({ persisted: authenticatedState() });
    await h.controller.initialize();
    const oldList = deferred<{ limit: number; devices: Device[] }>();
    const deleted = deferred<undefined>();
    const deletion = vi.spyOn(h.api, "deleteDevice").mockReturnValue(deleted.promise);
    const listing = vi
      .spyOn(h.api, "getDevices")
      .mockReturnValueOnce(oldList.promise)
      .mockResolvedValue({ limit: 2, devices: [] });
    let removing: ReturnType<typeof h.controller.deleteDevice>;
    let refreshing: ReturnType<typeof h.controller.refreshDevices>;
    if (when === "before") {
      refreshing = h.controller.refreshDevices();
      await vi.waitFor(() => expect(listing).toHaveBeenCalledOnce());
      removing = h.controller.deleteDevice("another-device");
    } else {
      removing = h.controller.deleteDevice("another-device");
      await vi.waitFor(() => expect(deletion).toHaveBeenCalled());
      refreshing = h.controller.refreshDevices();
      await vi.waitFor(() => expect(listing).toHaveBeenCalledOnce());
    }
    deleted.resolve(undefined);
    await removing;
    oldList.resolve({ limit: 2, devices: [device("another-device")] });
    await refreshing;
    expect(h.controller.getSnapshot().devices).toEqual([]);
  });
});
