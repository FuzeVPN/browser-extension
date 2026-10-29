// SPDX-License-Identifier: MPL-2.0

import { ApiError, NetworkError } from "../../src/core/api/client";
import { ALARM_RECONNECT } from "../../src/core/shared/config";
import { DEFAULT_SECURITY_STATE } from "../../src/core/shared/security";
import { authenticatedState, createHarness, NOW, proxySession } from "./helpers";

/** Fails a connection with a rate limit: the kill switch blocks while a reconnect is scheduled. */
async function rateLimitedWithoutSession() {
  const h = createHarness({ persisted: authenticatedState() });
  await h.controller.initialize();
  h.api.createError = new ApiError("rate_limited", 429, 60);
  expect(await h.controller.connect("frankfurt-01")).toMatchObject({ ok: false });
  const reconnectAt = NOW + 60_000;
  expect(await h.controller.getActiveSession()).toBeNull();
  expect(h.proxy.blockingRoute).toBe(true);
  expect(h.alarms.reconnectAt).toBe(reconnectAt);
  expect(h.securityStorage.state).toMatchObject({
    nextRetryAt: reconnectAt,
    retrySuspended: false,
  });
  return { ...h, reconnectAt };
}

async function takeOver(h: Awaited<ReturnType<typeof rateLimitedWithoutSession>>) {
  h.proxy.level = "controlled_by_other_extensions";
  await h.controller.handleProxyControlLost("controlled_by_other_extensions");
  expect(h.controller.getSnapshot()).toMatchObject({
    status: "error",
    protected: false,
    trafficBlocked: false,
    blockingScope: "unverified",
    error: "proxy_controlled_by_extension",
  });
  // The request guard stays closed and the scheduled reconnect survives the takeover.
  expect(await h.safety.inspect()).toMatchObject({ trafficBlocked: true });
  expect(h.alarms.reconnectAt).toBe(h.reconnectAt);
  expect(h.securityStorage.state).toMatchObject({
    nextRetryAt: h.reconnectAt,
    retrySuspended: false,
  });
}

describe("guard route takeover while a reconnect is scheduled", () => {
  for (const release of ["resumes our route", "lets us restore the route"] as const) {
    it(`keeps the reconnect and clears the stale control error when the release ${release}`, async () => {
      const h = await rateLimitedWithoutSession();
      await takeOver(h);

      if (release === "resumes our route") {
        h.proxy.level = "controlled_by_this_extension";
      } else {
        h.proxy.level = "controllable_by_this_extension";
        h.proxy.blockingRoute = false;
      }
      await h.controller.handleProxyControlLost(h.proxy.level);
      expect(await h.proxy.isGuardedConfiguration()).toBe(true);
      expect(h.controller.getSnapshot()).toMatchObject({
        status: "blocked",
        protected: false,
        trafficBlocked: true,
        blockingScope: "all",
        error: null,
        nextRetryAt: h.reconnectAt,
      });
      expect(h.alarms.reconnectAt).toBe(h.reconnectAt);

      h.api.createError = null;
      h.setNow(h.reconnectAt + 1_000);
      await h.controller.handleAlarm(ALARM_RECONNECT);
      expect(h.controller.getSnapshot()).toMatchObject({
        status: "connected",
        protected: true,
        error: null,
      });
    });
  }

  it("suspends the reconnect when the takeover still holds at its deadline", async () => {
    const h = await rateLimitedWithoutSession();
    await takeOver(h);
    const creates = h.api.proofs.length;

    h.api.createError = null;
    h.setNow(h.reconnectAt + 1_000);
    await h.controller.handleAlarm(ALARM_RECONNECT);
    expect(h.api.proofs).toHaveLength(creates);
    expect(h.alarms.reconnectAt).toBeNull();
    expect(h.securityStorage.state).toMatchObject({ nextRetryAt: null, retrySuspended: true });
    expect(h.controller.getSnapshot()).toMatchObject({
      protected: false,
      error: "proxy_controlled_by_extension",
    });
    expect(h.safety.events).not.toContain("allow");
  });

  it.each(["device_limit", "proxy_creation_uncertain"] as const)(
    "shows the %s block again once the takeover ends",
    async (reason) => {
      const h = createHarness({
        persisted: authenticatedState({ autoConnect: reason === "proxy_creation_uncertain" }),
        ...(reason === "proxy_creation_uncertain"
          ? { activeProxy: proxySession("xreview-guard-stale") }
          : {}),
      });
      if (reason === "proxy_creation_uncertain") {
        // A failed restart rebuild retains and blocks the stale browser route.
        h.api.createError = new NetworkError("network");
        await h.controller.initialize();
      } else {
        await h.controller.initialize();
        h.api.createError = new ApiError("device_limit", 409);
        expect(await h.controller.connect("frankfurt-01")).toMatchObject({ ok: false });
      }
      expect(h.controller.getSnapshot()).toMatchObject({ trafficBlocked: true, error: reason });

      h.proxy.level = "controlled_by_other_extensions";
      await h.controller.handleProxyControlLost("controlled_by_other_extensions");
      expect(h.controller.getSnapshot().error).toBe("proxy_controlled_by_extension");

      h.proxy.level = "controlled_by_this_extension";
      await h.controller.handleProxyControlLost("controlled_by_this_extension");
      expect(h.controller.getSnapshot()).toMatchObject({
        status: "blocked",
        trafficBlocked: true,
        error: reason,
      });
    },
  );
});

