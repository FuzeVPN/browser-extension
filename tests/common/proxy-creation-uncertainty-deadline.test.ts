// SPDX-License-Identifier: MPL-2.0

import { ApiError, NetworkError } from "../../src/core/api/client";
import {
  ALARM_EXPIRY,
  ALARM_RECONNECT,
  ALARM_REFRESH,
  PROXY_CREATION_UNCERTAINTY_MS,
  REFRESH_RETRY_MS,
} from "../../src/core/shared/config";
import { DEFAULT_SECURITY_STATE, type SecurityState } from "../../src/core/shared/security";
import {
  ExtensionSecurityStorage,
  SECURITY_STORAGE_KEY,
} from "../../src/core/storage/security-storage";
import { authenticatedState, createHarness, NOW, proxySession } from "./helpers";

const DAY = 24 * 60 * 60 * 1_000;
const DEADLINE = NOW + PROXY_CREATION_UNCERTAINTY_MS;

/** A session the server issues at that time, valid for ten minutes. */
function sessionIssuedAt(time: number, id = "proxy-session-later") {
  return proxySession(
    id,
    "frankfurt-01",
    new Date(time).toISOString(),
    new Date(time + 600_000).toISOString(),
  );
}

/** Protection requested, and the first session request left without an answer. */
async function unansweredConnection() {
  const h = createHarness({ persisted: authenticatedState() });
  await h.controller.initialize();
  await h.controller.startupConnectionSettled();
  h.api.createError = new NetworkError("timeout");
  expect(await h.controller.connect("frankfurt-01")).toEqual({
    ok: false,
    commandError: "proxy_creation_uncertain",
  });
  h.api.createError = null;
  return h;
}

afterEach(() => vi.restoreAllMocks());

