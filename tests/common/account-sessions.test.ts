// SPDX-License-Identifier: MPL-2.0

import { ApiError, NetworkError } from "../../src/core/api/client";
import {
  AccountSessions,
  SessionRenewalUnavailableError,
} from "../../src/core/background/account-sessions";
import {
  DAY,
  FakeRenewalServer,
  HOUR,
  MemorySessionStorage,
  MINUTE,
  START,
} from "./session-renewal-fixture";

const HANDLE = "sign-in-token-of-the-account";
const OTHER_REQUEST = "A".repeat(43);

interface Stored {
  version: number;
  revision: number;
  sessions: {
    handle: string;
    credentials: { accessToken: string; refreshToken: string } | null;
    pending: { route: string; token: string; requestId: string } | null;
    classicUntil: number | null;
    refused: boolean;
  }[];
}

function setup() {
  const clock = { now: START };
  const server = new FakeRenewalServer(() => clock.now);
  const storage = new MemorySessionStorage();
  const worker = () =>
    new AccountSessions({
      api: server,
      storage,
      now: () => clock.now,
      monotonic: () => clock.now,
    });
  server.signIn(HANDLE);
  return {
    clock,
    server,
    storage,
    worker,
    sessions: worker(),
    stored: () => storage.value as Stored,
    record: () => (storage.value as Stored).sessions.find((entry) => entry.handle === HANDLE),
  };
}

