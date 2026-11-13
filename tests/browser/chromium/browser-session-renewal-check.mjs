// SPDX-License-Identifier: MPL-2.0

// Run after npm run build. Real extension/Chrome APIs, synthetic server contracts only.
// Optional: CHROME_EXTENSION_DIR, PLAYWRIGHT_MODULE_PATH, CHROMIUM_EXECUTABLE,
// SESSION_RENEWAL_OUTPUT. No production request is allowed; no access data is logged.
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
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
const temporary = await mkdtemp(join(tmpdir(), "renewal-"));
const output = resolve(process.env.SESSION_RENEWAL_OUTPUT ?? temporary);
await mkdir(output, { recursive: true });
const extension = resolve(process.env.CHROME_EXTENSION_DIR ?? join(root, "dist/chrome"));
const report = {
  timestamp: new Date().toISOString(),
  scope:
    "Built worker and popup; temporary Chromium profile; synthetic API with renewable account sessions; every other HTTP(S) request aborted",
  limitations: [
    "The synthetic API applies the rotation rules of the session contract; no production session is converted or renewed.",
    "The worker clock is shifted to reach token expiry; no real hour elapses.",
  ],
  checks: [],
  pageErrors: [],
  unexpectedRequests: 0,
};
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const canonical32 = /^[A-Za-z0-9_-]{43}$/;
const location = {
  id: "renewal-fixture",
  city: "Local fixture",
  country_code: "FR",
  display_name: "Synthetic renewal check",
  supported_protocols: ["browser_proxy"],
};

/** Account sessions as the API keeps them: classic until converted, then one generation per rotation. */
const sessions = new Map();
const derived = new Map();
const rotations = [];
const presented = [];
const logouts = [];
let clockOffset = 0;
let loseNextAnswer = false;
let routeFailure = null;
let account = 0;
let sequence = 0;
let context;
let worker;

const serverNow = () => Date.now() + clockOffset;
const token32 = () => randomBytes(32).toString("base64url");
const accepts = (token) =>
  [...sessions.values()].some(
    (session) => session.access === token && session.accessExpiresAt > serverNow(),
  );
