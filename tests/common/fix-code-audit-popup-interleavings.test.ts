// SPDX-License-Identifier: MPL-2.0

import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import type { Device } from "../../src/core/api/types";
import type { ExtensionRequest, ExtensionResponse } from "../../src/core/shared/messages";
import { networkRouteKey } from "../../src/core/shared/network";
import { EMPTY_SNAPSHOT, type AppSnapshot } from "../../src/core/shared/state";
import { PopupSnapshotOrder, popupSnapshot } from "../../src/ui/popup/snapshot";
import { PROFILE } from "./helpers";

interface PopupResponse extends ExtensionResponse {
  stale?: boolean;
  transportFailed?: boolean;
}

interface Subject {
  snapshot: AppSnapshot;
  accountEpoch: number;
  accountRefreshPending: false | { epoch: number };
  communicationFailed: boolean;
  failures: number;
  request(message: ExtensionRequest): Promise<PopupResponse>;
  render(value: unknown, confirmed?: boolean): boolean;
  refreshAccount(): Promise<void>;
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
  "refreshAccount",
]);
const declarations = ast.statements
  .filter(ts.isFunctionDeclaration)
  .filter((node) => functionNames.has(node.name?.text ?? ""))
  .map((node) => node.getText(ast));
if (declarations.length !== functionNames.size) throw new Error("missing_popup_function");
const executable = ts.transpileModule(declarations.join("\n"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;

const DEVICE: Device = {
  deviceId: "device-to-delete",
  name: "Remote browser",
  kind: "browser_extension",
  profiles: [],
  createdAt: "2026-10-28T00:00:00Z",
};
const OTHER_DEVICE: Device = { ...DEVICE, deviceId: "unrelated-device" };
const PROFILE_B = { ...PROFILE, userId: "account-b", email: "b@example.invalid" };
const EXCLUSION = { domain: "example.com", includeSubdomains: true };

function state(revision = 1, patch: Partial<AppSnapshot> = {}): AppSnapshot {
  return {
    ...structuredClone(EMPTY_SNAPSHOT),
    profile: PROFILE,
    status: "connected",
    protected: true,
    protectionRequested: true,
    activeLocationId: "fr",
    selectedLocationId: "fr",
    effectiveLanguage: "fr",
    languagePreference: "fr",
    snapshotVersion: { workerId: "worker-a", revision },
    ...patch,
  };
}

function setup(initial = state()) {
  const pending: (ReturnType<typeof deferred<unknown>> & { message: ExtensionRequest })[] = [];
  const order = new PopupSnapshotOrder();
  order.accept(initial);
  const context = {
    snapshot: initial,
    accountEpoch: 1,
    accountRefreshPending: false,
    communicationFailed: false,
    failures: 0,
    renderSequence: 0,
    confirmedSnapshotSequence: 0,
    connectionRequestIntent: 0,
    devicesAction: 0,
    locationSelectionRequest: 0,
    loadedLocale: "fr",
    languageCatalogFailed: false,
    devicesFailure: null,
    devicesRefreshPending: false,
    locationPreferenceFailure: null,
    locationsRefreshPending: false,
    locationsRefreshFailed: false,
    automaticSelectionPending: false,
    locationSelectionPending: false,
    snapshotOrder: order,
    popupSnapshot,
    networkRouteKey,
    EMPTY_SNAPSHOT,
    expandedLocationCountries: new Set(),
    expandedLocationCities: new Set(),
    elements: { confirmationDialog: { close: vi.fn() } },
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
    renderCommunicationFailure() {
      context.communicationFailed = true;
      ++context.failures;
      ++context.renderSequence;
    },
  };
  // Execute the production functions, with only messaging and final rendering replaced.
  runInNewContext(executable, context);
  return { subject: context as unknown as Subject, pending, renderCurrent: context.renderCurrent };
}

const stopped: Partial<AppSnapshot> = {
  status: "disconnected",
  protected: false,
  protectionRequested: false,
  activeLocationId: null,
};
const manual = { ...EMPTY_SNAPSHOT.locationPreferences, automatic: false };

describe("CODE10 popup command confirmation depends on the requested effect", () => {
  it.each([
    { type: "logout" },
    { type: "disconnect" },
    { type: "change_location", locationId: "de" },
  ] satisfies ExtensionRequest[])(
    "does not hide a lost $type command after an independent devices refresh",
    async (message) => {
      const { subject, pending } = setup();
      const command = subject.request(message);
      const devices = subject.request({ type: "refresh_devices" });
      pending[1]!.resolve({ ok: true, snapshot: state(2, { devices: [OTHER_DEVICE] }) });
      await devices;
      pending[0]!.reject(new Error("command_was_not_delivered"));
      expect(await command).toMatchObject({ ok: false, transportFailed: true });
      expect(subject.snapshot).toMatchObject({
        profile: { userId: PROFILE.userId },
        protected: true,
        protectionRequested: true,
        activeLocationId: "fr",
        devices: [{ deviceId: OTHER_DEVICE.deviceId }],
      });
      expect(subject.communicationFailed).toBe(true);
      expect(subject.failures).toBe(1);
    },
  );

  const completions: {
    name: string;
    message: ExtensionRequest;
    initial: AppSnapshot;
    completed: AppSnapshot;
  }[] = [
    {
      name: "web_login authenticates the account returned by its own request",
      message: { type: "web_login", disconnectFirst: false },
      initial: state(1, { ...stopped, status: "logged_out", profile: null }),
      completed: state(2, { profile: PROFILE_B }),
    },
    {
      name: "logout removes the authenticated profile",
      message: { type: "logout" },
      initial: state(),
      completed: state(2, { ...stopped, status: "logged_out", profile: null }),
    },
    {
      name: "disconnect stops protection",
      message: { type: "disconnect" },
      initial: state(),
      completed: state(2, stopped),
    },
    {
      name: "connect reaches its target",
      message: { type: "connect", locationId: "de" },
      initial: state(1, stopped),
      completed: state(2, { activeLocationId: "de", selectedLocationId: "de" }),
    },
    {
      name: "change_location reaches its target",
      message: { type: "change_location", locationId: "de" },
      initial: state(),
      completed: state(2, { activeLocationId: "de", selectedLocationId: "de" }),
    },
    {
      name: "select_location records the requested manual selection",
      message: { type: "select_location", locationId: "de" },
      initial: state(1, { ...stopped, locationPreferences: manual }),
      completed: state(2, { ...stopped, selectedLocationId: "de", locationPreferences: manual }),
    },
    {
      name: "select_automatic_location enables automatic selection",
      message: { type: "select_automatic_location" },
      initial: state(1, { ...stopped, locationPreferences: manual }),
      completed: state(2, {
        ...stopped,
        selectedLocationId: "de",
        locationPreferences: { ...manual, automatic: true },
      }),
    },
    {
      name: "retry_connection recovers from an error",
      message: { type: "retry_connection" },
      initial: state(1, { status: "error", protected: false, error: "network_error" }),
      completed: state(2),
    },
    {
      name: "reset_device_identity removes the identity and connection",
      message: { type: "reset_device_identity" },
      initial: state(1, { currentDeviceId: "current-device" }),
      completed: state(2, { ...stopped, currentDeviceId: null }),
    },
    {
      name: "delete_device removes the requested device",
      message: { type: "delete_device", deviceId: DEVICE.deviceId },
      initial: state(1, { devices: [DEVICE, OTHER_DEVICE] }),
      completed: state(2, { devices: [OTHER_DEVICE] }),
    },
    {
      name: "update_security_preferences reaches both requested values",
      message: {
        type: "update_security_preferences",
        killSwitchEnabled: false,
        webRtcProtectionEnabled: false,
      },
      initial: state(),
      completed: state(2, {
        securityPreferences: { killSwitchEnabled: false, webRtcProtectionEnabled: false },
      }),
    },
    {
      name: "update_site_exclusions applies the requested policy",
      message: {
        type: "update_site_exclusions",
        expectedRevision: 0,
        enabled: true,
        entries: [EXCLUSION],
      },
      initial: state(),
      completed: state(2, {
        siteExclusions: {
          saved: { revision: 1, enabled: true, entries: [EXCLUSION] },
          applied: { revision: 1, enabled: true, entries: [EXCLUSION] },
          pending: false,
          error: false,
        },
      }),
    },
    {
      name: "retry_site_exclusions applies the saved pending policy",
      message: { type: "retry_site_exclusions" },
      initial: state(1, {
        siteExclusions: {
          ...structuredClone(EMPTY_SNAPSHOT.siteExclusions),
          saved: { revision: 1, enabled: true, entries: [EXCLUSION] },
          pending: true,
        },
      }),
      completed: state(2, {
        siteExclusions: {
          saved: { revision: 1, enabled: true, entries: [EXCLUSION] },
          applied: { revision: 1, enabled: true, entries: [EXCLUSION] },
          pending: false,
          error: false,
        },
      }),
    },
  ];

  it.each(completions)(
    "accepts a lost response when $name",
    async ({ message, initial, completed }) => {
      const { subject, pending } = setup(initial);
      const command = subject.request(message);
      expect(subject.render(completed, true)).toBe(true);
      pending[0]!.reject(new Error("completion_reply_lost"));
      expect(await command).toMatchObject({ ok: false, transportFailed: true });
      expect(subject.communicationFailed).toBe(false);
      expect(subject.failures).toBe(0);
      expect(subject.snapshot).toMatchObject(completed);
    },
  );

  it.each([
    { type: "connect", locationId: "de" },
    { type: "change_location", locationId: "de" },
    { type: "select_location", locationId: "de" },
  ] satisfies ExtensionRequest[])(
    "keeps $type failure visible when a different target becomes active",
    async (message) => {
      const { subject, pending } = setup();
      const command = subject.request(message);
      subject.render(state(2, { activeLocationId: "nl", selectedLocationId: "nl" }), true);
      pending[0]!.reject(new Error("requested_target_not_reached"));
      await command;
      expect(subject.snapshot.activeLocationId).toBe("nl");
      expect(subject.communicationFailed).toBe(true);
    },
  );

  it("does not confirm a manual selection while its protected route is still the previous target", async () => {
    const { subject, pending } = setup();
    const command = subject.request({ type: "select_location", locationId: "de" });
    subject.render(state(2, { selectedLocationId: "de" }), true);
    pending[0]!.reject(new Error("route_did_not_change"));
    await command;
    expect(subject.communicationFailed).toBe(true);
  });

  it("does not confirm security preferences when only one requested setting changed", async () => {
    const { subject, pending } = setup();
    const command = subject.request({
      type: "update_security_preferences",
      killSwitchEnabled: false,
      webRtcProtectionEnabled: false,
    });
    subject.render(
      state(2, {
        securityPreferences: { killSwitchEnabled: false, webRtcProtectionEnabled: true },
      }),
      true,
    );
    pending[0]!.reject(new Error("preferences_not_applied"));
    await command;
    expect(subject.communicationFailed).toBe(true);
  });

  it("does not confirm exclusions when a different policy was applied", async () => {
    const { subject, pending } = setup();
    const command = subject.request({
      type: "update_site_exclusions",
      expectedRevision: 0,
      enabled: true,
      entries: [EXCLUSION],
    });
    const otherPolicy = {
      revision: 1,
      enabled: true,
      entries: [{ domain: "other.example.com", includeSubdomains: false }],
    };
    subject.render(
      state(2, {
        siteExclusions: { saved: otherPolicy, applied: otherPolicy, pending: false, error: false },
      }),
      true,
    );
    expect(subject.snapshot.siteExclusions.applied).toEqual(otherPolicy);
    pending[0]!.reject(new Error("different_policy_was_applied"));
    await command;
    expect(subject.communicationFailed).toBe(true);
  });

  it("does not confirm a device deletion when an unrelated device was removed", async () => {
    const { subject, pending } = setup(state(1, { devices: [DEVICE, OTHER_DEVICE] }));
    const command = subject.request({ type: "delete_device", deviceId: DEVICE.deviceId });
    subject.render(state(2, { devices: [DEVICE] }), true);
    pending[0]!.reject(new Error("requested_device_still_exists"));
    await command;
    expect(subject.communicationFailed).toBe(true);
  });

  it("does not confirm saved exclusions before the same policy is applied", async () => {
    const { subject, pending } = setup();
    const command = subject.request({
      type: "update_site_exclusions",
      expectedRevision: 0,
      enabled: true,
      entries: [EXCLUSION],
    });
    subject.render(
      state(2, {
        siteExclusions: {
          ...structuredClone(EMPTY_SNAPSHOT.siteExclusions),
          saved: { revision: 1, enabled: true, entries: [EXCLUSION] },
          pending: true,
        },
      }),
      true,
    );
    pending[0]!.reject(new Error("saved_policy_was_not_applied"));
    await command;
    expect(subject.communicationFailed).toBe(true);
  });

  it.each(["IP", "progress", "preferences", "exclusions"] as const)(
    "does not let an unrelated %s publication confirm disconnect",
    async (publication) => {
      const { subject, pending } = setup();
      const command = subject.request({ type: "disconnect" });
      const patch: Partial<AppSnapshot> =
        publication === "IP"
          ? {
              network: {
                status: "ready",
                mode: "vpn",
                ip: "203.0.113.42",
                checkedAt: 1,
                latencyMs: 2,
                locationId: "fr",
              },
            }
          : publication === "progress"
            ? { status: "disconnecting" }
            : publication === "preferences"
              ? { securityPreferences: { killSwitchEnabled: false, webRtcProtectionEnabled: true } }
              : {
                  siteExclusions: {
                    saved: { revision: 1, enabled: true, entries: [EXCLUSION] },
                    applied: { revision: 1, enabled: true, entries: [EXCLUSION] },
                    pending: false,
                    error: false,
                  },
                };
      subject.render(state(2, patch), true);
      pending[0]!.reject(new Error("disconnect_not_confirmed"));
      await command;
      expect(subject.communicationFailed).toBe(true);
      expect(subject.failures).toBe(1);
    },
  );

  it("does not treat an already satisfied target as a new command confirmation", async () => {
    const { subject, pending } = setup();
    const command = subject.request({ type: "change_location", locationId: "fr" });
    subject.render(state(2, { devices: [OTHER_DEVICE] }), true);
    pending[0]!.reject(new Error("new_command_not_delivered"));
    await command;
    expect(subject.communicationFailed).toBe(true);
  });
});

describe("EXTRA03 popup account and worker interleavings", () => {
  it("accepts the authenticated account in the current web_login response", async () => {
    const { subject, pending } = setup(
      state(1, { ...stopped, status: "logged_out", profile: null }),
    );
    const login = subject.request({ type: "web_login", disconnectFirst: false });
    pending[0]!.resolve({ ok: true, snapshot: state(2, { profile: PROFILE_B }) });
    expect(await login).toMatchObject({ ok: true });
    expect(subject.snapshot.profile?.userId).toBe(PROFILE_B.userId);
    expect(subject.communicationFailed).toBe(false);
  });

  it("ignores a valid old-account error snapshot after the replacement account was confirmed", async () => {
    const { subject, pending } = setup();
    const old = subject.request({ type: "refresh_account" });
    subject.render(state(2, { profile: PROFILE_B }), true);
    pending[0]!.resolve({
      ok: false,
      commandError: "network_error",
      snapshot: state(3, { status: "error", error: "network_error" }),
    });
    expect(await old).toMatchObject({ ok: false, stale: true, superseded: true });
    expect(subject.snapshot.profile?.userId).toBe(PROFILE_B.userId);
    expect(subject.snapshot.error).toBeNull();
    expect(subject.communicationFailed).toBe(false);
    const current = subject.request({ type: "refresh_account" });
    pending[1]!.resolve({
      ok: false,
      commandError: "network_error",
      snapshot: state(4, { profile: PROFILE_B, status: "error", error: "network_error" }),
    });
    expect(await current).toMatchObject({ ok: false, commandError: "network_error" });
    expect(subject.snapshot.profile?.userId).toBe(PROFILE_B.userId);
    expect(subject.snapshot.error).toBe("network_error");
  });

  it.each(["A finishes first", "B finishes first"] as const)(
    "allows account B to refresh while A is pending: %s",
    async (order) => {
      const { subject, pending, renderCurrent } = setup();
      const old = subject.refreshAccount();
      expect(pending.map(({ message }) => message.type)).toEqual(["refresh_account"]);
      subject.render(state(2, { profile: PROFILE_B }), true);
      expect(subject.accountRefreshPending).toBe(false);
      const current = subject.refreshAccount();
      expect(pending.map(({ message }) => message.type)).toEqual([
        "refresh_account",
        "refresh_account",
      ]);
      const currentPending = subject.accountRefreshPending;
      expect(currentPending).toBeTruthy();
      if (order === "A finishes first") {
        pending[0]!.reject(new Error("old_account_transport"));
        await old;
        expect(subject.accountRefreshPending).toBe(currentPending);
        pending[1]!.resolve({ ok: true, snapshot: state(3, { profile: PROFILE_B }) });
        await current;
      } else {
        // Resolve B before awaiting it; a correct implementation creates a real second request.
        pending[1]!.resolve({ ok: true, snapshot: state(3, { profile: PROFILE_B }) });
        await current;
        const renders = renderCurrent.mock.calls.length;
        pending[0]!.reject(new Error("old_account_transport"));
        await old;
        expect(renderCurrent).toHaveBeenCalledTimes(renders);
      }
      expect(subject.accountRefreshPending).toBe(false);
      expect(subject.snapshot.profile?.userId).toBe(PROFILE_B.userId);
      expect(subject.snapshot.snapshotVersion?.revision).toBe(3);
      expect(subject.communicationFailed).toBe(false);
      expect(subject.failures).toBe(0);
    },
  );

  it.each(["old worker finishes first", "new worker finishes first"] as const)(
    "allows the same account to refresh after its worker restarts: %s",
    async (order) => {
      const { subject, pending } = setup();
      const old = subject.refreshAccount();
      subject.render(state(1, { snapshotVersion: { workerId: "worker-b", revision: 1 } }), true);
      expect(subject.accountRefreshPending).toBe(false);
      const current = subject.refreshAccount();
      expect(pending).toHaveLength(2);
      const currentPending = subject.accountRefreshPending;
      expect(currentPending).toBeTruthy();
      const completeCurrent = () =>
        pending[1]!.resolve({
          ok: true,
          snapshot: state(2, { snapshotVersion: { workerId: "worker-b", revision: 2 } }),
        });
      if (order === "old worker finishes first") {
        pending[0]!.reject(new Error("retired_worker_transport"));
        await old;
        expect(subject.accountRefreshPending).toBe(currentPending);
        completeCurrent();
        await current;
      } else {
        completeCurrent();
        await current;
        pending[0]!.reject(new Error("retired_worker_transport"));
        await old;
      }
      expect(subject.accountRefreshPending).toBe(false);
      expect(subject.snapshot.snapshotVersion).toEqual({ workerId: "worker-b", revision: 2 });
      expect(subject.snapshot.profile?.userId).toBe(PROFILE.userId);
      expect(subject.communicationFailed).toBe(false);
      expect(subject.failures).toBe(0);
    },
  );

  it.each(["rejected", "malformed"] as const)(
    "keeps an old account's %s response out of B and still reports B's own failure",
    async (response) => {
      const { subject, pending } = setup();
      const old = subject.request({ type: "logout" });
      subject.render(state(2, { profile: PROFILE_B }), true);
      const current = subject.request({ type: "disconnect" });
      if (response === "rejected") pending[0]!.reject(new Error("old_account_transport"));
      else pending[0]!.resolve({ ok: true, snapshot: null });
      expect(await old).toMatchObject({ transportFailed: true, stale: true, superseded: true });
      expect(subject.snapshot.profile?.userId).toBe(PROFILE_B.userId);
      expect(subject.communicationFailed).toBe(false);
      pending[1]!.reject(new Error("current_account_transport"));
      await current;
      expect(subject.communicationFailed).toBe(true);
      expect(subject.failures).toBe(1);
    },
  );

  it.each(["connecting", "refreshing", "disconnecting"] as const)(
    "ignores a retired worker's late error while the replacement is %s",
    async (status) => {
      const { subject, pending } = setup();
      const old = subject.request({ type: "disconnect" });
      subject.render(
        state(1, {
          snapshotVersion: { workerId: "worker-b", revision: 1 },
          status,
        }),
        true,
      );
      pending[0]!.reject(new Error("retired_worker_transport"));
      expect(await old).toMatchObject({ stale: true, superseded: true });
      expect(subject.communicationFailed).toBe(false);
      const current = subject.request({ type: "disconnect" });
      pending[1]!.reject(new Error("current_worker_transport"));
      await current;
      expect(subject.communicationFailed).toBe(true);
      expect(subject.failures).toBe(1);
    },
  );

  it("rejects a retired intermediate worker publication after A to B to C", async () => {
    const { subject, pending } = setup();
    const old = subject.request({ type: "change_location", locationId: "de" });
    subject.render(state(1, { snapshotVersion: { workerId: "worker-b", revision: 1 } }), true);
    subject.render(state(1, { snapshotVersion: { workerId: "worker-c", revision: 1 } }), true);
    expect(
      subject.render(
        state(99, {
          snapshotVersion: { workerId: "worker-b", revision: 99 },
          error: "network_error",
        }),
        true,
      ),
    ).toBe(false);
    pending[0]!.reject(new Error("retired_worker_a_transport"));
    expect(await old).toMatchObject({ superseded: true });
    expect(subject.snapshot.snapshotVersion?.workerId).toBe("worker-c");
    expect(subject.snapshot.error).toBeNull();
    expect(subject.communicationFailed).toBe(false);
  });

  it("keeps a valid retired-worker error response out of its replacement", async () => {
    const { subject, pending } = setup();
    const old = subject.request({ type: "refresh_account" });
    subject.render(state(1, { snapshotVersion: { workerId: "worker-b", revision: 1 } }), true);
    pending[0]!.resolve({
      ok: false,
      commandError: "network_error",
      snapshot: state(99, { status: "error", error: "network_error" }),
    });
    expect(await old).toMatchObject({ ok: false, stale: true });
    expect(subject.snapshot.snapshotVersion?.workerId).toBe("worker-b");
    expect(subject.snapshot.error).toBeNull();
    expect(subject.communicationFailed).toBe(false);
  });

  it("keeps optional public IP failures out of B's connection error state", async () => {
    const { subject, pending } = setup();
    const oldIp = subject.request({ type: "refresh_network" });
    subject.render(state(2, { profile: PROFILE_B }), true);
    pending[0]!.reject(new Error("old_optional_ip_transport"));
    expect(await oldIp).toMatchObject({ superseded: true });
    const currentIp = subject.request({ type: "refresh_network" });
    pending[1]!.reject(new Error("current_optional_ip_transport"));
    await currentIp;
    expect(subject.communicationFailed).toBe(false);
    expect(subject.failures).toBe(0);
  });
});
