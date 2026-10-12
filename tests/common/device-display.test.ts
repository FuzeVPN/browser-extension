// SPDX-License-Identifier: MPL-2.0

import { deviceDisplayName } from "../../src/ui/popup/device-display";

const device = { deviceId: "current", kind: "browser_extension", name: "Firefox" } as const;

describe("Firefox device names", () => {
  it.each(["Browser", "Chrome", "Firefox", "browser", "chrome", "firefox"])(
    "localizes the current legacy %s installation as Firefox",
    (name) => {
      expect(deviceDisplayName({ ...device, name }, "current", "Navigateur Firefox")).toBe(
        "Navigateur Firefox",
      );
      expect(deviceDisplayName({ ...device, name }, "current", "متصفح Firefox")).toBe(
        "متصفح Firefox",
      );
    },
  );

  it.each(["Browser", "Chrome", "Firefox", "Google Chrome", "Brave"])(
    "does not attribute the local browser to another %s installation",
    (name) => {
      for (const currentDeviceId of ["another", null]) {
        expect(deviceDisplayName({ ...device, name }, currentDeviceId, "Navigateur Firefox")).toBe(
          name,
        );
      }
    },
  );

  it.each(["Travail", "Firefox – Windows", "المكتب", "Google Chrome", "Brave"])(
    "preserves the actual or custom name %s",
    (name) => {
      expect(deviceDisplayName({ ...device, name }, "current", "Navigateur Firefox")).toBe(name);
    },
  );

  it("does not rename another device kind", () => {
    expect(deviceDisplayName({ ...device, kind: "vpn" }, "current", "Navigateur Firefox")).toBe(
      "Firefox",
    );
  });
});
