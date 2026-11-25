// SPDX-License-Identifier: MPL-2.0

// Built extension worker and popup against a synthetic account API which holds the
// choice of the account for the ad blocker; no filtering is exercised.
// Optional: CHROME_EXTENSION_DIR, PLAYWRIGHT_MODULE_PATH, CHROMIUM_EXECUTABLE,
// AD_BLOCKER_OUTPUT. No production connection or credentials are used.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { waitForRead } from "../../../scripts/browser-wait.mjs";
import { reportErrorEvents } from "./page-error-events.mjs";
import { installSyntheticWebAuth, assertSyntheticTokenRequest } from "./synthetic-web-auth.mjs";

const root = resolve(import.meta.dirname, "../../..");
const playwright =
  process.env.PLAYWRIGHT_MODULE_PATH ??
  join(
    homedir(),
    ".cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs",
  );
const { chromium } = await import(pathToFileURL(resolve(playwright)).href);
const temporary = await mkdtemp(join(tmpdir(), "ad-blocker-"));
const output = resolve(process.env.AD_BLOCKER_OUTPUT ?? temporary);
await mkdir(output, { recursive: true });
const extension = resolve(process.env.CHROME_EXTENSION_DIR ?? join(root, "dist/chrome"));
const french = JSON.parse(await readFile(join(extension, "_locales/fr/messages.json"), "utf8"));
const report = {
  timestamp: new Date().toISOString(),
  scope:
    "Built worker and popup; isolated Chromium profile; intercepted synthetic API which records the choice of the account",
  limitations: [
    "No production account is used, and no advertising domain is resolved or blocked: the suite covers the setting, not the filtering which the service applies.",
  ],
  checks: [],
  pageErrors: [],
};
const token = "synthetic-ad-blocker-token";
const location = {
  id: "ad-blocker-fr",
  city: "Paris",
  country_code: "FR",
  display_name: "Paris ad blocker fixture",
  supported_protocols: ["browser_proxy"],
};
/** What the synthetic service holds for the account, and how it answers next. */
const service = { adBlocking: false, available: true, updatedAt: null, mode: "normal" };
/** Every request about the ad blocker: its method, credential and body. */
const filterRequests = [];
let sessions = 0;
let context;