describe("the conversion of a classic account session", () => {
  it("happens once and yields the access token the server accepts", async () => {
    const f = setup();
    const access = await f.sessions.credential(HANDLE);
    expect(access).not.toBe(HANDLE);
    expect(f.server.accepts(access)).toBe(true);
    // The sign-in token no longer opens any account route.
    expect(f.server.accepts(HANDLE)).toBe(false);

    expect(await f.sessions.credential(HANDLE)).toBe(access);
    expect(f.server.rotations).toHaveLength(1);
    expect(f.server.rotations[0]).toMatchObject({ route: "upgrade", token: HANDLE });
    expect(f.server.rotations[0]?.requestId).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("stores its request before sending it, then the tokens and its removal together", async () => {
    const f = setup();
    const atSend: unknown[] = [];
    const upgrade = f.server.upgradeSession.bind(f.server);
    f.server.upgradeSession = (token, requestId) => {
      atSend.push(structuredClone(f.storage.value));
      return upgrade(token, requestId);
    };
    const access = await f.sessions.credential(HANDLE);

    const sent = f.server.rotations[0];
    expect((atSend[0] as Stored).sessions).toMatchObject([
      {
        handle: HANDLE,
        credentials: null,
        pending: { route: "upgrade", token: HANDLE, requestId: sent?.requestId },
      },
    ]);
    // One write later, never an intermediate state with tokens and a pending request.
    expect(f.storage.written).toHaveLength(2);
    expect(f.record()).toMatchObject({ credentials: { accessToken: access }, pending: null });
  });

  it("sends nothing when its request cannot be stored", async () => {
    const f = setup();
    f.storage.failWrite = true;
    expect(await f.sessions.credential(HANDLE)).toBe(HANDLE);
    expect(f.server.rotations).toHaveLength(0);
    expect(f.server.accepts(HANDLE)).toBe(true);
  });

  it("uses a new identifier for every request", async () => {
    const f = setup();
    await f.sessions.credential(HANDLE);
    for (let renewal = 0; renewal < 5; renewal++) {
      f.clock.now += HOUR;
      await f.sessions.credential(HANDLE);
    }
    const identifiers = f.server.rotations.map((call) => call.requestId);
    expect(new Set(identifiers).size).toBe(6);
  });

  it("is sent again unchanged after a lost answer, and yields the same tokens", async () => {
    const f = setup();
    f.server.faults.push("lost");
    // In doubt: the sign-in token is still tried, and nothing is sent before the delay.
    expect(await f.sessions.credential(HANDLE)).toBe(HANDLE);
    expect(await f.sessions.credential(HANDLE)).toBe(HANDLE);
    expect(f.server.rotations).toHaveLength(1);
    expect(f.record()?.pending).toMatchObject({ route: "upgrade", token: HANDLE });

    f.clock.now += 2_000;
    const access = await f.sessions.credential(HANDLE);
    expect(f.server.accepts(access)).toBe(true);
    expect(f.server.rotations).toHaveLength(2);
    expect(f.server.rotations[1]).toEqual(f.server.rotations[0]);
    expect(f.record()?.pending).toBeNull();
  });

  it("leaves the classic session in use when the server does not know it", async () => {
    const f = setup();
    f.server.supported = false;
    expect(await f.sessions.credential(HANDLE)).toBe(HANDLE);
    expect(await f.sessions.credential(HANDLE)).toBe(HANDLE);
    expect(f.server.rotations).toHaveLength(1);
    expect(f.record()).toMatchObject({ credentials: null, pending: null });
    expect(f.server.accepts(HANDLE)).toBe(true);

    // Asked again a day later, and converted once the server knows the route.
    f.clock.now += DAY + 1;
    expect(await f.sessions.credential(HANDLE)).toBe(HANDLE);
    expect(f.server.rotations).toHaveLength(2);
    f.server.supported = true;
    f.clock.now += DAY + 1;
    expect(f.server.accepts(await f.sessions.credential(HANDLE))).toBe(true);
  });

  it("is not asked again by a later worker within the day", async () => {
    const f = setup();
    f.server.supported = false;
    await f.sessions.credential(HANDLE);
    f.clock.now += HOUR;
    expect(await f.worker().credential(HANDLE)).toBe(HANDLE);
    expect(f.server.rotations).toHaveLength(1);
  });

  it("is refused when another request already converted the session", async () => {
    const f = setup();
    await f.server.upgradeSession(HANDLE, OTHER_REQUEST);
    await expect(f.sessions.credential(HANDLE)).rejects.toMatchObject({ status: 401 });
    expect(f.record()).toMatchObject({ refused: true, credentials: null, pending: null });
  });

  it("adopts the tokens another instance stored for the same conversion", async () => {
    const f = setup();
    const upgrade = f.server.upgradeSession.bind(f.server);
    let stored = "";
    f.server.upgradeSession = async (token, requestId) => {
      // Another instance converts the session and stores its result first.
      const pair = await upgrade(HANDLE, OTHER_REQUEST);
      stored = pair.accessToken;
      f.storage.value = {
        version: 1,
        revision: 9,
        sessions: [
          {
            handle: HANDLE,
            credentials: pair,
            pending: null,
            classicUntil: null,
            refused: false,
            touchedAt: f.clock.now,
          },
        ],
      };
      return upgrade(token, requestId);
    };
    expect(await f.sessions.credential(HANDLE)).toBe(stored);
    expect(f.server.sessionCount).toBe(1);
  });

  it("is not repeated by a second instance which finds the tokens in storage", async () => {
    const f = setup();
    const second = f.worker();
    await second.initialize();
    const access = await f.sessions.credential(HANDLE);
    expect(await second.credential(HANDLE)).toBe(access);
    expect(f.server.rotations).toHaveLength(1);
  });
});

describe("the renewal of an account session in use", () => {
  it("replaces the access token five minutes before it expires, not earlier", async () => {
    const f = setup();
    const first = await f.sessions.credential(HANDLE);
    const refresh = f.record()?.credentials?.refreshToken;

    f.clock.now += 54 * MINUTE;
    expect(await f.sessions.credential(HANDLE)).toBe(first);
    expect(f.server.rotations).toHaveLength(1);

    f.clock.now += 2 * MINUTE;
    const second = await f.sessions.credential(HANDLE);
    expect(second).not.toBe(first);
    expect(f.server.accepts(second)).toBe(true);
    expect(f.server.accepts(first)).toBe(false);
    expect(f.server.rotations[1]).toMatchObject({ route: "refresh", token: refresh });
  });

  it("accepts a refresh token after its access token has expired", async () => {
    const f = setup();
    await f.sessions.credential(HANDLE);
    f.clock.now += 200 * DAY;
    expect(f.server.accepts(await f.sessions.credential(HANDLE))).toBe(true);
  });

  it("goes on without a yearly deadline while the account is used", async () => {
    const f = setup();
    await f.sessions.credential(HANDLE);
    for (let month = 0; month < 30; month++) {
      f.clock.now += 30 * DAY;
      expect(f.server.accepts(await f.sessions.credential(HANDLE))).toBe(true);
      expect(f.sessions.expiryOf(HANDLE)).toBe(f.clock.now + 365 * DAY);
    }
  });

  it("is refused once the right to renew has run out, and asks nothing more", async () => {
    const f = setup();
    await f.sessions.credential(HANDLE);
    f.clock.now += 366 * DAY;
    await expect(f.sessions.credential(HANDLE)).rejects.toMatchObject({
      code: "unauthorized",
      status: 401,
    });
    const calls = f.server.rotations.length;
    await expect(f.sessions.credential(HANDLE)).rejects.toMatchObject({ status: 401 });
    await expect(f.worker().credential(HANDLE)).rejects.toMatchObject({ status: 401 });
    expect(f.server.rotations).toHaveLength(calls);
    expect(f.sessions.expiryOf(HANDLE)).toBeNull();
  });

  it("is refused when the server ended the session", async () => {
    const f = setup();
    await f.sessions.credential(HANDLE);
    f.server.revokeAll();
    f.clock.now += 56 * MINUTE;
    await expect(f.sessions.credential(HANDLE)).rejects.toBeInstanceOf(ApiError);
    expect(f.record()).toMatchObject({ refused: true, credentials: null, pending: null });
  });

  it("makes one rotation for requests which need it at the same time", async () => {
    const f = setup();
    const tokens = await Promise.all([
      f.sessions.credential(HANDLE),
      f.sessions.credential(HANDLE),
      f.sessions.credential(HANDLE),
    ]);
    expect(new Set(tokens).size).toBe(1);
    f.clock.now += HOUR;
    const renewed = await Promise.all([
      f.sessions.credential(HANDLE),
      f.sessions.credential(HANDLE),
    ]);
    expect(new Set(renewed).size).toBe(1);
    expect(f.server.rotations).toHaveLength(2);
  });

  it("is resumed unchanged by the next worker after a lost answer", async () => {
    const f = setup();
    const first = await f.sessions.credential(HANDLE);
    f.clock.now += 56 * MINUTE;
    f.server.faults.push("lost");
    // In doubt: the token which has not expired yet is tried, and the server refuses it.
    expect(await f.sessions.credential(HANDLE)).toBe(first);
    expect(f.server.accepts(first)).toBe(false);

    // The next worker respects the delay which the stored request carries.
    const next = f.worker();
    expect(await next.credential(HANDLE)).toBe(first);
    expect(f.server.rotations).toHaveLength(2);
    f.clock.now += 2_000;
    const second = await next.credential(HANDLE);
    expect(f.server.accepts(second)).toBe(true);
    expect(f.server.rotations).toHaveLength(3);
    expect(f.server.rotations[2]).toEqual(f.server.rotations[1]);
    expect(f.server.sessionCount).toBe(1);
  });

  it("uses the recovered refresh token at once when its access token has expired", async () => {
    const f = setup();
    await f.sessions.credential(HANDLE);
    f.clock.now += 56 * MINUTE;
    f.server.faults.push("lost");
    await f.sessions.credential(HANDLE);

    f.clock.now += 3 * HOUR;
    const access = await f.worker().credential(HANDLE);
    expect(f.server.accepts(access)).toBe(true);
    const calls = f.server.rotations;
    expect(calls).toHaveLength(4);
    // The lost request again, then a new one with the refresh token it returned.
    expect(calls[2]).toEqual(calls[1]);
    expect(calls[3]?.token).toMatch(/\.2$/);
    expect(calls[3]?.requestId).not.toBe(calls[2]?.requestId);
  });

  it.each([
    ["a session in transition", new ApiError("session_transition", 409), 2_000],
    ["a rate limit", new ApiError("rate_limited", 429, 30), 30_000],
    ["a server failure", new ApiError("server_error", 503), 2_000],
    ["an unavailable renewal service", new ApiError("session_renewal_unavailable", 503), 2_000],
    ["a network failure", new NetworkError("network"), 2_000],
    ["an unreadable answer", new NetworkError("invalid_response"), 2_000],
  ] as const)("keeps its request and sends it again after %s", async (_label, error, delay) => {
    const f = setup();
    const first = await f.sessions.credential(HANDLE);
    f.clock.now += 56 * MINUTE;
    f.server.faults.push(error);
    expect(await f.sessions.credential(HANDLE)).toBe(first);
    const pending = f.record()?.pending;
    expect(pending).toMatchObject({ route: "refresh" });

    // Nothing is sent before the delay, which follows Retry-After when it is given.
    f.clock.now += delay - 1;
    expect(await f.sessions.credential(HANDLE)).toBe(first);
    expect(f.server.rotations).toHaveLength(2);

    f.clock.now += 1;
    const second = await f.sessions.credential(HANDLE);
    expect(f.server.accepts(second)).toBe(true);
    expect(f.server.rotations[2]).toMatchObject({
      route: "refresh",
      token: pending?.token,
      requestId: pending?.requestId,
    });
  });

  it("waits longer after each failure", async () => {
    const f = setup();
    await f.sessions.credential(HANDLE);
    f.clock.now += 2 * HOUR;
    const delays = [2_000, 5_000, 15_000, 60_000, 5 * MINUTE, 5 * MINUTE];
    for (const delay of delays) {
      f.server.faults.push(new NetworkError("timeout"));
      await expect(f.sessions.credential(HANDLE)).rejects.toMatchObject({
        retryAfterSeconds: delay / 1_000,
      });
      f.clock.now += delay;
    }
    expect(f.server.accepts(await f.sessions.credential(HANDLE))).toBe(true);
    expect(new Set(f.server.rotations.slice(1).map((call) => call.requestId)).size).toBe(1);
  });

  it("is unavailable, not refused, while an expired token cannot be renewed", async () => {
    const f = setup();
    await f.sessions.credential(HANDLE);
    f.clock.now += 2 * HOUR;
    f.server.faults.push(new NetworkError("network"));
    await expect(f.sessions.credential(HANDLE)).rejects.toBeInstanceOf(
      SessionRenewalUnavailableError,
    );
    expect(f.record()).toMatchObject({ refused: false });
    expect(f.sessions.expiryOf(HANDLE)).not.toBeNull();

    f.clock.now += 2_000;
    expect(f.server.accepts(await f.sessions.credential(HANDLE))).toBe(true);
  });

  it("builds a new request after the server refused a malformed one", async () => {
    const f = setup();
    const first = await f.sessions.credential(HANDLE);
    f.clock.now += 56 * MINUTE;
    f.server.faults.push(new ApiError("invalid_session_request_id", 400));
    expect(await f.sessions.credential(HANDLE)).toBe(first);
    expect(f.record()?.pending).toBeNull();

    f.clock.now += 2_000;
    expect(f.server.accepts(await f.sessions.credential(HANDLE))).toBe(true);
    expect(f.server.rotations[2]?.requestId).not.toBe(f.server.rotations[1]?.requestId);
  });

  it("is unavailable while its stored sessions cannot be read", async () => {
    const f = setup();
    f.storage.failRead = true;
    await expect(f.sessions.credential(HANDLE)).rejects.toBeInstanceOf(
      SessionRenewalUnavailableError,
    );
    expect(f.server.rotations).toHaveLength(0);
    f.storage.failRead = false;
    expect(f.server.accepts(await f.sessions.credential(HANDLE))).toBe(true);
  });

  it("resumes at worker start a request which a previous worker left unanswered", async () => {
    const f = setup();
    f.server.faults.push("lost");
    await f.sessions.credential(HANDLE);
    f.clock.now += 2_000;
    f.worker().resume();
    await vi.waitFor(() => expect(f.record()?.credentials).not.toBeNull());
    expect(f.server.rotations).toHaveLength(2);
    expect(f.server.rotations[1]).toEqual(f.server.rotations[0]);
  });

  it("never throws from a background renewal", async () => {
    const f = setup();
    f.server.revokeAll();
    expect(() => f.sessions.touch(HANDLE)).not.toThrow();
    await vi.waitFor(() => expect(f.record()?.refused).toBe(true));
  });
});

describe("a request refused with a 401", () => {
  it("is sent again with the token which replaced the refused one", async () => {
    const f = setup();
    const first = await f.sessions.credential(HANDLE);
    f.clock.now += HOUR;
    const second = await f.sessions.credential(HANDLE);
    expect(await f.sessions.recover(HANDLE, first)).toBe(second);
    expect(f.server.rotations).toHaveLength(2);
  });

  it("renews once a token which the server alone considers expired", async () => {
    const f = setup();
    const first = await f.sessions.credential(HANDLE);
    f.clock.now += 10 * MINUTE;
    const second = await f.sessions.recover(HANDLE, first);
    expect(second).not.toBe(first);
    expect(f.server.accepts(second ?? "")).toBe(true);
  });

  it("renews once even a token issued a moment ago: only the renewal can refuse", async () => {
    const f = setup();
    const first = await f.sessions.credential(HANDLE);
    const second = await f.sessions.recover(HANDLE, first);
    expect(f.server.accepts(second ?? "")).toBe(true);
    expect(f.server.rotations).toHaveLength(2);
  });

  it("stands for the sign-in token of a classic session", async () => {
    const f = setup();
    f.server.supported = false;
    await f.sessions.credential(HANDLE);
    expect(await f.sessions.recover(HANDLE, HANDLE)).toBeNull();
  });

  it("stands for a token this class does not manage", async () => {
    const f = setup();
    expect(await f.sessions.recover("unknown-token", "unknown-token")).toBeNull();
    expect(f.server.rotations).toHaveLength(0);
  });

  it("is the refusal of the session when its renewal is refused too", async () => {
    const f = setup();
    const first = await f.sessions.credential(HANDLE);
    f.server.revokeAll();
    f.clock.now += 10 * MINUTE;
    await expect(f.sessions.recover(HANDLE, first)).rejects.toMatchObject({ status: 401 });
    expect(f.record()).toMatchObject({ refused: true });
  });

  it("settles the conversion in doubt which may explain it", async () => {
    const f = setup();
    f.server.faults.push("lost");
    await f.sessions.credential(HANDLE);
    // The delay is respected: the refusal is neither confirmed nor explained yet.
    await expect(f.sessions.recover(HANDLE, HANDLE)).rejects.toBeInstanceOf(
      SessionRenewalUnavailableError,
    );
    f.clock.now += 2_000;
    const access = await f.sessions.recover(HANDLE, HANDLE);
    expect(f.server.accepts(access ?? "")).toBe(true);
    expect(f.server.rotations[1]).toEqual(f.server.rotations[0]);
  });

  it("says nothing about the session when the renewal could not be made", async () => {
    const f = setup();
    const first = await f.sessions.credential(HANDLE);
    f.clock.now += 10 * MINUTE;
    f.server.faults.push(new NetworkError("timeout"));
    await expect(f.sessions.recover(HANDLE, first)).rejects.toBeInstanceOf(
      SessionRenewalUnavailableError,
    );
    f.clock.now += 2_000;
    f.storage.failWrite = true;
    f.server.faults.length = 0;
    // The pending request is still stored from the first attempt, and is sent again.
    expect(f.server.accepts((await f.sessions.recover(HANDLE, first)) ?? "")).toBe(true);
  });
});

describe("the logout of an account session", () => {
  it("ends a renewable session with its refresh token and forgets it", async () => {
    const f = setup();
    await f.sessions.credential(HANDLE);
    const refresh = f.record()?.credentials?.refreshToken;
    await f.sessions.logout(HANDLE);
    expect(f.server.calls.at(-1)).toEqual({ route: "logout", token: refresh });
    expect(f.server.sessionCount).toBe(0);
    expect(f.stored().sessions).toEqual([]);
    expect(f.sessions.expiryOf(HANDLE)).toBeNull();
  });

  it("works after the access token has expired", async () => {
    const f = setup();
    await f.sessions.credential(HANDLE);
    f.clock.now += 40 * DAY;
    await f.sessions.logout(HANDLE);
    expect(f.server.sessionCount).toBe(0);
    expect(f.server.rotations).toHaveLength(1);
  });

  it("ends the session whose renewal answer was lost", async () => {
    const f = setup();
    await f.sessions.credential(HANDLE);
    f.clock.now += 56 * MINUTE;
    f.server.faults.push("lost");
    await f.sessions.credential(HANDLE);
    // The retired refresh token is enough: no new rotation is needed to log out.
    await f.sessions.logout(HANDLE);
    expect(f.server.sessionCount).toBe(0);
    expect(f.server.rotations).toHaveLength(2);
  });

  it("ends a classic session with its sign-in token", async () => {
    const f = setup();
    f.server.supported = false;
    await f.sessions.credential(HANDLE);
    await f.sessions.logout(HANDLE);
    expect(f.server.calls.at(-1)).toEqual({ route: "logout", token: HANDLE });
    expect(f.server.sessionCount).toBe(0);
    expect(f.stored().sessions).toEqual([]);
  });

  it("does not convert a token only to log it out", async () => {
    const f = setup();
    await f.sessions.logout(HANDLE);
    expect(f.server.calls).toEqual([{ route: "logout", token: HANDLE }]);
    expect(f.server.sessionCount).toBe(0);
  });

  it("settles a conversion in doubt first, to end the session it created", async () => {
    const f = setup();
    f.server.faults.push("lost");
    await f.sessions.credential(HANDLE);
    f.clock.now += 2_000;
    await f.sessions.logout(HANDLE);
    expect(f.server.rotations).toHaveLength(2);
    expect(f.server.calls.at(-1)?.token).toMatch(/^fr1\./);
    expect(f.server.sessionCount).toBe(0);
  });

  it("removes a session from storage even when the server could not confirm", async () => {
    const f = setup();
    const access = await f.sessions.credential(HANDLE);
    f.server.logoutError = new NetworkError("network");
    await expect(f.sessions.logout(HANDLE)).rejects.toBeInstanceOf(NetworkError);
    expect(f.stored().sessions).toEqual([]);

    // This worker can still present the session, and end it once the server answers.
    expect(await f.sessions.credential(HANDLE)).toBe(access);
    expect(f.stored().sessions).toEqual([]);
    f.server.logoutError = null;
    await f.sessions.logout(HANDLE);
    expect(f.server.sessionCount).toBe(0);
    // A later worker knows nothing of it.
    expect(f.worker().expiryOf(HANDLE)).toBeNull();
  });

  it("waits for a renewal in progress and ends the renewed session", async () => {
    const f = setup();
    await f.sessions.credential(HANDLE);
    f.clock.now += HOUR;
    const renewal = f.sessions.credential(HANDLE);
    const logout = f.sessions.logout(HANDLE);
    await Promise.all([renewal, logout]);
    expect(f.server.calls.at(-1)?.token).toMatch(/\.2$/);
    expect(f.server.sessionCount).toBe(0);
  });
});

describe("the stored account sessions", () => {
  it("say when the right to renew ends, only once the session is renewable", async () => {
    const f = setup();
    expect(f.sessions.expiryOf(HANDLE)).toBeNull();
    await f.sessions.credential(HANDLE);
    expect(f.sessions.expiryOf(HANDLE)).toBe(START + 365 * DAY);
    const next = f.worker();
    await next.initialize();
    expect(next.expiryOf(HANDLE)).toBe(START + 365 * DAY);
  });

  it("drop every entry which cannot be read safely", async () => {
    const f = setup();
    const credentials = {
      accessToken: "access",
      expiresAt: new Date(START + HOUR).toISOString(),
      refreshToken: "fr1.session.1",
      refreshExpiresAt: new Date(START + 365 * DAY).toISOString(),
    };
    const entry = { classicUntil: null, refused: false, touchedAt: START };
    f.storage.value = {
      version: 1,
      revision: 4,
      sessions: [
        { ...entry, handle: "a token with spaces", credentials, pending: null },
        { ...entry, handle: "no-date", credentials: { ...credentials, expiresAt: "soon" } },
        {
          ...entry,
          handle: "foreign-request",
          credentials: null,
          pending: { route: "upgrade", token: "another-token", requestId: OTHER_REQUEST },
        },
        {
          ...entry,
          handle: "short-request",
          credentials,
          pending: { route: "refresh", token: "fr1.session.1", requestId: "short" },
        },
        { ...entry, handle: "kept", credentials, pending: null },
        "not a record",
      ].slice(0, 4),
    };
    const sessions = f.worker();
    await sessions.initialize();
    for (const handle of ["a token with spaces", "no-date", "foreign-request", "short-request"])
      expect(sessions.expiryOf(handle)).toBeNull();
  });

  it.each([null, "tokens", [], { version: 2, sessions: [] }, { version: 1 }])(
    "start empty from an unknown record: %j",
    async (stored) => {
      const f = setup();
      f.storage.value = stored;
      const sessions = f.worker();
      expect(f.server.accepts(await sessions.credential(HANDLE))).toBe(true);
    },
  );

  it("keep the four sessions used last", async () => {
    const f = setup();
    f.server.supported = false;
    for (const handle of ["one", "two", "three", "four", "five"]) {
      f.clock.now += 1;
      await f.sessions.credential(handle);
    }
    expect(f.stored().sessions.map((entry) => entry.handle)).toEqual([
      "five",
      "four",
      "three",
      "two",
    ]);
  });

  it("forget a refused session a day later", async () => {
    const f = setup();
    f.server.revokeAll();
    await expect(f.sessions.credential(HANDLE)).rejects.toMatchObject({ status: 401 });
    expect(f.stored().sessions).toHaveLength(1);
    f.clock.now += DAY + 1;
    f.server.supported = false;
    await f.sessions.credential("another-account");
    expect(f.stored().sessions.map((entry) => entry.handle)).toEqual(["another-account"]);
  });

  it("never hold a token outside their own record", async () => {
    const f = setup();
    await f.sessions.credential(HANDLE);
    f.clock.now += HOUR;
    await f.sessions.credential(HANDLE);
    const record = f.record();
    expect(Object.keys(f.stored()).sort()).toEqual(["revision", "sessions", "version"]);
    expect(Object.keys(record ?? {}).sort()).toEqual([
      "classicUntil",
      "credentials",
      "handle",
      "pending",
      "refused",
      "retryAt",
      "touchedAt",
    ]);
  });
});

describe("a fetch which presents the account session", () => {
  function fetching() {
    const f = setup();
    const base = vi.fn<typeof fetch>(async (_input, init) => {
      const token = new Headers(init?.headers).get("Authorization")?.slice(7) ?? "";
      return new Response("{}", { status: f.server.accepts(token) ? 201 : 401 });
    });
    const presented = () =>
      base.mock.calls.map(([, init]) => new Headers(init?.headers).get("Authorization"));
    return { ...f, base, presented, fetch: f.sessions.fetcher(base) };
  }
  const request = {
    method: "POST",
    headers: { Authorization: `Bearer ${HANDLE}`, "Content-Type": "application/json" },
    body: '{"report":1}',
  };

  it("leaves a request without account token untouched", async () => {
    const f = fetching();
    const init = { method: "GET" };
    await f.fetch("https://api.fuzevpn.com/v1/locations", init);
    expect(f.base).toHaveBeenCalledWith("https://api.fuzevpn.com/v1/locations", init);
    expect(f.server.rotations).toHaveLength(0);
  });

  it("replaces the sign-in token by the current access token", async () => {
    const f = fetching();
    const response = await f.fetch("https://api.fuzevpn.com/v1/diagnostics", request);
    expect(response.status).toBe(201);
    const access = f.record()?.credentials?.accessToken ?? "";
    expect(f.presented()).toEqual([`Bearer ${access}`]);
    expect(f.base.mock.calls[0]?.[1]).toMatchObject({ method: "POST", body: '{"report":1}' });
    expect(new Headers(f.base.mock.calls[0]?.[1]?.headers).get("Content-Type")).toBe(
      "application/json",
    );
  });

  it("sends the request once more after renewing a refused token", async () => {
    const f = fetching();
    const first = await f.sessions.credential(HANDLE);
    f.clock.now += 10 * MINUTE;
    f.base.mockResolvedValueOnce(new Response("{}", { status: 401 }));
    const response = await f.fetch("https://api.fuzevpn.com/v1/diagnostics", request);
    expect(response.status).toBe(201);
    expect(f.presented()).toEqual([
      `Bearer ${first}`,
      `Bearer ${f.record()?.credentials?.accessToken ?? ""}`,
    ]);
    expect(f.presented()[1]).not.toBe(f.presented()[0]);
  });

  it("answers 401 itself once the session is refused", async () => {
    const f = fetching();
    await f.sessions.credential(HANDLE);
    f.server.revokeAll();
    f.clock.now += HOUR;
    const response = await f.fetch("https://api.fuzevpn.com/v1/diagnostics", request);
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "unauthorized" });
    expect(f.base).not.toHaveBeenCalled();
  });

  it("returns the refusal of a session whose renewal is refused too", async () => {
    const f = fetching();
    await f.sessions.credential(HANDLE);
    f.server.revokeAll();
    f.clock.now += 10 * MINUTE;
    const response = await f.fetch("https://api.fuzevpn.com/v1/diagnostics", request);
    expect(response.status).toBe(401);
    expect(f.base).toHaveBeenCalledTimes(1);
  });

  it("fails like the network while the session cannot be renewed", async () => {
    const f = fetching();
    await f.sessions.credential(HANDLE);
    f.clock.now += 2 * HOUR;
    f.server.faults.push(new NetworkError("timeout"));
    await expect(f.fetch("https://api.fuzevpn.com/v1/diagnostics", request)).rejects.toBeInstanceOf(
      TypeError,
    );
    expect(f.base).not.toHaveBeenCalled();
  });
});

