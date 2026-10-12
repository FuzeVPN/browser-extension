// SPDX-License-Identifier: MPL-2.0

// Run after npm run build. Real extension/Chrome APIs, synthetic server contracts only.
// Optional: CHROME_EXTENSION_DIR, PLAYWRIGHT_MODULE_PATH, CHROMIUM_EXECUTABLE,
// LOGOUT_CONTRACTS_OUTPUT. No production request is allowed; no access data is logged.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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
// Chromium's Windows IndexedDB backend needs room for its origin/database suffixes.
const temporary = await mkdtemp(join(tmpdir(), "logout-"));
const output = resolve(process.env.LOGOUT_CONTRACTS_OUTPUT ?? temporary);
await mkdir(output, { recursive: true });
const extension = resolve(process.env.CHROME_EXTENSION_DIR ?? join(root, "dist/chrome"));
const report = {
  timestamp: new Date().toISOString(),
  scope:
    "Built worker and popup; temporary Chromium profile; synthetic API; every other HTTP(S) request aborted",
  limitations: [
    "No production session or tunnel checked. Confirmed cleanup means successful requests for known synthetic sessions.",
  ],
  checks: [],
  pageErrors: [],
  unexpectedRequests: 0,
};
const validTokens = new Set();
const sessions = new Map();
const order = [];
let account = 0;
let sequence = 0;
let createStatus = 201;
let logoutStatus = 204;
let revokeStatus = 204;
let failedRevocations = 0;
let held = null;
let context;
let worker;
const location = {
  id: "contract-fixture",
  city: "Local fixture",
  country_code: "FR",
  display_name: "Synthetic contract check",
  supported_protocols: ["browser_proxy"],
};

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function hold(kind) {
  assert.equal(held, null);
  const arrived = deferred();
  const release = deferred();
  held = { kind, arrived, release };
  return { arrived: arrived.promise, release: release.resolve };
}
async function pause(kind) {
  if (held?.kind !== kind) return;
  const gate = held;
  held = null;
  gate.arrived.resolve();
  await gate.release.promise;
}
function record(name, details) {
  report.checks.push({ name, passed: true, ...(details ? { details } : {}) });
  process.stdout.write(`PASS ${name}\n`);
}
async function command(page, value) {
  let timer;
  try {
    return await Promise.race([
      page.evaluate((request) => chrome.runtime.sendMessage(request), value),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Worker command timed out: ${value.type}`)),
          30000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
async function snapshot(page) {
  return (await command(page, { type: "get_snapshot" })).snapshot;
}
async function waitLocalLogout(page) {
  await waitForRead(
    () => snapshot(page),
    (current) => current.profile === null && current.logoutOutcome !== null,
    { message: "Local logout did not publish its account cleanup outcome" },
  );
  await page.locator("#loginView").waitFor({ state: "visible" });
}
async function login(page) {
  await page.locator("#loginView").waitFor({ state: "visible" });
  await page.locator("#loginButton").click();
  await page.locator("#mainView").waitFor({ state: "visible" });
  const current = await snapshot(page);
  assert.notEqual(current.profile, null);
  assert.equal(current.logoutOutcome, null);
}
async function connect(page) {
  const result = await command(page, { type: "connect", locationId: location.id });
  assert.equal(result.ok, true);
  assert.equal(result.snapshot.protected, true);
}
async function waitUntil(condition, failure) {
  const deadline = Date.now() + 5000;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error(failure);
    await new Promise((done) => setTimeout(done, 25));
  }
}
async function disconnectWithFailedRevocation(page) {
  const before = failedRevocations;
  revokeStatus = 500;
  const result = await command(page, { type: "disconnect" });
  assert.equal(result.ok, true);
  assert.equal(result.snapshot.protected, false);
  assert.equal(result.snapshot.protectionRequested, false);
  await waitUntil(() => failedRevocations > before, "Synthetic proxy revocation did not fail");
}
async function reply(route, status, body) {
  await route.fulfill({
    status,
    ...(body === undefined
      ? {}
      : {
          contentType: "application/json",
          body: JSON.stringify(body),
        }),
  });
}

async function installSyntheticAuth() {
  await worker.evaluate(() => {
    globalThis.authFixtureGrants = new Map();
    chrome.identity.launchWebAuthFlow = async (details) => {
      const authorization = new URL(details.url);
      if (authorization.origin !== "https://app.fuzevpn.com" || details.interactive !== true)
        throw new Error("Unexpected synthetic authentication origin or mode");
      if (authorization.searchParams.get("code_challenge_method") !== "S256")
        throw new Error("Synthetic authorization requires S256 PKCE");
      const redirectUri = authorization.searchParams.get("redirect_uri");
      const callback = new URL(redirectUri);
      if (callback.origin !== new URL(chrome.identity.getRedirectURL()).origin)
        throw new Error("Unexpected synthetic authentication callback");
      const code = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "");
      globalThis.authFixtureGrants.set(code, {
        clientId: authorization.searchParams.get("client_id"),
        redirectUri,
        challenge: authorization.searchParams.get("code_challenge"),
      });
      callback.searchParams.set("code", code);
      callback.searchParams.set("state", authorization.searchParams.get("state"));
      return callback.href;
    };
  });
}

try {
  context = await chromium.launchPersistentContext(join(temporary, "profile"), {
    channel: "chromium",
    headless: true,
    viewport: { width: 360, height: 680 },
    ...(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : {}),
    args: [
      `--disable-extensions-except=${extension}`,
      `--load-extension=${extension}`,
      "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1, EXCLUDE [::1]",
      "--disable-background-networking",
    ],
  });
  report.chromium = context.browser().version();
  context.setDefaultTimeout(15000);
  await context.route(/^https?:\/\//, async (route) => {
    report.unexpectedRequests++;
    await route.abort("blockedbyclient");
  });
  await context.route(/^https:\/\/api(?:64)?\.ipify\.org\//, (route) =>
    reply(route, 200, { ip: "203.0.113.8" }),
  );
  await context.route("https://api.fuzevpn.com/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    const method = route.request().method();
    const token = (route.request().headers().authorization ?? "").replace(/^Bearer /, "");
    if (path === "/v1/auth/extension/token") {
      assert.equal(method, "POST");
      const request = route.request().postDataJSON();
      assert.deepEqual(Object.keys(request).sort(), [
        "client_id",
        "code",
        "code_verifier",
        "redirect_uri",
      ]);
      assert.match(request.code_verifier, /^[A-Za-z0-9_-]{43,128}$/);
      const grant = await worker.evaluate((code) => {
        const result = globalThis.authFixtureGrants.get(code);
        globalThis.authFixtureGrants.delete(code);
        return result;
      }, request.code);
      assert(grant, "Only a one-use grant created by this synthetic web flow can issue a session");
      assert.equal(request.client_id, grant.clientId);
      assert.equal(request.redirect_uri, grant.redirectUri);
      assert.equal(
        createHash("sha256").update(request.code_verifier).digest("base64url"),
        grant.challenge,
      );
      const issued = `synthetic-contract-token-${++account}`;
      validTokens.add(issued);
      return reply(route, 201, {
        access_token: issued,
        expires_at: new Date(Date.now() + 3600000).toISOString(),
      });
    }
    if (path === "/v1/locations") return reply(route, 200, { locations: [location] });
    if (!validTokens.has(token)) {
      if (path.startsWith("/v1/proxy/sessions/")) order.push("proxy_revoke_rejected_401");
      return reply(route, 401, { error: "unauthorized" });
    }
    if (path === "/v1/me")
      return reply(route, 200, {
        user_id: `synthetic-contract-account-${account}`,
        email: "fixture@example.invalid",
        first_name: "Synthetic",
        last_name: "Contract",
        country_code: "FR",
      });
    if (path === "/v1/billing/subscription")
      return reply(route, 200, {
        status: "active",
        has_access: true,
        offer_id: "synthetic",
        started_at: null,
        expires_at: new Date(Date.now() + 3600000).toISOString(),
        renews_automatically: false,
      });
    if (path === "/v1/devices") return reply(route, 200, { limit: 5, devices: [] });
    if (path === "/v1/devices/browser")
      return reply(route, 201, {
        device_id: `synthetic-contract-device-${account}`,
        name: "Synthetic browser",
        kind: "browser_extension",
        created_at: new Date().toISOString(),
      });
    if (path === "/v1/proxy/sessions" && method === "POST") {
      order.push("creation_requested");
      const status = createStatus;
      if (status !== 201) return reply(route, status, { error: "server_error" });
      const id = `synthetic-contract-session-${++sequence}`;
      sessions.set(id, token);
      await pause("creation");
      order.push("creation_response");
      return reply(route, 201, {
        id,
        location_id: location.id,
        scheme: "https",
        host: "unavailable.proxy.audit.invalid",
        port: 443,
        username: "synthetic",
        password: "synthetic",
        issued_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 600000).toISOString(),
        refresh_after_seconds: 510,
      });
    }
    if (path.startsWith("/v1/proxy/sessions/") && method === "DELETE") {
      order.push("proxy_revoke");
      const id = decodeURIComponent(path.slice("/v1/proxy/sessions/".length));
      if (revokeStatus === 204) {
        if (sessions.get(id) === token) sessions.delete(id);
        return reply(route, 204);
      }
      await reply(route, revokeStatus, { error: "server_error" });
      failedRevocations++;
      return;
    }
    if (path === "/v1/auth/logout") {
      const status = logoutStatus;
      order.push("auth_logout_requested");
      await pause("logout");
      if (status === 204) {
        validTokens.delete(token);
        order.push("auth_logout_confirmed");
        return reply(route, 204);
      }
      order.push("auth_logout_failed");
      return reply(route, status, { error: "server_error" });
    }
    return reply(route, 404, { error: "not_found" });
  });
  worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
  await installSyntheticAuth();
  const page = await context.newPage();
  page.on("pageerror", (error) => report.pageErrors.push(error.name));
  await page.goto(`chrome-extension://${worker.url().split("/")[2]}/popup/popup.html`);

  await login(page);
  const creation = hold("creation");
  const creating = command(page, { type: "connect", locationId: location.id });
  await Promise.race([
    creation.arrived,
    creating.then(async (result) => {
      if (order.includes("creation_requested")) return;
      report.identityStorageOnUnexpectedConnect = await page.evaluate(
        () =>
          new Promise((done) => {
            const request = indexedDB.open("fuzevpn-device-identity");
            request.onsuccess = () => {
              request.result.close();
              done({ available: true });
            };
            request.onerror = () => done({ available: false, error: request.error?.name });
          }),
      );
      throw new Error(
        `Connect completed before the held synthetic POST: ${result.commandError ?? result.snapshot.error ?? result.ok}`,
      );
    }),
  ]);
  const loggingOut = command(page, { type: "logout" });
  await waitLocalLogout(page);
  const pending = await snapshot(page);
  assert.equal(pending.logoutOutcome.proxySessions, "pending");
  assert(!order.includes("auth_logout_requested"));
  creation.release();
  await Promise.all([creating, loggingOut]);
  const drained = await snapshot(page);
  assert.deepEqual(drained.logoutOutcome, { apiSession: "confirmed", proxySessions: "confirmed" });
  assert.equal(sessions.size, 0);
  assert(order.indexOf("proxy_revoke") < order.indexOf("auth_logout_requested"));
  assert(!order.includes("proxy_revoke_rejected_401"));
  record("In-flight creation is collected and revoked before API logout invalidates its token", {
    order: [...order],
  });
  await page.screenshot({ path: join(output, "logout-confirmed.png"), fullPage: true });

  await login(page);
  await connect(page);
  logoutStatus = 500;
  await command(page, { type: "logout" });
  const failed = await snapshot(page);
  assert.equal(failed.profile, null);
  assert.equal(failed.protected, false);
  assert.deepEqual(failed.logoutOutcome, { apiSession: "unconfirmed", proxySessions: "confirmed" });
  record("HTTP 500 logout clears the local account and exposes the unconfirmed remote API result");
  await page.screenshot({ path: join(output, "logout-api-unconfirmed.png"), fullPage: true });

  logoutStatus = 204;
  await login(page);
  await connect(page);
  const retainedId = [...sessions.keys()].at(-1);
  assert(retainedId);
  await disconnectWithFailedRevocation(page);
  const retained = await page.evaluate(
    async () =>
      (await chrome.storage.local.get("fuzevpnPendingProxyRevocations"))
        .fuzevpnPendingProxyRevocations,
  );
  assert.equal(retained.version, 1);
  assert.deepEqual(
    retained.sessions.map((session) => session.sessionId),
    [retainedId],
  );
  assert.deepEqual(Object.keys(retained.sessions[0]).sort(), ["expiresAt", "sessionId", "userId"]);
  const restoredCleanup = await restartWorker();
  assert.equal(restoredCleanup.protected, false);
  assert.notEqual(restoredCleanup.profile, null);
  const cleanupOrderStart = order.length;
  revokeStatus = 204;
  const cleanupLogout = await command(page, { type: "logout" });
  assert.equal(cleanupLogout.ok, true);
  assert.deepEqual(cleanupLogout.snapshot.logoutOutcome, {
    apiSession: "confirmed",
    proxySessions: "confirmed",
  });
  const cleanupOrder = order.slice(cleanupOrderStart);
  assert(cleanupOrder.indexOf("proxy_revoke") >= 0);
  assert(cleanupOrder.indexOf("proxy_revoke") < cleanupOrder.indexOf("auth_logout_requested"));
  assert.equal(sessions.has(retainedId), false);
  assert.deepEqual(
    await page.evaluate(
      async () =>
        (await chrome.storage.local.get("fuzevpnPendingProxyRevocations"))
          .fuzevpnPendingProxyRevocations.sessions,
    ),
    [],
  );
  record("Failed disconnect cleanup survives a real worker restart and is revoked before logout", {
    order: cleanupOrder,
    retainedFields: Object.keys(retained.sessions[0]).sort(),
  });

  await login(page);
  await connect(page);
  const corruptExclusions = {
    version: 1,
    saved: {
      revision: 5,
      enabled: true,
      entries: [{ domain: "example.com", includeSubdomains: false }],
    },
    applied: null,
    pending: false,
  };
  await page.evaluate(
    (record) => chrome.storage.local.set({ fuzevpnSiteExclusions: record }),
    corruptExclusions,
  );
  const corruptStartup = await restartWorker();
  assert.equal(corruptStartup.protected, false);
  assert.equal(corruptStartup.protectionRequested, true);
  assert.equal(corruptStartup.trafficBlocked, true);
  assert.equal(corruptStartup.siteExclusions.pending, true);
  assert.equal(corruptStartup.siteExclusions.error, true);
  const retainedGuard = await page.evaluate(async () => ({
    stored: await chrome.storage.local.get([
      "fuzevpnSiteExclusions",
      "fuzevpnSiteExclusionRecovery",
    ]),
    rules: await chrome.declarativeNetRequest.getDynamicRules(),
  }));
  assert.deepEqual(retainedGuard.stored.fuzevpnSiteExclusions, corruptExclusions);
  assert.equal(retainedGuard.stored.fuzevpnSiteExclusionRecovery, undefined);
  assert.equal(retainedGuard.rules.find((rule) => rule.id === 2000)?.action.type, "block");
  assert(!retainedGuard.rules.some((rule) => rule.id === 2001));
  record(
    "A corrupt exclusion journal retains Chrome's traffic guard after automatic worker restart",
  );

  const recovered = await command(page, { type: "disconnect" });
  assert.equal(
    recovered.ok,
    true,
    JSON.stringify({
      commandError: recovered.commandError,
      superseded: recovered.superseded,
      status: recovered.snapshot.status,
      error: recovered.snapshot.error,
    }),
  );
  assert.equal(recovered.snapshot.protectionRequested, false);
  assert.equal(recovered.snapshot.trafficBlocked, false);
  assert.equal(recovered.snapshot.siteExclusions.pending, false);
  assert.equal(recovered.snapshot.siteExclusions.error, false);
  assert.equal(recovered.snapshot.siteExclusions.recoveryNotice, "preferences_reset");
  assert.equal(recovered.snapshot.siteExclusions.saved.enabled, false);
  assert.deepEqual(recovered.snapshot.siteExclusions.saved.entries, []);
  const nativeRecovery = await page.evaluate(async () => ({
    stored: await chrome.storage.local.get([
      "fuzevpnSiteExclusions",
      "fuzevpnSiteExclusionRecovery",
    ]),
    rules: await chrome.declarativeNetRequest.getDynamicRules(),
    proxy: await chrome.proxy.settings.get({ incognito: false }),
  }));
  assert.deepEqual(nativeRecovery.rules, []);
  assert.notEqual(nativeRecovery.proxy.levelOfControl, "controlled_by_this_extension");
  assert.equal(nativeRecovery.stored.fuzevpnSiteExclusions.recoveryNotice, "preferences_reset");
  assert.equal(
    nativeRecovery.stored.fuzevpnSiteExclusionRecovery.reason,
    "invalid_site_exclusion_storage",
  );
  assert(JSON.stringify(nativeRecovery.stored.fuzevpnSiteExclusionRecovery).length < 1024);
  const recoveredRestart = await restartWorker();
  assert.equal(recoveredRestart.protectionRequested, false);
  assert.equal(recoveredRestart.trafficBlocked, false);
  assert.equal(recoveredRestart.siteExclusions.recoveryNotice, "preferences_reset");
  assert.equal(recoveredRestart.siteExclusions.error, false);
  record("Explicit disconnect repairs a corrupt journal durably and reports the preference reset", {
    recoveryNotice: recoveredRestart.siteExclusions.recoveryNotice,
  });
  await command(page, { type: "logout" });

  await login(page);
  await connect(page);
  await disconnectWithFailedRevocation(page);
  await restartWorker();
  const failuresBeforeRetry = failedRevocations;
  await command(page, { type: "logout" });
  const partial = await snapshot(page);
  assert.equal(partial.profile, null);
  assert.deepEqual(partial.logoutOutcome, {
    apiSession: "confirmed",
    proxySessions: "unconfirmed",
  });
  assert(failedRevocations > failuresBeforeRetry);
  record("A proxy revocation that fails again after worker restart stays unconfirmed at logout");
  revokeStatus = 204;

  await login(page);
  const delayed = hold("logout");
  logoutStatus = 500;
  const oldLogout = command(page, { type: "logout" });
  await delayed.arrived;
  await waitLocalLogout(page);
  await login(page);
  const next = await snapshot(page);
  delayed.release();
  await oldLogout;
  const afterOldLogout = await snapshot(page);
  assert.equal(afterOldLogout.profile.userId, next.profile.userId);
  assert.equal(afterOldLogout.logoutOutcome, null);
  assert.equal(afterOldLogout.error, null);
  record(
    "An older failed logout cannot overwrite a newer login or display its outcome on that account",
  );
  logoutStatus = 204;
  await command(page, { type: "logout" });

  await login(page);
  createStatus = 503;
  const ambiguous = await command(page, { type: "connect", locationId: location.id });
  assert.equal(ambiguous.snapshot.error, "proxy_creation_uncertain");
  assert.equal(ambiguous.snapshot.nextRetryAt, null);
  const security = await page.evaluate(async () => ({
    settings: (await chrome.storage.local.get("fuzevpnSecurityState")).fuzevpnSecurityState,
    alarms: (await chrome.alarms.getAll()).map((alarm) => alarm.name),
  }));
  assert.equal(security.settings.proxyCreationUncertain, true);
  assert.equal(security.settings.retrySuspended, true);
  assert(!security.alarms.includes("fuzevpn-proxy-reconnect"));
  assert(!security.alarms.includes("fuzevpn-proxy-refresh"));
  record(
    "A JSON 503 from session creation leaves a durable uncertainty marker and no automatic retry",
  );
  async function restartWorker() {
    const cdp = await context.newCDPSession(page);
    const versions = new Map();
    cdp.on("ServiceWorker.workerVersionUpdated", ({ versions: changed }) => {
      for (const version of changed) versions.set(version.versionId, version);
    });
    await cdp.send("ServiceWorker.enable");
    async function waitForVersion(condition) {
      const deadline = Date.now() + 5000;
      while (!condition()) {
        if (Date.now() >= deadline) throw new Error("Worker lifecycle event missing");
        await new Promise((done) => setTimeout(done, 25));
      }
    }
    await waitForVersion(() =>
      [...versions.values()].some(
        (version) => version.scriptURL === worker.url() && version.runningStatus === "running",
      ),
    );
    const version = [...versions.values()].find(
      (value) => value.scriptURL === worker.url() && value.runningStatus === "running",
    );
    await cdp.send("ServiceWorker.stopWorker", { versionId: version.versionId });
    await waitForVersion(() => versions.get(version.versionId)?.runningStatus === "stopped");
    const current = await snapshot(page);
    const workerUrl = worker.url();
    worker =
      context.serviceWorkers().find((candidate) => candidate.url() === workerUrl) ??
      (await context.waitForEvent("serviceworker", {
        predicate: (candidate) => candidate.url() === workerUrl,
      }));
    await installSyntheticAuth();
    await cdp.detach();
    return current;
  }
  const requestsBeforeRestart = order.filter((event) => event === "creation_requested").length;
  const restarted = await restartWorker();
  assert.equal(restarted.error, "proxy_creation_uncertain");
  assert.equal(restarted.nextRetryAt, null);
  assert.equal(
    order.filter((event) => event === "creation_requested").length,
    requestsBeforeRestart,
  );
  record("A real worker restart preserves creation uncertainty without sending another POST");
  createStatus = 201;
  const retried = await command(page, { type: "retry_connection" });
  assert.equal(retried.snapshot.protected, true);
  record("An explicit user retry can establish a verified connection after ambiguous creation");
  await restartWorker();
  await command(page, { type: "logout" });
  const historical = await snapshot(page);
  assert.deepEqual(historical.logoutOutcome, {
    apiSession: "confirmed",
    proxySessions: "unconfirmed",
  });
  record(
    "Unknown earlier cleanup stays unconfirmed after a successful manual connection and worker restart",
  );

  assert.equal(report.pageErrors.length, 0);
  report.result = "PASS";
} catch (error) {
  report.result = "FAIL";
  report.failure = { name: error.name, message: error.message };
  throw error;
} finally {
  await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2) + "\n");
  await context?.close();
}
