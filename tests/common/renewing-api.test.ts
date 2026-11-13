// SPDX-License-Identifier: MPL-2.0

import {
  ApiClient,
  ApiError,
  NetworkError,
  isDefinitiveProxyCreationRejection,
} from "../../src/core/api/client";
import type { DeviceProof } from "../../src/core/api/types";
import { AccountSessions, RenewingApi } from "../../src/core/background/account-sessions";
import { FakeApi } from "./helpers";
import {
  accountRoutes,
  FakeRenewalServer,
  HOUR,
  MemorySessionStorage,
  MINUTE,
  START,
} from "./session-renewal-fixture";

const HANDLE = "sign-in-token-of-the-account";
const PROOF: DeviceProof = {
  deviceId: "browser-device-1",
  deviceTimestamp: START,
  deviceNonce: "nonce",
  deviceSignature: "signature",
};

function setup() {
  const clock = { now: START };
  const server = new FakeRenewalServer(() => clock.now);
  server.signIn(HANDLE);
  const storage = new MemorySessionStorage();
  const sessions = new AccountSessions({
    api: server,
    storage,
    now: () => clock.now,
    monotonic: () => clock.now,
  });
  const fake = new FakeApi();
  const presented: string[] = [];
  const api = new RenewingApi(accountRoutes(fake, server, presented), sessions);
  return { clock, server, storage, sessions, fake, presented, api };
}

