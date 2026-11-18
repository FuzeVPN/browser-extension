// SPDX-License-Identifier: MPL-2.0

import { LocationPreferences } from "../../src/core/background/location-preferences";
import {
  PreferenceOwner,
  preferenceMark,
  preferenceOwnerDigest,
} from "../../src/core/background/preference-owner";

const A = "account-a";
const B = "account-b";
const TOKEN_1 = "00000000-0000-4000-8000-000000000001";
const TOKEN_2 = "00000000-0000-4000-8000-000000000002";
const LEFT_BY_A = "the list which account A left";

async function setup(recorded?: unknown) {
  let stored: unknown = recorded;
  let now = 1_000_000;
  let tokens = 0;
  // Stands for the saved exclusions: a content, and a change which may not be settled.
  const exclusions = { content: LEFT_BY_A, unsettled: false };
  // Stands for the location preferences, which keep the name of their last reset.
  const locations = { content: "the favourites of account A", reset: null as string | null };
  const read = vi.fn<() => Promise<unknown>>(async () => structuredClone(stored));
  const write = vi.fn<(record: unknown) => Promise<void>>(async (record) => {
    stored = structuredClone(record);
  });
  const settled = () => {
    if (exclusions.unsettled) throw new Error("site_exclusions_unsettled");
    return preferenceMark(exclusions.content);
  };
  const resetLocations = vi.fn<(token: string) => Promise<void>>(async (token) => {
    if (locations.reset === token) return;
    locations.content = "";
    locations.reset = token;
  });
  const exclusionsMark = vi.fn<() => Promise<string>>(async () => settled());
  const resetExclusions = vi.fn<(mark: string) => Promise<void>>(async (mark) => {
    if ((await settled()) === mark) exclusions.content = "";
  });
  const options = {
    storage: { read, write },
    digest: preferenceOwnerDigest,
    resetLocations,
    exclusionsMark,
    resetExclusions,
    token: () => `00000000-0000-4000-8000-${String(++tokens).padStart(12, "0")}`,
    now: () => now,
  };
  return {
    owner: new PreferenceOwner(options),
    restart: () => new PreferenceOwner(options),
    read,
    write,
    resetLocations,
    resetExclusions,
    exclusions,
    locations,
    stored: () => stored,
    advance(ms: number) {
      now += ms;
    },
    a: await preferenceOwnerDigest(A),
    b: await preferenceOwnerDigest(B),
    left: await preferenceMark(LEFT_BY_A),
  };
}

