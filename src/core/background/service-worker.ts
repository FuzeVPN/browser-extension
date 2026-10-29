// SPDX-License-Identifier: MPL-2.0

import { extensionApi, registerPlatformEvents, inspectWebRtc } from "@platform/bridge";
import { ApiClient } from "../api/client";
import { ExtensionWebAuthService } from "../auth/web-auth";
import { IndexedDbDeviceIdentityService } from "../device/device-identity";
import {
  isExtensionRequest,
  type ExtensionRequest,
  type CommandResult,
  type ExtensionResponse,
  type StateChangedMessage,
} from "../shared/messages";
import { EMPTY_SNAPSHOT, type AppSnapshot, type MachineState } from "../shared/state";
import { PROXY_AUTH_RESTORE_TIMEOUT_MS, SITE_URLS } from "../shared/config";
import { ExtensionStorageService } from "../storage/storage";
import { ProxyAuthHandler } from "./proxy-auth";
import { PlatformProxyService } from "./proxy-controller";
import { ExtensionAlarmService } from "./session-refresh";
import { AppController, failedCommand } from "./state-machine";
import { PlatformNetworkSafetyService } from "./network-safety";
import { PlatformRouteGuard, type RouteGuardState } from "./route-guard";
import { ExtensionSecurityStorage } from "../storage/security-storage";

import { LanguageController } from "./language-controller";
import { ExtensionLanguageStorage } from "../storage/language-storage";
import { NetworkObserver } from "./network-observer";
import { LocationPreferences } from "./location-preferences";
import { ConnectionJournal, type ConnectionTrace } from "./connection-journal";
import { ExtensionSiteExclusionStorage } from "../storage/site-exclusion-storage";
import { ExtensionProxyCleanupStorage } from "../storage/proxy-cleanup-storage";
import {
  DiagnosticService,
  DIAGNOSTIC_ALARM,
  DIAGNOSTIC_HISTORY_ALARM,
} from "../diagnostics/service";
import { isDiagnosticRequest } from "../shared/diagnostics-ui";
import type { DiagnosticReadModel } from "../diagnostics/collector";
import { readDiagnosticProbe } from "../diagnostics/probe";
import { canSendDiagnostics } from "../shared/data-consent";

const language = new LanguageController(new ExtensionLanguageStorage(), () =>
  extensionApi.i18n.getUILanguage(),
);
let publicationRequested = false;
let publicationScheduled = false;
let locationIntent = 0;
const snapshotWorkerId = crypto.randomUUID();
let snapshotRevision = 0;
let routingRevision = 0;
const proxy = new PlatformProxyService();
const safety = new PlatformNetworkSafetyService();
const CONNECTION_JOURNAL_KEY = "fuzevpnConnectionJournal";
const connectionJournal = new ConnectionJournal({
  storage: {
    async read() {
      return (await extensionApi.storage.session.get(CONNECTION_JOURNAL_KEY))[
        CONNECTION_JOURNAL_KEY
      ];
    },
    async write(events) {
      await extensionApi.storage.session.set({ [CONNECTION_JOURNAL_KEY]: events });
    },
  },
  now: Date.now,
  onChanged: () => diagnosticObserver.current?.connectionHistoryChanged(),
});
let lastConnectionState = "";
let connectionHistoryOwnerEstablished = false;
const diagnosticObserver: { current: DiagnosticService | null } = { current: null };
let signalDiagnosticReady: () => void = () => undefined;
const diagnosticReady = new Promise<void>((resolve) => {
  signalDiagnosticReady = resolve;
});
let webAuthService: ExtensionWebAuthService | null = null;
const controller = new AppController({
  webAuth: {
    authorize(signal, locale) {
      webAuthService ??= new ExtensionWebAuthService({ startUrl: SITE_URLS.extensionConnect });
      return webAuthService.authorize(signal, locale);
    },
  },
  api: new ApiClient(),
  storage: new ExtensionStorageService(),
  identity: new IndexedDbDeviceIdentityService(),
  proxy,
  alarms: new ExtensionAlarmService(),
  safety,
  securityStorage: new ExtensionSecurityStorage(),
  siteExclusionStorage: new ExtensionSiteExclusionStorage(),
  cleanupStorage: new ExtensionProxyCleanupStorage(),
  now: Date.now,
  onStateChanged: publishSnapshot,
  onConnectionEvent: recordConnectionEvent,
  captureConnectionEvents: () => connectionJournal.capture(),
  onDiagnosticAccountChanged: () => {
    lastConnectionState = "";
    if (diagnosticObserver.current) diagnosticObserver.current.syncAccount(true);
    else connectionJournal.clear();
  },
  resolveAutomaticLocation: async (catalog) => {
    await locations.initialize();
    const preferences = locations.getState(catalog);
    return preferences.automatic ? preferences.recommendedLocationId : undefined;
  },
});
new PlatformRouteGuard({
  readState: readRouteGuardState,
  extensionRoot: () => extensionApi.runtime.getURL(""),
}).register();
const network = new NetworkObserver({
  getSnapshot: () => controller.getSnapshot(),
  verifyRoute: verifyObservationRoute,
  useFallback: true,
  onChanged: () => {
    locations.recordObservation(network.getState());
    queuePublication();
  },
});
const LOCATION_PREFERENCES_KEY = "fuzevpnLocationPreferences";
const locations = new LocationPreferences({
  storage: {
    async read() {
      const stored = await extensionApi.storage.local.get(LOCATION_PREFERENCES_KEY);
      const preferences: unknown = stored[LOCATION_PREFERENCES_KEY];
      return preferences;
    },
    async write(value) {
      await extensionApi.storage.local.set({ [LOCATION_PREFERENCES_KEY]: value });
    },
  },
  onChanged: queuePublication,
});

