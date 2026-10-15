// SPDX-License-Identifier: MPL-2.0

import type { Location } from "../api/types";

/** Only public location fields, and only for the selected identifier. */
export function selectedLocationMetadata(value: unknown, id: string | null): Location | null {
  if (!id || !value || typeof value !== "object") return null;
  const location = value as Partial<Location>;
  if (
    location.id !== id ||
    typeof location.city !== "string" ||
    typeof location.countryCode !== "string" ||
    !/^[A-Za-z]{2}$/.test(location.countryCode) ||
    typeof location.displayName !== "string" ||
    !Array.isArray(location.supportedProtocols) ||
    !location.supportedProtocols.every((protocol) => typeof protocol === "string") ||
    !location.supportedProtocols.includes("browser_proxy")
  )
    return null;
  return {
    id,
    city: location.city,
    countryCode: location.countryCode,
    displayName: location.displayName,
    supportedProtocols: [...location.supportedProtocols],
  };
}
