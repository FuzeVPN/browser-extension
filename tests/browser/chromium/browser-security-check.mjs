// SPDX-License-Identifier: MPL-2.0

// Optional real-Chromium verification. Run after npm run build.
// Uses an isolated temporary profile, synthetic credentials, and local test traffic only.
// Set PLAYWRIGHT_MODULE_PATH / CHROMIUM_EXECUTABLE when Playwright is not on Node's path.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { SUPPORTED_LANGUAGES, localeDirectory } from "../../../scripts/supported-locales.mjs";

const root = resolve(import.meta.dirname, "../../..");
const require = createRequire(import.meta.url);
const runtimeModules = join(
  homedir(),
  ".cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules",
);
let playwrightPath = process.env.PLAYWRIGHT_MODULE_PATH;
if (!playwrightPath) {
  try {
    playwrightPath = require.resolve("playwright");
  } catch {
    playwrightPath = join(runtimeModules, "playwright/index.mjs");
  }
}
const { chromium } = await import(pathToFileURL(resolve(playwrightPath)).href);
const testRoot = await mkdtemp(join(tmpdir(), "fuzevpn-browser-security-"));
const report = {
  timestamp: new Date().toISOString(),
  profileIsolation: "Fresh temporary profiles; installed user browsers and settings untouched",
  checks: [],
  limitations: [
    "No production API credentials, VPN proxy, external STUN/TURN, or public IPv6 path tested.",
    "API replies and proxy credentials in application scenarios are synthetic fixtures.",
    "WebTransport is checked in Chrome's actual rule matcher, without an HTTP/3 server.",
    "Existing connections, protected Chrome traffic and other-extension takeover windows are not covered.",
    "Privileged chrome-extension:// pages can still produce UDP ICE candidates; the WebRTC check covers ordinary web pages.",
  ],
};
let context;
let nextRequest = 0;
const receivedPaths = [];
const server = createServer((request, response) => {
  receivedPaths.push(request.url);
  response.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "no-store" });
  response.end("<!doctype html><title>Local safety fixture</title><p>Local test only.</p>");
});
server.on("upgrade", (request, socket) => {
  receivedPaths.push(request.url);
  socket.destroy();
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const localOrigin = `http://127.0.0.1:${server.address().port}`;

function record(name, details = undefined) {
  report.checks.push({ name, passed: true, ...(details === undefined ? {} : { details }) });
  process.stdout.write(`PASS ${name}\n`);
}

async function launch(extensionPath, profileName) {
  const launchOptions = {
    channel: "chromium",
    headless: true,
    viewport: { width: 360, height: 600 },
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
      "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1, EXCLUDE [::1]",
      "--disable-background-networking",
    ],
  };
  if (process.env.CHROMIUM_EXECUTABLE)
    launchOptions.executablePath = process.env.CHROMIUM_EXECUTABLE;
  context = await chromium.launchPersistentContext(join(testRoot, profileName), launchOptions);
  report.chromium = context.browser().version();
  const worker =
    context.serviceWorkers()[0] ??
    (await context.waitForEvent("serviceworker", { timeout: 15000 }));
  return worker;
}

async function collectIce(page) {
  return page.evaluate(async () => {
    const connection = new RTCPeerConnection({ iceServers: [] });
    const candidates = [];
    connection.addEventListener("icecandidate", ({ candidate }) => {
      if (candidate) candidates.push({ protocol: candidate.protocol, type: candidate.type });
    });
    connection.createDataChannel("local-audit");
    await connection.setLocalDescription(await connection.createOffer());
    await new Promise((done) => {
      if (connection.iceGatheringState === "complete") return done();
      const timer = setTimeout(done, 3000);
      connection.addEventListener("icegatheringstatechange", () => {
        if (connection.iceGatheringState === "complete") {
          clearTimeout(timer);
          done();
        }
      });
    });
    connection.close();
    return candidates;
  });
}

async function blockedNavigation(url) {
  const page = await context.newPage();
  try {
    await assert.rejects(page.goto(url, { timeout: 10000 }), /ERR_BLOCKED_BY_CLIENT/);
  } finally {
    await page.close();
  }
}

async function screenshot(popup, name) {
  await popup.evaluate(async () => {
    await Promise.allSettled(
      document
        .getAnimations()
        .filter((animation) => animation.effect?.getTiming().iterations !== Infinity)
        .map((animation) => animation.finished),
    );
  });
  await popup.screenshot({ path: join(testRoot, name), fullPage: !name.includes("settings") });
}

async function verifyLegalLinks(popup, language, catalog) {
  const websiteLanguage = ["fr", "en", "es", "de", "nl"].includes(language) ? language : "en";
  const links = await popup.locator("a[data-legal-link]").evaluateAll((nodes) =>
    nodes.map((node) => ({
      kind: node.dataset.legalLink,
      key: node.dataset.i18n,
      label: node.textContent.trim(),
      href: node.href,
      hreflang: node.hreflang,
      target: node.target,
      rel: node.rel.split(/\s+/).sort(),
      tabIndex: node.tabIndex,
    })),
  );
  assert.equal(links.length, 6);
  for (const link of links) {
    const page =
      link.kind === "contact"
        ? ({ es: "contacto", de: "kontakt" }[websiteLanguage] ?? "contact")
        : link.kind;
    assert.equal(link.href, `https://fuzevpn.com/${websiteLanguage}/${page}.html`);
    assert.equal(link.hreflang, websiteLanguage);
    assert.equal(link.target, "_blank");
    assert.deepEqual(link.rel, ["noopener", "noreferrer"]);
    assert.equal(link.label, catalog[link.key].message);
    assert.equal(link.tabIndex, 0);
  }
  assert.equal(await popup.locator(".legal-links a[data-legal-link]").count(), 4);
  assert.equal(await popup.locator("#legalInformationTitle").isVisible(), true);
  assert.equal(await popup.locator("#diagnosticsPrivacyLink").isVisible(), true);
}

async function outcome(worker, request) {
  return worker.evaluate(
    async (details) => (await chrome.declarativeNetRequest.testMatchOutcome(details)).matchedRules,
    request,
  );
}

async function verifyRules(worker, ids, connected) {
  const extensionOrigin = `chrome-extension://${worker.url().split("/")[2]}`;
  const publicUrls = ["https://public.invalid/", "https://[2606:4700:4700::1111]/"];
  for (const type of ["main_frame", "sub_frame", "xmlhttprequest", "websocket", "webtransport"]) {
    const url = type === "websocket" ? "wss://public.invalid/socket" : publicUrls[0];
    const matches = await outcome(worker, { url, type });
    assert(matches.some((rule) => rule.ruleId === (connected ? ids.sessionAllow : ids.baseline)));
  }
  const localUrls = [
    "http://printer/",
    "http://printer./",
    "http://localhost/",
    "http://localhost./",
    "http://child.localhost/",
    "http://host.local/",
    "http://host.local./",
    "http://127.1/",
    "http://2130706433/",
    "http://0x7f000001/",
    "http://0177.0.0.1/",
    "http://0.0.0.0/",
    "http://10.1.2.3/",
    "http://172.16.0.1/",
    "http://172.31.255.255/",
    "http://192.168.1.1/",
    "http://169.254.1.1/",
    "http://100.64.0.1/",
    "http://100.127.255.255/",
    "http://[::]/",
    "http://[::1]/",
    "http://[0:0:0:0:0:0:0:1]/",
    "http://[fc00::1]/",
    "http://[FDFF::1]/",
    "http://[fe80::1]/",
    "http://[febf::1]/",
    "http://[::ffff:127.0.0.1]/",
    "http://[::ffff:192.168.1.1]/",
    "http://[::ffff:10.1.2.3]/",
    "http://[::127.0.0.1]/",
  ];
  const localIds = Object.entries(ids)
    .filter(([name]) => !["baseline", "sessionAllow", "apiBlock", "apiAllow"].includes(name))
    .map(([, id]) => id);
  for (const url of localUrls) {
    const matches = await outcome(worker, { url, type: "main_frame" });
    assert(
      matches.some((rule) => localIds.includes(rule.ruleId)),
      `Unblocked local URL ${url}`,
    );
  }
  for (const url of publicUrls) {
    const matches = await outcome(worker, { url, type: "main_frame" });
    assert(
      !matches.some((rule) => localIds.includes(rule.ruleId)),
      `Overblocked public URL ${url}`,
    );
  }
  for (const request of [
    { url: "https://api.fuzevpn.com/v1/me", type: "main_frame" },
    { url: "https://api.fuzevpn.com./v1/me", type: "main_frame" },
    { url: "https://synthetic@api.fuzevpn.com/v1/me", type: "main_frame" },
    {
      url: "https://api.fuzevpn.com/v1/me",
      type: "xmlhttprequest",
      initiator: "https://site.invalid",
    },
  ]) {
    assert((await outcome(worker, request)).some((rule) => rule.ruleId === ids.apiBlock));
  }
  for (const url of ["https://api.fuzevpn.com/v1/me", "https://api.fuzevpn.com:443/v1/me"]) {
    assert(
      (await outcome(worker, { url, type: "xmlhttprequest", initiator: extensionOrigin })).some(
        (rule) => rule.ruleId === ids.apiAllow,
      ),
    );
  }
  for (const url of [
    "http://api.fuzevpn.com/v1/me",
    "https://api.fuzevpn.com:444/v1/me",
    "https://api.fuzevpn.com.evil.invalid/v1/me",
  ]) {
    assert(
      !(await outcome(worker, { url, type: "xmlhttprequest", initiator: extensionOrigin })).some(
        (rule) => rule.ruleId === ids.apiAllow,
      ),
    );
  }
  record(`Chrome rule matching (${connected ? "connected" : "blocked"})`, {
    localUrls: localUrls.length,
    navigationAndTransportTypes: 5,
    apiOriginAndInitiatorChecks: 9,
  });
}

async function verifySafetyModule() {
  const extensionPath = join(testRoot, "safety-module-fixture");
  await mkdir(extensionPath, { recursive: true });
  const suffixRules = await readFile(
    join(root, "src/core/shared/vendor/public-suffix-rules.json"),
    "utf8",
  );
  for (const file of [
    "platform/chromium/network-safety",
    "platform/chromium/proxy-controller",
    "platform/contracts/network-safety",
    "platform/contracts/proxy",
    "core/shared/config",
    "core/shared/site-exclusions",
  ]) {
    const compiled = ts.transpileModule(await readFile(join(root, `src/${file}.ts`), "utf8"), {
      compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    await mkdir(join(extensionPath, "src", file, ".."), { recursive: true });
    await writeFile(
      join(extensionPath, `src/${file}.js`),
      compiled
        .replace(
          'import publicSuffixRules from "./vendor/public-suffix-rules.json";',
          `const publicSuffixRules = ${suffixRules};`,
        )
        .replace(/(from\s+["'])(\.\.?\/[^"']+)(["'])/g, "$1$2.js$3"),
    );
  }
  await writeFile(
    join(extensionPath, "worker.js"),
    'import { PlatformNetworkSafetyService, SAFETY_RULE_IDS } from "./src/platform/chromium/network-safety.js"; globalThis.safety = new PlatformNetworkSafetyService(); globalThis.ruleIds = SAFETY_RULE_IDS;',
  );
  await writeFile(
    join(extensionPath, "fixture.html"),
    "<!doctype html><title>Safety fixture</title>",
  );
  await writeFile(
    join(extensionPath, "manifest.json"),
    JSON.stringify({
      manifest_version: 3,
      name: "FuzeVPN isolated security module test",
      version: "0.2.0",
      permissions: ["privacy", "declarativeNetRequest"],
      host_permissions: ["<all_urls>"],
      background: { service_worker: "worker.js", type: "module" },
    }),
  );
  let worker = await launch(extensionPath, "safety-module-profile");
  const ids = await worker.evaluate(() => globalThis.ruleIds);
  const before = await worker.evaluate(() => chrome.privacy.network.webRTCIPHandlingPolicy.get({}));
  let fixturePage = await context.newPage();
  await fixturePage.goto(`chrome-extension://${worker.url().split("/")[2]}/fixture.html`);
  const baselineIce = await collectIce(fixturePage);
  const allowedPage = await context.newPage();
  const path = `/before-${++nextRequest}`;
  await allowedPage.goto(`${localOrigin}${path}`);
  assert(receivedPaths.includes(path));
  const baselinePageIce = await collectIce(allowedPage);
  await worker.evaluate(() => globalThis.safety.block(true));
  await verifyRules(worker, ids, false);
  await worker.evaluate(() => globalThis.safety.setWebRtc(true));
  const privacy = await worker.evaluate(() =>
    chrome.privacy.network.webRTCIPHandlingPolicy.get({}),
  );
  assert.equal(privacy.value, "disable_non_proxied_udp");
  assert.equal(privacy.levelOfControl, "controlled_by_this_extension");
  const protectedIce = await collectIce(fixturePage);
  const protectedExistingPageIce = await collectIce(allowedPage);
  await allowedPage.close();
  const freshRtcPage = await context.newPage();
  const freshProtectedIce = await collectIce(freshRtcPage);
  await freshRtcPage.close();
  record("WebRTC policy readback and local ICE observations", {
    baselineIce,
    baselinePageIce,
    protectedIce,
    protectedExistingPageIce,
    freshProtectedIce,
  });
  assert(!protectedExistingPageIce.some((candidate) => candidate.protocol === "udp"));
  assert(
    !freshProtectedIce.some((candidate) => candidate.protocol === "udp"),
    JSON.stringify({ baselineIce, protectedIce, freshProtectedIce }),
  );
  await worker.evaluate(() => globalThis.safety.allow());
  await verifyRules(worker, ids, true);
  const blockedPath = `/blocked-${++nextRequest}`;
  await blockedNavigation(`${localOrigin}${blockedPath}`);
  assert(!receivedPaths.includes(blockedPath));
  await blockedNavigation("http://[::1]/");
  record("Connected filter blocks real IPv4/IPv6 loopback navigation before network");
  const websocketPath = `/websocket-${++nextRequest}`;
  await fixturePage.evaluate(
    (url) =>
      new Promise((done, reject) => {
        const socket = new WebSocket(url);
        const timer = setTimeout(() => reject(new Error("WebSocket did not fail")), 3000);
        socket.onerror = () => {
          clearTimeout(timer);
          done();
        };
        socket.onopen = () => reject(new Error("Local WebSocket was not blocked"));
      }),
    `${localOrigin.replace("http:", "ws:")}${websocketPath}`,
  );
  assert(!receivedPaths.includes(websocketPath));
  record("Connected filter blocks a real new local WebSocket without reaching the server");
  const persistentRules = await worker.evaluate(() =>
    chrome.declarativeNetRequest.getDynamicRules(),
  );
  await context.close();
  context = undefined;
  worker = await launch(extensionPath, "safety-module-profile");
  assert.deepEqual(
    await worker.evaluate(() => chrome.declarativeNetRequest.getDynamicRules()),
    persistentRules,
  );
  assert.deepEqual(await worker.evaluate(() => chrome.declarativeNetRequest.getSessionRules()), []);
  assert.equal((await worker.evaluate(() => globalThis.safety.inspect())).trafficBlocked, true);
  await blockedNavigation("https://public.invalid/restart-test");
  record("Full browser restart preserves dynamic block and removes session allowance");
  await worker.evaluate(async () => {
    await globalThis.safety.release();
    await globalThis.safety.setWebRtc(false);
  });
  const after = await worker.evaluate(() => chrome.privacy.network.webRTCIPHandlingPolicy.get({}));
  assert.equal(after.value, before.value);
  assert.notEqual(after.levelOfControl, "controlled_by_this_extension");
  fixturePage = await context.newPage();
  const releasedPath = `/released-${++nextRequest}`;
  await fixturePage.goto(`${localOrigin}${releasedPath}`);
  assert(receivedPaths.includes(releasedPath));
  record("Release restores underlying WebRTC preference and real local navigation");
  await context.close();
  context = undefined;
}

async function verifyBuiltApplication() {
  const extensionPath = process.env.CHROME_EXTENSION_DIR || join(root, "dist/chrome");
  const manifest = JSON.parse(await readFile(join(extensionPath, "manifest.json"), "utf8"));
  const packageInfo = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  assert.equal(
    manifest.version,
    packageInfo.version,
    "Rebuild the current package before browser checks",
  );
  assert.equal(manifest.minimum_chrome_version, "116");
  assert(manifest.permissions.includes("identity"));
  report.builtArtifact = { version: manifest.version };
  for (const file of ["manifest.json", "background/service-worker.js"]) {
    report.builtArtifact[file] = createHash("sha256")
      .update(await readFile(join(extensionPath, file)))
      .digest("hex");
  }
  let apiMode = "healthy";
  const apiRequests = [];
  let sessionNumber = 0;
  const locationId = "browser-audit-01";
  async function installSyntheticApi() {
    await context.route("https://fuzevpn.com/**", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: "<!doctype html><title>Local legal-link fixture</title>",
      }),
    );
    await context.route("https://api.fuzevpn.com/**", async (route) => {
      const url = new URL(route.request().url());
      const method = route.request().method();
      apiRequests.push(`${method} ${url.pathname}`);
      let status = 200;
      let body;
      if (apiMode === "unavailable") {
        status = 503;
        body = { error: "proxy_unavailable" };
      } else if (apiMode === "unauthorized" && url.pathname !== "/v1/locations") {
        status = 401;
        body = { error: "unauthorized" };
      } else if (url.pathname === "/v1/auth/extension/token") {
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
        assert(grant, "Session acquisition requires a one-use synthetic authorization grant");
        assert.equal(request.client_id, grant.clientId);
        assert.equal(request.redirect_uri, grant.redirectUri);
        assert.equal(
          createHash("sha256").update(request.code_verifier).digest("base64url"),
          grant.challenge,
        );
        status = 201;
        body = {
          access_token: "isolated-synthetic-audit-token",
          expires_at: new Date(Date.now() + 3600000).toISOString(),
        };
      } else if (url.pathname === "/v1/me") {
        body = {
          user_id: "isolated-browser-audit",
          email: "audit@example.invalid",
          first_name: "Browser",
          last_name: "Audit",
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
              id: locationId,
              city: "Local audit",
              country_code: "FR",
              display_name: "Synthetic browser audit",
              supported_protocols: ["browser_proxy"],
            },
          ],
        };
      } else if (url.pathname === "/v1/devices/browser") {
        status = 201;
        body = {
          device_id: "isolated-browser-device",
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
          location_id: locationId,
          scheme: "https",
          host: "unavailable.proxy.audit.invalid",
          port: 443,
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
  async function popupFor(worker) {
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
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${worker.url().split("/")[2]}/popup/popup.html`);
    await popup.evaluate(() => {
      const original = chrome.runtime.sendMessage.bind(chrome.runtime);
      globalThis.auditMessages = [];
      chrome.runtime.sendMessage = (...args) => {
        if (args[0]?.type !== "get_snapshot") globalThis.auditMessages.push(args[0]);
        const response = original(...args);
        if (args[0]?.type !== "get_snapshot") globalThis.auditMutationResult = response;
        return response;
      };
    });
    return popup;
  }
  async function message(popup, request, expectedError = null) {
    const response = await popup.evaluate((value) => chrome.runtime.sendMessage(value), request);
    if (expectedError) {
      assert.equal(response?.ok, false, JSON.stringify(response));
      assert.equal(response.commandError, expectedError);
    } else
      assert(
        response && response.ok,
        `Message failed: ${request.type}: ${JSON.stringify(response)}`,
      );
    return response.snapshot;
  }
  async function verifyLanguages(popup, worker, state) {
    const languages = SUPPORTED_LANGUAGES;
    const operations = await worker.evaluate(() => {
      globalThis.languageAuditOperations = [];
      for (const [object, key] of [
        [chrome.proxy.settings, "set"],
        [chrome.proxy.settings, "clear"],
        [chrome.declarativeNetRequest, "updateDynamicRules"],
        [chrome.declarativeNetRequest, "updateSessionRules"],
        [chrome.privacy.network.webRTCIPHandlingPolicy, "set"],
        [chrome.privacy.network.webRTCIPHandlingPolicy, "clear"],
      ]) {
        const original = object[key].bind(object);
        object[key] = (...args) => {
          globalThis.languageAuditOperations.push(key);
          return original(...args);
        };
      }
      return globalThis.languageAuditOperations.length;
    });
    const requests = apiRequests.length;
    await popup.locator("#settingsButton").click();
    for (const code of languages) {
      const catalog = JSON.parse(
        await readFile(
          join(extensionPath, "_locales", localeDirectory(code), "messages.json"),
          "utf8",
        ),
      );
      await popup.locator("#languageSelect").selectOption(code);
      await popup.waitForFunction((code) => document.documentElement.lang === code, code);
      assert.equal(await popup.locator("#settingsTitle").textContent(), catalog.settings.message);
      assert.equal(await popup.locator("#languageSelect").inputValue(), code);
      assert(await popup.locator("#settingsPanel").isVisible());
      await verifyLegalLinks(popup, code, catalog);
      assert(
        await popup.evaluate(() => {
          const panel = document.querySelector("#settingsPanel");
          return panel.scrollWidth <= panel.clientWidth + 1;
        }),
        `Horizontal overflow: ${code}/${state}`,
      );
      await screenshot(popup, `language-${state}-${code}.png`);
      if (["fr", "ar"].includes(code)) {
        await popup.locator("#legalContactLink").scrollIntoViewIfNeeded();
        await screenshot(popup, `legal-${state}-${code}.png`);
      }
      await popup.keyboard.press("Escape");
      if (state === "logged-out")
        assert.equal(await popup.locator("#loginPrivacyLink").isVisible(), true);
      await screenshot(popup, `main-${state}-${code}.png`);
      await popup.locator("#settingsButton").click();
      const snapshot = await message(popup, { type: "get_snapshot" });
      assert.equal(snapshot.effectiveLanguage, code);
      assert.equal(snapshot.languagePreference, code);
    }
    assert.equal(apiRequests.length, requests, "Language change made API requests");
    assert.equal(
      await worker.evaluate(() => globalThis.languageAuditOperations.length),
      operations,
      "Language change changed network controls",
    );
    await popup.keyboard.press("Escape");
    record(
      `Thirty languages render with localized legal links, no horizontal overflow or VPN operations: ${state}`,
    );
  }
  let worker = await launch(extensionPath, "application-profile");
  await installSyntheticApi();
  let popup = await popupFor(worker);
  const initial = await message(popup, { type: "get_snapshot" });
  assert.deepEqual(initial.securityPreferences, {
    killSwitchEnabled: true,
    webRtcProtectionEnabled: true,
  });
  assert.equal(initial.protectionRequested, false);
  const requestsBeforePrivacy = apiRequests.length;
  const legalTabEvent = popup.waitForEvent("popup");
  const privacyUrl = await popup.locator("#loginPrivacyLink").getAttribute("href");
  await popup.locator("#loginPrivacyLink").click();
  const legalTab = await legalTabEvent;
  await legalTab.waitForURL(privacyUrl);
  assert.equal(await legalTab.evaluate(() => window.opener === null), true);
  await legalTab.close();
  const afterPrivacy = await message(popup, { type: "get_snapshot" });
  assert.equal(afterPrivacy.protectionRequested, initial.protectionRequested);
  assert.equal(afterPrivacy.protected, initial.protected);
  assert.deepEqual(afterPrivacy.securityPreferences, initial.securityPreferences);
  assert.equal(await popup.locator("#diagnosticsAuto").isChecked(), false);
  assert.equal(apiRequests.length, requestsBeforePrivacy);
  record(
    "Privacy is accessible before login in an isolated tab without changing protection or consent",
  );
  assert.equal(await popup.locator("#email, #password").count(), 0);
  await verifyLanguages(popup, worker, "logged-out");
  assert.equal(await popup.locator("#loginButton").isEnabled(), true);
  await message(popup, { type: "web_login", disconnectFirst: false });
  const connected = await message(popup, { type: "connect", locationId });
  assert.equal(connected.protected, true, JSON.stringify(connected));
  assert.equal(connected.trafficBlocked, false);
  assert.equal(connected.webRtcProtected, true);
  assert.equal(connected.protectionRequested, true);
  const proxy = await worker.evaluate(() => chrome.proxy.settings.get({ incognito: false }));
  assert.equal(proxy.value.mode, "fixed_servers");
  assert.equal(proxy.value.rules.singleProxy.scheme, "https");
  assert(proxy.value.rules.bypassList.includes("<-loopback>"));
  assert(!proxy.value.rules.bypassList.includes("<local>"));
  record(
    `Built v${manifest.version} connects with synthetic API and verified real Chrome protection settings`,
  );
  await verifyLanguages(popup, worker, "connected");
  await popup.locator("#settingsButton").click();
  await popup.locator("#manageDevicesButton").click();
  await popup.locator("#devicesDialog").waitFor({ state: "visible" });
  await popup.locator("#closeDevicesButton").click();
  await popup.locator("#settingsPanel").waitFor({ state: "visible" });
  await popup.waitForFunction(() => document.activeElement?.id === "manageDevicesButton");
  await popup.keyboard.press("Escape");
  const requestsBeforeSameLocation = apiRequests.length;
  await popup.locator("#changeLocationButton").click();
  await popup.waitForFunction(
    () => document.getElementById("refreshLocationsButton")?.getAttribute("aria-busy") === "false",
  );
  await popup.locator("#locationSearch").fill("Synthetic browser audit");
  await popup.locator(".location-option.selected").click();
  await popup.locator("#locationDialog").waitFor({ state: "hidden" });
  assert.deepEqual(apiRequests.slice(requestsBeforeSameLocation), ["GET /v1/locations"]);
  record(
    "Devices return with focus; opening locations refreshes only their catalog and selecting the current location keeps the connection untouched",
  );
  const failedProxyPage = await context.newPage();
  await assert.rejects(
    failedProxyPage.goto("https://public.invalid/isolated-proxy-failure", { timeout: 10000 }),
    /ERR_PROXY_CONNECTION_FAILED/,
  );
  await failedProxyPage.close();
  assert.equal((await message(popup, { type: "get_snapshot" })).protected, true);
  assert.equal(
    (await worker.evaluate(() => chrome.proxy.settings.get({ incognito: false }))).value.mode,
    "fixed_servers",
  );
  record("Failed real proxy transaction keeps fixed proxy without direct fallback");
  await screenshot(popup, "popup-connected.png");
  await message(popup, {
    type: "update_security_preferences",
    killSwitchEnabled: true,
    webRtcProtectionEnabled: false,
  });
  assert.notEqual(
    (await worker.evaluate(() => chrome.privacy.network.webRTCIPHandlingPolicy.get({})))
      .levelOfControl,
    "controlled_by_this_extension",
  );
  await message(popup, {
    type: "update_security_preferences",
    killSwitchEnabled: true,
    webRtcProtectionEnabled: true,
  });
  record("Built application applies independent WebRTC preference while connected");
  apiMode = "unavailable";
  await context.close();
  context = undefined;
  worker = await launch(extensionPath, "application-profile");
  await installSyntheticApi();
  popup = await popupFor(worker);
  const restored = await message(popup, { type: "get_snapshot" });
  assert.equal(restored.protectionRequested, true);
  assert.equal(restored.protected, false);
  assert.equal(restored.trafficBlocked, true, JSON.stringify(restored));
  assert.deepEqual(await worker.evaluate(() => chrome.declarativeNetRequest.getSessionRules()), []);
  await blockedNavigation("https://public.invalid/application-restart");
  assert(!(await popup.locator("#statusCard").isVisible()));
  assert(!(await popup.locator("#protectButton").isVisible()));
  assert(await popup.locator("#retryButton").isVisible());
  await screenshot(popup, "popup-blocked.png");
  record("Built application stays blocked after browser restart with unavailable API", {
    state: restored.status,
    error: restored.error,
    retryScheduled: restored.nextRetryAt !== null,
  });
  assert.equal(restored.languagePreference, "el");
  await verifyLanguages(popup, worker, "blocked");
  apiMode = "healthy";
  assert(await popup.locator("#retryButton").isEnabled());
  await popup.locator("#retryButton").click();
  const retried = (await popup.evaluate(() => globalThis.auditMutationResult)).snapshot;
  assert.equal(retried.protected, true, JSON.stringify(retried));
  assert.equal(retried.trafficBlocked, false);
  record("Explicit retry restores connection only after verified configuration");
  apiMode = "unauthorized";
  const expired = await message(popup, { type: "refresh_account" }, "unauthorized");
  assert.equal(expired.profile, null, JSON.stringify(expired));
  assert.equal(expired.protectionRequested, true);
  assert.equal(expired.trafficBlocked, true);
  await screenshot(popup, "popup-account-expired.png");
  record("Account expiration removes account data while preserving verified traffic block");
  assert(await popup.locator("#retryButton").isEnabled());
  await popup.locator("#retryButton").click();
  await popup.waitForFunction(() => document.activeElement?.id === "loginButton");
  record("Logged-out retry remains accessible and focuses account reconnection");
  await popup.locator("#settingsButton").click();
  assert(await popup.locator("#settingsPanel").isVisible());
  await screenshot(popup, "popup-blocked-settings.png");
  await popup.locator("#killSwitchEnabled").uncheck();
  const updateResponse = await popup.evaluate(() => globalThis.auditMutationResult);
  const disabled = await message(popup, { type: "get_snapshot" });
  assert.equal(disabled.webRtcProtected, true);
  assert.equal(
    disabled.securityPreferences.killSwitchEnabled,
    false,
    JSON.stringify({
      disabled,
      updateResponse,
      sent: await popup.evaluate(() => globalThis.auditMessages),
    }),
  );
  await popup.locator("#killSwitchEnabled").check();
  const rearmed = await popup.evaluate(() => globalThis.auditMutationResult);
  assert.equal(rearmed.snapshot.trafficBlocked, true);
  await popup.keyboard.press("Escape");
  assert(!(await popup.locator("#settingsPanel").isVisible()));
  record("Blocked logged-out popup settings independently release and restore kill switch");
  await popup.locator("#recoveryDisconnectButton").click();
  await popup.evaluate(() => globalThis.auditMutationResult);
  const released = await message(popup, { type: "get_snapshot" });
  assert.equal(released.protectionRequested, false);
  assert.equal(released.trafficBlocked, false);
  assert.equal(released.webRtcProtected, false);
  assert.deepEqual(await worker.evaluate(() => chrome.declarativeNetRequest.getDynamicRules()), []);
  const releasedPage = await context.newPage();
  const releasedPath = `/application-release-${++nextRequest}`;
  await releasedPage.goto(`${localOrigin}${releasedPath}`);
  assert(receivedPaths.includes(releasedPath));
  record("Voluntary disconnect without account releases block, proxy and WebRTC");
  await message(popup, {
    type: "update_security_preferences",
    killSwitchEnabled: true,
    webRtcProtectionEnabled: false,
  });
  apiMode = "healthy";
  await message(popup, { type: "web_login", disconnectFirst: false });
  const loggedOut = await message(popup, { type: "logout" });
  assert.deepEqual(loggedOut.securityPreferences, {
    killSwitchEnabled: true,
    webRtcProtectionEnabled: false,
  });
  assert.equal(loggedOut.languagePreference, "el");
  await popup.locator("#settingsButton").click();
  await worker.evaluate(() => {
    const original = chrome.storage.local.set.bind(chrome.storage.local);
    globalThis.restoreLanguageStorage = () => {
      chrome.storage.local.set = original;
    };
    chrome.storage.local.set = (items) =>
      "fuzevpnLanguage" in items
        ? Promise.reject(new Error("synthetic storage failure"))
        : original(items);
  });
  await popup.locator("#languageSelect").selectOption("fr");
  await popup.locator("#languageError").waitFor({ state: "visible" });
  assert.equal((await message(popup, { type: "get_snapshot" })).languagePreference, "el");
  await worker.evaluate(() => globalThis.restoreLanguageStorage());
  await popup.evaluate(() => {
    const select = document.querySelector("#languageSelect");
    for (const value of ["fr", "de", "es"]) {
      select.value = value;
      select.dispatchEvent(new Event("change"));
    }
  });
  await popup.waitForFunction(() => document.documentElement.lang === "es");
  await popup.locator("#languageSelect").selectOption("auto");
  await popup.waitForFunction(() => document.documentElement.lang !== "es");
  assert.equal((await message(popup, { type: "get_snapshot" })).languagePreference, "auto");
  record(
    "Language survives restart/logout, keeps web authentication usable, handles failed saves and rapid changes, and returns to automatic",
  );
  record("Preferences survive logout independently of account data");
  report.syntheticApiRequests = apiRequests.length;
  report.screenshots = [
    "popup-connected.png",
    "popup-blocked.png",
    "popup-account-expired.png",
    "popup-blocked-settings.png",
  ];
  await context.close();
  context = undefined;
}

try {
  await verifySafetyModule();
  if (!process.argv.includes("--modules-only")) await verifyBuiltApplication();
  report.passed = true;
} catch (error) {
  report.passed = false;
  report.failure = String(error.stack ?? error);
  process.exitCode = 1;
} finally {
  if (context) await context.close();
  await new Promise((done) => server.close(done));
  await writeFile(join(testRoot, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`Report: ${join(testRoot, "report.json")}\n`);
  if (report.failure) process.stderr.write(`${report.failure}\n`);
}