const diagnosticController: Partial<
  Pick<AppController, "getDiagnosticAccount" | "getDiagnosticReadState" | "verifyDiagnosticProxy">
> = controller;
const diagnostics = new DiagnosticService({
  whenReady: () => diagnosticReady,
  connectionHistory: {
    initialize: () => connectionJournal.initialize(),
    clear: () => connectionJournal.clear(),
    // A restored journal has no trusted owner until account restoration and purge finish.
    count: () =>
      connectionHistoryOwnerEstablished && controller.hasRestoredAccount()
        ? connectionJournal.count()
        : 0,
    pruneExpired: () => connectionJournal.pruneExpired(),
    nextExpiry: () => connectionJournal.nextExpiry(),
  },
  read: diagnosticReadState,
  getAccount: () => diagnosticController.getDiagnosticAccount?.() ?? null,
  canSendDiagnostics,
  inspectSafety: () => safety.inspect(),
  inspectWebRtc,
  getProxyControl: () => proxy.getControlLevel(),
  verifyProxy: () => diagnosticController.verifyDiagnosticProxy?.() ?? Promise.resolve(null),
  probe: () =>
    readDiagnosticProbe({
      getSnapshot: () => controller.getSnapshot(),
      verifyRoute: verifyDiagnosticRoute,
    }),
  language: () => language.getState().effectiveLanguage,
  version: () => extensionApi.runtime.getManifest().version,
  now: Date.now,
  onChanged: (state) => {
    void extensionApi.runtime
      .sendMessage({ type: "diagnostics_changed", state })
      .catch(() => undefined);
  },
});
diagnosticObserver.current = diagnostics;
void diagnostics.initialize().catch(() => undefined);

const actionIconCache = new Map<string, ImageData>();

new ProxyAuthHandler({
  getSession: () => controller.getActiveSession(),
  isConfiguredProxyChallenge: (challenger) => proxy.isConfiguredProxyChallenge(challenger),
  wasUsedProxyChallenge: (challenger) => proxy.wasUsedProxyChallenge(challenger),
  isSessionCurrent: (session) => controller.isSessionCurrentForProxyAuth(session),
  onAuthenticationFailure: async (session) => {
    const record = diagnostics.capture("proxy_authentication");
    const started = Date.now();
    try {
      await controller.handleProxyAuthenticationFailure(session);
      const error = controller.getSnapshot().error;
      if (error) record({ ok: false, commandError: error }, Date.now() - started);
    } catch (error) {
      record(failedCommand(error), Date.now() - started);
      throw error;
    }
  },
  now: Date.now,
  restoreTimeoutMs: PROXY_AUTH_RESTORE_TIMEOUT_MS,
}).register();

