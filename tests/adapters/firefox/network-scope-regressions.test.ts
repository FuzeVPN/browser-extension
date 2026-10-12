// SPDX-License-Identifier: MPL-2.0

import {
  PlatformProxyService,
  proxyConfig,
  type ProxySettingsResult,
} from "../../../src/core/background/proxy-controller";
import { PlatformNetworkSafetyService } from "../../../src/core/background/network-safety";
import { proxySession } from "../../common/helpers";

function fixture(incognitoAllowed = true) {
  type ProxySetting = ProxySettingsResult;
  interface PrivacySetting {
    value: string;
    levelOfControl: string;
    incognitoSpecific?: boolean;
  }
  const state: { proxy: ProxySetting; privacy: PrivacySetting } = {
    proxy: {
      value: proxyConfig(proxySession()),
      levelOfControl: "controlled_by_this_extension",
    },
    privacy: { value: "disable_non_proxied_udp", levelOfControl: "controlled_by_this_extension" },
  };
  const proxyGet = vi.fn(async (query: Record<string, unknown>) => {
    expect(query).toEqual({});
    return structuredClone(state.proxy);
  });
  const proxySet = vi.fn(async ({ value }: { value: browser.proxy.ProxyConfig }) => {
    state.proxy = { value, levelOfControl: "controlled_by_this_extension" };
  });
  const privacyGet = vi.fn(async ({ incognito }: { incognito?: boolean }) =>
    structuredClone(
      incognito ? { ...state.privacy, levelOfControl: "not_controllable" } : state.privacy,
    ),
  );
  const privacySet = vi.fn(async ({ value }: { value: string }) => {
    state.privacy = { value, levelOfControl: "controlled_by_this_extension" };
  });
  const permission = vi.fn(async () => incognitoAllowed);
  vi.stubGlobal("browser", {
    extension: { isAllowedIncognitoAccess: permission },
    runtime: {
      id: "fuzevpn-firefox@vpn1euro.com",
      getURL: () => "moz-extension://bca3eea0-32d4-497c-bd3b-4ae589202204/",
    },
    permissions: { contains: async () => true },
    proxy: {
      settings: {
        get: proxyGet,
        set: proxySet,
        clear: async () => {
          state.proxy = {
            value: { proxyType: "none" },
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
            state.privacy = { value: "default", levelOfControl: "controllable_by_this_extension" };
          },
        },
      },
    },
    storage: { session: { get: async () => ({}), set: async () => undefined } },
    declarativeNetRequest: { getDynamicRules: async () => [], getSessionRules: async () => [] },
  });
  return { state, proxyGet, proxySet, privacyGet, privacySet, permission };
}

describe("Firefox global proxy and privacy settings", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("rejects a global Firefox proxy takeover before installing or authenticating a session", async () => {
    const { state, proxySet, proxyGet } = fixture();
    state.proxy = {
      value: { proxyType: "none" },
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
    expect(proxyGet.mock.calls.every(([query]) => Object.keys(query).length === 0)).toBe(true);
  });

  it("does not query a private scope the user has not authorized", async () => {
    const { proxyGet, privacyGet, proxySet } = fixture(false);
    await expect(new PlatformProxyService().isActiveConfiguration(proxySession())).resolves.toBe(
      true,
    );
    await expect(new PlatformProxyService().apply(proxySession())).rejects.toThrow(
      "private_browsing_required",
    );
    expect(proxySet).not.toHaveBeenCalled();
    expect((await new PlatformNetworkSafetyService().inspect()).webRtcProtected).toBe(true);
    expect(
      [...proxyGet.mock.calls, ...privacyGet.mock.calls].every(([query]) => !query.incognito),
    ).toBe(true);
  });

  it("requires the complete expected PAC policy in the global Firefox setting", async () => {
    const { state } = fixture();
    state.proxy = {
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

  it("does not declare WebRTC protection when the global policy is overridden", async () => {
    const { state, privacySet } = fixture();
    state.privacy = {
      value: "default",
      levelOfControl: "controlled_by_other_extensions",
      incognitoSpecific: true,
    };
    const safety = new PlatformNetworkSafetyService();
    expect((await safety.inspect()).webRtcProtected).toBe(false);
    await expect(safety.setWebRtc(true)).rejects.toThrow("webrtc_control_unavailable");
    expect(privacySet).not.toHaveBeenCalled();
  });

  it("verifies Firefox global privacy without querying the unsupported private setting scope", async () => {
    const { permission, privacyGet } = fixture();
    const proxy = new PlatformProxyService();
    const safety = new PlatformNetworkSafetyService();
    await expect(proxy.isActiveConfiguration(proxySession())).resolves.toBe(true);
    await safety.setWebRtc(true);
    expect((await safety.inspect()).webRtcProtected).toBe(true);
    permission.mockRejectedValue(new Error("permission unavailable"));
    await expect(proxy.assertControllable()).rejects.toThrow("permission unavailable");
    expect((await safety.inspect()).webRtcProtected).toBe(true);
    expect(privacyGet.mock.calls.every(([query]) => Object.keys(query).length === 0)).toBe(true);
    privacyGet.mockRejectedValue(new Error("privacy unreadable"));
    expect((await safety.inspect()).webRtcProtected).toBe(false);
  });
});
