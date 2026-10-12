// SPDX-License-Identifier: MPL-2.0

import { WebAuthError } from "../../core/auth/web-auth";
import type { WebAuthIdentity } from "../contracts/web-auth";
export type { WebAuthIdentity } from "../contracts/web-auth";

export function readWebAuthIdentity(): WebAuthIdentity {
  if (typeof chrome === "undefined") throw new WebAuthError("web_login_unavailable");
  const identity = (chrome as Partial<Pick<typeof chrome, "identity">>).identity;
  if (!identity) throw new WebAuthError("web_login_unavailable");
  return {
    getRedirectURL: (path) => identity.getRedirectURL(path),
    launchWebAuthFlow: (details) => identity.launchWebAuthFlow(details),
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
