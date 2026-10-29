// SPDX-License-Identifier: MPL-2.0

import { DiagnosticDelivery } from "../../src/core/diagnostics/delivery";
import {
  serializeDiagnosticReport,
  type DiagnosticReport,
} from "../../src/core/shared/diagnostic-report";

const HOUR = 3_600_000;
const TTL = 24 * HOUR;
const QUEUED = Date.parse("2026-10-28T00:00:00Z");
const DEADLINE = QUEUED + TTL;
const OWNER = "synthetic-owner";
const id = (number: number) => `a1000000-0000-4000-8000-${String(number).padStart(12, "0")}`;

function report(number: number): DiagnosticReport {
  return {
    schema_version: 1,
    report_id: id(number),
    report_type: "full",
    platform: "chrome_extension",
    app_version: "0.9.2",
    created_at: new Date(QUEUED).toISOString(),
    consent: { mode: "manual", notice_version: 1 },
    state: "disconnected",
    occurrences: 1,
    truncated: false,
    dropped_events: 0,
  };
}

function entry(number: number, queuedAt: number) {
  return {
    ownerId: OWNER,
    id: id(number),
    body: serializeDiagnosticReport(report(number)),
    queuedAt,
    expiresAt: queuedAt + TTL,
    status: "pending",
    attempts: 0,
    nextAttemptAt: queuedAt,
  };
}

interface StoredFixture {
  accounts: { ownerId: string; attempts: number[] }[];
  reports: { id: string; status: string; attempts: number }[];
}

const persisted = (value: unknown) => structuredClone(value) as StoredFixture;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** A durable report becomes due one second before its 24-hour retention deadline. */
function fixture(reports = [entry(1, QUEUED)]) {
  const state = {
    now: DEADLINE - 1_000,
    stored: { version: 1, accounts: [], reports } as unknown,
  };
  const fetchTimes: number[] = [];
  const fetcher = vi.fn<typeof fetch>(async () => {
    fetchTimes.push(state.now);
    return new Response("{}", { status: 503 });
  });
  const write = vi.fn(async (value: unknown) => {
    state.stored = structuredClone(value);
  });
  const canSendDiagnostics = vi.fn(async () => true);
  const delivery = new DiagnosticDelivery({
    read: async () => structuredClone(state.stored),
    write,
    getAccount: () => ({
      ownerId: OWNER,
      token: "synthetic-token",
      generation: 1,
      expiresAt: QUEUED + 3 * TTL,
    }),
    now: () => state.now,
    random: () => 0,
    fetch: fetcher,
    canSendDiagnostics,
    onChanged() {},
    schedule: async () => {},
  });
  return { state, fetcher, fetchTimes, write, canSendDiagnostics, delivery };
}

/** Holds the first durable write of a claimed report until released. */
function holdClaimWrite(f: ReturnType<typeof fixture>) {
  const started = deferred<undefined>();
  const release = deferred<undefined>();
  let held = false;
  f.write.mockImplementation(async (value) => {
    if (!held && persisted(value).reports.some((saved) => saved.status === "sending")) {
      held = true;
      started.resolve(undefined);
      await release.promise;
    }
    f.state.stored = structuredClone(value);
  });
  return { started: started.promise, release: () => release.resolve(undefined) };
}

describe("diagnostic delivery retention deadline", () => {
  it("purges a report already expired before its claim without sending it", async () => {
    const f = fixture();
    await f.delivery.initialize();
    f.state.now = DEADLINE + 1_000;
    await f.delivery.pump();
    expect(f.fetcher).not.toHaveBeenCalled();
    expect(persisted(f.state.stored).reports).toEqual([]);
  });

  it("does not claim a report that expires while the claim reads native consent", async () => {
    const f = fixture();
    await f.delivery.initialize();
    const started = deferred<undefined>();
    const consent = deferred<boolean>();
    f.canSendDiagnostics.mockImplementationOnce(async () => {
      started.resolve(undefined);
      return consent.promise;
    });
    const pumping = f.delivery.pump();
    await started.promise;
    f.state.now = DEADLINE + 1_000;
    consent.resolve(true);
    await pumping;
    expect(f.fetcher).not.toHaveBeenCalled();
    // The expired report is purged by the claim itself, never persisted as an attempt.
    const written = f.write.mock.calls.map(([value]) => persisted(value).reports);
    expect(written.flat().filter((saved) => saved.status === "sending")).toEqual([]);
    expect(persisted(f.state.stored).reports).toEqual([]);
    expect(persisted(f.state.stored).accounts[0]!.attempts).toEqual([]);
  });

  it("does not start a request when the report expires during the durable claim write", async () => {
    const f = fixture();
    await f.delivery.initialize();
    const claim = holdClaimWrite(f);
    const pumping = f.delivery.pump();
    await claim.started;
    f.state.now = DEADLINE + 1_000;
    claim.release();
    await pumping;
    expect(f.fetcher).not.toHaveBeenCalled();
    expect(persisted(f.state.stored).reports).toEqual([]);
    // No request left the extension: the hourly upload quota is returned.
    expect(persisted(f.state.stored).accounts[0]!.attempts).toEqual([]);
  });

  it("re-checks retention after the final delivery consent read", async () => {
    const f = fixture();
    await f.delivery.initialize();
    const started = deferred<undefined>();
    const consent = deferred<boolean>();
    f.canSendDiagnostics.mockResolvedValueOnce(true).mockImplementationOnce(async () => {
      started.resolve(undefined);
      return consent.promise;
    });
    const pumping = f.delivery.pump();
    await started.promise;
    f.state.now = DEADLINE + 1_000;
    consent.resolve(true);
    await pumping;
    expect(f.fetcher).not.toHaveBeenCalled();
    expect(persisted(f.state.stored).reports).toEqual([]);
    expect(persisted(f.state.stored).accounts[0]!.attempts).toEqual([]);
  });

  it("still sends a fresher report in the same pass, charging only its own attempt", async () => {
    const fresh = entry(2, DEADLINE - HOUR);
    const f = fixture([entry(1, QUEUED), fresh]);
    await f.delivery.initialize();
    const claim = holdClaimWrite(f);
    const pumping = f.delivery.pump();
    await claim.started;
    f.state.now = DEADLINE + 1_000;
    claim.release();
    await pumping;
    expect(f.fetcher).toHaveBeenCalledOnce();
    expect(f.fetcher.mock.calls[0]![1]?.body).toBe(fresh.body);
    const stored = persisted(f.state.stored);
    expect(stored.reports).toMatchObject([{ id: id(2), status: "pending", attempts: 1 }]);
    expect(stored.accounts[0]!.attempts).toEqual([DEADLINE + 1_000]);
  });

  it("keeps a request invoked before the deadline as a prior attempt when its response is late", async () => {
    const f = fixture();
    await f.delivery.initialize();
    const started = deferred<undefined>();
    const response = deferred<Response>();
    f.fetcher.mockImplementationOnce(async () => {
      f.fetchTimes.push(f.state.now);
      started.resolve(undefined);
      return response.promise;
    });
    const pumping = f.delivery.pump();
    await started.promise;
    f.state.now = DEADLINE + 1_000;
    response.resolve(new Response("{}", { status: 503 }));
    await pumping;
    expect(f.fetcher).toHaveBeenCalledOnce();
    expect(f.fetchTimes).toEqual([DEADLINE - 1_000]);
    expect(persisted(f.state.stored).reports).toEqual([]);
    expect(persisted(f.state.stored).accounts[0]!.attempts).toEqual([DEADLINE - 1_000]);
  });
});