describe("the API with a renewable account session", () => {
  it("presents the access token of the session on every account route", async () => {
    const f = setup();
    await f.api.getProfile(HANDLE);
    await f.api.getSubscription(HANDLE);
    await f.api.getDevices(HANDLE);
    await f.api.enrollBrowserDevice(HANDLE, "Chrome", "public-key");
    await f.api.createProxySession(HANDLE, "frankfurt-01", PROOF);
    await f.api.revokeProxySession(HANDLE, "proxy-session-1");
    await f.api.deleteDevice(HANDLE, "browser-device-1");
    await f.api.resendVerification(HANDLE);

    expect(f.presented).toHaveLength(8);
    expect(new Set(f.presented).size).toBe(1);
    expect(f.presented).not.toContain(HANDLE);
    expect(f.server.rotations).toHaveLength(1);
    // The requests themselves are unchanged.
    expect(f.fake.enrollments).toMatchObject([{ name: "Chrome", publicKey: "public-key" }]);
    expect(f.fake.proofs).toEqual([PROOF]);
    expect(f.fake.revoked).toEqual(["proxy-session-1"]);
    expect(f.fake.deletedDevices).toEqual(["browser-device-1"]);
  });

  it("leaves the routes without account token alone", async () => {
    const f = setup();
    await f.api.getLocations();
    await f.api.login("client@example.com", "secret");
    await f.api.exchangeExtensionCode({
      clientId: "client",
      code: "code",
      redirectUri: "https://extension.invalid/",
      codeVerifier: "verifier",
    });
    expect(f.server.rotations).toHaveLength(0);
    expect(f.fake.exchangedCodes).toHaveLength(1);
  });

  it("renews the access token before a request once it is about to expire", async () => {
    const f = setup();
    await f.api.getProfile(HANDLE);
    f.clock.now += 56 * MINUTE;
    await f.api.getProfile(HANDLE);
    expect(f.presented[1]).not.toBe(f.presented[0]);
    expect(f.server.rotations.map((call) => call.route)).toEqual(["upgrade", "refresh"]);
  });

  it("sends a request once more when its token was replaced meanwhile", async () => {
    const f = setup();
    await f.api.getProfile(HANDLE);
    const stale = f.presented[0] ?? "";
    // The token is replaced while a request holding the previous one is on its way.
    const original = f.sessions.credential.bind(f.sessions);
    f.sessions.credential = async (handle) => {
      f.sessions.credential = original;
      f.clock.now += HOUR;
      await original(handle);
      return stale;
    };
    await expect(f.api.getSubscription(HANDLE)).resolves.toEqual(f.fake.subscription);
    expect(f.presented.slice(1)).toEqual([stale, f.presented[2]]);
    expect(f.server.accepts(f.presented[2] ?? "")).toBe(true);
  });

  it("renews once a token which only the server considers expired", async () => {
    const f = setup();
    await f.api.getProfile(HANDLE);
    f.clock.now += 10 * MINUTE;
    const guarded = f.fake.getDevices.bind(f.fake);
    let refusals = 1;
    f.fake.getDevices = async () => {
      if (refusals-- > 0) throw new ApiError("unauthorized", 401);
      return guarded();
    };
    await expect(f.api.getDevices(HANDLE)).resolves.toMatchObject({ limit: 2 });
    expect(f.server.rotations.map((call) => call.route)).toEqual(["upgrade", "refresh"]);
  });

  it("reports the refusal when the renewed token is refused as well", async () => {
    const f = setup();
    await f.api.getProfile(HANDLE);
    f.clock.now += 10 * MINUTE;
    let calls = 0;
    f.fake.getDevices = async () => {
      calls += 1;
      throw new ApiError("unauthorized", 401);
    };
    await expect(f.api.getDevices(HANDLE)).rejects.toMatchObject({ status: 401 });
    // One renewal and one repetition, as the session contract allows.
    expect(f.server.rotations).toHaveLength(2);
    expect(calls).toBe(2);
  });

  it("fails like the network while a refusal cannot be explained yet", async () => {
    const f = setup();
    // The conversion is applied and its answer is lost: the sign-in token is refused.
    f.server.faults.push("lost");
    await expect(f.api.getProfile(HANDLE)).rejects.toEqual(new NetworkError("network"));
    const failure = await f.api
      .createProxySession(HANDLE, "frankfurt-01", PROOF)
      .catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: "proxy_unavailable", status: 409 });
    expect(isDefinitiveProxyCreationRejection(failure)).toBe(true);
    expect(f.fake.proofs).toEqual([]);

    f.clock.now += 2_000;
    await expect(f.api.getProfile(HANDLE)).resolves.toEqual(f.fake.profile);
    expect(f.server.sessionCount).toBe(1);
  });

  it("reports the refusal of a session the server ended", async () => {
    const f = setup();
    await f.api.getProfile(HANDLE);
    f.server.revokeAll();
    await expect(f.api.getProfile(HANDLE)).rejects.toMatchObject({ status: 401 });
    f.clock.now += HOUR;
    await expect(f.api.getProfile(HANDLE)).rejects.toMatchObject({
      code: "unauthorized",
      status: 401,
    });
  });

  it("does not repeat a request refused for another reason", async () => {
    const f = setup();
    f.fake.enrollError = new ApiError("device_limit", 409);
    await expect(f.api.enrollBrowserDevice(HANDLE, "Chrome", "key")).rejects.toMatchObject({
      code: "device_limit",
    });
    expect(f.fake.enrollCalls).toBe(1);
  });

  it("fails like the network, not like a refusal, while the session cannot be renewed", async () => {
    const f = setup();
    await f.api.getProfile(HANDLE);
    f.clock.now += 2 * HOUR;
    f.server.faults.push(new NetworkError("timeout"));
    await expect(f.api.getProfile(HANDLE)).rejects.toEqual(new NetworkError("network"));
    expect(f.presented).toHaveLength(1);

    f.clock.now += 2_000;
    await expect(f.api.getProfile(HANDLE)).resolves.toEqual(f.fake.profile);
  });

  it("refuses a proxy creation it could not authorize, leaving nothing in doubt", async () => {
    const f = setup();
    await f.api.getProfile(HANDLE);
    f.clock.now += 2 * HOUR;
    f.server.faults.push(new ApiError("rate_limited", 429, 45));
    const failure = await f.api
      .createProxySession(HANDLE, "frankfurt-01", PROOF)
      .catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: "proxy_unavailable", retryAfterSeconds: 45 });
    expect(isDefinitiveProxyCreationRejection(failure)).toBe(true);
    // Nothing was sent to the creation route.
    expect(f.fake.proofs).toEqual([]);
  });

  it("repeats a proxy creation refused with a 401, which created nothing", async () => {
    const f = setup();
    await f.api.getProfile(HANDLE);
    f.clock.now += 10 * MINUTE;
    const create = f.fake.createProxySession.bind(f.fake);
    let refusals = 1;
    f.fake.createProxySession = async (...args) => {
      if (refusals-- > 0) throw new ApiError("unauthorized", 401);
      return create(...args);
    };
    await expect(f.api.createProxySession(HANDLE, "frankfurt-01", PROOF)).resolves.toMatchObject({
      locationId: "frankfurt-01",
    });
    expect(f.fake.proofs).toEqual([PROOF]);
  });

  it("makes the session usable before a request which must not be left in doubt", async () => {
    const f = setup();
    await f.api.prepareSession(HANDLE);
    expect(f.server.rotations).toHaveLength(1);
    expect(f.presented).toEqual([]);

    f.clock.now += 2 * HOUR;
    f.server.faults.push(new NetworkError("network"));
    await expect(f.api.prepareSession(HANDLE)).rejects.toEqual(new NetworkError("network"));
    f.server.revokeAll();
    f.clock.now += 2_000;
    await expect(f.api.prepareSession(HANDLE)).rejects.toMatchObject({ status: 401 });
  });

  it("gives up a request cancelled while its session was renewed", async () => {
    const f = setup();
    const abort = new AbortController();
    const upgrade = f.server.upgradeSession.bind(f.server);
    f.server.upgradeSession = (token, requestId) => {
      abort.abort();
      return upgrade(token, requestId);
    };
    await expect(f.api.getProfile(HANDLE, abort.signal)).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(f.presented).toEqual([]);
    // The rotation itself went through and is kept.
    expect(f.server.accepts(await f.sessions.credential(HANDLE))).toBe(true);
  });

  it("logs out with the refresh token of the session", async () => {
    const f = setup();
    await f.api.getProfile(HANDLE);
    await f.api.logout(HANDLE);
    expect(f.server.calls.at(-1)).toMatchObject({ route: "logout" });
    expect(f.server.calls.at(-1)?.token).toMatch(/^fr1\./);
    expect(f.server.sessionCount).toBe(0);
  });

  it("passes on a token it never converted, without converting it", async () => {
    const f = setup();
    await f.api.logout("token-of-an-abandoned-sign-in");
    expect(f.server.calls).toEqual([{ route: "logout", token: "token-of-an-abandoned-sign-in" }]);
  });
});

