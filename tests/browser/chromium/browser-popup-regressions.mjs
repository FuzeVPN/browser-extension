import { installSyntheticWebAuth, assertSyntheticTokenRequest } from "./synthetic-web-auth.mjs";
// SPDX-License-Identifier: MPL-2.0

// Run after building the extension. All account and API data is synthetic.
// Optional: CHROME_EXTENSION_DIR, PLAYWRIGHT_MODULE_PATH, CHROMIUM_EXECUTABLE,
// and POPUP_REGRESSION_OUTPUT (the report/screenshot directory).
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { waitForRead } from "../../../scripts/browser-wait.mjs";

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
const temporary = await mkdtemp(join(tmpdir(), "fuzevpn-popup-regressions-"));
const output = resolve(process.env.POPUP_REGRESSION_OUTPUT ?? temporary);
await mkdir(output, { recursive: true });
const extension = resolve(process.env.CHROME_EXTENSION_DIR ?? join(root, "dist/chrome"));
const frenchCatalog = JSON.parse(
  await readFile(join(extension, "_locales/fr/messages.json"), "utf8"),
);
const report = {
  timestamp: new Date().toISOString(),
  scope: "Built Chrome extension; fresh isolated Chromium profile; synthetic API only",
  checks: [],
  pageErrors: [],
};
let context;
let mode = "healthy";
let heldRequest = null;
let enrollmentCount = 0;
const enrollments = [];
let rejectedDeviceCode = null;
let quotaAfterRejection = false;
let quotaReached = false;
let sessionCount = 0;
const deletedDevices = [];
let devices = [
  {
    device_id: "other-one",
    name: "Private device one",
    kind: "vpn",
    created_at: "2026-01-02T12:00:00.000Z",
    profiles: [],
  },
  {
    device_id: "other-two",
    name: "Private device two",
    kind: "vpn",
    created_at: "2026-01-03T12:00:00.000Z",
    profiles: [],
  },
];
const location = {
  id: "popup-fr",
  city: "Paris",
  country_code: "FR",
  display_name: "Paris synthetic",
  supported_protocols: ["browser_proxy"],
};

function deferred() {
  let resolve;
  const promise = new Promise((done) => (resolve = done));
  return { promise, resolve };
}

function hold(path) {
  assert.equal(heldRequest, null);
  const arrived = deferred();
  const release = deferred();
  heldRequest = { path, arrived, release };
  return { arrived: arrived.promise, release: release.resolve };
}

function record(name) {
  report.checks.push({ name, passed: true });
  process.stdout.write(`PASS ${name}\n`);
}

async function command(page, value) {
  if (value.type === "web_login") await installSyntheticWebAuth(context);
  return page.evaluate((request) => chrome.runtime.sendMessage(request), value);
}

async function rendered(page) {
  await page.evaluate(
    () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))),
  );
}

