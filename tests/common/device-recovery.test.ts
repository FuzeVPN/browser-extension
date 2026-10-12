// SPDX-License-Identifier: MPL-2.0

import { ApiError, NetworkError } from "../../src/core/api/client";
import { AppController } from "../../src/core/background/state-machine";
import { ALARM_RECONNECT, ALARM_REFRESH } from "../../src/core/shared/config";
import { authenticatedState, createHarness, NOW, PROFILE, proxySession } from "./helpers";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

async function staleDevice(code = "device_identity_revoked") {
  const h = createHarness({ persisted: authenticatedState() });
  h.identity.deviceId = "old-device";
  await h.identity.getPublicKeySpkiBase64(PROFILE.userId);
  const create = h.api.createProxySession.bind(h.api);
  vi.spyOn(h.api, "createProxySession").mockImplementation(async (...args) => {
    if (args[2].deviceId === "old-device") {
      h.api.proofs.push(args[2]);
      throw new ApiError(code, code === "not_found" ? 404 : 403);
    }
    return create(...args);
  });
  await h.controller.initialize();
  return h;
}

function restart(h: Awaited<ReturnType<typeof staleDevice>>) {
  return new AppController({
    api: h.api,
    storage: h.storage,
    identity: h.identity,
    proxy: h.proxy,
    alarms: h.alarms,
    safety: h.safety,
    securityStorage: h.securityStorage,
    now: () => NOW + 300_000,
    onStateChanged: (snapshot) => h.snapshots.push(snapshot),
  });
}

