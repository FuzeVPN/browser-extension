// SPDX-License-Identifier: MPL-2.0

import type { AppErrorCode, AppSnapshot } from "./state";
import { isLanguagePreference, type LanguagePreference } from "./language";
import { validateSiteExclusionPolicy, type SiteExclusion } from "./site-exclusions";

export type ExtensionRequest =
  | {
      type: "update_site_exclusions";
      expectedRevision: number;
      enabled: boolean;
      entries: SiteExclusion[];
    }
  | { type: "retry_site_exclusions" }
  | { type: "get_snapshot" }
  | { type: "refresh_network" }
  | { type: "select_automatic_location" }
  | { type: "set_location_favorite"; locationId: string; favorite: boolean }
  | { type: "set_language_preference"; preference: LanguagePreference }
  | { type: "web_login"; disconnectFirst: boolean }
  | { type: "select_location"; locationId: string }
  | { type: "connect"; locationId: string }
  | { type: "change_location"; locationId: string }
  | { type: "disconnect" }
  | { type: "retry_connection" }
  | {
      type: "update_security_preferences";
      killSwitchEnabled: boolean;
      webRtcProtectionEnabled: boolean;
    }
  | { type: "logout" }
  | { type: "resend_verification" }
  | { type: "refresh_account" }
  | { type: "refresh_locations" }
  | { type: "refresh_devices" }
  | { type: "delete_device"; deviceId: string }
  | { type: "reset_device_identity" };

export interface CommandResult {
  ok: boolean;
  commandError?: AppErrorCode;
  commandRetryAfterSeconds?: number;
  superseded?: boolean;
}

export interface ExtensionResponse extends CommandResult {
  snapshot: AppSnapshot;
}

export interface StateChangedMessage {
  type: "state_changed";
  snapshot: AppSnapshot;
}

export function isExtensionRequest(value: unknown): value is ExtensionRequest {
  if (!value || typeof value !== "object" || !("type" in value)) return false;
  const candidate = value as Record<string, unknown>;
  const type = candidate.type;
  if (typeof type !== "string") return false;
  if (type === "update_site_exclusions") {
    return validateSiteExclusionPolicy({
      revision: candidate.expectedRevision,
      enabled: candidate.enabled,
      entries: candidate.entries,
    });
  }
  if (type === "set_location_favorite") {
    return (
      typeof candidate.locationId === "string" &&
      candidate.locationId.length > 0 &&
      candidate.locationId.length <= 200 &&
      typeof candidate.favorite === "boolean"
    );
  }
  if (type === "set_language_preference") return isLanguagePreference(candidate.preference);
  if (type === "update_security_preferences") {
    return (
      typeof candidate.killSwitchEnabled === "boolean" &&
      typeof candidate.webRtcProtectionEnabled === "boolean"
    );
  }
  if (type === "web_login")
    return (
      typeof candidate.disconnectFirst === "boolean" &&
      Object.keys(candidate).every((key) => key === "type" || key === "disconnectFirst")
    );
  if (type === "connect" || type === "change_location" || type === "select_location") {
    return typeof candidate.locationId === "string" && candidate.locationId.length > 0;
  }
  if (type === "delete_device") {
    return typeof candidate.deviceId === "string" && candidate.deviceId.length > 0;
  }
  return [
    "retry_site_exclusions",
    "get_snapshot",
    "refresh_network",
    "select_automatic_location",
    "retry_connection",
    "disconnect",
    "logout",
    "resend_verification",
    "refresh_account",
    "refresh_locations",
    "refresh_devices",
    "reset_device_identity",
  ].includes(type);
}