function record(name, details) {
  report.checks.push({ name, passed: true, ...(details === undefined ? {} : { details }) });
  process.stdout.write(`PASS ${name}\n`);
}
async function reply(route, status, body, headers = {}) {
  await route.fulfill({
    status,
    headers: { "cache-control": "no-store", ...headers },
    ...(body === undefined ? {} : { contentType: "application/json", body: JSON.stringify(body) }),
  });
}
async function command(page, request) {
  if (request.type === "web_login") await installSyntheticWebAuth(context);
  return page.evaluate((value) => chrome.runtime.sendMessage(value), request);
}
async function snapshot(page) {
  return (await command(page, { type: "get_snapshot" })).snapshot;
}
/** What the settings show of the ad blocker. */
function view(page) {
  return page.evaluate(() => {
    const at = (id) => document.getElementById(id);
    const shown = (node) => node.getClientRects().length > 0;
    const control = at("adBlockingEnabled");
    return {
      row: shown(at("adBlockingRow")),
      checked: control.checked,
      disabled: control.disabled,
      busy: control.getAttribute("aria-busy"),
      note: shown(at("adBlockingNote")) ? at("adBlockingNote").textContent : null,
      banner: shown(at("errorBanner")),
    };
  });
}
/** The control once no request about it is on its way. */
function settled(page, matches = () => true) {
  return waitForRead(
    () => view(page),
    (value) => value.busy === "false" && matches(value),
    { message: "the ad blocker settled" },
  );
}
const sent = (from = 0) => filterRequests.slice(from).map(({ method, body }) => body ?? method);

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
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const method = request.method();
    if (path === "/v1/me/dns-filter") {
      const body = method === "PUT" ? request.postData() : null;
      filterRequests.push({
        method,
        authorization: (await request.allHeaders()).authorization ?? null,
        body,
      });
      if (service.mode === "limited")
        return reply(route, 429, { error: "rate_limited" }, { "retry-after": "30" });
      if (service.mode === "missing") return reply(route, 404, { error: "not_found" });
      if (method === "PUT") {
        // The contract of the route: the whole choice, and nothing else.
        const choice = JSON.parse(body);
        if (Object.keys(choice).join() !== "ad_blocking" || typeof choice.ad_blocking !== "boolean")
          return reply(route, 400, { error: "invalid_request" });
        service.adBlocking = choice.ad_blocking;
        service.updatedAt = new Date().toISOString();
      } else if (method !== "GET") return reply(route, 404, { error: "not_found" });
      return reply(route, 200, {
        ad_blocking: service.adBlocking,
        available: service.available,
        updated_at: service.updatedAt,
      });
    }
    if (path === "/v1/auth/extension/token") {
      await assertSyntheticTokenRequest(context, request);
      return reply(route, 201, {
        access_token: token,
        expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      });
    }
    if (path === "/v1/me")
      return reply(route, 200, {
        user_id: "ad-blocker-user",
        email: "ad-blocker@example.invalid",
        first_name: "Ad",
        last_name: "Blocker",
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
    if (path === "/v1/locations") return reply(route, 200, { locations: [location] });
    if (path === "/v1/devices/browser") {
      const body = request.postDataJSON();
      return reply(route, 201, {
        device_id: "ad-blocker-device",
        name: body.name,
        kind: "browser_extension",
        created_at: new Date().toISOString(),
      });
    }
    if (path === "/v1/devices") return reply(route, 200, { limit: 5, devices: [] });
    if (path === "/v1/proxy/sessions" && method === "POST") {
      const id = `ad-blocker-session-${String(++sessions)}`;
      return reply(route, 201, {
        id,
        location_id: location.id,
        scheme: "https",
        host: "synthetic.ad-blocker.proxy.invalid",
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
  const url = `chrome-extension://${worker.url().split("/")[2]}/popup/popup.html`;
  const open = async () => {
    const page = await context.newPage();
    page.on("pageerror", (error) => report.pageErrors.push(error.message));
    await reportErrorEvents(page, (message) => report.pageErrors.push(message));
    await page.goto(url);
    return page;
  };
  let page = await open();
  assert.equal((await command(page, { type: "web_login", disconnectFirst: false })).ok, true);
  await page.locator("#mainView").waitFor({ state: "visible" });
  assert.equal(
    (await command(page, { type: "set_language_preference", preference: "fr" })).ok,
    true,
  );
  await page.waitForFunction(() => document.documentElement.lang === "fr");
  const connected = await command(page, { type: "connect", locationId: location.id });
  assert.equal(connected.ok, true, JSON.stringify(connected));

  // Signing in, connecting and showing the main view ask nothing about the ad blocker.
  assert.deepEqual(sent(), []);
  assert.deepEqual((await snapshot(page)).adBlocking, { enabled: null, available: true });
  await page.locator("#settingsButton").click();
  let shown = await settled(page, (value) => !value.disabled);
  assert.deepEqual(sent(), ["GET"]);
  assert.equal(filterRequests[0].authorization, `Bearer ${token}`);
  assert.deepEqual(shown, {
    row: true,
    checked: false,
    disabled: false,
    busy: "false",
    note: null,
    banner: false,
  });
  record("The choice of the account is read with its credential when the settings open");

  // One click records the choice: the body is the whole choice, and the connection is
  // left alone, with the session it had.
  await page.locator("#adBlockingEnabled").click();
  shown = await settled(page, (value) => value.checked);
  assert.deepEqual(sent(1), ['{"ad_blocking":true}']);
  assert.equal(filterRequests[1].authorization, `Bearer ${token}`);
  assert.equal(service.adBlocking, true);
  assert.equal(shown.note, null);
  let state = await snapshot(page);
  assert.deepEqual(state.adBlocking, { enabled: true, available: true });
  assert.equal(state.protected, true);
  assert.equal(state.error, null);
  assert.equal(sessions, 1);
  await page.screenshot({ path: join(output, "ad-blocker-on.png"), animations: "disabled" });
  record("A click records the choice with the service and leaves the connection as it was", {
    proxySessionsCreated: sessions,
  });

  // Another popup shows what the worker holds at once, then reads the account again
  // when its settings open: another device may have changed the choice meanwhile.
  await page.close();
  service.adBlocking = false;
  page = await open();
  await page.locator("#mainView").waitFor({ state: "visible" });
  let from = filterRequests.length;
  await page.locator("#settingsButton").click();
  shown = await settled(page, (value) => !value.checked);
  assert.deepEqual(sent(from), ["GET"]);
  assert.deepEqual((await snapshot(page)).adBlocking, { enabled: false, available: true });
  record(
    "Each opening of the settings reads the choice again, as another device may have changed it",
  );

  // The service has turned the blocker off for everyone: the popup says so, and the
  // choice can still be changed.
  await page.locator("#closeSettingsButton").click();
  service.available = false;
  await page.locator("#settingsButton").click();
  shown = await settled(page, (value) => value.note !== null);
  assert.equal(shown.note, french.adBlockerPaused.message);
  assert.equal(shown.disabled, false);
  from = filterRequests.length;
  await page.locator("#adBlockingEnabled").click();
  shown = await settled(page, (value) => value.checked);
  assert.deepEqual(sent(from), ['{"ad_blocking":true}']);
  assert.equal(shown.note, french.adBlockerPaused.message);
  await page.screenshot({ path: join(output, "ad-blocker-paused.png"), animations: "disabled" });
  service.available = true;
  record(
    "A blocker which the service has turned off for everyone is said so, its choice staying changeable",
  );

  // A refusal of the service: the control returns to the recorded choice, a note says
  // so, and neither the connection nor its error is concerned.
  service.mode = "limited";
  from = filterRequests.length;
  await page.locator("#adBlockingEnabled").click();
  shown = await settled(page, (value) => value.note === french.adBlockerFailed.message);
  assert.deepEqual(sent(from), ['{"ad_blocking":false}']);
  assert.equal(shown.checked, true);
  assert.equal(shown.banner, false);
  assert.equal(service.adBlocking, true);
  state = await snapshot(page);
  assert.equal(state.error, null);
  assert.equal(state.protected, true);
  assert.deepEqual(state.adBlocking, { enabled: true, available: false });
  await page.screenshot({ path: join(output, "ad-blocker-failed.png"), animations: "disabled" });
  service.mode = "normal";
  await page.locator("#adBlockingEnabled").click();
  shown = await settled(page, (value) => !value.checked);
  assert.equal(shown.note, null);
  assert.equal(service.adBlocking, false);
  record(
    "A change which the service refuses is said beside the setting, and changes nothing of the connection",
  );

  // A service without the route: the reading fails, and is said the same way.
  await page.locator("#closeSettingsButton").click();
  service.mode = "missing";
  await page.locator("#settingsButton").click();
  shown = await settled(page, (value) => value.note !== null);
  assert.equal(shown.note, french.adBlockerFailed.message);
  assert.equal(shown.banner, false);
  assert.equal((await snapshot(page)).error, null);
  service.mode = "normal";
  record("A reading which fails is said beside the setting, without an error of the connection");

  // Signed out, the worker holds no choice, and the next account starts from nothing.
  await page.locator("#closeSettingsButton").click();
  assert.equal((await command(page, { type: "logout" })).ok, true);
  await page.locator("#loginView").waitFor({ state: "visible" });
  assert.deepEqual((await snapshot(page)).adBlocking, { enabled: null, available: true });
  await page.locator("#settingsButton").click();
  assert.equal((await view(page)).row, false);
  from = filterRequests.length;
  await new Promise((done) => setTimeout(done, 300));
  assert.deepEqual(sent(from), []);
  assert.deepEqual(report.pageErrors, []);
  record("Signed out, no choice is kept, shown or asked, and the popup reported no error", {
    requests: filterRequests.length,
  });
  report.completed = true;
} catch (error) {
  report.failure = String(error.stack ?? error);
  process.exitCode = 1;
} finally {
  if (context) await context.close();
  await writeFile(join(output, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`Report: ${join(output, "report.json")}\n`);
}
