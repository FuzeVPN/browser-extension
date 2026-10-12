import { installSyntheticWebAuth, assertSyntheticTokenRequest } from "./synthetic-web-auth.mjs";
// SPDX-License-Identifier: MPL-2.0

// Real built worker and diagnostics page; all network replies are synthetic.
// Install interception BEFORE loading the extension. Never fall back to startup loading.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { waitForRead } from "../../../scripts/browser-wait.mjs";

const root = resolve(import.meta.dirname, "../../..");
const extension = resolve(process.env.CHROME_EXTENSION_DIR || join(root, "dist/chrome"));
const output = resolve(
  process.env.DIAGNOSTICS_INTEGRATION_OUTPUT ||
    join(root, "security-audit/diagnostics/browser-integration"),
);
if (relative(root, output).startsWith("..")) throw new Error("Output must stay inside Chrome");
if (!process.env.PLAYWRIGHT_MODULE_PATH || !process.env.CHROMIUM_EXECUTABLE)
  throw new Error("Use the scoped browser validation runner");
const { chromium } = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE_PATH).href);
await mkdir(output, { recursive: true });
const temporary = await mkdtemp(join(tmpdir(), "fuzevpn-diagnostics-integration-"));
const evidence = {
  scope:
    "Built diagnostics page and service worker; isolated profile; synthetic API and IP replies",
  limitations: [
    "Interception tests application behavior, not production VPN transport or server receipt.",
  ],
  checks: [],
  pageErrors: [],
  blockedRequests: [],
  unexpectedApiRequests: [],
};
const posts = [];
const routeErrors = [];
let ipRequests = 0;
let deviceFailure = false;
let connectFailure = false;
let diagnosticStatus = 201;
let sessionNumber = 0;
let loginNumber = 0;
let extensionId;
let context;
let page;
const locationId = "diagnostics-fr";
const directIp = "81.2.69.142";
const vpnIp = "185.159.157.10";
const accountEmail = "diagnostics@example.invalid";
const deliveryKey = "fuzevpnDiagnosticDelivery";
const record = (name) => {
  evidence.checks.push({ name, passed: true });
  process.stdout.write(`PASS ${name}\n`);
};
const reply = (route, status, body) =>
  route.fulfill({
    status,
    headers: { "Cache-Control": "no-store" },
    ...(body === undefined ? {} : { contentType: "application/json", body: JSON.stringify(body) }),
  });
const secretFixtures = [
  accountEmail,
  "diagnostics-user",
  "synthetic-login-password",
  "synthetic-diagnostics-token",
  "synthetic-proxy-user",
  "synthetic-proxy-password",
  "synthetic-diagnostics-browser",
  "unavailable.proxy.diagnostics.invalid",
  directIp,
  vpnIp,
];

function assertSanitized(report) {
  const text = JSON.stringify(report);
  for (const secret of secretFixtures)
    assert(!text.includes(secret), "A report exposed a fixture identifier or secret");
  assert.doesNotMatch(
    text,
    /https?:\/\/|Bearer |@|"(?:email|token|password|hostname|user_id|device_id|location_id|url|ip)"/i,
  );
  assert.equal(report.schema_version, 1);
  assert.equal(report.platform, "chrome_extension");
  assert.match(report.report_id, /^[0-9a-f]{8}-[0-9a-f-]{27}$/);
  assert.equal(report.consent.notice_version, 1);
  assert(Buffer.byteLength(text) <= (report.report_type === "simple" ? 8192 : 131072));
}

