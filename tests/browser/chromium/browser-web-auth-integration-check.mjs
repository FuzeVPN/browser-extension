// SPDX-License-Identifier: MPL-2.0

// Real Chrome identity web flow against loopback HTTPS only; the API is intercepted.
// Run after build; no Google account, production API or production DNS is contacted.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomBytes, X509Certificate } from "node:crypto";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { createServer } from "node:https";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { waitForRead } from "../../../scripts/browser-wait.mjs";
import {
  assertInsideProject,
  fileHashes,
  projectRoot,
  runDirectory,
  sha256,
  writeJson,
} from "../../../scripts/validation-common.mjs";

const output = assertInsideProject(
  resolve(process.env.WEB_AUTH_INTEGRATION_OUTPUT ?? runDirectory("web-auth-integration")),
);
await mkdir(output, { recursive: true });
// Keep the browser profile short even when the evidence output has a long audit path.
const nativeRuntime = assertInsideProject(join(projectRoot, "node_modules/.cache/validation"));
await mkdir(nativeRuntime, { recursive: true });
const temporary = await mkdtemp(join(nativeRuntime, "wa-"));
const runtime = join(homedir(), ".cache/codex-runtimes/codex-primary-runtime/dependencies");
const playwright =
  process.env.PLAYWRIGHT_MODULE_PATH ?? join(runtime, "node/node_modules/playwright/index.mjs");
const { chromium } = await import(pathToFileURL(resolve(playwright)).href);
const extension = assertInsideProject(
  resolve(process.env.CHROME_EXTENSION_DIR ?? join(projectRoot, "dist/chrome")),
);
const builtHashes = fileHashes(extension);
const clientOrigin = "https://app.fuzevpn.com";
const authPath = "/extension/connect";
const tokenPath = "/v1/auth/extension/token";
const canonical32 = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;
const accessToken = "synthetic-native-web-auth-token";
const secrets = new Set([accessToken]);
const attempts = [];
const apiRequests = [];
const sockets = new Set();
let mode = "success";
let context;
let server;
let popup;
let worker;
let expectedRedirect;
let routeFailure;
const report = {
  timestamp: new Date().toISOString(),
  scope:
    "Unmodified built extension, native chrome.identity, loopback TLS and intercepted synthetic API",
  limitations: [
    "Google/provider login, production API and store extension IDs are not validated.",
    "Synthetic access tokens follow the existing account-storage contract; PKCE verifier, state and one-use code must never be persisted.",
    "The public manifest key fixes this local callback; installed store packages are not validated by this synthetic test.",
  ],
  checks: [],
  unexpectedRequests: [],
  pageErrors: [],
  builtArtifact: {
    version: JSON.parse(await readFile(join(extension, "manifest.json"), "utf8")).version,
    distSha256: sha256(JSON.stringify(builtHashes)),
  },
};

function check(name, details) {
  report.checks.push({ name, passed: true, ...(details ? { details } : {}) });
  process.stdout.write(`PASS ${name}\n`);
}

function redact(value) {
  let result = String(value);
  for (const secret of secrets) result = result.replaceAll(secret, "[redacted]");
  return result;
}

