// SPDX-License-Identifier: MPL-2.0

import { inspectWebRtc } from "../../../src/platform/chromium/bridge";
import { PlatformNetworkSafetyService } from "../../../src/platform/chromium/network-safety";

interface PrivacySetting {
  value: string;
  levelOfControl: string;
}

const OWNED: PrivacySetting = {
  value: "disable_non_proxied_udp",
  levelOfControl: "controlled_by_this_extension",
};

function fixture(incognitoAccess: boolean) {
  const state = { regular: { ...OWNED }, private: { ...OWNED } };
  vi.stubGlobal("chrome", {
    extension: { isAllowedIncognitoAccess: async () => incognitoAccess },
    runtime: { id: "abcdefghijklmnopabcdefghijklmnop" },
    declarativeNetRequest: {
      getDynamicRules: async () => [],
      getSessionRules: async () => [],
    },
    privacy: {
      network: {
        webRTCIPHandlingPolicy: {
          get: async ({ incognito }: { incognito?: boolean }) => ({
            ...(incognito ? state.private : state.regular),
          }),
        },
      },
    },
  });
  return state;
}

describe("WebRTC protection stated by a diagnostic report", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("agrees with the safety inspection when a private window is not confined", async () => {
    const state = fixture(true);
    // Another extension holds an incognito-specific override of the policy.
    state.private = { value: "default", levelOfControl: "controlled_by_other_extensions" };

    const status = await new PlatformNetworkSafetyService().inspect();
    expect(status.webRtcProtected).toBe(false);
    expect(await inspectWebRtc()).toBe(status.webRtcProtected);
  });

  it("agrees with the safety inspection when every context is confined", async () => {
    fixture(true);

    const status = await new PlatformNetworkSafetyService().inspect();
    expect(status.webRtcProtected).toBe(true);
    expect(await inspectWebRtc()).toBe(status.webRtcProtected);
  });

  it("agrees with the safety inspection when private windows are out of scope", async () => {
    const state = fixture(false);
    state.private = { value: "default", levelOfControl: "controlled_by_other_extensions" };

    const status = await new PlatformNetworkSafetyService().inspect();
    expect(status.webRtcProtected).toBe(true);
    expect(await inspectWebRtc()).toBe(status.webRtcProtected);
  });
});
