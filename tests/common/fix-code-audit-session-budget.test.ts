// SPDX-License-Identifier: MPL-2.0

import { ApiError } from "../../src/core/api/client";
import { ALARM_EXPIRY, ALARM_REFRESH, MAX_REFRESH_ATTEMPTS } from "../../src/core/shared/config";
import { NOW, authenticatedState, createHarness, proxySession } from "./helpers";

const FIRST_REFRESH = NOW + 510_000;
const LAST_FAILURE = NOW + 570_000;
const SEEDED_DEADLINE = NOW + 550_000;
const A_ID = "code01-retained-A";
type Harness = ReturnType<typeof createHarness>;
type Retain = "select" | "preferences";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function turn() {
  return new Promise<void>((resolve) => setImmediate(resolve));
}

function fresh(id: string, locationId = "frankfurt-02", issuedAt = LAST_FAILURE) {
  return proxySession(
    id,
    locationId,
    new Date(issuedAt).toISOString(),
    new Date(issuedAt + 600_000).toISOString(),
  );
}

async function running(attempts = 0, retryAt = SEEDED_DEADLINE) {
  const a = proxySession(A_ID);
  const h = createHarness({
    persisted: authenticatedState({ autoConnect: true }),
    transient: {
      proxySession: a,
      refreshAttempts: attempts,
      refreshRetryAt: retryAt,
      retiredSessions: [],
    },
    activeProxy: a,
  });
  h.identity.deviceId = "browser-device-1";
  await h.controller.initialize();
  await h.controller.refreshAccount();
  h.setNow(FIRST_REFRESH);
  return h;
}

async function exhaustRealBudget() {
  const h = await running();
  const create = vi.spyOn(h.api, "createProxySession");
  h.api.createError = new ApiError("rate_limited", 429);
  for (const [index, at] of [FIRST_REFRESH, NOW + 540_000, LAST_FAILURE].entries()) {
    h.setNow(at);
    await h.controller.handleAlarm(ALARM_REFRESH);
    expect(h.storage.transient).toMatchObject({
      proxySession: { id: A_ID },
      refreshAttempts: index + 1,
      refreshRetryAt: at + 30_000,
    });
    expect(create).toHaveBeenCalledTimes(index + 1);
  }
  expect(h.alarms.retryAt).toBeNull();
  expect(h.proxy.active?.id).toBe(A_ID);
  h.api.createError = null;
  return { h, create, deadline: h.storage.transient.refreshRetryAt! };
}

// The write is already durable while its completion is withheld. Delaying only
// before the write would miss the revoked-credentials restart regression.
async function writtenB(h: Harness, id: string) {
  const b = fresh(id);
  const entered = deferred();
  const release = deferred();
  const write = h.storage.writeTransient.bind(h.storage);
  let delayed = false;
  const writing = vi.spyOn(h.storage, "writeTransient").mockImplementation(async (state) => {
    await write(state);
    if (!delayed && state.proxySession?.id === b.id) {
      delayed = true;
      entered.resolve();
      await release.promise;
    }
  });
  h.api.sessions = [b];
  const changing = h.controller.changeLocation(b.locationId);
  await entered.promise;
  expect(h.storage.transient).toMatchObject({
    proxySession: { id: b.id },
    refreshAttempts: 0,
  });
  expect(h.proxy.active?.id).toBe(A_ID);
  expect(await h.controller.getActiveSession()).toMatchObject({ id: A_ID });
  return { b, changing, release, writing, write };
}

function retain(h: Harness, kind: Retain) {
  return kind === "select"
    ? h.controller.changeLocation("frankfurt-01")
    : h.controller.updateSecurityPreferences(true, false);
}

async function discardB(h: Harness, kind: Retain, id: string) {
  const pending = await writtenB(h, id);
  const retaining = retain(h, kind);
  await turn();
  pending.release.resolve();
  expect(await pending.changing).toEqual({ ok: false, superseded: true });
  expect(await retaining).toEqual({ ok: true });
  expect(h.api.revoked).toContain(pending.b.id);
  expect(h.api.revoked).not.toContain(A_ID);
  return pending;
}

