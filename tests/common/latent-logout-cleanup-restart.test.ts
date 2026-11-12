// SPDX-License-Identifier: MPL-2.0

import { NetworkError } from "../../src/core/api/client";
import { EMPTY_PERSISTED_STATE } from "../../src/core/storage/storage";
import { AUTH, authenticatedState, createHarness, PROFILE, UNAUTHORIZED } from "./helpers";

type Harness = ReturnType<typeof createHarness>;

const settle = () => new Promise<void>((done) => setImmediate(done));

/**
 * An explicit logout whose local account removal fails. The server either revoked the
 * API session or never answered, in which case the stored credential is still valid.
 */
async function logoutWithoutLocalRemoval(remote: "confirmed" | "unconfirmed") {
  const h = createHarness({ persisted: authenticatedState() });
  await h.controller.initialize();
  vi.spyOn(h.storage, "clearPersisted").mockRejectedValueOnce(new Error("temporarily unavailable"));
  const remoteLogout = vi.spyOn(h.api, "logout");
  if (remote === "unconfirmed") remoteLogout.mockRejectedValueOnce(new NetworkError("network"));

  expect(await h.controller.logout()).toEqual({ ok: false, commandError: "storage_unavailable" });
  expect(remoteLogout).toHaveBeenCalledExactlyOnceWith(AUTH.accessToken);
  expect(h.storage.persisted.auth).toEqual(AUTH);
  // The failure is reported rather than left in progress, and protection was released.
  expect(h.controller.getSnapshot()).toMatchObject({
    profile: PROFILE,
    error: "storage_unavailable",
    protectionRequested: false,
    logoutOutcome: { apiSession: remote, proxySessions: "confirmed" },
  });
  expect(h.controller.getSnapshot().status).not.toBe("disconnecting");
  expect(h.securityStorage.state?.protectionRequested).toBe(false);
  return h;
}

/** A new worker over the same stores, with the server answering as it would. */
async function restartedWorker(h: Harness, revoked: boolean) {
  const restarted = createHarness({
    persisted: h.storage.persisted,
    transient: h.storage.transient,
    security: h.securityStorage.state!,
  });
  if (revoked) {
    vi.spyOn(restarted.api, "getProfile").mockRejectedValue(UNAUTHORIZED);
    vi.spyOn(restarted.api, "getSubscription").mockRejectedValue(UNAUTHORIZED);
  }
  await restarted.controller.initialize();
  // Startup reads a restored account in the background.
  await settle();
  return restarted;
}

describe("a worker restart after a logout whose local removal failed", () => {
  afterEach(() => vi.restoreAllMocks());

  it("discards the stored credential which the server revoked", async () => {
    const h = await logoutWithoutLocalRemoval("confirmed");
    const restarted = await restartedWorker(h, true);
    expect(restarted.storage.persisted).toEqual(EMPTY_PERSISTED_STATE);
    expect(restarted.controller.getSnapshot()).toMatchObject({
      status: "logged_out",
      profile: null,
      protectionRequested: false,
    });
    expect(restarted.controller.getDiagnosticAccount()).toBeNull();
  });

  it("stays signed out once the repeated logout removed the account", async () => {
    const h = await logoutWithoutLocalRemoval("unconfirmed");
    expect(await h.controller.logout()).toEqual({ ok: true });
    const restarted = await restartedWorker(h, false);
    expect(restarted.storage.persisted.auth).toBeNull();
    expect(restarted.controller.getSnapshot()).toMatchObject({
      status: "logged_out",
      profile: null,
    });
  });

  it("keeps the account of a logout which reported its failure, without reconnecting", async () => {
    const h = await logoutWithoutLocalRemoval("unconfirmed");
    const restarted = await restartedWorker(h, false);
    // Neither the server nor the storage recorded the logout: the account is still
    // shown, as it was when the logout failed, and protection stays released.
    expect(restarted.api.proofs).toHaveLength(0);
    expect(restarted.controller.getSnapshot()).toMatchObject({
      status: "disconnected",
      profile: PROFILE,
      protectionRequested: false,
    });
  });
});
