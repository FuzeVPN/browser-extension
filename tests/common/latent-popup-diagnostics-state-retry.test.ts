// SPDX-License-Identifier: MPL-2.0

import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import type {
  DiagnosticUiState,
  DiagnosticWorkerRequest,
} from "../../src/core/shared/diagnostics-ui";
import { DiagnosticConnection, diagnosticErrorKey } from "../../src/ui/diagnostics-page/client";

interface Subject {
  pollVisiblePopup(): void;
  refreshDiagnosticsState(): void;
}

const source = readFileSync(new URL("../../src/ui/popup/popup.ts", import.meta.url), "utf8");
const ast = ts.createSourceFile("popup.ts", source, ts.ScriptTarget.Latest, true);
const functionNames = new Set(["pollVisiblePopup", "refreshDiagnosticsState", "renderDiagnostics"]);
const declarations = ast.statements
  .filter(ts.isFunctionDeclaration)
  .filter((node) => functionNames.has(node.name?.text ?? ""))
  .map((node) => node.getText(ast));
if (declarations.length !== functionNames.size) throw new Error("missing_popup_function");
const executable = ts.transpileModule(declarations.join("\n"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;

const STATE: DiagnosticUiState = {
  version: 1,
  workerId: "worker-a",
  revision: 1,
  accountEpoch: 1,
  language: "fr",
  signedIn: true,
  autoReporting: true,
  preparing: false,
  historyCount: 0,
  reports: [],
};

/** The diagnostics control of the popup, against a worker which may not answer. */
function setup() {
  const worker = { reachable: false, requests: [] as string[] };
  const send = async (request: DiagnosticWorkerRequest) => {
    worker.requests.push(request.type);
    if (!worker.reachable) throw new Error("message channel closed");
    return { diagnosticsVersion: 1, ok: true, state: STATE };
  };
  const toggle = { checked: false, disabled: true };
  const error = { hidden: true, textContent: "" };
  const hiddenClass = (node: { hidden: boolean }) => ({
    toggle: (_name: string, force: boolean) => {
      node.hidden = force;
    },
  });
  const accountRequired = { hidden: false };
  const context = {
    snapshot: null,
    diagnosticsPending: false,
    diagnosticsStateRequest: null,
    document: { visibilityState: "visible" },
    diagnostics: new DiagnosticConnection(() => subject.renderDiagnostics(), send),
    diagnosticErrorKey,
    message: (key: string) => key,
    refreshNetwork: vi.fn(),
    elements: {
      diagnosticsAuto: toggle,
      diagnosticsAccountRequired: { classList: hiddenClass(accountRequired) },
      diagnosticsError: {
        classList: hiddenClass(error),
        set textContent(value: string) {
          error.textContent = value;
        },
      },
    },
  };
  // Execute the production functions, with only messaging and the document replaced.
  runInNewContext(executable, context);
  const subject = context as unknown as Subject & { renderDiagnostics(): void };
  const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
  return {
    subject,
    worker,
    settle,
    document: context.document,
    shown: () => ({
      toggleDisabled: toggle.disabled,
      error: error.hidden ? null : error.textContent,
    }),
  };
}

describe("the automatic-reporting control of a popup opened while the worker starts", () => {
  it("is disabled, with its reason, after the first read found no worker", async () => {
    const { subject, worker, settle, shown } = setup();
    subject.refreshDiagnosticsState();
    await settle();
    expect(worker.requests).toEqual(["diagnostics_state"]);
    expect(shown()).toEqual({ toggleDisabled: true, error: "diagnosticsUnavailable" });
  });

  it("is enabled again by the next poll once the worker answers", async () => {
    const { subject, worker, settle, shown } = setup();
    subject.refreshDiagnosticsState();
    await settle();
    expect(shown().toggleDisabled).toBe(true);

    // No diagnostics broadcast arrives: only the popup asking again can recover.
    worker.reachable = true;
    subject.pollVisiblePopup();
    await settle();
    expect(worker.requests).toEqual(["diagnostics_state", "diagnostics_state"]);
    expect(shown()).toEqual({ toggleDisabled: false, error: null });

    // An available connection is not read again by later polls.
    subject.pollVisiblePopup();
    await settle();
    expect(worker.requests).toHaveLength(2);
  });

  it("sends one read at a time, and none while the popup is hidden", async () => {
    const { subject, worker, settle, document } = setup();
    subject.refreshDiagnosticsState();
    subject.pollVisiblePopup();
    subject.pollVisiblePopup();
    expect(worker.requests).toEqual(["diagnostics_state"]);
    await settle();

    document.visibilityState = "hidden";
    subject.pollVisiblePopup();
    await settle();
    expect(worker.requests).toEqual(["diagnostics_state"]);
  });
});
