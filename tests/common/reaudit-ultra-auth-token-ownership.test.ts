// SPDX-License-Identifier: MPL-2.0

import { ApiError, type ApiService } from "../../src/core/api/client";
import type { WebAuthorization } from "../../src/core/auth/web-auth";
import { EMPTY_PERSISTED_STATE, type PersistedState } from "../../src/core/storage/storage";
import { AUTH, NOW, PROFILE, authenticatedState, createHarness } from "./helpers";

const AUTHORIZATION: WebAuthorization = {
  clientId: "fuzevpn-browser-extension",
  code: "synthetic-one-use-code-for-ownership-tests",
  redirectUri: "https://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.extensions.allizom.org/auth",
  codeVerifier: "synthetic-pkce-verifier-for-ownership-tests-43",
};

const webAuth = { authorize: async () => AUTHORIZATION };

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

type Harness = ReturnType<typeof createHarness>;

/** Suspends the first account write which carries `token` until released. */
function holdAuthenticationWrite(h: Harness, token = AUTH.accessToken) {
  const writing = deferred();
  const release = deferred();
  const write = h.storage.writePersisted.bind(h.storage);
  let held = false;
  vi.spyOn(h.storage, "writePersisted").mockImplementation(async (state: PersistedState) => {
    if (!held && state.auth?.accessToken === token) {
      held = true;
      writing.resolve();
      await release.promise;
    }
    await write(state);
  });
  return { writing: writing.promise, release: release.resolve };
}

/** Suspends the first security write which follows an account credential write. */
function holdSecurityWriteAfterCredential(h: Harness) {
  const reached = deferred();
  const release = deferred();
  const writePersisted = h.storage.writePersisted.bind(h.storage);
  const writeSecurity = h.securityStorage.write.bind(h.securityStorage);
  let armed = false;
  let held = false;
  vi.spyOn(h.storage, "writePersisted").mockImplementation(async (state: PersistedState) => {
    if (state.auth) armed = true;
    await writePersisted(state);
  });
  vi.spyOn(h.securityStorage, "write").mockImplementation(async (state) => {
    if (armed && !held) {
      held = true;
      reached.resolve();
      await release.promise;
    }
    await writeSecurity(state);
  });
  return { reached: reached.promise, release: release.resolve };
}

/**
 * Suspends the first profile request of account hydration until released.
 * An abortable request rejects on abort, like the browser fetch.
 */
function holdProfileRequest(h: Harness, abortable = false) {
  const reached = deferred();
  const release = deferred();
  const getProfile = h.api.getProfile.bind(h.api);
  let held = false;
  vi.spyOn(h.api as ApiService, "getProfile").mockImplementation(async (_token, signal) => {
    if (!held) {
      held = true;
      reached.resolve();
      await new Promise<void>((done, fail) => {
        void release.promise.then(done);
        if (abortable)
          signal?.addEventListener("abort", () => fail(new DOMException("Aborted", "AbortError")));
      });
    }
    return getProfile();
  });
  return { reached: reached.promise, release: release.resolve };
}

/** Suspends the first account write which drops `token` after it was written. */
function holdRollbackWrite(h: Harness, token = AUTH.accessToken) {
  const reached = deferred();
  const release = deferred();
  const write = h.storage.writePersisted.bind(h.storage);
  let written = false;
  let held = false;
  vi.spyOn(h.storage, "writePersisted").mockImplementation(async (state: PersistedState) => {
    if (state.auth?.accessToken === token) written = true;
    else if (written && !held) {
      held = true;
      reached.resolve();
      await release.promise;
    }
    await write(state);
  });
  return { reached: reached.promise, release: release.resolve };
}

function operationId(h: Harness): number {
  return (h.controller as unknown as { operationId: number }).operationId;
}

/** The account credential the controller would use next, which storage may not show. */
function currentCredential(h: Harness) {
  return (h.controller as unknown as { persisted: PersistedState }).persisted.auth;
}

const settle = () => new Promise<void>((done) => setImmediate(done));

/** Starts a security preference command and waits until it supersedes the login. */
async function supersedeWithPreference(h: Harness) {
  const before = operationId(h);
  const preference = h.controller.updateSecurityPreferences(false, false);
  await vi.waitFor(() => expect(operationId(h)).toBeGreaterThan(before));
  // Wrapped: the command may wait for the suspended login to release state.
  return { preference };
}

