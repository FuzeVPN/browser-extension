// SPDX-License-Identifier: MPL-2.0

import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { configureLegalLinks, EXTENSION_PRIVACY_PAGE } from "../../src/core/shared/legal-links";
import { LANGUAGE_NAMES, type Language } from "../../src/core/shared/language";

const extensionRoot = "moz-extension://privacy-fixture/";

function anchor(kind: string): HTMLAnchorElement {
  return {
    dataset: { legalLink: kind },
    href: "untouched",
    hreflang: "",
    target: "",
    rel: "",
  } as unknown as HTMLAnchorElement;
}

function root(links: HTMLAnchorElement[]): ParentNode {
  return { querySelectorAll: () => links } as unknown as ParentNode;
}

describe("extension privacy links", () => {
  beforeEach(() => {
    vi.stubGlobal("browser", {
      runtime: { getURL: (path: string) => `${extensionRoot}${path}` },
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it.each(Object.keys(LANGUAGE_NAMES) as Language[])(
    "opens the bundled notice in %s without sending the reader to the service policy",
    (language) => {
      const notice = anchor("privacy");
      configureLegalLinks(language, root([notice]));
      expect(notice.href).toBe(`${extensionRoot}${EXTENSION_PRIVACY_PAGE}?lang=${language}`);
      expect(notice.hreflang).toBe(language);
      expect(notice.target).toBe("_blank");
      expect(notice.rel).toBe("noopener noreferrer");
    },
  );

  it.each([
    ["fr", "fr", "contact"],
    ["de", "de", "kontakt"],
    ["es", "es", "contacto"],
    ["ar", "en", "contact"],
  ] as const)(
    "keeps service-policy and contact links external for %s",
    (language, site, contact) => {
      const links = ["general-privacy", "terms", "legal", "contact"].map(anchor);
      configureLegalLinks(language, root(links));
      expect(links.map((link) => link.href)).toEqual(
        ["privacy", "terms", "legal", contact].map(
          (page) => `https://fuzevpn.com/${site}/${page}.html`,
        ),
      );
      for (const link of links) {
        expect(link.hreflang).toBe(site);
        expect(link.target).toBe("_blank");
        expect(link.rel).toBe("noopener noreferrer");
      }
    },
  );

  it("ignores unknown and inherited object-property names", () => {
    const links = ["unknown", "toString", "constructor", "__proto__"].map(anchor);
    configureLegalLinks("fr", root(links));
    expect(links.every((link) => link.href === "untouched" && link.target === "")).toBe(true);
  });
});

describe("bundled privacy notice", () => {
  it("provides every displayed notice message in all shipped catalogs", async () => {
    const html = await readFile(
      resolve(import.meta.dirname, "../../src/ui", EXTENSION_PRIVACY_PAGE),
      "utf8",
    );
    const keys = [...html.matchAll(/data-i18n="([^"]+)"/g)].map((match) => match[1]);
    expect(keys.length).toBeGreaterThan(20);
    const localesRoot = resolve(import.meta.dirname, "../../assets/_locales");
    for (const directory of await readdir(localesRoot)) {
      const catalog: unknown = JSON.parse(
        await readFile(resolve(localesRoot, directory, "messages.json"), "utf8"),
      );
      expect(catalog).toBeTypeOf("object");
      for (const key of keys) {
        expect(typeof key).toBe("string");
        const entry = (catalog as Record<string, { message?: string }>)[key ?? ""];
        expect(entry?.message?.trim(), `${directory}: ${key ?? "missing key"}`).toBeTruthy();
      }
    }
  });
});
