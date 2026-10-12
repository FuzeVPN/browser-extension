// SPDX-License-Identifier: MPL-2.0

import {
  DiagnosticService,
  DIAGNOSTIC_DRAFTS_KEY,
  DIAGNOSTIC_ALARM,
  DIAGNOSTIC_HISTORY_KEY,
  DIAGNOSTIC_HISTORY_ALARM,
} from "../../src/core/diagnostics/service";
import type { DiagnosticAccount } from "../../src/core/diagnostics/delivery";
import type { DiagnosticReadModel } from "../../src/core/diagnostics/collector";
import { EMPTY_SNAPSHOT } from "../../src/core/shared/state";
import { EMPTY_NETWORK_OBSERVATION } from "../../src/core/shared/network";
import type { DiagnosticUiState } from "../../src/core/shared/diagnostics-ui";
import { serializeDiagnosticReport } from "../../src/core/shared/diagnostic-report";

const NOW = Date.parse("2026-09-16T12:00:00Z");
const accountA: DiagnosticAccount = {
  ownerId: "owner-a",
  token: "synthetic-token-a",
  expiresAt: NOW + 3_600_000,
  generation: 1,
};
const accountB: DiagnosticAccount = {
  ownerId: "owner-b",
  token: "synthetic-token-b",
  expiresAt: NOW + 3_600_000,
  generation: 2,
};