/** The account a new worker restores from the resulting storage. */
async function restartedSnapshot(h: Harness) {
  const restarted = createHarness({
    persisted: h.storage.persisted,
    security: h.securityStorage.state!,
  });
  await restarted.controller.initialize();
  // Startup hydrates a restored account in the background.
  await new Promise<void>((done) => setImmediate(done));
  return restarted.controller.getSnapshot();
}

describe("ownership of a token issued to a superseded authentication", () => {
  afterEach(() => vi.restoreAllMocks());

  it.each(["confirmed", "unconfirmed"] as const)(
    "lets logout revoke a token whose storage write it superseded (%s)",
    async (revocation) => {
      const h = createHarness({ webAuth });
      await h.controller.initialize();
      const hold = holdAuthenticationWrite(h);
      const apiLogout = vi.spyOn(h.api, "logout");
      if (revocation === "unconfirmed")
        apiLogout.mockRejectedValue(new ApiError("server_error", 500));
      const loggingIn = h.controller.webLogin(false);
      await hold.writing;
      const loggingOut = h.controller.logout();
      await vi.waitFor(() =>
        expect(h.controller.getSnapshot().logoutOutcome?.apiSession).toBe("pending"),
      );
      hold.release();

      expect(await loggingIn).toEqual({ ok: false, superseded: true });
      expect(await loggingOut).toEqual({ ok: true });
      expect(h.storage.persisted).toEqual(EMPTY_PERSISTED_STATE);
      // Logout owns the claimed token: one request, and no confirmation without it.
      expect(apiLogout).toHaveBeenCalledExactlyOnceWith(AUTH.accessToken);
      expect(h.controller.getSnapshot().logoutOutcome).toEqual({
        apiSession: revocation,
        proxySessions: "confirmed",
      });
    },
  );

  it("revokes both the committed account and a pending replacement on logout", async () => {
    const h = createHarness({ persisted: authenticatedState() });
    await h.controller.initialize();
    const replacement = "synthetic-replacement-account-token";
    h.api.auth = { ...AUTH, accessToken: replacement };
    const hold = holdAuthenticationWrite(h, replacement);
    const apiLogout = vi.spyOn(h.api as ApiService, "logout");
    const loggingIn = h.controller.login("b@example.invalid", "synthetic");
    await hold.writing;
    const loggingOut = h.controller.logout();
    await vi.waitFor(() =>
      expect(h.controller.getSnapshot().logoutOutcome?.apiSession).toBe("pending"),
    );
    hold.release();

    expect(await loggingIn).toEqual({ ok: false, superseded: true });
    expect(await loggingOut).toEqual({ ok: true });
    expect(h.storage.persisted).toEqual(EMPTY_PERSISTED_STATE);
    expect(apiLogout.mock.calls.map(([token]) => token).sort()).toEqual(
      [AUTH.accessToken, replacement].sort(),
    );
    expect(h.controller.getSnapshot().logoutOutcome?.apiSession).toBe("confirmed");
  });

  it("rolls back and revokes a web login cancelled by a security preference", async () => {
    const h = createHarness({ webAuth });
    await h.controller.initialize();
    const hold = holdAuthenticationWrite(h);
    const apiLogout = vi.spyOn(h.api, "logout");
    const loggingIn = h.controller.webLogin(false);
    await hold.writing;
    const before = operationId(h);
    const preference = h.controller.updateSecurityPreferences(false, false);
    await vi.waitFor(() => expect(operationId(h)).toBeGreaterThan(before));
    hold.release();

    expect(await loggingIn).toEqual({ ok: false, superseded: true });
    expect(await preference).toEqual({ ok: true });
    expect(h.controller.getSnapshot()).toMatchObject({ status: "logged_out", profile: null });
    expect(h.storage.persisted).toEqual(EMPTY_PERSISTED_STATE);
    expect(apiLogout).toHaveBeenCalledExactlyOnceWith(AUTH.accessToken);

    const restarted = createHarness({
      persisted: h.storage.persisted,
      security: h.securityStorage.state!,
    });
    await restarted.controller.initialize();
    await new Promise<void>((done) => setImmediate(done));
    expect(restarted.controller.getSnapshot()).toMatchObject({
      status: "logged_out",
      profile: null,
    });
  });

  it("revokes an issued token whose first durable write fails", async () => {
    const h = createHarness();
    await h.controller.initialize();
    const write = h.storage.writePersisted.bind(h.storage);
    vi.spyOn(h.storage, "writePersisted").mockImplementation(async (state) => {
      if (state.auth) throw new Error("unavailable");
      await write(state);
    });
    const apiLogout = vi.spyOn(h.api, "logout");

    expect(await h.controller.login("a@example.invalid", "synthetic")).toMatchObject({
      ok: false,
    });
    expect(h.storage.persisted).toEqual(EMPTY_PERSISTED_STATE);
    expect(apiLogout).toHaveBeenCalledExactlyOnceWith(AUTH.accessToken);
  });

  it("never revokes a reused token that a newer login is committing", async () => {
    const h = createHarness();
    await h.controller.initialize();
    const hold = holdAuthenticationWrite(h);
    const apiLogout = vi.spyOn(h.api, "logout");
    const login = vi.spyOn(h.api, "login");
    const first = h.controller.login("a@example.invalid", "synthetic");
    await hold.writing;
    // The authenticator returns the same credential to the newer login.
    const second = h.controller.login("a@example.invalid", "synthetic");
    await vi.waitFor(() => expect(login).toHaveBeenCalledTimes(2));
    await new Promise<void>((done) => setImmediate(done));
    hold.release();

    expect(await first).toEqual({ ok: false, superseded: true });
    expect(await second).toEqual({ ok: true });
    expect(apiLogout).not.toHaveBeenCalled();
    expect(h.storage.persisted.auth).toEqual(AUTH);
    expect(h.controller.getSnapshot().profile).toEqual(PROFILE);
  });
});

