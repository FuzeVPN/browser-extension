// SPDX-License-Identifier: MPL-2.0

/** Values already accepted by the server; Firefox intentionally uses unknown. */
export type BrowserName = "unknown" | "chrome" | "edge" | "brave" | "opera" | "chromium";

export interface BrowserEnvironment {
  browserName: BrowserName;
  browserVersion?: string;
}
