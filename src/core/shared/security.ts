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
  /** Why retries are suspended, when only the user can resolve it. */
  suspensionCause?: SuspensionCause;
}

/**
 * Refusals of the account itself. Unlike a local condition, which every startup checks
 * again, they are still the reason of a suspended protection after a worker restart.
 */
export const SUSPENSION_CAUSES = [
  "subscription_required",
  "email_verification_required",
  "device_limit",
  "device_revoked_limit",
] as const;

export type SuspensionCause = (typeof SUSPENSION_CAUSES)[number];

export function isSuspensionCause(value: unknown): value is SuspensionCause {
  return SUSPENSION_CAUSES.some((cause) => cause === value);
}

/** The state with its suspension cause set, or removed when there is none. */
export function withSuspensionCause(state: SecurityState, cause: unknown): SecurityState {
  const next = { ...state };
  if (isSuspensionCause(cause)) next.suspensionCause = cause;
  else delete next.suspensionCause;
  return next;
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