describe("ownership of a committed credential until its account is published", () => {
  afterEach(() => vi.restoreAllMocks());

  it.each([
    ["security write", holdSecurityWriteAfterCredential],
    ["profile request", holdProfileRequest],
  ] as const)(
    "rolls back and revokes a web login cancelled by a preference during its %s",
    async (_phase, hold) => {
      const h = createHarness({ webAuth });
      await h.controller.initialize();
      const held = hold(h);
      const apiLogout = vi.spyOn(h.api, "logout");
      const loggingIn = h.controller.webLogin(false);
      await held.reached;
      const { preference } = await supersedeWithPreference(h);
      held.release();

      expect(await loggingIn).toEqual({ ok: false, superseded: true });
      expect(await preference).toEqual({ ok: true });
      expect(h.controller.getSnapshot()).toMatchObject({ status: "logged_out", profile: null });
      expect(h.storage.persisted).toEqual(EMPTY_PERSISTED_STATE);
      expect(apiLogout).toHaveBeenCalledExactlyOnceWith(AUTH.accessToken);
      expect(await restartedSnapshot(h)).toMatchObject({ status: "logged_out", profile: null });
    },
  );

  it("revokes a cancelled web login before a retry replaces it", async () => {
    const h = createHarness({ webAuth });
    await h.controller.initialize();
    const held = holdProfileRequest(h);
    const apiLogout = vi.spyOn(h.api, "logout");
    const loggingIn = h.controller.webLogin(false);
    await held.reached;
    const { preference } = await supersedeWithPreference(h);
    held.release();
    expect(await loggingIn).toEqual({ ok: false, superseded: true });
    await preference;

    const retry = { ...AUTH, accessToken: "synthetic-retried-web-login-token" };
    h.api.auth = retry;
    expect(await h.controller.webLogin(false)).toEqual({ ok: true });
    expect(apiLogout).toHaveBeenCalledExactlyOnceWith(AUTH.accessToken);
    expect(h.storage.persisted.auth).toEqual(retry);
    expect(h.controller.getSnapshot().profile).toEqual(PROFILE);
  });

  it("restores the disconnected account replaced by a cancelled login", async () => {
    const h = createHarness({ persisted: authenticatedState() });
    await h.controller.initialize();
    await new Promise<void>((done) => setImmediate(done));
    const stored = structuredClone(h.storage.persisted);
    const replacement = { ...AUTH, accessToken: "synthetic-replacement-account-token" };
    h.api.auth = replacement;
    const held = holdProfileRequest(h);
    const apiLogout = vi.spyOn(h.api, "logout");
    const loggingIn = h.controller.login("b@example.invalid", "synthetic");
    await held.reached;
    const { preference } = await supersedeWithPreference(h);
    held.release();

    expect(await loggingIn).toEqual({ ok: false, superseded: true });
    expect(await preference).toEqual({ ok: true });
    expect(h.storage.persisted).toEqual(stored);
    expect(h.controller.getSnapshot()).toMatchObject({
      status: "disconnected",
      profile: PROFILE,
      selectedLocationId: stored.selectedLocationId,
    });
    expect(apiLogout).toHaveBeenCalledExactlyOnceWith(replacement.accessToken);
    expect((await restartedSnapshot(h)).profile).toEqual(PROFILE);
  });

  it("lets logout alone revoke a committed credential whose account is unpublished", async () => {
    const h = createHarness({ webAuth });
    await h.controller.initialize();
    const held = holdProfileRequest(h);
    const apiLogout = vi.spyOn(h.api, "logout");
    const loggingIn = h.controller.webLogin(false);
    await held.reached;
    expect(await h.controller.logout()).toEqual({ ok: true });
    held.release();

    expect(await loggingIn).toEqual({ ok: false, superseded: true });
    await new Promise<void>((done) => setImmediate(done));
    expect(apiLogout).toHaveBeenCalledExactlyOnceWith(AUTH.accessToken);
    expect(h.storage.persisted).toEqual(EMPTY_PERSISTED_STATE);
    expect(h.controller.getSnapshot().logoutOutcome).toEqual({
      apiSession: "confirmed",
      proxySessions: "confirmed",
    });
    expect((await restartedSnapshot(h)).profile).toBeNull();
  });

  it("keeps a credential whose account a newer connection already published", async () => {
    const h = createHarness({ webAuth });
    await h.controller.initialize();
    const held = holdProfileRequest(h);
    const apiLogout = vi.spyOn(h.api, "logout");
    const loggingIn = h.controller.webLogin(false);
    await held.reached;
    // A stale extension page may still send a connection command.
    expect(await h.controller.connect("frankfurt-01")).toEqual({ ok: true });
    held.release();

    expect(await loggingIn).toEqual({ ok: false, superseded: true });
    await new Promise<void>((done) => setImmediate(done));
    expect(apiLogout).not.toHaveBeenCalled();
    expect(h.storage.persisted).toMatchObject({ auth: AUTH, profile: PROFILE });
    expect(h.controller.getSnapshot()).toMatchObject({ status: "connected", profile: PROFILE });
  });

  it("never attaches a profile to a credential rolled back under a newer connection", async () => {
    const h = createHarness({ webAuth });
    await h.controller.initialize();
    const reached = [deferred(), deferred()];
    const released = [deferred(), deferred()];
    const getProfile = h.api.getProfile.bind(h.api);
    let requests = 0;
    vi.spyOn(h.api, "getProfile").mockImplementation(async () => {
      const request = requests++;
      reached[request]?.resolve();
      await released[request]?.promise;
      return getProfile();
    });
    const writes: PersistedState[] = [];
    const write = h.storage.writePersisted.bind(h.storage);
    vi.spyOn(h.storage, "writePersisted").mockImplementation(async (state: PersistedState) => {
      writes.push(structuredClone(state));
      await write(state);
    });
    const apiLogout = vi.spyOn(h.api, "logout");
    const loggingIn = h.controller.webLogin(false);
    await reached[0]!.promise;
    const connecting = h.controller.connect("frankfurt-01");
    await reached[1]!.promise;
    released[0]!.resolve();
    expect(await loggingIn).toEqual({ ok: false, superseded: true });
    released[1]!.resolve();

    expect(await connecting).toEqual({ ok: false, commandError: "unauthorized" });
    expect(
      writes.filter((state) => state.profile && state.auth?.accessToken !== AUTH.accessToken),
    ).toEqual([]);
    expect(h.storage.persisted).toEqual(EMPTY_PERSISTED_STATE);
    expect(h.controller.getSnapshot().profile).toBeNull();
    expect(apiLogout).toHaveBeenCalledExactlyOnceWith(AUTH.accessToken);
  });

  it.each(["logout", "disconnect"] as const)(
    "revokes a web token exchanged after %s even when fetch ignores abort",
    async (command) => {
      const h = createHarness({ webAuth });
      await h.controller.initialize();
      const exchanged = deferred();
      const exchange = h.api.exchangeExtensionCode.bind(h.api);
      vi.spyOn(h.api, "exchangeExtensionCode").mockImplementation(async (code) => {
        await exchanged.promise;
        return exchange(code);
      });
      const apiLogout = vi.spyOn(h.api, "logout");
      const loggingIn = h.controller.webLogin(false);
      await vi.waitFor(() => expect(h.api.exchangeExtensionCode).toHaveBeenCalledOnce());
      expect(await h.controller[command]()).toEqual({ ok: true });
      exchanged.resolve();

      expect(await loggingIn).toEqual({ ok: false, superseded: true });
      expect(apiLogout).toHaveBeenCalledExactlyOnceWith(AUTH.accessToken);
      expect(h.storage.persisted).toEqual(EMPTY_PERSISTED_STATE);
    },
  );

  it("revokes a web token rejected locally as already expired", async () => {
    const h = createHarness({ webAuth });
    await h.controller.initialize();
    const expired = { ...AUTH, expiresAt: new Date(NOW).toISOString() };
    h.api.auth = expired;
    const apiLogout = vi.spyOn(h.api, "logout");

    expect(await h.controller.webLogin(false)).toMatchObject({
      ok: false,
      commandError: "invalid_response",
    });
    expect(apiLogout).toHaveBeenCalledExactlyOnceWith(expired.accessToken);
    expect(h.storage.persisted).toEqual(EMPTY_PERSISTED_STATE);
  });

  it("returns a cancelled web login without waiting for its revocation", async () => {
    // A revocation bounded by the production deadline would outlast this test.
    const h = createHarness({ webAuth, remoteCleanupTimeoutMs: 60_000 });
    await h.controller.initialize();
    const held = holdAuthenticationWrite(h);
    const revoking = deferred();
    vi.spyOn(h.api, "logout").mockImplementation(() => revoking.promise);
    const loggingIn = h.controller.webLogin(false);
    await held.writing;
    const { preference } = await supersedeWithPreference(h);
    held.release();

    expect(await loggingIn).toEqual({ ok: false, superseded: true });
    expect(await preference).toEqual({ ok: true });
    expect(h.controller.getSnapshot().webLoginPending).toBe(false);
    revoking.resolve();
  });

  it("reports a cancelled login's revocation still in flight in the next logout", async () => {
    const h = createHarness({ webAuth });
    await h.controller.initialize();
    const held = holdProfileRequest(h);
    const revoking = deferred();
    const apiLogout = vi.spyOn(h.api, "logout").mockImplementationOnce(async () => {
      await revoking.promise;
      throw new ApiError("server_error", 500);
    });
    const loggingIn = h.controller.webLogin(false);
    await held.reached;
    const { preference } = await supersedeWithPreference(h);
    held.release();
    expect(await loggingIn).toEqual({ ok: false, superseded: true });
    await preference;
    expect(apiLogout).toHaveBeenCalledExactlyOnceWith(AUTH.accessToken);

    h.api.auth = { ...AUTH, accessToken: "synthetic-second-web-login-token" };
    expect(await h.controller.webLogin(false)).toEqual({ ok: true });
    const loggingOut = h.controller.logout();
    await vi.waitFor(() => expect(apiLogout).toHaveBeenCalledTimes(2));
    revoking.resolve();

    expect(await loggingOut).toEqual({ ok: true });
    // The abandoned token was never confirmed revoked: logout cannot confirm it.
    expect(h.controller.getSnapshot().logoutOutcome?.apiSession).toBe("unconfirmed");
  });

  it.each(["preference", "disconnection"] as const)(
    "lets logout started during the rollback of a login cancelled by a %s revoke its token",
    async (command) => {
      const h = createHarness({ webAuth });
      await h.controller.initialize();
      const held = holdProfileRequest(h);
      const rollback = holdRollbackWrite(h);
      const apiLogout = vi.spyOn(h.api, "logout");
      const loggingIn = h.controller.webLogin(false);
      await held.reached;
      const before = operationId(h);
      const superseding =
        command === "preference"
          ? h.controller.updateSecurityPreferences(false, false)
          : h.controller.disconnect();
      await vi.waitFor(() => expect(operationId(h)).toBeGreaterThan(before));
      held.release();
      await rollback.reached;
      const loggingOut = h.controller.logout();
      await vi.waitFor(() =>
        expect(h.controller.getSnapshot().logoutOutcome?.apiSession).toBe("pending"),
      );
      rollback.release();

      expect(await loggingIn).toEqual({ ok: false, superseded: true });
      expect(await superseding).toEqual({ ok: true });
      // The rollback must neither abort this logout's account work nor outlive it.
      expect(await loggingOut).toEqual({ ok: true });
      expect(h.controller.getSnapshot().logoutOutcome).toEqual({
        apiSession: "confirmed",
        proxySessions: "confirmed",
      });
      expect(apiLogout).toHaveBeenCalledExactlyOnceWith(AUTH.accessToken);
      expect(h.storage.persisted).toEqual(EMPTY_PERSISTED_STATE);
      expect(currentCredential(h)).toBeNull();
    },
  );

  it("lets logout revoke a kept credential and the cancelled login rolled back to it", async () => {
    const h = createHarness({ webAuth });
    await h.controller.initialize();
    const held = holdProfileRequest(h);
    vi.mocked(h.api.getProfile).mockRejectedValueOnce(new ApiError("server_error", 503));
    const apiLogout = vi.spyOn(h.api as ApiService, "logout");
    // A current hydration failure keeps the committed credential.
    expect(await h.controller.webLogin(false)).toMatchObject({ ok: false });
    expect(h.storage.persisted.auth).toEqual(AUTH);
    const replacement = { ...AUTH, accessToken: "synthetic-replacement-web-login-token" };
    h.api.auth = replacement;
    const rollback = holdRollbackWrite(h, replacement.accessToken);
    const loggingIn = h.controller.webLogin(false);
    await held.reached;
    const { preference } = await supersedeWithPreference(h);
    held.release();
    await rollback.reached;
    const loggingOut = h.controller.logout();
    await vi.waitFor(() =>
      expect(h.controller.getSnapshot().logoutOutcome?.apiSession).toBe("pending"),
    );
    rollback.release();

    expect(await loggingIn).toEqual({ ok: false, superseded: true });
    expect(await preference).toEqual({ ok: true });
    expect(await loggingOut).toEqual({ ok: true });
    expect(apiLogout.mock.calls.map(([token]) => token).sort()).toEqual(
      [AUTH.accessToken, replacement.accessToken].sort(),
    );
    expect(h.controller.getSnapshot().logoutOutcome?.apiSession).toBe("confirmed");
    expect(h.storage.persisted).toEqual(EMPTY_PERSISTED_STATE);
    expect(currentCredential(h)).toBeNull();
  });

  it.each([false, true])(
    "revokes a kept credential which a retried web login replaces (retry fails: %s)",
    async (retryFails) => {
      const h = createHarness({ webAuth });
      await h.controller.initialize();
      const getProfile = vi
        .spyOn(h.api, "getProfile")
        .mockRejectedValueOnce(new ApiError("server_error", 503));
      if (retryFails) getProfile.mockRejectedValueOnce(new ApiError("server_error", 503));
      const apiLogout = vi.spyOn(h.api, "logout");
      expect(await h.controller.webLogin(false)).toMatchObject({ ok: false });
      expect(h.storage.persisted.auth).toEqual(AUTH);

      const retry = { ...AUTH, accessToken: "synthetic-retried-web-login-token" };
      h.api.auth = retry;
      expect(await h.controller.webLogin(false)).toMatchObject({ ok: !retryFails });
      // Only the retried credential is kept, even when its hydration fails too.
      expect(h.storage.persisted.auth).toEqual(retry);
      expect(apiLogout).toHaveBeenCalledExactlyOnceWith(AUTH.accessToken);
    },
  );

  it("never restores a credential which a superseded login abandons", async () => {
    const h = createHarness();
    await h.controller.initialize();
    const committing = holdSecurityWriteAfterCredential(h);
    const hydrating = holdProfileRequest(h);
    const login = vi.spyOn(h.api, "login");
    const apiLogout = vi.spyOn(h.api as ApiService, "logout");
    const first = h.controller.login("a@example.invalid", "synthetic");
    await committing.reached;
    const second = { ...AUTH, accessToken: "synthetic-second-password-login-token" };
    h.api.auth = second;
    // The newer login commits over the first one before its rollback runs.
    const loggingInAgain = h.controller.login("b@example.invalid", "synthetic");
    await vi.waitFor(() => expect(login).toHaveBeenCalledTimes(2));
    await settle();
    committing.release();
    await hydrating.reached;
    expect(await first).toEqual({ ok: false, superseded: true });
    const { preference } = await supersedeWithPreference(h);
    hydrating.release();

    expect(await loggingInAgain).toEqual({ ok: false, superseded: true });
    expect(await preference).toEqual({ ok: true });
    await settle();
    expect(apiLogout.mock.calls.map(([token]) => token).sort()).toEqual(
      [AUTH.accessToken, second.accessToken].sort(),
    );
    expect(h.storage.persisted).toEqual(EMPTY_PERSISTED_STATE);
    expect(h.controller.getSnapshot()).toMatchObject({ status: "logged_out", profile: null });
    expect((await restartedSnapshot(h)).profile).toBeNull();
  });

  it("fails a stale connection as unauthorized once the rollback aborts its hydration", async () => {
    const h = createHarness({ webAuth });
    await h.controller.initialize();
    const held = holdProfileRequest(h, true);
    const apiLogout = vi.spyOn(h.api, "logout");
    const loggingIn = h.controller.webLogin(false);
    await held.reached;
    // A stale extension page may still send a connection command.
    const connecting = h.controller.connect("frankfurt-01");

    expect(await loggingIn).toEqual({ ok: false, superseded: true });
    expect(await connecting).toEqual({ ok: false, commandError: "unauthorized" });
    // The cancelled credential is never adopted, and the requested guard stays.
    expect(h.controller.getSnapshot()).toMatchObject({ profile: null, error: "unauthorized" });
    expect(h.safety.status.trafficBlocked).toBe(true);
    expect(h.storage.persisted).toEqual(EMPTY_PERSISTED_STATE);
    expect(apiLogout).toHaveBeenCalledExactlyOnceWith(AUTH.accessToken);
  });
});

