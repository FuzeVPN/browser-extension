// SPDX-License-Identifier: MPL-2.0

import { ApiError } from "../../src/core/api/client";
import { authenticatedState, createHarness, PROFILE } from "./helpers";

afterEach(() => vi.restoreAllMocks());

describe("an account which the server refuses", () => {
  /** Signed in; the removal of the stored account is held until released. */
  async function refusedWhileClearing() {
    const h = createHarness({ persisted: authenticatedState() });
    await h.controller.initialize();
    expect(h.controller.getSnapshot().profile).toEqual(PROFILE);
    let finish!: () => void;
    const clearing = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const clear = h.storage.clearPersisted.bind(h.storage);
    const cleared = vi.spyOn(h.storage, "clearPersisted").mockImplementationOnce(async () => {
      await clearing;
      await clear();
    });
    vi.spyOn(h.api, "getProfile").mockRejectedValue(new ApiError("unauthorized", 401));
    return { h, cleared, finish };
  }

  it("is no longer shown from the instant its removal begins", async () => {
    const { h, cleared, finish } = await refusedWhileClearing();

    const refreshing = h.controller.refreshAccount();
    await vi.waitFor(() => expect(cleared).toHaveBeenCalledOnce());

    // The removal is still in progress: a command answered now must not show the account.
    expect(h.controller.getSnapshot()).toMatchObject({ profile: null, protected: false });
    expect(h.snapshots.at(-1)).toMatchObject({ profile: null });

    finish();
    expect(await refreshing).toMatchObject({ ok: false });
    expect(h.controller.getSnapshot()).toMatchObject({ profile: null, status: "logged_out" });
  });

  it("is not shown by a command which that removal superseded", async () => {
    const { h, cleared, finish } = await refusedWhileClearing();
    vi.spyOn(h.api, "getLocations").mockRejectedValue(new ApiError("unauthorized", 401));

    // The popup refreshes the catalogue and the account at once: both are refused.
    const catalogue = h.controller.refreshLocations();
    const account = h.controller.refreshAccount();
    const first = await Promise.race([catalogue, account]);
    await vi.waitFor(() => expect(cleared).toHaveBeenCalled());

    expect(first.ok).toBe(false);
    expect(h.controller.getSnapshot().profile).toBeNull();

    finish();
    await Promise.all([catalogue, account]);
    expect(h.controller.getSnapshot()).toMatchObject({ profile: null, status: "logged_out" });
  });
});
