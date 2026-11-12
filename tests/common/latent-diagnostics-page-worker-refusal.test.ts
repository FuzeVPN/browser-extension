// SPDX-License-Identifier: MPL-2.0

import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { DiagnosticService } from "../../src/core/diagnostics/service";
import type { DiagnosticAccount } from "../../src/core/diagnostics/delivery";
import type { DiagnosticReadModel } from "../../src/core/diagnostics/collector";
import type {
  DiagnosticUiState,
  DiagnosticWorkerRequest,
} from "../../src/core/shared/diagnostics-ui";
import { EMPTY_SNAPSHOT } from "../../src/core/shared/state";
import { EMPTY_NETWORK_OBSERVATION } from "../../src/core/shared/network";
import { DiagnosticConnection, diagnosticErrorKey } from "../../src/ui/diagnostics-page/client";

const source = readFileSync(
  new URL("../../src/ui/diagnostics-page/diagnostics.ts", import.meta.url),
  "utf8",
);
const ast = ts.createSourceFile("diagnostics.ts", source, ts.ScriptTarget.Latest, true);
const functionNames = new Set(["render", "selected", "date"]);
const declarations = ast.statements
  .filter(ts.isFunctionDeclaration)
  .filter((node) => functionNames.has(node.name?.text ?? ""))
  .map((node) => node.getText(ast));
