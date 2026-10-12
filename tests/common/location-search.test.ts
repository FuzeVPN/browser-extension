// SPDX-License-Identifier: MPL-2.0

import { matchesLocationSearch, normalizeLocationSearch } from "../../src/ui/popup/location-search";

describe("localized location search", () => {
  it.each([
    ["İstanbul", "istanbul"],
    ["İtalya", "italya"],
    ["İrlanda", "irlanda"],
    ["Iğdır", "ığdır"],
  ])("matches Turkish lower-case input for %s", (name, query) => {
    expect(matchesLocationSearch(name, "", query, "tr")).toBe(true);
    expect(matchesLocationSearch(name, "", name, "tr")).toBe(true);
  });
  it("preserves the Turkish distinction between dotted and dotless i", () => {
    expect(normalizeLocationSearch("Iİıi", "tr")).toBe("ıiıi");
    expect(matchesLocationSearch("Iğdır", "TR", "iğdir", "tr")).toBe(false);
  });
  it.each(["IT", "IE", "IN", "ID"])(
    "matches country code %s independently of locale casing",
    (code) => {
      for (const query of [code, code.toLowerCase()]) {
        expect(matchesLocationSearch("", code, query, "tr")).toBe(true);
      }
    },
  );
  it("keeps accent-insensitive search and requires every search term", () => {
    expect(matchesLocationSearch("München Germany", "DE", "MUNCHEN de", "en")).toBe(true);
    expect(matchesLocationSearch("München Allemagne", "DE", "munchen allemagne", "fr")).toBe(true);
    expect(matchesLocationSearch("İstanbul Türkiye", "TR", "istanbul TR", "tr")).toBe(true);
    expect(matchesLocationSearch("İstanbul Türkiye", "TR", "istanbul IT", "tr")).toBe(false);
    expect(matchesLocationSearch("İstanbul Türkiye", "TR", "  ", "tr")).toBe(true);
  });
});
