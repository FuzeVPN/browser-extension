// SPDX-License-Identifier: MPL-2.0

import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import type { Location } from "../../src/core/api/types";
import type { CommandResult, ExtensionRequest } from "../../src/core/shared/messages";
import { EMPTY_SNAPSHOT, type AppSnapshot } from "../../src/core/shared/state";
import { countryLabel } from "../../src/ui/popup/country-label";
import { buildLocationGroups } from "../../src/ui/popup/location-groups";
import { matchesLocationSearch, normalizeLocationSearch } from "../../src/ui/popup/location-search";
import { displayedLocation } from "../../src/ui/popup/location-state";
import { PopupSnapshotOrder, popupSnapshot } from "../../src/ui/popup/snapshot";
import { PROFILE } from "./helpers";

interface Subject {
  snapshot: AppSnapshot;
  bindEvents(): void;
  render(value: unknown, confirmed?: boolean): boolean;
  renderLocations(next: AppSnapshot): void;
  selectLocation(locationId: string): void;
  favoriteButton(id: string, label: string, selected: boolean): FakeElement;
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
  disabled = false;
  open = false;
  dataset: Record<string, string> = {};
  focus = vi.fn();
  private readonly classes = new Set<string>();
  private readonly listeners = new Map<string, (() => void)[]>();
  readonly classList = {
    toggle: (name: string, force: boolean) => {
      if (force) this.classes.add(name);
      else this.classes.delete(name);
    },
  };

  get visible(): boolean {
    return !this.classes.has("hidden");
  }

  setAttribute(): void {}