describe("sessions handled at the same time", () => {
  const SECOND = "sign-in-token-of-another-account";

  it("do not wait for the logout of another session", async () => {
    const f = setup();
    f.server.signIn(SECOND);
    await f.sessions.credential(HANDLE);
    // The server holds the logout of the first account back.
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const logout = f.server.logout.bind(f.server);
    f.server.logout = async (token) => {
      await held;
      return logout(token);
    };
    const leaving = f.sessions.logout(HANDLE);

    const access = await f.sessions.credential(SECOND);
    expect(f.server.accepts(access)).toBe(true);
    expect(f.server.sessionCount).toBe(2);

    release();
    await leaving;
    expect(f.server.sessionCount).toBe(1);
    expect(f.stored().sessions.map((entry) => entry.handle)).toEqual([SECOND]);
  });

  it("wait for the logout of their own session", async () => {
    const f = setup();
    await f.sessions.credential(HANDLE);
    const order: string[] = [];
    const logout = f.server.logout.bind(f.server);
    f.server.logout = async (token) => {
      await Promise.resolve();
      order.push("logout");
      return logout(token);
    };
    const leaving = f.sessions.logout(HANDLE);
    const next = f.sessions.credential(HANDLE).then(
      () => order.push("credential"),
      () => order.push("credential"),
    );
    await Promise.all([leaving, next]);
    expect(order).toEqual(["logout", "credential"]);
  });

  it("are all stored when they are converted together", async () => {
    const f = setup();
    f.server.signIn(SECOND);
    const [first, second] = await Promise.all([
      f.sessions.credential(HANDLE),
      f.sessions.credential(SECOND),
    ]);
    const stored = f.stored().sessions;
    expect(stored).toHaveLength(2);
    expect(stored.every((entry) => entry.pending === null)).toBe(true);
    expect(stored.map((entry) => entry.credentials?.accessToken).sort()).toEqual(
      [first, second].sort(),
    );
    // Each write carries a higher revision than the one before.
    const revisions = f.storage.written.map((value) => (value as Stored).revision);
    expect(revisions).toEqual([...revisions].sort((left, right) => left - right));
    expect(new Set(revisions).size).toBe(revisions.length);
  });

  it("are written one after the other, the latest state last", async () => {
    const f = setup();
    f.server.signIn(SECOND);
    const write = f.storage.write.bind(f.storage);
    let writing = 0;
    let overlapped = false;
    let delay = 40;
    // Each write is faster than the one before: overlapping ones would finish in reverse.
    f.storage.write = async (value) => {
      if (writing++ > 0) overlapped = true;
      const wait = delay;
      delay = Math.max(0, delay - 10);
      await new Promise((resolve) => setTimeout(resolve, wait));
      await write(value);
      writing -= 1;
    };
    await Promise.all([f.sessions.credential(HANDLE), f.sessions.credential(SECOND)]);
    expect(overlapped).toBe(false);
    expect(f.stored().sessions).toHaveLength(2);
    expect(f.stored().sessions.every((entry) => entry.credentials && !entry.pending)).toBe(true);
  });
});

