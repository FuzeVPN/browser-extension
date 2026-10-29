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

type Marker = false | { epoch: number };
type MarkerName =
  | "connectionRetryPending"
  | "securityPreferencesPending"
  | "devicesRefreshPending"
  | "locationsRefreshPending"
  | "automaticSelectionPending";

interface Subject extends Record<MarkerName, Marker> {
  snapshot: AppSnapshot;
  communicationFailed: boolean;
  failures: number;
  accountRefreshPending: Marker;
  devicesFailure: { transport: boolean } | null;
  locationsRefreshFailed: boolean;
  locationPreferenceFailure: string | null;
  verificationPending: boolean;
  verificationSent: boolean;
  elements: { verificationStatus: { textContent: string } };
  request(message: ExtensionRequest): Promise<PopupResponse>;
  render(value: unknown, confirmed?: boolean): boolean;
  refreshAccount(): Promise<void>;
  resendVerification(): Promise<void>;
  refreshDevices(): Promise<void>;
  refreshLocations(): Promise<void>;
  retryConnection(): Promise<void>;
  updateSecurityPreferences(): Promise<void>;
  selectAutomaticLocation(): void;
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
  "resendVerification",
  "renderVerification",
  "resetVerificationFeedback",
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
function clickHandler(target: string): string {
  let handler: string | undefined;
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      node.expression.getText(ast) === `elements.${target}.addEventListener` &&
      node.arguments[0]?.getText(ast) === '"click"'
    )
      handler = node.arguments[1]?.getText(ast);
    ts.forEachChild(node, visit);
  };
  visit(ast);
  if (!handler) throw new Error("missing_popup_handler");
  return handler;
}

const executable = ts.transpileModule(
  [
    ...declarations,
    `var selectAutomaticLocation = ${clickHandler("automaticLocationButton")};`,
  ].join("\n"),
  { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
).outputText;

const PROFILE_B = { ...PROFILE, userId: "account-b", email: "b@example.invalid" };
const VERIFICATION_REQUIRED: Partial<AppSnapshot> = {
  status: "error",
  protected: false,
  protectionRequested: false,
  activeLocationId: null,
  error: "email_verification_required",
};
const BLOCKED: Partial<AppSnapshot> = {
  status: "blocked",
  protected: false,
  error: "network_error",
};

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
  const locationRenders: { loading: boolean; failed: boolean }[] = [];
  const order = new PopupSnapshotOrder();
  order.accept(initial);
  const control = () => ({ checked: false, disabled: false });
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
    locationsRefreshPending: false as Marker,
    locationsRefreshFailed: false,
    automaticSelectionPending: false,
    locationSelectionPending: false,
    connectionRetryPending: false,
    securityPreferencesPending: false,
    verificationPending: false,
    verificationRequest: 0,
    verificationSent: false,
    verificationAvailable: false,
    verificationCooldownUntil: 0,
    verificationObservedCooldown: null,
    verificationFailure: null,
    verificationTimer: undefined,
    snapshotOrder: order,
    popupSnapshot,
    EMPTY_SNAPSHOT,
    expandedLocationCountries: new Set(),
    expandedLocationCities: new Set(),
    setTimeout,
    clearTimeout,
    message: (key: string) => key,
    errorMessage: (code: string) => code,
    elements: {
      confirmationDialog: { close: vi.fn() },
      locationDialog: { close: vi.fn() },
      killSwitchEnabled: control(),
      webRtcProtectionEnabled: { ...control(), checked: true },
      settingsError: { textContent: "", classList: { remove: vi.fn() } },
      verificationPanel: { classList: { toggle: vi.fn() } },
      verificationStatus: { textContent: "" },
      resendButton: { disabled: false, setAttribute: vi.fn() },
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
    renderCurrent(next: AppSnapshot) {
      subject.renderVerification(next);
    },
    renderDevices: vi.fn(),
    renderLocations() {
      locationRenders.push({
        loading: Boolean(context.locationsRefreshPending),
        failed: context.locationsRefreshFailed,
      });
    },
    renderError: vi.fn(),
    renderSecurity: vi.fn(),
    renderCommunicationFailure() {
      context.communicationFailed = true;
      ++context.failures;
      ++context.renderSequence;
    },
  };
  const subject = context as unknown as Subject & { renderVerification(next: AppSnapshot): void };
  // Execute the production functions, with only messaging and DOM rendering replaced.
  runInNewContext(executable, context);
  return {
    subject,
    pending,
    locationRenders,
    sent: () => pending.map(({ message }) => message.type),
  };
}

