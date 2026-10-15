// SPDX-License-Identifier: MPL-2.0

import {
  EMPTY_SITE_EXCLUSIONS,
  validateSiteExclusionPolicy,
} from "../../core/shared/site-exclusions";
import { EMPTY_NETWORK_OBSERVATION, type NetworkObservation } from "../../core/shared/network";
import {
  EMPTY_LOCATION_PREFERENCES,
  type LocationPreferencesState,
} from "../../core/shared/location-preferences";
import { isLanguagePreference } from "../../core/shared/language";
import { normalizeSubscription } from "../../core/shared/subscription";
import { isIpv4 } from "../../core/shared/ip-address";
import type { AppSnapshot, LogoutOutcome } from "../../core/shared/state";

export interface PopupSnapshot extends AppSnapshot {
  siteExclusionsAvailable: boolean;
}

interface SnapshotVersion {
  workerId: string;
  revision: number;
}

/** Runtime responses and broadcasts share one ordering, including worker restarts.
 * Legacy workers remain usable until the first versioned snapshot is observed. */
export class PopupSnapshotOrder {
  private current: SnapshotVersion | null = null;
  private readonly retiredWorkers = new Set<string>();

  accept(snapshot: { snapshotVersion?: SnapshotVersion }): boolean {
    const version = snapshot.snapshotVersion;
    if (!version) return this.current === null;
    if (this.current?.workerId === version.workerId) {
      if (version.revision < this.current.revision) return false;
    } else {
      if (this.retiredWorkers.has(version.workerId)) return false;
      if (this.current) this.retiredWorkers.add(this.current.workerId);
    }
    this.current = { ...version };
    return true;
  }
}

/** An already running worker can reply with the previous version's schema after
 * an unpacked update. Adapt optional additions at the popup boundary, without
 * changing the account or the worker's protection state. */
export function popupSnapshot(value: unknown): PopupSnapshot {
  if (
    !isObject(value) ||
    typeof value.status !== "string" ||
    ![
      "logged_out",
      "disconnected",
      "connecting",
      "connected",
      "refreshing",
      "disconnecting",
      "blocked",
      "error",
    ].includes(value.status) ||
    typeof value.protected !== "boolean" ||
    typeof value.trafficBlocked !== "boolean" ||
    typeof value.protectionRequested !== "boolean" ||
    !(value.profile === null || isProfile(value.profile)) ||
    !isArrayOf(value.locations, isLocation) ||
    !isArrayOf(value.devices, isDevice) ||
    !isNullableString(value.currentDeviceId) ||
    !isNullableString(value.selectedLocationId) ||
    !isNullableString(value.activeLocationId) ||
    !isNullableString(value.error) ||
    !isNullableNumber(value.retryAfterSeconds) ||
    !isNullableNumber(value.nextRetryAt) ||
    typeof value.autoConnect !== "boolean" ||
    typeof value.webRtcProtected !== "boolean" ||
    !isLanguagePreference(value.languagePreference) ||
    !isLanguagePreference(value.effectiveLanguage) ||
    value.effectiveLanguage === "auto" ||
    !isObject(value.securityPreferences) ||
    typeof value.securityPreferences.killSwitchEnabled !== "boolean" ||
    typeof value.securityPreferences.webRtcProtectionEnabled !== "boolean" ||
    (value.snapshotVersion !== undefined && !isSnapshotVersion(value.snapshotVersion))
  ) {
    throw new Error("invalid_popup_snapshot");
  }
  const state = value.siteExclusions;
  const available =
    value.siteExclusionsAvailable !== false &&
    isObject(state) &&
    validateSiteExclusionPolicy(state.saved) &&
    validateSiteExclusionPolicy(state.applied) &&
    typeof state.pending === "boolean" &&
    typeof state.error === "boolean";
  const source = value as unknown as Omit<AppSnapshot, "network" | "locationPreferences"> &
    Partial<Pick<AppSnapshot, "network" | "locationPreferences">>;
  return {
    ...source,
    // Invalid cached billing metadata must not hide account or protection controls.
    subscription: normalizeSubscription(source.subscription),
    locationsStatus:
      source.locationsStatus !== undefined &&
      ["idle", "loading", "ready", "error"].includes(source.locationsStatus)
        ? source.locationsStatus
        : source.locations.length
          ? "ready"
          : "idle",
    locationsError: typeof source.locationsError === "string" ? source.locationsError : null,
    vpnNodeAddress:
      source.protected && isIpv4(source.vpnNodeAddress) ? source.vpnNodeAddress : null,
    vpnNodeAddressStatus: source.vpnNodeAddressStatus ?? "idle",
    activeLocation:
      source.protected &&
      isLocation(source.activeLocation) &&
      source.activeLocation?.id === source.activeLocationId
        ? structuredClone(source.activeLocation)
        : null,
    logoutOutcome: isLogoutOutcome(source.logoutOutcome) ? { ...source.logoutOutcome } : null,
    deviceLimit:
      typeof source.deviceLimit === "number" &&
      Number.isSafeInteger(source.deviceLimit) &&
      source.deviceLimit > 0
        ? source.deviceLimit
        : null,
    network: structuredClone(
      isNetwork(source.network) ? source.network : EMPTY_NETWORK_OBSERVATION,
    ),
    locationPreferences: structuredClone(
      isLocationPreferences(source.locationPreferences)
        ? source.locationPreferences
        : EMPTY_LOCATION_PREFERENCES,
    ),
    siteExclusions: available
      ? structuredClone(source.siteExclusions)
      : structuredClone(EMPTY_SITE_EXCLUSIONS),
    siteExclusionsAvailable: available,
    blockingScope:
      source.blockingScope !== undefined &&
      ["none", "all", "except_excluded", "unverified"].includes(source.blockingScope)
        ? source.blockingScope
        : source.trafficBlocked
          ? "all"
          : "none",
  };
}

