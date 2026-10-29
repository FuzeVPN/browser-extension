// SPDX-License-Identifier: MPL-2.0

import { ApiError, NetworkError } from "../../src/core/api/client";
import type { ProxySession } from "../../src/core/api/types";
import { ExtensionAlarmService } from "../../src/core/background/session-refresh";
import { AppController } from "../../src/core/background/state-machine";
import { ALARM_EXPIRY, ALARM_REFRESH } from "../../src/core/shared/config";
import { NOW, authenticatedState, createHarness, proxySession } from "./helpers";

const AT = NOW + 510_000;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function fresh(id: string, locationId = "frankfurt-01") {
  return proxySession(
    id,
    locationId,
    new Date(AT).toISOString(),
    new Date(AT + 600_000).toISOString(),
  );
}

async function retainedWithOneAttempt() {
  const previous = proxySession("retained-A");
  const h = createHarness({
    persisted: authenticatedState({ autoConnect: true }),
    transient: {
      proxySession: previous,
      refreshAttempts: 1,
      refreshRetryAt: AT,
      retiredSessions: [],
    },
    activeProxy: previous,
  });
  h.identity.deviceId = "browser-device-1";
  await h.controller.initialize();
  await h.controller.refreshAccount();
  h.setNow(AT);
  return { h, previous };
}