describe("an unanswered session creation suspends automatic retries until its deadline", () => {
  it("schedules the retry at the deadline and replays nothing before it", async () => {
    const h = await unansweredConnection();

    expect(h.api.proofs).toHaveLength(1);
    expect(h.securityStorage.state).toMatchObject({
      protectionRequested: true,
      proxyCreationUncertain: true,
      proxyCreationUncertainUntil: DEADLINE,
      retrySuspended: true,
      nextRetryAt: DEADLINE,
    });
    expect(h.alarms.reconnectAt).toBe(DEADLINE);
    expect(h.controller.getSnapshot()).toMatchObject({
      protected: false,
      error: "proxy_creation_uncertain",
    });

    // An alarm which fires early changes nothing and keeps the deadline.
    h.setNow(DEADLINE - 1);
    await h.controller.handleAlarm(ALARM_RECONNECT);
    await h.controller.startupConnectionSettled();
    await h.controller.handleAlarm(ALARM_REFRESH);
    await h.controller.startupConnectionSettled();
    expect(h.api.proofs).toHaveLength(1);
    expect(h.alarms.reconnectAt).toBe(DEADLINE);
    expect(h.securityStorage.state?.proxyCreationUncertain).toBe(true);
  });

  it("reconnects by itself once the deadline has passed", async () => {
    const h = await unansweredConnection();
    h.setNow(DEADLINE);
    h.api.sessions = [sessionIssuedAt(DEADLINE)];
    await h.controller.handleAlarm(ALARM_RECONNECT);
    await h.controller.startupConnectionSettled();

    expect(h.api.proofs).toHaveLength(2);
    expect(h.controller.getSnapshot()).toMatchObject({
      status: "connected",
      protected: true,
      error: null,
    });
    expect(h.securityStorage.state).toMatchObject({
      proxyCreationUncertain: false,
      retrySuspended: false,
      nextRetryAt: null,
    });
    expect(h.securityStorage.state).not.toHaveProperty("proxyCreationUncertainUntil");
  });

  it("asks to be woken again when the end of the suspension cannot be stored", async () => {
    const h = await unansweredConnection();
    h.setNow(DEADLINE);
    h.api.sessions = [sessionIssuedAt(DEADLINE + REFRESH_RETRY_MS)];
    const write = h.securityStorage.write.bind(h.securityStorage);
    vi.spyOn(h.securityStorage, "write").mockRejectedValueOnce(new Error("storage unavailable"));
    await h.controller.handleAlarm(ALARM_RECONNECT);
    await h.controller.startupConnectionSettled();

    // Still suspended, as storage says. The alarm which fired was the last one set:
    // without another, nothing would end the suspension before the next worker.
    expect(h.api.proofs).toHaveLength(1);
    expect(h.securityStorage.state?.proxyCreationUncertain).toBe(true);
    expect(h.alarms.reconnectAt).toBe(DEADLINE + REFRESH_RETRY_MS);

    vi.spyOn(h.securityStorage, "write").mockImplementation(write);
    h.setNow(DEADLINE + REFRESH_RETRY_MS);
    await h.controller.handleAlarm(ALARM_RECONNECT);
    await h.controller.startupConnectionSettled();
    expect(h.api.proofs).toHaveLength(2);
    expect(h.controller.getSnapshot()).toMatchObject({ status: "connected", protected: true });
  });

  it("reports the session it may have left at a logout made before the deadline", async () => {
    const h = await unansweredConnection();
    h.setNow(DEADLINE - 1);
    expect(h.securityStorage.state?.proxyCleanupUncertain).toBe(true);

    await h.controller.logout();
    expect(h.controller.getSnapshot().logoutOutcome?.proxySessions).toBe("unconfirmed");
  });

  it("no longer reports that session once it has expired", async () => {
    const h = await unansweredConnection();
    h.setNow(DEADLINE);
    h.api.sessions = [sessionIssuedAt(DEADLINE)];
    await h.controller.handleAlarm(ALARM_RECONNECT);
    await h.controller.startupConnectionSettled();

    expect(await h.controller.logout()).toEqual({ ok: true });
    expect(h.controller.getSnapshot().logoutOutcome?.proxySessions).toBe("confirmed");
    expect(h.securityStorage.state?.proxyCleanupUncertain).toBe(false);
  });

  it("keeps the ordinary backoff when the retry after the deadline fails", async () => {
    const h = await unansweredConnection();
    h.setNow(DEADLINE);
    h.api.createError = new ApiError("rate_limited", 429, 90);
    await h.controller.handleAlarm(ALARM_RECONNECT);
    await h.controller.startupConnectionSettled();

    // The refusal is definitive: nothing is left in doubt, and retries continue.
    expect(h.api.proofs).toHaveLength(2);
    expect(h.securityStorage.state).toMatchObject({
      proxyCreationUncertain: false,
      retrySuspended: false,
      nextRetryAt: DEADLINE + 90_000,
    });
    expect(h.alarms.reconnectAt).toBe(DEADLINE + 90_000);
  });

  it("waits a full new deadline when the retry is left unanswered too", async () => {
    const h = await unansweredConnection();
    h.setNow(DEADLINE);
    h.api.createError = new NetworkError("network");
    await h.controller.handleAlarm(ALARM_RECONNECT);
    await h.controller.startupConnectionSettled();

    expect(h.api.proofs).toHaveLength(2);
    expect(h.securityStorage.state).toMatchObject({
      proxyCreationUncertain: true,
      proxyCreationUncertainUntil: DEADLINE + PROXY_CREATION_UNCERTAINTY_MS,
      nextRetryAt: DEADLINE + PROXY_CREATION_UNCERTAINTY_MS,
    });
    expect(h.alarms.reconnectAt).toBe(DEADLINE + PROXY_CREATION_UNCERTAINTY_MS);
  });
});

