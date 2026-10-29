// SPDX-License-Identifier: MPL-2.0

import { extensionApi } from "@platform/bridge";
import { browserDeviceName, detectBrowserEnvironment } from "../../core/shared/browser-environment";
import {
  LANGUAGE_NAMES,
  resolveLanguage,
  isLanguagePreference,
  languageDirection,
  type Language,
} from "../../core/shared/language";
import { Translator } from "../../core/shared/translator";
import { configureLegalLinks } from "../../core/shared/legal-links";
import type { Device, Location } from "../../core/api/types";
import { SITE_URLS } from "../../core/shared/config";
import type {
  ExtensionRequest,
  ExtensionResponse,
  StateChangedMessage,
} from "../../core/shared/messages";
import {
  EMPTY_SNAPSHOT,
  type AppErrorCode,
  type AppSnapshot,
  type MachineState,
} from "../../core/shared/state";
import { countryLabel } from "./country-label";
import { buildLocationGroups, chooseGroupLocation } from "./location-groups";
import { deviceDisplayName, deviceKindMessageKey } from "./device-display";
import { deviceAccessibleName, deviceDisplayNames } from "./device-accessible-name";
import { displayedLocation, missingLocationMessage } from "./location-state";
import { matchesLocationSearch, normalizeLocationSearch } from "./location-search";
import { countryFlagPath } from "../../core/shared/country-flags";
import { NETWORK_OBSERVATION_POLL_MS, networkRouteKey } from "../../core/shared/network";
import { normalizeSiteExclusion, type SiteExclusion } from "../../core/shared/site-exclusions";
import { PopupSnapshotOrder, popupSnapshot, type PopupSnapshot } from "./snapshot";
import { exclusionRetry, type ExclusionIntent } from "./exclusion-retry";
import { DiagnosticConnection, diagnosticErrorKey } from "../diagnostics-page/client";
import { requestDiagnosticsConsent } from "../../core/shared/data-consent";

interface PopupResponse extends ExtensionResponse {
  snapshot: PopupSnapshot;
  stale?: boolean;
  transportFailed?: boolean;
}

// An in-flight request marker holds an opaque token: only the request that stored it may
// release it, and render() releases every marker when the account or worker changes.
type PendingRequest = false | object;

const elements = {
  languageSelect: element<HTMLSelectElement>("languageSelect"),
  languageError: element<HTMLElement>("languageError"),
  loginView: element<HTMLElement>("loginView"),
  mainView: element<HTMLElement>("mainView"),
  loginForm: element<HTMLFormElement>("loginForm"),
  loginButton: element<HTMLButtonElement>("loginButton"),
  webLoginButtonLabel: element<HTMLElement>("webLoginButtonLabel"),
  webLoginHelp: element<HTMLElement>("webLoginHelp"),
  webLoginStatus: element<HTMLElement>("webLoginStatus"),
  settingsButton: element<HTMLButtonElement>("settingsButton"),
  settingsPanel: element<HTMLDialogElement>("settingsPanel"),
  closeSettingsButton: element<HTMLButtonElement>("closeSettingsButton"),
  diagnosticsLink: element<HTMLAnchorElement>("diagnosticsLink"),
  diagnosticsAuto: element<HTMLInputElement>("diagnosticsAuto"),
  diagnosticsError: element<HTMLElement>("diagnosticsError"),
  diagnosticsAccountRequired: element<HTMLElement>("diagnosticsAccountRequired"),
  accountEmail: element<HTMLElement>("accountEmail"),
  protectButton: element<HTMLButtonElement>("protectButton"),
  changeLocationButton: element<HTMLButtonElement>("changeLocationButton"),
  statusCard: element<HTMLElement>("statusCard"),
  statusOrb: element<HTMLElement>("statusOrb"),
  statusLabel: element<HTMLElement>("statusLabel"),
  locationCard: element<HTMLElement>("locationCard"),
  locationName: element<HTMLElement>("locationName"),
  publicIp: element<HTMLElement>("publicIp"),
  subscriptionStatus: element<HTMLElement>("subscriptionStatus"),
  subscriptionExpiry: element<HTMLElement>("subscriptionExpiry"),
  refreshSubscriptionButton: element<HTMLButtonElement>("refreshSubscriptionButton"),
  errorBanner: element<HTMLElement>("errorBanner"),
  errorMessage: element<HTMLElement>("errorMessage"),
  retryUncertainConnectionButton: element<HTMLButtonElement>("retryUncertainConnectionButton"),
  loginErrorBanner: element<HTMLElement>("loginErrorBanner"),
  loginErrorMessage: element<HTMLElement>("loginErrorMessage"),
  logoutResult: element<HTMLElement>("logoutResult"),
  logoutApiStatus: element<HTMLElement>("logoutApiStatus"),
  logoutProxyStatus: element<HTMLElement>("logoutProxyStatus"),
  logoutUnconfirmedHelp: element<HTMLElement>("logoutUnconfirmedHelp"),
  resendButton: element<HTMLButtonElement>("resendButton"),
  verificationPanel: element<HTMLElement>("verificationPanel"),
  verificationStatus: element<HTMLElement>("verificationStatus"),
  errorManageDevicesButton: element<HTMLButtonElement>("errorManageDevicesButton"),
  logoutButton: element<HTMLButtonElement>("logoutButton"),
  locationDialog: element<HTMLDialogElement>("locationDialog"),
  locationList: element<HTMLElement>("locationList"),
  locationSearch: element<HTMLInputElement>("locationSearch"),
  allLocationsFilter: element<HTMLButtonElement>("allLocationsFilter"),
  favoriteLocationsFilter: element<HTMLButtonElement>("favoriteLocationsFilter"),
  recentLocationsFilter: element<HTMLButtonElement>("recentLocationsFilter"),
  automaticLocationButton: element<HTMLButtonElement>("automaticLocationButton"),
  locationEmpty: element<HTMLElement>("locationEmpty"),
  locationHierarchyHelp: element<HTMLElement>("locationHierarchyHelp"),
  locationLoadStatus: element<HTMLElement>("locationLoadStatus"),
  refreshLocationsButton: element<HTMLButtonElement>("refreshLocationsButton"),
  locationPreferenceError: element<HTMLElement>("locationPreferenceError"),
  closeLocationButton: element<HTMLButtonElement>("closeLocationButton"),
  dashboardLink: element<HTMLAnchorElement>("dashboardLink"),
  manageDevicesButton: element<HTMLButtonElement>("manageDevicesButton"),
  devicesDialog: element<HTMLDialogElement>("devicesDialog"),
  closeDevicesButton: element<HTMLButtonElement>("closeDevicesButton"),
  refreshDevicesButton: element<HTMLButtonElement>("refreshDevicesButton"),
  deviceCount: element<HTMLElement>("deviceCount"),
  deviceList: element<HTMLElement>("deviceList"),
  devicesError: element<HTMLElement>("devicesError"),
  confirmationDialog: element<HTMLDialogElement>("confirmationDialog"),
  confirmationTitle: element<HTMLElement>("confirmationTitle"),
  confirmationMessage: element<HTMLElement>("confirmationMessage"),
  confirmationCancelButton: element<HTMLButtonElement>("confirmationCancelButton"),
  confirmationAcceptButton: element<HTMLButtonElement>("confirmationAcceptButton"),
  recoveryPanel: element<HTMLElement>("recoveryPanel"),
  recoveryStatus: element<HTMLElement>("recoveryStatus"),
  retryButton: element<HTMLButtonElement>("retryButton"),
  recoveryDisconnectButton: element<HTMLButtonElement>("recoveryDisconnectButton"),
  killSwitchEnabled: element<HTMLInputElement>("killSwitchEnabled"),
  webRtcProtectionEnabled: element<HTMLInputElement>("webRtcProtectionEnabled"),
  securityState: element<HTMLElement>("securityState"),
  settingsError: element<HTMLElement>("settingsError"),
  manageExclusionsButton: element<HTMLButtonElement>("manageExclusionsButton"),
  exclusionsSummary: element<HTMLElement>("exclusionsSummary"),
  exclusionsRecoveryNotice: element<HTMLElement>("exclusionsRecoveryNotice"),
  exclusionsDialog: element<HTMLDialogElement>("exclusionsDialog"),
  exclusionsDialogRecoveryNotice: element<HTMLElement>("exclusionsDialogRecoveryNotice"),
  closeExclusionsButton: element<HTMLButtonElement>("closeExclusionsButton"),
  exclusionsEnabled: element<HTMLInputElement>("exclusionsEnabled"),
  exclusionsState: element<HTMLElement>("exclusionsState"),
  exclusionsError: element<HTMLElement>("exclusionsError"),
  exclusionsErrorMessage: element<HTMLElement>("exclusionsErrorMessage"),
  retryExclusionsButton: element<HTMLButtonElement>("retryExclusionsButton"),
  exclusionForm: element<HTMLFormElement>("exclusionForm"),
  exclusionInput: element<HTMLInputElement>("exclusionInput"),
  exclusionSubdomains: element<HTMLInputElement>("exclusionSubdomains"),
  exclusionPreview: element<HTMLElement>("exclusionPreview"),
  exclusionInputError: element<HTMLElement>("exclusionInputError"),
  addExclusionButton: element<HTMLButtonElement>("addExclusionButton"),
  exclusionsCount: element<HTMLElement>("exclusionsCount"),
  exclusionsEmpty: element<HTMLElement>("exclusionsEmpty"),
  exclusionsList: element<HTMLElement>("exclusionsList"),
};

let snapshot: PopupSnapshot | null = null;
const snapshotOrder = new PopupSnapshotOrder();
let communicationFailed = false;
let diagnosticsPending = false;
const diagnostics = new DiagnosticConnection(renderDiagnostics);
let loginPending = false;
let accountRefreshPending: PendingRequest = false;
let verificationPending = false;
let verificationRequest = 0;
let verificationSent = false;
let verificationAvailable = false;
let verificationCooldownUntil = 0;
let verificationObservedCooldown: number | null = null;
let verificationFailure: { code: AppErrorCode; retryAfter: number | null } | null = null;
let verificationTimer: ReturnType<typeof setTimeout> | undefined;
let devicesRefreshPending: PendingRequest = false;
let accountEpoch = 0;
let devicesAction = 0;
let devicesFailure: { transport: boolean; code: AppErrorCode; retryAfter: number | null } | null =
  null;
