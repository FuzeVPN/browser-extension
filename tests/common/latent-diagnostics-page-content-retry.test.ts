// SPDX-License-Identifier: MPL-2.0

import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import {
  parseDiagnosticReport,
  type DiagnosticReport,
} from "../../src/core/shared/diagnostic-report";
import type {
  DiagnosticResponse,
  DiagnosticUiState,
  DiagnosticWorkerRequest,
} from "../../src/core/shared/diagnostics-ui";
import { DiagnosticConnection } from "../../src/ui/diagnostics-page/client";

interface Subject {
  selectedId: string | null;
  content: DiagnosticReport | null;
  contentFailure: boolean;
  changed(): void;
  selectReport(id: string): void;
}

const source = readFileSync(
  new URL("../../src/ui/diagnostics-page/diagnostics.ts", import.meta.url),
  "utf8",
);
const ast = ts.createSourceFile("diagnostics.ts", source, ts.ScriptTarget.Latest, true);
const functionNames = new Set([
  "changed",
  "selected",
  "resetSelection",
  "selectReport",
  "schedulePoll",
]);
const declarations = ast.statements
  .filter(ts.isFunctionDeclaration)
  .filter((node) => functionNames.has(node.name?.text ?? ""))
  .map((node) => node.getText(ast));
if (declarations.length !== functionNames.size) throw new Error("missing_page_function");
const executable = ts.transpileModule(declarations.join("\n"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;

const NOW = Date.parse("2026-09-16T12:00:00Z");
const FIRST = "a1000000-0000-4000-8000-000000000001";
const SECOND = "a1000000-0000-4000-8000-000000000002";

function report(id: string): DiagnosticReport {
  return {
    schema_version: 1,
    report_id: id,
    report_type: "simple",
    platform: "chrome_extension",
    app_version: "0.9.3",
    created_at: new Date(NOW).toISOString(),
    consent: { mode: "manual", notice_version: 1 },
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

function state(revision: number, ids: string[]): DiagnosticUiState {
  return {
    version: 1,
    workerId: "worker-1",
    revision,
    accountEpoch: 1,
    language: "fr",
    signedIn: true,
    autoReporting: false,
    preparing: false,
    historyCount: 0,
    reports: ids.map((id) => ({
      id,
      type: "simple",
      createdAt: new Date(NOW).toISOString(),
      status: "failed",
      attempts: 5,
      nextAttemptAt: null,
      canSend: false,
    })),
  };
}

/** The production report selection of the page, against a scripted worker. */
function setup(ids: string[]) {
  const worker = { state: state(1, ids), reachable: true };
  const send = vi.fn(async (request: DiagnosticWorkerRequest): Promise<DiagnosticResponse> => {
    // The message channel closes without a reply, as when the worker is being replaced.
    if (!worker.reachable) throw new Error("message channel closed");
    return {
      diagnosticsVersion: 1,
      ok: true,
      state: worker.state,
      ...(request.type === "diagnostics_report" ? { report: report(request.reportId) } : {}),
    };
  });
  const client = new DiagnosticConnection(() => subject.changed(), send);
  const context = {
    busy: false,
    poll: undefined,
    selectedId: null,
    content: null,
    contentFailure: false,
    contentUnanswered: false,
    selectionRevision: 0,
    client,
    languageLoader: { request: () => undefined },
    elements: { consent: { checked: false } },
    element: () => ({ open: false }),
    document: { visibilityState: "visible" },
    render: () => undefined,
    parseDiagnosticReport,
    setTimeout: (handler: () => void, delay: number) => setTimeout(handler, delay),
    clearTimeout: (timer: ReturnType<typeof setTimeout> | undefined) => clearTimeout(timer),
  };
  // Execute the production functions, with only the document and rendering replaced.
  runInNewContext(executable, context);
  const subject = context as unknown as Subject;
  const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
  const contentRequests = () =>
    send.mock.calls.filter(([request]) => request.type === "diagnostics_report").length;
  return {
    subject,
    client,
    worker,
    settle,
    contentRequests,
    /** What the report view shows: the selected entry, and whether its content is there. */
    selection: () => ({
      selected: subject.selectedId,
      loaded: subject.content?.report_id ?? null,
      failed: subject.contentFailure,
    }),
    /** The worker publishes its state, as it does after any change or request. */
    async broadcast() {
      worker.state = { ...worker.state, revision: worker.state.revision + 1 };
      client.receive({ type: "diagnostics_changed", state: worker.state });
      await settle();
    },
  };
}

/** The page opens on its first report while the worker cannot answer the content read. */
async function failedContentLoad(ids: string[]) {
  const f = setup(ids);
  f.worker.reachable = false;
  f.client.receive({ type: "diagnostics_changed", state: f.worker.state });
  await f.settle();
  expect(f.contentRequests()).toBe(1);
  expect(f.selection()).toEqual({ selected: FIRST, loaded: null, failed: true });
  expect(f.client.available).toBe(false);

  // The worker answers again: the page is usable and still lists the selected report.
  f.worker.reachable = true;
  await f.broadcast();
  expect(f.client.available).toBe(true);
  expect(f.client.error).toBeNull();
  expect(f.client.state?.reports.map((item) => item.id)).toEqual(ids);
  return f;
}

describe("the diagnostics page after the content of its selected report failed to load", () => {
  it("loads it when the user selects another report and comes back", async () => {
    const f = await failedContentLoad([FIRST, SECOND]);
    f.subject.selectReport(SECOND);
    await f.settle();
    expect(f.selection()).toEqual({ selected: SECOND, loaded: SECOND, failed: false });
    f.subject.selectReport(FIRST);
    await f.settle();
    expect(f.selection()).toEqual({ selected: FIRST, loaded: FIRST, failed: false });
  });

  it("loads it without a page reload when it is the only report listed", async () => {
    // The selector fires no change for the entry already selected: nothing is left to click.
    const f = await failedContentLoad([FIRST]);
    expect(f.contentRequests()).toBe(2);
    expect(f.selection()).toEqual({ selected: FIRST, loaded: FIRST, failed: false });

    // A loaded report is not read again by later states.
    await f.broadcast();
    expect(f.contentRequests()).toBe(2);
    expect(f.selection()).toEqual({ selected: FIRST, loaded: FIRST, failed: false });
  });
});