describe("the refusal of a sign-in token while its conversion is pending", () => {
  it.each([
    ["an unavailable renewal service", new ApiError("session_renewal_unavailable", 503)],
    ["a rate limit", new ApiError("rate_limited", 429, 60)],
    ["a session in transition", new ApiError("session_transition", 409)],
  ] as const)("stands after %s, which changed nothing on the server", async (_label, error) => {
    const f = setup();
    f.server.faults.push(error);
    expect(await f.sessions.credential(HANDLE)).toBe(HANDLE);
    expect(f.record()?.pending).toMatchObject({ route: "upgrade" });
    // The sign-in token is refused: the pending conversion cannot be the reason.
    expect(await f.sessions.recover(HANDLE, HANDLE)).toBeNull();
    // The same request is still sent again later, as for any pending rotation.
    f.clock.now += 60_000;
    expect(f.server.accepts(await f.sessions.credential(HANDLE))).toBe(true);
    expect(f.server.rotations[1]).toEqual(f.server.rotations[0]);
  });

  it.each([
    ["no answer", new NetworkError("timeout")],
    ["a gateway failure", new ApiError("server_error", 502)],
    ["a server failure", new ApiError("server_error", 500)],
    ["an unavailable service of another kind", new ApiError("maintenance", 503)],
  ] as const)("cannot be judged after %s", async (_label, error) => {
    const f = setup();
    f.server.faults.push(error);
    expect(await f.sessions.credential(HANDLE)).toBe(HANDLE);
    await expect(f.sessions.recover(HANDLE, HANDLE)).rejects.toBeInstanceOf(
      SessionRenewalUnavailableError,
    );
  });

  it("cannot be judged by a later worker which finds the request stored", async () => {
    const f = setup();
    f.server.faults.push(new ApiError("session_renewal_unavailable", 503));
    await f.sessions.credential(HANDLE);
    const next = f.worker();
    f.server.faults.push(new ApiError("session_renewal_unavailable", 503));
    await expect(next.recover(HANDLE, HANDLE)).rejects.toBeInstanceOf(
      SessionRenewalUnavailableError,
    );
  });
});

