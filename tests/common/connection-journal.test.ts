// SPDX-License-Identifier: MPL-2.0

import {
  ConnectionJournal,
  type ConnectionEvent,
  type ConnectionTrace,
} from "../../src/core/background/connection-journal";

const NOW = Date.parse("2026-10-16T17:00:00Z");

function fixture(initial?: unknown) {
  let now = NOW;
  let stored = initial;
  const storage = {
    read: vi.fn(async () => structuredClone(stored)),
    write: vi.fn(async (events: ConnectionEvent[]) => {
      stored = structuredClone(events);
    }),
  };
  const options = { storage, now: () => now };
  return {
    journal: new ConnectionJournal(options),
    options,
    stored: () => stored,
    setNow: (value: number) => {
      now = value;
    },
  };
}

describe("local connection journal", () => {
  it("restores a worker's history and retains events recorded while storage is loading", async () => {
    let finishRead!: (value: unknown) => void;
    const journal = new ConnectionJournal({
      storage: {
        read: () => new Promise((resolve) => (finishRead = resolve)),
        write: vi.fn(async () => undefined),
      },
      now: () => NOW,
    });
    journal.record({ event: "command", phase: "start", action: "connect", operation: 7 });
    finishRead([{ event: "state", status: "disconnected", at: NOW - 20, sequence: 41 }]);
    expect(await journal.snapshot()).toEqual([
      { event: "state", status: "disconnected", at: NOW - 20, sequence: 41 },
      {
        event: "command",
        phase: "start",
        action: "connect",
        operation: 7,
        at: NOW,
        sequence: 42,
      },
    ]);
  });

  it("keeps only the latest 200 events and the inclusive ten-minute window", async () => {
    const f = fixture();
    await f.journal.snapshot();
    for (let index = 0; index < 205; index++) {
      f.setNow(NOW + index);
      f.journal.record({ event: "catalog", count: index, selectedPresent: false });
    }
    const retained = await f.journal.snapshot();
    expect(retained).toHaveLength(200);
    expect(retained[0]).toMatchObject({ count: 5, sequence: 6 });
    expect(retained.at(-1)).toMatchObject({ count: 204, sequence: 205 });
    f.setNow(NOW + 600_005);
    expect(await f.journal.snapshot()).toHaveLength(200);
    f.setNow(NOW + 600_006);
    expect(await f.journal.snapshot()).toHaveLength(199);
    f.setNow(NOW + 600_205);
    expect(await f.journal.snapshot()).toEqual([]);
    await vi.waitFor(() => expect(f.stored()).toEqual([]));
  });

  it("reconstructs stored data using only fixed vocabulary, numbers and booleans", async () => {
    const f = fixture([
      {
        event: "failure",
        phase: "end",
        action: "connect",
        operation: 5,
        source: "api",
        reason: "catalog_missing",
        status: "error",
        error: "invalid_location",
        httpStatus: 400,
        count: 3,
        selectedPresent: false,
        requestedPresent: true,
        protected: false,
        protectionRequested: true,
        trafficBlocked: true,
        at: NOW,
        sequence: 8,
        token: "secret-token",
        locationId: "secret-location",
        address: "192.0.2.1",
        message: "https://private.invalid/",
      },
      { event: "state", at: NOW + 1, sequence: 9 },
      { event: "state", at: NOW - 600_001, sequence: 10 },
      { event: "secret-event", at: NOW, sequence: 11 },
    ]);
    const snapshot = await f.journal.snapshot();
    expect(snapshot).toEqual([
      {
        event: "failure",
        phase: "end",
        action: "connect",
        operation: 5,
        source: "api",
        reason: "catalog_missing",
        status: "error",
        error: "invalid_location",
        httpStatus: 400,
        count: 3,
        selectedPresent: false,
        requestedPresent: true,
        protected: false,
        protectionRequested: true,
        trafficBlocked: true,
        at: NOW,
        sequence: 8,
      },
    ]);
    await vi.waitFor(() => expect(f.stored()).toEqual(snapshot));
    expect(JSON.stringify(snapshot)).not.toMatch(/secret|192\.0\.2|private/);
  });

  it("rejects coercion, unbounded numbers and arbitrary error text on record", async () => {
    const f = fixture();
    f.journal.record({
      event: "failure",
      action: "https://private.invalid/",
      operation: Infinity,
      source: ["api"],
      reason: "secret-reason",
      status: "secret-state",
      error: "secret-error",
      httpStatus: 600,
      count: -1,
      selectedPresent: 1,
      protected: "true",
      at: 1,
      sequence: 999,
      password: "secret-password",
    } as unknown as ConnectionTrace);
    f.journal.record({ event: ["command"] } as unknown as ConnectionTrace);
    f.journal.record({ event: "state", error: null, httpStatus: null, protected: true });
    expect(await f.journal.snapshot()).toEqual([
      { event: "failure", at: NOW, sequence: 1 },
      { event: "state", error: null, httpStatus: null, protected: true, at: NOW, sequence: 2 },
    ]);
  });

  it("keeps recording and exporting without awaiting a failed or hanging storage write", async () => {
    const storage = {
      read: vi.fn(async () => {
        throw new Error("storage_unavailable");
      }),
      write: vi.fn(async (_events: ConnectionEvent[]) => {
        throw new Error("storage_unavailable");
      }),
    };
    const journal = new ConnectionJournal({ storage, now: () => NOW });
    expect(await journal.snapshot()).toEqual([]);
    await vi.waitFor(() => expect(storage.write).toHaveBeenCalled());
    storage.write.mockImplementation(() => new Promise(() => undefined));
    expect(
      journal.record({ event: "state", status: "connected", protected: true }),
    ).toBeUndefined();
    expect(await journal.snapshot()).toEqual([
      { event: "state", status: "connected", protected: true, at: NOW, sequence: 1 },
    ]);
  });

  it("clears without letting a late restore resurrect old events", async () => {
    let finishRead!: (value: unknown) => void;
    const storage = {
      read: () => new Promise((resolve) => (finishRead = resolve)),
      write: vi.fn(async (_events: ConnectionEvent[]) => undefined),
    };
    const journal = new ConnectionJournal({ storage, now: () => NOW });
    journal.record({ event: "command", action: "connect" });
    journal.clear();
    journal.record({ event: "command", action: "disconnect" });
    finishRead([{ event: "state", status: "connected", at: NOW, sequence: 4 }]);
    expect(await journal.snapshot()).toEqual([
      { event: "command", action: "disconnect", at: NOW, sequence: 1 },
    ]);
    journal.clear();
    expect(await journal.snapshot()).toEqual([]);
    await vi.waitFor(() => expect(storage.write).toHaveBeenLastCalledWith([]));
  });

  it("exports copies and handles a stored sequence at its bound", async () => {
    const f = fixture([{ event: "state", at: NOW, sequence: 1_000_000_000 }]);
    const old = await f.journal.snapshot();
    old[0]!.event = "failure";
    f.journal.record({ event: "command", action: "get_snapshot" });
    expect(await f.journal.snapshot()).toEqual([
      { event: "state", at: NOW, sequence: 1 },
      { event: "command", action: "get_snapshot", at: NOW, sequence: 2 },
    ]);
  });

  it("drops pre-clear command completions and operation traces while accepting new commands", async () => {
    const f = fixture();
    await f.journal.initialize();
    const oldCommand = f.journal.capture();
    oldCommand({ event: "command", action: "connect", phase: "start" });
    oldCommand({ event: "target", operation: 7, source: "requested" });
    f.journal.clear();
    oldCommand({ event: "command", action: "connect", phase: "end" });
    oldCommand({ event: "failure", operation: 7, error: "network_error" });
    expect(await f.journal.snapshot()).toEqual([]);
    f.journal.capture()({ event: "command", action: "disconnect", phase: "end" });
    f.journal.capture()({ event: "target", operation: 7, source: "automatic" });
    expect(await f.journal.snapshot()).toEqual([
      expect.objectContaining({ event: "command", action: "disconnect" }),
      expect.objectContaining({ event: "target", operation: 7 }),
    ]);
  });

  it("invalidates work cleared before its first trace without retiring a reused operation ID", async () => {
    const f = fixture();
    await f.journal.initialize();
    const oldOperation = f.journal.capture();
    f.journal.clear();
    oldOperation({ event: "catalog", operation: 1, count: 2 });
    oldOperation({ event: "target", operation: 1, source: "requested" });
    expect(await f.journal.snapshot()).toEqual([]);
    f.journal.capture()({ event: "catalog", operation: 1, count: 3 });
    expect(await f.journal.snapshot()).toEqual([
      expect.objectContaining({ event: "catalog", operation: 1, count: 3 }),
    ]);
  });

  it("accepts current work regardless of a previous worker's operation numbers", async () => {
    const previousWorker = fixture();
    await previousWorker.journal.initialize();
    previousWorker.journal.record({ event: "target", operation: 20, source: "requested" });
    await previousWorker.journal.pruneExpired();

    const restartedWorker = fixture(previousWorker.stored());
    expect(await restartedWorker.journal.snapshot()).toEqual([
      expect.objectContaining({ event: "target", operation: 20 }),
    ]);
    restartedWorker.journal.clear();
    restartedWorker.journal.capture()({ event: "command", action: "connect", phase: "start" });
    restartedWorker.journal.record({ event: "target", operation: 2, source: "requested" });
    expect(await restartedWorker.journal.snapshot()).toEqual([
      expect.objectContaining({ event: "command", action: "connect" }),
      expect.objectContaining({ event: "target", operation: 2 }),
    ]);
  });

  it("invalidates captured work while an old journal is restoring and accepts a reused ID", async () => {
    let finishRead!: (value: unknown) => void;
    const journal = new ConnectionJournal({
      storage: {
        read: () => new Promise((resolve) => (finishRead = resolve)),
        write: async () => undefined,
      },
      now: () => NOW,
    });
    const oldCompletion = journal.capture();
    oldCompletion({ event: "target", operation: 1, source: "requested" });
    finishRead([{ event: "target", operation: 20, at: NOW, sequence: 20 }]);
    await journal.initialize();
    journal.clear();
    oldCompletion({ event: "command", action: "connect", phase: "end" });
    oldCompletion({ event: "failure", operation: 1, error: "network_error" });
    journal.capture()({ event: "target", operation: 1, source: "automatic" });
    expect(await journal.snapshot()).toEqual([
      expect.objectContaining({ event: "target", operation: 1 }),
    ]);
  });

  it("purges session storage on its maintenance deadline without a new snapshot or event", async () => {
    const f = fixture([{ event: "failure", error: "network_error", at: NOW, sequence: 1 }]);
    await f.journal.initialize();
    await vi.waitFor(() => expect(f.options.storage.write).toHaveBeenCalled());
    expect(f.journal.nextExpiry()).toBe(NOW + 600_001);
    f.setNow(NOW + 600_001);
    await f.journal.pruneExpired();
    expect(f.stored()).toEqual([]);
    expect(f.journal.nextExpiry()).toBeNull();
  });

  it("keeps a bounded maintenance retry after a failed purge and persists it on recovery", async () => {
    const f = fixture();
    await f.journal.initialize();
    f.journal.record({ event: "failure", error: "network_error" });
    await vi.waitFor(() => expect(f.stored()).toHaveLength(1));
    f.setNow(NOW + 600_001);
    const write = f.options.storage.write.getMockImplementation()!;
    f.options.storage.write.mockRejectedValueOnce(new Error("storage_unavailable"));
    await f.journal.pruneExpired();
    expect(f.stored()).toHaveLength(1);
    expect(f.journal.count()).toBe(0);
    expect(f.journal.nextExpiry()).toBe(NOW + 660_001);
    f.options.storage.write.mockImplementation(write);
    await f.journal.pruneExpired();
    expect(f.stored()).toEqual([]);
    expect(f.journal.nextExpiry()).toBeNull();
  });

  it("coalesces writes during slow storage and cannot queue an old snapshot after a clear", async () => {
    const f = fixture();
    await f.journal.initialize();
    await vi.waitFor(() => expect(f.options.storage.write).toHaveBeenCalledTimes(1));
    let finish!: () => void;
    const original = f.options.storage.write.getMockImplementation()!;
    f.options.storage.write.mockImplementationOnce(async (events) => {
      await new Promise<void>((resolve) => (finish = resolve));
      await original(events);
    });
    f.journal.record({ event: "command", action: "connect" });
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    for (let index = 0; index < 1_000; index++)
      f.journal.record({ event: "catalog", count: index });
    f.journal.clear();
    finish();
    await f.journal.pruneExpired();
    expect(f.stored()).toEqual([]);
    expect(f.options.storage.write).toHaveBeenCalledTimes(3);
  });
});
