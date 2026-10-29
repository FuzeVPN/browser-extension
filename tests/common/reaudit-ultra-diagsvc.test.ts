// SPDX-License-Identifier: MPL-2.0

import {
  DiagnosticService,
  DIAGNOSTIC_DRAFTS_KEY,
  DIAGNOSTIC_HISTORY_ALARM,
} from "../../src/core/diagnostics/service";
import { DiagnosticHistory } from "../../src/core/diagnostics/history";
import type { DiagnosticAccount } from "../../src/core/diagnostics/delivery";
import type { DiagnosticReadModel } from "../../src/core/diagnostics/collector";
import type { DiagnosticEnvironment } from "../../src/core/shared/diagnostic-report";
import { EMPTY_SNAPSHOT } from "../../src/core/shared/state";
import { EMPTY_NETWORK_OBSERVATION } from "../../src/core/shared/network";

const NOW = Date.parse("2026-10-28T12:00:00Z");
const DAY = 86_400_000;
const OWNER = "owner-a";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function requestBody(options?: RequestInit): string {
  if (typeof options?.body !== "string") throw new Error("expected_json_request_body");
  return options.body;
}

async function fixture() {
  let now = NOW;
  let sequence = 0;
  const account: DiagnosticAccount = {
    ownerId: OWNER,
    token: "synthetic-token",
    expiresAt: NOW + 4 * DAY,
    generation: 1,
  };
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
      create: async (name: string, info: { when: number }) => alarms.set(name, info),
      get: async (name: string) => alarms.get(name),
      clear: async (name: string) => alarms.delete(name),
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
        expires_at: new Date(now + DAY).toISOString(),
      },
      { status: 201 },
    );
  });
  vi.stubGlobal("fetch", fetcher);
  const permission = vi.fn(async () => true);
  const environment = vi.fn(async (): Promise<DiagnosticEnvironment> => ({
    browser_name: "chrome",
  }));
  const dependencies = {
    read: (): DiagnosticReadModel => ({
      snapshot: {
        ...structuredClone(EMPTY_SNAPSHOT),
        status: "disconnected",
        profile: {
          userId: OWNER,
          email: "synthetic@example.invalid",
          firstName: "Synthetic",
          lastName: "User",
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
    getAccount: () => account,
    canSendDiagnostics: permission,
    environment,
    now: () => now,
    language: () => "fr" as const,
    version: () => "0.9.2",
    onChanged: vi.fn(),
    uuid: () => `a1000000-0000-4000-8000-${(++sequence).toString(16).padStart(12, "0")}`,
  };
  const service = new DiagnosticService(dependencies);
  await service.initialize();
  await service.delivery.pump();
  const flush = async (target = service) => {
    await (target as unknown as { work: Promise<void> }).work;
    await (target as unknown as { writes: Promise<void> }).writes.catch(() => undefined);
    await target.delivery.pump();
  };
  const setAuto = (enabled: boolean) => {
    const state = service.state();
    return service.handle({
      type: "diagnostics_set_auto",
      enabled,
      workerId: state.workerId,
      accountEpoch: state.accountEpoch,
    });
  };
  return {
    service,
    storage,
    alarms,
    fetcher,
    permission,
    environment,
    flush,
    setAuto: async (enabled: boolean) => {
      expect(await setAuto(enabled)).toMatchObject({ ok: true });
      await service.delivery.pump();
    },
    requestAuto: setAuto,
    incidents: () => (session[DIAGNOSTIC_DRAFTS_KEY] as { incidents: unknown[] }).incidents,
    setNow: (value: number) => {
      now = value;
    },
    restart: () => new DiagnosticService(dependencies),
  };
}

describe("a successful history clear durably resets repeated-error counters", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("keeps a history window id across restarts and replaces it on every reset", async () => {
    let stored: unknown;
    const dependencies = {
      read: async () => structuredClone(stored),
      write: async (value: unknown) => {
        stored = structuredClone(value);
      },
      now: () => NOW,
    };
    const history = new DiagnosticHistory(dependencies);
    await history.initialize(OWNER);
    const first = history.id();
    const restored = new DiagnosticHistory(dependencies);
    await restored.initialize(OWNER);
    expect(restored.id()).toBe(first);
    await restored.clear(OWNER);
    expect(restored.id()).not.toBe(first);
    expect(stored).toMatchObject({ owner: OWNER, id: restored.id() });
    stored = { owner: OWNER, id: "sensitive-id", items: [], losses: [] };
    const sanitized = new DiagnosticHistory(dependencies);
    await sanitized.initialize(OWNER);
    expect(sanitized.id()).toMatch(/^[0-9a-f-]{36}$/);
    expect(JSON.stringify(stored)).not.toContain("sensitive");
  });

  it("does not restore pre-clear incident counts after their purge fails to persist", async () => {
    const f = await fixture();
    await f.setAuto(true);
    for (let index = 0; index < 2; index++) {
      f.service.record("connect", { ok: false, commandError: "network_error" });
      await f.flush();
    }
    expect(f.incidents()).toMatchObject([{ code: "network_error", count: 2 }]);
    const write = f.storage.session.set.getMockImplementation()!;
    f.storage.session.set.mockImplementation(async (value) => {
      if (DIAGNOSTIC_DRAFTS_KEY in value) throw new Error("synthetic-storage-failure");
      await write(value);
    });
    expect(await f.service.handle({ type: "diagnostics_clear_history" })).toMatchObject({
      ok: true,
      state: { historyCount: 0 },
    });
    await f.flush();
    // Only the history reset reached storage; the old counter is still persisted.
    expect(f.incidents()).toMatchObject([{ count: 2 }]);
    f.storage.session.set.mockImplementation(write);
    const restarted = f.restart();
    await restarted.initialize();
    restarted.record("connect", { ok: false, commandError: "network_error" });
    await f.flush(restarted);
    expect(f.incidents()).toMatchObject([{ code: "network_error", count: 1 }]);
    expect(f.fetcher).not.toHaveBeenCalled();
  });
});

describe("an automatic opt-in covers only incidents counted under it", () => {
  afterEach(() => vi.unstubAllGlobals());

  it.each(["environment", "permission-1", "permission-2", "permission-3"] as const)(
    "does not revive an incident prepared before OFF/ON during %s",
    async (gate) => {
      const f = await fixture();
      await f.setAuto(true);
      const entered = deferred<undefined>();
      const release = deferred<undefined>();
      if (gate === "environment")
        f.environment.mockImplementationOnce(async () => {
          entered.resolve(undefined);
          await release.promise;
          return { browser_name: "chrome" };
        });
      else {
        for (let query = 1; query < Number(gate.slice(-1)); query++)
          f.permission.mockResolvedValueOnce(true);
        f.permission.mockImplementationOnce(async () => {
          entered.resolve(undefined);
          await release.promise;
          return true;
        });
      }
      f.service.record("connect", { ok: false, commandError: "unknown_error" });
      await entered.promise;
      await f.setAuto(false);
      await f.setAuto(true);
      release.resolve(undefined);
      await f.flush();
      expect(f.fetcher).not.toHaveBeenCalled();
      expect(f.service.delivery.list(OWNER)).toEqual([]);
    },
  );

  it("does not commit an incident whose enqueue was holding the delivery lock during OFF", async () => {
    const f = await fixture();
    await f.setAuto(true);
    const entered = deferred<undefined>();
    const release = deferred<undefined>();
    for (let query = 1; query < 4; query++) f.permission.mockResolvedValueOnce(true);
    f.permission.mockImplementationOnce(async () => {
      entered.resolve(undefined);
      await release.promise;
      return true;
    });
    f.service.record("connect", { ok: false, commandError: "unknown_error" });
    await entered.promise;
    const off = f.requestAuto(false);
    await vi.waitFor(() => expect(f.service.state().autoReporting).toBe(false));
    const on = f.requestAuto(true);
    release.resolve(undefined);
    expect(await off).toMatchObject({ ok: true });
    expect(await on).toMatchObject({ ok: true });
    await f.flush();
    expect(f.fetcher).not.toHaveBeenCalled();
  });

  it("does not count repeated errors from an earlier opt-in after OFF/ON", async () => {
    const f = await fixture();
    await f.setAuto(true);
    for (let index = 0; index < 2; index++) {
      f.service.record("connect", { ok: false, commandError: "network_error" });
      await f.flush();
    }
    await f.setAuto(false);
    await f.setAuto(true);
    await f.flush();
    expect(f.incidents()).toEqual([]);
    f.service.record("connect", { ok: false, commandError: "network_error" });
    await f.flush();
    expect(f.incidents()).toMatchObject([{ code: "network_error", count: 1 }]);
    expect(f.fetcher).not.toHaveBeenCalled();
  });

  it("does not report an error recorded before the opt-in completed", async () => {
    const f = await fixture();
    const entered = deferred<undefined>();
    const release = deferred<undefined>();
    const write = f.storage.session.set.getMockImplementation()!;
    f.storage.session.set.mockImplementationOnce(async (value) => {
      entered.resolve(undefined);
      await release.promise;
      await write(value);
    });
    f.service.record("connect", { ok: false, commandError: "unknown_error" });
    await entered.promise;
    await f.setAuto(true);
    release.resolve(undefined);
    await f.flush();
    expect(f.fetcher).not.toHaveBeenCalled();
  });

  it("still reports a new incident under the renewed opt-in", async () => {
    const f = await fixture();
    await f.setAuto(true);
    await f.setAuto(false);
    await f.setAuto(true);
    f.service.record("connect", { ok: false, commandError: "unknown_error" });
    await f.flush();
    expect(f.fetcher).toHaveBeenCalledOnce();
    expect(JSON.parse(requestBody(f.fetcher.mock.calls[0]![1]))).toMatchObject({
      report_type: "simple",
      occurrences: 1,
      consent: { mode: "automatic_opt_in" },
      error: { code: "unknown_error", operation: "connect" },
    });
  });
});

describe("repeated-error counters expire with the technical history window", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("erases an expired counter on its own housekeeping deadline", async () => {
    const f = await fixture();
    await f.setAuto(true);
    f.setNow(NOW + 500);
    f.service.record("connect", { ok: false, commandError: "network_error" });
    await f.flush();
    expect(f.incidents()).toMatchObject([{ code: "network_error", count: 1, first: NOW + 500 }]);
    f.setNow(NOW + 600_001);
    await f.service.historyAlarm();
    // The event expired with its whole-second bucket; the counter still has 500 ms left.
    expect(f.service.state().historyCount).toBe(0);
    expect(f.incidents()).toHaveLength(1);
    expect(f.alarms.get(DIAGNOSTIC_HISTORY_ALARM)?.when).toBe(NOW + 601_001);
    f.setNow(NOW + 601_001);
    await f.service.historyAlarm();
    expect(f.incidents()).toEqual([]);
    expect(f.alarms.has(DIAGNOSTIC_HISTORY_ALARM)).toBe(false);
    expect(f.fetcher).not.toHaveBeenCalled();
  });
});
