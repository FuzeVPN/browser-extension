// SPDX-License-Identifier: MPL-2.0

import { NetworkError } from "../../src/core/api/client";
import { ProxyCleanupLedger } from "../../src/core/background/proxy-cleanup-ledger";
import { DEFAULT_SECURITY_STATE } from "../../src/core/shared/security";
import type {
  PendingProxyRevocation,
  ProxyCleanupStorage,
} from "../../src/core/storage/proxy-cleanup-storage";
import { ExtensionStorageService } from "../../src/core/storage/storage";
import { AUTH, NOW, PROFILE, authenticatedState, createHarness, proxySession } from "./helpers";

const SHORT = new Date(NOW + 1_000).toISOString();
const LONG = new Date(NOW + 600_000).toISOString();
const MAX_DATE = "+275760-09-13T00:00:00.000Z";
const SESSION_ID = "independent-cleanup-session";
const RETIRED_ID = "independent-cleanup-retired";
const ROTATED_TOKEN = "independent-rotated-token";
const OTHER_OWNER = "independent-other-owner";

function pending(
  sessionId = SESSION_ID,
  expiresAt = LONG,
  userId = PROFILE.userId,
): PendingProxyRevocation {
  return { userId, sessionId, expiresAt };
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

function legacyHarness() {
  const session = proxySession(SESSION_ID);
  const transient = {
    proxySession: session,
    refreshAttempts: 0,
    retiredSessions: [{ sessionId: RETIRED_ID, expiresAt: session.expiresAt }],
  };
  const cleanupStorage = new MemoryCleanup();
  return {
    ...createHarness({
      persisted: authenticatedState({ autoConnect: true }),
      security: { ...DEFAULT_SECURITY_STATE, protectionRequested: true },
      transient,
      activeProxy: session,
      cleanupStorage,
    }),
    cleanupStorage,
    session,
    transient,
  };
}

describe("CODE05 independent historical cleanup durability", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  // Reproduces the six failures in the immutable cleanup_uncertainty audit.
  it.each([
    ["same-controller", "same-token"],
    ["same-controller", "rotated-token"],
    ["same-controller", "new-owner"],
    ["restart", "same-token"],
    ["restart", "rotated-token"],
    ["restart", "new-owner"],
  ])("never confirms unknown cleanup after %s and %s login", async (lifecycle, account) => {
    const first = legacyHarness();
    const unread = vi
      .spyOn(first.storage, "readTransient")
      .mockRejectedValue(new Error("independent_transient_unreadable"));
    const clear = first.storage.clearTransient.bind(first.storage);
    vi.spyOn(first.storage, "clearTransient").mockImplementationOnce(async () => {
      expect(first.securityStorage.state?.proxyCleanupUncertain).toBe(true);
      await clear();
    });
    await first.controller.initialize();
    expect(await first.controller.disconnect()).toEqual({ ok: true });
    expect(first.storage.transient.proxySession).toBeNull();
    expect(first.storage.transient.retiredSessions).toEqual([]);
    expect(first.cleanupStorage.sessions).toEqual([]);
    expect(first.api.revoked).toEqual([]);
    unread.mockRestore();

    const next =
      lifecycle === "restart"
        ? createHarness({
            persisted: first.storage.persisted,
            transient: first.storage.transient,
            security: first.securityStorage.state!,
            cleanupStorage: first.cleanupStorage,
          })
        : first;
    if (account !== "same-token") next.api.auth = { ...AUTH, accessToken: ROTATED_TOKEN };
    if (account === "new-owner") next.api.profile = { ...PROFILE, userId: OTHER_OWNER };
    expect(await next.controller.login("cleanup@example.invalid", "synthetic")).toEqual({
      ok: true,
    });
    const markerAfterLogin = next.securityStorage.state?.proxyCleanupUncertain;
    expect(await next.controller.logout()).toEqual({ ok: true });
    expect(next.controller.getSnapshot().logoutOutcome).toEqual({
      apiSession: "confirmed",
      proxySessions: "unconfirmed",
    });
    expect(next.api.revoked).toEqual([]);
    expect(markerAfterLogin).toBe(true);
    expect(next.securityStorage.state?.proxyCleanupUncertain).toBe(true);
    expect(await next.controller.getActiveSession()).toBeNull();
  });

  it("retains unknown cleanup through two logins, token rotation, owner change and restart", async () => {
    const first = legacyHarness();
    const unread = vi
      .spyOn(first.storage, "readTransient")
      .mockRejectedValue(new Error("independent_transient_unreadable"));
    await first.controller.initialize();
    expect(await first.controller.disconnect()).toEqual({ ok: true });
    unread.mockRestore();
    expect(await first.controller.login("cleanup@example.invalid", "synthetic")).toEqual({
      ok: true,
    });
    first.api.auth = { ...AUTH, accessToken: ROTATED_TOKEN };
    first.api.profile = { ...PROFILE, userId: OTHER_OWNER };
    expect(await first.controller.login("other@example.invalid", "synthetic")).toEqual({
      ok: true,
    });
    const restarted = createHarness({
      persisted: first.storage.persisted,
      transient: first.storage.transient,
      security: first.securityStorage.state!,
      cleanupStorage: first.cleanupStorage,
    });
    await restarted.controller.initialize();
    expect(await restarted.controller.logout()).toEqual({ ok: true });
    expect(restarted.api.revoked).toEqual([]);
    expect(restarted.controller.getSnapshot().logoutOutcome?.proxySessions).toBe("unconfirmed");
    expect(restarted.securityStorage.state?.proxyCleanupUncertain).toBe(true);
  });

  it("does not rely on in-memory uncertainty after same-owner same-token login and restart", async () => {
    const first = legacyHarness();
    const unread = vi
      .spyOn(first.storage, "readTransient")
      .mockRejectedValue(new Error("independent_transient_unreadable"));
    await first.controller.initialize();
    expect(await first.controller.disconnect()).toEqual({ ok: true });
    unread.mockRestore();
    expect(await first.controller.login("cleanup@example.invalid", "synthetic")).toEqual({
      ok: true,
    });
    const restarted = createHarness({
      persisted: first.storage.persisted,
      transient: first.storage.transient,
      security: first.securityStorage.state!,
      cleanupStorage: first.cleanupStorage,
    });
    await restarted.controller.initialize();
    expect(await restarted.controller.logout()).toEqual({ ok: true });
    expect(restarted.api.revoked).toEqual([]);
    expect(restarted.controller.getSnapshot().logoutOutcome?.proxySessions).toBe("unconfirmed");
  });

  it("does not erase a lost second ID after partial migration, expiry, reauthentication and restart", async () => {
    const first = legacyHarness();
    const write = first.cleanupStorage.write.bind(first.cleanupStorage);
    vi.spyOn(first.cleanupStorage, "write").mockImplementation(async (entries) => {
      if (entries.some((entry) => entry.sessionId === RETIRED_ID))
        throw new Error("independent_second_id_write_failed");
      await write(entries);
    });
    await first.controller.initialize();
    expect(await first.controller.disconnect()).toEqual({ ok: true });
    await vi.waitFor(() => expect(first.api.revoked).toContain(SESSION_ID));
    expect(first.api.revoked).not.toContain(RETIRED_ID);
    expect(first.storage.transient.retiredSessions).toEqual([]);
    expect(first.securityStorage.state?.proxyCleanupUncertain).toBe(true);
    first.api.auth = { ...AUTH, accessToken: ROTATED_TOKEN };
    expect(await first.controller.login("cleanup@example.invalid", "synthetic")).toEqual({
      ok: true,
    });
    const restarted = createHarness({
      persisted: first.storage.persisted,
      transient: first.storage.transient,
      security: first.securityStorage.state!,
      cleanupStorage: first.cleanupStorage,
    });
    restarted.setNow(NOW + 600_001);
    await restarted.controller.initialize();
    expect(await restarted.controller.logout()).toEqual({ ok: true });
    expect(restarted.api.revoked).toEqual([]);
    expect(restarted.controller.getSnapshot().logoutOutcome?.proxySessions).toBe("unconfirmed");
  });

  it("keeps legacy IDs and their original owner until both persistence failures recover", async () => {
    const h = legacyHarness();
    const unread = vi
      .spyOn(h.storage, "readTransient")
      .mockRejectedValue(new Error("independent_transient_unreadable"));
    const write = h.securityStorage.write.bind(h.securityStorage);
    const unwritable = vi.spyOn(h.securityStorage, "write").mockImplementation(async (state) => {
      if (state.proxyCleanupUncertain) throw new Error("independent_marker_unwritable");
      await write(state);
    });
    const clear = vi.spyOn(h.storage, "clearTransient");
    await h.controller.initialize();
    expect((await h.controller.logout()).ok).toBe(false);
    expect((await h.controller.logout()).ok).toBe(false);
    expect((await h.controller.login("other@example.invalid", "synthetic")).ok).toBe(false);
    expect(clear).not.toHaveBeenCalled();
    expect(h.storage.transient).toEqual(h.transient);
    expect(await h.controller.getActiveSession()).toBeNull();
    unread.mockRestore();
    unwritable.mockRestore();
    h.api.auth = { ...AUTH, accessToken: ROTATED_TOKEN };
    h.api.profile = { ...PROFILE, userId: OTHER_OWNER };
    expect(await h.controller.login("other@example.invalid", "synthetic")).toEqual({ ok: true });
    expect(h.cleanupStorage.sessions).toEqual([
      pending(SESSION_ID, h.session.expiresAt),
      pending(RETIRED_ID, h.session.expiresAt),
    ]);
    const revoke = vi.spyOn(h.api, "revokeProxySession");
    expect(await h.controller.logout()).toEqual({ ok: true });
    expect(revoke).not.toHaveBeenCalled();
    expect(h.controller.getSnapshot().logoutOutcome?.proxySessions).toBe("unconfirmed");
  });

  it.each([PROFILE.userId, OTHER_OWNER])(
    "late revocation cannot remove historical uncertainty after login as %s",
    async (nextOwner) => {
      const cleanupStorage = new MemoryCleanup([pending()]);
      const h = createHarness({
        persisted: authenticatedState(),
        cleanupStorage,
        security: { ...DEFAULT_SECURITY_STATE, proxyCleanupUncertain: true },
      });
      const response = deferred();
      const revoke = vi.spyOn(h.api, "revokeProxySession").mockImplementation(async (token) => {
        if (token === AUTH.accessToken) await response.promise;
      });
      await h.controller.initialize();
      expect(await h.controller.disconnect()).toEqual({ ok: true });
      await vi.waitFor(() => expect(revoke).toHaveBeenCalledWith(AUTH.accessToken, SESSION_ID));
      h.api.auth = { ...AUTH, accessToken: ROTATED_TOKEN };
      h.api.profile = { ...PROFILE, userId: nextOwner };
      expect(await h.controller.login("next@example.invalid", "synthetic")).toEqual({
        ok: true,
      });
      response.resolve();
      await vi.waitFor(() => expect(cleanupStorage.sessions).toEqual([]));
      expect(h.securityStorage.state?.proxyCleanupUncertain).toBe(true);
      expect(await h.controller.logout()).toEqual({ ok: true });
      expect(h.controller.getSnapshot().logoutOutcome?.proxySessions).toBe("unconfirmed");
      if (nextOwner !== PROFILE.userId)
        expect(revoke).not.toHaveBeenCalledWith(ROTATED_TOKEN, SESSION_ID);
    },
  );

  it("keeps a successfully revoked ID durable when completion write fails, then retries on restart", async () => {
    const cleanupStorage = new MemoryCleanup([pending()]);
    const first = createHarness({ persisted: authenticatedState(), cleanupStorage });
    const writer = vi
      .spyOn(cleanupStorage, "write")
      .mockRejectedValue(new Error("independent_completion_unverified"));
    await first.controller.initialize();
    expect(await first.controller.logout()).toEqual({ ok: true });
    expect(first.api.revoked).toEqual([SESSION_ID]);
    expect(first.controller.getSnapshot().logoutOutcome?.proxySessions).toBe("unconfirmed");
    expect(cleanupStorage.sessions).toEqual([pending()]);
    writer.mockRestore();
    const restarted = createHarness({
      persisted: authenticatedState({ auth: { ...AUTH, accessToken: ROTATED_TOKEN } }),
      security: first.securityStorage.state!,
      cleanupStorage,
    });
    const revoke = vi.spyOn(restarted.api, "revokeProxySession");
    await restarted.controller.initialize();
    expect(await restarted.controller.logout()).toEqual({ ok: true });
    expect(revoke).toHaveBeenCalledExactlyOnceWith(ROTATED_TOKEN, SESSION_ID);
    expect(cleanupStorage.sessions).toEqual([]);
  });

  it("keeps unknown cleanup after a creation timeout and a successful authenticated session", async () => {
    const cleanupStorage = new MemoryCleanup();
    const h = createHarness({ persisted: authenticatedState(), cleanupStorage });
    await h.controller.initialize();
    h.api.createError = new NetworkError("timeout");
    await h.controller.connect("frankfurt-01");
    h.api.createError = null;
    expect(await h.controller.retryConnection()).toEqual({ ok: true });
    expect(h.controller.getSnapshot().protected).toBe(true);
    expect(await h.controller.disconnect()).toEqual({ ok: true });
    await vi.waitFor(() => expect(cleanupStorage.sessions).toEqual([]));
    h.api.auth = { ...AUTH, accessToken: ROTATED_TOKEN };
    expect(await h.controller.login("cleanup@example.invalid", "synthetic")).toEqual({
      ok: true,
    });
    expect(await h.controller.logout()).toEqual({ ok: true });
    expect(h.api.revoked).toHaveLength(1);
    expect(h.controller.getSnapshot().logoutOutcome?.proxySessions).toBe("unconfirmed");
  });
});

