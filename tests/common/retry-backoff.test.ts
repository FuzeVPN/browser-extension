// SPDX-License-Identifier: MPL-2.0

import { ApiError, NetworkError } from "../../src/core/api/client";
import { ALARM_RECONNECT, ALARM_REFRESH, STABLE_CONNECTION_MS } from "../../src/core/shared/config";
import { DEFAULT_SECURITY_STATE, type SecurityState } from "../../src/core/shared/security";
import {
  ExtensionSecurityStorage,
  SECURITY_STORAGE_KEY,
} from "../../src/core/storage/security-storage";
import { authenticatedState, createHarness, NOW, proxySession } from "./helpers";

type Harness = ReturnType<typeof createHarness>;

const SECOND = 1_000;
const MINUTE = 60 * SECOND;

/** A session the server issues at that time, valid for ten minutes. */
function sessionAt(time: number, id: string) {
  return proxySession(
    id,
    "frankfurt-01",
    new Date(time).toISOString(),
    new Date(time + 10 * MINUTE).toISOString(),
  );
}

async function connected(options: Parameters<typeof createHarness>[0] = {}) {
  const h = createHarness({ persisted: authenticatedState(), ...options });
  await h.controller.initialize();
  h.api.sessions = [sessionAt(NOW, "session-1")];
  expect(await h.controller.connect("frankfurt-01")).toEqual({ ok: true });
  return h;
}

/** The proxy of the active session fails its TLS handshake: the session is given up. */
async function nodeFails(h: Harness) {
  const session = h.proxy.active!;
  await h.controller.handleProxyError("proxy_tls_error", false, {
    host: session.host,
    port: session.port,
  });
  expect(h.controller.getSnapshot()).toMatchObject({ protected: false });
}

/** The retry alarm fires, and the server gives a session again. */
async function retrySucceeds(h: Harness, id: string) {
  const due = h.securityStorage.state!.nextRetryAt!;
  h.setNow(due);
  h.api.sessions = [sessionAt(due, id)];
  await h.controller.handleAlarm(ALARM_RECONNECT);
  expect(h.controller.getSnapshot()).toMatchObject({ status: "connected", protected: true });
}

const delay = (h: Harness, since: number) => h.securityStorage.state!.nextRetryAt! - since;

afterEach(() => vi.restoreAllMocks());