describe("a renewal left unanswered while its session is still valid", () => {
  it("retries after the expiry once the deadline has passed", async () => {
    const h = createHarness({ persisted: authenticatedState() });
    await h.controller.initialize();
    await h.controller.startupConnectionSettled();
    expect(await h.controller.connect("frankfurt-01")).toEqual({ ok: true });
    const previous = h.proxy.active!;
    const expiry = Date.parse(previous.expiresAt);

    // The renewal is sent at its usual time and its answer never arrives.
    const renewal = NOW + 510_000;
    h.setNow(renewal);
    h.api.createError = new NetworkError("timeout");
    await h.controller.handleAlarm(ALARM_REFRESH);
    await h.controller.startupConnectionSettled();
    expect(h.controller.getSnapshot()).toMatchObject({ status: "connected", protected: true });
    expect(h.proxy.active).toEqual(previous);
    const deadline = renewal + PROXY_CREATION_UNCERTAINTY_MS;
    expect(h.securityStorage.state).toMatchObject({
      proxyCreationUncertain: true,
      proxyCreationUncertainUntil: deadline,
    });

    // The session expires: protection stops, and its return is scheduled.
    h.setNow(expiry);
    await h.controller.handleAlarm(ALARM_EXPIRY);
    await h.controller.startupConnectionSettled();
    expect(h.controller.getSnapshot().protected).toBe(false);
    expect(h.api.proofs).toHaveLength(2);
    expect(h.securityStorage.state).toMatchObject({
      proxyCreationUncertain: true,
      nextRetryAt: deadline,
    });
    expect(h.alarms.reconnectAt).toBe(deadline);

    h.setNow(deadline);
    h.api.createError = null;
    h.api.sessions = [sessionIssuedAt(deadline)];
    await h.controller.handleAlarm(ALARM_RECONNECT);
    await h.controller.startupConnectionSettled();
    expect(h.api.proofs).toHaveLength(3);
    expect(h.controller.getSnapshot()).toMatchObject({ status: "connected", protected: true });
    expect(h.securityStorage.state?.proxyCreationUncertain).toBe(false);
  });
});

