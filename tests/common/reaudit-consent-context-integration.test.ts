// SPDX-License-Identifier: MPL-2.0

import { DiagnosticService, DIAGNOSTIC_DELIVERY_KEY } from "../../src/core/diagnostics/service";
import type { DiagnosticAccount } from "../../src/core/diagnostics/delivery";
import type { DiagnosticReadModel } from "../../src/core/diagnostics/collector";
import {
  isDiagnosticRequest,
  type DiagnosticUiState,
  type DiagnosticWorkerRequest,
} from "../../src/core/shared/diagnostics-ui";
import { EMPTY_SNAPSHOT } from "../../src/core/shared/state";
import { EMPTY_NETWORK_OBSERVATION } from "../../src/core/shared/network";
import { DiagnosticConnection } from "../../src/ui/diagnostics-page/client";
import { requestDiagnosticsConsent } from "../../src/platform/firefox/data-consent";

const NOW = Date.parse("2026-10-27T12:00:00Z");
const accountA: DiagnosticAccount = {
  ownerId: "consent-owner-a",
  token: "synthetic-token-a",
  generation: 1,
  expiresAt: NOW + 3_600_000,
};
const accountB: DiagnosticAccount = {
  ownerId: "consent-owner-b",
  token: "synthetic-token-b",
  generation: 2,
  expiresAt: NOW + 3_600_000,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function profile(account: DiagnosticAccount | null) {
  return account
    ? { userId: account.ownerId, email: "", firstName: "", lastName: "", countryCode: "FR" }
    : null;
}

async function fixture() {
  let account: DiagnosticAccount | null = { ...accountA };
  let permissionGranted = false;
  const permissionPrompt = deferred<boolean>();
  const local: Record<string, unknown> = {};
  const session: Record<string, unknown> = {};
  const broadcasts: DiagnosticUiState[] = [];
  const model: DiagnosticReadModel = {
    snapshot: {
      ...structuredClone(EMPTY_SNAPSHOT),
      status: "disconnected",
      profile: profile(account),
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
  const area = (data: Record<string, unknown>) => ({
    get: vi.fn(async (key: string) => ({ [key]: structuredClone(data[key]) })),
    set: vi.fn(async (value: Record<string, unknown>) => {
      Object.assign(data, structuredClone(value));
    }),
  });
  const storage = { local: area(local), session: area(session) };
  const alarms = new Map<string, number>();
  const getAllPermissions = vi.fn(async () => ({
    data_collection: permissionGranted ? ["technicalAndInteraction"] : [],
  }));
  const requestPermission = vi.fn(async () => permissionPrompt.promise);
  vi.stubGlobal("browser", {
    storage,
    alarms: {
      create: async (name: string, info: { when: number }) => {
        alarms.set(name, info.when);
      },
      get: async (name: string) =>
        alarms.has(name) ? { name, scheduledTime: alarms.get(name) } : undefined,
      clear: async (name: string) => alarms.delete(name),
    },
    permissions: { getAll: getAllPermissions, request: requestPermission },
  });
  const fetcher = vi.fn<typeof fetch>(async (_url, options) => {
    if (typeof options?.body !== "string") throw new Error("expected_json_report");
    const body = JSON.parse(options.body) as { report_id: string };
    return Response.json(
      {
        report_id: "b1000000-0000-4000-8000-000000000001",
        client_report_id: body.report_id,
        status: "received",
        duplicate: false,
        received_at: new Date(NOW).toISOString(),
        expires_at: new Date(NOW + 86_400_000).toISOString(),
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
    probe: async () => ({ ...EMPTY_NETWORK_OBSERVATION }),
    getAccount: () => account,
    now: () => NOW,
    language: () => "fr" as const,
    version: () => "0.9.2",
    environment: async () => ({ browser_name: "chrome" as const }),
    onChanged: (state: DiagnosticUiState) => broadcasts.push(structuredClone(state)),
  };
  let service = new DiagnosticService(dependencies);
  await service.initialize();
  await service.delivery.pump();
  const send = vi.fn(async (request: DiagnosticWorkerRequest) => service.handle(request));
  const client = new DiagnosticConnection(() => {}, send);
  const receiveCurrent = () =>
    client.receive({ type: "diagnostics_changed", state: service.state() });
  receiveCurrent();
  const switchAccount = (next: DiagnosticAccount | null) => {
    account = next;
    model.snapshot.profile = profile(next);
    model.snapshot.status = next ? "disconnected" : "logged_out";
    service.syncAccount(true);
  };
  const settle = async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    await service.delivery.pump();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  };
  return {
    client,
    send,
    broadcasts,
    storage,
    local,
    fetcher,
    getAllPermissions,
    requestPermission,
    get service() {
      return service;
    },
    receiveCurrent,
    switchAccount,
    settle,
    grantPrompt: (granted: boolean) => {
      permissionGranted = granted;
      permissionPrompt.resolve(granted);
    },
    setPermission: (granted: boolean) => {
      permissionGranted = granted;
    },
    restart: async () => {
      service = new DiagnosticService(dependencies);
      await service.initialize();
      await service.delivery.pump();
    },
    persistedAutomaticOwners: () => {
      const stored = local[DIAGNOSTIC_DELIVERY_KEY] as
        { accounts: { ownerId: string; automatic: boolean }[] } | undefined;
      return (
        stored?.accounts.filter((value) => value.automatic).map((value) => value.ownerId) ?? []
      );
    },
  };
}

async function consentIntent(f: Awaited<ReturnType<typeof fixture>>, kind: "automatic" | "manual") {
  if (kind === "automatic") return { type: "diagnostics_set_auto", enabled: true } as const;
  const prepared = await f.service.handle({ type: "diagnostics_run" });
  expect(prepared.ok).toBe(true);
  expect(prepared.reportId).toBeDefined();
  f.receiveCurrent();
  return {
    type: "diagnostics_send",
    reportId: prepared.reportId!,
    consent: true,
    noticeVersion: 1,
  } as const;
}

describe("diagnostics consent context across the real UI client and service", () => {
  afterEach(() => vi.unstubAllGlobals());

  it.each(["account-b", "aba", "new-worker"] as const)(
    "rejects the original automatic opt-in after %s even when all boundary broadcasts are delayed",
    async (boundary) => {
      const f = await fixture();
      const origin = f.client.state!;
      const pending = f.client.requestWithDataConsent(
        { type: "diagnostics_set_auto", enabled: true },
        requestDiagnosticsConsent,
      );
      expect(f.requestPermission).toHaveBeenCalledOnce();
      expect(f.send).not.toHaveBeenCalled();
      if (boundary === "new-worker") await f.restart();
      else {
        f.switchAccount({ ...accountB });
        if (boundary === "aba") f.switchAccount({ ...accountA, generation: 3 });
      }
      expect(f.client.state).toBe(origin);
      f.grantPrompt(true);
      expect(await pending).toMatchObject({ ok: false, error: "invalid_report" });
      expect(f.client.error).toBeNull();
      expect(f.send).toHaveBeenCalledWith({
        type: "diagnostics_set_auto",
        enabled: true,
        workerId: origin.workerId,
        accountEpoch: origin.accountEpoch,
      });
      expect(f.service.delivery.getAuto(accountA.ownerId)).toBe(false);
      expect(f.service.delivery.getAuto(accountB.ownerId)).toBe(false);
      expect(f.persistedAutomaticOwners()).toEqual([]);
      f.service.record("connect", { ok: false, commandError: "unknown_error" });
      await f.settle();
      expect(f.fetcher).not.toHaveBeenCalled();
    },
  );

  it.each(["account-b", "aba", "new-worker"] as const)(
    "rejects an old manual-report consent after %s without queuing or uploading it",
    async (boundary) => {
      const f = await fixture();
      const intent = await consentIntent(f, "manual");
      const pending = f.client.requestWithDataConsent(intent, requestDiagnosticsConsent);
      if (boundary === "new-worker") await f.restart();
      else {
        f.switchAccount({ ...accountB });
        if (boundary === "aba") f.switchAccount({ ...accountA, generation: 3 });
      }
      f.grantPrompt(true);
      expect(await pending).toMatchObject({ ok: false, error: "invalid_report" });
      expect(f.client.error).toBeNull();
      await f.settle();
      expect(f.service.delivery.list(accountA.ownerId)).toEqual([]);
      expect(f.service.delivery.list(accountB.ownerId)).toEqual([]);
      expect(f.fetcher).not.toHaveBeenCalled();
    },
  );

  it("drops consent locally when the new account epoch was already delivered", async () => {
    const f = await fixture();
    const pending = f.client.requestWithDataConsent(
      { type: "diagnostics_set_auto", enabled: true },
      requestDiagnosticsConsent,
    );
    f.switchAccount({ ...accountB });
    f.receiveCurrent();
    f.grantPrompt(true);
    expect(await pending).toBeNull();
    expect(f.send).not.toHaveBeenCalled();
    expect(f.persistedAutomaticOwners()).toEqual([]);
    expect(f.fetcher).not.toHaveBeenCalled();
  });

  it("does not transmit a context-bound command after native permission is refused", async () => {
    const f = await fixture();
    const pending = f.client.requestWithDataConsent(
      { type: "diagnostics_set_auto", enabled: true },
      requestDiagnosticsConsent,
    );
    f.grantPrompt(false);
    expect(await pending).toBeNull();
    expect(f.client.error).toBe("data_collection_required");
    expect(f.send).not.toHaveBeenCalled();
    expect(f.persistedAutomaticOwners()).toEqual([]);
    expect(f.fetcher).not.toHaveBeenCalled();
  });

  it("refuses a pending consent after logout without marking the new signed-out UI as failed", async () => {
    const f = await fixture();
    const pending = f.client.requestWithDataConsent(
      { type: "diagnostics_set_auto", enabled: true },
      requestDiagnosticsConsent,
    );
    f.switchAccount(null);
    f.grantPrompt(true);
    expect(await pending).toMatchObject({ ok: false, error: "session_required" });
    expect(f.client.state?.signedIn).toBe(false);
    expect(f.client.error).toBeNull();
    expect(f.persistedAutomaticOwners()).toEqual([]);
    expect(f.fetcher).not.toHaveBeenCalled();
  });

  it.each(["automatic", "manual"] as const)(
    "accepts current %s consent and sends only the current owner's report",
    async (kind) => {
      const f = await fixture();
      const intent = await consentIntent(f, kind);
      const pending = f.client.requestWithDataConsent(intent, requestDiagnosticsConsent);
      f.grantPrompt(true);
      expect(await pending).toMatchObject({ ok: true });
      if (kind === "automatic") {
        expect(f.persistedAutomaticOwners()).toEqual([accountA.ownerId]);
        f.service.record("connect", { ok: false, commandError: "unknown_error" });
      }
      await f.settle();
      expect(f.fetcher).toHaveBeenCalledOnce();
      const [url, init] = f.fetcher.mock.calls[0]!;
      expect(url).toBe("https://api.fuzevpn.com/v1/diagnostics");
      expect(new Headers(init?.headers).get("Authorization")).toBe(`Bearer ${accountA.token}`);
      const body = JSON.parse(init?.body as string) as { consent: { mode: string } };
      expect(body.consent.mode).toBe(kind === "automatic" ? "automatic_opt_in" : "manual");
      expect(f.service.delivery.getAuto(accountB.ownerId)).toBe(false);
    },
  );

  it.each([
    {},
    { workerId: "worker-without-epoch" },
    { accountEpoch: 0 },
    { workerId: "", accountEpoch: 0 },
    { workerId: "x".repeat(201), accountEpoch: 0 },
    { workerId: "worker", accountEpoch: -1 },
    { workerId: "worker", accountEpoch: 0.5 },
    { workerId: "worker", accountEpoch: Number.NaN },
    { workerId: "worker", accountEpoch: Number.POSITIVE_INFINITY },
    { workerId: "worker", accountEpoch: Number.MAX_SAFE_INTEGER + 1 },
    { workerId: "worker", accountEpoch: 0, extra: true },
  ])(
    "rejects missing or invalid wire consent context %j for both mutation kinds",
    async (context) => {
      const f = await fixture();
      const manual = await consentIntent(f, "manual");
      for (const intent of [{ type: "diagnostics_set_auto", enabled: true }, manual]) {
        const wire = { ...intent, ...context };
        expect(isDiagnosticRequest(wire)).toBe(false);
        expect(await f.service.handle(wire)).toMatchObject({ ok: false, error: "invalid_report" });
      }
      expect(f.persistedAutomaticOwners()).toEqual([]);
      expect(f.service.delivery.list(accountA.ownerId)).toEqual([]);
      expect(f.fetcher).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["automatic", 1],
    ["automatic", 2],
    ["manual", 1],
    ["manual", 2],
  ] as const)(
    "rechecks the original epoch for %s after native permission await %i, including inside the queued mutation",
    async (kind, blockedRead) => {
      const f = await fixture();
      const intent = await consentIntent(f, kind);
      f.setPermission(true);
      await f.settle();
      f.getAllPermissions.mockClear();
      const readPermission = deferred<{ data_collection: string[] }>();
      if (blockedRead === 2)
        f.getAllPermissions.mockResolvedValueOnce({ data_collection: ["technicalAndInteraction"] });
      f.getAllPermissions.mockReturnValueOnce(readPermission.promise);
      const pending = f.client.request(intent);
      await vi.waitFor(() => expect(f.getAllPermissions).toHaveBeenCalledTimes(blockedRead));
      f.switchAccount({ ...accountB });
      f.switchAccount({ ...accountA, generation: 3 });
      readPermission.resolve({ data_collection: ["technicalAndInteraction"] });
      expect(await pending).toMatchObject({ ok: false, error: "invalid_report" });
      expect(f.client.error).toBeNull();
      expect(f.persistedAutomaticOwners()).toEqual([]);
      expect(f.service.delivery.getAuto(accountA.ownerId)).toBe(false);
      expect(f.service.delivery.getAuto(accountB.ownerId)).toBe(false);
      expect(f.service.delivery.list(accountA.ownerId)).toEqual([]);
      expect(f.service.delivery.list(accountB.ownerId)).toEqual([]);
      expect(f.fetcher).not.toHaveBeenCalled();
    },
  );

  it.each(["automatic", "manual"] as const)(
    "revalidates %s consent after it waits behind an earlier durable write",
    async (kind) => {
      const f = await fixture();
      const intent = await consentIntent(f, kind);
      f.setPermission(true);
      await f.settle();
      const writeStarted = deferred<boolean>();
      const releaseWrite = deferred<boolean>();
      f.storage.local.set.mockImplementationOnce(async () => {
        writeStarted.resolve(true);
        await releaseWrite.promise;
        throw new Error("synthetic_preceding_write_failure");
      });
      const preceding = f.service.delivery
        .setAuto(accountA.ownerId, true)
        .catch((error: unknown) => error);
      await writeStarted.promise;
      const permissionReads = f.getAllPermissions.mock.calls.length;
      const pending = f.client.request(intent);
      await vi.waitFor(() =>
        expect(f.getAllPermissions.mock.calls.length).toBeGreaterThan(permissionReads),
      );
      f.switchAccount({ ...accountB });
      f.switchAccount({ ...accountA, generation: 3 });
      releaseWrite.resolve(true);
      expect(await preceding).toMatchObject({ code: "storage_unavailable" });
      expect(await pending).toMatchObject({ ok: false, error: "invalid_report" });
      expect(f.client.error).toBeNull();
      await f.settle();
      expect(f.persistedAutomaticOwners()).toEqual([]);
      expect(f.service.delivery.getAuto(accountA.ownerId)).toBe(false);
      expect(f.service.delivery.getAuto(accountB.ownerId)).toBe(false);
      expect(f.service.delivery.list(accountA.ownerId)).toEqual([]);
      expect(f.service.delivery.list(accountB.ownerId)).toEqual([]);
      expect(f.fetcher).not.toHaveBeenCalled();
    },
  );

  it("binds an explicit opt-out to the current worker and account as well", async () => {
    const f = await fixture();
    f.setPermission(true);
    const enabled = await f.client.request({ type: "diagnostics_set_auto", enabled: true });
    expect(enabled?.ok).toBe(true);
    const origin = f.client.state!;
    f.switchAccount({ ...accountB });
    expect(
      await f.service.handle({
        type: "diagnostics_set_auto",
        enabled: false,
        workerId: origin.workerId,
        accountEpoch: origin.accountEpoch,
      }),
    ).toMatchObject({ ok: false, error: "invalid_report" });
    expect(f.service.delivery.getAuto(accountA.ownerId)).toBe(true);
    expect(f.service.delivery.getAuto(accountB.ownerId)).toBe(false);
    f.receiveCurrent();
    const disabled = await f.client.request({ type: "diagnostics_set_auto", enabled: false });
    expect(disabled?.ok).toBe(true);
    expect(f.fetcher).not.toHaveBeenCalled();
  });
});