describe("a request which an earlier attempt may have applied", () => {
  it("is kept when a server which lost its answer no longer knows the conversion", async () => {
    const f = setup();
    f.server.faults.push("lost");
    await f.sessions.credential(HANDLE);
    // The retry reaches a server without the route: it says nothing of the first attempt.
    f.server.supported = false;
    f.clock.now += 2_000;
    expect(await f.sessions.credential(HANDLE)).toBe(HANDLE);
    expect(f.record()?.pending).toMatchObject({ route: "upgrade" });
    // That server cannot convert the session: its refusal of the sign-in token stands,
    // instead of leaving the account in a state which nothing would ever settle.
    expect(await f.sessions.recover(HANDLE, HANDLE)).toBeNull();

    f.server.supported = true;
    f.clock.now += 5_000;
    expect(f.server.accepts(await f.sessions.credential(HANDLE))).toBe(true);
    expect(f.server.rotations[2]).toEqual(f.server.rotations[0]);
  });

  it("is kept when its repetition is refused as malformed", async () => {
    const f = setup();
    await f.sessions.credential(HANDLE);
    f.clock.now += 56 * MINUTE;
    f.server.faults.push("lost", new ApiError("invalid_json", 400));
    await f.sessions.credential(HANDLE);
    f.clock.now += 2_000;
    await f.sessions.credential(HANDLE);
    expect(f.record()?.pending).toMatchObject({ route: "refresh" });

    // A new identifier with the retired refresh token would have ended the session.
    f.clock.now += 5_000;
    expect(f.server.accepts(await f.sessions.credential(HANDLE))).toBe(true);
    const sent = f.server.rotations.slice(1);
    expect(new Set(sent.map((call) => call.requestId)).size).toBe(1);
    expect(f.server.sessionCount).toBe(1);
  });

  it("is settled by the first answer of a server which does not know the conversion", async () => {
    const f = setup();
    f.server.supported = false;
    await f.sessions.credential(HANDLE);
    expect(f.record()).toMatchObject({ pending: null, credentials: null });
  });

  it("yields tokens which are renewed at once when they are about to expire", async () => {
    const f = setup();
    await f.sessions.credential(HANDLE);
    f.clock.now += 56 * MINUTE;
    f.server.faults.push("lost");
    await f.sessions.credential(HANDLE);

    // Recovered ten seconds before the access token it carries expires.
    f.clock.now += HOUR - 10_000;
    const access = await f.worker().credential(HANDLE);
    expect(f.server.rotations).toHaveLength(4);
    f.clock.now += 30_000;
    expect(f.server.accepts(access)).toBe(true);
  });

  it("yields tokens whose refusal a moment later is settled by a renewal", async () => {
    const f = setup();
    await f.sessions.credential(HANDLE);
    f.clock.now += 56 * MINUTE;
    f.server.faults.push("lost");
    await f.sessions.credential(HANDLE);

    // Recovered six minutes before expiry, on a clock which is seven minutes slow.
    f.clock.now += 54 * MINUTE;
    const next = f.worker();
    const recovered = await next.credential(HANDLE);
    expect(f.server.rotations).toHaveLength(3);
    const renewed = await next.recover(HANDLE, recovered);
    expect(renewed).not.toBeNull();
    expect(renewed).not.toBe(recovered);
  });
});

