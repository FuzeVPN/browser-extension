// SPDX-License-Identifier: MPL-2.0

import type { WebAuthIdentity } from "../contracts/web-auth";

export function readWebAuthIdentity(): WebAuthIdentity {
  if (typeof browser === "undefined") throw new Error("web_login_unavailable");
  const identity = (browser as Partial<Pick<typeof browser, "identity">>).identity;
  if (!identity) throw new Error("web_login_unavailable");
  return {
    getRedirectURL: (path) => identity.getRedirectURL(path),
    launchWebAuthFlow: (details) => identity.launchWebAuthFlow(details),
    // No `watchAuthenticationTab`: Firefox does not show an extension the address of the
    // tab of its identity window, even with every host permission granted. That window
    // cannot be told from another one for certain, and is left open when an attempt is
    // given up, as before.
  };
}

export function isValidRedirectUri(url: URL): boolean {
  return /^[a-f0-9]{40}\.extensions\.allizom\.org$/.test(url.hostname);
}
