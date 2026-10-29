// SPDX-License-Identifier: MPL-2.0
// Built extension, native worker fetch, real local TLS origins and HTTPS CONNECT/407.
// Only the account API is replaced. No IP fetch, response, or browser route is mocked.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, X509Certificate } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:https";
import { createRequire } from "node:module";
import { connect } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { waitForRead } from "../../../scripts/browser-wait.mjs";
import { assertInsideProject } from "../../../scripts/validation-common.mjs";
import { localeDirectory } from "../../../scripts/supported-locales.mjs";

const root = resolve(import.meta.dirname, "../../..");
const target = process.argv[2] ?? process.env.EXTENSION_TARGET ?? "chrome";
assert(["chrome", "edge"].includes(target), "Expected chrome or edge target");
const output = assertInsideProject(
  resolve(process.env.IPV4_TRANSPORT_OUTPUT ?? join(root, "audit/local/ipv4-transport", target)),
);
await mkdir(output, { recursive: true });
const runRoot = await mkdtemp(join(output, "run-"));
// The validation runner supplies a short scoped TMP; deep evidence paths exceed
// Windows IndexedDB limits even when the browser can open the extension itself.
const profileRoot = await mkdtemp(join(assertInsideProject(tmpdir()), "ipv4-"));
const runtime = join(homedir(), ".cache/codex-runtimes/codex-primary-runtime/dependencies");
const require = createRequire(import.meta.url);
let playwrightPath = process.env.PLAYWRIGHT_MODULE_PATH;
if (!playwrightPath) {
  try {
    playwrightPath = require.resolve("playwright");
  } catch {
    playwrightPath = join(runtime, "node/node_modules/playwright/index.mjs");
  }
}
const { chromium } = await import(pathToFileURL(resolve(playwrightPath)).href);
const report = {
  timestamp: new Date().toISOString(),
  target,
  runRoot,
  profileRoot,
  isolation:
    "Temporary profile, local TLS origins and authenticated HTTPS proxies; account API only is synthetic; no context.route or IP-fetch interception",
  limitations: [
    "Local fixtures verify transport and regressions, not the cause of a production failure.",
  ],
  checks: [],
  transport: [],
  pageErrors: [],
};
let context;
let worker;
let popup;
let cdp;
let mode = "healthy";
let proxyReadyAt = 0;
let expectedEpoch = 1;
let activeSlot = 0;
const servers = [];
const sockets = new Set();
const proxySockets = new Set();
const slots = [];
const heldResponses = [];
const workerVersions = new Map();
const IPV6 = "2a07:b944:ffff:ffff:ffff:ffff:ffff:ffff";

function trace(kind, fields) {
  report.transport.push({ at: Date.now(), kind, ...fields });
}
function record(name, details = {}) {
  report.checks.push({ name, passed: true, ...details });
  process.stdout.write(`PASS ${target} IPv4 transport: ${name}\n`);
}
function track(socket, proxy = false) {
  sockets.add(socket);
  if (proxy) proxySockets.add(socket);
  socket.on("close", () => {
    sockets.delete(socket);
    proxySockets.delete(socket);
  });
  socket.on("error", () => undefined);
}
function closeTunnels() {
  for (const socket of proxySockets) socket.destroy();
}
function releaseHeld() {
  for (const respond of heldResponses.splice(0)) respond();
}

