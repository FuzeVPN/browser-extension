// SPDX-License-Identifier: MPL-2.0

import { AUTH, authenticatedState, createHarness, PROFILE } from "./helpers";

/**
 * A signed-in account whose storage cannot be read for the first `failures` startups:
 * nothing is restored yet, and traffic stays guarded until a later read succeeds.
 */
async function unreadStartup(failures: number) {
  const h = createHarness({ persisted: authenticatedState() });
  const read = vi.spyOn(h.storage, "readPersisted");
  for (let attempt = 0; attempt < failures; attempt += 1)
    read.mockRejectedValueOnce(new Error("temporarily unavailable"));
  await h.controller.initialize();
  expect(h.controller.getSnapshot()).toMatchObject({
    profile: null,
    error: "storage_unavailable",
  });
  expect(h.controller.getDiagnosticAccount()).toBeNull();
  return { h, read };
}

/** The storage is readable again: the account is restored, signed in and disconnected. */
async function recovered(h: ReturnType<typeof createHarness>) {
  await h.controller.initialize();
  expect(h.storage.persisted.auth).toEqual(AUTH);
  expect(h.controller.getSnapshot()).toMatchObject({
    status: "disconnected",
    profile: PROFILE,
    error: null,
    logoutOutcome: null,
  });
}

describe("the diagnostics account after a logout which did not happen", () => {
  afterEach(() => vi.restoreAllMocks());

  it("is available once an unread startup storage is restored", async () => {
    const { h, read } = await unreadStartup(1);
    await recovered(h);
    expect(read).toHaveBeenCalledTimes(2);
    expect(h.controller.getDiagnosticAccount()).toMatchObject({
      ownerId: PROFILE.userId,
      token: AUTH.accessToken,
    });
  });

  it("is available again after a logout refused while the startup storage was unread", async () => {
    const { h, read } = await unreadStartup(2);
    const remote = vi.spyOn(h.api, "logout");
    const clearing = vi.spyOn(h.storage, "clearPersisted");

    // The logout cannot even read the account: it reports the failure and removes nothing.
    expect(await h.controller.logout()).toEqual({ ok: false, commandError: "storage_unavailable" });
    expect(read).toHaveBeenCalledTimes(2);
    expect(remote).not.toHaveBeenCalled();
    expect(clearing).not.toHaveBeenCalled();

    await recovered(h);
    expect(read).toHaveBeenCalledTimes(3);
    expect(h.controller.getDiagnosticAccount()).toMatchObject({
      ownerId: PROFILE.userId,
      token: AUTH.accessToken,
    });
  });
});
