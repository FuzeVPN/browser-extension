// SPDX-License-Identifier: MPL-2.0

import { ApiError, NetworkError } from "../../src/core/api/client";
import {
  WebAuthError,
  type WebAuthorization,
  type WebAuthService,
} from "../../src/core/auth/web-auth";
import { SafetyError } from "../../src/core/background/network-safety";
import { DEFAULT_SECURITY_STATE } from "../../src/core/shared/security";
import { EMPTY_TRANSIENT_STATE } from "../../src/core/storage/storage";
import { AUTH, NOW, PROFILE, authenticatedState, createHarness, proxySession } from "./helpers";

const AUTHORIZATION: WebAuthorization = {
  clientId: "fuzevpn-browser-extension",
  code: "synthetic-one-use-code-for-controller-tests",
  redirectUri: "https://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.extensions.allizom.org/auth",
  codeVerifier: "synthetic-pkce-verifier-for-controller-tests-43",
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function service() {
  return { authorize: vi.fn<WebAuthService["authorize"]>().mockResolvedValue(AUTHORIZATION) };
}

async function armed(webAuth = service()) {
  const harness = createHarness({
    webAuth,
    persisted: authenticatedState({
      auth: { ...AUTH, expiresAt: new Date(NOW - 1).toISOString() },
    }),
    activeProxy: proxySession("expired-account-proxy"),
    security: {
      ...DEFAULT_SECURITY_STATE,
      protectionRequested: true,
      selectedLocationId: "frankfurt-01",
    },
  });
  await harness.controller.initialize();
  expect(harness.controller.getSnapshot()).toMatchObject({
    profile: null,
    trafficBlocked: true,
    protectionRequested: true,
  });
  return { ...harness, webAuth };
}

describe("web authentication controller", () => {
  it("safely initializes a fresh controller before its first web-auth command", async () => {
    const webAuth = service();
    const harness = createHarness({ webAuth });
    expect(await harness.controller.webLogin(false)).toEqual({ ok: true });
    expect(webAuth.authorize).toHaveBeenCalledOnce();
    expect(harness.storage.trustedConfigured).toBe(true);
    expect(harness.controller.getSnapshot()).toMatchObject({
      profile: PROFILE,
      webLoginPending: false,
    });
  });

  it("honors logout arriving during genuine first-start storage restoration", async () => {
    const gate = deferred<undefined>();
    const webAuth = service();
    const harness = createHarness({ webAuth });
    const readPersisted = harness.storage.readPersisted.bind(harness.storage);
    vi.spyOn(harness.storage, "readPersisted").mockImplementation(async () => {
      await gate.promise;
      return readPersisted();
    });
    const loggingIn = harness.controller.webLogin(false);
    await vi.waitFor(() => expect(harness.storage.readPersisted).toHaveBeenCalledOnce());
    const loggingOut = harness.controller.logout();
    gate.resolve(undefined);
    await loggingOut;
    expect(await loggingIn).toMatchObject({ ok: false, superseded: true });
    expect(webAuth.authorize).not.toHaveBeenCalled();
    expect(harness.api.exchangedCodes).toEqual([]);
    expect(harness.storage.persisted.auth).toBeNull();
  });

  it.each([false, true])(
    "honors a logout arriving at the final initialization boundary with disconnectFirst=%s",
    async (disconnectFirst) => {
      const gate = deferred<undefined>();
      const harness = disconnectFirst ? await armed() : createHarness({ webAuth: service() });
      await harness.controller.initialize();
      const initialize = harness.controller.initialize.bind(harness.controller);
      let calls = 0;
      vi.spyOn(harness.controller, "initialize").mockImplementation(async () => {
        calls += 1;
        if (calls === 2) await gate.promise;
        await initialize();
      });
      const loggingIn = harness.controller.webLogin(disconnectFirst);
      await vi.waitFor(() => expect(calls).toBe(2));
      expect(await harness.controller.logout()).toEqual({ ok: true });
      gate.resolve(undefined);
      expect(await loggingIn).toMatchObject({ ok: false, superseded: true });
      expect(harness.api.exchangedCodes).toEqual([]);
      expect(harness.storage.persisted.auth).toBeNull();
      expect(harness.controller.getSnapshot()).toMatchObject({
        profile: null,
        webLoginPending: false,
      });
    },
  );

  it("exchanges one code, hydrates the account and recovers its device without an implicit connection", async () => {
    const webAuth = service();
    const harness = createHarness({ webAuth });
    harness.identity.deviceIds.set(PROFILE.userId, "known-browser-device");
    await harness.controller.initialize();
    expect(await harness.controller.webLogin(false, "fr")).toEqual({ ok: true });
    expect(webAuth.authorize).toHaveBeenCalledOnce();
    expect(webAuth.authorize.mock.calls[0]?.[1]).toBe("fr");
    expect(harness.api.exchangedCodes).toEqual([AUTHORIZATION]);
    expect(harness.storage.persisted.auth).toEqual(AUTH);
    expect(harness.controller.getSnapshot()).toMatchObject({
      status: "disconnected",
      profile: PROFILE,
      currentDeviceId: "known-browser-device",
      protected: false,
      protectionRequested: false,
      webLoginPending: false,
    });
    expect(harness.api.proofs).toEqual([]);
    expect(harness.proxy.active).toBeNull();
    expect(harness.snapshots.some((snapshot) => snapshot.webLoginPending === true)).toBe(true);
    expect(harness.snapshots.at(-1)?.webLoginPending).toBe(false);
  });

  it("enrolls the browser through the ordinary device-proof path only after an explicit VPN connection", async () => {
    const harness = createHarness({ webAuth: service() });
    await harness.controller.initialize();
    expect((await harness.controller.webLogin(false)).ok).toBe(true);
    expect(harness.api.enrollCalls).toBe(0);
    expect((await harness.controller.connect("frankfurt-01")).ok).toBe(true);
    expect(harness.api.enrollCalls).toBe(1);
    expect(harness.api.proofs[0]?.deviceId).toBe("browser-device-1");
    expect(harness.controller.getSnapshot().protected).toBe(true);
  });

  it.each([false, true])(
    "refuses to replace an existing profile even with disconnectFirst=%s",
    async (disconnectFirst) => {
      const webAuth = service();
      const harness = createHarness({ webAuth, persisted: authenticatedState() });
      await harness.controller.initialize();
      expect(await harness.controller.webLogin(disconnectFirst)).toMatchObject({
        ok: false,
        commandError: "login_requires_disconnect",
      });
      expect(webAuth.authorize).not.toHaveBeenCalled();
      expect(harness.api.exchangedCodes).toEqual([]);
      expect(harness.storage.persisted.auth).toEqual(AUTH);
      expect(harness.controller.getSnapshot().profile).toEqual(PROFILE);
    },
  );

  it("retains the expired-account guard without explicit disconnect authorization", async () => {
    const harness = await armed();
    const releases = harness.safety.events.filter((event) => event === "release").length;
    expect(await harness.controller.webLogin(false)).toMatchObject({
      ok: false,
      commandError: "login_requires_disconnect",
    });
    expect(harness.webAuth.authorize).not.toHaveBeenCalled();
    expect(harness.safety.events.filter((event) => event === "release")).toHaveLength(releases);
    expect(harness.proxy.active).not.toBeNull();
    expect(harness.controller.getSnapshot()).toMatchObject({
      trafficBlocked: true,
      protectionRequested: true,
      webLoginPending: false,
    });
  });

  it("completes every local protection cleanup before opening web authentication", async () => {
    const harness = await armed();
    harness.webAuth.authorize.mockImplementation(async () => {
      expect(harness.proxy.active).toBeNull();
      expect(harness.storage.transient).toEqual(EMPTY_TRANSIENT_STATE);
      expect(harness.alarms.session).toBeNull();
      expect(harness.alarms.retryAt).toBeNull();
      expect(harness.alarms.reconnectAt).toBeNull();
      expect(harness.safety.status).toMatchObject({
        trafficBlocked: false,
        webRtcProtected: false,
        filterActive: false,
      });
      expect(harness.securityStorage.state).toMatchObject({
        protectionRequested: false,
        nextRetryAt: null,
        reconnectAttempts: 0,
      });
      expect(harness.storage.persisted.autoConnect).toBe(false);
      return AUTHORIZATION;
    });
    expect(await harness.controller.webLogin(true)).toEqual({ ok: true });
    expect(harness.webAuth.authorize).toHaveBeenCalledOnce();
    expect(harness.controller.getSnapshot()).toMatchObject({
      protectionRequested: false,
      trafficBlocked: false,
      webRtcProtected: false,
    });
  });

  it.each(["proxy", "webrtc", "dnr", "transient", "alarms", "security-storage", "account-storage"])(
    "does not open any authentication window after failed %s cleanup",
    async (failure) => {
      const harness = await armed();
      const rejected = new SafetyError("traffic_guard_failed");
      if (failure === "proxy") vi.spyOn(harness.proxy, "clear").mockRejectedValue(rejected);
      if (failure === "webrtc")
        vi.spyOn(harness.safety, "setWebRtc").mockRejectedValue(
          new SafetyError("webrtc_control_unavailable"),
        );
      if (failure === "dnr") vi.spyOn(harness.safety, "release").mockRejectedValue(rejected);
      if (failure === "transient")
        vi.spyOn(harness.storage, "clearTransient").mockRejectedValue(rejected);
      if (failure === "alarms") vi.spyOn(harness.alarms, "clearAll").mockRejectedValue(rejected);
      if (failure === "security-storage")
        vi.spyOn(harness.securityStorage, "write").mockRejectedValue(rejected);
      if (failure === "account-storage")
        vi.spyOn(harness.storage, "writePersisted").mockRejectedValue(rejected);
      expect((await harness.controller.webLogin(true)).ok).toBe(false);
      expect(harness.webAuth.authorize).not.toHaveBeenCalled();
      expect(harness.api.exchangedCodes).toEqual([]);
      expect(harness.controller.getSnapshot().webLoginPending).toBe(false);
    },
  );

  it.each(["web_login_timeout", "web_login_cancelled", "web_login_unavailable"] as const)(
    "publishes %s and leaves an explicitly released browser disconnected",
    async (code) => {
      const harness = await armed();
      harness.webAuth.authorize.mockRejectedValue(new WebAuthError(code));
      expect(await harness.controller.webLogin(true)).toMatchObject({
        ok: false,
        commandError: code,
      });
      expect(harness.api.exchangedCodes).toEqual([]);
      expect(harness.controller.getSnapshot()).toMatchObject({
        error: code,
        profile: null,
        webLoginPending: false,
        protectionRequested: false,
        trafficBlocked: false,
        protected: false,
      });
    },
  );

  it("allows only one pending web flow across two simultaneous clicks", async () => {
    const gate = deferred<WebAuthorization>();
    const webAuth = service();
    webAuth.authorize.mockImplementation(() => gate.promise);
    const harness = createHarness({ webAuth });
    await harness.controller.initialize();
    const first = harness.controller.webLogin(false);
    await vi.waitFor(() => expect(webAuth.authorize).toHaveBeenCalledOnce());
    expect(harness.controller.getSnapshot().webLoginPending).toBe(true);
    expect(await harness.controller.webLogin(false)).toEqual({
      ok: false,
      commandError: "web_login_busy",
    });
    expect(webAuth.authorize).toHaveBeenCalledOnce();
    gate.resolve(AUTHORIZATION);
    expect(await first).toEqual({ ok: true });
    expect(harness.api.exchangedCodes).toHaveLength(1);
    expect(harness.controller.getSnapshot().webLoginPending).toBe(false);
  });

  it.each(["logout", "disconnect", "connect"] as const)(
    "ignores authorization returned after %s even when the provider ignores abort",
    async (command) => {
      const gate = deferred<WebAuthorization>();
      const webAuth = service();
      webAuth.authorize.mockImplementation(() => gate.promise);
      const harness = createHarness({ webAuth });
      await harness.controller.initialize();
      const loggingIn = harness.controller.webLogin(false);
      await vi.waitFor(() => expect(webAuth.authorize).toHaveBeenCalledOnce());
      if (command === "connect") await harness.controller.connect("frankfurt-01");
      else await harness.controller[command]();
      gate.resolve(AUTHORIZATION);
      expect(await loggingIn).toMatchObject({ ok: false, superseded: true });
      expect(harness.api.exchangedCodes).toEqual([]);
      expect(harness.storage.persisted.auth).toBeNull();
      expect(harness.controller.getSnapshot()).toMatchObject({
        profile: null,
        protected: false,
        webLoginPending: false,
      });
    },
  );

  it.each(["logout", "disconnect", "connect"] as const)(
    "does not store a late token exchange after %s even when fetch ignores abort",
    async (command) => {
      const gate = deferred<typeof AUTH>();
      const harness = createHarness({ webAuth: service() });
      const exchange = vi
        .spyOn(harness.api, "exchangeExtensionCode")
        .mockImplementation(() => gate.promise);
      await harness.controller.initialize();
      const loggingIn = harness.controller.webLogin(false);
      await vi.waitFor(() => expect(exchange).toHaveBeenCalledOnce());
      if (command === "connect") await harness.controller.connect("frankfurt-01");
      else await harness.controller[command]();
      gate.resolve(AUTH);
      expect(await loggingIn).toMatchObject({ ok: false, superseded: true });
      expect(harness.storage.persisted.auth).toBeNull();
      expect(harness.controller.getSnapshot()).toMatchObject({
        profile: null,
        protected: false,
        webLoginPending: false,
      });
    },
  );

  it("does not restore a device after a reset supersedes post-authentication device hydration", async () => {
    const gate = deferred<string | null>();
    const harness = createHarness({ webAuth: service() });
    const device = vi
      .spyOn(harness.identity, "getDeviceId")
      .mockImplementationOnce(() => gate.promise);
    await harness.controller.initialize();
    const loggingIn = harness.controller.webLogin(false);
    await vi.waitFor(() => expect(device).toHaveBeenCalledOnce());
    expect(harness.controller.getSnapshot().profile).toEqual(PROFILE);
    expect(await harness.controller.resetDeviceIdentity()).toEqual({ ok: true });
    gate.resolve("stale-device-id");
    expect(await loggingIn).toMatchObject({ ok: false, superseded: true });
    expect(harness.identity.clearCalls).toBe(1);
    expect(harness.controller.getSnapshot()).toMatchObject({
      currentDeviceId: null,
      protected: false,
      webLoginPending: false,
    });
  });

  it.each([
    [new ApiError("extension_auth_invalid_grant", 400), "web_login_denied"],
    [new ApiError("extension_auth_unavailable", 503), "web_login_unavailable"],
    [new NetworkError("network"), "network_error"],
    [new NetworkError("timeout"), "request_timeout"],
  ] as const)("never retries a one-use code after %s", async (error, code) => {
    const harness = createHarness({ webAuth: service() });
    harness.api.loginError = error;
    await harness.controller.initialize();
    expect(await harness.controller.webLogin(false)).toMatchObject({
      ok: false,
      commandError: code,
    });
    expect(harness.api.exchangedCodes).toEqual([AUTHORIZATION]);
    expect(harness.storage.persisted.auth).toBeNull();
    expect(harness.alarms.reconnectAt).toBeNull();
    expect(harness.controller.getSnapshot()).toMatchObject({ error: code, webLoginPending: false });
  });

  it("rejects an already expired token before any persistence or account hydration", async () => {
    const harness = createHarness({ webAuth: service() });
    harness.api.auth = { ...AUTH, expiresAt: new Date(NOW).toISOString() };
    const profile = vi.spyOn(harness.api, "getProfile");
    await harness.controller.initialize();
    expect(await harness.controller.webLogin(false)).toMatchObject({
      ok: false,
      commandError: "invalid_response",
    });
    expect(harness.api.exchangedCodes).toHaveLength(1);
    expect(profile).not.toHaveBeenCalled();
    expect(harness.storage.persisted.auth).toBeNull();
  });
});
