// SPDX-License-Identifier: MPL-2.0

import type { Device } from "../../core/api/types";

/** The local browser cannot identify another installation on the account. */
export function deviceDisplayName(
  device: Pick<Device, "deviceId" | "kind" | "name">,
  currentDeviceId: string | null,
  currentBrowserLabel: string,
  genericBrowserLabel?: string,
): string {
  return device.kind === "browser_extension" &&
    device.deviceId === currentDeviceId &&
    /^(?:Browser|Chrome|Firefox)$/i.test(device.name)
    ? currentBrowserLabel
    : device.kind === "browser_extension" && /^Browser$/i.test(device.name) && genericBrowserLabel
      ? genericBrowserLabel
      : device.name;
}

export function deviceKindMessageKey(
  device: Pick<Device, "deviceId" | "kind">,
  currentDeviceId: string | null,
  currentBrowserName: string,
): "deviceKindFirefox" | "deviceKindBrowser" | "deviceKindVpn" {
  if (device.kind !== "browser_extension") return "deviceKindVpn";
  return device.deviceId === currentDeviceId && currentBrowserName === "Firefox"
    ? "deviceKindFirefox"
    : "deviceKindBrowser";
}