/** The same token and request always derive the same access token. */
function accessFor(token, requestId) {
  const key = `${token}\n${requestId}`;
  if (!derived.has(key)) derived.set(key, token32());
  return derived.get(key);
}
function pair(session) {
  return {
    access_token: session.access,
    expires_at: new Date(session.accessExpiresAt).toISOString(),
    refresh_token: `fr1.${session.id}.${session.generation}`,
    refresh_expires_at: new Date(session.refreshExpiresAt).toISOString(),
  };
}
function apply(session, access, requestId) {
  session.generation += 1;
  session.access = access;
  session.accessExpiresAt = serverNow() + HOUR;
  session.refreshExpiresAt = serverNow() + 365 * DAY;
  session.lastRequest = requestId;
  return { status: 200, body: pair(session) };
}
const refusal = { status: 401, body: { error: "unauthorized" } };
function rotate(kind, token, requestId) {
  const access = accessFor(token, requestId);
  if (kind === "upgrade") {
    const session = [...sessions.values()].find(
      (candidate) => candidate.access === token || candidate.upgradeToken === token,
    );
    if (!session) return refusal;
    if (session.generation >= 1)
      return session.generation === 1 &&
        session.upgradeToken === token &&
        session.lastRequest === requestId &&
        session.access === access
        ? { status: 200, body: pair(session) }
        : { status: 409, body: { error: "session_upgrade_conflict" } };
    if (session.accessExpiresAt <= serverNow()) return refusal;
    session.upgradeToken = token;
    return apply(session, access, requestId);
  }
  const parsed = /^fr1\.([0-9a-f-]{36})\.(\d+)$/.exec(token);
  const session = parsed ? sessions.get(parsed[1]) : undefined;
  const generation = Number(parsed?.[2]);
  if (
    !session ||
    session.generation < 1 ||
    session.refreshExpiresAt <= serverNow() ||
    generation > session.generation
  )
    return refusal;
  if (generation < session.generation) {
    if (
      generation === session.generation - 1 &&
      session.lastRequest === requestId &&
      session.access === access
    )
      return { status: 200, body: pair(session) };
    // A different request with a retired refresh token is a replay.
    sessions.delete(session.id);
    return refusal;
  }
  return apply(session, access, requestId);
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
async function login(page) {
  await page.locator("#loginView").waitFor({ state: "visible" });
  await page.locator("#loginButton").click();
  await page.locator("#mainView").waitFor({ state: "visible" });
  assert.notEqual((await snapshot(page)).profile, null);
}
async function waitUntil(condition, failure) {
  const deadline = Date.now() + 15000;
  while (!condition()) {
    if (routeFailure) throw routeFailure;
    if (Date.now() >= deadline) throw new Error(failure);
    await new Promise((done) => setTimeout(done, 25));
  }
}
async function storage(page) {
  return page.evaluate(async () => ({
    local: await chrome.storage.local.get(null),
    session: await chrome.storage.session.get(null),
  }));
}
async function storedSession(page) {
  return (await storage(page)).local.fuzevpnAccountSessions?.sessions?.[0] ?? null;
}
async function reply(route, status, body) {
  await route.fulfill({
    status,
    headers: { "Cache-Control": "no-store" },
    ...(body === undefined ? {} : { contentType: "application/json", body: JSON.stringify(body) }),
  });
}
/** Both the synthetic server and the session clock of the worker move forward. */
async function advanceClock(milliseconds) {
  clockOffset += milliseconds;
  await applyClock();
}
async function applyClock() {
  await worker.evaluate((offset) => {
    globalThis.renewalFixtureNow ??= Date.now.bind(Date);
    globalThis.renewalFixtureRunning ??= performance.now.bind(performance);
    Date.now = () => globalThis.renewalFixtureNow() + offset;
    // The delays of the session manager run on the monotonic clock.
    performance.now = () => globalThis.renewalFixtureRunning() + offset;
  }, clockOffset);
}
async function installSyntheticAuth() {
  await worker.evaluate(() => {
    globalThis.authFixtureGrants = new Map();
    chrome.identity.launchWebAuthFlow = async (details) => {
      const authorization = new URL(details.url);
      if (authorization.origin !== "https://app.fuzevpn.com" || details.interactive !== true)
        throw new Error("Unexpected synthetic authentication origin or mode");
      const redirectUri = authorization.searchParams.get("redirect_uri");
      const callback = new URL(redirectUri);
      const code = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "");
      globalThis.authFixtureGrants.set(code, {
        challenge: authorization.searchParams.get("code_challenge"),
      });
      callback.searchParams.set("code", code);
      callback.searchParams.set("state", authorization.searchParams.get("state"));
      return callback.href;
    };
  });
}
async function restartWorker(page) {
  const cdp = await context.newCDPSession(page);
  const versions = new Map();
  cdp.on("ServiceWorker.workerVersionUpdated", ({ versions: changed }) => {
    for (const version of changed) versions.set(version.versionId, version);
  });
  await cdp.send("ServiceWorker.enable");
  const running = () =>
    [...versions.values()].find(
      (version) => version.scriptURL === worker.url() && version.runningStatus === "running",
    );
  await waitUntil(() => Boolean(running()), "Worker lifecycle event missing");
  const version = running();
  await cdp.send("ServiceWorker.stopWorker", { versionId: version.versionId });
  await waitUntil(
    () => versions.get(version.versionId)?.runningStatus === "stopped",
    "Worker did not stop",
  );
  await snapshot(page);
  const workerUrl = worker.url();
  worker =
    context.serviceWorkers().find((candidate) => candidate.url() === workerUrl) ??
    (await context.waitForEvent("serviceworker", {
      predicate: (candidate) => candidate.url() === workerUrl,
    }));
  await installSyntheticAuth();
  await applyClock();
  await cdp.detach();
}

