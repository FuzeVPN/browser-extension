// SPDX-License-Identifier: MPL-2.0

import { DiagnosticConnection, isDiagnosticUiState } from "../../src/ui/diagnostics-page/client";
import type { DiagnosticUiState } from "../../src/core/shared/diagnostics-ui";

const id = "a1000000-0000-4000-8000-000000000001";
function state(overrides: Partial<DiagnosticUiState> = {}): DiagnosticUiState {
  return {
    version: 1,
    workerId: "worker-1",
    revision: 1,
    language: "fr",
    signedIn: false,
    autoReporting: false,
    preparing: false,
    historyCount: 0,
    reports: [
      {
        id,
        type: "full",
        createdAt: "2026-09-16T12:00:00Z",
        status: "ready",
        attempts: 0,
        nextAttemptAt: null,
        canSend: false,
      },
    ],
    ...overrides,
  };
}
function deferred() {
  let resolve!: (value: unknown) => void;
  const promise = new Promise<unknown>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("diagnostic UI contract", () => {
  it("accepts an offline local report without enabling sending", () => {
    expect(isDiagnosticUiState(state())).toBe(true);
    expect(state().reports[0]?.canSend).toBe(false);
  });
  it("accepts a separate bounded connection journal count", () => {
    expect(isDiagnosticUiState(state({ historyCount: 200, connectionHistoryCount: 200 }))).toBe(
      true,
    );
    expect(isDiagnosticUiState(state({ connectionHistoryCount: 0 }))).toBe(true);
  });
  it.each([
    { version: 0 },
    { revision: -1 },
    { historyCount: 201 },
    { connectionHistoryCount: 201 },
    { connectionHistoryCount: -1 },
    { language: "auto" },
    { signedIn: "true" },
    { reports: [{ id: "untrusted" }] },
  ])("rejects malformed worker state %j", (changes) => {
    expect(isDiagnosticUiState({ ...state(), ...changes })).toBe(false);
  });
  it("rejects duplicate report identifiers", () => {
    const report = state().reports[0]!;
    expect(isDiagnosticUiState(state({ reports: [report, report] }))).toBe(false);
  });
  it("never claims receipt without a matching server acknowledgement", () => {
    const report = { ...state().reports[0]!, status: "received" as const };
    expect(isDiagnosticUiState(state({ reports: [report] }))).toBe(false);
    const receipt = {
      report_id: "a1000000-0000-4000-8000-000000000002",
      client_report_id: id,
      received_at: "2026-09-16T12:00:00Z",
      expires_at: "2026-10-16T12:00:00Z",
      status: "received" as const,
      duplicate: false,
    };
    expect(isDiagnosticUiState(state({ reports: [{ ...report, receipt }] }))).toBe(true);
    expect(
      isDiagnosticUiState(
        state({
          reports: [{ ...report, receipt: { ...receipt, client_report_id: receipt.report_id } }],
        }),
      ),
    ).toBe(false);
  });
});

describe("diagnostic UI communication", () => {
  afterEach(() => vi.useRealTimers());
  it("disables only diagnostic controls for a historical worker response", async () => {
    const changed = vi.fn();
    const client = new DiagnosticConnection(changed, async () => ({
      ok: true,
      snapshot: { status: "connected" },
    }));
    expect(await client.request({ type: "diagnostics_state" })).toBeNull();
    expect(client.available).toBe(false);
    expect(client.error).toBe("unavailable");
    expect(changed).toHaveBeenCalled();
  });
  it("bounds a worker that never responds and ignores its late answer", async () => {
    vi.useFakeTimers();
    const wait = deferred();
    const client = new DiagnosticConnection(
      () => undefined,
      () => wait.promise,
      20,
    );
    const pending = client.request({ type: "diagnostics_state" });
    await vi.advanceTimersByTimeAsync(20);
    expect(await pending).toBeNull();
    wait.resolve({ diagnosticsVersion: 1, ok: true, state: state() });
    await Promise.resolve();
    expect(client.available).toBe(false);
    expect(client.state).toBeNull();
  });
  it("keeps newer account-cleared state when an old report reply arrives", async () => {
    const wait = deferred();
    const client = new DiagnosticConnection(
      () => undefined,
      () => wait.promise,
    );
    client.receive({ type: "diagnostics_changed", state: state({ signedIn: true }) });
    const pending = client.request({ type: "diagnostics_report", reportId: id });
    client.receive({ type: "diagnostics_changed", state: state({ revision: 3, reports: [] }) });
    wait.resolve({
      diagnosticsVersion: 1,
      ok: true,
      state: state({ revision: 2, signedIn: true }),
    });
    await pending;
    expect(client.state?.signedIn).toBe(false);
    expect(client.state?.reports).toEqual([]);
  });
  it("accepts worker restart but never resurrects a retired worker", () => {
    const client = new DiagnosticConnection(
      () => undefined,
      async () => undefined,
    );
    client.receive({ type: "diagnostics_changed", state: state({ revision: 99 }) });
    client.receive({
      type: "diagnostics_changed",
      state: state({ workerId: "worker-2", reports: [] }),
    });
    client.receive({ type: "diagnostics_changed", state: state({ revision: 100 }) });
    expect(client.state?.workerId).toBe("worker-2");
    expect(client.state?.reports).toEqual([]);
  });
  it("recovers through a valid worker broadcast after a transport failure", async () => {
    const client = new DiagnosticConnection(
      () => undefined,
      async () => undefined,
    );
    await client.request({ type: "diagnostics_state" });
    client.receive({ type: "diagnostics_changed", state: state() });
    expect(client.available).toBe(true);
    expect(client.error).toBeNull();
  });
  it("does not let an older pending request failure override a newer live worker", async () => {
    vi.useFakeTimers();
    const client = new DiagnosticConnection(
      () => undefined,
      () => new Promise(() => undefined),
      20,
    );
    const pending = client.request({ type: "diagnostics_state" });
    client.receive({ type: "diagnostics_changed", state: state() });
    await vi.advanceTimersByTimeAsync(20);
    await pending;
    expect(client.available).toBe(true);
    expect(client.error).toBeNull();
  });
});
