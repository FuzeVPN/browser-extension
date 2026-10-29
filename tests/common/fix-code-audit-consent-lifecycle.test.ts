// SPDX-License-Identifier: MPL-2.0

import {
  DiagnosticService,
  DIAGNOSTIC_DELIVERY_KEY,
  DIAGNOSTIC_DRAFTS_KEY,
} from "../../src/core/diagnostics/service";
import type { DiagnosticAccount } from "../../src/core/diagnostics/delivery";
import type { DiagnosticReadModel } from "../../src/core/diagnostics/collector";
import type { DiagnosticRequest } from "../../src/core/shared/diagnostics-ui";
import { EMPTY_SNAPSHOT } from "../../src/core/shared/state";
import { EMPTY_NETWORK_OBSERVATION } from "../../src/core/shared/network";

const NOW = Date.parse("2026-10-28T12:00:00Z");
const TTL = 86_400_000;
const A: DiagnosticAccount = {
  ownerId: "consent-lifecycle-a",
  token: "synthetic-a",
  generation: 1,
  expiresAt: NOW + 3 * TTL,
};
const B: DiagnosticAccount = {
  ownerId: "consent-lifecycle-b",
  token: "synthetic-b",
  generation: 2,
  expiresAt: NOW + 3 * TTL,
};
type Kind = "automatic" | "manual";
type ContextBoundary = "account-b" | "aba" | "clear-history";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

