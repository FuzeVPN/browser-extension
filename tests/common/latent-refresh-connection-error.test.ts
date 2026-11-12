// SPDX-License-Identifier: MPL-2.0

import { ApiError, NetworkError } from "../../src/core/api/client";
import { DEFAULT_SECURITY_STATE } from "../../src/core/shared/security";
import { authenticatedState, createHarness, NOW } from "./helpers";

type Harness = ReturnType<typeof createHarness>;

const KILL_SWITCH = [
  ["on", true, "blocked"],
  ["off", false, "error"],
] as const;

const ACCOUNT_READS = [
  ["refreshAccount", (h: Harness) => h.controller.refreshAccount()],
  ["refreshDevices", (h: Harness) => h.controller.refreshDevices()],
  ["resendVerification", (h: Harness) => h.controller.resendVerification()],
] as const;

/** A connection which failed before any session was requested: its retry is scheduled. */
async function failedConnection(killSwitchEnabled: boolean, status: "blocked" | "error") {
  const h = createHarness({
    persisted: authenticatedState(),
    security: { ...DEFAULT_SECURITY_STATE, killSwitchEnabled },
  });
  await h.controller.initialize();
  vi.spyOn(h.api, "getProfile").mockRejectedValueOnce(new NetworkError("network"));
  expect(await h.controller.connect("frankfurt-01")).toEqual({
    ok: false,
    commandError: "network_error",
  });
  expect(h.api.proofs).toHaveLength(0);
  expect(h.alarms.reconnectAt).toBe(NOW + 30_000);
  expect(h.controller.getSnapshot()).toMatchObject({
    status,
    protected: false,
    protectionRequested: true,
    trafficBlocked: killSwitchEnabled,
    error: "network_error",
    nextRetryAt: NOW + 30_000,
  });
  return h;
}

describe("the reason of a failed connection while its retry is pending", () => {
  afterEach(() => vi.restoreAllMocks());

  it.each(KILL_SWITCH)(
    "stays displayed after a catalog refresh with the kill switch %s",
    async (_label, killSwitchEnabled, status) => {
      const h = await failedConnection(killSwitchEnabled, status);
      expect(await h.controller.refreshLocations()).toEqual({ ok: true });
      expect(h.controller.getSnapshot()).toMatchObject({
        status,
        error: "network_error",
        nextRetryAt: NOW + 30_000,
      });
    },
  );

  describe.each(ACCOUNT_READS)("after a successful %s", (_name, read) => {
    it.each(KILL_SWITCH)(
      "stays displayed with the kill switch %s",
      async (_label, killSwitchEnabled, status) => {
        const h = await failedConnection(killSwitchEnabled, status);
        expect(await read(h)).toEqual({ ok: true });

        // The connection outcome did not change: it is still failed, with the same retry.
        expect(h.alarms.reconnectAt).toBe(NOW + 30_000);
        expect(h.controller.getSnapshot()).toMatchObject({
          status,
          protected: false,
          protectionRequested: true,
          nextRetryAt: NOW + 30_000,
        });
        expect(h.controller.getSnapshot().error).toBe("network_error");
      },
    );
  });

  it("comes back once an account read which failed meanwhile succeeds again", async () => {
    const h = await failedConnection(false, "error");
    vi.spyOn(h.api, "getProfile").mockRejectedValueOnce(new ApiError("server_error", 503));
    expect(await h.controller.refreshAccount()).toEqual({
      ok: false,
      commandError: "proxy_unavailable",
    });
    // The failed read reports itself while it lasts.
    expect(h.controller.getSnapshot()).toMatchObject({
      status: "error",
      error: "proxy_unavailable",
      nextRetryAt: NOW + 30_000,
    });

    expect(await h.controller.refreshAccount()).toEqual({ ok: true });
    expect(h.controller.getSnapshot()).toMatchObject({
      status: "error",
      error: "network_error",
      nextRetryAt: NOW + 30_000,
    });
  });
});