describe("a worker starting with an unanswered session creation", () => {
  it("waits for the deadline when it starts before it", async () => {
    const h = await unansweredConnection();
    const restarted = createHarness({
      persisted: h.storage.persisted,
      security: h.securityStorage.state!,
    });
    restarted.setNow(DEADLINE - 60_000);
    await restarted.controller.initialize();
    await restarted.controller.startupConnectionSettled();

    expect(restarted.api.proofs).toHaveLength(0);
    expect(restarted.alarms.reconnectAt).toBe(DEADLINE);
    expect(restarted.controller.getSnapshot()).toMatchObject({
      protected: false,
      error: "proxy_creation_uncertain",
    });
    expect(restarted.securityStorage.state?.proxyCreationUncertain).toBe(true);
  });

  it("reconnects at once when it starts after it", async () => {
    const h = await unansweredConnection();
    const restarted = createHarness({
      persisted: h.storage.persisted,
      security: h.securityStorage.state!,
    });
    restarted.setNow(NOW + DAY);
    restarted.api.sessions = [sessionIssuedAt(NOW + DAY)];
    await restarted.controller.initialize();
    await restarted.controller.startupConnectionSettled();

    expect(restarted.api.proofs).toHaveLength(1);
    expect(restarted.controller.getSnapshot()).toMatchObject({
      status: "connected",
      protected: true,
    });
    // A day later, the session that request may have created is long expired.
    expect(restarted.securityStorage.state).toMatchObject({
      proxyCreationUncertain: false,
      proxyCleanupUncertain: false,
      retrySuspended: false,
    });
  });

  it("waits one full delay at most for a deadline which a clock running ahead wrote", async () => {
    // The clock was ten years ahead when the request was left unanswered, then set right.
    const AHEAD = NOW + 3_650 * DAY;
    const written: SecurityState = {
      ...DEFAULT_SECURITY_STATE,
      protectionRequested: true,
      selectedLocationId: "frankfurt-01",
      proxyCreationUncertain: true,
      proxyCreationUncertainUntil: AHEAD + PROXY_CREATION_UNCERTAINTY_MS,
      proxyCleanupUncertain: true,
      proxyCleanupUncertainUntil: AHEAD + PROXY_CREATION_UNCERTAINTY_MS,
      retrySuspended: true,
      nextRetryAt: AHEAD + PROXY_CREATION_UNCERTAINTY_MS,
    };
    const h = createHarness({ persisted: authenticatedState(), security: written });
    await h.controller.initialize();
    await h.controller.startupConnectionSettled();

    // No session lives longer than the delay: the deadline is at most that far.
    expect(h.alarms.reconnectAt).toBe(DEADLINE);
    expect(h.securityStorage.state).toMatchObject({
      proxyCreationUncertain: true,
      proxyCreationUncertainUntil: DEADLINE,
      proxyCleanupUncertainUntil: DEADLINE,
      nextRetryAt: DEADLINE,
    });

    // The worker which the alarm starts does not push it back again.
    const woken = createHarness({
      persisted: h.storage.persisted,
      security: h.securityStorage.state!,
    });
    woken.setNow(DEADLINE);
    woken.api.sessions = [sessionIssuedAt(DEADLINE)];
    await woken.controller.handleAlarm(ALARM_RECONNECT);
    await woken.controller.startupConnectionSettled();
    expect(woken.api.proofs).toHaveLength(1);
    expect(woken.controller.getSnapshot()).toMatchObject({ status: "connected", protected: true });
    expect(woken.securityStorage.state?.proxyCleanupUncertain).toBe(false);
  });

  it("leaves a later retry which the server asked for where it is", async () => {
    const AHEAD = NOW + 3_650 * DAY;
    const h = createHarness({
      persisted: authenticatedState(),
      security: {
        ...DEFAULT_SECURITY_STATE,
        protectionRequested: true,
        selectedLocationId: "frankfurt-01",
        proxyCreationUncertain: true,
        proxyCreationUncertainUntil: AHEAD,
        proxyCleanupUncertain: true,
        retrySuspended: true,
        nextRetryAt: NOW + DAY,
      },
    });
    await h.controller.initialize();
    await h.controller.startupConnectionSettled();

    expect(h.securityStorage.state).toMatchObject({
      proxyCreationUncertainUntil: DEADLINE,
      nextRetryAt: NOW + DAY,
    });
  });

  it("resumes a request which the previous worker never saw end", async () => {
    // The marker and its deadline are written before the request is sent.
    const interrupted: SecurityState = {
      ...DEFAULT_SECURITY_STATE,
      protectionRequested: true,
      selectedLocationId: "frankfurt-01",
      proxyCreationUncertain: true,
      proxyCreationUncertainUntil: DEADLINE,
      proxyCleanupUncertain: true,
      retrySuspended: true,
    };
    const h = createHarness({ persisted: authenticatedState(), security: interrupted });
    await h.controller.initialize();
    await h.controller.startupConnectionSettled();
    expect(h.api.proofs).toHaveLength(0);
    expect(h.alarms.reconnectAt).toBe(DEADLINE);

    h.setNow(DEADLINE);
    h.api.sessions = [sessionIssuedAt(DEADLINE)];
    await h.controller.handleAlarm(ALARM_RECONNECT);
    await h.controller.startupConnectionSettled();
    expect(h.api.proofs).toHaveLength(1);
    expect(h.controller.getSnapshot()).toMatchObject({ status: "connected", protected: true });
  });

  it("keeps a marker stored without a deadline suspended until it is settled", async () => {
    // Written by a version which knew no deadline: nothing says when it was set.
    const legacy: SecurityState = {
      ...DEFAULT_SECURITY_STATE,
      protectionRequested: true,
      selectedLocationId: "frankfurt-01",
      proxyCreationUncertain: true,
      proxyCleanupUncertain: true,
      retrySuspended: true,
    };
    const h = createHarness({ persisted: authenticatedState(), security: legacy });
    h.setNow(NOW + DAY);
    await h.controller.initialize();
    await h.controller.startupConnectionSettled();
    await h.controller.handleAlarm(ALARM_RECONNECT);
    await h.controller.startupConnectionSettled();

    expect(h.api.proofs).toHaveLength(0);
    expect(h.alarms.reconnectAt).toBeNull();
    expect(h.controller.getSnapshot().error).toBe("proxy_creation_uncertain");

    // The manual retry settles it, as before.
    h.api.sessions = [sessionIssuedAt(NOW + DAY)];
    expect(await h.controller.retryConnection()).toEqual({ ok: true });
    expect(h.securityStorage.state?.proxyCreationUncertain).toBe(false);
  });
});

