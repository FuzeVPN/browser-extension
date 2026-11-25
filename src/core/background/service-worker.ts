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
import { ExtensionAccountSessionStorage } from "../storage/account-session-storage";
import { AccountSessions, RenewingApi } from "./account-sessions";
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
import { PreferenceOwner, preferenceMark, preferenceOwnerDigest } from "./preference-owner";
import { VpnAddressBook } from "./vpn-addresses";
import { LocationPreferences } from "./location-preferences";
import { ConnectionJournal, type ConnectionTrace } from "./connection-journal";
import { ExtensionSiteExclusionStorage } from "../storage/site-exclusion-storage";
import { ExtensionProxyCleanupStorage } from "../storage/proxy-cleanup-storage";
import { ExtensionAccountCacheStorage } from "../storage/account-cache-storage";
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
/** Moves whenever something a route decision rests on has changed. */
let routingRevision = 0;
/** What the last published state means for routing: its changes move the revision. */
let routingKey = "";
/**
 * The basis of route decisions, kept while nothing it was read from has changed. Every
 * request asks for it twice: reading the proxy settings and building the configuration
 * to compare them with, each time, delayed each request for the same answer. Changes
 * are reported by events; the settings are still read again after this long, should an
 * event ever be missing.
 */
const ROUTE_GUARD_MEMO_MS = 1_000;
let routeGuardMemo: { state: RouteGuardState; readAt: number } | null = null;
let routeGuardRead: Promise<RouteGuardState> | null = null;
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
/** When this worker's script started: an alarm due before it is what started the worker. */
const workerStartedAt = Date.now();
/**
 * True while this worker has only served the history purge alarm which started it.
 * Technical history is retained ten minutes and purged by that alarm. Whatever the
 * start-up of such a worker recorded would need a purge of its own ten minutes later,
 * which would start the next worker, and so on for as long as the browser stays open.
 * This start-up therefore records nothing; history is kept again from the first event
 * which is not the purge itself.
 */