describe("the account which owns the preferences kept in the profile", () => {
  it("is recorded without a reset when none was recorded before", async () => {
    const h = await setup();
    await h.owner.adopt(A);

    expect(h.resetLocations).not.toHaveBeenCalled();
    expect(h.resetExclusions).not.toHaveBeenCalled();
    expect(h.stored()).toEqual({ owner: h.a });
  });

  it("keeps its preferences when it signs in again", async () => {
    const h = await setup({ owner: await preferenceOwnerDigest(A) });
    await h.owner.adopt(A);

    expect(h.resetLocations).not.toHaveBeenCalled();
    expect(h.resetExclusions).not.toHaveBeenCalled();
    expect(h.write).not.toHaveBeenCalled();
  });

  it("is replaced by another account, whose preferences start from the defaults", async () => {
    const h = await setup({ owner: await preferenceOwnerDigest(A) });
    await h.owner.adopt(B);

    expect(h.locations.content).toBe("");
    expect(h.exclusions.content).toBe("");
    expect(h.stored()).toEqual({ owner: h.b });
  });

  it("records the new owner and what remains to reset before resetting anything", async () => {
    const h = await setup({ owner: await preferenceOwnerDigest(A) });
    const seen: unknown[] = [];
    h.resetLocations.mockImplementation(async () => {
      seen.push(structuredClone(h.stored()));
    });
    h.resetExclusions.mockImplementation(async () => {
      seen.push(structuredClone(h.stored()));
    });
    await h.owner.adopt(B);

    expect(seen).toEqual([
      { owner: h.b, pending: { locations: TOKEN_1, exclusions: h.left } },
      { owner: h.b, pending: { exclusions: h.left } },
    ]);
  });

  it("is read once for the publications of a same account", async () => {
    const h = await setup({ owner: await preferenceOwnerDigest(A) });
    await Promise.all([h.owner.adopt(A), h.owner.adopt(A), h.owner.adopt(A)]);
    await h.owner.adopt(A);

    expect(h.read).toHaveBeenCalledOnce();
  });

  it("resumes a failed reset where it stopped, without undoing what was done", async () => {
    const h = await setup({ owner: await preferenceOwnerDigest(A) });
    h.resetExclusions.mockRejectedValueOnce(new Error("traffic_guard_failed"));
    await expect(h.owner.adopt(B)).rejects.toThrow("traffic_guard_failed");
    expect(h.stored()).toEqual({ owner: h.b, pending: { exclusions: h.left } });

    // The publications which the failure causes do not start it again at once.
    await h.owner.adopt(B);
    expect(h.resetExclusions).toHaveBeenCalledOnce();

    // Later, only the step which failed is repeated.
    h.advance(30_000);
    await h.owner.adopt(B);
    expect(h.resetLocations).toHaveBeenCalledOnce();
    expect(h.resetExclusions).toHaveBeenCalledTimes(2);
    expect(h.exclusions.content).toBe("");
    expect(h.stored()).toEqual({ owner: h.b });
  });

  it("is resumed by the next worker after an interruption", async () => {
    const h = await setup({ owner: await preferenceOwnerDigest(A) });
    h.resetLocations.mockRejectedValueOnce(new Error("storage unavailable"));
    await expect(h.owner.adopt(B)).rejects.toThrow("storage unavailable");
    expect(h.stored()).toEqual({
      owner: h.b,
      pending: { locations: TOKEN_1, exclusions: h.left },
    });

    await h.restart().adopt(B);
    expect(h.resetLocations).toHaveBeenLastCalledWith(TOKEN_1);
    expect(h.locations.content).toBe("");
    expect(h.exclusions.content).toBe("");
    expect(h.stored()).toEqual({ owner: h.b });
  });

  it("resets the exclusions which a cancelled attempt gave back", async () => {
    const h = await setup({ owner: await preferenceOwnerDigest(A) });
    // The first attempt is staged, fails, and is left unsettled.
    h.resetExclusions.mockImplementationOnce(async () => {
      h.exclusions.unsettled = true;
      throw new Error("traffic_guard_failed");
    });
    await expect(h.owner.adopt(B)).rejects.toThrow("traffic_guard_failed");

    // While nothing says what the exclusions will be, the reset is neither done nor dropped.
    await expect(h.restart().adopt(B)).rejects.toThrow("site_exclusions_unsettled");
    expect(h.stored()).toEqual({ owner: h.b, pending: { exclusions: h.left } });

    // A disconnection cancels the attempt: the list of account A is back, as it was.
    h.exclusions.unsettled = false;
    await h.restart().adopt(B);
    expect(h.exclusions.content).toBe("");
    expect(h.stored()).toEqual({ owner: h.b });
  });

  it("leaves exclusions which the new account has saved since", async () => {
    const h = await setup({ owner: await preferenceOwnerDigest(A) });
    h.resetExclusions.mockRejectedValueOnce(new Error("traffic_guard_failed"));
    await expect(h.owner.adopt(B)).rejects.toThrow();
    h.exclusions.content = "the list which account B chose";

    await h.restart().adopt(B);
    expect(h.exclusions.content).toBe("the list which account B chose");
    expect(h.stored()).toEqual({ owner: h.b });
  });

  it("waits for exclusions which are not settled before it changes the owner", async () => {
    const h = await setup({ owner: await preferenceOwnerDigest(A) });
    h.exclusions.unsettled = true;
    await expect(h.owner.adopt(B)).rejects.toThrow("site_exclusions_unsettled");

    // Nothing was recorded or reset: what account A left is not known yet.
    expect(h.stored()).toEqual({ owner: h.a });
    expect(h.resetLocations).not.toHaveBeenCalled();

    h.exclusions.unsettled = false;
    h.advance(30_000);
    await h.owner.adopt(B);
    expect(h.locations.content).toBe("");
    expect(h.exclusions.content).toBe("");
    expect(h.stored()).toEqual({ owner: h.b });
  });

  it("does not reset the locations again when their reset could not be struck off", async () => {
    const h = await setup({ owner: await preferenceOwnerDigest(A) });
    // The owner is recorded and the locations are reset, then storage fails.
    h.write.mockImplementationOnce(h.write.getMockImplementation()!);
    h.write.mockRejectedValueOnce(new Error("storage unavailable"));
    await expect(h.owner.adopt(B)).rejects.toThrow("storage unavailable");
    expect(h.locations.content).toBe("");
    h.locations.content = "the favourites which account B chose";

    await h.restart().adopt(B);
    // The same reset is asked again, by its name: the preferences know it was done.
    expect(h.resetLocations).toHaveBeenCalledTimes(2);
    expect(h.resetLocations).toHaveBeenLastCalledWith(TOKEN_1);
    expect(h.locations.content).toBe("the favourites which account B chose");
    expect(h.stored()).toEqual({ owner: h.b });
  });

  it("names each change of owner's reset differently", async () => {
    const h = await setup({ owner: await preferenceOwnerDigest(A) });
    await h.owner.adopt(B);
    h.locations.content = "the favourites which account B chose";
    await h.owner.adopt(A);

    expect(h.resetLocations).toHaveBeenLastCalledWith(TOKEN_2);
    expect(h.locations.content).toBe("");
  });

  it("does not hold another account back after one account's failure", async () => {
    const h = await setup({ owner: await preferenceOwnerDigest(A) });
    h.resetLocations.mockRejectedValueOnce(new Error("storage unavailable"));
    await expect(h.owner.adopt(B)).rejects.toThrow();

    // Account A signs in again at once: the delay is the other account's.
    await h.owner.adopt(A);
    expect(h.stored()).toEqual({ owner: h.a });
  });

  it("follows each account in turn within a worker", async () => {
    const h = await setup();
    await h.owner.adopt(A);
    await h.owner.adopt(B);
    await h.owner.adopt(A);

    expect(h.resetLocations).toHaveBeenCalledTimes(2);
    expect(h.stored()).toEqual({ owner: h.a });
  });

  it.each([
    ["a text", "account-a"],
    ["an owner which is no digest", { owner: "account-a" }],
    ["a list", []],
    ["remaining steps which cannot be read", { owner: "a".repeat(64), pending: "all" }],
    [
      "remaining steps of an earlier format",
      { owner: "a".repeat(64), pending: { locations: true, exclusions: 3 } },
    ],
  ])("treats %s as no recorded owner", async (_label, recorded) => {
    const h = await setup(recorded);
    await h.owner.adopt(A);

    expect(h.resetLocations).not.toHaveBeenCalled();
    expect(h.resetExclusions).not.toHaveBeenCalled();
    expect(h.stored()).toEqual({ owner: h.a });
  });

  it("stores a digest which does not contain the account identifier", async () => {
    const digest = await preferenceOwnerDigest(A);

    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(digest).not.toContain(A);
    expect(digest).toBe(await preferenceOwnerDigest(A));
    expect(digest).not.toBe(await preferenceOwnerDigest(B));
  });

  it("marks a content without containing it, and apart from an account's digest", async () => {
    const mark = await preferenceMark("example.com");

    expect(mark).toMatch(/^[0-9a-f]{64}$/);
    expect(mark).toBe(await preferenceMark("example.com"));
    expect(mark).not.toBe(await preferenceMark("example.org"));
    expect(mark).not.toBe(await preferenceOwnerDigest("example.com"));
  });
});

