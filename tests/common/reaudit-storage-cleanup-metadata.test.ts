// SPDX-License-Identifier: MPL-2.0

import { NetworkError } from "../../src/core/api/client";
import { ExtensionStorageService } from "../../src/core/storage/storage";
import type { PendingProxyRevocation } from "../../src/core/storage/proxy-cleanup-storage";
import { AUTH, NOW, PROFILE, authenticatedState, createHarness, proxySession } from "./helpers";

function cleanup(initial: PendingProxyRevocation[] = []) {
  let sessions = structuredClone(initial);
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

async function restore(proxySession: unknown, retiredSessions: unknown = []) {
  vi.stubGlobal("browser", {
    storage: {
      session: {
        get: async () => ({
          fuzevpnProxySession: { proxySession, retiredSessions, refreshAttempts: 0 },
        }),
      },
    },
  });
  return new ExtensionStorageService().readTransient();
}

describe("rejected legacy session cleanup metadata", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it.each([
    ["issuedAt", "invalid-date"],
    ["username", ""],
    ["password", ""],
    ["port", 0],
    ["refreshAfterSeconds", Infinity],
  ])("retains only revocation metadata for corrupt %s", async (field, value) => {
    const session = proxySession("legacy-rejected");
    const restored = await restore({ ...session, [field]: value, userId: "untrusted-owner" });
    expect(restored).toMatchObject({ proxySession: null, activeLocation: null });
    expect(restored.retiredSessions).toEqual([
      { sessionId: session.id, expiresAt: session.expiresAt },
    ]);
    expect(restored.cleanupUncertain).toBeUndefined();
    expect(JSON.stringify(restored)).not.toMatch(/username|password|userId|temporary-password/);
  });

  it("projects and deduplicates retained metadata without shortening its expiry", async () => {
    const session = { ...proxySession("duplicate"), issuedAt: "invalid-date" };
    const later = new Date(NOW + 900_000).toISOString();
    const restored = await restore(session, [
      { sessionId: session.id, expiresAt: later, username: "secret", userId: "other-account" },
      { sessionId: session.id, expiresAt: session.expiresAt },
      { sessionId: "second", expiresAt: session.expiresAt, password: "secret" },
    ]);
    expect(restored.retiredSessions).toEqual([
      { sessionId: session.id, expiresAt: later },
      { sessionId: "second", expiresAt: session.expiresAt },
    ]);
    expect(restored.cleanupUncertain).toBeUndefined();
  });

  it("bounds recovered metadata and records uncertainty when entries cannot fit", async () => {
    const session = { ...proxySession("rejected-first"), issuedAt: "invalid-date" };
    const restored = await restore(
      session,
      Array.from({ length: 300 }, (_, index) => ({
        sessionId: `retired-${String(index)}`,
        expiresAt: session.expiresAt,
      })),
    );
    expect(restored.retiredSessions).toHaveLength(256);
    expect(restored.retiredSessions[0]).toEqual({
      sessionId: session.id,
      expiresAt: session.expiresAt,
    });
    expect(restored.cleanupUncertain).toBe(true);
    expect(new Set(restored.retiredSessions.map(({ sessionId }) => sessionId)).size).toBe(256);
  });

  it.each([
    ["id", ""],
    ["id", " "],
    ["id", "x".repeat(1_025)],
    ["id", "contains\ncontrol"],
    ["expiresAt", "invalid-date"],
    ["expiresAt", "x".repeat(65)],
  ])("keeps uncertainty without inventing metadata for invalid %s", async (field, value) => {
    const restored = await restore({
      ...proxySession(),
      issuedAt: "invalid-date",
      [field]: value,
    });
    expect(restored.proxySession).toBeNull();
    expect(restored.retiredSessions).toEqual([]);
    expect(restored.cleanupUncertain).toBe(true);
  });

  it("keeps an otherwise valid legacy session usable", async () => {
    const session = proxySession();
    expect(await restore(session)).toMatchObject({ proxySession: session, retiredSessions: [] });
  });

  it("does not manufacture a revocation for malformed retired metadata", async () => {
    const restored = await restore(null, [
      { sessionId: "", expiresAt: proxySession().expiresAt },
      { sessionId: "cannot-expire", expiresAt: "invalid-date" },
    ]);
    expect(restored.retiredSessions).toEqual([]);
    expect(restored.cleanupUncertain).toBe(true);
  });

  it("preserves uncertainty when the stored session container itself is corrupt", async () => {
    vi.stubGlobal("browser", {
      storage: { session: { get: async () => ({ fuzevpnProxySession: "corrupt-record" }) } },
    });
    expect(await new ExtensionStorageService().readTransient()).toMatchObject({
      proxySession: null,
      retiredSessions: [],
      cleanupUncertain: true,
    });
  });

  it("keeps remote cleanup unconfirmed when rejected credentials have no safe metadata", async () => {
    const ledger = cleanup();
    const h = createHarness({
      persisted: authenticatedState(),
      transient: await restore({ ...proxySession(), id: "", issuedAt: "invalid-date" }),
      cleanupStorage: ledger,
    });
    await h.controller.initialize();
    expect(h.securityStorage.state?.proxyCleanupUncertain).toBe(true);
    expect(await h.controller.logout()).toEqual({ ok: true });
    expect(h.api.revoked).toEqual([]);
    expect(h.controller.getSnapshot().logoutOutcome?.proxySessions).toBe("unconfirmed");
    expect(ledger.sessions).toEqual([]);

    const restarted = createHarness({
      persisted: h.storage.persisted,
      security: h.securityStorage.state!,
      cleanupStorage: ledger,
    });
    await restarted.controller.initialize();
    expect(await restarted.controller.logout()).toEqual({ ok: true });
    expect(restarted.controller.getSnapshot().logoutOutcome?.proxySessions).toBe("unconfirmed");
  });

  it("migrates the rejected ID for the current owner, preserves a failed revoke across restart, and never reactivates credentials", async () => {
    const session = { ...proxySession("legacy-cleanup-only"), issuedAt: "invalid-date" };
    const restored = await restore({ ...session, userId: "another-account" });
    const ledger = cleanup();
    const first = createHarness({
      persisted: authenticatedState({ autoConnect: true }),
      transient: restored,
      activeProxy: session,
      cleanupStorage: ledger,
    });
    await first.controller.initialize();
    expect(await first.controller.getActiveSession()).not.toEqual(session);
    expect(ledger.sessions).toContainEqual({
      userId: PROFILE.userId,
      sessionId: session.id,
      expiresAt: session.expiresAt,
    });
    vi.spyOn(first.api, "revokeProxySession").mockImplementation(async (_token, id) => {
      if (id === session.id) throw new NetworkError("network");
      first.api.revoked.push(id);
    });
    expect(await first.controller.logout()).toEqual({ ok: true });
    expect(first.controller.getSnapshot().logoutOutcome?.proxySessions).toBe("unconfirmed");
    expect(ledger.sessions.map(({ sessionId }) => sessionId)).toEqual([session.id]);
    expect(JSON.stringify(ledger.sessions)).not.toMatch(/accessToken|username|password/);

    const restarted = createHarness({
      persisted: first.storage.persisted,
      transient: first.storage.transient,
      security: first.securityStorage.state!,
      cleanupStorage: ledger,
    });
    await restarted.controller.initialize();
    expect(await restarted.controller.getActiveSession()).toBeNull();
    expect(await restarted.controller.logout()).toEqual({ ok: true });
    expect(restarted.controller.getSnapshot().logoutOutcome?.proxySessions).toBe("unconfirmed");
    expect(restarted.api.revoked).toEqual([]);
  });

  it("revokes a safely recovered legacy ID before reporting logout cleanup as confirmed", async () => {
    const session = { ...proxySession("legacy-known"), issuedAt: "invalid-date" };
    const ledger = cleanup();
    const h = createHarness({
      persisted: authenticatedState(),
      transient: await restore(session),
      cleanupStorage: ledger,
    });
    const revoke = vi.spyOn(h.api, "revokeProxySession");
    await h.controller.initialize();
    expect(await h.controller.logout()).toEqual({ ok: true });
    expect(revoke).toHaveBeenCalledExactlyOnceWith(AUTH.accessToken, session.id);
    expect(h.controller.getSnapshot().logoutOutcome?.proxySessions).toBe("confirmed");
    expect(ledger.sessions).toEqual([]);
  });

  it("does not treat expired recovered metadata as a live session", async () => {
    const session = {
      ...proxySession("legacy-expired"),
      issuedAt: "invalid-date",
      expiresAt: new Date(NOW - 1).toISOString(),
    };
    const h = createHarness({
      persisted: authenticatedState(),
      transient: await restore(session),
      cleanupStorage: cleanup(),
    });
    await h.controller.initialize();
    expect(await h.controller.logout()).toEqual({ ok: true });
    expect(h.api.revoked).toEqual([]);
    expect(h.controller.getSnapshot().logoutOutcome?.proxySessions).toBe("confirmed");
  });
});
