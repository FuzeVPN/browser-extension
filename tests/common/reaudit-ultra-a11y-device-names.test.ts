// SPDX-License-Identifier: MPL-2.0

import { decodeDeviceList, type Device } from "../../src/core/api/types";
import {
  deviceAccessibleName,
  deviceDisplayNames,
} from "../../src/ui/popup/device-accessible-name";

function decoded(names: readonly string[]): Device[] {
  const list = decodeDeviceList({
    limit: 10,
    devices: names.map((name, index) => ({
      device_id: `private-${String(index)}`,
      name,
      kind: "browser_extension",
      profiles: [],
      created_at: "2026-10-28T00:00:00Z",
    })),
  });
  expect(list).not.toBeNull();
  return list!.devices;
}

function distinct(devices: readonly Device[], locale = "fr") {
  return deviceDisplayNames(
    devices,
    (entry) => entry.name,
    locale,
    () => "Navigateur",
  );
}

// What a reader perceives: blanks seen as spaces (U+FEFF is not White_Space),
// invisible characters dropped, equivalent forms merged.
function perceived(name: string, locale = "fr"): string {
  return name
    .replace(/\p{White_Space}/gu, " ")
    .replace(/[\p{Default_Ignorable_Code_Point}\p{Cc}]/gu, "")
    .normalize("NFKC")
    .toLocaleLowerCase(locale);
}

describe("device names stay distinct when cleanup exposes an equivalence", () => {
  it.each([
    ["combining grapheme joiner", "\u034f"],
    ["zero width space", "\u200b"],
    ["soft hyphen", "\u00ad"],
    ["bidi isolate", "\u2066"],
    ["control character", "\u0007"],
    ["zero width no-break space", "\ufeff"],
  ])("suffixes \u00e9 and e + %s + acute accepted from the API", (_label, invisible) => {
    const devices = decoded(["\u00e9", `e${invisible}\u0301`]);
    const names = distinct(devices);

    expect([...names.values()]).toEqual(["\u00e9 (1)", `e${invisible}\u0301 (2)`]);
    const accessible = [...names.values()].map((name) => deviceAccessibleName("Supprimer", name));
    expect(new Set(accessible.map((name) => perceived(name))).size).toBe(2);
  });

  it.each([
    ["\u1e98", "W\u030a"],
    ["\u01f0", "J\u030c"],
    ["\u1e97", "T\u0308"],
  ])("suffixes %s and an uppercase base whose lowercase composes", (composed, decomposed) => {
    const names = distinct(decoded([composed, decomposed]));

    expect([...names.values()]).toEqual([`${composed} (1)`, `${decomposed} (2)`]);
    expect(new Set([...names.values()].map((name) => perceived(name))).size).toBe(2);
  });

  it.each([
    ["tr", "\u00cd", "I\u2060\u0301"],
    ["tr", "\u00cf", "I\ufeff\u0308"],
    ["lt", "\u00cf", "I\u200b\u0308"],
  ])(
    "suffixes in %s a capital I whose case mapping depends on composition",
    (locale, composed, decomposed) => {
      const names = distinct(decoded([composed, decomposed]), locale);

      expect([...names.values()]).toEqual([`${composed} (1)`, `${decomposed} (2)`]);
      const accessible = [...names.values()].map((name) => deviceAccessibleName("Sil", name));
      expect(new Set(accessible.map((name) => perceived(name, locale))).size).toBe(2);
    },
  );

  it("treats U+FEFF as invisible, not as a space, while tabs stay visible spaces", () => {
    const names = distinct(decoded(["Laptop", "Lap\ufefftop", "Lap top", "Lap\ttop"]));

    expect([...names.values()]).toEqual([
      "Laptop (1)",
      "Lap\ufefftop (2)",
      "Lap top (1)",
      "Lap\ttop (2)",
    ]);
    const accessible = [...names.values()].map((name) => deviceAccessibleName("Supprimer", name));
    expect(new Set(accessible.map((name) => perceived(name))).size).toBe(4);
  });

  it("reserves a literal suffix that is only equivalent after cleanup, in any API order", () => {
    const devices = decoded(["\u00e9", "e\u034f\u0301", "e\u200b\u0301 (1)"]);
    const names = distinct(devices);

    expect([...names.values()]).toEqual(["\u00e9 (2)", "e\u034f\u0301 (3)", "e\u200b\u0301 (1)"]);
    expect(new Set([...names.values()].map((name) => perceived(name))).size).toBe(3);
    expect([...distinct([...devices].reverse())].sort()).toEqual([...names].sort());
  });

  it("keeps unrelated names intact and still falls back for invisible-only names", () => {
    const names = distinct(decoded(["\u00e9", "e\u034f", "\u034f\u0301\u200b"]));

    expect([...names.values()]).toEqual(["\u00e9", "e\u034f", "\u034f\u0301\u200b"]);
    expect(distinct(decoded(["\u034f\u200b", "\u2066\u2069"])).get("private-0")).toBe(
      "Navigateur (1)",
    );
  });
});