const deviceDeletions = new Set<string>();
let returnToSettingsAfterDevices = false;
let securityPreferencesPending: PendingRequest = false;
let connectionRetryPending: PendingRequest = false;
let observedNetworkRoute: string | null = null;
let locationFilter: "all" | "favorites" | "recent" = "all";
let locationPreferenceFailure: AppErrorCode | "save" | "transport" | null = null;
let locationsRefreshPending: PendingRequest = false;
let locationsRefreshFailed = false;
let automaticSelectionPending: PendingRequest = false;
let locationSelectionPending = false;
const expandedLocationCountries = new Set<string>();
const expandedLocationCities = new Set<string>();
let locationSelectionRequest = 0;
let returnToSettingsAfterExclusions = false;
let exclusionRequestPending = false;
let exclusionRequestFailed = false;
let exclusionConflict = false;
let failedExclusionIntent: ExclusionIntent | null = null;
let submittedExclusionDraft: { value: string; includeSubdomains: boolean } | null = null;
const favoriteChanges = new Set<string>();
let locale: Language = resolveLanguage("auto", extensionApi.i18n.getUILanguage());
const translator = new Translator();
let currentBrowserName = "Browser";
let translate: (key: string, substitutions?: string[]) => string = (key, substitutions) =>
  extensionApi.i18n.getMessage(key, substitutions) || key;
let renderSequence = 0;
let confirmedSnapshotSequence = 0;
let connectionRequestIntent = 0;
let languageRequest = 0;
let languagePending = false;
let languageFailed = false;
let languageCatalogFailed = false;
let loadedLocale: Language | null = null;
let renderedLocations = "";
let renderedDevices = "";
let renderedExclusions = "";
let countryNames = new Intl.DisplayNames([locale], { type: "region" });
let dateFormat = new Intl.DateTimeFormat(locale, { dateStyle: "medium" });

for (const [value, label] of Object.entries(LANGUAGE_NAMES)) {
  elements.languageSelect.add(new Option(label, value));
}
localizeDocument();
configureLinks();
bindEvents();
void initializePopup().catch(() => undefined);
void diagnostics.request({ type: "diagnostics_state" });
void detectBrowserEnvironment()
  .then((environment) => {
    currentBrowserName = browserDeviceName(environment);
    renderedDevices = "";
    if (snapshot?.profile) renderDevices(snapshot);
  })
  .catch(() => undefined);

// A short-lived popup requests observations; no background polling of browsing activity.
setInterval(() => {
  if (snapshot?.profile && document.visibilityState === "visible") refreshNetwork();
}, NETWORK_OBSERVATION_POLL_MS);
window.addEventListener("online", () => refreshNetwork());

extensionApi.runtime.onMessage.addListener((message: unknown) => {
  diagnostics.receive(message);
  const stateMessage = message as Partial<StateChangedMessage>;
  if (stateMessage.type === "state_changed") render(stateMessage.snapshot, true);
});

function bindEvents(): void {
  elements.diagnosticsAuto.addEventListener("change", () => {
    if (diagnosticsPending || !diagnostics.available || !diagnostics.state?.signedIn) return;
    const enabled = elements.diagnosticsAuto.checked;
    const epoch = accountEpoch;
    diagnosticsPending = true;
    diagnostics.error = null;
    renderDiagnostics();
    void (async () => {
      const command = { type: "diagnostics_set_auto", enabled } as const;
      if (enabled) {
        await diagnostics.requestWithDataConsent(
          command,
          requestDiagnosticsConsent,
          () => epoch === accountEpoch,
        );
      } else {
        await diagnostics.request(command);
      }
    })().finally(() => {
      diagnosticsPending = false;
      renderDiagnostics();
    });
  });
  elements.languageSelect.addEventListener("change", () => void changeLanguage());
  elements.loginForm.addEventListener("submit", (event) => {
    event.preventDefault();
    void signInOnWeb();
  });
  elements.protectButton.addEventListener("click", () => {
    if (!snapshot) return;
    if (canDisconnect(snapshot)) {
      void request({ type: "disconnect" });
      return;
    }
    const target = displayedLocation(snapshot);
    if (target) void request({ type: "connect", locationId: target.id });
  });
  elements.changeLocationButton.addEventListener("click", () => {
    elements.locationDialog.showModal();
    elements.locationSearch.focus();
    void refreshLocations();
  });
  elements.refreshLocationsButton.addEventListener("click", () => void refreshLocations());
  elements.locationSearch.addEventListener("input", () => {
    if (snapshot) renderLocations(snapshot);
  });
  for (const [filter, button] of locationFilters()) {
    button.addEventListener("click", () => {
      locationFilter = filter;
      if (snapshot) renderLocations(snapshot);
    });
  }
  elements.automaticLocationButton.addEventListener("click", () => {
    if (!snapshot?.profile || isBusy(snapshot.status) || automaticSelectionPending) return;
    const epoch = accountEpoch;
    const pending = {};
    automaticSelectionPending = pending;
    locationSelectionPending = false;
    const selection = ++locationSelectionRequest;
    locationPreferenceFailure = null;
    renderLocations(snapshot);
    void request({ type: "select_automatic_location" })
      .then((response) => {
        if (epoch !== accountEpoch || selection !== locationSelectionRequest || response.superseded)
          return;
        locationPreferenceFailure = locationCommandFailure(response);
        if (response.ok) elements.locationDialog.close();
        render(response.snapshot);
      })
      .catch(() => {
        if (epoch !== accountEpoch || selection !== locationSelectionRequest) return;
        locationPreferenceFailure = "transport";
      })
      .finally(() => {
        // A newer account or worker may already own a selection of its own.
        if (automaticSelectionPending !== pending) return;
        automaticSelectionPending = false;
        if (snapshot) renderLocations(snapshot);
      });
  });
  elements.closeLocationButton.addEventListener("click", () => elements.locationDialog.close());
  elements.settingsButton.addEventListener("click", () => elements.settingsPanel.showModal());
  elements.retryButton.addEventListener("click", () => {
    if (snapshot?.profile === null && snapshot.error !== "storage_unavailable") {
      elements.loginButton.focus();
      elements.loginButton.scrollIntoView({ block: "center" });
      return;
    }
    void retryConnection();
  });
  elements.retryUncertainConnectionButton.addEventListener("click", () => {
    if (snapshot?.error === "proxy_creation_uncertain") void retryConnection();
  });
  elements.recoveryDisconnectButton.addEventListener("click", () => {
    void request({ type: "disconnect" });
  });
  elements.killSwitchEnabled.addEventListener("change", () => void updateSecurityPreferences());
  elements.webRtcProtectionEnabled.addEventListener(
    "change",
    () => void updateSecurityPreferences(),
  );
  elements.closeSettingsButton.addEventListener("click", () => elements.settingsPanel.close());
  elements.manageExclusionsButton.addEventListener("click", () => {
    if (!snapshot?.siteExclusionsAvailable) return;
    elements.settingsPanel.close();
    returnToSettingsAfterExclusions = true;
    elements.exclusionsDialog.showModal();
    elements.exclusionInput.focus();
  });
  elements.closeExclusionsButton.addEventListener("click", () => elements.exclusionsDialog.close());
  elements.exclusionsDialog.addEventListener("close", () => {
    const returnToSettings = returnToSettingsAfterExclusions;
    returnToSettingsAfterExclusions = false;
    if (returnToSettings && !elements.settingsPanel.open) {
      elements.settingsPanel.showModal();
      elements.manageExclusionsButton.focus();
    }
  });
  elements.exclusionInput.addEventListener("input", renderExclusionPreview);
  elements.exclusionSubdomains.addEventListener("change", renderExclusionPreview);
  elements.exclusionsEnabled.addEventListener("change", () => {
    if (!snapshot) return;
    void updateSiteExclusions(
      elements.exclusionsEnabled.checked,
      snapshot.siteExclusions.saved.entries,
    );
  });
  elements.exclusionForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const entry = exclusionCandidate();
    if (!snapshot || !entry || elements.addExclusionButton.disabled) return;
    const saved = snapshot.siteExclusions.saved;
    void updateSiteExclusions(
      saved.entries.length === 0 || saved.enabled,
      [...saved.entries, entry],
      {
        value: elements.exclusionInput.value,
        includeSubdomains: elements.exclusionSubdomains.checked,
      },
    );
  });
  elements.retryExclusionsButton.addEventListener("click", () => {
    void sendExclusionsUpdate({ type: "retry_site_exclusions" }, true);
  });
  elements.logoutButton.addEventListener(
    "click",
    () =>
      void request({ type: "logout" }).then((response) => {
        if (response.stale) return;
        elements.settingsPanel.close();
        render(response.snapshot);
      }),
  );
  elements.resendButton.addEventListener("click", () => void resendVerification());
  elements.refreshSubscriptionButton.addEventListener("click", () => {
    void refreshAccount();
  });
  elements.manageDevicesButton.addEventListener("click", openDevices);
  elements.errorManageDevicesButton.addEventListener("click", openDevices);
  elements.closeDevicesButton.addEventListener("click", () => elements.devicesDialog.close());
  elements.devicesDialog.addEventListener("close", () => {
    const returnToSettings = returnToSettingsAfterDevices;
    returnToSettingsAfterDevices = false;
    if (returnToSettings && snapshot?.profile && !elements.settingsPanel.open) {
      elements.settingsPanel.showModal();
      elements.manageDevicesButton.focus();
    } else if (snapshot?.profile) {
      (elements.errorManageDevicesButton.classList.contains("hidden")
        ? elements.settingsButton
        : elements.errorManageDevicesButton
      ).focus();
    }
  });
  elements.refreshDevicesButton.addEventListener("click", () => void refreshDevices());
}

function openDevices(): void {
  if (!snapshot?.profile || communicationFailed) return;
  returnToSettingsAfterDevices = elements.settingsPanel.open;
  elements.settingsPanel.close();
  elements.devicesDialog.showModal();
  void refreshDevices();
}

// Browser-level confirm() can suspend an extension popup. Keep confirmation in
// the document so messages, cancellation and account changes remain responsive.
function confirmAction(title: string, description: string): Promise<boolean> {
  const dialog = elements.confirmationDialog;
  if (dialog.open) return Promise.resolve(false);
  elements.confirmationTitle.textContent = title;
  elements.confirmationMessage.textContent = description;
  elements.confirmationAcceptButton.textContent = title;
  dialog.returnValue = "cancel";
  dialog.showModal();
  elements.confirmationCancelButton.focus();
  return new Promise((resolve) => {
    dialog.addEventListener("close", () => resolve(dialog.returnValue === "confirm"), {
      once: true,
    });
  });
}

