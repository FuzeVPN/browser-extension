// SPDX-License-Identifier: MPL-2.0

import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { NetworkError } from "../../src/core/api/client";
import type { Device } from "../../src/core/api/types";
import type { CommandResult, ExtensionRequest } from "../../src/core/shared/messages";
import { EMPTY_SNAPSHOT, type AppSnapshot } from "../../src/core/shared/state";
import {
  deviceAccessibleName,
  deviceDisplayNames,
} from "../../src/ui/popup/device-accessible-name";
import { deviceDisplayName, deviceKindMessageKey } from "../../src/ui/popup/device-display";
import { PopupSnapshotOrder, popupSnapshot } from "../../src/ui/popup/snapshot";
import { PROFILE, authenticatedState, createHarness } from "./helpers";

interface Subject {
  snapshot: AppSnapshot;
  bindEvents(): void;
  renderDevices(next: AppSnapshot): void;
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

/** The few DOM members the popup uses on its own elements and device rows. */
class FakeElement {
  textContent = "";
  disabled = false;
  dataset: Record<string, string> = {};
  children: FakeElement[] = [];
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

  append(...children: FakeElement[]): void {
    this.children.push(...children);
  }

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
  "refreshDevices",
  "deleteDevice",
  "deviceFailure",
  "renderDevices",
  "deviceElement",
  "displayDeviceName",
  "isolatedText",
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

const CURRENT: Device = {
  deviceId: "current-device",
  name: "Firefox",
  kind: "browser_extension",
  profiles: [],
  createdAt: "2026-10-28T00:00:00Z",
};
const LAPTOP: Device = { ...CURRENT, deviceId: "laptop", name: "Travel laptop" };
const PHONE: Device = { ...CURRENT, deviceId: "phone", name: "Phone", kind: "vpn" };
// A failed account request is published as an error, without touching the protection.
const FAILED: Partial<AppSnapshot> = { status: "error", error: "network_error" };
const FAILURE = "<error_network_error>";

function state(revision: number, patch: Partial<AppSnapshot>): AppSnapshot {
  return {
    ...structuredClone(EMPTY_SNAPSHOT),
    profile: PROFILE,
    status: "connected",
    protected: true,
    protectionRequested: true,
    activeLocationId: "fr",
    selectedLocationId: "fr",
    devices: [CURRENT, LAPTOP, PHONE],
    deviceLimit: 5,
    currentDeviceId: CURRENT.deviceId,
    effectiveLanguage: "fr",
    languagePreference: "fr",
    ...patch,
    snapshotVersion: { workerId: "worker-a", revision },
  };
}

/** The devices dialog of the popup, against a scripted worker. */
function setup() {
  const pending: (ReturnType<typeof deferred<unknown>> & { message: ExtensionRequest })[] = [];
  const sent: ExtensionRequest[] = [];
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
    currentBrowserName: "Firefox",
    devicesFailure: null,
    locationPreferenceFailure: null,
    locationsRefreshFailed: false,
    locationSelectionPending: false,
    renderedDevices: "",
    deviceDeletions: new Set<string>(),
    expandedLocationCountries: new Set<string>(),
    expandedLocationCities: new Set<string>(),
    dateFormat: new Intl.DateTimeFormat("fr", { dateStyle: "medium" }),
    snapshotOrder: order,
    popupSnapshot,
    EMPTY_SNAPSHOT,
    deviceAccessibleName,
    deviceDisplayNames,
    deviceDisplayName,
    deviceKindMessageKey,
    elements,
    document: { activeElement: null, createElement: () => new FakeElement() },
    systemDarkTheme: new FakeElement(),
    message: (key: string) => `<${key}>`,
    extensionApi: {
      runtime: {
        sendMessage: vi.fn((message: ExtensionRequest) => {
          const response = { ...deferred<unknown>(), message };
          pending.push(response);
          sent.push(message);
          return response.promise;
        }),
      },
    },
    // The user accepts the in-document confirmation.
    confirmAction: async () => true,
    resetVerificationFeedback: vi.fn(),
    renderExclusionPreview: vi.fn(),
    renderTheme: vi.fn(),
    openDevices: vi.fn(),
    renderCommunicationFailure: vi.fn(),
    // Only the devices dialog is rendered.
    renderCurrent: (next: AppSnapshot) => subject.renderDevices(next),
    replaceListChildren: (list: FakeElement, children: FakeElement[]) => {
      list.children = children;
    },
  };
  // Execute the production functions, with only messaging and other views replaced.
  runInNewContext(executable, context);
  const subject = context as unknown as Subject;
  subject.bindEvents();
  subject.renderDevices(subject.snapshot);
  // Lets confirmations and fire-and-forget handlers finish their promise chains.
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  const deleteButton = (device: Device) => {
    const button = elements
      .deviceList!.children.flatMap((row) => row.children)
      .find(({ dataset }) => dataset.focusKey === device.deviceId);
    if (!button) throw new Error("missing_device_row");
    return button;
  };
  return {
    subject,
    elements,
    sent,
    deleteButton,
    async pressDelete(device: Device) {
      deleteButton(device).click();
      await settle();
    },
    async answer(request: ExtensionRequest, result: CommandResult, patch: Partial<AppSnapshot>) {
      const index = pending.findIndex(
        ({ message }) => JSON.stringify(message) === JSON.stringify(request),
      );
      if (index < 0) throw new Error("missing_popup_request");
      pending.splice(index, 1)[0]!.resolve({ ...result, snapshot: publish(patch) });
      await settle();
    },
    shownFailure: () =>
      elements.devicesError!.visible ? elements.devicesError!.textContent : null,
  };
}

const remove = (device: Device): ExtensionRequest => ({
  type: "delete_device",
  deviceId: device.deviceId,
});
const refused: CommandResult = { ok: false, commandError: "network_error" };

describe("the failure of a device deletion in the devices dialog", () => {
  it("scripts the worker as the controller answers overlapping device commands", async () => {
    const h = createHarness({ persisted: authenticatedState() });
    h.api.devices = { limit: 5, devices: [CURRENT, LAPTOP, PHONE] };
    h.identity.deviceId = CURRENT.deviceId;
    await h.controller.initialize();
    expect(await h.controller.refreshDevices()).toEqual({ ok: true });
    const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
    const held = {
      laptop: deferred<undefined>(),
      phone: deferred<undefined>(),
      list: deferred<undefined>(),
    };
    const deleteDevice = h.api.deleteDevice.bind(h.api);
    vi.spyOn(h.api, "deleteDevice").mockImplementation(async (token, deviceId) => {
      if (deviceId === LAPTOP.deviceId) {
        await held.laptop.promise;
        throw new NetworkError("network");
      }
      await held.phone.promise;
      await deleteDevice(token, deviceId);
    });
    const getDevices = h.api.getDevices.bind(h.api);
    vi.spyOn(h.api, "getDevices").mockImplementation(async () => {
      await held.list.promise;
      return getDevices();
    });

    // A list refresh started during a deletion that then fails.
    const laptop = h.controller.deleteDevice(LAPTOP.deviceId);
    await settle();
    const refresh = h.controller.refreshDevices();
    held.laptop.resolve(undefined);
    expect(await laptop).toEqual(refused);
    expect(h.controller.getSnapshot()).toMatchObject(FAILED);
    held.list.resolve(undefined);
    expect(await refresh).toEqual({ ok: true });
    expect(h.controller.getSnapshot()).toMatchObject({
      error: null,
      devices: [CURRENT, LAPTOP, PHONE],
    });

    // Another deletion started during a deletion that then fails.
    const failing = h.controller.deleteDevice(LAPTOP.deviceId);
    await settle();
    const other = h.controller.deleteDevice(PHONE.deviceId);
    expect(await failing).toEqual(refused);
    expect(h.controller.getSnapshot()).toMatchObject(FAILED);
    held.phone.resolve(undefined);
    expect(await other).toEqual({ ok: true });
    expect(h.controller.getSnapshot()).toMatchObject({ error: null, devices: [CURRENT, LAPTOP] });
  });

  it("is shown when the command failed after its device left the list", async () => {
    const { subject, pressDelete, answer, shownFailure } = setup();
    await pressDelete(LAPTOP);
    // The deletion itself went through; what followed it failed.
    await answer(remove(LAPTOP), refused, { ...FAILED, devices: [CURRENT, PHONE] });
    expect(subject.snapshot.devices).not.toContainEqual(LAPTOP);
    expect(shownFailure()).toBe(FAILURE);
  });

  it("is shown when nothing else was started meanwhile", async () => {
    const { subject, sent, pressDelete, answer, shownFailure } = setup();
    await pressDelete(LAPTOP);
    expect(sent).toEqual([remove(LAPTOP)]);
    await answer(remove(LAPTOP), refused, FAILED);
    expect(subject.snapshot.devices).toContainEqual(LAPTOP);
    expect(shownFailure()).toBe(FAILURE);
  });

  it.each(["the deletion first", "the refresh first"] as const)(
    "is still shown after a list refresh started before its reply: %s",
    async (order) => {
      const { subject, elements, sent, pressDelete, answer, shownFailure } = setup();
      await pressDelete(LAPTOP);
      // Refresh stays available while the deletion is pending.
      expect(elements.refreshDevicesButton!.disabled).toBe(false);
      elements.refreshDevicesButton!.click();
      expect(sent).toEqual([remove(LAPTOP), { type: "refresh_devices" }]);
      if (order === "the deletion first") {
        await answer(remove(LAPTOP), refused, FAILED);
        // A successful list refresh also clears the published account error.
        await answer({ type: "refresh_devices" }, { ok: true }, { error: null });
      } else {
        await answer({ type: "refresh_devices" }, { ok: true }, {});
        await answer(remove(LAPTOP), refused, FAILED);
      }
      // The device the user asked to delete is still listed.
      expect(subject.snapshot.devices).toContainEqual(LAPTOP);
      expect(shownFailure()).toBe(FAILURE);
    },
  );
});
