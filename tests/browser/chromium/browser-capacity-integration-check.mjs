import { installSyntheticWebAuth, assertSyntheticTokenRequest } from "./synthetic-web-auth.mjs";
// SPDX-License-Identifier: MPL-2.0

// Built extension worker and native browser APIs; all server data is synthetic.
// Optional: CHROME_EXTENSION_DIR, PLAYWRIGHT_MODULE_PATH, CHROMIUM_EXECUTABLE,
// CAPACITY_INTEGRATION_OUTPUT. No production connection or credentials are used.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { waitForRead } from "../../../scripts/browser-wait.mjs";

const root = resolve(import.meta.dirname, "../../..");
const playwright =
  process.env.PLAYWRIGHT_MODULE_PATH ??
  join(
    homedir(),
    ".cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs",
  );
const { chromium } = await import(pathToFileURL(resolve(playwright)).href);
const temporary = await mkdtemp(join(tmpdir(), "capacity-"));
const output = resolve(process.env.CAPACITY_INTEGRATION_OUTPUT ?? temporary);
await mkdir(output, { recursive: true });
const extension = resolve(process.env.CHROME_EXTENSION_DIR ?? join(root, "dist/chrome"));
const report = {
  timestamp: new Date().toISOString(),
  scope: "Built worker and popup; isolated Chromium profile; intercepted synthetic API only",
  limitations: ["No production capacity measurement or traffic tunnel is validated."],
  checks: [],
  pageErrors: [],
};
const france = {
  id: "capacity-fr",
  city: "Paris",
  country_code: "FR",
  display_name: "Paris capacity fixture",
  supported_protocols: ["browser_proxy"],
};
const germany = {
  ...france,
  id: "capacity-de",
  city: "Frankfurt",
  country_code: "DE",
  display_name: "Frankfurt capacity fixture",
};
const requests = [];
const enrollmentKeys = [];
const createdDevices = [];
let catalog = [france, germany];
let mode = "server_full";
let failRefreshAfterRefusal = false;
let failNextCatalog = false;
let sessionSequence = 0;
let context;
let workerUrl;

function count(path, method = "GET") {
  return requests.filter((request) => request.path === path && request.method === method).length;
}
function counts() {
  return {
    locations: count("/v1/locations"),
    profiles: count("/v1/me"),
    subscriptions: count("/v1/billing/subscription"),
    creations: count("/v1/proxy/sessions", "POST"),
    enrollments: enrollmentKeys.length,
  };
}
function record(name) {
  report.checks.push({ name, passed: true });
  process.stdout.write(`PASS ${name}\n`);
}
async function command(page, request) {
  if (request.type === "web_login") await installSyntheticWebAuth(context);
  return page.evaluate((value) => chrome.runtime.sendMessage(value), request);
}
async function snapshot(page) {
  return (await command(page, { type: "get_snapshot" })).snapshot;
}
async function security(page) {
  return page.evaluate(async () => ({
    state: (await chrome.storage.local.get("fuzevpnSecurityState")).fuzevpnSecurityState,
    alarms: (await chrome.alarms.getAll()).map(({ name }) => name),
  }));
}
async function reply(route, status, body, headers = {}) {
  await route.fulfill({
    status,
    headers,
    ...(body === undefined ? {} : { contentType: "application/json", body: JSON.stringify(body) }),
  });
}
async function restartWorker(page) {
  const cdp = await context.newCDPSession(page);
  const versions = new Map();
  cdp.on("ServiceWorker.workerVersionUpdated", ({ versions: changed }) => {
    for (const version of changed) versions.set(version.versionId, version);
  });
  try {
    await cdp.send("ServiceWorker.enable");
    const version = await waitForRead(
      () =>
        [...versions.values()].find(
          (value) => value.scriptURL === workerUrl && value.runningStatus === "running",
        ),
      Boolean,
      { message: "Running worker was not discovered", timeoutMs: 5000 },
    );
    await cdp.send("ServiceWorker.stopWorker", { versionId: version.versionId });
    await waitForRead(
      () => versions.get(version.versionId),
      (value) => value?.runningStatus === "stopped",
      { message: "Worker did not stop", timeoutMs: 5000 },
    );
    return await snapshot(page);
  } finally {
    await cdp.detach();
  }
}

