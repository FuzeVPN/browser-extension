// SPDX-License-Identifier: MPL-2.0

import {
  ApiClient,
  ApiError,
  NetworkError,
  ProxyCreationUncertainError,
} from "../../src/core/api/client";
import { ALARM_EXPIRY, ALARM_RECONNECT, ALARM_REFRESH } from "../../src/core/shared/config";
import { AUTH, authenticatedState, createHarness, NOW, PROFILE } from "./helpers";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("non-cascading logout contract", () => {
  it("drains a sent creation and deduplicates its revocation before invalidating the token", async () => {
    const h = createHarness({ persisted: authenticatedState() });
    await h.controller.initialize();
    const response = deferred<undefined>();
    h.api.createWait = response.promise;
    const create = vi.spyOn(h.api, "createProxySession");
    const revoke = vi.spyOn(h.api, "revokeProxySession");
    const logoutApi = vi.spyOn(h.api, "logout");
    const connecting = h.controller.connect("frankfurt-01");
    await vi.waitFor(() => expect(create).toHaveBeenCalledOnce());
    const logout = h.controller.logout();
    await vi.waitFor(() => expect(h.storage.persisted.auth).toBeNull());
    expect(create.mock.calls[0]?.[3]).toBeUndefined();
    expect(logoutApi).not.toHaveBeenCalled();
    expect(h.controller.getSnapshot().logoutOutcome).toEqual({
      apiSession: "pending",
      proxySessions: "pending",
    });
    response.resolve(undefined);
    await Promise.all([connecting, logout]);
    expect(revoke).toHaveBeenCalledExactlyOnceWith(AUTH.accessToken, "proxy-session-1");
    expect(revoke.mock.invocationCallOrder[0]).toBeLessThan(logoutApi.mock.invocationCallOrder[0]!);
    expect(h.controller.getSnapshot().logoutOutcome).toEqual({
      apiSession: "confirmed",
      proxySessions: "confirmed",
    });
  });

  it.each(["api", "proxy", "both"])("reports %s cleanup failure independently", async (failure) => {
    const h = createHarness({ persisted: authenticatedState() });
    await h.controller.initialize();
    await h.controller.connect("frankfurt-01");
    if (failure !== "api")
      vi.spyOn(h.api, "revokeProxySession").mockRejectedValue(new ApiError("server_error", 500));
    if (failure !== "proxy")
      vi.spyOn(h.api, "logout").mockRejectedValue(new ApiError("server_error", 500));
    await h.controller.logout();
    expect(h.storage.persisted.auth).toBeNull();
    expect(h.storage.transient.proxySession).toBeNull();
    expect(h.controller.getSnapshot().logoutOutcome).toEqual({
      apiSession: failure === "proxy" ? "confirmed" : "unconfirmed",
      proxySessions: failure === "api" ? "confirmed" : "unconfirmed",
    });
  });

  it("shares simultaneous logout calls and never replaces a partial result with success", async () => {
    const h = createHarness({ persisted: authenticatedState() });
    await h.controller.initialize();
    await h.controller.connect("frankfurt-01");
    const revoke = vi
      .spyOn(h.api, "revokeProxySession")
      .mockRejectedValue(new ApiError("server_error", 500));
    const logoutApi = vi.spyOn(h.api, "logout");
    await Promise.all([h.controller.logout(), h.controller.logout()]);
    expect(revoke).toHaveBeenCalledOnce();
    expect(logoutApi).toHaveBeenCalledOnce();
    const result = h.controller.getSnapshot().logoutOutcome;
    expect(result?.proxySessions).toBe("unconfirmed");
    await h.controller.logout();
    expect(h.controller.getSnapshot().logoutOutcome).toEqual(result);
    expect(logoutApi).toHaveBeenCalledOnce();
  });

  it("bounds an unresolved creation and reports unknown remote sessions after API logout", async () => {
    const h = createHarness({ persisted: authenticatedState(), remoteCleanupTimeoutMs: 20 });
    await h.controller.initialize();
    const response = deferred<undefined>();
    h.api.createWait = response.promise;
    const create = vi.spyOn(h.api, "createProxySession");
    const connecting = h.controller.connect("frankfurt-01");
    await vi.waitFor(() => expect(create).toHaveBeenCalledOnce());
    await h.controller.logout();
    expect(h.api.logoutCalls).toBe(1);
    expect(h.controller.getSnapshot().logoutOutcome).toEqual({
      apiSession: "confirmed",
      proxySessions: "unconfirmed",
    });
    response.resolve(undefined);
    await connecting;
    expect(h.controller.getSnapshot().logoutOutcome?.proxySessions).toBe("unconfirmed");
    expect(h.api.deletedDevices).toHaveLength(0);
  });

  it("bounds an unanswered revocation and API logout without claiming confirmation", async () => {
    const h = createHarness({ persisted: authenticatedState(), remoteCleanupTimeoutMs: 20 });
    await h.controller.initialize();
    await h.controller.connect("frankfurt-01");
    const revocation = deferred<undefined>();
    const apiLogout = deferred<undefined>();
    vi.spyOn(h.api, "revokeProxySession").mockReturnValue(revocation.promise);
    vi.spyOn(h.api, "logout").mockReturnValue(apiLogout.promise);
    await h.controller.logout();
    expect(h.controller.getSnapshot().logoutOutcome).toEqual({
      apiSession: "unconfirmed",
      proxySessions: "unconfirmed",
    });
    revocation.resolve(undefined);
    apiLogout.resolve(undefined);
  });

  it("does not publish an old logout result into a newer account", async () => {
    const h = createHarness({ persisted: authenticatedState() });
    await h.controller.initialize();
    const done = deferred<undefined>();
    const apiLogout = vi.spyOn(h.api, "logout").mockReturnValueOnce(done.promise);
    const logout = h.controller.logout();
    await vi.waitFor(() => expect(apiLogout).toHaveBeenCalledOnce());
    h.api.auth = { ...AUTH, accessToken: "account-b-token" };
    h.api.profile = { ...PROFILE, userId: "account-b" };
    await h.controller.login("b@example.invalid", "synthetic");
    const current = h.controller.getSnapshot();
    done.resolve(undefined);
    await logout;
    expect(h.controller.getSnapshot()).toEqual(current);
    expect(h.controller.getSnapshot().logoutOutcome).toBeNull();
  });

  it("executes a fresh logout after a new login even when the authenticator reuses its token", async () => {
    const h = createHarness({ persisted: authenticatedState() });
    await h.controller.initialize();
    const response = deferred<undefined>();
    h.api.createWait = response.promise;
    const create = vi.spyOn(h.api, "createProxySession");
    const connecting = h.controller.connect("frankfurt-01");
    await vi.waitFor(() => expect(create).toHaveBeenCalledOnce());
    const first = h.controller.logout();
    await vi.waitFor(() => expect(h.controller.getSnapshot().status).toBe("logged_out"));
    await h.controller.login("same@example.invalid", "synthetic");
    expect(h.controller.getSnapshot().profile).not.toBeNull();
    const second = h.controller.logout();
    expect(second).not.toBe(first);
    await vi.waitFor(() => expect(h.storage.persisted.auth).toBeNull());
    response.resolve(undefined);
    await Promise.all([connecting, first, second]);
    expect(h.controller.getSnapshot().profile).toBeNull();
    expect(h.controller.getSnapshot().status).toBe("logged_out");
  });
});

