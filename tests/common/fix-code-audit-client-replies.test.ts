// SPDX-License-Identifier: MPL-2.0

import type {
  DiagnosticResponse,
  DiagnosticUiState,
  DiagnosticWorkerRequest,
} from "../../src/core/shared/diagnostics-ui";
import { DiagnosticConnection } from "../../src/ui/diagnostics-page/client";

const REPORT_ID = "a1000000-0000-4000-8000-000000000001";

function state(changes: Partial<DiagnosticUiState> = {}): DiagnosticUiState {
  return {
    version: 1,
    workerId: "worker-1",
    revision: 1,
    accountEpoch: 1,
    language: "fr",
    signedIn: true,
    autoReporting: false,
    preparing: false,
    historyCount: 0,
    reports: [],
    ...changes,
  };
}

function reply(next: DiagnosticUiState, ok = true): DiagnosticResponse {
  return {
    diagnosticsVersion: 1,
    ok,
    state: next,
    ...(!ok ? { error: "not_found" as const } : {}),
  };
}

function deferred() {
  let resolve!: (value: unknown) => void;
  const promise = new Promise<unknown>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function broadcast(client: DiagnosticConnection, next: DiagnosticUiState): void {
  client.receive({ type: "diagnostics_changed", state: next });
}

async function denyConsent(client: DiagnosticConnection): Promise<void> {
  const denied = vi.fn(async () => false);
  expect(
    await client.requestWithDataConsent({ type: "diagnostics_set_auto", enabled: true }, denied),
  ).toBeNull();
  expect(denied).toHaveBeenCalledOnce();
  expect(client.error).toBe("data_collection_required");
}

describe("EXTRA01 independent real diagnostic client reply ordering", () => {
  it("runs in Node without a document or browser session", () => {
    expect(typeof document).toBe("undefined");
    expect(typeof window).toBe("undefined");
  });

  it.each([true, false])(
    "keeps W2 when its first unknown W1 reply arrives late (ok=%s)",
    async (ok) => {
      const held = deferred();
      const send = vi.fn(() => held.promise);
      const client = new DiagnosticConnection(() => undefined, send);
      expect(client.state).toBeNull();
      const pending = client.request({ type: "diagnostics_state" });
      const live = state({ workerId: "worker-2", revision: 7, accountEpoch: 3 });
      broadcast(client, live);
      await denyConsent(client);
      const liveReference = client.state;

      held.resolve(reply(state({ revision: 500, autoReporting: true }), ok));
      await pending;

      expect(client.state).toBe(liveReference);
      expect(client.state).toEqual(live);
      expect(client.available).toBe(true);
      expect(client.error).toBe("data_collection_required");
      expect(send).toHaveBeenCalledExactlyOnceWith({ type: "diagnostics_state" });
    },
  );

  it.each([true, false])(
    "keeps the latest worker after replies and broadcasts from two retired workers (ok=%s)",
    async (ok) => {
      const held = deferred();
      const client = new DiagnosticConnection(
        () => undefined,
        () => held.promise,
      );
      broadcast(client, state());
      const pending = client.request({ type: "diagnostics_report", reportId: REPORT_ID });
      broadcast(client, state({ workerId: "worker-2", revision: 0, accountEpoch: 0 }));
      const live = state({ workerId: "worker-3", revision: 0, accountEpoch: 0 });
      broadcast(client, live);
      await denyConsent(client);
      const liveReference = client.state;

      held.resolve(reply(state({ revision: 500 }), ok));
      expect(await pending).toBeNull();
      broadcast(client, state({ workerId: "worker-2", revision: 1_000, accountEpoch: 99 }));

      expect(client.state).toBe(liveReference);
      expect(client.state).toEqual(live);
      expect(client.error).toBe("data_collection_required");
      expect(client.available).toBe(true);
    },
  );

  it.each([true, false])(
    "keeps a higher revision and its local error when an older revision replies (ok=%s)",
    async (ok) => {
      const held = deferred();
      const client = new DiagnosticConnection(
        () => undefined,
        () => held.promise,
      );
      broadcast(client, state());
      const pending = client.request({ type: "diagnostics_report", reportId: REPORT_ID });
      const live = state({ revision: 4, historyCount: 2 });
      broadcast(client, live);
      await denyConsent(client);
      const liveReference = client.state;

      held.resolve(reply(state({ revision: 3, historyCount: 1 }), ok));
      await pending;

      expect(client.state).toBe(liveReference);
      expect(client.state).toEqual(live);
      expect(client.error).toBe("data_collection_required");
    },
  );

  it.each(["account", "sign-out-in", "worker"] as const)(
    "does not apply an old request error across the %s boundary",
    async (boundary) => {
      const held = deferred();
      const client = new DiagnosticConnection(
        () => undefined,
        () => held.promise,
      );
      broadcast(client, state());
      const pending = client.request({ type: "diagnostics_report", reportId: REPORT_ID });
      if (boundary === "sign-out-in") {
        broadcast(client, state({ revision: 2, accountEpoch: 2, signedIn: false }));
      }
      const live = state({
        revision: 3,
        accountEpoch: boundary === "sign-out-in" ? 3 : 2,
        ...(boundary === "worker" ? { workerId: "worker-2" } : {}),
      });
      broadcast(client, live);
      await denyConsent(client);

      held.resolve(reply({ ...live, revision: 4 }, false));
      await pending;

      expect(client.state).toEqual({ ...live, revision: 4 });
      expect(client.error).toBe("data_collection_required");
      expect(client.available).toBe(true);
    },
  );

  it.each([
    ["negative revision", { revision: -1 }],
    ["fractional revision", { revision: 0.5 }],
    ["unsafe revision", { revision: Number.MAX_SAFE_INTEGER + 1 }],
    ["NaN revision", { revision: Number.NaN }],
    ["string revision", { revision: "5" }],
    ["negative epoch", { accountEpoch: -1 }],
    ["fractional epoch", { accountEpoch: 0.5 }],
    ["unsafe epoch", { accountEpoch: Number.MAX_SAFE_INTEGER + 1 }],
    ["NaN epoch", { accountEpoch: Number.NaN }],
    ["null epoch", { accountEpoch: null }],
    ["empty worker", { workerId: "" }],
    ["oversized worker", { workerId: "x".repeat(201) }],
  ])("rejects %s in a broadcast and delayed reply", async (_label, changes) => {
    const held = deferred();
    const client = new DiagnosticConnection(
      () => undefined,
      () => held.promise,
    );
    broadcast(client, state());
    const pending = client.request({ type: "diagnostics_state" });
    const live = state({ revision: 4 });
    broadcast(client, live);
    await denyConsent(client);
    const liveReference = client.state;
    const malformed = { ...state({ revision: 5 }), ...changes };

    client.receive({ type: "diagnostics_changed", state: malformed });
    held.resolve({ diagnosticsVersion: 1, ok: true, state: malformed });
    expect(await pending).toBeNull();

    expect(client.state).toBe(liveReference);
    expect(client.state).toEqual(live);
    expect(client.error).toBe("data_collection_required");
    expect(client.available).toBe(true);
  });

  it("accepts the first relevant error when no newer event has occurred", async () => {
    const client = new DiagnosticConnection(
      () => undefined,
      async () => ({
        ...reply(state(), false),
        error: "storage_unavailable",
      }),
    );

    expect(await client.request({ type: "diagnostics_state" })).toMatchObject({
      ok: false,
      error: "storage_unavailable",
    });
    expect(client.state).toEqual(state());
    expect(client.available).toBe(true);
    expect(client.error).toBe("storage_unavailable");
  });
});

describe("EXTRA02 independent local diagnostic error ownership", () => {
  const races = [
    { label: "without a broadcast", broadcastRevision: null, responseRevision: 1 },
    { label: "at the broadcast revision", broadcastRevision: 2, responseRevision: 2 },
    { label: "above the broadcast revision", broadcastRevision: 2, responseRevision: 3 },
  ];

  it.each(races.flatMap((race) => [true, false].map((ok) => ({ ...race, ok }))))(
    "preserves native denial $label after an older report result (ok=$ok)",
    async ({ broadcastRevision, responseRevision, ok }) => {
      const held = deferred();
      const send = vi.fn(() => held.promise);
      const client = new DiagnosticConnection(() => undefined, send);
      broadcast(client, state());
      const older = client.request({ type: "diagnostics_report", reportId: REPORT_ID });
      if (broadcastRevision !== null) {
        broadcast(client, state({ revision: broadcastRevision }));
      }
      await denyConsent(client);

      held.resolve(reply(state({ revision: responseRevision }), ok));
      await older;

      expect(client.error).toBe("data_collection_required");
      expect(client.available).toBe(true);
      expect(send).toHaveBeenCalledExactlyOnceWith({
        type: "diagnostics_report",
        reportId: REPORT_ID,
      });
    },
  );

  it("tracks a repeated refusal even when its error text is unchanged", async () => {
    const held = deferred();
    const send = vi
      .fn<(request: DiagnosticWorkerRequest) => Promise<unknown>>()
      .mockResolvedValueOnce({ ...reply(state(), false), error: "data_collection_required" })
      .mockImplementationOnce(() => held.promise);
    const client = new DiagnosticConnection(() => undefined, send);
    broadcast(client, state());
    await client.request({ type: "diagnostics_report", reportId: REPORT_ID });
    expect(client.error).toBe("data_collection_required");
    const older = client.request({ type: "diagnostics_report", reportId: REPORT_ID });
    await denyConsent(client);

    held.resolve(reply(state({ revision: 2 })));
    await older;

    expect(client.error).toBe("data_collection_required");
  });

  it("preserves a native denial when the older report reply is malformed", async () => {
    const held = deferred();
    const client = new DiagnosticConnection(
      () => undefined,
      () => held.promise,
    );
    broadcast(client, state());
    const older = client.request({ type: "diagnostics_report", reportId: REPORT_ID });
    await denyConsent(client);

    held.resolve({ diagnosticsVersion: 1, ok: true, state: state({ revision: -1 }) });
    expect(await older).toBeNull();

    expect(client.state).toEqual(state());
    expect(client.error).toBe("data_collection_required");
    expect(client.available).toBe(true);
  });

  it("lets the current granted consent action clear its preceding native denial", async () => {
    const send = vi.fn(async () => reply(state({ revision: 2, autoReporting: true })));
    const client = new DiagnosticConnection(() => undefined, send);
    broadcast(client, state());
    await denyConsent(client);
    expect(send).not.toHaveBeenCalled();

    expect(
      await client.requestWithDataConsent(
        { type: "diagnostics_set_auto", enabled: true },
        async () => true,
      ),
    ).toMatchObject({ ok: true });

    expect(send).toHaveBeenCalledExactlyOnceWith({
      type: "diagnostics_set_auto",
      enabled: true,
      workerId: "worker-1",
      accountEpoch: 1,
    });
    expect(client.error).toBeNull();
    expect(client.available).toBe(true);
    expect(client.state?.autoReporting).toBe(true);
  });

  it("lets a current successful report retry clear its preceding worker error", async () => {
    const send = vi
      .fn<(request: DiagnosticWorkerRequest) => Promise<unknown>>()
      .mockResolvedValueOnce(reply(state({ revision: 2 }), false))
      .mockResolvedValueOnce(reply(state({ revision: 3 })));
    const client = new DiagnosticConnection(() => undefined, send);
    broadcast(client, state());
    await client.request({ type: "diagnostics_report", reportId: REPORT_ID });
    expect(client.error).toBe("not_found");

    expect(await client.request({ type: "diagnostics_report", reportId: REPORT_ID })).toMatchObject(
      { ok: true },
    );

    expect(client.error).toBeNull();
    expect(client.state?.revision).toBe(3);
    expect(send).toHaveBeenCalledTimes(2);
  });
});
