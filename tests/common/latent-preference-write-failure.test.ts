// SPDX-License-Identifier: MPL-2.0

import { ApiError } from "../../src/core/api/client";
import { failedCommand } from "../../src/core/background/state-machine";
import { authenticatedState, createHarness } from "./helpers";

type Harness = ReturnType<typeof createHarness>;

const DEFAULTS = { killSwitchEnabled: true, webRtcProtectionEnabled: true };
const CHANGED = { killSwitchEnabled: false, webRtcProtectionEnabled: false };

async function signedIn(connected: boolean) {
  const h = createHarness({ persisted: authenticatedState() });
  await h.controller.initialize();
  await h.controller.refreshAccount();
  if (connected) {
    expect(await h.controller.connect("frankfurt-01")).toEqual({ ok: true });
    expect(h.controller.getSnapshot()).toMatchObject({ status: "connected", protected: true });
  }
  expect(h.controller.getSnapshot().securityPreferences).toEqual(DEFAULTS);
  expect(h.securityStorage.state).toMatchObject(DEFAULTS);
  return h;
}

function storedPreferences(h: Harness) {
  return {
    killSwitchEnabled: h.securityStorage.state?.killSwitchEnabled,
    webRtcProtectionEnabled: h.securityStorage.state?.webRtcProtectionEnabled,
  };
}

afterEach(() => vi.restoreAllMocks());

describe("a change of security preferences", () => {
  it("is published and stored when its write succeeds", async () => {
    const h = await signedIn(false);
    expect(await h.controller.updateSecurityPreferences(false, false)).toEqual({ ok: true });
    expect(storedPreferences(h)).toEqual(CHANGED);
    expect(h.controller.getSnapshot().securityPreferences).toEqual(CHANGED);
  });

  it.each([
    ["disconnected", false],
    ["connected", true],
  ] as const)("is not published when its write fails while %s", async (_label, connected) => {
    const h = await signedIn(connected);
    vi.spyOn(h.securityStorage, "write").mockRejectedValue(new Error("disk unavailable"));

    expect(await h.controller.updateSecurityPreferences(false, false)).toEqual({
      ok: false,
      commandError: "traffic_guard_failed",
    });

    // Nothing was stored: a restarted worker would read the previous preferences.
    expect(storedPreferences(h)).toEqual(DEFAULTS);
    // The failed command must not show the popup values which were never saved.
    expect(h.controller.getSnapshot().securityPreferences).toEqual(storedPreferences(h));
  });
});

describe("a location selection whose security write fails", () => {
  it("does not redirect the next retry to the location it failed to select", async () => {
    const h = await signedIn(false);
    // Requested protection waits for a retry after a failed account read.
    vi.spyOn(h.api, "getProfile").mockRejectedValueOnce(new ApiError("server_error", 503));
    expect(await h.controller.connect("frankfurt-01")).toEqual({
      ok: false,
      commandError: "proxy_unavailable",
    });
    expect(h.controller.getSnapshot()).toMatchObject({
      protectionRequested: true,
      protected: false,
      selectedLocationId: "frankfurt-01",
    });

    vi.spyOn(h.securityStorage, "write").mockRejectedValueOnce(new Error("disk unavailable"));
    // Rejected or returned, the worker answers this command with its failure.
    expect(await h.controller.selectLocation("frankfurt-02").catch(failedCommand)).toEqual({
      ok: false,
      commandError: "traffic_guard_failed",
    });
    // The failed selection is neither shown nor stored as the protection target.
    expect(h.controller.getSnapshot().selectedLocationId).toBe("frankfurt-01");
    expect(h.securityStorage.state?.selectedLocationId).toBe("frankfurt-01");

    expect(await h.controller.retryConnection()).toEqual({ ok: true });
    expect(h.controller.getSnapshot()).toMatchObject({
      status: "connected",
      protected: true,
      activeLocationId: "frankfurt-01",
      selectedLocationId: "frankfurt-01",
    });
  });
});