async function assertRetained(
  h: Harness,
  attempts: number,
  retryAt = SEEDED_DEADLINE,
  now = FIRST_REFRESH,
) {
  expect(await h.controller.getActiveSession()).toMatchObject({ id: A_ID });
  expect(h.proxy.active?.id).toBe(A_ID);
  expect(h.storage.transient).toMatchObject({
    proxySession: { id: A_ID },
    refreshAttempts: attempts,
    refreshRetryAt: retryAt,
  });
  expect(h.controller.getSnapshot()).toMatchObject({
    protected: true,
    activeLocationId: "frankfurt-01",
  });
  expect(h.api.revoked).not.toContain(A_ID);
  expect(h.alarms.session?.id).toBe(A_ID);
  expect(h.alarms.retryAt).toBe(
    attempts >= MAX_REFRESH_ATTEMPTS ? null : Math.max(now + 1_000, attempts ? retryAt : 0),
  );
}

async function restart(h: Harness, now = LAST_FAILURE) {
  const restarted = createHarness({
    persisted: h.storage.persisted,
    transient: h.storage.transient,
    security: h.securityStorage.state!,
    ...(h.proxy.active ? { activeProxy: h.proxy.active } : {}),
  });
  restarted.identity.deviceId = "browser-device-1";
  restarted.setNow(now);
  await restarted.controller.initialize();
  return restarted;
}

afterEach(() => vi.restoreAllMocks());