async function api(route) {
  const request = route.request();
  const url = new URL(request.url());
  const path = url.pathname;
  const method = request.method();
  const headers = await request.allHeaders();
  const token = (headers.authorization ?? "").replace(/^Bearer /, "");
  assert.equal(url.search, "", "An API request carried a query string");
  assert.equal(headers.cookie, undefined, "An API request carried a cookie");
  if (path === "/v1/auth/extension/token") {
    const body = request.postDataJSON();
    const grant = await worker.evaluate((code) => {
      const result = globalThis.authFixtureGrants.get(code);
      globalThis.authFixtureGrants.delete(code);
      return result;
    }, body.code);
    assert(grant, "Only a one-use grant of the synthetic web flow can issue a session");
    assert.equal(
      createHash("sha256").update(body.code_verifier).digest("base64url"),
      grant.challenge,
    );
    const session = {
      id: randomUUID(),
      account: ++account,
      access: token32(),
      accessExpiresAt: serverNow() + 30 * DAY,
      generation: 0,
      upgradeToken: null,
      lastRequest: null,
      refreshExpiresAt: 0,
    };
    sessions.set(session.id, session);
    return reply(route, 201, {
      access_token: session.access,
      expires_at: new Date(session.accessExpiresAt).toISOString(),
    });
  }
  if (path === "/v1/locations") return reply(route, 200, { locations: [location] });
  if (path === "/v1/auth/session/upgrade" || path === "/v1/auth/session/refresh") {
    assert.equal(method, "POST");
    assert.equal(headers["content-type"], "application/json");
    const body = request.postDataJSON();
    assert.deepEqual(Object.keys(body), ["request_id"]);
    assert.match(body.request_id, canonical32);
    const decoded = Buffer.from(body.request_id, "base64url");
    assert.equal(decoded.length, 32);
    assert.equal(decoded.toString("base64url"), body.request_id);
    const kind = path.endsWith("/upgrade") ? "upgrade" : "refresh";
    rotations.push({ route: kind, token, requestId: body.request_id });
    const outcome = rotate(kind, token, body.request_id);
    if (loseNextAnswer) {
      // The rotation is applied; its answer never reaches the extension.
      loseNextAnswer = false;
      return route.abort("failed");
    }
    return reply(route, outcome.status, outcome.body);
  }
  if (path === "/v1/auth/logout") {
    assert.equal(method, "POST");
    logouts.push({ token, body: request.postData(), headers: Object.keys(headers) });
    const renewable = /^fr1\.([0-9a-f-]{36})\.(\d+)$/.exec(token);
    if (renewable) {
      const session = sessions.get(renewable[1]);
      if (session && session.generation >= Number(renewable[2])) sessions.delete(session.id);
    } else
      for (const session of sessions.values())
        if (session.access === token) sessions.delete(session.id);
    return reply(route, 204);
  }
  presented.push({ path, token });
  if (!accepts(token)) return reply(route, 401, { error: "unauthorized" });
  if (path === "/v1/me")
    return reply(route, 200, {
      user_id: "synthetic-renewal-account",
      email: "fixture@example.invalid",
      first_name: "Synthetic",
      last_name: "Renewal",
      country_code: "FR",
    });
  if (path === "/v1/billing/subscription")
    return reply(route, 200, {
      status: "active",
      has_access: true,
      offer_id: "synthetic",
      started_at: null,
      expires_at: new Date(Date.now() + 30 * DAY).toISOString(),
      renews_automatically: false,
    });
  if (path === "/v1/devices") return reply(route, 200, { limit: 5, devices: [] });
  if (path === "/v1/devices/browser")
    return reply(route, 201, {
      device_id: "synthetic-renewal-device",
      name: "Synthetic browser",
      kind: "browser_extension",
      created_at: new Date().toISOString(),
    });
  if (path === "/v1/proxy/sessions" && method === "POST")
    return reply(route, 201, {
      id: `synthetic-renewal-session-${++sequence}`,
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
  if (path.startsWith("/v1/proxy/sessions/") && method === "DELETE") return reply(route, 204);
  return reply(route, 404, { error: "not_found" });
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
  await context.route(/^https:\/\/(?:api(?:64)?\.ipify\.org|ipv4\.icanhazip\.com)\//, (route) =>
    reply(route, 200, { ip: "203.0.113.8" }),
  );
  await context.route("https://api.fuzevpn.com/**", async (route) => {
    try {
      await api(route);
    } catch (error) {
      routeFailure ??= error;
      await route.abort("failed").catch(() => undefined);
    }
  });
  worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
  await installSyntheticAuth();
  const page = await context.newPage();
  page.on("pageerror", (error) => report.pageErrors.push(error.name));
  await page.goto(`chrome-extension://${worker.url().split("/")[2]}/popup/popup.html`);

  await login(page);
  const signIn = [...sessions.values()][0].upgradeToken;
  assert.equal(rotations.length, 1);
  assert.equal(rotations[0].route, "upgrade");
  assert.equal(rotations[0].token, signIn);
  assert.match(signIn, canonical32);
  assert(presented.length > 0, "Signing in did not read the account");
  assert(
    presented.every(({ token }) => token !== signIn && accepts(token)),
    "An account route received the sign-in token after its conversion",
  );
  record("Signing in converts the classic session once, with a canonical 32-byte identifier", {
    accountRequests: presented.length,
  });

  const connected = await command(page, { type: "connect", locationId: location.id });
  assert.equal(connected.ok, true);
  assert.equal(connected.snapshot.protected, true);
  await command(page, { type: "disconnect" });
  const converted = await storedSession(page);
  assert.equal(
    new Set(presented.map(({ token }) => token)).size,
    1,
    "Account routes received more than one token within the hour",
  );
  assert.equal(presented.at(-1).token, converted.credentials.accessToken);
  assert.equal(rotations.length, 1);
  record("Every account route presents the access token of the converted session");

  const stored = await storage(page);
  const { fuzevpnAccountSessions: renewable, ...otherLocal } = stored.local;
  assert.equal(renewable.version, 1);
  assert.equal(renewable.sessions.length, 1);
  assert.equal(converted.handle, signIn);
  assert.equal(converted.pending, null);
  assert.equal(stored.local.fuzevpnState.auth.accessToken, signIn);
  const elsewhere = JSON.stringify({ local: otherLocal, session: stored.session });
  for (const secret of [converted.credentials.accessToken, converted.credentials.refreshToken])
    assert(!elsewhere.includes(secret), "A renewable token was stored outside its record");
  const published = JSON.stringify(await snapshot(page));
  for (const secret of [signIn, ...Object.values(converted.credentials)])
    assert(!published.includes(secret), "The published state carries a session value");
  record("Renewable tokens are stored in their own record only and never published");

  await advanceClock(56 * 60_000);
  await snapshot(page);
  await waitUntil(() => rotations.length === 2, "The popup did not renew the expiring token");
  assert.deepEqual(
    { route: rotations[1].route, token: rotations[1].token },
    { route: "refresh", token: converted.credentials.refreshToken },
  );
  assert.notEqual(rotations[1].requestId, rotations[0].requestId);
  const renewed = await waitForRead(
    () => storedSession(page),
    (current) => current?.credentials.refreshToken.endsWith(".2") && current.pending === null,
    { message: "The renewed tokens were not stored" },
  );
  assert.equal(accepts(converted.credentials.accessToken), false);
  assert.equal(accepts(renewed.credentials.accessToken), true);
  const before = presented.length;
  const reconnected = await command(page, { type: "connect", locationId: location.id });
  assert.equal(reconnected.snapshot.protected, true);
  await command(page, { type: "disconnect" });
  assert(presented.length > before);
  assert(presented.slice(before).every(({ token }) => token === renewed.credentials.accessToken));
  record("An access token about to expire is renewed when the popup opens, then used everywhere");

  await advanceClock(56 * 60_000);
  loseNextAnswer = true;
  await snapshot(page);
  await waitUntil(() => rotations.length === 3, "The second renewal was not sent");
  const pending = await waitForRead(
    () => storedSession(page),
    (current) => current?.pending?.requestId === rotations[2].requestId,
    { message: "The renewal request was not stored with its tokens" },
  );
  assert.deepEqual(pending.pending, {
    route: "refresh",
    token: renewed.credentials.refreshToken,
    requestId: rotations[2].requestId,
  });
  assert.equal(pending.credentials.refreshToken, renewed.credentials.refreshToken);
  await restartWorker(page);
  // The new worker waits for the delay its stored request carries, then sends it again.
  const resumeBy = Date.now() + 15000;
  while (rotations.length < 4) {
    if (routeFailure) throw routeFailure;
    if (Date.now() >= resumeBy) throw new Error("The restarted worker did not resume the request");
    await snapshot(page);
    await new Promise((done) => setTimeout(done, 250));
  }
  assert.deepEqual(rotations[3], rotations[2]);
  // Tokens recovered while a refused request waits are renewed once more before that
  // request is sent again: the stored session ends at the generation of the server.
  const generation = () => [...sessions.values()][0]?.generation;
  const recovered = await waitForRead(
    () => storedSession(page),
    (current) =>
      current?.pending === null &&
      current.credentials.refreshToken.endsWith(`.${generation()}`) &&
      accepts(current.credentials.accessToken),
    { message: "The recovered tokens were not stored" },
  );
  assert.equal(sessions.size, 1);
  assert(generation() === 3 || generation() === 4, "The session was rotated more than once more");
  assert.equal(rotations.length, generation() + 1);
  if (rotations.length === 5) {
    assert.equal(rotations[4].route, "refresh");
    assert(rotations[4].token.endsWith(".3"), "A retired refresh token was presented again");
    assert.notEqual(rotations[4].requestId, rotations[3].requestId);
  }
  assert.notEqual((await snapshot(page)).profile, null);
  record("A lost renewal answer is recovered by the next worker with the unchanged request", {
    rotationsAfterRecovery: rotations.length - 4,
  });

  const leaving = await storedSession(page);
  assert.equal(leaving.pending, null);
  assert(leaving.credentials.refreshToken.endsWith(`.${generation()}`));
  assert(recovered.credentials.refreshToken.endsWith(".3") || generation() === 4);
  await command(page, { type: "logout" });
  await page.locator("#loginView").waitFor({ state: "visible" });
  assert.equal(logouts.length, 1);
  assert.equal(logouts[0].token, leaving.credentials.refreshToken);
  assert.equal(logouts[0].body, null);
  assert(
    logouts[0].headers.every((name) => !/context|cookie/i.test(name)),
    "Logout carried a browser-context header",
  );
  assert.equal(sessions.size, 0);
  const afterLogout = await storage(page);
  assert.deepEqual(afterLogout.local.fuzevpnAccountSessions.sessions, []);
  assert.equal(afterLogout.local.fuzevpnState?.auth ?? null, null);
  assert.deepEqual((await snapshot(page)).logoutOutcome, {
    apiSession: "confirmed",
    proxySessions: "confirmed",
  });
  record("Logout presents the refresh token without body and leaves no session stored");

  await login(page);
  assert.equal(rotations.at(-1).route, "upgrade");
  assert.equal(sessions.size, 1);
  // The server ends the session, as a password reset does.
  sessions.clear();
  await advanceClock(56 * 60_000);
  const requests = rotations.length;
  await command(page, { type: "connect", locationId: location.id });
  const ended = await waitForRead(
    () => snapshot(page),
    (current) => current.profile === null,
    { message: "A refused renewal did not end the account" },
  );
  assert.equal(ended.error, "unauthorized");
  assert.equal(rotations.length, requests + 1);
  assert.equal(rotations.at(-1).route, "refresh");
  assert.equal((await storage(page)).local.fuzevpnState?.auth ?? null, null);
  // The record of an account which storage no longer holds leaves storage with it.
  await waitForRead(
    () => storage(page),
    (current) => current.local.fuzevpnAccountSessions.sessions.length === 0,
    { message: "The refused session stayed in storage" },
  );
  record("A renewal which the server refuses ends the account and keeps no token");

  if (routeFailure) throw routeFailure;
  assert.equal(report.pageErrors.length, 0);
  report.rotations = rotations.map(({ route }) => route);
  report.result = "PASS";
} catch (error) {
  report.result = "FAIL";
  report.failure = { name: error.name, message: error.message };
  throw error;
} finally {
  await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2) + "\n");
  await context?.close();
}