extensionApi.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  if (
    sender.id !== extensionApi.runtime.id ||
    !sender.url?.startsWith(extensionApi.runtime.getURL(""))
  )
    return false;
  if (
    message &&
    typeof message === "object" &&
    "type" in message &&
    message.type === "get_connection_journal" &&
    Object.keys(message).length === 1
  ) {
    void readConnectionJournal().then(sendResponse);
    return true;
  }
  if (isDiagnosticRequest(message)) {
    void diagnostics
      .handle(message)
      .then(sendResponse)
      .catch(() => undefined);
    return true;
  }
  if (!isExtensionRequest(message)) return false;
  if (message.type === "logout") diagnostics.syncAccount(true);
  const recordConnection = connectionJournal.capture();
  traceConnectionCommand(message, "start", recordConnection);
  const diagnosticStarted = Date.now();
  const recordDiagnostic = diagnostics.capture(message.type);
  void handleMessage(message, recordConnection)
    .then((result) => {
      traceConnectionCommand(message, "end", recordConnection, result);
      if (message.type !== "get_snapshot" && message.type !== "set_language_preference")
        recordDiagnostic(result, Date.now() - diagnosticStarted);
      sendResponse({ ...result, snapshot: localizedSnapshot() } satisfies ExtensionResponse);
    })
    .catch((error: unknown) => {
      const result = messageFailure(error);
      traceConnectionCommand(message, "end", recordConnection, result);
      if (message.type !== "get_snapshot" && message.type !== "set_language_preference")
        recordDiagnostic(result, Date.now() - diagnosticStarted);
      sendResponse({
        ...result,
        snapshot: localizedSnapshot(),
      } satisfies ExtensionResponse);
    });
  return true;
});

extensionApi.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === DIAGNOSTIC_HISTORY_ALARM) {
    void diagnostics.historyAlarm().catch(() => undefined);
    return;
  }
  if (alarm.name === DIAGNOSTIC_ALARM) {
    void diagnostics.alarm().catch(() => undefined);
    return;
  }
  runBackgroundEvent("alarms.onAlarm", () => controller.handleAlarm(alarm.name));
});
extensionApi.runtime.onStartup.addListener(() => {
  runBackgroundEvent("runtime.onStartup", () => controller.initialize());
});
extensionApi.runtime.onInstalled.addListener(() => {
  runBackgroundEvent("runtime.onInstalled", () => controller.initialize());
});

registerPlatformEvents({
  proxyChanged() {
    routingRevision++;
    runBackgroundEvent("proxy.settings.onChange", async () =>
      controller.handleProxyControlLost(await proxy.getControlLevel()),
    );
  },
  proxyError(message, provenance) {
    const handling = provenance
      ? controller.handleProxyError(message, false, provenance)
      : controller.handleProxyError(message, false);
    runBackgroundEvent("proxy.error", () => handling);
  },
  permissionsChanged() {
    routingRevision++;
    runBackgroundEvent("permissions.changed", () => controller.handleProxyPermissionsChanged());
  },
  diagnosticsConsentRemoved() {
    diagnostics.permissionsRemoved();
  },
  diagnosticsConsentAdded() {
    diagnostics.permissionsChanged();
  },
  privacyChanged() {
    routingRevision++;
    runBackgroundEvent("privacy.changed", () => controller.handlePrivacyChange());
  },
});

runBackgroundEvent("initialize", async () => {
  try {
    await controller.initialize();
    establishConnectionHistoryOwner();
  } finally {
    // Diagnostics wait for the existing startup to establish the local owner.
    // Restoring history before this point would mistake a sleeping worker for logout.
    signalDiagnosticReady();
  }
});

function establishConnectionHistoryOwner(): boolean {
  if (!controller.hasRestoredAccount()) return false;
  if (!connectionHistoryOwnerEstablished) {
    // Restored arrays have no owner. Start a known account/guest boundary before
    // publishing or exporting them, including after an unread-storage recovery.
    if (diagnosticObserver.current) diagnosticObserver.current.syncAccount(true);
    else connectionJournal.clear();
    connectionHistoryOwnerEstablished = true;
    lastConnectionState = "";
  }
  return true;
}

async function readConnectionJournal() {
  try {
    await diagnosticReady;
    await controller.initialize();
    if (!establishConnectionHistoryOwner()) return { ok: false, error: "storage_unavailable" };
    diagnostics.syncAccount();
    return {
      ok: true,
      journal: {
        schemaVersion: 1,
        extensionVersion: extensionApi.runtime.getManifest().version,
        events: await connectionJournal.snapshot(),
      },
    };
  } catch {
    return { ok: false, error: "storage_unavailable" };
  }
}

