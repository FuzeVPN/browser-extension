// SPDX-License-Identifier: MPL-2.0

import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import type { ExtensionRequest, ExtensionResponse } from "../../src/core/shared/messages";
import { EMPTY_SNAPSHOT, type AppSnapshot } from "../../src/core/shared/state";
import { PopupSnapshotOrder, popupSnapshot } from "../../src/ui/popup/snapshot";
import { PROFILE } from "./helpers";

interface PopupResponse extends ExtensionResponse {
  stale?: boolean;
  transportFailed?: boolean;
}

type Method =
  | "refreshAccount"
  | "refreshDevices"
  | "refreshLocations"
  | "retryConnection"
  | "updateSecurityPreferences"
  | "selectAutomaticLocation";

type Subject = Record<string, unknown> &
  Record<Method, () => unknown> & {
    communicationFailed: boolean;
    request(message: ExtensionRequest): Promise<PopupResponse>;
    render(value: unknown, confirmed?: boolean): boolean;
  };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  return { promise, resolve, reject };
}

const source = readFileSync(new URL("../../src/ui/popup/popup.ts", import.meta.url), "utf8");
const ast = ts.createSourceFile("popup.ts", source, ts.ScriptTarget.Latest, true);
const functionNames = new Set([
  "request",
  "render",
  "isBusy",
  "connectionRequestState",
  "refreshAccount",
  "refreshDevices",
  "deviceFailure",
  "refreshLocations",
  "retryConnection",
  "updateSecurityPreferences",
  "locationCommandFailure",
]);
const declarations = ast.statements
  .filter(ts.isFunctionDeclaration)
  .filter((node) => functionNames.has(node.name?.text ?? ""))
  .map((node) => node.getText(ast));
if (declarations.length !== functionNames.size) throw new Error("missing_popup_function");

// The automatic location action only exists as a click handler inside bindEvents.
let automaticSelection: string | undefined;
const visit = (node: ts.Node): void => {
  if (
    ts.isCallExpression(node) &&
    node.expression.getText(ast) === "elements.automaticLocationButton.addEventListener" &&
    node.arguments[0]?.getText(ast) === '"click"'
  )
    automaticSelection = node.arguments[1]?.getText(ast);
  ts.forEachChild(node, visit);
};
visit(ast);
if (!automaticSelection) throw new Error("missing_popup_handler");