let purgeOnlyWorker = false;
let workerActivity = false;
const diagnosticObserver: { current: DiagnosticService | null } = { current: null };
let signalDiagnosticReady: () => void = () => undefined;
const diagnosticReady = new Promise<void>((resolve) => {
  signalDiagnosticReady = resolve;
});
let webAuthService: ExtensionWebAuthService | null = null;
const apiClient = new ApiClient();
const accountSessions = new AccountSessions({
  api: apiClient,
  storage: new ExtensionAccountSessionStorage(),
  now: () => Date.now(),
});
const controller = new AppController({
  webAuth: {
    authorize(signal, locale) {
      webAuthService ??= new ExtensionWebAuthService({ startUrl: SITE_URLS.extensionConnect });
      return webAuthService.authorize(signal, locale);
    },
  },
  api: new RenewingApi(apiClient, accountSessions),
  storage: new ExtensionStorageService({
    // A renewable session is known before the account it belongs to is restored.
    ready: () => accountSessions.initialize(),
    // No token of an account which storage no longer holds stays stored.
    stored: (auth) => {
      accountSessions.follow(auth?.accessToken ?? null);
    },
  }),
  accountSessionExpiry: (auth) => accountSessions.expiryOf(auth.accessToken),
  identity: new IndexedDbDeviceIdentityService(),
  proxy,
  alarms: new ExtensionAlarmService(),
  safety,
  securityStorage: new ExtensionSecurityStorage(),
  siteExclusionStorage: new ExtensionSiteExclusionStorage(),
  cleanupStorage: new ExtensionProxyCleanupStorage(),
  accountCache: new ExtensionAccountCacheStorage(preferenceOwnerDigest),
  now: Date.now,
  onStateChanged: publishSnapshot,
  // A connection made after a restoration is a real attempt: its outcome is recorded
  // as its own event, whatever started the worker.
  onStartupConnection: (ended) => runBackgroundEvent("startup_connection", () => ended),
  onConnectionEvent: recordConnectionEvent,
  captureConnectionEvents: () => {
    const record = connectionJournal.capture();
    return (event) => {
      if (!purgeOnlyWorker) record(event);
    };
  },
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
const VPN_ADDRESSES_KEY = "fuzevpnVpnAddresses";
const vpnAddresses = new VpnAddressBook({
  storage: {
    async read() {
      const stored = await extensionApi.storage.local.get(VPN_ADDRESSES_KEY);
      const addresses: unknown = stored[VPN_ADDRESSES_KEY];
      return addresses;
    },
    async write(value) {
      await extensionApi.storage.local.set({ [VPN_ADDRESSES_KEY]: value });
    },
  },
});
const network = new NetworkObserver({
  getSnapshot: () => controller.getSnapshot(),
  verifyRoute: verifyObservationRoute,
  useFallback: true,
  recall: (locationId) => vpnAddresses.recall(locationId),
  onChanged: () => {
    locations.recordObservation(network.getState());
    vpnAddresses.record(network.getState());
    queuePublication();
  },
});
// Read once per worker, before any popup asks: a connection handled first still finds
// the address of its location.
void vpnAddresses.initialize().then(() => network.remind());
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
const PREFERENCE_OWNER_KEY = "fuzevpnPreferenceOwner";
/** The saved site exclusions, once nothing can change them but a new choice. */
function settledSiteExclusions() {
  const { saved, pending } = controller.getSnapshot().siteExclusions;
  // Unread, or changed without the change being applied yet: cancelled, it gives way
  // to what was applied before it.
  if (pending) throw new Error("site_exclusions_unsettled");
  return saved;
}
/** Tells whether the exclusions are what they were, whatever happened in between. */
function siteExclusionsMark(saved: ReturnType<typeof settledSiteExclusions>): Promise<string> {
  return preferenceMark(
    JSON.stringify([
      saved.enabled,
      saved.entries.map(({ domain, includeSubdomains }) => [domain, includeSubdomains]),
    ]),
  );
}
const preferenceOwner = new PreferenceOwner({
  storage: {
    async read() {
      const stored = await extensionApi.storage.local.get(PREFERENCE_OWNER_KEY);
      const owner: unknown = stored[PREFERENCE_OWNER_KEY];
      return owner;
    },
    async write(record) {
      await extensionApi.storage.local.set({ [PREFERENCE_OWNER_KEY]: record });
    },
  },
  digest: preferenceOwnerDigest,
  resetLocations: (token) => locations.reset(token),
  exclusionsMark: async () => siteExclusionsMark(settledSiteExclusions()),
  async resetExclusions(mark) {
    const saved = settledSiteExclusions();
    // Another content was saved by the account now signed in: it is not the previous
    // one's. The revision does not tell, which a failed attempt of this reset moves too.
    if ((await siteExclusionsMark(saved)) !== mark) return;
    if (!saved.enabled && saved.entries.length === 0) return;
    // A change made meanwhile is refused by its revision, and the reset tried again.
    await controller.updateSiteExclusions(saved.revision, false, []);
  },
});

const diagnosticController: Partial<
  Pick<AppController, "getDiagnosticAccount" | "getDiagnosticReadState" | "verifyDiagnosticProxy">
> = controller;
const diagnostics = new DiagnosticService({
  whenReady: () => diagnosticReady,
  connectionHistory: {
    initialize: () => connectionJournal.initialize(),
    clear: () => connectionJournal.clear(),
    establish: () => connectionJournal.establish(),
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
  fetch: accountSessions.fetcher(globalThis.fetch.bind(globalThis)),
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
// A rotation which a previous worker left unanswered is sent again, unchanged.
accountSessions.resume();

/** The popup is in the foreground: the access token its account needs next is renewed. */
function renewAccountSession(): void {
  const account = diagnosticController.getDiagnosticAccount?.();
  if (account) accountSessions.touch(account.token);
}

const actionIconCache = new Map<string, ImageData>();

new ProxyAuthHandler({
  getSession: () => controller.getActiveSession(),
  isConfiguredProxyChallenge: (challenger) => proxy.isConfiguredProxyChallenge(challenger),
  wasUsedProxyChallenge: (challenger) => proxy.wasUsedProxyChallenge(challenger),
  isSessionCurrent: (session) => controller.isSessionCurrentForProxyAuth(session),
  onAuthenticationFailure: async (session) => {
    noteWorkerActivity();
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
  noteWorkerActivity();
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
    // Due before this worker existed: the purge started it, and nothing else has.
    if (alarm.scheduledTime <= workerStartedAt && !workerActivity && !purgeOnlyWorker) {
      purgeOnlyWorker = true;
      // What this start-up has already recorded is dropped with the rest.
      connectionJournal.clear();
    }
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
    if (diagnosticObserver.current) diagnosticObserver.current.establishAccount();
    else connectionJournal.establish();
    connectionHistoryOwnerEstablished = true;
    lastConnectionState = "";
  }
  return true;
}

async function readConnectionJournal() {
  try {
    await diagnosticReady;
    await controller.ready();
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

/** Anything but the purge alarm and the start-up it caused: history is kept again. */
function noteWorkerActivity(): void {
  workerActivity = true;
  if (!purgeOnlyWorker) return;
  purgeOnlyWorker = false;
  // The journal starts from the state this activity found.
  lastConnectionState = "";
  if (connectionHistoryOwnerEstablished) recordConnectionState(controller.getSnapshot());
}

/**
 * A worker starts at the first request after each pause, and for the purge of its own
 * history. What it finds is most often what the previous worker left: recorded again
 * each time, it would fill the history, and the record of a worker which only purges
 * would need a purge of its own, for as long as the browser stays open. A start-up is
 * therefore recorded when what it leaves is not what the previous one left, for the
 * account it restored: a failure which is new is never lost, whatever started the
 * worker, and one which lasts is recorded once.
 */
function recordStartup(result: CommandResult, elapsed: number): void {
  let outcome: string;
  try {
    const snapshot = controller.getSnapshot();
    outcome = JSON.stringify([
      result.commandError ?? snapshot.error,
      snapshot.status,
      snapshot.protected,
      snapshot.trafficBlocked,
      snapshot.protectionRequested,
    ]);
  } catch {
    outcome = JSON.stringify([result.commandError ?? "unknown_error"]);
  }
  void diagnostics
    .startupNews(outcome)
    .then((news) => {
      if (!news) return;
      // History is kept from here on, starting from the state this start-up left.
      noteWorkerActivity();
      // Recorded for the account which the start-up has just established.
      diagnostics.record("initialize", result, elapsed);
    })
    .catch(() => undefined);
}

function runBackgroundEvent(event: string, operation: () => Promise<unknown>): void {
  const startup = event === "initialize";
  if (!startup && event !== "state_publication") noteWorkerActivity();
  const started = Date.now();
  const capturedDiagnostic = diagnostics.capture(event);
  const recordDiagnostic: typeof capturedDiagnostic = (result, elapsed) => {
    if (startup) recordStartup(result, elapsed ?? 0);
    else capturedDiagnostic(result, elapsed);
  };
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
        controller.ready(),
        initializeLanguageForPublication(),
        locations.initialize(),
        vpnAddresses.initialize(),
      ]);
      // A route restored before the memory was read gets its address in this reply.
      network.remind();
      renewAccountSession();
      break;
    case "refresh_network":
      await Promise.all([controller.ready(), vpnAddresses.initialize()]);
      network.observe(controller.getSnapshot());
      network.remind();
      // Publish the IP later without holding the command response open.
      void network.refresh().catch(() => undefined);
      break;
    case "set_language_preference":
      await language.setPreference(message.preference);
      publishSnapshot(controller.getSnapshot());
      break;
    case "cancel_web_login":
      return controller.cancelWebLogin();
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
    case "refresh_ad_blocking":
      return controller.refreshAdBlocking();
    case "set_ad_blocking":
      return controller.setAdBlocking(message.enabled);
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
  // A restoration leaves the connection it found due to be made after it, and that
  // connection reads the catalogue. An action on a location needs the catalogue: while
  // none is known, it waits for the one being read.
  if (controller.getSnapshot().locations.length === 0) await controller.startupConnectionSettled();
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
  if (purgeOnlyWorker) return;
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

/** Records a published state once, however many publications repeat it. */
function recordConnectionState(snapshot: AppSnapshot): void {
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
  if (stateKey === lastConnectionState) return;
  lastConnectionState = stateKey;
  recordConnectionEvent(connectionState);
}

function publishSnapshot(snapshot: AppSnapshot): void {
  // First, and whatever follows fails: a route decision must not outlive this state.
  noteRouting(snapshot);
  try {
    establishConnectionHistoryOwner();
  } catch {
    /* A failing history observer cannot interrupt state publication. */
  }
  // Preferences kept in the profile follow the account: another one starts from defaults.
  if (snapshot.profile) void preferenceOwner.adopt(snapshot.profile.userId).catch(() => undefined);
  recordConnectionState(snapshot);
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
  await controller.ready();
  // A request which arrives while the connection of a start-up is being made is held
  // for it, within the deadline of the guard, and then leaves through the VPN: the tabs
  // which a browser restores are not failed for arriving a moment too early.
  await controller.startupConnectionSettled();
  const memo = routeGuardMemo;
  if (memo?.state.isCurrent() && performance.now() - memo.readAt < ROUTE_GUARD_MEMO_MS)
    return memo.state;
  // Requests which arrive together share one read. One begun before a change answers a
  // state which is no longer current: its callers read again.
  routeGuardRead ??= computeRouteGuardState()
    .then((state) => {
      routeGuardMemo = { state, readAt: performance.now() };
      return state;
    })
    .finally(() => {
      routeGuardRead = null;
    });
  return routeGuardRead;
}

async function computeRouteGuardState(): Promise<RouteGuardState> {
  // The state this read starts from, should no publication have reported it yet.
  noteRouting(controller.getSnapshot());
  const revision = routingRevision;
  const session = await controller.getActiveSession();
  const owned = (await proxy.getControlLevel()) === "controlled_by_this_extension";
  const configured = !!session && owned && (await proxy.isActiveConfiguration(session));
  const snapshot = controller.getSnapshot();
  const exclusions = safety.getRouteExclusions();
  const exclusionGuard = safety.hasExclusionGuard();
  const policy = JSON.stringify(exclusions);
  // The published state moves the revision when its routing changes: see publishSnapshot.
  const isCurrent = () =>
    revision === routingRevision &&
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

/** Moves the revision when what a state means for routing differs from the last one. */
function noteRouting(snapshot: AppSnapshot): void {
  const key = routingSnapshotKey(snapshot);
  if (key === routingKey) return;
  routingKey = key;
  routingRevision++;
}

/** Account/catalog/UI publications must not invalidate an otherwise unchanged decision. */
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

/**
 * What this worker last gave the toolbar button, which the browser keeps. Most
 * publications change neither its icon nor its title: the button is given only what
 * changes. An update which the browser refused is not remembered, and is made again.
 */
const shownAction: { icon?: string; title?: string; badgeCleared?: true } = {};

async function updateAction(snapshot: AppSnapshot): Promise<void> {
  const visual = statusVisual(snapshot.status);
  const title = language.message(visual.titleKey);
  const updates: Promise<unknown>[] = [];
  if (shownAction.icon !== visual.icon)
    updates.push(
      updateActionIcon(visual.icon).then(() => {
        shownAction.icon = visual.icon;
      }),
    );
  // The compact state indicator is part of the local icon. Clear Chrome's
  // own badge because its fixed size obscures most of a 16 px brand mark.
  if (!shownAction.badgeCleared)
    updates.push(
      extensionApi.action.setBadgeText({ text: "" }).then(() => {
        shownAction.badgeCleared = true;
      }),
    );
  if (shownAction.title !== title)
    updates.push(
      extensionApi.action.setTitle({ title }).then(() => {
        shownAction.title = title;
      }),
    );
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
