// SPDX-License-Identifier: MPL-2.0

export const API_BASE_URL = "https://api.fuzevpn.com";

export const SITE_URLS = {
  register: "https://app.fuzevpn.com/register",
  forgotPassword: "https://app.fuzevpn.com/forgot-password",
  dashboard: "https://app.fuzevpn.com/dashboard",
  extensionConnect: "https://app.fuzevpn.com/extension/connect",
} as const;

export const API_TIMEOUT_MS = 15_000;
export const PROXY_AUTH_RESTORE_TIMEOUT_MS = 15_000;
export const PROXY_EXPIRY_MARGIN_MS = 5_000;
export const REFRESH_RETRY_MS = 30_000;
export const MAX_REFRESH_ATTEMPTS = 3;
/**
 * The expiry of a session is no failed attempt: its reconnection is due at once. The
 * alarm, set this little ahead so that it can be verified, serves a worker which ends
 * before making it.
 */
export const EXPIRY_RECONNECT_DELAY_MS = 1_000;
/**
 * How long an unanswered proxy session creation suspends automatic retries. It must
 * cover the lifetime of a proxy session: once it has passed, a session which that
 * request may have created has expired, and creating another one duplicates nothing.
 * The server issues sessions of ten minutes, and the request itself ends within
 * API_TIMEOUT_MS: eleven minutes leave a margin over both. Raise it with that lifetime.
 */
export const PROXY_CREATION_UNCERTAINTY_MS = 11 * 60_000;
/**
 * How long a worker which starts relies on the profile, the subscription and the
 * catalogue an earlier one received, without reading them from the API again. Opening
 * the popup refreshes them whatever their age, and a connection reads the subscription
 * and the catalogue itself: this only bounds what nobody is looking at.
 */
export const ACCOUNT_REFRESH_INTERVAL_MS = 60 * 60_000;
/**
 * How long a worker which starts may take to find a protected connection exactly in
 * place before it touches the traffic guard. These are local reads of a few
 * milliseconds: one which does not answer must not leave the allowance standing
 * unchecked, and the guard is then closed first, as it is whenever anything is in doubt.
 */
export const STARTUP_PREFLIGHT_TIMEOUT_MS = 1_000;

/**
 * How long a connection must have lasted for a failure to start the retry delays over.
 * It is the longest of these delays: a node which gives sessions and fails them at once
 * is then retried less and less often, in place of every thirty seconds for ever.
 */
export const STABLE_CONNECTION_MS = 5 * 60_000;
/**
 * Each retry delay is moved by up to this share either way, so that the clients which
 * a same outage disconnected do not all come back at the same instant.
 */
export const RETRY_SPREAD = 0.2;

/**
 * How often those who only read the state have a restoration which the guard refused
 * tried again for them. A command, or an event which reports a change, tries it at once:
 * this only spares a full restoration at each poll of an open popup, and on Firefox at
 * each web request, for as long as the refusal lasts.
 */
export const RESTORATION_RETRY_MS = 30_000;

export const ALARM_REFRESH = "fuzevpn-proxy-refresh";
export const ALARM_EXPIRY = "fuzevpn-proxy-expiry";
export const ALARM_RECONNECT = "fuzevpn-proxy-reconnect";
