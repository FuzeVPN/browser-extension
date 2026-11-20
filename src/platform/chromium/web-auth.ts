// SPDX-License-Identifier: MPL-2.0

import { WebAuthError } from "../../core/auth/web-auth";
import { watchAuthenticationTab } from "../../core/auth/authentication-tab";
import type { WebAuthIdentity } from "../contracts/web-auth";
export type { WebAuthIdentity } from "../contracts/web-auth";

export function readWebAuthIdentity(): WebAuthIdentity {
  if (typeof chrome === "undefined") throw new WebAuthError("web_login_unavailable");
  const identity = (chrome as Partial<Pick<typeof chrome, "identity">>).identity;
  if (!identity) throw new WebAuthError("web_login_unavailable");
  return {
    getRedirectURL: (path) => identity.getRedirectURL(path),
    launchWebAuthFlow: (details) => identity.launchWebAuthFlow(details),
    // The only uses of the tabs API beside the single read of proxy authentication, and
    // the audits hold them to these four calls: no list of tabs, no update, no capture.
    // Addresses of tabs are visible through the host permissions of the extension.
    watchAuthenticationTab: (url) =>
      watchAuthenticationTab(
        {
          onCreated: (listener) => chrome.tabs.onCreated.addListener(listener),
          offCreated: (listener) => chrome.tabs.onCreated.removeListener(listener),
          get: (tabId) => chrome.tabs.get(tabId),
          remove: (tabId) => chrome.tabs.remove(tabId),
        },
        url,
      ),
  };
}

/** The shared engine also compares the complete callback with the native expected URL. */
export function isValidRedirectUri(url: URL): boolean {
  return (
    url.protocol === "https:" &&
    /^[a-p]{32}\.chromiumapp\.org$/.test(url.hostname) &&
    !url.port &&
    !url.username &&
    !url.password &&
    url.pathname === "/auth" &&
    !url.search &&
    !url.hash
  );
}
