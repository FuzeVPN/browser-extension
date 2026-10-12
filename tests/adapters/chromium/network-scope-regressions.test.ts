// SPDX-License-Identifier: MPL-2.0

import { PlatformProxyService, proxyConfig } from "../../../src/platform/chromium/proxy-controller";
import { PlatformNetworkSafetyService } from "../../../src/platform/chromium/network-safety";
import { proxySession } from "./helpers";

function fixture(incognitoAllowed = true) {
  type ProxySetting = chrome.types.ChromeSettingGetResult<chrome.proxy.ProxyConfig>;
  type PrivacySetting = chrome.types.ChromeSettingGetResult<string>;
  let regularProxy: ProxySetting = {
    value: proxyConfig(proxySession()),
    levelOfControl: "controlled_by_this_extension",
  };
  let regularPrivacy: PrivacySetting = {
    value: "disable_non_proxied_udp",
    levelOfControl: "controlled_by_this_extension",
  };
  const state: { privateProxy: ProxySetting | null; privatePrivacy: PrivacySetting | null } = {
    privateProxy: null,
    privatePrivacy: null,
  };
  const proxyGet = vi.fn(async ({ incognito }: { incognito?: boolean }) =>
    structuredClone(incognito ? (state.privateProxy ?? regularProxy) : regularProxy),
  );
  const proxySet = vi.fn(async ({ value }: { value: chrome.proxy.ProxyConfig }) => {
    regularProxy = { value, levelOfControl: "controlled_by_this_extension" };
  });
  const privacyGet = vi.fn(async ({ incognito }: { incognito?: boolean }) =>
    structuredClone(incognito ? (state.privatePrivacy ?? regularPrivacy) : regularPrivacy),
  );
  const privacySet = vi.fn(async ({ value }: { value: string }) => {
    regularPrivacy = { value, levelOfControl: "controlled_by_this_extension" };
  });
  const permission = vi.fn(async () => incognitoAllowed);
  vi.stubGlobal("chrome", {
    extension: { isAllowedIncognitoAccess: permission },
    runtime: { id: "abcdefghijklmnopabcdefghijklmnop" },
    proxy: {
      settings: {
        get: proxyGet,
        set: proxySet,
        clear: async () => {
          regularProxy = {
            value: { mode: "direct" },
            levelOfControl: "controllable_by_this_extension",
          };
        },
      },
    },
    privacy: {
      network: {
        webRTCIPHandlingPolicy: {
          get: privacyGet,
          set: privacySet,
          clear: async () => {
            regularPrivacy = { value: "default", levelOfControl: "controllable_by_this_extension" };
          },
        },
      },
    },
    storage: { session: { get: async () => ({}), set: async () => undefined } },
    declarativeNetRequest: { getDynamicRules: async () => [], getSessionRules: async () => [] },
  });
  return { state, proxyGet, proxySet, privacyGet, privacySet, permission };
}

describe("effective private-window protection", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("rejects an incognito-only proxy takeover before installing or authenticating a session", async () => {
    const { state, proxySet } = fixture();
    state.privateProxy = {
      value: { mode: "direct" },
      levelOfControl: "controlled_by_other_extensions",
      incognitoSpecific: true,
    };
    const proxy = new PlatformProxyService();
    await expect(proxy.getControlLevel()).resolves.toBe("controlled_by_other_extensions");
    await expect(proxy.isActiveConfiguration(proxySession())).resolves.toBe(false);
    await expect(proxy.isConfiguredProxyChallenge(proxySession())).resolves.toBe(false);
    await expect(proxy.isExclusionConfiguration()).resolves.toBe(false);
    await expect(proxy.apply(proxySession())).rejects.toThrow("controlled_by_other_extensions");
    expect(proxySet).not.toHaveBeenCalled();
    // Explicit disconnect still releases our regular setting without touching the other extension.
    await proxy.clear();
    expect(state.privateProxy.value.mode).toBe("direct");
  });

  it("does not query a private scope the user has not authorized", async () => {
    const { state, proxyGet, privacyGet } = fixture(false);
    state.privateProxy = {
      value: { mode: "direct" },
      levelOfControl: "controlled_by_other_extensions",
    };
    await expect(new PlatformProxyService().isActiveConfiguration(proxySession())).resolves.toBe(
      true,
    );
    expect((await new PlatformNetworkSafetyService().inspect()).webRtcProtected).toBe(true);
    expect(
      [...proxyGet.mock.calls, ...privacyGet.mock.calls].every(([query]) => !query.incognito),
    ).toBe(true);
  });

  it("requires the same complete bypass policy in both effective scopes", async () => {
    const { state } = fixture();
    state.privateProxy = {
      value: proxyConfig(proxySession(), [{ domain: "example.com", includeSubdomains: false }]),
      levelOfControl: "controlled_by_this_extension",
      incognitoSpecific: true,
    };
    await expect(new PlatformProxyService().isActiveConfiguration(proxySession())).resolves.toBe(
      false,
    );
    await expect(new PlatformProxyService().updateExistingExclusions([], [])).rejects.toThrow(
      "configuration_rejected",
    );
  });

  it("does not declare WebRTC protection when only the private policy is overridden", async () => {
    const { state, privacySet } = fixture();
    state.privatePrivacy = {
      value: "default",
      levelOfControl: "controlled_by_other_extensions",
      incognitoSpecific: true,
    };
    const safety = new PlatformNetworkSafetyService();
    expect((await safety.inspect()).webRtcProtected).toBe(false);
    await expect(safety.setWebRtc(true)).rejects.toThrow("webrtc_control_unavailable");
    expect(privacySet).not.toHaveBeenCalled();
    await safety.setWebRtc(false);
    expect(state.privatePrivacy.value).toBe("default");
  });

  it("accepts inherited private settings and refuses an unreadable private permission", async () => {
    const { permission } = fixture();
    const proxy = new PlatformProxyService();
    const safety = new PlatformNetworkSafetyService();
    await expect(proxy.isActiveConfiguration(proxySession())).resolves.toBe(true);
    await safety.setWebRtc(true);
    expect((await safety.inspect()).webRtcProtected).toBe(true);
    permission.mockRejectedValue(new Error("permission unavailable"));
    await expect(proxy.isActiveConfiguration(proxySession())).rejects.toThrow(
      "permission unavailable",
    );
    expect((await safety.inspect()).webRtcProtected).toBe(false);
  });
});
