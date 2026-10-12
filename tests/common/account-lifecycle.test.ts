// SPDX-License-Identifier: MPL-2.0

import { type ApiService } from "../../src/core/api/client";
import { EMPTY_PERSISTED_STATE } from "../../src/core/storage/storage";
import { EMPTY_SNAPSHOT } from "../../src/core/shared/state";
import { authenticatedState, createHarness, PROFILE, proxySession, UNAUTHORIZED } from "./helpers";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function restoredAccount() {
  const session = proxySession();
  return createHarness({
    persisted: authenticatedState({ autoConnect: true }),
    transient: { proxySession: session, refreshAttempts: 0, retiredSessions: [] },
    activeProxy: session,
  });
}

async function settleBackground() {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

describe("Account data lifecycle", () => {
  it("preserves explicit disconnect while background profile storage is in progress", async () => {
    const h = restoredAccount();
    const writing = deferred<undefined>();
    const release = deferred<undefined>();
    const write = h.storage.writePersisted.bind(h.storage);
    vi.spyOn(h.storage, "writePersisted").mockImplementationOnce(async (state) => {
      writing.resolve(undefined);
      await release.promise;
      await write(state);
    });
    await h.controller.initialize();
    await writing.promise;
    const disconnect = h.controller.disconnect();
    await settleBackground();
    release.resolve(undefined);
    await disconnect;
    expect(h.storage.persisted.autoConnect).toBe(false);
    expect(h.controller.getSnapshot()).toMatchObject({
      status: "disconnected",
      autoConnect: false,
    });
  });

  it("cancels background hydration and ignores its late profile after logout", async () => {
    const h = restoredAccount();
    const response = deferred<typeof PROFILE>();
    let requestSignal: AbortSignal | undefined;
    vi.spyOn(h.api as ApiService, "getProfile").mockImplementationOnce((_token, signal) => {
      requestSignal = signal;
      return response.promise;
    });
    await h.controller.initialize();
    await h.controller.logout();
    response.resolve(PROFILE);
    await settleBackground();
    expect(h.storage.persisted).toEqual(EMPTY_PERSISTED_STATE);
    expect(h.controller.getSnapshot()).toEqual({
      ...EMPTY_SNAPSHOT,
      logoutOutcome: { apiSession: "confirmed", proxySessions: "confirmed" },
    });
    expect(requestSignal?.aborted).toBe(true);
  });

  it.each(["success", "unauthorized"])(
    "ignores an old background %s after logging into another account",
    async (outcome) => {
      const h = restoredAccount();
      const response = deferred<typeof PROFILE>();
      vi.spyOn(h.api, "getProfile").mockReturnValueOnce(response.promise);
      await h.controller.initialize();
      await h.controller.logout();
      h.api.auth = { ...h.api.auth, accessToken: "next-account-test-token" };
      h.api.profile = { ...PROFILE, userId: "next-account", email: "next@example.invalid" };
      await h.controller.login(h.api.profile.email, "synthetic-password");
      const persisted = structuredClone(h.storage.persisted);
      const snapshot = h.controller.getSnapshot();
      if (outcome === "success") response.resolve(PROFILE);
      else response.reject(UNAUTHORIZED);
      await settleBackground();
      expect(h.storage.persisted).toEqual(persisted);
      expect(h.controller.getSnapshot()).toEqual(snapshot);
    },
  );

  it.each(["success", "unauthorized"])(
    "ignores a late manual refresh %s after logout",
    async (outcome) => {
      const h = createHarness({ persisted: authenticatedState() });
      await h.controller.initialize();
      const response = deferred<typeof PROFILE>();
      const getProfile = vi.spyOn(h.api, "getProfile").mockReturnValueOnce(response.promise);
      const refreshing = h.controller.refreshAccount();
      await vi.waitFor(() => expect(getProfile).toHaveBeenCalled());
      await h.controller.logout();
      if (outcome === "success") response.resolve(PROFILE);
      else response.reject(UNAUTHORIZED);
      await refreshing;
      expect(h.storage.persisted).toEqual(EMPTY_PERSISTED_STATE);
      expect(h.controller.getSnapshot()).toEqual({
        ...EMPTY_SNAPSHOT,
        logoutOutcome: { apiSession: "confirmed", proxySessions: "confirmed" },
      });
    },
  );

  it.each(["refresh", "selection"])(
    "clears an in-flight %s storage write before finishing logout",
    async (action) => {
      const h = createHarness({ persisted: authenticatedState() });
      await h.controller.initialize();
      const writing = deferred<undefined>();
      const release = deferred<undefined>();
      const write = h.storage.writePersisted.bind(h.storage);
      vi.spyOn(h.storage, "writePersisted").mockImplementationOnce(async (state) => {
        writing.resolve(undefined);
        await release.promise;
        await write(state);
      });
      const update =
        action === "refresh"
          ? h.controller.refreshAccount()
          : h.controller.selectLocation("frankfurt-02");
      // Attach a rejection handler before logout can invalidate the update.
      const updated = update.catch(() => undefined);
      await writing.promise;
      const logout = h.controller.logout();
      await settleBackground();
      release.resolve(undefined);
      await Promise.all([updated, logout]);
      expect(h.storage.persisted).toEqual(EMPTY_PERSISTED_STATE);
      expect(h.controller.getSnapshot()).toEqual({
        ...EMPTY_SNAPSHOT,
        logoutOutcome: { apiSession: "confirmed", proxySessions: "confirmed" },
      });
    },
  );

  it("keeps a new login when the previous remote logout finishes later", async () => {
    const h = createHarness({ persisted: authenticatedState() });
    await h.controller.initialize();
    const remote = deferred<undefined>();
    const remoteLogout = vi.spyOn(h.api, "logout").mockReturnValueOnce(remote.promise);
    const logout = h.controller.logout();
    await vi.waitFor(() => expect(remoteLogout).toHaveBeenCalled());
    expect(h.storage.persisted).toEqual(EMPTY_PERSISTED_STATE);
    h.api.auth = { ...h.api.auth, accessToken: "next-account-test-token" };
    h.api.profile = { ...PROFILE, userId: "next-account", email: "next@example.invalid" };
    await h.controller.login(h.api.profile.email, "synthetic-password");
    const persisted = structuredClone(h.storage.persisted);
    const snapshot = h.controller.getSnapshot();
    remote.resolve(undefined);
    await logout;
    expect(h.storage.persisted).toEqual(persisted);
    expect(h.controller.getSnapshot()).toEqual(snapshot);
  });

  it("clears an in-flight profile write when the account becomes unauthorized", async () => {
    const h = createHarness({ persisted: authenticatedState() });
    await h.controller.initialize();
    const writing = deferred<undefined>();
    const release = deferred<undefined>();
    const write = h.storage.writePersisted.bind(h.storage);
    vi.spyOn(h.storage, "writePersisted").mockImplementationOnce(async (state) => {
      writing.resolve(undefined);
      await release.promise;
      await write(state);
    });
    const refreshing = h.controller.refreshAccount();
    await writing.promise;
    vi.spyOn(h.api, "getDevices").mockRejectedValueOnce(UNAUTHORIZED);
    const invalidation = h.controller.refreshDevices();
    await settleBackground();
    release.resolve(undefined);
    await Promise.all([refreshing, invalidation]);
    expect(h.storage.persisted).toEqual(EMPTY_PERSISTED_STATE);
    expect(h.controller.getSnapshot()).toEqual({ ...EMPTY_SNAPSHOT, error: "unauthorized" });
  });
});
