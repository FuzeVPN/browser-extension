// SPDX-License-Identifier: MPL-2.0

import { ApiError } from "../../src/core/api/client";
import { ProxyCleanupLedger } from "../../src/core/background/proxy-cleanup-ledger";
import type {
  PendingProxyRevocation,
  ProxyCleanupStorage,
} from "../../src/core/storage/proxy-cleanup-storage";
import { NOW, PROFILE, authenticatedState, createHarness, proxySession } from "./helpers";

const EXPIRED = new Date(NOW - 60_000).toISOString();

function pending(sessionId: string, expiresAt = proxySession().expiresAt): PendingProxyRevocation {
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

afterEach(() => vi.restoreAllMocks());

describe("XR-LC-06 one rule for the unknown cleanup marker", () => {
  it.each(["refused", "created"] as const)(
    "clears the marker once a superseded ID is recorded and revoked while the owner POST is %s",
    async (outcome) => {
      const ledger = new MemoryCleanup();
      const h = createHarness({ persisted: authenticatedState(), cleanupStorage: ledger });
      await h.controller.initialize();
      const first = deferred();
      const last = deferred();
      const create = vi
        .spyOn(h.api, "createProxySession")
        .mockImplementationOnce(async (_token, locationId) => {
          await first.promise;
          return { ...proxySession("x-old"), locationId };
        })
        .mockImplementationOnce(async (_token, locationId) => {
          await last.promise;
          if (outcome === "refused") throw new ApiError("forbidden", 403);
          return { ...proxySession("y-new"), locationId };
        });
      const older = h.controller.connect("frankfurt-01");
      await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(1));
      const newer = h.controller.connect("frankfurt-02");
      await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(2));
      // A command holds the state lock while both POSTs return: the superseded
      // ID is recorded and revoked before the owner settles behind that command.
      const gate = deferred();
      const holding = deferred();
      const write = h.securityStorage.write.bind(h.securityStorage);
      vi.spyOn(h.securityStorage, "write").mockImplementationOnce(async (state) => {
        holding.resolve();
        await gate.promise;
        await write(state);
      });
      const preferences = h.controller.updateSecurityPreferences(true, false);
      await holding.promise;
      first.resolve();
      await vi.waitFor(() => expect(h.api.revoked).toContain("x-old"));
      last.resolve();
      await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(2));
      gate.resolve();
      await preferences;
      await older;
      await newer;
      await vi.waitFor(() =>
        expect(h.api.revoked).toEqual(outcome === "created" ? ["x-old", "y-new"] : ["x-old"]),
      );
      await vi.waitFor(() => expect(ledger.sessions).toEqual([]));

      // Every ID is recorded and revoked, and no POST remains in flight.
      expect(h.securityStorage.state?.proxyCleanupUncertain).toBe(false);
      expect(h.controller.getDiagnosticReadState().proxyCleanupUncertain).toBe(false);

      create.mockRestore();
      const restarted = createHarness({
        persisted: h.storage.persisted,
        transient: h.storage.transient,
        security: h.securityStorage.state!,
        cleanupStorage: ledger,
      });
      await restarted.controller.initialize();
      expect(await restarted.controller.logout()).toEqual({ ok: true });
      expect(restarted.controller.getSnapshot().logoutOutcome?.proxySessions).toBe("confirmed");
    },
  );
});

describe("XR-LC-03 proven revocation of an ID whose record failed", () => {
  it("settles the revoked ID when the ledger stays unwritable and an expired record is stored", async () => {
    const ledger = new MemoryCleanup([pending("expired-elsewhere", EXPIRED)]);
    const h = createHarness({ persisted: authenticatedState(), cleanupStorage: ledger });
    await h.controller.initialize();
    const write = vi.spyOn(ledger, "write").mockRejectedValue(new Error("ledger_outage"));

    // The DELETE succeeds: only the purge of an unrelated expired record fails.
    expect(await h.controller.connect("frankfurt-01")).toEqual({
      ok: false,
      commandError: "storage_unavailable",
    });
    write.mockRestore();
    expect(h.api.revoked).toEqual(["proxy-session-1"]);
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

  it("keeps no ledger debt for the revoked ID after two consecutive failed writes", async () => {
    const ledger = new MemoryCleanup([pending("expired-elsewhere", EXPIRED)]);
    const h = createHarness({ persisted: authenticatedState(), cleanupStorage: ledger });
    await h.controller.initialize();
    vi.spyOn(ledger, "write")
      .mockRejectedValueOnce(new Error("ledger_write_failed"))
      .mockRejectedValueOnce(new Error("ledger_purge_failed"));

    expect(await h.controller.connect("frankfurt-01")).toEqual({
      ok: false,
      commandError: "storage_unavailable",
    });
    expect(h.api.revoked).toEqual(["proxy-session-1"]);
    expect(ledger.sessions.map(({ sessionId }) => sessionId)).not.toContain("proxy-session-1");
    expect(await h.controller.disconnect()).toEqual({ ok: true });
    expect(await h.controller.logout()).toEqual({ ok: true });
    // The proven revocation is shared: logout neither repeats it nor doubts it.
    expect(h.api.revoked).toEqual(["proxy-session-1"]);
    expect(h.controller.getSnapshot().logoutOutcome?.proxySessions).toBe("confirmed");
  });

  it("fails only writes which change an outstanding record", async () => {
    const storage = new MemoryCleanup([pending("expired", EXPIRED), pending("live")]);
    const ledger = new ProxyCleanupLedger(storage, () => NOW);
    await ledger.initialize();
    const write = vi.spyOn(storage, "write").mockRejectedValue(new Error("ledger_outage"));

    // Neither call changes an outstanding record: only the purge is retried later.
    await expect(ledger.complete(PROFILE.userId, "absent")).resolves.toBe(true);
    await expect(ledger.add(PROFILE.userId, proxySession("live"))).resolves.toBeUndefined();
    // A record which really exists is never reported removed or added without a write.
    await expect(ledger.complete(PROFILE.userId, "live")).rejects.toThrow("ledger_outage");
    await expect(ledger.add(PROFILE.userId, proxySession("new"))).rejects.toThrow("ledger_outage");
    expect(ledger.forAccount(PROFILE.userId)).toEqual([pending("live")]);
    expect(ledger.hasOutstanding()).toBe(true);

    write.mockRestore();
    await expect(ledger.complete(PROFILE.userId, "absent")).resolves.toBe(true);
    expect(storage.sessions).toEqual([pending("live")]);
  });
});