async function retryConnection(): Promise<void> {
  if (!snapshot || connectionRetryPending) return;
  const reloadStorage = snapshot.error === "storage_unavailable";
  if (!reloadStorage && (!snapshot.profile || isBusy(snapshot.status))) return;
  const pending = {};
  connectionRetryPending = pending;
  renderError(snapshot);
  renderSecurity(snapshot);
  try {
    await request({ type: reloadStorage ? "get_snapshot" : "retry_connection" });
  } finally {
    // A newer account or worker may already own a retry of its own.
    if (connectionRetryPending === pending) {
      connectionRetryPending = false;
      renderError(snapshot);
      renderSecurity(snapshot);
    }
  }
}

async function resendVerification(): Promise<void> {
  if (!snapshot?.profile || verificationPending || Date.now() < verificationCooldownUntil) return;
  const epoch = accountEpoch;
  const requestId = ++verificationRequest;
  verificationPending = true;
  verificationSent = false;
  verificationFailure = null;
  verificationAvailable = true;
  renderVerification(snapshot);
  try {
    const response = await request({ type: "resend_verification" });
    if (epoch !== accountEpoch || requestId !== verificationRequest || response.superseded) return;
    verificationSent = response.ok;
    if (!response.ok && !response.transportFailed) {
      verificationFailure = {
        code: response.commandError ?? "unknown_error",
        retryAfter: response.commandRetryAfterSeconds ?? null,
      };
    }
    if (response.commandError === "verification_email_cooldown") {
      verificationCooldownUntil =
        Date.now() + Math.max(0, response.commandRetryAfterSeconds ?? 0) * 1000;
    }
  } finally {
    if (epoch === accountEpoch && requestId === verificationRequest) {
      verificationPending = false;
      renderVerification(snapshot);
    }
  }
}

function renderVerification(next: AppSnapshot): void {
  if (next.status === "connected" && next.protected && next.error === null && verificationAvailable)
    resetVerificationFeedback();
  verificationAvailable ||=
    next.error === "email_verification_required" || next.error === "verification_email_cooldown";
  if (next.error === "verification_email_cooldown") {
    if (next.retryAfterSeconds !== verificationObservedCooldown) {
      verificationObservedCooldown = next.retryAfterSeconds;
      verificationCooldownUntil = Date.now() + Math.max(0, next.retryAfterSeconds ?? 0) * 1000;
    }
  } else {
    verificationObservedCooldown = null;
  }
  const remaining = Math.max(0, Math.ceil((verificationCooldownUntil - Date.now()) / 1000));
  elements.verificationPanel.classList.toggle("hidden", !next.profile || !verificationAvailable);
  elements.verificationStatus.textContent = verificationPending
    ? message("verificationSending")
    : verificationSent
      ? message("verificationSent")
      : remaining > 0
        ? message("errorVerificationCooldown", [String(remaining)])
        : verificationFailure && verificationFailure.code !== "verification_email_cooldown"
          ? errorMessage(verificationFailure.code, verificationFailure.retryAfter)
          : "";
  elements.resendButton.disabled = verificationPending || remaining > 0;
  elements.resendButton.setAttribute("aria-busy", String(verificationPending));
  clearTimeout(verificationTimer);
  verificationTimer = undefined;
  if (remaining > 0) {
    verificationTimer = setTimeout(() => {
      if (snapshot) renderVerification(snapshot);
    }, 1000);
  }
}

function resetVerificationFeedback(): void {
  ++verificationRequest;
  verificationPending = false;
  verificationSent = false;
  verificationAvailable = false;
  verificationCooldownUntil = 0;
  verificationObservedCooldown = null;
  verificationFailure = null;
  clearTimeout(verificationTimer);
}

async function updateSecurityPreferences(): Promise<void> {
  if (!snapshot || securityPreferencesPending) return;
  const update: ExtensionRequest = {
    type: "update_security_preferences",
    killSwitchEnabled: elements.killSwitchEnabled.checked,
    webRtcProtectionEnabled: elements.webRtcProtectionEnabled.checked,
  };
  const pending = {};
  securityPreferencesPending = pending;
  elements.killSwitchEnabled.disabled = true;
  elements.webRtcProtectionEnabled.disabled = true;
  try {
    const response = await request(update);
    if (response.stale) return;
    render(response.snapshot);
  } catch {
    elements.settingsError.textContent = message("error_unknown_error");
    elements.settingsError.classList.remove("hidden");
  } finally {
    // A newer account or worker may already own an update of its own.
    if (securityPreferencesPending === pending) {
      securityPreferencesPending = false;
      renderSecurity(snapshot);
    }
  }
}

async function updateSiteExclusions(
  enabled: boolean,
  entries: SiteExclusion[],
  draft: typeof submittedExclusionDraft = null,
): Promise<boolean> {
  if (
    !snapshot?.siteExclusionsAvailable ||
    exclusionRequestPending ||
    snapshot.siteExclusions.pending
  )
    return false;
  failedExclusionIntent = {
    base: structuredClone(snapshot.siteExclusions.saved),
    target: structuredClone({ enabled, entries }),
  };
  submittedExclusionDraft = draft;
  return sendExclusionsUpdate({
    type: "update_site_exclusions",
    expectedRevision: snapshot.siteExclusions.saved.revision,
    enabled,
    entries,
  });
}

async function sendExclusionsUpdate(
  update: Extract<ExtensionRequest, { type: "update_site_exclusions" | "retry_site_exclusions" }>,
  recheck = false,
): Promise<boolean> {
  if (!snapshot?.siteExclusionsAvailable || exclusionRequestPending) return false;
  exclusionRequestPending = true;
  exclusionRequestFailed = false;
  exclusionConflict = false;
  renderSiteExclusions(snapshot);
  try {
    if (recheck) {
      const current = await request({ type: "get_snapshot" });
      if (!current.ok || current.transportFailed || !current.snapshot.siteExclusionsAvailable) {
        exclusionRequestFailed = true;
        return false;
      }
      const retry = exclusionRetry(failedExclusionIntent, current.snapshot.siteExclusions);
      if (retry.type === "conflict") {
        exclusionConflict = true;
        exclusionRequestFailed = true;
        return false;
      }
      if (retry.type === "complete") {
        completeExclusionIntent();
        return true;
      }
      update = retry;
    }
    const response = await request(update);
    const applied =
      response.ok &&
      !response.superseded &&
      !response.snapshot.siteExclusions.pending &&
      !response.snapshot.siteExclusions.error &&
      (!failedExclusionIntent ||
        exclusionRetry(failedExclusionIntent, response.snapshot.siteExclusions).type ===
          "complete");
    exclusionRequestFailed = !applied;
    if (applied) completeExclusionIntent();
    render(response.snapshot);
    return applied;
  } catch {
    exclusionRequestFailed = true;
    return false;
  } finally {
    exclusionRequestPending = false;
    renderSiteExclusions(snapshot);
  }
}

function completeExclusionIntent(): void {
  if (
    submittedExclusionDraft?.value === elements.exclusionInput.value &&
    elements.exclusionSubdomains.checked === submittedExclusionDraft.includeSubdomains
  ) {
    elements.exclusionInput.value = "";
    elements.exclusionSubdomains.checked = true;
    queueMicrotask(() => {
      if (elements.exclusionsDialog.open && !elements.exclusionInput.disabled)
        elements.exclusionInput.focus();
    });
  }
  failedExclusionIntent = null;
  submittedExclusionDraft = null;
  exclusionRequestFailed = false;
  exclusionConflict = false;
}

function exclusionCandidate(): SiteExclusion | null {
  try {
    return normalizeSiteExclusion(
      elements.exclusionInput.value,
      elements.exclusionSubdomains.checked,
    );
  } catch {
    return null;
  }
}

function renderExclusionPreview(): void {
  const input = elements.exclusionInput.value.trim();
  const entry = input ? exclusionCandidate() : null;
  const saved = snapshot?.siteExclusions.saved;
  const duplicate = Boolean(entry && saved?.entries.some(({ domain }) => domain === entry.domain));
  const limit = (saved?.entries.length ?? 0) >= 100;
  const error = limit
    ? "siteExclusionsLimit"
    : duplicate
      ? "siteExclusionDuplicate"
      : input && !entry
        ? "siteExclusionInvalid"
        : "";
  elements.exclusionPreview.classList.toggle("hidden", entry === null);
  elements.exclusionPreview.replaceChildren();
  if (entry) {
    const marker = "\uFFFC";
    const parts = message("siteExclusionPreview", [marker]).split(marker);
    parts.forEach((part, index) => {
      if (index > 0) elements.exclusionPreview.append(isolatedText(entry.domain, "ltr"));
      elements.exclusionPreview.append(part);
    });
  }
  elements.exclusionInputError.classList.toggle("hidden", !error);
  elements.exclusionInputError.textContent = error ? message(error) : "";
  elements.exclusionInput.setAttribute("aria-invalid", String(Boolean(input && error)));
  elements.addExclusionButton.disabled =
    !snapshot ||
    !entry ||
    Boolean(error) ||
    exclusionRequestPending ||
    snapshot.siteExclusions.pending;
}

function renderSiteExclusions(next: PopupSnapshot): void {
  elements.manageExclusionsButton.disabled = !next.siteExclusionsAvailable;
  const preferencesReset =
    next.siteExclusionsAvailable && next.siteExclusions.recoveryNotice === "preferences_reset";
  elements.exclusionsRecoveryNotice.classList.toggle("hidden", !preferencesReset);
  elements.exclusionsDialogRecoveryNotice.classList.toggle("hidden", !preferencesReset);
  if (!next.siteExclusionsAvailable) {
    elements.exclusionsSummary.textContent = message("siteExclusionsReloadRequired");
    elements.exclusionsDialog.close();
    return;
  }
  const state = next.siteExclusions;
  const saved = state.saved;
  const busy = exclusionRequestPending || state.pending;
  const failed = exclusionRequestFailed || state.error;
  elements.exclusionsEnabled.checked = saved.enabled;
  elements.exclusionsEnabled.disabled = busy || saved.entries.length === 0;
  elements.exclusionsEnabled.setAttribute("aria-busy", String(busy));
  elements.exclusionsError.classList.toggle("hidden", !failed);
  elements.exclusionsErrorMessage.textContent = message(
    exclusionConflict ? "siteExclusionsConflict" : "siteExclusionsSaveError",
  );
  elements.retryExclusionsButton.disabled =
    exclusionRequestPending || (state.pending && !state.error);
  const stateKey = busy
    ? state.error
      ? "siteExclusionsInterrupted"
      : "siteExclusionsPending"
    : saved.enabled && saved.entries.length > 0
      ? "siteExclusionsOn"
      : "siteExclusionsOff";
  elements.exclusionsState.textContent = message(stateKey);
  elements.exclusionsSummary.textContent = message(
    busy ? stateKey : saved.enabled ? "siteExclusionsSummary" : "siteExclusionsOff",
    [String(saved.entries.length)],
  );
  elements.exclusionsCount.textContent = message("siteExclusionsCount", [
    String(saved.entries.length),
  ]);
  elements.exclusionsEmpty.classList.toggle("hidden", saved.entries.length > 0);
  elements.exclusionInput.disabled = busy;
  elements.exclusionSubdomains.disabled = busy;
  const listKey = JSON.stringify([locale, saved.entries, busy]);
  renderExclusionPreview();
  if (listKey === renderedExclusions) return;
  const rows = saved.entries.map((entry) => {
    const row = document.createElement("article");
    row.className = "exclusion-row";
    const info = document.createElement("div");
    const domain = document.createElement("p");
    domain.className = "exclusion-domain";
    domain.dir = "ltr";
    domain.textContent = entry.domain;
    const scope = document.createElement("p");
    scope.className = "exclusion-scope";
    scope.textContent = message(
      entry.includeSubdomains ? "siteExclusionScopeSubdomains" : "siteExclusionScopeExact",
    );
    info.append(domain, scope);
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "exclusion-remove";
    remove.dataset.focusKey = entry.domain;
    remove.textContent = "×";
    const label = message("siteExclusionRemove", [entry.domain]);
    remove.setAttribute("aria-label", label);
    remove.title = label;
    remove.disabled = busy;
    remove.addEventListener("click", () => {
      if (!snapshot) return;
      const current = snapshot.siteExclusions.saved;
      const entries = current.entries.filter(({ domain }) => domain !== entry.domain);
      void updateSiteExclusions(entries.length > 0 && current.enabled, entries);
    });
    row.append(info, remove);
    return row;
  });
  renderedExclusions = listKey;
  replaceListChildren(elements.exclusionsList, rows, elements.closeExclusionsButton);
}

