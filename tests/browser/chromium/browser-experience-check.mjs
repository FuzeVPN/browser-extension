import { installSyntheticWebAuth, assertSyntheticTokenRequest } from "./synthetic-web-auth.mjs";
// SPDX-License-Identifier: MPL-2.0

// Run after building. Uses a fresh Chromium profile, synthetic API/IP replies,
// and blocks all other network requests. No real account or VPN traffic is used.
// Optional: CHROME_EXTENSION_DIR, PLAYWRIGHT_MODULE_PATH, CHROMIUM_EXECUTABLE,
// EXPERIENCE_OUTPUT (the report and screenshot directory).
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { SUPPORTED_LANGUAGES, localeDirectory } from "../../../scripts/supported-locales.mjs";
import { expandAllLocations } from "./browser-location-ui.mjs";

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
const temporary = await mkdtemp(join(tmpdir(), "fuzevpn-browser-experience-"));
const output = resolve(process.env.EXPERIENCE_OUTPUT ?? temporary);
const extension = resolve(process.env.CHROME_EXTENSION_DIR ?? join(root, "dist/chrome"));
await mkdir(output, { recursive: true });

// Public-format addresses are response fixtures only; none is contacted.
const directIp = "81.2.69.142";
const vpnIp = "185.159.157.10";
const publicIpv6 = "2a07:b944:ffff:ffff:ffff:ffff:ffff:ffff";
const locationId = "experience-fr";
const germanLocationId = "experience-de";
const usLocationId = "experience-us";
const turkishLocationId = "experience-tr";
const italianLocationId = "experience-it";
const irishLocationId = "experience-ie";
const locations = [
  {
    id: locationId,
    city: "Paris",
    country_code: "FR",
    display_name: "Paris synthetic",
    supported_protocols: ["browser_proxy"],
  },
  {
    id: germanLocationId,
    city: "München",
    country_code: "DE",
    display_name: "München synthetic",
    supported_protocols: ["browser_proxy"],
  },
  {
    id: usLocationId,
    city: "San Francisco",
    country_code: "US",
    display_name: "San Francisco synthetic",
    supported_protocols: ["browser_proxy"],
  },
  {
    id: turkishLocationId,
    city: "İstanbul",
    country_code: "TR",
    display_name: "İstanbul synthetic",
    supported_protocols: ["browser_proxy"],
  },
  {
    id: italianLocationId,
    city: "Roma",
    country_code: "IT",
    display_name: "Roma synthetic",
    supported_protocols: ["browser_proxy"],
  },
  {
    id: irishLocationId,
    city: "Dublin",
    country_code: "IE",
    display_name: "Dublin synthetic",
    supported_protocols: ["browser_proxy"],
  },
];
const report = {
  timestamp: new Date().toISOString(),
  scope: "Built extension; isolated Chromium profile; synthetic API and ipify replies only",
  limitations: [
    "IP observations and API replies are intercepted fixtures, not proof of a production VPN route.",
    "Every other HTTP(S) request is aborted; external DNS is disabled as defense in depth.",
  ],
  checks: [],
  pageErrors: [],
  blockedRequests: [],
};
let context;
let sessionNumber = 0;
let expectedIp = directIp;
let expectedRoute = "direct";
let failIp = false;
let transientIpFailures = 0;
let heldIp = null;
const ipRequests = [];

function expectIp(mode, ip) {
  expectedRoute = mode;
  expectedIp = ip;
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => (resolve = done));
  return { promise, resolve };
}

function holdNextIp() {
  assert.equal(heldIp, null);
  const arrived = deferred();
  const release = deferred();
  const completed = deferred();
  heldIp = { arrived, release, completed };
  return {
    arrived: arrived.promise,
    release: release.resolve,
    completed: completed.promise,
  };
}

function record(name) {
  report.checks.push({ name, passed: true });
  process.stdout.write(`PASS ${name}\n`);
}

async function command(page, request) {
  if (request.type === "web_login") await installSyntheticWebAuth(context);
  const response = await page.evaluate((value) => chrome.runtime.sendMessage(value), request);
  assert.equal(response?.ok, true, `Command failed: ${request.type}`);
  return response.snapshot;
}

async function rendered(page) {
  await page.evaluate(
    () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))),
  );
}

async function withTimeout(promise, message) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), 15000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function networkState(page, expected) {
  await page.waitForFunction(
    async (values) => {
      const { snapshot } = await chrome.runtime.sendMessage({ type: "get_snapshot" });
      return Object.entries(values).every(([key, value]) => snapshot.network?.[key] === value);
    },
    expected,
    { timeout: 15000 },
  );
  if (expected.status === "ready" && expected.ip) {
    await page.waitForFunction(
      (ip) => document.querySelector("#publicIp bdi")?.textContent === ip,
      expected.ip,
      { timeout: 15000 },
    );
  } else if (expected.status === "unavailable") {
    await page.waitForFunction(
      () => document.querySelector("#publicIp")?.textContent.endsWith(" · Unavailable"),
      undefined,
      { timeout: 15000 },
    );
  }
  await rendered(page);
  return command(page, { type: "get_snapshot" });
}

