// SPDX-License-Identifier: MPL-2.0

import type { BrowserEnvironment } from "../contracts/environment";
export type { BrowserEnvironment, BrowserName } from "../contracts/environment";

export async function detectBrowserEnvironment(
  source: unknown = typeof navigator === "undefined" ? undefined : navigator,
): Promise<BrowserEnvironment> {
  const environment: BrowserEnvironment = { browserName: "unknown" };
  try {
    const info = await browser.runtime.getBrowserInfo();
    if (isVersion(info.version)) return { ...environment, browserVersion: info.version };
  } catch {
    /* Keep the server-compatible name even when the optional API is absent. */
  }
  const userAgent =
    source !== null && typeof source === "object" && "userAgent" in source
      ? source.userAgent
      : undefined;
  const version =
    typeof userAgent === "string"
      ? /Firefox\/([0-9]{1,5}(?:\.[0-9]{1,5}){0,3})(?:\s|$)/.exec(userAgent)?.[1]
      : undefined;
  return { ...environment, ...(isVersion(version) ? { browserVersion: version } : {}) };
}

export function browserDeviceName(_environment: BrowserEnvironment): string {
  return "Firefox";
}

function isVersion(value: unknown): value is string {
  return typeof value === "string" && /^[0-9]{1,5}(?:\.[0-9]{1,5}){0,3}$/.test(value);
}