async function localTls() {
  const python = process.env.PYTHON_EXECUTABLE ?? join(runtime, "python/python.exe");
  const generated = spawnSync(
    python,
    [
      "-B",
      "-c",
      `from cryptography import x509
from cryptography.x509.oid import NameOID
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from datetime import datetime, timedelta, timezone
from pathlib import Path
import sys
key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "FuzeVPN isolated web auth fixture")])
now = datetime.now(timezone.utc)
cert = (x509.CertificateBuilder().subject_name(name).issuer_name(name).public_key(key.public_key())
 .serial_number(x509.random_serial_number()).not_valid_before(now-timedelta(minutes=5))
 .not_valid_after(now+timedelta(days=1))
 .add_extension(x509.SubjectAlternativeName([x509.DNSName("app.fuzevpn.com")]), critical=False)
 .sign(key, hashes.SHA256()))
Path(sys.argv[1], "fixture-key.pem").write_bytes(key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()))
Path(sys.argv[1], "fixture-cert.pem").write_bytes(cert.public_bytes(serialization.Encoding.PEM))
`,
      temporary,
    ],
    { encoding: "utf8", windowsHide: true, timeout: 30_000 },
  );
  assert.equal(generated.status, 0, generated.stderr);
  const key = await readFile(join(temporary, "fixture-key.pem"));
  const cert = await readFile(join(temporary, "fixture-cert.pem"));
  const spki = createHash("sha256")
    .update(new X509Certificate(cert).publicKey.export({ format: "der", type: "spki" }))
    .digest("base64");
  server = createServer({ key, cert }, (request, response) => {
    const url = new URL(request.url, clientOrigin);
    if (url.pathname !== authPath) {
      response.writeHead(404).end();
      return;
    }
    const attempt = {
      mode,
      requestMethod: request.method,
      requestHost: request.headers.host,
      url,
      response,
      code: randomBytes(32).toString("base64url"),
      completed: false,
    };
    for (const value of [
      attempt.code,
      url.searchParams.get("state"),
      url.searchParams.get("code_challenge"),
    ])
      if (value) secrets.add(value);
    attempts.push(attempt);
    if (mode === "hold") return;
    if (mode === "cancel") {
      response.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "no-store" });
      response.end(
        "<!doctype html><meta charset=utf-8><title>FuzeVPN synthetic authentication</title><h1>Local authentication fixture</h1><p>No account or external provider is contacted.</p>",
      );
      return;
    }
    complete(attempt);
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  return { port: server.address().port, spki };
}

function complete(attempt) {
  assert.equal(attempt.completed, false, "Synthetic authorization must complete once");
  attempt.completed = true;
  const callback = new URL(attempt.url.searchParams.get("redirect_uri"));
  callback.searchParams.set("state", attempt.url.searchParams.get("state"));
  if (attempt.mode === "denied") callback.searchParams.set("error", "access_denied");
  else callback.searchParams.set("code", attempt.code);
  if (attempt.mode === "wrong-state")
    callback.searchParams.set("state", randomBytes(32).toString("base64url"));
  if (attempt.mode === "duplicate-code") callback.searchParams.append("code", attempt.code);
  attempt.response.writeHead(302, { Location: callback.href, "Cache-Control": "no-store" });
  attempt.response.end();
}

async function api(route) {
  try {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const method = request.method();
    apiRequests.push({ path, method });
    let status = 200;
    let body;
    if (path === tokenPath) {
      assert.equal(method, "POST");
      const payload = request.postDataJSON();
      assert.deepEqual(Object.keys(payload).sort(), [
        "client_id",
        "code",
        "code_verifier",
        "redirect_uri",
      ]);
      const attempt = attempts.find((candidate) => candidate.code === payload.code);
      assert.ok(attempt, "Code was not issued by the isolated local authentication server");
      assert.ok(!attempt.exchanged, "Authorization code exchanged more than once");
      attempt.exchanged = true;
      secrets.add(payload.code_verifier);
      assert.ok(
        canonical32.test(payload.code),
        "Authorization code does not encode 32 bytes canonically",
      );
      assert.ok(
        canonical32.test(payload.code_verifier),
        "PKCE verifier does not encode 32 bytes canonically",
      );
      assert.ok(payload.client_id === "fuzevpn-browser-extension", "Unexpected client identifier");
      assert.ok(
        payload.redirect_uri === expectedRedirect,
        "Exchange redirect differs from native redirect",
      );
      assert.ok(
        createHash("sha256").update(payload.code_verifier).digest("base64url") ===
          attempt.url.searchParams.get("code_challenge"),
        "Verifier does not prove the native PKCE challenge",
      );
      assert.ok(
        !request.headers().authorization,
        "Code exchange must not reuse an existing account token",
      );
      status = 201;
      body = {
        access_token: accessToken,
        expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      };
    } else if (path === "/v1/me") {
      assert.ok(
        request.headers().authorization === `Bearer ${accessToken}`,
        "Profile uses the wrong access token",
      );
      body = {
        user_id: "synthetic-google-user",
        email: "google-user@example.invalid",
        first_name: "Synthetic",
        last_name: "Account",
        country_code: "FR",
      };
    } else if (path === "/v1/billing/subscription") {
      body = {
        status: "active",
        has_access: true,
        offer_id: "synthetic",
        started_at: null,
        expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        renews_automatically: false,
      };
    } else if (path === "/v1/locations") {
      body = {
        locations: [
          {
            id: "synthetic-fr",
            city: "Paris",
            country_code: "FR",
            display_name: "Synthetic Paris",
            supported_protocols: ["browser_proxy"],
          },
        ],
      };
    } else if (path === "/v1/devices") {
      body = { limit: 2, devices: [] };
    } else if (path === "/v1/devices/browser") {
      status = 201;
      body = {
        device_id: "synthetic-native-device",
        name: "Synthetic Chrome",
        kind: "browser_extension",
        created_at: new Date().toISOString(),
      };
    } else if (path === "/v1/auth/logout" || method === "DELETE") status = 204;
    else {
      report.unexpectedRequests.push({ origin: "https://api.fuzevpn.com", path, method });
      status = 404;
      body = { error: "not_found" };
    }
    await route.fulfill({
      status,
      headers: { "Cache-Control": "no-store" },
      ...(body === undefined
        ? {}
        : { contentType: "application/json", body: JSON.stringify(body) }),
    });
  } catch (error) {
    routeFailure = error;
    await route.abort("failed").catch(() => undefined);
  }
}