async function intercept(route) {
  const request = route.request();
  const url = new URL(request.url());
  if (url.protocol === "chrome-extension:") return route.continue();
  if (
    ["https://api.ipify.org", "https://api64.ipify.org"].includes(url.origin) &&
    url.pathname === "/" &&
    url.search === "?format=json" &&
    request.method() === "GET"
  ) {
    ipRequests++;
    return reply(route, 200, { ip: url.origin === "https://api.ipify.org" ? vpnIp : directIp });
  }
  if (url.origin !== "https://api.fuzevpn.com") {
    evidence.blockedRequests.push(`${url.protocol}//${url.host}${url.pathname}`);
    return route.abort("blockedbyclient");
  }
  const path = url.pathname;
  const method = request.method();
  if (path === "/v1/diagnostics" && method === "POST") {
    const body = request.postDataJSON();
    assertSanitized(body);
    const headers = await request.allHeaders();
    assert.equal(headers.authorization, `Bearer synthetic-diagnostics-token-${loginNumber}`);
    assert.match(headers["content-type"], /^application\/json/);
    assert.equal(headers.cookie, undefined);
    posts.push({ body, text: request.postData(), status: diagnosticStatus });
    if (diagnosticStatus === 201 || diagnosticStatus === 200)
      return reply(route, diagnosticStatus, {
        report_id: `b1000000-0000-4000-8000-${String(posts.length).padStart(12, "0")}`,
        client_report_id: body.report_id,
        received_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 30 * 86400000).toISOString(),
        status: "received",
        duplicate: diagnosticStatus === 200,
      });
    return reply(route, diagnosticStatus, {
      error: diagnosticStatus === 401 ? "unauthorized" : "unavailable",
    });
  }
  if (path === "/v1/auth/extension/token" && method === "POST") {
    await assertSyntheticTokenRequest(context, request);
    return reply(route, 201, {
      access_token: `synthetic-diagnostics-token-${++loginNumber}`,
      expires_at: new Date(Date.now() + 3600000).toISOString(),
    });
  }
  if (path === "/v1/me" && method === "GET")
    return reply(route, 200, {
      user_id: "diagnostics-user",
      email: accountEmail,
      first_name: "Synthetic",
      last_name: "Diagnostics",
      country_code: "FR",
    });
  if (path === "/v1/billing/subscription" && method === "GET")
    return reply(route, 200, {
      status: "active",
      has_access: true,
      offer_id: "synthetic",
      started_at: null,
      expires_at: new Date(Date.now() + 3600000).toISOString(),
      renews_automatically: false,
    });
  if (path === "/v1/locations" && method === "GET")
    return reply(route, 200, {
      locations: [
        {
          id: locationId,
          city: "Paris",
          country_code: "FR",
          display_name: "Synthetic",
          supported_protocols: ["browser_proxy"],
        },
      ],
    });
  if (path === "/v1/devices/browser" && method === "POST")
    return reply(route, 201, {
      device_id: "synthetic-diagnostics-browser",
      name: "Synthetic browser",
      kind: "browser_extension",
      created_at: new Date().toISOString(),
    });
  if (path === "/v1/devices" && method === "GET")
    return reply(
      route,
      200,
      deviceFailure ? { devices: "invalid synthetic fixture" } : { limit: 5, devices: [] },
    );
  if (path === "/v1/proxy/sessions" && method === "POST") {
    if (connectFailure) return reply(route, 403, { error: "subscription_required" });
    return reply(route, 201, {
      id: `synthetic-session-${++sessionNumber}`,
      location_id: request.postDataJSON().location_id,
      scheme: "https",
      host: "unavailable.proxy.diagnostics.invalid",
      port: 443,
      username: "synthetic-proxy-user",
      password: "synthetic-proxy-password",
      issued_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 1200000).toISOString(),
      refresh_after_seconds: 900,
    });
  }
  if (
    (path.startsWith("/v1/proxy/sessions/synthetic-session-") && method === "DELETE") ||
    (path === "/v1/auth/logout" && method === "POST")
  )
    return reply(route, 204);
  evidence.unexpectedApiRequests.push(`${method} ${path}`);
  return route.abort("blockedbyclient");
}

