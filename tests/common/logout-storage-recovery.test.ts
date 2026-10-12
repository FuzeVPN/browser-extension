// SPDX-License-Identifier: MPL-2.0

import { NetworkError } from "../../src/core/api/client";
import { AUTH, authenticatedState, createHarness, PROFILE } from "./helpers";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("logout durable account cleanup recovery", () => {
  afterEach(() => vi.restoreAllMocks());

  it("retries local removal and preserves an unconfirmed remote logout across restart", async () => {
    const h = createHarness({ persisted: authenticatedState() });
    await h.controller.initialize();
    const clearing = vi
      .spyOn(h.storage, "clearPersisted")
      .mockRejectedValueOnce(new Error("temporarily unavailable"));
    const remote = vi.spyOn(h.api, "logout").mockRejectedValueOnce(new NetworkError("network"));

    expect(await h.controller.logout()).toEqual({ ok: false, commandError: "storage_unavailable" });
    expect(h.storage.persisted.auth).toEqual(AUTH);
    expect(h.controller.getSnapshot()).toMatchObject({
      profile: PROFILE,
      error: "storage_unavailable",
      logoutOutcome: { apiSession: "unconfirmed", proxySessions: "confirmed" },
    });

    expect(await h.controller.logout()).toEqual({ ok: true });
    expect(clearing).toHaveBeenCalledTimes(2);
    expect(remote).toHaveBeenCalledOnce();
    expect(h.storage.persisted.auth).toBeNull();
    expect(h.controller.getSnapshot()).toMatchObject({
      status: "logged_out",
      profile: null,
      error: null,
      logoutOutcome: { apiSession: "unconfirmed", proxySessions: "confirmed" },
    });
    await h.controller.logout();
    expect(clearing).toHaveBeenCalledTimes(2);

    const restarted = createHarness({
      persisted: h.storage.persisted,
      security: h.securityStorage.state!,
    });
    await restarted.controller.initialize();
    expect(restarted.controller.getSnapshot()).toMatchObject({
      status: "logged_out",
      profile: null,
    });
  });

  it("continues to report storage failure until local removal succeeds", async () => {
    const h = createHarness({ persisted: authenticatedState() });
    await h.controller.initialize();
    const clearing = vi
      .spyOn(h.storage, "clearPersisted")
      .mockRejectedValue(new Error("unavailable"));
    const remote = vi.spyOn(h.api, "logout");

    for (let attempt = 0; attempt < 2; attempt += 1) {
      expect(await h.controller.logout()).toEqual({
        ok: false,
        commandError: "storage_unavailable",
      });
      expect(h.storage.persisted.auth).toEqual(AUTH);
      expect(h.controller.getSnapshot().error).toBe("storage_unavailable");
    }
    expect(clearing).toHaveBeenCalledTimes(2);
    expect(remote).toHaveBeenCalledOnce();
    expect(h.controller.getSnapshot().logoutOutcome?.apiSession).toBe("confirmed");
  });

  it("shares simultaneous retries without duplicating local removal", async () => {
    const h = createHarness({ persisted: authenticatedState() });
    await h.controller.initialize();
    const clearing = vi
      .spyOn(h.storage, "clearPersisted")
      .mockRejectedValueOnce(new Error("unavailable"));
    await h.controller.logout();
    const first = h.controller.logout();
    const second = h.controller.logout();
    expect(second).toBe(first);
    expect(await first).toEqual({ ok: true });
    expect(clearing).toHaveBeenCalledTimes(2);
    expect(h.controller.getSnapshot().profile).toBeNull();
  });

  it("does not clear or replace a new account when login supersedes a delayed local retry", async () => {
    const h = createHarness({ persisted: authenticatedState() });
    await h.controller.initialize();
    const remove = h.storage.clearPersisted.bind(h.storage);
    const clearing = vi
      .spyOn(h.storage, "clearPersisted")
      .mockRejectedValueOnce(new Error("unavailable"));
    await h.controller.logout();
    const wait = deferred<undefined>();
    clearing.mockImplementationOnce(async () => {
      await wait.promise;
      await remove();
    });
    const retry = h.controller.logout();
    await vi.waitFor(() => expect(clearing).toHaveBeenCalledTimes(2));
    h.api.auth = { ...AUTH, accessToken: "synthetic-new-account-token" };
    h.api.profile = { ...PROFILE, userId: "new-account" };
    const login = h.controller.login("new@example.invalid", "synthetic");
    await Promise.resolve();
    wait.resolve(undefined);
    expect((await retry).ok).toBe(false);
    expect(await login).toEqual({ ok: true });
    expect(h.storage.persisted.auth?.accessToken).toBe("synthetic-new-account-token");
    expect(h.controller.getSnapshot()).toMatchObject({
      profile: { userId: "new-account" },
      logoutOutcome: null,
    });
    expect(await h.controller.logout()).toEqual({ ok: true });
    expect(h.storage.persisted.auth).toBeNull();
  });
});
