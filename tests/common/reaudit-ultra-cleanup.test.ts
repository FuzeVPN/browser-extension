// SPDX-License-Identifier: MPL-2.0

import { ApiError, NetworkError } from "../../src/core/api/client";
import { ProxyCleanupLedger } from "../../src/core/background/proxy-cleanup-ledger";
import { ALARM_REFRESH, REFRESH_RETRY_MS } from "../../src/core/shared/config";
import type {
  PendingProxyRevocation,
  ProxyCleanupStorage,
} from "../../src/core/storage/proxy-cleanup-storage";
import { EMPTY_PERSISTED_STATE } from "../../src/core/storage/storage";
import { AUTH, NOW, PROFILE, authenticatedState, createHarness, proxySession } from "./helpers";

const LONG = new Date(NOW + 600_000).toISOString();
const LATER = new Date(NOW + 900_000).toISOString();
const SESSION_EXPIRY = proxySession().expiresAt;

function pending(sessionId: string, expiresAt = SESSION_EXPIRY): PendingProxyRevocation {
  return { userId: PROFILE.userId, sessionId, expiresAt };
}

class MemoryCleanup implements ProxyCleanupStorage {
  sessions: PendingProxyRevocation[];

  constructor(initial: PendingProxyRevocation[] = []) {
    this.sessions = structuredClone(initial);
  }

  async read(): Promise<PendingProxyRevocation[]> {
    return structuredClone(this.sessions);
  }