async function request(value) {
  return page.evaluate((message) => chrome.runtime.sendMessage(message), value);
}
async function command(value) {
  if (value.type === "web_login") await installSyntheticWebAuth(context);
  const response = await request(value);
  assert.equal(response?.ok, true, `Command failed: ${value.type}`);
  return response;
}
async function state() {
  return (await command({ type: "diagnostics_state" })).state;
}
async function snapshot() {
  return (await command({ type: "get_snapshot" })).snapshot;
}
function safety(value) {
  const keys = [
    "status",
    "protected",
    "protectionRequested",
    "trafficBlocked",
    "blockingScope",
    "webRtcProtected",
    "activeLocationId",
    "error",
    "securityPreferences",
  ];
  return Object.fromEntries(keys.map((key) => [key, value[key]]));
}
async function waitState(predicate, message) {
  return waitForRead(state, predicate, { timeoutMs: 20000, message });
}
async function waitStatus(id, status) {
  const value = await waitState(
    (current) => current.reports.some((item) => item.id === id && item.status === status),
    `Report did not become ${status}`,
  );
  return value.reports.find((item) => item.id === id);
}
async function openPage() {
  page = await context.newPage();
  page.on("pageerror", (error) => evidence.pageErrors.push(error.name));
  await page.goto(`chrome-extension://${extensionId}/diagnostics-page/diagnostics.html`);
  await page.waitForFunction(() => !document.getElementById("runButton").disabled);
}
async function runReport() {
  const previous = new Set((await state()).reports.map((item) => item.id));
  await page.locator("#runButton").click();
  const current = await waitState(
    (value) => !value.preparing && value.reports.some((item) => !previous.has(item.id)),
    "Manual report missing",
  );
  const summary = current.reports.find((item) => !previous.has(item.id));
  await page.waitForFunction(
    (id) =>
      document.getElementById("reportSelect").value === id &&
      !document.getElementById("exportButton").disabled,
    summary.id,
  );
  assert.equal(await page.locator("#sendConsent").isChecked(), false);
  const report = (await command({ type: "diagnostics_report", reportId: summary.id })).report;
  assertSanitized(report);
  return report;
}
async function sendReport(report, status) {
  diagnosticStatus = status;
  const count = posts.length;
  assert.equal(await page.locator("#sendButton").isDisabled(), true);
  await page.locator("#sendConsent").check();
  await page.locator("#sendButton").click();
  await waitForRead(
    () => posts.length,
    (value) => value > count,
    { message: "Consent did not reach the synthetic endpoint" },
  );
  assert.deepEqual(
    posts[count].body,
    report,
    "The submitted body differs from the report inspected before consent",
  );
  assert.equal(await page.locator("#sendConsent").isChecked(), false);
}
async function login() {
  await command({ type: "web_login", disconnectFirst: false });
  await waitState((value) => value.signedIn, "Synthetic account missing");
}
async function restartWorker() {
  const before = await state();
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
          (value) =>
            value.scriptURL.startsWith(`chrome-extension://${extensionId}/`) &&
            value.runningStatus === "running",
        ),
      Boolean,
      { message: "Running worker not observed" },
    );
    await cdp.send("ServiceWorker.stopWorker", { versionId: version.versionId });
    await waitForRead(
      () => versions.get(version.versionId)?.runningStatus,
      (value) => value === "stopped",
      { message: "Worker did not stop" },
    );
    return await waitState(
      (value) => value.workerId !== before.workerId && value.signedIn,
      "Queue did not survive a worker restart",
    );
  } finally {
    await cdp.detach();
  }
}

