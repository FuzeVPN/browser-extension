// SPDX-License-Identifier: MPL-2.0

import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import {
  parseDiagnosticReport,
  type DiagnosticReport,
} from "../../src/core/shared/diagnostic-report";
import type {
  DiagnosticRequest,
  DiagnosticResponse,
  DiagnosticUiError,
  DiagnosticUiState,
  DiagnosticWorkerRequest,
} from "../../src/core/shared/diagnostics-ui";
import { DiagnosticConnection } from "../../src/ui/diagnostics-page/client";

interface Subject {
  busy: boolean;
  content: DiagnosticReport | null;
  changed(): void;
  command(request: DiagnosticRequest): Promise<void>;
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
  "command",
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
const REPORT_ID = "a1000000-0000-4000-8000-000000000001";
const REPORT: DiagnosticReport = {
  schema_version: 1,
  report_id: REPORT_ID,
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
// A report waiting for its next upload attempt: the page polls the worker every five seconds.
const STATE: DiagnosticUiState = {
  version: 1,
  workerId: "worker-1",
  revision: 1,
  accountEpoch: 1,
  language: "fr",
  signedIn: true,
  autoReporting: false,
  preparing: false,
  historyCount: 0,
  reports: [
    {
      id: REPORT_ID,
      type: "simple",
      createdAt: REPORT.created_at,
      status: "pending",
      attempts: 1,
      nextAttemptAt: NOW + 66_000,
      canSend: false,
    },
  ],
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function reply(error?: DiagnosticUiError): DiagnosticResponse {
  return { diagnosticsVersion: 1, ok: !error, state: STATE, ...(error ? { error } : {}) };
}

/** The production page controller and client, against a scripted worker and prompt. */
function setup() {
  const prompt = deferred<boolean>();
  const refusal = deferred<DiagnosticResponse>();
  // State reads and report contents are served at once; only the command is held.
  const send = vi.fn((request: DiagnosticWorkerRequest): Promise<DiagnosticResponse> => {
    if (request.type === "diagnostics_state") return Promise.resolve(reply());
    if (request.type === "diagnostics_report")
      return Promise.resolve({ ...reply(), report: REPORT });
    return refusal.promise;
  });
  const client = new DiagnosticConnection(() => subject.changed(), send);
  const context = {
    busy: false,
    localFailure: null,
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
    requestDiagnosticsConsent: () => prompt.promise,
    parseDiagnosticReport,
    setTimeout: (handler: () => void, delay: number) => setTimeout(handler, delay),
    clearTimeout: (timer: ReturnType<typeof setTimeout> | undefined) => clearTimeout(timer),
  };
  // Execute the production functions, with only the document and rendering replaced.
  runInNewContext(executable, context);
  const subject = context as unknown as Subject;
  return { subject, client, send, prompt, refusal };
}

const refusals = [
  { name: "a refused data-collection prompt", granted: false, shown: "data_collection_required" },
  { name: "a storage refusal from the worker", granted: true, shown: "storage_unavailable" },
] as const;

/** Enable automatic reporting `elapsed` ms after the last poll was armed, then be refused. */
async function refusedCommand(elapsed: number, refusal: (typeof refusals)[number]) {
  const f = setup();
  f.client.receive({ type: "diagnostics_changed", state: STATE });
  await vi.advanceTimersByTimeAsync(0);
  // The page is idle on its selected report; only the five-second poll is armed.
  expect(f.subject.content).toMatchObject({ report_id: REPORT_ID });
  expect(f.client.error).toBeNull();
  expect(vi.getTimerCount()).toBe(1);

  await vi.advanceTimersByTimeAsync(elapsed);
  const running = f.subject.command({ type: "diagnostics_set_auto", enabled: true });
  expect(f.subject.busy).toBe(true);
  // The browser prompt, then the worker, keep the command pending for two seconds.
  await vi.advanceTimersByTimeAsync(1_000);
  f.prompt.resolve(refusal.granted);
  await vi.advanceTimersByTimeAsync(1_000);
  if (refusal.granted) f.refusal.resolve(reply(refusal.shown));
  await running;
  expect(f.subject.busy).toBe(false);
  return f;
}

describe("the diagnostics page while a command is refused", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it.each(refusals)("displays $name when no poll is due", async (refusal) => {
    const f = await refusedCommand(1_000, refusal);
    expect(f.client.error).toBe(refusal.shown);
  });

  it.each(refusals)(
    "still displays $name when the poll falls due during the command",
    async (refusal) => {
      const f = await refusedCommand(4_000, refusal);
      expect(f.client.error).toBe(refusal.shown);
    },
  );
});