describe("a refusal with a cause of its own after an unanswered creation", () => {
  it("stays suspended once the deadline has passed", async () => {
    const h = await unansweredConnection();
    h.api.createError = new ApiError("subscription_required", 403);
    await h.controller.retryConnection();
    expect(h.api.proofs).toHaveLength(2);
    expect(h.securityStorage.state).toMatchObject({
      proxyCreationUncertain: true,
      retrySuspended: true,
      nextRetryAt: null,
      suspensionCause: "subscription_required",
    });
    expect(h.securityStorage.state).not.toHaveProperty("proxyCreationUncertainUntil");
    expect(h.alarms.reconnectAt).toBeNull();

    h.setNow(NOW + DAY);
    h.api.createError = null;
    await h.controller.handleAlarm(ALARM_RECONNECT);
    await h.controller.startupConnectionSettled();
    expect(h.api.proofs).toHaveLength(2);

    const restarted = createHarness({
      persisted: h.storage.persisted,
      security: h.securityStorage.state!,
    });
    restarted.setNow(NOW + DAY);
    await restarted.controller.initialize();
    await restarted.controller.startupConnectionSettled();
    expect(restarted.api.proofs).toHaveLength(0);
    expect(restarted.alarms.reconnectAt).toBeNull();
  });
});

describe("the stored deadline of an unanswered creation", () => {
  let local: Record<string, unknown> = {};

  beforeEach(() => {
    local = {};
    vi.stubGlobal("browser", {
      storage: {
        local: {
          get: async (key: string) => ({ [key]: structuredClone(local[key]) }),
          set: async (data: Record<string, unknown>) => {
            Object.assign(local, structuredClone(data));
          },
        },
      },
    });
  });

  afterEach(() => vi.unstubAllGlobals());

  it("is kept with its marker", async () => {
    const storage = new ExtensionSecurityStorage();
    const state: SecurityState = {
      ...DEFAULT_SECURITY_STATE,
      protectionRequested: true,
      proxyCreationUncertain: true,
      proxyCreationUncertainUntil: DEADLINE,
    };
    await storage.write(state);
    await expect(storage.read(false, null)).resolves.toEqual(state);
  });

  it.each([
    ["has no marker", { proxyCreationUncertain: false, proxyCreationUncertainUntil: DEADLINE }],
    ["is not a time", { proxyCreationUncertain: true, proxyCreationUncertainUntil: "soon" }],
    ["is not positive", { proxyCreationUncertain: true, proxyCreationUncertainUntil: 0 }],
  ])("is dropped when it %s", async (_label, stored) => {
    local[SECURITY_STORAGE_KEY] = {
      ...DEFAULT_SECURITY_STATE,
      protectionRequested: true,
      ...stored,
    };
    const read = await new ExtensionSecurityStorage().read(false, null);
    expect(read).not.toHaveProperty("proxyCreationUncertainUntil");
    expect(read.proxyCreationUncertain).toBe(stored.proxyCreationUncertain);
  });
});

describe("a manual retry which the server refuses after an unanswered creation", () => {
  it("leaves the automatic retry at the deadline of the unanswered creation", async () => {
    const h = await unansweredConnection();
    // Nine minutes later the user retries: the server refuses, so nothing was created.
    h.setNow(NOW + 9 * 60_000);
    h.api.createError = new ApiError("rate_limited", 429);
    expect(await h.controller.retryConnection()).toMatchObject({ ok: false });

    expect(h.api.proofs).toHaveLength(2);
    // The only unknown session is still the first one: its deadline is unchanged.
    expect(h.securityStorage.state).toMatchObject({
      proxyCreationUncertain: true,
      proxyCreationUncertainUntil: DEADLINE,
      nextRetryAt: DEADLINE,
    });
    expect(h.alarms.reconnectAt).toBe(DEADLINE);

    h.setNow(DEADLINE);
    h.api.createError = null;
    h.api.sessions = [sessionIssuedAt(DEADLINE)];
    await h.controller.handleAlarm(ALARM_RECONNECT);
    await h.controller.startupConnectionSettled();
    expect(h.controller.getSnapshot()).toMatchObject({ status: "connected", protected: true });
  });
});
