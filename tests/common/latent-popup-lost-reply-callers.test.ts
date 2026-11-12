// SPDX-License-Identifier: MPL-2.0

import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import type { Device, Location } from "../../src/core/api/types";
import type { ExtensionRequest } from "../../src/core/shared/messages";
import type { SiteExclusion, SiteExclusionsState } from "../../src/core/shared/site-exclusions";
import { EMPTY_SNAPSHOT, type AppSnapshot } from "../../src/core/shared/state";
import { deviceDisplayNames } from "../../src/ui/popup/device-accessible-name";
import { deviceDisplayName, deviceKindMessageKey } from "../../src/ui/popup/device-display";
import { exclusionRetry } from "../../src/ui/popup/exclusion-retry";
import { PopupSnapshotOrder, popupSnapshot } from "../../src/ui/popup/snapshot";
import { PROFILE } from "./helpers";

type ExclusionUpdate = Extract<
  ExtensionRequest,
  { type: "update_site_exclusions" | "retry_site_exclusions" }
>;

interface Subject {
  snapshot: AppSnapshot;
  communicationFailed: boolean;
  locationPreferenceFailure: string | null;
  devicesFailure: { transport: boolean; code: string } | null;
  exclusionRequestFailed: boolean;
  elements: { locationDialog: { open: boolean } };
  render(value: unknown, confirmed?: boolean): boolean;
  selectLocation(locationId: string): void;
  deleteDevice(deviceId: string, deletionKey: string, remove: object): Promise<void>;
  updateSiteExclusions(enabled: boolean, entries: SiteExclusion[]): Promise<boolean>;
  sendExclusionsUpdate(update: ExclusionUpdate, recheck?: boolean): Promise<boolean>;
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

const source = readFileSync(new URL("../../src/ui/popup/popup.ts", import.meta.url), "utf8");
const ast = ts.createSourceFile("popup.ts", source, ts.ScriptTarget.Latest, true);
const functionNames = new Set([
  "request",
  "render",
  "isBusy",
  "connectionRequestState",
  "selectLocation",
  "locationCommandFailure",
  "deleteDevice",
  "deviceFailure",
  "displayDeviceName",
  "updateSiteExclusions",
  "sendExclusionsUpdate",
  "completeExclusionIntent",
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
const CURRENT: Device = {
  deviceId: "current-device",
  name: "Firefox",
  kind: "browser_extension",
  profiles: [],
  createdAt: "2026-10-28T00:00:00Z",
};
const REMOTE: Device = { ...CURRENT, deviceId: "remote-device", name: "Travel laptop" };
const REMOTE_KEY = JSON.stringify([1, REMOTE.deviceId]);
const ENTRY: SiteExclusion = { domain: "example.com", includeSubdomains: true };
const POLICY = { revision: 1, enabled: true, entries: [ENTRY] };
const APPLIED: SiteExclusionsState = {
  saved: POLICY,
  applied: POLICY,
  pending: false,
  error: false,
};

function state(revision = 1, patch: Partial<AppSnapshot> = {}): AppSnapshot {
  return {
    ...structuredClone(EMPTY_SNAPSHOT),
    profile: PROFILE,
    status: "disconnected",
    locations: [PARIS, BERLIN],
    locationsStatus: "ready",
    selectedLocationId: PARIS.id,
    devices: [CURRENT, REMOTE],
    currentDeviceId: CURRENT.deviceId,
    effectiveLanguage: "fr",
    languagePreference: "fr",
    snapshotVersion: { workerId: "worker-a", revision },
    ...patch,
  };
}

/** The production commands of the popup; only messaging and final rendering are replaced. */
function setup() {
  const pending: (ReturnType<typeof deferred<unknown>> & { message: ExtensionRequest })[] = [];
  const initial = state();
  const order = new PopupSnapshotOrder();
  order.accept(initial);
  const context = {
    snapshot: popupSnapshot(initial),
    accountEpoch: 1,
    communicationFailed: false,
    renderSequence: 0,
    confirmedSnapshotSequence: 0,
    connectionRequestIntent: 0,
    devicesAction: 0,
    locationSelectionRequest: 0,
    loadedLocale: "fr",
    locale: "fr",
    languageCatalogFailed: false,
    currentBrowserName: "Firefox",
    accountRefreshPending: false,
    devicesRefreshPending: false,
    locationsRefreshPending: false,
    connectionRetryPending: false,
    securityPreferencesPending: false,
    automaticSelectionPending: false,
    verificationPending: false,
    devicesFailure: null,
    locationPreferenceFailure: null,
    locationsRefreshFailed: false,
    locationSelectionPending: false,
    exclusionRequestPending: false,
    exclusionRequestFailed: false,
    exclusionConflict: false,
    failedExclusionIntent: null,
    submittedExclusionDraft: null,
    deviceDeletions: new Set<string>(),
    expandedLocationCountries: new Set<string>(),
    expandedLocationCities: new Set<string>(),
    snapshotOrder: order,
    popupSnapshot,
    EMPTY_SNAPSHOT,
    exclusionRetry,
    deviceDisplayNames,
    deviceDisplayName,
    deviceKindMessageKey,
    structuredClone,
    queueMicrotask,
    message: (key: string) => key,
    document: { activeElement: null },
    elements: {
      confirmationDialog: { close: vi.fn() },
      locationDialog: {
        open: true,
        close() {
          this.open = false;
        },
      },
      refreshDevicesButton: { disabled: false, focus: vi.fn() },
      closeDevicesButton: { focus: vi.fn() },
      exclusionInput: { value: "", disabled: false, focus: vi.fn() },
      exclusionSubdomains: { checked: true },
      exclusionsDialog: { open: false },
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
    // The user accepts the in-document confirmation.
    confirmAction: async () => true,
    resetVerificationFeedback: vi.fn(),
    renderCurrent: vi.fn(),
    renderDevices: vi.fn(),
    renderLocations: vi.fn(),
    renderSiteExclusions: vi.fn(),
    renderCommunicationFailure() {
      context.communicationFailed = true;
      ++context.renderSequence;
    },
  };
  runInNewContext(executable, context);
  return {
    subject: context as unknown as Subject,
    pending,
    sent: () => pending.map(({ message }) => message.type),
  };
}

// Lets fire-and-forget handlers and awaited confirmations finish their promise chains.
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("a location selection whose reply is lost", () => {
  const selected = () => state(2, { selectedLocationId: BERLIN.id });

  it("closes the dialog on the delivered reply", async () => {
    const { subject, pending, sent } = setup();
    subject.selectLocation(BERLIN.id);
    expect(sent()).toEqual(["select_location"]);
    pending[0]!.resolve({ ok: true, snapshot: selected() });
    await settle();
    expect(subject.locationPreferenceFailure).toBeNull();
    expect(subject.elements.locationDialog.open).toBe(false);
  });

  it("stays reported when the selection never took effect", async () => {
    const { subject, pending } = setup();
    subject.selectLocation(BERLIN.id);
    pending[0]!.reject(new Error("command_was_not_delivered"));
    await settle();
    expect(subject.snapshot.selectedLocationId).toBe(PARIS.id);
    expect(subject.communicationFailed).toBe(true);
    expect(subject.locationPreferenceFailure).toBe("transport");
    expect(subject.elements.locationDialog.open).toBe(true);
  });

  it("behaves as on success once the published state shows the requested location", async () => {
    const { subject, pending } = setup();
    subject.selectLocation(BERLIN.id);
    // The worker publishes the saved selection; only its reply never arrives.
    expect(subject.render(selected(), true)).toBe(true);
    pending[0]!.reject(new Error("completion_reply_lost"));
    await settle();
    expect(subject.snapshot.selectedLocationId).toBe(BERLIN.id);
    expect(subject.communicationFailed).toBe(false);
    expect(subject.locationPreferenceFailure).toBeNull();
    expect(subject.elements.locationDialog.open).toBe(false);
  });
});

describe("a device deletion whose reply is lost", () => {
  const deleted = () => state(2, { devices: [CURRENT] });

  it("reports nothing on the delivered reply", async () => {
    const { subject, pending, sent } = setup();
    const deletion = subject.deleteDevice(REMOTE.deviceId, REMOTE_KEY, {});
    await settle();
    expect(sent()).toEqual(["delete_device"]);
    pending[0]!.resolve({ ok: true, snapshot: deleted() });
    await deletion;
    expect(subject.devicesFailure).toBeNull();
  });

  it("stays reported while the device is still listed", async () => {
    const { subject, pending } = setup();
    const deletion = subject.deleteDevice(REMOTE.deviceId, REMOTE_KEY, {});
    await settle();
    pending[0]!.reject(new Error("command_was_not_delivered"));
    await deletion;
    expect(subject.snapshot.devices).toContainEqual(REMOTE);
    expect(subject.communicationFailed).toBe(true);
    expect(subject.devicesFailure).toMatchObject({ transport: true });
  });

  it("reports no failure for a device the published state no longer lists", async () => {
    const { subject, pending } = setup();
    const deletion = subject.deleteDevice(REMOTE.deviceId, REMOTE_KEY, {});
    await settle();
    // The worker publishes the confirmed deletion before its own list refresh replies.
    expect(subject.render(deleted(), true)).toBe(true);
    pending[0]!.reject(new Error("completion_reply_lost"));
    await deletion;
    expect(subject.snapshot.devices).toEqual([CURRENT]);
    expect(subject.communicationFailed).toBe(false);
    expect(subject.devicesFailure).toBeNull();
  });
});

describe("an exclusion change whose reply is lost", () => {
  const applied = (revision: number) => state(revision, { siteExclusions: APPLIED });

  it("succeeds on the delivered reply", async () => {
    const { subject, pending, sent } = setup();
    const update = subject.updateSiteExclusions(true, [ENTRY]);
    expect(sent()).toEqual(["update_site_exclusions"]);
    pending[0]!.resolve({ ok: true, snapshot: applied(2) });
    expect(await update).toBe(true);
    expect(subject.exclusionRequestFailed).toBe(false);
  });

  it("stays reported when the policy was never applied", async () => {
    const { subject, pending } = setup();
    const update = subject.updateSiteExclusions(true, [ENTRY]);
    pending[0]!.reject(new Error("command_was_not_delivered"));
    expect(await update).toBe(false);
    expect(subject.snapshot.siteExclusions.applied.entries).toEqual([]);
    expect(subject.communicationFailed).toBe(true);
    expect(subject.exclusionRequestFailed).toBe(true);
  });

  it("is not flagged as failed once the published state shows the requested policy", async () => {
    const { subject, pending } = setup();
    const update = subject.updateSiteExclusions(true, [ENTRY]);
    // The worker publishes the applied policy; only its reply never arrives.
    expect(subject.render(applied(2), true)).toBe(true);
    pending[0]!.reject(new Error("completion_reply_lost"));
    const completed = await update;
    expect(subject.snapshot.siteExclusions).toEqual(APPLIED);
    expect(subject.communicationFailed).toBe(false);
    expect({ completed, flaggedAsFailed: subject.exclusionRequestFailed }).toEqual({
      completed: true,
      flaggedAsFailed: false,
    });
  });
});
