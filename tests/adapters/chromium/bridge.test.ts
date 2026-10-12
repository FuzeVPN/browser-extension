// SPDX-License-Identifier: MPL-2.0

import {
  configureTrustedStorage,
  extensionApi,
  hasExtensionApi,
  inspectWebRtc,
} from "../../../src/platform/chromium/bridge";

afterEach(() => vi.unstubAllGlobals());

describe("Chromium platform boundary", () => {
  it("resolves the browser API after import and after a fixture changes", () => {
    vi.stubGlobal("chrome", undefined);
    expect(hasExtensionApi()).toBe(false);
    expect(() => extensionApi.runtime).toThrow("Extension API unavailable");
    vi.stubGlobal("chrome", { runtime: { id: "first" } });
    expect(extensionApi.runtime.id).toBe("first");
    vi.stubGlobal("chrome", { runtime: { id: "second" } });
    expect(extensionApi.runtime.id).toBe("second");
  });

  it("does not continue with unprotected storage and can retry a failed initialization", async () => {
    const local = vi
      .fn()
      .mockRejectedValueOnce(new Error("storage policy rejected"))
      .mockResolvedValue(undefined);
    const session = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("chrome", {
      storage: { local: { setAccessLevel: local }, session: { setAccessLevel: session } },
    });
    await expect(configureTrustedStorage()).rejects.toThrow("storage policy rejected");
    await expect(configureTrustedStorage()).resolves.toBeUndefined();
    expect(local).toHaveBeenCalledWith({ accessLevel: "TRUSTED_CONTEXTS" });
    expect(session).toHaveBeenCalledTimes(2);
  });

  it("requires both the restrictive WebRTC policy and current ownership", async () => {
    const get = vi.fn().mockResolvedValue({
      value: "disable_non_proxied_udp",
      levelOfControl: "controlled_by_other_extensions",
    });
    vi.stubGlobal("chrome", { privacy: { network: { webRTCIPHandlingPolicy: { get } } } });
    expect(await inspectWebRtc()).toBe(false);
    get.mockResolvedValue({
      value: "disable_non_proxied_udp",
      levelOfControl: "controlled_by_this_extension",
    });
    expect(await inspectWebRtc()).toBe(true);
  });
});