async function refreshDevices(): Promise<void> {
  if (!snapshot?.profile || devicesRefreshPending) return;
  const epoch = accountEpoch;
  const pending = {};
  const action = ++devicesAction;
  devicesRefreshPending = pending;
  devicesFailure = null;
  renderDevices(snapshot);
  try {
    const response = await request({ type: "refresh_devices" });
    if (epoch !== accountEpoch || action !== devicesAction || response.superseded) return;
    devicesFailure = deviceFailure(response);
    render(response.snapshot);
  } finally {
    // A newer account or worker may already own a refresh of its own.
    if (devicesRefreshPending === pending) {
      devicesRefreshPending = false;
      renderDevices(snapshot);
    }
  }
}

function deviceFailure(response: PopupResponse): typeof devicesFailure {
  return response.ok
    ? null
    : {
        transport: response.transportFailed === true,
        code: response.commandError ?? response.snapshot.error ?? "unknown_error",
        retryAfter: response.commandRetryAfterSeconds ?? null,
      };
}

async function initializePopup(): Promise<void> {
  const response = await request({ type: "get_snapshot" });
  if (response.stale) return;
  render(response.snapshot);
  if (
    response.snapshot.profile &&
    !isBusy(response.snapshot.status) &&
    !(response.snapshot.autoConnect && !response.snapshot.protected)
  ) {
    await refreshAccount();
  }
}

async function refreshAccount(): Promise<void> {
  if (accountRefreshPending) return;
  const epoch = accountEpoch;
  const pending = {};
  accountRefreshPending = pending;
  if (snapshot) render(snapshot);
  try {
    const response = await request({ type: "refresh_account" });
    if (epoch !== accountEpoch || accountRefreshPending !== pending || response.stale) return;
    render(response.snapshot);
  } catch {
    // The service worker publishes a localized state when the API request itself fails.
  } finally {
    if (epoch === accountEpoch && accountRefreshPending === pending) {
      accountRefreshPending = false;
      if (snapshot) render(snapshot);
    }
  }
}

async function refreshLocations(): Promise<void> {
  if (!snapshot?.profile || locationsRefreshPending) return;
  const epoch = accountEpoch;
  const pending = {};
  locationsRefreshPending = pending;
  locationsRefreshFailed = false;
  renderLocations(snapshot);
  try {
    const response = await request({ type: "refresh_locations" });
    if (epoch !== accountEpoch || response.stale || response.superseded) return;
    locationsRefreshFailed = !response.ok;
  } catch {
    if (epoch === accountEpoch) locationsRefreshFailed = true;
  } finally {
    // A newer account or worker may already own a refresh of its own. A reply from the
    // replacement worker releases the marker itself, yet its stored result must be shown.
    if (locationsRefreshPending === pending) locationsRefreshPending = false;
    if (epoch === accountEpoch) renderLocations(snapshot);
  }
}

function locationCommandFailure(response: PopupResponse): typeof locationPreferenceFailure {
  if (response.ok) return null;
  if (response.transportFailed) return "transport";
  return response.commandError ?? response.snapshot.error ?? "save";
}

function render(value: unknown, confirmed = false): boolean {
  let next: PopupSnapshot;
  try {
    next = popupSnapshot(value);
  } catch {
    renderCommunicationFailure();
    return false;
  }
  if (!snapshotOrder.accept(next)) return false;
  const accountChanged = (snapshot?.profile?.userId ?? null) !== (next.profile?.userId ?? null);
  if (accountChanged || snapshot?.snapshotVersion?.workerId !== next.snapshotVersion?.workerId) {
    // Every PendingRequest marker is released here: a reply still owed by a previous
    // account or worker cannot block the current one.
    accountRefreshPending = false;
    devicesRefreshPending = false;
    locationsRefreshPending = false;
    connectionRetryPending = false;
    securityPreferencesPending = false;
    automaticSelectionPending = false;
    // verificationRequest still guards the old send's finally against a newer send.
    verificationPending = false;
  }
  if (accountChanged) {
    ++accountEpoch;
    elements.confirmationDialog.close("cancel");
    ++devicesAction;
    ++locationSelectionRequest;
    devicesFailure = null;
    locationPreferenceFailure = null;
    locationsRefreshFailed = false;
    locationSelectionPending = false;
    expandedLocationCountries.clear();
    expandedLocationCities.clear();
    resetVerificationFeedback();
  }
  snapshot = next;
  if (confirmed) {
    ++confirmedSnapshotSequence;
    communicationFailed = false;
    if (next.locationsStatus === "ready") locationsRefreshFailed = false;
  }
  const sequence = ++renderSequence;
  if (loadedLocale === next.effectiveLanguage) {
    try {
      languageCatalogFailed = false;
      renderCurrent(next);
      return true;
    } catch {
      renderCommunicationFailure();
      return false;
    }
  }
  void translator
    .forLanguage(next.effectiveLanguage)
    .then(
      (selected) => {
        if (sequence !== renderSequence) return;
        locale = next.effectiveLanguage;
        loadedLocale = locale;
        translate = selected;
        languageCatalogFailed = false;
        countryNames = new Intl.DisplayNames([locale], { type: "region" });
        dateFormat = new Intl.DateTimeFormat(locale, { dateStyle: "medium" });
        localizeDocument();
        renderCurrent(next);
      },
      () => {
        // Only a catalog failure belongs to the language error path.
        if (sequence !== renderSequence) return;
        languageCatalogFailed = true;
        renderCurrent(next);
      },
    )
    .catch(() => {
      if (sequence === renderSequence) renderCommunicationFailure();
    });
  return true;
}

function renderCommunicationFailure(): void {
  communicationFailed = true;
  ++renderSequence;
  const current = snapshot ?? popupSnapshot({ ...EMPTY_SNAPSHOT, siteExclusions: undefined });
  snapshot ??= current;
  // Preserve the authoritative state for subsequent commands. Only the display
  // loses its protection claim when the current state cannot be verified.
  renderError(current);
  renderSecurity({
    ...current,
    protected: false,
    blockingScope: "unverified",
    webRtcProtected: false,
  });
  renderWebLogin(current);
  elements.statusOrb.className = "status-orb unverified";
  elements.statusLabel.textContent = message("securityBlockUnverified");
  elements.publicIp.textContent = message("ipUnavailable");
  elements.logoutResult.classList.add("hidden");
}

async function changeLanguage(): Promise<void> {
  const preference = elements.languageSelect.value;
  if (!isLanguagePreference(preference)) return;
  const requestId = ++languageRequest;
  languagePending = true;
  languageFailed = false;
  try {
    const response = await request({ type: "set_language_preference", preference });
    if (requestId !== languageRequest || response.superseded) return;
    languageFailed = !response.ok;
    render(response.snapshot);
  } catch {
    if (requestId !== languageRequest) return;
    languageFailed = true;
  } finally {
    if (requestId === languageRequest) {
      languagePending = false;
      if (snapshot) render(snapshot);
    }
  }
}

