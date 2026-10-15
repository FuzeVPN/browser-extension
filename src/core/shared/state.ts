// SPDX-License-Identifier: MPL-2.0

import type { BillingSubscription, Device, Location, Profile } from "../api/types";
import type { LanguageState } from "./language";
import { EMPTY_NETWORK_OBSERVATION, type NetworkObservation } from "./network";
import { EMPTY_LOCATION_PREFERENCES, type LocationPreferencesState } from "./location-preferences";
import { EMPTY_SITE_EXCLUSIONS, type SiteExclusionsState } from "./site-exclusions";

export type MachineState =
  | "logged_out"
  | "disconnected"
  | "connecting"
  | "connected"
  | "refreshing"
  | "disconnecting"
  | "blocked"
  | "error";

export type AppErrorCode =
  | "invalid_credentials"
  | "login_requires_disconnect"
  | "web_login_cancelled"
  | "web_login_timeout"
  | "web_login_unavailable"
  | "web_login_invalid_callback"
  | "web_login_denied"
  | "web_login_busy"
  | "storage_unavailable"
  | "unauthorized"
  | "email_verification_required"
  | "verification_email_cooldown"
  | "subscription_required"
  | "device_limit"
  | "device_revoked_limit"
  | "device_identity_revoked"
  | "device_proof_invalid"
  | "device_proof_replayed"
  | "invalid_device"
  | "device_exists"
  | "not_found"
  | "invalid_location"
  | "server_full"
  | "capacity_unavailable"
  | "rate_limited"
  | "proxy_unavailable"
  | "proxy_creation_uncertain"
  | "api_token_expired"
  | "network_error"
  | "request_timeout"
  | "invalid_response"
  | "proxy_certificate_invalid"
  | "proxy_controlled_by_extension"
  | "proxy_controlled_by_policy"
  | "private_browsing_required"
  | "host_permissions_required"
  | "proxy_authentication_failed"
  | "session_expired"
  | "traffic_guard_failed"
  | "webrtc_control_unavailable"
  | "email_delivery_unavailable"
  | "unknown_error";

export interface LogoutOutcome {
  apiSession: "pending" | "confirmed" | "unconfirmed";
  proxySessions: "pending" | "confirmed" | "unconfirmed";
}

export interface AppSnapshot extends LanguageState {
  webLoginPending?: boolean;
  snapshotVersion?: { workerId: string; revision: number };
  logoutOutcome?: LogoutOutcome | null;
  siteExclusions: SiteExclusionsState;
  blockingScope?: "none" | "all" | "except_excluded" | "unverified";
  network: NetworkObservation;
  locationPreferences: LocationPreferencesState;
  status: MachineState;
  protected: boolean;
  profile: Profile | null;
  subscription: BillingSubscription | null;
  locations: Location[];
  locationsStatus?: "idle" | "loading" | "ready" | "error";
  locationsError?: AppErrorCode | null;
  devices: Device[];
  deviceLimit: number | null;
  currentDeviceId: string | null;
  selectedLocationId: string | null;
  activeLocationId: string | null;
  activeLocation?: Location | null;
  vpnNodeAddress?: string | null;
  vpnNodeAddressStatus?: "idle" | "checking" | "ready" | "unavailable";
  autoConnect: boolean;
  error: AppErrorCode | null;
  retryAfterSeconds: number | null;
  securityPreferences: { killSwitchEnabled: boolean; webRtcProtectionEnabled: boolean };
  protectionRequested: boolean;
  trafficBlocked: boolean;
  webRtcProtected: boolean;
  nextRetryAt: number | null;
}

export const EMPTY_SNAPSHOT: AppSnapshot = {
  webLoginPending: false,
  logoutOutcome: null,
  siteExclusions: structuredClone(EMPTY_SITE_EXCLUSIONS),
  blockingScope: "none",
  network: { ...EMPTY_NETWORK_OBSERVATION },
  locationPreferences: { ...EMPTY_LOCATION_PREFERENCES },
  languagePreference: "auto",
  effectiveLanguage: "en",
  status: "logged_out",
  protected: false,
  profile: null,
  subscription: null,
  locations: [],
  locationsStatus: "idle",
  locationsError: null,
  devices: [],
  deviceLimit: null,
  currentDeviceId: null,
  selectedLocationId: null,
  activeLocationId: null,
  activeLocation: null,
  vpnNodeAddress: null,
  autoConnect: false,
  error: null,
  retryAfterSeconds: null,
  securityPreferences: { killSwitchEnabled: true, webRtcProtectionEnabled: true },
  protectionRequested: false,
  trafficBlocked: false,
  webRtcProtected: false,
  nextRetryAt: null,
};
