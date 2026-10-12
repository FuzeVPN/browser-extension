// SPDX-License-Identifier: MPL-2.0

import type { Location } from "../../src/core/api/types";
import { buildLocationGroups, chooseGroupLocation } from "../../src/ui/popup/location-groups";
import { EMPTY_SNAPSHOT, type AppSnapshot } from "../../src/core/shared/state";

function location(id: string, city = "Frankfurt", countryCode = "DE"): Location {
  return { id, city, countryCode, displayName: id, supportedProtocols: ["browser_proxy"] };
}

const german = [location("Frankfurt10"), location("Frankfurt2"), location("Frankfurt1")];

function snapshot(locations = german): AppSnapshot {
  return { ...structuredClone(EMPTY_SNAPSHOT), locations };
}

describe("country and city location groups", () => {
  it("groups using country and city fields, then naturally orders individual servers", () => {
    const catalog = [...german, location("Paris1", "Paris", "FR"), location("Berlin1", "Berlin")];
    const original = structuredClone(catalog);
    const groups = buildLocationGroups(catalog, "fr");
    expect(groups.map(({ countryCode }) => countryCode)).toEqual(["DE", "FR"]);
    expect(groups[0]?.cities.map(({ city }) => city)).toEqual(["Berlin", "Frankfurt"]);
    expect(groups[0]?.cities[1]?.locations.map(({ id }) => id)).toEqual([
      "Frankfurt1",
      "Frankfurt2",
      "Frankfurt10",
    ]);
    expect(catalog).toEqual(original);
  });

  it("sorts by translated country names and retains stable identity when the language changes", () => {
    const catalog = [location("z", "Zürich", "CH"), location("b", "Berlin", "DE")];
    const french = buildLocationGroups(catalog, "fr");
    const germanGroups = buildLocationGroups(catalog, "de");
    expect(french.find((group) => group.countryCode === "DE")?.cities[0]?.key).toBe(
      germanGroups.find((group) => group.countryCode === "DE")?.cities[0]?.key,
    );
  });

  it("separates identically named cities in different countries and does not infer cities from names", () => {
    const catalog = [
      location("node-A", "Paris", "FR"),
      location("Paris2", "Lyon", "FR"),
      location("node-B", "Paris", "US"),
    ];
    const groups = buildLocationGroups(catalog, "en");
    expect(groups).toHaveLength(2);
    expect(groups.flatMap(({ cities }) => cities).map(({ key }) => key)).toHaveLength(3);
    expect(
      groups.find(({ countryCode }) => countryCode === "FR")?.cities.map(({ city }) => city),
    ).toEqual(["Lyon", "Paris"]);
  });

  it("normalizes spacing, case and Unicode without changing API labels or identifiers", () => {
    const first = location("one", "  São   Paulo ", "br");
    const second = location("two", "Sa\u0303o Paulo", "BR");
    const groups = buildLocationGroups([first, second], "pt-BR");
    expect(groups).toHaveLength(1);
    expect(groups[0]?.cities).toHaveLength(1);
    expect(groups[0]?.cities[0]?.city).toBe("São Paulo");
    expect(groups[0]?.locations).toContain(first);
    expect(first.city).toBe("  São   Paulo ");
  });

  it("supports a single server and an empty catalog without inventing entries", () => {
    expect(buildLocationGroups([], "ar")).toEqual([]);
    const groups = buildLocationGroups([location("solo")], "ar");
    expect(groups[0]?.cities[0]?.locations).toHaveLength(1);
  });

  it("keeps cities that have colliding display collation but distinct names separate", () => {
    const groups = buildLocationGroups([location("a", "München"), location("b", "Munchen")], "de");
    expect(groups[0]?.cities).toHaveLength(2);
  });
});

describe("one-click country and city selection", () => {
  it("prefers the already protected server within the chosen group", () => {
    const state = snapshot();
    state.protected = true;
    state.activeLocationId = "Frankfurt2";
    state.locationPreferences.recommendedLocationId = "Frankfurt1";
    expect(chooseGroupLocation(german, state)?.id).toBe("Frankfurt2");
  });

  it("uses the available recommendation, then a recent server within the group", () => {
    const state = snapshot();
    state.locationPreferences.recommendedLocationId = "Frankfurt2";
    state.locationPreferences.recentIds = ["outside", "Frankfurt10"];
    expect(chooseGroupLocation(german, state)?.id).toBe("Frankfurt2");
    state.locationPreferences.recommendedLocationId = "outside";
    expect(chooseGroupLocation(german, state)?.id).toBe("Frankfurt10");
  });

  it("has a stable natural fallback independent of API order", () => {
    const state = snapshot();
    expect(chooseGroupLocation(german, state)?.id).toBe("Frankfurt1");
    expect(chooseGroupLocation([...german].reverse(), state)?.id).toBe("Frankfurt1");
  });

  it("never selects an unavailable server from a stale group or a server outside the group", () => {
    const state = snapshot([german[0]!, location("Paris1", "Paris", "FR")]);
    state.protected = true;
    state.activeLocationId = "Frankfurt2";
    state.locationPreferences.recommendedLocationId = "Paris1";
    state.locationPreferences.recentIds = ["Frankfurt1"];
    expect(chooseGroupLocation(german, state)?.id).toBe("Frankfurt10");
    state.locations = [location("Paris1", "Paris", "FR")];
    expect(chooseGroupLocation(german, state)).toBeNull();
  });

  it("does not mutate selection, automatic preference or protection intent", () => {
    const state = snapshot();
    const original = structuredClone(state);
    chooseGroupLocation(german, state);
    expect(state).toEqual(original);
  });
});
