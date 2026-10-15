// SPDX-License-Identifier: MPL-2.0
// Real Chromium CONNECT / TLS / 407 regression. IP requests are never intercepted.
// Account APIs alone are replaced in an isolated copy before the worker starts.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, X509Certificate } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:https";
import { createRequire } from "node:module";
import { connect } from "node:net";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { waitForRead } from "../../../scripts/browser-wait.mjs";

const root = resolve(import.meta.dirname, "../../..");
const output = resolve(process.env.NATIVE_IP_OUTPUT || join(root, "audit/local/native154"));
await mkdir(output, { recursive: true });
const runRoot = await mkdtemp(join(output, "run-"));
const runtime = join(homedir(), ".cache/codex-runtimes/codex-primary-runtime/dependencies");
const require = createRequire(import.meta.url);
let playwrightModule = process.env.PLAYWRIGHT_MODULE_PATH;
if (!playwrightModule) {
  try {
    playwrightModule = require.resolve("playwright");
  } catch {
    playwrightModule = join(runtime, "node/node_modules/playwright/index.mjs");
  }
}
const { chromium } = await import(pathToFileURL(resolve(playwrightModule)).href);
const nodeHost = process.env.NATIVE_NODE_HOST || "127.0.0.1";
const expectedNodeIpv4 = (await (await import("node:dns/promises")).lookup(nodeHost, { family: 4 }))
  .address;
const cycles = Number(process.env.NATIVE_IP_CYCLES || 4);
const fixtureConfig = {
  nodeHost,
  expectedNodeIpv4,
  blockWorkerIp: process.env.NATIVE_IP_BLOCK_WORKER === "1",
  primaryStatus: Number(process.env.NATIVE_IP_PRIMARY_STATUS || 200),
  primaryDelayOnceMs: Number(process.env.NATIVE_IP_PRIMARY_DELAY_ONCE || 0),
};
assert([200, 403].includes(fixtureConfig.primaryStatus));
assert(Number.isInteger(cycles) && cycles >= 1, "At least one native cycle is required");
const report = {
  timestamp: new Date().toISOString(),
  isolation:
    "Temporary profile, local TLS origins and authenticated TLS proxies; no production account, no IP interception, no context.route",
  runRoot,
  fixtureConfig,
  browser: null,
  checks: [],
  cycles: [],
  transport: [],
  limits: [
    "Local fixtures do not establish the cause of a production failure.",
    "Chromium version is recorded; an installed Chrome refusing CLI extension loading is not treated as a passing test.",
  ],
};
let context;
const servers = [];
const sockets = new Set();
const proxySockets = new Set();
const slots = [];
let expectedEpoch = 1;
let worker;
let popup;
let extensionId;
let cdp;
const workerVersions = new Map();
let primaryDelayUsed = false;
let holdNextPrimary = false;
let failNextPrimary = 0;

function trace(kind, fields) {
  report.transport.push({ at: Date.now(), kind, ...fields });
}
function track(socket, proxy = false) {
  sockets.add(socket);
  if (proxy) proxySockets.add(socket);
  socket.on("close", () => {
    sockets.delete(socket);
    proxySockets.delete(socket);
  });
}
function closeTunnels() {
  for (const socket of proxySockets) socket.destroy();
}
function summarize(snapshot) {
  return {
    status: snapshot.status,
    protected: snapshot.protected,
    trafficBlocked: snapshot.trafficBlocked,
    activeLocationId: snapshot.activeLocationId,
    vpnNodeAddress: snapshot.vpnNodeAddress,
    network: snapshot.network,
  };
}

