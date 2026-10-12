// SPDX-License-Identifier: MPL-2.0

import { AppController } from "../../src/core/background/state-machine";
import {
  ALARM_REFRESH,
  MAX_REFRESH_ATTEMPTS,
  REFRESH_RETRY_MS,
} from "../../src/core/shared/config";
import { DEFAULT_SECURITY_STATE, type SecurityState } from "../../src/core/shared/security";
import { authenticatedState, createHarness, NOW, proxySession } from "./helpers";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const REFRESH_NOW = NOW + 510_000;

function liveHarness(options?: {
  automatic?: boolean;
  refreshAttempts?: number;
  refreshRetryAt?: number;
  security?: Partial<SecurityState>;
}) {
  const session = proxySession("original-session");
  const harness = createHarness({
    persisted: authenticatedState({ autoConnect: true }),
    transient: {
      proxySession: session,
      refreshAttempts: options?.refreshAttempts ?? 0,
      ...(options?.refreshRetryAt === undefined ? {} : { refreshRetryAt: options.refreshRetryAt }),
      retiredSessions: [],
    },
    activeProxy: session,
    security: {
      ...DEFAULT_SECURITY_STATE,
      protectionRequested: true,
      selectedLocationId: session.locationId,
      ...options?.security,
    },
  });
  harness.identity.deviceId = "browser-device-1";
  if (!options?.automatic) return harness;
  let now = NOW;
  const controller = new AppController({
    api: harness.api,
    storage: harness.storage,
    identity: harness.identity,
    proxy: harness.proxy,
    alarms: harness.alarms,
    safety: harness.safety,
    securityStorage: harness.securityStorage,
    now: () => now,
    onStateChanged: (snapshot) => harness.snapshots.push(snapshot),
    resolveAutomaticLocation: () => undefined,
    remoteCleanupTimeoutMs: 250,
  });
  return { ...harness, controller, setNow: (value: number) => (now = value) };
}

