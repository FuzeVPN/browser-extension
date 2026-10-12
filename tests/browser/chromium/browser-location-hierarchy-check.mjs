// SPDX-License-Identifier: MPL-2.0

// Popup regression checks with an isolated browser and synthetic runtime.
// No production connection, no real Chrome profile. Mock runtime and local dist assets only.
import assert from "node:assert/strict";
import { readFile, writeFile, mkdir, mkdtemp } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { resolve, join, extname, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { SUPPORTED_LANGUAGES, localeDirectory } from "../../../scripts/supported-locales.mjs";
const root = resolve(import.meta.dirname, "../../..");
const output = resolve(
  process.env.LOCATION_HIERARCHY_OUTPUT ||
    (await mkdtemp(join(tmpdir(), "fuzevpn-location-hierarchy-"))),
);
const extension = resolve(process.env.CHROME_EXTENSION_DIR || join(root, "dist/chrome"));
const playwright =
  process.env.PLAYWRIGHT_MODULE_PATH ||
  join(
    homedir(),
    ".cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs",
  );
const executablePath = process.env.CHROMIUM_EXECUTABLE;
const { chromium } = await import(pathToFileURL(playwright).href);
const catalog = JSON.parse(await readFile(join(extension, "_locales/fr/messages.json"), "utf8"));
const policy = { revision: 0, enabled: false, entries: [] };
const connected = {
  snapshotVersion: { workerId: "fixture-worker", revision: 1 },
  network: {
    status: "ready",
    mode: "vpn",
    ip: "203.0.113.7",
    checkedAt: Date.now(),
    latencyMs: 30,
    locationId: "fr",
  },
  locationPreferences: {
    favoriteIds: [],
    recentIds: [],
    automatic: false,
    recommendedLocationId: "fr",
  },
  siteExclusions: { saved: policy, applied: policy, pending: false, error: false },
  blockingScope: "none",
  languagePreference: "fr",
  effectiveLanguage: "fr",
  status: "connected",
  protected: true,
  profile: {
    userId: "synthetic",
    email: "audit@example.invalid",
    firstName: "Audit",
    lastName: "Synthetic",
    countryCode: "FR",
  },
  subscription: {
    status: "active",
    hasAccess: true,
    offerId: "audit",
    startedAt: null,
    expiresAt: "2027-01-01T00:00:00Z",
    renewsAutomatically: false,
  },
  locations: [
    {
      id: "fr",
      displayName: "Paris",
      city: "Paris",
      countryCode: "FR",
      supportedProtocols: ["browser_proxy"],
    },
  ],
  devices: [],
  deviceLimit: 5,
  currentDeviceId: null,
  selectedLocationId: "fr",
  activeLocationId: "fr",
  autoConnect: false,
  error: null,
  retryAfterSeconds: null,
  securityPreferences: { killSwitchEnabled: true, webRtcProtectionEnabled: true },
  protectionRequested: true,
  trafficBlocked: false,
  webRtcProtected: true,
  nextRetryAt: null,
};
connected.locations.push(
  ...[
    ["de1", "Frankfurt1", "Frankfurt"],
    ["de2", "Frankfurt2", "Frankfurt"],
    ["de10", "Frankfurt10", "Frankfurt"],
    ["berlin", "Berlin1", "Berlin"],
  ].map(([id, displayName, city]) => ({
    id,
    displayName,
    city,
    countryCode: "DE",
    supportedProtocols: ["browser_proxy"],
  })),
);
connected.locationPreferences.recommendedLocationId = "de2";
connected.locationPreferences.recentIds = ["de10", "fr"];
const report = {
  scope: "Built popup; Chromium temporary context; synthetic runtime; external requests aborted",
  timestamp: new Date().toISOString(),
  checks: [],
  pageErrors: [],
  blockedRequests: [],
};
const browser = await chromium.launch({
  executablePath,
  headless: true,
  args: ["--disable-background-networking", "--host-resolver-rules=MAP * ~NOTFOUND"],
});
report.chromium = browser.version();
await mkdir(output, { recursive: true });
const context = await browser.newContext({ viewport: { width: 360, height: 600 } });
await context.route("**/*", async (route) => {
  const url = new URL(route.request().url());
  if (url.origin !== "https://popup.invalid") {
    report.blockedRequests.push(url.origin);
    return route.abort();
  }
  const file = resolve(extension, `.${decodeURIComponent(url.pathname)}`);
  if (relative(extension, file).startsWith("..")) return route.abort();
  const contentType = {
    ".html": "text/html",
    ".js": "text/javascript",
    ".css": "text/css",
    ".json": "application/json",
    ".svg": "image/svg+xml",
    ".woff2": "font/woff2",
  }[extname(file)];
  try {
    return await route.fulfill({ body: await readFile(file), contentType });
  } catch {
    return route.fulfill({ status: 404, body: "Missing local asset" });
  }
});
await context.addInitScript(
  ({ connected, catalog }) => {
    const listeners = [];
    window.fixture = {
      snapshot: structuredClone(connected),
      commands: [],
      requests: [],
      failTypes: [],
      responsePatches: {},
      commandResults: {},
      applyExclusions: false,
      applyFavorites: true,
      heldType: null,
      held: null,
      publish(patch) {
        Object.assign(this.snapshot, patch);
        this.snapshot.snapshotVersion.revision += 1;
        this.emit(this.snapshot);
      },
      emit(value) {
        for (const listener of listeners)
          listener({ type: "state_changed", snapshot: structuredClone(value) });
      },
    };
    window.chrome = {
      i18n: {
        getUILanguage: () => "fr",
        getMessage: (key, values = []) =>
          (catalog[key]?.message ?? key).replace(/\$([1-9])/g, (_, i) => values[i - 1] ?? ""),
      },
      runtime: {
        getURL: (path) => `https://popup.invalid/${path}`,
        onMessage: { addListener: (listener) => listeners.push(listener) },
        async sendMessage(request) {
          const f = window.fixture;
          f.commands.push(request.type);
          f.requests.push(structuredClone(request));
          if (f.failTypes.includes(request.type)) throw new Error("Synthetic messaging failure");
          if (f.applyExclusions && request.type === "update_site_exclusions") {
            const saved = {
              revision: f.snapshot.siteExclusions.saved.revision + 1,
              enabled: request.enabled,
              entries: structuredClone(request.entries),
            };
            f.snapshot.siteExclusions = {
              saved,
              applied: structuredClone(saved),
              pending: false,
              error: false,
            };
          }
          if (f.applyFavorites && request.type === "set_location_favorite") {
            const preferences = f.snapshot.locationPreferences;
            preferences.favoriteIds = preferences.favoriteIds.filter(
              (id) => id !== request.locationId,
            );
            preferences.unavailableFavoriteIds = (preferences.unavailableFavoriteIds ?? []).filter(
              (id) => id !== request.locationId,
            );
            if (request.favorite) preferences.favoriteIds.push(request.locationId);
          }
          if (
            ["change_location", "select_location"].includes(request.type) &&
            !f.commandResults[request.type]?.commandError
          ) {
            f.snapshot.selectedLocationId = request.locationId;
            f.snapshot.locationPreferences.automatic = false;
            if (request.type === "change_location")
              f.snapshot.activeLocationId = request.locationId;
          }
          if (request.type === "select_automatic_location") {
            f.snapshot.locationPreferences.automatic = true;
            f.snapshot.selectedLocationId = f.snapshot.locationPreferences.recommendedLocationId;
          }
          Object.assign(f.snapshot, f.responsePatches[request.type] ?? {});
          f.snapshot.snapshotVersion.revision += 1;
          const response = {
            ok: true,
            ...f.commandResults[request.type],
            snapshot: structuredClone(f.snapshot),
          };
          if (f.heldType === request.type) {
            f.heldType = null;
            return new Promise((resolve) => {
              f.held = () => resolve(response);
            });
          }
          return response;
        },
      },
    };
  },
  { connected, catalog },
);
async function rendered(page) {
  await page.evaluate(
    () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))),
  );
}
async function open() {
  const page = await context.newPage();
  page.on("pageerror", (error) => report.pageErrors.push(error.message));
  await page.goto("https://popup.invalid/popup/popup.html");
  await page.waitForFunction(
    (expected) =>
      document.getElementById("statusLabel").textContent === expected &&
      document.getElementById("refreshSubscriptionButton").getAttribute("aria-busy") === "false",
    catalog.statusProtected.message,
  );
  await rendered(page);
  return page;
}
function record(name) {
  report.checks.push({ name, passed: true });
}
async function refreshed(page) {
  await page.waitForFunction(
    () => document.getElementById("refreshLocationsButton").getAttribute("aria-busy") === "false",
  );
  await rendered(page);
}

