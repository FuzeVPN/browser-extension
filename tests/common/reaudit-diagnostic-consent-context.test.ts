// SPDX-License-Identifier: MPL-2.0

import { DiagnosticService } from "../../src/core/diagnostics/service";
import type { DiagnosticAccount } from "../../src/core/diagnostics/delivery";
import type { DiagnosticReadModel } from "../../src/core/diagnostics/collector";
import {
  isDiagnosticRequest,
  type DiagnosticRequest,
  type DiagnosticWorkerRequest,
} from "../../src/core/shared/diagnostics-ui";
import { EMPTY_SNAPSHOT } from "../../src/core/shared/state";
import { EMPTY_NETWORK_OBSERVATION } from "../../src/core/shared/network";
import { DiagnosticConnection } from "../../src/ui/diagnostics-page/client";

const NOW = Date.parse("2026-10-27T12:00:00Z");
const account = (ownerId: string, generation = 1): DiagnosticAccount => ({
  ownerId,
  token: `synthetic-token-${ownerId}`,
  generation,
  expiresAt: NOW + 3_600_000,
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

async function fixture() {
  let current = account("owner-a");
  const local: Record<string, unknown> = {};
  const session: Record<string, unknown> = {};
  const area = (values: Record<string, unknown>) => ({
    get: vi.fn(async (key: string) => ({ [key]: structuredClone(values[key]) })),
    set: vi.fn(async (value: Record<string, unknown>) => {
      Object.assign(values, structuredClone(value));
    }),
  });
  const alarms = new Map<string, { when: number }>();
  vi.stubGlobal("browser", {
    storage: { local: area(local), session: area(session) },
    alarms: {
      create: async (name: string, value: { when: number }) => alarms.set(name, value),
      get: async (name: string) => alarms.get(name),
      clear: async (name: string) => alarms.delete(name),
    },
  });
  const fetcher = vi.fn(async () => new Response("{}", { status: 503 }));
  vi.stubGlobal("fetch", fetcher);
  const dependencies = {
    getAccount: () => current,
    read: (): DiagnosticReadModel => ({
      snapshot: {
        ...structuredClone(EMPTY_SNAPSHOT),
        status: "disconnected",
        profile: {
          userId: current.ownerId,
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
    canSendDiagnostics: async () => true,
    now: () => NOW,
    language: () => "fr" as const,
    version: () => "0.9.2",
    environment: async () => ({ browser_name: "chrome" as const }),
    onChanged: vi.fn(),
  };
  const service = new DiagnosticService(dependencies);
  await service.initialize();
  await service.delivery.pump();
  const send = vi.fn((request: DiagnosticWorkerRequest) => service.handle(request));
  const client = new DiagnosticConnection(() => undefined, send);
  client.receive({ type: "diagnostics_changed", state: service.state() });
  return {
    service,
    client,
    send,
    local,
    fetcher,
    switchAccount(owner: string, generation = 2) {
      current = account(owner, generation);
      service.syncAccount(true);
    },
    restart: () => new DiagnosticService(dependencies),
    bind(request: DiagnosticRequest) {
      const state = service.state();
      return { ...request, workerId: state.workerId, accountEpoch: state.accountEpoch };
    },
  };
}

describe("diagnostic consent is bound to its originating worker and account", () => {
  afterEach(() => vi.unstubAllGlobals());

  it.each([
    {},
    { workerId: "worker" },
    { accountEpoch: 0 },
    { workerId: "", accountEpoch: 0 },
    { workerId: "x".repeat(201), accountEpoch: 0 },
    { workerId: "worker", accountEpoch: -1 },
    { workerId: "worker", accountEpoch: 0.5 },
    { workerId: "worker", accountEpoch: "0" },
    { workerId: "worker", accountEpoch: Number.MAX_SAFE_INTEGER + 1 },
  ])("rejects an absent or malformed wire context %j", async (context) => {
    const f = await fixture();
    const request = { type: "diagnostics_set_auto", enabled: true, ...context };
    expect(isDiagnosticRequest(request)).toBe(false);
    expect(await f.service.handle(request)).toMatchObject({ ok: false, error: "invalid_report" });
    expect(f.service.state().autoReporting).toBe(false);
    expect(f.fetcher).not.toHaveBeenCalled();
  });

  it("requires context for manual consent too and rejects extra context keys", async () => {
    const f = await fixture();
    const request = {
      type: "diagnostics_send",
      reportId: "a1000000-0000-4000-8000-000000000001",
      consent: true,
      noticeVersion: 1,
    };
    expect(isDiagnosticRequest(request)).toBe(false);
    const bound = f.bind(request as DiagnosticRequest);
    expect(isDiagnosticRequest(bound)).toBe(true);
    expect(isDiagnosticRequest({ ...bound, ownerId: "owner-b" })).toBe(false);
  });

  it("accepts the current context while retaining a per-account preference", async () => {
    const f = await fixture();
    const state = f.service.state();
    const prompt = vi.fn(async () => true);
    expect(
      await f.client.requestWithDataConsent(
        { type: "diagnostics_set_auto", enabled: true },
        prompt,
      ),
    ).toMatchObject({ ok: true, state: { autoReporting: true } });
    expect(prompt).toHaveBeenCalledOnce();
    expect(f.send).toHaveBeenCalledExactlyOnceWith({
      type: "diagnostics_set_auto",
      enabled: true,
      workerId: state.workerId,
      accountEpoch: state.accountEpoch,
    });
    expect(f.service.delivery.getAuto("owner-a")).toBe(true);
    expect(f.service.delivery.getAuto("owner-b")).toBe(false);
  });

  it.each(["switch", "aba"])(
    "rejects a pending native grant after %s even before any account broadcast arrives",
    async (change) => {
      const f = await fixture();
      const grant = deferred<boolean>();
      const original = f.client.state!;
      const pending = f.client.requestWithDataConsent(
        { type: "diagnostics_set_auto", enabled: true },
        () => grant.promise,
      );
      f.switchAccount("owner-b");
      if (change === "aba") f.switchAccount("owner-a", 3);
      expect(f.client.state).toBe(original);
      grant.resolve(true);
      expect(await pending).toMatchObject({ ok: false, error: "invalid_report" });
      expect(f.client.error).toBeNull();
      expect(f.service.delivery.getAuto("owner-a")).toBe(false);
      expect(f.service.delivery.getAuto("owner-b")).toBe(false);
      expect(JSON.stringify(f.local)).not.toContain('"automatic":true');
      expect(f.fetcher).not.toHaveBeenCalled();
    },
  );

  it("rejects an old worker context even when the restarted worker has the same account epoch", async () => {
    const f = await fixture();
    const request = f.bind({ type: "diagnostics_set_auto", enabled: true });
    const restarted = f.restart();
    await restarted.initialize();
    expect(restarted.state().accountEpoch).toBe(request.accountEpoch);
    expect(restarted.state().workerId).not.toBe(request.workerId);
    expect(await restarted.handle(request)).toMatchObject({ ok: false, error: "invalid_report" });
    expect(restarted.state().autoReporting).toBe(false);
    expect(f.fetcher).not.toHaveBeenCalled();
  });

  it("rejects manual send with an old context even after returning to the report's owner", async () => {
    const f = await fixture();
    const prepared = await f.service.handle({ type: "diagnostics_run" });
    expect(prepared.ok).toBe(true);
    const request = f.bind({
      type: "diagnostics_send",
      reportId: prepared.reportId!,
      consent: true,
      noticeVersion: 1,
    });
    f.switchAccount("owner-b");
    f.switchAccount("owner-a", 3);
    expect(await f.service.handle(request)).toMatchObject({ ok: false, error: "invalid_report" });
    expect(f.fetcher).not.toHaveBeenCalled();
    expect(f.service.state().reports).toContainEqual(
      expect.objectContaining({ id: prepared.reportId, status: "ready" }),
    );
  });

  it("keeps reads available but refuses native consent with a historical context lacking epoch", async () => {
    const f = await fixture();
    f.client.receive({
      type: "diagnostics_changed",
      state: { ...f.service.state(), accountEpoch: undefined },
    });
    const prompt = vi.fn(async () => true);
    expect(
      await f.client.requestWithDataConsent(
        { type: "diagnostics_set_auto", enabled: true },
        prompt,
      ),
    ).toBeNull();
    expect(prompt).not.toHaveBeenCalled();
    expect(f.send).not.toHaveBeenCalled();
    expect(f.client.available).toBe(true);
    expect(await f.client.request({ type: "diagnostics_state" })).toMatchObject({ ok: true });
  });

  it.each(["account", "worker"])(
    "does not let an old request failure replace a newer %s error",
    async (boundary) => {
      const f = await fixture();
      const response = deferred<unknown>();
      const client = new DiagnosticConnection(
        () => undefined,
        () => response.promise,
      );
      const before = f.service.state();
      client.receive({ type: "diagnostics_changed", state: before });
      const pending = client.request({ type: "diagnostics_set_auto", enabled: true });
      const after = {
        ...before,
        revision: before.revision + 10,
        ...(boundary === "account"
          ? { accountEpoch: before.accountEpoch! + 1 }
          : { workerId: "new-worker" }),
      };
      client.receive({ type: "diagnostics_changed", state: after });
      client.error = "queue_full";
      response.resolve({
        diagnosticsVersion: 1,
        ok: false,
        error: "invalid_report",
        state: { ...after, revision: after.revision + 1 },
      });
      expect(await pending).toMatchObject({ ok: false, error: "invalid_report" });
      expect(client.error).toBe("queue_full");
    },
  );

  it("preserves a relevant first-response error before any worker state was received", async () => {
    const f = await fixture();
    const client = new DiagnosticConnection(
      () => undefined,
      async () => ({
        diagnosticsVersion: 1,
        ok: false,
        error: "storage_unavailable",
        state: f.service.state(),
      }),
    );
    await client.request({ type: "diagnostics_state" });
    expect(client.available).toBe(true);
    expect(client.error).toBe("storage_unavailable");
  });
});
