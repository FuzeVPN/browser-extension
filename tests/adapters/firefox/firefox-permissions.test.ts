// SPDX-License-Identifier: MPL-2.0

import { ProxyControlError } from "../../../src/core/background/proxy-controller";
import { diagnosticEnvironment, diagnosticError } from "../../../src/core/diagnostics/collector";
import { authenticatedState, createHarness, proxySession } from "../../common/helpers";

describe("Firefox permission loss", () => {
  it.each(["private_browsing_required", "host_permissions_required"] as const)(
    "blocks a connected session and shows the local %s instruction",
    async (code) => {
      const h = createHarness({ persisted: authenticatedState() });
      await h.controller.connect("frankfurt-01");
      expect(h.controller.getSnapshot().protected).toBe(true);
      const session = await h.controller.getActiveSession();
      vi.spyOn(h.proxy, "assertControllable").mockRejectedValue(new ProxyControlError(code));
      await h.controller.handleProxyPermissionsChanged();
      expect(h.controller.getSnapshot()).toMatchObject({
        protected: false,
        error: code,
        trafficBlocked: true,
      });
      expect(h.controller.isSessionCurrentForProxyAuth(session!)).toBe(false);
      expect(h.safety.events).toContain("suspend");
    },
  );

  it("does not change a deliberately disconnected session when permissions change", async () => {
    const h = createHarness({ persisted: authenticatedState() });
    await h.controller.initialize();
    h.safety.events.length = 0;
    await h.controller.handleProxyPermissionsChanged();
    expect(h.safety.events).toEqual([]);
    expect(h.controller.getSnapshot().status).toBe("disconnected");
  });

  it("reports missing host access before account refresh can obscure it as a network error", async () => {
    const h = createHarness({ persisted: authenticatedState() });
    await h.controller.initialize();
    // Finish the independent startup read before testing the new connect command.
    await h.controller.refreshAccount();
    const accountRead = vi
      .spyOn(h.api, "getLocations")
      .mockRejectedValue(new Error("network failure"));
    vi.spyOn(h.proxy, "assertControllable").mockRejectedValue(
      new ProxyControlError("host_permissions_required"),
    );
    const result = await h.controller.connect("frankfurt-01");
    expect(result).toMatchObject({ ok: false, commandError: "host_permissions_required" });
    expect(accountRead).not.toHaveBeenCalled();
  });

  it("never re-authorizes a restored proxy after host access was revoked during sleep", async () => {
    const session = proxySession();
    const h = createHarness({
      persisted: authenticatedState({ autoConnect: true }),
      transient: { proxySession: session, refreshAttempts: 0, retiredSessions: [] },
      activeProxy: session,
    });
    vi.spyOn(h.proxy, "assertControllable").mockRejectedValue(
      new ProxyControlError("host_permissions_required"),
    );
    await h.controller.initialize();
    expect(h.controller.getSnapshot()).toMatchObject({ protected: false, trafficBlocked: true });
    expect(h.safety.events).not.toContain("allow");
  });

  it("blocks when predictive-network protection is lost even while WebRTC remains protected", async () => {
    const h = createHarness({ persisted: authenticatedState() });
    await h.controller.connect("frankfurt-01");
    h.safety.status.filterActive = false;
    expect(h.safety.status.webRtcProtected).toBe(true);
    await h.controller.handlePrivacyChange();
    expect(h.controller.getSnapshot()).toMatchObject({
      protected: false,
      trafficBlocked: true,
      error: "traffic_guard_failed",
    });
  });
});

describe("Firefox diagnostics preserve the API contract", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("reports the real Firefox version without inventing a server browser enum", async () => {
    vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0 private-machine Firefox/156.0" });
    vi.stubGlobal("browser", {
      runtime: { getPlatformInfo: async () => ({ os: "win", arch: "x86-64" }) },
    });
    expect(await diagnosticEnvironment()).toEqual({
      browser_name: "unknown",
      browser_version: "156.0",
      os_family: "windows",
      architecture: "x64",
    });
  });

  it.each(["private_browsing_required", "host_permissions_required"])(
    "maps local %s hints to an existing diagnostic code",
    (code) => {
      expect(diagnosticError(code).code).toBe("proxy_controlled_by_policy");
    },
  );
});