async function command(message) {
  return popup.evaluate((request) => chrome.runtime.sendMessage(request), message);
}

async function snapshot() {
  return (await command({ type: "get_snapshot" })).snapshot;
}

async function settled() {
  return waitForRead(snapshot, (state) => state && !state.webLoginPending, {
    timeoutMs: 15_000,
    message: "Native web authentication did not settle",
  });
}

function tokenCount() {
  return apiRequests.filter(({ path }) => path === tokenPath).length;
}

async function start(nextMode) {
  mode = nextMode;
  const before = attempts.length;
  await popup.locator("#loginButton").waitFor({ state: "visible" });
  await popup.waitForFunction(() => !document.getElementById("loginButton").disabled);
  await popup.locator("#loginButton").click();
  const attempt = await waitForRead(() => attempts[before], Boolean, {
    timeoutMs: 15_000,
    message: "Native identity did not reach the loopback HTTPS authentication page",
  });
  assert.equal(attempt.requestMethod, "GET");
  assert.equal(attempt.requestHost, "app.fuzevpn.com");
  assert.ok(
    attempt.url.origin + attempt.url.pathname === clientOrigin + authPath,
    "Unexpected native authentication endpoint",
  );
  const query = attempt.url.searchParams;
  assert.deepEqual([...query.keys()].sort(), [
    "client_id",
    "code_challenge",
    "code_challenge_method",
    "locale",
    "redirect_uri",
    "state",
  ]);
  assert.equal(query.get("client_id"), "fuzevpn-browser-extension");
  assert.equal(query.get("code_challenge_method"), "S256");
  assert.ok(
    query.get("redirect_uri") === expectedRedirect,
    "Native redirect differs from getRedirectURL",
  );
  assert.ok(canonical32.test(query.get("state")), "State must be 32 canonical random bytes");
  assert.ok(
    canonical32.test(query.get("code_challenge")),
    "Challenge must be SHA256 in canonical base64url",
  );
  assert.equal(query.get("locale"), "fr");
  return attempt;
}

async function flowSecretsAbsent() {
  const stored = await popup.evaluate(async () => ({
    local: await chrome.storage.local.get(null),
    session: await chrome.storage.session.get(null),
  }));
  const encoded = JSON.stringify(stored);
  for (const secret of secrets)
    if (secret !== accessToken)
      assert.ok(
        !encoded.includes(secret),
        "PKCE material or one-use code found in extension storage",
      );
  assert.ok(
    !/code_verifier|client_secret|code_challenge/.test(encoded),
    "OAuth secret fields persisted in extension storage",
  );
  assert.equal(await popup.locator("input[type=password], input[type=email]").count(), 0);
  assert.equal(apiRequests.filter(({ path }) => path === "/v1/auth/login").length, 0);
}

async function capture(name) {
  await popup.screenshot({
    path: join(output, `${name}.png`),
    fullPage: true,
    animations: "disabled",
  });
  const state = await snapshot();
  await writeJson(join(output, `${name}-status.json`), {
    status: state.status,
    error: state.error,
    webLoginPending: state.webLoginPending,
    hasProfile: !!state.profile,
    hasSubscriptionAccess: state.subscription?.hasAccess === true,
    protected: state.protected,
    trafficBlocked: state.trafficBlocked,
  });
}