function runBackgroundEvent(event: string, operation: () => Promise<unknown>): void {
  const started = Date.now();
  const recordDiagnostic = diagnostics.capture(event);
  const readSignature = () => {
    try {
      const model = diagnosticController.getDiagnosticReadState?.();
      const snapshot = model?.snapshot ?? controller.getSnapshot();
      return {
        error: snapshot.error,
        value: JSON.stringify([
          snapshot.error,
          snapshot.status,
          snapshot.nextRetryAt,
          model?.reconnectAttempts ?? null,
        ]),
      };
    } catch {
      // An unavailable diagnostic read must neither fail the operation nor invent an incident.
      return null;
    }
  };
  const before = event === "state_publication" ? null : readSignature();
  void Promise.resolve()
    .then(operation)
    .then(() => {
      if (event === "state_publication") return;
      const after = readSignature();
      if (!before || !after) return;
      // Void handlers can legitimately do nothing. A persistent error is not a new
      // failure, while a changed retry deadline/count still identifies another attempt.
      if (after.error && before.value === after.value) return;
      recordDiagnostic(
        after.error ? { ok: false, commandError: after.error } : { ok: true },
        Date.now() - started,
      );
    })
    .catch((error: unknown) => {
      const result = failedCommand(error);
      if (event !== "state_publication") recordDiagnostic(result, Date.now() - started);
      if (result.superseded) return;
      // Event details, exception messages and stacks may contain URLs or credentials.
      console.warn("Background event failed", {
        event,
        code: result.commandError ?? "unknown_error",
      });
    });
}

async function handleMessage(
  message: ExtensionRequest,
  recordConnection: (event: ConnectionTrace) => void,
): Promise<CommandResult> {
  const changesConnection = [
    "web_login",
    "logout",
    "connect",
    "disconnect",
    "change_location",
    "select_location",
    "select_automatic_location",
    "retry_connection",
    "reset_device_identity",
    "delete_device",
    "update_security_preferences",
    "update_site_exclusions",
    "retry_site_exclusions",
  ].includes(message.type);
  const intent = changesConnection ? ++locationIntent : locationIntent;
  switch (message.type) {
    case "update_site_exclusions":
      await controller.updateSiteExclusions(
        message.expectedRevision,
        message.enabled,
        message.entries,
      );
      break;
    case "retry_site_exclusions":
      await controller.retrySiteExclusions();
      break;
    case "get_snapshot":
      await Promise.all([
        controller.initialize(),
        initializeLanguageForPublication(),
        locations.initialize(),
      ]);
      break;
    case "refresh_network":
      await controller.initialize();
      network.observe(controller.getSnapshot());
      // Publish the IP later without holding the command response open.
      void network.refresh().catch(() => undefined);
      break;
    case "set_language_preference":
      await language.setPreference(message.preference);
      publishSnapshot(controller.getSnapshot());
      break;
    case "web_login":
      await initializeLanguageForPublication();
      assertLocationIntent(intent);
      return controller.webLogin(message.disconnectFirst, language.getState().effectiveLanguage);
    case "set_location_favorite":
      await controller.initialize(recordConnection);
      if (!controller.getSnapshot().profile) throw new Error("unauthorized");
      if (message.favorite) assertAvailableLocation(message.locationId, recordConnection);
      await locations.setFavorite(message.locationId, message.favorite);
      break;
    case "select_automatic_location": {
      await prepareLocationAction(intent, recordConnection);
      await locations.setAutomatic(true);
      assertLocationIntent(intent);
      const snapshot = controller.getSnapshot();
      const recommended = locations.getState(snapshot.locations).recommendedLocationId;
      if (snapshot.protected) return controller.connect(null, recordConnection);
      if (!recommended) {
        recordConnection({
          event: "failure",
          source: "local",
          reason: "automatic_empty",
          error: "invalid_location",
          count: snapshot.locations.length,
          requestedPresent: false,
        });
        throw new Error("invalid_location");
      }
      return controller.selectLocation(recommended, recordConnection);
    }
    case "select_location":
      await prepareLocationAction(intent, recordConnection);
      assertAvailableLocation(message.locationId, recordConnection);
      await locations.setAutomatic(false);
      assertLocationIntent(intent);
      return controller.selectLocation(message.locationId, recordConnection);
    case "connect": {
      await prepareLocationAction(intent, recordConnection);
      const state = locations.getState(controller.getSnapshot().locations);
      return controller.connect(state.automatic ? null : message.locationId, recordConnection);
    }
    case "change_location":
      await prepareLocationAction(intent, recordConnection);
      assertAvailableLocation(message.locationId, recordConnection);
      await locations.setAutomatic(false);
      assertLocationIntent(intent);
      return controller.changeLocation(message.locationId, recordConnection);
    case "disconnect":
      return controller.disconnect();
    case "retry_connection":
      return controller.retryConnection(false, recordConnection);
    case "update_security_preferences":
      return controller.updateSecurityPreferences(
        message.killSwitchEnabled,
        message.webRtcProtectionEnabled,
        recordConnection,
      );
    case "logout":
      return controller.logout();
    case "resend_verification":
      return controller.resendVerification();
    case "refresh_account":
      return controller.refreshAccount();
    case "refresh_locations":
      return controller.refreshLocations();
    case "refresh_devices":
      return controller.refreshDevices();
    case "delete_device":
      return controller.deleteDevice(message.deviceId, recordConnection);
    case "reset_device_identity":
      return controller.resetDeviceIdentity();
  }
  return { ok: true };
}