async function login(page) {
  mode = "healthy";
  const response = await command(page, { type: "web_login", disconnectFirst: false });
  assert.equal(response.ok, true);
  await page.locator("#mainView").waitFor({ state: "visible" });
  await rendered(page);
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
  await context.route("https://api.fuzevpn.com/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    const method = route.request().method();
    if (heldRequest?.path === path) {
      const current = heldRequest;
      heldRequest = null;
      current.arrived.resolve();
      await current.release.promise;
    }
    let status = 200;
    let body;
    if (mode === "unauthorized") {
      status = 401;
      body = { error: "unauthorized" };
    } else if (path === "/v1/auth/extension/token") {
      await assertSyntheticTokenRequest(context, route.request());
      status = 201;
      body = {
        access_token: "synthetic-popup-token",
        expires_at: new Date(Date.now() + 3600000).toISOString(),
      };
    } else if (path === "/v1/me") {
      body = {
        user_id: "popup-user",
        email: "popup@example.invalid",
        first_name: "Popup",
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
      body = {
        locations: [
          {
            ...location,
            country_code:
              mode === "bad-country" ? "FRANCE" : mode === "unknown-country" ? "XX" : "FR",
            display_name: mode === "healthy" ? location.display_name : `Updated ${mode}`,
          },
          { ...location, id: "popup-de", display_name: "Frankfurt synthetic", country_code: "DE" },
        ],
      };
    } else if (path === "/v1/devices/browser") {
      enrollments.push(route.request().postDataJSON());
      if (quotaReached) {
        status = 409;
        body = { error: "device_limit" };
      } else {
        status = 201;
        body = {
          device_id: `synthetic-browser-${++enrollmentCount}`,
          name: route.request().postDataJSON().name,
          kind: "browser_extension",
          created_at: new Date().toISOString(),
        };
        devices.push({ ...body, profiles: [] });
      }
    } else if (path === "/v1/devices") {
      body = { limit: 5, devices };
    } else if (path.startsWith("/v1/devices/") && method === "DELETE") {
      const id = decodeURIComponent(path.slice("/v1/devices/".length));
      deletedDevices.push(id);
      devices = devices.filter(({ device_id }) => device_id !== id);
      quotaReached = false;
      status = 204;
    } else if (path === "/v1/proxy/sessions") {
      if (rejectedDeviceCode) {
        status = 403;
        body = { error: rejectedDeviceCode };
        const rejectedId = route.request().postDataJSON().device_id;
        devices = devices.filter(({ device_id }) => device_id !== rejectedId);
        rejectedDeviceCode = null;
        quotaReached = quotaAfterRejection;
        quotaAfterRejection = false;
      } else {
        status = 201;
        body = {
          id: `synthetic-popup-session-${++sessionCount}`,
          location_id: route.request().postDataJSON().location_id,
          scheme: "https",
          host: "unavailable.proxy.popup.invalid",
          port: 443,
          username: "synthetic-proxy-user",
          password: "synthetic-proxy-password",
          issued_at: new Date().toISOString(),
          expires_at: new Date(Date.now() + 1200000).toISOString(),
          refresh_after_seconds: 900,
        };
      }
    } else if (
      path === "/v1/auth/logout" ||
      (path.startsWith("/v1/proxy/sessions/") && method === "DELETE")
    ) {
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
  const url = `chrome-extension://${worker.url().split("/")[2]}/popup/popup.html`;
  function trackErrors(page) {
    page.on("pageerror", (error) => report.pageErrors.push(String(error)));
  }
  let page = await context.newPage();
  trackErrors(page);
  await page.goto(url);
  await login(page);
  await page.close();

  // Reproduce the initial account refresh arriving during keyboard navigation.
  const accountRefresh = hold("/v1/me");
  page = await context.newPage();
  trackErrors(page);
  await page.goto(url);
  await accountRefresh.arrived;
  await page.locator("#changeLocationButton").click();
  await page.locator("#locationSearch").fill("Frankfurt");
  await page.locator('.location-option[data-focus-key="popup-de"]').focus();
  accountRefresh.release();
  await page.waitForFunction(
    () =>
      document.getElementById("refreshSubscriptionButton").getAttribute("aria-busy") === "false",
  );
  await rendered(page);
  assert.equal(await page.evaluate(() => document.activeElement?.dataset.focusKey), "popup-de");
  assert.equal(await page.locator("#locationDialog").evaluate((node) => node.open), true);
  // Keyboard activation still selects the currently focused location.
  await page.keyboard.press("Enter");
  await page.locator("#locationDialog").waitFor({ state: "hidden" });
  assert.equal(
    (await command(page, { type: "get_snapshot" })).snapshot.selectedLocationId,
    "popup-de",
  );
  record("Delayed automatic account refresh preserves location focus and keyboard selection");

  await page.locator("#settingsButton").click();
  await page.locator("#manageDevicesButton").click();
  await page.locator(".delete-device-button").nth(1).waitFor({ state: "visible" });
  await page.waitForFunction(
    () => document.getElementById("refreshDevicesButton").getAttribute("aria-busy") === "false",
  );
  const deviceRefresh = hold("/v1/devices");
  const pendingDevices = command(page, { type: "refresh_devices" });
  await deviceRefresh.arrived;
  await page.locator(".delete-device-button").nth(1).focus();
  devices[1].name = "Renamed device two";
  deviceRefresh.release();
  await pendingDevices;
  await rendered(page);
  assert.equal(await page.evaluate(() => document.activeElement?.dataset.focusKey), "other-two");
  assert.match(await page.locator("#deviceList").textContent(), /Renamed device two/);
  record("Delayed device refresh preserves focused action while updating its data");

  await page.keyboard.press("Enter");
  await page.locator("#confirmationDialog").waitFor({ state: "visible" });
  const confirmation = await page.locator("#confirmationMessage").textContent();
  await page.locator("#confirmationAcceptButton").click();
  await page.waitForFunction(() => document.querySelectorAll(".delete-device-button").length === 1);
  await rendered(page);
  assert.match(confirmation, /Renamed device two/);
  assert.deepEqual(deletedDevices, ["other-two"]);
  assert.equal(await page.evaluate(() => document.activeElement?.id), "refreshDevicesButton");
  record(
    "Refreshed device action uses current identity/name and removal leaves usable keyboard focus",
  );
  await page.locator("#closeDevicesButton").click();
  await page.locator("#settingsPanel").waitFor({ state: "visible" });
  assert.equal(await page.evaluate(() => document.activeElement?.id), "manageDevicesButton");
  await page.locator("#closeSettingsButton").click();
  record("Closing devices normally returns to account settings");

  await command(page, { type: "select_location", locationId: "popup-fr" });
  await page.locator("#changeLocationButton").click();
  await page.locator("#locationSearch").fill("Paris");
  for (const countryMode of ["bad-country", "unknown-country"]) {
    mode = countryMode;
    await command(page, { type: "refresh_account" });
    await rendered(page);
    const country = countryMode === "bad-country" ? "FRANCE" : "XX";
    assert.equal(
      await page.locator("#locationName").textContent(),
      `${country} · Updated ${countryMode}`,
    );
    assert.equal(await page.locator(".location-option").count(), 2);
    assert.equal(
      await page
        .locator('.location-option[data-focus-key="popup-fr"] .option-country')
        .textContent(),
      `${country} · Paris`,
    );
    assert.equal(await page.locator("#languageError").textContent(), "");
    record(`${countryMode} renders complete current location data without a false language error`);
  }
  await page.screenshot({
    path: join(output, "popup-country-fallback.png"),
    animations: "disabled",
  });
  await page.locator("#closeLocationButton").click();
  mode = "healthy";
  await command(page, { type: "refresh_account" });
  await rendered(page);

  for (const dialog of ["locationDialog", "settingsPanel", "devicesDialog"]) {
    if (dialog === "locationDialog") await page.locator("#changeLocationButton").click();
    else {
      await page.locator("#settingsButton").click();
      if (dialog === "devicesDialog") {
        await page.locator("#manageDevicesButton").click();
        await page.locator(".device-name").waitFor({ state: "visible" });
        await page.waitForFunction(
          () =>
            document.getElementById("refreshDevicesButton").getAttribute("aria-busy") === "false",
        );
      }
    }
    assert.equal(await page.locator(`#${dialog}`).evaluate((node) => node.open), true);
    mode = "unauthorized";
    const expired = await command(page, { type: "refresh_account" });
    assert.equal(expired.snapshot.profile, null);
    await page.locator("#loginView").waitFor({ state: "visible" });
    await rendered(page);
    assert.equal(await page.locator("dialog[open]").count(), 0);
    assert.equal(await page.locator("#deviceList").textContent(), "");
    assert.equal(await page.locator("#deviceCount").textContent(), "");
    assert.equal(await page.locator("#locationList").textContent(), "");
    assert.equal(await page.locator("#accountEmail").textContent(), "");
    assert.equal(await page.locator("#subscriptionExpiry").textContent(), "");
    assert.equal(await page.evaluate(() => document.activeElement?.id), "loginButton");
    assert.notEqual(await page.locator("#loginErrorMessage").textContent(), "");
    record(`Account expiration in ${dialog} closes dialogs, clears account data and focuses login`);
    await login(page);
  }

  await command(page, { type: "set_language_preference", preference: "fr" });
  rejectedDeviceCode = "invalid_device";
  const recovered = await command(page, { type: "connect", locationId: "popup-fr" });
  assert.equal(recovered.ok, true);
  assert.equal(recovered.snapshot.status, "connected");
  assert.equal(recovered.snapshot.currentDeviceId, "synthetic-browser-2");
  assert.equal(recovered.snapshot.profile.userId, "popup-user");
  assert.equal(enrollmentCount, 2);
  assert.notEqual(enrollments[0].public_key, enrollments[1].public_key);
  assert.equal(await page.locator("#resetDeviceButton").count(), 0);
  record(
    "invalid_device automatically replaces the rejected identity without a reset action or logout",
  );

  await command(page, { type: "disconnect" });
  rejectedDeviceCode = "device_identity_revoked";
  quotaAfterRejection = true;
  const limited = await command(page, { type: "connect", locationId: "popup-fr" });
  assert.equal(limited.snapshot.error, "device_revoked_limit");
  assert.equal(limited.snapshot.currentDeviceId, null);
  assert.equal(enrollments.length, 3);
  await page.locator("#errorManageDevicesButton").waitFor({ state: "visible" });
  assert.equal(
    await page.locator("#errorMessage").textContent(),
    frenchCatalog.error_device_revoked_limit.message,
  );
  await page.locator("#errorManageDevicesButton").click();
  await page
    .locator('.delete-device-button[data-focus-key="other-one"]')
    .waitFor({ state: "visible" });
  await page.waitForFunction(() => !document.getElementById("refreshDevicesButton").disabled);
  assert.equal(
    (await command(page, { type: "get_snapshot" })).snapshot.error,
    "device_revoked_limit",
  );
  page.once("dialog", (dialog) => dialog.accept());
  await page.locator('.delete-device-button[data-focus-key="other-one"]').click();
  await page.locator("#confirmationAcceptButton").click();
  const resumed = await waitForRead(
    () => command(page, { type: "get_snapshot" }),
    ({ snapshot }) =>
      snapshot.status === "connected" && snapshot.currentDeviceId === "synthetic-browser-3",
    { message: "Deleting another device did not resume the pending connection" },
  );
  assert.equal(resumed.snapshot.error, null);
  assert.equal(enrollments.length, 4);
  assert.equal(enrollments[2].public_key, enrollments[3].public_key);
  assert.equal(await page.locator("#settingsPanel").evaluate((node) => node.open), false);
  record(
    "Revoked-device quota opens device management and removing another device resumes with the same candidate key",
  );

  await page.locator("#refreshDevicesButton").click();
  await page
    .locator('.delete-device-button[data-focus-key="synthetic-browser-3"]')
    .waitFor({ state: "visible" });
  page.once("dialog", (dialog) => dialog.accept());
  await page.locator('.delete-device-button[data-focus-key="synthetic-browser-3"]').click();
  await page.locator("#confirmationAcceptButton").click();
  await waitForRead(
    () => command(page, { type: "get_snapshot" }),
    ({ snapshot }) => snapshot.status === "disconnected" && snapshot.currentDeviceId === null,
    { message: "Deleting the current device did not leave it disconnected" },
  );
  await page.locator("#closeDevicesButton").click();
  await rendered(page);
  assert.equal(await page.locator("#settingsPanel").evaluate((node) => node.open), false);
  assert.equal(await page.evaluate(() => document.activeElement?.id), "settingsButton");
  assert.equal(enrollmentCount, 3);
  record(
    "Deleting the current device stays disconnected and quota management closes back to the main view",
  );

  quotaReached = true;
  devices.push({
    device_id: "quota-device",
    name: "Another browser",
    kind: "browser_extension",
    created_at: "2026-01-02T12:00:00.000Z",
    profiles: [],
  });
  const plainQuota = await command(page, { type: "connect", locationId: "popup-fr" });
  assert.equal(plainQuota.snapshot.error, "device_limit");
  await page.locator("#errorManageDevicesButton").waitFor({ state: "visible" });
  assert.equal(
    await page.locator("#errorMessage").textContent(),
    frenchCatalog.error_device_limit.message,
  );
  await page.locator("#errorManageDevicesButton").click();
  await page
    .locator('.delete-device-button[data-focus-key="quota-device"]')
    .waitFor({ state: "visible" });
  await page.waitForFunction(() => !document.getElementById("refreshDevicesButton").disabled);
  page.once("dialog", (dialog) => dialog.accept());
  await page.locator('.delete-device-button[data-focus-key="quota-device"]').click();
  await page.locator("#confirmationAcceptButton").click();
  await waitForRead(
    () => command(page, { type: "get_snapshot" }),
    ({ snapshot }) => snapshot.status === "connected" && snapshot.error === null,
    { message: "Deleting another device did not resume a simple quota failure" },
  );
  await page.locator("#closeDevicesButton").click();
  await command(page, { type: "disconnect" });
  record("A simple device quota has its own message and resumes automatically after removal");

  // Capture a signed-in state, then hold icon updates while the actual logout
  // reply reaches the popup. Neither a queued publication nor an older version
  // may restore the account afterward.
  const staleAccount = (await command(page, { type: "get_snapshot" })).snapshot;
  assert.ok(staleAccount.snapshotVersion);
  await page.locator("#settingsButton").click();
  await worker.evaluate(() => {
    const original = chrome.action.setTitle.bind(chrome.action);
    globalThis.popupAuditGates = [];
    globalThis.popupAuditReleased = false;
    chrome.action.setTitle = async (...args) => {
      await original(...args);
      if (!globalThis.popupAuditReleased) {
        await new Promise((resolve) => globalThis.popupAuditGates.push(resolve));
      }
    };
    globalThis.popupAuditRestore = () => {
      chrome.action.setTitle = original;
      globalThis.popupAuditReleased = true;
      for (const release of globalThis.popupAuditGates) release();
    };
  });
  await command(page, { type: "set_language_preference", preference: "fr" });
  await page.waitForFunction(() => document.getElementById("settingsPanel").open);
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (await worker.evaluate(() => globalThis.popupAuditGates.length > 0)) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(await worker.evaluate(() => globalThis.popupAuditGates.length > 0), true);
  await page.locator("#logoutButton").click();
  await page.locator("#loginView").waitFor({ state: "visible" });
  assert.equal((await command(page, { type: "get_snapshot" })).snapshot.profile, null);
  await worker.evaluate(() => globalThis.popupAuditGates[0]());
  await rendered(page);
  assert.equal(await page.locator("#mainView").isVisible(), false);
  assert.equal(await page.locator("#accountEmail").textContent(), "");
  record("A delayed native publication cannot restore the account after completed logout");
  await worker.evaluate(async (snapshot) => {
    await chrome.runtime.sendMessage({ type: "state_changed", snapshot });
  }, staleAccount);
  await rendered(page);
  assert.equal(await page.locator("#mainView").isVisible(), false);
  assert.equal(await page.locator("#accountEmail").textContent(), "");
  assert.equal(await page.locator("#loginErrorBanner").isVisible(), false);
  record("The popup ignores an older native snapshot revision without reviving account data");
  await worker.evaluate(() => globalThis.popupAuditRestore());

  assert.deepEqual(report.pageErrors, []);
  record("All popup regressions complete without uncaught browser exceptions");
  report.completed = true;
} catch (error) {
  report.failure = String(error.stack ?? error);
  process.exitCode = 1;
} finally {
  if (context) await context.close();
  await writeFile(
    join(output, "browser-popup-regressions.json"),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`Report: ${join(output, "browser-popup-regressions.json")}\n`);
}
