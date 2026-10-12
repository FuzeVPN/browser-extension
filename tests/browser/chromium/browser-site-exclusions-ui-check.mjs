// SPDX-License-Identifier: MPL-2.0

// Built-popup UI checks with a synthetic runtime. No account, proxy or live website is used.
// Routing and service-worker integration are checked separately by browser-site-exclusions-check.
// Optional: CHROME_EXTENSION_DIR, PLAYWRIGHT_MODULE_PATH, CHROMIUM_EXECUTABLE,
// SITE_EXCLUSIONS_UI_OUTPUT (report/screenshot directory).
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { extname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { SUPPORTED_LANGUAGES, localeDirectory } from "../../../scripts/supported-locales.mjs";

const root = resolve(import.meta.dirname, "../../..");
const require = createRequire(import.meta.url);
let playwrightPath = process.env.PLAYWRIGHT_MODULE_PATH;
if (!playwrightPath) {
  try {
    playwrightPath = require.resolve("playwright");
  } catch {
    playwrightPath = join(
      homedir(),
      ".cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs",
    );
  }
}
const { chromium } = await import(pathToFileURL(resolve(playwrightPath)).href);
const temporary = await mkdtemp(join(tmpdir(), "fuzevpn-exclusions-ui-"));
const output = resolve(process.env.SITE_EXCLUSIONS_UI_OUTPUT ?? temporary);
const extension = resolve(process.env.CHROME_EXTENSION_DIR ?? join(root, "dist/chrome"));
await mkdir(output, { recursive: true });
const report = {
  timestamp: new Date().toISOString(),
  scope: "Built popup, synthetic runtime snapshots, isolated Chromium; UI only",
  checks: [],
  pageErrors: [],
};
const catalog = JSON.parse(await readFile(join(extension, "_locales/fr/messages.json"), "utf8"));
const emptyPolicy = { revision: 0, enabled: false, entries: [] };
const initial = {
  network: {
    status: "idle",
    mode: null,
    ip: null,
    checkedAt: null,
    latencyMs: null,
    locationId: null,
  },
  locationPreferences: {
    favoriteIds: [],
    recentIds: [],
    automatic: false,
    recommendedLocationId: null,
  },
  siteExclusions: {
    saved: emptyPolicy,
    applied: emptyPolicy,
    pending: false,
    error: false,
  },
  blockingScope: "none",
  languagePreference: "fr",
  effectiveLanguage: "fr",
  status: "logged_out",
  protected: false,
  profile: null,
  subscription: null,
  locations: [],
  devices: [],
  deviceLimit: 2,
  currentDeviceId: null,
  selectedLocationId: null,
  activeLocationId: null,
  autoConnect: false,
  error: null,
  retryAfterSeconds: null,
  securityPreferences: { killSwitchEnabled: true, webRtcProtectionEnabled: true },
  protectionRequested: false,
  trafficBlocked: false,
  webRtcProtected: false,
  nextRetryAt: null,
};
let browser;

function record(name) {
  report.checks.push({ name, passed: true });
  process.stdout.write(`PASS ${name}\n`);
}

async function rendered(page) {
  await page.evaluate(
    () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))),
  );
}

async function publish(page, patch) {
  await page.evaluate((patch) => {
    Object.assign(window.exclusionFixture.snapshot, patch);
    window.exclusionFixture.publish();
  }, patch);
  await rendered(page);
}

