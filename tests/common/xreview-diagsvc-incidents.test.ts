// SPDX-License-Identifier: MPL-2.0

import { DiagnosticService, DIAGNOSTIC_DRAFTS_KEY } from "../../src/core/diagnostics/service";
import type { DiagnosticAccount } from "../../src/core/diagnostics/delivery";
import type { DiagnosticReadModel } from "../../src/core/diagnostics/collector";
import { EMPTY_SNAPSHOT } from "../../src/core/shared/state";
import { EMPTY_NETWORK_OBSERVATION } from "../../src/core/shared/network";

const NOW = Date.parse("2026-10-28T12:00:00Z");
const DAY = 86_400_000;
const OWNER = "owner-a";

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
        report_id: "b2000000-0000-4000-8000-000000000001",
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
    canSendDiagnostics: vi.fn(async () => true),
    environment: async () => ({ browser_name: "chrome" as const }),
    now: () => now,
    language: () => "fr" as const,
    version: () => "0.9.2",
    onChanged: vi.fn(),
    uuid: () => `a2000000-0000-4000-8000-${(++sequence).toString(16).padStart(12, "0")}`,
  };
  const service = new DiagnosticService(dependencies);
  await service.initialize();
  await service.delivery.pump();
  const flush = async (target = service) => {
    await (target as unknown as { work: Promise<void> }).work;
    await (target as unknown as { writes: Promise<void> }).writes.catch(() => undefined);
    await target.delivery.pump();
  };
  const write = storage.session.set.getMockImplementation()!;
  return {
    service,
    fetcher,
    flush,
    requestAuto: (enabled: boolean) => {
      const state = service.state();
      return service.handle({
        type: "diagnostics_set_auto",
        enabled,
        workerId: state.workerId,
        accountEpoch: state.accountEpoch,
      });
    },
    /** Only the drafts/incidents store fails; history and delivery stay writable. */
    failIncidentStore: (failing: boolean) =>
      storage.session.set.mockImplementation(async (value) => {
        if (failing && DIAGNOSTIC_DRAFTS_KEY in value) throw new Error("synthetic-storage-failure");
        await write(value);
      }),
    incidents: () => (session[DIAGNOSTIC_DRAFTS_KEY] as { incidents: unknown[] }).incidents,
    setNow: (value: number) => {
      now = value;
    },
    restart: () => new DiagnosticService(dependencies),
  };
}

async function countTwoRepeatedErrors(f: Awaited<ReturnType<typeof fixture>>) {
  expect(await f.requestAuto(true)).toMatchObject({ ok: true });
  for (let index = 0; index < 2; index++) {
    f.service.record("connect", { ok: false, commandError: "network_error" });
    await f.flush();
  }
  expect(f.incidents()).toMatchObject([{ code: "network_error", count: 2 }]);
}

describe("an accepted opt-in durably drops repeated-error counts of an older one", () => {
  afterEach(() => vi.unstubAllGlobals());

  it.each(["initialize", "historyAlarm"] as const)(
    "does not restore counts whose purge by OFF failed after ON and a restart (%s)",
    async (wake) => {
      const f = await fixture();
      await countTwoRepeatedErrors(f);
      f.failIncidentStore(true);
      expect(await f.requestAuto(false)).toMatchObject({
        ok: true,
        state: { autoReporting: false },
      });
      await f.flush();
      // Only the in-memory counters were purged; storage still holds the old count.
      expect(f.incidents()).toMatchObject([{ count: 2 }]);
      f.failIncidentStore(false);
      expect(await f.requestAuto(true)).toMatchObject({ ok: true, state: { autoReporting: true } });
      expect(f.incidents()).toEqual([]);
      // A worker stopped before the housekeeping retry, or woken by that alarm.
      const restarted = f.restart();
      await restarted[wake]();
      restarted.record("connect", { ok: false, commandError: "network_error" });
      await f.flush(restarted);
      expect(f.incidents()).toMatchObject([{ code: "network_error", count: 1 }]);
      expect(f.fetcher).not.toHaveBeenCalled();
    },
  );

  it("refuses ON until the purge reaches storage, without blocking OFF", async () => {
    const f = await fixture();
    await countTwoRepeatedErrors(f);
    f.failIncidentStore(true);
    expect(await f.requestAuto(false)).toMatchObject({ ok: true, state: { autoReporting: false } });
    expect(await f.requestAuto(true)).toMatchObject({
      ok: false,
      error: "storage_unavailable",
      state: { autoReporting: false },
    });
    expect(f.incidents()).toMatchObject([{ count: 2 }]);
    f.failIncidentStore(false);
    expect(await f.requestAuto(true)).toMatchObject({ ok: true, state: { autoReporting: true } });
    expect(f.incidents()).toEqual([]);
    f.service.record("connect", { ok: false, commandError: "network_error" });
    await f.flush();
    expect(f.incidents()).toMatchObject([{ code: "network_error", count: 1 }]);
    expect(f.fetcher).not.toHaveBeenCalled();
  });
});

describe("repeated-error counters use one ten-minute window", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("restores and extends a counter up to exactly ten minutes after its first error", async () => {
    const f = await fixture();
    expect(await f.requestAuto(true)).toMatchObject({ ok: true });
    f.setNow(NOW + 500);
    f.service.record("connect", { ok: false, commandError: "network_error" });
    await f.flush();
    f.setNow(NOW + 500 + 600_000);
    const kept = f.restart();
    await kept.initialize();
    kept.record("connect", { ok: false, commandError: "network_error" });
    await f.flush(kept);
    expect(f.incidents()).toMatchObject([{ count: 2, first: NOW + 500 }]);
    f.setNow(NOW + 500 + 600_001);
    const expired = f.restart();
    await expired.initialize();
    expect(f.incidents()).toEqual([]);
    expired.record("connect", { ok: false, commandError: "network_error" });
    await f.flush(expired);
    expect(f.incidents()).toMatchObject([{ count: 1, first: NOW + 500 + 600_001 }]);
    expect(f.fetcher).not.toHaveBeenCalled();
  });
});