function renderCurrent(next: PopupSnapshot): void {
  if (communicationFailed) {
    next = { ...next, protected: false, blockingScope: "unverified", webRtcProtected: false };
  }
  const route = networkRouteKey(next);
  if (!communicationFailed && route !== observedNetworkRoute) {
    observedNetworkRoute = route;
    if (next.profile) refreshNetwork();
  }
  if (!languagePending) elements.languageSelect.value = next.languagePreference;
  const languageError = languageFailed || languageCatalogFailed;
  elements.languageError.textContent = languageError ? message("languageSaveError") : "";
  elements.languageError.classList.toggle("hidden", !languageError);
  const loggedIn = next.profile !== null;
  const lostAccount = !loggedIn && !elements.mainView.classList.contains("hidden");
  elements.loginView.classList.toggle("hidden", loggedIn);
  elements.mainView.classList.toggle("hidden", !loggedIn);
  elements.settingsButton.classList.remove("hidden");
  renderWebLogin(next);
  renderError(next);
  renderLogoutOutcome(next);
  renderSecurity(next);
  renderSiteExclusions(next);
  if (!loggedIn) {
    returnToSettingsAfterDevices = false;
    elements.locationDialog.close();
    elements.devicesDialog.close();
    if (lostAccount) elements.settingsPanel.close();
    elements.locationList.replaceChildren();
    renderedLocations = "";
    elements.locationSearch.value = "";
    locationFilter = "all";
    locationPreferenceFailure = null;
    elements.deviceList.replaceChildren();
    renderedDevices = "";
    elements.deviceCount.textContent = "";
    elements.locationName.textContent = message("noLocation");
    elements.publicIp.textContent = "";
    elements.subscriptionStatus.textContent = "";
    elements.subscriptionExpiry.textContent = "";
    if (lostAccount) {
      elements.loginButton.focus();
    }
    return;
  }

  elements.accountEmail.textContent = next.profile?.email ?? "";
  const exclusionCount = next.siteExclusions.applied.enabled
    ? next.siteExclusions.applied.entries.length
    : 0;
  const status = statusKey(next);
  elements.statusLabel.textContent =
    status === "statusProtected" && exclusionCount > 0
      ? message("statusProtectedExceptions", [String(exclusionCount)])
      : message(status);
  elements.statusOrb.className = `status-orb ${
    communicationFailed ? "unverified" : statusClass(next.status, next.protected)
  }`;
  const selected = displayedLocation(next);
  const selectedLabel = selected ? locationLabel(selected) : message(missingLocationMessage(next));
  const locationText = document.createElement("span");
  locationText.textContent = next.locationPreferences.automatic
    ? message("automaticLocationName", [selectedLabel])
    : selectedLabel;
  elements.locationName.replaceChildren(
    ...(selected ? [countryFlag(selected.countryCode)] : []),
    locationText,
  );
  renderNetwork(next);
  elements.protectButton.textContent = message(
    canDisconnect(next) ? "disconnect" : "protectBrowser",
  );
  elements.protectButton.disabled = canDisconnect(next)
    ? next.status === "disconnecting"
    : isBusy(next.status) || !selected || !next.subscription?.hasAccess;
  elements.changeLocationButton.disabled = isBusy(next.status);
  elements.subscriptionStatus.textContent = message(
    next.subscription?.hasAccess ? "subscriptionActive" : "subscriptionInactive",
  );
  elements.subscriptionExpiry.textContent = subscriptionExpiry(next);
  elements.refreshSubscriptionButton.disabled =
    Boolean(accountRefreshPending) || isBusy(next.status);
  elements.refreshSubscriptionButton.classList.toggle("refreshing", Boolean(accountRefreshPending));
  elements.refreshSubscriptionButton.setAttribute(
    "aria-busy",
    String(Boolean(accountRefreshPending)),
  );
  const refreshLabel = message(
    accountRefreshPending ? "refreshingSubscription" : "refreshSubscription",
  );
  elements.refreshSubscriptionButton.setAttribute("aria-label", refreshLabel);
  elements.refreshSubscriptionButton.title = refreshLabel;
  renderLocations(next);
  renderDevices(next);
}

function webLoginRequiresDisconnect(next: AppSnapshot): boolean {
  return (
    next.profile === null && (next.trafficBlocked || next.protectionRequested || next.protected)
  );
}

function renderWebLogin(next: AppSnapshot): void {
  const pending = loginPending || next.webLoginPending === true;
  const disconnectFirst = webLoginRequiresDisconnect(next);
  elements.loginForm.dataset.pending = String(pending);
  elements.loginForm.dataset.disconnect = String(disconnectFirst);
  elements.loginForm.setAttribute("aria-busy", String(pending));
  elements.loginButton.disabled =
    pending ||
    communicationFailed ||
    next.profile !== null ||
    next.error === "storage_unavailable" ||
    next.status === "disconnecting";
  elements.webLoginButtonLabel.textContent = message(
    pending ? "webSignInPending" : disconnectFirst ? "webSignInDisconnect" : "webSignIn",
  );
  elements.webLoginHelp.textContent = message(
    disconnectFirst ? "webSignInDisconnectHelp" : "webSignInHelp",
  );
  elements.webLoginStatus.classList.toggle("hidden", !pending);
  elements.webLoginStatus.textContent = pending ? message("webSignInStatus") : "";
}

async function signInOnWeb(): Promise<void> {
  const current = snapshot;
  if (current?.profile !== null || elements.loginButton.disabled) return;
  const disconnectFirst = webLoginRequiresDisconnect(current);
  // A state change must display the disconnection warning before accepting its consent.
  if (elements.loginForm.dataset.disconnect !== String(disconnectFirst)) {
    renderWebLogin(current);
    return;
  }
  loginPending = true;
  renderWebLogin(current);
  try {
    await request({ type: "web_login", disconnectFirst });
  } finally {
    loginPending = false;
    if (snapshot) renderWebLogin(snapshot);
  }
}

function refreshNetwork(): void {
  void request({ type: "refresh_network" });
}

function renderNetwork(next: AppSnapshot): void {
  const observation = next.network;
  const isVpn = next.protected;
  const matchesRoute =
    (observation.status === "ready" || observation.status === "checking") &&
    observation.ip !== null &&
    (isVpn
      ? observation.mode === "vpn" && observation.locationId === next.activeLocationId
      : observation.mode === "direct" && !next.protectionRequested && !next.trafficBlocked);
  const label = message(isVpn ? "vpnIp" : "publicIp");
  const value = communicationFailed
    ? message("ipUnavailable")
    : matchesRoute
      ? (observation.ip ?? message("ipUnavailable"))
      : message(observation.status === "checking" ? "ipChecking" : "ipUnavailable");
  elements.publicIp.replaceChildren(
    `${label} · `,
    matchesRoute && !communicationFailed && observation.ip ? isolatedText(value, "ltr") : value,
  );
  elements.publicIp.title = message("ipLookupExplanation");
}

function renderSecurity(next: AppSnapshot): void {
  const recovering = next.protectionRequested && !next.protected;
  const showRecovery =
    communicationFailed ||
    next.blockingScope === "unverified" ||
    (!isConnectionProgress(next) && (recovering || next.trafficBlocked));
  elements.recoveryPanel.classList.toggle("hidden", !showRecovery);
  elements.statusCard.classList.toggle("hidden", showRecovery);
  // Recovery must retain access to the selector so an empty catalogue can be refreshed.
  elements.locationCard.classList.remove("hidden");
  elements.protectButton.classList.toggle("hidden", showRecovery);
  elements.retryButton.textContent = message(
    next.profile === null && next.error !== "storage_unavailable" ? "signIn" : "retryConnection",
  );
  elements.recoveryStatus.textContent = message(
    communicationFailed || next.blockingScope === "unverified"
      ? "securityBlockUnverified"
      : next.blockingScope === "except_excluded"
        ? "statusBlockedExceptions"
        : next.trafficBlocked
          ? next.nextRetryAt !== null || next.status === "connecting"
            ? "statusBlockedRetry"
            : "statusBlockedAction"
          : "statusProtectionUnavailable",
  );
  elements.retryButton.disabled =
    Boolean(connectionRetryPending) ||
    (next.error !== "storage_unavailable" &&
      ((next.profile !== null && !next.selectedLocationId) || isBusy(next.status)));
  elements.recoveryDisconnectButton.disabled = next.status === "disconnecting";
  elements.killSwitchEnabled.checked = next.securityPreferences.killSwitchEnabled;
  elements.webRtcProtectionEnabled.checked = next.securityPreferences.webRtcProtectionEnabled;
  elements.killSwitchEnabled.disabled = communicationFailed || Boolean(securityPreferencesPending);
  elements.webRtcProtectionEnabled.disabled =
    communicationFailed || Boolean(securityPreferencesPending);
  elements.securityState.textContent = communicationFailed
    ? message("extensionCommunicationError")
    : message("securityEffectiveState", [
        message(
          next.blockingScope === "unverified"
            ? "securityBlockUnverified"
            : next.blockingScope === "except_excluded"
              ? "securityBlockedExceptions"
              : next.trafficBlocked
                ? "securityBlocked"
                : "securityNotBlocked",
        ),
        message(next.webRtcProtected ? "securityWebRtcActive" : "securityWebRtcInactive"),
      ]);
  const loggedIn = next.profile !== null;
  elements.accountEmail.classList.toggle("hidden", !loggedIn);
  elements.accountEmail.textContent = next.profile?.email ?? "";
  elements.manageDevicesButton.classList.toggle("hidden", !loggedIn);
  elements.logoutButton.classList.toggle("hidden", !loggedIn);
}

function canDisconnect(next: AppSnapshot): boolean {
  return (
    next.protected ||
    next.protectionRequested ||
    next.trafficBlocked ||
    next.status === "connecting" ||
    next.status === "refreshing"
  );
}

function renderError(next: AppSnapshot): void {
  const visible = communicationFailed || next.error !== null;
  const text = communicationFailed
    ? message("extensionCommunicationError")
    : next.error
      ? errorMessage(next.error, next.retryAfterSeconds)
      : "";
  elements.errorBanner.classList.toggle("hidden", !visible || next.profile === null);
  elements.loginErrorBanner.classList.toggle("hidden", !visible || next.profile !== null);
  elements.errorMessage.textContent = text;
  elements.loginErrorMessage.textContent = text;
  elements.settingsError.textContent = text;
  elements.settingsError.classList.toggle("hidden", !visible);
  elements.retryUncertainConnectionButton.classList.toggle(
    "hidden",
    next.error !== "proxy_creation_uncertain",
  );
  elements.retryUncertainConnectionButton.disabled =
    communicationFailed || Boolean(connectionRetryPending) || isBusy(next.status);
  renderVerification(next);
  elements.errorManageDevicesButton.classList.toggle(
    "hidden",
    communicationFailed || (next.error !== "device_limit" && next.error !== "device_revoked_limit"),
  );
  elements.errorManageDevicesButton.disabled = communicationFailed || isBusy(next.status);
}

function renderLogoutOutcome(next: AppSnapshot): void {
  const outcome = next.profile === null && !communicationFailed ? next.logoutOutcome : null;
  elements.logoutResult.classList.toggle("hidden", !outcome);
  if (!outcome) {
    elements.logoutApiStatus.textContent = "";
    elements.logoutProxyStatus.textContent = "";
    return;
  }
  const keys = {
    pending: "logoutRevocationPending",
    confirmed: "logoutRevocationConfirmed",
    unconfirmed: "logoutRevocationUnconfirmed",
  };
  elements.logoutApiStatus.textContent = message(keys[outcome.apiSession]);
  elements.logoutProxyStatus.textContent = message(keys[outcome.proxySessions]);
  elements.logoutUnconfirmedHelp.classList.toggle(
    "hidden",
    outcome.apiSession !== "unconfirmed" && outcome.proxySessions !== "unconfirmed",
  );
}

