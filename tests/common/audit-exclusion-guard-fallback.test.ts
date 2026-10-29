// SPDX-License-Identifier: MPL-2.0

import { SafetyError } from "../../src/core/background/network-safety";
import {
  emptySiteExclusionRecord,
  type SiteExclusionRecord,
} from "../../src/core/storage/site-exclusion-storage";
import { authenticatedState, createHarness } from "./helpers";

describe("independent guards during a disconnected exclusion transaction", () => {
  afterEach(() => vi.restoreAllMocks());

  it("installs the proxy and HTTP guards even when WebRTC policy cannot be applied", async () => {
    let record: SiteExclusionRecord = emptySiteExclusionRecord();
    const h = createHarness({
      persisted: authenticatedState(),
      siteExclusionStorage: {
        async read() {
          return structuredClone(record);
        },
        async write(next) {
          record = structuredClone(next);
        },
      },
    });
    await h.controller.initialize();
    await h.controller.refreshAccount();
    const applyWebRtc = h.safety.setWebRtc.bind(h.safety);
    vi.spyOn(h.safety, "setWebRtc").mockImplementation(async (enabled) => {
      if (enabled) throw new SafetyError("webrtc_control_unavailable");
      await applyWebRtc(enabled);
    });
    const ensureProxy = vi.spyOn(h.proxy, "ensureBlockingConfiguration");

    await expect(
      h.controller.updateSiteExclusions(0, true, [
        { domain: "example.com", includeSubdomains: true },
      ]),
    ).rejects.toMatchObject({ code: "webrtc_control_unavailable" });

    expect(ensureProxy).toHaveBeenCalled();
    expect(h.proxy.blockingRoute).toBe(true);
    expect(await h.proxy.isGuardedConfiguration()).toBe(true);
    expect(h.safety.status.filterActive).toBe(true);
    expect(h.safety.status.trafficBlocked).toBe(true);
    expect(h.controller.getSnapshot()).toMatchObject({
      protected: false,
      trafficBlocked: false,
      blockingScope: "unverified",
      siteExclusions: { pending: true, error: true },
    });
    expect(record.pending).toBe(true);
    expect(h.api.proofs).toHaveLength(0);
  });
});