describe("non-idempotent proxy creation contract", () => {
  const proof = {
    deviceId: "device",
    deviceTimestamp: 1,
    deviceNonce: "nonce",
    deviceSignature: "signature",
  };

  it.each([
    [500, '{"error":"server_error"}'],
    [503, "<html>Unavailable</html>"],
    [504, ""],
    [201, "invalid response"],
  ])("does not make HTTP %i creation errors replayable", async (status, body) => {
    const client = new ApiClient(async () => new Response(body, { status }));
    await expect(client.createProxySession("token", "frankfurt-01", proof)).rejects.toBeInstanceOf(
      ProxyCreationUncertainError,
    );
  });

  it("persists an in-flight marker before dispatch and pauses a worker restored during the POST", async () => {
    const h = createHarness({ persisted: authenticatedState() });
    await h.controller.initialize();
    const response = deferred<undefined>();
    h.api.createWait = response.promise;
    const create = vi.spyOn(h.api, "createProxySession");
    const connecting = h.controller.connect("frankfurt-01");
    await vi.waitFor(() => expect(create).toHaveBeenCalledOnce());
    expect(h.securityStorage.state?.proxyCreationUncertain).toBe(true);
    expect(h.securityStorage.state?.proxyCleanupUncertain).toBe(true);
    expect(h.controller.getSnapshot().error).toBeNull();
    const restarted = createHarness({
      persisted: h.storage.persisted,
      security: h.securityStorage.state!,
    });
    await restarted.controller.initialize();
    await restarted.controller.handleAlarm(ALARM_RECONNECT);
    expect(restarted.api.proofs).toHaveLength(0);
    expect(restarted.controller.getSnapshot().error).toBe("proxy_creation_uncertain");
    response.resolve(undefined);
    await connecting;
  });

  it("never replays an ambiguous initial POST through alarms or restart", async () => {
    const h = createHarness({ persisted: authenticatedState() });
    await h.controller.initialize();
    h.api.createError = new ApiError("server_error", 503);
    await h.controller.connect("frankfurt-01");
    expect(h.api.proofs).toHaveLength(1);
    expect(h.alarms.reconnectAt).toBeNull();
    expect(h.securityStorage.state?.proxyCreationUncertain).toBe(true);
    await h.controller.handleAlarm(ALARM_RECONNECT);
    await h.controller.handleAlarm(ALARM_REFRESH);
    const restarted = createHarness({
      persisted: h.storage.persisted,
      security: h.securityStorage.state!,
    });
    await restarted.controller.initialize();
    expect(restarted.api.proofs).toHaveLength(0);
    await h.controller.logout();
    expect(h.controller.getSnapshot().logoutOutcome?.proxySessions).toBe("unconfirmed");
  });

  it("retains a verified old session, survives config/restart, then expires without replay", async () => {
    const h = createHarness({ persisted: authenticatedState() });
    await h.controller.initialize();
    await h.controller.connect("frankfurt-01");
    const previous = h.proxy.active!;
    h.api.createError = new NetworkError("timeout");
    await h.controller.handleAlarm(ALARM_REFRESH);
    expect(h.controller.getSnapshot().protected).toBe(true);
    expect(h.controller.getSnapshot().status).toBe("connected");
    expect(h.proxy.active).toEqual(previous);
    await h.controller.updateSecurityPreferences(true, true);
    expect(h.controller.getSnapshot().error).toBe("proxy_creation_uncertain");
    await h.controller.handleAlarm(ALARM_REFRESH);
    expect(h.api.proofs).toHaveLength(2);
    expect(h.securityStorage.state?.proxyCreationUncertain).toBe(true);
    const restarted = createHarness({
      persisted: h.storage.persisted,
      transient: h.storage.transient,
      security: h.securityStorage.state!,
      activeProxy: previous,
    });
    await restarted.controller.initialize();
    expect(restarted.controller.getSnapshot().protected).toBe(true);
    expect(restarted.controller.getSnapshot().status).toBe("connected");
    await restarted.controller.handleAlarm(ALARM_REFRESH);
    expect(restarted.api.proofs).toHaveLength(0);
    restarted.setNow(Date.parse(previous.expiresAt));
    await restarted.controller.handleAlarm(ALARM_EXPIRY);
    await restarted.controller.handleAlarm(ALARM_RECONNECT);
    expect(restarted.controller.getSnapshot().protected).toBe(false);
    expect(restarted.alarms.reconnectAt).toBeNull();
    expect(restarted.api.proofs).toHaveLength(0);
  });

  it("manual renewal keeps the old session on uncertainty and does not retry a later 429 automatically", async () => {
    const h = createHarness({ persisted: authenticatedState() });
    await h.controller.initialize();
    await h.controller.connect("frankfurt-01");
    const previous = h.proxy.active!;
    h.api.createError = new ApiError("server_error", 500);
    await h.controller.handleAlarm(ALARM_REFRESH);
    await h.controller.retryConnection();
    expect(h.proxy.active).toEqual(previous);
    expect(h.controller.getSnapshot().protected).toBe(true);
    h.api.createError = new ApiError("rate_limited", 429, 90);
    await h.controller.retryConnection();
    expect(h.alarms.retryAt).toBeNull();
    expect(h.alarms.reconnectAt).toBeNull();
    expect(h.securityStorage.state?.proxyCreationUncertain).toBe(true);
    const attempts = h.api.proofs.length;
    h.setNow(NOW + 90_000);
    await h.controller.handleAlarm(ALARM_RECONNECT);
    await h.controller.handleAlarm(ALARM_REFRESH);
    expect(h.api.proofs).toHaveLength(attempts);
    h.api.createError = null;
    await h.controller.retryConnection();
    expect(h.api.proofs).toHaveLength(attempts + 1);
    expect(h.controller.getSnapshot().protected).toBe(true);
    expect(h.securityStorage.state?.proxyCreationUncertain).toBe(false);
  });

  it("still retries a failed pre-creation GET without duplicating a POST", async () => {
    const h = createHarness({ persisted: authenticatedState() });
    await h.controller.initialize();
    vi.spyOn(h.api, "getProfile").mockRejectedValueOnce(new ApiError("server_error", 503));
    await h.controller.connect("frankfurt-01");
    expect(h.api.proofs).toHaveLength(0);
    expect(h.alarms.reconnectAt).toBe(NOW + 30_000);
    h.setNow(NOW + 30_000);
    await h.controller.handleAlarm(ALARM_RECONNECT);
    expect(h.api.proofs).toHaveLength(1);
    expect(h.controller.getSnapshot().protected).toBe(true);
  });

  it.each(["successful manual retry", "disconnect"])(
    "remembers historical cleanup uncertainty after %s and a worker restart",
    async (action) => {
      const h = createHarness({ persisted: authenticatedState() });
      await h.controller.initialize();
      h.api.createError = new NetworkError("timeout");
      await h.controller.connect("frankfurt-01");
      if (action === "disconnect") await h.controller.disconnect();
      else {
        h.api.createError = null;
        await h.controller.retryConnection();
        expect(h.controller.getSnapshot().protected).toBe(true);
      }
      expect(h.securityStorage.state?.proxyCreationUncertain).toBe(false);
      expect(h.securityStorage.state?.proxyCleanupUncertain).toBe(true);
      const restarted = createHarness({
        persisted: h.storage.persisted,
        transient: h.storage.transient,
        security: h.securityStorage.state!,
        ...(h.proxy.active ? { activeProxy: h.proxy.active } : {}),
      });
      await restarted.controller.initialize();
      await restarted.controller.logout();
      expect(restarted.controller.getSnapshot().logoutOutcome).toEqual({
        apiSession: "confirmed",
        proxySessions: "unconfirmed",
      });
    },
  );

  it("does not retain cleanup uncertainty after a reliable refusal before restart", async () => {
    const h = createHarness({ persisted: authenticatedState() });
    await h.controller.initialize();
    h.api.createError = new ApiError("subscription_required", 403);
    await h.controller.connect("frankfurt-01");
    expect(h.securityStorage.state?.proxyCleanupUncertain).toBe(false);
    const restarted = createHarness({
      persisted: h.storage.persisted,
      security: h.securityStorage.state!,
    });
    await restarted.controller.initialize();
    await restarted.controller.logout();
    expect(restarted.controller.getSnapshot().logoutOutcome?.proxySessions).toBe("confirmed");
  });
});