const executable = ts.transpileModule(
  [...declarations, `var selectAutomaticLocation = ${automaticSelection};`].join("\n"),
  { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
).outputText;

// Module-level popup state, with its declared type.
const moduleVariables = ast.statements
  .filter(ts.isVariableStatement)
  .flatMap((statement) => [...statement.declarationList.declarations])
  .map((declaration) => ({
    name: declaration.name.getText(ast),
    type: declaration.type?.getText(ast) ?? null,
  }));
const markers = moduleVariables
  .filter(({ type }) => type === "PendingRequest")
  .map(({ name }) => name);

const requests: { method: Method; marker: string; type: ExtensionRequest["type"] }[] = [
  { method: "refreshAccount", marker: "accountRefreshPending", type: "refresh_account" },
  { method: "refreshDevices", marker: "devicesRefreshPending", type: "refresh_devices" },
  { method: "refreshLocations", marker: "locationsRefreshPending", type: "refresh_locations" },
  { method: "retryConnection", marker: "connectionRetryPending", type: "retry_connection" },
  {
    method: "updateSecurityPreferences",
    marker: "securityPreferencesPending",
    type: "update_security_preferences",
  },
  {
    method: "selectAutomaticLocation",
    marker: "automaticSelectionPending",
    type: "select_automatic_location",
  },
];

const PROFILE_B = { ...PROFILE, userId: "account-b", email: "b@example.invalid" };

function state(revision = 1, patch: Partial<AppSnapshot> = {}): AppSnapshot {
  return {
    ...structuredClone(EMPTY_SNAPSHOT),
    profile: PROFILE,
    status: "blocked",
    protected: false,
    protectionRequested: true,
    selectedLocationId: "fr",
    effectiveLanguage: "fr",
    languagePreference: "fr",
    error: "network_error",
    snapshotVersion: { workerId: "worker-a", revision },
    ...patch,
  };
}

function setup(initial = state()) {
  const pending: (ReturnType<typeof deferred<unknown>> & { message: ExtensionRequest })[] = [];
  const order = new PopupSnapshotOrder();
  order.accept(initial);
  const control = () => ({ checked: false, disabled: false });
  const context: Record<string, unknown> = {
    snapshot: initial,
    accountEpoch: 1,
    communicationFailed: false,
    renderSequence: 0,
    confirmedSnapshotSequence: 0,
    connectionRequestIntent: 0,
    devicesAction: 0,
    locationSelectionRequest: 0,
    loadedLocale: "fr",
    devicesFailure: null,
    locationPreferenceFailure: null,
    locationsRefreshFailed: false,
    locationSelectionPending: false,
    verificationPending: false,
    snapshotOrder: order,
    popupSnapshot,
    EMPTY_SNAPSHOT,
    expandedLocationCountries: new Set(),
    expandedLocationCities: new Set(),
    message: (key: string) => key,
    elements: {
      confirmationDialog: { close: vi.fn() },
      locationDialog: { close: vi.fn() },
      killSwitchEnabled: control(),
      webRtcProtectionEnabled: control(),
      settingsError: { textContent: "", classList: { remove: vi.fn() } },
    },
    extensionApi: {
      runtime: {
        sendMessage: vi.fn((message: ExtensionRequest) => {
          const response = { ...deferred<unknown>(), message };
          pending.push(response);
          return response.promise;
        }),
      },
    },
    resetVerificationFeedback: vi.fn(),
    renderCurrent: vi.fn(),
    renderDevices: vi.fn(),
    renderLocations: vi.fn(),
    renderError: vi.fn(),
    renderSecurity: vi.fn(),
    renderCommunicationFailure() {
      context.communicationFailed = true;
    },
  };
  for (const marker of [...markers, ...requests.map(({ marker }) => marker)])
    context[marker] = false;
  // Execute the production functions, with only messaging and DOM rendering replaced.
  runInNewContext(executable, context);
  return { subject: context as Subject, pending };
}

// Lets fire-and-forget click handlers finish their promise chains.
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("XQ-07 popup request markers share one ownership idiom", () => {
  it("declares every request marker as a PendingRequest", () => {
    expect(markers).toEqual(expect.arrayContaining(requests.map(({ marker }) => marker)));
    // A marker typed ad hoc would escape the boundary check below.
    expect(moduleVariables.filter(({ type }) => type !== null && /\bfalse\b/.test(type))).toEqual(
      [],
    );
  });

  it.each(["account", "worker"] as const)(
    "releases every PendingRequest marker when the %s changes, and only then",
    (boundary) => {
      expect(markers.length).toBeGreaterThan(0);
      const { subject } = setup();
      const tokens = new Map(markers.map((marker) => [marker, {}]));
      for (const [marker, token] of tokens) subject[marker] = token;
      expect(subject.render(state(2), true)).toBe(true);
      for (const [marker, token] of tokens) expect(subject[marker], marker).toBe(token);
      const replacement =
        boundary === "account"
          ? { profile: PROFILE_B }
          : { snapshotVersion: { workerId: "worker-b", revision: 1 } };
      expect(subject.render(state(3, replacement), true)).toBe(true);
      for (const marker of markers) expect(subject[marker], marker).toBe(false);
    },
  );

  it.each(requests)(
    "$method stores a fresh opaque token and releases only its own",
    async ({ method, marker, type }) => {
      const { subject, pending } = setup();
      void subject[method]();
      const first = subject[marker];
      expect(pending.map(({ message }) => message.type)).toEqual([type]);
      // The token carries no account state: each request checks its account itself.
      expect(first).toBeTypeOf("object");
      expect(Object.keys(first as object)).toEqual([]);
      subject.render(state(2, { snapshotVersion: { workerId: "worker-b", revision: 1 } }), true);
      void subject[method]();
      const second = subject[marker];
      expect(second).toBeTypeOf("object");
      expect(second).not.toBe(first);
      pending[0]!.reject(new Error("retired_worker_channel"));
      await settle();
      expect(subject[marker]).toBe(second);
      pending[1]!.resolve({
        ok: true,
        snapshot: state(2, { snapshotVersion: { workerId: "worker-b", revision: 2 } }),
      });
      await settle();
      expect(subject[marker]).toBe(false);
    },
  );
});

describe("XQ-07 request() applies one supersession rule to delivered and lost replies", () => {
  const changes = {
    account: (subject: Subject) => subject.render(state(2, { profile: PROFILE_B }), true),
    worker: (subject: Subject) =>
      subject.render(state(1, { snapshotVersion: { workerId: "worker-b", revision: 1 } }), true),
    "connection command": (subject: Subject) => void subject.request({ type: "disconnect" }),
    none: () => undefined,
  };
  const commands: ExtensionRequest[] = [
    { type: "connect", locationId: "fr" },
    { type: "refresh_devices" },
  ];
  const cases = (Object.keys(changes) as (keyof typeof changes)[]).flatMap((change) =>
    commands.map((command) => ({
      change,
      command,
      superseded:
        change === "account" ||
        change === "worker" ||
        (change === "connection command" && command.type === "connect"),
    })),
  );

  it.each(cases)(
    "$command.type after a newer $change: superseded=$superseded either way",
    async ({ change, command, superseded }) => {
      const outcomes: boolean[] = [];
      for (const completion of ["resolve", "reject"] as const) {
        const { subject, pending } = setup();
        const reply = subject.request(command);
        changes[change](subject);
        if (completion === "resolve") pending[0]!.resolve({ ok: true, snapshot: state(9) });
        else pending[0]!.reject(new Error("command_channel_closed"));
        outcomes.push((await reply).superseded === true);
      }
      expect(outcomes).toEqual([superseded, superseded]);
    },
  );

  it.each(["get_snapshot", "refresh_devices", "refresh_locations"] as const)(
    "lets only a settled newer state answer a lost %s reply",
    async (type) => {
      const { subject, pending } = setup();
      const reply = subject.request({ type });
      subject.render(state(2, { status: "connecting" }), true);
      pending[0]!.reject(new Error("command_channel_closed"));
      expect(await reply).toMatchObject({ transportFailed: true });
      expect(subject.communicationFailed).toBe(true);
    },
  );
});