function renderLocations(next: AppSnapshot): void {
  const loading = next.locationsStatus === "loading" || Boolean(locationsRefreshPending);
  const failed = next.locationsStatus === "error" || locationsRefreshFailed;
  const unknown = next.locations.length === 0 && next.locationsStatus !== "ready";
  elements.refreshLocationsButton.disabled = loading || !next.profile;
  elements.refreshLocationsButton.setAttribute("aria-busy", String(loading));
  const refreshLabel = message(loading ? "refreshingLocations" : "refreshLocations");
  elements.refreshLocationsButton.setAttribute("aria-label", refreshLabel);
  elements.refreshLocationsButton.title = refreshLabel;
  elements.refreshLocationsButton.classList.toggle("refreshing", loading);
  elements.locationList.setAttribute("aria-busy", String(loading));
  elements.locationLoadStatus.classList.toggle("hidden", !loading && !failed);
  elements.locationLoadStatus.textContent = message(
    failed ? "locationsRefreshError" : "refreshingLocations",
  );
  const preferences = next.locationPreferences;
  const query = elements.locationSearch.value;
  const search = normalizeLocationSearch(query, locale).split(/\s+/).filter(Boolean);
  const hierarchical = locationFilter === "all" && search.length === 0;
  elements.locationHierarchyHelp.classList.toggle(
    "hidden",
    !hierarchical || !next.locations.length,
  );
  for (const [filter, button] of locationFilters()) {
    button.setAttribute("aria-pressed", String(filter === locationFilter));
  }
  elements.automaticLocationButton.setAttribute("aria-pressed", String(preferences.automatic));
  elements.automaticLocationButton.disabled =
    isBusy(next.status) || Boolean(automaticSelectionPending) || !next.locations.length;
  const failure =
    locationPreferenceFailure ??
    (next.error === "server_full" || next.error === "capacity_unavailable" ? next.error : null);
  elements.locationPreferenceError.classList.toggle("hidden", failure === null);
  elements.locationPreferenceError.textContent =
    failure === "transport"
      ? message("extensionCommunicationError")
      : failure === "save"
        ? message("locationSaveError")
        : failure
          ? errorMessage(failure, next.retryAfterSeconds)
          : "";
  const listKey = JSON.stringify([
    locale,
    accountEpoch,
    next.locations,
    next.locationsStatus,
    loading,
    failed,
    preferences,
    next.selectedLocationId,
    isBusy(next.status),
    locationFilter,
    query,
    [...favoriteChanges],
    [...expandedLocationCountries],
    [...expandedLocationCities],
  ]);
  if (listKey === renderedLocations) return;
  const favoriteIds = new Set(preferences.favoriteIds);
  const recentIds = new Set(preferences.recentIds);
  const visible = next.locations.filter((location) => {
    if (locationFilter === "favorites" && !favoriteIds.has(location.id)) return false;
    if (locationFilter === "recent" && !recentIds.has(location.id)) return false;
    const text = [
      location.displayName,
      location.city,
      countryLabel(location.countryCode, countryNames),
    ].join(" ");
    return matchesLocationSearch(text, location.countryCode, query, locale);
  });
  const rank = (location: Location): number => {
    if (locationFilter === "recent") return preferences.recentIds.indexOf(location.id);
    if (favoriteIds.has(location.id)) return -1;
    const recent = preferences.recentIds.indexOf(location.id);
    return recent >= 0 ? recent : preferences.recentIds.length;
  };
  visible.sort((left, right) => rank(left) - rank(right));
  elements.locationEmpty.classList.toggle("hidden", visible.length > 0 || unknown);
  elements.locationEmpty.textContent = message(
    locationFilter === "favorites" &&
      !preferences.favoriteIds.length &&
      preferences.unavailableFavoriteIds?.length
      ? "noAvailableFavoriteLocations"
      : !next.locations.length
        ? "noAvailableLocations"
        : search.length
          ? "noMatchingLocations"
          : locationFilter === "favorites"
            ? "noFavoriteLocations"
            : locationFilter === "recent"
              ? "noRecentLocations"
              : "noAvailableLocations",
  );
  const rows: HTMLElement[] = hierarchical
    ? buildLocationGroups(visible, locale).map((group) => locationCountryGroup(group, next))
    : visible.map((location) => locationServerRow(location, next));
  if (locationFilter === "favorites" && search.length === 0) {
    rows.push(
      ...(preferences.unavailableFavoriteIds ?? []).map((id, index) =>
        unavailableFavoriteRow(id, index),
      ),
    );
  }
  const fallback =
    locationFilters().find(([filter]) => filter === locationFilter)?.[1] ??
    elements.closeLocationButton;
  renderedLocations = listKey;
  replaceListChildren(elements.locationList, rows, fallback);
}

function unavailableFavoriteRow(id: string, index: number): HTMLElement {
  const row = document.createElement("div");
  row.className = "location-row location-unavailable-favorite";
  const label = message("unavailableFavoriteLocation", [
    new Intl.NumberFormat(locale).format(index + 1),
  ]);
  const title = document.createElement("span");
  title.className = "location-unavailable-label";
  title.textContent = label;
  row.append(title, favoriteButton(id, label, true));
  return row;
}

function locationServerRow(location: Location, next: AppSnapshot): HTMLElement {
  const preferences = next.locationPreferences;
  const favoriteIds = new Set(preferences.favoriteIds);
  const row = document.createElement("div");
  row.className = "location-row location-server-row";
  const button = document.createElement("button");
  button.type = "button";
  button.className = "location-option";
  button.dataset.focusKey = location.id;
  const selected = location.id === next.selectedLocationId && !preferences.automatic;
  button.classList.toggle("selected", selected);
  button.setAttribute("aria-pressed", String(selected));
  const title = document.createElement("span");
  title.className = "option-title";
  title.dir = "auto";
  title.textContent = location.displayName;
  const country = document.createElement("span");
  country.className = "option-country";
  country.textContent = [countryLabel(location.countryCode, countryNames), location.city]
    .filter(Boolean)
    .join(" · ");
  button.append(countryFlag(location.countryCode), title, country);
  button.disabled = isBusy(next.status);
  button.addEventListener("click", () => selectLocation(location.id));
  row.append(
    button,
    favoriteButton(location.id, locationLabel(location), favoriteIds.has(location.id)),
  );
  return row;
}

function selectLocation(locationId: string): void {
  const current = snapshot;
  if (
    !current?.profile ||
    isBusy(current.status) ||
    !current.locations.some(({ id }) => id === locationId)
  )
    return;
  if (
    locationId === current.selectedLocationId &&
    !locationSelectionPending &&
    !automaticSelectionPending &&
    !current.locationPreferences.automatic &&
    current.error !== "server_full" &&
    (!current.protected || locationId === current.activeLocationId)
  ) {
    elements.locationDialog.close();
    return;
  }
  const type = current.protected ? "change_location" : "select_location";
  const epoch = accountEpoch;
  const selection = ++locationSelectionRequest;
  locationSelectionPending = true;
  locationPreferenceFailure = null;
  void request({ type, locationId })
    .then((response) => {
      if (epoch !== accountEpoch || selection !== locationSelectionRequest || response.superseded)
        return;
      locationPreferenceFailure = locationCommandFailure(response);
      if (response.ok) elements.locationDialog.close();
      render(response.snapshot);
    })
    .catch(() => {
      if (epoch !== accountEpoch || selection !== locationSelectionRequest) return;
      locationPreferenceFailure = "transport";
      if (snapshot) renderLocations(snapshot);
    })
    .finally(() => {
      if (epoch !== accountEpoch || selection !== locationSelectionRequest) return;
      locationSelectionPending = false;
    });
}

function locationCountryGroup(
  group: ReturnType<typeof buildLocationGroups>[number],
  next: AppSnapshot,
): HTMLElement {
  const section = document.createElement("section");
  section.className = "location-country-group";
  section.dataset.countryCode = group.countryCode;
  const label = countryLabel(group.countryCode, countryNames);
  const content = document.createElement("div");
  content.className = "location-group-children location-cities";
  content.id = `location-cities-${encodeURIComponent(group.countryCode)}`;
  content.hidden = !expandedLocationCountries.has(group.countryCode);
  content.append(...group.cities.map((city) => locationCityGroup(group.countryCode, city, next)));
  const row = document.createElement("div");
  row.className = "location-group-row";
  const select = locationGroupSelect(label, group.locations, next, "locationCountrySelect", () => {
    const current = snapshot;
    if (!current) return;
    const locations =
      buildLocationGroups(current.locations, locale).find(
        (currentGroup) => currentGroup.countryCode === group.countryCode,
      )?.locations ?? [];
    const selected = chooseGroupLocation(locations, current);
    if (selected) selectLocation(selected.id);
  });
  select.dataset.countryCode = group.countryCode;
  select.dataset.focusKey = `country:${group.countryCode}`;
  select.prepend(countryFlag(group.countryCode));
  row.append(
    select,
    locationDisclosure(
      `country:${group.countryCode}`,
      label,
      content,
      expandedLocationCountries,
      group.countryCode,
      "locationShowCities",
      "locationHideCities",
    ),
  );
  section.append(row, content);
  return section;
}

function locationCityGroup(
  countryCode: string,
  city: ReturnType<typeof buildLocationGroups>[number]["cities"][number],
  next: AppSnapshot,
): HTMLElement {
  const section = document.createElement("section");
  section.className = "location-city-group";
  section.dataset.cityKey = city.key;
  const onlyLocation = city.locations.length === 1 ? city.locations[0] : undefined;
  const label =
    city.city.length > 0 ? city.city : (onlyLocation?.displayName ?? message("location"));
  const row = document.createElement("div");
  row.className = "location-group-row";
  const select = locationGroupSelect(label, city.locations, next, "locationCitySelect", () => {
    const current = snapshot;
    if (!current) return;
    const candidates =
      buildLocationGroups(current.locations, locale)
        .find((group) => group.countryCode === countryCode)
        ?.cities.find((group) => group.key === city.key)?.locations ?? [];
    const selected = chooseGroupLocation(candidates, current);
    if (selected) selectLocation(selected.id);
  });
  select.classList.add("location-city-select");
  select.dataset.countryCode = countryCode;
  select.dataset.cityKey = city.key;
  select.dataset.focusKey = `city:${city.key}`;
  row.append(select);
  if (onlyLocation) {
    const location = onlyLocation;
    row.classList.add("location-single-server");
    row.append(
      favoriteButton(
        location.id,
        locationLabel(location),
        next.locationPreferences.favoriteIds.includes(location.id),
      ),
    );
    section.append(row);
  } else {
    const content = document.createElement("div");
    content.className = "location-group-children location-servers";
    content.id = `location-servers-${encodeURIComponent(city.key)}`;
    content.hidden = !expandedLocationCities.has(city.key);
    content.append(...city.locations.map((location) => locationServerRow(location, next)));
    row.append(
      locationDisclosure(
        `city:${city.key}`,
        label,
        content,
        expandedLocationCities,
        city.key,
        "locationShowServers",
        "locationHideServers",
      ),
    );
    section.append(row, content);
  }
  return section;
}

