// SPDX-License-Identifier: MPL-2.0

import { ALARM_EXPIRY, ALARM_REFRESH } from "../../src/core/shared/config";
import { DEFAULT_SECURITY_STATE, type SecurityState } from "../../src/core/shared/security";
import { authenticatedState, createHarness, NOW, proxySession } from "./helpers";

const MINUTE = 60_000;

/** A session the server issues at that time, valid for ten minutes. */
function sessionIssuedAt(time: number, id: string) {
  return proxySession(
    id,
    "frankfurt-01",
    new Date(time).toISOString(),
    new Date(time + 10 * MINUTE).toISOString(),
  );
}

const PROTECTED: SecurityState = {
  ...DEFAULT_SECURITY_STATE,
  protectionRequested: true,
  selectedLocationId: "frankfurt-01",
};

/** What a browser keeps of a protected connection while its worker is stopped. */
function stoppedWorker(session: ReturnType<typeof proxySession>, configured: boolean) {
  return createHarness({
    persisted: authenticatedState(),
    security: PROTECTED,
    transient: { proxySession: session, refreshAttempts: 0, retiredSessions: [] },
    ...(configured ? { activeProxy: session } : {}),
  });
}

afterEach(() => vi.restoreAllMocks());

describe("a renewal alarm delivered after its session expired", () => {
  it("starts a worker which replaces the expired session once", async () => {
    // The computer slept: the alarm set for the renewal is delivered twenty minutes late.
    const h = stoppedWorker(sessionIssuedAt(NOW - 20 * MINUTE, "expired-during-sleep"), false);
    h.api.sessions = [
      sessionIssuedAt(NOW, "created-at-start-up"),
      sessionIssuedAt(NOW, "created-by-the-late-alarm"),
    ];

    await h.controller.handleAlarm(ALARM_REFRESH);
    await h.controller.startupConnectionSettled();

    // The start-up reconnects; the alarm, set for the expired session, renews nothing.
    expect(h.api.proofs).toHaveLength(1);
    expect(h.proxy.active?.id).toBe("created-at-start-up");
    expect(h.controller.getSnapshot()).toMatchObject({
      status: "connected",
      protected: true,
      error: null,
    });
    // The session just created keeps the renewal which was scheduled for it.
    expect(h.alarms.session?.id).toBe("created-at-start-up");
  });

  it("leaves that session a renewal which a later alarm makes", async () => {
    const h = stoppedWorker(sessionIssuedAt(NOW - 20 * MINUTE, "expired-during-sleep"), false);
    h.api.sessions = [sessionIssuedAt(NOW, "created-at-start-up")];
    await h.controller.handleAlarm(ALARM_REFRESH);
    await h.controller.startupConnectionSettled();
    expect(h.api.proofs).toHaveLength(1);

    h.setNow(NOW + 8.5 * MINUTE);
    h.api.sessions = [sessionIssuedAt(NOW + 8.5 * MINUTE, "renewed-on-time")];
    await h.controller.handleAlarm(ALARM_REFRESH);
    await h.controller.startupConnectionSettled();

    expect(h.api.proofs).toHaveLength(2);
    expect(h.proxy.active?.id).toBe("renewed-on-time");
  });

  it("is delivered with the expiry alarm, in either order, for one reconnection", async () => {
    for (const order of [
      [ALARM_REFRESH, ALARM_EXPIRY],
      [ALARM_EXPIRY, ALARM_REFRESH],
    ]) {
      const h = stoppedWorker(sessionIssuedAt(NOW - 20 * MINUTE, "expired-during-sleep"), false);
      h.api.sessions = [
        sessionIssuedAt(NOW, "created-at-start-up"),
        sessionIssuedAt(NOW, "created-by-a-late-alarm"),
      ];

      await Promise.all(order.map((name) => h.controller.handleAlarm(name)));
      await h.controller.startupConnectionSettled();

      expect(h.api.proofs).toHaveLength(1);
      expect(h.proxy.active?.id).toBe("created-at-start-up");
      expect(h.controller.getSnapshot()).toMatchObject({ status: "connected", protected: true });
    }
  });
});