describe("resetting the location preferences", () => {
  function preferencesOver(initial: unknown) {
    let stored: unknown = initial;
    const onChanged = vi.fn<() => void>();
    const preferences = new LocationPreferences({
      storage: {
        read: async () => structuredClone(stored),
        write: async (value) => {
          stored = structuredClone(value);
        },
      },
      onChanged,
    });
    return { preferences, onChanged, stored: () => stored };
  }

  it("returns favourites, recent locations and automatic selection to their defaults", async () => {
    const h = preferencesOver({ favoriteIds: ["fr", "de"], recentIds: ["nl"], automatic: true });
    await h.preferences.initialize();
    h.onChanged.mockClear();

    await h.preferences.reset(TOKEN_1);

    expect(h.stored()).toEqual({
      favoriteIds: [],
      recentIds: [],
      automatic: false,
      reset: TOKEN_1,
    });
    expect(h.onChanged).toHaveBeenCalledOnce();
    const locations = ["fr", "de", "nl"].map((id) => ({
      id,
      city: id,
      countryCode: id.toUpperCase(),
      displayName: id,
      supportedProtocols: ["browser_proxy" as const],
    }));
    expect(h.preferences.getState(locations)).toMatchObject({
      favoriteIds: [],
      recentIds: [],
      automatic: false,
    });
  });

  it("is done once under a same name, whatever was chosen since", async () => {
    const h = preferencesOver({ favoriteIds: ["fr"], recentIds: [], automatic: false });
    await h.preferences.reset(TOKEN_1);
    await h.preferences.setFavorite("de", true);
    await h.preferences.recordConnected("nl");

    await h.preferences.reset(TOKEN_1);
    expect(h.stored()).toEqual({
      favoriteIds: ["de"],
      recentIds: ["nl"],
      automatic: false,
      reset: TOKEN_1,
    });

    // The next worker reads the name with the preferences.
    const next = preferencesOver(h.stored());
    await next.preferences.reset(TOKEN_1);
    expect(next.stored()).toMatchObject({ favoriteIds: ["de"] });

    await next.preferences.reset(TOKEN_2);
    expect(next.stored()).toEqual({
      favoriteIds: [],
      recentIds: [],
      automatic: false,
      reset: TOKEN_2,
    });
  });

  it("keeps the name of a reset of preferences which were the defaults already", async () => {
    const h = preferencesOver(undefined);
    await h.preferences.reset(TOKEN_1);

    expect(h.stored()).toMatchObject({ reset: TOKEN_1 });
  });

  it("refuses a name which is none, and ignores a stored one", async () => {
    const h = preferencesOver({ favoriteIds: ["fr"], recentIds: [], automatic: false, reset: 7 });
    await expect(h.preferences.reset("again")).rejects.toThrow("invalid_location_preference");
    await h.preferences.setAutomatic(true);

    expect(h.stored()).toEqual({ favoriteIds: ["fr"], recentIds: [], automatic: true });
  });
});