// Lets fire-and-forget click handlers finish their promise chains.
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("ULTRA-16 an unrelated reply cannot confirm an account refresh or email", () => {
  it.each([
    ["refreshAccount", "refresh_network"],
    ["refreshAccount", "refresh_devices"],
    ["resendVerification", "refresh_network"],
    ["resendVerification", "refresh_devices"],
  ] as const)(
    "%s keeps its channel failure visible after a %s reply",
    async (method, unrelated) => {
      const patch = method === "resendVerification" ? VERIFICATION_REQUIRED : {};
      const { subject, pending } = setup(state(1, patch));
      const command = subject[method]();
      if (method === "resendVerification")
        expect(subject.elements.verificationStatus.textContent).toBe("verificationSending");
      const other = subject.request({ type: unrelated });
      pending[1]!.resolve({ ok: true, snapshot: state(2, patch) });
      expect(await other).toMatchObject({ ok: true });
      expect(subject.communicationFailed).toBe(false);
      pending[0]!.reject(new Error("command_channel_closed"));
      await command;
      expect(subject.communicationFailed).toBe(true);
      expect(subject.failures).toBe(1);
      expect(subject.accountRefreshPending).toBe(false);
      expect(subject.verificationPending).toBe(false);
      expect(subject.verificationSent).toBe(false);
      expect(subject.elements.verificationStatus.textContent).not.toBe("verificationSending");
    },
  );

  it("still accepts the email command's own successful reply after an unrelated reply", async () => {
    const { subject, pending } = setup(state(1, VERIFICATION_REQUIRED));
    const email = subject.resendVerification();
    const other = subject.request({ type: "refresh_devices" });
    pending[1]!.resolve({ ok: true, snapshot: state(2, VERIFICATION_REQUIRED) });
    await other;
    pending[0]!.resolve({ ok: true, snapshot: state(3, VERIFICATION_REQUIRED) });
    await email;
    expect(subject.verificationSent).toBe(true);
    expect(subject.elements.verificationStatus.textContent).toBe("verificationSent");
    expect(subject.communicationFailed).toBe(false);
  });

  it("lets list refreshes report their own failure after a newer confirmed state", async () => {
    const { subject, pending } = setup();
    const devices = subject.refreshDevices();
    const locations = subject.refreshLocations();
    expect(subject.render(state(2), true)).toBe(true);
    pending[0]!.reject(new Error("devices_channel_closed"));
    pending[1]!.reject(new Error("locations_channel_closed"));
    await Promise.all([devices, locations]);
    expect(subject.devicesFailure).toMatchObject({ transport: true });
    expect(subject.locationsRefreshFailed).toBe(true);
    expect(subject.communicationFailed).toBe(false);
  });
});

const connectionCommands: ExtensionRequest[] = [
  { type: "disconnect" },
  { type: "update_security_preferences", killSwitchEnabled: true, webRtcProtectionEnabled: true },
];

describe("ULTRA-16 a newer connection command supersedes only connection commands", () => {
  it.each(
    connectionCommands.flatMap((command) => [
      { method: "refreshAccount" as const, command },
      { method: "resendVerification" as const, command },
    ]),
  )(
    "$method keeps its channel failure visible after $command.type is sent",
    async ({ method, command }) => {
      const patch = method === "resendVerification" ? VERIFICATION_REQUIRED : {};
      const { subject, pending } = setup(state(1, patch));
      const current = subject[method]();
      void subject.request(command);
      pending[0]!.reject(new Error("command_channel_closed"));
      await current;
      expect(subject.communicationFailed).toBe(true);
      expect(subject.failures).toBe(1);
      expect(subject.accountRefreshPending).toBe(false);
      expect(subject.verificationPending).toBe(false);
      expect(subject.elements.verificationStatus.textContent).not.toBe("verificationSending");
    },
  );

  it("shows the email command's own success after an unrelated connection command", async () => {
    const { subject, pending } = setup(state(1, VERIFICATION_REQUIRED));
    const email = subject.resendVerification();
    const other = subject.request({ type: "disconnect" });
    pending[1]!.resolve({ ok: true, snapshot: state(2, VERIFICATION_REQUIRED) });
    await other;
    pending[0]!.resolve({ ok: true, snapshot: state(3, VERIFICATION_REQUIRED) });
    await email;
    expect(subject.verificationSent).toBe(true);
    expect(subject.elements.verificationStatus.textContent).toBe("verificationSent");
  });

  it("lets list refreshes report their own failure after a connection command", async () => {
    const { subject, pending } = setup();
    const devices = subject.refreshDevices();
    const locations = subject.refreshLocations();
    void subject.request({ type: "disconnect" });
    pending[0]!.reject(new Error("devices_channel_closed"));
    pending[1]!.reject(new Error("locations_channel_closed"));
    await Promise.all([devices, locations]);
    expect(subject.devicesFailure).toMatchObject({ transport: true });
    expect(subject.locationsRefreshFailed).toBe(true);
    expect(subject.communicationFailed).toBe(true);
  });

  it("still lets a newer connection command supersede an older one", async () => {
    const { subject, pending } = setup();
    const old = subject.request({ type: "connect", locationId: "de" });
    void subject.request({ type: "disconnect" });
    pending[0]!.reject(new Error("older_connect_channel_closed"));
    expect(await old).toMatchObject({ stale: true, superseded: true });
    expect(subject.communicationFailed).toBe(false);
  });
});