// Serialized before the built worker. Every non-account request uses native fetch unchanged.
function installAccountFixture(slotPorts) {
  const nativeFetch = globalThis.fetch.bind(globalThis);
  globalThis.nativeIpEpoch = 1;
  globalThis.nativeIpCreatedAt = 0;
  globalThis.nativeIpSessionCount = 0;
  globalThis.nativeIpErrors = [];
  globalThis.nativeCatalogExcluded = null;
  globalThis.nativeRejectNextLocation = false;
  chrome.webRequest.onErrorOccurred.addListener(
    (details) => {
      const host = new URL(details.url).hostname;
      globalThis.nativeIpErrors.push({
        provider: host === "api.ipify.org" ? "primary" : "fallback",
        error: /^net::ERR_[A-Z0-9_]{1,64}$/.test(details.error) ? details.error : "other",
      });
    },
    { urls: ["https://api.ipify.org/*", "https://ipv4.icanhazip.com/*"] },
  );
  chrome.identity.launchWebAuthFlow = async (details) => {
    const auth = new URL(details.url);
    const callback = new URL(auth.searchParams.get("redirect_uri"));
    callback.searchParams.set("state", auth.searchParams.get("state"));
    callback.searchParams.set(
      "code",
      btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
        .replaceAll("+", "-")
        .replaceAll("/", "_")
        .replace(/=+$/, ""),
    );
    return callback.href;
  };
  globalThis.fetch = async (input, options = {}) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.hostname !== "api.fuzevpn.com") return nativeFetch(input, options);
    const method = options.method ?? "GET";
    let status = 200;
    let body;
    if (url.pathname === "/v1/auth/extension/token") {
      status = 201;
      body = {
        access_token: "native-ip-fixture-token",
        expires_at: new Date(Date.now() + 3600000).toISOString(),
      };
    } else if (url.pathname === "/v1/me") {
      body = {
        user_id: "native-ip-fixture",
        email: "audit@example.invalid",
        first_name: "Native",
        last_name: "Audit",
        country_code: "FR",
      };
    } else if (url.pathname === "/v1/billing/subscription") {
      body = {
        status: "active",
        has_access: true,
        offer_id: "native-ip-fixture",
        started_at: new Date(Date.now() - 60000).toISOString(),
        expires_at: new Date(Date.now() + 3600000).toISOString(),
        renews_automatically: false,
      };
    } else if (url.pathname === "/v1/locations") {
      body = {
        locations: slotPorts
          .map((_port, index) => ({
            id: "native-ip-" + index,
            city: "Local " + index,
            country_code: "FR",
            display_name: "Native fixture " + index,
            supported_protocols: ["browser_proxy"],
          }))
          .filter(({ id }) => id !== globalThis.nativeCatalogExcluded),
      };
    } else if (url.pathname === "/v1/devices/browser") {
      status = 201;
      body = {
        device_id: "native-ip-fixture-device",
        name: "Native fixture",
        kind: "browser_extension",
        created_at: new Date().toISOString(),
      };
    } else if (url.pathname === "/v1/devices") {
      body = { limit: 2, devices: [] };
    } else if (url.pathname === "/v1/proxy/sessions" && method === "POST") {
      globalThis.nativeIpCreatedAt = Date.now();
      globalThis.nativeIpSessionCount++;
      const locationId = JSON.parse(options.body).location_id;
      const slot = Number(locationId.split("-").at(-1));
      if (globalThis.nativeRejectNextLocation) {
        globalThis.nativeRejectNextLocation = false;
        status = 400;
        body = { error: "invalid_location" };
      } else {
        status = 201;
        body = {
          id: "native-ip-session-" + globalThis.nativeIpEpoch,
          location_id: locationId,
          scheme: "https",
          host: "127.0.0.1",
          port: slotPorts[slot],
          username: "synthetic-" + globalThis.nativeIpEpoch,
          password: "synthetic-password-" + globalThis.nativeIpEpoch,
          issued_at: new Date().toISOString(),
          expires_at: new Date(Date.now() + 1800000).toISOString(),
          refresh_after_seconds: 900,
        };
      }
    } else if (method === "DELETE" || url.pathname === "/v1/auth/logout") {
      status = 204;
    } else {
      status = 404;
      body = { error: "not_found" };
    }
    return new Response(body ? JSON.stringify(body) : null, {
      status,
      headers: { "content-type": "application/json" },
    });
  };
}