describe("renewal ownership across concurrent commands", () => {
  afterEach(() => vi.restoreAllMocks());

  it.each(["permissions", "proxy control"] as const)(
    "rearms renewal when a Firefox %s event retains the session during signing",
    async (event) => {
      const h = liveHarness();
      await h.controller.initialize();
      h.setNow(REFRESH_NOW);
      const previous = h.proxy.active!;
      const proof = await h.identity.createProof(
        "user-test",
        "browser-device-1",
        previous.locationId,
        NOW,
      );
      const signing = deferred<typeof proof>();
      const signer = vi.spyOn(h.identity, "createProof").mockReturnValueOnce(signing.promise);
      const schedule = vi.spyOn(h.alarms, "scheduleSession");
      const create = vi.spyOn(h.api, "createProxySession");
      await h.alarms.clearRefresh();
      const refresh = h.controller.handleAlarm(ALARM_REFRESH);
      await vi.waitFor(() => expect(signer).toHaveBeenCalledOnce());

      if (event === "permissions") await h.controller.handleProxyPermissionsChanged();
      else {
        vi.spyOn(h.proxy, "isActiveConfiguration").mockResolvedValueOnce(false);
        await h.controller.handleProxyControlLost("controllable_by_this_extension");
      }
      signing.resolve(proof);
      await refresh;

      expect(create).not.toHaveBeenCalled();
      expect(schedule).toHaveBeenLastCalledWith(previous, REFRESH_NOW + 1_000);
      expect(h.controller.getSnapshot()).toMatchObject({ status: "connected", protected: true });
      const replacement = proxySession(
        "renewed-after-event",
        previous.locationId,
        "2026-08-26T12:08:31Z",
        "2026-08-26T12:18:31Z",
      );
      h.api.sessions = [replacement];
      h.setNow(h.alarms.retryAt!);
      await h.controller.handleAlarm(ALARM_REFRESH);
      expect(h.proxy.active?.id).toBe(replacement.id);
    },
  );

  it("rearms renewal when security settings supersede signing before the POST", async () => {
    const h = liveHarness();
    await h.controller.initialize();
    h.setNow(REFRESH_NOW);
    const previous = h.proxy.active!;
    const proof = await h.identity.createProof(
      "user-test",
      "browser-device-1",
      previous.locationId,
      NOW,
    );
    const signing = deferred<typeof proof>();
    const signer = vi.spyOn(h.identity, "createProof").mockReturnValueOnce(signing.promise);
    const schedule = vi.spyOn(h.alarms, "scheduleSession");
    const create = vi.spyOn(h.api, "createProxySession");
    await h.alarms.clearRefresh();
    const refresh = h.controller.handleAlarm(ALARM_REFRESH);
    await vi.waitFor(() => expect(signer).toHaveBeenCalledOnce());

    expect(await h.controller.updateSecurityPreferences(true, false)).toEqual({ ok: true });
    signing.resolve(proof);
    await refresh;

    expect(create).not.toHaveBeenCalled();
    expect(schedule).toHaveBeenLastCalledWith(previous, REFRESH_NOW + 1_000);
    expect(h.controller.getSnapshot()).toMatchObject({ status: "connected", protected: true });
    const replacement = proxySession(
      "renewed-session",
      previous.locationId,
      "2026-08-26T12:08:31Z",
      "2026-08-26T12:18:31Z",
    );
    h.api.sessions = [replacement];
    h.setNow(h.alarms.retryAt!);
    await h.controller.handleAlarm(ALARM_REFRESH);
    expect(h.proxy.active?.id).toBe(replacement.id);
    expect(h.storage.transient.proxySession?.id).toBe(replacement.id);
    expect(h.alarms.session?.id).toBe(replacement.id);
  });

  it("defers a consumed alarm during Auto selection and renews the retained server", async () => {
    const h = liveHarness({ automatic: true });
    await h.controller.initialize();
    h.setNow(REFRESH_NOW);
    const previous = h.proxy.active!;
    const subscription = deferred<typeof h.api.subscription>();
    const entitlement = vi
      .spyOn(h.api, "getSubscription")
      .mockReturnValueOnce(subscription.promise);
    const schedule = vi.spyOn(h.alarms, "scheduleSession");
    const create = vi.spyOn(h.api, "createProxySession");
    const selection = h.controller.changeLocation(previous.locationId);
    await vi.waitFor(() => expect(entitlement).toHaveBeenCalledOnce());
    expect(h.controller.getSnapshot().status).toBe("connecting");
    await h.alarms.clearRefresh();

    await h.controller.handleAlarm(ALARM_REFRESH);
    expect(schedule).toHaveBeenLastCalledWith(previous, REFRESH_NOW + REFRESH_RETRY_MS);
    expect(create).not.toHaveBeenCalled();
    subscription.resolve(h.api.subscription);
    expect(await selection).toEqual({ ok: true });
    expect(schedule).toHaveBeenLastCalledWith(previous, REFRESH_NOW + 1_000);
    expect(h.controller.getSnapshot()).toMatchObject({ status: "connected", protected: true });

    const replacement = proxySession(
      "renewed-retained-session",
      previous.locationId,
      "2026-08-26T12:08:31Z",
      "2026-08-26T12:18:31Z",
    );
    h.api.sessions = [replacement];
    h.setNow(h.alarms.retryAt!);
    await h.controller.handleAlarm(ALARM_REFRESH);
    expect(h.storage.transient.proxySession?.id).toBe(replacement.id);
    expect(h.proxy.active?.id).toBe(replacement.id);
  });

  it("rearms a retained manual selection that supersedes an unfinished signature", async () => {
    const h = liveHarness();
    await h.controller.initialize();
    h.setNow(REFRESH_NOW);
    const previous = h.proxy.active!;
    const proof = await h.identity.createProof(
      "user-test",
      "browser-device-1",
      previous.locationId,
      NOW,
    );
    const signing = deferred<typeof proof>();
    const signer = vi.spyOn(h.identity, "createProof").mockReturnValueOnce(signing.promise);
    const schedule = vi.spyOn(h.alarms, "scheduleSession");
    const refresh = h.controller.handleAlarm(ALARM_REFRESH);
    await vi.waitFor(() => expect(signer).toHaveBeenCalledOnce());

    expect(await h.controller.changeLocation(previous.locationId)).toEqual({ ok: true });
    signing.resolve(proof);
    await refresh;

    expect(h.api.proofs).toHaveLength(0);
    expect(schedule).toHaveBeenLastCalledWith(previous, REFRESH_NOW + 1_000);
    expect(h.storage.transient.refreshAttempts).toBe(0);
  });

  it.each([
    { name: "the exhausted refresh budget", refreshAttempts: MAX_REFRESH_ATTEMPTS, security: {} },
    {
      name: "a full server",
      refreshAttempts: 0,
      security: { capacityBlockedLocationId: "frankfurt-01" },
    },
    {
      name: "an uncertain proxy creation",
      refreshAttempts: 0,
      security: { proxyCreationUncertain: true },
    },
    {
      name: "a rate limit extending past expiry",
      refreshAttempts: 0,
      security: { retryNotBefore: NOW + 600_000 },
    },
  ])("keeps renewal suspended for $name after a protection update", async (scenario) => {
    const h = liveHarness(scenario);
    await h.controller.initialize();
    h.setNow(REFRESH_NOW);
    const previous = h.proxy.active!;
    const schedule = vi.spyOn(h.alarms, "scheduleSession");
    const create = vi.spyOn(h.api, "createProxySession");

    expect(await h.controller.updateSecurityPreferences(true, false)).toEqual({ ok: true });

    expect(schedule).toHaveBeenLastCalledWith(previous, null);
    expect(h.storage.transient.refreshAttempts).toBe(scenario.refreshAttempts);
    expect(create).not.toHaveBeenCalled();
    expect(h.proxy.active?.id).toBe(previous.id);
  });

  it("preserves the retry deadline and budget when a protection update retains the session", async () => {
    const retryAt = REFRESH_NOW + 60_000;
    const h = liveHarness({ refreshAttempts: 2, refreshRetryAt: retryAt });
    await h.controller.initialize();
    h.setNow(REFRESH_NOW);
    const schedule = vi.spyOn(h.alarms, "scheduleSession");

    expect(await h.controller.updateSecurityPreferences(true, false)).toEqual({ ok: true });

    expect(schedule).toHaveBeenLastCalledWith(h.proxy.active, retryAt);
    expect(h.storage.transient.refreshAttempts).toBe(2);
    expect(h.storage.transient.refreshRetryAt).toBe(retryAt);
    expect(h.api.proofs).toHaveLength(0);
  });

  it("preserves an exhausted budget when selection retains the same server", async () => {
    const h = liveHarness({ automatic: true, refreshAttempts: MAX_REFRESH_ATTEMPTS });
    await h.controller.initialize();
    h.setNow(REFRESH_NOW);
    const subscription = deferred<typeof h.api.subscription>();
    const entitlement = vi
      .spyOn(h.api, "getSubscription")
      .mockReturnValueOnce(subscription.promise);
    const schedule = vi.spyOn(h.alarms, "scheduleSession");
    const selection = h.controller.changeLocation("frankfurt-01");
    await vi.waitFor(() => expect(entitlement).toHaveBeenCalledOnce());

    await h.controller.handleAlarm(ALARM_REFRESH);
    expect(schedule).toHaveBeenLastCalledWith(h.proxy.active, null);
    subscription.resolve(h.api.subscription);
    expect(await selection).toEqual({ ok: true });
    expect(schedule).toHaveBeenLastCalledWith(h.proxy.active, null);
    expect(h.storage.transient.refreshAttempts).toBe(MAX_REFRESH_ATTEMPTS);
    expect(h.api.proofs).toHaveLength(0);
  });

  it("does not restore an alarm when logout supersedes a pending retained-session read", async () => {
    const h = liveHarness();
    await h.controller.initialize();
    h.setNow(REFRESH_NOW);
    const stored = structuredClone(h.storage.transient);
    const reading = deferred<typeof stored>();
    const read = vi.spyOn(h.storage, "readTransient").mockReturnValueOnce(reading.promise);
    const schedule = vi.spyOn(h.alarms, "scheduleSession");
    const settings = h.controller.updateSecurityPreferences(true, false);
    await vi.waitFor(() => expect(read).toHaveBeenCalledOnce());

    const logout = h.controller.logout();
    await vi.waitFor(() => expect(h.controller.getSnapshot().status).toBe("disconnecting"));
    reading.resolve(stored);
    expect(await settings).toEqual({ ok: false, superseded: true });
    expect(await logout).toEqual({ ok: true });

    expect(schedule).not.toHaveBeenCalled();
    expect(h.alarms.session).toBeNull();
    expect(h.storage.transient.proxySession).toBeNull();
    expect(h.proxy.active).toBeNull();
    expect(h.controller.getSnapshot()).toMatchObject({ status: "logged_out", protected: false });
  });

  it("lets a newer location own the alarm when it supersedes retained-session scheduling", async () => {
    const h = liveHarness();
    await h.controller.initialize();
    h.setNow(REFRESH_NOW);
    const stored = structuredClone(h.storage.transient);
    const reading = deferred<typeof stored>();
    const read = vi.spyOn(h.storage, "readTransient").mockReturnValueOnce(reading.promise);
    const schedule = vi.spyOn(h.alarms, "scheduleSession");
    const settings = h.controller.updateSecurityPreferences(true, false);
    await vi.waitFor(() => expect(read).toHaveBeenCalledOnce());
    const replacement = proxySession(
      "selected-session",
      "frankfurt-02",
      "2026-08-26T12:08:30Z",
      "2026-08-26T12:18:30Z",
    );
    h.api.sessions = [replacement];

    const selection = h.controller.changeLocation(replacement.locationId);
    await vi.waitFor(() => expect(h.controller.getSnapshot().status).toBe("connecting"));
    reading.resolve(stored);
    expect(await settings).toEqual({ ok: false, superseded: true });
    expect(await selection).toEqual({ ok: true });

    expect(schedule).toHaveBeenCalledOnce();
    expect(schedule.mock.calls[0]?.[0].id).toBe(replacement.id);
    expect(h.alarms.session?.id).toBe(replacement.id);
    expect(h.storage.transient.proxySession?.id).toBe(replacement.id);
  });

  it("settles a deferred alarm safely when logout interrupts its storage read", async () => {
    const h = liveHarness({ automatic: true });
    await h.controller.initialize();
    h.setNow(REFRESH_NOW);
    const subscription = deferred<typeof h.api.subscription>();
    const entitlement = vi
      .spyOn(h.api, "getSubscription")
      .mockReturnValueOnce(subscription.promise);
    const selection = h.controller.changeLocation("frankfurt-01");
    await vi.waitFor(() => expect(entitlement).toHaveBeenCalledOnce());
    const stored = structuredClone(h.storage.transient);
    const reading = deferred<typeof stored>();
    const read = vi.spyOn(h.storage, "readTransient").mockReturnValueOnce(reading.promise);
    const schedule = vi.spyOn(h.alarms, "scheduleSession");
    const alarm = h.controller.handleAlarm(ALARM_REFRESH);
    await vi.waitFor(() => expect(read).toHaveBeenCalledOnce());

    const logout = h.controller.logout();
    await vi.waitFor(() => expect(h.controller.getSnapshot().status).toBe("disconnecting"));
    reading.resolve(stored);
    await expect(alarm).resolves.toBeUndefined();
    subscription.resolve(h.api.subscription);
    expect(await selection).toEqual({ ok: false, superseded: true });
    expect(await logout).toEqual({ ok: true });

    expect(schedule).not.toHaveBeenCalled();
    expect(h.alarms.session).toBeNull();
    expect(h.proxy.active).toBeNull();
  });
});