describe("the delay before a connection is tried again", () => {
  it("grows for a node which fails right after each connection", async () => {
    const h = await connected();
    const delays: number[] = [];
    let now = NOW;
    for (let round = 0; round < 6; round++) {
      // Each connection holds five seconds.
      now += 5 * SECOND;
      h.setNow(now);
      await nodeFails(h);
      delays.push(delay(h, now));
      await retrySucceeds(h, `session-${String(round + 2)}`);
      now = h.securityStorage.state!.connectedSince!;
    }

    expect(delays).toEqual([30, 60, 120, 300, 300, 300].map((seconds) => seconds * SECOND));
    // The attempts which failed in a row are still counted from the last success.
    expect(h.securityStorage.state).toMatchObject({ reconnectAttempts: 0, backoffLevel: 6 });
  });

  it("starts over after a connection which lasted", async () => {
    const h = await connected();
    h.setNow(NOW + 5 * SECOND);
    await nodeFails(h);
    await retrySucceeds(h, "session-2");
    const since = h.securityStorage.state!.connectedSince!;

    h.setNow(since + STABLE_CONNECTION_MS - 1);
    await nodeFails(h);
    expect(delay(h, since + STABLE_CONNECTION_MS - 1)).toBe(60 * SECOND);

    await retrySucceeds(h, "session-3");
    const again = h.securityStorage.state!.connectedSince!;
    h.setNow(again + STABLE_CONNECTION_MS);
    await nodeFails(h);
    expect(delay(h, again + STABLE_CONNECTION_MS)).toBe(30 * SECOND);
    expect(h.securityStorage.state?.backoffLevel).toBe(1);
  });

  it("counts a connection from when it came up, not from its last renewal", async () => {
    const h = await connected();
    expect(h.securityStorage.state?.connectedSince).toBe(NOW);

    h.setNow(NOW + 8.5 * MINUTE);
    h.api.sessions = [sessionAt(NOW + 8.5 * MINUTE, "renewed")];
    await h.controller.handleAlarm(ALARM_REFRESH);
    expect(h.proxy.active?.id).toBe("renewed");

    expect(h.securityStorage.state?.connectedSince).toBe(NOW);
  });

  it("starts over after a deliberate disconnection", async () => {
    const h = await connected();
    h.setNow(NOW + 5 * SECOND);
    await nodeFails(h);
    await retrySucceeds(h, "session-2");
    const since = h.securityStorage.state!.connectedSince!;
    h.setNow(since + 5 * SECOND);
    await nodeFails(h);
    expect(delay(h, since + 5 * SECOND)).toBe(60 * SECOND);

    expect(await h.controller.disconnect()).toEqual({ ok: true });
    expect(h.securityStorage.state).not.toHaveProperty("backoffLevel");
    expect(h.securityStorage.state).not.toHaveProperty("connectedSince");
    expect(h.securityStorage.state).not.toHaveProperty("retryCause");

    h.api.sessions = [sessionAt(since + 5 * SECOND, "session-3")];
    expect(await h.controller.connect("frankfurt-01")).toEqual({ ok: true });
    h.setNow(since + 10 * SECOND);
    await nodeFails(h);
    expect(delay(h, since + 10 * SECOND)).toBe(30 * SECOND);
  });

  it("goes on from the attempts which a previous version had counted", async () => {
    const counted: SecurityState = {
      ...DEFAULT_SECURITY_STATE,
      protectionRequested: true,
      selectedLocationId: "frankfurt-01",
      reconnectAttempts: 2,
      nextRetryAt: NOW,
    };
    const h = createHarness({ persisted: authenticatedState(), security: counted });
    h.api.createError = new ApiError("capacity_unavailable", 503);
    await h.controller.initialize();
    await h.controller.startupConnectionSettled();

    expect(delay(h, NOW)).toBe(120 * SECOND);
  });

  it.each([
    [0, 24],
    [0.5, 30],
    [1, 36],
    [Number.NaN, 30],
    [7, 36],
    [-3, 24],
  ])("is moved by a fifth at most either way (draw %s)", async (drawn, seconds) => {
    const h = await connected({ random: () => drawn });
    h.setNow(NOW + 5 * SECOND);
    await nodeFails(h);

    expect(delay(h, NOW + 5 * SECOND)).toBe(seconds * SECOND);
  });

  it("is never shorter than what the server asked for", async () => {
    const h = createHarness({ persisted: authenticatedState(), random: () => 0 });
    await h.controller.initialize();
    h.api.createError = new ApiError("rate_limited", 429, 45);
    await h.controller.connect("frankfurt-01");

    expect(delay(h, NOW)).toBe(45 * SECOND);
  });
});

describe("a session which is given up after a failure", () => {
  it("is revoked: the server does not hold it until it expires", async () => {
    const h = await connected();
    h.setNow(NOW + 5 * SECOND);
    await nodeFails(h);

    await vi.waitFor(() => expect(h.api.revoked).toEqual(["session-1"]));
  });

  it("is not revoked once it has expired", async () => {
    const h = await connected();
    h.setNow(NOW + 11 * MINUTE);
    h.api.createError = new NetworkError("network");
    await h.controller.handleAlarm(ALARM_REFRESH);
    await h.controller.startupConnectionSettled();

    expect(h.controller.getSnapshot().protected).toBe(false);
    expect(h.api.revoked).toEqual([]);
  });
});

