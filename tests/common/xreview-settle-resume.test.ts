// SPDX-License-Identifier: MPL-2.0

import { ApiError, NetworkError } from "../../src/core/api/client";
import type { ProxySession } from "../../src/core/api/types";
import { ALARM_EXPIRY, ALARM_RECONNECT, ALARM_REFRESH } from "../../src/core/shared/config";
import { authenticatedState, createHarness, NOW, proxySession } from "./helpers";

const AT = NOW + 510_000;

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

type Harness = ReturnType<typeof createHarness>;

function fresh(id: string, locationId = "frankfurt-01") {
  return proxySession(
    id,
    locationId,
    new Date(AT).toISOString(),
    new Date(AT + 600_000).toISOString(),
  );
}

async function retainedRenewal() {
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
  const response = deferred<ProxySession>();
  const create = vi.spyOn(h.api, "createProxySession").mockReturnValueOnce(response.promise);
  const renewing = h.controller.handleAlarm(ALARM_REFRESH);
  await vi.waitFor(() => expect(create).toHaveBeenCalledOnce());
  return { h, previous, response, renewing };
}

/** The settled marker leaves one prompt reconnection, which restores protection. */
async function expectReconnection(h: Harness, reconnectAt: number) {
  expect(h.alarms.reconnectAt).toBe(reconnectAt);
  expect(h.securityStorage.state).toMatchObject({
    proxyCreationUncertain: false,
    retrySuspended: false,
    nextRetryAt: reconnectAt,
  });
  expect(h.controller.getSnapshot().nextRetryAt).toBe(reconnectAt);
  h.setNow(reconnectAt);
  await h.controller.handleAlarm(ALARM_RECONNECT);
  expect(h.controller.getSnapshot()).toMatchObject({ status: "connected", protected: true });
}

