// SPDX-License-Identifier: MPL-2.0

import { ApiError, NetworkError } from "../../src/core/api/client";
import { authenticatedState, createHarness, PROFILE } from "./helpers";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  return { promise, resolve, reject };
}

describe("device operations across account and connection changes", () => {
  it("does not restore a stale identity after its explicit reset completes", async () => {
    const harness = createHarness({ persisted: authenticatedState() });
    harness.identity.deviceId = "old-device";
    await harness.controller.initialize();
    const clearEntered = deferred<undefined>();
    const finishClear = deferred<undefined>();
    const finishReadingIdentity = deferred<undefined>();
    const identityRead = deferred<undefined>();
    const clearIdentity = harness.identity.clear.bind(harness.identity);
    harness.identity.clear = async (userId) => {
      clearEntered.resolve(undefined);
      await finishClear.promise;
      await clearIdentity(userId);
    };
    harness.identity.getDeviceId = async (userId) => {
      const oldIdentity = harness.identity.deviceIds.get(userId) ?? null;
      identityRead.resolve(undefined);
      await finishReadingIdentity.promise;
      return oldIdentity;
    };

    const reset = harness.controller.resetDeviceIdentity();
    await clearEntered.promise;
    const refresh = harness.controller.refreshDevices();
    await identityRead.promise;
    finishClear.resolve(undefined);
    await reset;
    expect(harness.controller.getSnapshot().currentDeviceId).toBeNull();
    finishReadingIdentity.resolve(undefined);
    await refresh;

    expect(harness.identity.deviceId).toBeNull();
    expect(harness.controller.getSnapshot().currentDeviceId).toBeNull();
    expect(harness.controller.getSnapshot().status).toBe("disconnected");
    expect(harness.controller.getSnapshot().profile?.userId).toBe(PROFILE.userId);
  });

  it("ignores an old deletion failure after login to a new account", async () => {
    const harness = createHarness({ persisted: authenticatedState() });
    await harness.controller.initialize();
    const deletion = deferred<undefined>();
    const entered = deferred<undefined>();
    harness.api.deleteDevice = async () => {
      entered.resolve(undefined);
      return deletion.promise;
    };
    const pending = harness.controller.deleteDevice("another-device");
    await entered.promise;
    harness.api.profile = { ...PROFILE, email: "new-account@example.com" };
    await harness.controller.login("new-account@example.com", "test-only");
    deletion.reject(new ApiError("unauthorized", 401));
    await pending;
    expect(harness.controller.getSnapshot().profile?.email).toBe("new-account@example.com");
    expect(harness.storage.persisted.profile?.email).toBe("new-account@example.com");
    expect(harness.controller.getSnapshot().error).toBeNull();
  });

  it("ignores an old post-deletion list failure after login to a new account", async () => {
    const harness = createHarness({ persisted: authenticatedState() });
    await harness.controller.initialize();
    const listing = deferred<Awaited<ReturnType<typeof harness.api.getDevices>>>();
    const entered = deferred<undefined>();
    harness.api.getDevices = async () => {
      entered.resolve(undefined);
      return listing.promise;
    };
    const pending = harness.controller.deleteDevice("another-device");
    await entered.promise;
    harness.api.profile = { ...PROFILE, email: "new-account@example.com" };
    await harness.controller.login("new-account@example.com", "test-only");
    listing.reject(new ApiError("unauthorized", 401));
    await pending;
    expect(harness.controller.getSnapshot().profile?.email).toBe("new-account@example.com");
    expect(harness.controller.getSnapshot().error).toBeNull();
  });

  it("removes a confirmed remote deletion before a slow refresh and keeps it removed on refresh failure", async () => {
    const harness = createHarness({ persisted: authenticatedState() });
    harness.identity.deviceId = "current-device";
    const current = {
      deviceId: "current-device",
      name: "Current browser",
      kind: "browser_extension" as const,
      createdAt: "2026-08-26T12:00:00Z",
      profiles: [],
    };
    const remote = { ...current, deviceId: "remote-device", name: "Other browser" };
    harness.api.devices.devices = [current, remote];
    await harness.controller.connect("frankfurt-01");
    await harness.controller.refreshDevices();
    const sessionId = harness.proxy.active?.id;
    const listing = deferred<Awaited<ReturnType<typeof harness.api.getDevices>>>();
    const entered = deferred<undefined>();
    harness.api.getDevices = async () => {
      entered.resolve(undefined);
      return listing.promise;
    };

    const pending = harness.controller.deleteDevice(remote.deviceId);
    await entered.promise;
    expect(harness.api.deletedDevices).toEqual([remote.deviceId]);
    expect(harness.controller.getSnapshot().devices).toEqual([current]);
    expect(harness.controller.getSnapshot().currentDeviceId).toBe(current.deviceId);
    listing.reject(new NetworkError("timeout"));

    await expect(pending).resolves.toEqual({ ok: false, commandError: "request_timeout" });
    expect(harness.controller.getSnapshot().devices).toEqual([current]);
    expect(harness.controller.getSnapshot().error).toBe("request_timeout");
    expect(harness.controller.getSnapshot().protected).toBe(true);
    expect(harness.proxy.active?.id).toBe(sessionId);
    expect(harness.identity.deviceId).toBe(current.deviceId);
    expect(harness.identity.clearCalls).toBe(0);
  });

  it.each(["different-account", "same-account"])(
    "does not filter a newer %s list when an old successful deletion finishes",
    async (account) => {
      const harness = createHarness({ persisted: authenticatedState() });
      await harness.controller.initialize();
      const deletion = deferred<undefined>();
      const entered = deferred<undefined>();
      harness.api.deleteDevice = async () => {
        entered.resolve(undefined);
        return deletion.promise;
      };
      const pending = harness.controller.deleteDevice("remote-device");
      await entered.promise;
      harness.api.profile = {
        ...PROFILE,
        userId: account === "same-account" ? PROFILE.userId : "new-account",
        email: "new-session@example.com",
      };
      await harness.controller.login("new-session@example.com", "test-only");
      const refreshed = {
        deviceId: "remote-device",
        name: "New session's device list",
        kind: "browser_extension" as const,
        createdAt: "2026-08-26T12:00:00Z",
        profiles: [],
      };
      harness.api.devices.devices = [refreshed];
      await harness.controller.refreshDevices();
      deletion.resolve(undefined);

      await expect(pending).resolves.toEqual({ ok: false, superseded: true });
      expect(harness.controller.getSnapshot().devices).toEqual([refreshed]);
      expect(harness.controller.getSnapshot().error).toBeNull();
      expect(harness.identity.clearCalls).toBe(0);
    },
  );

  it("does not erase a new identity after an old current-device deletion completes", async () => {
    const harness = createHarness({ persisted: authenticatedState() });
    harness.identity.deviceId = "old-device";
    await harness.controller.initialize();
    const deletion = deferred<undefined>();
    const entered = deferred<undefined>();
    harness.api.deleteDevice = async () => {
      entered.resolve(undefined);
      return deletion.promise;
    };
    const pending = harness.controller.deleteDevice("old-device").catch(() => undefined);
    await entered.promise;
    harness.api.profile = { ...PROFILE, email: "new-account@example.com" };
    await harness.controller.login("new-account@example.com", "test-only");
    harness.identity.deviceId = "new-device";
    deletion.resolve(undefined);
    await pending;
    expect(harness.identity.deviceId).toBe("new-device");
    expect(harness.identity.clearCalls).toBe(0);
    expect(harness.controller.getSnapshot().profile?.email).toBe("new-account@example.com");
  });

  it("does not cancel a connection when deleting another device", async () => {
    const harness = createHarness({ persisted: authenticatedState() });
    await harness.controller.initialize();
    const session = deferred<undefined>();
    harness.api.createWait = session.promise;
    const connecting = harness.controller.connect("frankfurt-01");
    await vi.waitFor(() => expect(harness.api.proofs).toHaveLength(1));
    await harness.controller.deleteDevice("another-device");
    session.resolve(undefined);
    await connecting;
    expect(harness.controller.getSnapshot().protected).toBe(true);
    expect(harness.controller.getSnapshot().activeLocationId).toBe("frankfurt-01");
  });

  it("retains verified protection when deleting another device fails", async () => {
    const harness = createHarness({ persisted: authenticatedState() });
    await harness.controller.initialize();
    await harness.controller.connect("frankfurt-01");
    const sessionId = harness.proxy.active?.id;
    harness.api.deleteDevice = async () => {
      throw new NetworkError("network");
    };
    await harness.controller.deleteDevice("another-device");
    expect(harness.controller.getSnapshot().protected).toBe(true);
    expect(harness.controller.getSnapshot().error).toBe("network_error");
    expect(harness.proxy.active?.id).toBe(sessionId);
    expect(harness.controller.getSnapshot().trafficBlocked).toBe(false);
  });
});