try {
  const { port, spki } = await localTls();
  context = await chromium.launchPersistentContext(join(temporary, "profile"), {
    channel: "chromium",
    headless: true,
    viewport: { width: 360, height: 600 },
    ...(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : {}),
    args: [
      `--disable-extensions-except=${extension}`,
      `--load-extension=${extension}`,
      `--host-resolver-rules=MAP app.fuzevpn.com 127.0.0.1:${port}, MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1, EXCLUDE [::1]`,
      "--disable-background-networking",
      "--disable-quic",
      `--ignore-certificate-errors-spki-list=${spki}`,
    ],
  });
  context.setDefaultTimeout(15_000);
  report.chromium = context.browser().version();
  await context.route(/^https?:\/\//, async (route) => {
    const url = new URL(route.request().url());
    if (url.origin === clientOrigin) return route.continue();
    report.unexpectedRequests.push({ origin: url.origin, path: url.pathname });
    return route.abort("blockedbyclient");
  });
  await context.route(/^https:\/\/api(?:64)?\.ipify\.org\//, (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: '{"ip":"9.9.9.9"}' }),
  );
  await context.route("https://ipv4.icanhazip.com/", (route) =>
    route.fulfill({ status: 200, contentType: "text/plain", body: "9.9.9.9\n" }),
  );
  await context.route("https://api.fuzevpn.com/**", api);
  worker =
    context.serviceWorkers()[0] ??
    (await context.waitForEvent("serviceworker", { timeout: 15_000 }));
  popup = await context.newPage();
  popup.on("pageerror", (error) => report.pageErrors.push(redact(error.message)));
  await popup.goto(`chrome-extension://${worker.url().split("/")[2]}/popup/popup.html`);
  expectedRedirect = await popup.evaluate(() => chrome.identity.getRedirectURL("auth"));
  assert.match(expectedRedirect, /^https:\/\/[a-p]{32}\.chromiumapp\.org\/auth$/);
  report.unpackedIdentity = {
    extensionId: worker.url().split("/")[2],
    redirectUri: expectedRedirect,
    extensionDirectory: extension,
    storeId: null,
  };
  await command({ type: "set_language_preference", preference: "fr" });
  await popup.waitForFunction(() => document.documentElement.lang === "fr");
  await flowSecretsAbsent();
  check("Popup offers centralized web sign-in without email/password fields");

  const before = tokenCount();
  await start("success");
  const success = await settled();
  if (routeFailure) throw routeFailure;
  assert.equal(success.profile?.userId, "synthetic-google-user");
  assert.equal(success.profile?.email, "google-user@example.invalid");
  assert.equal(success.subscription?.hasAccess, true);
  assert.equal(success.status, "disconnected");
  assert.equal(success.locations[0]?.id, "synthetic-fr");
  assert.equal(tokenCount(), before + 1);
  await popup.locator("#mainView").waitFor({ state: "visible" });
  await capture("native-success");
  await flowSecretsAbsent();
  check(
    "Native Chrome flow validates state, S256 proof and exchanges one local code exactly once",
    {
      redirectUri: expectedRedirect,
      codeBytes: 32,
      stateBytes: 32,
      pkce: "S256",
      tokenExchanges: 1,
    },
  );
  check("Web-authenticated synthetic account hydrates profile, subscription and locations");

  const logout = await command({ type: "logout" });
  assert.equal(logout.ok, true);
  await popup.locator("#loginView").waitFor({ state: "visible" });
  for (const [scenario, expected] of [
    ["denied", "web_login_denied"],
    ["wrong-state", "web_login_invalid_callback"],
    ["duplicate-code", "web_login_invalid_callback"],
  ]) {
    const previous = tokenCount();
    await start(scenario);
    const rejected = await settled();
    assert.equal(rejected.profile, null);
    assert.equal(rejected.error, expected);
    assert.equal(tokenCount(), previous);
    await flowSecretsAbsent();
    await capture(`native-${scenario}`);
    check(`Native ${scenario} return does not exchange a code or create a session`);
  }

  const windowsBefore = await popup.evaluate(async () =>
    (await chrome.windows.getAll()).map(({ id }) => id),
  );
  const cancelCount = tokenCount();
  await start("cancel");
  const nativeWindow = await waitForRead(
    () => popup.evaluate(async () => (await chrome.windows.getAll()).map(({ id }) => id)),
    (ids) => ids.some((id) => !windowsBefore.includes(id)),
    { timeoutMs: 5_000, message: "Native authentication window is not available for cancellation" },
  );
  const nativeId = nativeWindow.find((id) => !windowsBefore.includes(id));
  await popup.evaluate((windowId) => chrome.windows.remove(windowId), nativeId);
  const cancelled = await settled();
  assert.equal(cancelled.profile, null);
  assert.equal(cancelled.error, "web_login_cancelled");
  assert.equal(tokenCount(), cancelCount);
  await capture("native-cancelled");
  check("Closing the real native authentication window cancels sign-in without creating a session");

  const lateCount = tokenCount();
  const lateWindowsBefore = await popup.evaluate(async () =>
    (await chrome.windows.getAll()).map(({ id }) => id),
  );
  const held = await start("hold");
  const pending = await snapshot();
  assert.equal(pending.webLoginPending, true);
  const stopped = await command({ type: "logout" });
  assert.equal(stopped.ok, true);
  complete(held);
  await waitForRead(
    () => popup.evaluate(async () => (await chrome.windows.getAll()).map(({ id }) => id)),
    (ids) => ids.every((id) => lateWindowsBefore.includes(id)),
    { message: "Late native callback did not close its browser authentication window" },
  );
  await settled();
  // Confirm the invalidated attempt is retired before testing a fresh sign-in.
  const late = await waitForRead(
    snapshot,
    (state) => !state.webLoginPending && state.profile === null,
    { message: "Logout did not invalidate pending identity flow" },
  );
  assert.equal(late.profile, null);
  assert.equal(tokenCount(), lateCount);
  await capture("native-logout-late-return");
  await flowSecretsAbsent();
  check("Logout invalidates a pending native flow; its later valid return cannot create a session");
  await start("success");
  const restarted = await settled();
  assert.equal(restarted.profile?.userId, "synthetic-google-user");
  assert.equal(restarted.status, "disconnected");
  assert.equal(tokenCount(), lateCount + 1);
  await flowSecretsAbsent();
  check("A fresh native sign-in succeeds after invalidation; the old code is never exchanged");
  assert.deepEqual(report.unexpectedRequests, []);
  assert.deepEqual(report.pageErrors, []);
  if (routeFailure) throw routeFailure;
  assert.deepEqual(fileHashes(extension), builtHashes, "Built extension changed during validation");
  check(
    "No production requests, no PKCE secrets persisted and the built distribution is unchanged",
  );
  report.completed = true;
} catch (error) {
  report.failure = redact(error.stack ?? error);
  process.exitCode = 1;
  if (popup) {
    const state = await snapshot().catch(() => null);
    if (state)
      report.failureStatus = {
        status: state.status,
        error: state.error,
        webLoginPending: state.webLoginPending,
        hasProfile: !!state.profile,
        trafficBlocked: state.trafficBlocked,
        protectionRequested: state.protectionRequested,
      };
    report.apiPaths = apiRequests;
    if (worker)
      report.workerStorageProbe = await worker
        .evaluate(async () => {
          try {
            const database = await new Promise((resolve, reject) => {
              const request = indexedDB.open("fuzevpn-device-identity", 1);
              request.onsuccess = () => resolve(request.result);
              request.onerror = () => reject(request.error);
            });
            const stores = Array.from(database.objectStoreNames);
            if (!stores.includes("keys")) return { stores };
            const result = await new Promise((resolve, reject) => {
              const request = database
                .transaction("keys", "readonly")
                .objectStore("keys")
                .get("browser-p256-account-v1:synthetic-google-user");
              request.onsuccess = () => resolve(request.result);
              request.onerror = () => reject(request.error);
            });
            database.close();
            return { stores, hasRecord: result !== undefined };
          } catch (error) {
            return { name: error.name, message: error.message };
          }
        })
        .catch(() => null);
  }
  if (popup)
    await popup
      .screenshot({ path: join(output, "failure.png"), fullPage: true })
      .catch(() => undefined);
} finally {
  await context?.close();
  for (const socket of sockets) socket.destroy();
  if (server) await new Promise((done) => server.close(done));
  await writeJson(join(output, "report.json"), report);
  process.stdout.write(JSON.stringify(report, null, 2));
}
