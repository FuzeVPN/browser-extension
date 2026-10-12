import { installSyntheticWebAuth, assertSyntheticTokenRequest } from "./synthetic-web-auth.mjs";
// SPDX-License-Identifier: MPL-2.0

// Isolated regression: a real HTTPS proxy challenges an already pending request
// only after the built extension has completed a voluntary disconnect.
// Synthetic credentials, loopback-only servers and temporary profiles only.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, X509Certificate } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:https";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { waitForRead } from "../../../scripts/browser-wait.mjs";

const root = resolve(import.meta.dirname, "../../..");
const require = createRequire(import.meta.url);
const runtime = join(homedir(), ".cache/codex-runtimes/codex-primary-runtime/dependencies");
let playwrightPath = process.env.PLAYWRIGHT_MODULE_PATH;
if (!playwrightPath) {
  try {
    playwrightPath = require.resolve("playwright");
  } catch {
    playwrightPath = join(runtime, "node/node_modules/playwright/index.mjs");
  }
}
const { chromium } = await import(pathToFileURL(resolve(playwrightPath)).href);
const testRoot = await mkdtemp(join(tmpdir(), "fuzevpn-proxy-auth-"));
const artifactRoot = resolve(
  process.env.PROXY_AUTH_OUTPUT ?? join(root, "security-audit/proxy-auth-fix"),
);
await mkdir(artifactRoot, { recursive: true });
const baseline = process.argv.includes("--baseline");
const report = {
  timestamp: new Date().toISOString(),
  baseline,
  isolation: "Temporary Chromium profile and local TLS proxy; synthetic API and credentials only",
  checks: [],
  limitations: [
    "Native login dialog visibility is not observed in headless Chromium; cancellation is verified through real onAuthRequired and network error events.",
    "No production VPN endpoint or API credentials are used.",
  ],
};
let context;
let server;
const sockets = new Set();
const pending = new Map();
const received = [];
const resolvers = new Map();
function record(name, details) {
  report.checks.push({ name, passed: true, details });
  process.stdout.write(`PASS ${name}\n`);
}
function waitForRequest(path) {
  if (pending.has(path)) return Promise.resolve(pending.get(path));
  return new Promise((done, reject) => {
    const timer = setTimeout(() => reject(new Error(`Proxy did not receive ${path}`)), 12000);
    resolvers.set(path, (request) => {
      clearTimeout(timer);
      done(request);
    });
  });
}

async function createLocalProxy() {
  const python = process.env.PYTHON_EXECUTABLE ?? join(runtime, "python/python.exe");
  const source = `from cryptography import x509
from cryptography.x509.oid import NameOID
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from datetime import datetime, timedelta, timezone
from pathlib import Path
import ipaddress, sys
key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "FuzeVPN isolated proxy test")])
now = datetime.now(timezone.utc)
cert = (x509.CertificateBuilder().subject_name(name).issuer_name(name).public_key(key.public_key())
 .serial_number(x509.random_serial_number()).not_valid_before(now-timedelta(minutes=5))
 .not_valid_after(now+timedelta(days=1))
 .add_extension(x509.SubjectAlternativeName([x509.IPAddress(ipaddress.ip_address("127.0.0.1"))]), critical=False)
 .sign(key, hashes.SHA256()))
Path(sys.argv[1], "test-key.pem").write_bytes(key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()))
Path(sys.argv[1], "test-cert.pem").write_bytes(cert.public_bytes(serialization.Encoding.PEM))
`;
  const generated = spawnSync(python, ["-c", source, testRoot], {
    encoding: "utf8",
    windowsHide: true,
  });
  assert.equal(generated.status, 0, generated.stderr);
  const key = await readFile(join(testRoot, "test-key.pem"));
  const cert = await readFile(join(testRoot, "test-cert.pem"));
  const spki = createHash("sha256")
    .update(new X509Certificate(cert).publicKey.export({ format: "der", type: "spki" }))
    .digest("base64");
  server = createServer({ key, cert }, (request, response) => {
    const url = new URL(request.url, "https://127.0.0.1");
    received.push({
      path: url.pathname,
      credentialsReceived: !!request.headers["proxy-authorization"],
    });
    if (["/origin-auth", "/explicit-auth-cancellation"].includes(url.pathname)) {
      response.writeHead(401, {
        "WWW-Authenticate": 'Basic realm="isolated-site-auth"',
        "Content-Length": "0",
      });
      response.end();
    } else if (
      url.pathname === "/rejected-auth" ||
      (url.pathname === "/active-auth" && !request.headers["proxy-authorization"])
    ) {
      response.writeHead(407, {
        "Proxy-Authenticate": 'Basic realm="isolated-active-proxy"',
        "Content-Length": "0",
      });
      response.end();
    } else if (url.pathname.startsWith("/delayed-")) {
      const value = { request, response };
      pending.set(url.pathname, value);
      resolvers.get(url.pathname)?.(value);
    } else {
      response.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "no-store" });
      response.end("<!doctype html><title>Isolated proxy fixture</title>");
    }
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  server.on("connect", (_request, socket) => socket.destroy());
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  return { port: server.address().port, spki };
}