const actions = [
  {
    method: "retryConnection",
    marker: "connectionRetryPending",
    type: "retry_connection",
    initial: BLOCKED,
  },
  {
    method: "updateSecurityPreferences",
    marker: "securityPreferencesPending",
    type: "update_security_preferences",
    initial: BLOCKED,
  },
  {
    method: "refreshDevices",
    marker: "devicesRefreshPending",
    type: "refresh_devices",
    initial: {},
  },
  {
    method: "refreshLocations",
    marker: "locationsRefreshPending",
    type: "refresh_locations",
    initial: {},
  },
] as const;

// Publishes the replacement context and returns the patch identifying its later snapshots.
function replaceContext(
  subject: Subject,
  boundary: "account" | "worker",
  initial: Partial<AppSnapshot>,
): Partial<AppSnapshot> {
  if (boundary === "worker") {
    subject.render(
      state(1, { ...initial, snapshotVersion: { workerId: "worker-b", revision: 1 } }),
      true,
    );
    return { snapshotVersion: { workerId: "worker-b", revision: 2 } };
  }
  subject.render(
    state(2, {
      profile: null,
      status: "logged_out",
      protected: false,
      protectionRequested: false,
      activeLocationId: null,
    }),
    true,
  );
  subject.render(state(3, { ...initial, profile: PROFILE_B }), true);
  return { profile: PROFILE_B, snapshotVersion: { workerId: "worker-a", revision: 4 } };
}

