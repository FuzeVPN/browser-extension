// SPDX-License-Identifier: MPL-2.0

import {
  browserDeviceName,
  detectBrowserEnvironment,
} from "../../../src/platform/firefox/environment";

afterEach(() => vi.unstubAllGlobals());

describe("Firefox browser identity and server vocabulary", () => {
  it("uses the actual runtime version while preserving unknown in diagnostics", async () => {
    vi.stubGlobal("browser", {
      runtime: { getBrowserInfo: async () => ({ name: "Firefox", version: "157.0.1" }) },
    });
    expect(await detectBrowserEnvironment({ userAgent: "Firefox/140.0 Chrome/200.0" })).toEqual({
      browserName: "unknown",
      browserVersion: "157.0.1",
    });
    expect(browserDeviceName({ browserName: "unknown" })).toBe("Firefox");
  });
  it("falls back to the Firefox numeric version when the native API is unavailable", async () => {
    vi.stubGlobal("browser", {
      runtime: {
        getBrowserInfo: async () => {
          throw new Error("unavailable");
        },
      },
    });
    expect(await detectBrowserEnvironment({ userAgent: "private-host Firefox/156.0.2" })).toEqual({
      browserName: "unknown",
      browserVersion: "156.0.2",
    });
  });
  it("does not infer Chromium product names or retain arbitrary user agent data", async () => {
    vi.stubGlobal("browser", undefined);
    expect(
      await detectBrowserEnvironment({ userAgent: "private-host Chrome/141.0 Edg/142.0" }),
    ).toEqual({ browserName: "unknown" });
  });
});