describe("a renewal alarm delivered for the session it was set for", () => {
  it("starts a worker which restores that session and renews it", async () => {
    const h = stoppedWorker(sessionIssuedAt(NOW - 8.5 * MINUTE, "due-for-renewal"), true);
    h.api.sessions = [sessionIssuedAt(NOW, "renewed")];

    await h.controller.handleAlarm(ALARM_REFRESH);
    await h.controller.startupConnectionSettled();

    expect(h.api.proofs).toHaveLength(1);
    expect(h.proxy.active?.id).toBe("renewed");
    expect(h.controller.getSnapshot()).toMatchObject({ status: "connected", protected: true });
  });

  it("renews it once when the alarm set again by the restoration fires meanwhile", async () => {
    const h = stoppedWorker(sessionIssuedAt(NOW - 8.5 * MINUTE, "due-for-renewal"), true);
    h.api.sessions = [sessionIssuedAt(NOW, "renewed"), sessionIssuedAt(NOW, "renewed-twice")];
    // The server takes its time to answer the renewal.
    let answer!: () => void;
    const answered = new Promise<void>((resolve) => {
      answer = resolve;
    });
    const create = h.api.createProxySession.bind(h.api);
    vi.spyOn(h.api, "createProxySession").mockImplementationOnce(async (...args) => {
      await answered;
      return create(...args);
    });

    const woken = h.controller.handleAlarm(ALARM_REFRESH);
    for (let turn = 0; turn < 20; turn++) await new Promise<void>((done) => setImmediate(done));
    // Its renewal being due already, the restoration set the alarm one second ahead, for
    // the same session: it fires while the renewal is still unanswered.
    expect(h.alarms.session?.id).toBe("due-for-renewal");
    const again = h.controller.handleAlarm(ALARM_REFRESH);
    for (let turn = 0; turn < 20; turn++) await new Promise<void>((done) => setImmediate(done));
    answer();
    await Promise.all([woken, again]);

    // The second alarm joins the renewal in progress: one session is asked of the server.
    expect(h.api.proofs).toHaveLength(1);
    expect(h.proxy.active?.id).toBe("renewed");
    expect(h.controller.getSnapshot()).toMatchObject({
      status: "connected",
      protected: true,
      error: null,
    });
  });

  it("renews the session of a worker which is running", async () => {
    const h = createHarness({ persisted: authenticatedState() });
    await h.controller.initialize();
    await h.controller.startupConnectionSettled();
    h.api.sessions = [sessionIssuedAt(NOW, "connected")];
    expect(await h.controller.connect("frankfurt-01")).toEqual({ ok: true });

    h.setNow(NOW + 8.5 * MINUTE);
    h.api.sessions = [sessionIssuedAt(NOW + 8.5 * MINUTE, "renewed")];
    await h.controller.handleAlarm(ALARM_REFRESH);
    await h.controller.startupConnectionSettled();

    expect(h.api.proofs).toHaveLength(2);
    expect(h.proxy.active?.id).toBe("renewed");
  });

  it("replaces a session found expired in a running worker once", async () => {
    const h = createHarness({ persisted: authenticatedState() });
    await h.controller.initialize();
    await h.controller.startupConnectionSettled();
    h.api.sessions = [sessionIssuedAt(NOW, "connected")];
    expect(await h.controller.connect("frankfurt-01")).toEqual({ ok: true });

    // The worker stayed alive through a sleep: both alarms are delivered late.
    h.setNow(NOW + 20 * MINUTE);
    h.api.sessions = [
      sessionIssuedAt(NOW + 20 * MINUTE, "created-after-sleep"),
      sessionIssuedAt(NOW + 20 * MINUTE, "created-twice"),
    ];
    await Promise.all([
      h.controller.handleAlarm(ALARM_REFRESH),
      h.controller.handleAlarm(ALARM_EXPIRY),
    ]);

    expect(h.api.proofs).toHaveLength(2);
    expect(h.proxy.active?.id).toBe("created-after-sleep");
    expect(h.controller.getSnapshot()).toMatchObject({ status: "connected", protected: true });
  });
});
