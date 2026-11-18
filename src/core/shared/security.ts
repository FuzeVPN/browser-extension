// SPDX-License-Identifier: MPL-2.0

export interface SecurityState {
  killSwitchEnabled: boolean;
  webRtcProtectionEnabled: boolean;
  protectionRequested: boolean;
  reconnectAttempts: number;
  nextRetryAt: number | null;
  retrySuspended: boolean;
  proxyCreationUncertain: boolean;
  /**
   * When the unanswered creation stops suspending automatic retries: a session it may
   * have created has expired by then. Absent, the marker suspends them until it is
   * settled, as it does once a failure has suspended them for a cause of its own.
   */
  proxyCreationUncertainUntil?: number;
  proxyCleanupUncertain: boolean;
  /**
   * When every session the cleanup marker may stand for has expired: nothing is left to
   * revoke from then on, and the next worker or logout ends the marker. Absent on a
   * marker stored by an earlier version, which the worker reading it dates.
   */
  proxyCleanupUncertainUntil?: number;
  retryNotBefore: number | null;
  selectedLocationId: string | null;
  /** A confirmed full target remains paused until a deliberate connection action. */
  capacityBlockedLocationId?: string | null;
  /** Why retries are suspended, when only the user can resolve it. */
  suspensionCause?: SuspensionCause;
  /**
   * Why the retry which nextRetryAt schedules is needed. Kept with that retry only, for
   * a worker which starts before it: it reports the failure it finds, not a generic one.
   */
  retryCause?: RetryCause;
  /**
   * How far the retry delays have grown. Unlike reconnectAttempts, a connection which
   * succeeds does not end it: only one which lasted does, or a deliberate disconnection.
   */
  backoffLevel?: number;
  /** Since when protection has been up without a failure. Absent while it is down. */
  connectedSince?: number;
}

/** The failures after which the connection is tried again by itself. */
export const RETRY_CAUSES = [
  "network_error",
  "request_timeout",
  "proxy_unavailable",
  "capacity_unavailable",
  "proxy_certificate_invalid",
  "session_expired",
  "rate_limited",
] as const;

export type RetryCause = (typeof RETRY_CAUSES)[number];

export function isRetryCause(value: unknown): value is RetryCause {
  return RETRY_CAUSES.some((cause) => cause === value);
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

/** The state with its creation marker set or settled; the deadline never outlives the marker. */
export function withCreationUncertainty(state: SecurityState, uncertain: boolean): SecurityState {
  const next = { ...state, proxyCreationUncertain: uncertain };
  if (!uncertain) delete next.proxyCreationUncertainUntil;
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
