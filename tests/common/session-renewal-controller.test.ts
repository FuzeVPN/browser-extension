// SPDX-License-Identifier: MPL-2.0

import { NetworkError } from "../../src/core/api/client";
import { AccountSessions, RenewingApi } from "../../src/core/background/account-sessions";
import { AppController } from "../../src/core/background/state-machine";
import type { AppSnapshot } from "../../src/core/shared/state";
import type { StorageService } from "../../src/core/storage/storage";
import {
  AUTH,
  FakeAlarms,
  FakeApi,
  FakeIdentity,
  FakeProxy,
  FakeSafety,
  FakeSecurityStorage,
  FakeStorage,
  NOW,
  PROFILE,
  authenticatedState,
  proxySession,
} from "./helpers";
import {
  accountRoutes,
  DAY,
  FakeRenewalServer,
  HOUR,
  MemorySessionStorage,
} from "./session-renewal-fixture";

/** A signed-in account whose classic session the server can convert. */
function setup() {
  const clock = { now: NOW };
  const server = new FakeRenewalServer(() => clock.now);
  server.signIn(AUTH.accessToken, Date.parse(AUTH.expiresAt) - NOW);
  const sessionStorage = new MemorySessionStorage();
  const account = new FakeStorage();
  account.persisted = structuredClone(authenticatedState());
  const fake = new FakeApi();
  const presented: string[] = [];
  const proxy = new FakeProxy();
  const securityStorage = new FakeSecurityStorage();
  const identity = new FakeIdentity();
  const alarms = new FakeAlarms();
  const safety = new FakeSafety();
  const snapshots: AppSnapshot[] = [];
  /** A service worker: its own memory, the storage of the browser profile. */
  const worker = (renewable = true) => {
    const sessions = new AccountSessions({
      api: server,
      storage: sessionStorage,
      now: () => clock.now,
      monotonic: () => clock.now,
    });
    const storage: StorageService = {
      configureTrustedContexts: () => account.configureTrustedContexts(),
      // As the worker wires it: the sessions are read first, then told of the account.
      readPersisted: async () => {
        await sessions.initialize();
        const state = await account.readPersisted();
        sessions.follow(state.auth?.accessToken ?? null);
        return state;
      },
      writePersisted: async (state) => {
        await account.writePersisted(state);
        sessions.follow(state.auth?.accessToken ?? null);
      },
      clearPersisted: async () => {
        await account.clearPersisted();
        sessions.follow(null);
      },
      readTransient: () => account.readTransient(),
      writeTransient: (state) => account.writeTransient(state),
      clearTransient: () => account.clearTransient(),
    };
    const controller = new AppController({
      api: new RenewingApi(accountRoutes(fake, server, presented), sessions),
      storage,
      identity,
      proxy,
      alarms,
      safety,
      securityStorage,
      now: () => clock.now,
      remoteCleanupTimeoutMs: 250,
      onStateChanged: (snapshot) => snapshots.push(snapshot),
      ...(renewable ? { accountSessionExpiry: (auth) => sessions.expiryOf(auth.accessToken) } : {}),
    });
    return { controller, sessions };
  };
  /** The proxy session the API issues next, valid at the current time. */
  const issue = (id: string) => {
    fake.sessions = [
      proxySession(
        id,
        "frankfurt-01",
        new Date(clock.now).toISOString(),
        new Date(clock.now + 10 * 60_000).toISOString(),
      ),
    ];
  };
  return {
    clock,
    server,
    sessionStorage,
    account,
    fake,
    presented,
    securityStorage,
    worker,
    issue,
  };
}

