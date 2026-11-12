// SPDX-License-Identifier: MPL-2.0

import { ApiError, NetworkError } from "../../src/core/api/client";
import { ALARM_RECONNECT, ALARM_REFRESH } from "../../src/core/shared/config";
import { DEFAULT_SECURITY_STATE } from "../../src/core/shared/security";
import { AUTH, authenticatedState, createHarness, NOW, PROFILE } from "./helpers";

/** A connection which failed before any session was requested: its retry is scheduled. */
async function failedConnection(killSwitchEnabled = false) {
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
  expect(h.controller.getSnapshot()).toMatchObject({
    status: killSwitchEnabled ? "blocked" : "error",
    error: "network_error",
    nextRetryAt: NOW + 30_000,
  });
  return h;
}

afterEach(() => vi.restoreAllMocks());

describe("the reason of a failed connection across account requests", () => {
  it("does not come back once another publication replaced the error shown", async () => {
    const h = await failedConnection();
    vi.spyOn(h.api, "getProfile").mockRejectedValueOnce(new ApiError("server_error", 503));
    expect(await h.controller.refreshAccount()).toMatchObject({ ok: false });
    expect(h.controller.getSnapshot().error).toBe("proxy_unavailable");

    // A selection publishes its own outcome, which owns the error from then on.
    expect(await h.controller.selectLocation("frankfurt-02")).toEqual({ ok: true });
    expect(h.controller.getSnapshot().error).toBeNull();

    expect(await h.controller.refreshAccount()).toEqual({ ok: true });
    expect(h.controller.getSnapshot().error).toBeNull();
  });

  it("is not replaced by a proxy takeover which has ended", async () => {
    const h = await failedConnection(true);
    // Another extension takes the proxy, then an account read fails during that takeover.
    h.proxy.level = "controlled_by_other_extensions";
    await h.controller.handleProxyControlLost("controlled_by_other_extensions");
    expect(h.controller.getSnapshot().error).toBe("proxy_controlled_by_extension");
    vi.spyOn(h.api, "getProfile").mockRejectedValueOnce(new ApiError("server_error", 503));
    expect(await h.controller.refreshAccount()).toMatchObject({ ok: false });

    // The takeover ends: the route verification alone reports it.
    h.proxy.level = "controllable_by_this_extension";
    await h.controller.handleProxyControlLost("controllable_by_this_extension");

    expect(await h.controller.refreshAccount()).toEqual({ ok: true });
    expect(h.controller.getSnapshot().error).not.toBe("proxy_controlled_by_extension");
  });
});

describe("device commands refused for an account without a profile", () => {
  it.each([
    ["deleteDevice", (h: ReturnType<typeof createHarness>) => h.controller.deleteDevice("remote")],
    [
      "resetDeviceIdentity",
      (h: ReturnType<typeof createHarness>) => h.controller.resetDeviceIdentity(),
    ],
  ] as const)("leave the stored credential untouched: %s", async (_name, command) => {
    const h = createHarness();
    await h.controller.initialize();
    vi.spyOn(h.api, "getProfile").mockRejectedValueOnce(new NetworkError("network"));
    expect(await h.controller.login(PROFILE.email, "synthetic")).toMatchObject({ ok: false });
    expect(h.storage.persisted).toMatchObject({ auth: AUTH, profile: null });
    const published = h.snapshots.length;

    expect(await command(h)).toMatchObject({ ok: false });

    // The refused command reports itself and changes nothing else.
    expect(h.storage.persisted).toMatchObject({ auth: AUTH, profile: null });
    expect(h.snapshots).toHaveLength(published);
  });
});

describe("a reconnect alarm after a renewal which already ended", () => {
  it("still makes its attempt while the status rests on refreshing", async () => {
    const h = createHarness({ persisted: authenticatedState() });
    await h.controller.initialize();
    expect(await h.controller.connect("frankfurt-01")).toEqual({ ok: true });

    // A refused renewal keeps the live session and leaves the status on refreshing.
    h.api.createError = new ApiError("rate_limited", 429, 90);
    await h.controller.handleAlarm(ALARM_REFRESH);
    expect(h.controller.getSnapshot()).toMatchObject({ status: "refreshing", protected: true });

    // The user retries by hand: the delay asked by the server defers it to an alarm.
    expect(await h.controller.retryConnection()).toEqual({
      ok: false,
      commandError: "rate_limited",
    });
    const retryAt = h.securityStorage.state?.nextRetryAt;
    expect(retryAt).toBe(h.alarms.reconnectAt);
    expect(retryAt).toBeGreaterThan(NOW);

    h.api.createError = null;
    const attempts = h.api.proofs.length;
    h.setNow(retryAt!);
    await h.controller.handleAlarm(ALARM_RECONNECT);
    expect(h.api.proofs.length).toBeGreaterThan(attempts);
    expect(h.controller.getSnapshot()).toMatchObject({ status: "connected", protected: true });
  });
});