function messageFailure(error: unknown): CommandResult {
  if (error instanceof Error) {
    if (error.message === "location_selection_superseded") return { ok: false, superseded: true };
    if (error.message === "unauthorized" || error.message === "invalid_location")
      return { ok: false, commandError: error.message };
  }
  return failedCommand(error);
}

async function initializeLanguageForPublication(): Promise<void> {
  try {
    await language.initialize();
  } catch {
    // Native Chrome messages remain available; subsequent publications retry loading.
    console.warn("Language preferences unavailable; using browser messages.");
  }
}

async function prepareLocationAction(
  intent: number,
  recordConnection: (event: ConnectionTrace) => void,
): Promise<void> {
  // A restoration retried here belongs to the command, like the one it would retry itself.
  await Promise.all([controller.initialize(recordConnection), locations.initialize()]);
  assertLocationIntent(intent);
  if (!controller.getSnapshot().profile) throw new Error("unauthorized");
}

function assertLocationIntent(intent: number): void {
  if (intent !== locationIntent) throw new Error("location_selection_superseded");
}

function assertAvailableLocation(
  id: string,
  recordConnection: (event: ConnectionTrace) => void,
): void {
  const snapshot = controller.getSnapshot();
  if (!snapshot.profile || !snapshot.locations.some((location) => location.id === id)) {
    recordConnection({
      event: "failure",
      source: "local",
      reason: "select_missing",
      error: "invalid_location",
      count: snapshot.locations.length,
      requestedPresent: false,
    });
    throw new Error("invalid_location");
  }
}

function recordConnectionEvent(event: ConnectionTrace): void {
  try {
    connectionJournal.record(event);
  } catch {
    /* Local tracing must never affect a VPN command or publication. */
  }
}

function traceConnectionCommand(
  message: ExtensionRequest,
  phase: "start" | "end",
  recordConnection: (event: ConnectionTrace) => void,
  result?: CommandResult,
): void {
  const action = message.type;
  if (
    action !== "connect" &&
    action !== "disconnect" &&
    action !== "retry_connection" &&
    action !== "change_location" &&
    action !== "select_location" &&
    action !== "select_automatic_location" &&
    action !== "refresh_account" &&
    action !== "refresh_locations"
  )
    return;
  const snapshot = controller.getSnapshot();
  recordConnection({
    event: "command",
    phase,
    action,
    status: snapshot.status,
    error: result?.commandError ?? null,
    count: snapshot.locations.length,
    selectedPresent: snapshot.locations.some(
      (location) => location.id === snapshot.selectedLocationId,
    ),
    ...("locationId" in message
      ? {
          requestedPresent: snapshot.locations.some(
            (location) => location.id === message.locationId,
          ),
        }
      : {}),
  });
}

function localizedSnapshot(): AppSnapshot {
  const snapshot = controller.getSnapshot();
  return {
    ...snapshot,
    ...language.getState(),
    snapshotVersion: { workerId: snapshotWorkerId, revision: ++snapshotRevision },
    network: network.getState(),
    locationPreferences: locations.getState(snapshot.locations),
  };
}

