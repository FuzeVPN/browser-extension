// SPDX-License-Identifier: MPL-2.0

import { DiagnosticHistory } from "../../src/core/diagnostics/history";
import type { DiagnosticEvent } from "../../src/core/shared/diagnostic-report";

const NOW = Date.parse("2026-09-16T12:00:00Z");
const event = (stage: DiagnosticEvent["stage"] = "startup"): DiagnosticEvent => ({
  source: "controller",
  stage,
  event: "begin",
  offset_ms: 0,
});

function fixture(initial?: unknown) {
  let now = NOW;
  let stored: unknown = initial;
  const writes: unknown[] = [];
  const dependencies = {
    read: vi.fn(async () => structuredClone(stored)),
    write: vi.fn(async (value: unknown) => {
      stored = structuredClone(value);
      writes.push(stored);
    }),
    now: () => now,
  };
  return {
    history: new DiagnosticHistory(dependencies),
    dependencies,
    writes,
    stored: () => stored,
    setNow: (value: number) => {
      now = value;
    },
  };
}

describe("bounded diagnostic history", () => {
  it("retains the latest 200 events and reports removed events", async () => {
    const f = fixture();
    await f.history.initialize("owner-a");
    for (let index = 0; index < 201; index++) {
      f.setNow(NOW + index);
      await f.history.record(event(index === 0 ? "authentication" : "cleanup"));
    }
    const snapshot = f.history.snapshot();
    expect(snapshot.events).toHaveLength(200);
    expect(snapshot.events.every((item) => item.stage === "cleanup")).toBe(true);
    expect(snapshot.events[0]!.offset_ms).toBe(0);
    expect(snapshot.events[199]!.offset_ms).toBe(199);
    expect(snapshot.dropped).toBe(1);
  });

  it("retains the ten-minute boundary and removes older events", async () => {
    const f = fixture();
    await f.history.initialize("owner-a");
    await f.history.record(event("authentication"));
    f.setNow(NOW + 600_000);
    await f.history.record(event("cleanup"));
    expect(f.history.snapshot().events.map((item) => item.offset_ms)).toEqual([0, 600_000]);
    f.setNow(NOW + 600_001);
    expect(f.history.snapshot().events).toEqual([event("cleanup")]);
  });

  it("expires the dropped-event count when only a new window remains", async () => {
    const f = fixture();
    await f.history.initialize("owner-a");
    for (let index = 0; index < 201; index++) await f.history.record(event());
    f.setNow(NOW + 600_000);
    await f.history.record(event("cleanup"));
    f.setNow(NOW + 600_001);
    expect(f.history.snapshot()).toEqual({ events: [event("cleanup")], dropped: 0 });
  });

  it("clears persisted and in-memory history when changing accounts", async () => {
    const f = fixture();
    await f.history.initialize("owner-a");
    await f.history.record(event());
    await f.history.clear("owner-b");
    expect(f.history.snapshot()).toEqual({ events: [], dropped: 0 });
    const restored = new DiagnosticHistory(f.dependencies);
    await restored.initialize("owner-b");
    expect(restored.snapshot()).toEqual({ events: [], dropped: 0 });
    expect(JSON.stringify(f.stored())).not.toContain("owner-a");
  });

  it("does not restore another account's events", async () => {
    const f = fixture({ owner: "owner-a", items: [{ at: NOW, event: event() }], dropped: 1 });
    await f.history.initialize("owner-b");
    expect(f.history.snapshot()).toEqual({ events: [], dropped: 0 });
    expect(f.stored()).toEqual({ owner: "owner-b", items: [], losses: [] });
  });

  it("purges persisted events and loss buckets at the next expiry without recording another event", async () => {
    const f = fixture();
    await f.history.initialize("owner-a");
    for (let index = 0; index < 201; index++) await f.history.record(event());
    expect(f.history.nextExpiry()).toBe(NOW + 600_001);
    f.setNow(NOW + 600_001);
    await f.history.pruneExpired();
    expect(f.stored()).toEqual({ owner: "owner-a", items: [], losses: [] });
    expect(f.history.nextExpiry()).toBeNull();
    const writes = f.writes.length;
    await f.history.pruneExpired();
    expect(f.writes).toHaveLength(writes);
  });

  it("persists pruning triggered by a snapshot and retries a failed purge", async () => {
    const f = fixture();
    await f.history.initialize("owner-a");
    await f.history.record(event());
    f.setNow(NOW + 600_001);
    f.dependencies.write.mockRejectedValueOnce(new Error("storage_unavailable"));
    expect(f.history.snapshot()).toEqual({ events: [], dropped: 0 });
    await vi.waitFor(() => expect(f.dependencies.write).toHaveBeenCalledTimes(3));
    expect(f.history.nextExpiry()).toBe(NOW + 660_001);
    await f.history.pruneExpired();
    expect(f.stored()).toEqual({ owner: "owner-a", items: [], losses: [] });
    expect(f.history.nextExpiry()).toBeNull();
  });

  it("reconstructs a corrupt stored event without secrets, absolute offsets or arbitrary metadata", async () => {
    const f = fixture({
      owner: "owner-a",
      token: "sensitive-token",
      items: [
        {
          at: NOW - 50,
          event: {
            ...event(),
            source: "sensitive-source",
            offset_ms: NOW,
            code: "sensitive-code",
            message: "sensitive-message",
            ip: "192.0.2.55",
            domain: "private.example.invalid",
            duration_ms: 0,
            http_status: 429,
            span_id: "sensitive-id",
          },
          password: "sensitive-password",
        },
      ],
      dropped: 0,
    });
    await f.history.initialize("owner-a");
    expect(f.history.snapshot()).toEqual({
      events: [{ ...event(), duration_ms: 0, http_status: 429 }],
      dropped: 0,
    });
    const stored = JSON.stringify(f.stored());
    for (const secret of ["sensitive", "192.0.2.55", "private.example.invalid"])
      expect(stored).not.toContain(secret);
  });

  it("rejects malformed event types instead of coercing arrays to vocabulary", async () => {
    const f = fixture({
      owner: "owner-a",
      items: [{ at: NOW, event: { ...event(), event: ["begin"] } }],
      dropped: 0,
    });
    await f.history.initialize("owner-a");
    expect(f.history.snapshot().events).toEqual([]);
  });

  it("drops invalid timestamps, future observations and unknown stages", async () => {
    const f = fixture({
      owner: "owner-a",
      items: [
        { at: NaN, event: event() },
        { at: NOW + 1, event: event() },
        { at: NOW - 600_001, event: event() },
        { at: NOW, event: { ...event(), stage: "sensitive-stage" } },
        { at: NOW - 1, event: event("cleanup") },
      ],
      dropped: 0,
    });
    await f.history.initialize("owner-a");
    expect(f.history.snapshot().events).toEqual([event("cleanup")]);
  });

  it("restores offset chronology from local event times, not stored wire offsets", async () => {
    const f = fixture({
      owner: "owner-a",
      items: [
        { at: NOW - 100, event: { ...event(), offset_ms: 99999 } },
        { at: NOW - 25, event: { ...event("cleanup"), offset_ms: 1 } },
      ],
      dropped: 0,
    });
    await f.history.initialize("owner-a");
    expect(f.history.snapshot().events.map((item) => item.offset_ms)).toEqual([0, 75]);
  });

  it("does not let a caller mutate the retained history through a snapshot", async () => {
    const f = fixture();
    await f.history.initialize("owner-a");
    await f.history.record(event());
    const snapshot = f.history.snapshot();
    snapshot.events[0]!.stage = "cleanup";
    snapshot.events.push(event());
    expect(f.history.snapshot().events).toEqual([event()]);
  });

  it("recovers the persistence chain after one rejected write", async () => {
    const f = fixture();
    await f.history.initialize("owner-a");
    f.dependencies.write.mockRejectedValueOnce(new Error("storage_unavailable"));
    await expect(f.history.record(event())).rejects.toThrow("storage_unavailable");
    await f.history.record(event("cleanup"));
    const restored = new DiagnosticHistory(f.dependencies);
    await restored.initialize("owner-a");
    expect(restored.snapshot().events.map((item) => item.stage)).toEqual(["startup", "cleanup"]);
  });
});
