// SPDX-License-Identifier: MPL-2.0

import { ApiError, NetworkError } from "../../src/core/api/client";
import { AUTH, authenticatedState, createHarness, PROFILE } from "./helpers";

const REMOTE_DEVICE = {
  deviceId: "remote-device",
  name: "Other browser",
  kind: "browser_extension" as const,
  createdAt: "2026-08-26T12:00:00Z",
  profiles: [],
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

async function blockedByQuota(revoked: boolean) {
  const harness = createHarness({ persisted: authenticatedState() });
  harness.api.devices.devices = [REMOTE_DEVICE];
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
  expect(await harness.controller.refreshDevices()).toEqual({ ok: true });
  expect(harness.controller.getSnapshot()).toMatchObject({
    error: revoked ? "device_revoked_limit" : "device_limit",
    protectionRequested: true,
    protected: false,
    trafficBlocked: true,
    nextRetryAt: null,
  });
  harness.api.enrollError = null;
  return harness;
}

async function pendingDeletion(revoked: boolean) {
  const harness = await blockedByQuota(revoked);
  const entered = deferred<undefined>();
  const listing = deferred<typeof harness.api.devices>();
  vi.spyOn(harness.api, "getDevices").mockImplementationOnce(async () => {
    entered.resolve(undefined);
    return listing.promise;
  });
  const deletion = harness.controller.deleteDevice(REMOTE_DEVICE.deviceId);
  await entered.promise;
  expect(harness.api.deletedDevices).toEqual([REMOTE_DEVICE.deviceId]);
  expect(harness.controller.getSnapshot().devices).toEqual([]);
  return { harness, listing, deletion };
}

describe("quota recovery after a confirmed remote-device deletion", () => {
  it.each([false, true])(
    "resumes once even when the follow-up device list fails (revoked=%s)",
    async (revoked) => {
      const harness = await blockedByQuota(revoked);
      const enrollments = harness.api.enrollCalls;
      const proofs = harness.api.proofs.length;
      const recoveryKey = harness.api.enrollments.at(-1)?.publicKey;
      vi.spyOn(harness.api, "getDevices").mockRejectedValueOnce(new NetworkError("network"));

      await harness.controller.deleteDevice(REMOTE_DEVICE.deviceId);

      expect(harness.api.deletedDevices).toEqual([REMOTE_DEVICE.deviceId]);
      expect(harness.api.enrollCalls).toBe(enrollments + 1);
      expect(harness.api.proofs).toHaveLength(proofs + 1);
      expect(harness.api.enrollments.at(-1)?.publicKey).toBe(recoveryKey);
      expect(harness.controller.getSnapshot()).toMatchObject({
        profile: PROFILE,
        protectionRequested: true,
        protected: true,
        trafficBlocked: false,
        activeLocationId: "frankfurt-01",
        nextRetryAt: null,
      });
      expect(await harness.controller.refreshDevices()).toEqual({ ok: true });
      expect(await harness.controller.refreshAccount()).toEqual({ ok: true });
      expect(harness.api.enrollCalls).toBe(enrollments + 1);
      expect(harness.api.proofs).toHaveLength(proofs + 1);
    },
  );

  it.each([false, true])(
    "resumes once when a newer successful list overtakes the deletion list (revoked=%s)",
    async (revoked) => {
      const { harness, listing, deletion } = await pendingDeletion(revoked);
      const enrollments = harness.api.enrollCalls;
      const proofs = harness.api.proofs.length;
      const recoveryKey = harness.api.enrollments.at(-1)?.publicKey;
      const duplicate = harness.controller.deleteDevice(REMOTE_DEVICE.deviceId);

      expect(await harness.controller.refreshDevices()).toEqual({ ok: true });
      listing.resolve(structuredClone(harness.api.devices));
      await Promise.all([deletion, duplicate]);

      expect(harness.api.deletedDevices).toEqual([REMOTE_DEVICE.deviceId]);
      expect(harness.api.enrollCalls).toBe(enrollments + 1);
      expect(harness.api.proofs).toHaveLength(proofs + 1);
      expect(harness.api.enrollments.at(-1)?.publicKey).toBe(recoveryKey);
      expect(harness.controller.getSnapshot()).toMatchObject({
        error: null,
        protectionRequested: true,
        protected: true,
        trafficBlocked: false,
        activeLocationId: "frankfurt-01",
        nextRetryAt: null,
      });
      expect(await harness.controller.refreshDevices()).toEqual({ ok: true });
      expect(harness.api.enrollCalls).toBe(enrollments + 1);
      expect(harness.api.proofs).toHaveLength(proofs + 1);
    },
  );

  it.each([false, true])(
    "uses only one recovery when two different remote deletions complete together (revoked=%s)",
    async (revoked) => {
      const harness = await blockedByQuota(revoked);
      const secondDevice = { ...REMOTE_DEVICE, deviceId: "second-remote-device" };
      harness.api.devices.devices = [REMOTE_DEVICE, secondDevice];
      expect(await harness.controller.refreshDevices()).toEqual({ ok: true });
      const enrollments = harness.api.enrollCalls;
      const proofs = harness.api.proofs.length;
      const entered = deferred<undefined>();
      const listing = deferred<typeof harness.api.devices>();
      let requests = 0;
      vi.spyOn(harness.api, "getDevices").mockImplementation(async () => {
        requests += 1;
        if (requests === 2) entered.resolve(undefined);
        return listing.promise;
      });

      const firstDeletion = harness.controller.deleteDevice(REMOTE_DEVICE.deviceId);
      const secondDeletion = harness.controller.deleteDevice(secondDevice.deviceId);
      await entered.promise;
      listing.resolve(structuredClone(harness.api.devices));
      await Promise.all([firstDeletion, secondDeletion]);

      expect(harness.api.deletedDevices).toEqual([REMOTE_DEVICE.deviceId, secondDevice.deviceId]);
      expect(harness.api.enrollCalls).toBe(enrollments + 1);
      expect(harness.api.proofs).toHaveLength(proofs + 1);
      expect(harness.controller.getSnapshot()).toMatchObject({
        protected: true,
        trafficBlocked: false,
        activeLocationId: "frankfurt-01",
      });
    },
  );

  it.each([false, true])(
    "does not recover an account rejected by the follow-up list (revoked=%s)",
    async (revoked) => {
      const harness = await blockedByQuota(revoked);
      const enrollments = harness.api.enrollCalls;
      const proofs = harness.api.proofs.length;
      vi.spyOn(harness.api, "getDevices").mockRejectedValueOnce(new ApiError("unauthorized", 401));

      expect(await harness.controller.deleteDevice(REMOTE_DEVICE.deviceId)).toEqual({
        ok: false,
        commandError: "unauthorized",
      });

      expect(harness.api.deletedDevices).toEqual([REMOTE_DEVICE.deviceId]);
      expect(harness.api.enrollCalls).toBe(enrollments);
      expect(harness.api.proofs).toHaveLength(proofs);
      expect(harness.controller.getSnapshot()).toMatchObject({
        profile: null,
        protectionRequested: true,
        protected: false,
        trafficBlocked: true,
        nextRetryAt: null,
        error: "unauthorized",
      });
    },
  );

  for (const revoked of [false, true]) {
    it.each(["disconnect", "logout", "replace-account", "connect"] as const)(
      `does not replay an old recovery after %s while its list is pending (revoked=${String(revoked)})`,
      async (action) => {
        const { harness, listing, deletion } = await pendingDeletion(revoked);
        const enrollments = harness.api.enrollCalls;
        const proofs = harness.api.proofs.length;

        if (action === "logout") {
          expect(await harness.controller.logout()).toEqual({ ok: true });
        } else if (action === "connect") {
          expect(await harness.controller.connect("frankfurt-02")).toEqual({ ok: true });
          expect(harness.api.enrollCalls).toBe(enrollments + 1);
          expect(harness.api.proofs).toHaveLength(proofs + 1);
          expect(harness.controller.getSnapshot()).toMatchObject({
            protected: true,
            activeLocationId: "frankfurt-02",
          });
        } else {
          expect(await harness.controller.disconnect()).toEqual({ ok: true });
          if (action === "replace-account") {
            harness.api.auth = { ...AUTH, accessToken: "synthetic-account-b" };
            harness.api.profile = {
              ...PROFILE,
              userId: "account-b",
              email: "b@example.invalid",
            };
            expect(await harness.controller.login(harness.api.profile.email, "synthetic")).toEqual({
              ok: true,
            });
          }
        }
        const snapshot = harness.controller.getSnapshot();
        const finalEnrollments = harness.api.enrollCalls;
        const finalProofs = harness.api.proofs.length;

        listing.resolve({ limit: 2, devices: [REMOTE_DEVICE] });
        await expect(deletion).resolves.toMatchObject({ ok: false, superseded: true });

        expect(harness.controller.getSnapshot()).toEqual(snapshot);
        expect(harness.api.enrollCalls).toBe(finalEnrollments);
        expect(harness.api.proofs).toHaveLength(finalProofs);
        if (action !== "connect") {
          expect(harness.api.enrollCalls).toBe(enrollments);
          expect(harness.api.proofs).toHaveLength(proofs);
          expect(harness.controller.getSnapshot()).toMatchObject({
            protectionRequested: false,
            protected: false,
            trafficBlocked: false,
          });
        }
      },
    );
  }

  it.each(["failed", "overtaken"])(
    "keeps current-device deletion disconnected when the list is %s",
    async (outcome) => {
      const harness = createHarness({ persisted: authenticatedState() });
      harness.identity.deviceId = "current-device";
      harness.api.devices.devices = [{ ...REMOTE_DEVICE, deviceId: "current-device" }];
      harness.api.createError = new ApiError("device_limit", 409);
      await harness.controller.connect("frankfurt-01");
      expect(harness.controller.getSnapshot().error).toBe("device_limit");
      expect(await harness.controller.refreshDevices()).toEqual({ ok: true });
      const enrollments = harness.api.enrollCalls;
      const proofs = harness.api.proofs.length;
      harness.api.createError = null;

      if (outcome === "failed") {
        vi.spyOn(harness.api, "getDevices").mockRejectedValueOnce(new NetworkError("network"));
        await harness.controller.deleteDevice("current-device");
      } else {
        const entered = deferred<undefined>();
        const listing = deferred<typeof harness.api.devices>();
        vi.spyOn(harness.api, "getDevices").mockImplementationOnce(async () => {
          entered.resolve(undefined);
          return listing.promise;
        });
        const deleting = harness.controller.deleteDevice("current-device");
        await entered.promise;
        expect(await harness.controller.refreshDevices()).toEqual({ ok: true });
        listing.resolve(structuredClone(harness.api.devices));
        await deleting;
      }

      expect(harness.api.deletedDevices).toEqual(["current-device"]);
      expect(harness.api.enrollCalls).toBe(enrollments);
      expect(harness.api.proofs).toHaveLength(proofs);
      expect(await harness.identity.getDeviceId(PROFILE.userId)).toBeNull();
      expect(harness.controller.getSnapshot()).toMatchObject({
        currentDeviceId: null,
        protectionRequested: false,
        protected: false,
        trafficBlocked: false,
        nextRetryAt: null,
      });
      expect(harness.alarms.reconnectAt).toBeNull();
    },
  );
});