function publishSnapshot(snapshot: AppSnapshot): void {
  try {
    establishConnectionHistoryOwner();
  } catch {
    /* A failing history observer cannot interrupt state publication. */
  }
  const connectionState: ConnectionTrace = {
    event: "state",
    status: snapshot.status,
    error: snapshot.error,
    protected: snapshot.protected,
    protectionRequested: snapshot.protectionRequested,
    trafficBlocked: snapshot.trafficBlocked,
    count: snapshot.locations.length,
    selectedPresent: snapshot.locations.some(
      (location) => location.id === snapshot.selectedLocationId,
    ),
  };
  const stateKey = JSON.stringify(connectionState);
  if (stateKey !== lastConnectionState) {
    lastConnectionState = stateKey;
    recordConnectionEvent(connectionState);
  }
  try {
    diagnosticObserver.current?.syncAccount();
    diagnosticObserver.current?.observeRecovery();
  } catch {
    /* Diagnostics cannot interrupt state publication. */
  }
  network.observe(snapshot);
  if (snapshot.protected && snapshot.activeLocationId && snapshot.status === "connected") {
    void locations.recordConnected(snapshot.activeLocationId).catch(() => undefined);
  }
  queuePublication();
}

async function readRouteGuardState(): Promise<RouteGuardState> {
  await controller.initialize();
  const revision = routingRevision;
  const routingPolicy = routingSnapshotKey(controller.getSnapshot());
  const session = await controller.getActiveSession();
  const owned = (await proxy.getControlLevel()) === "controlled_by_this_extension";
  const configured = !!session && owned && (await proxy.isActiveConfiguration(session));
  const snapshot = controller.getSnapshot();
  const exclusions = safety.getRouteExclusions();
  const exclusionGuard = safety.hasExclusionGuard();
  const policy = JSON.stringify(exclusions);
  const isCurrent = () =>
    revision === routingRevision &&
    routingPolicy === routingSnapshotKey(controller.getSnapshot()) &&
    exclusionGuard === safety.hasExclusionGuard() &&
    policy === JSON.stringify(safety.getRouteExclusions());
  if (exclusionGuard || snapshot.trafficBlocked) {
    return { mode: "block", exclusions, isCurrent };
  }
  if (configured && controller.isSessionCurrentForProxyAuth(session)) {
    return {
      mode: "proxy",
      exclusions,
      endpoint: { host: session.host, port: session.port },
      isCurrent: () => isCurrent() && controller.isSessionCurrentForProxyAuth(session),
    };
  }
  if (owned || (snapshot.protectionRequested && snapshot.securityPreferences.killSwitchEnabled)) {
    return { mode: "block", exclusions, isCurrent };
  }
  return { mode: "off", isCurrent };
}

/** Account/catalog/UI publications must not cancel an otherwise unchanged request. */
function routingSnapshotKey(snapshot: AppSnapshot): string {
  return JSON.stringify([
    snapshot.protectionRequested,
    snapshot.protected,
    snapshot.trafficBlocked,
    snapshot.blockingScope,
    snapshot.securityPreferences.killSwitchEnabled,
    snapshot.securityPreferences.webRtcProtectionEnabled,
    snapshot.webRtcProtected,
    snapshot.activeLocationId,
    snapshot.profile?.userId ?? null,
    snapshot.siteExclusions.pending,
    snapshot.siteExclusions.error,
    ["connecting", "refreshing", "disconnecting"].includes(snapshot.status)
      ? snapshot.status
      : null,
  ]);
}

function queuePublication(): void {
  publicationRequested = true;
  if (publicationScheduled) return;
  publicationScheduled = true;
  runBackgroundEvent("state_publication", async () => {
    try {
      while (publicationRequested) {
        publicationRequested = false;
        await initializeLanguageForPublication();
        const localized = localizedSnapshot();
        await updateAction(localized);
        const message: StateChangedMessage = {
          type: "state_changed",
          // Action APIs may finish after a newer command response. Capture the
          // current state here; the version also orders independently delivered messages.
          snapshot: localizedSnapshot(),
        };
        await extensionApi.runtime.sendMessage(message).catch(() => undefined);
        diagnostics.syncAccount();
      }
    } finally {
      publicationScheduled = false;
      // A failure must not strand a newer change that arrived during an await.
      if (publicationRequested) queuePublication();
    }
  });
}

function diagnosticReadState(): DiagnosticReadModel {
  if (diagnosticController.getDiagnosticReadState)
    return diagnosticController.getDiagnosticReadState();
  return {
    snapshot: structuredClone(EMPTY_SNAPSHOT),
    safety: {
      trafficBlocked: false,
      webRtcProtected: false,
      filterActive: false,
      blockingScope: "unverified",
    },
    reconnectAttempts: 0,
    proxyCreationUncertain: false,
    proxyCleanupUncertain: false,
  };
}

