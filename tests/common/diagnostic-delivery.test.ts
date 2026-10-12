// SPDX-License-Identifier: MPL-2.0

import {
  DiagnosticDelivery,
  DiagnosticDeliveryError,
  type DiagnosticAccount,
} from "../../src/core/diagnostics/delivery";
import {
  serializeDiagnosticReport,
  type DiagnosticReport,
} from "../../src/core/shared/diagnostic-report";

const NOW = Date.parse("2026-09-16T12:00:00Z");
const HOUR = 3_600_000;
const OWNER = "synthetic-account";
const id = (number: number) => `a1000000-0000-4000-8000-${String(number).padStart(12, "0")}`;

function report(number = 1, automatic = false): DiagnosticReport {
  return {
    schema_version: 1,
    report_id: id(number),
    report_type: "simple",
    platform: "chrome_extension",
    app_version: "0.5.5",
    created_at: new Date(NOW).toISOString(),
    consent: { mode: automatic ? "automatic_opt_in" : "manual", notice_version: 1 },
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

function receipt(clientId: string, duplicate = false) {
  return {
    report_id: "b1000000-0000-4000-8000-000000000001",
    client_report_id: clientId,
    received_at: new Date(NOW).toISOString(),
    expires_at: new Date(NOW + 30 * 24 * HOUR).toISOString(),
    status: "received",
    duplicate,
  };
}

function fullReport(number: number): DiagnosticReport {
  return {
    ...report(number),
    report_type: "full",
    events: Array.from({ length: 200 }, (_, index) => ({
      source: "controller",
      stage: "certificate_renewal",
      event: "error",
      offset_ms: index * 3_000,
      duration_ms: 604_800_000,
      code: "proxy_controlled_by_extension",
      http_status: 503,
      span_id: 2_000,
      parent_span_id: 1_999,
    })),
    checks: Array.from({ length: 64 }, () => ({
      id: "tunnel_configuration",
      result: "failed",
      code: "proxy_controlled_by_extension",
      duration_ms: 604_800_000,
      age_ms: 604_800_000,
    })),
  };
}

interface StoredFixture {
  version: 1;
  accounts: {
    ownerId: string;
    automatic: boolean;
    sessionRequired?: boolean;
    attempts: number[];
    automaticReports: number[];
  }[];
  reports: {
    ownerId: string;
    id: string;
    body: string;
    queuedAt: number;
    expiresAt: number;
    status: string;
    attempts: number;
    nextAttemptAt: number | null;
    receipt?: ReturnType<typeof receipt>;
  }[];
}

const persisted = (value: unknown) => structuredClone(value) as StoredFixture;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function fixture(initial?: unknown) {
  const state = {
    now: NOW,
    stored: initial,
    account: {
      ownerId: OWNER,
      token: "synthetic-token-one",
      expiresAt: NOW + 7 * 24 * HOUR,
      generation: 1,
    } as DiagnosticAccount | null,
  };
  const fetcher = vi
    .fn<typeof fetch>()
    .mockImplementation(
      async () => new Response('{"error":"diagnostics_unavailable"}', { status: 503 }),
    );
  const write = vi.fn(async (value: unknown) => {
    state.stored = structuredClone(value);
  });
  const read = vi.fn(async () => structuredClone(state.stored));
  const schedule = vi.fn(async (_when: number | null) => {});
  const changed = vi.fn();
  const options = {
    read,
    write,
    getAccount: () => state.account,
    canSendDiagnostics: vi.fn(async () => true),
    now: () => state.now,
    random: () => 0.5,
    fetch: fetcher,
    onChanged: changed,
    schedule,
  };
  const delivery = new DiagnosticDelivery(options);
  const flush = async () => {
    await delivery.pump();
  };
  const advance = async (milliseconds: number) => {
    state.now += milliseconds;
    await vi.advanceTimersByTimeAsync(milliseconds);
  };
  return { state, fetcher, write, read, schedule, changed, options, delivery, flush, advance };
}

describe("isolated diagnostic delivery", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it.each(["absent", "unreadable"] as const)(
    "requires Mozilla consent for manual enqueue and automatic opt-in when it is %s",
    async (condition) => {
      const f = fixture();
      f.options.canSendDiagnostics.mockImplementation(async () => {
        if (condition === "unreadable") throw new Error("permission_read_failed");
        return false;
      });
      await expect(f.delivery.enqueue(report(), OWNER)).rejects.toMatchObject({
        code: "data_collection_required",
      });
      await expect(f.delivery.setAuto(OWNER, true)).rejects.toMatchObject({
        code: "data_collection_required",
      });
      await f.delivery.setAuto(OWNER, false);
      await f.flush();
      expect(f.fetcher).not.toHaveBeenCalled();
      expect(persisted(f.state.stored).reports).toHaveLength(0);
      expect(f.delivery.getAuto(OWNER)).toBe(false);
    },
  );

  it.each(["absent", "unreadable"] as const)(
    "does not consume restored HTTP attempts or resume a retry while Mozilla consent is %s",
    async (condition) => {
      const f = fixture();
      await f.delivery.enqueue(report(), OWNER);
      await f.flush();
      const stored = persisted(f.state.stored);
      f.fetcher.mockClear();
      f.state.now = stored.reports[0]!.nextAttemptAt!;
      f.options.canSendDiagnostics.mockImplementation(async () => {
        if (condition === "unreadable") throw new Error("permission_read_failed");
        return false;
      });
      const restored = new DiagnosticDelivery(f.options);
      await restored.pump();
      expect(f.fetcher).not.toHaveBeenCalled();
      expect(persisted(f.state.stored).reports[0]!.attempts).toBe(1);
      expect(restored.list(OWNER)[0]).toMatchObject({
        status: "pending",
        error: "data_collection_required",
        nextAttemptAt: null,
      });
      expect(f.schedule).toHaveBeenLastCalledWith(stored.reports[0]!.expiresAt);
    },
  );

  it("aborts a live upload synchronously on Mozilla revocation and ignores its late receipt", async () => {
    const f = fixture();
    const response = deferred<Response>();
    const started = deferred<undefined>();
    let signal: AbortSignal | undefined;
    f.fetcher.mockImplementation(async (_url, options) => {
      signal = options?.signal ?? undefined;
      started.resolve(undefined);
      return response.promise;
    });
    await f.delivery.enqueue(report(), OWNER);
    await started.promise;
    f.options.canSendDiagnostics.mockResolvedValue(false);
    f.delivery.permissionsRemoved();
    expect(signal?.aborted).toBe(true);
    response.resolve(Response.json(receipt(id(1)), { status: 201 }));
    await f.flush();
    expect(f.delivery.list(OWNER)[0]).toMatchObject({
      status: "pending",
      attempts: 1,
      error: "data_collection_required",
      nextAttemptAt: null,
    });
    await f.advance(HOUR);
    await f.flush();
    expect(f.fetcher).toHaveBeenCalledTimes(1);
    expect(persisted(f.state.stored).reports[0]!.receipt).toBeUndefined();
  });

  it("rejects a permission read begun before revocation even when it later resolves as granted", async () => {
    const f = fixture();
    const reading = deferred<boolean>();
    const started = deferred<undefined>();
    f.options.canSendDiagnostics
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockImplementationOnce(async () => {
        started.resolve(undefined);
        return reading.promise;
      })
      .mockResolvedValue(false);
    await f.delivery.enqueue(report(), OWNER);
    await started.promise;
    f.delivery.permissionsRemoved();
    reading.resolve(true);
    await f.flush();
    expect(f.fetcher).not.toHaveBeenCalled();
    expect(persisted(f.state.stored).reports[0]!.attempts).toBe(0);
    expect(persisted(f.state.stored).accounts[0]!.attempts).toHaveLength(0);
  });

  it("returns the HTTP quota reservation if Mozilla consent is removed while the claim is persisted", async () => {
    const f = fixture();
    const writing = deferred<undefined>();
    const started = deferred<undefined>();
    f.write.mockImplementation(async (value) => {
      if (persisted(value).reports.some((entry) => entry.status === "sending")) {
        started.resolve(undefined);
        await writing.promise;
      }
      f.state.stored = structuredClone(value);
    });
    await f.delivery.enqueue(report(), OWNER);
    await started.promise;
    f.options.canSendDiagnostics.mockResolvedValue(false);
    f.delivery.permissionsRemoved();
    writing.resolve(undefined);
    await f.flush();
    expect(f.fetcher).not.toHaveBeenCalled();
    expect(persisted(f.state.stored).reports[0]!.attempts).toBe(0);
    expect(persisted(f.state.stored).accounts[0]!.attempts).toHaveLength(0);
  });

  it("does not re-enable local automatic consent when Mozilla consent is granted again", async () => {
    const f = fixture();
    await f.delivery.setAuto(OWNER, true);
    f.options.canSendDiagnostics.mockResolvedValue(false);
    f.delivery.permissionsRemoved();
    await f.delivery.setAuto(OWNER, false);
    f.options.canSendDiagnostics.mockResolvedValue(true);
    f.delivery.permissionsChanged();
    await f.flush();
    expect(f.delivery.getAuto(OWNER)).toBe(false);
    await expect(f.delivery.enqueue(report(1, true), OWNER)).rejects.toMatchObject({
      code: "consent_required",
    });
    expect(f.fetcher).not.toHaveBeenCalled();
  });

  it("resumes a frozen manual retry only after Mozilla consent is granted again", async () => {
    const f = fixture();
    await f.delivery.enqueue(report(), OWNER);
    await f.flush();
    const original = f.delivery.getReport(id(1), OWNER);
    f.options.canSendDiagnostics.mockResolvedValue(false);
    f.delivery.permissionsRemoved();
    await f.advance(120_000);
    await f.flush();
    expect(f.fetcher).toHaveBeenCalledTimes(1);
    f.fetcher.mockResolvedValue(Response.json(receipt(id(1)), { status: 201 }));
    f.options.canSendDiagnostics.mockResolvedValue(true);
    f.delivery.permissionsChanged();
    await f.flush();
    expect(f.fetcher).toHaveBeenCalledTimes(2);
    expect(f.delivery.list(OWNER)[0]).toMatchObject({ status: "received", attempts: 2 });
    expect(f.delivery.getReport(id(1), OWNER)).toEqual(original);
  });

  it("persists an immutable closed body before sending and keeps tokens out of storage", async () => {
    const f = fixture();
    const first = report();
    f.fetcher.mockImplementation(async (_url, init) => {
      expect(JSON.stringify(f.state.stored)).toContain('"attempts":1');
      expect(init).toMatchObject({
        method: "POST",
        credentials: "omit",
        redirect: "error",
        referrerPolicy: "no-referrer",
        cache: "no-store",
      });
      return new Response(JSON.stringify(receipt(first.report_id)), { status: 201 });
    });
    await f.delivery.enqueue(first, OWNER);
    first.occurrences = 999;
    await f.flush();
    expect(f.fetcher.mock.calls[0]?.[0]).toBe("https://api.fuzevpn.com/v1/diagnostics");
    expect(new Headers(f.fetcher.mock.calls[0]?.[1]?.headers).get("Authorization")).toBe(
      "Bearer synthetic-token-one",
    );
    expect(JSON.stringify(f.state.stored)).not.toContain("synthetic-token-one");
    expect(f.delivery.getReport(first.report_id, OWNER)?.occurrences).toBe(1);
    expect(f.delivery.list(OWNER)[0]).toMatchObject({
      status: "received",
      attempts: 1,
      receipt: receipt(first.report_id),
      canSend: false,
    });
  });

  it("retries with the same bytes and accepts only the correlated duplicate receipt", async () => {
    const f = fixture();
    await f.delivery.enqueue(report(), OWNER);
    await f.flush();
    const body = f.fetcher.mock.calls[0]?.[1]?.body;
    f.fetcher.mockResolvedValue(
      new Response(JSON.stringify(receipt(id(1), true)), { status: 200 }),
    );
    await f.advance(66_000);
    await f.flush();
    expect(f.fetcher.mock.calls[1]?.[1]?.body).toBe(body);
    expect(f.delivery.list(OWNER)[0]?.receipt?.duplicate).toBe(true);
    await f.delivery.cancel(id(1), OWNER);
    expect(f.delivery.list(OWNER)[0]?.status).toBe("received");
  });

  it("keeps alarm failures separate from durable enqueue and bounds local scheduling retries", async () => {
    const f = fixture();
    f.schedule.mockRejectedValue(new Error("synthetic-alarm-failure"));
    await expect(f.delivery.enqueue(report(), OWNER)).resolves.toBeUndefined();
    await f.flush();
    expect(f.fetcher).toHaveBeenCalledOnce();
    expect(f.delivery.list(OWNER)[0]).toMatchObject({
      status: "pending",
      attempts: 1,
      nextAttemptAt: NOW + 66_000,
    });
    const scheduleCalls = f.schedule.mock.calls.length;
    expect(vi.getTimerCount()).toBe(1);
    await f.advance(59_999);
    expect(f.schedule).toHaveBeenCalledTimes(scheduleCalls);
    expect(f.fetcher).toHaveBeenCalledOnce();
    await f.advance(1);
    expect(f.schedule).toHaveBeenCalledTimes(scheduleCalls + 1);
    expect(f.fetcher).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(1);
    await f.advance(60_000);
    expect(f.fetcher).toHaveBeenCalledTimes(2);
    expect(f.delivery.list(OWNER)[0]).toMatchObject({
      status: "pending",
      attempts: 2,
      nextAttemptAt: NOW + 450_000,
    });
    expect(vi.getTimerCount()).toBe(1);
  });

  it("restores the real alarm and clears its fallback without retrying HTTP before Retry-After", async () => {
    const f = fixture();
    f.schedule.mockRejectedValue(new Error("synthetic-alarm-failure"));
    f.fetcher.mockResolvedValueOnce(
      new Response("{}", { status: 429, headers: { "Retry-After": "600" } }),
    );
    await f.delivery.enqueue(report(), OWNER);
    await f.flush();
    expect(f.delivery.list(OWNER)[0]?.nextAttemptAt).toBe(NOW + 600_000);
    f.schedule.mockResolvedValue(undefined);
    await f.advance(60_000);
    expect(f.fetcher).toHaveBeenCalledOnce();
    expect(f.schedule).toHaveBeenLastCalledWith(NOW + 600_000);
    expect(vi.getTimerCount()).toBe(0);
    await f.advance(540_000);
    await f.flush();
    expect(f.fetcher).toHaveBeenCalledTimes(2);
    expect(new Set(f.fetcher.mock.calls.map((call) => call[1]?.body)).size).toBe(1);
  });

  it("does not resurrect a removed report through a fallback when alarm clearing also fails", async () => {
    const f = fixture();
    f.schedule.mockRejectedValue(new Error("synthetic-alarm-failure"));
    await f.delivery.enqueue(report(), OWNER);
    await f.flush();
    await f.delivery.remove(id(1), OWNER);
    expect(vi.getTimerCount()).toBe(0);
    await f.advance(600_000);
    expect(f.fetcher).toHaveBeenCalledOnce();
    expect(f.delivery.list(OWNER)).toEqual([]);
  });

  it.each(["cancel", "optout", "logout"] as const)(
    "respects %s when a fallback wakes during an alarm outage",
    async (action) => {
      const f = fixture();
      f.schedule.mockRejectedValue(new Error("synthetic-alarm-failure"));
      if (action === "optout") await f.delivery.setAuto(OWNER, true);
      await f.delivery.enqueue(report(1, action === "optout"), OWNER);
      await f.flush();
      expect(f.fetcher).toHaveBeenCalledOnce();
      if (action === "cancel") await f.delivery.cancel(id(1), OWNER);
      else if (action === "optout") await f.delivery.setAuto(OWNER, false);
      else {
        f.state.account = null;
        f.delivery.syncAccount();
        await f.flush();
      }
      await f.advance(120_000);
      expect(f.fetcher).toHaveBeenCalledOnce();
      if (action === "optout") {
        expect(f.delivery.list(OWNER)).toEqual([]);
        expect(vi.getTimerCount()).toBe(0);
      } else
        expect(f.delivery.list(OWNER)[0]?.status).toBe(
          action === "cancel" ? "cancelled" : "session_required",
        );
    },
  );

  it("does not lose a newly queued report while the previous pump is awaiting its alarm update", async () => {
    const f = fixture();
    const scheduling = deferred<undefined>();
    const release = deferred<undefined>();
    const secondQueued = deferred<undefined>();
    const secondSent = deferred<undefined>();
    let delayed = false;
    f.schedule.mockImplementation(async (when) => {
      if (!delayed && when === NOW + 66_000) {
        delayed = true;
        scheduling.resolve(undefined);
        await release.promise;
      }
    });
    f.write.mockImplementation(async (value) => {
      f.state.stored = structuredClone(value);
      if (persisted(value).reports.some((entry) => entry.id === id(2)))
        secondQueued.resolve(undefined);
    });
    f.fetcher.mockImplementation(async (_url, options) => {
      if (typeof options?.body === "string" && options.body.includes(id(2)))
        secondSent.resolve(undefined);
      return new Response("{}", { status: 503 });
    });
    await f.delivery.enqueue(report(), OWNER);
    await scheduling.promise;
    const enqueue = f.delivery.enqueue(report(2), OWNER);
    await secondQueued.promise;
    release.resolve(undefined);
    await enqueue;
    // No external pump or timer: the second accepted enqueue must be handled itself.
    await secondSent.promise;
    expect(f.fetcher).toHaveBeenCalledTimes(2);
    await f.flush();
  });

  it("retains the five-attempt limit and purges expiry during a persistent alarm outage", async () => {
    const f = fixture();
    f.schedule.mockRejectedValue(new Error("synthetic-alarm-failure"));
    await f.delivery.enqueue(report(), OWNER);
    await f.flush();
    // Each wake is separated by a minute; advance the injected clock with it.
    for (let minute = 0; minute < 24 * 60; minute++) await f.advance(60_000);
    expect(f.fetcher).toHaveBeenCalledTimes(5);
    expect(new Set(f.fetcher.mock.calls.map((call) => call[1]?.body)).size).toBe(1);
    expect(f.delivery.list(OWNER)).toEqual([]);
    expect(persisted(f.state.stored).reports).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    { client_report_id: id(2) },
    { report_id: id(1) },
    { report_id: "NOT-UUID" },
    { status: "queued" },
    { duplicate: true },
    { received_at: "yesterday" },
    { received_at: "2026-02-31T12:00:00Z" },
    { received_at: `2026-09-16T12:00:00.${"1".repeat(4_000)}Z` },
    { received_at: "2026-09-16T24:00:00Z" },
    { received_at: "2026-09-16T12:00:00+24:00" },
    { expires_at: new Date(NOW - 1).toISOString() },
    { extra: "not accepted" },
  ])("does not confirm malformed or mismatched success %j", async (patch) => {
    const f = fixture();
    f.fetcher.mockResolvedValue(
      new Response(JSON.stringify({ ...receipt(id(1)), ...patch }), { status: 201 }),
    );
    await f.delivery.enqueue(report(), OWNER);
    await f.flush();
    expect(f.delivery.list(OWNER)[0]).toMatchObject({
      status: "pending",
      error: "delivery_failed",
    });
    expect(f.delivery.list(OWNER)[0]?.receipt).toBeUndefined();
  });

  it.each([400, 404, 409, 413, 415])(
    "stops HTTP %i without retaining server messages",
    async (status) => {
      const f = fixture();
      f.fetcher.mockResolvedValue(
        new Response(
          '{"error":"invalid_diagnostic","message":"raw secret https://private.invalid"}',
          { status },
        ),
      );
      await f.delivery.enqueue(report(), OWNER);
      await f.flush();
      expect(f.delivery.list(OWNER)[0]?.status).toBe(status === 404 ? "expired" : "failed");
      expect(f.delivery.getReport(id(1), OWNER)).not.toBeNull();
      expect(JSON.stringify(f.state.stored)).not.toContain("raw secret");
      await f.advance(HOUR);
      await f.flush();
      expect(f.fetcher).toHaveBeenCalledOnce();
    },
  );

  it("distinguishes missing server content from a temporary 503", async () => {
    const f = fixture();
    f.fetcher.mockResolvedValue(
      new Response('{"error":"diagnostic_content_unavailable"}', { status: 503 }),
    );
    await f.delivery.enqueue(report(), OWNER);
    await f.flush();
    expect(f.delivery.list(OWNER)[0]).toMatchObject({
      status: "failed",
      error: "content_unavailable",
      nextAttemptAt: null,
    });
  });

  it.each(["3600", new Date(NOW + HOUR).toUTCString()])(
    "respects Retry-After %s",
    async (header) => {
      const f = fixture();
      f.fetcher.mockImplementation(
        async () => new Response("{}", { status: 429, headers: { "Retry-After": header } }),
      );
      await f.delivery.enqueue(report(), OWNER);
      await f.flush();
      expect(f.delivery.list(OWNER)[0]?.nextAttemptAt).toBe(NOW + HOUR);
      await f.advance(HOUR - 1);
      await f.flush();
      expect(f.fetcher).toHaveBeenCalledOnce();
      await f.advance(1);
      await f.flush();
      expect(f.fetcher).toHaveBeenCalledTimes(2);
    },
  );

  it("limits retries to five attempts and never resets their immutable payload", async () => {
    const f = fixture();
    await f.delivery.enqueue(report(), OWNER);
    await f.flush();
    for (const delay of [66_000, 330_000, 1_980_000, 7_920_000]) {
      expect(f.delivery.list(OWNER)[0]?.nextAttemptAt).toBe(f.state.now + delay);
      await f.advance(delay);
      await f.flush();
    }
    expect(f.fetcher).toHaveBeenCalledTimes(5);
    expect(f.delivery.list(OWNER)[0]).toMatchObject({ status: "failed", attempts: 5 });
    expect(new Set(f.fetcher.mock.calls.map((call) => call[1]?.body)).size).toBe(1);
  });

  it.each(["86400", "9".repeat(100)])(
    "does not shorten a server delay beyond retention %s",
    async (header) => {
      const f = fixture();
      f.fetcher.mockResolvedValue(
        new Response("{}", { status: 429, headers: { "Retry-After": header } }),
      );
      await f.delivery.enqueue(report(), OWNER);
      await f.flush();
      expect(f.delivery.list(OWNER)[0]).toMatchObject({
        status: "expired",
        nextAttemptAt: null,
        attempts: 1,
      });
      await f.advance(HOUR);
      await f.flush();
      expect(f.fetcher).toHaveBeenCalledOnce();
    },
  );

  it("suspends every queued report after 401 until a different token for the same account", async () => {
    const f = fixture();
    f.fetcher.mockImplementation(async () => new Response("{}", { status: 401 }));
    await f.delivery.enqueue(report(), OWNER);
    await f.flush();
    await f.delivery.enqueue(report(2), OWNER);
    await f.flush();
    expect(f.fetcher).toHaveBeenCalledOnce();
    f.state.account!.generation++;
    f.delivery.syncAccount();
    await f.flush();
    expect(f.fetcher).toHaveBeenCalledOnce();
    f.state.account!.token = "synthetic-token-two";
    f.fetcher.mockImplementation(async (_url, init) => {
      if (typeof init?.body !== "string") throw new Error("Expected a JSON body");
      const body = JSON.parse(init.body) as DiagnosticReport;
      return new Response(JSON.stringify(receipt(body.report_id)), { status: 201 });
    });
    f.delivery.syncAccount();
    await f.flush();
    expect(f.fetcher).toHaveBeenCalledTimes(3);
    expect(f.delivery.list(OWNER).every((entry) => entry.status === "received")).toBe(true);
  });

  it("keeps restored 401 records suspended on the first observed session", async () => {
    const f = fixture();
    f.fetcher.mockResolvedValue(new Response("{}", { status: 401 }));
    await f.delivery.enqueue(report(), OWNER);
    await f.flush();
    const restarted = fixture(f.state.stored);
    await restarted.delivery.initialize();
    restarted.delivery.syncAccount();
    await restarted.flush();
    expect(restarted.fetcher).not.toHaveBeenCalled();
    restarted.state.account!.token = "renewed-after-restart";
    restarted.state.account!.generation++;
    restarted.delivery.syncAccount();
    await restarted.flush();
    expect(restarted.fetcher).toHaveBeenCalledOnce();
  });

  it("never reuses a rejected token after another token has already resumed delivery", async () => {
    const f = fixture();
    f.fetcher.mockResolvedValueOnce(new Response("{}", { status: 401 }));
    await f.delivery.enqueue(report(), OWNER);
    await f.flush();
    f.state.account!.token = "replacement-token";
    f.state.account!.generation++;
    f.delivery.syncAccount();
    await f.flush();
    expect(f.fetcher).toHaveBeenCalledTimes(2);
    f.state.account!.token = "synthetic-token-one";
    f.state.account!.generation++;
    f.delivery.syncAccount();
    await f.delivery.enqueue(report(2), OWNER);
    await f.flush();
    expect(f.fetcher).toHaveBeenCalledTimes(2);
    expect(f.delivery.list(OWNER).every((entry) => entry.status === "session_required")).toBe(true);
  });

  it("retains the account's 401 suspension when the rejected report is removed before restart", async () => {
    const f = fixture();
    f.fetcher.mockImplementation(async () => new Response("{}", { status: 401 }));
    await f.delivery.enqueue(report(), OWNER);
    await f.flush();
    await f.delivery.enqueue(report(2), OWNER);
    await f.delivery.remove(id(1), OWNER);
    await f.flush();
    const restarted = fixture(f.state.stored);
    await restarted.flush();
    expect(restarted.fetcher).not.toHaveBeenCalled();
    expect(restarted.delivery.list(OWNER)[0]).toMatchObject({
      id: id(2),
      status: "session_required",
      attempts: 0,
    });
    restarted.state.account!.token = "newly-observed-token";
    restarted.state.account!.generation++;
    restarted.delivery.syncAccount();
    await restarted.flush();
    expect(restarted.fetcher).toHaveBeenCalledOnce();
  });

  it.each(["cancel", "remove"] as const)(
    "aborts %s synchronously and ignores a late receipt",
    async (action) => {
      const f = fixture();
      const response = deferred<Response>();
      const started = deferred<undefined>();
      let signal: AbortSignal | null | undefined;
      f.fetcher.mockImplementation((_url, init) => {
        signal = init?.signal;
        started.resolve(undefined);
        return response.promise;
      });
      await f.delivery.enqueue(report(), OWNER);
      await started.promise;
      const pending = f.delivery[action](id(1), OWNER);
      expect(signal?.aborted).toBe(true);
      await pending;
      response.resolve(new Response(JSON.stringify(receipt(id(1))), { status: 201 }));
      await f.flush();
      expect(f.delivery.list(OWNER)[0]?.status).toBe(action === "cancel" ? "cancelled" : undefined);
      expect(f.delivery.getReport(id(1), OWNER) === null).toBe(action === "remove");
    },
  );

  it("aborts a switched account without sending its queued report under another owner", async () => {
    const f = fixture();
    const response = deferred<Response>();
    const started = deferred<undefined>();
    let signal: AbortSignal | null | undefined;
    f.fetcher.mockImplementation((_url, init) => {
      signal = init?.signal;
      started.resolve(undefined);
      return response.promise;
    });
    await f.delivery.enqueue(report(), OWNER);
    await started.promise;
    f.state.account = {
      ...f.state.account!,
      ownerId: "other-owner",
      token: "other-token",
      generation: 2,
    };
    f.delivery.syncAccount();
    expect(signal?.aborted).toBe(true);
    response.resolve(new Response(JSON.stringify(receipt(id(1))), { status: 201 }));
    await f.flush();
    expect(f.delivery.list("other-owner")).toEqual([]);
    expect(f.delivery.getReport(id(1), "other-owner")).toBeNull();
    expect(f.fetcher).toHaveBeenCalledOnce();
    expect(f.delivery.list(OWNER)[0]?.status).toBe("session_required");
  });

  it("requires automatic consent and disabling it purges only pending automatic reports", async () => {
    const f = fixture();
    await expect(f.delivery.enqueue(report(1, true), OWNER)).rejects.toMatchObject({
      code: "consent_required",
    });
    await f.delivery.setAuto(OWNER, true);
    await f.delivery.enqueue(report(1, true), OWNER);
    await f.delivery.enqueue(report(2), OWNER);
    await f.flush();
    await f.delivery.setAuto(OWNER, false);
    await f.flush();
    expect(f.delivery.getAuto(OWNER)).toBe(false);
    expect(f.delivery.getReport(id(1), OWNER)).toBeNull();
    expect(f.delivery.getReport(id(2), OWNER)).not.toBeNull();
    expect(JSON.stringify(f.state.stored)).not.toContain("synthetic-token");
  });

  it("aborts an automatic upload immediately on opt-out and preserves a received automatic report", async () => {
    const f = fixture();
    await f.delivery.setAuto(OWNER, true);
    f.fetcher.mockResolvedValueOnce(new Response(JSON.stringify(receipt(id(1))), { status: 201 }));
    await f.delivery.enqueue(report(1, true), OWNER);
    await f.flush();
    const started = deferred<undefined>();
    let signal: AbortSignal | null | undefined;
    f.fetcher.mockImplementation((_url, init) => {
      signal = init?.signal;
      started.resolve(undefined);
      return new Promise(() => undefined);
    });
    await f.delivery.enqueue(report(2, true), OWNER);
    await started.promise;
    const disabled = f.delivery.setAuto(OWNER, false);
    expect(signal?.aborted).toBe(true);
    await disabled;
    await f.flush();
    expect(f.delivery.list(OWNER)).toMatchObject([{ id: id(1), status: "received" }]);
  });

  it("keeps the five-new-automatic-per-hour quota after cancellation or deletion", async () => {
    const f = fixture();
    await f.delivery.setAuto(OWNER, true);
    for (let index = 1; index <= 5; index++) {
      await f.delivery.enqueue(report(index, true), OWNER);
      await f.flush();
      await f.delivery.remove(id(index), OWNER);
    }
    await expect(f.delivery.enqueue(report(6, true), OWNER)).rejects.toMatchObject({
      code: "queue_full",
    });
    await f.advance(HOUR);
    await f.delivery.enqueue(report(6, true), OWNER);
    await f.flush();
    expect(f.delivery.getReport(id(6), OWNER)).not.toBeNull();
  });

  it("shares the ten-attempts-per-hour budget across different reports", async () => {
    const f = fixture();
    f.fetcher.mockImplementation(async () => new Response("{}", { status: 400 }));
    for (let index = 1; index <= 12; index++) {
      await f.delivery.enqueue(report(index), OWNER);
      await f.flush();
    }
    expect(f.fetcher).toHaveBeenCalledTimes(10);
    expect(
      f.delivery
        .list(OWNER)
        .filter((entry) => entry.status === "pending")
        .every((entry) => entry.nextAttemptAt === NOW + HOUR),
    ).toBe(true);
    await f.advance(HOUR);
    await f.flush();
    expect(f.fetcher).toHaveBeenCalledTimes(12);
  });

  it("never has two simultaneous transmissions", async () => {
    const f = fixture();
    const first = deferred<Response>();
    const started = deferred<undefined>();
    f.fetcher.mockImplementationOnce(() => {
      started.resolve(undefined);
      return first.promise;
    });
    await f.delivery.enqueue(report(), OWNER);
    await started.promise;
    await f.delivery.enqueue(report(2), OWNER);
    expect(f.fetcher).toHaveBeenCalledOnce();
    first.resolve(new Response("{}", { status: 400 }));
    await f.flush();
    expect(f.fetcher).toHaveBeenCalledTimes(2);
  });

  it.each([200, 401, 429])(
    "bounds a stalled HTTP %i response body while preserving useful headers",
    async (status) => {
      const f = fixture();
      const started = deferred<undefined>();
      let cancelled = false;
      f.fetcher.mockImplementation(async () => {
        started.resolve(undefined);
        return new Response(
          new ReadableStream<Uint8Array>({
            cancel() {
              cancelled = true;
            },
          }),
          { status, headers: { "Retry-After": "3600" } },
        );
      });
      await f.delivery.enqueue(report(), OWNER);
      await started.promise;
      const pending = f.flush();
      await f.advance(15_000);
      await pending;
      expect(cancelled).toBe(true);
      expect(f.delivery.list(OWNER)[0]?.status).toBe(
        status === 401 ? "session_required" : "pending",
      );
      if (status === 429) expect(f.delivery.list(OWNER)[0]?.nextAttemptAt).toBe(f.state.now + HOUR);
    },
  );

  it("bounds even a fetch implementation that ignores abort", async () => {
    const f = fixture();
    const started = deferred<undefined>();
    f.fetcher.mockImplementation(() => {
      started.resolve(undefined);
      return new Promise(() => undefined);
    });
    await f.delivery.enqueue(report(), OWNER);
    await started.promise;
    const pending = f.flush();
    await f.advance(15_000);
    await pending;
    expect(f.delivery.list(OWNER)[0]).toMatchObject({ status: "pending", attempts: 1 });
  });

  it("cancels response streams exceeding 16 KiB", async () => {
    const f = fixture();
    let cancelled = false;
    f.fetcher.mockResolvedValue(
      new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            controller.enqueue(new Uint8Array(16 * 1024 + 1));
          },
          cancel() {
            cancelled = true;
          },
        }),
        { status: 201 },
      ),
    );
    await f.delivery.enqueue(report(), OWNER);
    await f.flush();
    expect(cancelled).toBe(true);
    expect(f.delivery.list(OWNER)[0]?.receipt).toBeUndefined();
  });

  it("purges bodies after 24 hours and never extends expiry by restarting", async () => {
    const f = fixture();
    await f.delivery.enqueue(report(), OWNER);
    await f.flush();
    const restarted = fixture(f.state.stored);
    restarted.state.now += 24 * HOUR;
    await restarted.flush();
    expect(restarted.delivery.list(OWNER)).toEqual([]);
    expect(restarted.delivery.getReport(id(1), OWNER)).toBeNull();
    expect(restarted.fetcher).not.toHaveBeenCalled();
  });

  it("bounds retained reports and rejects body changes under an existing identifier", async () => {
    const f = fixture();
    f.fetcher.mockImplementation(async () => new Response("{}", { status: 400 }));
    for (let index = 1; index <= 20; index++) {
      await f.delivery.enqueue(report(index), OWNER);
      await f.flush();
    }
    await expect(f.delivery.enqueue(report(21), OWNER)).rejects.toMatchObject({
      code: "queue_full",
    });
    await expect(f.delivery.enqueue({ ...report(), occurrences: 2 }, OWNER)).rejects.toMatchObject({
      code: "invalid_report",
    });
  });

  it("bounds aggregate storage to 1 MiB and retains reserved room for a strict receipt", async () => {
    const f = fixture();
    f.fetcher.mockImplementation(async () => new Response("{}", { status: 400 }));
    let accepted = 0;
    for (let number = 1; number <= 20; number++) {
      try {
        await f.delivery.enqueue(fullReport(number), OWNER);
        await f.flush();
        accepted++;
      } catch (error) {
        expect(error).toMatchObject({ code: "queue_full" });
        break;
      }
    }
    expect(accepted).toBeGreaterThan(1);
    expect(accepted).toBeLessThan(20);
    expect(new TextEncoder().encode(JSON.stringify(f.state.stored)).byteLength).toBeLessThan(
      1024 * 1024,
    );
    const saved = persisted(f.state.stored);
    saved.reports[0]!.status = "pending";
    saved.reports[0]!.nextAttemptAt = NOW;
    saved.accounts[0]!.attempts = [];
    // Exercise a nearly full store: a received record must consume its reserve,
    // rather than keep reserving the same bytes after the receipt is present.
    saved.accounts.push({
      ownerId: "padding",
      automatic: false,
      sessionRequired: false,
      attempts: [],
      automaticReports: [],
    });
    const budget = 1024 * 1024 - saved.reports.length * 512;
    const padding = budget - new TextEncoder().encode(JSON.stringify(saved)).byteLength;
    saved.accounts.at(-1)!.ownerId += "x".repeat(padding);
    const restarted = fixture(saved);
    restarted.fetcher.mockResolvedValueOnce(
      new Response(JSON.stringify(receipt(id(1))), { status: 201 }),
    );
    await restarted.flush();
    expect(restarted.delivery.list(OWNER)[0]?.status).toBe("received");
    expect(
      new TextEncoder().encode(JSON.stringify(restarted.state.stored)).byteLength,
    ).toBeLessThan(1024 * 1024);
  });

  it.each(["cancel", "logout"] as const)(
    "does not dispatch when %s interrupts the durable attempt write",
    async (action) => {
      const f = fixture();
      const started = deferred<undefined>();
      const release = deferred<undefined>();
      f.write.mockImplementation(async (value) => {
        if (persisted(value).reports.some((entry) => entry.status === "sending")) {
          started.resolve(undefined);
          await release.promise;
        }
        f.state.stored = structuredClone(value);
      });
      await f.delivery.enqueue(report(), OWNER);
      await started.promise;
      const pending = action === "cancel" ? f.delivery.cancel(id(1), OWNER) : Promise.resolve();
      if (action === "logout") {
        f.state.account = null;
        f.delivery.syncAccount();
      }
      release.resolve(undefined);
      await pending;
      await f.flush();
      expect(f.fetcher).not.toHaveBeenCalled();
      expect(f.delivery.list(OWNER)[0]?.status).toBe(
        action === "cancel" ? "cancelled" : "session_required",
      );
    },
  );

  it("recovers an interrupted durable attempt with backoff and the original bytes", async () => {
    const f = fixture();
    await f.delivery.enqueue(report(), OWNER);
    await f.flush();
    const saved = persisted(f.state.stored);
    saved.reports[0]!.status = "sending";
    saved.reports[0]!.nextAttemptAt = null;
    const restarted = fixture(saved);
    await restarted.flush();
    expect(restarted.fetcher).not.toHaveBeenCalled();
    expect(restarted.delivery.list(OWNER)[0]).toMatchObject({
      attempts: 1,
      status: "pending",
      nextAttemptAt: NOW + 66_000,
    });
    await restarted.advance(66_000);
    await restarted.flush();
    expect(restarted.fetcher.mock.calls[0]?.[1]?.body).toBe(saved.reports[0]!.body);
    expect(restarted.delivery.list(OWNER)[0]?.attempts).toBe(2);
  });

  it.each(["claim", "receipt"] as const)(
    "recovers safely after a failed %s write",
    async (stage) => {
      const f = fixture();
      let fail = true;
      f.fetcher.mockImplementation(
        async () => new Response(JSON.stringify(receipt(id(1))), { status: 201 }),
      );
      f.write.mockImplementation(async (value) => {
        const status = persisted(value).reports[0]?.status;
        if (fail && status === (stage === "claim" ? "sending" : "received"))
          throw new Error("private storage error");
        f.state.stored = structuredClone(value);
      });
      await f.delivery.enqueue(report(), OWNER);
      await expect(f.flush()).rejects.toMatchObject({ code: "storage_unavailable" });
      expect(f.fetcher).toHaveBeenCalledTimes(stage === "claim" ? 0 : 1);
      expect(f.schedule).toHaveBeenLastCalledWith(NOW + 60_000);
      fail = false;
      await f.flush();
      if (stage === "receipt") {
        expect(f.delivery.list(OWNER)[0]).toMatchObject({
          status: "pending",
          attempts: 1,
          nextAttemptAt: NOW + 66_000,
        });
        await f.advance(66_000);
        await f.flush();
      }
      expect(f.delivery.list(OWNER)[0]?.status).toBe("received");
      expect(new Set(f.fetcher.mock.calls.map((call) => call[1]?.body))).toEqual(
        new Set([serializeDiagnosticReport(report())]),
      );
    },
  );

  it.each(["body", "owner", "receipt"] as const)(
    "does not expose malformed stored %s",
    async (field) => {
      const f = fixture();
      await f.delivery.enqueue(report(), OWNER);
      await f.flush();
      const saved = persisted(f.state.stored);
      if (field === "body") saved.reports[0]!.body = '{"token":"not allowed"}';
      if (field === "owner") saved.reports[0]!.ownerId = "";
      if (field === "receipt") {
        saved.reports[0]!.status = "received";
        saved.reports[0]!.receipt = { ...receipt(id(1)), client_report_id: id(2) };
      }
      const restarted = fixture(saved);
      await expect(restarted.flush()).rejects.toMatchObject({ code: "storage_unavailable" });
      expect(restarted.delivery.list(OWNER)).toEqual([]);
      expect(restarted.delivery.getReport(id(1), OWNER)).toBeNull();
      expect(restarted.fetcher).not.toHaveBeenCalled();
    },
  );

  it("fails closed on unreadable storage and never transmits before a durable attempt", async () => {
    const f = fixture();
    f.read.mockRejectedValue(new Error("raw storage detail"));
    await expect(f.delivery.enqueue(report(), OWNER)).rejects.toBeInstanceOf(
      DiagnosticDeliveryError,
    );
    expect(f.fetcher).not.toHaveBeenCalled();
    f.read.mockResolvedValue(undefined);
    f.write.mockRejectedValue(new Error("raw storage detail"));
    await expect(f.delivery.enqueue(report(), OWNER)).rejects.toMatchObject({
      code: "storage_unavailable",
    });
    expect(f.fetcher).not.toHaveBeenCalled();
  });
});
