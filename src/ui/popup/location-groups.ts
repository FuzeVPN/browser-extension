// SPDX-License-Identifier: MPL-2.0

import type { Location } from "../../core/api/types";
import type { Language } from "../../core/shared/language";
import type { AppSnapshot } from "../../core/shared/state";
import { countryLabel } from "./country-label";

export interface LocationCityGroup {
  key: string;
  city: string;
  locations: Location[];
}

export interface LocationCountryGroup {
  countryCode: string;
  cities: LocationCityGroup[];
  locations: Location[];
}

/** Group by API geography, never by a server's display name or numeric suffix. */
export function buildLocationGroups(
  locations: Location[],
  locale: Language,
): LocationCountryGroup[] {
  const names = new Intl.DisplayNames([locale], { type: "region" });
  const collator = new Intl.Collator(locale, { sensitivity: "base", numeric: true });
  const compare = (left: string, right: string): number => collator.compare(left, right);
  const countries = new Map<string, Map<string, LocationCityGroup>>();
  for (const location of locations) {
    const countryCode = location.countryCode.trim().toUpperCase();
    const city = location.city.trim().normalize("NFC").replace(/\s+/g, " ");
    const cityKey = JSON.stringify([countryCode, city.toLowerCase()]);
    let cities = countries.get(countryCode);
    if (!cities) {
      cities = new Map();
      countries.set(countryCode, cities);
    }
    let group = cities.get(cityKey);
    if (!group) {
      group = { key: cityKey, city, locations: [] };
      cities.set(cityKey, group);
    }
    group.locations.push(location);
  }
  const result: LocationCountryGroup[] = [];
  for (const [countryCode, cityMap] of countries) {
    const cities = [...cityMap.values()].sort(
      (left, right) => compare(left.city, right.city) || lexical(left.key, right.key),
    );
    for (const city of cities) {
      city.locations.sort(
        (left, right) => compare(left.displayName, right.displayName) || lexical(left.id, right.id),
      );
    }
    result.push({ countryCode, cities, locations: cities.flatMap((city) => city.locations) });
  }
  return result.sort(
    (left, right) =>
      compare(countryLabel(left.countryCode, names), countryLabel(right.countryCode, names)) ||
      lexical(left.countryCode, right.countryCode),
  );
}

/** Resolve this click only; geography never becomes a persistent automatic mode. */
export function chooseGroupLocation(locations: Location[], snapshot: AppSnapshot): Location | null {
  const available = new Map(snapshot.locations.map((location) => [location.id, location]));
  const candidates = locations.flatMap((location) => {
    const current = available.get(location.id);
    return current ? [current] : [];
  });
  const ids = [
    ...(snapshot.protected && snapshot.activeLocationId ? [snapshot.activeLocationId] : []),
    snapshot.locationPreferences.recommendedLocationId,
    ...snapshot.locationPreferences.recentIds,
  ];
  for (const id of ids) {
    const candidate = candidates.find((location) => location.id === id);
    if (candidate) return candidate;
  }
  return (
    [...candidates].sort(
      (left, right) =>
        left.displayName.localeCompare(right.displayName, "en", { numeric: true }) ||
        lexical(left.id, right.id),
    )[0] ?? null
  );
}

function lexical(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
