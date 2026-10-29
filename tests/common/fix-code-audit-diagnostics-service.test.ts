// SPDX-License-Identifier: MPL-2.0

import {
  DiagnosticService,
  DIAGNOSTIC_DELIVERY_KEY,
  DIAGNOSTIC_DRAFTS_KEY,
} from "../../src/core/diagnostics/service";
import type { DiagnosticAccount } from "../../src/core/diagnostics/delivery";
import type { DiagnosticReadModel } from "../../src/core/diagnostics/collector";
import { EMPTY_SNAPSHOT } from "../../src/core/shared/state";
import { EMPTY_NETWORK_OBSERVATION } from "../../src/core/shared/network";

const NOW = Date.parse("2026-10-28T12:00:00Z");
const TTL = 86_400_000;
const A: DiagnosticAccount = {
  ownerId: "account-a",
  token: "synthetic-a",
  generation: 1,
  expiresAt: NOW + 2 * TTL,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function fixture() {
  let account = { ...A };
  let now = NOW;
  let sequence = 0;
  const local: Record<string, unknown> = {};
  const session: Record<string, unknown> = {};
  const area = (values: Record<string, unknown>) => ({
    get: vi.fn(async (key: string) => ({ [key]: structuredClone(values[key]) })),
    set: vi.fn(async (value: Record<string, unknown>) => {
      Object.assign(values, structuredClone(value));
    }),
  });
  const storage = { local: area(local), session: area(session) };
  const alarms = new Map<string, { when: number }>();
  vi.stubGlobal("browser", {
    storage,
    alarms: {
      create: async (name: string, info: { when: number }) => {
        alarms.set(name, info);
      },
      get: async (name: string) => alarms.get(name),
      clear: async (name: string) => alarms.delete(name),
    },
  });
  const fetcher = vi.fn<typeof fetch>(async (_url, options) => {
    const body = JSON.parse(options?.body as string) as { report_id: string };
    return Response.json(
      {
        report_id: "b1000000-0000-4000-8000-000000000001",
        client_report_id: body.report_id,
        status: "received",
        duplicate: false,
        received_at: new Date(now).toISOString(),
        expires_at: new Date(now + TTL).toISOString(),
      },
      { status: 201 },
    );
  });
  vi.stubGlobal("fetch", fetcher);
  const permission = vi.fn(async () => true);
  const environment = vi.fn(async () => ({ browser_name: "chrome" as const }));
  const dependencies = {
    getAccount: () => account,
    read: (): DiagnosticReadModel => ({
      snapshot: {
        ...structuredClone(EMPTY_SNAPSHOT),
        status: "disconnected",
        profile: {
          userId: account.ownerId,
          email: "",
          firstName: "",
          lastName: "",
          countryCode: "FR",
        },
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
    }),
    inspectSafety: async () => ({
      blockingScope: "none" as const,
      trafficBlocked: false,
      filterActive: false,
      webRtcProtected: false,
    }),
    inspectWebRtc: async () => false,
    getProxyControl: async () => "controllable_by_this_extension" as const,
    verifyProxy: async () => null,
    probe: async () => ({ ...EMPTY_NETWORK_OBSERVATION }),
    canSendDiagnostics: permission,
    now: () => now,
    language: () => "fr" as const,
    version: () => "0.9.2",
    environment,
    onChanged: vi.fn(),
    uuid: () => `a1000000-0000-4000-8000-${(++sequence).toString(16).padStart(12, "0")}`,
  };
  const service = new DiagnosticService(dependencies);
  await service.initialize();
  await service.delivery.pump();
  const bind = (request: Record<string, unknown>) => ({
    ...request,
    workerId: service.state().workerId,
    accountEpoch: service.state().accountEpoch,
  });
  const boundary = async (kind: "aba" | "clear-history") => {
    if (kind === "clear-history") {
      expect(await service.handle({ type: "diagnostics_clear_history" })).toMatchObject({
        ok: true,
      });
      return;
    }
    account = { ...A, ownerId: "account-b", generation: 2 };
    service.syncAccount(true);
    account = { ...A, generation: 3 };
    service.syncAccount(true);
  };
  const flush = async () => {
    await (service as unknown as { work: Promise<void> }).work;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    await service.delivery.pump();
  };
  const enableAutomatic = async () => {
    expect(
      await service.handle(bind({ type: "diagnostics_set_auto", enabled: true })),
    ).toMatchObject({ ok: true });
    await flush();
  };
  const prepareSend = async () => {
    const prepared = await service.handle({ type: "diagnostics_run" });
    expect(prepared.ok).toBe(true);
    return {
      ...bind({ type: "diagnostics_send" }),
      reportId: prepared.reportId!,
      consent: true,
      noticeVersion: 1,
    };
  };
  return {
    service,
    local,
    session,
    storage,
    permission,
    environment,
    fetcher,
    boundary,
    flush,
    enableAutomatic,
    prepareSend,
    advance: (milliseconds: number) => {
      now += milliseconds;
    },
    restart: () => new DiagnosticService(dependencies),
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("CODE-07 automatic incident epoch", () => {
  it.each([
    ["aba", 1],
    ["aba", 2],
    ["aba", 3],
    ["aba", 4],
    ["clear-history", 1],
    ["clear-history", 2],
    ["clear-history", 3],
    ["clear-history", 4],
  ] as const)(
    "discards an incident invalidated by %s during permission query %i",
    async (kind, query) => {
      const f = await fixture();
      await f.enableAutomatic();
      const started = deferred<undefined>();
      const gate = deferred<boolean>();
      for (let index = 1; index < query; index++) f.permission.mockResolvedValueOnce(true);
      f.permission.mockImplementationOnce(async () => {
        started.resolve(undefined);
        return gate.promise;
      });
      f.service.record("connect", { ok: false, commandError: "unknown_error" });
      await started.promise;
      await f.boundary(kind);
      gate.resolve(true);
      await f.flush();
      expect(f.fetcher).not.toHaveBeenCalled();
      expect(f.service.delivery.list(A.ownerId)).toEqual([]);
      expect(f.local[DIAGNOSTIC_DELIVERY_KEY]).toMatchObject({ reports: [] });
      expect(f.session[DIAGNOSTIC_DRAFTS_KEY]).toMatchObject({ incidents: [] });
      // The invalidated operation must not prevent a later, current incident.
      f.service.record("connect", { ok: false, commandError: "unknown_error" });
      await f.flush();
      expect(f.fetcher).toHaveBeenCalledOnce();
      expect(JSON.parse(f.fetcher.mock.calls[0]![1]!.body as string)).toMatchObject({
        occurrences: 1,
      });
    },
  );

  it("discards an incident invalidated while collecting its environment", async () => {
    const f = await fixture();
    await f.enableAutomatic();
    const started = deferred<undefined>();
    const gate = deferred<{ browser_name: "chrome" }>();
    f.environment.mockImplementationOnce(async () => {
      started.resolve(undefined);
      return gate.promise;
    });
    f.service.record("connect", { ok: false, commandError: "unknown_error" });
    await started.promise;
    await f.boundary("aba");
    gate.resolve({ browser_name: "chrome" });
    await f.flush();
    expect(f.fetcher).not.toHaveBeenCalled();
    expect(f.local[DIAGNOSTIC_DELIVERY_KEY]).toMatchObject({ reports: [] });
  });
});

describe("EXTRA-04 manual draft retention", () => {
  it.each([
    [1, false],
    [2, false],
    [1, true],
    [2, true],
  ] as const)(
    "refuses an expired draft at permission query %i (alarm purge: %s)",
    async (query, purge) => {
      const f = await fixture();
      const request = await f.prepareSend();
      const started = deferred<undefined>();
      const gate = deferred<boolean>();
      for (let index = 1; index < query; index++) f.permission.mockResolvedValueOnce(true);
      f.permission.mockImplementationOnce(async () => {
        started.resolve(undefined);
        return gate.promise;
      });
      const pending = f.service.handle(request);
      await started.promise;
      f.advance(TTL);
      if (purge) await f.service.historyAlarm();
      gate.resolve(true);
      expect(await pending).toMatchObject({ ok: false, error: "not_found" });
      await f.flush();
      expect(f.fetcher).not.toHaveBeenCalled();
      expect(f.service.state().reports).toEqual([]);
      expect(f.session[DIAGNOSTIC_DRAFTS_KEY]).toMatchObject({ drafts: [] });
      expect(
        (f.local[DIAGNOSTIC_DELIVERY_KEY] as { reports?: unknown[] } | undefined)?.reports ?? [],
      ).toEqual([]);
      const restarted = f.restart();
      await restarted.initialize();
      expect(restarted.state().reports).toEqual([]);
    },
  );

  it.each([1, 2] as const)("refuses a draft deleted during permission query %i", async (query) => {
    const f = await fixture();
    const request = await f.prepareSend();
    const started = deferred<undefined>();
    const gate = deferred<boolean>();
    for (let index = 1; index < query; index++) f.permission.mockResolvedValueOnce(true);
    f.permission.mockImplementationOnce(async () => {
      started.resolve(undefined);
      return gate.promise;
    });
    const pending = f.service.handle(request);
    await started.promise;
    const deleted = f.service.handle({ type: "diagnostics_delete", reportId: request.reportId });
    // Delivery serializes its mutations: deletion may wait behind this enqueue,
    // but it removes the draft synchronously before entering that delivery queue.
    await vi.waitFor(() => expect(f.service.state().reports).toEqual([]));
    gate.resolve(true);
    expect(await pending).toMatchObject({ ok: false, error: "not_found" });
    expect(await deleted).toMatchObject({ ok: true });
    await f.flush();
    expect(f.fetcher).not.toHaveBeenCalled();
    expect(f.service.state().reports).toEqual([]);
  });
});
