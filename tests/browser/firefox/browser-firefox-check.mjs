// SPDX-License-Identifier: MPL-2.0

// Real Firefox integration: the unchanged dist is loaded into a fresh temporary profile.
// The API certificate and forced DNS mapping exist only in that profile. No production login.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer as httpServer } from "node:http";
import { createServer as httpsServer } from "node:https";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { connect as connectTcp } from "node:net";
import { Builder, By, Key } from "selenium-webdriver";
import sharp from "sharp";
import firefox from "selenium-webdriver/firefox.js";
import { download } from "geckodriver";
import { firefoxDesignReview } from "./browser-firefox-design-review.mjs";
import { firefoxConsentCheck } from "./browser-firefox-consent-check.mjs";
import {
  firefoxWebAuthFixture,
  firefoxWebAuthLogin,
  firefoxWebAuthCheck,
} from "./browser-firefox-web-auth-check.mjs";
import { SUPPORTED_LANGUAGES, localeDirectory } from "../../../scripts/supported-locales.mjs";
import {
  assertInsideProject,
  fileHashes,
  projectRoot,
  runDirectory,
  sha256,
  writeJson,
} from "../../../scripts/validation-common.mjs";

const output = runDirectory("firefox", "runtime");
const cache = join(projectRoot, "node_modules/.cache/firefox-validation");
await mkdir(cache, { recursive: true });
const profile = join(output, "profile");
await mkdir(profile);
const executable = process.env.FIREFOX_EXECUTABLE || "C:/Program Files/Mozilla Firefox/firefox.exe";
const extensionId = "fuzevpn-firefox@vpn1euro.com";
const uuid = "6fba7d51-b5ea-46e2-b92b-cdb7e5dca602";
const extensionOrigin = `moz-extension://${uuid}`;
const dist = join(projectRoot, "dist/firefox");
const before = fileHashes(dist);
const report = {
  startedAt: new Date().toISOString(),
  mode:
    process.env.FIREFOX_WEB_AUTH_ONLY === "1"
      ? "web-auth-only"
      : process.env.FIREFOX_CONSENT_ONLY === "1"
        ? "consent-only"
        : process.env.FIREFOX_LEGAL_ONLY === "1"
          ? "legal-only"
          : process.env.FIREFOX_DESIGN_ONLY === "1"
            ? "design-only"
            : "full",
  scope:
    "Unchanged packaged Firefox extension, synthetic HTTPS API and authenticated TLS proxy on loopback, isolated Firefox profile",
  distSha256: sha256(JSON.stringify(before)),
  workerSha256: before["background/service-worker.js"],
  checks: [],
  limitations: [
    "Legal destinations are synthetic local HTTPS fixtures; public policy content and availability are not checked.",
    "No production account, VPN service, public IPv6, STUN/TURN server or minimum Firefox 140 runtime tested.",
    "DNS confinement is enforced through this test profile's forceResolve preference; OS-wide DNS or packet capture is not collected.",
    "Screenshots load the actual popup page in a browser tab at popup width; toolbar anchoring is not covered.",
  ],
};
const received = {
  api: [],
  proxy: [],
  direct: [],
  deviceEnrollments: [],
  sessionAttempts: [],
  diagnostics: [],
};
let diagnosticResponseMode = "success";
const legalFixtureRequests = [];
const fixtureDevices = new Map([
  [
    "remote-device",
    {
      device_id: "remote-device",
      name: "Ordinateur de test",
      kind: "browser_extension",
      created_at: new Date().toISOString(),
      profiles: [],
    },
  ],
  [
    "retry-device",
    {
      device_id: "retry-device",
      name: "Appareil à réessayer",
      kind: "browser_extension",
      created_at: new Date().toISOString(),
      profiles: [],
    },
  ],
]);
const deviceDeletionModes = new Map();
const apiDelays = new Map();
let locationsReplyMode = "normal";
const unavailableLocations = new Map();
const proxyRejections = [];
let enrollmentLimit = false;
let recoveryDeviceSequence = null;
const normalLocations = [
  {
    id: "local-audit",
    city: "Paris",
    country_code: "FR",
    display_name: "France — Paris",
    supported_protocols: ["browser_proxy"],
  },
];
const groupedLocations = [
  { id: "paris-10", city: "Paris", country_code: "FR", display_name: "Paris 10" },
  { id: "frankfurt-2", city: "Frankfurt", country_code: "DE", display_name: "Frankfurt 2" },
  { id: "lyon-1", city: "Lyon", country_code: "FR", display_name: "Lyon 1" },
  { id: "berlin-1", city: "Berlin", country_code: "DE", display_name: "Berlin 1" },
  { id: "paris-2", city: "Paris", country_code: "FR", display_name: "Paris 2" },
  { id: "frankfurt-1", city: "Frankfurt", country_code: "DE", display_name: "Frankfurt 1" },
].map((location) => ({ ...location, supported_protocols: ["browser_proxy"] }));
let heldDeviceDeletion;
let failNextDeviceList = false;
const sockets = new Set();
let directConnections = 0;
let driver;
let api;
let proxy;
let target;
let tlsTarget;
let proxyAvailable = true;
let vpnIpUnavailable = false;
let vpnIpRequests = 0;
let sessions = 0;
let pendingChallenge;
let proxyPort;
const webAuthFixture = firefoxWebAuthFixture();
const designReview = firefoxDesignReview({
  getDriver: () => driver,
  output,
  report,
  record,
  openPopup,
  send,
  snapshot,
  click,
  waitFor,
  extensionOrigin,
  setLocationsMode: (mode) => {
    locationsReplyMode = mode;
  },
  rejectNextSession: (rejection) => {
    proxyRejections.push(rejection);
  },
});
function record(name, details) {
  report.checks.push({ name, passed: true, ...(details === undefined ? {} : { details }) });
  process.stdout.write(`PASS ${name}\n`);
}
function track(server) {
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  return server;
}
function listen(server, port = 0) {
  return new Promise((done, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => done(server.address().port));
  });
}
async function waitFor(read, predicate, label, timeout = 15000) {
  const start = Date.now();
  let value;
  while (Date.now() - start < timeout) {
    value = await read();
    if (predicate(value)) return value;
    await new Promise((done) => setTimeout(done, 100));
  }
  throw new Error(`${label}: ${JSON.stringify(value)}`);
}
function apiReply(path, method, payload = {}) {
  const expires = new Date(Date.now() + 3600000).toISOString();
  if (path === "/v1/diagnostics" && method === "POST")
    return [
      201,
      {
        report_id: randomUUID(),
        client_report_id: payload.report_id,
        received_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 86400000).toISOString(),
        status: "received",
        duplicate: false,
      },
    ];
  if (path === "/v1/me")
    return [
      200,
      {
        user_id: "firefox-audit",
        email: "audit@example.invalid",
        first_name: "Audit",
        last_name: "Firefox",
        country_code: "FR",
      },
    ];
  if (path === "/v1/billing/subscription")
    return [
      200,
      {
        status: "active",
        has_access: true,
        offer_id: "audit",
        started_at: new Date(Date.now() - 60000).toISOString(),
        expires_at: expires,
        renews_automatically: false,
      },
    ];
  if (path === "/v1/locations" && locationsReplyMode === "failure")
    return [503, { error: "network_error" }];
  if (path === "/v1/locations" && locationsReplyMode === "empty") return [200, { locations: [] }];
  if (path === "/v1/locations")
    return [
      200,
      {
        locations: [
          ...normalLocations,
          ...(locationsReplyMode === "grouped" ? groupedLocations : []),
        ].filter((location) => !unavailableLocations.has(location.id)),
      },
    ];
  if (path === "/v1/devices/browser") {
    received.deviceEnrollments.push({
      name: payload.name,
      publicKeySha256: sha256(payload.public_key),
    });
    if (enrollmentLimit) return [409, { error: "device_limit" }];
    const device = {
      device_id:
        recoveryDeviceSequence === null
          ? "firefox-device"
          : `firefox-recovered-${++recoveryDeviceSequence}`,
      name: payload.name,
      kind: "browser_extension",
      created_at: new Date().toISOString(),
      profiles: [],
    };
    fixtureDevices.set(device.device_id, device);
    return [201, device];
  }
  if (path === "/v1/devices") {
    if (failNextDeviceList) {
      failNextDeviceList = false;
      return [503, { error: "network_error" }];
    }
    return [200, { limit: 5, devices: [...fixtureDevices.values()] }];
  }
  if (method === "DELETE" && path.startsWith("/v1/devices/")) {
    const deviceId = decodeURIComponent(path.slice("/v1/devices/".length));
    if (deviceDeletionModes.get(deviceId) === "fail") return [503, { error: "network_error" }];
    fixtureDevices.delete(deviceId);
    if (deviceId === "quota-slot") enrollmentLimit = false;
    return [204, null];
  }
  if (path === "/v1/proxy/sessions" && method === "POST") {
    received.sessionAttempts.push({ locationId: payload.location_id, deviceId: payload.device_id });
    const rejection = proxyRejections.shift();
    if (rejection) {
      if (["server_full", "capacity_unavailable"].includes(rejection.code))
        unavailableLocations.set(payload.location_id, rejection.code);
      return [rejection.status, { error: rejection.code }];
    }
    return [
      201,
      {
        id: `firefox-session-${++sessions}`,
        location_id: payload.location_id,
        scheme: "https",
        host: "127.0.0.1",
        port: proxyPort,
        username: "synthetic-user",
        password: "synthetic-password",
        issued_at: new Date().toISOString(),
        expires_at: expires,
        refresh_after_seconds: 900,
      },
    ];
  }
  if (method === "DELETE" || path === "/v1/auth/logout") return [204, null];
  return [404, { error: "not_found" }];
}
async function certificate() {
  const python =
    process.env.PYTHON_EXECUTABLE ||
    join(homedir(), ".cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe");
  const generated = spawnSync(
    python,
    [
      "-c",
      `from cryptography import x509
from cryptography.x509.oid import NameOID
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from datetime import datetime, timedelta, timezone
from pathlib import Path
import ipaddress, sys
k = rsa.generate_private_key(public_exponent=65537, key_size=2048)
n = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "FuzeVPN isolated Firefox validation")])
t = datetime.now(timezone.utc)
ca = (x509.CertificateBuilder().subject_name(n).issuer_name(n).public_key(k.public_key()).serial_number(x509.random_serial_number()).not_valid_before(t-timedelta(minutes=5)).not_valid_after(t+timedelta(days=1)).add_extension(x509.BasicConstraints(ca=True,path_length=None),critical=True).sign(k,hashes.SHA256()))
leafname = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "api.fuzevpn.com")])
c = (x509.CertificateBuilder().subject_name(leafname).issuer_name(n).public_key(k.public_key()).serial_number(x509.random_serial_number()).not_valid_before(t-timedelta(minutes=5)).not_valid_after(t+timedelta(days=1)).add_extension(x509.BasicConstraints(ca=False,path_length=None),critical=True).add_extension(x509.SubjectAlternativeName([x509.DNSName("api.fuzevpn.com"),x509.DNSName("app.fuzevpn.com"),x509.DNSName("fuzevpn.com"),x509.DNSName("api.ipify.org"),x509.DNSName("api64.ipify.org"),x509.DNSName("*.example.com"),x509.DNSName("example.com"),x509.IPAddress(ipaddress.ip_address("127.0.0.1"))]),critical=False).sign(k,hashes.SHA256()))
Path(sys.argv[1], "key.pem").write_bytes(k.private_bytes(serialization.Encoding.PEM,serialization.PrivateFormat.PKCS8,serialization.NoEncryption()))
Path(sys.argv[1], "cert.pem").write_bytes(c.public_bytes(serialization.Encoding.PEM))
Path(sys.argv[1], "ca.pem").write_bytes(ca.public_bytes(serialization.Encoding.PEM))
`,
      output,
    ],
    { encoding: "utf8", windowsHide: true },
  );
  assert.equal(generated.status, 0, generated.stderr);
  return {
    key: await readFile(join(output, "key.pem")),
    cert: await readFile(join(output, "cert.pem")),
  };
}
async function privileged(script, ...args) {
  await driver.setContext(firefox.Context.CHROME);
  try {
    return await driver.executeAsyncScript(script, ...args);
  } finally {
    await driver.setContext(firefox.Context.CONTENT);
  }
}
async function extension(script, ...args) {
  return driver.executeAsyncScript(script, ...args);
}
async function send(message) {
  return extension(
    "const done = arguments[arguments.length - 1]; browser.runtime.sendMessage(arguments[0]).then(done, e => done({runtimeError:String(e)}));",
    message,
  );
}
async function openPopup() {
  await driver.get(`${extensionOrigin}/popup/popup.html`);
  await waitFor(
    () => send({ type: "get_snapshot" }),
    (value) => value?.snapshot,
    "Extension background ready",
  );
}
async function snapshot() {
  return (await send({ type: "get_snapshot" })).snapshot;
}
async function terminateBackground() {
  await driver.get("about:blank");
  const result = await privileged(
    `const done=arguments[arguments.length-1]; (async()=>{const {ExtensionParent}=ChromeUtils.importESModule("resource://gre/modules/ExtensionParent.sys.mjs"); const e=ExtensionParent.GlobalManager.getExtension(arguments[0]); await e.terminateBackground({disableResetIdleForTest:true}); done(true);})().catch(e=>done({error:String(e)}));`,
    extensionId,
  );
  assert.equal(result, true);
}
async function verifyDelayedAccountRestoration(protectedUrl) {
  await openPopup();
  assert.equal((await send({ type: "set_language_preference", preference: "fr" })).ok, true);
  for (const path of ["/v1/locations", "/v1/me", "/v1/billing/subscription"]) {
    const previous = await snapshot();
    assert.equal(previous.status, "connected");
    assert.equal(previous.protected, true);
    assert(previous.locations.some((location) => location.id === "local-audit"));
    const marker = `/delayed-restoration-${path.split("/").at(-1)}`;
    const popupHandle = await driver.getWindowHandle();
    await driver.switchTo().newWindow("tab");
    // Give the probe a committed document before background termination. Firefox
    // can discard navigation from a new tab's initial about:blank document.
    await driver.get(`data:text/html,${encodeURIComponent("<title>Restoration probe</title>")}`);
    assert.equal(await driver.getTitle(), "Restoration probe");
    const requestHandle = await driver.getWindowHandle();
    await privileged(`const done=arguments[arguments.length-1];
      const win=Services.wm.getMostRecentWindow("navigator:browser");
      win.fuzevpnRestorationProbe=win.gBrowser.selectedBrowser; done(true);`);
    await driver.switchTo().window(popupHandle);
    const apiStart = received.api.length;
    apiDelays.set(path, 4000);
    await terminateBackground();
    const started = Date.now();
    // Unlike openPopup(), this deliberately does not await the background response.
    await driver.get(`${extensionOrigin}/popup/popup.html`);
    // Start a browser navigation, as the URL bar does. A content location assignment
    // from the data document can be discarded during the process/background switch.
    // Keep WebDriver on the popup so it does not wait for the delayed probe to commit.
    await privileged(
      `const done=arguments[arguments.length-1];
        const tab=Services.wm.getMostRecentWindow("navigator:browser").fuzevpnRestorationProbe;
        tab.loadURI(Services.io.newURI(arguments[0]), {
          triggeringPrincipal:Services.scriptSecurityManager.getSystemPrincipal()
        }); done(true);`,
      `${protectedUrl}${marker}`,
    );
    // During restoration the guard may cancel before a new document commits.
    // Both cancellation and proxying are safe; neither permits a direct request.
    const samples = [];
    let finalSnapshot;
    while (Date.now() - started < 9000) {
      const ui =
        await driver.executeScript(`const visible=id=>{const e=document.getElementById(id);return Boolean(e && e.getClientRects().length && getComputedStyle(e).visibility!=='hidden')};return {
        location:document.querySelector('#locationName')?.textContent,
        locationVisible:visible('locationCard'),mainVisible:visible('mainView'),
        status:document.querySelector('#statusLabel')?.textContent,
        recovery:visible('recoveryPanel')?document.querySelector('#recoveryStatus')?.textContent:null,
        changeDisabled:document.querySelector('#changeLocationButton')?.disabled,
        protectDisabled:document.querySelector('#protectButton')?.disabled,
        protectText:document.querySelector('#protectButton')?.textContent,
        locations:[...document.querySelectorAll('#locationList > .location-country-group > .location-group-row .option-title, #locationList > .location-row .option-title')].map(e=>e.textContent),
        error:visible('errorBanner')?document.querySelector('#errorBanner')?.textContent:null
      }`);
      samples.push({ ms: Date.now() - started, ...ui });
      if (
        ui.location?.includes("Paris") &&
        ui.protectText === "Déconnecter" &&
        ui.locations.length > 0 &&
        Date.now() - started > 4500
      ) {
        finalSnapshot = await snapshot();
        if (
          finalSnapshot.status === "connected" &&
          finalSnapshot.snapshotVersion.workerId !== previous.snapshotVersion.workerId &&
          received.api.slice(apiStart).some((request) => request.path === path)
        )
          break;
      }
      await new Promise((done) => setTimeout(done, 100));
    }
    apiDelays.delete(path);
    finalSnapshot ??= await snapshot();
    assert.equal(finalSnapshot.status, "connected");
    assert.equal(finalSnapshot.protected, true);
    assert.notEqual(finalSnapshot.snapshotVersion.workerId, previous.snapshotVersion.workerId);
    const misleading = samples.filter(
      (sample) =>
        sample.mainVisible && sample.locationVisible && /aucun emplacement/i.test(sample.location),
    );
    const details = {
      delayedEndpoint: path,
      delayMs: 4000,
      elapsedMs: Date.now() - started,
      falseEmptySamples: misleading.length,
      falseEmptyDurationMs: misleading.length > 1 ? misleading.at(-1).ms - misleading[0].ms : 0,
      firstNamedLocationMs:
        samples.find((sample) => sample.locationVisible && sample.location?.includes("Paris"))
          ?.ms ?? null,
      firstCatalogMs:
        samples.find(
          (sample) =>
            sample.locations.includes("France") || sample.locations.includes("France — Paris"),
        )?.ms ?? null,
      samples,
      apiRequests: received.api.slice(apiStart),
      protected: finalSnapshot.protected,
      requestTargetUrl: `${protectedUrl}${marker}`,
    };
    report.locationRestoration ??= [];
    report.locationRestoration.push(details);
    await driver.switchTo().window(requestHandle);
    assert(!received.direct.includes(marker), "Startup probe must not reach its target directly");
    details.requestUrlBeforeRecovery = await driver.getCurrentUrl();
    // Reissue after verified restoration if the conservative startup guard cancelled it.
    await driver.get(`${protectedUrl}${marker}`);
    details.requestUrl = await driver.getCurrentUrl();
    details.requestTitle = await driver.getTitle();
    assert.equal(details.requestTitle, "Proxied fixture");
    await driver.close();
    await driver.switchTo().window(popupHandle);
    await privileged(`const done=arguments[arguments.length-1];
      delete Services.wm.getMostRecentWindow("navigator:browser").fuzevpnRestorationProbe; done(true);`);
    assert(
      !received.direct.includes(marker),
      "Restoration must not send protected traffic directly",
    );
    assert(received.proxy.some((entry) => entry.path === marker && entry.authenticated));
    if (process.env.FIREFOX_LOCATION_AUDIT === "baseline") {
      record(`Baseline location restoration with delayed ${path}`, details);
    } else {
      assert.equal(misleading.length, 0, `False empty location while restoring after ${path}`);
      assert(
        details.firstNamedLocationMs !== null && details.firstNamedLocationMs < 3000,
        "Verified active location must appear before the delayed API returns",
      );
      if (path !== "/v1/locations")
        assert(
          details.firstCatalogMs !== null && details.firstCatalogMs < 3000,
          "Location catalog must not await a slower account endpoint",
        );
      record(`Cached location survives event-page restoration with delayed ${path}`, details);
    }
  }
}
async function verifyDisconnectedRestoration(protectedUrl) {
  await openPopup();
  assert.equal((await send({ type: "disconnect" })).ok, true);
  const previous = await snapshot();
  const missingSavedSelection = !process.env.FIREFOX_LOCATION_AUDIT?.startsWith("baseline");
  if (missingSavedSelection) {
    const stored = await extension(`const done=arguments[arguments.length-1];
      (async()=>{const keys=['fuzevpnState','fuzevpnSecurityState'];const records=await browser.storage.local.get(keys);
      for(const key of keys){if(!records[key])throw new Error('Missing synthetic account record');records[key].selectedLocationId='removed-synthetic-location';}
      await browser.storage.local.set(records);done(true)})().catch(error=>done(String(error)));`);
    assert.equal(stored, true);
  }
  const popupHandle = await driver.getWindowHandle();
  await driver.switchTo().newWindow("tab");
  const requestHandle = await driver.getWindowHandle();
  await driver.switchTo().window(popupHandle);
  apiDelays.set("/v1/me", 12000);
  const marker = "/disconnected-restoration";
  const directStart = received.direct.length;
  const apiStart = received.api.length;
  await terminateBackground();
  const started = Date.now();
  await driver.get(`${extensionOrigin}/popup/popup.html`);
  await driver.switchTo().window(requestHandle);
  await driver.executeScript(
    `const url=arguments[0]; setTimeout(()=>{location.href=url},50);`,
    `${protectedUrl}${marker}`,
  );
  await driver.switchTo().window(popupHandle);
  const samples = [];
  let directAfterMs = null;
  let catalogBeforeProfile;
  while (Date.now() - started < 13500) {
    const sample = await driver.executeScript(
      `const visible=id=>{const e=document.getElementById(id);return Boolean(e && e.getClientRects().length)};return {mainVisible:visible('mainView'),locationVisible:visible('locationCard'),location:document.querySelector('#locationName')?.textContent,status:document.querySelector('#statusLabel')?.textContent,error:visible('errorBanner')?document.querySelector('#errorBanner')?.textContent:null,changeDisabled:document.querySelector('#changeLocationButton')?.disabled,protectDisabled:document.querySelector('#protectButton')?.disabled}`,
    );
    samples.push({ ms: Date.now() - started, ...sample });
    if (directAfterMs === null && received.direct.slice(directStart).includes(marker))
      directAfterMs = Date.now() - started;
    if (missingSavedSelection && !catalogBeforeProfile && Date.now() - started >= 2000) {
      const early = await snapshot();
      catalogBeforeProfile = {
        observedAtMs: Date.now() - started,
        locationsStatus: early.locationsStatus,
        locationIds: early.locations.map((location) => location.id),
        selectedLocationId: early.selectedLocationId,
      };
    }
    await new Promise((done) => setTimeout(done, 100));
  }
  apiDelays.delete("/v1/me");
  const restored = await snapshot();
  const details = {
    delayMs: 12000,
    delayedEndpoint: "/v1/me",
    directAfterMs,
    elapsedMs: Date.now() - started,
    samples,
    apiRequests: received.api.slice(apiStart),
    protected: restored.protected,
    missingSavedSelection,
    catalogBeforeProfile,
  };
  report.disconnectedRestoration = details;
  await driver.switchTo().window(requestHandle);
  details.requestTitle = await driver.getTitle();
  await driver.close();
  await driver.switchTo().window(popupHandle);
  assert.equal(restored.status, "disconnected");
  assert.equal(restored.protected, false);
  assert.notEqual(restored.snapshotVersion.workerId, previous.snapshotVersion.workerId);
  if (process.env.FIREFOX_LOCATION_AUDIT?.startsWith("baseline"))
    record("Baseline disconnected restoration with delayed profile", details);
  else {
    assert(
      directAfterMs !== null && directAfterMs < 3000,
      "Disconnected browsing must not await account refresh or hit route-guard timeout",
    );
    assert.equal(details.requestTitle, "Direct fixture");
    record("Disconnected wake preserves ordinary browsing during slow account refresh", details);
    assert(
      catalogBeforeProfile.observedAtMs < 3000,
      "Available catalog must be selectable before delayed profile returns",
    );
    assert.equal(catalogBeforeProfile.locationsStatus, "ready");
    assert.deepEqual(catalogBeforeProfile.locationIds, ["local-audit"]);
    assert.equal(catalogBeforeProfile.selectedLocationId, "local-audit");
    assert(
      !samples.some(
        (sample) =>
          sample.mainVisible &&
          sample.locationVisible &&
          /aucun emplacement/i.test(sample.location),
      ),
      "Removed saved location must not hide available catalog",
    );
    assert(
      samples.some(
        (sample) =>
          sample.ms < 3000 &&
          sample.location?.includes("Paris") &&
          !sample.changeDisabled &&
          !sample.protectDisabled,
      ),
      "Fresh catalog restores usable local selection before profile completes",
    );
    record(
      "Removed saved selection is replaced by a usable catalog location before slow profile refresh",
      catalogBeforeProfile,
    );
  }
  const connected = await send({ type: "connect", locationId: "local-audit" });
  assert.equal(connected.ok, true, JSON.stringify(connected));
}
async function locationsUi() {
  return driver.executeScript(`const visible=id=>{const e=document.getElementById(id);return Boolean(e && e.getClientRects().length)};return {
    open:document.querySelector('#locationDialog').open,
    loadVisible:visible('locationLoadStatus'),loadMessage:document.querySelector('#locationLoadStatus').textContent,
    emptyVisible:visible('locationEmpty'),emptyMessage:document.querySelector('#locationEmpty').textContent,
    retryDisabled:document.querySelector('#refreshLocationsButton').disabled,
    location:document.querySelector('#locationName').textContent,
    locations:[...document.querySelectorAll('#locationList > .location-country-group > .location-group-row .option-title, #locationList > .location-row .option-title')].map(e=>e.textContent)
  }`);
}
async function verifyLocationRefreshUi(protectedUrl) {
  await openPopup();
  await click("#changeLocationButton");
  await waitFor(
    locationsUi,
    (value) => value.open && value.locations.length === 1 && !value.retryDisabled,
    "Loaded location dialog",
  );
  locationsReplyMode = "failure";
  apiDelays.set("/v1/locations", 500);
  await click("#refreshLocationsButton");
  await waitFor(
    locationsUi,
    (value) => value.loadVisible && value.retryDisabled,
    "Location refresh has visible loading state",
  );
  await waitFor(
    snapshot,
    (value) => value.locationsStatus === "error",
    "Location API failure is separate from VPN status",
  );
  const failed = await waitFor(
    locationsUi,
    (value) => value.loadVisible && !value.retryDisabled,
    "Location retry becomes available",
  );
  assert.equal(failed.emptyVisible, false);
  assert.deepEqual(failed.locations, ["France"]);
  assert(failed.location.includes("Paris"));
  let state = await snapshot();
  assert.equal(state.protected, true);
  assert.equal(state.status, "connected");
  assert.equal(state.error, null);
  assert.equal(state.locationsError, "proxy_unavailable");
  await writeFile(
    join(output, "locations-retry-fr.png"),
    Buffer.from(await driver.takeFullPageScreenshot(), "base64"),
  );
  record("Failed location refresh retains catalog and VPN, offers usable retry", failed);

  locationsReplyMode = "empty";
  await click("#refreshLocationsButton");
  await waitFor(
    snapshot,
    (value) => value.locationsStatus === "ready" && value.locations.length === 0,
    "Genuinely empty catalog accepted",
  );
  const empty = await waitFor(
    locationsUi,
    (value) => value.emptyVisible && !value.retryDisabled,
    "Empty catalog message shown after successful response",
  );
  assert.equal(empty.loadVisible, false);
  assert.equal(empty.locations.length, 0);
  assert(empty.location.includes("Paris"));
  state = await snapshot();
  assert.equal(state.protected, true);
  assert.equal(state.error, null);
  assert.equal(state.locationsError, null);
  record(
    "Genuinely empty catalog displays empty state while active endpoint remains identified",
    empty,
  );

  locationsReplyMode = "normal";
  apiDelays.delete("/v1/locations");
  await click("#refreshLocationsButton");
  await waitFor(
    snapshot,
    (value) => value.locationsStatus === "ready" && value.locations.length === 1,
    "Location retry recovers catalog",
  );
  const retried = await waitFor(
    locationsUi,
    (value) => !value.loadVisible && !value.emptyVisible && value.locations.length === 1,
    "Recovered catalog rendered",
  );
  assert.equal(retried.retryDisabled, false);
  await click("#closeLocationButton");
  assert.equal((await navigate(`${protectedUrl}/after-location-retry`)).title, "Proxied fixture");
  assert(!received.direct.includes("/after-location-retry"));
  assert.equal((await snapshot()).protected, true);
  record(
    "Location retry restores entries and authenticated web navigation remains protected",
    retried,
  );
}
async function click(selector) {
  const element = await waitFor(
    async () => {
      const candidates = await driver.findElements(By.css(selector));
      const candidate = candidates[0];
      return candidate && (await candidate.isDisplayed()) && (await candidate.isEnabled())
        ? candidate
        : null;
    },
    Boolean,
    `Clickable ${selector}`,
  );
  await element.click();
}
async function deviceUi() {
  return driver.executeScript(`return {
    devicesOpen:document.querySelector('#devicesDialog').open,
    settingsOpen:document.querySelector('#settingsPanel').open,
    confirmationOpen:document.querySelector('#confirmationDialog').open,
    confirmationMessage:document.querySelector('#confirmationMessage').textContent,
    errorVisible:!document.querySelector('#devicesError').classList.contains('hidden'),
    refreshDisabled:document.querySelector('#refreshDevicesButton').disabled,
    rows:[...document.querySelectorAll('#deviceList .device-item')].map(row=>({
      id:row.querySelector('button').dataset.focusKey,
      name:row.querySelector('.device-name').textContent,
      disabled:row.querySelector('button').disabled,
      busy:row.querySelector('button').getAttribute('aria-busy')
    }))
  }`);
}
const deleteSelector = (id) => `#deviceList .delete-device-button[data-focus-key="${id}"]`;
const deletionCount = (id) =>
  received.api.filter(
    (request) => request.method === "DELETE" && request.path === `/v1/devices/${id}`,
  ).length;
