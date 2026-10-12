// SPDX-License-Identifier: MPL-2.0

// Popup regression checks with an isolated browser and synthetic runtime.
// No production connection, no real Chrome profile. Mock runtime and local dist assets only.
import assert from "node:assert/strict";
import { readFile, writeFile, mkdir, mkdtemp } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { resolve, join, extname, relative } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { SUPPORTED_LANGUAGES, localeDirectory } from "../../../scripts/supported-locales.mjs";
import {
  inspectDesign,
  inspectKeyboardFocus,
  inspectReducedMotion,
} from "./browser-design-review.mjs";
const root = resolve(import.meta.dirname, "../../..");
const output = resolve(
  process.env.POPUP_AUDIT_FIXES_OUTPUT ||
    (await mkdtemp(join(tmpdir(), "fuzevpn-popup-audit-fixes-"))),
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
  webLoginPending: false,
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
          if (
            typeof window.favoriteBackend === "function" &&
            ["get_snapshot", "set_location_favorite"].includes(request.type)
          ) {
            const { locationPreferences, ...result } = await window.favoriteBackend(request);
            f.snapshot.locationPreferences = locationPreferences;
            f.snapshot.snapshotVersion.revision += 1;
            return { ...result, snapshot: structuredClone(f.snapshot) };
          }
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
          if (request.type === "web_login") f.publish({ webLoginPending: true });
          Object.assign(f.snapshot, f.responsePatches[request.type] ?? {});
          f.snapshot.snapshotVersion.revision += 1;
          const response = {
            ok: true,
            ...f.commandResults[request.type],
            snapshot: structuredClone(f.snapshot),
          };
          if (request.type === "web_login") response.snapshot.webLoginPending = false;
          if (f.heldType === request.type) {
            f.heldType = null;
            return new Promise((resolve) => {
              f.held = () => {
                if (
                  request.type === "web_login" &&
                  f.snapshot.snapshotVersion.revision === response.snapshot.snapshotVersion.revision
                )
                  f.snapshot.webLoginPending = false;
                resolve(response);
              };
            });
          }
          if (request.type === "web_login") f.snapshot.webLoginPending = false;
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
async function open(beforeLoad = async () => {}) {
  const page = await context.newPage();
  page.on("pageerror", (error) => report.pageErrors.push(error.message));
  await beforeLoad(page);
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
async function status(page) {
  return page.evaluate(() => ({
    status: document.getElementById("statusLabel").textContent,
    orb: document.getElementById("statusOrb").className,
    recoveryVisible: !document.getElementById("recoveryPanel").classList.contains("hidden"),
    errorVisible: !document.getElementById("errorBanner").classList.contains("hidden"),
    error: document.getElementById("errorMessage").textContent,
    commands: window.fixture.commands,
  }));
}
async function reviewPopupDesign() {
  const design = { screenshots: [], measurements: [] };
  report.design = design;
  const location = (id, city, countryCode) => ({
    id,
    displayName: city,
    city,
    countryCode,
    supportedProtocols: ["browser_proxy"],
  });
  const locations = [
    location("fr", "Paris", "FR"),
    location("de", "Frankfurt", "DE"),
    location("de2", "Frankfurt 2", "DE"),
    location("us", "New York", "US"),
  ];
  for (const language of ["fr", "en", "de", "ar"]) {
    const page = await open();
    await page.evaluate(
      ({ language, locations }) =>
        window.fixture.publish({
          languagePreference: language,
          effectiveLanguage: language,
          locations,
          devices: [
            {
              deviceId: "design-browser",
              name: "FuzeVPN · Desktop",
              kind: "browser",
              createdAt: "2026-09-30T12:00:00Z",
              profiles: [],
            },
            {
              deviceId: "design-phone",
              name: "FuzeVPN · Mobile",
              kind: "vpn",
              createdAt: "2026-09-29T12:00:00Z",
              profiles: [],
            },
          ],
          currentDeviceId: "design-browser",
          locationPreferences: {
            favoriteIds: ["fr"],
            unavailableFavoriteIds: ["unavailable-fixture"],
            recentIds: ["de", "fr"],
            automatic: false,
            recommendedLocationId: "fr",
          },
        }),
      { language, locations },
    );
    await page.waitForFunction((language) => document.documentElement.lang === language, language);
    const capture = async (state, selectors) => {
      await rendered(page);
      await page.evaluate(() => document.fonts.ready);
      const measurement = await inspectDesign(page, selectors);
      assert.equal(measurement.direction, language === "ar" ? "rtl" : "ltr");
      design.measurements.push({ language, state, ...measurement });
      const name = `design-${language}-${state}.png`;
      await page.screenshot({ path: join(output, name), fullPage: true, animations: "disabled" });
      design.screenshots.push(name);
    };
    const main = {
      text: [
        "#statusLabel",
        "#statusDetail",
        "#mainView .card-label",
        "#mainView .card-value",
        "#publicIp",
        "#subscriptionExpiry",
        ".privacy-note",
        "#protectButton",
        "#changeLocationButton",
      ],
      controls: ["#settingsButton", "#changeLocationButton", "#refreshSubscriptionButton"],
      primary: ["#protectButton"],
      inView: ["fr", "en"].includes(language) ? ["#protectButton"] : [],
    };
    await capture("connected", main);
    await page.evaluate(() =>
      window.fixture.publish({
        status: "disconnected",
        protected: false,
        activeLocationId: null,
        protectionRequested: false,
        network: { ...window.fixture.snapshot.network, mode: "direct", locationId: null },
      }),
    );
    await capture("disconnected", main);
    await page.evaluate(() =>
      window.fixture.publish({
        status: "blocked",
        protectionRequested: true,
        trafficBlocked: true,
        blockingScope: "all",
        error: "network_error",
        nextRetryAt: Date.now() + 60_000,
      }),
    );
    await capture("recovery", {
      text: ["#recoveryPanel p", "#errorMessage", "#retryButton", "#recoveryDisconnectButton"],
      primary: ["#retryButton", "#recoveryDisconnectButton"],
    });
    await page.evaluate(() =>
      window.fixture.publish({
        status: "connected",
        protected: true,
        activeLocationId: "fr",
        protectionRequested: true,
        trafficBlocked: false,
        blockingScope: "none",
        error: null,
        nextRetryAt: null,
        network: { ...window.fixture.snapshot.network, mode: "vpn", locationId: "fr" },
      }),
    );
    await page.locator("#settingsButton").click();
    await page.locator("#languageSelect").focus();
    await page.keyboard.press("Tab");
    design.measurements.push({
      language,
      state: "settings-keyboard-focus",
      focus: await inspectKeyboardFocus(page),
    });
    await capture("settings", {
      text: [
        "#settingsTitle",
        "#settingsPanel .settings-section-title",
        "#settingsPanel .muted",
        "#settingsPanel .setting-label span",
      ],
      controls: ["#closeSettingsButton", "#killSwitchEnabled", "#webRtcProtectionEnabled"],
    });
    await page.locator("#manageDevicesButton").click();
    await page.locator("#devicesDialog").waitFor({ state: "visible" });
    await capture("devices", {
      text: [
        "#devicesTitle",
        ".device-name",
        ".device-meta",
        ".device-current",
        ".delete-device-button",
      ],
      controls: ["#closeDevicesButton", "#refreshDevicesButton", ".delete-device-button"],
    });
    await page.locator("#closeDevicesButton").click();
    await page.locator("#manageExclusionsButton").click();
    await page.locator("#exclusionsDialog").waitFor({ state: "visible" });
    await capture("exclusions", {
      text: [
        "#exclusionsDialog h2",
        "#exclusionsDialog .muted",
        ".exclusion-help",
        ".exclusion-state",
      ],
      controls: ["#closeExclusionsButton", "#exclusionInput", ".exclusion-subdomains"],
    });
    await page.keyboard.press("Escape");
    await page.locator("#closeSettingsButton").click();
    await page.locator("#changeLocationButton").click();
    await page.locator("#locationSearch").waitFor({ state: "visible" });
    const selector = {
      text: [
        "#locationDialogTitle",
        ".option-title",
        ".option-country",
        "#locationHierarchyHelp",
        ".location-filters button",
      ],
      controls: [
        "#closeLocationButton",
        "#refreshLocationsButton",
        ".location-disclosure",
        ".location-favorite",
      ],
    };
    await capture("locations", selector);
    await page.locator("#favoriteLocationsFilter").click();
    await capture("favorites", {
      ...selector,
      text: [...selector.text, ".location-unavailable-label"],
    });
    await page.locator("#allLocationsFilter").click();
    await page.locator("#locationSearch").fill("No matching destination");
    await capture("locations-search-empty", {
      ...selector,
      text: [...selector.text, "#locationEmpty"],
    });
    await page.locator("#locationSearch").fill("");
    await page.evaluate(() => window.fixture.publish({ locations: [] }));
    await capture("locations-catalog-empty", {
      ...selector,
      text: [...selector.text, "#locationEmpty"],
    });
    await page.locator("#closeLocationButton").click();
    design.reducedMotion = await inspectReducedMotion(page);
    await page.emulateMedia({ forcedColors: "active" });
    await page.locator("#settingsButton").click();
    const switchStyle = await page.locator("#killSwitchEnabled").evaluate((node) => ({
      appearance: getComputedStyle(node).appearance,
      decorativeThumb: getComputedStyle(node, "::before").display,
    }));
    assert.notEqual(switchStyle.appearance, "none");
    assert.equal(switchStyle.decorativeThumb, "none");
    await page.locator("#closeSettingsButton").click();
    await page.emulateMedia({ forcedColors: "none" });
    await page.evaluate(() =>
      window.fixture.publish({
        profile: null,
        subscription: null,
        status: "logged_out",
        protected: false,
        protectionRequested: false,
        webRtcProtected: false,
        activeLocationId: null,
        devices: [],
        error: null,
        logoutOutcome: null,
      }),
    );
    await page.locator("#loginView").waitFor({ state: "visible" });
    await capture("login", {
      text: ["#loginView h1", "#loginView .muted", "#webLoginHelp", "#loginButton", "#loginView a"],
      controls: ["#settingsButton"],
      primary: ["#loginButton"],
      inView: ["fr", "en"].includes(language) ? ["#loginButton"] : [],
    });
    report.checks.push({
      passed: true,
      name: `${language}: design captures cover every popup view with readable contrast, usable targets, no horizontal overflow, reduced motion and system color support`,
    });
    await page.close();
  }
}
try {
  let page = await open();
  await page.evaluate(() => {
    window.fixture.failTypes = ["refresh_network"];
    window.dispatchEvent(new Event("online"));
  });
  await rendered(page);
  const failedObservation = await status(page);
  assert.notEqual(failedObservation.orb, "status-orb connected");
  assert.equal(failedObservation.errorVisible, true);
  assert.equal(failedObservation.recoveryVisible, true);
  report.checks.push({
    id: "POP-01",
    passed: true,
    name: "A failed network refresh immediately removes the protection claim and shows communication recovery",
    actual: failedObservation,
  });
  await page.screenshot({
    animations: "disabled",
    path: join(output, "POP-01-silent-communication-failure.png"),
  });
  await page.evaluate(() => {
    window.fixture.failTypes = [];
    window.fixture.publish({});
  });
  await rendered(page);
  assert.equal((await status(page)).orb, "status-orb connected");
  assert.equal((await status(page)).errorVisible, false);
  report.checks.push({
    passed: true,
    name: "A valid broadcast restores verified protection after communication recovers",
  });
  await page.close();

  page = await open();
  await page.evaluate(() => {
    window.fixture.publish({
      status: "disconnected",
      protected: false,
      protectionRequested: false,
      activeLocationId: null,
      network: {
        ...window.fixture.snapshot.network,
        mode: "direct",
        locationId: null,
        ip: "198.51.100.42",
      },
    });
    window.fixture.failTypes = ["update_security_preferences", "refresh_account"];
  });
  await rendered(page);
  assert.match(await page.locator("#publicIp").textContent(), /198\.51\.100\.42/);
  await page.locator("#settingsButton").click();
  await page.locator("#killSwitchEnabled").click();
  await rendered(page);
  assert.equal(await page.locator("#recoveryStatus").textContent(), "Blocage non vérifié");
  await page.locator("#closeSettingsButton").click();
  await page.locator("#refreshSubscriptionButton").click();
  await page.waitForFunction(
    () =>
      document.getElementById("refreshSubscriptionButton").getAttribute("aria-busy") === "false",
  );
  await rendered(page);
  assert.equal(await page.locator("#publicIp").textContent(), "IP publique · Indisponible");
  assert.equal(await page.locator("#recoveryStatus").textContent(), "Blocage non vérifié");
  assert.equal((await status(page)).errorVisible, true);
  report.checks.push({
    passed: true,
    name: "Local rerenders after failed settings and account requests cannot restore an old direct IP or a verified recovery state",
  });
  await page.close();

  page = await open();
  await page.evaluate(() =>
    window.fixture.emit({ ...window.fixture.snapshot, status: "malformed" }),
  );
  await rendered(page);
  const malformed = await status(page);
  assert.equal(malformed.errorVisible, true);
  assert.notEqual(malformed.orb, "status-orb connected");
  assert.equal(malformed.recoveryVisible, true);
  report.checks.push({
    id: "POP-01-related",
    passed: true,
    name: "A malformed broadcast removes the stale green protection state and shows communication recovery",
    actual: malformed,
  });
  await page.screenshot({
    animations: "disabled",
    path: join(output, "POP-01-malformed-state-green.png"),
  });
  await page.close();

  page = await open();
  await page.evaluate(() => {
    window.fixture.heldType = "refresh_account";
  });
  await page.locator("#refreshSubscriptionButton").click();
  await page.waitForFunction(() => Boolean(window.fixture.held));
  await page.evaluate(() =>
    window.fixture.publish({
      status: "blocked",
      protected: false,
      trafficBlocked: true,
      blockingScope: "all",
      error: "proxy_unavailable",
    }),
  );
  await page.locator("#recoveryPanel").waitFor({ state: "visible" });
  const before = await status(page);
  await page.evaluate(() => window.fixture.held());
  await rendered(page);
  const after = await status(page);
  assert.equal(before.recoveryVisible, true);
  assert.equal(after.recoveryVisible, true);
  assert.notEqual(after.status, catalog.statusProtected.message);
  report.checks.push({
    id: "POP-02",
    passed: true,
    name: "A stale successful response cannot overwrite a newer blocked state",
    before,
    after,
  });
  await page.screenshot({
    animations: "disabled",
    path: join(output, "POP-02-stale-response.png"),
  });
  await page.close();

  page = await open();
  await page.locator("#settingsButton").click();
  await page.locator("#manageExclusionsButton").click();
  await page.locator("#exclusionInput").fill("example.com");
  await page.evaluate(() => {
    window.fixture.heldType = "update_site_exclusions";
  });
  await page.locator("#addExclusionButton").click();
  await page.waitForFunction(() => Boolean(window.fixture.held));
  await page.evaluate(() => window.fixture.publish({}));
  await rendered(page);
  await page.evaluate(() => window.fixture.held());
  await page.waitForFunction(() => !document.getElementById("exclusionInput").disabled);
  assert.equal(await page.locator("#exclusionsDialog").isVisible(), true);
  assert.equal(await page.locator("#exclusionInput").inputValue(), "example.com");
  report.checks.push({
    passed: true,
    name: "An obsolete successful exclusions response preserves the open dialog and its draft",
  });
  await page.close();

  page = await open();
  const payload = '<img src=x onerror="window.injected=true">';
  await page.evaluate(
    (payload) =>
      window.fixture.publish({
        locations: [
          {
            ...window.fixture.snapshot.locations[0],
            displayName: payload,
            countryCode: "<script>",
          },
        ],
        profile: { ...window.fixture.snapshot.profile, email: payload },
        devices: [
          {
            deviceId: "d",
            name: payload,
            kind: "vpn",
            createdAt: "2026-01-01T00:00:00Z",
            profiles: [],
          },
        ],
      }),
    payload,
  );
  await rendered(page);
  assert.match(await page.locator("#locationName").textContent(), /<img/);
  assert.equal(await page.locator("#locationName img").count(), 1);
  assert.equal(await page.evaluate(() => Boolean(window.injected)), false);
  report.checks.push({
    id: "PASS-DOM",
    passed: true,
    name: "Location, account and device text payloads remain inert text",
  });
  const colors = await page.evaluate(() => ({
    focus: getComputedStyle(document.getElementById("settingsButton")).outlineColor,
    country: getComputedStyle(document.querySelector(".option-country")).color,
  }));
  report.colors = colors;
  await page.locator("#settingsButton").focus();
  await page.keyboard.press("Tab");
  const focused = await inspectKeyboardFocus(page);
  report.keyboardFocus = focused;
  report.checks.push({
    passed: true,
    name: "Keyboard focus is visible, opaque and has at least 3:1 contrast",
  });
  await page.close();

  page = await open();
  await page.evaluate(() => {
    window.fixture.publish({ error: "proxy_creation_uncertain", status: "connected" });
    window.fixture.heldType = "retry_connection";
  });
  await page.locator("#retryUncertainConnectionButton").waitFor({ state: "visible" });
  assert.equal(await page.locator("#retryUncertainConnectionButton").isEnabled(), true);
  assert.equal(await page.locator("#statusLabel").textContent(), catalog.statusProtected.message);
  assert.equal(await page.locator("#recoveryPanel").isVisible(), false);
  await page.locator("#retryUncertainConnectionButton").click();
  await page.waitForFunction(() => Boolean(window.fixture.held));
  assert.equal(await page.locator("#retryUncertainConnectionButton").isDisabled(), true);
  await page.locator("#retryUncertainConnectionButton").dispatchEvent("click");
  assert.equal(
    await page.evaluate(
      () => window.fixture.commands.filter((type) => type === "retry_connection").length,
    ),
    1,
  );
  assert.equal(await page.locator("#statusLabel").textContent(), catalog.statusProtected.message);
  await page.evaluate(() => window.fixture.held());
  await page.waitForFunction(
    () => !document.getElementById("retryUncertainConnectionButton").disabled,
  );
  await page.evaluate(() => window.fixture.publish({ error: null }));
  await page.locator("#retryUncertainConnectionButton").waitFor({ state: "hidden" });
  report.checks.push({
    passed: true,
    name: "An uncertain renewal offers one guarded manual retry while preserving the previous protected connection",
  });
  await page.close();

  for (const limit of [1, 5, 12]) {
    page = await open();
    await page.evaluate((limit) => {
      window.fixture.publish({ deviceLimit: null });
      window.fixture.heldType = "refresh_devices";
      window.fixture.responsePatches.refresh_devices = { deviceLimit: limit };
    }, limit);
    await rendered(page);
    await page.locator("#settingsButton").click();
    await page.locator("#manageDevicesButton").click();
    await page.waitForFunction(() => Boolean(window.fixture.held));
    assert.equal(await page.locator("#deviceCount").textContent(), "Chargement du quota…");
    await page.evaluate(() => window.fixture.held());
    await page.waitForFunction(
      (limit) => document.getElementById("deviceCount").textContent === `0 / ${limit} appareils`,
      limit,
    );
    report.checks.push({
      passed: true,
      name: `Unknown device quota stays pending until the server returns limit ${limit}`,
    });
    await page.close();
  }

  const loggedOut = {
    webLoginPending: false,
    profile: null,
    status: "logged_out",
    protected: false,
    protectionRequested: false,
    activeLocationId: null,
    trafficBlocked: false,
    error: null,
    devices: [],
    deviceLimit: null,
  };

  page = await open();
  await page.evaluate((loggedOut) => {
    const f = window.fixture;
    const recovered = structuredClone(f.snapshot);
    delete recovered.snapshotVersion;
    f.publish({
      ...loggedOut,
      status: "blocked",
      error: "storage_unavailable",
      selectedLocationId: null,
      locations: [],
      protectionRequested: true,
      trafficBlocked: true,
      blockingScope: "all",
    });
    f.responsePatches.get_snapshot = recovered;
    f.heldType = "get_snapshot";
    f.commands = [];
  }, loggedOut);
  await page.locator("#recoveryPanel").waitFor({ state: "visible" });
  assert.equal(await page.locator("#retryButton").textContent(), catalog.retryConnection.message);
  await page.locator("#retryButton").click();
  await page.waitForFunction(() => Boolean(window.fixture.held));
  assert.equal(await page.locator("#retryButton").isDisabled(), true);
  assert.deepEqual(await page.evaluate(() => window.fixture.commands), ["get_snapshot"]);
  await page.evaluate(() => window.fixture.held());
  await page.locator("#mainView").waitFor({ state: "visible" });
  assert.equal(await page.locator("#recoveryPanel").isVisible(), false);
  assert.equal(await page.locator("#accountEmail").textContent(), connected.profile.email);
  assert.equal(await page.evaluate(() => window.fixture.commands.includes("web_login")), false);
  report.checks.push({
    passed: true,
    name: "Storage recovery rereads the snapshot once and restores the account without a new login",
  });
  await page.close();

  for (const failure of ["web_login_cancelled", "web_login_denied"]) {
    page = await open();
    await page.evaluate(
      ({ loggedOut, failure }) => {
        const f = window.fixture;
        f.publish(loggedOut);
        f.heldType = "web_login";
        f.commandResults.web_login = { ok: false, commandError: failure };
        f.responsePatches.web_login = { error: failure };
      },
      { loggedOut, failure },
    );
    await page.locator("#loginView").waitFor({ state: "visible" });
    assert.equal(await page.locator("#email, #password").count(), 0);
    await page.locator("#loginButton").click();
    await page.waitForFunction(() => Boolean(window.fixture.held));
    assert.equal(await page.locator("#loginButton").isDisabled(), true);
    assert.equal(await page.locator("#webLoginStatus").isVisible(), true);
    assert.equal(await page.locator("#loginForm").getAttribute("aria-busy"), "true");
    await page.locator("#loginButton").evaluate((button) => button.click());
    assert.equal(
      await page.evaluate(
        () => window.fixture.requests.filter((request) => request.type === "web_login").length,
      ),
      1,
    );
    assert.deepEqual(
      await page.evaluate(() =>
        window.fixture.requests.find((request) => request.type === "web_login"),
      ),
      { type: "web_login", disconnectFirst: false },
    );
    await page.evaluate(() => window.fixture.held());
    await page.waitForFunction(() => !document.getElementById("loginButton").disabled);
    assert.equal(await page.locator("#webLoginStatus").isVisible(), false);
    await page.locator("#loginErrorBanner").waitFor({ state: "visible" });
    assert.equal(
      await page.locator("#loginErrorMessage").textContent(),
      catalog[`error_${failure}`].message,
    );
    report.checks.push({
      passed: true,
      name: `${failure}: one web-auth request without credential inputs, visible pending status and actionable failure`,
    });
    await page.close();
  }

  page = await open();
  await page.evaluate((loggedOut) => {
    const f = window.fixture;
    const signedIn = structuredClone(f.snapshot);
    delete signedIn.snapshotVersion;
    Object.assign(signedIn, {
      status: "disconnected",
      protected: false,
      protectionRequested: false,
      activeLocationId: null,
    });
    f.publish(loggedOut);
    f.responsePatches.web_login = signedIn;
    f.heldType = "web_login";
  }, loggedOut);
  await page.locator("#loginView").waitFor({ state: "visible" });
  await page.locator("#loginButton").click();
  await page.waitForFunction(() => Boolean(window.fixture.held));
  await page.evaluate(() => window.fixture.held());
  await page.locator("#mainView").waitFor({ state: "visible" });
  assert.equal(await page.locator("#email, #password").count(), 0);
  assert.equal(await page.locator("#accountEmail").textContent(), connected.profile.email);
  assert.equal(await page.evaluate(() => window.fixture.commands.includes("connect")), false);
  report.checks.push({
    passed: true,
    name: "An authoritative web sign-in restores the account without hidden credential fields or implicit VPN connection",
  });
  await page.close();

  page = await open();
  await page.evaluate((loggedOut) => {
    const f = window.fixture;
    f.newAccount = structuredClone(f.snapshot);
    delete f.newAccount.snapshotVersion;
    f.newAccount.profile.userId = "new-account";
    f.publish(loggedOut);
    f.responsePatches.web_login = f.newAccount;
    f.heldType = "web_login";
  }, loggedOut);
  await page.locator("#loginView").waitFor({ state: "visible" });
  await page.locator("#loginButton").click();
  await page.waitForFunction(() => Boolean(window.fixture.held));
  await page.evaluate((loggedOut) => {
    window.fixture.publish(window.fixture.newAccount);
    window.fixture.publish(loggedOut);
  }, loggedOut);
  await page.locator("#loginView").waitFor({ state: "visible" });
  await page.evaluate(() => window.fixture.held());
  await page.waitForFunction(() => !document.getElementById("loginButton").disabled);
  assert.equal(await page.locator("#loginView").isVisible(), true);
  assert.equal(await page.locator("#mainView").isVisible(), false);
  assert.equal(await page.locator("#loginErrorBanner").isVisible(), false);
  report.checks.push({
    passed: true,
    name: "A stale successful web-auth reply cannot replace the logged-out view after a newer account transition",
  });
  await page.close();

  page = await open();
  await page.evaluate((loggedOut) => {
    const f = window.fixture;
    f.publish({ ...loggedOut, webLoginPending: true });
    f.commands = [];
  }, loggedOut);
  await page.locator("#loginView").waitFor({ state: "visible" });
  assert.equal(await page.locator("#loginButton").isDisabled(), true);
  assert.equal(await page.locator("#webLoginStatus").isVisible(), true);
  await page.locator("#loginButton").evaluate((button) => button.click());
  assert.equal(await page.evaluate(() => window.fixture.commands.includes("web_login")), false);
  await page.evaluate((loggedOut) => window.fixture.publish(loggedOut), loggedOut);
  await page.waitForFunction(() => !document.getElementById("loginButton").disabled);
  report.checks.push({
    passed: true,
    name: "A pending worker authentication disables a reopened popup and releases its control after completion",
  });
  await page.close();

  page = await open();
  await page.evaluate((loggedOut) => {
    const f = window.fixture;
    f.publish({
      ...loggedOut,
      status: "blocked",
      trafficBlocked: true,
      protectionRequested: true,
      blockingScope: "all",
    });
    f.commandResults.web_login = { ok: false, commandError: "web_login_cancelled" };
    f.responsePatches.web_login = {
      error: "web_login_cancelled",
      trafficBlocked: false,
      protectionRequested: false,
      blockingScope: "none",
    };
  }, loggedOut);
  await page.locator("#loginView").waitFor({ state: "visible" });
  assert.equal(
    await page.locator("#webLoginButtonLabel").textContent(),
    catalog.webSignInDisconnect.message,
  );
  assert.equal(
    await page.locator("#webLoginHelp").textContent(),
    catalog.webSignInDisconnectHelp.message,
  );
  await page.locator("#loginButton").click();
  await page.waitForFunction(() => !document.getElementById("loginButton").disabled);
  assert.deepEqual(
    await page.evaluate(() =>
      window.fixture.requests.find((request) => request.type === "web_login"),
    ),
    { type: "web_login", disconnectFirst: true },
  );
  report.checks.push({
    passed: true,
    name: "Guarded reconnection exposes an explicit disconnect warning and sends its authorization only after a user action",
  });
  await page.close();

  for (const outcome of [
    { apiSession: "pending", proxySessions: "pending" },
    { apiSession: "unconfirmed", proxySessions: "confirmed" },
    { apiSession: "confirmed", proxySessions: "unconfirmed" },
    { apiSession: "confirmed", proxySessions: "confirmed" },
  ]) {
    page = await open();
    await page.evaluate(
      ({ loggedOut, outcome }) => window.fixture.publish({ ...loggedOut, logoutOutcome: outcome }),
      { loggedOut, outcome },
    );
    await page.locator("#logoutResult").waitFor({ state: "visible" });
    const labels = {
      pending: catalog.logoutRevocationPending.message,
      confirmed: catalog.logoutRevocationConfirmed.message,
      unconfirmed: catalog.logoutRevocationUnconfirmed.message,
    };
    assert.equal(await page.locator("#logoutApiStatus").textContent(), labels[outcome.apiSession]);
    assert.equal(
      await page.locator("#logoutProxyStatus").textContent(),
      labels[outcome.proxySessions],
    );
    assert.equal(await page.locator("#mainView").isVisible(), false);
    assert.equal(await page.locator("#accountEmail").textContent(), "");
    assert.equal(
      await page.locator("#logoutUnconfirmedHelp").isVisible(),
      Object.values(outcome).includes("unconfirmed"),
    );
    report.checks.push({
      passed: true,
      name: `Local logout distinguishes account ${outcome.apiSession} and proxy ${outcome.proxySessions}`,
    });
    await page.close();
  }

  page = await open();
  await page.evaluate((loggedOut) => {
    window.fixture.newAccount = structuredClone(window.fixture.snapshot);
    window.fixture.publish({
      ...loggedOut,
      logoutOutcome: { apiSession: "unconfirmed", proxySessions: "unconfirmed" },
    });
  }, loggedOut);
  await page.locator("#logoutResult").waitFor({ state: "visible" });
  for (const locale of SUPPORTED_LANGUAGES) {
    await page.evaluate((locale) => {
      window.fixture.publish({ languagePreference: locale, effectiveLanguage: locale });
    }, locale);
    await page.waitForFunction((locale) => document.documentElement.lang === locale, locale);
    await rendered(page);
    const directory = localeDirectory(locale);
    const translated = JSON.parse(
      await readFile(join(extension, `_locales/${directory}/messages.json`), "utf8"),
    );
    assert.equal(
      await page.locator("#logoutApiStatus").textContent(),
      translated.logoutRevocationUnconfirmed.message,
    );
    assert.equal(
      await page.locator("#logoutProxyStatus").textContent(),
      translated.logoutRevocationUnconfirmed.message,
    );
    const overflow = await page.locator("#logoutResult").evaluate((node) => {
      const box = node.getBoundingClientRect();
      return node.scrollWidth > node.clientWidth + 1 || box.left < 0 || box.right > innerWidth;
    });
    assert.equal(overflow, false, `Logout result overflow in ${locale}`);
    await page.screenshot({
      path: join(output, `logout-unconfirmed-${directory}.png`),
      animations: "disabled",
    });
  }
  report.checks.push({
    passed: true,
    name: "Remote logout uncertainty is localized in thirty languages without horizontal overflow",
  });
  await page.evaluate(() => {
    const stale = structuredClone(window.fixture.snapshot);
    const revision = window.fixture.snapshot.snapshotVersion;
    window.fixture.publish({
      ...window.fixture.newAccount,
      snapshotVersion: revision,
      profile: { ...window.fixture.newAccount.profile, userId: "new-account" },
      logoutOutcome: null,
    });
    window.fixture.emit(stale);
  });
  await page.locator("#mainView").waitFor({ state: "visible" });
  assert.equal(await page.locator("#logoutResult").isVisible(), false);
  assert.equal(await page.locator("#logoutApiStatus").textContent(), "");
  assert.equal(await page.locator("#logoutProxyStatus").textContent(), "");
  report.checks.push({
    passed: true,
    name: "A late logout outcome cannot restore an old warning after a newer account snapshot",
  });
  await page.close();
  page = await open();
  page.on("dialog", (dialog) => dialog.accept());
  await page.evaluate(() =>
    window.fixture.publish({
      currentDeviceId: "current",
      devices: [
        {
          deviceId: "remote",
          name: "Other browser",
          kind: "browser_extension",
          profiles: [],
          createdAt: "2026-01-01T00:00:00Z",
        },
      ],
    }),
  );
  await page.locator("#settingsButton").click();
  await page.locator("#manageDevicesButton").click();
  await page.waitForFunction(() => !document.getElementById("refreshDevicesButton").disabled);
  await page.evaluate(() => {
    window.fixture.heldType = "delete_device";
    window.fixture.commandResults.delete_device = { ok: false, commandError: "not_found" };
    window.fixture.responsePatches.delete_device = { error: "not_found" };
  });
  await page.locator(".delete-device-button").click();
  await page.locator("#confirmationAcceptButton").click();
  await page.waitForFunction(() => Boolean(window.fixture.held));
  await page.evaluate(() => window.fixture.publish({}));
  await rendered(page);
  assert.equal(await page.locator(".delete-device-button").isDisabled(), true);
  await page.locator(".delete-device-button").dispatchEvent("click");
  assert.equal(
    await page.evaluate(
      () => window.fixture.commands.filter((type) => type === "delete_device").length,
    ),
    1,
  );
  await page.evaluate(() => window.fixture.held());
  await page.waitForFunction(() => !document.querySelector(".delete-device-button").disabled);
  assert.equal(await page.locator("#devicesDialog").isVisible(), true);
  assert.equal(await page.locator("#devicesError").textContent(), catalog.error_not_found.message);
  assert.equal(await page.locator("#resetDeviceButton").count(), 0);
  await page.evaluate(() => {
    window.fixture.failTypes = ["refresh_devices", "delete_device"];
  });
  await page.locator("#refreshDevicesButton").click();
  await page.waitForFunction(() => !document.getElementById("refreshDevicesButton").disabled);
  assert.equal(await page.locator("#devicesDialog").isVisible(), true);
  assert.equal(
    await page.locator("#devicesError").textContent(),
    catalog.extensionCommunicationError.message,
  );
  await page.locator(".delete-device-button").click();
  await page.locator("#confirmationAcceptButton").click();
  await page.waitForFunction(() => !document.querySelector(".delete-device-button").disabled);
  assert.equal(await page.locator("#devicesDialog").isVisible(), true);
  assert.equal(
    await page.locator("#devicesError").textContent(),
    catalog.extensionCommunicationError.message,
  );
  report.checks.push({
    passed: true,
    name: "Pending device deletion survives unrelated rerenders, rejects duplicate clicks, and displays business/transport failures inside the modal without inviting local identity reset",
  });
  await page.close();

  page = await open();
  await page.evaluate(() => {
    const f = window.fixture;
    f.publish({
      locations: [
        ...f.snapshot.locations,
        { ...f.snapshot.locations[0], id: "de", displayName: "Berlin", countryCode: "DE" },
      ],
    });
    f.commandResults.change_location = { ok: false, commandError: "proxy_unavailable" };
  });
  await page.locator("#changeLocationButton").click();
  await page.locator("#locationSearch").fill("Berlin");
  await page.locator('button.location-option[data-focus-key="de"]').click();
  await page.locator("#locationPreferenceError").waitFor({ state: "visible" });
  assert.equal(await page.locator("#locationDialog").isVisible(), true);
  assert.match(await page.locator("#locationName").textContent(), /Paris/);
  await page.evaluate(() => {
    window.fixture.commandResults.change_location = { ok: false, superseded: true };
  });
  await page.locator('button.location-option[data-focus-key="de"]').click();
  await rendered(page);
  assert.equal(await page.locator("#locationDialog").isVisible(), true);
  assert.equal(await page.locator("#locationPreferenceError").isVisible(), false);
  await page.evaluate(() => {
    window.fixture.commandResults.change_location = { ok: true };
    window.fixture.heldType = "change_location";
  });
  await page.locator('button.location-option[data-focus-key="de"]').click();
  await page.waitForFunction(() => Boolean(window.fixture.held));
  await page.evaluate(() => {
    window.fixture.publish({ error: "proxy_creation_uncertain" });
    window.fixture.held();
  });
  await page.locator("#locationDialog").waitFor({ state: "hidden" });
  assert.equal(
    await page.locator("#errorMessage").textContent(),
    catalog.error_proxy_creation_uncertain.message,
  );
  report.checks.push({
    passed: true,
    name: "Location failure keeps the modal and previous proxy, superseded commands have no UI effect, and a stale snapshot does not erase the command result or newer state",
  });
  await page.close();

  for (const automatic of [true, false]) {
    page = await open();
    await page.evaluate((automatic) => {
      const f = window.fixture;
      f.publish({
        locations: [
          ...f.snapshot.locations,
          { ...f.snapshot.locations[0], id: "de", displayName: "Berlin", countryCode: "DE" },
        ],
        locationPreferences: { ...f.snapshot.locationPreferences, automatic: !automatic },
      });
      const command = automatic ? "select_automatic_location" : "change_location";
      f.responsePatches[command] = {
        locationPreferences: { ...f.snapshot.locationPreferences, automatic },
      };
      f.commandResults[command] = { ok: false, commandError: "proxy_unavailable" };
    }, automatic);
    await page.locator("#changeLocationButton").click();
    if (!automatic) await page.locator("#locationSearch").fill("Berlin");
    await page
      .locator(
        automatic ? "#automaticLocationButton" : 'button.location-option[data-focus-key="de"]',
      )
      .click();
    await page.locator("#locationPreferenceError").waitFor({ state: "visible" });
    assert.equal(
      await page.locator("#locationPreferenceError").textContent(),
      catalog.error_proxy_unavailable.message,
    );
    assert.equal(await page.locator("#locationDialog").isVisible(), true);
    assert.equal(
      await page.locator("#automaticLocationButton").getAttribute("aria-pressed"),
      String(automatic),
    );
    assert.match(await page.locator("#locationName").textContent(), /Paris/);
    assert.equal(await page.evaluate(() => window.fixture.snapshot.activeLocationId), "fr");
    report.checks.push({
      passed: true,
      name: `An incomplete location change reports its exact refusal and preserves the confirmed automatic=${automatic} mode and active route`,
    });
    await page.close();
  }

  page = await open();
  await page.evaluate(() => {
    window.fixture.applyFavorites = true;
    window.fixture.heldType = "set_location_favorite";
  });
  await page.locator("#changeLocationButton").click();
  await page.locator("#locationSearch").fill("Paris");
  const pendingFavorite = page.locator('.location-favorite[data-focus-key="favorite:fr"]');
  await pendingFavorite.focus();
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => Boolean(window.fixture.held));
  assert.equal(await pendingFavorite.getAttribute("aria-disabled"), "true");
  assert.equal(await pendingFavorite.getAttribute("aria-busy"), "true");
  assert.equal(await page.evaluate(() => document.activeElement.dataset.focusKey), "favorite:fr");
  await page.keyboard.press("Enter");
  const favoriteBox = await pendingFavorite.boundingBox();
  await page.mouse.click(
    favoriteBox.x + favoriteBox.width / 2,
    favoriteBox.y + favoriteBox.height / 2,
  );
  assert.equal(
    await page.evaluate(
      () => window.fixture.commands.filter((type) => type === "set_location_favorite").length,
    ),
    1,
  );
  await page.evaluate(() => {
    window.fixture.publish({});
    window.fixture.held();
  });
  await page.waitForFunction(
    () =>
      document
        .querySelector('.location-favorite[data-focus-key="favorite:fr"]')
        .getAttribute("aria-busy") === "false",
  );
  assert.equal(await page.evaluate(() => document.activeElement.dataset.focusKey), "favorite:fr");
  assert.equal(await pendingFavorite.getAttribute("aria-pressed"), "true");
  report.checks.push({
    passed: true,
    name: "A pending favorite retains keyboard focus across updates and blocks repeated keyboard or pointer activation until its own result arrives",
  });
  await page.close();

  page = await open();
  await page.evaluate(() => {
    window.fixture.applyFavorites = true;
    window.fixture.publish({
      locationPreferences: {
        ...window.fixture.snapshot.locationPreferences,
        unavailableFavoriteIds: ["retired-location"],
      },
    });
  });
  await page.locator("#changeLocationButton").click();
  await page.locator("#favoriteLocationsFilter").click();
  assert.doesNotMatch(await page.locator("#locationList").textContent(), /retired-location/);
  assert.equal(await page.locator("#locationList button.location-option").count(), 0);
  await page.locator("#locationEmpty").waitFor({ state: "visible" });
  assert.equal(
    await page.locator("#locationEmpty").textContent(),
    catalog.noAvailableFavoriteLocations.message,
  );
  assert.deepEqual(
    await page.evaluate(() => window.fixture.snapshot.locationPreferences.unavailableFavoriteIds),
    ["retired-location"],
  );
  const unavailableFavorite = page.locator(
    '.location-unavailable-favorite .location-favorite[data-focus-key="favorite:retired-location"]',
  );
  assert.equal(await unavailableFavorite.count(), 1);
  assert.equal(
    await unavailableFavorite.getAttribute("aria-label"),
    catalog.removeFavorite.message.replace(
      "$1",
      catalog.unavailableFavoriteLocation.message.replace("$1", "1"),
    ),
  );
  await page.locator("#locationSearch").fill("No matching location");
  assert.equal(await page.locator(".location-unavailable-favorite").count(), 0);
  await page.locator("#locationSearch").fill("");
  await unavailableFavorite.focus();
  await page.keyboard.press("Enter");
  await page.waitForFunction(
    () => !window.fixture.snapshot.locationPreferences.unavailableFavoriteIds.length,
  );
  assert.equal(await page.locator(".location-unavailable-favorite").count(), 0);
  assert.equal(await page.evaluate(() => document.activeElement.id), "favoriteLocationsFilter");
  report.checks.push({
    passed: true,
    name: "Unavailable favorites retain their saved identifiers until explicit keyboard removal, with translated labels and focus recovery",
  });
  await page.close();

  // Use the production preference class for the quota and durable-storage contract.
  const locationPreferencesModule = ts.transpileModule(
    await readFile(join(root, "src/core/background/location-preferences.ts"), "utf8"),
    {
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    },
  ).outputText;
  const { LocationPreferences } = await import(
    `data:text/javascript;base64,${Buffer.from(locationPreferencesModule).toString("base64")}`
  );
  let storedFavorites = {
    favoriteIds: Array.from({ length: 100 }, (_, index) => `retired-${index}`),
    recentIds: [],
    automatic: false,
  };
  const favoriteWrites = [];
  const favoriteFailures = [];
  const favoriteStorage = {
    read: async () => structuredClone(storedFavorites),
    write: async (value) => {
      storedFavorites = structuredClone(value);
      favoriteWrites.push(structuredClone(value));
    },
  };
  const openWithSavedFavorites = async () => {
    const preferences = new LocationPreferences({
      storage: favoriteStorage,
      onChanged() {},
    });
    await preferences.initialize();
    return open(async (page) => {
      await page.exposeFunction("favoriteBackend", async (request) => {
        let result = { ok: true };
        if (request.type === "set_location_favorite") {
          try {
            await preferences.setFavorite(request.locationId, request.favorite);
          } catch (error) {
            favoriteFailures.push(error.message);
            // The worker maps the preference class's ordinary Error to unknown_error.
            result = { ok: false, commandError: "unknown_error" };
          }
        }
        return { ...result, locationPreferences: preferences.getState(connected.locations) };
      });
    });
  };
  page = await openWithSavedFavorites();
  await page.locator("#changeLocationButton").click();
  await page.locator("#locationSearch").fill("Paris");
  const availableFavorite = page.locator('.location-favorite[data-focus-key="favorite:fr"]');
  await availableFavorite.click();
  await page.locator("#locationPreferenceError").waitFor({ state: "visible" });
  assert.equal(
    await page.locator("#locationPreferenceError").textContent(),
    catalog.error_unknown_error.message,
  );
  assert.deepEqual(favoriteFailures, ["location_favorites_limit"]);
  assert.equal(favoriteWrites.length, 0);
  await page.locator("#locationSearch").fill("");
  await page.locator("#favoriteLocationsFilter").click();
  assert.equal(await page.locator(".location-unavailable-favorite").count(), 100);
  assert.doesNotMatch(await page.locator("#locationList").textContent(), /retired-/);
  await page.screenshot({
    animations: "disabled",
    path: join(output, "popup-unavailable-favorites-quota.png"),
  });
  await page
    .locator(
      '.location-unavailable-favorite .location-favorite[data-focus-key="favorite:retired-0"]',
    )
    .click();
  await page.waitForFunction(
    () => window.fixture.snapshot.locationPreferences.unavailableFavoriteIds.length === 99,
  );
  assert.equal(storedFavorites.favoriteIds.includes("retired-0"), false);
  assert.equal(storedFavorites.favoriteIds.length, 99);
  await page.locator("#allLocationsFilter").click();
  await page.locator("#locationSearch").fill("Paris");
  await availableFavorite.click();
  await page.waitForFunction(() =>
    window.fixture.snapshot.locationPreferences.favoriteIds.includes("fr"),
  );
  assert.equal(await availableFavorite.getAttribute("aria-pressed"), "true");
  assert.equal(await page.locator("#locationPreferenceError").isVisible(), false);
  assert.equal(storedFavorites.favoriteIds.length, 100);
  assert.equal(favoriteWrites.length, 2);
  await page.close();
  page = await openWithSavedFavorites();
  await page.locator("#changeLocationButton").click();
  await page.locator("#favoriteLocationsFilter").click();
  assert.equal(await page.locator(".location-unavailable-favorite").count(), 99);
  assert.equal(
    await page.locator('.location-favorite[data-focus-key="favorite:retired-0"]').count(),
    0,
  );
  assert.equal(
    await page
      .locator('.location-favorite[data-focus-key="favorite:fr"]')
      .getAttribute("aria-pressed"),
    "true",
  );
  assert.equal(favoriteWrites.length, 2);
  report.checks.push({
    passed: true,
    name: "Removing one of 100 unavailable favorites through the popup frees the production quota; the available favorite and 99 remaining unavailable favorites persist after reopening",
  });
  await page.close();

  page = await open();
  await page.evaluate(() => {
    window.fixture.applyExclusions = true;
    window.fixture.failTypes = ["update_site_exclusions"];
  });
  await page.locator("#settingsButton").click();
  await page.locator("#manageExclusionsButton").click();
  await page.locator("#exclusionInput").fill("example.com");
  await page.locator("#addExclusionButton").click();
  await page.locator("#exclusionsError").waitFor({ state: "visible" });
  assert.equal(await page.locator("#exclusionInput").inputValue(), "example.com");
  await page.evaluate(() => {
    window.fixture.failTypes = [];
  });
  await page.locator("#retryExclusionsButton").click();
  await page.waitForFunction(
    () =>
      document.getElementById("exclusionInput").value === "" &&
      !document.getElementById("exclusionInput").disabled,
  );
  assert.equal(await page.locator(".exclusion-domain").textContent(), "example.com");
  assert.deepEqual(
    await page.evaluate(() =>
      window.fixture.requests.filter((request) => request.type === "update_site_exclusions"),
    ),
    [
      {
        type: "update_site_exclusions",
        expectedRevision: 0,
        enabled: true,
        entries: [{ domain: "example.com", includeSubdomains: true }],
      },
      {
        type: "update_site_exclusions",
        expectedRevision: 0,
        enabled: true,
        entries: [{ domain: "example.com", includeSubdomains: true }],
      },
    ],
  );
  await page.evaluate(() => {
    window.fixture.failTypes = ["update_site_exclusions"];
  });
  await page.locator(".exclusion-remove").click();
  await page.locator("#exclusionsError").waitFor({ state: "visible" });
  await page.evaluate(() => {
    window.fixture.failTypes = [];
  });
  await page.locator("#retryExclusionsButton").click();
  await page.locator("#exclusionsEmpty").waitFor({ state: "visible" });
  assert.equal(await page.locator("#exclusionsError").isVisible(), false);
  report.checks.push({
    passed: true,
    name: "Retry rechecks durable state then reapplies the exact add or remove intent lost before worker receipt",
  });
  await page.close();

  page = await open();
  await page.evaluate(() => {
    window.fixture.publish({
      error: "email_verification_required",
      status: "disconnected",
      protected: false,
      protectionRequested: false,
      activeLocationId: null,
    });
    window.fixture.heldType = "resend_verification";
    window.fixture.responsePatches.resend_verification = { error: null };
  });
  await page.locator("#resendButton").click();
  await page.waitForFunction(() => Boolean(window.fixture.held));
  assert.equal(await page.locator("#resendButton").isDisabled(), true);
  assert.equal(
    await page.locator("#verificationStatus").textContent(),
    catalog.verificationSending.message,
  );
  await page.locator("#resendButton").dispatchEvent("click");
  assert.equal(
    await page.evaluate(
      () => window.fixture.commands.filter((type) => type === "resend_verification").length,
    ),
    1,
  );
  await page.evaluate(() => window.fixture.held());
  await page.waitForFunction(() => !document.getElementById("resendButton").disabled);
  assert.equal(
    await page.locator("#verificationStatus").textContent(),
    catalog.verificationSent.message,
  );
  assert.equal(await page.locator("#verificationPanel").isVisible(), true);
  assert.equal(await page.locator("#errorBanner").isVisible(), false);
  await page.evaluate(() => {
    window.fixture.commandResults.resend_verification = {
      ok: false,
      commandError: "verification_email_cooldown",
      commandRetryAfterSeconds: 1,
    };
    window.fixture.responsePatches.resend_verification = {
      error: "verification_email_cooldown",
      retryAfterSeconds: 1,
    };
  });
  await page.locator("#resendButton").click();
  await page.waitForFunction(
    () => !document.getElementById("verificationStatus").textContent.includes("Envoi"),
  );
  assert.equal(await page.locator("#resendButton").isDisabled(), true);
  await page.waitForFunction(() => !document.getElementById("resendButton").disabled, null, {
    timeout: 5000,
  });
  await page.evaluate(() => {
    window.fixture.commandResults.resend_verification = { ok: true };
    window.fixture.responsePatches.resend_verification = { error: null };
    window.fixture.heldType = "resend_verification";
  });
  await page.locator("#resendButton").click();
  await page.waitForFunction(() => Boolean(window.fixture.held));
  await page.evaluate(() => {
    window.fixture.publish({
      status: "connected",
      protected: true,
      protectionRequested: true,
      activeLocationId: "fr",
      error: null,
    });
    window.fixture.held();
  });
  await page.locator("#verificationPanel").waitFor({ state: "hidden" });
  assert.equal(await page.locator("#verificationStatus").textContent(), "");
  report.checks.push({
    passed: true,
    name: "Verification email has one pending request, a visible success after the error clears, and a cooldown that enables another manual attempt",
  });
  await page.close();

  page = await open();
  await page.locator("#settingsButton").click();
  await page.route("**/_locales/de/messages.json", (route) => route.abort());
  await page.evaluate(() =>
    window.fixture.publish({ languagePreference: "de", effectiveLanguage: "de" }),
  );
  await page.locator("#languageError").waitFor({ state: "visible" });
  await page.unroute("**/_locales/de/messages.json");
  await page.evaluate(() => window.fixture.publish({}));
  await page.waitForFunction(() => document.documentElement.lang === "de");
  assert.equal(await page.locator("#languageError").isVisible(), false);
  await page.evaluate(() => {
    window.fixture.commandResults.set_language_preference = {
      ok: false,
      commandError: "unknown_error",
    };
  });
  await page.locator("#languageSelect").selectOption("fr");
  await page.locator("#languageError").waitFor({ state: "visible" });
  await page.evaluate(() => window.fixture.publish({}));
  await rendered(page);
  assert.equal(await page.locator("#languageError").isVisible(), true);
  report.checks.push({
    passed: true,
    name: "Catalog recovery clears only catalog errors; failed preference persistence remains visible",
  });
  await page.close();

  for (const locale of ["fr", "en"]) {
    page = await open();
    await page.evaluate((locale) => {
      window.fixture.publish({
        languagePreference: locale,
        effectiveLanguage: locale,
        error: "future_worker_error",
      });
    }, locale);
    await page.waitForFunction((locale) => document.documentElement.lang === locale, locale);
    await rendered(page);
    const translated = JSON.parse(
      await readFile(join(extension, `_locales/${locale}/messages.json`), "utf8"),
    );
    assert.equal(
      await page.locator("#errorMessage").textContent(),
      translated.error_unknown_error.message,
    );
    report.checks.push({
      passed: true,
      name: `An unknown worker error falls back to the localized generic message in ${locale}`,
    });
    await page.close();
  }

  page = await open();
  await page.evaluate(() => {
    const f = window.fixture;
    f.publish({
      locations: [
        ...f.snapshot.locations,
        ...Array.from({ length: 200 }, (_, index) => ({
          ...f.snapshot.locations[0],
          id: `location-${index}`,
          displayName: `Location ${index}`,
        })),
      ],
    });
  });
  await rendered(page);
  await page.locator("#changeLocationButton").click();
  await page.locator("#locationSearch").fill("Paris");
  await page.locator("button.location-option").first().focus();
  const cachedWork = await page.evaluate(() => {
    const original = Intl.DisplayNames.prototype.of;
    let countryLookups = 0;
    const focused = document.activeElement;
    const firstRow = document.querySelector("button.location-option");
    Intl.DisplayNames.prototype.of = function (...args) {
      countryLookups += 1;
      return original.apply(this, args);
    };
    try {
      for (let index = 0; index < 10; index += 1) {
        window.fixture.publish({
          network: { ...window.fixture.snapshot.network, ip: `203.0.113.${index + 10}` },
        });
      }
      return {
        countryLookups,
        focusPreserved: document.activeElement === focused,
        nodePreserved: document.querySelector("button.location-option") === firstRow,
      };
    } finally {
      Intl.DisplayNames.prototype.of = original;
    }
  });
  assert.equal(
    cachedWork.countryLookups,
    10,
    "Only the main location label should be localized again",
  );
  assert.equal(cachedWork.focusPreserved, true);
  assert.equal(cachedWork.nodePreserved, true);
  await page.locator("#locationSearch").fill("Location 199");
  assert.equal(await page.locator("button.location-option").count(), 1);
  assert.equal(
    await page.locator("button.location-option").getAttribute("data-focus-key"),
    "location-199",
  );
  await page.evaluate(() => {
    window.fixture.publish({
      locationPreferences: {
        ...window.fixture.snapshot.locationPreferences,
        favoriteIds: ["location-199"],
      },
    });
  });
  assert.equal(
    await page
      .locator('.location-favorite[data-focus-key="favorite:location-199"]')
      .getAttribute("aria-pressed"),
    "true",
  );
  await page.evaluate(() =>
    window.fixture.publish({ languagePreference: "en", effectiveLanguage: "en" }),
  );
  await page.waitForFunction(() => document.documentElement.lang === "en");
  await rendered(page);
  assert.equal(await page.locator("#allLocationsFilter").textContent(), "All");
  assert.equal(await page.locator("button.location-option").count(), 1);
  report.checks.push({
    passed: true,
    name: "IP-only publications skip all 201 location rows while search, favorites and language invalidate the cache",
    actual: cachedWork,
  });
  await page.close();

  page = await open();
  await page.locator("#changeLocationButton").click();
  await page.locator("#locationSearch").fill("Paris");
  await page.evaluate(() => {
    window.originalLocationNode = document.querySelector("button.location-option");
    window.fixture.publish({});
  });
  await rendered(page);
  assert.equal(
    await page.evaluate(
      () => window.originalLocationNode === document.querySelector("button.location-option"),
    ),
    true,
  );
  await page.locator("button.location-option").focus();
  await page.evaluate(() =>
    window.fixture.publish({ network: { ...window.fixture.snapshot.network, ip: "203.0.113.30" } }),
  );
  await rendered(page);
  assert.equal(
    await page.evaluate(() => window.originalLocationNode === document.activeElement),
    true,
  );
  assert.equal(
    await page.evaluate(
      () => window.originalLocationNode === document.querySelector("button.location-option"),
    ),
    true,
  );
  await page.locator("#closeLocationButton").click();
  for (const patch of [
    { profile: { userId: "broken" } },
    { devices: [{ deviceId: "bad", createdAt: "not-a-date" }] },
  ]) {
    await page.evaluate(
      (patch) => window.fixture.emit({ ...window.fixture.snapshot, ...patch }),
      patch,
    );
    await rendered(page);
    assert.equal((await status(page)).errorVisible, true);
    await page.evaluate(() => window.fixture.publish({}));
    await rendered(page);
  }
  report.checks.push({
    passed: true,
    name: "Unchanged hidden and visible lists retain node identity and keyboard focus; malformed nested snapshots show recovery without breaking the popup",
  });
  await page.close();
  await reviewPopupDesign();
  assert.deepEqual(report.pageErrors, []);
  report.completed = true;
} catch (error) {
  report.failure = String(error.stack ?? error);
  process.exitCode = 1;
} finally {
  await browser.close();
  await writeFile(
    join(output, "browser-popup-audit-fixes.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  process.stdout.write(JSON.stringify(report, null, 2));
}
