// SPDX-License-Identifier: MPL-2.0

import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { NetworkError } from "../../src/core/api/client";
import type { CommandResult, ExtensionRequest } from "../../src/core/shared/messages";
import { EMPTY_SNAPSHOT, type AppSnapshot } from "../../src/core/shared/state";
import { countryLabel } from "../../src/ui/popup/country-label";
import { buildLocationGroups } from "../../src/ui/popup/location-groups";
import { matchesLocationSearch, normalizeLocationSearch } from "../../src/ui/popup/location-search";
import { PopupSnapshotOrder, popupSnapshot } from "../../src/ui/popup/snapshot";
import { LOCATIONS, PROFILE, authenticatedState, createHarness } from "./helpers";

interface Subject {
  snapshot: AppSnapshot;
  communicationFailed: boolean;
  bindEvents(): void;
  refreshNetwork(): void;
  renderLocations(next: AppSnapshot): void;
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
  focus = vi.fn();
  private readonly classes = new Set<string>();
  private readonly listeners = new Map<string, (() => void)[]>();
  readonly classList = {
    contains: (name: string) => this.classes.has(name),
    toggle: (name: string, force: boolean) => {
      if (force) this.classes.add(name);
      else this.classes.delete(name);
    },
  };

  setAttribute(): void {}

  showModal(): void {}

  addEventListener(type: string, listener: () => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  /** A disabled control ignores activation, as in a browser. */
  click(): void {
    if (!this.disabled) for (const listener of this.listeners.get("click") ?? []) listener();
  }
}

const source = readFileSync(new URL("../../src/ui/popup/popup.ts", import.meta.url), "utf8");
const ast = ts.createSourceFile("popup.ts", source, ts.ScriptTarget.Latest, true);
const functionNames = new Set([
  "bindEvents",
  "locationFilters",
  "refreshLocations",
  "refreshNetwork",
  "renderLocations",
  "errorMessage",
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

// A failed catalogue request keeps the previous rows and reports its own status.
const FAILED: Partial<AppSnapshot> = { locationsStatus: "error", locationsError: "network_error" };
const refused: CommandResult = { ok: false, commandError: "network_error" };
const LOADING = { spinner: true, text: "<refreshingLocations>" };
const FAILURE = { spinner: false, text: "<locationsRefreshError>" };

function state(revision: number, patch: Partial<AppSnapshot>): AppSnapshot {
  return {
    ...structuredClone(EMPTY_SNAPSHOT),
    profile: PROFILE,
    status: "connected",
    protected: true,
    protectionRequested: true,
    activeLocationId: LOCATIONS[0]!.id,
    selectedLocationId: LOCATIONS[0]!.id,
    locations: LOCATIONS,
    locationsStatus: "ready",
    effectiveLanguage: "fr",
    languagePreference: "fr",
    ...patch,
    snapshotVersion: { workerId: "worker-a", revision },
  };
}

/** The open location dialog of the popup, against a scripted worker. */
function setup(catalogue: Partial<AppSnapshot> = {}) {
  const pending: (ReturnType<typeof deferred<unknown>> & { message: ExtensionRequest })[] = [];
  const worker = { revision: 1, state: catalogue };
  const publish = (patch: Partial<AppSnapshot>) => {
    worker.state = { ...worker.state, ...patch };
    return state(++worker.revision, worker.state);
  };
  const created: Record<string, FakeElement> = {};
  const elements = new Proxy(created, {
    get: (target, name) => (target[String(name)] ??= new FakeElement()),
  });
  const initial = state(1, catalogue);
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
    elements,
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
    renderCommunicationFailure() {
      context.communicationFailed = true;
      ++context.renderSequence;
    },
    // Only the location dialog is rendered; its rows are not needed.
    renderCurrent: (next: AppSnapshot) => subject.renderLocations(next),
    locationCountryGroup: () => new FakeElement(),
    replaceListChildren: vi.fn(),
  };
  // Execute the production functions, with only messaging and row rendering replaced.
  runInNewContext(executable, context);
  const subject = context as unknown as Subject;
  subject.bindEvents();
  subject.renderLocations(subject.snapshot);
  const take = (type: ExtensionRequest["type"]) => {
    const index = pending.findIndex(({ message }) => message.type === type);
    if (index < 0) throw new Error("missing_popup_request");
    return pending.splice(index, 1)[0]!;
  };
  // Lets fire-and-forget handlers finish their promise chains.
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  const answer = async (
    type: ExtensionRequest["type"],
    result: CommandResult,
    patch: Partial<AppSnapshot> = {},
  ) => {
    take(type).resolve({ ...result, snapshot: publish(patch) });
    await settle();
  };
  return {
    subject,
    answer,
    pressRefresh: () => elements.refreshLocationsButton!.click(),
    async lose(type: ExtensionRequest["type"]) {
      take(type).reject(new Error("worker_unreachable"));
      await settle();
    },
    // The popup asks for a network observation every few seconds while it is visible.
    async poll() {
      subject.refreshNetwork();
      await answer("refresh_network", { ok: true });
    },
    loadStatus: () => ({
      spinner: elements.refreshLocationsButton!.classList.contains("refreshing"),
      text: elements.locationLoadStatus!.classList.contains("hidden")
        ? null
        : elements.locationLoadStatus!.textContent,
    }),
  };
}

describe("the load status of the location dialog", () => {
  it("scripts the worker as the controller reports a failed catalogue refresh", async () => {
    const h = createHarness({ persisted: authenticatedState() });
    await h.controller.initialize();
    expect(await h.controller.refreshAccount()).toEqual({ ok: true });
    expect(h.controller.getSnapshot()).toMatchObject({
      locationsStatus: "ready",
      locations: LOCATIONS,
    });
    vi.spyOn(h.api, "getLocations").mockRejectedValue(new NetworkError("network"));
    expect(await h.controller.refreshLocations()).toEqual(refused);
    expect(h.controller.getSnapshot()).toMatchObject({ ...FAILED, locations: LOCATIONS });
  });

  it("shows loading, then the failure the worker reports, across network polls", async () => {
    const { pressRefresh, answer, poll, loadStatus } = setup();
    expect(loadStatus()).toEqual({ spinner: false, text: null });
    pressRefresh();
    expect(loadStatus()).toEqual(LOADING);
    await answer("refresh_locations", refused, FAILED);
    expect(loadStatus()).toEqual(FAILURE);
    await poll();
    expect(loadStatus()).toEqual(FAILURE);
  });

  it("shows only loading while a retry of a failed refresh is in flight", () => {
    const { pressRefresh, loadStatus } = setup(FAILED);
    expect(loadStatus()).toEqual(FAILURE);
    pressRefresh();
    // The worker has not published its own loading status yet.
    expect(loadStatus()).toEqual(LOADING);
  });
});