describe("CODE06 independent longest cleanup deadline", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  // Reproduces storage_metadata's same-owner same-ID 1s / 600s counterexample.
  it("revokes a recovered 600s session after its old 1s ledger deadline and worker restart", async () => {
    const cleanupStorage = new MemoryCleanup([pending(SESSION_ID, SHORT)]);
    vi.stubGlobal("browser", {
      storage: {
        session: {
          get: async () => ({
            fuzevpnProxySession: {
              proxySession: { ...proxySession(SESSION_ID), issuedAt: "corrupt", expiresAt: LONG },
              retiredSessions: [],
            },
          }),
        },
      },
    });
    const transient = await new ExtensionStorageService().readTransient();
    expect(transient.proxySession).toBeNull();
    expect(transient.retiredSessions).toEqual([{ sessionId: SESSION_ID, expiresAt: LONG }]);
    const first = createHarness({ persisted: authenticatedState(), transient, cleanupStorage });
    await first.controller.initialize();
    expect(cleanupStorage.sessions).toEqual([pending()]);
    expect(await first.controller.getActiveSession()).toBeNull();
    const restarted = createHarness({
      persisted: first.storage.persisted,
      transient: first.storage.transient,
      security: first.securityStorage.state!,
      cleanupStorage,
    });
    restarted.setNow(NOW + 2_000);
    await restarted.controller.initialize();
    expect(await restarted.controller.logout()).toEqual({ ok: true });
    expect(restarted.api.revoked).toEqual([SESSION_ID]);
    expect(restarted.controller.getSnapshot().logoutOutcome?.proxySessions).toBe("confirmed");
    expect(cleanupStorage.sessions).toEqual([]);
  });

  it.each(["same-owner", "new-owner"])(
    "does not confirm an unrevoked extended ID after %s login and the old deadline",
    async (account) => {
      const cleanupStorage = new MemoryCleanup([pending(SESSION_ID, SHORT)]);
      const h = createHarness({
        persisted: authenticatedState(),
        cleanupStorage,
        transient: {
          proxySession: null,
          refreshAttempts: 0,
          retiredSessions: [{ sessionId: SESSION_ID, expiresAt: LONG }],
        },
      });
      const revoke = vi
        .spyOn(h.api, "revokeProxySession")
        .mockRejectedValue(new NetworkError("network"));
      await h.controller.initialize();
      expect(cleanupStorage.sessions).toEqual([pending()]);
      h.api.auth = { ...AUTH, accessToken: ROTATED_TOKEN };
      if (account === "new-owner") h.api.profile = { ...PROFILE, userId: OTHER_OWNER };
      expect(await h.controller.login("next@example.invalid", "synthetic")).toEqual({
        ok: true,
      });
      h.setNow(NOW + 2_000);
      expect(await h.controller.logout()).toEqual({ ok: true });
      expect(h.controller.getSnapshot().logoutOutcome?.proxySessions).toBe("unconfirmed");
      expect(cleanupStorage.sessions).toEqual([pending()]);
      if (account === "new-owner")
        expect(revoke).not.toHaveBeenCalledWith(ROTATED_TOKEN, SESSION_ID);
      else expect(revoke).toHaveBeenCalledWith(ROTATED_TOKEN, SESSION_ID);
    },
  );

  it("records uncertainty before dropping an extension that cannot be durably written", async () => {
    const cleanupStorage = new MemoryCleanup([pending(SESSION_ID, SHORT)]);
    const writer = vi.spyOn(cleanupStorage, "write").mockRejectedValue(new Error("write_failed"));
    const first = createHarness({
      persisted: authenticatedState(),
      cleanupStorage,
      transient: {
        proxySession: null,
        refreshAttempts: 0,
        retiredSessions: [{ sessionId: SESSION_ID, expiresAt: LONG }],
      },
    });
    await first.controller.initialize();
    expect(await first.controller.disconnect()).toEqual({ ok: true });
    expect(first.securityStorage.state?.proxyCleanupUncertain).toBe(true);
    writer.mockRestore();
    const restarted = createHarness({
      persisted: first.storage.persisted,
      transient: first.storage.transient,
      security: first.securityStorage.state!,
      cleanupStorage,
    });
    restarted.setNow(NOW + 2_000);
    await restarted.controller.initialize();
    expect(await restarted.controller.logout()).toEqual({ ok: true });
    expect(restarted.controller.getSnapshot().logoutOutcome?.proxySessions).toBe("unconfirmed");
  });

  it.each([LONG, "2026-08-26T14:10:00+02:00", MAX_DATE])(
    "preserves the longest deadline %s against shorter dates and restart",
    async (expiresAt) => {
      let now = NOW;
      // Time really passes here: elapsed time proves each expiry the wall clock reaches.
      const elapsed = () => now - NOW;
      const cleanupStorage = new MemoryCleanup([pending(SESSION_ID, SHORT)]);
      const ledger = new ProxyCleanupLedger(cleanupStorage, () => now, elapsed);
      await ledger.initialize();
      await ledger.add(PROFILE.userId, { id: SESSION_ID, expiresAt });
      await ledger.add(PROFILE.userId, { id: SESSION_ID, expiresAt: SHORT });
      await ledger.add(PROFILE.userId, { id: SESSION_ID, expiresAt: "invalid-date" });
      now = NOW + 2_000;
      const restarted = new ProxyCleanupLedger(cleanupStorage, () => now, elapsed);
      await restarted.initialize();
      expect(restarted.forAccount(PROFILE.userId)).toEqual([pending(SESSION_ID, expiresAt)]);
      expect(restarted.hasOutstanding()).toBe(true);
      now = Date.parse(expiresAt);
      expect(restarted.forAccount(PROFILE.userId)).toEqual([]);
      expect(restarted.hasOutstanding()).toBe(false);
    },
  );

  it("never shortens either owner's deadline or completes the other owner's equal ID", async () => {
    const cleanupStorage = new MemoryCleanup([
      pending(SESSION_ID, SHORT),
      pending(SESSION_ID, MAX_DATE, OTHER_OWNER),
    ]);
    const ledger = new ProxyCleanupLedger(cleanupStorage, () => NOW);
    await ledger.initialize();
    await ledger.add(PROFILE.userId, { id: SESSION_ID, expiresAt: LONG });
    await ledger.add(OTHER_OWNER, { id: SESSION_ID, expiresAt: LONG });
    await ledger.complete(PROFILE.userId, SESSION_ID);
    expect(cleanupStorage.sessions).toEqual([pending(SESSION_ID, MAX_DATE, OTHER_OWNER)]);
    expect(ledger.forAccount(PROFILE.userId)).toEqual([]);
    expect(ledger.hasOutstanding()).toBe(true);
  });

  it("rejects an unverified extension, leaves its previous deadline durable, and retries", async () => {
    let now = NOW;
    const cleanupStorage = new MemoryCleanup([pending(SESSION_ID, SHORT)]);
    const ledger = new ProxyCleanupLedger(cleanupStorage, () => now);
    await ledger.initialize();
    const writer = vi
      .spyOn(cleanupStorage, "write")
      .mockRejectedValueOnce(new Error("extension_unverified"));
    await expect(ledger.add(PROFILE.userId, { id: SESSION_ID, expiresAt: LONG })).rejects.toThrow(
      "extension_unverified",
    );
    expect(cleanupStorage.sessions).toEqual([pending(SESSION_ID, SHORT)]);
    expect(ledger.forAccount(PROFILE.userId)).toEqual([pending(SESSION_ID, SHORT)]);
    await ledger.add(PROFILE.userId, { id: SESSION_ID, expiresAt: LONG });
    expect(writer).toHaveBeenCalledTimes(2);
    now = NOW + 2_000;
    const restarted = new ProxyCleanupLedger(cleanupStorage, () => now);
    await restarted.initialize();
    expect(restarted.forAccount(PROFILE.userId)).toEqual([pending()]);
  });

  it("waits for durable extension before exposing the later deadline to concurrent readers", async () => {
    const cleanupStorage = new MemoryCleanup([pending(SESSION_ID, SHORT)]);
    const ledger = new ProxyCleanupLedger(cleanupStorage, () => NOW);
    await ledger.initialize();
    const released = deferred();
    const write = cleanupStorage.write.bind(cleanupStorage);
    const writer = vi.spyOn(cleanupStorage, "write").mockImplementationOnce(async (entries) => {
      await released.promise;
      await write(entries);
    });
    const extending = ledger.add(PROFILE.userId, { id: SESSION_ID, expiresAt: LONG });
    await vi.waitFor(() => expect(writer).toHaveBeenCalledOnce());
    const later = ledger.add(PROFILE.userId, { id: SESSION_ID, expiresAt: MAX_DATE });
    await settle();
    expect(cleanupStorage.sessions).toEqual([pending(SESSION_ID, SHORT)]);
    expect(ledger.forAccount(PROFILE.userId)).toEqual([pending(SESSION_ID, SHORT)]);
    released.resolve();
    await Promise.all([extending, later]);
    expect(cleanupStorage.sessions).toEqual([pending(SESSION_ID, MAX_DATE)]);
  });

  it("refuses an expiry-only completion queued behind an extension until server revocation", async () => {
    let now = NOW;
    // Time really passes here: elapsed time proves the old expiry, so the queued
    // extension is the only reason to refuse the expiry-only completion.
    const elapsed = () => now - NOW;
    const cleanupStorage = new MemoryCleanup([
      pending(SESSION_ID, SHORT),
      pending(SESSION_ID, MAX_DATE, OTHER_OWNER),
    ]);
    const ledger = new ProxyCleanupLedger(cleanupStorage, () => now, elapsed);
    await ledger.initialize();
    const released = deferred();
    const write = cleanupStorage.write.bind(cleanupStorage);
    const writer = vi.spyOn(cleanupStorage, "write").mockImplementationOnce(async (entries) => {
      await released.promise;
      await write(entries);
    });
    const extending = ledger.add(PROFILE.userId, { id: SESSION_ID, expiresAt: LONG });
    await vi.waitFor(() => expect(writer).toHaveBeenCalledOnce());
    now = NOW + 2_000;
    const expiryOnly = ledger.complete(PROFILE.userId, SESSION_ID, now);
    released.resolve();
    await extending;
    expect(await expiryOnly).toBe(false);
    expect(cleanupStorage.sessions).toEqual([
      pending(),
      pending(SESSION_ID, MAX_DATE, OTHER_OWNER),
    ]);
    const restarted = new ProxyCleanupLedger(cleanupStorage, () => now, elapsed);
    await restarted.initialize();
    expect(restarted.forAccount(PROFILE.userId)).toEqual([pending()]);
    expect(await restarted.complete(PROFILE.userId, SESSION_ID)).toBe(true);
    expect(cleanupStorage.sessions).toEqual([pending(SESSION_ID, MAX_DATE, OTHER_OWNER)]);
  });
});