function isProfile(value: unknown): boolean {
  return (
    isObject(value) &&
    ["userId", "email", "firstName", "lastName", "countryCode"].every(
      (key) => typeof value[key] === "string",
    )
  );
}

function isLocation(value: unknown): boolean {
  return (
    isObject(value) &&
    ["id", "displayName", "city", "countryCode"].every((key) => typeof value[key] === "string") &&
    isStringArray(value.supportedProtocols)
  );
}

function isDevice(value: unknown): boolean {
  return (
    isObject(value) &&
    ["deviceId", "name", "kind"].every((key) => typeof value[key] === "string") &&
    isDate(value.createdAt) &&
    isArrayOf(
      value.profiles,
      (profile) =>
        isObject(profile) &&
        typeof profile.protocol === "string" &&
        typeof profile.status === "string" &&
        isDate(profile.createdAt) &&
        isNullableDate(profile.expiresAt),
    )
  );
}

function isNetwork(value: unknown): value is NetworkObservation {
  return (
    isObject(value) &&
    typeof value.status === "string" &&
    ["idle", "checking", "ready", "unavailable"].includes(value.status) &&
    (value.mode === null || value.mode === "direct" || value.mode === "vpn") &&
    isNullableString(value.ip) &&
    isNullableString(value.locationId) &&
    isNullableNumber(value.checkedAt) &&
    isNullableNumber(value.latencyMs)
  );
}

function isLocationPreferences(value: unknown): value is LocationPreferencesState {
  return (
    isObject(value) &&
    isStringArray(value.favoriteIds) &&
    isStringArray(value.recentIds) &&
    (value.unavailableFavoriteIds === undefined || isStringArray(value.unavailableFavoriteIds)) &&
    typeof value.automatic === "boolean" &&
    isNullableString(value.recommendedLocationId)
  );
}

function isArrayOf(value: unknown, check: (entry: unknown) => boolean): boolean {
  return Array.isArray(value) && value.every(check);
}

function isStringArray(value: unknown): boolean {
  return isArrayOf(value, (entry) => typeof entry === "string");
}

function isNullableString(value: unknown): boolean {
  return value === null || typeof value === "string";
}

function isNullableNumber(value: unknown): boolean {
  return value === null || (typeof value === "number" && Number.isFinite(value) && value >= 0);
}

function isDate(value: unknown): boolean {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function isNullableDate(value: unknown): boolean {
  return value === null || isDate(value);
}

function isLogoutOutcome(value: unknown): value is LogoutOutcome {
  const states = ["pending", "confirmed", "unconfirmed"];
  return (
    isObject(value) &&
    typeof value.apiSession === "string" &&
    states.includes(value.apiSession) &&
    typeof value.proxySessions === "string" &&
    states.includes(value.proxySessions)
  );
}

function isSnapshotVersion(value: unknown): value is SnapshotVersion {
  return (
    isObject(value) &&
    typeof value.workerId === "string" &&
    value.workerId.length > 0 &&
    value.workerId.length <= 200 &&
    Number.isSafeInteger(value.revision) &&
    (value.revision as number) >= 0
  );
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