/** A startup refused by a takeover leaves a session only our blocking route still guards. */
async function refusedGuardedRestore(killSwitchEnabled: boolean) {
  const session = proxySession(
    "xreview-guard-repair",
    "frankfurt-01",
    new Date(NOW - 540_000).toISOString(),
  );
  const transient = {
    proxySession: session,
    refreshAttempts: 2,
    refreshRetryAt: NOW + 45_000,
    retiredSessions: [],
  };
  const h = createHarness({
    persisted: authenticatedState({ autoConnect: true }),
    security: { ...DEFAULT_SECURITY_STATE, protectionRequested: true, killSwitchEnabled },
    transient,
  });
  await h.proxy.ensureBlockingConfiguration();
  h.proxy.level = "controlled_by_other_extensions";
  await h.controller.initialize();
  expect(h.controller.getSnapshot().error).toBe("proxy_controlled_by_extension");
  expect(h.storage.transient).toEqual(transient);
  // The repair finds the guard route ours again: restoring must reapply the session.
  h.proxy.level = "controlled_by_this_extension";
  h.proxy.blockingRoute = true;
  return { ...h, session, transient };
}

/** Rejects the control checks that follow the repair's recovery read with an IPC failure. */
function rejectControlChecks(h: Awaited<ReturnType<typeof refusedGuardedRestore>>, count: number) {
  let remaining = 0;
  const getRecovery = h.identity.getRecovery.bind(h.identity);
  vi.spyOn(h.identity, "getRecovery").mockImplementationOnce(async (userId) => {
    const recovery = await getRecovery(userId);
    remaining = count;
    return recovery;
  });
  const assertControllable = h.proxy.assertControllable.bind(h.proxy);
  vi.spyOn(h.proxy, "assertControllable").mockImplementation(async () => {
    if (remaining > 0) {
      remaining -= 1;
      throw new Error("extension context unavailable");
    }
    return assertControllable();
  });
}

describe("startup guard repair on a guarded restoration", () => {
  afterEach(() => vi.restoreAllMocks());

  it.each([true, false])(
    "restores the session after one inconclusive control re-check, kill switch %s",
    async (killSwitchEnabled) => {
      const h = await refusedGuardedRestore(killSwitchEnabled);
      rejectControlChecks(h, 1);
      await h.controller.initialize();
      expect(await h.controller.getActiveSession()).toEqual(h.session);
      expect(h.controller.getSnapshot()).toMatchObject({ protected: true, error: null });
      expect(h.storage.transient).toMatchObject({ proxySession: h.session, refreshAttempts: 2 });
      expect(h.api.proofs).toHaveLength(0);
    },
  );

  it.each([true, false])(
    "keeps the session and its budget while control checks keep failing, kill switch %s",
    async (killSwitchEnabled) => {
      const h = await refusedGuardedRestore(killSwitchEnabled);
      rejectControlChecks(h, Number.POSITIVE_INFINITY);
      await h.controller.initialize();
      expect(h.storage.transient).toEqual(h.transient);
      expect(h.snapshots.filter((snapshot) => snapshot.protected)).toEqual([]);
      expect(h.safety.events).not.toContain("allow");

      vi.restoreAllMocks();
      await h.controller.initialize();
      expect(await h.controller.getActiveSession()).toEqual(h.session);
      expect(h.controller.getSnapshot()).toMatchObject({ protected: true, error: null });
      expect(h.api.proofs).toHaveLength(0);
    },
  );
});
