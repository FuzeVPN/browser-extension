// SPDX-License-Identifier: MPL-2.0

import { ApiError } from "../../src/core/api/client";
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

async function signedIn() {
  const h = createHarness({ persisted: authenticatedState() });
  h.identity.deviceId = "browser-device-1";
  await h.controller.initialize();
  await h.controller.refreshAccount();
  return h;
}

/** An attempt which fails on its account read, before any session request of its own. */
async function failBeforeRequest(h: Awaited<ReturnType<typeof signedIn>>) {
  const requests = h.api.proofs.length;
  vi.spyOn(h.api, "getProfile").mockRejectedValueOnce(new ApiError("server_error", 503));
  expect(await h.controller.connect("frankfurt-01")).toEqual({
    ok: false,
    commandError: "proxy_unavailable",
  });
  expect(h.api.proofs).toHaveLength(requests);
}

afterEach(() => vi.restoreAllMocks());

describe("a session request still unanswered when a newer attempt fails before its own", () => {
  it.each(["refused with a 429", "answered with a session"] as const)(
    "leaves no creation marker and retries once the older request is %s",
    async (outcome) => {
      const h = await signedIn();
      const response = deferred<ProxySession>();
      const create = vi.spyOn(h.api, "createProxySession").mockReturnValueOnce(response.promise);
      const first = h.controller.connect("frankfurt-01");
      await vi.waitFor(() => expect(create).toHaveBeenCalledOnce());

      // The user asks again: that attempt replaces the first one, then fails.
      await failBeforeRequest(h);
      expect(create).toHaveBeenCalledOnce();
      // While the first request is unanswered, its marker rightly defers the retry.
      expect(h.securityStorage.state).toMatchObject({
        protectionRequested: true,
        proxyCreationUncertain: true,
        nextRetryAt: null,
      });
      expect(h.alarms.reconnectAt).toBeNull();

      if (outcome === "answered with a session") response.resolve(proxySession("discarded-first"));
      else response.reject(new ApiError("rate_limited", 429, 30));
      expect(await first).toEqual({ ok: false, superseded: true });
      await settle();
      if (outcome === "answered with a session") expect(h.api.revoked).toContain("discarded-first");

      // Every request is settled and the cleanup marker agrees that nothing is unknown:
      // no creation marker is left to keep the automatic retries off.
      expect(create).toHaveBeenCalledOnce();
      expect(h.securityStorage.state?.proxyCleanupUncertain).toBe(false);
      expect(h.securityStorage.state).toMatchObject({
        protectionRequested: true,
        proxyCreationUncertain: false,
        retrySuspended: false,
      });

      // The retryable failure of the second attempt then gets its automatic retry.
      const reconnectAt = h.alarms.reconnectAt;
      expect(reconnectAt).not.toBeNull();
      expect(h.securityStorage.state?.nextRetryAt).toBe(reconnectAt);
      h.setNow(reconnectAt!);
      await h.controller.handleAlarm(ALARM_RECONNECT);
      expect(h.controller.getSnapshot()).toMatchObject({ status: "connected", protected: true });
    },
  );

  it("retries the same failure by itself when no older request is in flight", async () => {
    const h = await signedIn();
    await failBeforeRequest(h);

    expect(h.securityStorage.state).toMatchObject({
      protectionRequested: true,
      proxyCreationUncertain: false,
      retrySuspended: false,
      nextRetryAt: NOW + 30_000,
    });
    expect(h.alarms.reconnectAt).toBe(NOW + 30_000);
    h.setNow(NOW + 30_000);
    await h.controller.handleAlarm(ALARM_RECONNECT);
    expect(h.controller.getSnapshot()).toMatchObject({ status: "connected", protected: true });
  });
});