function locationGroupSelect(
  label: string,
  locations: Location[],
  next: AppSnapshot,
  labelKey: string,
  select: () => void,
): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "location-option location-group-select";
  button.setAttribute("aria-label", message(labelKey, [label]));
  button.title = message(labelKey, [label]);
  button.disabled = isBusy(next.status);
  const selected =
    !next.locationPreferences.automatic &&
    locations.some((location) => location.id === next.selectedLocationId);
  button.classList.toggle("selected", selected);
  button.setAttribute("aria-pressed", String(selected));
  const title = document.createElement("span");
  title.className = "option-title";
  title.dir = "auto";
  title.textContent = label;
  const count = document.createElement("span");
  count.className = "option-country";
  count.textContent = message("locationAvailableServers", [
    new Intl.NumberFormat(locale).format(locations.length),
  ]);
  button.append(title, count);
  button.addEventListener("click", select);
  return button;
}

function locationDisclosure(
  focusKey: string,
  label: string,
  content: HTMLElement,
  expanded: Set<string>,
  key: string,
  showKey: string,
  hideKey: string,
): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "location-disclosure";
  button.dataset.focusKey = `expand:${focusKey}`;
  button.setAttribute("aria-expanded", String(!content.hidden));
  button.setAttribute("aria-controls", content.id);
  const title = message(content.hidden ? showKey : hideKey, [label]);
  button.setAttribute("aria-label", title);
  button.title = title;
  const chevron = document.createElement("span");
  chevron.className = "location-chevron";
  chevron.setAttribute("aria-hidden", "true");
  button.append(chevron);
  button.addEventListener("click", () => {
    if (expanded.has(key)) expanded.delete(key);
    else expanded.add(key);
    if (snapshot) renderLocations(snapshot);
  });
  return button;
}

function favoriteButton(id: string, label: string, selected: boolean): HTMLButtonElement {
  const favorite = document.createElement("button");
  favorite.type = "button";
  favorite.className = "location-favorite";
  favorite.dataset.focusKey = `favorite:${id}`;
  favorite.setAttribute("aria-pressed", String(selected));
  const favoriteLabel = message(selected ? "removeFavorite" : "addFavorite", [label]);
  favorite.setAttribute("aria-label", favoriteLabel);
  favorite.title = favoriteLabel;
  favorite.textContent = selected ? "★" : "☆";
  const key = JSON.stringify([accountEpoch, id]);
  const pending = favoriteChanges.has(key);
  favorite.setAttribute("aria-disabled", String(pending));
  favorite.setAttribute("aria-busy", String(pending));
  favorite.addEventListener("click", () => {
    if (!snapshot?.profile || favoriteChanges.has(key)) return;
    const epoch = accountEpoch;
    favoriteChanges.add(key);
    locationPreferenceFailure = null;
    const preferences = snapshot.locationPreferences;
    const value = ![
      ...preferences.favoriteIds,
      ...(preferences.unavailableFavoriteIds ?? []),
    ].includes(id);
    renderLocations(snapshot);
    void request({ type: "set_location_favorite", locationId: id, favorite: value })
      .then((response) => {
        if (epoch !== accountEpoch || response.superseded) return;
        locationPreferenceFailure = locationCommandFailure(response);
        render(response.snapshot);
      })
      .catch(() => {
        if (epoch === accountEpoch) locationPreferenceFailure = "transport";
      })
      .finally(() => {
        favoriteChanges.delete(key);
        if (epoch === accountEpoch && snapshot) renderLocations(snapshot);
      });
  });
  return favorite;
}

function locationFilters(): ["all" | "favorites" | "recent", HTMLButtonElement][] {
  return [
    ["all", elements.allLocationsFilter],
    ["favorites", elements.favoriteLocationsFilter],
    ["recent", elements.recentLocationsFilter],
  ];
}

function isolatedText(value: string, direction: "auto" | "ltr" = "auto"): HTMLElement {
  const node = document.createElement("bdi");
  node.dir = direction;
  node.textContent = value;
  return node;
}

function renderDevices(next: AppSnapshot): void {
  const refreshing = Boolean(devicesRefreshPending);
  elements.devicesError.classList.toggle("hidden", !devicesFailure);
  elements.devicesError.textContent = devicesFailure
    ? devicesFailure.transport
      ? message("extensionCommunicationError")
      : errorMessage(devicesFailure.code, devicesFailure.retryAfter)
    : "";
  elements.deviceCount.textContent =
    next.deviceLimit === null
      ? message(refreshing ? "deviceQuotaLoading" : "deviceQuotaUnknown")
      : message("deviceCount", [String(next.devices.length), String(next.deviceLimit)]);
  elements.refreshDevicesButton.disabled = refreshing || isBusy(next.status);
  elements.refreshDevicesButton.classList.toggle("refreshing", refreshing);
  elements.refreshDevicesButton.setAttribute("aria-busy", String(refreshing));
  const listKey = JSON.stringify([
    locale,
    accountEpoch,
    next.devices,
    next.currentDeviceId,
    isBusy(next.status),
    refreshing,
    [...deviceDeletions],
  ]);
  if (listKey === renderedDevices) return;
  const entries: HTMLElement[] = [];
  if (next.devices.length === 0) {
    const empty = document.createElement("p");
    empty.className = "muted";
    empty.textContent = refreshing ? message("loadingDevices") : message("noDevices");
    entries.push(empty);
  } else {
    const displayNames = deviceDisplayNames(
      next.devices,
      (device) => displayDeviceName(device, next.currentDeviceId),
      locale,
      (device) => message(deviceKindMessageKey(device, next.currentDeviceId, currentBrowserName)),
    );
    for (const device of next.devices)
      entries.push(
        deviceElement(
          device,
          next,
          displayNames.get(device.deviceId) ?? displayDeviceName(device, next.currentDeviceId),
        ),
      );
  }
  renderedDevices = listKey;
  replaceListChildren(
    elements.deviceList,
    entries,
    elements.refreshDevicesButton.disabled
      ? elements.closeDevicesButton
      : elements.refreshDevicesButton,
  );
}

function replaceListChildren(
  list: HTMLElement,
  children: HTMLElement[],
  fallbackFocus: HTMLButtonElement,
): void {
  const active = document.activeElement;
  const focusKey =
    active instanceof HTMLButtonElement && list.contains(active) ? active.dataset.focusKey : null;
  const cityKey =
    active instanceof HTMLElement
      ? active.closest<HTMLElement>(".location-city-group")?.dataset.cityKey
      : null;
  const countryCode =
    active instanceof HTMLElement
      ? active.closest<HTMLElement>(".location-country-group")?.dataset.countryCode
      : null;
  const scrollTop = list.scrollTop;
  list.replaceChildren(...children);
  if (focusKey !== null && focusKey !== undefined) {
    const visibleButtons = Array.from(list.querySelectorAll<HTMLButtonElement>("button")).filter(
      (button) => !button.disabled && button.getClientRects().length > 0,
    );
    const replacement = [
      focusKey,
      cityKey ? `city:${cityKey}` : null,
      countryCode ? `country:${countryCode}` : null,
    ]
      .map((key) => visibleButtons.find((button) => button.dataset.focusKey === key))
      .find(Boolean);
    (replacement ?? fallbackFocus).focus({ preventScroll: true });
    list.scrollTop = scrollTop;
  }
}

function displayDeviceName(device: Device, currentDeviceId: string | null): string {
  const currentLabel =
    currentBrowserName === "Firefox"
      ? message("deviceKindFirefox")
      : currentBrowserName === "Browser"
        ? message("deviceKindBrowser")
        : currentBrowserName;
  return deviceDisplayName(device, currentDeviceId, currentLabel, message("deviceKindBrowser"));
}

function deviceElement(device: Device, state: AppSnapshot, displayName: string): HTMLElement {
  const article = document.createElement("article");
  article.className = "device-item";
  const head = document.createElement("div");
  head.className = "device-head";
  const title = document.createElement("p");
  title.className = "device-name";
  title.append(isolatedText(displayName));
  if (device.deviceId === state.currentDeviceId) {
    const current = document.createElement("span");
    current.className = "device-current";
    current.textContent = message("currentDevice");
    title.append(current);
  }
  const kind = document.createElement("p");
  kind.className = "device-meta";
  kind.textContent = message(
    deviceKindMessageKey(device, state.currentDeviceId, currentBrowserName),
  );
  const created = document.createElement("p");
  created.className = "device-meta";
  created.textContent = message("deviceCreatedOn", [dateFormat.format(new Date(device.createdAt))]);
  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "delete-device-button";
  remove.dataset.focusKey = device.deviceId;
  remove.textContent = message("deleteDevice");
  remove.setAttribute("aria-label", deviceAccessibleName(message("deleteDevice"), displayName));
  const deletionKey = JSON.stringify([accountEpoch, device.deviceId]);
  remove.disabled = isBusy(state.status) || deviceDeletions.has(deletionKey);
  remove.setAttribute("aria-busy", String(deviceDeletions.has(deletionKey)));
  remove.addEventListener("click", () => void deleteDevice(device.deviceId, deletionKey, remove));
  head.append(title);
  article.append(head, kind, created, remove);
  return article;
}

async function deleteDevice(
  deviceId: string,
  deletionKey: string,
  remove: HTMLButtonElement,
): Promise<void> {
  const current = snapshot;
  const currentDevice = current?.devices.find((device) => device.deviceId === deviceId);
  if (
    !current?.profile ||
    isBusy(current.status) ||
    !currentDevice ||
    deviceDeletions.has(deletionKey)
  )
    return;
  const epoch = accountEpoch;
  const confirmationLocale = locale;
  const displayNames = deviceDisplayNames(
    current.devices,
    (device) => displayDeviceName(device, current.currentDeviceId),
    locale,
    (device) => message(deviceKindMessageKey(device, current.currentDeviceId, currentBrowserName)),
  );
  const confirmationDisplayName =
    displayNames.get(deviceId) ?? displayDeviceName(currentDevice, current.currentDeviceId);
  if (
    !(await confirmAction(
      message("deleteDevice"),
      message("confirmDeleteDevice", [confirmationDisplayName]),
    ))
  )
    return;
  if (
    epoch !== accountEpoch ||
    locale !== confirmationLocale ||
    !snapshot?.profile ||
    isBusy(snapshot.status) ||
    !snapshot.devices.some((device) => device.deviceId === deviceId) ||
    deviceDeletions.has(deletionKey)
  )
    return;
  const latest = snapshot;
  const currentDisplayNames = deviceDisplayNames(
    latest.devices,
    (device) => displayDeviceName(device, latest.currentDeviceId),
    locale,
    (device) => message(deviceKindMessageKey(device, latest.currentDeviceId, currentBrowserName)),
  );
  if (currentDisplayNames.get(deviceId) !== confirmationDisplayName) return;
  if (document.activeElement === remove) {
    const fallback = elements.refreshDevicesButton.disabled
      ? elements.closeDevicesButton
      : elements.refreshDevicesButton;
    fallback.focus({ preventScroll: true });
  }
  const action = ++devicesAction;
  deviceDeletions.add(deletionKey);
  devicesFailure = null;
  renderDevices(snapshot);
  await request({ type: "delete_device", deviceId })
    .then((response) => {
      if (epoch !== accountEpoch || action !== devicesAction || response.superseded) return;
      devicesFailure = deviceFailure(response);
      render(response.snapshot);
    })
    .finally(() => {
      deviceDeletions.delete(deletionKey);
      if (epoch === accountEpoch && snapshot) renderDevices(snapshot);
    });
}