try {
  browser = await chromium.launch({
    ...(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : {}),
    headless: true,
    args: ["--disable-background-networking", "--host-resolver-rules=MAP * ~NOTFOUND"],
  });
  report.chromium = browser.version();
  const context = await browser.newContext({ viewport: { width: 360, height: 600 } });
  await context.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== "https://popup.invalid") return route.abort();
    const file = resolve(extension, `.${decodeURIComponent(url.pathname)}`);
    if (relative(extension, file).startsWith("..")) return route.abort();
    const type = {
      ".html": "text/html",
      ".js": "text/javascript",
      ".css": "text/css",
      ".json": "application/json",
      ".svg": "image/svg+xml",
      ".woff2": "font/woff2",
    }[extname(file)];
    try {
      return await route.fulfill({ body: await readFile(file), contentType: type });
    } catch {
      return route.fulfill({ status: 404, body: "Missing test asset" });
    }
  });
  await context.addInitScript(
    ({ initial, catalog }) => {
      const listeners = [];
      const fixture = {
        snapshot: structuredClone(initial),
        commands: [],
        failNext: false,
        publish() {
          for (const listener of listeners) {
            listener({ type: "state_changed", snapshot: structuredClone(this.snapshot) });
          }
        },
      };
      window.exclusionFixture = fixture;
      window.chrome = {
        i18n: {
          getUILanguage: () => "fr",
          getMessage: (key, substitutions = []) =>
            (catalog[key]?.message ?? key).replace(
              /\$([1-9])/g,
              (_, n) => substitutions[n - 1] ?? "",
            ),
        },
        runtime: {
          getURL: (path) => `https://popup.invalid/${path}`,
          onMessage: { addListener: (listener) => listeners.push(listener) },
          async sendMessage(request) {
            fixture.commands.push(structuredClone(request));
            let ok = true;
            if (request.type === "update_site_exclusions") {
              if (fixture.failNext) {
                fixture.failNext = false;
                ok = false;
              } else if (
                request.expectedRevision !== fixture.snapshot.siteExclusions.saved.revision
              ) {
                ok = false;
              } else {
                const policy = {
                  revision: request.expectedRevision + 1,
                  enabled: request.enabled,
                  entries: request.entries,
                };
                fixture.snapshot.siteExclusions = {
                  saved: structuredClone(policy),
                  applied: structuredClone(policy),
                  pending: false,
                  error: false,
                };
              }
            } else if (request.type === "retry_site_exclusions") {
              fixture.snapshot.siteExclusions.applied = structuredClone(
                fixture.snapshot.siteExclusions.saved,
              );
              fixture.snapshot.siteExclusions.pending = false;
              fixture.snapshot.siteExclusions.error = false;
            } else if (request.type === "set_language_preference") {
              fixture.snapshot.languagePreference = request.preference;
              fixture.snapshot.effectiveLanguage =
                request.preference === "auto" ? "fr" : request.preference;
            }
            return { ok, snapshot: structuredClone(fixture.snapshot) };
          },
        },
      };
    },
    { initial, catalog },
  );
  const page = await context.newPage();
  page.on("pageerror", (error) => report.pageErrors.push(error.message));
  await page.goto("https://popup.invalid/popup/popup.html");
  await page.locator("#settingsButton").click();
  await page.locator("#manageExclusionsButton").click();
  assert.equal(await page.locator("#exclusionsDialog").evaluate((node) => node.open), true);
  assert.equal(await page.evaluate(() => document.activeElement.id), "exclusionInput");
  assert.equal(await page.locator("#exclusionSubdomains").isChecked(), true);
  assert.equal(await page.locator("#exclusionsEnabled").isChecked(), false);
  assert.equal(await page.locator("#exclusionsEmpty").isVisible(), true);
  record("Exceptions are available while signed out, empty by default and keyboard focused");

  await page.locator("#exclusionInput").fill("https://BÜCHER.de/path?query=1");
  assert.match(await page.locator("#exclusionPreview").innerText(), /xn--bcher-kva\.de/);
  await page.locator("#exclusionSubdomains").uncheck();
  await page.locator("#exclusionInput").press("Enter");
  await rendered(page);
  const first = await page.evaluate(() =>
    window.exclusionFixture.commands.find((c) => c.type === "update_site_exclusions"),
  );
  assert.deepEqual(first, {
    type: "update_site_exclusions",
    expectedRevision: 0,
    enabled: true,
    entries: [{ domain: "xn--bcher-kva.de", includeSubdomains: false }],
  });
  assert.equal(await page.locator("#exclusionInput").inputValue(), "");
  assert.equal(await page.locator("#exclusionSubdomains").isChecked(), true);
  assert.equal(await page.locator("#exclusionsEnabled").isChecked(), true);
  record("URL/IDN preview, Enter submission, exact-domain payload and first-add activation");

  for (const invalid of [
    "127.0.0.1",
    "localhost",
    "co.uk",
    "*.example.com",
    "api.ipify.org",
    "ipify.org",
  ]) {
    await page.locator("#exclusionInput").fill(invalid);
    assert.equal(await page.locator("#addExclusionButton").isDisabled(), true, invalid);
    assert.equal(await page.locator("#exclusionInputError").isVisible(), true, invalid);
  }
  await page.locator("#exclusionInput").fill("BÜCHER.de");
  assert.equal(
    await page.locator("#exclusionInputError").innerText(),
    catalog.siteExclusionDuplicate.message,
  );
  record("Invalid, reserved and duplicate domains cannot be added");

  await page.locator("#exclusionInput").fill("example.com");
  await page.locator("#addExclusionButton").click();
  await rendered(page);
  assert.equal(await page.locator(".exclusion-row").count(), 2);
  const secondPolicy = await page.evaluate(
    () => window.exclusionFixture.snapshot.siteExclusions.saved,
  );
  assert.deepEqual(secondPolicy.entries[1], { domain: "example.com", includeSubdomains: true });
  record("Subdomains are included by default on the next addition");

  await page.locator("#exclusionInput").fill("draft.example.net");
  await page.locator("#exclusionSubdomains").uncheck();
  await publish(page, {});
  assert.equal(await page.locator("#exclusionInput").inputValue(), "draft.example.net");
  assert.equal(await page.locator("#exclusionSubdomains").isChecked(), false);
  await page.locator(".exclusion-remove").last().focus();
  await publish(page, {});
  assert.equal(await page.evaluate(() => document.activeElement.dataset.focusKey), "example.com");
  record("Snapshots preserve the draft, scope choice and focused removal button");

  await page.locator("#exclusionsEnabled").uncheck();
  await rendered(page);
  assert.equal(await page.locator(".exclusion-row").count(), 2);
  assert.equal(await page.locator("#exclusionsEnabled").isChecked(), false);
  await page.locator("#exclusionsEnabled").check();
  await rendered(page);
  record("The global switch preserves the list and sends a versioned update");

  await page.evaluate(() => {
    window.exclusionFixture.failNext = true;
  });
  await page.locator(".exclusion-remove").first().click();
  await rendered(page);
  assert.equal(await page.locator("#exclusionsError").isVisible(), true);
  assert.equal(await page.locator(".exclusion-row").count(), 2);
  await page.locator("#retryExclusionsButton").click();
  await rendered(page);
  assert.equal(await page.locator("#exclusionsError").isVisible(), false);
  assert.equal(await page.locator(".exclusion-row").count(), 1);
  assert.equal(await page.locator(".exclusion-domain").textContent(), "example.com");
  record("Retry applies the originally failed removal and preserves the remaining saved entry");

  const committed = await page.evaluate(
    () => window.exclusionFixture.snapshot.siteExclusions.saved,
  );
  const target = {
    ...committed,
    revision: committed.revision + 1,
    entries: committed.entries.slice(0, 1),
  };
  await publish(page, {
    siteExclusions: { saved: target, applied: committed, pending: true, error: true },
  });
  assert.equal(await page.locator("#exclusionInput").isDisabled(), true);
  assert.equal(await page.locator("#retryExclusionsButton").isDisabled(), false);
  assert.equal(
    await page.locator("#exclusionsState").innerText(),
    catalog.siteExclusionsInterrupted.message,
  );
  await page.locator("#retryExclusionsButton").click();
  await rendered(page);
  assert.equal(await page.locator("#exclusionInput").isDisabled(), false);
  assert.equal(await page.locator(".exclusion-row").count(), 1);
  record("An interrupted transaction shows the durable target, restricts edits and can be retried");

  await page.locator("#exclusionInput").fill("");
  for (const language of SUPPORTED_LANGUAGES) {
    await page.locator("#closeExclusionsButton").click();
    await page.locator("#languageSelect").selectOption(language);
    await page.waitForFunction((language) => document.documentElement.lang === language, language);
    await page.locator("#manageExclusionsButton").click();
    const fileLocale = localeDirectory(language);
    const translated = JSON.parse(
      await readFile(join(extension, `_locales/${fileLocale}/messages.json`), "utf8"),
    );
    assert.equal(
      await page.locator("#exclusionsTitle").innerText(),
      translated.siteExclusions.message,
    );
    await page.locator("#exclusionInput").fill("https://bücher.de/audit");
    const direction = await page.evaluate(() => ({
      page: getComputedStyle(document.documentElement).direction,
      input: getComputedStyle(document.getElementById("exclusionInput")).direction,
      preview: getComputedStyle(document.querySelector("#exclusionPreview bdi")).direction,
      domain: getComputedStyle(document.querySelector(".exclusion-domain")).direction,
    }));
    assert.deepEqual(
      direction,
      {
        page: ["ar", "fa", "ur"].includes(language) ? "rtl" : "ltr",
        input: "ltr",
        preview: "ltr",
        domain: "ltr",
      },
      `Excluded domain isolation in ${language}`,
    );
    assert.equal(await page.locator("#exclusionPreview bdi").textContent(), "xn--bcher-kva.de");
    if (["ar", "fa", "ur"].includes(language))
      await page.screenshot({ path: join(output, `sites-exclus-${language}.png`) });
    await page.locator("#exclusionInput").fill("");
    assert.equal(
      await page
        .locator("#exclusionsDialog")
        .evaluate((node) => node.scrollWidth <= node.clientWidth + 1),
      true,
      language,
    );
    assert.equal(
      await page
        .locator("#exclusionsDialog [data-i18n]")
        .evaluateAll((nodes) =>
          nodes.every((node) => node.textContent.trim() && node.textContent !== node.dataset.i18n),
        ),
      true,
      language,
    );
  }
  record("All thirty translated dialogs render without missing text or horizontal overflow");
  record("Excluded domains and URL inputs stay LTR within both RTL and LTR dialogs");
  await page.locator("#closeExclusionsButton").click();
  await page.locator("#languageSelect").selectOption("fr");
  await page.waitForFunction(() => document.documentElement.lang === "fr");
  await page.locator("#manageExclusionsButton").click();
  await page.screenshot({ path: join(output, "sites-exclus-fr.png") });
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => document.getElementById("settingsPanel").open);
  assert.equal(await page.locator("#settingsPanel").evaluate((node) => node.open), true);
  assert.equal(await page.evaluate(() => document.activeElement.id), "manageExclusionsButton");
  await page.locator("#closeSettingsButton").click();
  record("Escape restores the settings dialog and its opener focus");

  await publish(page, {
    profile: {
      userId: "synthetic",
      email: "synthetic@example.invalid",
      firstName: "Synthetic",
      lastName: "Fixture",
      countryCode: "FR",
    },
    status: "connected",
    protected: true,
    protectionRequested: true,
    activeLocationId: "fr",
    selectedLocationId: "fr",
    locations: [
      {
        id: "fr",
        displayName: "Paris synthetic",
        city: "Paris",
        countryCode: "FR",
        supportedProtocols: ["browser_proxy"],
      },
    ],
    network: {
      status: "ready",
      mode: "vpn",
      ip: "185.159.157.10",
      checkedAt: Date.now(),
      latencyMs: 20,
      locationId: "fr",
    },
    siteExclusions: { saved: target, applied: committed, pending: false, error: false },
  });
  assert.equal(await page.locator("#statusLabel").innerText(), "VPN actif · 1 exceptions");
  assert.match(await page.locator("#publicIp").innerText(), /185\.159\.157\.10/);
  record("Connected status counts the applied policy and preserves the displayed VPN IPv4");

  await publish(page, {
    status: "blocked",
    protected: false,
    trafficBlocked: true,
    blockingScope: "except_excluded",
  });
  assert.equal(
    await page.locator("#recoveryStatus").innerText(),
    catalog.statusBlockedExceptions.message,
  );
  await publish(page, { blockingScope: "unverified" });
  assert.equal(
    await page.locator("#recoveryStatus").innerText(),
    catalog.securityBlockUnverified.message,
  );
  assert.equal(
    await page
      .locator("#recoveryStatus")
      .innerText()
      .then((text) => text.includes(catalog.statusBlockedExceptions.message)),
    false,
  );
  record("Outage accessibility is claimed only for a verified exception blocking scope");

  const full = {
    revision: 99,
    enabled: true,
    entries: Array.from({ length: 100 }, (_, n) => ({
      domain: `site${n}.example.com`,
      includeSubdomains: true,
    })),
  };
  await publish(page, {
    siteExclusions: { saved: full, applied: full, pending: false, error: false },
  });
  await page.locator("#settingsButton").click();
  await page.locator("#manageExclusionsButton").click();
  await page.locator("#exclusionInput").fill("extra.example.net");
  assert.equal(await page.locator("#addExclusionButton").isDisabled(), true);
  assert.equal(
    await page.locator("#exclusionInputError").innerText(),
    catalog.siteExclusionsLimit.message,
  );
  await page.locator(".exclusion-remove").last().click();
  await rendered(page);
  assert.equal(await page.locator(".exclusion-row").count(), 99);
  assert.equal(await page.locator("#addExclusionButton").isDisabled(), false);
  record("The 100-entry limit prevents additions until a site is removed");

  assert.deepEqual(report.pageErrors, []);
  report.passed = true;
} catch (error) {
  report.passed = false;
  report.error = error.stack ?? String(error);
  throw error;
} finally {
  await browser?.close();
  await writeFile(join(output, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`Report: ${join(output, "report.json")}\n`);
}