describe("known settlement of a renewal superseded by settings", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it.each([
    ["created", AT + 1_000],
    ["429", AT + 30_000],
  ] as const)(
    "re-arms the retained budget despite an account read error before a late %s",
    async (result, refreshAt) => {
      const { h, previous } = await retainedWithOneAttempt();
      const response = deferred<ProxySession>();
      const create = vi.spyOn(h.api, "createProxySession").mockReturnValueOnce(response.promise);
      const refreshing = h.controller.handleAlarm(ALARM_REFRESH);
      await vi.waitFor(() => expect(create).toHaveBeenCalledOnce());
      expect(await h.controller.updateSecurityPreferences(true, false)).toEqual({ ok: true });
      expect(h.alarms.retryAt).toBeNull();
      vi.spyOn(h.api, "getProfile").mockRejectedValueOnce(new NetworkError("network"));
      expect(await h.controller.refreshAccount()).toMatchObject({ commandError: "network_error" });
      expect(h.controller.getSnapshot()).toMatchObject({ protected: true });

      if (result === "created") response.resolve(fresh("discarded-after-account-error"));
      else response.reject(new ApiError("rate_limited", 429, 30));
      await refreshing;

      // The account error is still displayed; the retained renewal is restored anyway.
      expect(h.alarms.retryAt).toBe(refreshAt);
      expect(h.securityStorage.state).toMatchObject({
        proxyCreationUncertain: false,
        retrySuspended: false,
      });
      expect(h.storage.transient).toMatchObject({
        proxySession: { id: previous.id },
        refreshAttempts: 1,
      });
      expect(h.proxy.active?.id).toBe(previous.id);

      const renewed = fresh("renewed-after-account-error");
      h.api.sessions = [renewed];
      h.setNow(refreshAt);
      await h.controller.handleAlarm(ALARM_REFRESH);
      expect(create).toHaveBeenCalledTimes(2);
      h.setNow(Date.parse(previous.expiresAt));
      await h.controller.handleAlarm(ALARM_EXPIRY);
      expect(h.proxy.active?.id).toBe(renewed.id);
      expect(h.controller.getSnapshot()).toMatchObject({ status: "connected", protected: true });
    },
  );

  it("restores the extension refresh alarm after an account read error", async () => {
    let now = NOW;
    const scheduled = new Map<string, number>();
    vi.spyOn(Date, "now").mockImplementation(() => now);
    vi.stubGlobal("browser", {
      alarms: {
        create: async (name: string, info: { when: number }) => {
          scheduled.set(name, info.when);
        },
        get: async (name: string) => {
          const scheduledTime = scheduled.get(name);
          return scheduledTime === undefined ? undefined : { name, scheduledTime };
        },
        clear: async (name: string) => scheduled.delete(name),
      },
    });
    const previous = proxySession("extension-alarm-A");
    const h = createHarness({
      persisted: authenticatedState({ autoConnect: true }),
      transient: { proxySession: previous, refreshAttempts: 0, retiredSessions: [] },
      activeProxy: previous,
    });
    h.identity.deviceId = "browser-device-1";
    const controller = new AppController({
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
    await controller.initialize();
    await controller.refreshAccount();
    now = AT;
    const response = deferred<ProxySession>();
    const create = vi.spyOn(h.api, "createProxySession").mockReturnValueOnce(response.promise);
    const renewing = controller.handleAlarm(ALARM_REFRESH);
    await vi.waitFor(() => expect(create).toHaveBeenCalledOnce());
    expect(await controller.updateSecurityPreferences(true, false)).toEqual({ ok: true });
    expect(scheduled.has(ALARM_REFRESH)).toBe(false);
    vi.spyOn(h.api, "getProfile").mockRejectedValueOnce(new NetworkError("network"));
    expect(await controller.refreshAccount()).toMatchObject({ commandError: "network_error" });
    response.resolve(fresh("extension-discarded"));
    await renewing;

    expect(scheduled.get(ALARM_REFRESH)).toBe(AT + 1_000);
    expect(scheduled.get(ALARM_EXPIRY)).toBe(Date.parse(previous.expiresAt));
    expect(controller.getSnapshot().protected).toBe(true);
  });

  it("re-arms the retained session when a failed selection error is displayed", async () => {
    const { h, previous } = await retainedWithOneAttempt();
    const response = deferred<ProxySession>();
    const create = vi.spyOn(h.api, "createProxySession").mockReturnValueOnce(response.promise);
    const refreshing = h.controller.handleAlarm(ALARM_REFRESH);
    await vi.waitFor(() => expect(create).toHaveBeenCalledOnce());
    expect(await h.controller.updateSecurityPreferences(true, false)).toEqual({ ok: true });
    vi.spyOn(h.api, "getSubscription").mockRejectedValueOnce(new NetworkError("network"));
    expect(await h.controller.changeLocation("frankfurt-02")).toMatchObject({
      commandError: "network_error",
    });
    expect(h.controller.getSnapshot()).toMatchObject({
      protected: true,
      activeLocationId: previous.locationId,
      error: "network_error",
    });
    expect(h.alarms.retryAt).toBeNull();

    response.resolve(fresh("discarded-after-selection-error"));
    await refreshing;

    expect(create).toHaveBeenCalledOnce();
    expect(h.alarms.retryAt).toBe(AT + 1_000);
    expect(h.securityStorage.state).toMatchObject({
      proxyCreationUncertain: false,
      retrySuspended: false,
    });
    expect(h.proxy.active?.id).toBe(previous.id);
  });

  it("re-arms the retained session while another location stays full", async () => {
    const h = createHarness({ persisted: authenticatedState() });
    await h.controller.initialize();
    expect(await h.controller.connect("frankfurt-01")).toEqual({ ok: true });
    const previous = h.proxy.active!;
    h.api.createError = new ApiError("server_full", 409);
    await h.controller.changeLocation("frankfurt-02");
    h.api.createError = null;
    expect(h.controller.getSnapshot()).toMatchObject({ protected: true, error: "server_full" });
    h.setNow(AT);
    const response = deferred<ProxySession>();
    const create = vi.spyOn(h.api, "createProxySession").mockReturnValueOnce(response.promise);
    const refreshing = h.controller.handleAlarm(ALARM_REFRESH);
    await vi.waitFor(() => expect(create).toHaveBeenCalledOnce());
    expect(await h.controller.updateSecurityPreferences(true, false)).toEqual({ ok: true });
    expect(h.alarms.retryAt).toBeNull();

    response.resolve(fresh("discarded-while-full"));
    await refreshing;

    expect(h.alarms.retryAt).toBe(AT + 1_000);
    // The capacity block of the other location keeps automatic reconnects suspended.
    expect(h.securityStorage.state).toMatchObject({
      proxyCreationUncertain: false,
      retrySuspended: true,
      capacityBlockedLocationId: "frankfurt-02",
    });
    expect(h.proxy.active?.id).toBe(previous.id);
    expect(h.controller.getSnapshot()).toMatchObject({ protected: true, error: "server_full" });
  });
});
