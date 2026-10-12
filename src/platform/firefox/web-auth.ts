// SPDX-License-Identifier: MPL-2.0

import type { WebAuthIdentity } from "../contracts/web-auth";

export function readWebAuthIdentity(): WebAuthIdentity {
  if (typeof browser === "undefined") throw new Error("web_login_unavailable");
  const identity = (browser as Partial<Pick<typeof browser, "identity">>).identity;
  if (!identity) throw new Error("web_login_unavailable");
  return {
    getRedirectURL: (path) => identity.getRedirectURL(path),
    launchWebAuthFlow: (details) => identity.launchWebAuthFlow(details),
  };
}

export function isValidRedirectUri(url: URL): boolean {
  return /^[a-f0-9]{40}\.extensions\.allizom\.org$/.test(url.hostname);
}
