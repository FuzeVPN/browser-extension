// SPDX-License-Identifier: MPL-2.0

export interface SecurityState {
  killSwitchEnabled: boolean;
  webRtcProtectionEnabled: boolean;
  protectionRequested: boolean;
  reconnectAttempts: number;
  nextRetryAt: number | null;
  retrySuspended: boolean;
  proxyCreationUncertain: boolean;
  proxyCleanupUncertain: boolean;
  retryNotBefore: number | null;
  selectedLocationId: string | null;
  /** A confirmed full target remains paused until a deliberate connection action. */
  capacityBlockedLocationId?: string | null;
}

export const DEFAULT_SECURITY_STATE: SecurityState = {
  killSwitchEnabled: true,
  webRtcProtectionEnabled: true,
  protectionRequested: false,
  reconnectAttempts: 0,
  nextRetryAt: null,
  retrySuspended: false,
  proxyCreationUncertain: false,
  proxyCleanupUncertain: false,
  retryNotBefore: null,
  selectedLocationId: null,
  capacityBlockedLocationId: null,
};

export interface SecurityStatus {
  trafficBlocked: boolean;
  webRtcProtected: boolean;
  filterActive: boolean;
  /** Verified scope of the guard; excluded destinations may remain reachable. */
  blockingScope?: "none" | "all" | "except_excluded" | "unverified";
}
