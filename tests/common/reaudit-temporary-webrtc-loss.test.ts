// SPDX-License-Identifier: MPL-2.0

import { ApiError } from "../../src/core/api/client";
import { SafetyError } from "../../src/core/background/network-safety";
import { DEFAULT_SECURITY_STATE } from "../../src/core/shared/security";
import {
  emptySiteExclusionRecord,
  type SiteExclusionRecord,
} from "../../src/core/storage/site-exclusion-storage";
import { authenticatedState, createHarness } from "./helpers";

async function temporarilyBlocked() {
  const h = createHarness({
    persisted: authenticatedState(),
    security: { ...DEFAULT_SECURITY_STATE, webRtcProtectionEnabled: false },
  });
  h.api.createError = new ApiError("device_limit", 409);
  expect(await h.controller.connect("frankfurt-01")).toMatchObject({ ok: false });
  expect(h.controller.getSnapshot()).toMatchObject({
    protectionRequested: true,
    protected: false,
    trafficBlocked: true,
    webRtcProtected: true,
    securityPreferences: { killSwitchEnabled: true, webRtcProtectionEnabled: false },
  });
  return h;
}

describe("mandatory temporary WebRTC policy after native privacy changes", () => {
  afterEach(() => vi.restoreAllMocks());

  it("restores a controllable policy and publishes the repaired block with the optional preference off", async () => {
    const h = await temporarilyBlocked();
    const publications = h.snapshots.length;
    const proofs = h.api.proofs.length;
    const rtc = vi.spyOn(h.safety, "setWebRtc");
    const allow = vi.spyOn(h.safety, "allow");
    h.safety.status.webRtcProtected = false;

    await h.controller.handlePrivacyChange();

    expect(rtc).toHaveBeenCalledWith(true);
    expect(h.snapshots.length).toBeGreaterThan(publications);
    expect(h.controller.getSnapshot()).toMatchObject({
      protected: false,
      trafficBlocked: true,
      blockingScope: "all",
      webRtcProtected: true,
      securityPreferences: { webRtcProtectionEnabled: false },
    });
    expect(h.snapshots.at(-1)).toEqual(h.controller.getSnapshot());
    expect(h.safety.status.filterActive).toBe(true);
    expect(await h.proxy.isGuardedConfiguration()).toBe(true);
    expect(await h.controller.getActiveSession()).toBeNull();
    expect(allow).not.toHaveBeenCalled();
    expect(h.api.proofs).toHaveLength(proofs);
  });

  it("publishes an unverified block if another owner refuses the mandatory temporary policy", async () => {
    const h = await temporarilyBlocked();
    const publications = h.snapshots.length;
    const proofs = h.api.proofs.length;
    const rtc = vi
      .spyOn(h.safety, "setWebRtc")
      .mockRejectedValue(new SafetyError("webrtc_control_unavailable"));
    const allow = vi.spyOn(h.safety, "allow");
    h.safety.status.webRtcProtected = false;

    await h.controller.handlePrivacyChange();

    expect(rtc).toHaveBeenCalledWith(true);
    expect(h.snapshots.length).toBeGreaterThan(publications);
    expect(h.controller.getSnapshot()).toMatchObject({
      protected: false,
      trafficBlocked: false,
      blockingScope: "unverified",
      webRtcProtected: false,
      error: "webrtc_control_unavailable",
    });
    for (const snapshot of h.snapshots.slice(publications)) {
      expect(snapshot).toMatchObject({
        trafficBlocked: false,
        blockingScope: "unverified",
        webRtcProtected: false,
      });
    }
    expect(h.snapshots.at(-1)).toEqual(h.controller.getSnapshot());
    expect(h.safety.status.filterActive).toBe(true);
    expect(await h.proxy.isGuardedConfiguration()).toBe(true);
    expect(await h.controller.getActiveSession()).toBeNull();
    expect(allow).not.toHaveBeenCalled();
    expect(h.api.proofs).toHaveLength(proofs);
  });

  it("repairs a requested WebRTC policy without discarding a valid authorized session", async () => {
    const h = createHarness({ persisted: authenticatedState() });
    expect(await h.controller.connect("frankfurt-01")).toEqual({ ok: true });
    const session = await h.controller.getActiveSession();
    const proofs = h.api.proofs.length;
    const publications = h.snapshots.length;
    const rtc = vi.spyOn(h.safety, "setWebRtc");
    h.safety.status.webRtcProtected = false;

    await h.controller.handlePrivacyChange();

    expect(rtc).toHaveBeenCalledWith(true);
    expect(h.snapshots.length).toBeGreaterThan(publications);
    expect(h.controller.getSnapshot()).toMatchObject({
      protected: true,
      trafficBlocked: false,
      webRtcProtected: true,
    });
    expect(await h.controller.getActiveSession()).toEqual(session);
    expect(h.api.proofs).toHaveLength(proofs);
  });

  it("retains the existing failure behavior when a requested policy is unavailable", async () => {
    const h = createHarness({ persisted: authenticatedState() });
    expect(await h.controller.connect("frankfurt-01")).toEqual({ ok: true });
    const proofs = h.api.proofs.length;
    const allow = vi.spyOn(h.safety, "allow");
    vi.spyOn(h.safety, "setWebRtc").mockRejectedValue(
      new SafetyError("webrtc_control_unavailable"),
    );
    h.safety.status.webRtcProtected = false;

    await h.controller.handlePrivacyChange();

    expect(h.controller.getSnapshot()).toMatchObject({
      protected: false,
      trafficBlocked: false,
      blockingScope: "unverified",
      webRtcProtected: false,
      error: "webrtc_control_unavailable",
    });
    expect(allow).not.toHaveBeenCalled();
    expect(h.api.proofs).toHaveLength(proofs);
  });

  it("keeps explicit disconnect released when a later privacy event arrives", async () => {
    const h = await temporarilyBlocked();
    expect(await h.controller.disconnect()).toEqual({ ok: true });
    const rtc = vi.spyOn(h.safety, "setWebRtc");
    const proofs = h.api.proofs.length;
    h.safety.status.webRtcProtected = false;

    await h.controller.handlePrivacyChange();

    expect(rtc).not.toHaveBeenCalledWith(true);
    expect(h.controller.getSnapshot()).toMatchObject({
      protectionRequested: false,
      protected: false,
      trafficBlocked: false,
      webRtcProtected: false,
    });
    expect(h.safety.status.filterActive).toBe(false);
    expect(await h.proxy.isGuardedConfiguration()).toBe(false);
    expect(h.api.proofs).toHaveLength(proofs);
  });

  it("repairs mandatory protection for a failed disconnected exclusion edit", async () => {
    let journal: SiteExclusionRecord = emptySiteExclusionRecord();
    const h = createHarness({
      persisted: authenticatedState(),
      security: { ...DEFAULT_SECURITY_STATE, webRtcProtectionEnabled: false },
      siteExclusionStorage: {
        async read() {
          return structuredClone(journal);
        },
        async write(next) {
          if (!next.pending) throw new Error("final exclusion commit unavailable");
          journal = structuredClone(next);
        },
      },
    });
    await h.controller.initialize();
    await expect(
      h.controller.updateSiteExclusions(0, true, [
        { domain: "example.com", includeSubdomains: false },
      ]),
    ).rejects.toThrow("final exclusion commit unavailable");
    expect(journal.pending).toBe(true);
    expect(h.controller.getSnapshot()).toMatchObject({
      protectionRequested: false,
      trafficBlocked: true,
      webRtcProtected: true,
      siteExclusions: { pending: true, error: true },
    });
    const rtc = vi.spyOn(h.safety, "setWebRtc");
    const allow = vi.spyOn(h.safety, "allow");
    const publications = h.snapshots.length;
    h.safety.status.webRtcProtected = false;

    await h.controller.handlePrivacyChange();

    expect(rtc).toHaveBeenCalledWith(true);
    expect(h.snapshots.length).toBeGreaterThan(publications);
    expect(h.controller.getSnapshot()).toMatchObject({
      protectionRequested: false,
      trafficBlocked: true,
      webRtcProtected: true,
      siteExclusions: { pending: true, error: true },
    });
    expect(await h.proxy.isGuardedConfiguration()).toBe(true);
    expect(h.safety.status.filterActive).toBe(true);
    expect(allow).not.toHaveBeenCalled();
    expect(h.api.proofs).toHaveLength(0);
  });
});