async function createTlsFixture() {
  const source = [
    "from cryptography import x509",
    "from cryptography.x509.oid import NameOID",
    "from cryptography.hazmat.primitives import hashes, serialization",
    "from cryptography.hazmat.primitives.asymmetric import rsa",
    "from datetime import datetime, timedelta, timezone",
    "from pathlib import Path",
    "import ipaddress, sys",
    "key=rsa.generate_private_key(public_exponent=65537,key_size=2048)",
    "name=x509.Name([x509.NameAttribute(NameOID.COMMON_NAME,'IPv4 local fixture')])",
    "now=datetime.now(timezone.utc)",
    "cert=(x509.CertificateBuilder().subject_name(name).issuer_name(name).public_key(key.public_key()).serial_number(x509.random_serial_number()).not_valid_before(now-timedelta(minutes=5)).not_valid_after(now+timedelta(days=1)).add_extension(x509.SubjectAlternativeName([x509.IPAddress(ipaddress.ip_address('127.0.0.1'))]),critical=False).sign(key,hashes.SHA256()))",
    "Path(sys.argv[1],'key.pem').write_bytes(key.private_bytes(serialization.Encoding.PEM,serialization.PrivateFormat.PKCS8,serialization.NoEncryption()))",
    "Path(sys.argv[1],'cert.pem').write_bytes(cert.public_bytes(serialization.Encoding.PEM))",
  ].join("\n");
  const generated = spawnSync(
    process.env.PYTHON_EXECUTABLE ?? join(runtime, "python/python.exe"),
    ["-B", "-c", source, runRoot],
    { encoding: "utf8", windowsHide: true },
  );
  assert.equal(generated.status, 0, generated.stderr);
  const key = await readFile(join(runRoot, "key.pem"));
  const cert = await readFile(join(runRoot, "cert.pem"));
  const spki = createHash("sha256")
    .update(new X509Certificate(cert).publicKey.export({ format: "der", type: "spki" }))
    .digest("base64");
  for (const [slot, ip] of ["8.8.4.4", "9.9.9.9"].entries()) {
    const origin = createServer({ key, cert }, (request, response) => {
      const fallback = request.headers.host.startsWith("ipv4.icanhazip.com");
      const requestMode = mode;
      const status =
        requestMode === "both-fail"
          ? 503
          : !fallback && requestMode === "primary-denied"
            ? 403
            : 200;
      const value = !fallback && requestMode === "primary-ipv6" ? IPV6 : ip;
      const body =
        status !== 200
          ? JSON.stringify({ error: "fixture_denial" })
          : fallback
            ? value + "\n"
            : JSON.stringify({ ip: value });
      trace("origin", {
        slot,
        provider: fallback ? "fallback" : "primary",
        mode: requestMode,
        status,
        cookiePresent: Boolean(request.headers.cookie),
      });
      const respond = () => {
        trace("origin-response", { slot, mode: requestMode, destroyed: response.destroyed });
        if (response.destroyed) return;
        response.writeHead(status, {
          "Content-Type": fallback ? "text/plain" : "application/json",
          "Content-Length": Buffer.byteLength(body),
          "Cache-Control": "no-store",
        });
        response.end(body);
      };
      if (!fallback && ["primary-hung", "hold-primary"].includes(requestMode)) {
        heldResponses.push(respond);
        trace("origin-held", { slot, mode: requestMode });
      } else respond();
    });
    servers.push(origin);
    origin.on("connection", (socket) => track(socket));
    await new Promise((done) => origin.listen(0, "127.0.0.1", done));
    const proxy = createServer({ key, cert }, (_request, response) => {
      response.writeHead(501);
      response.end();
    });
    servers.push(proxy);
    proxy.on("connection", (socket) => track(socket));
    proxy.on("secureConnection", (socket) => track(socket, true));
    proxy.on("connect", (request, socket, head) => {
      const credential = request.headers["proxy-authorization"];
      const expected =
        "Basic " +
        Buffer.from("synthetic-" + expectedEpoch + ":synthetic-password-" + expectedEpoch).toString(
          "base64",
        );
      const accepted = credential === expected;
      const ipProvider = ["api.ipify.org:443", "ipv4.icanhazip.com:443"].includes(request.url);
      const rejectTunnel =
        mode === "proxy-rejected" || (mode === "proxy-startup" && Date.now() < proxyReadyAt);
      const tunnelStatus = !accepted ? 407 : ipProvider ? (rejectTunnel ? 503 : 200) : null;
      trace("connect", {
        slot,
        epoch: expectedEpoch,
        host: request.url,
        credentialPresent: Boolean(credential),
        accepted,
        tunnelStatus,
      });
      if (!accepted) {
        socket.end(
          'HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="native-ip-fixture"\r\nContent-Length: 0\r\nConnection: close\r\n\r\n',
        );
        return;
      }
      if (!ipProvider) {
        socket.destroy();
        return;
      }
      if (tunnelStatus === 503) {
        socket.end(
          "HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
        );
        return;
      }
      const upstream = connect(origin.address().port, "127.0.0.1", () => {
        socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length) upstream.write(head);
        socket.pipe(upstream);
        upstream.pipe(socket);
      });
      track(upstream);
      upstream.on("error", () => socket.destroy());
      socket.on("error", () => upstream.destroy());
      socket.on("close", () => upstream.destroy());
    });
    await new Promise((done) => proxy.listen(0, "127.0.0.1", done));
    slots.push({ port: proxy.address().port, ip });
  }
  return spki;
}