describe("the failure which a scheduled retry follows", () => {
  /** A connection which the server could not serve, its retry thirty seconds away. */
  async function offline() {
    const h = createHarness({ persisted: authenticatedState() });
    await h.controller.initialize();
    h.api.createError = new ApiError("capacity_unavailable", 503);
    await h.controller.connect("frankfurt-01");
    expect(h.controller.getSnapshot().error).toBe("capacity_unavailable");
    return h;
  }

  it("is reported by a worker which starts before that retry", async () => {
    const h = await offline();
    expect(h.securityStorage.state).toMatchObject({
      retryCause: "capacity_unavailable",
      nextRetryAt: NOW + 30 * SECOND,
    });

    const next = createHarness({
      persisted: h.storage.persisted,
      security: h.securityStorage.state!,
    });
    next.setNow(NOW + 10 * SECOND);
    await next.controller.initialize();

    expect(next.controller.getSnapshot()).toMatchObject({
      status: "blocked",
      protected: false,
      error: "capacity_unavailable",
      nextRetryAt: NOW + 30 * SECOND,
    });
    expect(next.api.proofs).toHaveLength(0);
  });

  it("is reported as an unavailable proxy when a previous version stored the retry", async () => {
    const h = await offline();
    const stored = { ...h.securityStorage.state! };
    delete stored.retryCause;

    const next = createHarness({ persisted: h.storage.persisted, security: stored });
    next.setNow(NOW + 10 * SECOND);
    await next.controller.initialize();

    expect(next.controller.getSnapshot().error).toBe("proxy_unavailable");
  });

  it("is forgotten once the connection is back", async () => {
    const h = await offline();
    h.api.createError = null;
    h.setNow(NOW + 30 * SECOND);
    h.api.sessions = [sessionAt(NOW + 30 * SECOND, "session-1")];
    await h.controller.handleAlarm(ALARM_RECONNECT);

    expect(h.controller.getSnapshot()).toMatchObject({ protected: true, error: null });
    expect(h.securityStorage.state).not.toHaveProperty("retryCause");
  });
});

describe("what is stored of the retries", () => {
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

  const base = { ...DEFAULT_SECURITY_STATE, protectionRequested: true };

  it("is kept as it was written", async () => {
    const storage = new ExtensionSecurityStorage();
    const state: SecurityState = {
      ...base,
      nextRetryAt: NOW + 30 * SECOND,
      retryCause: "request_timeout",
      backoffLevel: 3,
    };
    await storage.write(state);
    await expect(storage.read(false, null)).resolves.toEqual(state);

    const up: SecurityState = { ...base, connectedSince: NOW, backoffLevel: 1 };
    await storage.write(up);
    await expect(storage.read(false, null)).resolves.toEqual(up);
  });

  it.each([
    ["a cause without its retry", { retryCause: "network_error" }, "retryCause"],
    [
      "a cause which no retry follows",
      { nextRetryAt: NOW, retryCause: "subscription_required" },
      "retryCause",
    ],
    ["a cause which is none", { nextRetryAt: NOW, retryCause: 7 }, "retryCause"],
    ["a level which is no count", { backoffLevel: "high" }, "backoffLevel"],
    ["a level of zero", { backoffLevel: 0 }, "backoffLevel"],
    ["a negative level", { backoffLevel: -1 }, "backoffLevel"],
    ["a time which is none", { connectedSince: "now" }, "connectedSince"],
    ["a time of zero", { connectedSince: 0 }, "connectedSince"],
  ])("drops %s", async (_name, stored, field) => {
    local[SECURITY_STORAGE_KEY] = { ...base, ...stored };

    expect(await new ExtensionSecurityStorage().read(false, null)).not.toHaveProperty(field);
  });

  it("bounds a level which was stored out of range", async () => {
    local[SECURITY_STORAGE_KEY] = { ...base, backoffLevel: 5_000_000 };

    expect((await new ExtensionSecurityStorage().read(false, null)).backoffLevel).toBe(1_000);
  });
});