  addEventListener(type: string, listener: () => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  dispatch(type: string): void {
    for (const listener of this.listeners.get(type) ?? []) listener();
  }

  click(): void {
    if (!this.disabled) this.dispatch("click");
  }

  showModal(): void {
    this.open = true;
  }

  close(): void {
    if (!this.open) return;
    this.open = false;
    this.dispatch("close");
  }

  /** Escape cancels a modal dialog, which then closes. */
  pressEscape(): void {
    this.dispatch("cancel");
    this.close();
  }
}

const source = readFileSync(new URL("../../src/ui/popup/popup.ts", import.meta.url), "utf8");
const ast = ts.createSourceFile("popup.ts", source, ts.ScriptTarget.Latest, true);
const functionNames = new Set([
  "bindEvents",
  "locationFilters",
  "refreshLocations",
  "selectLocation",
  "favoriteButton",
  "locationCommandFailure",
  "renderLocations",
  "errorMessage",
  "canDisconnect",
  "request",
  "render",
  "isBusy",
  "connectionRequestState",
]);
const declarations = ast.statements
  .filter(ts.isFunctionDeclaration)
  .filter((node) => functionNames.has(node.name?.text ?? ""))
  .map((node) => node.getText(ast));
if (declarations.length !== functionNames.size) throw new Error("missing_popup_function");
const executable = ts.transpileModule(declarations.join("\n"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;

const PARIS: Location = {
  id: "fr",
  displayName: "Paris",
  city: "Paris",
  countryCode: "FR",
  supportedProtocols: ["browser_proxy"],
};
const BERLIN: Location = { ...PARIS, id: "de", displayName: "Berlin", city: "Berlin" };
const CONNECTED: Partial<AppSnapshot> = {
  status: "connected",
  protected: true,
  protectionRequested: true,
  activeLocationId: PARIS.id,
  error: null,
};
const DISCONNECTED: Partial<AppSnapshot> = {
  status: "disconnected",
  protected: false,
  protectionRequested: false,
  activeLocationId: null,
  error: null,
};
// A refused change restores the previous session and keeps reporting its refusal.
const REFUSED: Partial<AppSnapshot> = { status: "error", error: "proxy_unavailable" };
const REFUSAL = "<error_proxy_unavailable>";

function state(revision: number, patch: Partial<AppSnapshot>): AppSnapshot {
  return {
    ...structuredClone(EMPTY_SNAPSHOT),
    profile: PROFILE,
    locations: [PARIS, BERLIN],
    locationsStatus: "ready",
    selectedLocationId: PARIS.id,
    effectiveLanguage: "fr",
    languagePreference: "fr",
    ...CONNECTED,
    ...patch,
    snapshotVersion: { workerId: "worker-a", revision },
  };
}

/** The location dialog of a protected popup, against a scripted worker. */
function setup() {
  const pending: (ReturnType<typeof deferred<unknown>> & { message: ExtensionRequest })[] = [];
  const worker = { revision: 1, state: {} as Partial<AppSnapshot> };
  const publish = (patch: Partial<AppSnapshot>) => {
    worker.state = { ...worker.state, ...patch };
    return state(++worker.revision, worker.state);
  };
  const created: Record<string, FakeElement> = {};
  const elements = new Proxy(created, {
    get: (target, name) => (target[String(name)] ??= new FakeElement()),
  });
  const initial = state(1, {});
  const order = new PopupSnapshotOrder();
  order.accept(initial);
  const context = {
    snapshot: popupSnapshot(initial),
    accountEpoch: 1,
    accountRefreshPending: false,
    devicesRefreshPending: false,
    locationsRefreshPending: false,
    connectionRetryPending: false,
    securityPreferencesPending: false,
    automaticSelectionPending: false,
    verificationPending: false,
    communicationFailed: false,
    renderSequence: 0,
    confirmedSnapshotSequence: 0,
    connectionRequestIntent: 0,
    devicesAction: 0,
    locationSelectionRequest: 0,
    loadedLocale: "fr",
    locale: "fr",
    languageCatalogFailed: false,
    devicesFailure: null,
    locationPreferenceFailure: null,
    locationFavoriteFailed: false,
    locationsRefreshFailed: false,
    locationSelectionPending: false,
    locationFilter: "all",
    renderedLocations: "",
    favoriteChanges: new Set<string>(),
    expandedLocationCountries: new Set<string>(),
    expandedLocationCities: new Set<string>(),
    countryNames: new Intl.DisplayNames(["fr"], { type: "region" }),
    snapshotOrder: order,
    popupSnapshot,
    EMPTY_SNAPSHOT,
    countryLabel,
    buildLocationGroups,
    matchesLocationSearch,
    normalizeLocationSearch,
    displayedLocation,
    elements,
    document: { createElement: () => new FakeElement() },
    systemDarkTheme: new FakeElement(),
    message: (key: string) => `<${key}>`,
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
    renderExclusionPreview: vi.fn(),
    renderTheme: vi.fn(),
    openDevices: vi.fn(),
    renderCommunicationFailure: vi.fn(),
    // Only the location dialog is rendered; its rows are not needed.
    renderCurrent: (next: AppSnapshot) => subject.renderLocations(next),
    locationCountryGroup: () => new FakeElement(),
    locationServerRow: () => new FakeElement(),
    unavailableFavoriteRow: () => new FakeElement(),
    replaceListChildren: vi.fn(),
  };
  // Execute the production functions, with only messaging and row rendering replaced.
  runInNewContext(executable, context);
  const subject = context as unknown as Subject;
  subject.bindEvents();
  subject.renderLocations(subject.snapshot);
  const answer = async (
    type: ExtensionRequest["type"],
    result: CommandResult,
    patch: Partial<AppSnapshot> = {},
  ) => {
    const index = pending.findIndex(({ message }) => message.type === type);
    if (index < 0) throw new Error("missing_popup_request");
    const [request] = pending.splice(index, 1);
    request!.resolve({ ...result, snapshot: publish(patch) });
    // Lets fire-and-forget handlers finish their promise chains.
    await new Promise((resolve) => setTimeout(resolve, 0));
  };
  return {
    subject,
    elements,
    answer,
    dialog: elements.locationDialog!,
    async openDialog() {
      elements.changeLocationButton!.click();
      await answer("refresh_locations", { ok: true });
    },
    shownFailure: () =>
      elements.locationPreferenceError!.visible
        ? elements.locationPreferenceError!.textContent
        : null,
  };
}

describe("the failure shown in the location dialog", () => {
  it("reports a refused location change in the dialog, which stays open", async () => {
    const { subject, dialog, openDialog, answer, shownFailure } = setup();
    await openDialog();
    expect(shownFailure()).toBeNull();
    subject.selectLocation(BERLIN.id);
    await answer("change_location", { ok: false, commandError: "proxy_unavailable" }, REFUSED);
    expect(dialog.open).toBe(true);
    expect(shownFailure()).toBe(REFUSAL);
  });

  it("is not erased by starring a location while the change is still refused", async () => {
    const { subject, openDialog, answer, shownFailure } = setup();
    await openDialog();
    subject.selectLocation(BERLIN.id);
    await answer("change_location", { ok: false, commandError: "proxy_unavailable" }, REFUSED);
    expect(shownFailure()).toBe(REFUSAL);

    subject.favoriteButton(BERLIN.id, "Berlin", false).click();
    await answer(
      "set_location_favorite",
      { ok: true },
      { locationPreferences: { ...EMPTY_SNAPSHOT.locationPreferences, favoriteIds: [BERLIN.id] } },
    );
    expect(subject.snapshot.locationPreferences.favoriteIds).toEqual([BERLIN.id]);
    // The worker still reports the refused change and the previous location.
    expect(subject.snapshot).toMatchObject({ error: "proxy_unavailable", activeLocationId: "fr" });
    expect(shownFailure()).toBe(REFUSAL);
  });

  it("does not come back when the dialog is reopened after an unrelated reconnection", async () => {
    const { subject, elements, dialog, openDialog, answer, shownFailure } = setup();
    await openDialog();
    subject.selectLocation(BERLIN.id);
    dialog.pressEscape();
    expect(dialog.open).toBe(false);
    // The refusal arrives after the dialog was closed.
    await answer("change_location", { ok: false, commandError: "proxy_unavailable" }, REFUSED);
    expect(dialog.open).toBe(false);

    // The user disconnects, then protects the browser again from the main view.
    elements.protectButton!.click();
    await answer("disconnect", { ok: true }, DISCONNECTED);
    elements.protectButton!.click();
    await answer("connect", { ok: true }, CONNECTED);
    expect(subject.snapshot).toMatchObject({ ...CONNECTED, selectedLocationId: PARIS.id });

    await openDialog();
    expect(dialog.open).toBe(true);
    expect(shownFailure()).toBeNull();
  });
});