async function verifyDiagnosticRoute(mode: "direct" | "vpn"): Promise<boolean> {
  const snapshot = controller.getSnapshot();
  if (snapshot.siteExclusions.pending || snapshot.siteExclusions.error || snapshot.trafficBlocked)
    return false;
  const status = await safety.inspect();
  if (status.blockingScope === "unverified" || status.trafficBlocked) return false;
  if (mode === "direct") {
    if (snapshot.protectionRequested || snapshot.protected) return false;
    const level = await proxy.getControlLevel();
    return level === "controllable_by_this_extension" && status.blockingScope === "none";
  }
  if (!snapshot.protected || !status.filterActive) return false;
  return (
    (await diagnosticController.verifyDiagnosticProxy?.()) === true &&
    (!snapshot.securityPreferences.webRtcProtectionEnabled || status.webRtcProtected)
  );
}

async function verifyObservationRoute(mode: "direct" | "vpn"): Promise<boolean> {
  const snapshot = controller.getSnapshot();
  if (snapshot.siteExclusions.pending || snapshot.siteExclusions.error) return false;
  if (mode === "direct") {
    if (snapshot.protectionRequested || snapshot.protected || snapshot.trafficBlocked) return false;
    const [level, status] = await Promise.all([proxy.getControlLevel(), safety.inspect()]);
    return level !== "controlled_by_this_extension" && !status.trafficBlocked;
  }
  if (!snapshot.protected || snapshot.trafficBlocked) return false;
  const session = await controller.getActiveSession();
  if (session?.locationId !== snapshot.activeLocationId) return false;
  const [configured, status] = await Promise.all([
    proxy.isActiveConfiguration(session),
    safety.inspect(),
  ]);
  return (
    configured &&
    controller.isSessionCurrentForProxyAuth(session) &&
    status.filterActive &&
    !status.trafficBlocked &&
    (!snapshot.securityPreferences.webRtcProtectionEnabled || status.webRtcProtected)
  );
}

async function updateAction(snapshot: AppSnapshot): Promise<void> {
  const visual = statusVisual(snapshot.status);
  const updates: Promise<unknown>[] = [
    updateActionIcon(visual.icon),
    // The compact state indicator is part of the local icon. Clear Chrome's
    // own badge because its fixed size obscures most of a 16 px brand mark.
    extensionApi.action.setBadgeText({ text: "" }),
    extensionApi.action.setTitle({ title: language.message(visual.titleKey) }),
  ];
  await Promise.allSettled(updates);
}

async function updateActionIcon(name: string): Promise<void> {
  const imageData: Record<number, ImageData> = {};
  for (const size of [16, 32]) {
    const cacheKey = `${name}-${String(size)}`;
    let icon = actionIconCache.get(cacheKey);
    if (!icon) {
      icon = await loadActionIcon(name, size);
      actionIconCache.set(cacheKey, icon);
    }
    imageData[size] = icon;
  }
  await extensionApi.action.setIcon({ imageData });
}

async function loadActionIcon(name: string, size: number): Promise<ImageData> {
  const response = await globalThis.fetch(
    extensionApi.runtime.getURL(`icons/${name}-${String(size)}.png`),
    { cache: "force-cache" },
  );
  if (!response.ok) throw new Error("action_icon_unavailable");
  const bitmap = await createImageBitmap(await response.blob());
  try {
    const canvas = new OffscreenCanvas(size, size);
    const context = canvas.getContext("2d");
    if (!context) throw new Error("action_icon_context_unavailable");
    context.drawImage(bitmap, 0, 0, size, size);
    return context.getImageData(0, 0, size, size);
  } finally {
    bitmap.close();
  }
}

function statusVisual(status: MachineState): {
  icon: string;
  titleKey: string;
} {
  if (status === "connected") return { icon: "connected", titleKey: "actionConnected" };
  if (status === "connecting" || status === "refreshing" || status === "disconnecting")
    return { icon: "reconnecting", titleKey: "actionReconnecting" };
  if (status === "error") return { icon: "error", titleKey: "actionError" };
  if (status === "blocked") return { icon: "error", titleKey: "actionBlocked" };
  return { icon: "disconnected", titleKey: "actionDisconnected" };
}