async function installSyntheticApi(port) {
  let sessionNumber = 0;
  await context.route("https://api.fuzevpn.com/**", async (route) => {
    const url = new URL(route.request().url());
    const method = route.request().method();
    let status = 200;
    let body;
    if (url.pathname === "/v1/auth/extension/token") {
      await assertSyntheticTokenRequest(context, route.request());
      status = 201;
      body = {
        access_token: "isolated-proxy-auth-token",
        expires_at: new Date(Date.now() + 3600000).toISOString(),
      };
    } else if (url.pathname === "/v1/me") {
      body = {
        user_id: "isolated-proxy-auth",
        email: "audit@example.invalid",
        first_name: "Audit",
        last_name: "Only",
        country_code: "FR",
      };
    } else if (url.pathname === "/v1/billing/subscription") {
      body = {
        status: "active",
        has_access: true,
        offer_id: "audit-only",
        started_at: new Date(Date.now() - 60000).toISOString(),
        expires_at: new Date(Date.now() + 3600000).toISOString(),
        renews_automatically: false,
      };
    } else if (url.pathname === "/v1/locations") {
      body = {
        locations: [
          {
            id: "proxy-auth-audit",
            city: "Local audit",
            country_code: "FR",
            display_name: "Synthetic proxy auth audit",
            supported_protocols: ["browser_proxy"],
          },
        ],
      };
    } else if (url.pathname === "/v1/devices/browser") {
      status = 201;
      body = {
        device_id: "isolated-proxy-auth-device",
        name: "Audit only",
        kind: "browser_extension",
        created_at: new Date().toISOString(),
      };
    } else if (url.pathname === "/v1/devices") {
      body = { limit: 2, devices: [] };
    } else if (url.pathname === "/v1/proxy/sessions" && method === "POST") {
      status = 201;
      body = {
        id: `isolated-session-${++sessionNumber}`,
        location_id: "proxy-auth-audit",
        scheme: "https",
        host: "127.0.0.1",
        port,
        username: "synthetic-user",
        password: "synthetic-password",
        issued_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 1200000).toISOString(),
        refresh_after_seconds: 900,
      };
    } else if (method === "DELETE" || url.pathname === "/v1/auth/logout") {
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
}

async function verify() {
  const { port, spki } = await createLocalProxy();
  const extensionPath = process.env.EXTENSION_PATH ?? join(root, "dist/chrome");
  report.builtArtifact = {
    manifest: JSON.parse(await readFile(join(extensionPath, "manifest.json"), "utf8")).version,
    workerSha256: createHash("sha256")
      .update(await readFile(join(extensionPath, "background/service-worker.js")))
      .digest("hex"),
  };
  context = await chromium.launchPersistentContext(join(testRoot, "profile"), {
    channel: "chromium",
    headless: true,
    ...(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : {}),
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
      "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1, EXCLUDE [::1]",
      "--disable-background-networking",
      "--disable-quic",
      `--ignore-certificate-errors-spki-list=${spki}`,
    ],
  });
  report.chromium = context.browser().version();
  let worker =
    context.serviceWorkers()[0] ??
    (await context.waitForEvent("serviceworker", { timeout: 15000 }));
  await installSyntheticApi(port);
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${worker.url().split("/")[2]}/popup/popup.html`);
  async function message(request) {
    if (request.type === "web_login") await installSyntheticWebAuth(context);
    const response = await popup.evaluate((value) => chrome.runtime.sendMessage(value), request);
    assert(response?.ok, JSON.stringify(response));
    return response.snapshot;
  }
  await message({ type: "web_login", disconnectFirst: false });
  async function observe() {
    await popup.evaluate(() => {
      globalThis.auditAuth = [];
      chrome.webRequest.onAuthRequired.addListener(
        (details) => {
          globalThis.auditAuth.push({
            isProxy: details.isProxy,
            challenger: details.challenger,
            url: details.url,
          });
        },
        { urls: ["<all_urls>"] },
      );
    });
  }
  await observe();
  // Establish this Chromium version's actual error for explicit authentication
  // cancellation. This listener is removed before testing production behavior.
  await popup.evaluate(() => {
    globalThis.cancelOracle = (_details, callback) => callback({ cancel: true });
    chrome.webRequest.onAuthRequired.addListener(
      globalThis.cancelOracle,
      {
        urls: ["https://127.0.0.1/explicit-auth-cancellation"],
      },
      ["asyncBlocking"],
    );
  });
  const oraclePage = await context.newPage();
  const oracleOutcome = await oraclePage
    .goto(`https://127.0.0.1:${port}/explicit-auth-cancellation`, { timeout: 12000 })
    .then(
      () => ({ error: null }),
      (error) => ({ error: String(error.message) }),
    );
  await popup.evaluate(() =>
    chrome.webRequest.onAuthRequired.removeListener(globalThis.cancelOracle),
  );
  await oraclePage.close();
  const cancellationError = oracleOutcome.error?.match(/net::(ERR_[A-Z_]+)/)?.[1];
  assert.equal(cancellationError, "ERR_HTTP_RESPONSE_CODE_FAILURE");
  record(
    "Explicit authentication cancellation establishes Chromium error-code control",
    oracleOutcome,
  );
  const cdp = await context.newCDPSession(popup);
  const versions = new Map();
  cdp.on("ServiceWorker.workerVersionUpdated", ({ versions: changed }) => {
    for (const value of changed) versions.set(value.versionId, value);
  });
  await cdp.send("ServiceWorker.enable");
  async function waitUntil(condition, failure) {
    const deadline = Date.now() + 5000;
    while (!condition()) {
      if (Date.now() >= deadline) throw new Error(failure);
      await new Promise((done) => setTimeout(done, 25));
    }
  }
  for (const scenario of [
    { action: "disconnect", restartWorker: false, suffix: "completed disconnect" },
    { action: "disconnect", restartWorker: true, suffix: "worker restart" },
    { action: "logout", restartWorker: false, suffix: "account logout" },
  ]) {
    const { restartWorker } = scenario;
    const path = `/delayed-${scenario.action}${restartWorker ? "-worker-restart" : ""}`;
    const connected = await message({ type: "connect", locationId: "proxy-auth-audit" });
    assert.equal(connected.protected, true, JSON.stringify(connected));
    await popup.evaluate(() => {
      globalThis.auditAuth = [];
    });
    const page = await context.newPage();
    const navigation = page.goto(`http://public.audit.invalid${path}`, { timeout: 12000 }).then(
      () => ({ error: null }),
      (error) => ({ error: String(error.message) }),
    );
    const deferred = await waitForRequest(path);
    const disconnected = await message({ type: scenario.action });
    assert.equal(disconnected.protectionRequested, false, JSON.stringify(disconnected));
    const setting = await popup.evaluate(() => chrome.proxy.settings.get({ incognito: false }));
    assert.notEqual(setting.levelOfControl, "controlled_by_this_extension");
    if (restartWorker) {
      await waitUntil(
        () =>
          [...versions.values()].some(
            (value) => value.scriptURL === worker.url() && value.runningStatus === "running",
          ),
        "Worker version was not reported by DevTools",
      );
      const version = [...versions.values()].find(
        (value) => value.scriptURL === worker.url() && value.runningStatus === "running",
      );
      await cdp.send("ServiceWorker.stopWorker", { versionId: version.versionId });
      await waitUntil(
        () => versions.get(version.versionId)?.runningStatus === "stopped",
        "Worker did not stop before challenge",
      );
      report.workerStoppedBefore407 = true;
    }
    assert(
      !deferred.response.destroyed,
      "Chromium closed request before the delayed challenge was delivered",
    );
    deferred.response.writeHead(407, {
      "Proxy-Authenticate": 'Basic realm="isolated-delayed-proxy"',
      "Content-Length": "0",
    });
    deferred.response.end();
    const outcome = await navigation;
    const auth = await popup.evaluate(() => globalThis.auditAuth);
    const credentialsReceived = received.filter(
      (request) => request.path === path && request.credentialsReceived,
    ).length;
    const details = {
      proxyRemovedBefore407: true,
      workerStoppedBefore407: restartWorker,
      auth,
      outcome,
      credentialsReceived,
    };
    report.delayedChallenge = details;
    assert(auth.some((event) => event.isProxy && event.challenger.port === port));
    assert.equal(credentialsReceived, 0);
    if (baseline) {
      assert.match(outcome.error ?? "", /ERR_INVALID_AUTH_CREDENTIALS|Timeout/);
      record(
        `Baseline reproduces unhandled late proxy authentication after ${scenario.suffix}`,
        details,
      );
    } else {
      assert.equal(outcome.error?.match(/net::(ERR_[A-Z_]+)/)?.[1], cancellationError);
      record(`Late real HTTPS proxy challenge is cancelled after ${scenario.suffix}`, details);
    }
    await page.close();
    if (restartWorker) {
      worker =
        context.serviceWorkers()[0] ??
        (await context.waitForEvent("serviceworker", { timeout: 5000 }));
      assert.equal((await message({ type: "get_snapshot" })).protectionRequested, false);
    }
  }
  await message({ type: "web_login", disconnectFirst: false });
  const connected = await message({ type: "connect", locationId: "proxy-auth-audit" });
  assert.equal(connected.protected, true, JSON.stringify(connected));
  const activePage = await context.newPage();
  await activePage.goto("http://public.audit.invalid/active-auth", { timeout: 12000 });
  assert.equal(await activePage.title(), "Isolated proxy fixture");
  assert(
    received.some((request) => request.path === "/active-auth" && request.credentialsReceived),
  );
  record("Current active proxy still authenticates and loads a real page", { authenticated: true });

  if (!baseline) {
    await popup.evaluate(() => {
      globalThis.auditAuth = [];
    });
    const rejectedOutcome = await activePage
      .goto("http://public.audit.invalid/rejected-auth", { timeout: 12000 })
      .then(
        () => ({ error: null }),
        (error) => ({ error: String(error.message) }),
      );
    assert.equal(rejectedOutcome.error?.match(/net::(ERR_[A-Z_]+)/)?.[1], cancellationError);
    const rejected = await waitForRead(
      () => message({ type: "get_snapshot" }),
      (snapshot) => snapshot.error === "proxy_authentication_failed" && snapshot.trafficBlocked,
      { message: "Proxy authentication recovery did not block the rejected session" },
    );
    assert.equal(rejected.status, "blocked");
    assert.equal(rejected.protected, false);
    assert.equal(rejected.protectionRequested, true);
    assert.equal(rejected.nextRetryAt, null);
    const rejectedAuth = await popup.evaluate(() => globalThis.auditAuth);
    assert(
      rejectedAuth.filter((event) => event.isProxy && event.url.endsWith("/rejected-auth"))
        .length >= 2,
    );
    assert(
      received.some((request) => request.path === "/rejected-auth" && request.credentialsReceived),
    );
    const rejectedAlarms = await popup.evaluate(async () =>
      (await chrome.alarms.getAll()).map((alarm) => alarm.name),
    );
    assert(!rejectedAlarms.includes("fuzevpn-proxy-reconnect"));
    assert(!rejectedAlarms.includes("fuzevpn-proxy-refresh"));
    const recovered = await message({ type: "retry_connection" });
    assert.equal(recovered.protected, true);
    assert.equal(recovered.error, null);
    await activePage.goto("http://public.audit.invalid/active-auth", { timeout: 12000 });
    assert.equal(await activePage.title(), "Isolated proxy fixture");
    record(
      "Repeated real proxy rejection cancels the request, blocks the session and permits explicit retry",
      {
        rejectedOutcome,
        error: rejected.error,
        recovered: recovered.protected,
      },
    );
  }

  await message({ type: "disconnect" });
  await activePage.close();
  await popup.evaluate(() => {
    globalThis.auditAuth = [];
  });
  const originPage = await context.newPage();
  const originOutcome = await originPage
    .goto(`https://127.0.0.1:${port}/origin-auth`, { timeout: 12000 })
    .then(
      () => ({ error: null }),
      (error) => ({ error: String(error.message) }),
    );
  const originAuth = await popup.evaluate(() => globalThis.auditAuth);
  assert(originAuth.some((event) => event.isProxy === false && event.challenger.port === port));
  assert.match(originOutcome.error ?? "", /ERR_INVALID_AUTH_CREDENTIALS/);
  record("Ordinary website authentication at remembered host and port remains untouched", {
    originAuth,
    outcome: originOutcome,
  });
  await originPage.close();
  await cdp.detach();
  report.passed = true;
}

try {
  await verify();
} catch (error) {
  report.passed = false;
  report.failure = String(error.stack ?? error);
  process.exitCode = 1;
} finally {
  if (context) await context.close();
  for (const socket of sockets) socket.destroy();
  if (server) await new Promise((done) => server.close(done));
  const reportPath = join(
    artifactRoot,
    baseline ? "browser-baseline.json" : "browser-corrected.json",
  );
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`Report: ${reportPath}\n`);
  if (report.failure) process.stderr.write(`${report.failure}\n`);
}
