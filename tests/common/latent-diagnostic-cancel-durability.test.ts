// SPDX-License-Identifier: MPL-2.0

import { DiagnosticDelivery, type DiagnosticAccount } from "../../src/core/diagnostics/delivery";
import type { DiagnosticReport } from "../../src/core/shared/diagnostic-report";

const NOW = Date.parse("2026-09-16T12:00:00Z");
const HOUR = 3_600_000;
const OWNER = "synthetic-account";
const REPORT_ID = "a1000000-0000-4000-8000-000000000001";

function report(): DiagnosticReport {
  return {
    schema_version: 1,
    report_id: REPORT_ID,
    report_type: "simple",
    platform: "chrome_extension",
    app_version: "0.5.5",
    created_at: new Date(NOW).toISOString(),
    consent: { mode: "manual", notice_version: 1 },
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

describe("a diagnostic report withdrawn while storage is failing", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it.each(["cancel", "remove"] as const)(
    "is listed as withdrawn by %s only once the next worker cannot deliver it",
    async (action) => {
      const f = fixture();
      const withdraw = () => f.delivery[action](REPORT_ID, OWNER);
      await f.delivery.enqueue(report(), OWNER);
      await f.delivery.pump();
      // The first upload was refused: the report waits for its next attempt.
      expect(f.fetcher).toHaveBeenCalledOnce();
      const queued = (f.state.stored as Stored).reports[0]!;
      expect(queued).toMatchObject({ id: REPORT_ID, status: "pending" });
      f.fetcher.mockClear();

      f.write.mockRejectedValueOnce(new Error("quota exceeded"));
      await expect(withdraw()).rejects.toMatchObject({ code: "storage_unavailable" });
      // Nothing durable records the refused command: the report still shows as queued.
      expect(f.delivery.list(OWNER).map((entry) => entry.status)).toEqual(["pending"]);
      expect((f.state.stored as Stored).reports[0]).toMatchObject({ status: "pending" });

      // Repeated once storage accepts the write, the command is durable.
      await withdraw();
      expect(f.delivery.list(OWNER).map((entry) => entry.status)).toEqual(
        action === "cancel" ? ["cancelled"] : [],
      );

      // The worker stops; the next one starts from storage alone, at the retry deadline.
      f.state.now = queued.nextAttemptAt!;
      const restarted = new DiagnosticDelivery(f.options);
      await restarted.pump();
      expect(f.fetcher).not.toHaveBeenCalled();
      expect(restarted.list(OWNER).map((entry) => entry.status)).toEqual(
        action === "cancel" ? ["cancelled"] : [],
      );
    },
  );
});