describe("an account whose session is renewable", () => {
  it("is converted by its first account request and keeps its sign-in token as identity", async () => {
    const f = setup();
    const w = f.worker();
    await expect(w.controller.connect("frankfurt-01")).resolves.toEqual({ ok: true });
    expect(w.controller.getSnapshot().status).toBe("connected");

    expect(f.server.rotations).toMatchObject([{ route: "upgrade", token: AUTH.accessToken }]);
    expect(f.presented.length).toBeGreaterThan(0);
    expect(f.presented).not.toContain(AUTH.accessToken);
    expect(new Set(f.presented).size).toBe(1);
    expect(f.account.persisted.auth).toEqual(AUTH);
  });

  it("stays signed in after its sign-in expiry, in a later worker", async () => {
    const f = setup();
    const first = f.worker();
    await first.controller.connect("frankfurt-01");
    await first.controller.disconnect();

    f.clock.now = Date.parse(AUTH.expiresAt) + 10 * DAY;
    const next = f.worker();
    await next.controller.initialize();
    expect(next.controller.getSnapshot()).toMatchObject({
      status: "disconnected",
      profile: { userId: PROFILE.userId },
    });
    f.issue("proxy-after-expiry");
    await expect(next.controller.connect("frankfurt-01")).resolves.toEqual({ ok: true });
    expect(f.server.accepts(f.presented.at(-1) ?? "")).toBe(true);
  });

  it("would be signed out at its sign-in expiry without the renewable expiry", async () => {
    const f = setup();
    const first = f.worker();
    await first.controller.connect("frankfurt-01");
    await first.controller.disconnect();

    f.clock.now = Date.parse(AUTH.expiresAt) + 10 * DAY;
    const next = f.worker(false);
    await next.controller.initialize();
    expect(next.controller.getSnapshot()).toMatchObject({ status: "logged_out", profile: null });
  });

  it("is signed out at the end of its right to renew", async () => {
    const f = setup();
    const first = f.worker();
    await first.controller.connect("frankfurt-01");
    await first.controller.disconnect();

    // A year without any use: nothing renewed the session meanwhile.
    f.clock.now += 365 * DAY + 1;
    const next = f.worker();
    await next.controller.initialize();
    expect(next.controller.getSnapshot()).toMatchObject({ status: "logged_out", profile: null });
    expect(f.account.persisted.auth).toBeNull();
    // The server would have refused the renewal as well.
    expect(f.server.sessionCount).toBe(1);
    await expect(
      f.server.refreshSession("fr1.00000000-0000-4000-8000-000000000001.1", "A".repeat(43)),
    ).rejects.toMatchObject({ status: 401 });
  });

  it("is signed out once the server refuses its session", async () => {
    const f = setup();
    const first = f.worker();
    await first.controller.connect("frankfurt-01");
    await first.controller.disconnect();

    f.server.revokeAll();
    f.clock.now += 2 * HOUR;
    const next = f.worker();
    f.issue("proxy-after-refusal");
    // The refusal ends the account, which supersedes the connection it interrupted.
    await expect(next.controller.connect("frankfurt-01")).resolves.toMatchObject({ ok: false });
    await vi.waitFor(() => expect(next.controller.getSnapshot().profile).toBeNull());
    // The protection which was asked for stays guarded, as for any account which ends.
    expect(next.controller.getSnapshot()).toMatchObject({
      status: "blocked",
      error: "unauthorized",
    });
    expect(f.account.persisted.auth).toBeNull();
  });

  it("stays signed in while its session cannot be renewed, with no creation in doubt", async () => {
    const f = setup();
    const w = f.worker();
    await w.controller.connect("frankfurt-01");
    await w.controller.disconnect();
    const proofs = f.fake.proofs.length;

    f.clock.now += 2 * HOUR;
    f.server.faults.push(new NetworkError("network"));
    f.issue("proxy-after-failure");
    await expect(w.controller.connect("frankfurt-01")).resolves.toMatchObject({
      ok: false,
      commandError: "network_error",
    });
    expect(w.controller.getSnapshot().profile).toMatchObject({ userId: PROFILE.userId });
    expect(f.account.persisted.auth).toEqual(AUTH);
    expect(f.fake.proofs).toHaveLength(proofs);
    expect(f.securityStorage.state).toMatchObject({ proxyCreationUncertain: false });

    f.clock.now += 2_000;
    f.issue("proxy-after-recovery");
    await expect(w.controller.connect("frankfurt-01")).resolves.toEqual({ ok: true });
  });

  it("is the same account for diagnostics before and after a renewal", async () => {
    const f = setup();
    const w = f.worker();
    await w.controller.initialize();
    // Neither the conversion nor a renewal may look like a change of account.
    const before = w.controller.getDiagnosticAccount();
    expect(before).toMatchObject({ token: AUTH.accessToken });
    expect(before?.expiresAt).toBeGreaterThan(NOW + 365 * DAY);
    await w.controller.connect("frankfurt-01");
    await w.controller.disconnect();
    expect(f.server.rotations).toHaveLength(1);
    expect(w.controller.getDiagnosticAccount()).toEqual(before);

    // A renewal moves the right to renew, which must not look like another account.
    f.clock.now += HOUR;
    f.issue("proxy-after-renewal");
    await w.controller.connect("frankfurt-01");
    expect(f.server.rotations).toHaveLength(2);
    expect(w.controller.getDiagnosticAccount()).toEqual(before);
  });

  it("is logged out with its refresh token, and nothing of it stays stored", async () => {
    const f = setup();
    const w = f.worker();
    await w.controller.connect("frankfurt-01");
    await expect(w.controller.logout()).resolves.toEqual({ ok: true });

    const logout = f.server.calls.find((call) => call.route === "logout");
    expect(logout?.token).toMatch(/^fr1\./);
    expect(f.server.sessionCount).toBe(0);
    expect(f.sessionStorage.value).toMatchObject({ sessions: [] });
    expect(f.account.persisted.auth).toBeNull();
    expect(w.controller.getSnapshot()).toMatchObject({
      status: "logged_out",
      logoutOutcome: { apiSession: "confirmed" },
    });
  });
});