describe("logout reporting of abandoned API revocations", () => {
  afterEach(() => vi.restoreAllMocks());

  /** Starts a web login whose code exchange ignores abort until released. */
  function lateExchange(h: Harness) {
    const exchanged = deferred();
    const exchange = h.api.exchangeExtensionCode.bind(h.api);
    vi.spyOn(h.api, "exchangeExtensionCode").mockImplementation(async (code) => {
      await exchanged.promise;
      return exchange(code);
    });
    const loggingIn = h.controller.webLogin(false);
    return { loggingIn, release: exchanged.resolve };
  }

  it("retries a cancelled login's refused revocation in the next logout", async () => {
    const h = createHarness({ webAuth });
    await h.controller.initialize();
    const held = holdProfileRequest(h);
    const apiLogout = vi
      .spyOn(h.api as ApiService, "logout")
      .mockRejectedValueOnce(new ApiError("server_error", 503));
    const loggingIn = h.controller.webLogin(false);
    await held.reached;
    const { preference } = await supersedeWithPreference(h);
    held.release();
    expect(await loggingIn).toEqual({ ok: false, superseded: true });
    await preference;
    await settle();

    const next = { ...AUTH, accessToken: "synthetic-next-web-login-token" };
    h.api.auth = next;
    expect(await h.controller.webLogin(false)).toEqual({ ok: true });
    expect(await h.controller.logout()).toEqual({ ok: true });
    expect(apiLogout.mock.calls.map(([token]) => token)).toEqual([
      AUTH.accessToken,
      next.accessToken,
      AUTH.accessToken,
    ]);
    expect(h.controller.getSnapshot().logoutOutcome?.apiSession).toBe("confirmed");
  });

  it("retries a token abandoned and refused while logout clears the account", async () => {
    const h = createHarness({ webAuth });
    await h.controller.initialize();
    const clearing = deferred();
    const cleared = deferred();
    const clear = h.storage.clearPersisted.bind(h.storage);
    vi.spyOn(h.storage, "clearPersisted").mockImplementation(async () => {
      clearing.resolve();
      await cleared.promise;
      await clear();
    });
    const apiLogout = vi
      .spyOn(h.api as ApiService, "logout")
      .mockRejectedValueOnce(new ApiError("server_error", 503));
    const login = lateExchange(h);
    await vi.waitFor(() => expect(h.api.exchangeExtensionCode).toHaveBeenCalledOnce());
    const loggingOut = h.controller.logout();
    await clearing.promise;
    login.release();
    expect(await login.loggingIn).toEqual({ ok: false, superseded: true });
    await settle();
    cleared.resolve();

    expect(await loggingOut).toEqual({ ok: true });
    expect(apiLogout.mock.calls.map(([token]) => token)).toEqual([
      AUTH.accessToken,
      AUTH.accessToken,
    ]);
    expect(h.controller.getSnapshot().logoutOutcome?.apiSession).toBe("confirmed");
  });

  it("reports a token abandoned while logout revokes the account's own", async () => {
    const h = createHarness({ persisted: authenticatedState() });
    await h.controller.initialize();
    const late = { ...AUTH, accessToken: "synthetic-late-password-login-token" };
    h.api.auth = late;
    const issued = deferred();
    const login = h.api.login.bind(h.api);
    vi.spyOn(h.api, "login").mockImplementation(async () => {
      await issued.promise;
      return login();
    });
    const revoking = deferred();
    const apiLogout = vi.spyOn(h.api as ApiService, "logout").mockImplementation(async (token) => {
      if (token === late.accessToken) throw new ApiError("server_error", 503);
      await revoking.promise;
    });
    const loggingIn = h.controller.login("b@example.invalid", "synthetic");
    await vi.waitFor(() => expect(h.api.login).toHaveBeenCalledOnce());
    const loggingOut = h.controller.logout();
    await vi.waitFor(() => expect(apiLogout).toHaveBeenCalledWith(AUTH.accessToken));
    issued.resolve();
    expect(await loggingIn).toEqual({ ok: false, superseded: true });
    await vi.waitFor(() => expect(apiLogout).toHaveBeenCalledWith(late.accessToken));
    await settle();
    revoking.resolve();

    expect(await loggingOut).toEqual({ ok: true });
    expect(h.controller.getSnapshot().logoutOutcome?.apiSession).toBe("unconfirmed");
  });

  it("withdraws a shown confirmation when a late token's revocation is refused", async () => {
    const h = createHarness({ webAuth });
    await h.controller.initialize();
    const apiLogout = vi
      .spyOn(h.api as ApiService, "logout")
      .mockRejectedValueOnce(new ApiError("server_error", 503));
    const login = lateExchange(h);
    await vi.waitFor(() => expect(h.api.exchangeExtensionCode).toHaveBeenCalledOnce());
    expect(await h.controller.logout()).toEqual({ ok: true });
    expect(h.controller.getSnapshot().logoutOutcome?.apiSession).toBe("confirmed");
    login.release();

    expect(await login.loggingIn).toEqual({ ok: false, superseded: true });
    await vi.waitFor(() =>
      expect(h.controller.getSnapshot().logoutOutcome).toEqual({
        apiSession: "unconfirmed",
        proxySessions: "confirmed",
      }),
    );
    // The next logout of an account retries the refused token.
    const next = { ...AUTH, accessToken: "synthetic-next-web-login-token" };
    h.api.auth = next;
    expect(await h.controller.webLogin(false)).toEqual({ ok: true });
    expect(await h.controller.logout()).toEqual({ ok: true });
    expect(apiLogout.mock.calls.map(([token]) => token)).toEqual([
      AUTH.accessToken,
      next.accessToken,
      AUTH.accessToken,
    ]);
    expect(h.controller.getSnapshot().logoutOutcome?.apiSession).toBe("confirmed");
  });
});
