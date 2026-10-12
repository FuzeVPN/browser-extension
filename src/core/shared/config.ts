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

export const ALARM_REFRESH = "fuzevpn-proxy-refresh";
export const ALARM_EXPIRY = "fuzevpn-proxy-expiry";
export const ALARM_RECONNECT = "fuzevpn-proxy-reconnect";