try {
  context = await chromium.launchPersistentContext(join(temporary, "profile"), {
    channel: "chromium",
    headless: true,
    viewport: { width: 360, height: 600 },
    ...(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : {}),
    args: [
      `--disable-extensions-except=${extension}`,
      `--load-extension=${extension}`,
      "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1, EXCLUDE [::1]",
      "--disable-background-networking",
    ],
  });
  context.setDefaultTimeout(15000);
  report.chromium = context.browser().version();
  await context.route(/^https?:\/\//, (route) => route.abort("blockedbyclient"));
  await context.route(/^https:\/\/api(?:64)?\.ipify\.org\//, (route) =>
    reply(route, 200, { ip: "203.0.113.8" }),
  );
  await context.route("https://api.fuzevpn.com/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    const method = route.request().method();
    requests.push({ path, method });
    if (path === "/v1/auth/extension/token") {
      await assertSyntheticTokenRequest(context, route.request());
      return reply(route, 201, {
        access_token: "synthetic-capacity-token",
        expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      });
    }
    if (path === "/v1/me")
      return reply(route, 200, {
        user_id: "capacity-user",
        email: "capacity@example.invalid",
        first_name: "Capacity",
        last_name: "Fixture",
        country_code: "FR",
      });
    if (path === "/v1/billing/subscription")
      return reply(route, 200, {
        status: "active",
        has_access: true,
        offer_id: "synthetic",
        started_at: null,
        expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        renews_automatically: false,
      });
    if (path === "/v1/locations") {
      if (failNextCatalog) {
        failNextCatalog = false;
        return reply(route, 503, { error: "server_error" });
      }
      return reply(route, 200, { locations: catalog });
    }
    if (path === "/v1/devices/browser") {
      const body = route.request().postDataJSON();
      enrollmentKeys.push(body.public_key);
      const device = {
        device_id: "capacity-browser-device",
        name: body.name,
        kind: "browser_extension",
        created_at: new Date().toISOString(),
      };
      createdDevices.push({ ...device, profiles: [] });
      return reply(route, 201, device);
    }
    if (path === "/v1/devices") return reply(route, 200, { limit: 5, devices: createdDevices });
    if (path === "/v1/proxy/sessions" && method === "POST") {
      const locationId = route.request().postDataJSON().location_id;
      if (mode === "server_full") {
        catalog = catalog.filter(({ id }) => id !== locationId);
        if (failRefreshAfterRefusal) failNextCatalog = true;
        return reply(route, 409, { error: "server_full" });
      }
      if (mode === "capacity_unavailable")
        return reply(route, 503, { error: "capacity_unavailable" }, { "Retry-After": "120" });
      const id = `capacity-session-${++sessionSequence}`;
      return reply(route, 201, {
        id,
        location_id: locationId,
        scheme: "https",
        host: "synthetic.capacity.proxy.invalid",
        port: 443,
        username: id,
        password: "synthetic-proxy-password",
        issued_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 1_200_000).toISOString(),
        refresh_after_seconds: 900,
      });
    }
    if (
      path === "/v1/auth/logout" ||
      (path.startsWith("/v1/proxy/sessions/") && method === "DELETE")
    )
      return reply(route, 204);
    return reply(route, 404, { error: "not_found" });
  });
  const worker =
    context.serviceWorkers()[0] ??
    (await context.waitForEvent("serviceworker", { timeout: 15000 }));
  workerUrl = worker.url();
  const page = await context.newPage();
  page.on("pageerror", (error) => report.pageErrors.push(String(error)));
  await page.goto(`chrome-extension://${workerUrl.split("/")[2]}/popup/popup.html`);
  assert.equal((await command(page, { type: "web_login", disconnectFirst: false })).ok, true);
  await page.locator("#mainView").waitFor({ state: "visible" });
  await page.waitForFunction(
    () => document.getElementById("refreshSubscriptionButton").getAttribute("aria-busy") !== "true",
  );
  const beforeRefresh = counts();
  assert.equal((await command(page, { type: "refresh_locations" })).ok, true);
  assert.deepEqual(counts(), { ...beforeRefresh, locations: beforeRefresh.locations + 1 });
  record(
    "Manual catalog refresh makes one locations request without reloading account or subscription",
  );

  assert.equal((await command(page, { type: "select_location", locationId: france.id })).ok, true);
  await command(page, { type: "set_location_favorite", locationId: france.id, favorite: true });
  const beforeFull = counts();
  const full = await command(page, { type: "connect", locationId: france.id });
  assert.equal(full.ok, false);
  assert.equal(full.commandError, "server_full");
  assert.equal(full.snapshot.error, "server_full");
  assert.equal(full.snapshot.protected, false);
  assert.equal(full.snapshot.selectedLocationId, france.id);
  assert.deepEqual(
    full.snapshot.locations.map(({ id }) => id),
    [germany.id],
  );
  assert.equal(counts().creations, beforeFull.creations + 1);
  assert.equal(counts().locations, beforeFull.locations + 2);
  assert.equal(counts().profiles, beforeFull.profiles + 1);
  assert.equal(counts().subscriptions, beforeFull.subscriptions + 1);
  const deviceId = full.snapshot.currentDeviceId;
  assert.equal(deviceId, "capacity-browser-device");
  record(
    "Capacity becoming full after listing causes one refused POST and one additional catalog refresh",
  );

  const blocked = await security(page);
  assert.equal(blocked.state.capacityBlockedLocationId, france.id);
  assert.equal(blocked.state.proxyCreationUncertain, false);
  assert.equal(blocked.state.retrySuspended, true);
  assert(!blocked.alarms.includes("fuzevpn-proxy-reconnect"));
  assert(!blocked.alarms.includes("fuzevpn-proxy-refresh"));
  const creationsBeforeRestart = counts().creations;
  const restarted = await restartWorker(page);
  assert.equal(restarted.error, "server_full");
  assert.equal(restarted.currentDeviceId, deviceId);
  assert.equal(counts().creations, creationsBeforeRestart);
  assert.equal((await security(page)).state.capacityBlockedLocationId, france.id);
  record(
    "A real worker restart preserves the full target suspension without recreating the device or session",
  );

  catalog = [];
  const empty = await command(page, { type: "refresh_locations" });
  assert.equal(empty.ok, true);
  assert.deepEqual(empty.snapshot.locations, []);
  assert.equal(empty.snapshot.selectedLocationId, france.id);
  assert.equal(empty.snapshot.error, "server_full");
  catalog = [france, germany];
  const returned = await command(page, { type: "refresh_locations" });
  assert.equal(returned.snapshot.selectedLocationId, france.id);
  assert(returned.snapshot.locationPreferences.favoriteIds.includes(france.id));
  assert.equal(counts().creations, creationsBeforeRestart);
  record(
    "An empty then restored catalog preserves manual selection and favorites without connecting elsewhere",
  );

  failRefreshAfterRefusal = true;
  const failedRefresh = await command(page, { type: "retry_connection" });
  failRefreshAfterRefusal = false;
  assert.equal(failedRefresh.commandError, "server_full");
  assert.equal(failedRefresh.snapshot.error, "server_full");
  assert.deepEqual(
    failedRefresh.snapshot.locations.map(({ id }) => id),
    [germany.id],
  );
  assert.equal(failedRefresh.snapshot.currentDeviceId, deviceId);
  assert.equal(enrollmentKeys.length, 1);
  record(
    "A failed catalog reload retains the capacity refusal and other locations while hiding the full target",
  );

  await command(page, { type: "disconnect" });
  catalog = [france, germany];
  await command(page, { type: "refresh_locations" });
  mode = "capacity_unavailable";
  const beforeCapacity = counts();
  const capacity = await command(page, { type: "connect", locationId: france.id });
  assert.equal(capacity.commandError, "capacity_unavailable");
  assert.equal(capacity.snapshot.error, "capacity_unavailable");
  assert.equal(capacity.snapshot.currentDeviceId, deviceId);
  assert.equal(capacity.commandRetryAfterSeconds, 120);
  assert(capacity.snapshot.nextRetryAt >= Date.now() + 115_000);
  assert.equal(counts().creations, beforeCapacity.creations + 1);
  assert.equal(counts().locations, beforeCapacity.locations + 2);
  const capacitySecurity = await security(page);
  assert.equal(capacitySecurity.state.proxyCreationUncertain, false);
  assert.equal(capacitySecurity.state.capacityBlockedLocationId, null);
  assert(capacitySecurity.alarms.includes("fuzevpn-proxy-reconnect"));
  record(
    "HTTP 503 capacity refusal refreshes the catalog, preserves identity and honors Retry-After without creation uncertainty",
  );

  await command(page, { type: "disconnect" });
  mode = "healthy";
  const connected = await command(page, { type: "connect", locationId: france.id });
  assert.equal(connected.ok, true);
  assert.equal(connected.snapshot.protected, true);
  mode = "server_full";
  const beforeChange = counts();
  const changed = await command(page, { type: "change_location", locationId: germany.id });
  assert.equal(changed.commandError, "server_full");
  assert.equal(changed.snapshot.protected, true);
  assert.equal(changed.snapshot.activeLocationId, france.id);
  assert.equal(changed.snapshot.activeLocation.id, france.id);
  assert.deepEqual(
    changed.snapshot.locations.map(({ id }) => id),
    [france.id],
  );
  assert.equal(counts().creations, beforeChange.creations + 1);
  assert.equal(counts().locations, beforeChange.locations + 2);
  assert.equal(enrollmentKeys.length, 1);
  record(
    "Changing to a full location preserves the valid preceding session and never switches to another target",
  );

  assert.equal(changed.snapshot.selectedLocationId, germany.id);
  assert.equal(
    await page.evaluate(
      async () => (await chrome.storage.local.get("fuzevpnState")).fuzevpnState.selectedLocationId,
    ),
    germany.id,
  );
  const creationsBeforeChangeRestart = counts().creations;
  await restartWorker(page);
  const restoredChange = await command(page, { type: "refresh_account" });
  assert.equal(restoredChange.snapshot.selectedLocationId, germany.id);
  assert.equal(restoredChange.snapshot.activeLocationId, france.id);
  assert.equal(restoredChange.snapshot.activeLocation.id, france.id);
  assert.equal(restoredChange.snapshot.protected, true);
  assert.equal(restoredChange.snapshot.error, "server_full");
  assert.equal(counts().creations, creationsBeforeChangeRestart);
  assert.equal((await security(page)).state.capacityBlockedLocationId, germany.id);
  record(
    "Restart and account refresh preserve the refused manual target independently of the retained active session",
  );

  await command(page, { type: "disconnect" });
  mode = "healthy";
  assert.equal((await command(page, { type: "connect", locationId: france.id })).ok, true);
  mode = "capacity_unavailable";
  const beforeRenewal = counts();
  const renewal = await command(page, { type: "retry_connection" });
  assert.equal(renewal.commandError, "capacity_unavailable");
  assert.equal(renewal.snapshot.protected, true);
  assert.equal(renewal.snapshot.activeLocationId, france.id);
  assert.equal(counts().creations, beforeRenewal.creations + 1);
  assert.equal(counts().locations, beforeRenewal.locations + 1);
  assert.equal(counts().profiles, beforeRenewal.profiles);
  assert.equal(counts().subscriptions, beforeRenewal.subscriptions);
  assert.equal(enrollmentKeys.length, 1);
  record(
    "Renewal capacity refusal refreshes only locations and keeps the verified previous session",
  );
  await command(page, { type: "disconnect" });
  assert.equal((await snapshot(page)).protectionRequested, false);
  assert.equal(count("/v1/locations/availability"), 0);
  assert.deepEqual(report.pageErrors, []);
  record(
    "Capacity flows use no availability endpoint and finish without uncaught popup exceptions",
  );
  report.completed = true;
  report.requestCounts = counts();
} catch (error) {
  report.failure = String(error.stack ?? error);
  process.exitCode = 1;
} finally {
  if (context) await context.close();
  await writeFile(join(output, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`Report: ${join(output, "report.json")}\n`);
}
