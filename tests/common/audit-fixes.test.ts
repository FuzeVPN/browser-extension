// SPDX-License-Identifier: MPL-2.0

import { getEventListeners } from "node:events";
import { ApiClient, ApiError, NetworkError } from "../../src/core/api/client";
import type { BillingSubscription } from "../../src/core/api/types";
import { ALARM_RECONNECT, ALARM_REFRESH } from "../../src/core/shared/config";
import {
  ACTIVE_SUBSCRIPTION,
  AUTH,
  authenticatedState,
  createHarness,
  INACTIVE_SUBSCRIPTION,
  NOW,
  PROFILE,
  proxySession,
  UNAUTHORIZED,
} from "./helpers";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

async function settle() {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

describe("temporary API failures", () => {
  it.each([
    [500, '{"error":"server_error"}'],
    [502, "<html>Bad gateway</html>"],
    [503, ""],
    [504, '{"error":"server_error","retry_after_seconds":90}'],
  ])("preserves the HTTP %i server failure for recovery", async (status, body) => {
    const client = new ApiClient(
      async () => new Response(body, { status }),
      "https://example.invalid",
    );
    await expect(client.getLocations()).rejects.toMatchObject({
      name: "ApiError",
      status,
      code: "server_error",
    });
  });

  it.each(["connect", "refresh"])(
    "recovers %s after a reliable 429 without dropping a verified live fallback",
    async (mode) => {
      const h = createHarness({ persisted: authenticatedState() });
      await h.controller.initialize();
      if (mode === "refresh") await h.controller.connect("frankfurt-01");
      const previous = h.proxy.active;
      const client = new ApiClient(
        async () => new Response('{"error":"rate_limited"}', { status: 429 }),
        "https://example.invalid",
      );
      vi.spyOn(h.api, "createProxySession").mockImplementationOnce((...args) =>
        client.createProxySession(...args),
      );
      if (mode === "refresh") await h.controller.handleAlarm(ALARM_REFRESH);
      else await h.controller.connect("frankfurt-01");
      expect(h.controller.getSnapshot().error).toBe("rate_limited");
      expect(h.securityStorage.state?.retrySuspended).toBe(false);
      if (mode === "refresh") {
        expect(h.controller.getSnapshot().protected).toBe(true);
        expect(h.proxy.active).toEqual(previous);
        expect(h.storage.transient.proxySession).toEqual(previous);
        expect(h.alarms.retryAt).toBe(NOW + 30_000);
      } else {
        expect(h.controller.getSnapshot().trafficBlocked).toBe(true);
        expect(h.alarms.reconnectAt).toBe(NOW + 30_000);
      }
      h.setNow(NOW + 30_000);
      await h.controller.handleAlarm(mode === "refresh" ? ALARM_REFRESH : ALARM_RECONNECT);
      expect(h.controller.getSnapshot()).toMatchObject({
        status: "connected",
        protected: true,
        error: null,
      });
    },
  );

  it("keeps a server retry deadline and does not retry account errors", async () => {
    const h = createHarness({ persisted: authenticatedState() });
    await h.controller.initialize();
    vi.spyOn(h.api, "getProfile").mockRejectedValueOnce(new ApiError("server_error", 503, 90));
    await h.controller.connect("frankfurt-01");
    expect(h.alarms.reconnectAt).toBe(NOW + 90_000);
    await h.controller.disconnect();
    h.api.createError = new ApiError("subscription_required", 403);
    await h.controller.connect("frankfurt-01");
    expect(h.securityStorage.state?.retrySuspended).toBe(true);
    expect(h.alarms.reconnectAt).toBeNull();
  });
});

describe("current device deletion and concurrent connection intents", () => {
  it.each(["success", "failure"])(
    "waits for a pending current-device deletion (%s) before reusing or replacing its identity",
    async (outcome) => {
      const h = createHarness({ persisted: authenticatedState() });
      h.identity.deviceId = "deleted-device";
      await h.controller.initialize();
      await h.controller.connect("frankfurt-01");
      const deletion = deferred<undefined>();
      const remove = vi.spyOn(h.api, "deleteDevice").mockReturnValueOnce(deletion.promise);
      const deleting = h.controller.deleteDevice("deleted-device");
      await vi.waitFor(() => expect(remove).toHaveBeenCalledOnce());
      expect(h.controller.getSnapshot().status).toBe("disconnected");
      const connecting = h.controller.connect("frankfurt-01");
      await settle();
      expect(h.api.proofs).toHaveLength(1);
      if (outcome === "success") deletion.resolve(undefined);
      else deletion.reject(new NetworkError("network"));
      await Promise.all([deleting, connecting]);
      expect(h.controller.getSnapshot().protected).toBe(true);
      expect(h.identity.clearCalls).toBe(outcome === "success" ? 1 : 0);
      expect(h.api.proofs.at(-1)?.deviceId).toBe(
        outcome === "success" ? "browser-device-1" : "deleted-device",
      );
      expect(h.controller.getSnapshot().currentDeviceId).toBe(h.identity.deviceId);
    },
  );

  it("does not run a waiting reconnect after a newer disconnect", async () => {
    const h = createHarness({ persisted: authenticatedState() });
    h.identity.deviceId = "deleted-device";
    await h.controller.initialize();
    const deletion = deferred<undefined>();
    const remove = vi.spyOn(h.api, "deleteDevice").mockReturnValueOnce(deletion.promise);
    const deleting = h.controller.deleteDevice("deleted-device");
    await vi.waitFor(() => expect(remove).toHaveBeenCalledOnce());
    const connecting = h.controller.connect("frankfurt-01");
    await settle();
    await h.controller.disconnect();
    deletion.resolve(undefined);
    await Promise.all([deleting, connecting]);
    expect(h.identity.deviceId).toBeNull();
    expect(h.controller.getSnapshot().currentDeviceId).toBeNull();
    expect(h.api.proofs).toHaveLength(0);
    expect(h.controller.getSnapshot().protected).toBe(false);
  });

  it("keeps a different identity installed after the old deletion started", async () => {
    const h = createHarness({ persisted: authenticatedState() });
    h.identity.deviceId = "deleted-device";
    await h.controller.initialize();
    const deletion = deferred<undefined>();
    const remove = vi.spyOn(h.api, "deleteDevice").mockReturnValueOnce(deletion.promise);
    const deleting = h.controller.deleteDevice("deleted-device");
    await vi.waitFor(() => expect(remove).toHaveBeenCalledOnce());
    await h.controller.logout();
    h.api.profile = { ...PROFILE, userId: "account-b" };
    h.api.auth = { ...AUTH, accessToken: "account-b-token" };
    await h.controller.login("b@example.invalid", "synthetic");
    await h.identity.setDeviceId("account-b", "new-device");
    deletion.resolve(undefined);
    await deleting;
    expect(await h.identity.getDeviceId("account-b")).toBe("new-device");
    expect(await h.identity.getDeviceId(PROFILE.userId)).toBeNull();
    expect(h.controller.getSnapshot().profile?.userId).toBe("account-b");
  });
});

describe("sessions created before cancellation", () => {
  it("finishes local logout and still calls remote logout when revocation fails", async () => {
    const h = createHarness({ persisted: authenticatedState() });
    await h.controller.initialize();
    const writing = deferred<undefined>();
    const release = deferred<undefined>();
    const write = h.storage.writeTransient.bind(h.storage);
    vi.spyOn(h.storage, "writeTransient").mockImplementationOnce(async (state) => {
      writing.resolve(undefined);
      await release.promise;
      await write(state);
    });
    h.api.sessions = [proxySession("created-before-logout")];
    const connecting = h.controller.connect("frankfurt-01");
    await writing.promise;
    const revoke = vi
      .spyOn(h.api, "revokeProxySession")
      .mockRejectedValue(new NetworkError("network"));
    const remoteLogout = vi.spyOn(h.api, "logout");
    const logout = h.controller.logout();
    await vi.waitFor(() => expect(h.controller.getSnapshot().status).toBe("disconnecting"));
    release.resolve(undefined);
    await Promise.all([connecting, logout]);
    expect(revoke).toHaveBeenCalledWith(AUTH.accessToken, "created-before-logout");
    expect(remoteLogout).toHaveBeenCalledWith(AUTH.accessToken);
    expect(h.storage.transient.proxySession).toBeNull();
    expect(h.storage.persisted.auth).toBeNull();
    expect(h.controller.getSnapshot().protected).toBe(false);
  });

  it.each(["connect", "refresh"])(
    "revokes the %s session being written before remote logout",
    async (mode) => {
      const h = createHarness({ persisted: authenticatedState() });
      await h.controller.initialize();
      if (mode === "refresh") await h.controller.connect("frankfurt-01");
      const writing = deferred<undefined>();
      const release = deferred<undefined>();
      const write = h.storage.writeTransient.bind(h.storage);
      vi.spyOn(h.storage, "writeTransient").mockImplementationOnce(async (state) => {
        writing.resolve(undefined);
        await release.promise;
        await write(state);
      });
      h.api.sessions = [proxySession("created-before-logout")];
      const pending =
        mode === "refresh"
          ? h.controller.handleAlarm(ALARM_REFRESH)
          : h.controller.connect("frankfurt-01");
      await writing.promise;
      const revoking = deferred<undefined>();
      const revoke = vi.spyOn(h.api, "revokeProxySession").mockReturnValue(revoking.promise);
      const remoteLogout = vi.spyOn(h.api, "logout");
      const logout = h.controller.logout();
      await vi.waitFor(() => expect(h.controller.getSnapshot().status).toBe("disconnecting"));
      release.resolve(undefined);
      await vi.waitFor(() =>
        expect(revoke).toHaveBeenCalledWith(AUTH.accessToken, "created-before-logout"),
      );
      await settle();
      expect(remoteLogout).not.toHaveBeenCalled();
      revoking.resolve(undefined);
      await Promise.all([pending, logout]);
      expect(remoteLogout).toHaveBeenCalledWith(AUTH.accessToken);
      expect(h.storage.transient.proxySession).toBeNull();
      expect(h.controller.getSnapshot().profile).toBeNull();
    },
  );

  it.each(["connect", "refresh"])(
    "uses the originating account for a late %s response after a new login",
    async (mode) => {
      const h = createHarness({ persisted: authenticatedState() });
      await h.controller.initialize();
      if (mode === "refresh") await h.controller.connect("frankfurt-01");
      const release = deferred<undefined>();
      h.api.createWait = release.promise;
      h.api.ignoreCreateAbort = true;
      h.api.sessions = [proxySession("late-old-account-session")];
      const pending =
        mode === "refresh"
          ? h.controller.handleAlarm(ALARM_REFRESH)
          : h.controller.connect("frankfurt-01");
      await vi.waitFor(() => expect(h.api.proofs).toHaveLength(mode === "refresh" ? 2 : 1));
      await h.controller.logout();
      h.api.auth = { ...AUTH, accessToken: "account-b-token" };
      h.api.profile = { ...PROFILE, userId: "account-b" };
      await h.controller.login("b@example.invalid", "synthetic");
      const revoke = vi.spyOn(h.api, "revokeProxySession");
      release.resolve(undefined);
      await pending;
      expect(revoke).toHaveBeenCalledWith(AUTH.accessToken, "late-old-account-session");
      expect(h.controller.getSnapshot().profile?.userId).toBe("account-b");
    },
  );
});

describe("account responses in completion order", () => {
  it.each(["success", "unauthorized"])(
    "discards an older account %s after newer account data was committed",
    async (outcome) => {
      const h = createHarness({ persisted: authenticatedState() });
      await h.controller.initialize();
      const old = deferred<BillingSubscription>();
      const getSubscription = vi
        .spyOn(h.api, "getSubscription")
        .mockReturnValueOnce(old.promise)
        .mockResolvedValue(INACTIVE_SUBSCRIPTION);
      const refreshing = h.controller.refreshAccount();
      await vi.waitFor(() => expect(getSubscription).toHaveBeenCalledOnce());
      await h.controller.refreshAccount();
      const snapshot = h.controller.getSnapshot();
      if (outcome === "success") old.resolve(ACTIVE_SUBSCRIPTION);
      else old.reject(UNAUTHORIZED);
      await refreshing;
      expect(h.controller.getSnapshot()).toEqual(snapshot);
      expect(h.storage.persisted.subscription).toEqual(INACTIVE_SUBSCRIPTION);
      expect(h.controller.getSnapshot().profile).not.toBeNull();
    },
  );

  it("does not overwrite newer entitlement data with a slow popup refresh", async () => {
    const h = createHarness({ persisted: authenticatedState() });
    await h.controller.initialize();
    await h.controller.connect("frankfurt-01");
    const old = deferred<BillingSubscription>();
    const getSubscription = vi
      .spyOn(h.api, "getSubscription")
      .mockReturnValueOnce(old.promise)
      .mockResolvedValue(INACTIVE_SUBSCRIPTION);
    const refreshing = h.controller.refreshAccount();
    await vi.waitFor(() => expect(getSubscription).toHaveBeenCalledOnce());
    await h.controller.changeLocation("frankfurt-02");
    const snapshot = h.controller.getSnapshot();
    old.resolve(ACTIVE_SUBSCRIPTION);
    await refreshing;
    expect(h.controller.getSnapshot()).toEqual(snapshot);
    expect(h.storage.persisted.subscription).toEqual(INACTIVE_SUBSCRIPTION);
  });
});

describe("request cancellation listener cleanup", () => {
  it.each(["success", "api_error", "invalid_response", "network", "invalid_header"])(
    "removes account signal listeners after %s",
    async (outcome) => {
      const account = new AbortController();
      const client = new ApiClient(async () => {
        if (outcome === "network") throw new TypeError("synthetic network failure");
        if (outcome === "api_error")
          return new Response('{"error":"server_error"}', { status: 503 });
        return new Response(outcome === "success" ? '{"locations":[]}' : "invalid");
      });
      for (let count = 0; count < 8; count++) {
        const request =
          outcome === "invalid_header"
            ? client.getProfile("invalid\nheader", account.signal)
            : client.getLocations(account.signal);
        await request.catch(() => undefined);
        expect(getEventListeners(account.signal, "abort")).toHaveLength(0);
      }
    },
  );

  it.each(["caller", "timeout"])("cleans listeners after %s cancellation", async (kind) => {
    const account = new AbortController();
    const client = new ApiClient(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("Synthetic cancellation", "AbortError")),
            { once: true },
          );
        }),
      "https://example.invalid",
      20,
    );
    const request = client.getLocations(account.signal);
    if (kind === "caller") account.abort();
    await expect(request).rejects.toMatchObject(
      kind === "caller" ? { name: "AbortError" } : { name: "NetworkError", kind: "timeout" },
    );
    expect(getEventListeners(account.signal, "abort")).toHaveLength(0);
  });
});
