// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it, vi } from "vitest";
import { LocationPreferences } from "../../src/core/background/location-preferences";
import type { Location } from "../../src/core/api/types";
import type { NetworkObservation } from "../../src/core/shared/network";

const LOCATIONS: Location[] = ["fr", "de", "nl", "uk", "es", "it"].map((id) => ({
  id,
  city: id,
  countryCode: id.toUpperCase(),
  displayName: id,
  supportedProtocols: ["browser_proxy"],
}));

interface StoredPreferences {
  favoriteIds: string[];
  recentIds: string[];
  automatic: boolean;
}

function setup(initial: unknown = null) {
  let stored: unknown = initial;
  let now = 1_000_000;
  const read = vi.fn<() => Promise<unknown>>().mockImplementation(async () => stored);
  const write = vi
    .fn<(value: StoredPreferences) => Promise<void>>()
    .mockImplementation(async (value) => {
      stored = structuredClone(value);
    });
  const onChanged = vi.fn<() => void>();
  const options = { storage: { read, write }, onChanged, now: () => now };
  return {
    preferences: new LocationPreferences(options),
    read,
    write,
    onChanged,
    restart: () => new LocationPreferences(options),
    stored: () => stored,
    advance(ms: number) {
      now += ms;
    },
    sample(
      locationId: string,
      latencyMs: number,
      changes: Partial<NetworkObservation> = {},
    ): NetworkObservation {
      return {
        status: "ready",
        mode: "vpn",
        locationId,
        latencyMs,
        checkedAt: now,
        ip: "8.8.8.8",
        ...changes,
      };
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("location preferences", () => {
  it("migrates an absent value to manual mode and the first available location", async () => {
    const f = setup();
    await Promise.all([f.preferences.initialize(), f.preferences.initialize()]);
    expect(f.read).toHaveBeenCalledTimes(1);
    expect(f.write).not.toHaveBeenCalled();
    expect(f.preferences.getState(LOCATIONS)).toEqual({
      favoriteIds: [],
      recentIds: [],
      automatic: false,
      recommendedLocationId: "fr",
    });
    expect(f.preferences.getState([]).recommendedLocationId).toBeNull();
  });

  it("restores preferences and exposes only locations available in the current catalog", async () => {
    const f = setup({
      favoriteIds: ["fr", "removed"],
      recentIds: ["removed", "de"],
      automatic: true,
    });
    await f.preferences.initialize();
    expect(f.preferences.getState(LOCATIONS)).toEqual({
      favoriteIds: ["fr"],
      unavailableFavoriteIds: ["removed"],
      recentIds: ["de"],
      automatic: true,
      recommendedLocationId: "de",
    });
    expect(f.write).not.toHaveBeenCalled();
    expect(
      f.preferences.getState([...LOCATIONS, { ...LOCATIONS[0]!, id: "removed" }]).favoriteIds,
    ).toEqual(["fr", "removed"]);
  });

  it("sanitizes duplicates, invalid values and list limits without changing stored data", async () => {
    const ids = Array.from({ length: 105 }, (_, index) => `location-${String(index)}`);
    const locations = ids.map((id) => ({ ...LOCATIONS[0]!, id }));
    const f = setup({
      favoriteIds: ["", " ", 7, null, "x".repeat(201), ids[0], ...ids],
      recentIds: [...ids, ids[0]],
      automatic: "true",
      ip: "8.8.8.8",
    });
    await f.preferences.initialize();
    const state = f.preferences.getState(locations);
    expect(state.favoriteIds).toEqual(ids.slice(0, 100));
    expect(state.recentIds).toEqual(ids.slice(0, 5));
    expect(state.automatic).toBe(false);
    expect(f.write).not.toHaveBeenCalled();
  });

  it.each([undefined, null, false, 7, "text", [], { favoriteIds: {}, recentIds: "fr" }])(
    "ignores malformed storage: %j",
    async (stored) => {
      const f = setup(stored);
      await f.preferences.initialize();
      expect(f.preferences.getState(LOCATIONS)).toMatchObject({
        favoriteIds: [],
        recentIds: [],
        automatic: false,
      });
    },
  );

  it("ignores inherited and accessor properties, including inherited array entries", async () => {
    const getter = vi.fn(() => ["fr"]);
    const raw: object = Object.create({ automatic: true, recentIds: ["fr"] }) as object;
    Object.defineProperty(raw, "favoriteIds", { get: getter });
    const f = setup(raw);
    await f.preferences.initialize();
    expect(getter).not.toHaveBeenCalled();
    expect(f.preferences.getState(LOCATIONS)).toMatchObject({
      favoriteIds: [],
      recentIds: [],
      automatic: false,
    });

    const values = new Array<unknown>(2);
    const prototype = Object.create(Array.prototype) as object;
    Object.defineProperty(prototype, "0", { value: "fr" });
    Object.setPrototypeOf(values, prototype);
    values[1] = "de";
    const g = setup({ favoriteIds: values });
    await g.preferences.initialize();
    expect(g.preferences.getState(LOCATIONS).favoriteIds).toEqual(["de"]);
  });

  it("persists favorites and automatic mode across service-worker restarts", async () => {
    const f = setup();
    await f.preferences.setFavorite("de", true);
    await f.preferences.setAutomatic(true);
    await f.preferences.recordConnected("nl");
    const restored = f.restart();
    await restored.initialize();
    expect(restored.getState(LOCATIONS)).toEqual({
      favoriteIds: ["de"],
      recentIds: ["nl"],
      automatic: true,
      recommendedLocationId: "nl",
    });
    await restored.setFavorite("de", false);
    expect(restored.getState(LOCATIONS).favoriteIds).toEqual([]);
  });

  it("serializes concurrent changes without overwriting favorites, automatic mode or recents", async () => {
    const f = setup();
    const gate = deferred<undefined>();
    f.write.mockImplementationOnce(async () => gate.promise);
    const first = f.preferences.setFavorite("fr", true);
    const second = f.preferences.setFavorite("de", true);
    const third = f.preferences.setAutomatic(true);
    const fourth = f.preferences.recordConnected("nl");
    await vi.waitFor(() => expect(f.write).toHaveBeenCalledTimes(1));
    expect(f.preferences.getState(LOCATIONS).favoriteIds).toEqual([]);
    gate.resolve(undefined);
    await Promise.all([first, second, third, fourth]);
    expect(f.stored()).toEqual({ favoriteIds: ["fr", "de"], recentIds: ["nl"], automatic: true });
    expect(f.write.mock.calls.map(([value]) => value)).toEqual([
      { favoriteIds: ["fr"], recentIds: [], automatic: false },
      { favoriteIds: ["fr", "de"], recentIds: [], automatic: false },
      { favoriteIds: ["fr", "de"], recentIds: [], automatic: true },
      { favoriteIds: ["fr", "de"], recentIds: ["nl"], automatic: true },
    ]);
  });

  it("waits for loading preferences before applying a user change", async () => {
    const f = setup();
    const loaded = deferred<unknown>();
    f.read.mockReturnValueOnce(loaded.promise);
    const initialized = f.preferences.initialize();
    const changed = f.preferences.setFavorite("de", true);
    loaded.resolve({ favoriteIds: ["fr"], recentIds: ["nl"], automatic: true });
    await Promise.all([initialized, changed]);
    expect(f.stored()).toEqual({ favoriteIds: ["fr", "de"], recentIds: ["nl"], automatic: true });
  });

  it("keeps the prior state on a write failure and allows a later queued change", async () => {
    const f = setup();
    f.write.mockRejectedValueOnce(new Error("storage_full"));
    const failed = f.preferences.setFavorite("fr", true);
    const succeeded = f.preferences.setFavorite("de", true);
    await expect(failed).rejects.toThrow("storage_full");
    await succeeded;
    expect(f.preferences.getState(LOCATIONS).favoriteIds).toEqual(["de"]);
    expect(f.stored()).toEqual({ favoriteIds: ["de"], recentIds: [], automatic: false });
  });

  it("does not overwrite unread preferences after a transient storage read failure", async () => {
    const f = setup({ favoriteIds: ["fr"], recentIds: ["nl"], automatic: true });
    f.read.mockRejectedValueOnce(new Error("temporarily_unavailable"));
    await expect(f.preferences.setFavorite("de", true)).rejects.toThrow("temporarily_unavailable");
    expect(f.write).not.toHaveBeenCalled();
    await f.preferences.setFavorite("de", true);
    expect(f.stored()).toEqual({ favoriteIds: ["fr", "de"], recentIds: ["nl"], automatic: true });
  });

  it("keeps five unique recent locations in most-recent order", async () => {
    const f = setup();
    for (const location of LOCATIONS) await f.preferences.recordConnected(location.id);
    await f.preferences.recordConnected("nl");
    expect(f.preferences.getState(LOCATIONS).recentIds).toEqual(["nl", "it", "es", "uk", "de"]);
    expect(f.preferences.getState(LOCATIONS).recommendedLocationId).toBe("nl");
  });

  it("does not write or notify when a favorite, recent or automatic setting is unchanged", async () => {
    const f = setup({ favoriteIds: ["fr"], recentIds: ["de"], automatic: true });
    await f.preferences.initialize();
    f.onChanged.mockClear();
    await f.preferences.setFavorite("fr", true);
    await f.preferences.setFavorite("nl", false);
    await f.preferences.recordConnected("de");
    await f.preferences.setAutomatic(true);
    expect(f.write).not.toHaveBeenCalled();
    expect(f.onChanged).not.toHaveBeenCalled();
  });

  it("rejects invalid IDs and prevents a 101st favorite without removing existing favorites", async () => {
    const ids = Array.from({ length: 100 }, (_, index) => `location-${String(index)}`);
    const f = setup({ favoriteIds: ids });
    await f.preferences.initialize();
    await expect(f.preferences.setFavorite("fr", true)).rejects.toThrow("location_favorites_limit");
    for (const id of ["", " ", "x".repeat(201)]) {
      await expect(f.preferences.setFavorite(id, true)).rejects.toThrow("invalid_location");
      await expect(f.preferences.recordConnected(id)).rejects.toThrow("invalid_location");
    }
    expect(f.write).not.toHaveBeenCalled();
  });

  it("exposes unavailable favorites for explicit removal so a full old catalog cannot trap the quota", async () => {
    const ids = Array.from({ length: 100 }, (_, index) => `retired-${String(index)}`);
    const f = setup({ favoriteIds: ids });
    await f.preferences.initialize();
    const initial = f.preferences.getState(LOCATIONS);
    expect(initial.favoriteIds).toEqual([]);
    expect(initial.unavailableFavoriteIds).toEqual(ids);
    expect(f.write).not.toHaveBeenCalled();
    initial.unavailableFavoriteIds!.length = 0;
    expect(f.preferences.getState(LOCATIONS).unavailableFavoriteIds).toHaveLength(100);
    await f.preferences.setFavorite(ids[0]!, false);
    await f.preferences.setFavorite("fr", true);
    expect(f.preferences.getState(LOCATIONS).favoriteIds).toEqual(["fr"]);
    expect(f.preferences.getState(LOCATIONS).unavailableFavoriteIds).toEqual(ids.slice(1));
  });

  it("recommends the lowest recent measured latency among available locations", async () => {
    const f = setup({ recentIds: ["nl"] });
    await f.preferences.initialize();
    f.preferences.recordObservation(f.sample("fr", 200));
    f.preferences.recordObservation(f.sample("de", 60));
    f.preferences.recordObservation(f.sample("removed", 10));
    expect(f.preferences.getState(LOCATIONS).recommendedLocationId).toBe("de");
    expect(
      f.preferences.getState(LOCATIONS.filter((location) => location.id !== "de"))
        .recommendedLocationId,
    ).toBe("fr");
    f.advance(600_000);
    expect(f.preferences.getState(LOCATIONS).recommendedLocationId).toBe("nl");
    expect(
      f.preferences.getState(LOCATIONS.filter((location) => location.id !== "nl"))
        .recommendedLocationId,
    ).toBe("fr");
  });

  it("uses the latest sample for each location and ignores duplicates or older samples", async () => {
    const f = setup();
    const initial = f.sample("fr", 50);
    f.preferences.recordObservation(initial);
    f.preferences.recordObservation(f.sample("de", 100));
    f.onChanged.mockClear();
    f.preferences.recordObservation({ ...initial, latencyMs: 999 });
    f.preferences.recordObservation({
      ...initial,
      checkedAt: initial.checkedAt! - 1,
      latencyMs: 999,
    });
    expect(f.onChanged).not.toHaveBeenCalled();
    expect(f.preferences.getState(LOCATIONS).recommendedLocationId).toBe("fr");
    f.advance(1);
    f.preferences.recordObservation(f.sample("fr", 200));
    expect(f.preferences.getState(LOCATIONS).recommendedLocationId).toBe("de");
  });

  it.each([
    { status: "unavailable" },
    { status: "checking" },
    { mode: "direct" },
    { mode: null },
    { locationId: null },
    { locationId: "" },
    { latencyMs: null },
    { latencyMs: -1 },
    { latencyMs: Number.NaN },
    { latencyMs: Number.POSITIVE_INFINITY },
    { latencyMs: 1.5 },
    { checkedAt: null },
    { checkedAt: 0 },
    { checkedAt: 1_000_001 },
    { checkedAt: 400_000 },
  ] satisfies Partial<NetworkObservation>[])(
    "ignores invalid or stale measurements: %j",
    (changes) => {
      const f = setup();
      f.preferences.recordObservation(f.sample("de", 10, changes));
      expect(f.preferences.getState(LOCATIONS).recommendedLocationId).toBe("fr");
      expect(f.onChanged).not.toHaveBeenCalled();
      expect(f.write).not.toHaveBeenCalled();
    },
  );

  it("never persists IPs or measurements and forgets them after worker restart", async () => {
    const f = setup();
    await f.preferences.initialize();
    f.preferences.recordObservation(f.sample("de", 25));
    expect(f.write).not.toHaveBeenCalled();
    expect(f.preferences.getState(LOCATIONS).recommendedLocationId).toBe("de");
    await f.preferences.setFavorite("nl", true);
    expect(f.stored()).toEqual({ favoriteIds: ["nl"], recentIds: [], automatic: false });
    expect(JSON.stringify(f.write.mock.calls)).not.toContain("8.8.8.8");
    expect(JSON.stringify(f.write.mock.calls)).not.toContain("latencyMs");
    const restarted = f.restart();
    await restarted.initialize();
    expect(restarted.getState(LOCATIONS).recommendedLocationId).toBe("fr");
  });

  it("does not expose mutable arrays from its internal preferences", async () => {
    const f = setup({ favoriteIds: ["fr"], recentIds: ["de"] });
    await f.preferences.initialize();
    const state = f.preferences.getState(LOCATIONS);
    state.favoriteIds.push("nl");
    state.recentIds.length = 0;
    expect(f.preferences.getState(LOCATIONS)).toMatchObject({
      favoriteIds: ["fr"],
      recentIds: ["de"],
    });
  });
});
