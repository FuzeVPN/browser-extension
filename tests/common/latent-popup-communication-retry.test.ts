// SPDX-License-Identifier: MPL-2.0

import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { popupDom } from "./popup-dom";
import ts from "typescript";
import type { ExtensionRequest } from "../../src/core/shared/messages";
import { networkRouteKey } from "../../src/core/shared/network";
import { EMPTY_SNAPSHOT, type AppSnapshot } from "../../src/core/shared/state";
import { PopupSnapshotOrder, popupSnapshot } from "../../src/ui/popup/snapshot";

interface Subject {
  snapshot: AppSnapshot | null;
  communicationFailed: boolean;
  accountKnown: boolean;
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
  open = false;
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

  readonly attributes = new Map<string, string>();

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  showModal(): void {}

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
  "readStateAgain",
  "signInOnWeb",
  "request",
  "render",
  "renderCommunicationFailure",
  "renderCurrent",
  "renderWebLogin",
  "renderError",
  "renderLogoutOutcome",
  "renderSecurity",
  "renderAdBlocking",
  "refreshAdBlocking",
  "changeAdBlocking",
  "adBlockingRequest",
  "showsRecovery",
  "showsProxyConflict",
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

const version = (revision: number) => ({ workerId: "worker-a", revision });

function signedIn(revision: number): AppSnapshot {
  return {
    ...signedOut(revision),
    status: "connected",
    protected: true,
    protectionRequested: true,
    activeLocationId: "fr",
    selectedLocationId: "fr",
    profile: {
      userId: "user",
      email: "user@example.invalid",
      firstName: "Test",
      lastName: "User",
      countryCode: "FR",
    },
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
  // Until its first state or failure the popup shows neither view: this ends that.
  const endBoot = vi.fn();
  const context = {
    // No element has the focus in this popup.
    document: { activeElement: null, createElement: () => new FakeElement() },
    // Of the main view, these tests read which view is shown and its recovery panel.
    statusKey: () => "statusProtected",
    statusClass: () => "connected",
    displayedLocation: () => null,
    missingLocationMessage: () => "noLocation",
    canDisconnect: () => true,
    subscriptionExpiry: () => "",
    renderNetwork: vi.fn(),
    refreshNetwork: vi.fn(),
    renderLocations: vi.fn(),
    renderDevices: vi.fn(),
    snapshot: null,
    accountEpoch: 0,
    accountRefreshPending: false,
    devicesRefreshPending: false,
    adBlockingPending: false,
    adBlockingWanted: null,
    adBlockingFailed: false,
    locationsRefreshPending: false,
    connectionRetryPending: false,
    stateReadPending: false,
    securityPreferencesPending: false,
    automaticSelectionPending: false,
    verificationPending: false,
    loginPending: false,
    communicationFailed: false,
    accountKnown: false,
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
    deviceRefusals: new Map<string, unknown>(),
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
    message: (key: string, substitutions?: string[]) =>
      substitutions ? `${key}[${substitutions.join(",")}]` : key,
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
    endBoot,
  };
  // Execute the production functions, with only messaging and unrelated rendering replaced.
  runInNewContext(executable, Object.assign(context, popupDom));
  const subject = context as unknown as Subject;
  subject.bindEvents();
  return {
    subject,
    elements,
    pending,
    endBoot,
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
  // The failure is shown: a popup which stayed empty would hide it.
  expect(popup.endBoot).toHaveBeenCalled();
  return popup;
}

describe("a signed-out popup whose first snapshot request failed", () => {
  it("shows the recovery panel with one enabled button, which says that it tries again", async () => {
    const { subject, elements } = await openWithoutWorker();
    expect(elements.recoveryPanel!.visible).toBe(true);
    // Nothing says that nobody is signed in: the button does not invite to sign in.
    expect(elements.retryButton).toMatchObject({ textContent: "retryConnection", disabled: false });
    expect(elements.loginButton!.disabled).toBe(true);
    expect(subject.accountKnown).toBe(false);
  });

  it("reads the state again from that button, and shows the account it finds", async () => {
    const { subject, elements, sent, pending } = await openWithoutWorker();
    elements.retryButton!.click();
    expect(sent()).toEqual(["get_snapshot", "get_snapshot"]);

    pending[1]!.resolve({ ok: true, snapshot: signedIn(1) });
    await settle();
    expect(subject.communicationFailed).toBe(false);
    expect(subject.accountKnown).toBe(true);
    expect(elements.mainView!.visible).toBe(true);
    expect(elements.loginView!.visible).toBe(false);
  });

  it("invites to sign in once a state says that nobody is", async () => {
    const { subject, elements } = await openWithoutWorker();
    expect(subject.render(signedOut(1), true)).toBe(true);
    expect(subject.accountKnown).toBe(true);
    expect(elements.loginView!.visible).toBe(true);
    expect(elements.loginButton!.disabled).toBe(false);
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
    // The sign-in button stays disabled while the worker does not answer.
    pressSignIn();
    await settle();
    expect(sent().slice(1), "messages sent by the recovery button").toEqual(["get_snapshot"]);
  });
});

describe("a popup whose proxy another extension holds", () => {
  const conflict = (patch: Partial<AppSnapshot> = {}): AppSnapshot => ({
    ...signedIn(1),
    status: "error",
    protected: false,
    protectionRequested: true,
    activeLocationId: null,
    blockingScope: "unverified",
    error: "proxy_controlled_by_extension",
    ...patch,
  });

  it("says in the recovery panel what happens and what to do, in place of the error banner", () => {
    const { subject, elements } = setup();
    expect(subject.render(conflict(), true)).toBe(true);

    expect(elements.recoveryPanel!.visible).toBe(true);
    expect(elements.recoveryStatus!.textContent).toBe("proxyConflictTitle");
    // The instruction names the button to press by its own label.
    expect(elements.recoveryHelp!.textContent).toBe("proxyConflictHelp[retryConnection]");
    // Said once: the banner would repeat it in fewer words.
    expect(elements.errorBanner!.visible).toBe(false);
    // Why it shows now, after days without it, is offered and not imposed.
    expect(elements.recoveryWhy!.visible).toBe(true);
    expect(elements.recoveryWhy!.open).toBe(false);
    expect(elements.retryButton).toMatchObject({ textContent: "retryConnection", disabled: false });
  });

  it("returns to the usual recovery text for any other failure", () => {
    const { subject, elements } = setup();
    subject.render(conflict(), true);
    // The reader opened the explanation: it does not stay open for another failure.
    elements.recoveryWhy!.open = true;
    subject.render({ ...conflict({ error: "network_error" }), snapshotVersion: version(2) }, true);

    expect(elements.recoveryStatus!.textContent).toBe("securityBlockUnverified");
    expect(elements.recoveryHelp!.textContent).toBe("recoveryHelp");
    expect(elements.recoveryWhy!.visible).toBe(false);
    expect(elements.recoveryWhy!.open).toBe(false);
    expect(elements.errorBanner!.visible).toBe(true);
    // This stand-in translates no error code: the banner falls back to its generic text.
    expect(elements.errorMessage!.textContent).toBe("error_unknown_error");
  });

  it("keeps the usual recovery text when nothing failed", () => {
    const { subject, elements } = setup();
    subject.render(
      conflict({ error: null, blockingScope: "all", trafficBlocked: true, status: "blocked" }),
      true,
    );
    expect(elements.recoveryHelp!.textContent).toBe("recoveryHelp");
    expect(elements.errorBanner!.visible).toBe(false);
  });

  it("keeps the banner when the recovery panel is not shown", () => {
    const { subject, elements } = setup();
    // The protection is no longer asked for: the status card is back, the error is still said.
    subject.render(
      conflict({ protectionRequested: false, blockingScope: "none", status: "disconnected" }),
      true,
    );
    expect(elements.recoveryPanel!.visible).toBe(false);
    expect(elements.errorBanner!.visible).toBe(true);
    expect(elements.errorMessage!.textContent).not.toBe("");
  });

  it("keeps the banner of the sign-in view, where no recovery panel shows", () => {
    const { subject, elements } = setup();
    subject.render(
      {
        ...signedOut(1),
        protectionRequested: true,
        blockingScope: "unverified",
        error: "proxy_controlled_by_extension",
      },
      true,
    );
    expect(elements.loginView!.visible).toBe(true);
    expect(elements.recoveryWhy!.visible).toBe(false);
    expect(elements.loginErrorBanner!.visible).toBe(true);
    expect(elements.errorBanner!.visible).toBe(false);
  });

  it("says that the worker does not answer rather than what its last state said", async () => {
    const popup = setup();
    popup.subject.render(conflict(), true);
    void popup.subject.initializePopup();
    popup.pending[0]!.reject(new Error("worker_unreachable"));
    await settle();
    expect(popup.elements.recoveryStatus!.textContent).toBe("securityBlockUnverified");
    expect(popup.elements.recoveryHelp!.textContent).toBe("recoveryHelp");
    expect(popup.elements.errorMessage!.textContent).toBe("extensionCommunicationError");
  });
});

describe("a signed-in popup whose worker stops answering", () => {
  async function lostWorker(patch: Partial<AppSnapshot> = {}) {
    const popup = setup();
    expect(popup.subject.render({ ...signedIn(1), ...patch }, true)).toBe(true);
    void popup.subject.initializePopup();
    popup.pending
      .find(({ message }) => message.type === "get_snapshot")!
      .reject(new Error("worker_unreachable"));
    await settle();
    expect(popup.subject.communicationFailed).toBe(true);
    // What the popup asks about the state or the connection, among its other requests.
    const asked = () =>
      popup.sent().filter((type) => type === "get_snapshot" || type === "retry_connection");
    return { ...popup, asked };
  }

  it("keeps the account it knew, and offers to try again", async () => {
    const { subject, elements } = await lostWorker();
    expect(subject.accountKnown).toBe(true);
    expect(elements.mainView!.visible).toBe(true);
    expect(elements.recoveryPanel!.visible).toBe(true);
    expect(elements.retryButton).toMatchObject({ textContent: "retryConnection", disabled: false });
  });

  it("reads the state again: a connection which may be fine is not made again", async () => {
    const { elements, asked } = await lostWorker();
    elements.retryButton!.click();
    expect(asked()).toEqual(["get_snapshot", "get_snapshot"]);
  });

  it.each([
    ["no location is selected", { selectedLocationId: null }],
    ["the last state was in progress", { status: "connecting" as const }],
  ])("can try again when %s", async (_name, patch) => {
    const { elements, asked } = await lostWorker(patch);
    expect(elements.retryButton!.disabled).toBe(false);
    elements.retryButton!.click();
    expect(asked()).toEqual(["get_snapshot", "get_snapshot"]);
  });

  it("asks once while its reading is on its way", async () => {
    const { elements, asked } = await lostWorker();
    elements.retryButton!.click();
    expect(elements.retryButton!.disabled).toBe(true);
    elements.retryButton!.click();
    expect(asked()).toEqual(["get_snapshot", "get_snapshot"]);
  });
});

describe("the ad blocker of the account", () => {
  const choice = (
    revision: number,
    adBlocking: { enabled: boolean | null; available: boolean },
  ): AppSnapshot => ({ ...signedIn(revision), adBlocking });
  const off = { enabled: false, available: true };
  const on = { enabled: true, available: true };

  function shown(popup: ReturnType<typeof setup>) {
    const control = popup.elements.adBlockingEnabled!;
    const note = popup.elements.adBlockingNote!;
    return {
      checked: control.checked,
      disabled: control.disabled,
      busy: control.attributes.get("aria-busy"),
      note: note.visible ? note.textContent : null,
    };
  }
  /** The reader flips the control, as a click does. */
  function flip(popup: ReturnType<typeof setup>) {
    const control = popup.elements.adBlockingEnabled!;
    control.checked = !control.checked;
    control.dispatch("change");
  }
  async function answer(popup: ReturnType<typeof setup>, index: number, reply: unknown) {
    popup.pending[index]!.resolve(reply);
    await settle();
  }

  it("is not offered without an account", () => {
    const popup = setup();
    popup.subject.render(signedOut(1), true);
    expect(popup.elements.adBlockingRow!.visible).toBe(false);
  });

  it("cannot be changed before the choice of the account has been read", () => {
    const popup = setup();
    popup.subject.render(signedIn(1), true);
    expect(popup.elements.adBlockingRow!.visible).toBe(true);
    expect(shown(popup)).toEqual({ checked: false, disabled: true, busy: "false", note: null });
  });

  it("reads the choice when the settings open", async () => {
    const popup = setup();
    popup.subject.render(signedIn(1), true);
    popup.elements.settingsButton!.click();
    expect(popup.sent()).toEqual(["refresh_ad_blocking"]);
    expect(shown(popup)).toEqual({ checked: false, disabled: true, busy: "true", note: null });

    await answer(popup, 0, { ok: true, snapshot: choice(2, on) });
    expect(shown(popup)).toEqual({ checked: true, disabled: false, busy: "false", note: null });
  });

  it("shows the choice asked for while it is recorded, then what the service holds", async () => {
    const popup = setup();
    popup.subject.render(choice(1, off), true);
    flip(popup);
    expect(popup.pending[0]!.message).toEqual({ type: "set_ad_blocking", enabled: true });
    expect(shown(popup)).toEqual({ checked: true, disabled: true, busy: "true", note: null });

    // A state published meanwhile still says the earlier choice.
    popup.subject.render(choice(2, off));
    expect(shown(popup).checked).toBe(true);

    await answer(popup, 0, { ok: true, snapshot: choice(3, on) });
    expect(shown(popup)).toEqual({ checked: true, disabled: false, busy: "false", note: null });
  });

  it("returns to the recorded choice and says so when the change fails", async () => {
    const popup = setup();
    popup.subject.render(choice(1, off), true);
    flip(popup);
    await answer(popup, 0, { ok: false, commandError: "rate_limited", snapshot: choice(2, off) });
    expect(shown(popup)).toEqual({
      checked: false,
      disabled: false,
      busy: "false",
      note: "adBlockerFailed",
    });
    // The failure is that of the ad blocker: nothing is said of the connection.
    expect(popup.elements.errorBanner!.visible).toBe(false);

    flip(popup);
    await answer(popup, 1, { ok: true, snapshot: choice(3, on) });
    expect(shown(popup)).toEqual({ checked: true, disabled: false, busy: "false", note: null });
  });

  it("takes the outcome of a reply whose state was published before it", async () => {
    const popup = setup();
    popup.subject.render(choice(1, off), true);
    flip(popup);
    await answer(popup, 0, { ok: false, commandError: "rate_limited", snapshot: choice(2, off) });
    expect(shown(popup).note).toBe("adBlockerFailed");

    // The worker publishes the recorded choice, then answers with that same state.
    flip(popup);
    popup.subject.render(choice(3, on));
    await answer(popup, 1, { ok: true, snapshot: choice(3, on) });
    expect(shown(popup)).toEqual({ checked: true, disabled: false, busy: "false", note: null });

    // And the other way round: a refusal whose unchanged state was already displayed.
    flip(popup);
    popup.subject.render(choice(4, on));
    await answer(popup, 2, { ok: false, commandError: "rate_limited", snapshot: choice(4, on) });
    expect(shown(popup)).toEqual({
      checked: true,
      disabled: false,
      busy: "false",
      note: "adBlockerFailed",
    });
  });

  it("says when the choice could not be read, and leaves the control alone", async () => {
    const popup = setup();
    popup.subject.render(signedIn(1), true);
    popup.elements.settingsButton!.click();
    await answer(popup, 0, { ok: false, commandError: "network_error", snapshot: signedIn(2) });
    expect(shown(popup)).toEqual({
      checked: false,
      disabled: true,
      busy: "false",
      note: "adBlockerFailed",
    });

    // Opening the settings again reads it again.
    popup.elements.settingsButton!.click();
    await answer(popup, 1, { ok: true, snapshot: choice(3, on) });
    expect(shown(popup)).toEqual({ checked: true, disabled: false, busy: "false", note: null });
  });

  it("says when the service has turned the blocker off, the choice staying changeable", () => {
    const popup = setup();
    popup.subject.render(choice(1, { enabled: true, available: false }), true);
    expect(shown(popup)).toEqual({
      checked: true,
      disabled: false,
      busy: "false",
      note: "adBlockerPaused",
    });
  });

  it("asks the service what it holds when the worker abandoned a change", async () => {
    const popup = setup();
    popup.subject.render(choice(1, off), true);
    flip(popup);
    await answer(popup, 0, { ok: false, superseded: true, snapshot: choice(2, off) });
    expect(popup.sent()).toEqual(["set_ad_blocking", "refresh_ad_blocking"]);
    // Abandoned is not failed: the reading which follows says what was recorded.
    expect(shown(popup).note).toBeNull();
    await answer(popup, 1, { ok: true, snapshot: choice(3, on) });
    expect(shown(popup)).toEqual({ checked: true, disabled: false, busy: "false", note: null });
  });

  it("asks once while a request is on its way", () => {
    const popup = setup();
    popup.subject.render(choice(1, off), true);
    popup.elements.settingsButton!.click();
    popup.elements.settingsButton!.click();
    // A change which reached the page all the same is not sent, and is not shown.
    flip(popup);
    expect(popup.sent()).toEqual(["refresh_ad_blocking"]);
    expect(shown(popup).checked).toBe(false);
  });

  it("forgets the request and the failure of a previous account", async () => {
    const popup = setup();
    popup.subject.render(choice(1, off), true);
    flip(popup);
    await answer(popup, 0, { ok: false, commandError: "network_error", snapshot: choice(2, off) });
    expect(shown(popup).note).toBe("adBlockerFailed");
    flip(popup);
    expect(shown(popup).busy).toBe("true");

    const other = signedIn(3);
    popup.subject.render({ ...other, profile: { ...other.profile!, userId: "other" } }, true);
    expect(shown(popup)).toEqual({ checked: false, disabled: true, busy: "false", note: null });
    // The reply owed to the previous account changes nothing for this one.
    await answer(popup, 1, { ok: true, snapshot: choice(4, on) });
    expect(shown(popup).checked).toBe(false);
  });
});