async function message(request) {
  const response = await popup.evaluate((value) => chrome.runtime.sendMessage(value), request);
  assert(response?.ok, JSON.stringify(response));
  return response.snapshot;
}
async function connectionJournal() {
  const response = await popup.evaluate(() =>
    chrome.runtime.sendMessage({ type: "get_connection_journal" }),
  );
  assert.equal(response?.ok, true, "Built worker did not export its local connection journal");
  assert.equal(response.journal?.schemaVersion, 1);
  assert(Array.isArray(response.journal.events));
  const encoded = JSON.stringify(response.journal);
  assert(
    !/native-ip-|synthetic-|audit@example|access_token|password|username|Proxy-Authorization|https?:\/\/|(?:\d{1,3}\.){3}\d{1,3}/i.test(
      encoded,
    ),
    "Exported journal retained an identity, credential, address or URL",
  );
  return response.journal;
}
async function readyIp(slot) {
  const snapshot = await waitForRead(
    () => message({ type: "refresh_network" }),
    (snapshot) => snapshot.network.status === "ready" && snapshot.network.ip === slots[slot].ip,
    { timeoutMs: 12000, intervalMs: 40, message: "Expected observed IPv4 for slot " + slot },
  );
  assert.equal(snapshot.status, "connected");
  assert.equal(snapshot.protected, true);
  assert.equal(snapshot.trafficBlocked, false);
  await waitForRead(
    () => popup.locator("#publicIp").textContent(),
    (text) => text?.includes(slots[slot].ip),
    { timeoutMs: 5000, message: "Built popup did not render observed IPv4" },
  );
  return snapshot;
}
async function reconnect(slot = 1 - activeSlot) {
  expectedEpoch++;
  await worker.evaluate((epoch) => {
    globalThis.nativeIpEpoch = epoch;
  }, expectedEpoch);
  const request =
    slot === activeSlot
      ? { type: "retry_connection" }
      : { type: "change_location", locationId: "native-ip-" + slot };
  const connected = await message(request);
  if (mode === "proxy-startup") {
    const createdAt = await worker.evaluate(() => globalThis.nativeIpCreatedAt);
    proxyReadyAt = createdAt + 1200;
  }
  activeSlot = slot;
  closeTunnels();
  assert.equal(connected.status, "connected");
  assert.equal(connected.protected, true);
  return connected;
}
async function waitHeld(after) {
  await waitForRead(
    async () => report.transport.slice(after).some((entry) => entry.kind === "origin-held"),
    Boolean,
    { timeoutMs: 5000, message: "Primary fixture did not hold the real IP request" },
  );
}
async function restartWorker() {
  const previous = await message({ type: "get_snapshot" });
  const running = await waitForRead(
    async () =>
      [...workerVersions.values()].find(
        (version) => version.scriptURL === worker.url() && version.runningStatus === "running",
      ),
    Boolean,
    { timeoutMs: 5000 },
  );
  await cdp.send("ServiceWorker.stopWorker", { versionId: running.versionId });
  await waitForRead(
    async () => workerVersions.get(running.versionId)?.runningStatus,
    (status) => status === "stopped",
    { timeoutMs: 5000 },
  );
  await message({ type: "get_snapshot" });
  worker =
    context.serviceWorkers()[0] ??
    (await context.waitForEvent("serviceworker", { timeout: 10000 }));
  const restored = await message({ type: "get_snapshot" });
  assert.notEqual(restored.snapshotVersion.workerId, previous.snapshotVersion.workerId);
  return restored;
}