async function openDeviceList() {
  await click("#settingsButton");
  await click("#manageDevicesButton");
  return waitFor(
    deviceUi,
    (value) => value.devicesOpen && !value.refreshDisabled && value.rows.length > 0,
    "Device list rendered",
  );
}
async function returnFromDevices() {
  await click("#closeDevicesButton");
  await waitFor(
    deviceUi,
    (value) => value.settingsOpen && !value.devicesOpen,
    "Settings usable after device action",
  );
  await click("#closeSettingsButton");
  await waitFor(
    deviceUi,
    (value) => !value.settingsOpen && !value.devicesOpen,
    "Popup usable after device action",
  );
}
async function verifyDeviceDeletionUi(protectedUrl) {
  await openPopup();
  assert.equal((await send({ type: "set_language_preference", preference: "fr" })).ok, true);
  let ui = await openDeviceList();
  assert(received.deviceEnrollments.some((entry) => entry.name === "Firefox"));
  assert(ui.rows.find((row) => row.id === "firefox-device")?.name.includes("Navigateur Firefox"));
  assert.equal(ui.rows.find((row) => row.id === "remote-device")?.name, "Ordinateur de test");
  record(
    "Actual device list names the current enrollment Navigateur Firefox and preserves custom names",
  );

  const originalDeletes = deletionCount("remote-device");
  await click(deleteSelector("remote-device"));
  await waitFor(
    deviceUi,
    (value) => value.confirmationOpen,
    "Nonblocking deletion confirmation opens",
  );
  assert.equal(
    await driver.executeScript(
      "return document.querySelector('#confirmationDialog').contains(document.activeElement)",
    ),
    true,
  );
  await driver.executeAsyncScript(
    "const done=arguments[arguments.length-1]; Promise.allSettled(document.getAnimations().filter(a=>a.effect?.getTiming().iterations!==Infinity).map(a=>a.finished)).then(()=>requestAnimationFrame(()=>done(true)));",
  );
  await writeFile(
    join(output, "device-confirmation-fr.png"),
    Buffer.from(await driver.takeFullPageScreenshot(), "base64"),
  );
  await click("#confirmationCancelButton");
  await waitFor(
    deviceUi,
    (value) => !value.confirmationOpen && value.devicesOpen,
    "Cancel returns to device list",
  );
  assert.equal(deletionCount("remote-device"), originalDeletes);
  await click(deleteSelector("remote-device"));
  await waitFor(deviceUi, (value) => value.confirmationOpen, "Confirmation reopens");
  await driver.findElement(By.css("#confirmationCancelButton")).sendKeys(Key.ESCAPE);
  await waitFor(
    deviceUi,
    (value) => !value.confirmationOpen && value.devicesOpen,
    "Escape returns to device list",
  );
  assert.equal(deletionCount("remote-device"), originalDeletes);
  record("Device confirmation Cancel and Escape send no DELETE and leave the popup responsive");

  deviceDeletionModes.set("remote-device", "hold");
  heldDeviceDeletion = null;
  await click(deleteSelector("remote-device"));
  await waitFor(
    deviceUi,
    (value) => value.confirmationOpen,
    "Confirmation opens for remote delete",
  );
  await click("#confirmationAcceptButton");
  await waitFor(() => heldDeviceDeletion, Boolean, "Confirmed device DELETE reaches local API");
  assert.equal(deletionCount("remote-device"), originalDeletes + 1);
  assert.equal(
    await driver.executeAsyncScript(
      "const done=arguments[arguments.length-1]; requestAnimationFrame(()=>done(true));",
    ),
    true,
  );
  ui = await deviceUi();
  assert.equal(ui.rows.find((row) => row.id === "remote-device")?.disabled, true);
  failNextDeviceList = true;
  deviceDeletionModes.delete("remote-device");
  heldDeviceDeletion.reply();
  await waitFor(
    deviceUi,
    (value) =>
      !value.confirmationOpen &&
      !value.rows.some((row) => row.id === "remote-device") &&
      value.errorVisible &&
      !value.refreshDisabled,
    "Confirmed deletion remains removed when follow-up refresh fails",
  );
  assert.equal((await snapshot()).protected, true);
  assert.equal(
    (await navigate(`${protectedUrl}/after-device-list-failure`)).title,
    "Proxied fixture",
  );
  assert(!received.direct.includes("/after-device-list-failure"));
  await returnFromDevices();
  ui = await openDeviceList();
  assert(!ui.rows.some((row) => row.id === "remote-device"));
  assert.equal(deletionCount("remote-device"), originalDeletes + 1);
  record(
    "Remote deletion sends one request, remains removed after list failure and preserves usable UI and VPN",
  );

  deviceDeletionModes.set("retry-device", "fail");
  await click(deleteSelector("retry-device"));
  await waitFor(deviceUi, (value) => value.confirmationOpen, "Failure case confirmation opens");
  await click("#confirmationAcceptButton");
  await waitFor(
    deviceUi,
    (value) =>
      !value.confirmationOpen &&
      value.errorVisible &&
      value.rows.some((row) => row.id === "retry-device" && !row.disabled),
    "Delete API failure restores enabled row",
  );
  assert.equal(deletionCount("retry-device"), 1);
  await returnFromDevices();
  await openDeviceList();
  deviceDeletionModes.delete("retry-device");
  await click(deleteSelector("retry-device"));
  await waitFor(deviceUi, (value) => value.confirmationOpen, "Retry confirmation opens");
  await click("#confirmationAcceptButton");
  await waitFor(
    deviceUi,
    (value) =>
      !value.confirmationOpen &&
      !value.rows.some((row) => row.id === "retry-device") &&
      !value.refreshDisabled,
    "Retry completes without stuck UI",
  );
  assert.equal(deletionCount("retry-device"), 2);
  assert.equal((await snapshot()).protected, true);
  assert.equal((await navigate(`${protectedUrl}/after-device-retry`)).title, "Proxied fixture");
  assert(!received.direct.includes("/after-device-retry"));
  record(
    "Delete API failure leaves the device retryable and a subsequent user confirmation succeeds",
  );

  await click(deleteSelector("firefox-device"));
  await waitFor(deviceUi, (value) => value.confirmationOpen, "Current-device confirmation opens");
  assert((await deviceUi()).confirmationMessage.includes("Navigateur Firefox"));
  await click("#confirmationAcceptButton");
  await waitFor(
    deviceUi,
    (value) =>
      !value.confirmationOpen &&
      !value.rows.some((row) => row.id === "firefox-device") &&
      !value.refreshDisabled,
    "Current-device deletion completes",
  );
  const disconnected = await waitFor(
    snapshot,
    (value) => value.status === "disconnected" && value.currentDeviceId === null,
    "Current-device deletion disconnects and clears identity",
  );
  assert.equal(disconnected.protected, false);
  assert.equal(deletionCount("firefox-device"), 1);
  await returnFromDevices();
  const enrollments = received.deviceEnrollments.length;
  await click("#protectButton");
  await waitFor(
    snapshot,
    (value) => value.status === "connected" && value.currentDeviceId === "firefox-device",
    "User can reconnect after deleting this device",
  );
  assert.equal(received.deviceEnrollments.length, enrollments + 1);
  assert.equal(received.deviceEnrollments.at(-1).name, "Firefox");
  ui = await openDeviceList();
  assert(ui.rows.find((row) => row.id === "firefox-device")?.name.includes("Navigateur Firefox"));
  await writeFile(
    join(output, "devices-after-reconnect-fr.png"),
    Buffer.from(await driver.takeFullPageScreenshot(), "base64"),
  );
  await returnFromDevices();
  record(
    "Deleting the current device releases VPN and permits a fresh Firefox enrollment through the popup",
  );
}
async function captureBackgroundErrors() {
  await driver.executeScript(`window.auditErrors=[];
    if(!window.auditErrorListener){window.auditErrorListener=message=>{if(message.type==='state_changed' && message.snapshot?.error)window.auditErrors.push(message.snapshot.error)};browser.runtime.onMessage.addListener(window.auditErrorListener)}`);
}
async function verifyDeviceRecovery(protectedUrl) {
  await openPopup();
  await send({ type: "set_language_preference", preference: "fr" });
  recoveryDeviceSequence = 0;
  for (const [code, status] of [
    ["not_found", 404],
    ["device_identity_revoked", 403],
  ]) {
    assert.equal((await send({ type: "disconnect" })).ok, true);
    const previousId = (await snapshot()).currentDeviceId;
    if (code === "not_found") fixtureDevices.delete(previousId);
    const previousAttempts = received.sessionAttempts.length;
    const previousEnrollments = received.deviceEnrollments.length;
    proxyRejections.push({ code, status });
    await captureBackgroundErrors();
    const connected = await send({ type: "connect", locationId: "local-audit" });
    assert.equal(connected.ok, true, JSON.stringify(connected));
    assert.equal(connected.snapshot.protected, true);
    assert.equal(connected.snapshot.error, null);
    assert.notEqual(connected.snapshot.currentDeviceId, previousId);
    assert.equal(received.deviceEnrollments.length, previousEnrollments + 1);
    assert.equal(received.sessionAttempts.length, previousAttempts + 2);
    const publishedErrors = await driver.executeScript("return window.auditErrors");
    assert(
      !publishedErrors.some((error) =>
        ["not_found", "device_identity_revoked", "invalid_device"].includes(error),
      ),
    );
    assert.equal((await navigate(`${protectedUrl}/recovered-${code}`)).title, "Proxied fixture");
    assert(!received.direct.includes(`/recovered-${code}`));
    record(
      `Missing or revoked device (${code}) recreates once without exposing the rejected identity`,
      { publishedErrors, attempts: 2, enrollments: 1 },
    );
  }

  assert.equal((await send({ type: "disconnect" })).ok, true);
  let previousAttempts = received.sessionAttempts.length;
  let previousEnrollments = received.deviceEnrollments.length;
  proxyRejections.push(
    { code: "invalid_device", status: 403 },
    { code: "invalid_device", status: 403 },
  );
  await captureBackgroundErrors();
  const bounded = await send({ type: "connect", locationId: "local-audit" });
  assert.equal(bounded.ok, false);
  assert.equal(bounded.commandError, "proxy_unavailable");
  assert.equal(received.sessionAttempts.length, previousAttempts + 2);
  assert.equal(received.deviceEnrollments.length, previousEnrollments + 1);
  assert.equal(bounded.snapshot.nextRetryAt, null);
  assert.equal(bounded.snapshot.protected, false);
  assert(!(await driver.executeScript("return window.auditErrors")).includes("invalid_device"));
  assert.equal((await send({ type: "retry_connection" })).ok, true);
  assert.equal((await snapshot()).protected, true);
  record("Repeated device refusals stop after one replacement, with an explicit retry available");

  assert.equal((await send({ type: "disconnect" })).ok, true);
  previousAttempts = received.sessionAttempts.length;
  previousEnrollments = received.deviceEnrollments.length;
  fixtureDevices.set("quota-slot", {
    device_id: "quota-slot",
    name: "Place à libérer",
    kind: "browser_extension",
    created_at: new Date().toISOString(),
    profiles: [],
  });
  enrollmentLimit = true;
  proxyRejections.push({ code: "device_identity_revoked", status: 403 });
  await captureBackgroundErrors();
  const quota = await send({ type: "connect", locationId: "local-audit" });
  assert.equal(quota.ok, false);
  assert.equal(quota.commandError, "device_revoked_limit");
  assert.equal(quota.snapshot.protected, false);
  assert.equal(quota.snapshot.nextRetryAt, null);
  assert.equal(received.sessionAttempts.length, previousAttempts + 1);
  assert.equal(received.deviceEnrollments.length, previousEnrollments + 1);
  const banner = await waitFor(
    () =>
      driver.executeScript(
        "return {text:document.querySelector('#errorMessage').textContent,visible:document.querySelector('#errorManageDevicesButton').getClientRects().length>0}",
      ),
    (value) => value.visible && value.text.includes("liste des appareils est complète"),
    "Contextual removed-device quota message and list action",
  );
  assert(banner.text.includes("Liste des appareils"));
  await click("#errorManageDevicesButton");
  await waitFor(
    deviceUi,
    (value) =>
      value.devicesOpen &&
      !value.refreshDisabled &&
      value.rows.some((row) => row.id === "quota-slot"),
    "Device list opens directly from quota",
  );
  await click(deleteSelector("quota-slot"));
  await waitFor(
    deviceUi,
    (value) => value.confirmationOpen,
    "Quota deletion has responsive HTML confirmation",
  );
  await click("#confirmationAcceptButton");
  await waitFor(
    snapshot,
    (value) => value.protected && value.error === null,
    "Freeing a slot resumes the pending device enrollment",
  );
  assert.equal(received.deviceEnrollments.length, previousEnrollments + 2);
  assert.equal(
    received.deviceEnrollments.at(-1).publicKeySha256,
    received.deviceEnrollments.at(-2).publicKeySha256,
    "Quota retry keeps the replacement key",
  );
  assert(
    !(await driver.executeScript("return window.auditErrors")).includes("device_identity_revoked"),
  );
  await click("#closeDevicesButton");
  assert.equal((await deviceUi()).settingsOpen, false);
  assert.equal((await navigate(`${protectedUrl}/recovered-after-quota`)).title, "Proxied fixture");
  assert(!received.direct.includes("/recovered-after-quota"));
  record(
    "Revoked-device quota links to devices; freeing a slot recreates with the same replacement key and resumes protection",
    banner,
  );
}
async function hierarchyUi() {
  return driver.executeScript(`const visible=e=>Boolean(e.getClientRects().length);return {
    dir:document.documentElement.dir,open:document.querySelector('#locationDialog').open,
    countries:[...document.querySelectorAll('.location-country-group')].map(e=>e.dataset.countryCode),
    cities:[...document.querySelectorAll('.location-country-group[data-country-code="FR"] .location-city-select .option-title')].map(e=>e.textContent),
    servers:[...document.querySelectorAll('.location-server-row .location-option')].map(e=>({id:e.dataset.focusKey,visible:visible(e)})),
    direct:[...document.querySelectorAll('#locationList > .location-server-row .location-option')].map(e=>e.dataset.focusKey),
    unavailable:[...document.querySelectorAll('.location-unavailable-favorite .location-favorite')].map(e=>e.dataset.focusKey),
    error:document.querySelector('#locationPreferenceError').textContent,
    emptyVisible:visible(document.querySelector('#locationEmpty')),
    focused:document.activeElement?.dataset.focusKey,
    chevrons:[...document.querySelectorAll('.location-disclosure .location-chevron')].filter(visible).map(e=>({width:e.getBoundingClientRect().width,height:e.getBoundingClientRect().height,border:getComputedStyle(e).borderInlineEndWidth})),
    indented:[...document.querySelectorAll('.location-group-children')].filter(visible).every(e=>parseFloat(getComputedStyle(e).paddingInlineStart)>0),
    overflow:document.documentElement.scrollWidth>innerWidth || document.querySelector('#locationDialog').scrollWidth>document.querySelector('#locationDialog').clientWidth
  }`);
}
async function verifyCapacityAndHierarchy(protectedUrl) {
  await openPopup();
  await send({ type: "set_language_preference", preference: "fr" });
  locationsReplyMode = "grouped";
  assert.equal((await send({ type: "refresh_locations" })).ok, true);
  assert.equal((await snapshot()).locations.length, 7);
  assert.equal(
    (await send({ type: "set_location_favorite", locationId: "paris-2", favorite: true })).ok,
    true,
  );
  await click("#changeLocationButton");
  await waitFor(locationsUi, (value) => !value.retryDisabled, "Fresh grouped catalog");
  const successfulSessions = sessions;
  const apiStart = received.api.length;
  proxyRejections.push({ code: "server_full", status: 409 });
  const full = await send({ type: "change_location", locationId: "paris-2" });
  assert.equal(full.ok, false);
  assert.equal(full.commandError, "server_full");
  assert.equal(full.snapshot.protected, true);
  assert.equal(full.snapshot.activeLocationId, "local-audit");
  assert(!full.snapshot.locations.some((location) => location.id === "paris-2"));
  assert.equal(sessions, successfulSessions);
  assert(received.api.slice(apiStart).some((request) => request.path === "/v1/locations"));
  await waitFor(
    hierarchyUi,
    (value) => value.error.includes("complet"),
    "Server-full message displayed inside chooser",
  );
  await click("#favoriteLocationsFilter");
  const unavailableFavorite = await waitFor(
    hierarchyUi,
    (value) => value.direct.length === 0 && value.unavailable.includes("favorite:paris-2"),
    "Full favorite remains unavailable for connection but offers explicit removal",
  );
  assert(full.snapshot.locationPreferences.unavailableFavoriteIds.includes("paris-2"));
  assert.equal((await navigate(`${protectedUrl}/after-full-refusal`)).title, "Proxied fixture");
  assert(!received.direct.includes("/after-full-refusal"));
  record(
    "HTTP 409 server_full hides the full server from connection choices and offers favorite removal while retaining the active proxy",
    unavailableFavorite,
  );
  await click("#allLocationsFilter");
  await click(
    '.location-country-group[data-country-code="FR"] > .location-group-row > .location-group-select',
  );
  await waitFor(
    snapshot,
    (value) => value.error === null && value.selectedLocationId === "local-audit",
    "Country click reselects active available endpoint after full refusal",
  );
  assert.equal(sessions, successfulSessions);
  record(
    "Country selection after a full refusal retains the existing protected session without creating another",
  );

  proxyRejections.push({ code: "capacity_unavailable", status: 503 });
  const capacity = await send({ type: "change_location", locationId: "lyon-1" });
  assert.equal(capacity.ok, false);
  assert.equal(capacity.commandError, "capacity_unavailable");
  assert.equal(capacity.snapshot.protected, true);
  assert.equal(capacity.snapshot.activeLocationId, "local-audit");
  assert.equal(sessions, successfulSessions);
  assert.equal((await navigate(`${protectedUrl}/after-capacity-refusal`)).title, "Proxied fixture");
  assert(!received.direct.includes("/after-capacity-refusal"));
  assert.equal((await send({ type: "change_location", locationId: "local-audit" })).ok, true);
  record(
    "HTTP 503 capacity_unavailable preserves the active authenticated route and reports capacity failure",
  );

  unavailableLocations.clear();
  assert.equal((await send({ type: "refresh_locations" })).ok, true);
  await click("#changeLocationButton");
  await waitFor(locationsUi, (value) => !value.retryDisabled, "Available grouped catalog restored");
  let ui = await hierarchyUi();
  assert.deepEqual(ui.countries, ["DE", "FR"]);
  assert.deepEqual(ui.cities, ["Lyon", "Paris"]);
  const countryDisclosure =
    '.location-country-group[data-country-code="FR"] > .location-group-row > .location-disclosure';
  await click(countryDisclosure);
  const parisDisclosure =
    '.location-country-group[data-country-code="FR"] .location-city-group:last-child .location-disclosure';
  const parisButton = await driver.findElement(By.css(parisDisclosure));
  await parisButton.sendKeys(Key.SPACE);
  ui = await waitFor(
    hierarchyUi,
    (value) => value.servers.filter((server) => server.visible).length === 3,
    "Keyboard opens the multi-server city",
  );
  assert.deepEqual(
    ui.servers.filter((server) => server.visible).map((server) => server.id),
    ["local-audit", "paris-2", "paris-10"],
  );
  assert(ui.focused.startsWith("expand:city:"));
  assert(
    ui.chevrons.length >= 3 &&
      ui.chevrons.every(
        (chevron) => chevron.width >= 9 && chevron.height >= 9 && parseFloat(chevron.border) > 0,
      ),
  );
  assert.equal(ui.indented, true);
  assert.equal(
    await driver.executeScript(
      "return document.querySelector('.location-country-group[data-country-code=FR] .location-city-group:first-child .location-disclosure')===null",
    ),
    true,
    "A single-server city has no extra server submenu",
  );
  assert.equal(ui.overflow, false);
  await writeFile(
    join(output, "locations-groups-fr.png"),
    Buffer.from(await driver.takeFullPageScreenshot(), "base64"),
  );
  record(
    "Locations sort by translated country, then city and natural server number; keyboard disclosure retains focus",
    ui,
  );
  await click("#favoriteLocationsFilter");
  assert.deepEqual((await hierarchyUi()).direct, ["paris-2"]);
  await click("#recentLocationsFilter");
  assert((await hierarchyUi()).direct.includes("local-audit"));
  await click("#allLocationsFilter");
  await driver.findElement(By.css("#locationSearch")).sendKeys("Paris");
  ui = await waitFor(
    hierarchyUi,
    (value) => value.direct.length === 3,
    "Search exposes matching servers directly",
  );
  assert.equal(ui.countries.length, 0);
  await driver.findElement(By.css("#locationSearch")).clear();
  await driver.executeScript(
    "document.querySelector('#locationSearch').dispatchEvent(new Event('input',{bubbles:true}))",
  );
  record("Favorites, recents and search retain direct server access with the hierarchical catalog");
  await send({ type: "set_language_preference", preference: "ar" });
  ui = await waitFor(
    hierarchyUi,
    (value) => value.dir === "rtl" && value.countries.length === 2,
    "Arabic hierarchy rendered",
  );
  assert.equal(ui.overflow, false);
  await writeFile(
    join(output, "locations-groups-ar.png"),
    Buffer.from(await driver.takeFullPageScreenshot(), "base64"),
  );
  record("Arabic location hierarchy retains expansion and has no horizontal overflow", ui);
  await click("#closeLocationButton");
  await send({ type: "set_language_preference", preference: "fr" });
  locationsReplyMode = "normal";
  assert.equal((await send({ type: "refresh_locations" })).ok, true);
  assert.equal((await snapshot()).protected, true);
}
async function unavailableFavoritesUi() {
  return driver.executeScript(`return {
    dir:document.documentElement.dir,
    count:document.querySelectorAll('.location-unavailable-favorite').length,
    selectable:document.querySelectorAll('.location-unavailable-favorite .location-option').length,
    rawIdsVisible:/retired-/.test(document.querySelector('#locationList').textContent),
    error:document.querySelector('#locationPreferenceError').textContent,
    focused:document.activeElement?.dataset.focusKey ?? document.activeElement?.id,
    overflow:document.documentElement.scrollWidth>innerWidth || document.querySelector('#locationDialog').scrollWidth>document.querySelector('#locationDialog').clientWidth
  }`);
}
async function readFavoriteStorage() {
  return extension(
    "browser.storage.local.get('fuzevpnLocationPreferences').then(value=>arguments[arguments.length-1](value.fuzevpnLocationPreferences));",
  );
}
async function verifyUnavailableFavorites(protectedUrl) {
  await openPopup();
  const original = await readFavoriteStorage();
  const retiredIds = Array.from({ length: 100 }, (_, index) => `retired-${index}`);
  assert.equal(
    await extension(
      "const done=arguments[arguments.length-1]; browser.storage.local.set({fuzevpnLocationPreferences:{favoriteIds:arguments[0],recentIds:[],automatic:false}}).then(()=>done(true));",
      retiredIds,
    ),
    true,
  );
  await terminateBackground();
  await openPopup();
  await waitFor(snapshot, (value) => value.locationsStatus === "ready", "Favorite fixture catalog");
  await click("#changeLocationButton");
  await driver.findElement(By.css("#locationSearch")).sendKeys("Paris");
  const availableSelector = '.location-favorite[data-focus-key="favorite:local-audit"]';
  await waitFor(
    () => driver.findElements(By.css(availableSelector)),
    (value) => value.length === 1,
    "Available favorite control appears",
  );
  await click(availableSelector);
  await waitFor(
    unavailableFavoritesUi,
    (value) => value.error.length > 0,
    "Full saved-favorite quota prevents a new favorite",
  );
  assert.deepEqual((await readFavoriteStorage()).favoriteIds, retiredIds);
  await driver.findElement(By.css("#locationSearch")).clear();
  await driver.executeScript(
    "document.querySelector('#locationSearch').dispatchEvent(new Event('input',{bubbles:true}))",
  );
  await click("#favoriteLocationsFilter");
  let ui = await waitFor(
    unavailableFavoritesUi,
    (value) => value.count === 100,
    "All 100 unavailable saved favorites remain removable",
  );
  assert.equal(ui.selectable, 0);
  assert.equal(ui.rawIdsVisible, false);
  assert.equal(ui.overflow, false);
  await writeFile(
    join(output, "unavailable-favorites-fr.png"),
    Buffer.from(await driver.takeFullPageScreenshot(), "base64"),
  );
  const first = await driver.findElement(
    By.css(
      '.location-unavailable-favorite .location-favorite[data-focus-key="favorite:retired-0"]',
    ),
  );
  assert.match(await first.getAttribute("aria-label"), /retirer|supprimer/i);
  await first.sendKeys(Key.SPACE);
  ui = await waitFor(
    unavailableFavoritesUi,
    (value) => value.count === 99,
    "Keyboard removes an unavailable favorite",
  );
  assert.equal(ui.focused, "favoriteLocationsFilter");
  assert.equal((await readFavoriteStorage()).favoriteIds.includes("retired-0"), false);
  record(
    "A full quota of unavailable favorites remains visible and supports explicit keyboard removal",
    ui,
  );

  await click("#allLocationsFilter");
  await driver.findElement(By.css("#locationSearch")).sendKeys("Paris");
  await click(availableSelector);
  await waitFor(
    readFavoriteStorage,
    (value) => value.favoriteIds.includes("local-audit") && value.favoriteIds.length === 100,
    "Removing an unavailable favorite frees the real favorite quota",
  );
  assert.equal(
    await driver.findElement(By.css(availableSelector)).getAttribute("aria-pressed"),
    "true",
  );
  await terminateBackground();
  await openPopup();
  await waitFor(
    snapshot,
    (value) => value.locationsStatus === "ready",
    "Reopened favorite catalog",
  );
  await click("#changeLocationButton");
  await click("#favoriteLocationsFilter");
  ui = await waitFor(
    unavailableFavoritesUi,
    (value) => value.count === 99,
    "Saved favorites restored",
  );
  assert.equal((await readFavoriteStorage()).favoriteIds.length, 100);
  assert.equal((await readFavoriteStorage()).favoriteIds.includes("retired-0"), false);
  assert.equal(
    await driver.findElement(By.css(availableSelector)).getAttribute("aria-pressed"),
    "true",
  );
  assert.equal((await snapshot()).protected, true);
  assert.equal(
    (await navigate(`${protectedUrl}/favorite-quota-recovered`)).title,
    "Proxied fixture",
  );
  record(
    "A new available favorite and 99 unavailable favorites persist across popup and event-page restoration",
    ui,
  );

  await send({ type: "set_language_preference", preference: "ar" });
  ui = await waitFor(
    unavailableFavoritesUi,
    (value) => value.dir === "rtl",
    "Arabic unavailable favorites",
  );
  assert.equal(ui.overflow, false);
  assert.equal(ui.rawIdsVisible, false);
  await writeFile(
    join(output, "unavailable-favorites-ar.png"),
    Buffer.from(await driver.takeFullPageScreenshot(), "base64"),
  );
  record(
    "Unavailable favorite labels and removal controls remain readable in Arabic without overflow",
    ui,
  );

  locationsReplyMode = "empty";
  assert.equal((await send({ type: "refresh_locations" })).ok, true);
  await waitFor(
    unavailableFavoritesUi,
    (value) => value.count === 100,
    "All favorites unavailable with an empty catalog",
  );
  const unavailableActive = await driver.findElement(By.css(availableSelector));
  await unavailableActive.sendKeys(Key.ENTER);
  await waitFor(
    readFavoriteStorage,
    (value) => value.favoriteIds.length === 99 && !value.favoriteIds.includes("local-audit"),
    "Favorite removal with empty catalog persists",
  );
  assert.equal((await snapshot()).locations.length, 0);
  assert.equal((await snapshot()).protected, true);
  assert.equal((await navigate(`${protectedUrl}/favorite-empty-catalog`)).title, "Proxied fixture");
  record(
    "An empty catalog still permits keyboard removal of a saved favorite and preserves the live VPN",
  );
  locationsReplyMode = "normal";
  assert.equal((await send({ type: "refresh_locations" })).ok, true);
  await send({ type: "set_language_preference", preference: "fr" });
  await extension(
    "const done=arguments[arguments.length-1]; browser.storage.local.set({fuzevpnLocationPreferences:arguments[0]}).then(()=>done(true));",
    original,
  );
  await terminateBackground();
  await openPopup();
}
async function verifyDeferredRenewal(protectedUrl, alarm) {
  const previous = await extension(
    "browser.storage.session.get('fuzevpnProxySession').then(value=>arguments[arguments.length-1](value.fuzevpnProxySession.proxySession.id));",
  );
  const count = sessions;
  apiDelays.set("/v1/billing/subscription", 3500);
  await driver.executeScript(
    "window.concurrentSelectionResult=null; browser.runtime.sendMessage({type:'change_location',locationId:'local-audit'}).then(value=>{window.concurrentSelectionResult=value;});",
  );
  await waitFor(
    snapshot,
    (value) => value.status === "connecting" && value.protected,
    "Slow same-location change retains the live proxy",
  );
  const firedAt = Date.now() + 100;
  await extension(
    "const done=arguments[arguments.length-1]; browser.alarms.create(arguments[0],{when:arguments[1]}).then(()=>done(true));",
    alarm,
    firedAt,
  );
  const deferred = await waitFor(
    () =>
      extension(
        "browser.alarms.get(arguments[0]).then(value=>arguments[arguments.length-1](value ?? null));",
        alarm,
      ),
    (value) => value && value.scheduledTime > firedAt + 1000,
    "A consumed refresh alarm is rearmed while selection is pending",
    2500,
  );
  assert.equal((await snapshot()).status, "connecting");
  assert.equal(sessions, count);
  const result = await waitFor(
    () => driver.executeScript("return window.concurrentSelectionResult"),
    (value) => value !== null,
    "Same-location selection completes after the delayed account response",
  );
  apiDelays.delete("/v1/billing/subscription");
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.snapshot.protected, true);
  assert.equal(sessions, count);
  const current = await extension(
    "browser.storage.session.get('fuzevpnProxySession').then(value=>arguments[arguments.length-1](value.fuzevpnProxySession.proxySession.id));",
  );
  assert.equal(current, previous);
  const rearmed = await extension(
    "browser.alarms.get(arguments[0]).then(arguments[arguments.length-1]);",
    alarm,
  );
  assert(rearmed.scheduledTime > Date.now());
  assert.equal((await navigate(`${protectedUrl}/deferred-renewal`)).title, "Proxied fixture");
  assert(!received.direct.includes("/deferred-renewal"));
  record(
    "A native refresh alarm during slow same-location selection is deferred and retained-session renewal is rearmed",
    { deferred, rearmed },
  );
}
async function navigate(url) {
  await driver.switchTo().newWindow("tab");
  let error = null;
  try {
    await driver.get(url);
  } catch (value) {
    error = String(value.message);
  }
  const title = await driver.getTitle().catch(() => "");
  await driver.close();
  await driver.switchTo().window((await driver.getAllWindowHandles())[0]);
  return { error, title };
}
async function permissions(privateAllowed, hostsAllowed = true) {
  await driver.get("about:blank");
  return privileged(
    `const done=arguments[arguments.length-1]; const [id,privateAllowed,hostsAllowed]=arguments;
    (async()=>{const {ExtensionPermissions}=ChromeUtils.importESModule("resource://gre/modules/ExtensionPermissions.sys.mjs");
    const priv={permissions:["internal:privateBrowsingAllowed"],origins:[]};
    await ExtensionPermissions[privateAllowed?"add":"remove"](id,priv);
    await ExtensionPermissions[hostsAllowed?"add":"remove"](id,{permissions:[],origins:["<all_urls>","https://api.fuzevpn.com/*"]});
    const {AddonManager}=ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
    const addon=await AddonManager.getAddonByID(id); await addon.reload(); done(true);})().catch(e=>done({error:String(e),stack:e.stack}));`,
    extensionId,
    privateAllowed,
    hostsAllowed,
  );
}
async function screenshot(language, page) {
  await openPopup();
  assert.equal((await send({ type: "set_language_preference", preference: language })).ok, true);
  if (page === "diagnostics")
    await driver.get(`${extensionOrigin}/diagnostics-page/diagnostics.html`);
  await waitFor(
    () => driver.executeScript("return document.documentElement.lang"),
    (value) => value === language,
    "Localized page",
  );
  if (page === "popup") {
    await waitFor(
      () =>
        driver.executeScript(
          "const main=document.querySelector('#mainView');return main && !main.classList.contains('hidden') && getComputedStyle(main).display!=='none'",
        ),
      Boolean,
      "Account view rendered",
    );
  }
  await driver.executeAsyncScript(`const done=arguments[arguments.length-1];
    (async()=>{await document.fonts.ready; await Promise.allSettled(document.getAnimations().filter(a=>a.effect?.getTiming().iterations!==Infinity).map(a=>a.finished)); await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))); done(true)})().catch(e=>done(String(e)));`);
  const layout = await driver.executeScript(
    "return {lang:document.documentElement.lang,dir:document.documentElement.dir,width:innerWidth,scrollWidth:document.documentElement.scrollWidth,scrollX,scrollY,text:document.body.innerText.length,rectangles:Object.fromEntries(['body','.shell','#mainView','#statusCard','.status-orb'].map(s=>{const e=document.querySelector(s);return [s,e?{x:e.getBoundingClientRect().x,y:e.getBoundingClientRect().y,width:e.getBoundingClientRect().width,height:e.getBoundingClientRect().height,opacity:getComputedStyle(e).opacity,transform:getComputedStyle(e).transform}:null]}))}",
  );
  assert.equal(layout.dir, language === "ar" ? "rtl" : "ltr");
  assert(layout.text > 100);
  assert(layout.scrollWidth <= layout.width, "No horizontal overflow");
  // Firefox's element screenshot command can scroll/repaint only part of a RTL
  // document. Capture once without scrolling, then extract the measured body.
  const fullPage = Buffer.from(await driver.takeFullPageScreenshot(), "base64");
  await writeFile(join(output, `${page}-${language}-viewport.png`), fullPage);
  const metadata = await sharp(fullPage).metadata();
  const scale = metadata.width / layout.scrollWidth;
  const body = layout.rectangles.body;
  const left = Math.round((body.x + layout.scrollX) * scale);
  const top = Math.round((body.y + layout.scrollY) * scale);
  await sharp(fullPage)
    .extract({
      left,
      top,
      width: Math.round(body.width * scale),
      height: Math.min(Math.round(body.height * scale), metadata.height - top),
    })
    .toFile(join(output, `${page}-${language}.png`));
  record(`${page} ${language} layout`, layout);
}