describe("the session routes of the API client", () => {
  const PAIR = {
    access_token: "access-token",
    expires_at: "2026-11-12T11:00:00Z",
    refresh_token: "fr1.00000000-0000-4000-8000-000000000001.1",
    refresh_expires_at: "2027-11-12T10:00:00Z",
  };
  const REQUEST = "A".repeat(43);

  function client(response: Response) {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response);
    return { fetcher, api: new ApiClient(fetcher, "https://api.example.test", 1_000) };
  }

  it.each([
    ["upgradeSession", "/v1/auth/session/upgrade"],
    ["refreshSession", "/v1/auth/session/refresh"],
  ] as const)("%s sends the token as bearer and the identifier as body", async (method, path) => {
    const f = client(new Response(JSON.stringify(PAIR), { status: 200 }));
    await expect(f.api[method]("presented-token", REQUEST)).resolves.toEqual({
      accessToken: "access-token",
      expiresAt: "2026-11-12T11:00:00Z",
      refreshToken: "fr1.00000000-0000-4000-8000-000000000001.1",
      refreshExpiresAt: "2027-11-12T10:00:00Z",
    });
    const [url, init] = f.fetcher.mock.calls[0] ?? [];
    expect(url).toBe(`https://api.example.test${path}`);
    expect(init).toMatchObject({
      method: "POST",
      body: JSON.stringify({ request_id: REQUEST }),
      credentials: "omit",
      cache: "no-store",
      redirect: "error",
    });
    const headers = new Headers(init?.headers);
    expect(headers.get("Authorization")).toBe("Bearer presented-token");
    expect(headers.get("Content-Type")).toBe("application/json");
    // The token is never part of the address.
    expect(JSON.stringify(url)).not.toContain("presented-token");
  });

  it.each([
    ["no refresh token", { ...PAIR, refresh_token: undefined }],
    ["an empty access token", { ...PAIR, access_token: "" }],
    ["a token which does not fit a header", { ...PAIR, access_token: "two words" }],
    ["a token with a line break", { ...PAIR, refresh_token: "fr1.session\n.1" }],
    ["an unreadable access expiry", { ...PAIR, expires_at: "in an hour" }],
    ["an unreadable refresh expiry", { ...PAIR, refresh_expires_at: 365 }],
    ["a list", [PAIR]],
  ])("rejects an answer with %s", async (_label, body) => {
    const f = client(new Response(JSON.stringify(body), { status: 200 }));
    await expect(f.api.refreshSession("token", REQUEST)).rejects.toEqual(
      new NetworkError("invalid_response"),
    );
  });

  it.each([
    [401, "unauthorized"],
    [404, "not_found"],
    [409, "session_upgrade_conflict"],
    [409, "session_transition"],
    [400, "invalid_session_request_id"],
    [503, "session_renewal_unavailable"],
  ])("reports HTTP %i %s with its code", async (status, error) => {
    const f = client(new Response(JSON.stringify({ error }), { status }));
    await expect(f.api.upgradeSession("token", REQUEST)).rejects.toMatchObject({
      status,
      code: error,
    });
  });

  it("reports the delay a rate limit asks for", async () => {
    const f = client(
      new Response(JSON.stringify({ error: "rate_limited" }), {
        status: 429,
        headers: { "Retry-After": "37" },
      }),
    );
    await expect(f.api.refreshSession("token", REQUEST)).rejects.toMatchObject({
      status: 429,
      retryAfterSeconds: 37,
    });
  });

  it("logs out with the given token, without body", async () => {
    const f = client(new Response(null, { status: 204 }));
    await f.api.logout("fr1.00000000-0000-4000-8000-000000000001.3");
    const [url, init] = f.fetcher.mock.calls[0] ?? [];
    expect(url).toBe("https://api.example.test/v1/auth/logout");
    expect(init?.body).toBeUndefined();
    const headers = new Headers(init?.headers);
    expect(headers.get("Authorization")).toBe("Bearer fr1.00000000-0000-4000-8000-000000000001.3");
    const names: string[] = [];
    headers.forEach((_value, name) => names.push(name));
    expect(names.sort()).toEqual(["accept", "authorization"]);
  });
});