async function snapshotState(page, expected) {
  await page.waitForFunction(
    async (values) => {
      const { snapshot } = await chrome.runtime.sendMessage({ type: "get_snapshot" });
      return Object.entries(values).every(([path, value]) => {
        const actual = path.split(".").reduce((object, key) => object?.[key], snapshot);
        return JSON.stringify(actual) === JSON.stringify(value);
      });
    },
    expected,
    { timeout: 15000 },
  );
  await rendered(page);
  return command(page, { type: "get_snapshot" });
}

async function visibleLocationIds(page) {
  return page
    .locator(".location-server-row .location-option")
    .evaluateAll((nodes) => nodes.map((node) => node.dataset.focusKey));
}

async function openLocations(page) {
  if (!(await page.locator("#locationDialog").evaluate((node) => node.open))) {
    await page.locator("#changeLocationButton").click();
  }
  await page.locator("#locationSearch").waitFor({ state: "visible" });
}

async function assertFlag(page, container, code) {
  const selector = `${container} img.country-flag`;
  await page.waitForFunction(
    ({ selector, code }) => {
      const image = document.querySelector(selector);
      return (
        image instanceof HTMLImageElement &&
        image.complete &&
        image.naturalWidth > 0 &&
        new URL(image.src).protocol === "chrome-extension:" &&
        new URL(image.src).pathname === `/flags/${code}.svg`
      );
    },
    { selector, code },
  );
  assert.equal(await page.locator(selector).count(), 1);
}

async function assertOrb(page, state) {
  assert.equal(
    await page.locator("#statusOrb").evaluate((node, name) => node.classList.contains(name), state),
    true,
  );
  const color = await page
    .locator("#statusOrb span")
    .evaluate((node) => getComputedStyle(node).borderTopColor);
  const rgb = color.match(/\d+/g).map(Number);
  if (state === "connected")
    assert(rgb[1] > rgb[0] && rgb[1] > rgb[2], `Expected green, got ${color}`);
  else assert(rgb[0] > rgb[1] && rgb[0] > rgb[2], `Expected red, got ${color}`);
}

async function screenshot(page, name) {
  await rendered(page);
  await page.screenshot({ path: join(output, name), fullPage: true, animations: "disabled" });
}