async function readLegalLinks() {
  return driver.executeScript(`return [...document.querySelectorAll('a[data-legal-link]')].map(a=>({
    id:a.id,kind:a.dataset.legalLink,key:a.dataset.i18n,label:a.textContent.trim(),href:a.href,
    hreflang:a.hreflang,target:a.target,rel:a.rel,tabIndex:a.tabIndex,visible:a.getClientRects().length>0
  }))`);
}
async function settleLegalVisuals() {
  await driver.executeAsyncScript(`const done=arguments[arguments.length-1];
    (async()=>{await document.fonts.ready; await Promise.allSettled(document.getAnimations().filter(a=>a.effect?.getTiming().iterations!==Infinity).map(a=>a.finished)); await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))); done(true)})().catch(e=>done(String(e)));`);
}
async function assertLegalLinks(language, expectedCount) {
  const links = await readLegalLinks();
  assert.equal(links.length, expectedCount);
  const catalog = JSON.parse(
    await readFile(join(dist, "_locales", localeDirectory(language), "messages.json"), "utf8"),
  );
  const websiteLanguage = ["fr", "en", "es", "de", "nl"].includes(language) ? language : "en";
  for (const link of links) {
    const page =
      link.kind === "contact"
        ? ({ es: "contacto", de: "kontakt" }[websiteLanguage] ?? "contact")
        : link.kind;
    assert.equal(link.href, `https://fuzevpn.com/${websiteLanguage}/${page}.html`);
    assert.equal(link.hreflang, websiteLanguage);
    assert.equal(link.label, catalog[link.key].message);
    assert.equal(link.target, "_blank");
    assert.deepEqual(link.rel.split(/\s+/).sort(), ["noopener", "noreferrer"]);
    assert.equal(link.tabIndex, 0);
  }
  return links;
}
async function openLegalFixture(selector, keyboard = false) {
  const original = await driver.getWindowHandle();
  const handles = await driver.getAllWindowHandles();
  const requestStart = legalFixtureRequests.length;
  const destination = new URL(await driver.findElement(By.css(selector)).getAttribute("href"))
    .pathname;
  if (keyboard) {
    const link = await driver.findElement(By.css(selector));
    await driver.executeScript("arguments[0].focus()", link);
    await link.sendKeys(Key.ENTER);
  } else await click(selector);
  const opened = await waitFor(
    () => driver.getAllWindowHandles(),
    (value) => value.length === handles.length + 1,
    "Legal link opens new tab",
  );
  await driver.switchTo().window(opened.find((handle) => !handles.includes(handle)));
  await waitFor(
    () => driver.getTitle(),
    (value) => value === "Local legal fixture",
    "Synthetic legal page loaded",
  );
  assert.equal(await driver.executeScript("return window.opener === null"), true);
  assert.equal(await driver.executeScript("return document.referrer"), "");
  await driver.close();
  await driver.switchTo().window(original);
  // A favicon request can legitimately refer to its own destination page.
  // The navigation from the extension itself must carry no referrer.
  const navigations = legalFixtureRequests
    .slice(requestStart)
    .filter((entry) => entry.path === destination);
  assert(navigations.length > 0);
  assert(navigations.every((entry) => entry.referer === null));
}
async function verifyLegalInformation() {
  assert.equal((await snapshot()).status, "logged_out");
  const networkStart = received.api.length;
  const fixtureStart = legalFixtureRequests.length;
  for (const language of SUPPORTED_LANGUAGES) {
    assert.equal((await send({ type: "set_language_preference", preference: language })).ok, true);
    await waitFor(
      () => driver.executeScript("return document.documentElement.lang"),
      (value) => value === language,
      "Popup legal language",
    );
    const loginLinks = await assertLegalLinks(language, 6);
    assert(loginLinks.find((link) => link.id === "loginPrivacyLink").visible);
    if (process.env.FIREFOX_DESIGN_ONLY === "1") await designReview.loggedOut(language);
    await click("#settingsButton");
    const settingsLinks = await assertLegalLinks(language, 6);
    assert(
      settingsLinks.filter((link) => link.id.startsWith("legal")).every((link) => link.visible),
    );
    assert(settingsLinks.find((link) => link.id === "diagnosticsPrivacyLink").visible);
    assert.equal(
      await driver.executeScript("return document.querySelector('#diagnosticsAuto').checked"),
      false,
    );
    assert.equal(
      await driver.executeScript(
        "return document.documentElement.scrollWidth <= innerWidth && document.querySelector('#settingsPanel').scrollWidth <= document.querySelector('#settingsPanel').clientWidth",
      ),
      true,
    );
    if (["fr", "ar"].includes(language)) {
      await driver.executeScript(
        "document.querySelector('#legalContactLink').scrollIntoView({block:'end'})",
      );
      await settleLegalVisuals();
      assert.equal(
        await driver.executeScript(
          "return getComputedStyle(document.querySelector('#settingsPanel')).opacity",
        ),
        "1",
      );
      await writeFile(
        join(output, `legal-logged-out-${language}.png`),
        Buffer.from(await driver.takeFullPageScreenshot(), "base64"),
      );
    }
    await click("#closeSettingsButton");
    await driver.get(`${extensionOrigin}/diagnostics-page/diagnostics.html`);
    await waitFor(
      () => driver.executeScript("return document.documentElement.lang"),
      (value) => value === language,
      "Diagnostic legal language",
    );
    const diagnosticLinks = await assertLegalLinks(language, 2);
    assert(diagnosticLinks.find((link) => link.id === "autoPrivacyLink").visible);
    assert.equal(
      await driver.executeScript("return document.querySelector('#autoReporting').checked"),
      false,
    );
    await openPopup();
  }
  assert.equal(legalFixtureRequests.length, fixtureStart, "Legal pages are not prefetched");
  assert(!received.api.slice(networkStart).some((request) => request.method !== "GET"));
  record(
    "Legal links work logged out in all thirty languages without consent or network side effects",
    { languages: SUPPORTED_LANGUAGES.length },
  );
  await send({ type: "set_language_preference", preference: "fr" });
  await waitFor(
    () => driver.executeScript("return document.documentElement.lang"),
    (value) => value === "fr",
    "French link before keyboard test",
  );
  await openLegalFixture("#loginPrivacyLink", true);
  assert.equal((await snapshot()).status, "logged_out");
  record("Logged-out privacy link opens by keyboard without opener or referrer", {
    destination: "local HTTPS fixture only",
  });
}
async function verifyLegalConsentLinks() {
  const networkStart = received.api.length;
  await click("#settingsButton");
  await openLegalFixture("#diagnosticsPrivacyLink");
  assert.equal(
    await driver.executeScript("return document.querySelector('#diagnosticsAuto').checked"),
    false,
  );
  await click("#closeSettingsButton");
  await driver.get(`${extensionOrigin}/diagnostics-page/diagnostics.html`);
  await waitFor(
    () => driver.executeScript("return document.querySelector('#runButton').disabled"),
    (value) => value === false,
    "Diagnostics ready",
  );
  await openLegalFixture("#autoPrivacyLink");
  assert.equal(
    await driver.executeScript("return document.querySelector('#autoReporting').checked"),
    false,
  );
  await click("#runButton");
  await waitFor(
    () => driver.executeScript("return document.querySelector('#sendConsent').disabled"),
    (value) => value === false,
    "Local report ready for consent",
  );
  await click("#sendConsent");
  await openLegalFixture("#sendPrivacyLink", true);
  assert.equal(
    await driver.executeScript("return document.querySelector('#sendConsent').checked"),
    true,
  );
  assert.equal(
    await driver.executeScript("return document.querySelector('#autoReporting').checked"),
    false,
  );
  assert(!received.api.slice(networkStart).some((request) => request.path === "/v1/diagnostics"));
  for (const language of ["fr", "ar"]) {
    await send({ type: "set_language_preference", preference: language });
    await waitFor(
      () => driver.executeScript("return document.documentElement.lang"),
      (value) => value === language,
      "Diagnostic consent locale",
    );
    await assertLegalLinks(language, 2);
    await driver.executeScript(
      "document.querySelector('#sendPrivacyLink').scrollIntoView({block:'center'})",
    );
    await settleLegalVisuals();
    await writeFile(
      join(output, `legal-diagnostic-consent-${language}.png`),
      Buffer.from(await driver.takeFullPageScreenshot(), "base64"),
    );
  }
  await click("#sendConsent");
  await click("#deleteButton");
  record(
    "Privacy links preserve automatic and individual diagnostic consent and never send a report",
  );
  await openPopup();
  await send({ type: "set_language_preference", preference: "fr" });
}

