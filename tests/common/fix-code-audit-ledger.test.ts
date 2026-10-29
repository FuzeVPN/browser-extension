// SPDX-License-Identifier: MPL-2.0

import { ProxyCleanupLedger } from "../../src/core/background/proxy-cleanup-ledger";
import type {
  PendingProxyRevocation,
  ProxyCleanupStorage,
} from "../../src/core/storage/proxy-cleanup-storage";

const NOW = Date.parse("2026-08-26T12:00:00Z");
const SHORT = new Date(NOW + 1_000).toISOString();
const LONG = new Date(NOW + 600_000).toISOString();
const pending = (expiresAt = SHORT, userId = "owner"): PendingProxyRevocation => ({
  userId,
  sessionId: "same-session",
  expiresAt,
});
const session = (expiresAt: string) => ({ id: "same-session", expiresAt });

class MemoryCleanup implements ProxyCleanupStorage {
  sessions: PendingProxyRevocation[];
  writes: PendingProxyRevocation[][] = [];

  constructor(sessions: PendingProxyRevocation[] = [pending()]) {
    this.sessions = structuredClone(sessions);
  }

  async read(): Promise<PendingProxyRevocation[]> {
    return structuredClone(this.sessions);
  }

  async write(sessions: PendingProxyRevocation[]): Promise<void> {
    this.writes.push(structuredClone(sessions));
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

describe("CODE06 durable cleanup expiry", () => {
  it("retains the longest known expiry across the old deadline and restart", async () => {
    const storage = new MemoryCleanup();
    let now = NOW;
    const ledger = new ProxyCleanupLedger(storage, () => now);
    await ledger.initialize();

    await ledger.add("owner", session(LONG));
    now = NOW + 2_000;

    expect(ledger.forAccount("owner")).toEqual([pending(LONG)]);
    expect(ledger.hasOutstanding()).toBe(true);
    expect(storage.sessions).toEqual([pending(LONG)]);
    const restarted = new ProxyCleanupLedger(storage, () => now);
    await restarted.initialize();
    expect(restarted.forAccount("owner")).toEqual([pending(LONG)]);
    expect(restarted.hasOutstanding()).toBe(true);
  });

  it.each([SHORT, "2026-08-26T14:10:00+02:00", "invalid-date"])(
    "does not shorten or rewrite a known expiry for %s",
    async (expiresAt) => {
      const storage = new MemoryCleanup([pending(LONG)]);
      const ledger = new ProxyCleanupLedger(storage, () => NOW);
      await ledger.initialize();

      await ledger.add("owner", session(expiresAt));

      expect(ledger.forAccount("owner")).toEqual([pending(LONG)]);
      expect(storage.sessions).toEqual([pending(LONG)]);
      expect(storage.writes).toEqual([]);
    },
  );

  it("does not shorten a later duplicate already present in durable metadata", async () => {
    const storage = new MemoryCleanup([pending(), pending(LONG)]);
    const ledger = new ProxyCleanupLedger(storage, () => NOW);
    await ledger.initialize();
    const middle = new Date(NOW + 10_000).toISOString();

    await ledger.add("owner", session(middle));

    expect(storage.sessions).toEqual([pending(middle), pending(LONG)]);
  });

  it("keeps equal session IDs isolated by owner when extending and completing", async () => {
    const storage = new MemoryCleanup([pending(), pending(LONG, "other-owner")]);
    const ledger = new ProxyCleanupLedger(storage, () => NOW);
    await ledger.initialize();

    await ledger.add("owner", session(LONG));
    expect(ledger.forAccount("owner")).toEqual([pending(LONG)]);
    expect(ledger.forAccount("other-owner")).toEqual([pending(LONG, "other-owner")]);
    expect(await ledger.complete("owner", "same-session")).toBe(true);

    expect(storage.sessions).toEqual([pending(LONG, "other-owner")]);
    expect(ledger.hasOutstanding()).toBe(true);
  });

  it("serializes concurrent extensions and only publishes verified durable state", async () => {
    const storage = new MemoryCleanup();
    const ledger = new ProxyCleanupLedger(storage, () => NOW);
    await ledger.initialize();
    const entered = deferred();
    const released = deferred();
    const write = storage.write.bind(storage);
    const writer = vi.spyOn(storage, "write").mockImplementationOnce(async (sessions) => {
      entered.resolve();
      await released.promise;
      await write(sessions);
    });

    const extending = ledger.add("owner", session(LONG));
    await entered.promise;
    const shorter = ledger.add("owner", session(SHORT));
    expect(ledger.forAccount("owner")).toEqual([pending()]);
    expect(storage.sessions).toEqual([pending()]);
    expect(writer).toHaveBeenCalledTimes(1);
    released.resolve();
    await Promise.all([extending, shorter]);

    expect(storage.sessions).toEqual([pending(LONG)]);
    expect(ledger.forAccount("owner")).toEqual([pending(LONG)]);
    expect(writer).toHaveBeenCalledTimes(1);
  });

  it("retains the old state after failed durability and retries a queued extension", async () => {
    const storage = new MemoryCleanup();
    const ledger = new ProxyCleanupLedger(storage, () => NOW);
    await ledger.initialize();
    const writer = vi
      .spyOn(storage, "write")
      .mockRejectedValueOnce(new Error("storage_unverified"));

    await expect(ledger.add("owner", session(LONG))).rejects.toThrow("storage_unverified");
    expect(ledger.forAccount("owner")).toEqual([pending()]);
    expect(storage.sessions).toEqual([pending()]);
    await ledger.add("owner", session(LONG));

    expect(ledger.forAccount("owner")).toEqual([pending(LONG)]);
    expect(storage.sessions).toEqual([pending(LONG)]);
    expect(writer).toHaveBeenCalledTimes(2);
  });

  it("captures identifiers and expiry before an add waits in the mutation queue", async () => {
    const storage = new MemoryCleanup();
    const ledger = new ProxyCleanupLedger(storage, () => NOW);
    await ledger.initialize();
    const entered = deferred();
    const released = deferred();
    const write = storage.write.bind(storage);
    vi.spyOn(storage, "write").mockImplementationOnce(async (sessions) => {
      entered.resolve();
      await released.promise;
      await write(sessions);
    });

    const first = ledger.add("different-owner", session(LONG));
    await entered.promise;
    const metadata = session(LONG);
    const queued = ledger.add("owner", metadata);
    metadata.id = "changed-after-add";
    metadata.expiresAt = SHORT;
    released.resolve();
    await Promise.all([first, queued]);

    expect(ledger.forAccount("owner")).toEqual([pending(LONG)]);
  });

  it("does not erase a queued extension when cleanup only observed the old expiry", async () => {
    const storage = new MemoryCleanup();
    let now = NOW;
    // Time really passes here: elapsed time proves the old expiry, so the queued
    // extension is the only reason to refuse the cleanup.
    const elapsed = () => now - NOW;
    const ledger = new ProxyCleanupLedger(storage, () => now, elapsed);
    await ledger.initialize();
    const entered = deferred();
    const released = deferred();
    const write = storage.write.bind(storage);
    vi.spyOn(storage, "write").mockImplementationOnce(async (sessions) => {
      entered.resolve();
      await released.promise;
      await write(sessions);
    });

    const extending = ledger.add("owner", session(LONG));
    await entered.promise;
    now = NOW + 2_000;
    const expiredCleanup = ledger.complete("owner", "same-session", now);
    released.resolve();
    expect(await Promise.all([extending, expiredCleanup])).toEqual([undefined, false]);

    expect(storage.sessions).toEqual([pending(LONG)]);
    expect(ledger.forAccount("owner")).toEqual([pending(LONG)]);
    expect(ledger.hasOutstanding()).toBe(true);
  });
});