describe("the delay before a rotation is sent again", () => {
  it("is respected by a later worker", async () => {
    const f = setup();
    await f.sessions.credential(HANDLE);
    f.clock.now += 56 * MINUTE;
    f.server.faults.push(new ApiError("rate_limited", 429, 600));
    const first = await f.sessions.credential(HANDLE);

    f.clock.now += 3 * MINUTE;
    const next = f.worker();
    next.resume();
    expect(await next.credential(HANDLE)).toBe(first);
    expect(f.server.rotations).toHaveLength(2);

    f.clock.now += 7 * MINUTE;
    expect(f.server.accepts(await next.credential(HANDLE))).toBe(true);
    expect(f.server.rotations[2]).toEqual(f.server.rotations[1]);
  });

  it("is neither extended nor shortened by a change of the system time", async () => {
    const clock = { wall: START, running: 0 };
    const server = new FakeRenewalServer(() => clock.wall);
    server.signIn(HANDLE);
    const sessions = new AccountSessions({
      api: server,
      storage: new MemorySessionStorage(),
      now: () => clock.wall,
      monotonic: () => clock.running,
    });
    server.faults.push(new NetworkError("timeout"));
    await sessions.credential(HANDLE);

    // The system time jumps forward by an hour: the two seconds have not passed.
    clock.wall += HOUR;
    expect(await sessions.credential(HANDLE)).toBe(HANDLE);
    expect(server.rotations).toHaveLength(1);
    // It jumps back by a day: the two seconds pass all the same.
    clock.wall -= DAY;
    clock.running += 2_000;
    await sessions.credential(HANDLE);
    expect(server.rotations).toHaveLength(2);
  });

  it("is never longer than an hour, even when a stored value says so", async () => {
    const f = setup();
    f.server.faults.push(new NetworkError("timeout"));
    await f.sessions.credential(HANDLE);
    const stored = f.stored();
    const entry = stored.sessions[0] as unknown as { retryAt: number };
    entry.retryAt = f.clock.now + 30 * DAY;
    const next = f.worker();
    expect(await next.credential(HANDLE)).toBe(HANDLE);
    f.clock.now += HOUR;
    expect(f.server.accepts(await next.credential(HANDLE))).toBe(true);
  });
});