describe("known settlement of a superseded creation without a session", () => {
  afterEach(() => vi.restoreAllMocks());

  it.each([
    { result: "created", accountError: false, delay: 1_000 },
    { result: "created", accountError: true, delay: 1_000 },
    { result: "429", accountError: false, delay: 30_000 },
    { result: "429", accountError: true, delay: 30_000 },
  ] as const)(
    "resumes the initial connection after a late $result (account read error: $accountError)",
    async ({ result, accountError, delay }) => {
      const h = createHarness({ persisted: authenticatedState() });
      await h.controller.initialize();
      await h.controller.refreshAccount();
      const response = deferred<ProxySession>();
      const create = vi.spyOn(h.api, "createProxySession").mockReturnValueOnce(response.promise);
      const connecting = h.controller.connect("frankfurt-01");
      await vi.waitFor(() => expect(create).toHaveBeenCalledOnce());
      expect(await h.controller.updateSecurityPreferences(true, false)).toEqual({ ok: true });
      if (accountError) {
        vi.spyOn(h.api, "getProfile").mockRejectedValueOnce(new NetworkError("network"));
        expect(await h.controller.refreshAccount()).toMatchObject({
          commandError: "network_error",
        });
      }

      if (result === "created") response.resolve(proxySession("discarded-initial"));
      else response.reject(new ApiError("rate_limited", 429, 30));
      expect(await connecting).toMatchObject({ ok: false });

      // A failed account read is not a connection failure: it must not cost the
      // requested protection its reconnection once the creation is settled.
      expect(h.controller.getSnapshot()).toMatchObject({ status: "blocked", trafficBlocked: true });
      await expectReconnection(h, NOW + delay);
    },
  );

  describe("settled during a transient takeover of the guard route", () => {
    async function settledDuringTakeover(
      result: "created" | "429" | "server_full" | "capacity_unavailable",
    ) {
      const h = createHarness({ persisted: authenticatedState() });
      await h.controller.initialize();
      await h.controller.refreshAccount();
      const response = deferred<ProxySession>();
      const create = vi.spyOn(h.api, "createProxySession").mockReturnValueOnce(response.promise);
      const connecting = h.controller.connect("frankfurt-01");
      await vi.waitFor(() => expect(create).toHaveBeenCalledOnce());
      expect(await h.controller.updateSecurityPreferences(true, false)).toEqual({ ok: true });
      h.proxy.level = "controlled_by_other_extensions";
      await h.controller.handleProxyControlLost("controlled_by_other_extensions");

      if (result === "created") response.resolve(proxySession("discarded-initial"));
      else if (result === "429") response.reject(new ApiError("rate_limited", 429, 30));
      else response.reject(new ApiError(result, result === "server_full" ? 409 : 503, 30));
      expect(await connecting).toMatchObject({ ok: false });
      await settle();
      // The takeover suspended nothing; its error still explains the unconfined route.
      expect(h.controller.getSnapshot()).toMatchObject({
        protected: false,
        trafficBlocked: false,
        error: "proxy_controlled_by_extension",
      });
      return h;
    }

    it.each([
      { result: "created", delay: 1_000 },
      { result: "429", delay: 30_000 },
    ] as const)(
      "resumes the initial connection after a $result once control returns",
      async ({ result, delay }) => {
        const h = await settledDuringTakeover(result);
        expect(h.alarms.reconnectAt).toBe(NOW + delay);

        h.proxy.level = "controlled_by_this_extension";
        await h.controller.handleProxyControlLost("controlled_by_this_extension");
        expect(h.controller.getSnapshot()).toMatchObject({
          status: "blocked",
          trafficBlocked: true,
          error: null,
        });
        await expectReconnection(h, NOW + delay);
      },
    );

    it("keeps the takeover error over a capacity refusal, then shows the server_full block", async () => {
      const h = await settledDuringTakeover("server_full");
      await settle();
      expect(h.controller.getSnapshot()).toMatchObject({ error: "proxy_controlled_by_extension" });

      h.proxy.level = "controlled_by_this_extension";
      await h.controller.handleProxyControlLost("controlled_by_this_extension");
      expect(h.alarms.reconnectAt).toBeNull();
      expect(h.securityStorage.state).toMatchObject({
        capacityBlockedLocationId: "frankfurt-01",
        retrySuspended: true,
      });
      expect(h.controller.getSnapshot()).toMatchObject({
        trafficBlocked: true,
        error: "server_full",
      });
    });

    it("keeps the takeover error over capacity_unavailable, then reconnects once control returns", async () => {
      const h = await settledDuringTakeover("capacity_unavailable");
      await settle();
      expect(h.controller.getSnapshot()).toMatchObject({ error: "proxy_controlled_by_extension" });
      expect(h.alarms.reconnectAt).toBe(NOW + 30_000);

      h.proxy.level = "controlled_by_this_extension";
      await h.controller.handleProxyControlLost("controlled_by_this_extension");
      expect(h.controller.getSnapshot()).toMatchObject({ trafficBlocked: true, error: null });
      await expectReconnection(h, NOW + 30_000);
    });

    it("suspends the resumed reconnect when the takeover still holds at its deadline", async () => {
      const h = await settledDuringTakeover("created");
      const creates = h.api.proofs.length;
      h.setNow(NOW + 1_000);
      await h.controller.handleAlarm(ALARM_RECONNECT);
      expect(h.api.proofs).toHaveLength(creates);
      expect(h.alarms.reconnectAt).toBeNull();
      expect(h.securityStorage.state).toMatchObject({ nextRetryAt: null, retrySuspended: true });
      expect(h.controller.getSnapshot()).toMatchObject({
        protected: false,
        error: "proxy_controlled_by_extension",
      });
    });
  });

  it("resumes a renewal whose session expired during the uncertainty", async () => {
    const { h, previous, response, renewing } = await retainedRenewal();
    expect(await h.controller.updateSecurityPreferences(true, false)).toEqual({ ok: true });
    h.setNow(Date.parse(previous.expiresAt));
    await h.controller.handleAlarm(ALARM_EXPIRY);
    // Only the pending creation kept this retryable expiry from scheduling a reconnection.
    expect(h.controller.getSnapshot()).toMatchObject({ error: "session_expired" });
    expect(h.alarms.reconnectAt).toBeNull();

    response.resolve(fresh("discarded-renewal"));
    await renewing;

    expect(h.controller.getSnapshot()).toMatchObject({
      status: "blocked",
      error: "session_expired",
      protected: false,
    });
    h.api.sessions = [fresh("reconnected-after-expiry")];
    await expectReconnection(h, Date.parse(previous.expiresAt) + 1_000);
  });

  it("keeps retries suspended after a failure which does not retry by itself", async () => {
    const { h, response, renewing } = await retainedRenewal();
    // The permission check confirms the retained route, which is gone when authorized.
    vi.spyOn(h.proxy, "isActiveConfiguration").mockResolvedValueOnce(true).mockResolvedValue(false);
    await h.controller.handleProxyPermissionsChanged();
    vi.mocked(h.proxy.isActiveConfiguration).mockRestore();
    // The displayed code is retryable elsewhere; this failure never retries by itself.
    expect(h.controller.getSnapshot()).toMatchObject({
      status: "blocked",
      error: "proxy_unavailable",
    });

    response.resolve(fresh("discarded-after-permission-change"));
    await renewing;
    await settle();

    expect(h.alarms.reconnectAt).toBeNull();
    expect(h.securityStorage.state).toMatchObject({
      proxyCreationUncertain: false,
      retrySuspended: true,
      nextRetryAt: null,
    });
    expect(h.controller.getSnapshot()).toMatchObject({ protected: false, nextRetryAt: null });
  });
});

