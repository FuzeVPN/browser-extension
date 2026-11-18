// SPDX-License-Identifier: MPL-2.0

import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { popupDom } from "./popup-dom";
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
  render(value: unknown, confirmed?: boolean): boolean;
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
  private text = "";
  /** How many times the text was written. */
  writes = 0;
  disabled = false;

  get textContent(): string {
    return this.text;
  }

  set textContent(value: string) {
    this.writes += 1;
    this.text = value;
  }

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

/** The devices dialog of the popup, open unless told otherwise, against a scripted worker. */
function setup(open = true) {
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
    deviceRefusals: new Map<string, unknown>(),
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
  runInNewContext(executable, Object.assign(context, popupDom));
  const subject = context as unknown as Subject;
  subject.bindEvents();
  (elements.devicesDialog as unknown as { open: boolean }).open = open;
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
const limited: CommandResult = { ok: false, commandError: "rate_limited" };
const LIMITED: Partial<AppSnapshot> = { status: "error", error: "rate_limited" };
const LIMIT = "<error_rate_limited>";

describe("the rows of the device list", () => {
  it("are not built while the dialog is closed, and are when it is open", () => {
    const { subject, elements } = setup(false);
    expect(elements.deviceList!.children).toEqual([]);
    // What the main view shows of the devices does not wait for the dialog.
    expect(elements.deviceCount!.textContent).toBe("<deviceCount>");

    subject.render(state(2, { devices: [CURRENT, LAPTOP] }));
    expect(elements.deviceList!.children).toEqual([]);

    (elements.devicesDialog as unknown as { open: boolean }).open = true;
    subject.renderDevices(subject.snapshot);
    expect(elements.deviceList!.children).toHaveLength(2);
  });
});

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

  it("is still shown when the deletion of another device is refused for another reason", async () => {
    const { subject, pressDelete, answer, shownFailure } = setup();
    await pressDelete(LAPTOP);
    await answer(remove(LAPTOP), refused, FAILED);
    await pressDelete(PHONE);
    // The first refusal stands while the second deletion is on its way.
    expect(shownFailure()).toBe(FAILURE);
    await answer(remove(PHONE), limited, LIMITED);
    expect(subject.snapshot.devices).toEqual([CURRENT, LAPTOP, PHONE]);

    // Both devices are still listed, and both refusals are reported.
    expect(shownFailure()).toBe(`${FAILURE}\n${LIMIT}`);

    // The phone is removed from elsewhere: its refusal leaves, the other one stays.
    subject.render(state(50, { ...LIMITED, devices: [CURRENT, LAPTOP] }));
    expect(shownFailure()).toBe(FAILURE);
  });

  it("is said once when two deletions are refused for the same reason", async () => {
    const { pressDelete, answer, shownFailure } = setup();
    await pressDelete(LAPTOP);
    await answer(remove(LAPTOP), refused, FAILED);
    await pressDelete(PHONE);
    await answer(remove(PHONE), refused, FAILED);
    expect(shownFailure()).toBe(FAILURE);
  });

  it("leaves when the same deletion is asked again, and then succeeds", async () => {
    const { pressDelete, answer, shownFailure } = setup();
    await pressDelete(LAPTOP);
    await answer(remove(LAPTOP), refused, FAILED);
    await pressDelete(PHONE);
    await answer(remove(PHONE), limited, LIMITED);

    await pressDelete(LAPTOP);
    // Asked again, the first deletion no longer reports its previous refusal.
    expect(shownFailure()).toBe(LIMIT);
    await answer(remove(LAPTOP), { ok: true }, { error: null, devices: [CURRENT, PHONE] });
    // Its success says nothing of the phone, which is still refused.
    expect(shownFailure()).toBe(LIMIT);
  });

  it("is not hidden by a list refresh which fails for another reason", async () => {
    const { elements, answer, pressDelete, shownFailure } = setup();
    await pressDelete(LAPTOP);
    await answer(remove(LAPTOP), refused, FAILED);
    elements.refreshDevicesButton!.click();
    await answer({ type: "refresh_devices" }, limited, LIMITED);
    expect(shownFailure()).toBe(`${LIMIT}\n${FAILURE}`);

    // The next refresh succeeds: only what it reported itself leaves.
    elements.refreshDevicesButton!.click();
    await answer({ type: "refresh_devices" }, { ok: true }, { error: null });
    expect(shownFailure()).toBe(FAILURE);
  });

  it("is written once: an alert written again is read again", async () => {
    const { subject, elements, pressDelete, answer } = setup();
    await pressDelete(LAPTOP);
    await answer(remove(LAPTOP), refused, FAILED);
    const written = elements.devicesError!.writes;
    subject.renderDevices(subject.snapshot);
    subject.renderDevices(subject.snapshot);
    expect(elements.devicesError!.writes).toBe(written);
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
