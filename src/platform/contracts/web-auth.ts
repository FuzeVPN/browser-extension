// SPDX-License-Identifier: MPL-2.0

/** The tab of a web authentication, once the platform has seen it. */
export interface AuthenticationTab {
  /** Closes the tab if it was seen and is still open. Never fails. */
  close(): Promise<void>;
  /** Stops watching for it, and leaves it to the browser. */
  release(): void;
}

export interface WebAuthIdentity {
  getRedirectURL(path: string): string;
  launchWebAuthFlow(details: { url: string; interactive: true }): Promise<string | undefined>;
  /**
   * Watches for the tab which is about to show `url`, the page of a web authentication.
   * A platform which cannot see tabs omits it: the window then stays open when the
   * attempt is given up.
   */
  watchAuthenticationTab?(url: string): AuthenticationTab;
}