describe("a capacity refusal of a replaced target settled after a cancellation", () => {
  afterEach(() => vi.restoreAllMocks());

  it.each([
    { code: "server_full", status: 409, delay: 1_000 },
    { code: "capacity_unavailable", status: 503, delay: 30_000 },
  ] as const)(
    "schedules the reconnection to the selection once after $code",
    async ({ code, status, delay }) => {
      const h = createHarness({ persisted: authenticatedState() });
      h.identity.deviceId = "existing-device";
      await h.controller.initialize();
      await settle();
      const posted = deferred();
      const release = deferred();
      vi.spyOn(h.api, "createProxySession").mockImplementationOnce(async () => {
        posted.resolve();
        await release.promise;
        throw new ApiError(code, status, 30);
      });
      const connecting = h.controller.connect("frankfurt-01");
      await posted.promise;
      const { killSwitchEnabled, webRtcProtectionEnabled } =
        h.controller.getSnapshot().securityPreferences;
      expect(await h.controller.selectLocation("frankfurt-02")).toEqual({ ok: true });
      expect(
        await h.controller.updateSecurityPreferences(killSwitchEnabled, webRtcProtectionEnabled),
      ).toEqual({ ok: true });
      const scheduled = vi.spyOn(h.alarms, "scheduleReconnect");
      const writes = vi.spyOn(h.securityStorage, "write");
      // The catalog refresh which follows the refusal takes time.
      const getLocations = h.api.getLocations.bind(h.api);
      vi.spyOn(h.api, "getLocations").mockImplementation(async () => {
        h.setNow(NOW + 5_000);
        return getLocations();
      });
      release.resolve();
      expect(await connecting).toEqual({ ok: false, superseded: true });
      await settle();

      // One settlement writes and schedules its reconnection once, before the catalog GET;
      // a later write of the refusal's server delay keeps it.
      expect(scheduled.mock.calls).toEqual([[NOW + delay]]);
      const written = writes.mock.calls.map(([state]) => state.nextRetryAt);
      expect(written.filter((at, index) => at !== written[index - 1])).toEqual([null, NOW + delay]);
      expect(h.controller.getSnapshot()).toMatchObject({
        selectedLocationId: "frankfurt-02",
        error: null,
      });
      h.setNow(NOW + delay);
      await h.controller.handleAlarm(ALARM_RECONNECT);
      expect(h.controller.getSnapshot()).toMatchObject({
        status: "connected",
        protected: true,
        activeLocationId: "frankfurt-02",
      });
    },
  );
});
