// SPDX-License-Identifier: MPL-2.0

import type { AuthSession } from "../../src/core/api/types";
import type { WebAuthorization, WebAuthService } from "../../src/core/auth/web-auth";
import { SafetyError } from "../../src/core/background/network-safety";
import { isExtensionRequest } from "../../src/core/shared/messages";
import { DEFAULT_SECURITY_STATE } from "../../src/core/shared/security";
import { AUTH, NOW, PROFILE, authenticatedState, createHarness, proxySession } from "./helpers";

const AUTHORIZATION: WebAuthorization = {
  clientId: "fuzevpn-browser-extension",
  code: "synthetic-one-use-code-for-cancel-tests-000",
  redirectUri: "https://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.extensions.allizom.org/auth",
  codeVerifier: "synthetic-pkce-verifier-for-cancel-tests-0000043",
};

const aborted = () => new DOMException("Web authentication cancelled", "AbortError");

/** A sign-in window which stays open until it is released, and ends when it is aborted. */
function openWindow() {
  const windows: { signal?: AbortSignal; release(value: WebAuthorization): void }[] = [];
  const authorize = vi.fn<WebAuthService["authorize"]>(
    (signal) =>
      new Promise<WebAuthorization>((resolve, reject) => {
        if (signal?.aborted) {
          reject(aborted());
          return;
        }
        signal?.addEventListener("abort", () => reject(aborted()), { once: true });
        windows.push({ signal, release: resolve });
      }),
  );
  return { authorize, windows };
}

afterEach(() => vi.restoreAllMocks());

describe("giving up a web sign-in from the popup", () => {
  it("is a command of the extension pages", () => {
    expect(isExtensionRequest({ type: "cancel_web_login" })).toBe(true);
  });

  it("ends the pending attempt like a closed sign-in window", async () => {
    const webAuth = openWindow();
    const h = createHarness({ webAuth });
    const signingIn = h.controller.webLogin(false);
    await vi.waitFor(() => expect(webAuth.windows).toHaveLength(1));
    expect(h.controller.getSnapshot().webLoginPending).toBe(true);

    expect(h.controller.cancelWebLogin()).toEqual({ ok: true });

    expect(await signingIn).toEqual({ ok: false, commandError: "web_login_cancelled" });
    expect(webAuth.windows[0]?.signal?.aborted).toBe(true);
    expect(h.api.exchangedCodes).toEqual([]);
    expect(h.storage.persisted.auth).toBeNull();
    expect(h.controller.getSnapshot()).toMatchObject({
      profile: null,
      webLoginPending: false,
      error: "web_login_cancelled",
    });
  });

  it("lets the next attempt open a new window and sign in", async () => {
    const webAuth = openWindow();
    const h = createHarness({ webAuth });
    const first = h.controller.webLogin(false);
    await vi.waitFor(() => expect(webAuth.windows).toHaveLength(1));
    h.controller.cancelWebLogin();
    await first;

    const second = h.controller.webLogin(false);
    await vi.waitFor(() => expect(webAuth.windows).toHaveLength(2));
    webAuth.windows[1]?.release(AUTHORIZATION);

    expect(await second).toEqual({ ok: true });
    expect(h.api.exchangedCodes).toHaveLength(1);
    expect(h.controller.getSnapshot()).toMatchObject({
      profile: PROFILE,
      webLoginPending: false,
      error: null,
    });
  });

  it("discards a window which returns its code although it was given up", async () => {
    // A window which ignores its cancellation and still returns later.
    let release!: (value: WebAuthorization) => void;
    const authorize = vi.fn<WebAuthService["authorize"]>(
      () =>
        new Promise<WebAuthorization>((resolve) => {
          release = resolve;
        }),
    );
    const h = createHarness({ webAuth: { authorize } });
    const signingIn = h.controller.webLogin(false);
    await vi.waitFor(() => expect(authorize).toHaveBeenCalledOnce());

    h.controller.cancelWebLogin();
    release(AUTHORIZATION);

    expect(await signingIn).toEqual({ ok: false, commandError: "web_login_cancelled" });
    expect(h.api.exchangedCodes).toEqual([]);
    expect(h.controller.getSnapshot().profile).toBeNull();
  });

  it("is given up before its window opens when the command arrives during startup", async () => {
    const webAuth = openWindow();
    const h = createHarness({ webAuth });
    const signingIn = h.controller.webLogin(false);
    // The attempt exists as soon as its command is received, before its window.
    h.controller.cancelWebLogin();

    expect(await signingIn).toEqual({ ok: false, commandError: "web_login_cancelled" });
    expect(webAuth.windows).toHaveLength(0);
    expect(h.api.exchangedCodes).toEqual([]);
  });

  it("changes nothing once the window has returned its code", async () => {
    const webAuth = openWindow();
    const h = createHarness({ webAuth });
    let finishExchange!: () => void;
    const exchanging = new Promise<void>((resolve) => {
      finishExchange = resolve;
    });
    const exchange = h.api.exchangeExtensionCode.bind(h.api);
    const exchanged = vi
      .spyOn(h.api, "exchangeExtensionCode")
      .mockImplementation(async (...args): Promise<AuthSession> => {
        await exchanging;
        return exchange(...args);
      });
    const signingIn = h.controller.webLogin(false);
    await vi.waitFor(() => expect(webAuth.windows).toHaveLength(1));
    webAuth.windows[0]?.release(AUTHORIZATION);
    await vi.waitFor(() => expect(exchanged).toHaveBeenCalledOnce());

    // The one-use code is being exchanged: the account it opens is not dropped.
    expect(h.controller.cancelWebLogin()).toEqual({ ok: true });
    finishExchange();

    expect(await signingIn).toEqual({ ok: true });
    expect(h.controller.getSnapshot()).toMatchObject({ profile: PROFILE, error: null });
  });

  it("changes nothing without a pending sign-in", async () => {
    const h = createHarness({ webAuth: openWindow() });
    await h.controller.initialize();
    const before = h.controller.getSnapshot();

    expect(h.controller.cancelWebLogin()).toEqual({ ok: true });

    expect(h.controller.getSnapshot()).toEqual(before);
  });

  it("leaves a sign-in which another command superseded reported as superseded", async () => {
    const webAuth = openWindow();
    const h = createHarness({ webAuth });
    const signingIn = h.controller.webLogin(false);
    await vi.waitFor(() => expect(webAuth.windows).toHaveLength(1));

    await h.controller.logout();
    h.controller.cancelWebLogin();

    expect(await signingIn).toMatchObject({ ok: false, superseded: true });
    expect(h.controller.getSnapshot().error).not.toBe("web_login_cancelled");
  });
});