describe("CODE01 durable retained-session budget", () => {
  describe.each<Retain>(["select", "preferences"])("retained by %s", (kind) => {
    it.each([0, 1, 2, MAX_REFRESH_ATTEMPTS])(
      "repairs the durable session while preserving %i attempts and the exact deadline",
      async (attempts) => {
        const h = await running(attempts);
        const create = vi.spyOn(h.api, "createProxySession");
        const { b } = await discardB(h, kind, `seeded-B-${kind}-${String(attempts)}`);
        await assertRetained(h, attempts);
        expect(create).toHaveBeenCalledOnce();
        expect(h.securityStorage.state!.proxyCreationUncertain).toBe(false);
        const restarted = await restart(h, FIRST_REFRESH);
        await assertRetained(restarted, attempts);
        expect(restarted.proxy.active?.id).not.toBe(b.id);
      },
    );

    it("keeps a real three-429 budget across discarded B, duplicate alarms, restart, and explicit retry", async () => {
      const { h, create, deadline } = await exhaustRealBudget();
      const { b } = await discardB(h, kind, `real-exhaustion-B-${kind}`);
      await assertRetained(h, MAX_REFRESH_ATTEMPTS, deadline, LAST_FAILURE);
      expect(create).toHaveBeenCalledTimes(MAX_REFRESH_ATTEMPTS + 1);
      h.api.sessions = [fresh("forbidden-fourth-auto", "frankfurt-01")];
      h.setNow(NOW + 575_000);
      for (let duplicate = 0; duplicate < 5; duplicate++) {
        await h.controller.handleAlarm(ALARM_REFRESH);
      }
      expect(create).toHaveBeenCalledTimes(MAX_REFRESH_ATTEMPTS + 1);
      await assertRetained(h, MAX_REFRESH_ATTEMPTS, deadline, NOW + 575_000);

      const restarted = await restart(h, NOW + 575_000);
      await assertRetained(restarted, MAX_REFRESH_ATTEMPTS, deadline, NOW + 575_000);
      expect(restarted.storage.transient.proxySession?.id).not.toBe(b.id);
      const restartedCreate = vi.spyOn(restarted.api, "createProxySession");
      for (let duplicate = 0; duplicate < 3; duplicate++) {
        await restarted.controller.handleAlarm(ALARM_REFRESH);
      }
      expect(restartedCreate).not.toHaveBeenCalled();
      restarted.api.sessions = [fresh("explicit-renewal", "frankfurt-01", NOW + 575_000)];
      expect(await restarted.controller.retryConnection()).toEqual({ ok: true });
      expect(restartedCreate).toHaveBeenCalledOnce();
      expect(restarted.storage.transient).toMatchObject({
        proxySession: { id: "explicit-renewal" },
        refreshAttempts: 0,
      });
      expect(restarted.storage.transient.refreshRetryAt).toBeUndefined();
      expect(restarted.proxy.active?.id).toBe("explicit-renewal");
      expect(await restarted.controller.getActiveSession()).toMatchObject({
        id: "explicit-renewal",
      });
      expect(restarted.api.revoked).not.toContain("explicit-renewal");
    });
  });

  it("does not spend B's empty budget when an alarm races the durable B write and retained A selection", async () => {
    const { h, create, deadline } = await exhaustRealBudget();
    const { b, changing, release } = await writtenB(h, "alarm-during-durable-B");
    const selectingA = h.controller.changeLocation("frankfurt-01");
    await turn();
    h.setNow(NOW + 575_000);
    const staleAlarm = h.controller.handleAlarm(ALARM_REFRESH);
    await turn();
    release.resolve();
    expect(await changing).toEqual({ ok: false, superseded: true });
    expect(await selectingA).toEqual({ ok: true });
    await staleAlarm;
    await assertRetained(h, MAX_REFRESH_ATTEMPTS, deadline, NOW + 575_000);
    expect(h.api.revoked).toContain(b.id);
    expect(create).toHaveBeenCalledTimes(MAX_REFRESH_ATTEMPTS + 1);
    await h.controller.handleAlarm(ALARM_REFRESH);
    expect(create).toHaveBeenCalledTimes(MAX_REFRESH_ATTEMPTS + 1);
  });

  it.each(["select", "retry", "new-location"] as const)(
    "leaves the newest %s intent in control when it supersedes a queued A selection",
    async (intent) => {
      const { h, create, deadline } = await exhaustRealBudget();
      const { b, changing, release } = await writtenB(h, `superseded-B-${intent}`);
      const selectingA = h.controller.changeLocation("frankfurt-01");
      await turn();
      const c = fresh(
        `newest-${intent}`,
        intent === "new-location" ? "frankfurt-02" : "frankfurt-01",
      );
      h.api.sessions = [c];
      const newest =
        intent === "select"
          ? h.controller.changeLocation("frankfurt-01")
          : intent === "retry"
            ? h.controller.retryConnection()
            : h.controller.changeLocation("frankfurt-02");
      await turn();
      release.resolve();
      expect(await changing).toEqual({ ok: false, superseded: true });
      expect(await selectingA).toEqual({ ok: false, superseded: true });
      expect(await newest).toEqual({ ok: true });
      expect(h.api.revoked).toContain(b.id);
      if (intent === "select") {
        await assertRetained(h, MAX_REFRESH_ATTEMPTS, deadline, LAST_FAILURE);
        expect(create).toHaveBeenCalledTimes(MAX_REFRESH_ATTEMPTS + 1);
      } else {
        expect(await h.controller.getActiveSession()).toMatchObject({ id: c.id });
        expect(h.proxy.active?.id).toBe(c.id);
        expect(h.storage.transient).toMatchObject({
          proxySession: { id: c.id },
          refreshAttempts: 0,
        });
        expect(h.storage.transient.refreshRetryAt).toBeUndefined();
        expect(h.api.revoked).not.toContain(c.id);
        expect(create).toHaveBeenCalledTimes(MAX_REFRESH_ATTEMPTS + 2);
        const restarted = await restart(h);
        expect(await restarted.controller.getActiveSession()).toMatchObject({ id: c.id });
        expect(restarted.proxy.active?.id).toBe(c.id);
        expect(restarted.storage.transient.proxySession?.id).toBe(c.id);
      }
    },
  );

  it.each(["disconnect", "logout", "expiry"] as const)(
    "never restores A or discarded B when %s supersedes the queued retained selection",
    async (action) => {
      const { h, create } = await exhaustRealBudget();
      const { b, changing, release } = await writtenB(h, `stopped-B-${action}`);
      const selectingA = h.controller.changeLocation("frankfurt-01");
      await turn();
      if (action === "expiry") h.setNow(NOW + 600_000);
      const stopping =
        action === "expiry" ? h.controller.handleAlarm(ALARM_EXPIRY) : h.controller[action]();
      await turn();
      release.resolve();
      expect(await changing).toEqual({ ok: false, superseded: true });
      expect(await selectingA).toMatchObject({ ok: false });
      await stopping;
      expect(await h.controller.getActiveSession()).toBeNull();
      expect(h.controller.getSnapshot().protected).toBe(false);
      expect(h.proxy.active?.id).not.toBe(b.id);
      expect(h.storage.transient.proxySession).toBeNull();
      expect(h.alarms.retryAt).toBeNull();
      expect(h.api.revoked).toContain(b.id);
      if (action !== "expiry") {
        expect(h.proxy.active).toBeNull();
        expect(h.securityStorage.state!.protectionRequested).toBe(false);
      } else {
        expect(h.safety.status.trafficBlocked).toBe(true);
      }
      if (action === "logout") expect(h.storage.persisted.auth).toBeNull();
      const restarted = await restart(h, action === "expiry" ? NOW + 600_000 : LAST_FAILURE);
      expect(await restarted.controller.getActiveSession()).toBeNull();
      expect(restarted.controller.getSnapshot().protected).toBe(false);
      expect(restarted.proxy.active?.id).not.toBe(b.id);
      expect(restarted.storage.transient.proxySession).toBeNull();
      expect(create).toHaveBeenCalledTimes(MAX_REFRESH_ATTEMPTS + 1);
    },
  );

  it.each(["before", "after"] as const)(
    "fails closed when restoring A fails %s its durable write, and cannot restart revoked B",
    async (failurePoint) => {
      const { h, create } = await exhaustRealBudget();
      const pending = await writtenB(h, `storage-failed-B-${failurePoint}`);
      let failedRepairs = 0;
      pending.writing.mockImplementation(async (state) => {
        if (state.proxySession?.id === A_ID) {
          failedRepairs++;
          if (failurePoint === "after") await pending.write(state);
          throw new Error("injected_transient_repair_failure");
        }
        await pending.write(state);
      });
      const selectingA = h.controller.changeLocation("frankfurt-01");
      await turn();
      pending.release.resolve();
      expect(await pending.changing).toEqual({ ok: false, superseded: true });
      expect(await selectingA).toMatchObject({ ok: false });
      expect(failedRepairs).toBeGreaterThan(0);
      expect(h.api.revoked).toContain(pending.b.id);
      expect(await h.controller.getActiveSession()).toBeNull();
      expect(h.controller.getSnapshot().protected).toBe(false);
      expect(h.proxy.active?.id).not.toBe(pending.b.id);
      expect(h.safety.status.trafficBlocked).toBe(true);
      expect(h.alarms.retryAt).toBeNull();
      const restarted = await restart(h);
      expect(await restarted.controller.getActiveSession()).toBeNull();
      expect(restarted.controller.getSnapshot().protected).toBe(false);
      expect(restarted.proxy.active?.id).not.toBe(pending.b.id);
      expect(restarted.storage.transient.proxySession?.id).not.toBe(pending.b.id);
      h.setNow(NOW + 575_000);
      await h.controller.handleAlarm(ALARM_REFRESH);
      expect(create).toHaveBeenCalledTimes(MAX_REFRESH_ATTEMPTS + 1);
    },
  );
});
