// SPDX-License-Identifier: MPL-2.0

import { ApiError, NetworkError } from "../../src/core/api/client";
import { AUTH, authenticatedState, createHarness, PROFILE } from "./helpers";

async function blockedByDeviceQuota(revoked: boolean) {
  const harness = createHarness({ persisted: authenticatedState() });
  if (revoked) {
    harness.identity.deviceId = "old-device";
    const create = harness.api.createProxySession.bind(harness.api);
    harness.api.createProxySession = async (...args) => {
      if (args[2].deviceId === "old-device") throw new ApiError("device_identity_revoked", 403);
      return create(...args);
    };
  }
  harness.api.enrollError = new ApiError("device_limit", 409);
  await harness.controller.connect("frankfurt-01");
  expect(harness.controller.getSnapshot()).toMatchObject({
    error: revoked ? "device_revoked_limit" : "device_limit",
    protectionRequested: true,
    protected: false,
    trafficBlocked: true,
  });
  return harness;
}

describe("device quota recovery across account refresh", () => {
  it.each([false, true])(
    "preserves the quota and resumes after removing another device (revoked=%s)",
    async (revoked) => {
      const harness = await blockedByDeviceQuota(revoked);
      const quotaError = revoked ? "device_revoked_limit" : "device_limit";
      const enrollmentCalls = harness.api.enrollCalls;
      const recoveryKey = harness.api.enrollments.at(-1)?.publicKey;

      expect(await harness.controller.refreshAccount()).toEqual({ ok: true });
      expect(harness.controller.getSnapshot()).toMatchObject({
        error: quotaError,
        protectionRequested: true,
        protected: false,
        trafficBlocked: true,
      });
      harness.api.enrollError = null;
      expect(await harness.controller.deleteDevice("another-device")).toEqual({ ok: true });

      expect(harness.api.enrollCalls).toBe(enrollmentCalls + 1);
      expect(harness.api.enrollments.at(-1)?.publicKey).toBe(recoveryKey);
      expect(harness.api.deletedDevices).toEqual(["another-device"]);
      expect(harness.controller.getSnapshot()).toMatchObject({
        error: null,
        status: "connected",
        profile: PROFILE,
        protectionRequested: true,
        protected: true,
        trafficBlocked: false,
      });
      expect(harness.proxy.active?.locationId).toBe("frankfurt-01");
    },
  );

  it("retains the pending quota when a transient device-list failure changes the displayed error", async () => {
    const harness = await blockedByDeviceQuota(true);
    const enrollmentCalls = harness.api.enrollCalls;
    vi.spyOn(harness.api, "getDevices").mockRejectedValueOnce(new NetworkError("network"));
    expect(await harness.controller.refreshDevices()).toEqual({
      ok: false,
      commandError: "network_error",
    });
    expect(harness.controller.getSnapshot().error).toBe("network_error");

    expect(await harness.controller.refreshAccount()).toEqual({ ok: true });
    expect(harness.controller.getSnapshot().error).toBe("device_revoked_limit");
    harness.api.enrollError = null;
    expect(await harness.controller.deleteDevice("another-device")).toEqual({ ok: true });
    expect(harness.api.enrollCalls).toBe(enrollmentCalls + 1);
    expect(harness.controller.getSnapshot().protected).toBe(true);
  });

  it("does not carry a quota into the next account after an explicit disconnect", async () => {
    const harness = await blockedByDeviceQuota(true);
    expect(await harness.controller.disconnect()).toEqual({ ok: true });
    harness.api.auth = { ...AUTH, accessToken: "account-b-token" };
    harness.api.profile = { ...PROFILE, userId: "account-b", email: "b@example.invalid" };
    harness.api.enrollError = null;
    expect(await harness.controller.login(harness.api.profile.email, "synthetic")).toEqual({
      ok: true,
    });
    expect(await harness.controller.refreshAccount()).toEqual({ ok: true });
    const enrollmentCalls = harness.api.enrollCalls;
    expect(await harness.controller.deleteDevice("account-b-other-device")).toEqual({ ok: true });

    expect(harness.api.enrollCalls).toBe(enrollmentCalls);
    expect(harness.controller.getSnapshot()).toMatchObject({
      error: null,
      profile: { userId: "account-b" },
      protectionRequested: false,
      protected: false,
      trafficBlocked: false,
    });
    expect(await harness.identity.getDeviceId("account-b")).toBeNull();
  });

  it("keeps deletion of the current device disconnected even after quota recovery was requested", async () => {
    const harness = createHarness({ persisted: authenticatedState() });
    harness.identity.deviceId = "current-device";
    harness.api.createError = new ApiError("device_limit", 409);
    await harness.controller.connect("frankfurt-01");
    expect(harness.controller.getSnapshot().error).toBe("device_limit");
    expect(await harness.controller.refreshAccount()).toEqual({ ok: true });
    const enrollmentCalls = harness.api.enrollCalls;
    const proofs = harness.api.proofs.length;

    harness.api.createError = null;
    expect(await harness.controller.deleteDevice("current-device")).toEqual({ ok: true });

    expect(harness.api.deletedDevices).toEqual(["current-device"]);
    expect(harness.api.enrollCalls).toBe(enrollmentCalls);
    expect(harness.api.proofs).toHaveLength(proofs);
    expect(await harness.identity.getDeviceId(PROFILE.userId)).toBeNull();
    expect(harness.controller.getSnapshot()).toMatchObject({
      currentDeviceId: null,
      error: null,
      status: "disconnected",
      protectionRequested: false,
      protected: false,
      trafficBlocked: false,
    });
    expect(harness.alarms.reconnectAt).toBeNull();
  });
});