async function verify() {
  const spki = await createTlsFixture();
  const extension = join(runRoot, "extension");
  await cp(
    resolve(
      process.env.EXTENSION_PATH ?? process.env.CHROME_EXTENSION_DIR ?? join(root, "dist", target),
    ),
    extension,
    {
      recursive: true,
    },
  );
  const workerPath = join(extension, "background/service-worker.js");
  const originalWorker = await readFile(workerPath, "utf8");
  const manifest = JSON.parse(await readFile(join(extension, "manifest.json"), "utf8"));
  report.artifact = {
    version: manifest.version,
    sourceWorkerSha256: createHash("sha256").update(originalWorker).digest("hex"),
  };
  await writeFile(
    workerPath,
    "(" +
      installAccountFixture.toString() +
      ")(" +
      JSON.stringify(slots.map(({ port }) => port)) +
      ");\n" +
      originalWorker,
  );
  context = await chromium.launchPersistentContext(join(profileRoot, "profile"), {
    channel: "chromium",
    headless: true,
    ignoreDefaultArgs: ["--disable-extensions"],
    ...(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : {}),
    args: [
      "--enable-unsafe-extension-debugging",
      "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1, EXCLUDE [::1]",
      "--disable-background-networking",
      "--disable-quic",
      "--ignore-certificate-errors-spki-list=" + spki,
      "--log-net-log=" + join(runRoot, "netlog.json"),
      "--net-log-capture-mode=Default",
    ],
  });
  report.browser = context.browser().version();
  const loader = await context.browser().newBrowserCDPSession();
  await loader.send("Extensions.loadUnpacked", { path: extension });
  worker =
    context.serviceWorkers()[0] ??
    (await context.waitForEvent("serviceworker", { timeout: 15000 }));
  const extensionId = worker.url().split("/")[2];
  popup = await context.newPage();
  popup.on("pageerror", (error) => report.pageErrors.push(String(error)));
  await popup.goto("chrome-extension://" + extensionId + "/popup/popup.html");
  cdp = await context.newCDPSession(popup);
  cdp.on("ServiceWorker.workerVersionUpdated", ({ versions }) => {
    for (const version of versions) workerVersions.set(version.versionId, version);
  });
  await cdp.send("ServiceWorker.enable");
  await message({ type: "web_login", disconnectFirst: false });
  await message({ type: "connect", locationId: "native-ip-0" });
  await readyIp(0);
  assert(
    report.transport.some((entry) => entry.kind === "connect" && !entry.accepted),
    "No real proxy 407 challenge occurred",
  );
  assert(
    report.transport.some((entry) => entry.kind === "connect" && entry.accepted),
    "No authenticated CONNECT succeeded",
  );
  record("cold worker displays the public IPv4 through authenticated CONNECT");

  mode = "proxy-startup";
  proxyReadyAt = Number.POSITIVE_INFINITY;
  let start = report.transport.length;
  const sessionsBeforeStartup = await worker.evaluate(() => {
    globalThis.nativeIpErrors.length = 0;
    return globalThis.nativeIpSessionCount;
  });
  await reconnect();
  const connectedAt = Date.now();
  const createdAt = await worker.evaluate(() => globalThis.nativeIpCreatedAt);
  report.startup = { createdAt, connectedAt, proxyReadyAt };
  const startupReady = await waitForRead(
    () => message({ type: "refresh_network" }),
    (snapshot) =>
      snapshot.network.status === "ready" && snapshot.network.ip === slots[activeSlot].ip,
    {
      timeoutMs: 2500,
      intervalMs: 40,
      message: "Startup CONNECT rejections did not recover within 2500 ms",
    },
  );
  const startupElapsedMs = Date.now() - createdAt;
  const startupConnects = report.transport
    .slice(start)
    .filter(
      (entry) =>
        entry.kind === "connect" &&
        ["api.ipify.org:443", "ipv4.icanhazip.com:443"].includes(entry.host),
    );
  assert(connectedAt - createdAt < 500, "The controller waited for the public-IP probe");
  assert(
    startupConnects[0].at - createdAt >= 500,
    "A provider request started before the 500 ms settling delay",
  );
  assert.equal(
    startupConnects.filter((entry) => entry.tunnelStatus === 503).length,
    4,
    "Expected two rounds of real CONNECT rejection before proxy readiness",
  );
  assert(startupElapsedMs < 2500, "Startup recovery fell back to the five-second popup poll");
  assert.equal(startupReady.status, "connected");
  assert.equal(startupReady.protected, true);
  assert.equal(startupReady.trafficBlocked, false);
  assert.equal(
    await worker.evaluate(() => globalThis.nativeIpSessionCount),
    sessionsBeforeStartup + 1,
    "IP retries created another proxy session",
  );
  const startupErrors = await worker.evaluate(() => globalThis.nativeIpErrors);
  assert.equal(
    startupErrors.filter((entry) => entry.error === "net::ERR_TUNNEL_CONNECTION_FAILED").length,
    4,
  );
  await readyIp(activeSlot);
  record("new VPN waits 500 ms and retries transient CONNECT503 until the proxy is ready", {
    elapsedMs: startupElapsedMs,
    firstAttemptDelayMs: startupConnects[0].at - createdAt,
    rejectedConnects: 4,
    errors: startupErrors,
  });

  mode = "proxy-rejected";
  start = report.transport.length;
  await worker.evaluate(() => {
    globalThis.nativeIpErrors.length = 0;
  });
  await reconnect();
  const rejected = await waitForRead(
    () => message({ type: "refresh_network" }),
    (snapshot) => snapshot.network.status === "unavailable",
    {
      timeoutMs: 4500,
      intervalMs: 40,
      message: "Permanent CONNECT rejection did not stop after three rounds",
    },
  );
  const permanentConnects = report.transport
    .slice(start)
    .filter((entry) => entry.kind === "connect" && entry.tunnelStatus === 503);
  assert.equal(
    permanentConnects.length,
    6,
    "Permanent rejection must stop after three rounds of two providers",
  );
  assert(
    !report.transport.slice(start).some((entry) => entry.kind === "origin"),
    "A rejected CONNECT must never reach the IP HTTP origin",
  );
  assert.equal(rejected.status, "connected");
  assert.equal(rejected.protected, true);
  assert.equal(rejected.trafficBlocked, false);
  assert.equal(rejected.error, null);
  assert.equal(rejected.network.ip, null);
  const permanentErrors = await worker.evaluate(() => globalThis.nativeIpErrors);
  assert.equal(
    permanentErrors.filter((entry) => entry.error === "net::ERR_TUNNEL_CONNECTION_FAILED").length,
    6,
  );
  record("permanent CONNECT503 stops after three rounds without changing VPN protection", {
    rounds: 3,
    rejectedConnects: permanentConnects.length,
    errors: permanentErrors,
  });

  for (const failureMode of ["primary-denied", "primary-hung", "primary-ipv6"]) {
    mode = failureMode;
    const start = report.transport.length;
    const started = Date.now();
    await reconnect();
    await readyIp(activeSlot);
    const transport = report.transport.slice(start);
    assert(
      transport.some(
        (entry) =>
          entry.kind === "origin" && entry.provider === "primary" && entry.mode === failureMode,
      ),
    );
    assert(
      transport.some(
        (entry) =>
          entry.kind === "origin" && entry.provider === "fallback" && entry.mode === failureMode,
      ),
    );
    assert(!(await popup.locator("#publicIp").textContent()).includes(IPV6));
    releaseHeld();
    record(failureMode + " recovers using the independent IPv4 provider", {
      elapsedMs: Date.now() - started,
    });
  }

  mode = "both-fail";
  await reconnect();
  const unavailable = await waitForRead(
    () => message({ type: "refresh_network" }),
    (snapshot) => snapshot.network.status === "unavailable",
    { timeoutMs: 10000 },
  );
  assert.equal(unavailable.status, "connected");
  assert.equal(unavailable.protected, true);
  assert.equal(unavailable.trafficBlocked, false);
  assert.equal(unavailable.error, null);
  assert.equal(unavailable.network.ip, null);
  assert.equal(await popup.locator("#protectButton").isEnabled(), true);
  assert.equal(await popup.locator("#recoveryPanel").isVisible(), false);
  record("both IP services fail without changing protection or disabling disconnect");

  mode = "hold-primary";
  start = report.transport.length;
  await reconnect();
  await waitHeld(start);
  // Observe native API latency without changing their arguments or returned promises.
  await worker.evaluate(() => {
    globalThis.nativeDisconnectTimings = [];
    const groups = [
      ["proxy", chrome.proxy.settings, ["get", "set", "clear"]],
      ["webrtc", chrome.privacy.network.webRTCIPHandlingPolicy, ["get", "set", "clear"]],
      ["prediction", chrome.privacy.network.networkPredictionEnabled, ["get", "set", "clear"]],
      ["rules", chrome.declarativeNetRequest, ["getDynamicRules", "updateDynamicRules"]],
      ["local", chrome.storage.local, ["set"]],
      ["session", chrome.storage.session, ["set", "remove"]],
      ["alarms", chrome.alarms, ["clear", "clearAll"]],
    ];
    for (const [name, owner, methods] of groups) {
      for (const method of methods) {
        const original = owner[method];
        if (typeof original !== "function") continue;
        owner[method] = function (...args) {
          const started = performance.now();
          const entry = { name: `${name}.${method}`, at: Date.now(), elapsedMs: null };
          globalThis.nativeDisconnectTimings.push(entry);
          const value = Reflect.apply(original, owner, args);
          if (value && typeof value.then === "function")
            value.then(
              () => {
                entry.elapsedMs = performance.now() - started;
              },
              () => {
                entry.elapsedMs = performance.now() - started;
                entry.rejected = true;
              },
            );
          return value;
        };
      }
    }
  });
  const refreshStarted = Date.now();
  const pendingRefresh = await message({ type: "refresh_network" });
  assert.equal(pendingRefresh.network.status, "checking");
  assert(Date.now() - refreshStarted < 1500, "Optional IP refresh waited for the held provider");
  const disconnectStarted = Date.now();
  await message({ type: "disconnect" });
  const disconnectElapsedMs = Date.now() - disconnectStarted;
  report.disconnectTiming = {
    startedAt: disconnectStarted,
    elapsedMs: disconnectElapsedMs,
    nativeCalls: await worker.evaluate(() => globalThis.nativeDisconnectTimings),
  };
  assert(disconnectElapsedMs < 1500, "Disconnect waited for the held IP request");
  releaseHeld();
  await new Promise((done) => setTimeout(done, 150));
  const disconnected = await message({ type: "get_snapshot" });
  assert.equal(disconnected.protected, false);
  assert.equal(disconnected.status, "disconnected");
  assert.notEqual(disconnected.network.mode, "vpn");
  record("pending lookup is optional and its late response cannot undo disconnect");

  start = report.transport.length;
  expectedEpoch++;
  await worker.evaluate((epoch) => {
    globalThis.nativeIpEpoch = epoch;
  }, expectedEpoch);
  await message({ type: "connect", locationId: "native-ip-" + activeSlot });
  await waitHeld(start);
  mode = "healthy";
  await reconnect();
  await readyIp(activeSlot);
  releaseHeld();
  await new Promise((done) => setTimeout(done, 150));
  const switched = await message({ type: "get_snapshot" });
  assert.equal(switched.network.ip, slots[activeSlot].ip);
  assert.equal(switched.network.locationId, "native-ip-" + activeSlot);
  record("late response from the previous location cannot replace the new public IPv4");

  start = report.transport.length;
  await reconnect(activeSlot);
  await readyIp(activeSlot);
  assert(
    report.transport
      .slice(start)
      .some((entry) => entry.kind === "connect" && entry.accepted && entry.epoch === expectedEpoch),
  );
  record("renewed proxy credentials still authenticate native worker IP requests");
  closeTunnels();
  const restored = await restartWorker();
  assert.equal(restored.protected, true);
  await readyIp(activeSlot);
  record("worker restart restores the authenticated route and displays its IPv4");
  await message({ type: "disconnect" });
  const selectedTarget = "native-ip-" + activeSlot;
  const selected = await message({ type: "select_location", locationId: selectedTarget });
  assert(selected.locations.some(({ id }) => id === selectedTarget));
  assert.equal(selected.selectedLocationId, selectedTarget);
  const selectedMetadata = selected.locations.find(({ id }) => id === selectedTarget);
  const selectedLabel = await waitForRead(
    () => popup.locator("#locationName").textContent(),
    (text) => text?.includes("Native fixture " + activeSlot),
    { timeoutMs: 5000, message: "Cached catalog did not display the requested location" },
  );
  const beforeKnownJournal = await connectionJournal();
  const beforeKnownSequence = beforeKnownJournal.events.at(-1)?.sequence ?? 0;
  expectedEpoch++;
  const sessionsBeforeKnown = await worker.evaluate(
    ({ id, epoch }) => {
      globalThis.nativeCatalogExcluded = id;
      globalThis.nativeIpEpoch = epoch;
      return globalThis.nativeIpSessionCount;
    },
    { id: selectedTarget, epoch: expectedEpoch },
  );
  const knownConnection = await popup.evaluate(
    (locationId) => chrome.runtime.sendMessage({ type: "connect", locationId }),
    selectedTarget,
  );
  assert.equal(knownConnection.ok, true);
  assert.equal(knownConnection.snapshot.status, "connected");
  assert.equal(knownConnection.snapshot.error, null);
  assert.equal(knownConnection.snapshot.protected, true);
  assert.equal(knownConnection.snapshot.activeLocationId, selectedTarget);
  assert.deepEqual(knownConnection.snapshot.activeLocation, selectedMetadata);
  assert.equal(knownConnection.snapshot.locations.length, selected.locations.length - 1);
  assert.equal(
    knownConnection.snapshot.locations.some(({ id }) => id === selectedTarget),
    false,
  );
  await readyIp(activeSlot);
  assert.equal(
    await worker.evaluate(() => globalThis.nativeIpSessionCount),
    sessionsBeforeKnown + 1,
  );
  assert.equal(await popup.locator("#locationName").textContent(), selectedLabel);
  const catalog = JSON.parse(
    await readFile(
      join(
        extension,
        "_locales",
        localeDirectory(knownConnection.snapshot.effectiveLanguage),
        "messages.json",
      ),
      "utf8",
    ),
  );
  const knownJournal = await connectionJournal();
  const knownEvents = knownJournal.events.filter(({ sequence }) => sequence > beforeKnownSequence);
  assert(
    knownEvents.some(
      (entry) =>
        entry.event === "target" &&
        entry.source === "requested" &&
        entry.requestedPresent === false,
    ),
  );
  assert.equal(
    knownEvents.some((entry) => entry.event === "failure" && entry.error === "invalid_location"),
    false,
  );
  record(
    "a known explicit target omitted by the fresh catalog is validated by one session POST and retains its active label",
    {
      source: "requested",
      requestedPresent: false,
      sessionAttempts: 1,
      freshCatalogCount: knownConnection.snapshot.locations.length,
    },
  );

  await message({ type: "disconnect" });
  await worker.evaluate(() => {
    globalThis.nativeCatalogExcluded = null;
  });
  const catalogRestored = await message({ type: "refresh_locations" });
  assert(catalogRestored.locations.some(({ id }) => id === selectedTarget));
  await message({ type: "select_location", locationId: selectedTarget });
  const retainedLabel = await waitForRead(
    () => popup.locator("#locationName").textContent(),
    (text) => text?.includes("Native fixture " + activeSlot),
    { timeoutMs: 5000, message: "Restored catalog did not retain the selected location label" },
  );
  const beforeApiJournal = await connectionJournal();
  const beforeApiSequence = beforeApiJournal.events.at(-1)?.sequence ?? 0;
  const sessionsBeforeApi = await worker.evaluate(() => {
    globalThis.nativeRejectNextLocation = true;
    return globalThis.nativeIpSessionCount;
  });
  const apiFailure = await popup.evaluate(
    (locationId) => chrome.runtime.sendMessage({ type: "connect", locationId }),
    selectedTarget,
  );
  assert.equal(apiFailure.ok, false);
  assert.equal(apiFailure.commandError, "invalid_location");
  assert.equal(apiFailure.snapshot.error, "invalid_location");
  assert.equal(apiFailure.snapshot.protected, false);
  assert.equal(apiFailure.snapshot.network.ip, null);
  assert(apiFailure.snapshot.locations.some(({ id }) => id === selectedTarget));
  assert.equal(await worker.evaluate(() => globalThis.nativeIpSessionCount), sessionsBeforeApi + 1);
  await waitForRead(
    () => popup.locator("#errorMessage").textContent(),
    (text) => text === catalog.error_invalid_location.message,
    { timeoutMs: 5000, message: "API invalid_location was not shown in the built popup" },
  );
  assert.equal(await popup.locator("#locationName").textContent(), retainedLabel);
  const apiJournal = await connectionJournal();
  const apiEvents = apiJournal.events.filter(({ sequence }) => sequence > beforeApiSequence);
  assert(
    apiEvents.some(
      (entry) =>
        entry.event === "failure" &&
        entry.source === "api" &&
        entry.httpStatus === 400 &&
        entry.error === "invalid_location",
    ),
  );
  assert.equal(
    apiEvents.some((entry) => entry.reason === "catalog_missing"),
    false,
  );
  record(
    "built worker journal distinguishes an API400 invalid_location while retaining the valid catalog selection",
    {
      source: "api",
      httpStatus: 400,
      sessionAttempts: 1,
    },
  );
  await message({ type: "disconnect" });
  const unknownTarget = "native-ip-never-known";
  const beforeUnknown = await message({ type: "get_snapshot" });
  assert.equal(
    beforeUnknown.locations.some(({ id }) => id === unknownTarget),
    false,
  );
  const beforeUnknownJournal = await connectionJournal();
  const beforeUnknownSequence = beforeUnknownJournal.events.at(-1)?.sequence ?? 0;
  const sessionsBeforeUnknown = await worker.evaluate(() => globalThis.nativeIpSessionCount);
  const unknownFailure = await popup.evaluate(
    (locationId) => chrome.runtime.sendMessage({ type: "connect", locationId }),
    unknownTarget,
  );
  assert.equal(unknownFailure.ok, false);
  assert.equal(unknownFailure.commandError, "invalid_location");
  assert.equal(unknownFailure.snapshot.protected, false);
  assert.equal(unknownFailure.snapshot.network.ip, null);
  assert.equal(unknownFailure.snapshot.selectedLocationId, beforeUnknown.selectedLocationId);
  assert.equal(await worker.evaluate(() => globalThis.nativeIpSessionCount), sessionsBeforeUnknown);
  await waitForRead(
    () => popup.locator("#locationName").textContent(),
    (text) => text === retainedLabel,
    {
      timeoutMs: 5000,
      message: "Rejecting a never-known target replaced the previous valid location label",
    },
  );
  const unknownJournal = await connectionJournal();
  const unknownEvents = unknownJournal.events.filter(
    ({ sequence }) => sequence > beforeUnknownSequence,
  );
  assert(
    unknownEvents.some(
      (entry) =>
        entry.event === "failure" &&
        entry.source === "local" &&
        entry.reason === "catalog_missing" &&
        entry.error === "invalid_location",
    ),
  );
  assert.equal(
    unknownEvents.some((entry) => entry.event === "failure" && entry.source === "api"),
    false,
  );
  report.connectionJournals = {
    knownOmitted: knownJournal,
    api: apiJournal,
    local: unknownJournal,
  };
  record(
    "a never-known target is refused locally without replacing the valid selection or creating a session",
    {
      source: "local",
      reason: "catalog_missing",
      sessionAttempts: 0,
    },
  );
  assert(
    report.transport
      .filter((entry) => entry.kind === "origin")
      .every((entry) => entry.cookiePresent === false),
  );
  assert.deepEqual(report.pageErrors, []);
  report.passed = true;
}

try {
  await verify();
} catch (error) {
  report.passed = false;
  report.error = String(error?.stack ?? error);
  report.browserErrors = await worker?.evaluate(() => globalThis.nativeIpErrors).catch(() => []);
  process.exitCode = 1;
} finally {
  await context?.close();
  for (const socket of sockets) socket.destroy();
  await Promise.all(servers.map((server) => new Promise((done) => server.close(done))));
  await writeFile(join(runRoot, "report.json"), JSON.stringify(report, null, 2) + "\n");
  await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2) + "\n");
  await writeFile(
    join(output, "latest.json"),
    JSON.stringify({ runRoot, passed: report.passed }, null, 2) + "\n",
  );
  process.stdout.write(
    JSON.stringify({
      passed: report.passed,
      report: join(runRoot, "report.json"),
      error: report.error,
    }) + "\n",
  );
}