describe("automatic device recovery", () => {
  it.each(["device_identity_revoked", "invalid_device", "not_found"])(
    "replaces a rejected identity (%s) without logging out or showing the refusal",
    async (code) => {
      const h = await staleDevice(code);
      expect(await h.controller.connect("frankfurt-01")).toEqual({ ok: true });
      expect(h.api.proofs.map((proof) => proof.deviceId)).toEqual([
        "old-device",
        "browser-device-1",
      ]);
      expect(h.api.enrollCalls).toBe(1);
      expect(h.identity.keyGenerations).toBe(2);
      expect(h.controller.getSnapshot()).toMatchObject({
        protected: true,
        error: null,
        profile: PROFILE,
      });
      expect(h.snapshots.some((snapshot) => snapshot.error === code)).toBe(false);
      expect(await h.identity.getRecovery(PROFILE.userId)).toEqual({
        pending: false,
        exhausted: false,
      });
    },
  );

  it("does not rotate a device still listed after an unrelated not_found", async () => {
    const h = await staleDevice("not_found");
    h.api.devices.devices = [
      {
        deviceId: "old-device",
        name: "Personal name",
        kind: "browser_extension",
        profiles: [],
        createdAt: "2026-08-26T12:00:00Z",
      },
    ];
    await h.controller.connect("frankfurt-01");
    expect(h.identity.deviceId).toBe("old-device");
    expect(h.api.enrollCalls).toBe(0);
    expect(h.controller.getSnapshot().error).toBe("proxy_unavailable");
  });

  it("preserves identity and reports the network problem when missing-device verification fails", async () => {
    const h = await staleDevice("not_found");
    vi.spyOn(h.api, "getDevices").mockRejectedValue(new NetworkError("network"));
    await h.controller.connect("frankfurt-01");
    expect(h.identity.deviceId).toBe("old-device");
    expect(h.api.enrollCalls).toBe(0);
    expect(h.controller.getSnapshot().error).toBe("network_error");
  });

  it("retains one replacement key after a lost enrollment response, including across worker restart", async () => {
    const h = await staleDevice();
    h.api.enrollError = new NetworkError("timeout");
    await h.controller.connect("frankfurt-01");
    expect(h.controller.getSnapshot().error).toBe("request_timeout");
    expect(await h.identity.getRecovery(PROFILE.userId)).toEqual({
      pending: true,
      exhausted: false,
    });
    const key = h.api.enrollments[0]?.publicKey;
    const generations = h.identity.keyGenerations;
    h.api.enrollError = null;
    const controller = restart(h);
    await controller.initialize();
    expect(controller.getSnapshot().protected).toBe(true);
    expect(h.api.enrollments[1]?.publicKey).toBe(key);
    expect(h.identity.keyGenerations).toBe(generations);
  });

  it("shows contextual quota and resumes after device management frees a slot", async () => {
    const h = await staleDevice();
    h.api.enrollError = new ApiError("device_limit", 409);
    await h.controller.connect("frankfurt-01");
    expect(h.controller.getSnapshot().error).toBe("device_revoked_limit");
    expect(h.alarms.reconnectAt).toBeNull();
    await h.controller.refreshDevices();
    expect(h.controller.getSnapshot().error).toBe("device_revoked_limit");
    const key = h.api.enrollments[0]?.publicKey;
    h.api.enrollError = null;
    expect(await h.controller.deleteDevice("another-device")).toEqual({ ok: true });
    expect(h.controller.getSnapshot().protected).toBe(true);
    expect(h.api.enrollments[1]?.publicKey).toBe(key);
  });

  it("retains contextual quota after restart and an explicit retry", async () => {
    const h = await staleDevice();
    h.api.enrollError = new ApiError("device_limit", 409);
    await h.controller.connect("frankfurt-01");
    const controller = restart(h);
    await controller.initialize();
    await controller.connect("frankfurt-01");
    expect(controller.getSnapshot().error).toBe("device_revoked_limit");
    expect(h.identity.keyGenerations).toBe(2);
  });

  it("bounds repeated refusals and opens a fresh recovery sequence only on explicit retry", async () => {
    const h = await staleDevice();
    h.api.createProxySession = vi.fn(async () => {
      throw new ApiError("invalid_device", 403);
    });
    await h.controller.connect("frankfurt-01");
    expect(h.api.createProxySession).toHaveBeenCalledTimes(2);
    expect(h.api.enrollCalls).toBe(1);
    expect(h.controller.getSnapshot()).toMatchObject({
      error: "proxy_unavailable",
      protected: false,
      nextRetryAt: null,
    });
    expect(await h.identity.getRecovery(PROFILE.userId)).toEqual({
      pending: true,
      exhausted: true,
    });
    await h.controller.handleAlarm(ALARM_RECONNECT);
    expect(h.api.createProxySession).toHaveBeenCalledTimes(2);
    const controller = restart(h);
    await controller.initialize();
    expect(h.api.enrollCalls).toBe(1);
    await controller.connect("frankfurt-01");
    expect(h.api.enrollCalls).toBe(2);
  });

  it("keeps the nonce retry independent of identity recovery", async () => {
    const h = await staleDevice();
    h.api.replayProofOnce = true;
    await h.controller.connect("frankfurt-01");
    expect(h.controller.getSnapshot().protected).toBe(true);
    expect(h.api.proofs).toHaveLength(3);
    expect(new Set(h.api.proofs.map((proof) => proof.deviceNonce)).size).toBe(3);
    expect(h.api.enrollCalls).toBe(1);
  });

  it.each(["renewal", "change-location"])(
    "never restores revoked credentials when %s recovery loses network",
    async (operation) => {
      const h = createHarness({ persisted: authenticatedState() });
      await h.controller.initialize();
      await h.controller.connect("frankfurt-01");
      h.api.createError = new ApiError("device_identity_revoked", 403);
      h.api.enrollError = new NetworkError("network");
      if (operation === "renewal") await h.controller.handleAlarm(ALARM_REFRESH);
      else await h.controller.changeLocation("frankfurt-02");
      expect(h.controller.getSnapshot()).toMatchObject({
        protected: false,
        trafficBlocked: true,
        error: "network_error",
      });
      expect(h.storage.transient.proxySession).toBeNull();
      expect(await h.controller.getActiveSession()).toBeNull();
      expect(h.securityStorage.state?.protectionRequested).toBe(true);
    },
  );

  it("respects a disabled kill switch while invalidating old credentials", async () => {
    const h = await staleDevice();
    await h.controller.updateSecurityPreferences(false, true);
    h.api.enrollError = new ApiError("device_limit", 409);
    await h.controller.connect("frankfurt-01");
    expect(h.controller.getSnapshot()).toMatchObject({
      protected: false,
      trafficBlocked: false,
      error: "device_revoked_limit",
    });
    expect(h.proxy.active).toBeNull();
  });

  it("ignores a delayed enrollment after logout and a new account login", async () => {
    const h = await staleDevice();
    const started = deferred<undefined>();
    const response = deferred<Awaited<ReturnType<typeof h.api.enrollBrowserDevice>>>();
    h.api.enrollBrowserDevice = vi.fn(async () => {
      started.resolve(undefined);
      return response.promise;
    });
    const connecting = h.controller.connect("frankfurt-01");
    await started.promise;
    await h.controller.logout();
    h.api.profile = { ...PROFILE, userId: "new-account", email: "new@example.invalid" };
    await h.controller.login(h.api.profile.email, "test-only");
    await h.identity.setDeviceId("new-account", "new-device");
    response.resolve({
      deviceId: "late-device",
      name: "Browser",
      kind: "browser_extension",
      createdAt: "2026-08-26T12:00:00Z",
    });
    expect(await connecting).toMatchObject({ superseded: true });
    expect(await h.identity.getDeviceId("new-account")).toBe("new-device");
    expect(await h.identity.getDeviceId(PROFILE.userId)).toBeNull();
    expect(h.controller.getSnapshot().protected).toBe(false);
  });

  it("does not recreate after disconnect while verifying a missing device", async () => {
    const h = await staleDevice("not_found");
    const started = deferred<undefined>();
    const listing = deferred<typeof h.api.devices>();
    h.api.getDevices = vi.fn(async () => {
      started.resolve(undefined);
      return listing.promise;
    });
    const connecting = h.controller.connect("frankfurt-01");
    await started.promise;
    await h.controller.disconnect();
    listing.resolve({ limit: 2, devices: [] });
    expect(await connecting).toMatchObject({ superseded: true });
    expect(h.api.enrollCalls).toBe(0);
    expect(h.identity.deviceId).toBe("old-device");
  });

  it("treats deletion of an already missing remote device as success without reenrolling", async () => {
    const h = await staleDevice();
    h.api.deleteDevice = vi.fn(async () => {
      throw new ApiError("not_found", 404);
    });
    expect(await h.controller.deleteDevice("another-device")).toEqual({ ok: true });
    expect(h.api.enrollCalls).toBe(0);
    expect(h.identity.deviceId).toBe("old-device");
  });

  it("does not replay an uncertain proxy creation or rotate on a 401", async () => {
    const h = await staleDevice();
    h.api.createProxySession = vi.fn(async () => {
      throw new ApiError("device_identity_revoked", 401);
    });
    await h.controller.connect("frankfurt-01");
    expect(h.api.enrollCalls).toBe(0);
    expect(h.controller.getSnapshot().error).toBe("unauthorized");
    const other = await staleDevice();
    other.api.createProxySession = vi.fn(async () => {
      throw new NetworkError("timeout");
    });
    await other.controller.connect("frankfurt-01");
    expect(other.api.createProxySession).toHaveBeenCalledTimes(1);
    expect(other.api.enrollCalls).toBe(0);
    expect(other.controller.getSnapshot().error).toBe("proxy_creation_uncertain");
  });

  it("does not restore staged credentials at startup while recovery is pending", async () => {
    const h = await staleDevice();
    await h.identity.beginRecovery(PROFILE.userId, "old-device");
    h.storage.transient.proxySession = proxySession("stale-transient");
    h.securityStorage.state!.protectionRequested = true;
    h.securityStorage.state!.retrySuspended = true;
    const controller = restart(h);
    await controller.initialize();
    expect(await controller.getActiveSession()).toBeNull();
  });
});