describe("the account which storage holds", () => {
  const SECOND = "sign-in-token-of-another-account";
  const settled = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

  it("keeps its session stored and untouched", async () => {
    const f = setup();
    await f.sessions.credential(HANDLE);
    const next = f.worker();
    next.follow(HANDLE);
    await settled();
    expect(f.stored().sessions.map((entry) => entry.handle)).toEqual([HANDLE]);
    expect(f.server.calls.filter((call) => call.route === "logout")).toEqual([]);
  });

  it("is the only one whose session stays stored once the account is cleared", async () => {
    const f = setup();
    f.sessions.follow(HANDLE);
    const access = await f.sessions.credential(HANDLE);
    f.sessions.follow(null);
    await settled();
    expect(f.stored().sessions).toEqual([]);
    // The worker which clears the account still ends its session on the server.
    expect(f.server.calls.filter((call) => call.route === "logout")).toEqual([]);
    expect(await f.sessions.credential(HANDLE)).toBe(access);
    await f.sessions.logout(HANDLE);
    expect(f.server.sessionCount).toBe(0);
    expect(f.worker().expiryOf(HANDLE)).toBeNull();
  });

  it("replaces the session of the account it supersedes, and gives it back", async () => {
    const f = setup();
    f.server.signIn(SECOND);
    f.sessions.follow(HANDLE);
    await f.sessions.credential(HANDLE);
    f.sessions.follow(SECOND);
    await f.sessions.credential(SECOND);
    await settled();
    expect(f.stored().sessions.map((entry) => entry.handle)).toEqual([SECOND]);

    // The superseding sign-in is abandoned and the first account is restored.
    f.sessions.follow(HANDLE);
    await settled();
    expect(f.stored().sessions.map((entry) => entry.handle)).toEqual([HANDLE]);
  });

  it("is absent at worker start: a session left behind is ended and forgotten", async () => {
    const f = setup();
    await f.sessions.credential(HANDLE);
    const refresh = f.record()?.credentials?.refreshToken;
    // The browser quit between the local sign-out and the end of the session.
    const next = f.worker();
    next.follow(null);
    await vi.waitFor(() => expect(f.server.sessionCount).toBe(0));
    expect(f.server.calls.at(-1)).toEqual({ route: "logout", token: refresh });
    await vi.waitFor(() => expect(f.stored().sessions).toEqual([]));
  });

  it("is another one at worker start: only the session left behind is ended", async () => {
    const f = setup();
    f.server.signIn(SECOND);
    await f.sessions.credential(HANDLE);
    await f.sessions.credential(SECOND);
    const next = f.worker();
    next.follow(SECOND);
    await vi.waitFor(() => expect(f.server.sessionCount).toBe(1));
    await vi.waitFor(() =>
      expect(f.stored().sessions.map((entry) => entry.handle)).toEqual([SECOND]),
    );
    expect(f.server.accepts(await next.credential(SECOND))).toBe(true);
  });

  it("does nothing while the stored sessions cannot be read", async () => {
    const f = setup();
    await f.sessions.credential(HANDLE);
    f.storage.failRead = true;
    const next = f.worker();
    next.follow(null);
    await settled();
    expect(f.server.sessionCount).toBe(1);
    expect(f.stored().sessions).toHaveLength(1);
  });
});

