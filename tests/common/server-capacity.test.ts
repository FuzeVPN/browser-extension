// SPDX-License-Identifier: MPL-2.0

import { ApiError, NetworkError } from "../../src/core/api/client";
import type { Location } from "../../src/core/api/types";
import { AppController, mapError } from "../../src/core/background/state-machine";
import { ALARM_EXPIRY, ALARM_RECONNECT, ALARM_REFRESH } from "../../src/core/shared/config";
import { authenticatedState, createHarness, LOCATIONS, NOW, PROFILE } from "./helpers";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

async function ready(connected = false) {
  const h = createHarness({ persisted: authenticatedState() });
  h.identity.deviceId = "existing-device";
  await h.controller.initialize();
  await new Promise<void>((resolve) => setImmediate(resolve));
  if (connected) await h.controller.connect(LOCATIONS[0]!.id);
  return h;
}

function restart(h: Awaited<ReturnType<typeof ready>>, now = NOW) {
  return new AppController({
    api: h.api,
    storage: h.storage,
    identity: h.identity,
    proxy: h.proxy,
    alarms: h.alarms,
    safety: h.safety,
    securityStorage: h.securityStorage,
    now: () => now,
    onStateChanged: (snapshot) => h.snapshots.push(snapshot),
  });
}

describe("server capacity refusals", () => {
  it.each([
    ["server_full", 409],
    ["capacity_unavailable", 503],
  ] as const)(
    "refreshes only locations once after %s, without rotating identity",
    async (code, status) => {
      const h = await ready();
      const locations = vi.spyOn(h.api, "getLocations");
      const profile = vi.spyOn(h.api, "getProfile");
      const subscription = vi.spyOn(h.api, "getSubscription");
      const create = vi.spyOn(h.api, "createProxySession").mockImplementation(async () => {
        h.api.locations = [LOCATIONS[1]!];
        throw new ApiError(code, status);
      });
      expect(await h.controller.connect(LOCATIONS[0]!.id)).toMatchObject({
        ok: false,
        commandError: code,
      });
      expect(locations).toHaveBeenCalledTimes(2); // Initial hydration, then one refusal refresh.
      expect(profile).toHaveBeenCalledTimes(1);
      expect(subscription).toHaveBeenCalledTimes(1);
      expect(create).toHaveBeenCalledTimes(1);
      expect(h.api.enrollCalls).toBe(0);
      expect(h.identity.deviceId).toBe("existing-device");
      expect(h.securityStorage.state).toMatchObject({
        proxyCreationUncertain: false,
        proxyCleanupUncertain: false,
      });
      expect(h.controller.getSnapshot()).toMatchObject({ error: code, locations: [LOCATIONS[1]!] });
    },
  );

  it("removes the full location immediately and keeps others if catalog refresh fails", async () => {
    const h = await ready();
    const pending = deferred<Location[]>();
    const locations = vi
      .spyOn(h.api, "getLocations")
      .mockResolvedValueOnce(LOCATIONS)
      .mockImplementationOnce(() => pending.promise);
    h.api.createError = new ApiError("server_full", 409);
    const connecting = h.controller.connect(LOCATIONS[0]!.id);
    await vi.waitFor(() => expect(locations).toHaveBeenCalledTimes(2));
    expect(h.controller.getSnapshot()).toMatchObject({
      locations: [LOCATIONS[1]!],
      error: "server_full",
    });
    pending.resolve([LOCATIONS[1]!]);
    await connecting;
    locations.mockRejectedValueOnce(new NetworkError("network"));
    expect(await h.controller.refreshLocations()).toMatchObject({
      ok: false,
      commandError: "network_error",
    });
    expect(h.controller.getSnapshot()).toMatchObject({
      locations: [LOCATIONS[1]!],
      error: "server_full",
    });
    expect(h.storage.persisted.selectedLocationId).toBe(LOCATIONS[0]!.id);
  });

  it("keeps the original refusal when the automatic refresh fails", async () => {
    const h = await ready();
    vi.spyOn(h.api, "getLocations")
      .mockResolvedValueOnce(LOCATIONS)
      .mockRejectedValueOnce(new NetworkError("network"));
    h.api.createError = new ApiError("server_full", 409);
    await h.controller.connect(LOCATIONS[0]!.id);
    expect(h.controller.getSnapshot()).toMatchObject({
      locations: [LOCATIONS[1]!],
      error: "server_full",
    });
    expect(h.alarms.reconnectAt).toBeNull();
  });

  it("keeps a full target suspended after refresh, alarms and a worker restart", async () => {
    const h = await ready();
    h.api.createError = new ApiError("server_full", 409);
    const create = vi.spyOn(h.api, "createProxySession");
    await h.controller.connect(LOCATIONS[0]!.id);
    await h.controller.refreshLocations();
    expect(h.securityStorage.state?.capacityBlockedLocationId).toBe(LOCATIONS[0]!.id);
    await h.controller.handleAlarm(ALARM_RECONNECT);
    await h.controller.retryConnection(true);
    const restored = restart(h);
    await restored.initialize();
    await restored.retryConnection(true);
    expect(create).toHaveBeenCalledTimes(1);
    expect(restored.getSnapshot()).toMatchObject({
      error: "server_full",
      protected: false,
      trafficBlocked: true,
    });
    h.api.createError = null;
    expect(await restored.retryConnection()).toEqual({ ok: true });
    expect(create).toHaveBeenCalledTimes(2);
    expect(h.securityStorage.state?.capacityBlockedLocationId).toBeNull();
  });

  it("retries uncertain capacity after the existing backoff and Retry-After", async () => {
    const h = await ready();
    h.api.createError = new ApiError("capacity_unavailable", 503, 90);
    const create = vi.spyOn(h.api, "createProxySession");
    await h.controller.connect(LOCATIONS[0]!.id);
    expect(h.alarms.reconnectAt).toBe(NOW + 90_000);
    expect(h.securityStorage.state?.proxyCreationUncertain).toBe(false);
    h.setNow(NOW + 89_000);
    await h.controller.handleAlarm(ALARM_RECONNECT);
    expect(create).toHaveBeenCalledTimes(1);
    h.api.createError = null;
    h.setNow(NOW + 90_000);
    await h.controller.handleAlarm(ALARM_RECONNECT);
    expect(create).toHaveBeenCalledTimes(2);
    expect(h.controller.getSnapshot().protected).toBe(true);
  });

  it("retains the active location metadata and exact expiry when renewal reports full", async () => {
    const h = await ready(true);
    const previous = structuredClone(h.storage.transient.proxySession);
    h.api.createError = new ApiError("server_full", 409);
    h.api.locations = [LOCATIONS[1]!];
    await h.controller.handleAlarm(ALARM_REFRESH);
    expect(h.controller.getSnapshot()).toMatchObject({
      protected: true,
      error: "server_full",
      locations: [LOCATIONS[1]!],
      activeLocation: LOCATIONS[0],
    });
    expect(h.storage.transient.proxySession).toEqual(previous);
    expect(h.storage.transient.activeLocation).toEqual(LOCATIONS[0]);
    expect(h.alarms.retryAt).toBeNull();
    const create = vi.spyOn(h.api, "createProxySession");
    const restored = restart(h);
    await restored.initialize();
    expect(restored.getSnapshot()).toMatchObject({
      status: "connected",
      protected: true,
      error: "server_full",
      activeLocation: LOCATIONS[0],
    });
    await restored.handleAlarm(ALARM_REFRESH);
    expect(create).not.toHaveBeenCalled();
    h.setNow(Date.parse(previous!.expiresAt));
    await h.controller.handleAlarm(ALARM_EXPIRY);
    expect(h.controller.getSnapshot()).toMatchObject({
      protected: false,
      trafficBlocked: true,
      activeLocation: null,
    });
    expect(await h.controller.getActiveSession()).toBeNull();
    expect(h.alarms.reconnectAt).toBeNull();
  });

  it("retains a verified previous session after a full change without changing its expiry", async () => {
    const h = await ready(true);
    const previous = structuredClone(h.storage.transient.proxySession);
    h.api.createError = new ApiError("server_full", 409);
    const create = vi.spyOn(h.api, "createProxySession");
    await h.controller.changeLocation(LOCATIONS[1]!.id);
    expect(create).toHaveBeenCalledTimes(1);
    expect(h.storage.transient.proxySession).toEqual(previous);
    expect(h.controller.getSnapshot()).toMatchObject({
      protected: true,
      activeLocation: LOCATIONS[0],
      selectedLocationId: LOCATIONS[1]!.id,
      error: "server_full",
      locations: [LOCATIONS[0]!],
    });
    expect(h.securityStorage.state?.selectedLocationId).toBe(LOCATIONS[1]!.id);
    expect(h.storage.persisted.selectedLocationId).toBe(LOCATIONS[1]!.id);
    const restored = restart(h);
    await restored.initialize();
    await restored.refreshAccount();
    expect(restored.getSnapshot()).toMatchObject({
      selectedLocationId: LOCATIONS[1]!.id,
      activeLocationId: LOCATIONS[0]!.id,
      protected: true,
      error: "server_full",
    });
  });

  it("retains a valid session and respects Retry-After when renewal capacity is unavailable", async () => {
    const h = await ready(true);
    const previous = structuredClone(h.storage.transient.proxySession);
    h.api.createError = new ApiError("capacity_unavailable", 503, 120);
    await h.controller.handleAlarm(ALARM_REFRESH);
    expect(h.controller.getSnapshot()).toMatchObject({
      protected: true,
      error: "capacity_unavailable",
    });
    expect(h.storage.transient.proxySession).toEqual(previous);
    expect(h.alarms.retryAt).toBe(NOW + 120_000);
    expect(h.securityStorage.state).toMatchObject({
      proxyCreationUncertain: false,
      retrySuspended: false,
    });
  });

  it("does not restore a previous session invalidated by confirmed device revocation", async () => {
    const h = await ready(true);
    vi.spyOn(h.api, "createProxySession")
      .mockRejectedValueOnce(new ApiError("device_identity_revoked", 403))
      .mockRejectedValueOnce(new ApiError("server_full", 409));
    await h.controller.handleAlarm(ALARM_REFRESH);
    expect(h.controller.getSnapshot()).toMatchObject({
      protected: false,
      error: "server_full",
      trafficBlocked: true,
    });
    expect(await h.controller.getActiveSession()).toBeNull();
    expect(h.storage.transient.proxySession).toBeNull();
  });

  it("deduplicates simultaneous catalog refreshes without account requests", async () => {
    const h = await ready();
    const pending = deferred<Location[]>();
    const locations = vi.spyOn(h.api, "getLocations").mockReturnValue(pending.promise);
    const profile = vi.spyOn(h.api, "getProfile");
    const subscription = vi.spyOn(h.api, "getSubscription");
    const first = h.controller.refreshLocations();
    const second = h.controller.refreshLocations();
    await vi.waitFor(() => expect(locations).toHaveBeenCalledTimes(1));
    pending.resolve([]);
    expect(await Promise.all([first, second])).toEqual([{ ok: true }, { ok: true }]);
    expect(profile).not.toHaveBeenCalled();
    expect(subscription).not.toHaveBeenCalled();
    expect(h.controller.getSnapshot().locations).toEqual([]);
    expect(h.storage.persisted.selectedLocationId).toBe(LOCATIONS[0]!.id);
  });

  it("rejects a pre-refusal catalog and makes its waiters wait for the replacement", async () => {
    const h = await ready(true);
    const stale = deferred<Location[]>();
    const fresh = deferred<Location[]>();
    const locations = vi
      .spyOn(h.api, "getLocations")
      .mockReturnValueOnce(stale.promise)
      .mockReturnValueOnce(fresh.promise);
    let accountComplete = false;
    const account = h.controller.refreshAccount().then((result) => {
      accountComplete = true;
      return result;
    });
    await vi.waitFor(() => expect(locations).toHaveBeenCalledTimes(1));
    h.api.createError = new ApiError("server_full", 409);
    const renewing = h.controller.handleAlarm(ALARM_REFRESH);
    await vi.waitFor(() => expect(locations).toHaveBeenCalledTimes(2));
    stale.resolve(LOCATIONS);
    await Promise.resolve();
    await Promise.resolve();
    expect(accountComplete).toBe(false);
    fresh.resolve([LOCATIONS[1]!]);
    await Promise.all([account, renewing]);
    expect(h.controller.getSnapshot()).toMatchObject({
      locations: [LOCATIONS[1]!],
      error: "server_full",
    });
  });

  it("does not undo a deliberate disconnect while the capacity refresh is outstanding", async () => {
    const h = await ready();
    const pending = deferred<Location[]>();
    const locations = vi
      .spyOn(h.api, "getLocations")
      .mockResolvedValueOnce(LOCATIONS)
      .mockReturnValueOnce(pending.promise);
    h.api.createError = new ApiError("server_full", 409);
    const connecting = h.controller.connect(LOCATIONS[0]!.id);
    await vi.waitFor(() => expect(locations).toHaveBeenCalledTimes(2));
    await h.controller.disconnect();
    pending.resolve([LOCATIONS[1]!]);
    expect(await connecting).toMatchObject({ ok: false, superseded: true });
    expect(h.controller.getSnapshot()).toMatchObject({
      protected: false,
      protectionRequested: false,
      error: null,
    });
    expect(h.securityStorage.state?.capacityBlockedLocationId).toBeNull();
    expect(h.alarms.reconnectAt).toBeNull();
  });

  it("cannot overwrite a new account with an old catalog response", async () => {
    const h = await ready();
    const pending = deferred<Location[]>();
    const locations = vi.spyOn(h.api, "getLocations").mockReturnValueOnce(pending.promise);
    const refreshing = h.controller.refreshLocations();
    await vi.waitFor(() => expect(locations).toHaveBeenCalledTimes(1));
    await h.controller.logout();
    h.api.profile = { ...PROFILE, userId: "other-account" };
    h.api.locations = [LOCATIONS[1]!];
    await h.controller.login("other@example.test", "test-password");
    pending.resolve(LOCATIONS);
    expect(await refreshing).toMatchObject({ ok: false, superseded: true });
    expect(h.controller.getSnapshot()).toMatchObject({
      profile: { userId: "other-account" },
      locations: [LOCATIONS[1]!],
    });
  });

  it("keeps generic server failures uncertain instead of treating them as capacity refusals", async () => {
    const h = await ready();
    h.api.createError = new ApiError("capacity_unavailable", 500);
    const locations = vi.spyOn(h.api, "getLocations");
    await h.controller.connect(LOCATIONS[0]!.id);
    expect(h.controller.getSnapshot().error).toBe("proxy_creation_uncertain");
    expect(h.securityStorage.state?.proxyCreationUncertain).toBe(true);
    expect(locations).toHaveBeenCalledTimes(1);
    expect(mapError(new ApiError("capacity_unavailable", 503))).toBe("capacity_unavailable");
    expect(mapError(new ApiError("capacity_unavailable", 500))).toBe("proxy_unavailable");
  });

  it("preserves an absent manual selection until the location becomes available again", async () => {
    const h = await ready();
    h.api.locations = [LOCATIONS[1]!];
    await h.controller.refreshAccount();
    expect(h.controller.getSnapshot().selectedLocationId).toBe(LOCATIONS[0]!.id);
    expect(h.storage.persisted.selectedLocationId).toBe(LOCATIONS[0]!.id);
    h.api.locations = LOCATIONS;
    await h.controller.refreshLocations();
    expect(h.controller.getSnapshot()).toMatchObject({
      selectedLocationId: LOCATIONS[0]!.id,
      locations: LOCATIONS,
    });
  });

  it("resolves Auto from the freshly fetched catalog rather than the requested cached target", async () => {
    const h = await ready();
    const select = vi.fn(async (locations: Location[]) => {
      await Promise.resolve();
      return locations[0]?.id ?? null;
    });
    const controller = new AppController({
      api: h.api,
      storage: h.storage,
      identity: h.identity,
      proxy: h.proxy,
      alarms: h.alarms,
      safety: h.safety,
      securityStorage: h.securityStorage,
      now: () => NOW,
      onStateChanged: () => undefined,
      resolveAutomaticLocation: select,
    });
    await controller.initialize();
    h.api.locations = [LOCATIONS[1]!];
    const create = vi.spyOn(h.api, "createProxySession");
    expect(await controller.connect(LOCATIONS[0]!.id)).toEqual({ ok: true });
    expect(select).toHaveBeenCalledWith([LOCATIONS[1]!]);
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0]?.[1]).toBe(LOCATIONS[1]!.id);
    expect(controller.getSnapshot().activeLocationId).toBe(LOCATIONS[1]!.id);
  });

  it.each([
    ["server_full", 409],
    ["capacity_unavailable", 503],
  ] as const)(
    "settles a late %s after a settings change without stranding its creation marker",
    async (code, status) => {
      const h = await ready(true);
      const previous = structuredClone(h.storage.transient.proxySession);
      const refusal = deferred<ApiError>();
      const create = vi.spyOn(h.api, "createProxySession").mockImplementation(async () => {
        throw await refusal.promise;
      });
      const locations = vi.spyOn(h.api, "getLocations");
      const changing = h.controller.changeLocation(LOCATIONS[1]!.id);
      await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(1));
      expect(h.securityStorage.state?.proxyCreationUncertain).toBe(true);
      await h.controller.updateSecurityPreferences(false, true);
      refusal.resolve(new ApiError(code, status, 90));
      expect(await changing).toMatchObject({ ok: false, superseded: true });
      expect(h.securityStorage.state).toMatchObject({
        proxyCreationUncertain: false,
        proxyCleanupUncertain: false,
      });
      expect(h.controller.getSnapshot()).toMatchObject({ error: code, protected: true });
      expect(h.storage.transient.proxySession).toEqual(previous);
      expect(locations).toHaveBeenCalledTimes(2);
      if (code === "server_full") {
        expect(h.securityStorage.state?.capacityBlockedLocationId).toBe(LOCATIONS[1]!.id);
        expect(h.controller.getSnapshot().locations).toEqual([LOCATIONS[0]!]);
      } else {
        expect(h.securityStorage.state?.retrySuspended).toBe(false);
        expect(h.securityStorage.state?.retryNotBefore).toBe(NOW + 90_000);
        expect(h.alarms.retryAt).toBeGreaterThanOrEqual(NOW + 90_000);
      }
    },
  );

  it("rearms renewal when the user explicitly selects the retained full location again", async () => {
    const h = await ready(true);
    h.api.createError = new ApiError("server_full", 409);
    await h.controller.handleAlarm(ALARM_REFRESH);
    expect(h.storage.transient.refreshAttempts).toBeGreaterThan(0);
    const schedule = vi.spyOn(h.alarms, "scheduleSession");
    h.api.createError = null;
    await h.controller.connect(LOCATIONS[0]!.id);
    expect(h.securityStorage.state?.capacityBlockedLocationId).toBeNull();
    expect(h.storage.transient.refreshAttempts).toBe(0);
    expect(schedule).toHaveBeenCalledTimes(1);
    await h.controller.handleAlarm(ALARM_REFRESH);
    expect(h.controller.getSnapshot()).toMatchObject({ protected: true, error: null });
  });

  it("keeps location details when a successful creation fills its server during a concurrent refresh", async () => {
    const h = await ready();
    const pending = deferred<undefined>();
    h.api.createWait = pending.promise;
    const create = vi.spyOn(h.api, "createProxySession");
    const connecting = h.controller.connect(LOCATIONS[0]!.id);
    await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    h.api.locations = [LOCATIONS[1]!];
    await h.controller.refreshLocations();
    pending.resolve(undefined);
    expect(await connecting).toEqual({ ok: true });
    expect(h.controller.getSnapshot()).toMatchObject({
      activeLocationId: LOCATIONS[0]!.id,
      activeLocation: LOCATIONS[0],
      locations: [LOCATIONS[1]!],
      protected: true,
    });
    expect(h.storage.transient.activeLocation).toEqual(LOCATIONS[0]);
  });
});