  async write(sessions: PendingProxyRevocation[]): Promise<void> {
    this.sessions = structuredClone(sessions);
  }
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

afterEach(() => vi.restoreAllMocks());

describe("ULTRA-08 known creation whose ledger write fails", () => {
  it("closes the creation once its only ledger write fails and its revocation succeeds", async () => {
    const ledger = new MemoryCleanup();
    const h = createHarness({ persisted: authenticatedState(), cleanupStorage: ledger });
    await h.controller.initialize();
    vi.spyOn(ledger, "write").mockRejectedValueOnce(new Error("ledger_write_failed"));

    expect(await h.controller.connect("frankfurt-01")).toEqual({
      ok: false,
      commandError: "storage_unavailable",
    });
    expect(h.api.revoked).toEqual(["proxy-session-1"]);
    expect(ledger.sessions).toEqual([]);
    expect(h.securityStorage.state).toMatchObject({
      proxyCreationUncertain: false,
      proxyCleanupUncertain: false,
    });
    expect(await h.controller.disconnect()).toEqual({ ok: true });
    expect(await h.controller.logout()).toEqual({ ok: true });
    expect(h.controller.getSnapshot().logoutOutcome?.proxySessions).toBe("confirmed");
    expect(h.securityStorage.state?.proxyCleanupUncertain).toBe(false);

    const restarted = createHarness({
      persisted: h.storage.persisted,
      transient: h.storage.transient,
      security: h.securityStorage.state!,
      cleanupStorage: ledger,
    });
    await restarted.controller.initialize();
    expect(await restarted.controller.logout()).toEqual({ ok: true });
    expect(restarted.controller.getSnapshot().logoutOutcome?.proxySessions).toBe("confirmed");
  });

  it("revokes the unrecorded ID when the wall clock jumps past its expiry", async () => {
    const ledger = new MemoryCleanup();
    const h = createHarness({ persisted: authenticatedState(), cleanupStorage: ledger });
    await h.controller.initialize();
    vi.spyOn(ledger, "write").mockImplementationOnce(async () => {
      h.setNow(Date.parse(SESSION_EXPIRY) + 1);
      throw new Error("ledger_write_failed");
    });

    expect(await h.controller.connect("frankfurt-01")).toEqual({
      ok: false,
      commandError: "storage_unavailable",
    });
    // Without a record, the jump still proves no expiry of the fresh session.
    expect(h.api.revoked).toEqual(["proxy-session-1"]);
    expect(ledger.sessions).toEqual([]);
    expect(h.securityStorage.state?.proxyCleanupUncertain).toBe(false);
  });

  it("keeps the known ID as ledger debt when its revocation fails and a retried write succeeds", async () => {
    const ledger = new MemoryCleanup();
    const h = createHarness({ persisted: authenticatedState(), cleanupStorage: ledger });
    await h.controller.initialize();
    vi.spyOn(ledger, "write").mockRejectedValueOnce(new Error("ledger_write_failed"));
    const revoke = vi
      .spyOn(h.api, "revokeProxySession")
      .mockRejectedValueOnce(new NetworkError("network"));

    expect(await h.controller.connect("frankfurt-01")).toEqual({
      ok: false,
      commandError: "storage_unavailable",
    });
    expect(revoke).toHaveBeenCalledOnce();
    expect(ledger.sessions).toEqual([pending("proxy-session-1")]);
    expect(h.securityStorage.state?.proxyCleanupUncertain).toBe(false);
    expect(await h.controller.logout()).toEqual({ ok: true });
    expect(revoke).toHaveBeenLastCalledWith(AUTH.accessToken, "proxy-session-1");
    expect(ledger.sessions).toEqual([]);
    expect(h.controller.getSnapshot().logoutOutcome?.proxySessions).toBe("confirmed");
    expect(h.securityStorage.state?.proxyCleanupUncertain).toBe(false);
  });

  it("keeps the live session when a renewal's only ledger write fails and its revocation succeeds", async () => {
    const ledger = new MemoryCleanup();
    const h = createHarness({ persisted: authenticatedState(), cleanupStorage: ledger });
    await h.controller.initialize();
    expect(await h.controller.connect("frankfurt-01")).toEqual({ ok: true });
    const previous = h.proxy.active!;
    vi.spyOn(ledger, "write").mockRejectedValueOnce(new Error("ledger_write_failed"));
    h.api.sessions = [proxySession("renewal-2")];

    await h.controller.handleAlarm(ALARM_REFRESH);
    // The settled replacement leaves no unknown: the valid predecessor stays
    // protected and its renewal is retried instead of suspended or cut.
    expect(h.api.revoked).toEqual(["renewal-2"]);
    expect(ledger.sessions).toEqual([pending(previous.id, previous.expiresAt)]);
    expect(h.proxy.active).toEqual(previous);
    expect(h.controller.getSnapshot()).toMatchObject({
      status: "refreshing",
      protected: true,
      error: "storage_unavailable",
    });
    expect(h.securityStorage.state).toMatchObject({
      proxyCreationUncertain: false,
      proxyCleanupUncertain: false,
    });
    expect(h.alarms.retryAt).toBe(NOW + REFRESH_RETRY_MS);

    h.api.sessions = [proxySession("renewal-3")];
    h.setNow(NOW + REFRESH_RETRY_MS);
    await h.controller.handleAlarm(ALARM_REFRESH);
    expect(h.proxy.active?.id).toBe("renewal-3");
    expect(h.controller.getSnapshot()).toMatchObject({
      status: "connected",
      protected: true,
      error: null,
    });
  });

  it("keeps an ID that is neither recorded nor revoked as durable unknown cleanup", async () => {
    const ledger = new MemoryCleanup();
    const h = createHarness({ persisted: authenticatedState(), cleanupStorage: ledger });
    await h.controller.initialize();
    vi.spyOn(ledger, "write")
      .mockRejectedValueOnce(new Error("ledger_write_failed"))
      .mockRejectedValueOnce(new Error("ledger_retry_failed"));
    vi.spyOn(h.api, "revokeProxySession").mockRejectedValueOnce(new NetworkError("network"));

    expect(await h.controller.connect("frankfurt-01")).toEqual({
      ok: false,
      commandError: "proxy_creation_uncertain",
    });
    expect(ledger.sessions).toEqual([]);
    expect(h.securityStorage.state?.proxyCleanupUncertain).toBe(true);

    const restarted = createHarness({
      persisted: h.storage.persisted,
      transient: h.storage.transient,
      security: h.securityStorage.state!,
      cleanupStorage: ledger,
    });
    await restarted.controller.initialize();
    expect(await restarted.controller.logout()).toEqual({ ok: true });
    expect(restarted.controller.getSnapshot().logoutOutcome?.proxySessions).toBe("unconfirmed");
    expect(restarted.securityStorage.state?.proxyCleanupUncertain).toBe(true);
  });
});

describe("COND-ULTRA-01 creation still pending when logout times out", () => {
  it("resolves the marker once the late ID is recorded and revoked", async () => {
    const ledger = new MemoryCleanup();
    const h = createHarness({
      persisted: authenticatedState(),
      cleanupStorage: ledger,
      remoteCleanupTimeoutMs: 5,
    });
    await h.controller.initialize();
    const response = deferred();
    h.api.createWait = response.promise;
    h.api.sessions = [proxySession("late-known-created")];
    const connecting = h.controller.connect("frankfurt-01");
    await vi.waitFor(() => expect(h.api.proofs).toHaveLength(1));

    expect(await h.controller.logout()).toEqual({ ok: true });
    expect(h.controller.getSnapshot().logoutOutcome?.proxySessions).toBe("unconfirmed");
    // The POST may still return an unknown ID: a worker stopped now cannot resolve it.
    expect(h.securityStorage.state?.proxyCleanupUncertain).toBe(true);
    response.resolve();
    await connecting;
    await vi.waitFor(() => expect(h.api.revoked).toEqual(["late-known-created"]));
    await vi.waitFor(() => expect(ledger.sessions).toEqual([]));
    expect(h.securityStorage.state?.proxyCleanupUncertain).toBe(false);

    const restarted = createHarness({
      persisted: h.storage.persisted,
      transient: h.storage.transient,
      security: h.securityStorage.state!,
      cleanupStorage: ledger,
    });
    await restarted.controller.initialize();
    expect(await restarted.controller.logout()).toEqual({ ok: true });
    expect(restarted.controller.getSnapshot().logoutOutcome?.proxySessions).toBe("confirmed");

    h.api.auth = { ...AUTH, accessToken: "rotated-after-late-creation" };
    expect(await h.controller.login("cleanup@example.invalid", "synthetic")).toEqual({ ok: true });
    expect(await h.controller.logout()).toEqual({ ok: true });
    expect(h.controller.getSnapshot().logoutOutcome?.proxySessions).toBe("confirmed");
    expect(h.securityStorage.state?.proxyCleanupUncertain).toBe(false);
  });

  it("keeps a later logout unconfirmed while an earlier POST is still in flight", async () => {
    const ledger = new MemoryCleanup();
    const h = createHarness({
      persisted: authenticatedState(),
      cleanupStorage: ledger,
      remoteCleanupTimeoutMs: 5,
    });
    await h.controller.initialize();
    const response = deferred();
    h.api.createWait = response.promise;
    h.api.sessions = [proxySession("late-known-created")];
    const connecting = h.controller.connect("frankfurt-01");
    await vi.waitFor(() => expect(h.api.proofs).toHaveLength(1));
    expect(await h.controller.logout()).toEqual({ ok: true });
    h.api.auth = { ...AUTH, accessToken: "rotated-during-late-creation" };
    expect(await h.controller.login("cleanup@example.invalid", "synthetic")).toEqual({ ok: true });

    // The older POST may still return an ID: no logout can confirm cleanup yet.
    expect(await h.controller.logout()).toEqual({ ok: true });
    expect(h.controller.getSnapshot().logoutOutcome?.proxySessions).toBe("unconfirmed");
    expect(h.securityStorage.state?.proxyCleanupUncertain).toBe(true);

    response.resolve();
    await connecting;
    await vi.waitFor(() => expect(h.api.revoked).toEqual(["late-known-created"]));
    await vi.waitFor(() => expect(ledger.sessions).toEqual([]));
    expect(h.securityStorage.state?.proxyCleanupUncertain).toBe(false);
    h.api.auth = { ...AUTH, accessToken: "rotated-after-late-creation" };
    expect(await h.controller.login("cleanup@example.invalid", "synthetic")).toEqual({ ok: true });
    expect(await h.controller.logout()).toEqual({ ok: true });
    expect(h.controller.getSnapshot().logoutOutcome?.proxySessions).toBe("confirmed");
  });

  it.each([
    ["returns its ID", "created", ["late-known-created"]],
    ["is refused", "refused", []],
    ["is throttled", "throttled", []],
    [
      "returns an ID whose ledger write fails before its revocation",
      "unrecorded",
      ["late-known-created"],
    ],
  ] as const)(
    "does not restore the marker when the logout's last write waits behind a late POST which %s",
    async (_name, result, revoked) => {
      const ledger = new MemoryCleanup();
      const h = createHarness({
        persisted: authenticatedState(),
        cleanupStorage: ledger,
        remoteCleanupTimeoutMs: 5,
      });
      await h.controller.initialize();
      const response = deferred();
      const create = vi.spyOn(h.api, "createProxySession").mockImplementation(async () => {
        await response.promise;
        if (result === "refused") throw new ApiError("forbidden", 403);
        if (result === "throttled") throw new ApiError("rate_limited", 429, 90);
        return proxySession("late-known-created");
      });
      if (result === "unrecorded")
        vi.spyOn(ledger, "write").mockRejectedValueOnce(new Error("ledger_write_failed"));
      const connecting = h.controller.connect("frankfurt-01");
      await vi.waitFor(() => expect(create).toHaveBeenCalledOnce());
      // Hold the late creation's resolution inside the state lock, so that the
      // logout's final marker write is queued before its attempt ends.
      const settling = deferred();
      const release = deferred();
      const write = h.securityStorage.write.bind(h.securityStorage);
      const writes: boolean[] = [];
      vi.spyOn(h.securityStorage, "write").mockImplementation(async (state) => {
        writes.push(state.proxyCleanupUncertain);
        if (!state.proxyCleanupUncertain) {
          settling.resolve();
          await release.promise;
        }
        await write(state);
      });
      const logout = h.api.logout.bind(h.api);
      vi.spyOn(h.api, "logout").mockImplementation(async () => {
        response.resolve();
        await settling.promise;
        return logout();
      });

      const loggingOut = h.controller.logout();
      await settling.promise;
      await settle();
      await settle();
      release.resolve();
      expect(await loggingOut).toEqual({ ok: true });
      expect(await connecting).toMatchObject({ ok: false });
      await vi.waitFor(() => expect(h.api.revoked).toEqual(revoked));
      await vi.waitFor(() => expect(ledger.sessions).toEqual([]));
      expect(writes.at(-1)).toBe(false);
      expect(h.securityStorage.state?.proxyCleanupUncertain).toBe(false);
    },
  );

  it.each([
    ["refused", new ApiError("forbidden", 403)],
    ["throttled", new ApiError("rate_limited", 429, 90)],
  ] as const)("resolves the marker once the timed-out POST is %s", async (_name, refusal) => {
    const ledger = new MemoryCleanup();
    const h = createHarness({
      persisted: authenticatedState(),
      cleanupStorage: ledger,
      remoteCleanupTimeoutMs: 5,
    });
    await h.controller.initialize();
    const response = deferred();
    const create = vi.spyOn(h.api, "createProxySession").mockImplementation(async () => {
      await response.promise;
      throw refusal;
    });
    const connecting = h.controller.connect("frankfurt-01");
    await vi.waitFor(() => expect(create).toHaveBeenCalledOnce());
    expect(await h.controller.logout()).toEqual({ ok: true });
    expect(h.controller.getSnapshot().logoutOutcome?.proxySessions).toBe("unconfirmed");
    expect(h.securityStorage.state?.proxyCleanupUncertain).toBe(true);

    response.resolve();
    await connecting;
    // A refusal proves that this POST created no session.
    expect(h.api.revoked).toEqual([]);
    expect(h.securityStorage.state?.proxyCleanupUncertain).toBe(false);
    create.mockRestore();

    const restarted = createHarness({
      persisted: h.storage.persisted,
      transient: h.storage.transient,
      security: h.securityStorage.state!,
      cleanupStorage: ledger,
    });
    await restarted.controller.initialize();
    expect(await restarted.controller.login("cleanup@example.invalid", "synthetic")).toEqual({
      ok: true,
    });
    expect(await restarted.controller.logout()).toEqual({ ok: true });
    expect(restarted.controller.getSnapshot().logoutOutcome?.proxySessions).toBe("confirmed");
  });

  it("leaves the resolved marker to the next write of a newly logged-in account", async () => {
    const ledger = new MemoryCleanup();
    const h = createHarness({
      persisted: authenticatedState(),
      cleanupStorage: ledger,
      remoteCleanupTimeoutMs: 5,
    });
    await h.controller.initialize();
    const response = deferred();
    h.api.createWait = response.promise;
    h.api.sessions = [proxySession("late-old-account")];
    const connecting = h.controller.connect("frankfurt-01");
    await vi.waitFor(() => expect(h.api.proofs).toHaveLength(1));
    expect(await h.controller.logout()).toEqual({ ok: true });
    h.api.auth = { ...AUTH, accessToken: "new-account-token" };
    h.api.profile = { ...PROFILE, userId: "new-account" };
    expect(await h.controller.login("new@example.invalid", "synthetic")).toEqual({ ok: true });
    const security = structuredClone(h.securityStorage.state);
    expect(security?.proxyCleanupUncertain).toBe(true);

    response.resolve();
    await connecting;
    await vi.waitFor(() => expect(h.api.revoked).toEqual(["late-old-account"]));
    await vi.waitFor(() => expect(ledger.sessions).toEqual([]));
    // The old account's late result never writes the new account's state...
    expect(h.securityStorage.state).toEqual(security);
    // ...whose next security write persists the resolved marker.
    expect(await h.controller.updateSecurityPreferences(true, false)).toEqual({ ok: true });
    expect(h.securityStorage.state?.proxyCleanupUncertain).toBe(false);
    expect(await h.controller.logout()).toEqual({ ok: true });
    expect(h.controller.getSnapshot().logoutOutcome?.proxySessions).toBe("confirmed");
  });

  it("keeps durable uncertainty when the late POST ends without an ID after a new login", async () => {
    const ledger = new MemoryCleanup();
    const h = createHarness({
      persisted: authenticatedState(),
      cleanupStorage: ledger,
      remoteCleanupTimeoutMs: 5,
    });
    await h.controller.initialize();
    const response = deferred();
    const create = vi.spyOn(h.api, "createProxySession").mockImplementation(async () => {
      await response.promise;
      throw new NetworkError("network");
    });
    const connecting = h.controller.connect("frankfurt-01");
    await vi.waitFor(() => expect(create).toHaveBeenCalledOnce());
    expect(await h.controller.logout()).toEqual({ ok: true });
    h.api.auth = { ...AUTH, accessToken: "rotated-before-late-failure" };
    expect(await h.controller.login("cleanup@example.invalid", "synthetic")).toEqual({ ok: true });

    response.resolve();
    await connecting;
    expect(h.securityStorage.state?.proxyCleanupUncertain).toBe(true);
    create.mockRestore();
    // A later committed creation must not erase the unknown left by the old POST.
    expect(await h.controller.connect("frankfurt-01")).toEqual({ ok: true });
    expect(h.securityStorage.state?.proxyCleanupUncertain).toBe(true);
    expect(await h.controller.logout()).toEqual({ ok: true });
    expect(h.controller.getSnapshot().logoutOutcome?.proxySessions).toBe("unconfirmed");
    expect(h.securityStorage.state?.proxyCleanupUncertain).toBe(true);
  });
});

describe("COND-ULTRA-02 durable expiry under a wall-clock jump", () => {
  it("does not durably expire a record while the wall clock is ahead of elapsed time", async () => {
    const storage = new MemoryCleanup([pending("skew-live-id", LONG)]);
    let now = NOW;
    let elapsed = 0;
    const ledger = new ProxyCleanupLedger(
      storage,
      () => now,
      () => elapsed,
    );
    await ledger.initialize();
    now = NOW + 600_001;
    elapsed = 1_000;

    // Neither reads nor removal take the jump as proof of expiry.
    expect(ledger.hasOutstanding()).toBe(true);
    expect(ledger.forAccount(PROFILE.userId)).toEqual([pending("skew-live-id", LONG)]);
    expect(await ledger.complete(PROFILE.userId, "skew-live-id", now)).toBe(false);
    await ledger.add(PROFILE.userId, { id: "later-id", expiresAt: LATER });
    expect(storage.sessions).toEqual([pending("skew-live-id", LONG), pending("later-id", LATER)]);

    now = NOW + 1_000;
    expect(ledger.forAccount(PROFILE.userId)).toEqual(storage.sessions);
    const restarted = new ProxyCleanupLedger(
      storage,
      () => now,
      () => elapsed,
    );
    await restarted.initialize();
    expect(restarted.forAccount(PROFILE.userId)).toEqual(storage.sessions);
    expect(await restarted.complete(PROFILE.userId, "skew-live-id")).toBe(true);
    expect(storage.sessions).toEqual([pending("later-id", LATER)]);
  });

  it("still removes a record once elapsed time confirms its expiry", async () => {
    const storage = new MemoryCleanup([pending("expired-id", LONG)]);
    let now = NOW;
    let elapsed = 0;
    const ledger = new ProxyCleanupLedger(
      storage,
      () => now,
      () => elapsed,
    );
    await ledger.initialize();
    now = NOW + 600_001;
    elapsed = 600_001;

    expect(ledger.hasOutstanding()).toBe(false);
    expect(ledger.forAccount(PROFILE.userId)).toEqual([]);
    expect(await ledger.complete(PROFILE.userId, "expired-id", now)).toBe(true);
    expect(storage.sessions).toEqual([]);
  });

  it.each([
    ["confirms the revocation", "confirmed", []],
    ["keeps the record after a failed revocation", "unconfirmed", [pending("skew-live-id", LONG)]],
  ] as const)(
    "revokes an unproven record for an account logging in during the jump and %s",
    async (_name, proxySessions, remaining) => {
      const ledger = new MemoryCleanup([pending("skew-live-id", LONG)]);
      const h = createHarness({ persisted: { ...EMPTY_PERSISTED_STATE }, cleanupStorage: ledger });
      const revoke = vi.spyOn(h.api, "revokeProxySession");
      if (proxySessions === "unconfirmed")
        revoke.mockRejectedValueOnce(new NetworkError("network"));
      await h.controller.initialize();
      h.setNow(NOW + 600_001);

      expect(await h.controller.login("cleanup@example.invalid", "synthetic")).toEqual({
        ok: true,
      });
      expect(await h.controller.logout()).toEqual({ ok: true });
      expect(revoke).toHaveBeenCalledExactlyOnceWith(AUTH.accessToken, "skew-live-id");
      expect(ledger.sessions).toEqual(remaining);
      expect(h.controller.getSnapshot().logoutOutcome?.proxySessions).toBe(proxySessions);
    },
  );

  it.each(["same-worker", "restart"] as const)(
    "revokes a live ID after a temporary forward jump (%s)",
    async (variant) => {
      const ledger = new MemoryCleanup([pending("skew-live-id", LONG)]);
      const h = createHarness({ persisted: authenticatedState(), cleanupStorage: ledger });
      const revoke = vi
        .spyOn(h.api, "revokeProxySession")
        .mockRejectedValueOnce(new NetworkError("network"));
      await h.controller.initialize();
      h.setNow(NOW + 600_001);

      expect(await h.controller.disconnect()).toEqual({ ok: true });
      await settle();
      // The jump is not proof of remote expiry: the DELETE is attempted and,
      // since it failed, the ID stays durable for a later attempt.
      expect(revoke).toHaveBeenCalledExactlyOnceWith(AUTH.accessToken, "skew-live-id");
      expect(ledger.sessions).toEqual([pending("skew-live-id", LONG)]);

      const corrected =
        variant === "restart"
          ? createHarness({
              persisted: h.storage.persisted,
              transient: h.storage.transient,
              security: h.securityStorage.state!,
              cleanupStorage: ledger,
            })
          : h;
      corrected.setNow(NOW + 1_000);
      await corrected.controller.initialize();
      expect(await corrected.controller.disconnect()).toEqual({ ok: true });
      await settle();
      expect(await corrected.controller.logout()).toEqual({ ok: true });
      expect(corrected.api.revoked).toEqual(["skew-live-id"]);
      expect(ledger.sessions).toEqual([]);
      expect(corrected.controller.getSnapshot().logoutOutcome?.proxySessions).toBe("confirmed");
    },
  );
});