describe("giving up a sign-in while protection is being released for it", () => {
  async function armedWithoutAccount(webAuth: ReturnType<typeof openWindow>) {
    const h = createHarness({
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
    await h.controller.initialize();
    expect(h.controller.getSnapshot()).toMatchObject({
      profile: null,
      trafficBlocked: true,
      protectionRequested: true,
    });
    return h;
  }

  it("requests again the protection which was released for nothing", async () => {
    const webAuth = openWindow();
    const h = await armedWithoutAccount(webAuth);
    // The release is in progress when the user gives the sign-in up.
    let finish!: () => void;
    const releasing = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const release = h.safety.release.bind(h.safety);
    const released = vi.spyOn(h.safety, "release").mockImplementationOnce(async () => {
      await releasing;
      await release();
    });

    const signingIn = h.controller.webLogin(true);
    await vi.waitFor(() => expect(released).toHaveBeenCalledOnce());
    h.controller.cancelWebLogin();
    finish();

    expect(await signingIn).toEqual({ ok: false, commandError: "web_login_cancelled" });
    // No window was opened, and the guard is back as the user had left it.
    expect(webAuth.windows).toHaveLength(0);
    expect(h.securityStorage.state).toMatchObject({
      protectionRequested: true,
      selectedLocationId: "frankfurt-01",
    });
    expect(h.safety.status.trafficBlocked).toBe(true);
    expect(h.controller.getSnapshot()).toMatchObject({
      profile: null,
      protected: false,
      trafficBlocked: true,
      protectionRequested: true,
      webLoginPending: false,
      error: "web_login_cancelled",
    });
  });

  it("reports a guard which cannot be closed again", async () => {
    const webAuth = openWindow();
    const h = await armedWithoutAccount(webAuth);
    let finish!: () => void;
    const releasing = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const release = h.safety.release.bind(h.safety);
    const released = vi.spyOn(h.safety, "release").mockImplementationOnce(async () => {
      await releasing;
      await release();
      // From here on the browser refuses the rules.
      vi.spyOn(h.safety, "block").mockRejectedValue(new SafetyError("traffic_guard_failed"));
    });

    const signingIn = h.controller.webLogin(true);
    await vi.waitFor(() => expect(released).toHaveBeenCalledOnce());
    h.controller.cancelWebLogin();
    finish();

    expect(await signingIn).toMatchObject({ ok: false });
    expect(webAuth.windows).toHaveLength(0);
    expect(h.controller.getSnapshot()).toMatchObject({
      profile: null,
      webLoginPending: false,
      error: "traffic_guard_failed",
      protectionRequested: false,
    });
    expect(h.securityStorage.state?.protectionRequested).toBe(false);
  });

  it("opens the sign-in window when nobody gave it up", async () => {
    const webAuth = openWindow();
    const h = await armedWithoutAccount(webAuth);

    const signingIn = h.controller.webLogin(true);
    await vi.waitFor(() => expect(webAuth.windows).toHaveLength(1));
    expect(h.controller.getSnapshot()).toMatchObject({
      trafficBlocked: false,
      protectionRequested: false,
    });
    h.controller.cancelWebLogin();
    expect(await signingIn).toEqual({ ok: false, commandError: "web_login_cancelled" });
    // Given up at its window, after the release it asked for: nothing is armed again.
    expect(h.controller.getSnapshot()).toMatchObject({ protectionRequested: false });
  });
});

describe("giving up a sign-in which must release protection first", () => {
  it("keeps the protection which the sign-in would have released", async () => {
    const webAuth = openWindow();
    const h = createHarness({
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
    await h.controller.initialize();
    expect(h.controller.getSnapshot()).toMatchObject({
      profile: null,
      trafficBlocked: true,
      protectionRequested: true,
    });

    const signingIn = h.controller.webLogin(true);
    h.controller.cancelWebLogin();

    expect(await signingIn).toEqual({ ok: false, commandError: "web_login_cancelled" });
    expect(webAuth.windows).toHaveLength(0);
    expect(h.securityStorage.state?.protectionRequested).toBe(true);
    expect(h.controller.getSnapshot()).toMatchObject({
      profile: null,
      trafficBlocked: true,
      protectionRequested: true,
      webLoginPending: false,
      error: "web_login_cancelled",
    });
  });
});
