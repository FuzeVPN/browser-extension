// SPDX-License-Identifier: MPL-2.0

import { DEFAULT_SECURITY_STATE } from "../../src/core/shared/security";
import type { PendingProxyRevocation } from "../../src/core/storage/proxy-cleanup-storage";
import { AUTH, PROFILE, authenticatedState, createHarness, proxySession } from "./helpers";

function cleanup() {
  let sessions: PendingProxyRevocation[] = [];
  return {
    async read() {
      return structuredClone(sessions);
    },
    async write(value: PendingProxyRevocation[]) {
      sessions = structuredClone(value);
    },
    get sessions() {
      return structuredClone(sessions);
    },
  };
}

function legacyHarness() {
  const session = proxySession("legacy-before-disconnect");
  const transient = {
    proxySession: session,
    refreshAttempts: 0,
    retiredSessions: [{ sessionId: "legacy-retired", expiresAt: session.expiresAt }],
  };
  const ledger = cleanup();
  const h = createHarness({
    persisted: authenticatedState({ autoConnect: true }),
    security: { ...DEFAULT_SECURITY_STATE, protectionRequested: true },
    transient,
    activeProxy: session,
    cleanupStorage: ledger,
  });
  return { ...h, ledger, session, transient };
}

describe("disconnect cleanup after unread legacy storage", () => {
  afterEach(() => vi.restoreAllMocks());

  it("persists unknown remote cleanup before clearing legacy credentials and keeps logout unconfirmed after restart", async () => {
    const first = legacyHarness();
    vi.spyOn(first.storage, "readTransient").mockRejectedValue(new Error("temporary read failure"));
    const clear = first.storage.clearTransient.bind(first.storage);
    vi.spyOn(first.storage, "clearTransient").mockImplementation(async () => {
      expect(first.securityStorage.state?.proxyCleanupUncertain).toBe(true);
      await clear();
    });
    await first.controller.initialize();
    expect(first.controller.getSnapshot().error).toBe("storage_unavailable");
    expect(await first.controller.disconnect()).toEqual({ ok: true });
    expect(first.storage.transient.proxySession).toBeNull();
    expect(first.storage.transient.retiredSessions).toEqual([]);
    expect(first.securityStorage.state?.proxyCleanupUncertain).toBe(true);
    expect(first.api.revoked).toEqual([]);
    expect(await first.controller.getActiveSession()).toBeNull();
    expect(first.controller.getSnapshot()).toMatchObject({
      protected: false,
      trafficBlocked: false,
    });

    const restarted = createHarness({
      persisted: first.storage.persisted,
      transient: first.storage.transient,
      security: first.securityStorage.state!,
      cleanupStorage: first.ledger,
    });
    await restarted.controller.initialize();
    expect(await restarted.controller.logout()).toEqual({ ok: true });
    expect(restarted.api.revoked).toEqual([]);
    expect(restarted.controller.getSnapshot().logoutOutcome?.proxySessions).toBe("unconfirmed");
  });

  it("makes one final migration attempt before clearing legacy credentials", async () => {
    const h = legacyHarness();
    vi.spyOn(h.storage, "readTransient")
      .mockRejectedValueOnce(new Error("startup read failure"))
      .mockRejectedValueOnce(new Error("disconnect initialization read failure"));
    const revoke = vi.spyOn(h.api, "revokeProxySession");
    await h.controller.initialize();
    expect(await h.controller.disconnect()).toEqual({ ok: true });
    await vi.waitFor(() => expect(revoke).toHaveBeenCalledTimes(2));
    expect(revoke).toHaveBeenCalledWith(AUTH.accessToken, h.session.id);
    expect(revoke).toHaveBeenCalledWith(AUTH.accessToken, "legacy-retired");
    expect(h.storage.transient.proxySession).toBeNull();
    await vi.waitFor(() => expect(h.ledger.sessions).toEqual([]));
    expect(h.securityStorage.state?.proxyCleanupUncertain).toBe(false);
    expect(await h.controller.logout()).toEqual({ ok: true });
    expect(h.controller.getSnapshot().logoutOutcome?.proxySessions).toBe("confirmed");
  });

  it("preserves the only unknown copy when its uncertainty marker cannot be persisted, then migrates it on restart", async () => {
    const h = legacyHarness();
    vi.spyOn(h.storage, "readTransient").mockRejectedValue(new Error("temporary read failure"));
    const clear = vi.spyOn(h.storage, "clearTransient");
    const writeSecurity = h.securityStorage.write.bind(h.securityStorage);
    vi.spyOn(h.securityStorage, "write").mockImplementation(async (state) => {
      if (state.proxyCleanupUncertain) throw new Error("marker write unavailable");
      await writeSecurity(state);
    });
    await h.controller.initialize();
    expect(await h.controller.disconnect()).toEqual({
      ok: false,
      commandError: "traffic_guard_failed",
    });
    expect(clear).not.toHaveBeenCalled();
    expect(h.storage.transient).toEqual(h.transient);
    expect(h.ledger.sessions).toEqual([]);
    expect(h.api.revoked).toEqual([]);
    expect(await h.controller.getActiveSession()).toBeNull();
    expect(h.proxy.active).toBeNull();

    const restarted = createHarness({
      persisted: h.storage.persisted,
      transient: h.storage.transient,
      security: h.securityStorage.state!,
      cleanupStorage: h.ledger,
    });
    const revoke = vi.spyOn(restarted.api, "revokeProxySession");
    await restarted.controller.initialize();
    expect(h.ledger.sessions).toContainEqual({
      userId: PROFILE.userId,
      sessionId: h.session.id,
      expiresAt: h.session.expiresAt,
    });
    expect(await restarted.controller.logout()).toEqual({ ok: true });
    expect(revoke).toHaveBeenCalledWith(AUTH.accessToken, h.session.id);
    expect(revoke).toHaveBeenCalledWith(AUTH.accessToken, "legacy-retired");
    expect(restarted.controller.getSnapshot().logoutOutcome?.proxySessions).toBe("confirmed");
  });

  it("never confirms cleanup after logout cannot persist uncertainty for unread legacy credentials", async () => {
    const h = legacyHarness();
    vi.spyOn(h.storage, "readTransient").mockRejectedValue(new Error("temporary read failure"));
    const clear = vi.spyOn(h.storage, "clearTransient");
    const writeSecurity = h.securityStorage.write.bind(h.securityStorage);
    vi.spyOn(h.securityStorage, "write").mockImplementation(async (state) => {
      if (state.proxyCleanupUncertain) throw new Error("marker write unavailable");
      await writeSecurity(state);
    });
    await h.controller.initialize();
    expect(await h.controller.logout()).toEqual({
      ok: false,
      commandError: "traffic_guard_failed",
    });
    expect(clear).not.toHaveBeenCalled();
    expect(h.storage.transient).toEqual(h.transient);
    expect(h.controller.getSnapshot().logoutOutcome?.proxySessions).toBe("unconfirmed");
    expect(await h.controller.getActiveSession()).toBeNull();

    const restarted = createHarness({
      persisted: h.storage.persisted,
      transient: h.storage.transient,
      security: h.securityStorage.state!,
      cleanupStorage: h.ledger,
    });
    await restarted.controller.initialize();
    await restarted.controller.logout();
    if (restarted.controller.getSnapshot().logoutOutcome?.proxySessions === "confirmed") {
      expect(restarted.api.revoked).toContain(h.session.id);
      expect(restarted.api.revoked).toContain("legacy-retired");
    } else
      expect(restarted.controller.getSnapshot().logoutOutcome?.proxySessions).toBe("unconfirmed");
  });

  it("migrates the retained owner's legacy IDs before another account can log in after recovery", async () => {
    const h = legacyHarness();
    const unread = vi
      .spyOn(h.storage, "readTransient")
      .mockRejectedValue(new Error("temporary read failure"));
    const writeSecurity = h.securityStorage.write.bind(h.securityStorage);
    const unwritable = vi.spyOn(h.securityStorage, "write").mockImplementation(async (state) => {
      if (state.proxyCleanupUncertain) throw new Error("marker write unavailable");
      await writeSecurity(state);
    });
    await h.controller.initialize();
    expect((await h.controller.logout()).ok).toBe(false);
    unread.mockRestore();
    unwritable.mockRestore();
    h.api.auth = { ...AUTH, accessToken: "new-account-token" };
    h.api.profile = { ...PROFILE, userId: "new-account" };

    expect(await h.controller.login("other@example.invalid", "synthetic")).toEqual({ ok: true });

    expect(h.ledger.sessions).toContainEqual({
      userId: PROFILE.userId,
      sessionId: h.session.id,
      expiresAt: h.session.expiresAt,
    });
    expect(h.ledger.sessions).toContainEqual({
      userId: PROFILE.userId,
      sessionId: "legacy-retired",
      expiresAt: h.session.expiresAt,
    });
    const revoke = vi.spyOn(h.api, "revokeProxySession");
    expect(await h.controller.logout()).toEqual({ ok: true });
    expect(revoke).not.toHaveBeenCalledWith("new-account-token", h.session.id);
    expect(revoke).not.toHaveBeenCalledWith("new-account-token", "legacy-retired");
    expect(h.controller.getSnapshot().logoutOutcome?.proxySessions).toBe("unconfirmed");
  });
});
