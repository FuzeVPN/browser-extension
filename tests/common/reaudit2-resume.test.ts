// SPDX-License-Identifier: MPL-2.0

import { ApiError, NetworkError } from "../../src/core/api/client";
import type { ProxySession } from "../../src/core/api/types";
import { ALARM_RECONNECT } from "../../src/core/shared/config";
import { authenticatedState, createHarness, NOW, proxySession } from "./helpers";

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

/** The settled marker leaves one prompt reconnection, which restores protection. */
async function expectReconnection(h: Harness, reconnectAt: number) {
  expect(h.alarms.reconnectAt).toBe(reconnectAt);
  expect(h.securityStorage.state).toMatchObject({
    proxyCreationUncertain: false,
    retrySuspended: false,
    nextRetryAt: reconnectAt,
  });
  h.setNow(reconnectAt);
  await h.controller.handleAlarm(ALARM_RECONNECT);
  expect(h.controller.getSnapshot()).toMatchObject({ status: "connected", protected: true });
}

/** connect(F1) with its POST held, then superseded by a settings command. */
async function supersededInitialConnection() {
  const h = createHarness({ persisted: authenticatedState() });
  h.identity.deviceId = "browser-device-1";
  await h.controller.initialize();
  await h.controller.refreshAccount();
  const response = deferred<ProxySession>();
  const create = vi.spyOn(h.api, "createProxySession").mockReturnValueOnce(response.promise);
  const connecting = h.controller.connect("frankfurt-01");
  await vi.waitFor(() => expect(create).toHaveBeenCalledOnce());
  expect(await h.controller.updateSecurityPreferences(true, false)).toEqual({ ok: true });
  return { h, response, connecting };
}

const READ_FAILURES = {
  // A truncated or undecodable body.
  account_invalid_response: async (h: Harness) => {
    vi.spyOn(h.api, "getProfile").mockRejectedValueOnce(new NetworkError("invalid_response"));
    return h.controller.refreshAccount();
  },
  // A 403 without a known code, such as a WAF or captive portal reply.
  account_unknown_error: async (h: Harness) => {
    vi.spyOn(h.api, "getProfile").mockRejectedValueOnce(new ApiError("server_error", 403));
    return h.controller.refreshAccount();
  },
  account_not_found: async (h: Harness) => {
    vi.spyOn(h.api, "getProfile").mockRejectedValueOnce(new ApiError("not_found", 404));
    return h.controller.refreshAccount();
  },
  devices_invalid_response: async (h: Harness) => {
    vi.spyOn(h.api, "getDevices").mockRejectedValueOnce(new NetworkError("invalid_response"));
    return h.controller.refreshDevices();
  },
  // A rejected command: the location left the catalog.
  selection_invalid_location: (h: Harness) => h.controller.selectLocation("frankfurt-99"),
} as const;

