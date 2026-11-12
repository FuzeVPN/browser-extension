// SPDX-License-Identifier: MPL-2.0

import { ApiError, NetworkError } from "../../src/core/api/client";
import { ALARM_REFRESH } from "../../src/core/shared/config";
import { authenticatedState, createHarness, NOW } from "./helpers";

const DAY = 24 * 60 * 60 * 1_000;
const HISTORIES = [
  ["no earlier ambiguous creation", false],
  ["an ambiguous creation settled by a successful manual retry", true],
] as const;

/** A protected connection, reached directly or after one ambiguous session request. */
async function connected(ambiguous: boolean) {
  const h = createHarness({ persisted: authenticatedState() });
  await h.controller.initialize();
  if (ambiguous) {
    h.api.createError = new NetworkError("timeout");
    expect(await h.controller.connect("frankfurt-01")).toEqual({
      ok: false,
      commandError: "proxy_creation_uncertain",
    });
    h.api.createError = null;
    expect(await h.controller.retryConnection()).toEqual({ ok: true });
  } else expect(await h.controller.connect("frankfurt-01")).toEqual({ ok: true });
  expect(h.controller.getSnapshot()).toMatchObject({ status: "connected", protected: true });
  expect(h.securityStorage.state).toMatchObject({
    protectionRequested: true,
    proxyCreationUncertain: false,
    retrySuspended: false,
  });
  return h;
}

afterEach(() => vi.restoreAllMocks());

describe("automatic retries long after one ambiguous session creation", () => {
  it.each(HISTORIES)(
    "schedules the retry of a rate-limited startup with %s",
    async (_label, ambiguous) => {
      const h = await connected(ambiguous);

      // A day later the browser restarts: session storage is gone, and any session the
      // ambiguous request may have created expired long ago.
      const later = NOW + DAY;
      const restarted = createHarness({
        persisted: h.storage.persisted,
        security: h.securityStorage.state!,
      });
      restarted.setNow(later);
      restarted.api.createError = new ApiError("rate_limited", 429, 90);
      await restarted.controller.initialize();

      // The refusal is definitive: nothing was created, so the reconnection is retried.
      expect(restarted.api.proofs).toHaveLength(1);
      expect(restarted.securityStorage.state).toMatchObject({
        protectionRequested: true,
        proxyCreationUncertain: false,
        retrySuspended: false,
        nextRetryAt: later + 90_000,
      });
      expect(restarted.alarms.reconnectAt).toBe(later + 90_000);
      expect(restarted.controller.getSnapshot().error).toBe("rate_limited");
    },
  );

  it.each(HISTORIES)(
    "keeps retrying a rate-limited renewal in the same worker with %s",
    async (_label, ambiguous) => {
      const h = await connected(ambiguous);
      const session = h.proxy.active!;
      const attempts = h.api.proofs.length;
      h.api.createError = new ApiError("rate_limited", 429, 90);
      await h.controller.handleAlarm(ALARM_REFRESH);

      // The live session stays protected and its renewal is tried again later.
      expect(h.api.proofs).toHaveLength(attempts + 1);
      expect(h.proxy.active).toEqual(session);
      expect(h.securityStorage.state).toMatchObject({
        proxyCreationUncertain: false,
        retrySuspended: false,
      });
      expect(h.controller.getSnapshot()).toMatchObject({ protected: true, error: "rate_limited" });
      expect(h.storage.transient).toMatchObject({ proxySession: session, refreshAttempts: 1 });
      expect(h.alarms.retryAt).toBe(NOW + 90_000);
    },
  );

  it("still reports the unknown session at logout after the manual retry", async () => {
    const h = await connected(true);
    expect(h.securityStorage.state?.proxyCleanupUncertain).toBe(true);
    expect(await h.controller.logout()).toEqual({ ok: true });
    expect(h.controller.getSnapshot().logoutOutcome?.proxySessions).toBe("unconfirmed");
  });
});