function requestBody(options?: RequestInit): string {
  if (typeof options?.body !== "string") throw new Error("expected_json_request_body");
  return options.body;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function fixture(signedIn = true) {
  let now = NOW;
  let account: DiagnosticAccount | null = signedIn ? { ...accountA } : null;
  let sequence = 0;
  const local: Record<string, unknown> = {};
  const session: Record<string, unknown> = {};
  const changes: DiagnosticUiState[] = [];
  const model: DiagnosticReadModel = {
    snapshot: {
      ...structuredClone(EMPTY_SNAPSHOT),
      status: signedIn ? "disconnected" : "logged_out",
      profile: signedIn
        ? {
            userId: "owner-a",
            email: "sensitive@example.invalid",
            firstName: "SensitiveFirst",
            lastName: "SensitiveLast",
            countryCode: "FR",
          }
        : null,
    },
    safety: {
      blockingScope: "none",
      trafficBlocked: false,
      filterActive: false,
      webRtcProtected: false,
    },
    reconnectAttempts: 0,
    proxyCreationUncertain: false,
    proxyCleanupUncertain: false,
  };
  const area = (values: Record<string, unknown>) => ({
    get: vi.fn(async (key: string) => ({ [key]: structuredClone(values[key]) })),
    set: vi.fn(async (value: Record<string, unknown>) => {
      Object.assign(values, structuredClone(value));
    }),
    setAccessLevel: vi.fn(async () => {}),
  });
  const storage = { local: area(local), session: area(session) };
  const alarms = new Map<string, number>();
  const createAlarm = vi.fn((name: string, info: { when: number }) => {
    alarms.set(name, info.when);
  });
  vi.stubGlobal("browser", {
    storage,
    alarms: {
      create: createAlarm,
      get: vi.fn(async (name: string) =>
        alarms.has(name) ? { name, scheduledTime: alarms.get(name) } : undefined,
      ),
      clear: vi.fn(async (name: string) => alarms.delete(name)),
    },
  });
  const fetcher = vi.fn<typeof fetch>(async (_url, options) => {
    const body = JSON.parse(requestBody(options)) as { report_id: string };
    return Response.json(
      {
        report_id: "b1000000-0000-4000-8000-000000000001",
        client_report_id: body.report_id,
        status: "received",
        duplicate: false,
        received_at: new Date(now).toISOString(),
        expires_at: new Date(now + 30 * 86_400_000).toISOString(),
      },
      { status: 201 },
    );
  });
  vi.stubGlobal("fetch", fetcher);
  const dependencies = {
    read: () => structuredClone(model),
    inspectSafety: async () => structuredClone(model.safety),
    inspectWebRtc: async () => false,
    getProxyControl: async () => "controllable_by_this_extension" as const,
    verifyProxy: async () => null,
    probe: vi.fn(async () => ({ ...EMPTY_NETWORK_OBSERVATION })),
    now: () => now,
    getAccount: () => account,
    canSendDiagnostics: vi.fn(async () => true),
    language: () => "fr" as const,
    version: () => "0.5.5",
    onChanged: (state: DiagnosticUiState) => {
      changes.push(structuredClone(state));
    },
    uuid: () => `a1000000-0000-4000-8000-${(++sequence).toString(16).padStart(12, "0")}`,
    environment: async () => ({ browser_name: "chrome" as const, browser_version: "141.0.0.0" }),
  };
  const service = new DiagnosticService(dependencies);
  const settle = async (target = service) => {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    await target.delivery.pump().catch(() => undefined);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  };
  return {
    service,
    dependencies,
    storage,
    alarms,
    createAlarm,
    local,
    session,
    changes,
    fetcher,
    model,
    settle,
    restart: () => new DiagnosticService(dependencies),
    setNow: (value: number) => {
      now = value;
    },
    setAccount: (value: DiagnosticAccount | null) => {
      account = value;
      model.snapshot.profile = value
        ? {
            userId: value.ownerId,
            email: "sensitive@example.invalid",
            firstName: "SensitiveFirst",
            lastName: "SensitiveLast",
            countryCode: "FR",
          }
        : null;
      model.snapshot.status = value ? "disconnected" : "logged_out";
    },
  };
}

describe("diagnostic service manual consent and account boundaries", () => {
  afterEach(() => vi.unstubAllGlobals());

  it.each(["absent", "unreadable"] as const)(
    "keeps local preparation/export available but refuses manual delivery when Mozilla consent is %s",
    async (condition) => {
      const f = fixture();
      f.dependencies.canSendDiagnostics.mockImplementation(async () => {
        if (condition === "unreadable") throw new Error("permission_read_failed");
        return false;
      });
      const prepared = await f.service.handle({ type: "diagnostics_run" });
      expect(prepared.ok).toBe(true);
      const exported = await f.service.handle({
        type: "diagnostics_report",
        reportId: prepared.reportId,
      });
      expect(exported.ok).toBe(true);
      expect(exported.report?.report_id).toBe(prepared.reportId);
      const sent = await f.service.handle({
        type: "diagnostics_send",
        reportId: prepared.reportId,
        consent: true,
        noticeVersion: 1,
      });
      expect(sent).toMatchObject({ ok: false, error: "data_collection_required" });
      expect(f.service.state().reports).toHaveLength(1);
      expect(f.service.state().reports[0]).toMatchObject({ status: "ready", attempts: 0 });
      await f.settle();
      expect(f.fetcher).not.toHaveBeenCalled();
    },
  );

  it("keeps local incident history without enqueuing automatic reports after Mozilla revocation", async () => {
    const f = fixture();
    const enabled = await f.service.handle({ type: "diagnostics_set_auto", enabled: true });
    expect(enabled.ok).toBe(true);
    f.dependencies.canSendDiagnostics.mockResolvedValue(false);
    f.service.permissionsRemoved();
    f.service.record("connect", { ok: false, commandError: "proxy_authentication_failed" });
    await f.settle();
    expect(f.service.state().historyCount).toBe(1);
    expect(f.service.state().reports).toHaveLength(0);
    expect(f.fetcher).not.toHaveBeenCalled();
    const disabled = await f.service.handle({ type: "diagnostics_set_auto", enabled: false });
    expect(disabled.ok).toBe(true);
    f.dependencies.canSendDiagnostics.mockResolvedValue(true);
    f.service.permissionsChanged();
    f.service.record("connect", { ok: false, commandError: "proxy_authentication_failed" });
    await f.settle();
    expect(f.service.state().autoReporting).toBe(false);
    expect(f.service.state().reports).toHaveLength(0);
    expect(f.fetcher).not.toHaveBeenCalled();
  });

  it("wakes to remove expired history from session storage without a report or new event", async () => {
    const f = fixture();
    await f.service.initialize();
    expect(f.alarms.has(DIAGNOSTIC_HISTORY_ALARM)).toBe(false);
    f.service.record("initialize", { ok: true });
    await f.settle();
    expect(f.alarms.get(DIAGNOSTIC_HISTORY_ALARM)).toBe(NOW + 600_001);
    f.setNow(NOW + 600_001);
    await f.service.historyAlarm();
    expect(f.session[DIAGNOSTIC_HISTORY_KEY]).toEqual({ owner: "owner-a", items: [], losses: [] });
    expect(f.alarms.has(DIAGNOSTIC_HISTORY_ALARM)).toBe(false);
    expect(f.fetcher).not.toHaveBeenCalled();
  });

  it("replans for remaining events and clears the history alarm on an account boundary", async () => {
    const f = fixture();
    await f.service.initialize();
    f.service.record("initialize", { ok: true });
    await f.settle();
    f.setNow(NOW + 5_000);
    f.service.record("initialize", { ok: true });
    await f.settle();
    f.setNow(NOW + 600_001);
    await f.service.historyAlarm();
    expect(f.alarms.get(DIAGNOSTIC_HISTORY_ALARM)).toBe(NOW + 605_001);
    expect((f.session[DIAGNOSTIC_HISTORY_KEY] as { items: unknown[] }).items).toHaveLength(1);
    f.setAccount(accountB);
    f.service.syncAccount(true);
    await f.settle();
    expect(f.alarms.has(DIAGNOSTIC_HISTORY_ALARM)).toBe(false);
    expect(f.session[DIAGNOSTIC_HISTORY_KEY]).toEqual({ owner: "owner-b", items: [], losses: [] });
  });

  it("restores the history deadline and persists an account mismatch purge on startup", async () => {
    const f = fixture();
    await f.service.initialize();
    f.service.record("initialize", { ok: true });
    await f.settle();
    f.alarms.clear();
    await f.restart().initialize();
    expect(f.alarms.get(DIAGNOSTIC_HISTORY_ALARM)).toBe(NOW + 600_001);
    f.setAccount(accountB);
    await f.restart().initialize();
    expect(f.session[DIAGNOSTIC_HISTORY_KEY]).toEqual({ owner: "owner-b", items: [], losses: [] });
    expect(f.alarms.has(DIAGNOSTIC_HISTORY_ALARM)).toBe(false);
  });

  it("uses the same housekeeping alarm to purge a retained draft after 24 hours", async () => {
    const f = fixture(false);
    await f.service.handle({ type: "diagnostics_run" });
    expect(f.alarms.get(DIAGNOSTIC_HISTORY_ALARM)).toBe(NOW + 86_400_000);
    f.setNow(NOW + 86_400_000);
    await f.service.historyAlarm();
    expect(f.session[DIAGNOSTIC_DRAFTS_KEY]).toEqual({ drafts: [], incidents: [] });
    expect(f.alarms.has(DIAGNOSTIC_HISTORY_ALARM)).toBe(false);
    expect(f.fetcher).not.toHaveBeenCalled();
  });

  it("purges already expired persisted drafts when restarting after their missed deadline", async () => {
    const f = fixture(false);
    await f.service.handle({ type: "diagnostics_run" });
    f.setNow(NOW + 86_400_000);
    f.alarms.clear();
    const restarted = f.restart();
    await restarted.initialize();
    expect(f.session[DIAGNOSTIC_DRAFTS_KEY]).toEqual({ drafts: [], incidents: [] });
    expect(restarted.state().reports).toEqual([]);
    expect(f.alarms.has(DIAGNOSTIC_HISTORY_ALARM)).toBe(false);
  });

  it("keeps a bounded retry alarm when an expired history purge cannot be persisted", async () => {
    const f = fixture();
    await f.service.initialize();
    f.service.record("initialize", { ok: true });
    await f.settle();
    f.setNow(NOW + 600_001);
    const write = f.storage.session.set.getMockImplementation()!;
    f.storage.session.set.mockRejectedValue(new Error("synthetic-storage-failure"));
    await expect(f.service.historyAlarm()).rejects.toThrow("synthetic-storage-failure");
    expect(f.alarms.get(DIAGNOSTIC_HISTORY_ALARM)).toBe(NOW + 660_001);
    f.storage.session.set.mockImplementation(write);
    await f.service.historyAlarm();
    expect(f.session[DIAGNOSTIC_HISTORY_KEY]).toEqual({ owner: "owner-a", items: [], losses: [] });
    expect(f.alarms.has(DIAGNOSTIC_HISTORY_ALARM)).toBe(false);
  });

  it("prepares, views and exports a local report without an account or upload", async () => {
    const f = fixture(false);
    const prepared = await f.service.handle({ type: "diagnostics_run" });
    expect(prepared.ok).toBe(true);
    expect(prepared.state.reports).toHaveLength(1);
    expect(prepared.state.reports[0]).toMatchObject({ status: "ready", canSend: false });
    const viewed = await f.service.handle({
      type: "diagnostics_report",
      reportId: prepared.reportId,
    });
    expect(viewed.ok).toBe(true);
    expect(serializeDiagnosticReport(viewed.report)).toContain('"report_type":"full"');
    expect(
      await f.service.handle({
        type: "diagnostics_send",
        reportId: prepared.reportId,
        consent: true,
        noticeVersion: 1,
      }),
    ).toMatchObject({ ok: false, error: "session_required" });
    await f.settle();
    expect(f.fetcher).not.toHaveBeenCalled();
  });

  it.each([
    { type: "diagnostics_send", consent: false, noticeVersion: 1 },
    { type: "diagnostics_send", noticeVersion: 1 },
    { type: "diagnostics_send", consent: true, noticeVersion: 2 },
    { type: "diagnostics_send", consent: true, noticeVersion: 1, ownerId: "owner-b" },
  ])("rejects a forged send request %j before uploading", async (request) => {
    const f = fixture();
    const prepared = await f.service.handle({ type: "diagnostics_run" });
    expect(await f.service.handle({ ...request, reportId: prepared.reportId })).toMatchObject({
      ok: false,
      error: "invalid_report",
    });
    await f.settle();
    expect(f.fetcher).not.toHaveBeenCalled();
  });

  it("sends the frozen manual report once under its owning account despite two concurrent clicks", async () => {
    const f = fixture();
    const prepared = await f.service.handle({ type: "diagnostics_run" });
    const viewed = await f.service.handle({
      type: "diagnostics_report",
      reportId: prepared.reportId,
    });
    const frozen = serializeDiagnosticReport(viewed.report);
    f.model.snapshot.error = "network_error";
    f.setNow(NOW + 5_000);
    const request = {
      type: "diagnostics_send",
      reportId: prepared.reportId,
      consent: true,
      noticeVersion: 1,
    };
    await Promise.all([f.service.handle(request), f.service.handle(request)]);
    await f.settle();
    expect(f.fetcher).toHaveBeenCalledOnce();
    expect(f.fetcher.mock.calls[0]![1]!.body).toBe(frozen);
    expect(new Headers(f.fetcher.mock.calls[0]![1]!.headers).get("Authorization")).toBe(
      "Bearer synthetic-token-a",
    );
    expect(f.service.state().reports).toHaveLength(1);
    expect(f.service.state().reports[0]!.status).toBe("received");
    expect(JSON.stringify({ local: f.local, session: f.session })).not.toContain(
      "synthetic-token-a",
    );
  });

  it("accepts a durable send despite one alarm failure and schedules the normal HTTP retry", async () => {
    const f = fixture();
    const prepared = await f.service.handle({ type: "diagnostics_run" });
    await f.settle();
    let failed = false;
    f.createAlarm.mockImplementation((name, info) => {
      if (name === DIAGNOSTIC_ALARM && !failed) {
        failed = true;
        throw new Error("synthetic-alarm-failure");
      }
      f.alarms.set(name, info.when);
    });
    f.fetcher.mockResolvedValueOnce(new Response("{}", { status: 503 }));
    const sent = await f.service.handle({
      type: "diagnostics_send",
      reportId: prepared.reportId,
      consent: true,
      noticeVersion: 1,
    });
    expect(sent.ok).toBe(true);
    expect(sent.error).toBeUndefined();
    // Do not explicitly pump here: the accepted send must start its own work.
    await vi.waitFor(() => {
      expect(f.fetcher).toHaveBeenCalledOnce();
      expect(f.service.state().reports[0]).toMatchObject({ status: "pending", attempts: 1 });
      expect(f.alarms.get(DIAGNOSTIC_ALARM)).toBeGreaterThanOrEqual(NOW + 60_000);
      expect(f.alarms.get(DIAGNOSTIC_ALARM)).toBeLessThanOrEqual(NOW + 72_000);
    });
    expect(failed).toBe(true);
    expect((f.session[DIAGNOSTIC_DRAFTS_KEY] as { drafts: unknown[] }).drafts).toEqual([]);
    const state = await f.service.handle({ type: "diagnostics_state" });
    expect(state.ok).toBe(true);
    const firstBody = requestBody(f.fetcher.mock.calls[0]![1]);
    f.setNow(f.alarms.get(DIAGNOSTIC_ALARM)!);
    await f.service.alarm();
    expect(f.fetcher).toHaveBeenCalledTimes(2);
    expect(requestBody(f.fetcher.mock.calls[1]![1])).toBe(firstBody);
    expect(f.service.state().reports[0]?.status).toBe("received");
  });

  it("does not report an accepted send as failed when cleanup of its draft cannot be persisted", async () => {
    const f = fixture();
    const prepared = await f.service.handle({ type: "diagnostics_run" });
    await f.settle();
    f.storage.session.set.mockRejectedValueOnce(new Error("synthetic-draft-cleanup-failure"));
    const sent = await f.service.handle({
      type: "diagnostics_send",
      reportId: prepared.reportId,
      consent: true,
      noticeVersion: 1,
    });
    expect(sent.ok).toBe(true);
    expect(sent.error).toBeUndefined();
    await vi.waitFor(() => expect(f.service.state().reports[0]?.status).toBe("received"));
    expect(f.fetcher).toHaveBeenCalledOnce();
    expect(f.alarms.get(DIAGNOSTIC_HISTORY_ALARM)).toBe(NOW + 60_000);
    f.setNow(NOW + 60_000);
    await f.service.historyAlarm();
    expect((f.session[DIAGNOSTIC_DRAFTS_KEY] as { drafts: unknown[] }).drafts).toEqual([]);
    expect(f.fetcher).toHaveBeenCalledOnce();
  });

  it("never publishes old-account reports during synchronous account change notifications", async () => {
    const f = fixture();
    const prepared = await f.service.handle({ type: "diagnostics_run" });
    f.changes.length = 0;
    f.setAccount(accountB);
    f.service.syncAccount(true);
    await f.settle();
    expect(f.changes.length).toBeGreaterThan(0);
    expect(
      f.changes.every((state) => state.reports.every((report) => report.id !== prepared.reportId)),
    ).toBe(true);
    expect(
      await f.service.handle({ type: "diagnostics_report", reportId: prepared.reportId }),
    ).toMatchObject({ ok: false, error: "not_found" });
    f.setAccount(accountA);
    f.service.syncAccount(true);
    expect(
      (await f.service.handle({ type: "diagnostics_report", reportId: prepared.reportId })).ok,
    ).toBe(true);
  });

  it("discards a manual preparation when its account changes during the probe", async () => {
    const f = fixture();
    await f.service.initialize();
    const probe = deferred<typeof EMPTY_NETWORK_OBSERVATION>();
    f.dependencies.probe.mockReturnValueOnce(probe.promise);
    const preparing = f.service.handle({ type: "diagnostics_run" });
    await vi.waitFor(() => expect(f.dependencies.probe).toHaveBeenCalledOnce());
    f.setAccount(accountB);
    f.service.syncAccount(true);
    probe.resolve({ ...EMPTY_NETWORK_OBSERVATION });
    expect(await preparing).toMatchObject({ ok: false, error: "session_required" });
    expect(f.service.state().reports).toEqual([]);
    f.setAccount(accountA);
    f.service.syncAccount(true);
    expect(f.service.state().reports).toEqual([]);
    expect(f.fetcher).not.toHaveBeenCalled();
  });

  it("does not attach an anonymous preparation to an account that later signs in", async () => {
    const f = fixture(false);
    const prepared = await f.service.handle({ type: "diagnostics_run" });
    f.setAccount(accountA);
    f.service.syncAccount(true);
    expect(
      await f.service.handle({
        type: "diagnostics_send",
        reportId: prepared.reportId,
        consent: true,
        noticeVersion: 1,
      }),
    ).toMatchObject({ ok: false });
    expect(f.service.state().reports).toEqual([]);
    expect(f.fetcher).not.toHaveBeenCalled();
  });
});

describe("diagnostic service automatic incident policy", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("records a full server as invalid_location without an automatic report even after repeated refusals", async () => {
    const f = fixture();
    await f.service.handle({ type: "diagnostics_set_auto", enabled: true });
    for (let index = 0; index < 4; index++)
      f.service.record("connect", { ok: false, commandError: "server_full" });
    await f.settle();
    expect(f.service.state().historyCount).toBe(4);
    expect(f.service.state().reports).toEqual([]);
    expect(f.fetcher).not.toHaveBeenCalled();
    const history = f.session[DIAGNOSTIC_HISTORY_KEY] as {
      items: { event: { code: string } }[];
    };
    expect(history.items.map((item) => item.event.code)).toEqual(Array(4).fill("invalid_location"));
    expect(JSON.stringify(f.session)).not.toContain("server_full");
    const restarted = f.restart();
    await restarted.initialize();
    expect(restarted.state().autoReporting).toBe(true);
    expect(restarted.state().historyCount).toBe(4);
    expect(restarted.state().reports).toEqual([]);
  });

  it("shares the repeated proxy counter across capacity refusals, existing errors and a worker restart", async () => {
    const f = fixture();
    await f.service.handle({ type: "diagnostics_set_auto", enabled: true });
    f.service.record("connect", { ok: false, commandError: "proxy_unavailable" });
    f.service.record("connect", { ok: false, commandError: "capacity_unavailable" });
    await f.settle();
    expect(f.fetcher).not.toHaveBeenCalled();
    expect(f.session[DIAGNOSTIC_DRAFTS_KEY]).toMatchObject({
      incidents: [{ code: "proxy_unavailable", operation: "connect", count: 2 }],
    });
    expect(JSON.stringify(f.session)).not.toContain("capacity_unavailable");
    const restarted = f.restart();
    await restarted.initialize();
    restarted.record("connect", { ok: false, commandError: "capacity_unavailable" });
    await f.settle(restarted);
    expect(f.fetcher).toHaveBeenCalledOnce();
    expect(JSON.parse(requestBody(f.fetcher.mock.calls[0]![1]))).toMatchObject({
      report_type: "simple",
      occurrences: 3,
      consent: { mode: "automatic_opt_in" },
      error: { code: "proxy_unavailable", operation: "connect" },
    });
    restarted.record("connect", { ok: false, commandError: "capacity_unavailable" });
    await f.settle(restarted);
    expect(f.fetcher).toHaveBeenCalledOnce();
  });

  it("does not upload repeated capacity refusals without automatic consent", async () => {
    const f = fixture();
    await f.service.initialize();
    for (let index = 0; index < 4; index++)
      f.service.record("connect", { ok: false, commandError: "capacity_unavailable" });
    await f.settle();
    expect(f.service.state().historyCount).toBe(4);
    expect(f.service.state().reports).toEqual([]);
    expect(f.fetcher).not.toHaveBeenCalled();
    expect(JSON.stringify(f.session)).not.toContain("capacity_unavailable");
  });

  it.each(["operation", "window"] as const)(
    "keeps the existing capacity incident %s boundary before automatic delivery",
    async (boundary) => {
      const f = fixture();
      await f.service.handle({ type: "diagnostics_set_auto", enabled: true });
      f.service.record("connect", { ok: false, commandError: "capacity_unavailable" });
      f.service.record("connect", { ok: false, commandError: "capacity_unavailable" });
      await f.settle();
      if (boundary === "window") f.setNow(NOW + 600_001);
      const operation = boundary === "operation" ? "refresh_proxy_session" : "connect";
      f.service.record(operation, { ok: false, commandError: "capacity_unavailable" });
      await f.settle();
      expect(f.fetcher).not.toHaveBeenCalled();
      for (let index = 0; index < 2; index++)
        f.service.record(operation, { ok: false, commandError: "capacity_unavailable" });
      await f.settle();
      expect(f.fetcher).toHaveBeenCalledOnce();
      expect(JSON.parse(requestBody(f.fetcher.mock.calls[0]![1]))).toMatchObject({
        occurrences: 3,
        error: {
          code: "proxy_unavailable",
          operation: boundary === "operation" ? "refresh" : "connect",
        },
      });
    },
  );

  it.each([
    ["server_full", "invalid_location"],
    ["capacity_unavailable", "proxy_unavailable"],
  ] as const)(
    "exports only the compatible %s alias without local location metadata",
    async (code, normalized) => {
      const f = fixture();
      f.model.snapshot.error = code;
      Object.assign(f.model.snapshot, {
        activeLocation: {
          id: "private-active-location",
          city: "PrivateActiveCity",
          displayName: "PrivateActiveDisplay",
          countryCode: "FR",
          supportedProtocols: ["browser_proxy"],
        },
        capacityBlockedLocationId: "private-blocked-location",
      });
      await f.service.initialize();
      f.service.record("connect", { ok: false, commandError: code });
      await f.settle();
      const prepared = await f.service.handle({ type: "diagnostics_run" });
      const viewed = await f.service.handle({
        type: "diagnostics_report",
        reportId: prepared.reportId,
      });
      expect(viewed.report).toMatchObject({
        error: { code: normalized },
        events: [{ code: normalized }],
      });
      const encoded = serializeDiagnosticReport(viewed.report);
      for (const privateValue of [
        code,
        "activeLocation",
        "private-active-location",
        "PrivateActiveCity",
        "PrivateActiveDisplay",
        "capacityBlockedLocationId",
        "private-blocked-location",
      ])
        expect(encoded).not.toContain(privateValue);
      expect(f.fetcher).not.toHaveBeenCalled();
      expect(
        await f.service.handle({
          type: "diagnostics_send",
          reportId: prepared.reportId,
          consent: true,
          noticeVersion: 1,
        }),
      ).toMatchObject({ ok: true });
      await f.settle();
      expect(f.fetcher).toHaveBeenCalledOnce();
      expect(requestBody(f.fetcher.mock.calls[0]![1])).toBe(encoded);
    },
  );

  it("keeps a contextual device quota error out of automatic reports after normalization", async () => {
    const f = fixture();
    await f.service.handle({ type: "diagnostics_set_auto", enabled: true });
    f.service.record("connect", { ok: false, commandError: "device_revoked_limit" });
    await f.settle();
    expect(f.service.state().historyCount).toBe(1);
    expect(f.service.state().reports).toEqual([]);
    expect(f.fetcher).not.toHaveBeenCalled();
    expect(f.session[DIAGNOSTIC_HISTORY_KEY]).toMatchObject({
      items: [{ event: { event: "error", code: "device_limit" } }],
    });
    expect(JSON.stringify(f.session)).not.toContain("device_revoked_limit");
    const restarted = f.restart();
    await restarted.initialize();
    expect(restarted.state().autoReporting).toBe(true);
    expect(restarted.state().historyCount).toBe(1);
    expect(restarted.state().reports).toEqual([]);
    expect(f.fetcher).not.toHaveBeenCalled();
  });

  it("exports and sends only the normalized quota code without local repair context", async () => {
    const f = fixture();
    f.model.snapshot.error = "device_revoked_limit";
    // The collector must select allowed fields even if its local read model grows.
    Object.assign(f.model.snapshot, {
      pendingRepair: { ownerId: "private-repair-owner", deviceId: "private-repair-device" },
    });
    await f.service.initialize();
    f.service.record("connect", { ok: false, commandError: "device_revoked_limit" });
    await f.settle();
    const prepared = await f.service.handle({ type: "diagnostics_run" });
    expect(prepared.ok).toBe(true);
    const viewed = await f.service.handle({
      type: "diagnostics_report",
      reportId: prepared.reportId,
    });
    expect(viewed.report).toMatchObject({
      error: { code: "device_limit" },
      events: [{ code: "device_limit" }],
    });
    const encoded = serializeDiagnosticReport(viewed.report);
    for (const privateValue of [
      "device_revoked_limit",
      "pendingRepair",
      "private-repair-owner",
      "private-repair-device",
      "owner-a",
      "sensitive@example.invalid",
      "synthetic-token-a",
    ])
      expect(encoded).not.toContain(privateValue);
    expect(f.fetcher).not.toHaveBeenCalled();
    const sent = await f.service.handle({
      type: "diagnostics_send",
      reportId: prepared.reportId,
      consent: true,
      noticeVersion: 1,
    });
    expect(sent.ok).toBe(true);
    await f.settle();
    expect(f.fetcher).toHaveBeenCalledOnce();
    expect(requestBody(f.fetcher.mock.calls[0]![1])).toBe(encoded);
  });

  it("defaults OFF and never uploads terminal or repeated failures without opt-in", async () => {
    const f = fixture();
    await f.service.initialize();
    expect(f.service.state().autoReporting).toBe(false);
    for (let index = 0; index < 3; index++)
      f.service.record("connect", { ok: false, commandError: "network_error" });
    f.service.record("connect", { ok: false, commandError: "traffic_guard_failed" });
    await f.settle();
    expect(f.service.state().historyCount).toBe(4);
    expect(f.fetcher).not.toHaveBeenCalled();
  });

  it("keeps automatic consent isolated per account and restores the original preference", async () => {
    const f = fixture();
    expect((await f.service.handle({ type: "diagnostics_set_auto", enabled: true })).ok).toBe(true);
    f.setAccount(accountB);
    f.service.syncAccount(true);
    expect(f.service.state().autoReporting).toBe(false);
    f.service.record("connect", { ok: false, commandError: "traffic_guard_failed" });
    await f.settle();
    expect(f.fetcher).not.toHaveBeenCalled();
    f.setAccount(accountA);
    f.service.syncAccount(true);
    expect(f.service.state().autoReporting).toBe(true);
  });

  it("groups three consecutive network failures before one automatic report", async () => {
    const f = fixture();
    await f.service.handle({ type: "diagnostics_set_auto", enabled: true });
    for (let index = 0; index < 2; index++) {
      f.service.record("connect", { ok: false, commandError: "network_error" });
      await f.settle();
      expect(f.fetcher).not.toHaveBeenCalled();
    }
    f.service.record("connect", { ok: false, commandError: "network_error" });
    await f.settle();
    expect(f.fetcher).toHaveBeenCalledOnce();
    const body = JSON.parse(requestBody(f.fetcher.mock.calls[0]![1])) as Record<string, unknown>;
    expect(body).toMatchObject({
      report_type: "simple",
      occurrences: 3,
      consent: { mode: "automatic_opt_in" },
      error: { code: "network_error" },
    });
    expect(body).not.toHaveProperty("events");
    f.service.record("connect", { ok: false, commandError: "network_error" });
    await f.settle();
    expect(f.fetcher).toHaveBeenCalledOnce();
  });

  it("resets repeated network incidents after a successful operation", async () => {
    const f = fixture();
    await f.service.handle({ type: "diagnostics_set_auto", enabled: true });
    f.service.record("connect", { ok: false, commandError: "network_error" });
    f.service.record("connect", { ok: false, commandError: "network_error" });
    f.service.record("connect", { ok: true });
    f.service.record("connect", { ok: false, commandError: "network_error" });
    await f.settle();
    expect(f.fetcher).not.toHaveBeenCalled();
  });

  it("reports a terminal failure once and never turns delivery errors into new incidents", async () => {
    const f = fixture();
    await f.service.handle({ type: "diagnostics_set_auto", enabled: true });
    f.fetcher.mockResolvedValue(
      Response.json({ error: "synthetic-server-failure" }, { status: 503 }),
    );
    f.service.record("connect", { ok: false, commandError: "traffic_guard_failed" });
    await f.settle();
    expect(f.fetcher).toHaveBeenCalledOnce();
    expect(f.service.state().historyCount).toBe(1);
    expect(f.service.state().reports).toHaveLength(1);
    expect(f.service.state().reports[0]!.status).toBe("pending");
    await f.service.handle({ type: "diagnostics_set_auto", enabled: false });
    f.setNow(NOW + 3_600_000);
    await f.service.alarm();
    expect(f.fetcher).toHaveBeenCalledOnce();
  });

  it("rejects diagnostic commands from the business incident recorder", async () => {
    const f = fixture();
    await f.service.handle({ type: "diagnostics_set_auto", enabled: true });
    f.service.record("diagnostics_send", { ok: false, commandError: "unknown_error" });
    f.service.record("diagnostics_run", { ok: false, commandError: "storage_unavailable" });
    await f.settle();
    expect(f.fetcher).not.toHaveBeenCalled();
    expect(f.service.state().historyCount).toBe(0);
  });

  it("records and automatically reports a captured terminal error within the same account epoch", async () => {
    const f = fixture();
    await f.service.handle({ type: "diagnostics_set_auto", enabled: true });
    const complete = f.service.capture("connect");
    expect(complete({ ok: false, commandError: "traffic_guard_failed" }, 25)).toBeUndefined();
    await f.settle();
    expect(f.fetcher).toHaveBeenCalledOnce();
    expect(JSON.parse(requestBody(f.fetcher.mock.calls[0]![1]))).toMatchObject({
      report_type: "simple",
      occurrences: 1,
      error: { code: "traffic_guard_failed", operation: "connect" },
    });
    expect(f.service.state().historyCount).toBe(1);
    expect(new Headers(f.fetcher.mock.calls[0]![1]!.headers).get("Authorization")).toBe(
      "Bearer synthetic-token-a",
    );
  });

  it("drops captured completions across account changes even after returning to the original account", async () => {
    const f = fixture();
    await f.service.handle({ type: "diagnostics_set_auto", enabled: true });
    const completesOnB = f.service.capture("connect");
    const completesBackOnA = f.service.capture("connect");
    f.setAccount(accountB);
    f.service.syncAccount(true);
    completesOnB({ ok: false, commandError: "traffic_guard_failed" });
    await f.settle();
    expect(f.service.state().historyCount).toBe(0);
    expect(f.fetcher).not.toHaveBeenCalled();
    f.setAccount(accountA);
    f.service.syncAccount(true);
    completesBackOnA({ ok: false, commandError: "traffic_guard_failed" });
    await f.settle();
    expect(f.service.state().historyCount).toBe(0);
    expect(f.service.state().reports).toEqual([]);
    expect(f.fetcher).not.toHaveBeenCalled();
  });

  it("returns immediately from a captured completion and contains a later storage rejection", async () => {
    const f = fixture();
    await f.service.handle({ type: "diagnostics_set_auto", enabled: true });
    await f.settle();
    const writing = deferred<undefined>();
    let writeStarted = false;
    f.storage.session.set.mockImplementationOnce(async () => {
      writeStarted = true;
      await writing.promise;
      throw new Error("synthetic-history-storage-failure");
    });
    const complete = f.service.capture("connect");
    expect(complete({ ok: false, commandError: "traffic_guard_failed" })).toBeUndefined();
    expect(writeStarted).toBe(false);
    await vi.waitFor(() => expect(writeStarted).toBe(true));
    expect(f.fetcher).not.toHaveBeenCalled();
    writing.resolve(undefined);
    await f.settle();
    expect(f.fetcher).not.toHaveBeenCalled();
    expect(f.model.snapshot.error).toBeNull();
    expect(f.service.capture("disconnect")({ ok: true })).toBeUndefined();
    await f.settle();
    expect(f.service.state().historyCount).toBe(2);
  });

  it("never attributes a queued incident to another account after its history write was delayed", async () => {
    const f = fixture();
    await f.service.handle({ type: "diagnostics_set_auto", enabled: true });
    f.setAccount(accountB);
    f.service.syncAccount(true);
    await f.service.handle({ type: "diagnostics_set_auto", enabled: true });
    f.setAccount(accountA);
    f.service.syncAccount(true);
    await f.settle();
    const writing = deferred<undefined>();
    let historyWriteStarted = false;
    f.storage.session.set.mockImplementationOnce(async (value) => {
      expect(value).toHaveProperty(DIAGNOSTIC_HISTORY_KEY);
      historyWriteStarted = true;
      await writing.promise;
      Object.assign(f.session, structuredClone(value));
    });
    f.service.record("connect", { ok: false, commandError: "traffic_guard_failed" });
    await vi.waitFor(() => expect(historyWriteStarted).toBe(true));
    f.setAccount(accountB);
    f.service.syncAccount(true);
    writing.resolve(undefined);
    await f.settle();
    expect(f.fetcher).not.toHaveBeenCalled();
    expect(f.service.state().reports).toEqual([]);
  });
});

