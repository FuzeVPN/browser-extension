// SPDX-License-Identifier: MPL-2.0

import { readFile, readdir, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import sharp from "sharp";

const root = resolve(import.meta.dirname, "../..");
// A single basic tab read disambiguates normal/private request provenance. The
// allowlist excludes aliases, every other tabs method and sensitive namespaces.
const AUTH_CHROME_APIS =
  /\b(?:browser|chrome)\.(?:tabs\b(?!\.get\()|history\b|cookies\b|scripting\b)/;

describe("source package audit", () => {
  it("restricts the proxy auth tab exception to a direct get call", () => {
    expect("browser.tabs.get(requestTabId)").not.toMatch(AUTH_CHROME_APIS);
    for (const code of [
      "browser.tabs.query({})",
      "browser.tabs.captureVisibleTab()",
      "browser.tabs.update(1,{})",
      "browser.tabs.remove(1)",
      "const get = browser.tabs.get",
      "browser.tabs.getAll()",
      "browser.tabs['get'](1)",
      "browser.history.search({})",
      "browser.cookies.get({})",
      "browser.scripting.executeScript({})",
    ])
      expect(code).toMatch(AUTH_CHROME_APIS);
  });
  it("uses exactly the approved permissions", async () => {
    const targets = (await import(pathToFileURL(resolve(root, "scripts/targets.mjs")).href)) as {
      manifestFor(target: string): Promise<Record<string, unknown>>;
    };
    const manifest = await targets.manifestFor("firefox");
    expect(manifest.permissions).toEqual([
      "identity",
      "proxy",
      "storage",
      "alarms",
      "webRequest",
      "webRequestBlocking",
      "privacy",
      "declarativeNetRequest",
    ]);
    expect(manifest.host_permissions).toEqual(["https://api.fuzevpn.com/*", "<all_urls>"]);
    expect(manifest).not.toHaveProperty("content_scripts");
    expect(manifest).not.toHaveProperty("minimum_chrome_version");
    expect(manifest.browser_specific_settings).toMatchObject({
      gecko: {
        id: "fuzevpn-firefox@vpn1euro.com",
        strict_min_version: "140.0",
        data_collection_permissions: {
          required: [
            "authenticationInfo",
            "personallyIdentifyingInfo",
            "browsingActivity",
            "websiteContent",
          ],
          optional: ["technicalAndInteraction"],
        },
      },
    });
    expect(manifest.background).toEqual({
      scripts: ["background/service-worker.js"],
      type: "module",
    });
    expect(manifest.default_locale).toBe("en");
    const packageInfo = JSON.parse(await readFile(resolve(root, "package.json"), "utf8")) as {
      version: string;
    };
    expect(manifest.version).toBe(packageInfo.version);
  });

  it("ships thirty complete catalogs with preserved substitutions and localized descriptions", async () => {
    const languages = [
      "en",
      "es",
      "pt_BR",
      "de",
      "fr",
      "ar",
      "tr",
      "ja",
      "id",
      "ru",
      "it",
      "ko",
      "pl",
      "nl",
      "hi",
      "vi",
      "uk",
      "th",
      "zh_CN",
      "zh_TW",
      "fa",
      "ur",
      "fil",
      "ms",
      "ro",
      "cs",
      "sv",
      "da",
      "no",
      "el",
    ];
    const source = await locale("en");
    for (const language of languages) {
      const catalog = await locale(language);
      expect(Object.keys(catalog).sort()).toEqual(Object.keys(source).sort());
      for (const key of Object.keys(source)) {
        const text = message(catalog, key);
        expect(typeof text).toBe("string");
        expect(String(text).trim().length).toBeGreaterThan(0);
        expect(
          String(text)
            .match(/\$[1-9]/g)
            ?.sort() ?? [],
        ).toEqual(
          String(message(source, key))
            .match(/\$[1-9]/g)
            ?.sort() ?? [],
        );
      }
      expect(message(catalog, "extensionName")).toBe("FuzeVPN");
      expect(String(message(catalog, "extensionDescription")).length).toBeLessThanOrEqual(132);
      if (language !== "en")
        expect(message(catalog, "extensionDescription")).not.toBe(
          message(source, "extensionDescription"),
        );
    }
  });

  it("keeps the official mark unchanged outside the compact status indicator", async () => {
    const names = ["disconnected", "connected", "reconnecting", "error"];
    const topRegions = await Promise.all(
      names.map((name) =>
        sharp(resolve(root, `assets/icons/${name}-128.png`))
          .extract({ left: 0, top: 0, width: 128, height: 88 })
          .raw()
          .toBuffer(),
      ),
    );
    for (const region of topRegions.slice(1)) expect(region.equals(topRegions[0]!)).toBe(true);

    const worker = await readFile(resolve(root, "src/core/background/service-worker.ts"), "utf8");
    expect(worker).toContain('extensionApi.action.setBadgeText({ text: "" })');
    expect(worker).not.toContain("setBadgeBackgroundColor");
  });

  it("defines every localization key referenced by the popup and assistance page", async () => {
    const [fr, popup, diagnostics] = await Promise.all([
      locale("fr"),
      readFile(resolve(root, "src/ui/popup/popup.html"), "utf8"),
      readFile(resolve(root, "src/ui/diagnostics-page/diagnostics.html"), "utf8"),
    ]);
    const html = popup + diagnostics;
    const keys = [...html.matchAll(/data-i18n(?:-placeholder|-aria-label|-title)?="([^"]+)"/g)].map(
      (match) => match[1],
    );
    for (const key of keys) expect(fr).toHaveProperty(key ?? "");
  });

  it("contains no remote runtime code, forbidden brand or prohibited Chrome APIs", async () => {
    const forbiddenBrand = ["VPN", "1", "Dollar"].join(" ");
    const patterns = [
      new RegExp(forbiddenBrand, "i"),
      /<script[^>]+src=["']https?:/i,
      /\beval\s*\(/,
      /new\s+Function\s*\(/,
    ];
    for (const file of await files(resolve(root, "src"))) {
      const text = await readFile(file, "utf8");
      const chromeApis =
        file === resolve(root, "src/platform/firefox/proxy-auth.ts") ||
        file === resolve(root, "src/platform/chromium/proxy-auth.ts")
          ? AUTH_CHROME_APIS
          : /\b(?:browser|chrome)\.(tabs|history|cookies|scripting)\b/;
      for (const pattern of [
        ...patterns,
        chromeApis,
        ...(file.includes(`${String.fromCharCode(92)}platform${String.fromCharCode(92)}`) ||
        file.includes("/platform/")
          ? []
          : [/\b(?:chrome|browser)\./]),
      ])
        expect(text).not.toMatch(pattern);
    }
  });
});

async function locale(language: string): Promise<Record<string, unknown>> {
  return JSON.parse(
    await readFile(resolve(root, `assets/_locales/${language}/messages.json`), "utf8"),
  ) as Record<string, unknown>;
}

function message(localeData: Record<string, unknown>, key: string): unknown {
  return (localeData[key] as { message?: unknown } | undefined)?.message;
}

async function files(directory: string): Promise<string[]> {
  const result: string[] = [];
  for (const name of await readdir(directory)) {
    const path = resolve(directory, name);
    const info = await stat(path);
    if (info.isDirectory()) result.push(...(await files(path)));
    else if (/\.(?:ts|html|css|json)$/i.test(path)) result.push(path);
  }
  return result;
}