try {
  context = await chromium.launchPersistentContext(join(temporary, "profile"), {
    executablePath: process.env.CHROMIUM_EXECUTABLE,
    channel: "chromium",
    headless: true,
    viewport: { width: 850, height: 900 },
    acceptDownloads: true,
    ignoreDefaultArgs: ["--disable-extensions"],
    args: [
      "--enable-unsafe-extension-debugging",
      "--disable-background-networking",
      "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1, EXCLUDE [::1]",
    ],
  });
  evidence.chromium = context.browser().version();
  await context.route("**/*", async (route) => {
    try {
      await intercept(route);
    } catch (error) {
      routeErrors.push(error);
      await route.abort("blockedbyclient").catch(() => undefined);
    }
  });
  // No extension is running before this point. If this CDP method is unavailable,
  // the check fails closed rather than loading a worker before network interception.
  const browserCdp = await context.browser().newBrowserCDPSession();
  const loaded = await browserCdp.send("Extensions.loadUnpacked", { path: extension });
  extensionId = loaded.id;
  assert.match(extensionId, /^[a-p]{32}$/);
  await browserCdp.detach();
  await openPage();
  await command({ type: "set_language_preference", preference: "en" });

  const initial = await state();
  assert.equal(initial.signedIn, false);
  assert.equal(initial.autoReporting, false);
  assert.equal(await page.locator("#autoReporting").isDisabled(), true);
  const beforeAnonymous = safety(await snapshot());
  const anonymous = await runReport();
  assert.equal(await page.locator("#sendConsent").isDisabled(), true);
  assert.equal(anonymous.chrome.probe_result, "passed");
  assert.equal(anonymous.checks.find((item) => item.id === "connectivity").result, "passed");
  const downloadPromise = page.waitForEvent("download");
  await page.locator("#exportButton").click();
  const download = await downloadPromise;
  assert.match(download.suggestedFilename(), /\.json$/);
  const exportedPath = join(output, "synthetic-anonymous-export.json");
  await download.saveAs(exportedPath);
  assert.deepEqual(JSON.parse(await readFile(exportedPath, "utf8")), anonymous);
  assert.deepEqual(safety(await snapshot()), beforeAnonymous);
  assert.equal(posts.length, 0);
  record("Signed-out manual checks and JSON export work without upload or a VPN state change");

  await login();
  assert.equal((await state()).autoReporting, false);
  assert(
    !(await state()).reports.some((item) => item.id === anonymous.report_id),
    "Anonymous report leaked into the signed-in account",
  );
  deviceFailure = true;
  const historyBefore = (await state()).historyCount;
  const offFailure = await request({ type: "refresh_devices" });
  assert.equal(offFailure.commandError, "invalid_response");
  await waitState(
    (value) => value.historyCount > historyBefore,
    "Local history did not record the synthetic error",
  );
  assert.equal(posts.length, 0);
  assert.equal(await page.locator("#autoReporting").isChecked(), false);
  await page.locator("#autoReporting").click();
  await waitState((value) => value.autoReporting, "Automatic consent was not saved");
  const onFailure = await request({ type: "refresh_devices" });
  assert.equal(onFailure.commandError, "invalid_response");
  const automatic = await waitState(
    (value) => value.reports.some((item) => item.type === "simple" && item.status === "received"),
    "Consented automatic error report missing",
  );
  assert.equal(posts.length, 1);
  assert.equal(posts[0].body.report_type, "simple");
  assert.equal(posts[0].body.consent.mode, "automatic_opt_in");
  assert.equal(posts[0].body.error.code, "invalid_response");
  assert.equal(automatic.autoReporting, true);
  deviceFailure = false;
  assert.equal(await page.locator("#autoReporting").isChecked(), true);
  await page.locator("#autoReporting").click();
  await waitState((value) => !value.autoReporting, "Automatic consent did not turn off");
  record(
    "Technical history stays local with automatic consent off; opt-in sends only a sanitized simple failure report",
  );
  // End the deliberately failed business operation before comparing restart state.
  await command({ type: "disconnect" });

  for (const status of [201, 200]) {
    const full = await runReport();
    const before = posts.length;
    assert.equal(full.report_type, "full");
    assert.equal(full.consent.mode, "manual");
    assert.equal(
      (await state()).reports.find((item) => item.id === full.report_id).status,
      "ready",
    );
    assert.equal(posts.length, before);
    await sendReport(full, status);
    const received = await waitStatus(full.report_id, "received");
    assert.equal(received.receipt.client_report_id, full.report_id);
    assert.equal(received.receipt.duplicate, status === 200);
  }
  record(
    "Explicit per-report consent sends the inspected JSON; valid 201 and duplicate 200 receipts alone confirm delivery",
  );

  const queued = await runReport();
  const beforeQueue = safety(await snapshot());
  await sendReport(queued, 503);
  const pending = await waitStatus(queued.report_id, "pending");
  assert.equal(pending.attempts, 1);
  assert(pending.nextAttemptAt > Date.now());
  const postsBeforeRestart = posts.length;
  const historyBeforeRestart = await page.evaluate(
    async () =>
      (await chrome.storage.session.get("fuzevpnDiagnosticHistory")).fuzevpnDiagnosticHistory,
  );
  assert(historyBeforeRestart.items.length > 0, "Expected technical events before worker restart");
  await page.close();
  await openPage();
  const restored = await restartWorker();
  const historyAfterRestart = await page.evaluate(
    async () =>
      (await chrome.storage.session.get("fuzevpnDiagnosticHistory")).fuzevpnDiagnosticHistory,
  );
  for (const item of historyBeforeRestart.items)
    assert(
      historyAfterRestart.items.some(
        (restoredItem) => JSON.stringify(restoredItem) === JSON.stringify(item),
      ),
      "Worker restart discarded an event of the same account",
    );
  const restoredSummary = restored.reports.find((item) => item.id === queued.report_id);
  assert.equal(restoredSummary.status, "pending");
  assert.equal(restoredSummary.attempts, 1);
  assert.equal(restoredSummary.nextAttemptAt, pending.nextAttemptAt);
  assert.deepEqual(
    (await command({ type: "diagnostics_report", reportId: queued.report_id })).report,
    queued,
  );
  assert.equal(posts.length, postsBeforeRestart);
  await page.locator("#reportSelect").selectOption(queued.report_id);
  await page.locator("#cancelButton").click();
  await waitStatus(queued.report_id, "cancelled");
  assert.deepEqual(safety(await snapshot()), beforeQueue);
  record(
    "A 503 queue and account history survive page closure and worker restart; immutable body and retry time, cancellation preserves VPN state",
  );

  await command({ type: "connect", locationId });
  await waitForRead(snapshot, (value) => value.status === "connected" && value.protected, {
    message: "Synthetic VPN did not connect",
  });
  const connected = safety(await snapshot());
  const protectedReport = await runReport();
  assert.equal(protectedReport.chrome.probe_result, "passed");
  await sendReport(protectedReport, 401);
  await waitStatus(protectedReport.report_id, "session_required");
  assert.deepEqual(safety(await snapshot()), connected);
  assert.equal((await state()).signedIn, true);
  await page.locator("#cancelButton").click();
  await waitStatus(protectedReport.report_id, "cancelled");
  assert.deepEqual(safety(await snapshot()), connected);
  record(
    "Diagnostic HTTP 401 and cancellation leave the authenticated, protected VPN connection intact",
  );

  await command({ type: "disconnect" });
  connectFailure = true;
  const denied = await request({ type: "connect", locationId });
  assert.equal(denied.commandError, "subscription_required");
  const blocked = await waitForRead(
    snapshot,
    (value) => value.status === "blocked" && value.trafficBlocked,
    { message: "Synthetic connection denial did not activate the guard" },
  );
  const probesBefore = ipRequests;
  const blockedReport = await runReport();
  assert.equal(blockedReport.chrome.blocking_scope, "all");
  assert.equal(blockedReport.chrome.probe_result, "not_run");
  assert.equal(blockedReport.checks.find((item) => item.id === "connectivity").result, "skipped");
  assert.equal(ipRequests, probesBefore, "A blocked route triggered a diagnostic IP request");
  assert.deepEqual(safety(await snapshot()), safety(blocked));
  record(
    "Blocked traffic produces a skipped connectivity check without a new probe or guard change",
  );

  await command({ type: "logout" });
  await waitState((value) => !value.signedIn, "Logout did not remove diagnostic account access");
  connectFailure = false;
  await login();
  const pendingLogout = await runReport();
  await sendReport(pendingLogout, 503);
  await waitStatus(pendingLogout.report_id, "pending");
  const countBeforeLogout = posts.length;
  await command({ type: "logout" });
  await waitState(
    (value) =>
      !value.signedIn &&
      value.historyCount === 0 &&
      !value.reports.some((item) => item.id === pendingLogout.report_id),
    "Logout retained account diagnostic history or report access",
  );
  // Exercise the real alarm handler immediately; the absent session must prevent upload.
  await page.evaluate(() =>
    chrome.alarms.create("fuzevpn-diagnostics-delivery", { when: Date.now() + 1000 }),
  );
  await waitForRead(
    () => page.evaluate(() => chrome.alarms.get("fuzevpn-diagnostics-delivery")),
    (alarm) => alarm && alarm.scheduledTime > Date.now() + 60000,
    { timeoutMs: 10000, message: "Signed-out delivery alarm was not rescheduled for expiration" },
  );
  assert.equal(posts.length, countBeforeLogout);
  const stored = await page.evaluate(
    async (key) => (await chrome.storage.local.get(key))[key],
    deliveryKey,
  );
  assert(
    stored.reports.some((item) => item.id === pendingLogout.report_id),
    "Consented queue disappeared instead of remaining bounded to the account",
  );
  for (const entry of stored.reports) assertSanitized(JSON.parse(entry.body));
  record(
    "Logout clears local technical history and hides account reports; delivery stays suspended without an authenticated account",
  );

  assert.equal(routeErrors.length, 0, routeErrors[0]?.message);
  assert.deepEqual(evidence.unexpectedApiRequests, []);
  assert.deepEqual(evidence.pageErrors, []);
  evidence.diagnosticPosts = posts.map(({ body, status }) => ({
    type: body.report_type,
    mode: body.consent.mode,
    status,
  }));
  evidence.probeRequests = ipRequests;
  await page.screenshot({ path: join(output, "diagnostics-signed-out.png"), fullPage: true });
} catch (error) {
  evidence.failure = { name: error.name, message: error.message };
  if (page && !page.isClosed()) {
    evidence.finalDiagnosticState = await state()
      .then((value) => ({
        signedIn: value.signedIn,
        historyCount: value.historyCount,
        reports: value.reports.map((item) => ({ type: item.type, status: item.status })),
      }))
      .catch(() => null);
    evidence.finalHistory = await page
      .evaluate(
        async () =>
          (await chrome.storage.session.get("fuzevpnDiagnosticHistory")).fuzevpnDiagnosticHistory,
      )
      .then((value) => ({ events: value?.events, dropped: value?.dropped }))
      .catch(() => null);
  }
  process.exitCode = 1;
} finally {
  await context?.close();
  await writeFile(join(output, "report.json"), JSON.stringify(evidence, null, 2));
  process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
}
