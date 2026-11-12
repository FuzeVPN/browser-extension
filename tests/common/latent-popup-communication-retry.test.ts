// SPDX-License-Identifier: MPL-2.0

import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import type { ExtensionRequest } from "../../src/core/shared/messages";
import { networkRouteKey } from "../../src/core/shared/network";
import { EMPTY_SNAPSHOT, type AppSnapshot } from "../../src/core/shared/state";
import { PopupSnapshotOrder, popupSnapshot } from "../../src/ui/popup/snapshot";

interface Subject {
  snapshot: AppSnapshot | null;
  communicationFailed: boolean;
  bindEvents(): void;
  initializePopup(): Promise<void>;
  render(value: unknown, confirmed?: boolean): boolean;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  return { promise, resolve, reject };
}

/** The few DOM members the popup uses on its own elements. */
class FakeElement {
  textContent = "";
  value = "";
  className = "";
  disabled = false;
  checked = false;
  dataset: Record<string, string> = {};
  focus = vi.fn();
  scrollIntoView = vi.fn();
  private readonly classes = new Set<string>();
  private readonly listeners = new Map<string, ((event: unknown) => void)[]>();
  readonly classList = {
    add: (name: string) => void this.classes.add(name),
    remove: (name: string) => void this.classes.delete(name),
    contains: (name: string) => this.classes.has(name),
    toggle: (name: string, force?: boolean) => {
      if (force ?? !this.classes.has(name)) this.classes.add(name);
      else this.classes.delete(name);
    },
  };

  get visible(): boolean {
    return !this.classes.has("hidden");
  }

  setAttribute(): void {}

  close(): void {}

  replaceChildren(): void {}

  addEventListener(type: string, listener: (event: unknown) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  dispatch(type: string): void {
    for (const listener of this.listeners.get(type) ?? []) listener({ preventDefault() {} });
  }

  /** A disabled control ignores activation, as in a browser. */
  click(): void {
    if (!this.disabled) this.dispatch("click");
  }
}

const source = readFileSync(new URL("../../src/ui/popup/popup.ts", import.meta.url), "utf8");
const ast = ts.createSourceFile("popup.ts", source, ts.ScriptTarget.Latest, true);
const functionNames = new Set([
  "bindEvents",
  "locationFilters",
  "initializePopup",
  "refreshAccount",
  "retryConnection",
  "signInOnWeb",
  "request",
  "render",
  "renderCommunicationFailure",
  "renderCurrent",
  "renderWebLogin",
  "renderError",
  "renderLogoutOutcome",
  "renderSecurity",
  "webLoginRequiresDisconnect",
  "isConnectionProgress",
  "isBusy",
  "connectionRequestState",
  "errorMessage",
]);
const declarations = ast.statements
  .filter(ts.isFunctionDeclaration)
  .filter((node) => functionNames.has(node.name?.text ?? ""))
  .map((node) => node.getText(ast));
if (declarations.length !== functionNames.size) throw new Error("missing_popup_function");
const executable = ts.transpileModule(declarations.join("\n"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;

function signedOut(revision: number): AppSnapshot {
  return {
    ...structuredClone(EMPTY_SNAPSHOT),
    snapshotVersion: { workerId: "worker-a", revision },
  };
}

/** A popup that has just been opened, with its real event handlers and view rendering. */
function setup() {
  const pending: (ReturnType<typeof deferred<unknown>> & { message: ExtensionRequest })[] = [];
  const created: Record<string, FakeElement> = {};
  const elements = new Proxy(created, {
    get: (target, name) => (target[String(name)] ??= new FakeElement()),
  });
  // The initial markup: the recovery panel and the main view hidden, sign-in disabled.
  elements.recoveryPanel!.classList.add("hidden");
  elements.mainView!.classList.add("hidden");
  elements.loginButton!.disabled = true;
  const context = {
    snapshot: null,
    accountEpoch: 0,
    accountRefreshPending: false,
    devicesRefreshPending: false,
    locationsRefreshPending: false,
    connectionRetryPending: false,
    securityPreferencesPending: false,
    automaticSelectionPending: false,
    verificationPending: false,
    loginPending: false,
    communicationFailed: false,
    renderSequence: 0,
    confirmedSnapshotSequence: 0,
    connectionRequestIntent: 0,
    devicesAction: 0,
    locationSelectionRequest: 0,
    loadedLocale: "en",
    languagePending: false,
    languageFailed: false,
    languageCatalogFailed: false,
    observedNetworkRoute: null,
    returnToSettingsAfterDevices: false,
    renderedLocations: "",
    renderedDevices: "",
    locationFilter: "all",
    devicesFailure: null,
    locationPreferenceFailure: null,
    locationsRefreshFailed: false,
    locationSelectionPending: false,
    snapshotOrder: new PopupSnapshotOrder(),
    popupSnapshot,
    networkRouteKey,
    EMPTY_SNAPSHOT,
    expandedLocationCountries: new Set<string>(),
    expandedLocationCities: new Set<string>(),
    elements,
    systemDarkTheme: new FakeElement(),
    message: (key: string) => key,
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
    renderVerification: vi.fn(),
    renderSiteExclusions: vi.fn(),
    renderExclusionPreview: vi.fn(),
    renderTheme: vi.fn(),
    openDevices: vi.fn(),
  };
  // Execute the production functions, with only messaging and unrelated rendering replaced.
  runInNewContext(executable, context);
  const subject = context as unknown as Subject;
  subject.bindEvents();
  return {
    subject,
    elements,
    pending,
    sent: () => pending.map(({ message }) => message.type),
    // The sign-in button submits its form.
    pressSignIn() {
      if (!elements.loginButton!.disabled) elements.loginForm!.dispatch("submit");
    },
  };
}

function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function openWithoutWorker() {
  const popup = setup();
  void popup.subject.initializePopup();
  popup.pending[0]!.reject(new Error("worker_unreachable"));
  await settle();
  const { subject, elements } = popup;
  expect(popup.sent()).toEqual(["get_snapshot"]);
  expect(subject.communicationFailed).toBe(true);
  expect(subject.snapshot?.profile).toBeNull();
  expect(elements.loginErrorBanner!.visible).toBe(true);
  expect(elements.loginErrorMessage!.textContent).toBe("extensionCommunicationError");
  return popup;
}

describe("a signed-out popup whose first snapshot request failed", () => {
  it("shows the recovery panel with one enabled button labelled as sign-in", async () => {
    const { elements } = await openWithoutWorker();
    expect(elements.recoveryPanel!.visible).toBe(true);
    expect(elements.retryButton).toMatchObject({ textContent: "signIn", disabled: false });
    expect(elements.loginButton!.disabled).toBe(true);
  });

  it("lets the user sign in as soon as the worker publishes again", async () => {
    const { subject, elements, sent, pressSignIn } = await openWithoutWorker();
    expect(subject.render(signedOut(1), true)).toBe(true);
    expect(subject.communicationFailed).toBe(false);
    expect(elements.loginButton!.disabled).toBe(false);
    pressSignIn();
    expect(sent()).toEqual(["get_snapshot", "web_login"]);
  });

  it("gives that button a way to reach the worker again", async () => {
    const { elements, sent, pressSignIn } = await openWithoutWorker();
    elements.retryButton!.click();
    // The button only moves the focus to the sign-in button: the user presses it next.
    pressSignIn();
    await settle();
    expect(
      sent().slice(1),
      "messages sent by the recovery button and the sign-in button it focuses",
    ).not.toEqual([]);
  });
});