describe("the sessions which storage keeps", () => {
  it("include every session which can still be renewed, beyond four", async () => {
    const f = setup();
    const handles = ["one", "two", "three", "four", "five"];
    for (const handle of handles) {
      f.server.signIn(handle);
      f.clock.now += 1;
      await f.sessions.credential(handle);
    }
    expect(
      f
        .stored()
        .sessions.map((entry) => entry.handle)
        .sort(),
    ).toEqual([...handles].sort());
  });

  it("leave out a classic session before one which can be renewed", async () => {
    const f = setup();
    await f.sessions.credential(HANDLE);
    f.server.supported = false;
    for (const handle of ["one", "two", "three", "four"]) {
      f.clock.now += 1;
      await f.sessions.credential(handle);
    }
    const stored = f.stored().sessions.map((entry) => entry.handle);
    expect(stored).toHaveLength(4);
    expect(stored).toContain(HANDLE);
    expect(stored).not.toContain("one");
  });
});

describe("sessions recovered late, or of an account which storage does not hold", () => {
  const SECOND = "sign-in-token-of-another-account";
  const settled = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

  it("renews at once tokens which a refused request recovers already expired", async () => {
    const f = setup();
    f.server.faults.push("lost");
    await f.sessions.credential(HANDLE);
    // Two hours later the repetition fails once more, and the sign-in token is tried.
    f.clock.now += 2 * HOUR;
    f.server.faults.push(new NetworkError("timeout"));
    expect(await f.sessions.credential(HANDLE)).toBe(HANDLE);
    // Its refusal arrives after the delay: the conversion is recovered, with an access
    // token which expired an hour ago and must not be the one sent again.
    f.clock.now += 5_000;
    const access = await f.sessions.recover(HANDLE, HANDLE);
    expect(f.server.accepts(access ?? "")).toBe(true);
    expect(f.server.rotations.at(-1)).toMatchObject({ route: "refresh" });
  });

  it("returns recovered tokens which are still good without renewing them", async () => {
    const f = setup();
    f.server.faults.push("lost");
    await f.sessions.credential(HANDLE);
    f.clock.now += 2_000;
    const access = await f.sessions.recover(HANDLE, HANDLE);
    expect(f.server.accepts(access ?? "")).toBe(true);
    expect(f.server.rotations.map((call) => call.route)).toEqual(["upgrade", "upgrade"]);
  });

  it("does not convert a session whose account storage does not hold", async () => {
    const f = setup();
    f.server.signIn(SECOND);
    f.sessions.follow(HANDLE);
    await f.sessions.credential(HANDLE);
    // A late request for an account which is leaving or was superseded.
    expect(await f.sessions.credential(SECOND)).toBe(SECOND);
    expect(f.server.rotations).toHaveLength(1);
    expect(f.server.accepts(SECOND)).toBe(true);
    await settled();
    expect(f.stored().sessions.map((entry) => entry.handle)).toEqual([HANDLE]);
  });

  it("converts the session of the account as soon as storage holds it", async () => {
    const f = setup();
    f.server.signIn(SECOND);
    f.sessions.follow(HANDLE);
    await f.sessions.credential(HANDLE);
    // The sign-in of another account is written, and its first request follows at once.
    f.sessions.follow(SECOND);
    expect(f.server.accepts(await f.sessions.credential(SECOND))).toBe(true);
    expect(await f.sessions.credential(SECOND)).not.toBe(SECOND);
    await settled();
    expect(f.stored().sessions.map((entry) => entry.handle)).toEqual([SECOND]);
  });

  it("stores again, at the next change of account, a session which storage refused", async () => {
    const f = setup();
    f.sessions.follow(HANDLE);
    await f.sessions.credential(HANDLE);
    f.sessions.follow(SECOND);
    await settled();
    expect(f.stored().sessions).toEqual([]);

    // The first account is restored while storage refuses the write.
    f.storage.failWrite = true;
    f.sessions.follow(HANDLE);
    await settled();
    expect(f.stored().sessions).toEqual([]);
    f.storage.failWrite = false;
    f.sessions.follow(HANDLE);
    await settled();
    expect(f.stored().sessions.map((entry) => entry.handle)).toEqual([HANDLE]);
  });
});