try {
  runtimeValidation: {
    const tls = await certificate();
    api = track(
      httpsServer(tls, async (request, response) => {
        if (webAuthFixture.handleWebRequest(request, response)) return;
        if (/^fuzevpn\.com(?::443)?$/.test(request.headers.host || "")) {
          legalFixtureRequests.push({
            path: request.url,
            referer: request.headers.referer ?? null,
          });
          response.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "no-store" });
          response.end(
            "<!doctype html><title>Local legal fixture</title><p>Synthetic link destination only</p>",
          );
          return;
        }
        received.api.push({ method: request.method, path: request.url, at: Date.now() });
        if (/^api(?:64)?\.ipify\.org(?::443)?$/.test(request.headers.host || "")) {
          response.writeHead(200, {
            "Content-Type": "application/json",
            "Cache-Control": "no-store",
          });
          response.end(JSON.stringify({ ip: "8.8.8.8" }));
          return;
        }
        const path = new URL(request.url, "https://api.fuzevpn.com").pathname;
        let payload = "";
        for await (const chunk of request) {
          payload += String(chunk);
          if (payload.length > 100_000) throw new Error("Oversized synthetic API request");
        }
        const parsed = payload ? JSON.parse(payload) : {};
        if (path === "/v1/diagnostics" && request.method === "POST") {
          const item = {
            id: parsed.report_id,
            type: parsed.report_type,
            consent: parsed.consent.mode,
            held: diagnosticResponseMode === "hold",
            aborted: false,
          };
          received.diagnostics.push(item);
          response.on("close", () => {
            if (!response.writableEnded) item.aborted = true;
          });
          if (diagnosticResponseMode === "hold") return;
        }
        const reply = () => {
          const [status, body] =
            webAuthFixture.exchange(path, request.method, parsed, request.headers) ??
            apiReply(path, request.method, parsed);
          response.writeHead(status, {
            "Content-Type": "application/json",
            "Cache-Control": "no-store",
          });
          response.end(body ? JSON.stringify(body) : undefined);
        };
        const deviceId = decodeURIComponent(path.slice("/v1/devices/".length));
        if (
          request.method === "DELETE" &&
          path.startsWith("/v1/devices/") &&
          deviceDeletionModes.get(deviceId) === "hold"
        ) {
          heldDeviceDeletion = { deviceId, reply };
          return;
        }
        const delay = apiDelays.get(path);
        if (delay) setTimeout(reply, delay);
        else reply();
      }),
    );
    await listen(api, 443);
    target = track(
      httpServer((request, response) => {
        received.direct.push(request.url);
        response.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "no-store" });
        response.end("<!doctype html><title>Direct fixture</title><p>Direct local destination</p>");
      }),
    );
    const targetPort = await listen(target);
    target.on("connection", () => {
      directConnections++;
    });
    tlsTarget = track(
      httpsServer(tls, (_request, response) => {
        vpnIpRequests++;
        if (vpnIpUnavailable) {
          response.writeHead(503, { "Content-Type": "application/json" });
          response.end(JSON.stringify({ error: "synthetic_unavailable" }));
          return;
        }
        response.writeHead(200, {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
        });
        response.end(JSON.stringify({ ip: "9.9.9.9" }));
      }),
    );
    const tlsTargetPort = await listen(tlsTarget);
    proxy = track(
      httpsServer(tls, (request, response) => {
        const path = new URL(request.url).pathname;
        const authenticated =
          request.headers["proxy-authorization"] ===
          `Basic ${Buffer.from("synthetic-user:synthetic-password").toString("base64")}`;
        received.proxy.push({ path, authenticated });
        if (!proxyAvailable) {
          request.socket.destroy();
          return;
        }
        if (path === "/delayed-auth") {
          pendingChallenge = response;
          return;
        }
        if (!authenticated) {
          response.writeHead(407, {
            "Proxy-Authenticate": 'Basic realm="firefox-test"',
            "Content-Length": "0",
          });
          response.end();
          return;
        }
        response.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "no-store" });
        response.end("<!doctype html><title>Proxied fixture</title><p>Authenticated TLS proxy</p>");
      }),
    );
    proxy.on("connect", (request, socket, head) => {
      const authenticated =
        request.headers["proxy-authorization"] ===
        `Basic ${Buffer.from("synthetic-user:synthetic-password").toString("base64")}`;
      received.proxy.push({
        connect: request.url,
        authenticated,
      });
      if (!proxyAvailable || !/^api(?:64)?\.ipify\.org:443$/.test(request.url)) {
        socket.destroy();
        return;
      }
      if (!authenticated) {
        socket.end(
          'HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="firefox-test"\r\nContent-Length: 0\r\n\r\n',
        );
        return;
      }
      const upstream = connectTcp(tlsTargetPort, "127.0.0.1", () => {
        socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length) upstream.write(head);
        socket.pipe(upstream).pipe(socket);
      });
      sockets.add(upstream);
      upstream.on("close", () => sockets.delete(upstream));
      upstream.on("error", () => socket.destroy());
      socket.on("error", () => upstream.destroy());
    });
    proxyPort = await listen(proxy);
    const gecko = await download(process.env.GECKODRIVER_VERSION, cache);
    report.geckodriver = spawnSync(gecko, ["--version"], {
      encoding: "utf8",
      windowsHide: true,
    }).stdout.trim();
    const options = new firefox.Options()
      .setBinary(executable)
      .addArguments("-headless", "-no-remote", "--allow-system-access", "-profile", profile);
    for (const [key, value] of Object.entries({
      "extensions.webextensions.uuids": JSON.stringify({ [extensionId]: uuid }),
      "extensions.allowPrivateBrowsingByDefault": false,
      "network.dns.forceResolve": "127.0.0.1",
      "network.trr.mode": 5,
      "network.proxy.allow_hijacking_localhost": true,
      "network.captive-portal-service.enabled": false,
      "network.connectivity-service.enabled": false,
      "network.prefetch-next": false,
      "network.dns.disablePrefetch": true,
      "network.http.speculative-parallel-limit": 0,
      "browser.safebrowsing.malware.enabled": false,
      "browser.safebrowsing.phishing.enabled": false,
      "datareporting.healthreport.uploadEnabled": false,
      "toolkit.telemetry.enabled": false,
      "app.update.enabled": false,
      "extensions.update.enabled": false,
      ...(process.env.FIREFOX_CONSENT_ONLY === "1"
        ? {
            "browser.download.dir": join(output, "downloads"),
            "browser.download.folderList": 2,
            "browser.download.useDownloadDir": true,
            "browser.download.alwaysOpenPanel": false,
          }
        : {}),
    }))
      options.setPreference(key, value);
    driver = await new Builder()
      .forBrowser("firefox")
      .setFirefoxOptions(options)
      .setFirefoxService(
        new firefox.ServiceBuilder(gecko).addArguments(
          "--allow-system-access",
          "--profile-root",
          cache,
        ),
      )
      .build();
    await driver.manage().setTimeouts({ script: 20000, pageLoad: 10000 });
    await driver.manage().window().setRect({ width: 520, height: 900 });
    report.firefox = (await driver.getCapabilities()).get("browserVersion");
    assert(Number.parseInt(report.firefox, 10) >= 140);
    const certificateBody = (await readFile(join(output, "ca.pem"), "utf8")).replace(
      /-----[^-]+-----|\s/g,
      "",
    );
    const trusted = await privileged(
      `try { const db=Components.classes["@mozilla.org/security/x509certdb;1"].getService(Components.interfaces.nsIX509CertDB); db.addCertFromBase64(arguments[0],"CT,C,C"); arguments[arguments.length-1](true); } catch(e) {arguments[arguments.length-1](String(e));}`,
      certificateBody,
    );
    assert.equal(trusted, true);
    await driver.get("https://api.fuzevpn.com/v1/locations");
    assert(
      received.api.some((request) => request.path === "/v1/locations"),
      "Verify local API before any synthetic login",
    );
    record("Firefox runtime and isolated loopback API", {
      firefox: report.firefox,
      nativeApiUnmodified: true,
    });
    assert.equal(await driver.installAddon(dist, true), extensionId);
    await openPopup();
    record("Unchanged Manifest V3 event page loads", { initialStatus: (await snapshot()).status });
    const loginViaWeb = () =>
      firefoxWebAuthLogin({ driver, fixture: webAuthFixture, click, snapshot, waitFor });
    if (process.env.FIREFOX_WEB_AUTH_ONLY === "1") {
      await firefoxWebAuthCheck({
        driver,
        fixture: webAuthFixture,
        output,
        received,
        extension,
        send,
        snapshot,
        openPopup,
        permissions,
        click,
        waitFor,
        record,
        navigate,
        protectedUrl: `http://public.example.com:${targetPort}`,
      });
      report.success = true;
      break runtimeValidation;
    }
    if (process.env.FIREFOX_CONSENT_ONLY === "1") {
      await firefoxConsentCheck({
        driver,
        extensionId,
        extensionOrigin,
        output,
        received,
        privileged,
        extension,
        send,
        snapshot,
        openPopup,
        permissions,
        click,
        waitFor,
        record,
        loginViaWeb,
        setDiagnosticMode: (mode) => {
          diagnosticResponseMode = mode;
        },
      });
      report.success = true;
      break runtimeValidation;
    }
    await verifyLegalInformation();
    const login = await loginViaWeb();
    assert.equal(login.ok, true, JSON.stringify(login));
    await verifyLegalConsentLinks();
    if (process.env.FIREFOX_LEGAL_ONLY === "1") {
      report.success = true;
      break runtimeValidation;
    }
    await send({ type: "refresh_network" });
    const directObservation = await waitFor(
      snapshot,
      (value) => value.network.status === "ready" && value.network.mode === "direct",
      "Direct synthetic IP observation",
    );
    assert.equal(directObservation.network.ip, "8.8.8.8");
    record("Direct IP probe displays synthetic fixture address", {
      ip: directObservation.network.ip,
      simulated: true,
    });
    const denied = await send({ type: "connect", locationId: "local-audit" });
    assert.equal(denied.ok, false);
    assert.equal(denied.commandError, "private_browsing_required");
    assert.notEqual(denied.snapshot.status, "connected");
    record("Connection refuses missing private permission", { error: denied.commandError });
    await waitFor(
      () => driver.executeScript("return document.querySelector('#errorBanner').textContent"),
      (value) => /même/i.test(value) && /normal/i.test(value),
      "Private permission message explains normal Firefox windows",
    );
    record("Private-permission message explains the requirement in normal Firefox windows");
    assert.equal(await permissions(true), true);
    await openPopup();
    vpnIpUnavailable = true;
    const beforeTransientVpnIpFailure = vpnIpRequests;
    let connected = await send({ type: "connect", locationId: "local-audit" });
    assert.equal(connected.ok, true, JSON.stringify(connected));
    assert.equal(connected.snapshot.status, "connected");
    record("Synthetic authenticated account connects", { protected: connected.snapshot.protected });
    const failedVpnIp = await send({ type: "refresh_network" });
    assert.equal(failedVpnIp.snapshot.network.status, "unavailable");
    assert.equal(failedVpnIp.snapshot.status, "connected");
    assert.equal(failedVpnIp.snapshot.protected, true);
    assert.equal(failedVpnIp.snapshot.trafficBlocked, false);
    assert.equal(vpnIpRequests, beforeTransientVpnIpFailure + 2);
    record("Firefox keeps the VPN connected and limits failed IP-service lookups to two attempts");
    vpnIpUnavailable = false;
    const vpnObservation = await waitFor(
      snapshot,
      (value) => value.network.status === "ready" && value.network.mode === "vpn",
      "VPN synthetic IP observation",
    );
    assert.equal(vpnObservation.network.ip, "9.9.9.9");
    assert(
      received.proxy.some((entry) => entry.connect === "api.ipify.org:443" && entry.authenticated),
    );
    record("VPN IP probe uses authenticated CONNECT and displays synthetic address", {
      ip: vpnObservation.network.ip,
      simulated: true,
    });
    assert.equal(vpnIpRequests, beforeTransientVpnIpFailure + 3);
    assert.equal(vpnObservation.status, "connected");
    assert.equal(vpnObservation.protected, true);
    record("Firefox popup automatically recovers IP measurement on the authenticated VPN route");
    const protectedUrl = `http://protected.example.com:${targetPort}`;
    assert.equal((await navigate(`${protectedUrl}/active-auth`)).title, "Proxied fixture");
    assert(
      received.proxy.some((request) => request.path === "/active-auth" && request.authenticated),
    );
    assert(!received.direct.includes("/active-auth"));
    record("Protected navigation uses authenticated HTTPS proxy");
    if (process.env.FIREFOX_DESIGN_ONLY !== "1") {
      if (process.env.FIREFOX_LOCATION_AUDIT !== "baseline-disconnected")
        await verifyDelayedAccountRestoration(protectedUrl);
      await verifyDisconnectedRestoration(protectedUrl);
      if (!process.env.FIREFOX_LOCATION_AUDIT?.startsWith("baseline"))
        await verifyLocationRefreshUi(protectedUrl);
    }
    const dnsObservation = await privileged(`const done=arguments[arguments.length-1];
    const timer=setTimeout(()=>done({available:false,error:"DNS dashboard timed out"}),4000);
    try { const dashboard=Components.classes["@mozilla.org/network/dashboard;1"].getService(Components.interfaces.nsIDashboard);
      dashboard.requestDNSInfo(data=>{clearTimeout(timer);done({available:true,data});});
    } catch(error){clearTimeout(timer);done({available:false,error:String(error)});}`);
    assert.equal(dnsObservation.available, true, JSON.stringify(dnsObservation));
    record("Native Firefox DNS cache observed in synthetic loopback profile", {
      observation: dnsObservation.data,
      interpretation:
        "Read-only native cache observation after a protected request. forceResolve maps every destination to loopback and may bypass the resolver/cache; an empty cache does not prove absence of DNS leaks.",
    });
    await driver.switchTo().newWindow("tab");
    await driver.get(`${protectedUrl}/webrtc`);
    const candidates = await driver.executeAsyncScript(`const done=arguments[arguments.length-1];
    (async()=>{const pc=new RTCPeerConnection({iceServers:[]}); const candidates=[];
    pc.onicecandidate=({candidate})=>{if(candidate)candidates.push({protocol:candidate.protocol,type:candidate.type})};
    pc.createDataChannel("isolated-audit"); await pc.setLocalDescription(await pc.createOffer());
    await new Promise(resolve=>{if(pc.iceGatheringState==="complete")return resolve(); const t=setTimeout(resolve,2500);pc.onicegatheringstatechange=()=>{if(pc.iceGatheringState==="complete"){clearTimeout(t);resolve()}}});
    pc.close();done(candidates)})().catch(e=>done({error:String(e)}));`);
    assert(Array.isArray(candidates));
    assert(!candidates.some((candidate) => candidate.protocol === "udp"));
    await driver.close();
    await driver.switchTo().window((await driver.getAllWindowHandles())[0]);
    record("Protected ordinary page produces no local UDP ICE candidate", candidates);
    const pac = await extension(
      "browser.proxy.settings.get({}).then(arguments[arguments.length-1]);",
    );
    assert.equal(pac.value.proxyType, "autoConfig");
    assert(!JSON.stringify(pac).includes("synthetic-password"));
    record("PAC settings contain no proxy credentials");
    const webRtc = await extension(
      "browser.privacy.network.webRTCIPHandlingPolicy.get({}).then(arguments[arguments.length-1]);",
    );
    assert.equal(webRtc.value, "disable_non_proxied_udp");
    record("Firefox WebRTC policy is enabled", webRtc);
    const prediction = await extension(
      "browser.privacy.network.networkPredictionEnabled.get({}).then(arguments[arguments.length-1]);",
    );
    assert.equal(prediction.levelOfControl, "controlled_by_this_extension");
    assert.equal(prediction.value, false);
    record("Network prediction is disabled and controlled during protection", prediction);
    const excluded = await send({
      type: "update_site_exclusions",
      expectedRevision: connected.snapshot.siteExclusions.saved.revision,
      enabled: true,
      entries: [{ domain: "excluded.example.com", includeSubdomains: true }],
    });
    assert.equal(excluded.ok, true, JSON.stringify(excluded));
    assert.equal(
      (await navigate(`http://excluded.example.com:${targetPort}/excluded`)).title,
      "Direct fixture",
    );
    assert(received.direct.includes("/excluded"));
    record("Committed site exclusion goes directly to local target");
    await screenshot("fr", "popup");
    await screenshot("ar", "popup");
    await screenshot("fr", "diagnostics");
    await screenshot("ar", "diagnostics");
    if (process.env.FIREFOX_DESIGN_ONLY === "1") {
      await designReview.connected();
      report.success = true;
      break runtimeValidation;
    }
    await verifyDeviceDeletionUi(protectedUrl);
    await verifyDeviceRecovery(protectedUrl);
    await verifyCapacityAndHierarchy(protectedUrl);
    await verifyUnavailableFavorites(protectedUrl);
    await openPopup();
    // The actual alarm name is read from the shipped source instead of inventing a production hook.
    const config = await readFile(join(projectRoot, "src/core/shared/config.ts"), "utf8");
    const alarm = config.match(/ALARM_REFRESH\s*=\s*["']([^"']+)/)?.[1];
    assert(alarm);
    await verifyDeferredRenewal(protectedUrl, alarm);
    const count = sessions;
    await extension(
      "const done=arguments[arguments.length-1]; Promise.resolve(browser.alarms.create(arguments[0],{when:Date.now()+100})).then(()=>done(true));",
      alarm,
    );
    await waitFor(
      () => sessions,
      (value) => value > count,
      "Session renewal",
    );
    await waitFor(snapshot, (value) => value.status === "connected", "Renewed session connected");
    record("Session alarm renews via synthetic API", { sessions });
    proxyAvailable = false;
    const directBefore = received.direct.length;
    const connectionsBeforeFailure = directConnections;
    await navigate(`${protectedUrl}/proxy-unavailable`);
    assert.equal(received.direct.length, directBefore);
    assert.equal(directConnections, connectionsBeforeFailure);
    record("Proxy failure never falls back directly", {
      directTcpConnections: directConnections - connectionsBeforeFailure,
    });
    assert.equal(
      (await navigate(`http://excluded.example.com:${targetPort}/excluded-during-failure`)).title,
      "Direct fixture",
    );
    record("Explicit exclusion remains reachable during proxy failure");
    proxyAvailable = true;
    await openPopup();
    await send({ type: "disconnect" });
    connected = await send({ type: "connect", locationId: "local-audit" });
    assert.equal(connected.ok, true, JSON.stringify(connected));
    const oldWorker = connected.snapshot.snapshotVersion.workerId;
    // Terminate only the extension event page; session storage and the Firefox profile remain alive.
    const suspended = await privileged(
      `const done=arguments[arguments.length-1]; (async()=>{const {ExtensionParent}=ChromeUtils.importESModule("resource://gre/modules/ExtensionParent.sys.mjs"); const e=ExtensionParent.GlobalManager.getExtension(arguments[0]); await e.terminateBackground({disableResetIdleForTest:true}); done(true);})().catch(e=>done({error:String(e)}));`,
      extensionId,
    );
    assert.equal(suspended, true);
    await openPopup();
    const restored = await waitFor(
      snapshot,
      (value) => value.status === "connected" && value.snapshotVersion.workerId !== oldWorker,
      "Event page restoration",
    );
    assert(restored.protected);
    record("Suspended event page restores authenticated session");
    const beforeBadPac = received.direct.length;
    const connectionsBeforeBadPac = directConnections;
    await extension(
      "const done=arguments[arguments.length-1]; browser.proxy.settings.set({value:{proxyType:'autoConfig',autoConfigUrl:'data:application/x-ns-proxy-autoconfig,'+encodeURIComponent('function FindProxyForURL(){throw new Error(\"fixture PAC failure\")}')}}).then(()=>done(true),e=>done(String(e)));",
    );
    await navigate(`${protectedUrl}/pac-failure`);
    assert.equal(received.direct.length, beforeBadPac);
    assert.equal(directConnections, connectionsBeforeBadPac);
    record("Failing PAC never sends protected navigation directly", {
      directTcpConnections: directConnections - connectionsBeforeBadPac,
    });
    await openPopup();
    const disconnect = await send({ type: "disconnect" });
    assert.equal(disconnect.ok, true, JSON.stringify(disconnect));
    const cleared = await extension(
      "Promise.all([browser.proxy.settings.get({}),browser.privacy.network.webRTCIPHandlingPolicy.get({}),browser.storage.session.get(null),browser.privacy.network.networkPredictionEnabled.get({})]).then(arguments[arguments.length-1]);",
    );
    assert.notEqual(cleared[0].levelOfControl, "controlled_by_this_extension");
    assert.notEqual(cleared[1].levelOfControl, "controlled_by_this_extension");
    assert(!JSON.stringify(cleared[2]).includes("synthetic-password"));
    assert.notEqual(cleared[3].levelOfControl, "controlled_by_this_extension");
    record("Disconnect restores settings and clears proxy credentials", {
      networkPrediction: cleared[3],
    });
    connected = await send({ type: "connect", locationId: "local-audit" });
    assert.equal(connected.ok, true, JSON.stringify(connected));
    await extension(
      "fetch(arguments[0]).catch(()=>undefined); arguments[arguments.length-1](true);",
      `${protectedUrl}/delayed-auth`,
    );
    await waitFor(() => Boolean(pendingChallenge), Boolean, "Delayed proxy challenge request");
    assert.equal((await send({ type: "disconnect" })).ok, true);
    const afterDisconnect = received.proxy.length;
    pendingChallenge.writeHead(407, {
      "Proxy-Authenticate": 'Basic realm="delayed-firefox-test"',
      "Content-Length": "0",
    });
    pendingChallenge.end();
    await new Promise((done) => setTimeout(done, 500));
    assert(
      !received.proxy
        .slice(afterDisconnect)
        .some((entry) => entry.path === "/delayed-auth" && entry.authenticated),
    );
    record("Late challenge after disconnect receives no credentials");
    assert.equal((await send({ type: "connect", locationId: "local-audit" })).ok, true);
    assert.equal(await permissions(false), true);
    await openPopup();
    const removed = await send({ type: "connect", locationId: "local-audit" });
    assert.equal(removed.ok, false);
    assert.equal(removed.commandError, "private_browsing_required");
    assert.notEqual(removed.snapshot.status, "connected");
    record("Withdrawn private permission prevents reconnect", { error: removed.commandError });
    assert.equal(await permissions(true, false), true);
    await openPopup();
    const hostsRemoved = await send({ type: "connect", locationId: "local-audit" });
    assert.equal(hostsRemoved.ok, false);
    assert.equal(hostsRemoved.commandError, "host_permissions_required");
    record("Withdrawn host permissions prevent reconnect", { error: hostsRemoved.commandError });
    report.success = true;
  }
} catch (error) {
  report.success = false;
  report.failure = {
    message: webAuthFixture.redact(error.message),
    stack: webAuthFixture.redact(error.stack),
  };
  if (driver) {
    report.failure.runtime = await extension(
      "const done=arguments[arguments.length-1]; Promise.allSettled([browser.permissions.getAll(),browser.extension.isAllowedIncognitoAccess(),browser.declarativeNetRequest.getDynamicRules(),browser.declarativeNetRequest.getSessionRules(),browser.privacy.network.networkPredictionEnabled.get({}),browser.proxy.settings.get({})]).then(done);",
    ).catch(() => null);
    report.failure.console = await privileged(
      "const logs=Services.console.getMessageArray(); arguments[arguments.length-1](logs.slice(-25).map(e=>e.message));",
    )
      .then((logs) => logs?.map((message) => webAuthFixture.redact(message)))
      .catch(() => null);
  }
  process.stderr.write(`${error.stack}\n`);
  process.exitCode = 1;
} finally {
  await driver?.quit().catch(() => undefined);
  for (const socket of sockets) socket.destroy();
  for (const server of [api, proxy, target, tlsTarget]) server?.close();
  // Only this finished run's verified local temporary profile and test key material.
  await rm(assertInsideProject(profile), { recursive: true, force: true });
  for (const filename of ["key.pem", "cert.pem", "ca.pem"])
    await rm(assertInsideProject(join(output, filename)), { force: true });
  report.completedAt = new Date().toISOString();
  report.distUnchanged = JSON.stringify(before) === JSON.stringify(fileHashes(dist));
  report.success &&= report.distUnchanged;
  report.received = received;
  report.legalFixtureRequests = legalFixtureRequests;
  await writeJson(join(output, "report.json"), report);
  process.stdout.write(`Firefox validation evidence: ${output}\n`);
  if (!report.success) process.exitCode = 1;
}