if (declarations.length !== functionNames.size) throw new Error("missing_page_function");
const executable = ts.transpileModule(declarations.join("\n"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;

const NOW = Date.parse("2026-10-27T12:00:00Z");
const ACCOUNT: DiagnosticAccount = {
  ownerId: "owner-a",
  token: "synthetic-token",
  generation: 1,
  expiresAt: NOW + 3_600_000,
};

interface PageNode {
  hidden: boolean;
  disabled: boolean;
  checked: boolean;
  value: string;
  textContent: string;
  dataset: Record<string, string>;
  replaceChildren(): void;
}

/** The production render of the page over a document reduced to the fields it writes. */
function page(send: (request: DiagnosticWorkerRequest) => Promise<unknown>) {
  const nodes = new Map<string, PageNode>();
  const node = (id: string): PageNode => {
    const existing = nodes.get(id);
    if (existing) return existing;
    const created: PageNode = {
      hidden: false,
      disabled: false,
      checked: false,
      value: "",
      textContent: "",
      dataset: {},
      replaceChildren: () => undefined,
    };
    nodes.set(id, created);
    return created;
  };
  const client = new DiagnosticConnection(() => undefined, send);
  const context = {
    language: "en",
    languageCatalogFailed: false,
    localFailure: null,
    busy: false,
    exportingConnectionLog: false,
    selectedId: null,
    content: null,
    contentFailure: false,
    client,
    diagnosticErrorKey,
    // Message keys stand for their translations.
    message: (key: string) => key,
    configureLegalLinks: () => undefined,
    languageDirection: () => "ltr",
    document: { documentElement: { lang: "", dir: "" }, title: "", querySelectorAll: () => [] },
    element: node,
    elements: {
      auto: node("autoReporting"),
      run: node("runButton"),
      clear: node("clearHistoryButton"),
      connectionLog: node("connectionLogButton"),
      reload: node("reloadButton"),
      select: node("reportSelect"),
      consent: node("sendConsent"),
      send: node("sendButton"),
      cancel: node("cancelButton"),
      delete: node("deleteButton"),
      export: node("exportButton"),
    },
    Option: class {
      constructor(
        readonly text: string,
        readonly value: string,
      ) {}
    },
  };
  runInNewContext(executable, context);
  const render = (context as unknown as { render(): void }).render;
  return {
    client,
    /** The page-level feedback and whether its commands can still be used. */
    shown() {
      render();
      return {
        banner: node("pageError").hidden ? null : node("pageError").textContent,
        reloadOffered: !node("reloadButton").hidden,
        commandsEnabled: !node("runButton").disabled,
      };
    },
  };
}

async function worker() {
  const outage = { session: false };
  const local: Record<string, unknown> = {};
  const session: Record<string, unknown> = {};
  vi.stubGlobal("browser", {
    storage: {
      local: {
        get: async (key: string) => ({ [key]: structuredClone(local[key]) }),
        set: async (value: Record<string, unknown>) => {
          Object.assign(local, structuredClone(value));
        },
      },
      session: {
        get: async (key: string) => ({ [key]: structuredClone(session[key]) }),
        set: async (value: Record<string, unknown>) => {
          if (outage.session) throw new Error("session storage unavailable");
          Object.assign(session, structuredClone(value));
        },
      },
    },
    alarms: (() => {
      const alarms = new Map<string, { when: number }>();
      return {
        create: async (name: string, value: { when: number }) => alarms.set(name, value),
        get: async (name: string) => alarms.get(name),
        clear: async (name: string) => alarms.delete(name),
      };
    })(),
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("{}", { status: 503 })),
  );
  const pages: DiagnosticConnection[] = [];
  const service = new DiagnosticService({
    getAccount: () => ACCOUNT,
    read: (): DiagnosticReadModel => ({
      snapshot: {
        ...structuredClone(EMPTY_SNAPSHOT),
        status: "disconnected",
        profile: {
          userId: ACCOUNT.ownerId,
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
    version: () => "0.9.3",
    environment: async () => ({ browser_name: "chrome" as const }),
    // The worker broadcasts every state change to the open diagnostics pages.
    onChanged: (state: DiagnosticUiState) => {
      for (const client of pages)
        client.receive({ type: "diagnostics_changed", state: structuredClone(state) });
    },
  });
  await service.initialize();
  await service.delivery.pump();
  return {
    service,
    outage,
    open() {
      const opened = page((request) => service.handle(request));
      pages.push(opened.client);
      return opened;
    },
  };
}

describe("the diagnostics page feedback when a command cannot be completed", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("asks to reload the extension when the worker does not answer", async () => {
    const opened = page(async () => {
      throw new Error("message channel closed");
    });
    expect(await opened.client.request({ type: "diagnostics_state" })).toBeNull();
    expect(opened.client.available).toBe(false);
    expect(opened.shown()).toEqual({
      banner: "diagnosticsUnavailable",
      reloadOffered: true,
      commandsEnabled: false,
    });
  });

  it("does not ask to reload the extension when a live worker refuses the command", async () => {
    const f = await worker();
    const opened = f.open();
    const prepared = await opened.client.request({ type: "diagnostics_run" });
    expect(prepared).toMatchObject({ ok: true, state: { reports: [{ status: "ready" }] } });
    expect(opened.shown()).toEqual({ banner: null, reloadOffered: false, commandsEnabled: true });

    // The deletion cannot be recorded while the worker's session storage is failing.
    f.outage.session = true;
    expect(
      await opened.client.request({ type: "diagnostics_delete", reportId: prepared!.reportId! }),
    ).toMatchObject({ ok: false });
    // The worker answered: it is alive, and the page keeps its commands enabled.
    expect(opened.client.available).toBe(true);
    const refused = opened.shown();
    expect(refused.commandsEnabled).toBe(true);
    expect(refused.banner).not.toBeNull();

    // Once storage works again the next request succeeds: nothing had to be reloaded.
    f.outage.session = false;
    expect(await opened.client.request({ type: "diagnostics_state" })).toMatchObject({ ok: true });
    expect(opened.shown()).toEqual({ banner: null, reloadOffered: false, commandsEnabled: true });

    expect({
      deadWorkerNotice: refused.banner === "diagnosticsUnavailable",
      reloadOffered: refused.reloadOffered,
    }).toEqual({ deadWorkerNotice: false, reloadOffered: false });
  });
});
