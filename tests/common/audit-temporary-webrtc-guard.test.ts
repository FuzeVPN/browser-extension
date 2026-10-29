// SPDX-License-Identifier: MPL-2.0

import { ApiError } from "../../src/core/api/client";
import { DEFAULT_SECURITY_STATE } from "../../src/core/shared/security";
import { authenticatedState, createHarness, proxySession } from "./helpers";

describe("temporary WebRTC confinement with the optional preference disabled", () => {
  afterEach(() => vi.restoreAllMocks());

  it("keeps WebRTC confined until the new session route is authorized", async () => {
    const h = createHarness({
      persisted: authenticatedState(),
      security: { ...DEFAULT_SECURITY_STATE, webRtcProtectionEnabled: false },
    });
    await h.controller.initialize();
    const create = h.api.createProxySession.bind(h.api);
    vi.spyOn(h.api, "createProxySession").mockImplementation(async (...args) => {
      expect(h.safety.status).toMatchObject({ trafficBlocked: true, webRtcProtected: true });
      expect(await h.proxy.isGuardedConfiguration()).toBe(true);
      return create(...args);
    });
    const allow = h.safety.allow.bind(h.safety);
    vi.spyOn(h.safety, "allow").mockImplementation(async () => {
      expect(h.safety.status.webRtcProtected).toBe(true);
      expect(await h.proxy.isActiveConfiguration(h.proxy.active!)).toBe(true);
      await allow();
    });
    expect(await h.controller.connect("frankfurt-01")).toEqual({ ok: true });
    expect(h.controller.getSnapshot()).toMatchObject({
      protected: true,
      trafficBlocked: false,
      webRtcProtected: false,
      securityPreferences: { killSwitchEnabled: true, webRtcProtectionEnabled: false },
    });
  });

  it("retains the temporary policy throughout a failed connection and preference update", async () => {
    const h = createHarness({
      persisted: authenticatedState(),
      security: { ...DEFAULT_SECURITY_STATE, webRtcProtectionEnabled: false },
    });
    h.api.createError = new ApiError("device_limit", 409);
    expect(await h.controller.connect("frankfurt-01")).toMatchObject({ ok: false });
    expect(h.controller.getSnapshot()).toMatchObject({
      protected: false,
      trafficBlocked: true,
      webRtcProtected: true,
    });
    await h.controller.updateSecurityPreferences(true, false);
    expect(h.controller.getSnapshot()).toMatchObject({
      protected: false,
      trafficBlocked: true,
      webRtcProtected: true,
    });
    await h.controller.disconnect();
    expect(h.controller.getSnapshot()).toMatchObject({
      trafficBlocked: false,
      webRtcProtected: false,
    });
  });

  it("arms WebRTC before restoring an existing session with the preference disabled", async () => {
    const session = proxySession("restored-with-optional-webrtc-off");
    const h = createHarness({
      persisted: authenticatedState({ autoConnect: true }),
      security: {
        ...DEFAULT_SECURITY_STATE,
        protectionRequested: true,
        webRtcProtectionEnabled: false,
      },
      transient: { proxySession: session, refreshAttempts: 0, retiredSessions: [] },
      activeProxy: session,
    });
    const allow = h.safety.allow.bind(h.safety);
    vi.spyOn(h.safety, "allow").mockImplementation(async () => {
      expect(h.safety.status.webRtcProtected).toBe(true);
      await allow();
    });
    await h.controller.initialize();
    expect(h.api.proofs).toHaveLength(0);
    expect(h.controller.getSnapshot()).toMatchObject({
      protected: true,
      webRtcProtected: false,
      trafficBlocked: false,
    });
  });
});
