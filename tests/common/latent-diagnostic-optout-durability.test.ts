// SPDX-License-Identifier: MPL-2.0

import { DiagnosticDelivery, type DiagnosticAccount } from "../../src/core/diagnostics/delivery";
import type { DiagnosticReport } from "../../src/core/shared/diagnostic-report";

const NOW = Date.parse("2026-09-16T12:00:00Z");
const HOUR = 3_600_000;
const OWNER = "synthetic-account";
const REPORT_ID = "a1000000-0000-4000-8000-000000000001";

function automaticReport(): DiagnosticReport {
  return {
    schema_version: 1,
    report_id: REPORT_ID,
    report_type: "simple",
    platform: "chrome_extension",
    app_version: "0.5.5",
    created_at: new Date(NOW).toISOString(),
    consent: { mode: "automatic_opt_in", notice_version: 1 },
    protocol: "browser_proxy",
    state: "error",
    occurrences: 1,
    error: {
      domain: "proxy",
      code: "proxy_unavailable",
      operation: "connect",
      stage: "proxy_configuration",
    },
    truncated: false,
    dropped_events: 0,
  };
}

interface Stored {
  accounts: { ownerId: string; automatic: boolean }[];
  reports: { id: string; status: string; nextAttemptAt: number | null }[];
}

function fixture() {
  const state = { now: NOW, stored: undefined as unknown };
  const account: DiagnosticAccount = {
    ownerId: OWNER,
    token: "synthetic-token-one",
    expiresAt: NOW + 7 * 24 * HOUR,
    generation: 1,
  };
  const fetcher = vi
    .fn<typeof fetch>()
    .mockImplementation(
      async () => new Response('{"error":"diagnostics_unavailable"}', { status: 503 }),
    );
  const write = vi.fn(async (value: unknown) => {
    state.stored = structuredClone(value);
  });
  const options = {
    read: vi.fn(async () => structuredClone(state.stored)),
    write,
    getAccount: () => account,
    canSendDiagnostics: vi.fn(async () => true),
    now: () => state.now,
    random: () => 0.5,
    fetch: fetcher,
    onChanged: vi.fn(),
    schedule: vi.fn(async (_when: number | null) => {}),
  };
  return { state, fetcher, write, options, delivery: new DiagnosticDelivery(options) };
}

/** An opted-in account whose automatic report was refused once and waits for its retry. */
async function queuedAutomaticReport() {
  const f = fixture();
  await f.delivery.setAuto(OWNER, true);
  await f.delivery.enqueue(automaticReport(), OWNER);
  await f.delivery.pump();
  expect(f.fetcher).toHaveBeenCalledOnce();
  const stored = f.state.stored as Stored;
  expect(stored.accounts).toMatchObject([{ ownerId: OWNER, automatic: true }]);
  expect(stored.reports).toMatchObject([{ id: REPORT_ID, status: "pending" }]);
  expect(f.delivery.getAuto(OWNER)).toBe(true);
  f.fetcher.mockClear();
  return { ...f, retryAt: stored.reports[0]!.nextAttemptAt! };
}

describe("an automatic-reporting opt-out while storage is failing", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("is shown as effective only if the next worker neither opts back in nor uploads", async () => {
    const f = await queuedAutomaticReport();

    f.write.mockRejectedValueOnce(new Error("quota exceeded"));
    await expect(f.delivery.setAuto(OWNER, false)).rejects.toMatchObject({
      code: "storage_unavailable",
    });
    // Nothing durable records the refused opt-out: storage still holds the opt-in
    // and the queued automatic report.
    const stored = f.state.stored as Stored;
    expect(stored.accounts).toMatchObject([{ automatic: true }]);
    expect(stored.reports).toMatchObject([{ id: REPORT_ID, status: "pending" }]);
    // What this worker displays after the refused command, once it is idle again.
    await f.delivery.pump();
    expect(f.fetcher).not.toHaveBeenCalled();
    const displayedOptIn = f.delivery.getAuto(OWNER);
    // The refused opt-out is not presented as effective.
    expect(displayedOptIn).toBe(true);
    expect(f.delivery.list(OWNER).map((entry) => entry.status)).toEqual(["pending"]);

    // The worker stops; the next one starts from storage alone, at the retry deadline.
    f.state.now = f.retryAt;
    const restarted = new DiagnosticDelivery(f.options);
    await restarted.pump();
    expect({
      optedIn: restarted.getAuto(OWNER),
      uploads: f.fetcher.mock.calls.length,
    }).toEqual(displayedOptIn ? { optedIn: true, uploads: 1 } : { optedIn: false, uploads: 0 });
  });

  it("holds in the next worker once storage accepted it", async () => {
    const f = await queuedAutomaticReport();

    await f.delivery.setAuto(OWNER, false);
    expect(f.delivery.getAuto(OWNER)).toBe(false);
    expect(f.delivery.list(OWNER)).toEqual([]);

    f.state.now = f.retryAt;
    const restarted = new DiagnosticDelivery(f.options);
    await restarted.pump();
    expect(restarted.getAuto(OWNER)).toBe(false);
    expect(restarted.list(OWNER)).toEqual([]);
    expect(f.fetcher).not.toHaveBeenCalled();
  });
});
