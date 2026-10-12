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
  process.env.CAPACITY_UI_OUTPUT || (await mkdtemp(join(tmpdir(), "fuzevpn-capacity-ui-"))),
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
  locationsStatus: "ready",
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
      applyFavorites: false,
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
const otherLocation = {
  id: "de",
  displayName: "Berlin",
  city: "Berlin",
  countryCode: "DE",
  supportedProtocols: ["browser_proxy"],
};
function record(name) {
  report.checks.push({ name, passed: true });
}
async function refreshed(page) {
  await page.waitForFunction(
    () => document.getElementById("refreshLocationsButton").getAttribute("aria-busy") === "false",
  );
  await rendered(page);
}
try {
  let page = await open();
  await page.locator("#changeLocationButton").click();
  await refreshed(page);
  assert.deepEqual(
    await page.evaluate(() =>
      window.fixture.commands.filter((type) => type === "refresh_locations"),
    ),
    ["refresh_locations"],
  );
  assert.equal(
    await page.evaluate(
      () => window.fixture.commands.filter((type) => type === "refresh_account").length,
    ),
    1,
  );
  assert.equal(
    await page.locator("#locationSearch").evaluate((node) => document.activeElement === node),
    true,
  );
  record(
    "Opening the selector requests one lightweight refresh and retains search focus without an additional account refresh",
  );
  await page.locator("#locationSearch").fill("Paris");
  await page.evaluate(() => {
    window.fixture.heldType = "refresh_locations";
  });
  await page.locator("#refreshLocationsButton").click();
  assert.equal(await page.locator("#refreshLocationsButton").isDisabled(), true);
  await page.locator("#locationSearch").focus();
  await page.evaluate(() => window.fixture.held());
  await refreshed(page);
  assert.equal(await page.locator("#locationSearch").inputValue(), "Paris");
  assert.equal(
    await page.locator("#locationSearch").evaluate((node) => document.activeElement === node),
    true,
  );
  record(
    "An in-flight refresh disables repeated activation and preserves search and keyboard focus",
  );
  await page.evaluate(() => {
    window.fixture.commandResults.refresh_locations = { ok: false, commandError: "network_error" };
    window.fixture.publish({ error: "server_full" });
  });
  await page.locator("#refreshLocationsButton").click();
  await refreshed(page);
  assert.equal(
    await page.locator("#locationLoadStatus").textContent(),
    catalog.locationsRefreshError.message,
  );
  assert.equal(
    await page.locator("#locationPreferenceError").textContent(),
    catalog.error_server_full.message,
  );
  assert.equal(await page.locator("#locationList button.location-option").count(), 1);
  assert.equal(await page.locator("#locationSearch").inputValue(), "Paris");
  record(
    "A failed refresh preserves other locations and the original capacity refusal inside the selector",
  );
  await page.close();

  for (const code of ["server_full", "capacity_unavailable"]) {
    page = await open();
    await page.evaluate(
      ({ otherLocation, code }) => {
        const f = window.fixture;
        const activeLocation = f.snapshot.locations[0];
        f.publish({ locations: [activeLocation, otherLocation], activeLocation });
        f.commandResults.change_location = { ok: false, commandError: code };
        f.responsePatches.change_location = {
          error: code,
          locations: code === "server_full" ? [] : [activeLocation],
          selectedLocationId: otherLocation.id,
        };
      },
      { otherLocation, code },
    );
    await page.locator("#changeLocationButton").click();
    await refreshed(page);
    await page.locator("#locationSearch").fill("Berlin");
    await page.locator('button.location-option[data-focus-key="de"]').click();
    await rendered(page);
    assert.equal(await page.locator("#locationDialog").evaluate((node) => node.open), true);
    assert.equal(
      await page.locator("#locationPreferenceError").textContent(),
      catalog[`error_${code}`].message,
    );
    assert.match(await page.locator("#locationName").textContent(), /Paris/);
    assert.equal(await page.locator('button.location-option[data-focus-key="de"]').count(), 0);
    assert.equal(
      await page.evaluate(
        () =>
          window.fixture.commands.filter((type) => ["change_location", "connect"].includes(type))
            .length,
      ),
      1,
    );
    record(
      `${code} keeps the selector open with precise feedback, preserves the active location label and does not initiate another connection`,
    );
    if (code === "server_full") {
      await page.evaluate((otherLocation) => {
        const f = window.fixture;
        f.publish({ locations: [f.snapshot.activeLocation, otherLocation] });
        f.commandResults.change_location = { ok: true };
        f.responsePatches.change_location = {
          error: null,
          activeLocationId: otherLocation.id,
          activeLocation: otherLocation,
        };
      }, otherLocation);
      await rendered(page);
      await page.locator('button.location-option[data-focus-key="de"]').click();
      await page.locator("#locationDialog").waitFor({ state: "hidden" });
      assert.equal(
        await page.evaluate(
          () => window.fixture.commands.filter((type) => type === "change_location").length,
        ),
        2,
      );
      record(
        "Selecting the previously full target after it reappears explicitly retries the change even when its manual selection was preserved",
      );
    }
    await page.close();
  }

  page = await open();
  await page.evaluate(() =>
    window.fixture.publish({
      status: "disconnected",
      protected: false,
      protectionRequested: false,
      activeLocationId: null,
      locations: [],
      selectedLocationId: "fr",
      locationPreferences: {
        ...window.fixture.snapshot.locationPreferences,
        unavailableFavoriteIds: ["fr"],
        recommendedLocationId: null,
      },
    }),
  );
  await rendered(page);
  assert.equal(await page.locator("#protectButton").isDisabled(), true);
  assert.equal(await page.locator("#changeLocationButton").isDisabled(), false);
  await page.locator("#changeLocationButton").click();
  await refreshed(page);
  assert.equal(
    await page.locator("#locationEmpty").textContent(),
    catalog.noAvailableLocations.message,
  );
  await page.locator("#favoriteLocationsFilter").click();
  assert.equal(
    await page.locator("#locationEmpty").textContent(),
    catalog.noAvailableFavoriteLocations.message,
  );
  assert.equal(await page.locator("#locationList button.location-option").count(), 0);
  assert.equal(await page.locator("#locationList .location-unavailable-favorite").count(), 1);
  assert.equal(
    await page
      .locator('.location-favorite[data-focus-key="favorite:fr"]')
      .getAttribute("aria-label"),
    catalog.removeFavorite.message.replace(
      "$1",
      catalog.unavailableFavoriteLocation.message.replace("$1", "1"),
    ),
  );
  assert.deepEqual(
    await page.evaluate(() => window.fixture.snapshot.locationPreferences.unavailableFavoriteIds),
    ["fr"],
  );
  await page.evaluate((location) => {
    window.fixture.responsePatches.refresh_locations = {
      locations: [location],
      locationPreferences: {
        ...window.fixture.snapshot.locationPreferences,
        favoriteIds: ["fr"],
        unavailableFavoriteIds: [],
        recommendedLocationId: "fr",
      },
    };
  }, connected.locations[0]);
  await page.locator("#refreshLocationsButton").click();
  await refreshed(page);
  assert.equal(await page.locator("#favoriteLocationsFilter").getAttribute("aria-pressed"), "true");
  assert.equal(
    await page
      .locator('.location-favorite[data-focus-key="favorite:fr"]')
      .getAttribute("aria-pressed"),
    "true",
  );
  assert.equal(await page.locator("#protectButton").isDisabled(), false);
  record(
    "An empty catalog keeps the selector available and protection disabled; unavailable favorites offer explicit removal and return starred unless removed, preserving the chosen filter and manual selection",
  );
  await page.locator("#locationSearch").fill("not-a-location");
  assert.equal(
    await page.locator("#locationEmpty").textContent(),
    catalog.noMatchingLocations.message,
  );
  record("A search with no matches is distinct from an empty catalog and unavailable favorites");
  await page.close();

  page = await open();
  await page.evaluate(() => {
    window.fixture.applyFavorites = true;
    window.fixture.publish({
      status: "disconnected",
      protected: false,
      protectionRequested: false,
      activeLocationId: null,
      locations: [],
      locationPreferences: {
        ...window.fixture.snapshot.locationPreferences,
        unavailableFavoriteIds: ["fr"],
        recommendedLocationId: null,
      },
    });
  });
  await page.locator("#changeLocationButton").click();
  await refreshed(page);
  await page.locator("#favoriteLocationsFilter").click();
  await page.locator('.location-favorite[data-focus-key="favorite:fr"]').click();
  await page.waitForFunction(
    () => window.fixture.snapshot.locationPreferences.unavailableFavoriteIds.length === 0,
  );
  assert.deepEqual(
    await page.evaluate(() =>
      window.fixture.requests.filter((request) => request.type === "set_location_favorite"),
    ),
    [{ type: "set_location_favorite", locationId: "fr", favorite: false }],
  );
  assert.equal(await page.locator("#locationList .location-unavailable-favorite").count(), 0);
  assert.equal(await page.locator("#locationList button.location-option").count(), 0);
  assert.equal(await page.locator("#protectButton").isDisabled(), true);
  assert.equal(await page.locator("#favoriteLocationsFilter").getAttribute("aria-pressed"), "true");
  record(
    "A favorite can be explicitly removed with an empty catalog while protection remains disabled",
  );
  await page.close();

  page = await open();
  await page.evaluate(() =>
    window.fixture.publish({
      status: "blocked",
      error: "server_full",
      protected: false,
      protectionRequested: true,
      trafficBlocked: true,
      blockingScope: "all",
      activeLocationId: null,
      locations: [],
      locationPreferences: {
        ...window.fixture.snapshot.locationPreferences,
        recommendedLocationId: null,
      },
    }),
  );
  await rendered(page);
  assert.equal(await page.locator("#recoveryPanel").isVisible(), true);
  assert.equal(await page.locator("#changeLocationButton").isVisible(), true);
  assert.equal(await page.locator("#changeLocationButton").isDisabled(), false);
  await page.locator("#changeLocationButton").click();
  await refreshed(page);
  assert.equal(
    await page.locator("#locationEmpty").textContent(),
    catalog.noAvailableLocations.message,
  );
  assert.equal(
    await page.locator("#locationPreferenceError").textContent(),
    catalog.error_server_full.message,
  );
  record(
    "When the last server fills up and the kill switch blocks traffic, the empty selector remains visible and usable from recovery",
  );
  await page.close();

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
        window.fixture.publish({
          languagePreference: language,
          effectiveLanguage: language,
          error: "server_full",
          activeLocation: window.fixture.snapshot.locations[0],
          locations: [],
        }),
      language,
    );
    await page.waitForFunction((language) => document.documentElement.lang === language, language);
    await page.locator("#changeLocationButton").click();
    await refreshed(page);
    for (const code of ["server_full", "capacity_unavailable"]) {
      await page.evaluate((error) => window.fixture.publish({ error }), code);
      await rendered(page);
      assert.equal(
        await page.locator("#locationPreferenceError").textContent(),
        translated[`error_${code}`].message,
      );
    }
    assert.equal(
      await page.locator("#locationEmpty").textContent(),
      translated.noAvailableLocations.message,
    );
    assert.equal(
      await page.locator("#refreshLocationsButton").getAttribute("aria-label"),
      translated.refreshLocations.message,
    );
    const layout = await page.evaluate(() => {
      const dialog = document.getElementById("locationDialog");
      const refresh = document.getElementById("refreshLocationsButton").getBoundingClientRect();
      const close = document.getElementById("closeLocationButton").getBoundingClientRect();
      return {
        dir: document.documentElement.dir,
        overflow: dialog.scrollWidth - dialog.clientWidth,
        bodyOverflow: document.documentElement.scrollWidth - innerWidth,
        refreshWidth: refresh.width,
        controlsOverlap: refresh.left < close.right && close.left < refresh.right,
      };
    });
    assert.equal(layout.dir, ["ar", "fa", "ur"].includes(language) ? "rtl" : "ltr");
    assert.ok(layout.overflow <= 1, JSON.stringify({ language, layout }));
    assert.ok(layout.bodyOverflow <= 1, JSON.stringify({ language, layout }));
    assert.ok(layout.refreshWidth >= 30, JSON.stringify({ language, layout }));
    assert.equal(layout.controlsOverlap, false);
    if (["fr", "ar", "fa", "ur"].includes(language))
      await page.screenshot({
        path: join(output, `capacity-${language}.png`),
        animations: "disabled",
      });
    record(
      `${language}: both capacity messages, empty state and refresh control are translated and fit the selector in the expected writing direction`,
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
