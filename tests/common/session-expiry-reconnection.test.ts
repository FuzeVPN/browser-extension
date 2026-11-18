// SPDX-License-Identifier: MPL-2.0

import { ApiError } from "../../src/core/api/client";
import {
  ALARM_EXPIRY,
  ALARM_RECONNECT,
  ALARM_REFRESH,
  EXPIRY_RECONNECT_DELAY_MS,
} from "../../src/core/shared/config";
import { authenticatedState, createHarness, proxySession } from "./helpers";

/** A session the server issues at that time, valid for ten minutes. */
function sessionIssuedAt(time: number, id = "proxy-session-after-expiry") {
  return proxySession(
    id,
    "frankfurt-01",
    new Date(time).toISOString(),
    new Date(time + 600_000).toISOString(),
  );
}

/** A protected connection whose session was never renewed. */
async function connected() {
  const h = createHarness({ persisted: authenticatedState() });
  await h.controller.initialize();
  await h.controller.startupConnectionSettled();
  expect(await h.controller.connect("frankfurt-01")).toEqual({ ok: true });
  const session = h.proxy.active!;
  return { h, session, expiry: Date.parse(session.expiresAt) };
}

afterEach(() => vi.restoreAllMocks());

describe("a session which expires while protection is requested", () => {
  it("is replaced at once when the server answers", async () => {
    const { h, session, expiry } = await connected();
    const requests = h.api.proofs.length;
    h.setNow(expiry);
    h.api.sessions = [sessionIssuedAt(expiry)];
    await h.controller.handleAlarm(ALARM_EXPIRY);
    await h.controller.startupConnectionSettled();

    expect(h.api.proofs).toHaveLength(requests + 1);
    expect(h.controller.getSnapshot()).toMatchObject({
      status: "connected",
      protected: true,
      error: null,
    });
    expect(h.proxy.active?.id).toBe("proxy-session-after-expiry");
    expect(h.proxy.active?.id).not.toBe(session.id);
    expect(h.securityStorage.state).toMatchObject({
      protectionRequested: true,
      reconnectAttempts: 0,
      nextRetryAt: null,
      retrySuspended: false,
    });
  });

  it("is never left authorized between its expiry and its replacement", async () => {
    const { h, expiry } = await connected();
    const published = h.snapshots.length;
    h.setNow(expiry);
    h.api.sessions = [sessionIssuedAt(expiry)];
    await h.controller.handleAlarm(ALARM_EXPIRY);
    await h.controller.startupConnectionSettled();

    // The expired session is dropped, unprotected, before the reconnection begins.
    const since = h.snapshots.slice(published);
    const dropped = since.findIndex(
      (snapshot) => !snapshot.protected && snapshot.error === "session_expired",
    );
    const restored = since.findIndex(
      (snapshot) => snapshot.protected && snapshot.status === "connected",
    );
    expect(dropped).toBeGreaterThanOrEqual(0);
    expect(restored).toBeGreaterThan(dropped);
  });

  it("keeps the ordinary backoff when its reconnection is refused", async () => {
    const { h, expiry } = await connected();
    const requests = h.api.proofs.length;
    h.setNow(expiry);
    h.api.createError = new ApiError("rate_limited", 429);
    await h.controller.handleAlarm(ALARM_EXPIRY);
    await h.controller.startupConnectionSettled();

    // One attempt at the expiry, which counts as the first failure, not the second.
    expect(h.api.proofs).toHaveLength(requests + 1);
    expect(h.controller.getSnapshot()).toMatchObject({ protected: false, error: "rate_limited" });
    expect(h.securityStorage.state).toMatchObject({
      reconnectAttempts: 1,
      nextRetryAt: expiry + 30_000,
      retrySuspended: false,
    });
    expect(h.alarms.reconnectAt).toBe(expiry + 30_000);

    h.setNow(expiry + 30_000);
    h.api.createError = null;
    h.api.sessions = [sessionIssuedAt(expiry + 30_000)];
    await h.controller.handleAlarm(ALARM_RECONNECT);
    await h.controller.startupConnectionSettled();
    expect(h.controller.getSnapshot()).toMatchObject({ status: "connected", protected: true });
  });

  it("is replaced at once when its renewal fires late, after a sleep", async () => {
    const { h, expiry } = await connected();
    const requests = h.api.proofs.length;
    const wake = expiry + 60_000;
    h.setNow(wake);
    h.api.sessions = [sessionIssuedAt(wake)];
    await h.controller.handleAlarm(ALARM_REFRESH);
    await h.controller.startupConnectionSettled();

    expect(h.api.proofs).toHaveLength(requests + 1);
    expect(h.controller.getSnapshot()).toMatchObject({ status: "connected", protected: true });

    // The expiry alarm of the same wake finds nothing left to do.
    await h.controller.handleAlarm(ALARM_EXPIRY);
    await h.controller.startupConnectionSettled();
    expect(h.api.proofs).toHaveLength(requests + 1);
    expect(h.controller.getSnapshot()).toMatchObject({ status: "connected", protected: true });
  });

  it("leaves its alarm for a worker which ends before reconnecting", async () => {
    const { h, expiry } = await connected();
    h.setNow(expiry);
    // The reconnection cannot be made by this worker: only its alarm remains.
    const retry = vi
      .spyOn(h.controller, "retryConnection")
      .mockResolvedValueOnce({ ok: false, superseded: true });
    await h.controller.handleAlarm(ALARM_EXPIRY);
    await h.controller.startupConnectionSettled();
    expect(retry).toHaveBeenCalledOnce();
    expect(h.controller.getSnapshot()).toMatchObject({
      protected: false,
      error: "session_expired",
    });
    expect(h.securityStorage.state).toMatchObject({
      reconnectAttempts: 0,
      nextRetryAt: expiry + EXPIRY_RECONNECT_DELAY_MS,
    });
    expect(h.alarms.reconnectAt).toBe(expiry + EXPIRY_RECONNECT_DELAY_MS);

    // The next worker starts with that state and reconnects.
    const restarted = createHarness({
      persisted: h.storage.persisted,
      security: h.securityStorage.state!,
    });
    restarted.setNow(expiry + 30_000);
    restarted.api.sessions = [sessionIssuedAt(expiry + 30_000)];
    await restarted.controller.initialize();
    await restarted.controller.startupConnectionSettled();
    expect(restarted.controller.getSnapshot()).toMatchObject({
      status: "connected",
      protected: true,
    });
  });

  it("is not replaced once protection is no longer requested", async () => {
    const { h, expiry } = await connected();
    expect(await h.controller.disconnect()).toEqual({ ok: true });
    const requests = h.api.proofs.length;
    h.setNow(expiry);
    await h.controller.handleAlarm(ALARM_EXPIRY);
    await h.controller.startupConnectionSettled();

    expect(h.api.proofs).toHaveLength(requests);
    expect(h.controller.getSnapshot()).toMatchObject({ status: "disconnected", protected: false });
  });
});