describe("the tokens of an account which leaves", () => {
  it("leave storage with the account, before the server confirms the logout", async () => {
    const f = setup();
    const w = f.worker();
    await w.controller.connect("frankfurt-01");
    await w.controller.disconnect();
    // The server holds its answer back for longer than the logout waits.
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const logout = f.server.logout.bind(f.server);
    f.server.logout = async (token) => {
      await held;
      return logout(token);
    };
    await expect(w.controller.logout()).resolves.toEqual({ ok: true });
    expect(w.controller.getSnapshot()).toMatchObject({
      profile: null,
      logoutOutcome: { apiSession: "unconfirmed" },
    });
    expect(f.account.persisted.auth).toBeNull();
    await vi.waitFor(() => expect(f.sessionStorage.value).toMatchObject({ sessions: [] }));
    expect(f.server.sessionCount).toBe(1);

    // The same worker still ends the session once the server answers.
    release();
    await vi.waitFor(() => expect(f.server.sessionCount).toBe(0));
    expect(f.sessionStorage.value).toMatchObject({ sessions: [] });
  });

  it("leave storage when the server ends the account", async () => {
    const f = setup();
    const first = f.worker();
    await first.controller.connect("frankfurt-01");
    await first.controller.disconnect();
    f.server.revokeAll();
    f.clock.now += 2 * HOUR;
    const next = f.worker();
    f.issue("proxy-after-refusal");
    await next.controller.connect("frankfurt-01");
    await vi.waitFor(() => expect(next.controller.getSnapshot().profile).toBeNull());
    await vi.waitFor(() => expect(f.sessionStorage.value).toMatchObject({ sessions: [] }));
  });

  it("are ended and removed by the next worker when the browser quit in between", async () => {
    const f = setup();
    const first = f.worker();
    await first.controller.connect("frankfurt-01");
    await first.controller.disconnect();
    const left = structuredClone(f.sessionStorage.value);
    // The account is gone from storage, but the record of its session was not removed.
    f.account.persisted = { ...f.account.persisted, auth: null, profile: null };
    f.sessionStorage.value = left;

    const next = f.worker();
    await next.controller.initialize();
    expect(next.controller.getSnapshot().status).toBe("logged_out");
    await vi.waitFor(() => expect(f.server.sessionCount).toBe(0));
    await vi.waitFor(() => expect(f.sessionStorage.value).toMatchObject({ sessions: [] }));
    expect(f.server.calls.at(-1)?.token).toMatch(/^fr1\./);
  });

  it("stay stored for the account which a worker restores", async () => {
    const f = setup();
    const first = f.worker();
    await first.controller.connect("frankfurt-01");
    await first.controller.disconnect();
    const next = f.worker();
    await next.controller.initialize();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(f.sessionStorage.value).toMatchObject({ sessions: [{ handle: AUTH.accessToken }] });
    expect(f.server.calls.filter((call) => call.route === "logout")).toEqual([]);
  });
});

describe("an account on a server without renewable sessions", () => {
  it("works with its classic session, exactly as before", async () => {
    const f = setup();
    f.server.supported = false;
    const w = f.worker();
    await expect(w.controller.connect("frankfurt-01")).resolves.toEqual({ ok: true });
    expect(new Set(f.presented)).toEqual(new Set([AUTH.accessToken]));
    expect(f.server.rotations).toHaveLength(1);

    await expect(w.controller.logout()).resolves.toEqual({ ok: true });
    expect(f.server.calls.at(-1)).toEqual({ route: "logout", token: AUTH.accessToken });
    expect(f.server.sessionCount).toBe(0);
  });

  it("still expires at its sign-in expiry", async () => {
    const f = setup();
    f.server.supported = false;
    const first = f.worker();
    await first.controller.connect("frankfurt-01");
    await first.controller.disconnect();
    f.clock.now = Date.parse(AUTH.expiresAt) + 1;
    const next = f.worker();
    await next.controller.initialize();
    expect(next.controller.getSnapshot()).toMatchObject({ status: "logged_out", profile: null });
  });
});