function countryFlag(code: string): HTMLImageElement {
  const flag = document.createElement("img");
  flag.className = "country-flag";
  flag.alt = "";
  flag.setAttribute("aria-hidden", "true");
  flag.width = 24;
  flag.height = 18;
  flag.decoding = "async";
  flag.src = extensionApi.runtime.getURL(countryFlagPath(code));
  flag.addEventListener(
    "error",
    () => {
      flag.src = extensionApi.runtime.getURL("flags/unknown.svg");
    },
    { once: true },
  );
  return flag;
}

function isConnectionProgress(next: AppSnapshot): boolean {
  return (
    !communicationFailed &&
    next.error === null &&
    next.blockingScope !== "unverified" &&
    (next.status === "connecting" || next.status === "refreshing")
  );
}

function statusKey(next: AppSnapshot): string {
  const { status, protected: protectedState } = next;
  if (isConnectionProgress(next))
    return status === "refreshing"
      ? "statusRefreshing"
      : protectedState
        ? "statusChanging"
        : "statusConnecting";
  if (next.trafficBlocked)
    return next.nextRetryAt !== null || status === "connecting"
      ? "statusBlockedRetry"
      : "statusBlockedAction";
  if (status === "refreshing") return "statusRefreshing";
  if (status === "connecting") return protectedState ? "statusChanging" : "statusConnecting";
  if (status === "disconnecting") return "statusDisconnecting";
  if (protectedState) return "statusProtected";
  if (status === "error") return "statusError";
  return "statusDisconnected";
}

function statusClass(status: MachineState, protectedState: boolean): string {
  if (status === "blocked") return "blocked";
  if (status === "refreshing" || status === "connecting" || status === "disconnecting")
    return "reconnecting";
  if (protectedState) return "connected";
  return status === "error" ? "error" : "disconnected";
}

function isBusy(status: MachineState): boolean {
  return status === "connecting" || status === "refreshing" || status === "disconnecting";
}

function subscriptionExpiry(state: AppSnapshot): string {
  const expiresAt = state.subscription?.expiresAt;
  if (!expiresAt) return message("noExpiry");
  return message("expiresOn", [dateFormat.format(new Date(expiresAt))]);
}

function locationLabel(location: Location): string {
  const country = countryLabel(location.countryCode, countryNames);
  return `${country} · ${location.displayName}`;
}

function errorMessage(code: AppErrorCode, retryAfter: number | null): string {
  if (code === "verification_email_cooldown" && retryAfter)
    return message("errorVerificationCooldown", [String(retryAfter)]);
  const key = `error_${code}`;
  const translated = message(key);
  return translated && translated !== key ? translated : message("error_unknown_error");
}

function connectionRequestState(
  next: AppSnapshot | null,
  command: ExtensionRequest,
): string | null {
  if (!next || next.error || isBusy(next.status)) return null;
  switch (command.type) {
    case "logout":
      return next.profile === null && !next.protected && !next.protectionRequested
        ? "logged_out"
        : null;
    case "disconnect":
      return !next.protected && !next.protectionRequested && next.activeLocationId === null
        ? "disconnected"
        : null;
    case "connect":
    case "change_location":
      return next.protected &&
        next.protectionRequested &&
        next.activeLocationId === command.locationId
        ? command.locationId
        : null;
    case "retry_connection":
      return next.protected && next.protectionRequested && next.activeLocationId !== null
        ? next.activeLocationId
        : null;
    case "select_location":
      return !next.locationPreferences.automatic &&
        next.selectedLocationId === command.locationId &&
        (!next.protectionRequested ||
          (next.protected && next.activeLocationId === command.locationId))
        ? command.locationId
        : null;
    case "select_automatic_location":
      return next.locationPreferences.automatic &&
        (!next.protectionRequested ||
          (next.protected && next.activeLocationId === next.selectedLocationId))
        ? JSON.stringify([true, next.selectedLocationId])
        : null;
    case "web_login":
      return next.profile && !next.webLoginPending ? next.profile.userId : null;
    case "reset_device_identity":
      return next.currentDeviceId === null && !next.protected && !next.protectionRequested
        ? "identity_reset"
        : null;
    case "delete_device":
      return next.devices.some(({ deviceId }) => deviceId === command.deviceId) ? null : "deleted";
    case "update_security_preferences":
      return next.securityPreferences.killSwitchEnabled === command.killSwitchEnabled &&
        next.securityPreferences.webRtcProtectionEnabled === command.webRtcProtectionEnabled
        ? JSON.stringify(next.securityPreferences)
        : null;
    case "update_site_exclusions":
    case "retry_site_exclusions": {
      const { saved, applied, pending, error } = next.siteExclusions;
      if (pending || error || JSON.stringify(saved) !== JSON.stringify(applied)) return null;
      if (
        command.type === "update_site_exclusions" &&
        (saved.revision <= command.expectedRevision ||
          saved.enabled !== command.enabled ||
          JSON.stringify(saved.entries) !== JSON.stringify(command.entries))
      )
        return null;
      return JSON.stringify(applied);
    }
    default:
      return null;
  }
}

async function request(messageValue: ExtensionRequest): Promise<PopupResponse> {
  const epoch = accountEpoch;
  const workerId = snapshot?.snapshotVersion?.workerId ?? null;
  const confirmation = confirmedSnapshotSequence;
  const previousState = connectionRequestState(snapshot, messageValue);
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
  ].includes(messageValue.type);
  const intent = changesConnection ? ++connectionRequestIntent : connectionRequestIntent;
  // A newer account or worker supersedes every reply. A newer connection command supersedes
  // only older connection commands; any other reply keeps its own outcome.
  const isSuperseded = () =>
    epoch !== accountEpoch ||
    workerId !== (snapshot?.snapshotVersion?.workerId ?? null) ||
    (changesConnection && intent !== connectionRequestIntent);
  try {
    const response: unknown = await extensionApi.runtime.sendMessage(messageValue);
    if (
      !response ||
      typeof response !== "object" ||
      !("ok" in response) ||
      typeof response.ok !== "boolean" ||
      !("snapshot" in response)
    )
      throw new Error("invalid_extension_response");
    const next = popupSnapshot(response.snapshot);
    if (isSuperseded())
      return { ok: false, stale: true, superseded: true, snapshot: snapshot ?? next };
    const command = response as ExtensionResponse;
    const accepted = render(next, true);
    return {
      ok: command.ok,
      ...(command.commandError ? { commandError: command.commandError } : {}),
      ...(command.commandRetryAfterSeconds !== undefined
        ? { commandRetryAfterSeconds: command.commandRetryAfterSeconds }
        : {}),
      ...(command.superseded ? { superseded: true } : {}),
      snapshot: snapshot ?? next,
      ...(!accepted ? { stale: true } : {}),
    };
  } catch {
    const superseded = isSuperseded();
    const currentState = connectionRequestState(snapshot, messageValue);
    // Only a newer confirmed state that is not in progress can answer a lost reply. Any
    // such state answers a snapshot read, and these list and preference callers keep
    // their own transport failure visible. Every other command, including account
    // refreshes and verification emails, is confirmed only by its own effect: IP
    // observations and unrelated lists cannot confirm its completion.
    const newerStateSuffices = [
      "get_snapshot",
      "refresh_devices",
      "refresh_locations",
      "set_location_favorite",
      "set_language_preference",
    ].includes(messageValue.type);
    const stateConfirmed =
      confirmation !== confirmedSnapshotSequence &&
      snapshot !== null &&
      !isBusy(snapshot.status) &&
      (newerStateSuffices || (currentState !== null && previousState !== currentState));
    // Public IP is optional; its message channel cannot change the connection UI.
    if (messageValue.type !== "refresh_network" && !superseded && !stateConfirmed)
      renderCommunicationFailure();
    return {
      ok: false,
      transportFailed: true,
      ...(superseded ? { stale: true, superseded: true } : {}),
      snapshot: snapshot ?? popupSnapshot({ ...EMPTY_SNAPSHOT, siteExclusions: undefined }),
    };
  }
}

function localizeDocument(): void {
  configureLegalLinks(locale);
  renderDiagnostics();
  document.documentElement.lang = locale;
  document.documentElement.dir = languageDirection(locale);
  document.title = message("extensionName");
  document.querySelectorAll<HTMLElement>("[data-i18n]").forEach((node) => {
    node.textContent = message(node.dataset.i18n ?? "");
  });
  document.querySelectorAll<HTMLElement>("[data-i18n-placeholder]").forEach((node) => {
    node.setAttribute("placeholder", message(node.dataset.i18nPlaceholder ?? ""));
  });
  document.querySelectorAll<HTMLElement>("[data-i18n-aria-label]").forEach((node) => {
    node.setAttribute("aria-label", message(node.dataset.i18nAriaLabel ?? ""));
  });
  document.querySelectorAll<HTMLElement>("[data-i18n-title]").forEach((node) => {
    node.setAttribute("title", message(node.dataset.i18nTitle ?? ""));
  });
}

function configureLinks(): void {
  elements.diagnosticsLink.href = extensionApi.runtime.getURL("diagnostics-page/diagnostics.html");
  elements.dashboardLink.href = SITE_URLS.dashboard;
}

function renderDiagnostics(): void {
  const state = diagnostics.state;
  elements.diagnosticsAuto.checked = state?.signedIn === true && state.autoReporting;
  elements.diagnosticsAuto.disabled =
    !diagnostics.available || diagnosticsPending || !state?.signedIn;
  elements.diagnosticsAccountRequired.classList.toggle("hidden", state?.signedIn === true);
  elements.diagnosticsError.classList.toggle("hidden", diagnostics.error === null);
  elements.diagnosticsError.textContent = diagnostics.error
    ? message(diagnosticErrorKey(diagnostics.error))
    : "";
}

function message(key: string, substitutions?: string[]): string {
  return translate(key, substitutions);
}

function element<T extends HTMLElement>(id: string): T {
  const value = document.getElementById(id);
  if (!value) throw new Error("Missing popup element");
  return value as T;
}