describe("a settlement without a session after a read or a rejected command", () => {
  afterEach(() => vi.restoreAllMocks());

  it.each([
    { failure: "account_invalid_response", error: "invalid_response", result: "created" },
    { failure: "account_invalid_response", error: "invalid_response", result: "429" },
    { failure: "account_unknown_error", error: "unknown_error", result: "created" },
    { failure: "account_not_found", error: "not_found", result: "created" },
    { failure: "devices_invalid_response", error: "invalid_response", result: "created" },
    { failure: "selection_invalid_location", error: "invalid_location", result: "created" },
    { failure: "selection_invalid_location", error: "invalid_location", result: "429" },
  ] as const)(
    "resumes requested protection after $failure ($error) and a late $result",
    async ({ failure, error, result }) => {
      const { h, response, connecting } = await supersededInitialConnection();
      expect(await READ_FAILURES[failure](h)).toMatchObject({ ok: false, commandError: error });
      // Only the displayed error changed: no failure suspended the automatic retries.
      expect(h.controller.getSnapshot()).toMatchObject({ error, trafficBlocked: true });

      if (result === "created") response.resolve(proxySession("discarded-initial"));
      else response.reject(new ApiError("rate_limited", 429, 30));
      expect(await connecting).toMatchObject({ ok: false });
      await settle();

      expect(h.controller.getSnapshot()).toMatchObject({ status: "blocked", trafficBlocked: true });
      await expectReconnection(h, NOW + (result === "429" ? 30_000 : 1_000));
    },
  );

  it("persists the resumed reconnection for a restarted worker", async () => {
    const { h, response, connecting } = await supersededInitialConnection();
    await READ_FAILURES.account_invalid_response(h);
    response.resolve(proxySession("discarded-initial"));
    await connecting;
    await settle();

    const restarted = createHarness({
      persisted: h.storage.persisted,
      transient: h.storage.transient,
      security: h.securityStorage.state ?? undefined,
    });
    restarted.identity.deviceId = "browser-device-1";
    restarted.setNow(NOW + 500);
    await restarted.controller.initialize();
    await expectReconnection(restarted, NOW + 1_000);
  });

  it("keeps retries suspended after a failure which does not retry, whatever is displayed later", async () => {
    const { h, response, connecting } = await supersededInitialConnection();
    // The request filter disappeared: this failure suspends the retries for a cause of its own.
    h.safety.status.filterActive = false;
    await h.controller.handlePrivacyChange();
    expect(h.controller.getSnapshot()).toMatchObject({ error: "traffic_guard_failed" });
    expect(await READ_FAILURES.selection_invalid_location(h)).toMatchObject({
      commandError: "invalid_location",
    });
    expect(await h.controller.refreshAccount()).toEqual({ ok: true });
    expect(h.controller.getSnapshot()).toMatchObject({ error: null });

    response.resolve(proxySession("discarded-initial"));
    await connecting;
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

describe("a connection superseded by a selection after a superseded disconnect", () => {
  afterEach(() => vi.restoreAllMocks());

  /**
   * connect(F1) holds its POST; disconnect() releases the guards and is held either at its
   * security write (protection no longer requested) or right after the release (protection
   * still requested). connect(F2) supersedes it, then selectLocation(F1) supersedes connect(F2)
   * before its first mutation.
   */
  async function supersededAfterRelease(hold: "security_write" | "release") {
    const h = createHarness({ persisted: authenticatedState() });
    h.identity.deviceId = "browser-device-1";
    await h.controller.initialize();
    await h.controller.refreshAccount();
    const post = deferred();
    h.api.createWait = post.promise;
    const first = h.controller.connect("frankfurt-01");
    await vi.waitFor(() => expect(h.api.proofs).toHaveLength(1));
    expect(h.safety.status).toMatchObject({ trafficBlocked: true, filterActive: true });

    const reached = deferred();
    const held = deferred();
    if (hold === "security_write") {
      const write = h.securityStorage.write.bind(h.securityStorage);
      vi.spyOn(h.securityStorage, "write").mockImplementation(async (state) => {
        if (!state.protectionRequested) {
          reached.resolve();
          await held.promise;
        }
        return write(state);
      });
    } else {
      const release = h.safety.release.bind(h.safety);
      vi.spyOn(h.safety, "release").mockImplementationOnce(async () => {
        await release();
        reached.resolve();
        await held.promise;
      });
    }
    const stopping = h.controller.disconnect();
    await reached.promise;
    expect(h.safety.status).toMatchObject({ trafficBlocked: false, filterActive: false });
    const second = h.controller.connect("frankfurt-02");
    const selected = h.controller.selectLocation("frankfurt-01");
    for (let tick = 0; tick < 5; tick += 1) await settle();
    held.resolve();
    expect(await stopping).toEqual({ ok: false, superseded: true });
    expect(await second).toEqual({ ok: false, superseded: true });
    expect(await selected).toEqual({ ok: true });
    post.resolve();
    expect(await first).toMatchObject({ ok: false });
    await settle();
    return h;
  }

  it("publishes the released guards once protection is no longer requested", async () => {
    const h = await supersededAfterRelease("security_write");
    expect(h.safety.status).toMatchObject({ trafficBlocked: false, filterActive: false });
    expect(h.controller.getSnapshot()).toMatchObject({
      status: "disconnected",
      protected: false,
      protectionRequested: false,
      trafficBlocked: false,
      blockingScope: "none",
      selectedLocationId: "frankfurt-01",
    });
    expect(h.alarms.reconnectAt).toBeNull();
  });

  it("restores the guard of still requested protection until it reconnects to the selection", async () => {
    const h = await supersededAfterRelease("release");
    expect(h.safety.status).toMatchObject({ trafficBlocked: true, filterActive: true });
    expect(h.controller.getSnapshot()).toMatchObject({
      status: "blocked",
      protected: false,
      protectionRequested: true,
      trafficBlocked: true,
      blockingScope: "all",
    });
    expect(h.alarms.reconnectAt).toBe(NOW + 1_000);

    h.setNow(NOW + 1_000);
    await h.controller.handleAlarm(ALARM_RECONNECT);
    expect(h.controller.getSnapshot()).toMatchObject({
      status: "connected",
      protected: true,
      activeLocationId: "frankfurt-01",
    });
  });
});
