// SPDX-License-Identifier: MPL-2.0

// Isolated UI regression: current popup, synthetic web-auth command with the 0.4.1 snapshot schema.
// Usage: node <this-file> [--expect-broken]. CHROME_EXTENSION_DIR overrides dist.
import assert from "node:assert/strict";
import { cp, mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = resolve(import.meta.dirname, "../../..");
const expectBroken = process.argv.includes("--expect-broken");
const runName = `${expectBroken ? "before" : "after"}-${Date.now()}`;
const output = resolve(
  process.env.LEGACY_WORKER_OUTPUT ?? join(root, "security-audit/legacy-worker", runName),
);
await mkdir(output, { recursive: true });
const scratch = join(root, "node_modules/.cache/hotfix-diagnostics", runName);
await mkdir(scratch, { recursive: true });
const extension = join(scratch, "extension");
await cp(resolve(process.env.CHROME_EXTENSION_DIR ?? join(root, "dist/chrome")), extension, {
  recursive: true,
});
const fixture = {
  languagePreference: "en",
  effectiveLanguage: "en",
  status: "connected",
  protected: true,
  profile: {
    userId: "synthetic-legacy-user",
    email: "legacy@example.invalid",
    firstName: "Legacy",
    lastName: "Fixture",
    countryCode: "FR",
  },
  subscription: {
    status: "active",
    hasAccess: true,
    offerId: "synthetic",
    startedAt: null,
    expiresAt: null,
    renewsAutomatically: false,
  },
  locations: [
    {
      id: "legacy-fr",
      city: "Paris",
      countryCode: "FR",
      displayName: "Paris synthetic",
      supportedProtocols: ["browser_proxy"],
    },
  ],
  devices: [],
  deviceLimit: 5,
  currentDeviceId: "legacy-browser",
  selectedLocationId: "legacy-fr",
  activeLocationId: "legacy-fr",
  autoConnect: false,
  error: null,
  retryAfterSeconds: null,
  securityPreferences: { killSwitchEnabled: true, webRtcProtectionEnabled: true },
  protectionRequested: true,
  trafficBlocked: false,
  webRtcProtected: true,
  nextRetryAt: null,
  network: {
    status: "ready",
    mode: "vpn",
    ip: "185.159.157.10",
    checkedAt: Date.now(),
    latencyMs: 20,
    locationId: "legacy-fr",
  },
  locationPreferences: {
    favoriteIds: [],
    recentIds: ["legacy-fr"],
    automatic: false,
    recommendedLocationId: "legacy-fr",
  },
};
await writeFile(
  join(extension, "background/service-worker.js"),
  `
const initial = ${JSON.stringify(fixture)};
let snapshot = structuredClone(initial);
let invalidLogin = true;
globalThis.fixtureCommands = [];
globalThis.fixtureSnapshot = () => structuredClone(snapshot);
globalThis.fixturePublish = async (change) => {
  snapshot = { ...snapshot, ...change };
  await chrome.runtime.sendMessage({ type: "state_changed", snapshot }).catch(() => {});
};
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (message.type === "state_changed") return false;
  fixtureCommands.push(message.type);
  if (message.type === ${JSON.stringify(expectBroken ? "login" : "web_login")}) {
    if (invalidLogin) snapshot = { ...snapshot, profile: null, status: "logged_out", error: ${JSON.stringify(expectBroken ? "invalid_credentials" : "web_login_denied")} };
    else snapshot = structuredClone(initial);
  }
  if (message.type === "fixture_valid_login") invalidLogin = false;
  if (message.type === "refresh_devices") snapshot.devices = [{ deviceId: "legacy-browser", name: "Synthetic legacy browser", kind: "browser_extension", createdAt: "2026-01-02T12:00:00.000Z", profiles: [] }];
  if (message.type === "disconnect") snapshot = { ...snapshot, status: "disconnected", protected: false, protectionRequested: false, activeLocationId: null, network: { ...snapshot.network, mode: "direct", locationId: null, ip: "81.2.69.142" } };
  if (message.type === "logout") snapshot = { ...snapshot, status: "logged_out", profile: null, protected: false, protectionRequested: false, error: null };
  reply({ ok: !snapshot.error, snapshot });
  return false;
});
`,
);
const playwrightPath =
  process.env.PLAYWRIGHT_MODULE_PATH ??
  join(
    homedir(),
    ".cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs",
  );
const { chromium } = await import(pathToFileURL(resolve(playwrightPath)).href);
const report = {
  timestamp: new Date().toISOString(),
  mode: expectBroken ? "reproduce" : "regression",
  scope:
    "Synthetic 0.4.1 snapshot schema with web-auth command, built popup, fresh Chromium profile, no production traffic or account; does not claim an old worker supports web-auth",
  checks: [],
  pageErrors: [],
  commands: [],
};
let context;
function pass(name) {
  report.checks.push({ name, passed: true });
  process.stdout.write(`PASS ${name}\n`);
}
try {
  context = await chromium.launchPersistentContext(join(scratch, "profile"), {
    channel: "chromium",
    headless: true,
    executablePath:
      process.env.CHROMIUM_EXECUTABLE ??
      join(homedir(), "AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe"),
    viewport: { width: 360, height: 600 },
    args: [
      `--disable-extensions-except=${extension}`,
      `--load-extension=${extension}`,
      "--host-resolver-rules=MAP * ~NOTFOUND",
      "--disable-background-networking",
    ],
  });
  await context.route("**/*", (route) =>
    new URL(route.request().url()).protocol === "chrome-extension:"
      ? route.continue()
      : route.abort(),
  );
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
  const page = await context.newPage();
  page.on("pageerror", (error) => report.pageErrors.push(String(error)));
  await page.goto(`chrome-extension://${new URL(worker.url()).host}/popup/popup.html`);
  await page.waitForFunction(() => document.documentElement.lang === "en");
  if (expectBroken) {
    await page.waitForTimeout(300);
    assert(
      report.pageErrors.some((error) => /undefined.*applied|applied.*undefined/.test(error)),
      JSON.stringify(report.pageErrors),
    );
    assert(await page.locator("#loginView").isVisible());
    assert(!(await page.locator("#mainView").isVisible()));
    pass("Connected legacy snapshot crashes before login/main view selection (reading applied)");
    await page.locator("#settingsButton").click();
    assert(await page.locator("#logoutButton").isVisible());
    await page.locator("#manageDevicesButton").click();
    await page.waitForTimeout(150);
    assert.equal(await page.locator("#deviceList .device-item").count(), 0);
    assert((await worker.evaluate(() => fixtureCommands)).includes("refresh_devices"));
    pass("Disconnect account action remains visible and successful device response cannot render");
    await page.screenshot({ path: join(output, "broken-devices.png"), fullPage: true });
    await page.locator("#closeDevicesButton").click();
    await page.locator("#closeSettingsButton").click();
    await page.locator("#email").fill("legacy@example.invalid");
    await page.locator("#password").fill("synthetic-password");
    await page.locator("#loginButton").click();
    await page.waitForTimeout(150);
    assert(await page.locator("#loginErrorBanner").isHidden());
    pass("Invalid login response has no visible feedback because rendering throws again");
    await page.screenshot({ path: join(output, "broken-login.png"), fullPage: true });
  } else {
    await page.locator("#mainView").waitFor({ state: "visible" });
    assert(await page.locator("#loginView").isHidden());
    assert.equal(await page.locator("#publicIp").textContent(), "VPN IP · 185.159.157.10");
    assert((await page.locator("#statusOrb").getAttribute("class")).includes("connected"));
    pass(
      "Existing authenticated connection, green indicator and VPN IPv4 render from legacy response",
    );
    await page.locator("#settingsButton").click();
    assert(await page.locator("#logoutButton").isVisible());
    assert(await page.locator("#manageExclusionsButton").isDisabled());
    assert.match(await page.locator("#exclusionsSummary").textContent(), /reload|update/i);
    await page.locator("#manageExclusionsButton").evaluate((node) => node.click());
    assert(!(await page.locator("#exclusionsDialog").evaluate((node) => node.open)));
    assert(
      !(await worker.evaluate(() => fixtureCommands)).some((type) =>
        type.includes("site_exclusions"),
      ),
    );
    pass(
      "Unsupported site exclusions stay disabled with reload guidance and no new worker command",
    );
    await page.locator("#manageDevicesButton").click();
    await page.locator("#deviceList .device-item").waitFor();
    assert.match(await page.locator("#deviceList").textContent(), /Synthetic legacy browser/);
    pass("Device refresh renders its result with the legacy worker schema");
    await page.locator("#closeDevicesButton").click();
    await page.locator("#closeSettingsButton").click();
    await worker.evaluate(() =>
      fixturePublish({
        status: "disconnected",
        protected: false,
        protectionRequested: false,
        activeLocationId: null,
        network: {
          status: "ready",
          mode: "direct",
          ip: "81.2.69.142",
          checkedAt: Date.now(),
          latencyMs: 10,
          locationId: null,
        },
      }),
    );
    await page.waitForFunction(
      () => document.getElementById("publicIp").textContent === "Public IP · 81.2.69.142",
    );
    assert(await page.locator("#mainView").isVisible());
    pass("Legacy state_changed messages update the authenticated view and direct IP");
    await worker.evaluate(() => fixturePublish({ status: "logged_out", profile: null }));
    await page.locator("#loginView").waitFor({ state: "visible" });
    assert.equal(await page.locator("#email, #password").count(), 0);
    await page.locator("#loginButton").click();
    await page.locator("#loginErrorBanner").waitFor({ state: "visible" });
    assert((await page.locator("#loginErrorMessage").textContent()).length > 10);
    assert.equal(await page.locator("#loginButton").isDisabled(), false);
    pass(
      "Rejected web-auth with a legacy snapshot schema produces visible feedback and releases the button",
    );
    await page.evaluate(() => chrome.runtime.sendMessage({ type: "fixture_valid_login" }));
    await page.locator("#loginButton").click();
    await page.locator("#mainView").waitFor({ state: "visible" });
    assert.equal(await page.locator("#publicIp").textContent(), "VPN IP · 185.159.157.10");
    pass("Successful web-auth remains usable with the legacy snapshot schema");

    const emptyPolicy = { revision: 0, enabled: false, entries: [] };
    await worker.evaluate(
      (state) => fixturePublish({ siteExclusions: state, blockingScope: "none" }),
      {
        saved: emptyPolicy,
        applied: emptyPolicy,
        pending: false,
        error: false,
      },
    );
    await page.locator("#settingsButton").click();
    await page.waitForFunction(() => !document.getElementById("manageExclusionsButton").disabled);
    await page.locator("#manageExclusionsButton").click();
    await page.locator("#exclusionsDialog").waitFor({ state: "visible" });
    pass(
      "A subsequent current-worker snapshot enables site exclusions without reopening the popup",
    );
    await page.locator("#closeExclusionsButton").click();
    await page.locator("#closeSettingsButton").click();

    for (const failure of ["undefined", "malformed", "transport"]) {
      await worker.evaluate(() =>
        fixturePublish({
          status: "logged_out",
          profile: null,
          protected: false,
          protectionRequested: false,
          error: null,
        }),
      );
      await page.locator("#loginView").waitFor({ state: "visible" });
      await page.evaluate((mode) => {
        const send = chrome.runtime.sendMessage.bind(chrome.runtime);
        chrome.runtime.sendMessage = (value, ...args) => {
          if (value.type !== "web_login") return send(value, ...args);
          if (mode === "transport")
            return Promise.reject(new Error("Synthetic closed message port"));
          return Promise.resolve(mode === "undefined" ? undefined : { ok: true, snapshot: {} });
        };
        globalThis.restoreFixtureTransport = () => {
          chrome.runtime.sendMessage = send;
        };
      }, failure);
      await page.locator("#loginButton").click();
      await page.locator("#loginErrorBanner").waitFor({ state: "visible" });
      assert.match(
        await page.locator("#loginErrorMessage").textContent(),
        /extension|reload|respond/i,
      );
      assert.equal(await page.locator("#loginButton").isDisabled(), true);
      await page.evaluate(() => restoreFixtureTransport());
      await worker.evaluate(() => fixturePublish({ error: null }));
      await page.waitForFunction(() => !document.getElementById("loginButton").disabled);
      pass(
        `${failure} web-auth response blocks another attempt until a verified snapshot restores communication`,
      );
    }
    await page.locator("#loginButton").click();
    await page.locator("#mainView").waitFor({ state: "visible" });
    await page.evaluate(() => {
      const send = chrome.runtime.sendMessage.bind(chrome.runtime);
      chrome.runtime.sendMessage = (value, ...args) =>
        value.type === "refresh_devices"
          ? Promise.reject(new Error("Synthetic device message port closed"))
          : send(value, ...args);
      globalThis.restoreFixtureTransport = () => {
        chrome.runtime.sendMessage = send;
      };
    });
    await page.locator("#settingsButton").click();
    await page.locator("#manageDevicesButton").click();
    await page.locator("#errorBanner").waitFor({ state: "visible" });
    assert.match(await page.locator("#errorMessage").textContent(), /extension|reload|respond/i);
    assert(await page.locator("#mainView").isVisible());
    assert.equal(await page.locator("#refreshDevicesButton").isDisabled(), false);
    await page.evaluate(() => restoreFixtureTransport());
    pass(
      "Device transport failure shows feedback without presenting an authenticated account as logged out",
    );
    assert.equal(report.pageErrors.length, 0, JSON.stringify(report.pageErrors));
    pass("No popup JavaScript errors across initial response, refresh, broadcasts or login");
    await page.screenshot({ path: join(output, "legacy-connected-fixed.png"), fullPage: true });
  }
  report.commands = await worker.evaluate(() => fixtureCommands);
} catch (error) {
  report.failure = String(error?.stack ?? error);
  process.exitCode = 1;
} finally {
  await context?.close();
  await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2));
  process.stdout.write(`Report: ${join(output, "report.json")}\n`);
  if (report.failure) process.stderr.write(report.failure + "\n");
}