// This function is serialized into the isolated extension copy. The captured native
// fetch is used unchanged for every host except the synthetic account API.
function installAccountFixture(slotPorts, fixtureConfig) {
  const nativeFetch = globalThis.fetch.bind(globalThis);
  globalThis.nativeIpEpoch = 1;
  globalThis.nativeIpEvents = [];
  globalThis.nativeIpLookupCount = 0;
  const isIp = (url) => ["api.ipify.org", "ipv4.icanhazip.com"].includes(new URL(url).hostname);
  chrome.webRequest.onAuthRequired.addListener(
    (details) => {
      if (isIp(details.url))
        globalThis.nativeIpEvents.push({
          event: "auth",
          requestId: details.requestId,
          tabId: details.tabId,
          isProxy: details.isProxy,
          challenger: details.challenger,
        });
    },
    { urls: ["https://api.ipify.org/*", "https://ipv4.icanhazip.com/*"] },
  );
  chrome.webRequest.onErrorOccurred.addListener(
    (details) => {
      if (isIp(details.url))
        globalThis.nativeIpEvents.push({
          event: "error",
          requestId: details.requestId,
          tabId: details.tabId,
          code: details.error,
        });
    },
    { urls: ["https://api.ipify.org/*", "https://ipv4.icanhazip.com/*"] },
  );
  chrome.webRequest.onCompleted.addListener(
    (details) => {
      if (isIp(details.url))
        globalThis.nativeIpEvents.push({
          event: "completed",
          requestId: details.requestId,
          tabId: details.tabId,
          statusCode: details.statusCode,
        });
    },
    { urls: ["https://api.ipify.org/*", "https://ipv4.icanhazip.com/*"] },
  );
  chrome.identity.launchWebAuthFlow = async (details) => {
    const auth = new URL(details.url);
    const callback = new URL(auth.searchParams.get("redirect_uri"));
    callback.searchParams.set("state", auth.searchParams.get("state"));
    const grant = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replace(/=+$/, "");
    callback.searchParams.set("code", grant);
    return callback.href;
  };
  globalThis.fetch = async (input, options = {}) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.hostname !== "api.fuzevpn.com") {
      if (isIp(url.href)) globalThis.nativeIpLookupCount++;
      if (fixtureConfig.blockWorkerIp && isIp(url.href))
        throw new TypeError("Synthetic worker-only IP failure");
      return nativeFetch(input, options);
    }
    const method = options.method || "GET";
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
        locations: slotPorts.map((_port, index) => ({
          id: "native-ip-" + index,
          city: "Local " + index,
          country_code: "FR",
          display_name: "Native fixture " + index,
          supported_protocols: ["browser_proxy"],
        })),
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
      const locationId = JSON.parse(options.body).location_id;
      const slot = Number(locationId.split("-").at(-1));
      status = 201;
      body = {
        id: "native-ip-session-" + globalThis.nativeIpEpoch,
        location_id: locationId,
        scheme: "https",
        host: fixtureConfig.nodeHost,
        port: slotPorts[slot],
        username: "synthetic-" + globalThis.nativeIpEpoch,
        password: "synthetic-password-" + globalThis.nativeIpEpoch,
        issued_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 1800000).toISOString(),
        refresh_after_seconds: 900,
      };
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
  const python = process.env.PYTHON_EXECUTABLE || join(runtime, "python/python.exe");
  const source = [
    "from cryptography import x509",
    "from cryptography.x509.oid import NameOID",
    "from cryptography.hazmat.primitives import hashes, serialization",
    "from cryptography.hazmat.primitives.asymmetric import rsa",
    "from datetime import datetime, timedelta, timezone",
    "from pathlib import Path",
    "import ipaddress, sys",
    "key=rsa.generate_private_key(public_exponent=65537,key_size=2048)",
    "name=x509.Name([x509.NameAttribute(NameOID.COMMON_NAME,'Native IP fixture')])",
    "now=datetime.now(timezone.utc)",
    "cert=(x509.CertificateBuilder().subject_name(name).issuer_name(name).public_key(key.public_key()).serial_number(x509.random_serial_number()).not_valid_before(now-timedelta(minutes=5)).not_valid_after(now+timedelta(days=1)).add_extension(x509.SubjectAlternativeName([x509.IPAddress(ipaddress.ip_address('127.0.0.1'))]),critical=False).sign(key,hashes.SHA256()))",
    "Path(sys.argv[1],'key.pem').write_bytes(key.private_bytes(serialization.Encoding.PEM,serialization.PrivateFormat.PKCS8,serialization.NoEncryption()))",
    "Path(sys.argv[1],'cert.pem').write_bytes(cert.public_bytes(serialization.Encoding.PEM))",
  ].join("\n");
  const generated = spawnSync(python, ["-B", "-c", source, runRoot], {
    encoding: "utf8",
    windowsHide: true,
  });
  assert.equal(generated.status, 0, generated.stderr);
  const key = await readFile(join(runRoot, "key.pem"));
  const cert = await readFile(join(runRoot, "cert.pem"));
  const spki = createHash("sha256")
    .update(new X509Certificate(cert).publicKey.export({ format: "der", type: "spki" }))
    .digest("base64");
  for (const [slot, ip] of ["8.8.4.4", "9.9.9.9"].entries()) {
    const origin = createServer({ key, cert }, (request, response) => {
      const text = request.headers.host.startsWith("ipv4.icanhazip.com");
      const status =
        !text && failNextPrimary > 0
          ? (failNextPrimary--, 503)
          : text
            ? 200
            : fixtureConfig.primaryStatus;
      const body =
        status === 200
          ? text
            ? ip + "\n"
            : JSON.stringify({ ip })
          : JSON.stringify({ error: "synthetic_primary_denial" });
      trace("origin", {
        slot,
        host: request.headers.host,
        cookiePresent: Boolean(request.headers.cookie),
      });
      const respond = () => {
        if (response.destroyed) return;
        response.writeHead(status, {
          "Content-Type": text ? "text/plain" : "application/json",
          "Content-Length": Buffer.byteLength(body),
          "Cache-Control": "no-store",
        });
        response.end(body);
      };
      if (!text && holdNextPrimary) {
        holdNextPrimary = false;
        trace("origin-held", { slot });
        // Closing the first popup must cancel this request. New document requests
        // receive a normal response immediately; the held response never completes.
      } else if (!text && fixtureConfig.primaryDelayOnceMs > 0 && !primaryDelayUsed) {
        primaryDelayUsed = true;
        trace("origin-delay", { slot, delayMs: fixtureConfig.primaryDelayOnceMs });
        setTimeout(respond, fixtureConfig.primaryDelayOnceMs);
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
      trace("connect", {
        slot,
        epoch: expectedEpoch,
        host: request.url,
        credentialPresent: Boolean(credential),
        accepted,
      });
      if (!accepted) {
        socket.end(
          'HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="native-ip-fixture"\r\nContent-Length: 0\r\nConnection: close\r\n\r\n',
        );
        return;
      }
      const realDns = ["dns.google:443", "cloudflare-dns.com:443"].includes(request.url);
      if (!realDns && !["api.ipify.org:443", "ipv4.icanhazip.com:443"].includes(request.url)) {
        socket.destroy();
        return;
      }
      const upstream = connect(
        realDns ? 443 : origin.address().port,
        realDns ? request.url.split(":")[0] : "127.0.0.1",
        () => {
          socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
          if (head.length) upstream.write(head);
          socket.pipe(upstream);
          upstream.pipe(socket);
        },
      );
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
async function readIp(credentials = "omit") {
  return worker.evaluate(async (credentials) => {
    const started = performance.now();
    try {
      const response = await fetch(
        "https://api.ipify.org/?format=json&native=" + crypto.randomUUID(),
        {
          credentials,
          cache: "no-store",
          redirect: "error",
          referrerPolicy: "no-referrer",
          signal: AbortSignal.timeout(8000),
        },
      );
      return {
        status: response.status,
        body: await response.text(),
        elapsedMs: Math.round(performance.now() - started),
      };
    } catch (error) {
      return { error: String(error), elapsedMs: Math.round(performance.now() - started) };
    }
  }, credentials);
}
async function readyIp(slot) {
  const documentId = report.documentClient
    ? await waitForRead(() => popup.evaluate(() => globalThis.nativeIpDocumentId), Boolean, {
        timeoutMs: 6000,
        message: "Built popup did not register its document IP client",
      })
    : undefined;
  const snapshot = await waitForRead(
    () => message({ type: "refresh_network", ...(documentId ? { documentId } : {}) }),
    (snapshot) => snapshot.network.status === "ready" && snapshot.network.ip === slots[slot].ip,
    {
      timeoutMs: 16000,
      intervalMs: 40,
      message: "Native observation did not display expected IPv4 for slot " + slot,
    },
  );
  await waitForRead(
    () => popup.locator("#publicIp").textContent(),
    (text) => text === "VPN IP · " + expectedNodeIpv4,
    { timeoutMs: 5000, message: "Built popup did not render the active node" },
  );
  return snapshot;
}
async function readJournal() {
  if (!report.documentClient) return null;
  const journal = await popup.evaluate(() =>
    chrome.runtime.sendMessage({ type: "network_trace_get" }),
  );
  assert.equal(journal?.schemaVersion, 1, "Local IP journal was not exported");
  assert(Array.isArray(journal.events));
  const encoded = JSON.stringify(journal);
  assert(
    !/synthetic-password|audit@example|native-ip-fixture-token|8\.8\.4\.4|9\.9\.9\.9|Proxy-Authorization/i.test(
      encoded,
    ),
    "Local journal retained fixture credentials or IP values",
  );
  return journal;
}
async function restartWorker() {
  const previous = await message({ type: "get_snapshot" });
  const running = await waitForRead(
    async () =>
      [...workerVersions.values()].find(
        (version) => version.scriptURL === worker.url() && version.runningStatus === "running",
      ),
    Boolean,
    { timeoutMs: 5000, message: "Worker version is not available" },
  );
  await cdp.send("ServiceWorker.stopWorker", { versionId: running.versionId });
  await waitForRead(
    async () => workerVersions.get(running.versionId)?.runningStatus,
    (status) => status === "stopped",
    { timeoutMs: 5000, message: "Worker did not stop" },
  );
  await message({ type: "get_snapshot" });
  worker =
    context.serviceWorkers()[0] ||
    (await context.waitForEvent("serviceworker", { timeout: 10000 }));
  const restored = await message({ type: "get_snapshot" });
  assert.notEqual(
    restored.snapshotVersion.workerId,
    previous.snapshotVersion.workerId,
    "Worker startup identity did not change",
  );
  trace("worker-restart", {
    before: previous.snapshotVersion.workerId,
    after: restored.snapshotVersion.workerId,
  });
}

async function verify() {
  const spki = await createTlsFixture();
  const sourceExtension = resolve(process.env.EXTENSION_PATH || join(root, "dist/chrome"));
  const extension = join(runRoot, "extension");
  await cp(sourceExtension, extension, { recursive: true });
  const originalWorker = await readFile(join(extension, "background/service-worker.js"), "utf8");
  const manifest = JSON.parse(await readFile(join(extension, "manifest.json"), "utf8"));
  report.artifact = {
    version: manifest.version,
    sourceWorkerSha256: createHash("sha256").update(originalWorker).digest("hex"),
  };
  report.documentClient = originalWorker.includes("network_document_fetch");
  const fixture =
    "(" +
    installAccountFixture.toString() +
    ")(" +
    JSON.stringify(slots.map(({ port }) => port)) +
    "," +
    JSON.stringify(fixtureConfig) +
    ");\n";
  await writeFile(join(extension, "background/service-worker.js"), fixture + originalWorker);
  context = await chromium.launchPersistentContext(join(runRoot, "profile"), {
    executablePath:
      process.env.CHROME_EXECUTABLE || "C:/Program Files/Google/Chrome/Application/chrome.exe",
    ignoreDefaultArgs: ["--disable-extensions"],
    headless: true,
    ...(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : {}),
    args: [
      "--enable-unsafe-extension-debugging",

      "--host-resolver-rules=MAP " +
        nodeHost +
        " 127.0.0.1, MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1, EXCLUDE [::1]",
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
  await context.addInitScript(() => {
    if (!globalThis.chrome?.runtime?.sendMessage) return;
    const nativeSend = chrome.runtime.sendMessage.bind(chrome.runtime);
    chrome.runtime.sendMessage = (...args) => {
      const request = args[0];
      if (request?.type === "refresh_network" && request.documentId)
        globalThis.nativeIpDocumentId = request.documentId;
      return nativeSend(...args);
    };
    globalThis.nativeIpDocumentMessages = [];
    chrome.runtime.onMessage.addListener((message, sender) => {
      if (!["network_document_fetch", "network_document_cancel"].includes(message?.type)) return;
      globalThis.nativeIpDocumentMessages.push({
        type: message.type,
        senderIdMatches: sender.id === chrome.runtime.id,
        senderUrlPresent: typeof sender.url === "string",
        senderUrlOwnExtension: sender.url?.startsWith(chrome.runtime.getURL("")) === true,
        senderSource: sender.url?.includes("/background/") ? "background" : "other",
      });
    });
  });
  worker =
    context.serviceWorkers()[0] ||
    (await context.waitForEvent("serviceworker", { timeout: 15000 }));
  extensionId = worker.url().split("/")[2];
  popup = await context.newPage();
  await popup.goto("chrome-extension://" + extensionId + "/popup/popup.html");
  cdp = await context.newCDPSession(popup);
  cdp.on("ServiceWorker.workerVersionUpdated", ({ versions }) => {
    for (const version of versions) workerVersions.set(version.versionId, version);
  });
  await cdp.send("ServiceWorker.enable");
  await message({ type: "web_login", disconnectFirst: false });
  await message({ type: "set_language_preference", preference: "en" });
  await message({ type: "connect", locationId: "native-ip-0" });
  const firstConnected = await message({ type: "get_snapshot" });
  assert(
    firstConnected.vpnNodeAddress === null || firstConnected.vpnNodeAddress === expectedNodeIpv4,
  );
  assert.equal(firstConnected.network.status, "idle");
  await waitForRead(
    async () => (report.firstPopupText = await popup.locator("#publicIp").textContent()),
    (text) => text === "VPN IP · " + expectedNodeIpv4,
    { timeoutMs: 8000, message: "First connection did not display the node IPv4" },
  );
  const automaticCount = await worker.evaluate(() => globalThis.nativeIpLookupCount);
  await popup.waitForTimeout(5500);
  assert.equal(await worker.evaluate(() => globalThis.nativeIpLookupCount), automaticCount);
  report.checks.push({
    nodeHost,
    resolvedIpv4: expectedNodeIpv4,
    realDnsRequests: report.transport.filter((event) =>
      ["dns.google:443", "cloudflare-dns.com:443"].includes(event.host),
    ).length,
    phase: "first-connection",
    nodeDisplayedWithoutLookup: true,
    pollingLookups: 0,
  });
  let slot = 0;
  report.checks.push({
    phase: "cold",
    observation: summarize(await readyIp(slot)),
    raw: await readIp(),
    journal: await readJournal(),
  });
  for (let cycle = 1; cycle <= cycles; cycle++) {
    const started = Date.now();
    const firstTransport = report.transport.length;
    await worker.evaluate(() => {
      globalThis.nativeIpEvents.length = 0;
    });
    await popup.evaluate(() => {
      globalThis.nativeIpDocumentMessages.length = 0;
    });
    let action;
    if (cycle % 4 === 0) {
      action = "worker-restart";
      closeTunnels();
      await restartWorker();
    } else {
      expectedEpoch++;
      await worker.evaluate((epoch) => {
        globalThis.nativeIpEpoch = epoch;
      }, expectedEpoch);
      if (cycle % 4 === 1) {
        action = "credential-renewal";
        await message({ type: "retry_connection" });
      } else if (cycle % 4 === 2) {
        action = "proxy-port-switch";
        slot = 1 - slot;
        await message({ type: "change_location", locationId: "native-ip-" + slot });
      } else {
        action = "disconnect-reconnect";
        await message({ type: "disconnect" });
        await message({ type: "connect", locationId: "native-ip-" + slot });
      }
      closeTunnels();
    }
    const raw = await readIp();
    const observation = summarize(await readyIp(slot));
    const browserEvents = await worker.evaluate(() => globalThis.nativeIpEvents);
    const documentMessages = await popup.evaluate(() => globalThis.nativeIpDocumentMessages);
    const journal = await readJournal();
    const result = {
      cycle,
      action,
      epoch: expectedEpoch,
      slot,
      elapsedMs: Date.now() - started,
      raw,
      observation,
      browserEvents,
      documentMessages,
      journal: journal
        ? { ...journal, events: journal.events.filter((event) => event.at >= started) }
        : null,
      transport: report.transport.slice(firstTransport),
    };
    report.cycles.push(result);
    if (fixtureConfig.blockWorkerIp)
      assert(raw.error?.includes("Synthetic worker-only IP failure"), JSON.stringify(result));
    else {
      assert.equal(raw.status, fixtureConfig.primaryStatus, JSON.stringify(result));
      if (raw.status === 200)
        assert.equal(JSON.parse(raw.body).ip, slots[slot].ip, JSON.stringify(result));
    }
    assert.equal(observation.network.ip, slots[slot].ip, JSON.stringify(result));
    process.stdout.write(
      "PASS native IP cycle " + cycle + "/" + cycles + " " + action + " " + raw.elapsedMs + " ms\n",
    );
    await writeFile(join(runRoot, "report.json"), JSON.stringify(report, null, 2) + "\n");
  }
  if (report.documentClient && fixtureConfig.primaryStatus === 200) {
    const oldDocumentId = await popup.evaluate(() => globalThis.nativeIpDocumentId);
    const firstTransport = report.transport.length;
    holdNextPrimary = true;
    expectedEpoch++;
    await worker.evaluate((epoch) => {
      globalThis.nativeIpEpoch = epoch;
    }, expectedEpoch);
    await message({ type: "retry_connection" });
    await waitForRead(
      async () =>
        report.transport.slice(firstTransport).some((event) => event.kind === "origin-held"),
      Boolean,
      { timeoutMs: 5000, message: "First popup did not begin its held IP request" },
    );
    const replacedAt = Date.now();
    await popup.close();
    popup = await context.newPage();
    await popup.goto("chrome-extension://" + extensionId + "/popup/popup.html");
    const observation = summarize(await readyIp(slot));
    const elapsedMs = Date.now() - replacedAt;
    const newDocumentId = await popup.evaluate(() => globalThis.nativeIpDocumentId);
    const result = {
      phase: "popup-replacement",
      elapsedMs,
      documentIdChanged: newDocumentId !== oldDocumentId,
      observation,
      journal: await readJournal(),
      transport: report.transport.slice(firstTransport),
    };
    report.checks.push(result);
    assert(result.documentIdChanged, "Reopened popup reused the previous document identity");
    assert(
      elapsedMs < 4000,
      "Reopened popup inherited the old document timeout or error cache: " + JSON.stringify(result),
    );
    process.stdout.write("PASS native popup replacement " + elapsedMs + " ms\n");
  }
  const page = await context.newPage();
  const tabProvider =
    fixtureConfig.primaryStatus === 200
      ? "https://api.ipify.org/?format=json"
      : "https://ipv4.icanhazip.com/";
  const response = await page.goto(tabProvider, { timeout: 10000 });
  const tabIp =
    fixtureConfig.primaryStatus === 200
      ? JSON.parse(await response.text()).ip
      : (await response.text()).trim();
  assert.equal(tabIp, slots[slot].ip);
  report.checks.push({ phase: "tab-navigation", status: response.status(), ip: slots[slot].ip });
  report.journal = await readJournal();
  if (report.documentClient) {
    assert(
      report.cycles.some((cycle) =>
        cycle.documentMessages.some((message) => message.type === "network_document_fetch"),
      ),
      "No actual popup document IP request was observed",
    );
    assert(
      report.journal.events.some(
        (event) => event.event === "attempt_success" && event.context === "document",
      ),
      "Local journal omitted successful document IP measurements",
    );
  }

  await popup.close();
  await worker.evaluate(async () => chrome.action.openPopup());
  const toolbarContexts = await worker.evaluate(async () =>
    (await chrome.runtime.getContexts({ contextTypes: ["POPUP"] })).map((c) => ({
      type: c.contextType,
      tabId: c.tabId,
    })),
  );
  assert(toolbarContexts.some((c) => c.type === "POPUP" && c.tabId === -1));
  const info = (await loader.send("Target.getTargets")).targetInfos.find(
    (t) => t.url === `chrome-extension://${extensionId}/popup/popup.html`,
  );
  assert(info, "No actual action popup target");
  const { sessionId: popupSession } = await loader.send("Target.attachToTarget", {
    targetId: info.targetId,
    flatten: false,
  });
  let rpcSequence = 0;
  const rpcPending = new Map();
  loader.on("Target.receivedMessageFromTarget", ({ sessionId, message }) => {
    if (sessionId !== popupSession) return;
    const reply = JSON.parse(message);
    if (reply.id && rpcPending.has(reply.id)) {
      rpcPending.get(reply.id)(reply);
      rpcPending.delete(reply.id);
    }
  });
  const popupRead = async (expression) => {
    const id = ++rpcSequence;
    const pending = new Promise((resolve) => rpcPending.set(id, resolve));
    await loader.send("Target.sendMessageToTarget", {
      sessionId: popupSession,
      message: JSON.stringify({
        id,
        method: "Runtime.evaluate",
        params: { expression, returnByValue: true, awaitPromise: true },
      }),
    });
    const reply = await pending;
    return reply.result?.result?.value;
  };
  assert.equal(
    await popupRead('chrome.runtime.sendMessage({type:"retry_connection"}).then(r=>r.ok)'),
    true,
  );
  const toolbarIp = await waitForRead(
    () => popupRead('document.querySelector("#publicIp")?.textContent'),
    (value) => value === "VPN IP · " + expectedNodeIpv4,
    { timeoutMs: 1500, message: "Actual action popup did not render its node" },
  );
  report.toolbarPopup = {
    contexts: toolbarContexts,
    displayedNode: toolbarIp,
  };
  failNextPrimary = 2;
  assert.equal(
    await popupRead('chrome.runtime.sendMessage({type:"retry_connection"}).then(r=>r.ok)'),
    true,
  );
  await popupRead('chrome.runtime.sendMessage({type:"refresh_network"})');
  await waitForRead(
    () =>
      popupRead(
        'chrome.runtime.sendMessage({type:"get_snapshot"}).then(r=>r.snapshot.network.status)',
      ),
    (value) => value === "unavailable",
    { timeoutMs: 4000, message: "Injected popup failure was not observed" },
  );
  assert.equal(
    await popupRead('document.querySelector("#publicIp")?.textContent'),
    "VPN IP · " + expectedNodeIpv4,
  );
  report.nodeUnaffectedByIpServiceFailure = true;
  assert.equal(
    await popupRead('chrome.runtime.sendMessage({type:"diagnostics_run"}).then(r=>r.ok)'),
    true,
  );
  const healed = await waitForRead(
    () => popupRead('document.querySelector("#publicIp")?.textContent'),
    (value) => value === "VPN IP · " + expectedNodeIpv4,
    { timeoutMs: 1500, message: "Diagnostic changed the displayed node" },
  );
  report.nodeUnaffectedByDiagnostic = healed === "VPN IP · " + expectedNodeIpv4;
  const journal = await popupRead('chrome.runtime.sendMessage({type:"get_ip_journal"})');
  assert(journal.entries.some((entry) => entry.event === "failure" && entry.httpStatus === 503));
  assert(!JSON.stringify(journal).match(/synthetic-password|8[.]8[.]4[.]4|9[.]9[.]9[.]9/));
  report.localJournal = {
    events: journal.entries.length,
    httpFailureRecorded: true,
    privateFieldsAbsent: true,
  };

  report.passed = true;
}

try {
  await verify();
} catch (error) {
  report.passed = false;
  report.failure = String(error.stack || error);
  process.exitCode = 1;
} finally {
  if (context) await context.close();
  for (const socket of sockets) socket.destroy();
  await Promise.all(servers.map((server) => new Promise((done) => server.close(done))));
  await writeFile(join(runRoot, "report.json"), JSON.stringify(report, null, 2) + "\n");
  await writeFile(
    join(output, "latest.json"),
    JSON.stringify(
      {
        runRoot,
        report: join(runRoot, "report.json"),
        passed: report.passed,
        browser: report.browser,
        completedCycles: report.cycles.length,
      },
      null,
      2,
    ) + "\n",
  );
  process.stdout.write("Native transport report: " + join(runRoot, "report.json") + "\n");
  if (report.failure) process.stderr.write(report.failure + "\n");
}