describe("diagnostic service worker restart and failed storage", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("waits for the worker's existing startup before deciding the owner of restored history", async () => {
    const f = fixture();
    await f.service.initialize();
    f.service.record("refresh_account", { ok: false, commandError: "network_error" });
    await vi.waitFor(() => expect(f.service.state().historyCount).toBe(1));
    await f.settle();
    const stored = structuredClone(f.session[DIAGNOSTIC_HISTORY_KEY]);
    const startup = deferred<undefined>();
    f.setAccount(null);
    const restored = new DiagnosticService({ ...f.dependencies, whenReady: () => startup.promise });
    const initializing = restored.initialize();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(f.session[DIAGNOSTIC_HISTORY_KEY]).toEqual(stored);
    f.setAccount(accountA);
    startup.resolve(undefined);
    await initializing;
    expect(restored.state().historyCount).toBe(1);
    const prepared = await restored.handle({ type: "diagnostics_run" });
    const viewed = await restored.handle({
      type: "diagnostics_report",
      reportId: prepared.reportId,
    });
    expect(viewed.report!.events).toEqual([expect.objectContaining({ code: "network_error" })]);
    expect(f.fetcher).not.toHaveBeenCalled();
  });

  it.each(["none", "delivery", "drafts"])(
    "discards restored old-owner history when the account changes during initialization with %s storage failure",
    async (failure) => {
      const f = fixture();
      const storedHistory = {
        owner: "owner-a",
        items: [
          {
            at: NOW,
            event: {
              source: "controller",
              stage: "storage",
              event: "error",
              offset_ms: 0,
              code: "storage_unavailable",
            },
          },
        ],
        losses: [],
      };
      const reading = deferred<Record<string, unknown>>();
      f.storage.session.get.mockReturnValueOnce(reading.promise);
      if (failure === "drafts")
        f.storage.session.get.mockRejectedValueOnce(new Error("synthetic-storage-failure"));
      if (failure === "delivery")
        f.storage.local.get.mockRejectedValueOnce(new Error("synthetic-storage-failure"));
      const initializing = f.service.handle({ type: "diagnostics_state" });
      await vi.waitFor(() =>
        expect(f.storage.session.get).toHaveBeenCalledWith(DIAGNOSTIC_HISTORY_KEY),
      );
      f.setAccount(accountB);
      f.service.syncAccount(true);
      reading.resolve({ [DIAGNOSTIC_HISTORY_KEY]: storedHistory });
      const response = await initializing;
      expect(response.ok).toBe(true);
      expect(response.state.historyCount).toBe(0);
      const prepared = await f.service.handle({ type: "diagnostics_run" });
      const viewed = await f.service.handle({
        type: "diagnostics_report",
        reportId: prepared.reportId,
      });
      expect(viewed.report).not.toHaveProperty("events");
    },
  );

  it("restores a bounded ten-minute history after a worker restart", async () => {
    const f = fixture();
    await f.service.initialize();
    for (let index = 0; index < 205; index++) f.service.record("initialize", { ok: true }, index);
    await vi.waitFor(() => expect(f.service.state().historyCount).toBe(200));
    await f.settle();
    const restored = f.restart();
    await restored.initialize();
    expect(restored.state().historyCount).toBe(200);
    const prepared = await restored.handle({ type: "diagnostics_run" });
    const viewed = await restored.handle({
      type: "diagnostics_report",
      reportId: prepared.reportId,
    });
    expect(viewed.report).toMatchObject({ truncated: true, dropped_events: 5 });
    expect(viewed.report!.events).toHaveLength(200);
    f.setNow(NOW + 600_001);
    expect(restored.state().historyCount).toBe(0);
    await restored.handle({ type: "diagnostics_clear_history" });
    expect((f.session[DIAGNOSTIC_HISTORY_KEY] as { items: unknown[] }).items).toEqual([]);
    expect(f.fetcher).not.toHaveBeenCalled();
  });

  it("keeps a sanitized manual report available in memory when storage cannot initialize or write", async () => {
    const f = fixture(false);
    f.storage.local.get.mockRejectedValue(new Error("synthetic-storage-failure"));
    f.storage.session.set.mockRejectedValue(new Error("synthetic-storage-failure"));
    const prepared = await f.service.handle({ type: "diagnostics_run" });
    expect(prepared.ok).toBe(true);
    const viewed = await f.service.handle({
      type: "diagnostics_report",
      reportId: prepared.reportId,
    });
    expect(viewed.ok).toBe(true);
    expect(serializeDiagnosticReport(viewed.report)).not.toContain("synthetic-storage-failure");
    expect(f.service.state().reports).toHaveLength(1);
    expect(f.fetcher).not.toHaveBeenCalled();
  });

  it("does not duplicate restored drafts across repeated partial storage initialization failures", async () => {
    const f = fixture();
    const prepared = await f.service.handle({ type: "diagnostics_run" });
    expect(f.session[DIAGNOSTIC_DRAFTS_KEY]).toBeDefined();
    f.storage.local.get.mockRejectedValue(new Error("synthetic-storage-failure"));
    const restored = f.restart();
    for (let index = 0; index < 3; index++) {
      expect(
        (await restored.handle({ type: "diagnostics_report", reportId: prepared.reportId })).ok,
      ).toBe(true);
      expect(restored.state().reports).toHaveLength(1);
    }
    expect(f.fetcher).not.toHaveBeenCalled();
  });
});
