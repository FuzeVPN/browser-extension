// SPDX-License-Identifier: MPL-2.0

export interface WebAuthIdentity {
  getRedirectURL(path: string): string;
  launchWebAuthFlow(details: { url: string; interactive: true }): Promise<string | undefined>;
}