async function fixture() {
  let account: DiagnosticAccount | null = { ...A };
  let now = NOW;
  let sequence = 0;
  let permissionGranted = true;
  const local: Record<string, unknown> = {};
  const session: Record<string, unknown> = {};
  const area = (values: Record<string, unknown>) => ({
    get: vi.fn(async (name: string) => ({ [name]: structuredClone(values[name]) })),
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
  const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
    const body = JSON.parse(init?.body as string) as { report_id: string };
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
  const permission = vi.fn(async () => permissionGranted);
  const environment = vi.fn(async () => ({ browser_name: "chrome" as const }));
  const dependencies = {
    getAccount: () => account,
    read: (): DiagnosticReadModel => ({
      snapshot: {
        ...structuredClone(EMPTY_SNAPSHOT),
        status: account ? "disconnected" : "logged_out",
        profile: account
          ? { userId: account.ownerId, email: "", firstName: "", lastName: "", countryCode: "FR" }
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
    environment,
    now: () => now,
    language: () => "fr" as const,
    version: () => "0.9.2",
    uuid: () => `a1000000-0000-4000-8000-${(++sequence).toString(16).padStart(12, "0")}`,
    onChanged: vi.fn(),
  };
  const service = new DiagnosticService(dependencies);
  await service.initialize();
  await service.delivery.pump();
  const bind = (request: DiagnosticRequest) => ({
    ...request,
    workerId: service.state().workerId,
    accountEpoch: service.state().accountEpoch,
  });
  const intent = async (kind: Kind) => {
    if (kind === "automatic") return bind({ type: "diagnostics_set_auto", enabled: true });
    const prepared = await service.handle({ type: "diagnostics_run" });
    expect(prepared.ok).toBe(true);
    expect(typeof prepared.reportId).toBe("string");
    return bind({
      type: "diagnostics_send",
      reportId: prepared.reportId!,
      consent: true,
      noticeVersion: 1,
    });
  };
  const switchAccount = (next: DiagnosticAccount | null) => {
    account = next;
    service.syncAccount(true);
  };
  const boundary = async (change: ContextBoundary) => {
    if (change === "clear-history") {
      expect(await service.handle({ type: "diagnostics_clear_history" })).toMatchObject({
        ok: true,
      });
    } else {
      switchAccount({ ...B });
      if (change === "aba") switchAccount({ ...A, generation: 3 });
    }
  };
  const settle = async (target = service) => {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    await target.delivery.pump();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  };
  const gatePermission = (query: number) => {
    const started = deferred<undefined>();
    const grant = deferred<boolean>();
    for (let index = 1; index < query; index++) permission.mockResolvedValueOnce(true);
    permission.mockImplementationOnce(async () => {
      started.resolve(undefined);
      return grant.promise;
    });
    return { started: started.promise, release: () => grant.resolve(true) };
  };
  return {
    service,
    local,
    session,
    storage,
    fetcher,
    permission,
    environment,
    bind,
    intent,
    boundary,
    switchAccount,
    settle,
    gatePermission,
    restart: () => new DiagnosticService(dependencies),
    advance: (milliseconds: number) => {
      now += milliseconds;
    },
    revokePermission: () => {
      permissionGranted = false;
      service.permissionsRemoved();
    },
  };
}

function expectNoDelivery(f: Awaited<ReturnType<typeof fixture>>) {
  expect(f.service.delivery.list(A.ownerId)).toEqual([]);
  expect(f.service.delivery.list(B.ownerId)).toEqual([]);
  const stored = f.local[DIAGNOSTIC_DELIVERY_KEY] as { reports?: unknown[] } | undefined;
  expect(stored?.reports ?? []).toEqual([]);
  expect(f.fetcher).not.toHaveBeenCalled();
}

afterEach(() => vi.unstubAllGlobals());

describe("CODE07 / EXTRA04 — consent lifecycle through the real diagnostic service", () => {
  it.each(["automatic", "manual"] as const)(
    "refuses forged, stale-account and restarted-worker %s contexts before a permission query",
    async (kind) => {
      const f = await fixture();
      const request = await f.intent(kind);
      const restarted = f.restart();
      await restarted.initialize();
      await f.settle(restarted);
      f.permission.mockClear();
      expect(await f.service.handle({ ...request, workerId: "forged-worker" })).toMatchObject({
        ok: false,
        error: "invalid_report",
      });
      expect(await restarted.handle(request)).toMatchObject({ ok: false, error: "invalid_report" });
      await f.boundary("aba");
      expect(await f.service.handle(request)).toMatchObject({ ok: false, error: "invalid_report" });
      expect(f.permission).not.toHaveBeenCalled();
      expect(f.service.delivery.getAuto(A.ownerId)).toBe(false);
      expectNoDelivery(f);
    },
  );

  it.each(
    (["automatic", "manual"] as const).flatMap((kind) =>
      ([1, 2] as const).flatMap((query) =>
        (["account-b", "aba", "clear-history"] as const).map(
          (change) => [kind, query, change] as const,
        ),
      ),
    ),
  )("rejects %s after permission query %i crosses %s", async (kind, query, change) => {
    const f = await fixture();
    const request = await f.intent(kind);
    const gate = f.gatePermission(query);
    const pending = f.service.handle(request);
    await gate.started;
    await f.boundary(change);
    gate.release();
    expect(await pending).toMatchObject({ ok: false, error: "invalid_report" });
    await f.settle();
    expect(f.service.delivery.getAuto(A.ownerId)).toBe(false);
    expect(f.service.delivery.getAuto(B.ownerId)).toBe(false);
    expectNoDelivery(f);
  });

  it.each(
    (["automatic", "manual"] as const).flatMap((kind) =>
      (["account-b", "aba", "clear-history"] as const).map((change) => [kind, change] as const),
    ),
  )("rejects %s waiting behind an earlier failed durable write after %s", async (kind, change) => {
    const f = await fixture();
    const request = await f.intent(kind);
    const writing = deferred<undefined>();
    const release = deferred<undefined>();
    f.storage.local.set.mockImplementationOnce(async () => {
      writing.resolve(undefined);
      await release.promise;
      throw new Error("synthetic_preceding_write_failure");
    });
    const preceding = f.service.delivery.setAuto(A.ownerId, true).catch((error: unknown) => error);
    await writing.promise;
    const readCount = f.permission.mock.calls.length;
    const pending = f.service.handle(request);
    await vi.waitFor(() => expect(f.permission.mock.calls.length).toBeGreaterThan(readCount));
    await f.boundary(change);
    release.resolve(undefined);
    expect(await preceding).toMatchObject({ code: "storage_unavailable" });
    expect(await pending).toMatchObject({ ok: false, error: "invalid_report" });
    await f.settle();
    expect(f.service.delivery.getAuto(A.ownerId)).toBe(false);
    expectNoDelivery(f);
  });

  it.each(["automatic", "manual"] as const)(
    "keeps an already invoked %s durable write owned by its original account",
    async (kind) => {
      const f = await fixture();
      const request = await f.intent(kind);
      const writing = deferred<undefined>();
      const release = deferred<undefined>();
      f.storage.local.set.mockImplementationOnce(async (value) => {
        writing.resolve(undefined);
        await release.promise;
        Object.assign(f.local, structuredClone(value));
      });
      const pending = f.service.handle(request);
      await writing.promise;
      await f.boundary("account-b");
      release.resolve(undefined);
      expect(await pending).toMatchObject({ ok: true });
      await f.settle();
      const stored = f.local[DIAGNOSTIC_DELIVERY_KEY] as {
        accounts: { ownerId: string; automatic: boolean }[];
        reports: { ownerId: string }[];
      };
      expect(stored.accounts).not.toContainEqual(
        expect.objectContaining({ ownerId: B.ownerId, automatic: true }),
      );
      if (kind === "automatic")
        expect(stored.accounts).toContainEqual(
          expect.objectContaining({ ownerId: A.ownerId, automatic: true }),
        );
      else expect(stored.reports).toHaveLength(1);
      expect(stored.reports.every((entry) => entry.ownerId === A.ownerId)).toBe(true);
      expect(f.service.delivery.getAuto(B.ownerId)).toBe(false);
      expect(f.service.delivery.list(B.ownerId)).toEqual([]);
      expect(f.fetcher).not.toHaveBeenCalled();
    },
  );

  it.each(
    ([1, 2, 3, 4] as const).flatMap((query) =>
      (
        [
          "aba",
          "clear-history",
          "automatic-disabled",
          "permission-removed",
          "account-expired",
        ] as const
      ).map((change) => [query, change] as const),
    ),
  )(
    "does not upload an automatic incident after permission query %i and %s",
    async (query, change) => {
      const f = await fixture();
      expect(await f.service.handle(await f.intent("automatic"))).toMatchObject({ ok: true });
      await f.settle();
      const gate = f.gatePermission(query);
      f.service.record("connect", { ok: false, commandError: "unknown_error" });
      await gate.started;
      let disabling: ReturnType<DiagnosticService["handle"]> | undefined;
      if (change === "automatic-disabled") {
        disabling = f.service.handle(f.bind({ type: "diagnostics_set_auto", enabled: false }));
        await vi.waitFor(() => expect(f.service.delivery.getAuto(A.ownerId)).toBe(false));
      } else if (change === "permission-removed") f.revokePermission();
      else if (change === "account-expired") f.advance(3 * TTL);
      else await f.boundary(change);
      gate.release();
      if (disabling) expect(await disabling).toMatchObject({ ok: true });
      await f.settle();
      expectNoDelivery(f);
      if (change === "automatic-disabled")
        expect(f.service.delivery.getAuto(A.ownerId)).toBe(false);
    },
  );

  it.each(["aba", "clear-history", "automatic-disabled"] as const)(
    "checks automatic context again after environment collection crosses %s",
    async (change) => {
      const f = await fixture();
      expect(await f.service.handle(await f.intent("automatic"))).toMatchObject({ ok: true });
      await f.settle();
      const collecting = deferred<undefined>();
      const release = deferred<{ browser_name: "chrome" }>();
      f.environment.mockImplementationOnce(async () => {
        collecting.resolve(undefined);
        return release.promise;
      });
      f.service.record("connect", { ok: false, commandError: "unknown_error" });
      await collecting.promise;
      if (change === "automatic-disabled")
        expect(
          await f.service.handle(f.bind({ type: "diagnostics_set_auto", enabled: false })),
        ).toMatchObject({ ok: true });
      else await f.boundary(change);
      release.resolve({ browser_name: "chrome" });
      await f.settle();
      expectNoDelivery(f);
    },
  );

  it.each(
    ([1, 2] as const).flatMap((query) =>
      ([TTL - 1, TTL, TTL + 1] as const).flatMap((age) =>
        ([false, true] as const).map((housekeeping) => [query, age, housekeeping] as const),
      ),
    ),
  )(
    "rechecks a manual draft at query %i, age %i ms, housekeeping=%s",
    async (query, age, housekeeping) => {
      const f = await fixture();
      const request = await f.intent("manual");
      const gate = f.gatePermission(query);
      const pending = f.service.handle(request);
      await gate.started;
      f.advance(age);
      if (housekeeping) await f.service.historyAlarm();
      gate.release();
      const result = await pending;
      await f.settle();
      if (age < TTL) {
        expect(result).toMatchObject({ ok: true });
        expect(f.fetcher).toHaveBeenCalledOnce();
        expect(f.service.delivery.list(A.ownerId)).toContainEqual(
          expect.objectContaining({
            id: "reportId" in request ? request.reportId : "",
            status: "received",
          }),
        );
      } else {
        expect(result).toMatchObject({ ok: false, error: "not_found" });
        expect(f.session[DIAGNOSTIC_DRAFTS_KEY]).toMatchObject({ drafts: [] });
        expectNoDelivery(f);
        const restarted = f.restart();
        await restarted.initialize();
        await f.settle(restarted);
        expect(restarted.state().reports).toEqual([]);
      }
    },
  );

  it.each([1, 2] as const)(
    "does not restore a draft deleted while manual permission query %i is pending",
    async (query) => {
      const f = await fixture();
      const request = await f.intent("manual");
      if (!("reportId" in request)) throw new Error("expected_manual_request");
      const gate = f.gatePermission(query);
      const pending = f.service.handle(request);
      await gate.started;
      const deletion = f.service.handle({ type: "diagnostics_delete", reportId: request.reportId });
      // Deletion removes the in-memory draft synchronously, even if delivery's
      // serialized durable queue is waiting on the same native permission query.
      await vi.waitFor(() => expect(f.service.state().reports).toEqual([]));
      gate.release();
      expect(await deletion).toMatchObject({ ok: true });
      expect(await pending).toMatchObject({ ok: false, error: "not_found" });
      await f.settle();
      expect(f.session[DIAGNOSTIC_DRAFTS_KEY]).toMatchObject({ drafts: [] });
      expectNoDelivery(f);
    },
  );

  it("does not resend a draft consumed by another manual submission while permission was pending", async () => {
    const f = await fixture();
    const request = await f.intent("manual");
    const gate = f.gatePermission(1);
    const oldPending = f.service.handle(request);
    await gate.started;
    expect(await f.service.handle(request)).toMatchObject({ ok: true });
    await f.settle();
    expect(f.fetcher).toHaveBeenCalledOnce();
    gate.release();
    expect(await oldPending).toMatchObject({ ok: false, error: "not_found" });
    await f.settle();
    expect(f.fetcher).toHaveBeenCalledOnce();
    expect(f.service.delivery.list(A.ownerId)).toHaveLength(1);
    expect(f.session[DIAGNOSTIC_DRAFTS_KEY]).toMatchObject({ drafts: [] });
  });

  it.each([1, 2] as const)(
    "does not enqueue a manual draft cancelled while permission query %i is pending",
    async (query) => {
      const f = await fixture();
      const request = await f.intent("manual");
      if (!("reportId" in request)) throw new Error("expected_manual_request");
      const gate = f.gatePermission(query);
      const pending = f.service.handle(request);
      await gate.started;
      const cancellation = f.service.handle({
        type: "diagnostics_cancel",
        reportId: request.reportId,
      });
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      gate.release();
      // No queued report existed yet; the cancellation still invalidates its id.
      expect(await cancellation).toMatchObject({ ok: false, error: "not_found" });
      expect(await pending).toMatchObject({ ok: false, error: "not_found" });
      await f.settle();
      expectNoDelivery(f);
    },
  );

  it("retains a fresh draft for a new consent context after history clears the old context", async () => {
    const f = await fixture();
    const request = await f.intent("manual");
    const gate = f.gatePermission(1);
    const pending = f.service.handle(request);
    await gate.started;
    await f.boundary("clear-history");
    gate.release();
    expect(await pending).toMatchObject({ ok: false, error: "invalid_report" });
    expectNoDelivery(f);
    expect(f.service.state().reports).toContainEqual(expect.objectContaining({ status: "ready" }));
    expect(await f.service.handle(f.bind(request))).toMatchObject({ ok: true });
    await f.settle();
    expect(f.fetcher).toHaveBeenCalledOnce();
  });

  it.each(["automatic", "manual"] as const)(
    "accepts current %s consent and transmits with the originating account",
    async (kind) => {
      const f = await fixture();
      expect(await f.service.handle(await f.intent(kind))).toMatchObject({ ok: true });
      if (kind === "automatic")
        f.service.record("connect", { ok: false, commandError: "unknown_error" });
      await f.settle();
      expect(f.fetcher).toHaveBeenCalledOnce();
      const [url, init] = f.fetcher.mock.calls[0]!;
      expect(url).toBe("https://api.fuzevpn.com/v1/diagnostics");
      expect(new Headers(init?.headers).get("Authorization")).toBe(`Bearer ${A.token}`);
      expect(JSON.parse(init?.body as string)).toMatchObject({
        consent: { mode: kind === "automatic" ? "automatic_opt_in" : "manual" },
      });
      expect(f.service.delivery.list(B.ownerId)).toEqual([]);
    },
  );
});