function country(page, code = "DE") {
  return page.locator(`.location-country-group[data-country-code="${code}"]`);
}
function city(page, name = "Frankfurt") {
  return country(page)
    .locator(".location-city-group")
    .filter({
      has: page.locator(".location-city-select > .option-title", { hasText: name }),
    });
}
const groupButton = ":scope > .location-group-row > .location-group-select";
const disclosure = ":scope > .location-group-row > .location-disclosure";
async function selector(page) {
  await page.locator("#changeLocationButton").click();
  await refreshed(page);
}
async function expand(page) {
  await country(page).locator(disclosure).click();
  await city(page).locator(disclosure).click();
}
async function connectionRequests(page) {
  return page.evaluate(() =>
    window.fixture.requests.filter((request) =>
      ["change_location", "select_location", "connect", "select_automatic_location"].includes(
        request.type,
      ),
    ),
  );
}
try {
  let page = await open();
  await selector(page);
  assert.equal(await page.locator(".location-country-group").count(), 2);
  assert.equal(await page.locator(".location-server-row:visible").count(), 0);
  assert.equal(await country(page).locator(disclosure).getAttribute("aria-expanded"), "false");
  assert.equal(
    await country(page).locator(`${groupButton} > .option-title`).textContent(),
    "Allemagne",
  );
  await country(page).locator(disclosure).focus();
  await page.keyboard.press("Enter");
  assert.equal(await country(page).locator(".location-city-group:visible").count(), 2);
  assert.equal(await city(page).locator(disclosure).getAttribute("aria-expanded"), "false");
  await city(page).locator(disclosure).focus();
  await page.keyboard.press("Space");
  assert.deepEqual(
    await city(page).locator(".location-server-row .option-title").allTextContents(),
    ["Frankfurt1", "Frankfurt2", "Frankfurt10"],
  );
  assert.equal(
    await city(page)
      .locator(disclosure)
      .evaluate((node) => document.activeElement === node),
    true,
  );
  assert.deepEqual(await connectionRequests(page), []);
  record(
    "Country and city disclosure expose the requested hierarchy in natural server order; Enter and Space preserve focus without selecting or connecting",
  );
  await page.locator('button[data-focus-key="de2"]').scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(output, "hierarchy-fr.png"), animations: "disabled" });
  const geometry = await country(page)
    .locator(".location-group-row")
    .first()
    .evaluate((row) => {
      const [select, expand] = [...row.children].map((node) => node.getBoundingClientRect());
      return {
        selectWidth: select.width,
        expandWidth: expand.width,
        expandHeight: expand.height,
        ratio: expand.width / (select.width + expand.width),
      };
    });
  assert.ok(geometry.expandWidth >= 44 && geometry.expandHeight >= 44, JSON.stringify(geometry));
  assert.ok(geometry.ratio >= 0.24 && geometry.ratio <= 0.26, JSON.stringify(geometry));
  record(
    "The country row has separate 75/25 selection and disclosure targets with a disclosure area of at least 44 pixels",
  );
  await page.locator('button[data-focus-key="de2"]').focus();
  await page.evaluate(() =>
    window.fixture.publish({
      locations: window.fixture.snapshot.locations.filter(({ id }) => id !== "de10"),
    }),
  );
  await rendered(page);
  assert.equal(await city(page).locator(disclosure).getAttribute("aria-expanded"), "true");
  assert.equal(
    await page
      .locator('button[data-focus-key="de2"]')
      .evaluate((node) => document.activeElement === node),
    true,
  );
  assert.equal(await page.locator('button[data-focus-key="de10"]').count(), 0);
  record(
    "Catalog updates preserve expanded country/city and keyboard focus while removing an unavailable server",
  );
  await country(page).locator(groupButton).click();
  await page.locator("#locationDialog").waitFor({ state: "hidden" });
  assert.deepEqual(await connectionRequests(page), [
    { type: "change_location", locationId: "de2" },
  ]);
  assert.equal(
    await page.evaluate(() => window.fixture.snapshot.locationPreferences.automatic),
    false,
  );
  record(
    "Selecting a country resolves its available recommended server through one ordinary manual change command",
  );
  await selector(page);
  await country(page).locator(groupButton).click();
  await page.locator("#locationDialog").waitFor({ state: "hidden" });
  assert.equal((await connectionRequests(page)).length, 1);
  record(
    "Selecting the current country retains its already active available server without reconnecting",
  );
  await page.close();

  page = await open();
  await selector(page);
  await country(page).locator(disclosure).click();
  assert.equal(await city(page, "Berlin").locator(disclosure).count(), 0);
  await city(page, "Berlin").locator(".location-favorite").click();
  await rendered(page);
  assert.equal(
    await city(page, "Berlin").locator(".location-favorite").getAttribute("aria-pressed"),
    "true",
  );
  assert.deepEqual(await connectionRequests(page), []);
  await city(page, "Berlin").locator(groupButton).click();
  await page.locator("#locationDialog").waitFor({ state: "hidden" });
  assert.deepEqual(await connectionRequests(page), [
    { type: "change_location", locationId: "berlin" },
  ]);
  record(
    "A single-server city remains directly selectable and its separate favorite action does not connect",
  );
  await page.close();

  page = await open();
  await page.evaluate(() =>
    window.fixture.publish({
      status: "disconnected",
      protected: false,
      protectionRequested: false,
      activeLocationId: null,
    }),
  );
  await selector(page);
  await country(page).locator(disclosure).click();
  await city(page).locator(groupButton).click();
  await page.locator("#locationDialog").waitFor({ state: "hidden" });
  assert.deepEqual(await connectionRequests(page), [
    { type: "select_location", locationId: "de2" },
  ]);
  record(
    "When disconnected, selecting a city changes only the manual server selection and does not start protection",
  );
  await page.close();

  page = await open();
  await page.evaluate(() =>
    window.fixture.publish({
      locationPreferences: {
        ...window.fixture.snapshot.locationPreferences,
        favoriteIds: ["de1", "berlin"],
      },
    }),
  );
  await selector(page);
  await page.locator("#favoriteLocationsFilter").click();
  assert.equal(await page.locator(".location-country-group").count(), 0);
  assert.deepEqual(
    await page
      .locator(".location-server-row .location-option")
      .evaluateAll((nodes) => nodes.map((node) => node.dataset.focusKey)),
    ["de1", "berlin"],
  );
  await page.locator("#recentLocationsFilter").click();
  assert.deepEqual(
    await page
      .locator(".location-server-row .location-option")
      .evaluateAll((nodes) => nodes.map((node) => node.dataset.focusKey)),
    ["de10", "fr"],
  );
  await page.locator("#allLocationsFilter").click();
  await page.locator("#locationSearch").fill("Frankfurt");
  assert.equal(await page.locator(".location-country-group").count(), 0);
  assert.equal(await page.locator(".location-server-row").count(), 3);
  assert.match(
    await page.locator(".location-server-row .option-country").first().textContent(),
    /Allemagne · Frankfurt/,
  );
  await page.locator("#locationSearch").fill("Allemagne");
  assert.equal(await page.locator(".location-server-row").count(), 4);
  assert.deepEqual(await connectionRequests(page), []);
  record(
    "Favorites and recent servers remain direct shortcuts; country/city/server search returns matching leaves with geographic context",
  );
  await page.close();

  page = await open();
  await selector(page);
  await expand(page);
  await page.evaluate(() => {
    window.fixture.commandResults.change_location = { ok: false, commandError: "server_full" };
    window.fixture.responsePatches.change_location = {
      error: "server_full",
      locations: window.fixture.snapshot.locations.filter(({ id }) => id !== "de2"),
    };
  });
  await city(page).locator(groupButton).click();
  await rendered(page);
  assert.equal(await page.locator("#locationDialog").evaluate((node) => node.open), true);
  assert.equal(
    await page.locator("#locationPreferenceError").textContent(),
    catalog.error_server_full.message,
  );
  assert.equal(await city(page).locator(disclosure).getAttribute("aria-expanded"), "true");
  assert.equal(await page.locator('button[data-focus-key="de2"]').count(), 0);
  assert.equal((await connectionRequests(page)).length, 1);
  record(
    "A full-server refusal preserves the open hierarchy and precise error, removes that server and never automatically selects another",
  );
  await page.evaluate(() =>
    window.fixture.publish({
      profile: { ...window.fixture.snapshot.profile, userId: "another-account" },
      error: null,
    }),
  );
  await rendered(page);
  assert.equal(await country(page).locator(disclosure).getAttribute("aria-expanded"), "false");
  record("An account change resets the local disclosure state");
  await page.close();

  page = await open();
  await selector(page);
  await country(page).locator(disclosure).click();
  await city(page, "Berlin").locator(".location-favorite").focus();
  await page.evaluate(() =>
    window.fixture.publish({
      locations: [
        ...window.fixture.snapshot.locations,
        {
          id: "berlin2",
          displayName: "Berlin2",
          city: "Berlin",
          countryCode: "DE",
          supportedProtocols: ["browser_proxy"],
        },
      ],
    }),
  );
  await rendered(page);
  assert.equal(
    await city(page, "Berlin").locator(disclosure).getAttribute("aria-expanded"),
    "false",
  );
  assert.equal(
    await city(page, "Berlin")
      .locator(groupButton)
      .evaluate((node) => document.activeElement === node),
    true,
  );
  record(
    "When a one-server city gains another server, keyboard focus moves to its visible city control instead of a favorite in the collapsed list",
  );
  await page.close();

  for (const type of ["select_location", "select_automatic_location"]) {
    page = await open();
    await page.evaluate((type) => {
      window.fixture.publish({
        status: "disconnected",
        protected: false,
        protectionRequested: false,
        activeLocationId: null,
      });
      window.fixture.heldType = type;
    }, type);
    await selector(page);
    if (type === "select_location") await country(page).locator(groupButton).click();
    else await page.locator("#automaticLocationButton").click();
    await page.waitForFunction(() => window.fixture.held !== null);
    await country(page, "FR").locator(groupButton).click();
    await page.locator("#locationDialog").waitFor({ state: "hidden" });
    await page.evaluate(() => window.fixture.held());
    await rendered(page);
    assert.deepEqual(
      (await connectionRequests(page)).map(({ type, locationId }) => ({
        type,
        ...(locationId ? { locationId } : {}),
      })),
      [
        { type, ...(type === "select_location" ? { locationId: "de2" } : {}) },
        { type: "select_location", locationId: "fr" },
      ],
    );
    assert.equal(await page.evaluate(() => window.fixture.snapshot.selectedLocationId), "fr");
    assert.equal(
      await page.evaluate(() => window.fixture.snapshot.locationPreferences.automatic),
      false,
    );
    assert.match(await page.locator("#locationName").textContent(), /Paris/);
    record(
      `${type}: returning to the initially selected country while a prior request is pending issues a new manual command; the late response cannot override it`,
    );
    await page.close();
  }

  for (const language of SUPPORTED_LANGUAGES) {
    const translated = JSON.parse(
      await readFile(
        join(extension, "_locales", localeDirectory(language), "messages.json"),
        "utf8",
      ),
    );
    page = await open();
    await page.evaluate(
      (language) =>
        window.fixture.publish({ languagePreference: language, effectiveLanguage: language }),
      language,
    );
    await page.waitForFunction((language) => document.documentElement.lang === language, language);
    await selector(page);
    await expand(page);
    assert.equal(
      await page.locator("#locationHierarchyHelp").textContent(),
      translated.locationHierarchyHelp.message,
    );
    const countryLabel = await country(page)
      .locator(`${groupButton} > .option-title`)
      .textContent();
    assert.equal(
      await country(page).locator(groupButton).getAttribute("aria-label"),
      translated.locationCountrySelect.message.replace("$1", countryLabel),
    );
    assert.equal(
      await country(page).locator(disclosure).getAttribute("aria-label"),
      translated.locationHideCities.message.replace("$1", countryLabel),
    );
    assert.equal(
      await city(page).locator(disclosure).getAttribute("aria-label"),
      translated.locationHideServers.message.replace("$1", "Frankfurt"),
    );
    const layout = await page.evaluate(() => {
      const dialog = document.getElementById("locationDialog");
      const row = document.querySelector(
        '.location-country-group[data-country-code="DE"] > .location-group-row',
      );
      const [select, expand] = [...row.children].map((node) => node.getBoundingClientRect());
      return {
        dir: document.documentElement.dir,
        overflow: dialog.scrollWidth - dialog.clientWidth,
        bodyOverflow: document.documentElement.scrollWidth - innerWidth,
        selectX: select.x,
        expandX: expand.x,
        expandWidth: expand.width,
        expandHeight: expand.height,
      };
    });
    const rtl = ["ar", "fa", "ur"].includes(language);
    assert.equal(layout.dir, rtl ? "rtl" : "ltr");
    assert.ok(
      layout.overflow <= 1 && layout.bodyOverflow <= 1,
      JSON.stringify({ language, layout }),
    );
    assert.ok(
      layout.expandWidth >= 44 && layout.expandHeight >= 44,
      JSON.stringify({ language, layout }),
    );
    assert.equal(layout.expandX < layout.selectX, rtl);
    if (["fr", "ar", "fa", "ur"].includes(language)) {
      await page.locator('button[data-focus-key="de2"]').scrollIntoViewIfNeeded();
      await page.screenshot({
        path: join(output, `hierarchy-${language}.png`),
        animations: "disabled",
      });
    }
    record(
      `${language}: translated hierarchy, server counts and accessible split controls fit 360×600 with the correct reading direction`,
    );
    await page.close();
  }
  assert.deepEqual(report.pageErrors, []);
  report.completed = true;
} catch (error) {
  report.failure = String(error.stack ?? error);
  process.exitCode = 1;
} finally {
  await browser.close();
  await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2) + "\n");
  process.stdout.write(JSON.stringify(report, null, 2));
}
