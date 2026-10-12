import { installSyntheticWebAuth, assertSyntheticTokenRequest } from "./synthetic-web-auth.mjs";
// SPDX-License-Identifier: MPL-2.0

// Real Chromium routing checks: an isolated TLS proxy and direct HTTP/HTTPS origins.
// API and ipify responses are synthetic. Proxy settings, DNR and tested destination requests are real.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, X509Certificate } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { createRequire } from "node:module";
import { createConnection } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

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
const testRoot = await mkdtemp(join(tmpdir(), "fuzevpn-site-exclusions-"));
const artifactRoot = resolve(
  process.env.SITE_EXCLUSIONS_NETWORK_OUTPUT ??
    join(root, "security-audit/site-exclusions/network"),
);
await mkdir(artifactRoot, { recursive: true });
const report = {
  timestamp: new Date().toISOString(),
  isolation:
    "Temporary Chromium profile, loopback-only direct HTTP/HTTPS origins and real HTTPS proxy with CONNECT; synthetic API, ipify and credentials only",
  checks: [],
  limitations: [
    "No production endpoint, real account or Internet destination is used.",
    "These checks cover newly opened requests; existing site connections may require a reload.",
    "API expiration reproduces a verified kill-switch outage without mocking proxy settings or DNR.",
    "ipify responses are synthetic to keep popup probes from introducing unrelated TLS tunnel errors; this is not an IP measurement test.",
    "Recovery checks pause the final local policy write before or after it commits, then terminate the test worker; proxy settings and DNR continue to run in Chromium.",
  ],
};
const sockets = new Set();
const requests = [];
let context;
let proxyServer;
let directServer;
let directTlsServer;
let proxiedTlsServer;
let directPort;
let directTlsPort;
let apiExpired = false;
let sessionsCreated = 0;
let requestSerial = 0;

