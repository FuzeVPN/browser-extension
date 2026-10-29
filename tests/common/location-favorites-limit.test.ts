// SPDX-License-Identifier: MPL-2.0

import { readFile } from "node:fs/promises";
import {
  LocationPreferenceError,
  LocationPreferences,
} from "../../src/core/background/location-preferences";
import { failedCommand } from "../../src/core/background/state-machine";

it("returns an actionable localized quota error and accepts an addition after removal", async () => {
  const ids = Array.from({ length: 100 }, (_, index) => `server-${String(index)}`);
  const stored = { favoriteIds: ids, recentIds: [], automatic: false };
  const write = vi.fn(async () => undefined);
  const preferences = new LocationPreferences({
    storage: { read: async () => stored, write },
    onChanged() {},
  });
  await preferences.initialize();
  let failure: unknown;
  try {
    await preferences.setFavorite("new-server", true);
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(LocationPreferenceError);
  expect(failedCommand(failure)).toEqual({
    ok: false,
    commandError: "location_favorites_limit",
  });
  expect(write).not.toHaveBeenCalled();
  const french = JSON.parse(
    await readFile(new URL("../../assets/_locales/fr/messages.json", import.meta.url), "utf8"),
  ) as { error_location_favorites_limit: { message: string } };
  expect(french.error_location_favorites_limit.message).toContain("100");
  expect(french.error_location_favorites_limit.message).toMatch(/Retirez un favori/);
  await preferences.setFavorite(ids[0]!, false);
  await preferences.setFavorite("new-server", true);
  const current = preferences.getState([]);
  expect(current.unavailableFavoriteIds).toHaveLength(100);
  expect(current.unavailableFavoriteIds).toContain("new-server");
  expect(current.unavailableFavoriteIds).not.toContain(ids[0]);
});