try {
  context = await chromium.launchPersistentContext(join(temporary, "profile"), {
    channel: "chromium",
    ...(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : {}),
    headless: true,
    viewport: { width: 360, height: 600 },
    args: [
      `--disable-extensions-except=${extension}`,
      `--load-extension=${extension}`,
      "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1, EXCLUDE [::1]",
      "--disable-background-networking",
    ],
  });
  report.chromium = context.browser().version();
  await context.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.protocol === "chrome-extension:") return route.continue();
    if (
      ["https://api.ipify.org", "https://api64.ipify.org"].includes(url.origin) &&
      url.search === "?format=json"
    ) {
      assert.equal(
        url.origin,
        expectedRoute === "vpn" ? "https://api.ipify.org" : "https://api64.ipify.org",
        `Unexpected IP endpoint for the ${expectedRoute} route`,
      );
      const responseIp = expectedIp;
      const failure = failIp || transientIpFailures > 0;
      if (transientIpFailures > 0) transientIpFailures--;
      ipRequests.push({
        mode: expectedRoute,
        origin: url.origin,
        method: request.method(),
        headers: await request.allHeaders(),
      });
      const current = heldIp;
      if (current) {
        heldIp = null;
        current.arrived.resolve();
        await current.release.promise;
      }
      try {
        await route.fulfill({
          status: failure ? 503 : 200,
          contentType: "application/json",
          headers: { "Cache-Control": "no-store" },
          body: JSON.stringify(failure ? { error: "synthetic_unavailable" } : { ip: responseIp }),
        });
      } catch (error) {
        // A route change intentionally aborts the delayed browser request.
        if (!current) throw error;
      } finally {
        current?.completed.resolve();
      }
      return;
    }
    if (url.origin !== "https://api.fuzevpn.com") {
      report.blockedRequests.push(`${url.protocol}//${url.host}${url.pathname}`);
      return route.abort("blockedbyclient");
    }
    let status = 200;
    let body;
    const path = url.pathname;
    if (path === "/v1/auth/extension/token") {
      await assertSyntheticTokenRequest(context, request);
      status = 201;
      body = {
        access_token: "synthetic-experience-token",
        expires_at: new Date(Date.now() + 3600000).toISOString(),
      };
    } else if (path === "/v1/me") {
      body = {
        user_id: "experience-user",
        email: "experience@example.invalid",
        first_name: "Experience",
        last_name: "Test",
        country_code: "FR",
      };
    } else if (path === "/v1/billing/subscription") {
      body = {
        status: "active",
        has_access: true,
        offer_id: "synthetic",
        started_at: null,
        expires_at: new Date(Date.now() + 3600000).toISOString(),
        renews_automatically: false,
      };
    } else if (path === "/v1/locations") {
      body = { locations };
    } else if (path === "/v1/devices/browser") {
      status = 201;
      body = {
        device_id: "synthetic-experience-browser",
        name: "Synthetic experience browser",
        kind: "browser_extension",
        created_at: new Date().toISOString(),
      };
    } else if (path === "/v1/devices") {
      body = {
        limit: 5,
        devices: [
          {
            device_id: "synthetic-experience-browser",
            name: "Synthetic experience browser",
            kind: "browser_extension",
            created_at: "2026-01-02T12:00:00.000Z",
            profiles: [
              {
                protocol: "browser_proxy",
                status: "active",
                created_at: "2026-01-02T12:00:00.000Z",
                expires_at: null,
              },
            ],
          },
        ],
      };
    } else if (path === "/v1/proxy/sessions" && request.method() === "POST") {
      status = 201;
      body = {
        id: `synthetic-experience-session-${++sessionNumber}`,
        location_id: request.postDataJSON().location_id,
        scheme: "https",
        host: "unavailable.proxy.experience.invalid",
        port: 443,
        username: "synthetic-proxy-user",
        password: "synthetic-proxy-password",
        issued_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 1200000).toISOString(),
        refresh_after_seconds: 900,
      };
    } else if (request.method() === "DELETE" || path === "/v1/auth/logout") {
      status = 204;
    } else {
      status = 404;
      body = { error: "not_found" };
    }
    await route.fulfill({
      status,
      ...(body ? { contentType: "application/json", body: JSON.stringify(body) } : {}),
    });
  });
  const worker =
    context.serviceWorkers()[0] ??
    (await context.waitForEvent("serviceworker", { timeout: 15000 }));
  const page = await context.newPage();
  page.on("pageerror", (error) => report.pageErrors.push(String(error)));
  await page.goto(`chrome-extension://${worker.url().split("/")[2]}/popup/popup.html`);
  await command(page, { type: "set_language_preference", preference: "en" });
  await command(page, { type: "web_login", disconnectFirst: false });
  await page.locator("#mainView").waitFor({ state: "visible" });
  await networkState(page, { status: "ready", mode: "direct", ip: directIp });
  assert.equal(await page.locator("#publicIp").textContent(), `Public IP · ${directIp}`);
  await assertOrb(page, "disconnected");
  await assertFlag(page, "#locationName", "fr");
  const locationBounds = await page.locator("#locationName").boundingBox();
  const ipBounds = await page.locator("#publicIp").boundingBox();
  assert(
    ipBounds.y >= locationBounds.y + locationBounds.height,
    "The IP must appear below the location",
  );
  await screenshot(page, "experience-disconnected.png");
  record("Disconnected popup shows a red indicator and the public IP below the location");

  const initialRequests = ipRequests.length;
  await Promise.all(Array.from({ length: 4 }, () => command(page, { type: "refresh_network" })));
  assert.equal(ipRequests.length, initialRequests);
  record("Repeated popup refresh requests reuse the recent observation without extra traffic");

  await page.locator("#settingsButton").click();
  await page.locator("#manageDevicesButton").click();
  await page.waitForFunction(() =>
    document.getElementById("deviceList").textContent.includes("Synthetic experience browser"),
  );
  assert.equal(await page.locator("#deviceList .device-profiles").count(), 0);
  assert.doesNotMatch(
    await page.locator("#deviceList").textContent(),
    /Active profiles|Profils actifs/i,
  );
  await screenshot(page, "experience-devices.png");
  await page.locator("#closeDevicesButton").click();
  await page.locator("#closeSettingsButton").click();
  record("Managing an account with an active device profile omits the unused profile line");

  expectIp("vpn", vpnIp);
  transientIpFailures = 1;
  const beforeTransientFailure = ipRequests.length;
  await command(page, { type: "connect", locationId });
  const connected = await networkState(page, {
    status: "ready",
    mode: "vpn",
    ip: vpnIp,
    locationId,
  });
  assert.equal(connected.status, "connected");
  assert.equal(connected.protected, true);
  assert.equal(await page.locator("#publicIp").textContent(), `VPN IP · ${vpnIp}`);
  await assertOrb(page, "connected");
  await screenshot(page, "experience-connected.png");
  record("Connection changes the indicator to green and replaces the public IP with the VPN IP");
  assert.equal(ipRequests.length, beforeTransientFailure + 2);
  record(
    "A temporary IP-service failure recovers through the same VPN endpoint without reconnecting",
  );

  expectIp("direct", directIp);
  await command(page, { type: "disconnect" });
  await networkState(page, { status: "ready", mode: "direct", ip: directIp });
  assert.equal(await page.locator("#publicIp").textContent(), `Public IP · ${directIp}`);
  await assertOrb(page, "disconnected");
  record("Disconnecting restores the red indicator and a fresh public IP observation");

  failIp = true;
  expectIp("vpn", vpnIp);
  await command(page, { type: "connect", locationId });
  const unavailable = await networkState(page, { status: "unavailable", mode: "vpn", ip: null });
  assert.equal(unavailable.status, "connected");
  assert.equal(unavailable.protected, true);
  assert.equal(unavailable.trafficBlocked, false);
  assert.equal(await page.locator("#publicIp").textContent(), "VPN IP · Unavailable");
  await assertOrb(page, "connected");
  await screenshot(page, "experience-ip-unavailable.png");
  record("An unavailable IP service shows an explicit fallback without disconnecting the VPN");

  failIp = false;
  const recoveredIp = await networkState(page, { status: "ready", mode: "vpn", ip: vpnIp });
  assert.equal(recoveredIp.status, "connected");
  assert.equal(recoveredIp.protected, true);
  assert.equal(await page.locator("#publicIp").textContent(), `VPN IP · ${vpnIp}`);
  record(
    "The open popup rechecks a failed IP observation and recovers automatically on the same session",
  );
  expectIp("direct", publicIpv6);
  await command(page, { type: "disconnect" });
  await networkState(page, { status: "ready", mode: "direct", ip: publicIpv6 });
  assert.equal(await page.locator("#publicIp").textContent(), `Public IP · ${publicIpv6}`);
  const layout = await page.evaluate(() => {
    const ip = document.getElementById("publicIp");
    const card = document.getElementById("locationCard");
    const bounds = ip.getBoundingClientRect();
    const cardBounds = card.getBoundingClientRect();
    return {
      ipWidth: ip.clientWidth,
      ipScrollWidth: ip.scrollWidth,
      cardRight: cardBounds.right,
      ipRight: bounds.right,
      documentWidth: document.documentElement.scrollWidth,
      viewportWidth: innerWidth,
    };
  });
  assert(layout.ipScrollWidth <= layout.ipWidth + 1, "IPv6 overflows its text container");
  assert(layout.ipRight <= layout.cardRight, "IPv6 extends outside the location card");
  assert(layout.documentWidth <= layout.viewportWidth, "IPv6 creates horizontal page scrolling");
  await screenshot(page, "experience-disconnected-ipv6.png");
  record("A full-length direct public IPv6 address stays readable within the 360 px popup");

  expectIp("vpn", publicIpv6);
  const beforeRejectedIpv6 = ipRequests.length;
  await command(page, { type: "connect", locationId });
  const rejectedIpv6 = await networkState(page, { status: "unavailable", mode: "vpn", ip: null });
  assert.equal(rejectedIpv6.status, "connected");
  assert.equal(rejectedIpv6.protected, true);
  assert.equal(ipRequests.length, beforeRejectedIpv6 + 1, "IPv6 rejection caused another lookup");
  assert.equal(await page.locator("#publicIp").textContent(), "VPN IP · Unavailable");
  expectIp("direct", directIp);
  await command(page, { type: "disconnect" });
  await networkState(page, { status: "ready", mode: "direct", ip: directIp });
  expectIp("vpn", vpnIp);
  await command(page, { type: "connect", locationId });
  await networkState(page, { status: "ready", mode: "vpn", ip: vpnIp });
  assert.equal(await page.locator("#publicIp").textContent(), `VPN IP · ${vpnIp}`);
  record(
    "VPN lookups request IPv4, reject an IPv6 reply without fallback, and recover on reconnection",
  );

  expectIp("direct", directIp);
  const delayed = holdNextIp();
  await command(page, { type: "disconnect" });
  await withTimeout(delayed.arrived, "Direct IP request did not arrive");
  expectIp("vpn", vpnIp);
  await command(page, { type: "connect", locationId });
  await networkState(page, { status: "ready", mode: "vpn", ip: vpnIp });
  delayed.release();
  await delayed.completed;
  await rendered(page);
  const afterLate = await command(page, { type: "get_snapshot" });
  assert.equal(afterLate.network.mode, "vpn");
  assert.equal(afterLate.network.ip, vpnIp);
  assert.equal(await page.locator("#publicIp").textContent(), `VPN IP · ${vpnIp}`);
  record("A delayed direct IP reply cannot replace the VPN IP after reconnection");

  await openLocations(page);
  await page.locator("#allLocationsFilter").click();
  await expandAllLocations(page);
  for (const location of locations)
    await assertFlag(
      page,
      `.location-country-group[data-country-code="${location.country_code}"] > .location-group-row > .location-group-select`,
      location.country_code.toLowerCase(),
    );
  record("The selected location and all six country rows load their bundled flags");
  assert.equal(await page.locator("#allLocationsFilter").getAttribute("aria-pressed"), "true");
  for (const query of ["munchen", "MÜNCHEN", "DE", "Germany"]) {
    await page.locator("#locationSearch").fill(query);
    assert.deepEqual(
      await visibleLocationIds(page),
      [germanLocationId],
      `Wrong results for ${query}`,
    );
  }
  await command(page, { type: "set_language_preference", preference: "fr" });
  await page.waitForFunction(() => document.documentElement.lang === "fr");
  await page.locator("#locationSearch").fill("allemagne");
  assert.deepEqual(await visibleLocationIds(page), [germanLocationId]);
  await command(page, { type: "set_language_preference", preference: "tr" });
  await page.waitForFunction(() => document.documentElement.lang === "tr");
  for (const [query, expected] of [
    ["İstanbul", turkishLocationId],
    ["istanbul", turkishLocationId],
    ["İtalya", italianLocationId],
    ["italya", italianLocationId],
    ["İrlanda", irishLocationId],
    ["irlanda", irishLocationId],
    ["IT", italianLocationId],
    ["it", italianLocationId],
    ["IE", irishLocationId],
    ["ie", irishLocationId],
    ["istanbul TR", turkishLocationId],
  ]) {
    await page.locator("#locationSearch").fill(query);
    assert.deepEqual(
      await visibleLocationIds(page),
      [expected],
      `Wrong Turkish results for ${query}`,
    );
  }
  record(
    "Turkish search handles dotted I, lowercase country names and case-independent ISO country codes",
  );
  await command(page, { type: "set_language_preference", preference: "en" });
  await page.waitForFunction(() => document.documentElement.lang === "en");
  await page.locator("#locationSearch").fill("");
  await expandAllLocations(page);
  assert.deepEqual(
    await page
      .locator(".location-country-group")
      .evaluateAll((nodes) => nodes.map((node) => node.dataset.countryCode).sort()),
    locations.map(({ country_code }) => country_code).sort(),
  );
  record(
    "Location search matches cities without accents, country codes, and localized country names",
  );

  await page.locator("#locationSearch").fill("no-location-matches-this-query");
  assert.deepEqual(await visibleLocationIds(page), []);
  await page.locator("#locationEmpty").waitFor({ state: "visible" });
  assert((await page.locator("#locationEmpty").textContent()).trim().length > 0);
  await screenshot(page, "experience-locations-empty.png");
  await page.locator("#locationSearch").fill("");
  await expandAllLocations(page);
  record("An unmatched location search displays a clear empty state");

  const favorite = page.locator(
    `.location-favorite[data-focus-key="favorite:${germanLocationId}"]`,
  );
  await favorite.click();
  const favorited = await snapshotState(page, {
    "locationPreferences.favoriteIds": [germanLocationId],
  });
  assert.equal(favorited.activeLocationId, locationId, "Favoriting unexpectedly switched the VPN");
  assert.equal(await favorite.getAttribute("aria-pressed"), "true");
  await favorite.focus();
  await command(page, { type: "refresh_account" });
  await rendered(page);
  assert.equal(
    await page.evaluate(() => document.activeElement?.dataset.focusKey),
    `favorite:${germanLocationId}`,
  );
  await page.keyboard.press("Enter");
  await snapshotState(page, { "locationPreferences.favoriteIds": [] });
  assert.equal(
    await page.evaluate(() => document.activeElement?.dataset.focusKey),
    `favorite:${germanLocationId}`,
  );
  await page.keyboard.press("Enter");
  await snapshotState(page, { "locationPreferences.favoriteIds": [germanLocationId] });
  record("Favorite toggles keep keyboard focus during state refreshes and do not switch the VPN");

  await page.locator("#favoriteLocationsFilter").click();
  assert.equal(await page.locator("#favoriteLocationsFilter").getAttribute("aria-pressed"), "true");
  assert.deepEqual(await visibleLocationIds(page), [germanLocationId]);
  await screenshot(page, "experience-locations-favorites.png");
  await page.reload();
  await page.locator("#mainView").waitFor({ state: "visible" });
  await snapshotState(page, { "locationPreferences.favoriteIds": [germanLocationId] });
  await openLocations(page);
  await page.locator("#favoriteLocationsFilter").click();
  assert.deepEqual(await visibleLocationIds(page), [germanLocationId]);
  assert.equal(await favorite.getAttribute("aria-pressed"), "true");
  record("The favorites filter displays only saved locations and survives popup reload");

  await page.locator("#recentLocationsFilter").click();
  assert.equal(await page.locator("#recentLocationsFilter").getAttribute("aria-pressed"), "true");
  assert.deepEqual(await visibleLocationIds(page), [locationId]);
  await page.locator("#closeLocationButton").click();
  expectIp("direct", directIp);
  await command(page, { type: "disconnect" });
  await networkState(page, { status: "ready", mode: "direct", ip: directIp });
  await openLocations(page);
  await page.locator("#allLocationsFilter").click();
  await expandAllLocations(page);
  await page.locator('.location-city-select[data-country-code="US"]').click();
  const selectedOnly = await snapshotState(page, { selectedLocationId: usLocationId });
  assert.deepEqual(selectedOnly.locationPreferences.recentIds, [locationId]);
  assert.equal(selectedOnly.locationPreferences.automatic, false);
  await page.locator("#locationDialog").waitFor({ state: "hidden" });
  await assertFlag(page, "#locationName", "us");
  await openLocations(page);
  await page.locator("#allLocationsFilter").click();
  await expandAllLocations(page);
  await page.locator('.location-city-select[data-country-code="DE"]').click();
  await snapshotState(page, { selectedLocationId: germanLocationId });
  await assertFlag(page, "#locationName", "de");
  record("Changing the selected location updates its country flag before connection");
  expectIp("vpn", vpnIp);
  await page.locator("#protectButton").click();
  await networkState(page, {
    status: "ready",
    mode: "vpn",
    locationId: germanLocationId,
    ip: vpnIp,
  });
  const recentlyConnected = await snapshotState(page, {
    status: "connected",
    protected: true,
    activeLocationId: germanLocationId,
    "locationPreferences.recentIds": [germanLocationId, locationId],
  });
  assert.equal(
    recentlyConnected.activeLocationId,
    germanLocationId,
    JSON.stringify({
      status: recentlyConnected.status,
      protected: recentlyConnected.protected,
      error: recentlyConnected.error,
      activeLocationId: recentlyConnected.activeLocationId,
      network: recentlyConnected.network,
    }),
  );
  await openLocations(page);
  await page.locator("#recentLocationsFilter").click();
  assert.deepEqual(await visibleLocationIds(page), [germanLocationId, locationId]);
  await screenshot(page, "experience-locations-recent.png");
  record(
    "Recent locations record successful connections in order, excluding a selection without connection",
  );

  const recommendation = (await command(page, { type: "get_snapshot" })).locationPreferences
    .recommendedLocationId;
  await page.locator("#automaticLocationButton").click();
  const automatic = await snapshotState(page, {
    "locationPreferences.automatic": true,
    status: "connected",
  });
  assert.equal(automatic.selectedLocationId, recommendation);
  assert.equal(automatic.activeLocationId, recommendation);
  await page.locator("#locationDialog").waitFor({ state: "hidden" });
  await openLocations(page);
  await page.locator("#allLocationsFilter").click();
  await expandAllLocations(page);
  const sessionsBeforeFailedSave = sessionNumber;
  await worker.evaluate(() => {
    const original = chrome.storage.local.set.bind(chrome.storage.local);
    globalThis.experienceRestoreFailedStorage = () => {
      chrome.storage.local.set = original;
    };
    let rejected = false;
    chrome.storage.local.set = (items, ...args) => {
      if (!rejected && items.fuzevpnLocationPreferences?.automatic === false) {
        rejected = true;
        return Promise.reject(new Error("synthetic_preferences_storage_failure"));
      }
      return original(items, ...args);
    };
  });
  try {
    await page.locator('.location-city-select[data-country-code="US"]').click();
    await page.locator("#locationPreferenceError").waitFor({ state: "visible" });
    assert.equal(await page.locator("#locationDialog").evaluate((node) => node.open), true);
    assert((await page.locator("#locationPreferenceError").textContent()).trim().length > 0);
    const failedSave = await command(page, { type: "get_snapshot" });
    assert.equal(failedSave.locationPreferences.automatic, true);
    assert.equal(failedSave.selectedLocationId, recommendation);
    assert.equal(failedSave.activeLocationId, recommendation);
    assert.equal(failedSave.status, "connected");
    assert.equal(
      sessionNumber,
      sessionsBeforeFailedSave,
      "A failed preference save switched the VPN",
    );
    await screenshot(page, "experience-locations-save-failure.png");
  } finally {
    await worker.evaluate(() => {
      globalThis.experienceRestoreFailedStorage();
      delete globalThis.experienceRestoreFailedStorage;
    });
  }
  await page.locator('.location-city-select[data-country-code="US"]').click();
  await snapshotState(page, {
    status: "connected",
    activeLocationId: usLocationId,
    selectedLocationId: usLocationId,
    "locationPreferences.automatic": false,
  });
  await page.locator("#locationDialog").waitFor({ state: "hidden" });
  record("A failed manual preference save keeps the dialog and VPN unchanged, and retry succeeds");
  record(
    "Automatic selection connects to its recommendation and an explicit location restores manual mode",
  );

  await openLocations(page);
  await page.locator("#allLocationsFilter").click();
  await networkState(page, { status: "ready", mode: "vpn", ip: vpnIp, locationId: usLocationId });
  const sessionsBeforeLanguages = sessionNumber;
  for (const code of SUPPORTED_LANGUAGES) {
    const catalog = JSON.parse(
      await readFile(join(extension, "_locales", localeDirectory(code), "messages.json"), "utf8"),
    );
    await command(page, { type: "set_language_preference", preference: code });
    await page.waitForFunction((language) => document.documentElement.lang === language, code);
    await rendered(page);
    await expandAllLocations(page);
    await page.locator("#publicIp bdi").waitFor({ state: "attached" });
    const rtl = ["ar", "fa", "ur"].includes(code);
    const direction = await page.evaluate(() => {
      const title = document.getElementById("locationDialogTitle").getBoundingClientRect();
      const close = document.getElementById("closeLocationButton").getBoundingClientRect();
      return {
        attribute: document.documentElement.dir,
        computed: getComputedStyle(document.documentElement).direction,
        closeAfterTitle: close.x > title.x,
        ip: getComputedStyle(document.querySelector("#publicIp bdi")).direction,
        email: getComputedStyle(document.getElementById("accountEmail")).direction,
      };
    });
    assert.deepEqual(
      direction,
      {
        attribute: rtl ? "rtl" : "ltr",
        computed: rtl ? "rtl" : "ltr",
        closeAfterTitle: !rtl,
        ip: "ltr",
        email: "ltr",
      },
      `Popup direction and technical fields in ${code}`,
    );
    for (const selector of [
      "#allLocationsFilter",
      "#favoriteLocationsFilter",
      "#recentLocationsFilter",
    ]) {
      const button = page.locator(selector);
      const key = await button.getAttribute("data-i18n");
      assert(key && catalog[key]?.message, `Missing localized filter label: ${code}/${selector}`);
      assert.equal(await button.textContent(), catalog[key].message);
    }
    const overflow = await page.evaluate(() => {
      const dialog = document.getElementById("locationDialog");
      const list = document.getElementById("locationList");
      const controls = [...dialog.querySelectorAll("button, input")];
      return {
        dialog: dialog.scrollWidth > dialog.clientWidth + 1,
        list: list.scrollWidth > list.clientWidth + 1,
        page: document.documentElement.scrollWidth > innerWidth,
        controls: controls
          .filter((node) => node.scrollWidth > node.clientWidth + 1)
          .map((node) => node.id || node.className),
      };
    });
    assert.deepEqual(
      overflow,
      { dialog: false, list: false, page: false, controls: [] },
      `Location dialog overflow in ${code}`,
    );
    assert.equal(await page.locator(".location-country-group").count(), locations.length);
    assert.equal(await page.locator(".location-city-select:visible").count(), locations.length);
    await screenshot(page, `experience-locations-${code}.png`);
  }
  assert.equal(
    sessionNumber,
    sessionsBeforeLanguages,
    "Changing language unexpectedly created a VPN session",
  );
  record(
    "Search, filters, favorites, and automatic choice render in all thirty languages without horizontal overflow",
  );

  await page.locator("#closeLocationButton").click();
  await page.locator("#settingsButton").click();
  for (const code of ["ar", "fa", "ur", "en"]) {
    await command(page, { type: "set_language_preference", preference: code });
    await page.waitForFunction((language) => document.documentElement.lang === language, code);
    const rtl = code !== "en";
    const switches = await page.evaluate(() => {
      const input = document.getElementById("killSwitchEnabled");
      const style = document.createElement("style");
      style.textContent = ".setting-label input::before { transition: none !important; }";
      document.head.append(style);
      const original = input.checked;
      const positions = [];
      try {
        for (const checked of [false, true]) {
          input.checked = checked;
          const pseudo = getComputedStyle(input, "::before");
          const matrix =
            pseudo.transform === "none" ? 0 : new DOMMatrixReadOnly(pseudo.transform).m41;
          positions.push(Number.parseFloat(pseudo.left) + matrix);
        }
      } finally {
        input.checked = original;
        style.remove();
      }
      const title = document.getElementById("settingsTitle").getBoundingClientRect();
      const close = document.getElementById("closeSettingsButton").getBoundingClientRect();
      return { off: positions[0], on: positions[1], closeAfterTitle: close.x > title.x };
    });
    assert.equal(switches.closeAfterTitle, !rtl, `Settings heading direction in ${code}`);
    assert.equal(switches.on > switches.off, !rtl, `Switch movement direction in ${code}`);
    assert(switches.off >= 0 && switches.on >= 0 && Math.max(switches.off, switches.on) <= 24);
    await screenshot(page, `experience-settings-${code}.png`);
  }
  await page.locator("#closeSettingsButton").click();
  record(
    "Arabic, Persian and Urdu mirror settings and switches; switching back to English restores LTR",
  );
  const sessionsBeforeCancelledChoice = sessionNumber;
  await worker.evaluate(() => {
    const original = chrome.storage.local.set.bind(chrome.storage.local);
    globalThis.experienceRestoreStorage = () => {
      chrome.storage.local.set = original;
    };
    let arrive;
    let release;
    globalThis.experienceStorageArrived = new Promise((done) => {
      arrive = done;
    });
    const pending = new Promise((done) => {
      release = done;
    });
    globalThis.experienceReleaseStorage = release;
    let held = false;
    chrome.storage.local.set = (items, ...args) => {
      if (!held && Object.hasOwn(items, "fuzevpnLocationPreferences")) {
        held = true;
        arrive();
        return pending.then(() => original(items, ...args));
      }
      return original(items, ...args);
    };
  });
  try {
    const pendingAutomatic = page.evaluate(() =>
      chrome.runtime.sendMessage({ type: "select_automatic_location" }),
    );
    await withTimeout(
      worker.evaluate(() => globalThis.experienceStorageArrived),
      "Automatic preference storage did not start",
    );
    expectIp("direct", directIp);
    await command(page, { type: "disconnect" });
    await snapshotState(page, {
      status: "disconnected",
      protected: false,
      protectionRequested: false,
    });
    await worker.evaluate(() => globalThis.experienceReleaseStorage());
    const cancelled = await pendingAutomatic;
    assert.equal(cancelled.ok, false, "A superseded automatic selection should be rejected");
    const final = await command(page, { type: "get_snapshot" });
    assert.equal(final.status, "disconnected");
    assert.equal(final.activeLocationId, null);
    assert.equal(final.protected, false);
    assert.equal(final.protectionRequested, false);
    assert.equal(
      sessionNumber,
      sessionsBeforeCancelledChoice,
      "A late automatic preference save reconnected the VPN",
    );
    record("A delayed automatic preference save cannot reconnect after a newer disconnect request");
  } finally {
    await worker.evaluate(() => {
      globalThis.experienceReleaseStorage();
      globalThis.experienceRestoreStorage();
      delete globalThis.experienceReleaseStorage;
      delete globalThis.experienceRestoreStorage;
      delete globalThis.experienceStorageArrived;
    });
  }

  const storage = await page.evaluate(async () => ({
    local: await chrome.storage.local.get(null),
    session: await chrome.storage.session.get(null),
  }));
  const stored = JSON.stringify(storage);
  for (const ip of [directIp, vpnIp, publicIpv6])
    assert(!stored.includes(ip), "An observed IP was persisted");
  record("Observed public and VPN IP addresses are absent from local and session storage");

  assert(ipRequests.length >= 6);
  for (const request of ipRequests) {
    assert.equal(
      request.origin,
      request.mode === "vpn" ? "https://api.ipify.org" : "https://api64.ipify.org",
    );
    assert.equal(request.method, "GET");
    assert.equal(request.headers.authorization, undefined);
    assert.equal(request.headers.cookie, undefined);
    assert.equal(request.headers.referer, undefined);
    assert(!JSON.stringify(request.headers).includes("synthetic-experience-token"));
    assert(!JSON.stringify(request.headers).includes("synthetic-proxy-password"));
  }
  report.ipRequests = ipRequests.length;
  record(
    "Every VPN observation uses the IPv4 endpoint and every direct observation uses the dual-stack endpoint",
  );
  record("IP lookup requests carry no account token, proxy password, cookies, or referrer");
  assert.deepEqual(report.pageErrors, []);
  record("All experience scenarios complete without uncaught popup exceptions");
  report.completed = true;
} catch (error) {
  report.failure = String(error.stack ?? error);
  process.exitCode = 1;
} finally {
  heldIp?.release.resolve();
  if (context) await context.close();
  await writeFile(
    join(output, "browser-experience-check.json"),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`Report: ${join(output, "browser-experience-check.json")}\n`);
}