describe("COND-ULTRA-05/06 a pending marker belongs to the account and worker that sent it", () => {
  for (const boundary of ["account", "worker"] as const) {
    it.each(
      actions.flatMap((action) => [
        { ...action, completion: "reject" as const },
        { ...action, completion: "resolve" as const },
      ]),
    )(
      `${boundary} replacement: $method is neither blocked nor released by the old $completion`,
      async ({ method, marker, type, initial, completion }) => {
        const { subject, pending, sent } = setup(state(1, initial));
        const old = subject[method]();
        expect(subject[marker]).toBeTruthy();
        const current = replaceContext(subject, boundary, initial);
        expect(subject[marker]).toBe(false);
        const replacement = subject[method]();
        expect(sent()).toEqual([type, type]);
        const currentMarker = subject[marker];
        expect(currentMarker).toBeTruthy();
        if (completion === "reject") pending[0]!.reject(new Error("retired_context_channel"));
        else
          pending[0]!.resolve({
            ok: false,
            commandError: "device_limit",
            snapshot: state(99, { status: "error", error: "device_limit" }),
          });
        await old;
        expect(subject[marker]).toBe(currentMarker);
        expect(subject.snapshot.error).not.toBe("device_limit");
        expect(subject.devicesFailure).toBeNull();
        expect(subject.locationsRefreshFailed).toBe(false);
        expect(subject.communicationFailed).toBe(false);
        pending[1]!.resolve({ ok: true, snapshot: state(5, { ...initial, ...current }) });
        await replacement;
        expect(subject[marker]).toBe(false);
        expect(subject.communicationFailed).toBe(false);
        expect(subject.failures).toBe(0);
      },
    );
  }

  it("shows a location refresh failure answered by the replacement worker itself", async () => {
    const { subject, pending, locationRenders } = setup();
    const locations = subject.refreshLocations();
    pending[0]!.resolve({
      ok: false,
      commandError: "network_error",
      snapshot: state(1, { snapshotVersion: { workerId: "worker-b", revision: 1 } }),
    });
    await locations;
    expect(subject.snapshot.snapshotVersion?.workerId).toBe("worker-b");
    expect(subject.locationsRefreshPending).toBe(false);
    expect(subject.locationsRefreshFailed).toBe(true);
    expect(locationRenders.at(-1)).toEqual({ loading: false, failed: true });
  });

  it.each(["reject", "resolve"] as const)(
    "lets a replacement worker resend verification and keeps it pending after the old %s",
    async (completion) => {
      const { subject, pending, sent } = setup(state(1, VERIFICATION_REQUIRED));
      const old = subject.resendVerification();
      replaceContext(subject, "worker", VERIFICATION_REQUIRED);
      expect(subject.verificationPending).toBe(false);
      const current = subject.resendVerification();
      expect(sent()).toEqual(["resend_verification", "resend_verification"]);
      if (completion === "reject") pending[0]!.reject(new Error("retired_worker_channel"));
      else pending[0]!.resolve({ ok: true, snapshot: state(2, VERIFICATION_REQUIRED) });
      await old;
      expect(subject.verificationPending).toBe(true);
      expect(subject.verificationSent).toBe(false);
      expect(subject.elements.verificationStatus.textContent).toBe("verificationSending");
      expect(subject.communicationFailed).toBe(false);
      pending[1]!.resolve({
        ok: true,
        snapshot: state(2, {
          ...VERIFICATION_REQUIRED,
          snapshotVersion: { workerId: "worker-b", revision: 2 },
        }),
      });
      await current;
      expect(subject.verificationPending).toBe(false);
      expect(subject.elements.verificationStatus.textContent).toBe("verificationSent");
    },
  );

  it("shows a verification email sent by the replacement worker that answered it", async () => {
    const { subject, pending } = setup(state(1, VERIFICATION_REQUIRED));
    const email = subject.resendVerification();
    pending[0]!.resolve({
      ok: true,
      snapshot: state(1, {
        ...VERIFICATION_REQUIRED,
        snapshotVersion: { workerId: "worker-b", revision: 1 },
      }),
    });
    await email;
    expect(subject.verificationPending).toBe(false);
    expect(subject.verificationSent).toBe(true);
    expect(subject.elements.verificationStatus.textContent).toBe("verificationSent");
  });

  it.each(["reject", "resolve"] as const)(
    "lets a replacement worker select automatically and keeps its marker after the old %s",
    async (completion) => {
      const { subject, pending, sent } = setup();
      subject.selectAutomaticLocation();
      replaceContext(subject, "worker", {});
      expect(subject.automaticSelectionPending).toBe(false);
      subject.selectAutomaticLocation();
      expect(sent()).toEqual(["select_automatic_location", "select_automatic_location"]);
      const currentMarker = subject.automaticSelectionPending;
      expect(currentMarker).toBeTruthy();
      if (completion === "reject") pending[0]!.reject(new Error("retired_worker_channel"));
      else
        pending[0]!.resolve({
          ok: false,
          commandError: "server_full",
          snapshot: state(2, { error: "server_full" }),
        });
      await settle();
      expect(subject.automaticSelectionPending).toBe(currentMarker);
      expect(subject.locationPreferenceFailure).toBeNull();
      pending[1]!.resolve({
        ok: true,
        snapshot: state(2, { snapshotVersion: { workerId: "worker-b", revision: 2 } }),
      });
      await settle();
      expect(subject.automaticSelectionPending).toBe(false);
      expect(subject.communicationFailed).toBe(false);
    },
  );

  it("releases the automatic location selection of a retired worker", () => {
    const { subject } = setup();
    const context = subject as unknown as { automaticSelectionPending: Marker };
    context.automaticSelectionPending = { epoch: 1 };
    subject.render(state(2), true);
    expect(context.automaticSelectionPending).toEqual({ epoch: 1 });
    replaceContext(subject, "worker", {});
    expect(context.automaticSelectionPending).toBe(false);
  });

  it.each(actions)(
    "still deduplicates $method within the same account and worker",
    async ({ method, marker, type, initial }) => {
      const { subject, pending, sent } = setup(state(1, initial));
      const first = subject[method]();
      await subject[method]();
      expect(sent()).toEqual([type]);
      pending[0]!.resolve({ ok: true, snapshot: state(2, initial) });
      await first;
      expect(subject[marker]).toBe(false);
    },
  );
});
