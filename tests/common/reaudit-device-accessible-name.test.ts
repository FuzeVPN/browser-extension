// SPDX-License-Identifier: MPL-2.0

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { LANGUAGE_NAMES, localeDirectory, type Language } from "../../src/core/shared/language";
import { Translator, type Catalog } from "../../src/core/shared/translator";
import { deviceAccessibleName } from "../../src/ui/popup/device-accessible-name";
import { deviceDisplayName } from "../../src/ui/popup/device-display";

const languages = Object.keys(LANGUAGE_NAMES) as Language[];
const translator = new Translator(async (language) => {
  const source = await readFile(
    resolve(
      import.meta.dirname,
      "../../assets/_locales",
      localeDirectory(language),
      "messages.json",
    ),
    "utf8",
  );
  return JSON.parse(source) as Catalog;
});
const names = [
  "Laptop two",
  "Travel phone",
  "حاسوب العمل",
  '<img src=x onerror="globalThis.deviceNameExecuted=true"> $1 $$ <script>alert(1)</script>',
  "\u202e><button autofocus>الجهاز\u202c \u2067RTL\u2069",
];

describe("device deletion labels retain the visible action", () => {
  it("covers all thirty shipped languages", () => {
    expect(languages).toHaveLength(30);
  });

  it.each(languages)(
    "keeps the complete visible label and the distinct target in %s",
    async (language) => {
      const message = await translator.forLanguage(language);
      const visibleAction = message("deleteDevice");
      expect(visibleAction).not.toBe("deleteDevice");
      const accessibleNames = names.map((name) => deviceAccessibleName(visibleAction, name));

      for (const [index, accessibleName] of accessibleNames.entries()) {
        expect(accessibleName.startsWith(visibleAction)).toBe(true);
        expect(accessibleName).toContain(visibleAction);
        expect(accessibleName.endsWith(names[index] ?? "")).toBe(true);
      }
      expect(new Set(accessibleNames).size).toBe(names.length);

      const currentDisplayName = deviceDisplayName(
        { deviceId: "current", kind: "browser_extension", name: "Browser" },
        "current",
        message("deviceKindFirefox"),
        message("deviceKindBrowser"),
      );
      const currentName = deviceAccessibleName(visibleAction, currentDisplayName);
      expect(currentName.startsWith(visibleAction)).toBe(true);
      expect(currentName).toContain(currentDisplayName);
    },
  );

  it("preserves hostile text, substitutions and bidi controls as literal name data", () => {
    const name =
      '\u202e</button><img src=x onerror="globalThis.deviceNameExecuted=true"> $1 $$ &amp; \u2067حاسوب\u2069\u202c';
    const label = deviceAccessibleName("Supprimer l’appareil", name);

    expect(typeof label).toBe("string");
    expect(label.startsWith("Supprimer l’appareil")).toBe(true);
    expect(label.endsWith(name)).toBe(true);
    expect(label).toContain('<img src=x onerror="globalThis.deviceNameExecuted=true">');
    expect(label).toContain("$1 $$ &amp;");
    expect(label).toContain("\u202e");
    expect(label).toContain("\u2067حاسوب\u2069\u202c");
  });
});