function record(name, details) {
  report.checks.push({ name, passed: true, details });
  process.stdout.write(`PASS ${name}\n`);
}
function track(server) {
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
}
async function listen(server) {
  track(server);
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  return server.address().port;
}
function respond(route, request, response) {
  const url = new URL(
    request.url,
    `${request.socket.encrypted ? "https" : "http"}://${request.headers.host}`,
  );
  requests.push({ route, protocol: url.protocol, host: url.hostname, path: url.pathname });
  const headers = { "Cache-Control": "no-store", Connection: "close" };
  if (url.pathname.endsWith("/third-party.js")) {
    response.writeHead(200, { ...headers, "Content-Type": "text/javascript" });
    response.end(`document.documentElement.dataset.thirdPartyRoute=${JSON.stringify(route)};`);
  } else {
    const script = url.pathname.includes("/third-party-page")
      ? `<script src="${url.protocol}//cdn.example.org:${url.protocol === "https:" ? directTlsPort : directPort}/third-party.js"></script>`
      : "";
    response.writeHead(200, { ...headers, "Content-Type": "text/html" });
    response.end(
      `<!doctype html><html data-route="${route}"><title>${route}</title><body>${route}${script}</body></html>`,
    );
  }
}
async function startServers() {
  directServer = createHttpServer((request, response) => respond("direct", request, response));
  directPort = await listen(directServer);
  const python = process.env.PYTHON_EXECUTABLE ?? join(runtime, "python/python.exe");
  const source = `from cryptography import x509
from cryptography.x509.oid import NameOID
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from datetime import datetime, timedelta, timezone
from pathlib import Path
import ipaddress, sys
key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "FuzeVPN isolated site exclusions")])
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
  directTlsServer = createHttpsServer({ key, cert }, (request, response) =>
    respond("direct", request, response),
  );
  directTlsPort = await listen(directTlsServer);
  proxiedTlsServer = createHttpsServer({ key, cert }, (request, response) =>
    respond("proxy", request, response),
  );
  const proxiedTlsPort = await listen(proxiedTlsServer);
  proxyServer = createHttpsServer({ key, cert }, (request, response) => {
    if (!request.headers["proxy-authorization"]) {
      response.writeHead(407, {
        "Proxy-Authenticate": 'Basic realm="isolated-exclusions"',
        "Content-Length": "0",
      });
      response.end();
      return;
    }
    respond("proxy", request, response);
  });
  proxyServer.on("connect", (request, socket, head) => {
    if (!request.headers["proxy-authorization"]) {
      socket.end(
        'HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="isolated-exclusions"\r\nContent-Length: 0\r\nConnection: close\r\n\r\n',
      );
      return;
    }
    // The test proxy never connects to a requested Internet host: its only
    // tunnel destination is the local TLS fixture, on a dedicated marker origin.
    if (!request.url.endsWith(`:${directTlsPort}`)) return socket.destroy();
    const origin = createConnection({ host: "127.0.0.1", port: proxiedTlsPort }, () => {
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) origin.write(head);
      origin.pipe(socket);
      socket.pipe(origin);
    });
    sockets.add(origin);
    origin.on("close", () => sockets.delete(origin));
    origin.on("error", () => socket.destroy());
    socket.on("error", () => origin.destroy());
    socket.on("close", () => origin.destroy());
  });
  const proxyPort = await listen(proxyServer);
  return { proxyPort, spki };
}
async function installSyntheticApi(proxyPort) {
  for (const origin of ["https://api.ipify.org", "https://api64.ipify.org"]) {
    await context.route(`${origin}/**`, (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ip: "185.159.157.10" }),
      }),
    );
  }
  await context.route("https://api.fuzevpn.com/**", async (route) => {
    const url = new URL(route.request().url());
    const method = route.request().method();
    let status = 200;
    let body;
    if (url.pathname === "/v1/auth/extension/token") {
      await assertSyntheticTokenRequest(context, route.request());
      status = 201;
      body = {
        access_token: "isolated-exclusions-token",
        expires_at: new Date(Date.now() + 3600000).toISOString(),
      };
    } else if (apiExpired && method !== "DELETE" && url.pathname !== "/v1/auth/logout") {
      status = 401;
      body = { error: "unauthorized" };
    } else if (url.pathname === "/v1/me") {
      body = {
        user_id: "isolated-exclusions",
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
            id: "exclusions-audit",
            city: "Local audit",
            country_code: "FR",
            display_name: "Synthetic exclusion audit",
            supported_protocols: ["browser_proxy"],
          },
        ],
      };
    } else if (url.pathname === "/v1/devices/browser") {
      status = 201;
      body = {
        device_id: "isolated-exclusions-device",
        name: "Audit only",
        kind: "browser_extension",
        created_at: new Date().toISOString(),
      };
    } else if (url.pathname === "/v1/devices") {
      body = { limit: 2, devices: [] };
    } else if (url.pathname === "/v1/proxy/sessions" && method === "POST") {
      sessionsCreated += 1;
      status = 201;
      body = {
        id: `isolated-exclusions-session-${sessionsCreated}`,
        location_id: "exclusions-audit",
        scheme: "https",
        host: "127.0.0.1",
        port: proxyPort,
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
  const { proxyPort, spki } = await startServers();
  const extensionPath = process.env.EXTENSION_PATH ?? join(root, "dist/chrome");
  report.builtArtifact = {
    manifest: JSON.parse(await readFile(join(extensionPath, "manifest.json"), "utf8")).version,
    workerSha256: createHash("sha256")
      .update(await readFile(join(extensionPath, "background/service-worker.js")))
      .digest("hex"),
  };
  const hosts = [
    "example.com",
    "*.example.com",
    "example.com.",
    "*.example.com.",
    "example.org",
    "*.example.org",
    "example.org.",
    "*.example.org.",
    "otherexample.com",
  ];
  context = await chromium.launchPersistentContext(join(testRoot, "profile"), {
    channel: "chromium",
    headless: true,
    ...(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : {}),
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
      `--host-resolver-rules=${hosts.map((host) => `MAP ${host} 127.0.0.1`).join(", ")}, MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1, EXCLUDE [::1]`,
      "--disable-background-networking",
      "--disable-quic",
      `--ignore-certificate-errors-spki-list=${spki}`,
    ],
  });
  report.chromium = context.browser().version();
  const worker =
    context.serviceWorkers()[0] ??
    (await context.waitForEvent("serviceworker", { timeout: 15000 }));
  await installSyntheticApi(proxyPort);
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${worker.url().split("/")[2]}/popup/popup.html`);
  async function message(request, expectedError = null) {
    if (request.type === "web_login") await installSyntheticWebAuth(context);
    const response = await popup.evaluate((value) => chrome.runtime.sendMessage(value), request);
    if (!response?.ok && !expectedError) {
      report.failedCommandDiagnostics = await popup.evaluate(async () => ({
        proxy: await chrome.proxy.settings.get({ incognito: false }),
        dynamic: await chrome.declarativeNetRequest.getDynamicRules(),
        session: await chrome.declarativeNetRequest.getSessionRules(),
        policy: await chrome.storage.local.get("fuzevpnSiteExclusions"),
      }));
    }
    if (expectedError) {
      assert.equal(response?.ok, false, JSON.stringify(response));
      assert.equal(response.commandError, expectedError);
    } else assert(response?.ok, JSON.stringify(response));
    return response.snapshot;
  }
  async function update(entries, enabled = true) {
    const previous = await message({ type: "get_snapshot" });
    const snapshot = await message({
      type: "update_site_exclusions",
      expectedRevision: previous.siteExclusions.saved.revision,
      enabled,
      entries,
    });
    assert.equal(snapshot.siteExclusions.pending, false, JSON.stringify(snapshot));
    assert.equal(snapshot.siteExclusions.error, false, JSON.stringify(snapshot));
    assert.deepEqual(snapshot.siteExclusions.applied, snapshot.siteExclusions.saved);
    return snapshot;
  }
  async function routeIs(host, expected, path = "route", protocol = "http") {
    const page = await context.newPage();
    const uniquePath = `/${path}-${++requestSerial}`;
    try {
      const outcome = await page
        .goto(
          `${protocol}://${host}:${protocol === "https" ? directTlsPort : directPort}${uniquePath}`,
          { timeout: 12000 },
        )
        .then(
          () => null,
          (error) => String(error.message),
        );
      if (expected === "blocked") {
        assert.match(outcome ?? "", /net::ERR_BLOCKED_BY_CLIENT/, `${host}: ${outcome}`);
        assert(
          !requests.some((request) => request.path === uniquePath),
          "Blocked request reached a server",
        );
      } else {
        assert.equal(outcome, null, `${host}: ${outcome}`);
        assert.equal(await page.locator("html").getAttribute("data-route"), expected, host);
        assert(
          requests.some((request) => request.path === uniquePath && request.route === expected),
          "No matching server request",
        );
      }
    } finally {
      await page.close();
    }
  }
  const initial = await message({ type: "get_snapshot" });
  assert.deepEqual(initial.siteExclusions.saved.entries, []);
  assert.equal(initial.siteExclusions.saved.enabled, false);
  record("Fresh installation has no excluded sites", {});
  await message({ type: "web_login", disconnectFirst: false });
  const exact = [{ domain: "example.com", includeSubdomains: false }];
  await update(exact);
  assert.equal(sessionsCreated, 0);
  record("Saving an exception while disconnected creates no proxy session", {});
  const connected = await message({ type: "connect", locationId: "exclusions-audit" });
  assert.equal(connected.protected, true, JSON.stringify(connected));
  await routeIs("example.com", "direct");
  record("Exact excluded domain bypasses the real TLS proxy", {});
  await routeIs("shop.example.com", "proxy");
  await routeIs("otherexample.com", "proxy");
  record("Exact exception leaves subdomains and neighbouring domains on the proxy", {});
  await routeIs("example.com.", "direct");
  await routeIs("shop.example.com.", "proxy");
  record("Terminal-dot hostnames have matching proxy and exception scope", {});
  await routeIs("example.com", "direct", "tls-route", "https");
  await routeIs("shop.example.com", "proxy", "tls-route", "https");
  await routeIs("otherexample.com", "proxy", "tls-route", "https");
  record("HTTPS exclusions bypass the TLS proxy while other domains use authenticated CONNECT", {});
  const page = await context.newPage();
  await page.goto(`http://example.com:${directPort}/third-party-page`, { timeout: 12000 });
  assert.equal(await page.locator("html").getAttribute("data-route"), "direct");
  assert.equal(await page.locator("html").getAttribute("data-third-party-route"), "proxy");
  await page.close();
  record("Third-party resources of an excluded page still use the proxy", {});
  const tlsPage = await context.newPage();
  await tlsPage.goto(`https://example.com:${directTlsPort}/third-party-page`, { timeout: 12000 });
  assert.equal(await tlsPage.locator("html").getAttribute("data-route"), "direct");
  assert.equal(await tlsPage.locator("html").getAttribute("data-third-party-route"), "proxy");
  await tlsPage.close();
  record("HTTPS third-party resources stay on the proxy when their parent page is excluded", {});
  await update([{ domain: "example.com", includeSubdomains: true }]);
  await routeIs("shop.example.com", "direct");
  await routeIs("a.b.example.com.", "direct");
  await routeIs("otherexample.com", "proxy");
  record("Subdomain option routes children directly without matching neighbours", {});
  const child = [{ domain: "shop.example.com", includeSubdomains: false }];
  await update(child);
  await routeIs("example.com", "proxy");
  await routeIs("shop.example.com", "direct");
  await routeIs("a.shop.example.com", "proxy");
  record("Connected removal and narrowing immediately change new request routes", {});
  const disabled = await update(child, false);
  assert.deepEqual(disabled.siteExclusions.saved.entries, child);
  await routeIs("shop.example.com", "proxy");
  record("Disabling exclusions keeps the saved list and routes its sites through the proxy", {});
  await update([{ domain: "example.com", includeSubdomains: true }]);
  const endpointBefore = await popup.evaluate(
    async () => (await chrome.proxy.settings.get({ incognito: false })).value.rules.singleProxy,
  );
  const sessionsBeforeFailure = sessionsCreated;
  apiExpired = true;
  await message({ type: "refresh_account" }, "unauthorized");
  const blocked = await message({ type: "get_snapshot" });
  assert.equal(blocked.protectionRequested, true, JSON.stringify(blocked));
  assert.equal(blocked.trafficBlocked, true, JSON.stringify(blocked));
  assert.equal(blocked.blockingScope, "except_excluded", JSON.stringify(blocked));
  await routeIs("example.com", "direct");
  await routeIs("shop.example.com.", "direct");
  await routeIs("example.org", "blocked");
  await routeIs("example.com", "direct", "tls-outage", "https");
  await routeIs("example.org", "blocked", "tls-outage", "https");
  record(
    "Verified kill-switch outage keeps excluded sites direct and blocks other destinations",
    {},
  );
  const replacement = [{ domain: "example.org", includeSubdomains: false }];
  const editedBlocked = await update(replacement);
  assert.equal(editedBlocked.blockingScope, "except_excluded", JSON.stringify(editedBlocked));
  assert.equal(sessionsCreated, sessionsBeforeFailure);
  const endpointAfter = await popup.evaluate(
    async () => (await chrome.proxy.settings.get({ incognito: false })).value.rules.singleProxy,
  );
  assert.deepEqual(endpointAfter, endpointBefore);
  await routeIs("example.com", "blocked");
  await routeIs("example.org", "direct");
  await routeIs("shop.example.org", "blocked");
  record(
    "Editing exclusions during outage preserves the proxy endpoint and creates no session",
    {},
  );
  const cdp = await context.newCDPSession(popup);
  const versions = new Map();
  cdp.on("ServiceWorker.workerVersionUpdated", ({ versions: changed }) => {
    for (const version of changed) versions.set(version.versionId, version);
  });
  await cdp.send("ServiceWorker.enable");
  async function waitUntil(condition, failure) {
    const deadline = Date.now() + 8000;
    while (!condition()) {
      if (Date.now() >= deadline) throw new Error(failure);
      await new Promise((done) => setTimeout(done, 25));
    }
  }
  await waitUntil(
    () =>
      [...versions.values()].some(
        (version) => version.scriptURL === worker.url() && version.runningStatus === "running",
      ),
    "Worker version unavailable",
  );
  const version = [...versions.values()].find(
    (value) => value.scriptURL === worker.url() && value.runningStatus === "running",
  );
  await cdp.send("ServiceWorker.stopWorker", { versionId: version.versionId });
  await waitUntil(
    () => versions.get(version.versionId)?.runningStatus === "stopped",
    "Worker did not stop",
  );
  const restored = await message({ type: "get_snapshot" });
  assert.deepEqual(restored.siteExclusions.saved, editedBlocked.siteExclusions.saved);
  assert.deepEqual(restored.siteExclusions.applied, editedBlocked.siteExclusions.applied);
  assert.equal(restored.blockingScope, "except_excluded", JSON.stringify(restored));
  await routeIs("example.org", "direct");
  await routeIs("example.com", "blocked");
  assert.equal(sessionsCreated, sessionsBeforeFailure);
  record(
    "Worker restart restores exclusions and the verified outage guard without credentials",
    {},
  );
  await update([{ domain: "example.org", includeSubdomains: true }]);
  const beforeInterrupted = await message({ type: "get_snapshot" });
  const resumedWorker = context.serviceWorkers().find((current) => current.url() === worker.url());
  assert(resumedWorker, "Restarted worker not found");
  await resumedWorker.evaluate(() => {
    const originalSet = chrome.storage.local.set.bind(chrome.storage.local);
    globalThis.exclusionCommitHeld = false;
    chrome.storage.local.set = async (values) => {
      const record = values.fuzevpnSiteExclusions;
      if (record && record.pending === false) {
        globalThis.exclusionCommitHeld = true;
        await new Promise(() => {});
      }
      return originalSet(values);
    };
  });
  const interruptedTarget = [
    { domain: "shop.example.org", includeSubdomains: false },
    { domain: "example.com", includeSubdomains: false },
  ];
  const interruptedRequest = popup
    .evaluate((request) => chrome.runtime.sendMessage(request), {
      type: "update_site_exclusions",
      expectedRevision: beforeInterrupted.siteExclusions.saved.revision,
      enabled: true,
      entries: interruptedTarget,
    })
    .catch(() => null);
  const holdDeadline = Date.now() + 8000;
  while (!(await resumedWorker.evaluate(() => globalThis.exclusionCommitHeld))) {
    if (Date.now() >= holdDeadline) throw new Error("Final policy commit was not reached");
    await new Promise((done) => setTimeout(done, 25));
  }
  const journalBeforeRestart = await popup.evaluate(
    async () => (await chrome.storage.local.get("fuzevpnSiteExclusions")).fuzevpnSiteExclusions,
  );
  assert.equal(journalBeforeRestart.pending, true);
  assert.deepEqual(journalBeforeRestart.saved.entries, interruptedTarget);
  await routeIs("shop.example.org", "direct");
  await routeIs("example.org", "blocked");
  await routeIs("example.com", "blocked");
  record(
    "An unfinished commit permits only the domain coverage shared by old and new exceptions",
    {},
  );
  const interruptedVersion = [...versions.values()].find(
    (value) => value.scriptURL === worker.url() && value.runningStatus === "running",
  );
  assert(interruptedVersion, "Running worker version unavailable for interruption");
  await cdp.send("ServiceWorker.stopWorker", { versionId: interruptedVersion.versionId });
  await waitUntil(
    () => versions.get(interruptedVersion.versionId)?.runningStatus === "stopped",
    "Interrupted worker did not stop",
  );
  await interruptedRequest;
  const recoveredJournal = await message({ type: "get_snapshot" });
  assert.equal(recoveredJournal.siteExclusions.pending, false, JSON.stringify(recoveredJournal));
  assert.equal(recoveredJournal.siteExclusions.error, false, JSON.stringify(recoveredJournal));
  assert.deepEqual(recoveredJournal.siteExclusions.saved.entries, interruptedTarget);
  assert.deepEqual(recoveredJournal.siteExclusions.saved, recoveredJournal.siteExclusions.applied);
  assert.equal(recoveredJournal.blockingScope, "except_excluded", JSON.stringify(recoveredJournal));
  assert.equal(sessionsCreated, sessionsBeforeFailure);
  await routeIs("shop.example.org", "direct");
  await routeIs("example.com", "direct");
  await routeIs("example.org", "blocked");
  record(
    "Worker interruption before final commit resumes the durable journal without opening other sites",
    {},
  );
  const commitWindowWorker = context
    .serviceWorkers()
    .find((current) => current.url() === worker.url());
  assert(commitWindowWorker, "Worker unavailable before committed-guard check");
  await commitWindowWorker.evaluate(() => {
    const originalSet = chrome.storage.local.set.bind(chrome.storage.local);
    globalThis.exclusionCommitHeld = false;
    chrome.storage.local.set = async (values) => {
      const result = await originalSet(values);
      const record = values.fuzevpnSiteExclusions;
      if (record && record.pending === false) {
        globalThis.exclusionCommitHeld = true;
        await new Promise(() => {});
      }
      return result;
    };
  });
  const committedTarget = [
    { domain: "example.com", includeSubdomains: true },
    { domain: "example.org", includeSubdomains: false },
  ];
  const committedRequest = popup
    .evaluate((request) => chrome.runtime.sendMessage(request), {
      type: "update_site_exclusions",
      expectedRevision: recoveredJournal.siteExclusions.saved.revision,
      enabled: true,
      entries: committedTarget,
    })
    .catch(() => null);
  const committedHoldDeadline = Date.now() + 8000;
  while (!(await commitWindowWorker.evaluate(() => globalThis.exclusionCommitHeld))) {
    if (Date.now() >= committedHoldDeadline)
      throw new Error("Committed policy write was not reached");
    await new Promise((done) => setTimeout(done, 25));
  }
  const committedBeforeRestart = await popup.evaluate(
    async () => (await chrome.storage.local.get("fuzevpnSiteExclusions")).fuzevpnSiteExclusions,
  );
  assert.equal(committedBeforeRestart.pending, false);
  assert.deepEqual(committedBeforeRestart.saved.entries, committedTarget);
  assert.deepEqual(committedBeforeRestart.applied, committedBeforeRestart.saved);
  await routeIs("example.com", "direct");
  await routeIs("shop.example.org", "blocked");
  await routeIs("shop.example.com", "blocked");
  await routeIs("example.org", "blocked");
  record(
    "The durable temporary guard still restricts new-only domains after policy storage commits",
    {},
  );
  const committedVersion = [...versions.values()].find(
    (value) => value.scriptURL === worker.url() && value.runningStatus === "running",
  );
  assert(committedVersion, "Running worker version unavailable after commit");
  await cdp.send("ServiceWorker.stopWorker", { versionId: committedVersion.versionId });
  await waitUntil(
    () => versions.get(committedVersion.versionId)?.runningStatus === "stopped",
    "Committed worker did not stop",
  );
  await committedRequest;
  const committedRecovery = await message({ type: "get_snapshot" });
  assert.equal(committedRecovery.siteExclusions.pending, false, JSON.stringify(committedRecovery));
  assert.equal(committedRecovery.siteExclusions.error, false, JSON.stringify(committedRecovery));
  assert.deepEqual(committedRecovery.siteExclusions.saved.entries, committedTarget);
  assert.deepEqual(
    committedRecovery.siteExclusions.applied,
    committedRecovery.siteExclusions.saved,
  );
  assert.equal(
    committedRecovery.blockingScope,
    "except_excluded",
    JSON.stringify(committedRecovery),
  );
  assert.equal(sessionsCreated, sessionsBeforeFailure);
  await routeIs("example.com", "direct");
  await routeIs("shop.example.com", "direct");
  await routeIs("example.org", "direct");
  await routeIs("shop.example.org", "blocked");
  record(
    "Restart after committed storage verifies the target and removes the surviving temporary guard",
    {},
  );
  const allBlocked = await update(replacement, false);
  assert.equal(allBlocked.blockingScope, "all", JSON.stringify(allBlocked));
  await routeIs("example.org", "blocked");
  record("Disabling exceptions during outage restores a verified total block", {});
  await update(replacement, true);
  await routeIs("example.org", "direct");
  const released = await message({ type: "disconnect" });
  assert.equal(released.protectionRequested, false);
  assert.deepEqual(released.siteExclusions.saved.entries, replacement);
  await routeIs("example.com", "direct");
  await routeIs("example.org", "direct");
  const rules = await popup.evaluate(async () => ({
    dynamic: await chrome.declarativeNetRequest.getDynamicRules(),
    session: await chrome.declarativeNetRequest.getSessionRules(),
  }));
  assert.deepEqual(rules, { dynamic: [], session: [] });
  record("Explicit disconnect releases all guard rules and retains the saved exclusions", {});
  await message({ type: "logout" });
  const loggedOut = await message({ type: "get_snapshot" });
  assert.deepEqual(loggedOut.siteExclusions.saved.entries, replacement);
  record("Account logout retains the local excluded-site list", {});
  await cdp.detach();
  report.sessionsCreated = sessionsCreated;
  report.observedRoutes = requests;
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
  for (const server of [proxyServer, directServer, directTlsServer, proxiedTlsServer])
    if (server) await new Promise((done) => server.close(done));
  const reportPath = join(artifactRoot, "report.json");
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`Report: ${reportPath}\n`);
  if (report.failure) process.stderr.write(`${report.failure}\n`);
}
