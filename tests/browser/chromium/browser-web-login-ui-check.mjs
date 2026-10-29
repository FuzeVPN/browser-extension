// SPDX-License-Identifier: MPL-2.0

// Built popup, synthetic worker state and local assets. No OAuth or production request.
import assert from "node:assert/strict";
import { readFile, writeFile, mkdir, mkdtemp } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { resolve, join, extname, relative, isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import { SUPPORTED_LANGUAGES, localeDirectory } from "../../../scripts/supported-locales.mjs";
import {
  inspectDesign,
  inspectKeyboardFocus,
  inspectReducedMotion,
} from "./browser-design-review.mjs";

const root = resolve(import.meta.dirname, "../../..");
const output = resolve(
  process.env.WEB_LOGIN_UI_OUTPUT || (await mkdtemp(join(tmpdir(), "fuzevpn-web-login-ui-"))),
);
const extension = resolve(process.env.CHROME_EXTENSION_DIR || join(root, "dist/chrome"));
const playwright =
  process.env.PLAYWRIGHT_MODULE_PATH ||
  join(
    homedir(),
    ".cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs",
  );
const { chromium } = await import(pathToFileURL(playwright).href);
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_EXECUTABLE,
  headless: true,
  args: ["--disable-background-networking", "--host-resolver-rules=MAP * ~NOTFOUND"],
});
await mkdir(output, { recursive: true });
const report = {
  scope: "Built popup; synthetic web-login runtime; thirty locales; external requests aborted",
  timestamp: new Date().toISOString(),
  chromium: browser.version(),
  checks: [],
  pageErrors: [],
  blockedRequests: [],
  design: { screenshots: [], measurements: [] },
};
const context = await browser.newContext({ viewport: { width: 360, height: 600 } });
await context.route("**/*", async (route) => {
  const url = new URL(route.request().url());
  if (url.origin !== "https://popup.invalid") {
    report.blockedRequests.push(url.origin);
    return route.abort();
  }
  const file = resolve(extension, `.${decodeURIComponent(url.pathname)}`);
  const local = relative(extension, file);
  if (local.startsWith("..") || isAbsolute(local)) return route.abort();
  const contentType = {
    ".html": "text/html",
    ".js": "text/javascript",
    ".css": "text/css",
    ".json": "application/json",
    ".svg": "image/svg+xml",
    ".woff2": "font/woff2",
  }[extname(file)];
  try {
    return await route.fulfill({ body: await readFile(file), contentType });
  } catch {
    return route.fulfill({ status: 404, body: "Missing local asset" });
  }
});
const policy = { revision: 0, enabled: false, entries: [] };
const signedOut = {
  snapshotVersion: { workerId: "web-login-ui-fixture", revision: 1 },
  logoutOutcome: null,
  webLoginPending: false,
  siteExclusions: { saved: policy, applied: policy, pending: false, error: false },
  blockingScope: "none",
  network: {
    status: "unavailable",
    mode: null,
    ip: null,
    checkedAt: null,
    latencyMs: null,
    locationId: null,
  },
  locationPreferences: {
    favoriteIds: [],
    recentIds: [],
    automatic: false,
    recommendedLocationId: null,
  },
  languagePreference: "fr",
  effectiveLanguage: "fr",
  status: "logged_out",
  protected: false,
  profile: null,
  subscription: null,
  locations: [],
  devices: [],
  deviceLimit: null,
  currentDeviceId: null,
  selectedLocationId: null,
  activeLocationId: null,
  activeLocation: null,
  autoConnect: false,
  error: null,
  retryAfterSeconds: null,
  securityPreferences: { killSwitchEnabled: true, webRtcProtectionEnabled: true },
  protectionRequested: false,
  trafficBlocked: false,
  webRtcProtected: false,
  nextRetryAt: null,
};
const errors = [
  "web_login_cancelled",
  "web_login_timeout",
  "web_login_unavailable",
  "web_login_invalid_callback",
  "web_login_denied",
  "web_login_busy",
];
const check = (name, details = {}) => report.checks.push({ name, passed: true, ...details });
async function open(language = "fr", patch = {}) {
  const catalog = JSON.parse(
    await readFile(join(extension, "_locales", localeDirectory(language), "messages.json"), "utf8"),
  );
  const page = await context.newPage();
  page.on("pageerror", (error) => report.pageErrors.push(error.message));
  await page.addInitScript(
    ({ language, catalog, initial }) => {
      const listeners = [];
      window.fixture = {
        snapshot: structuredClone(initial),
        requests: [],
        held: null,
        publish(patch) {
          Object.assign(this.snapshot, patch);
          ++this.snapshot.snapshotVersion.revision;
          for (const listener of listeners)
            listener({ type: "state_changed", snapshot: structuredClone(this.snapshot) });
        },
        finish(error = null, profile = null) {
          this.publish({
            webLoginPending: false,
            error,
            profile,
            status: profile ? "disconnected" : "logged_out",
          });
          const resolve = this.held;
          this.held = null;
          resolve?.({ ok: !error, snapshot: structuredClone(this.snapshot) });
        },
      };
      window.chrome = {
        i18n: {
          getUILanguage: () => language,
          getMessage: (key, values = []) =>
            (catalog[key]?.message ?? key).replace(/\$([1-9])/g, (_, i) => values[i - 1] ?? ""),
        },
        runtime: {
          getURL: (path) => `https://popup.invalid/${path}`,
          onMessage: { addListener: (listener) => listeners.push(listener) },
          async sendMessage(request) {
            const f = window.fixture;
            f.requests.push(structuredClone(request));
            if (request.type === "diagnostics_state")
              return {
                diagnosticsVersion: 1,
                ok: true,
                state: {
                  version: 1,
                  workerId: "diagnostics-fixture",
                  accountEpoch: 0,
                  revision: 1,
                  language,
                  signedIn: false,
                  autoReporting: false,
                  preparing: false,
                  historyCount: 0,
                  connectionHistoryCount: 0,
                  reports: [],
                },
              };
            if (request.type === "web_login") {
              f.publish({ webLoginPending: true, error: null });
              return new Promise((resolve) => {
                f.held = resolve;
              });
            }
            return { ok: true, snapshot: structuredClone(f.snapshot) };
          },
        },
      };
    },
    {
      language,
      catalog,
      initial: {
        ...structuredClone(signedOut),
        ...patch,
        languagePreference: language,
        effectiveLanguage: language,
      },
    },
  );
  await page.goto("https://popup.invalid/popup/popup.html");
  await page.waitForFunction(
    ({ language, pending, disconnect }) => {
      const form = document.getElementById("loginForm");
      return (
        document.documentElement.lang === language &&
        form.dataset.pending === String(pending) &&
        form.dataset.disconnect === String(disconnect)
      );
    },
    {
      language,
      pending: patch.webLoginPending === true,
      disconnect: Boolean(patch.trafficBlocked || patch.protectionRequested || patch.protected),
    },
  );
  await page.evaluate(() => document.fonts.ready);
  return { page, catalog };
}
async function capture(page, language, state, selectors) {
  const measurement = await inspectDesign(page, selectors);
  report.design.measurements.push({ language, state, ...measurement });
  const file = `web-login-${localeDirectory(language)}-${state}.png`;
  await page.screenshot({ path: join(output, file), fullPage: true });
  report.design.screenshots.push({ language, state, file });
}
const designText = [
  "#loginView h1",
  "#loginView .intro .muted",
  "#webLoginHelp",
  "#loginButton",
  "#webLoginStatus",
  "#loginPrivacyLink",
];
try {
  for (const language of SUPPORTED_LANGUAGES) {
    let { page, catalog } = await open(language);
    assert.equal(await page.locator("#loginView").isVisible(), true);
    assert.equal(await page.locator("#loginForm button").count(), 1);
    assert.equal(
      await page.locator("input[type=password], input[type=email], #email, #password").count(),
      0,
    );
    assert.equal(
      await page.locator("#webLoginButtonLabel").textContent(),
      catalog.webSignIn.message,
    );
    assert.equal(await page.locator("#webLoginHelp").textContent(), catalog.webSignInHelp.message);
    assert.equal(await page.locator("#loginButton").isDisabled(), false);
    assert.equal(await page.locator("#webLoginStatus").isVisible(), false);
    assert.equal(await page.locator("#loginPrivacyLink").isVisible(), true);
    assert.equal(
      await page.locator("html").getAttribute("dir"),
      ["ar", "fa", "ur"].includes(language) ? "rtl" : "ltr",
    );
    await capture(page, language, "ready", {
      text: designText,
      controls: ["#settingsButton", "#loginButton", "#loginPrivacyLink"],
      primary: ["#loginButton"],
      inView: ["#loginButton"],
    });
    check(`Single web sign-in, no credentials and accessible layout in ${language}`);

    await page.keyboard.press("Tab");
    assert.equal(await page.evaluate(() => document.activeElement.id), "settingsButton");
    await page.keyboard.press("Tab");
    assert.equal(await page.evaluate(() => document.activeElement.id), "loginButton");
    const focus = await inspectKeyboardFocus(page);
    check(`Keyboard focus reaches the single sign-in action in ${language}`, { focus });
    await page.close();

    ({ page, catalog } = await open(language, { webLoginPending: true, status: "connecting" }));
    assert.equal(await page.locator("#loginButton").isDisabled(), true);
    assert.equal(await page.locator("#loginForm").getAttribute("aria-busy"), "true");
    assert.equal(
      await page.locator("#webLoginButtonLabel").textContent(),
      catalog.webSignInPending.message,
    );
    assert.equal(
      await page.locator("#webLoginStatus").textContent(),
      catalog.webSignInStatus.message,
    );
    assert.equal(await page.locator("#webLoginStatus").isVisible(), true);
    await capture(page, language, "pending", { text: designText, inView: ["#loginButton"] });
    check(`Restored sign-in pending state is visible in ${language}`);
    for (const error of errors) {
      await page.evaluate(
        (error) => window.fixture.publish({ webLoginPending: false, error }),
        error,
      );
      await page.waitForFunction(
        (expected) => document.getElementById("loginErrorMessage").textContent === expected,
        catalog[`error_${error}`].message,
      );
      assert.equal(await page.locator("#loginErrorBanner").isVisible(), true);
      assert.equal(await page.locator("#loginButton").isDisabled(), false);
      assert.equal(await page.locator("#webLoginStatus").isVisible(), false);
    }
    check(
      `Cancellation, timeout, unavailable, invalid, denied and busy errors are localized in ${language}`,
    );
    await page.close();

    ({ page, catalog } = await open(language, {
      status: "blocked",
      trafficBlocked: true,
      protectionRequested: true,
      blockingScope: "all",
      error: "unauthorized",
    }));
    assert.equal(
      await page.locator("#webLoginButtonLabel").textContent(),
      catalog.webSignInDisconnect.message,
    );
    assert.equal(
      await page.locator("#webLoginHelp").textContent(),
      catalog.webSignInDisconnectHelp.message,
    );
    assert.equal(await page.locator("#recoveryPanel").isVisible(), true);
    const before = await page.evaluate(() => window.fixture.requests.length);
    await page.locator("#retryButton").click();
    assert.equal(await page.evaluate(() => document.activeElement.id), "loginButton");
    assert.equal(await page.evaluate(() => window.fixture.requests.length), before);
    await capture(page, language, "disconnect-required", {
      text: [...designText, "#recoveryStatus"],
      primary: ["#loginButton"],
    });
    check(`Recovery requires explicit consent and does not disconnect on focus in ${language}`);
    await page.close();
  }

  let { page } = await open("fr");
  await page.locator("#loginButton").click();
  await page.waitForFunction(() => window.fixture.held !== null);
  await page.evaluate(() => {
    document.getElementById("loginForm").dispatchEvent(new Event("submit", { cancelable: true }));
    document.getElementById("loginButton").click();
  });
  assert.deepEqual(
    await page.evaluate(() =>
      window.fixture.requests.filter((request) => request.type === "web_login"),
    ),
    [{ type: "web_login", disconnectFirst: false }],
  );
  const pendingSnapshot = await page.evaluate(() => window.fixture.snapshot);
  await page.close();
  ({ page } = await open("fr", pendingSnapshot));
  assert.equal(await page.locator("#loginButton").isDisabled(), true);
  assert.equal(await page.locator("#webLoginStatus").isVisible(), true);
  await inspectReducedMotion(page);
  await page.evaluate(() =>
    window.fixture.publish({ webLoginPending: false, error: "web_login_cancelled" }),
  );
  await page.waitForFunction(() => !document.getElementById("loginButton").disabled);
  assert.equal(await page.locator("#loginForm").getAttribute("aria-busy"), "false");
  check(
    "Double submission starts one flow; reopening restores pending state; cancellation re-enables sign-in; reduced motion is respected",
  );
  await page.close();

  for (const patch of [
    { trafficBlocked: true },
    { protectionRequested: true },
    { protected: true },
  ]) {
    ({ page } = await open("fr", patch));
    await page.locator("#loginButton").click();
    await page.waitForFunction(() => window.fixture.held !== null);
    assert.deepEqual(
      await page.evaluate(() =>
        window.fixture.requests.filter((request) => request.type === "web_login"),
      ),
      [{ type: "web_login", disconnectFirst: true }],
    );
    await page.close();
  }
  check(
    "Blocked traffic, requested protection and active protection each require explicit disconnectFirst consent",
  );

  ({ page } = await open("fr", { status: "connecting", webLoginPending: false }));
  assert.equal(await page.locator("#loginButton").isDisabled(), false);
  assert.equal(await page.locator("#webLoginStatus").isVisible(), false);
  check("Proxy connection status alone is not misrepresented as a pending web sign-in");
  await page.close();

  for (const patch of [{ error: "storage_unavailable" }, { status: "disconnecting" }]) {
    ({ page } = await open("fr", patch));
    assert.equal(await page.locator("#loginButton").isDisabled(), true);
    await page.evaluate(() =>
      document.getElementById("loginForm").dispatchEvent(new Event("submit", { cancelable: true })),
    );
    assert.equal(
      await page.evaluate(() =>
        window.fixture.requests.some((request) => request.type === "web_login"),
      ),
      false,
    );
    await page.close();
  }
  check("Storage failure and an active disconnect prevent premature web sign-in");

  ({ page } = await open("fr"));
  let releaseCatalog;
  let catalogRequested;
  const catalogHeld = new Promise((resolve) => {
    releaseCatalog = resolve;
  });
  const catalogStarted = new Promise((resolve) => {
    catalogRequested = resolve;
  });
  await page.route("**/_locales/ar/messages.json", async (route) => {
    catalogRequested();
    await catalogHeld;
    await route.fulfill({
      body: await readFile(join(extension, "_locales/ar/messages.json")),
      contentType: "application/json",
    });
  });
  await page.evaluate(() =>
    window.fixture.publish({
      trafficBlocked: true,
      protectionRequested: true,
      languagePreference: "ar",
      effectiveLanguage: "ar",
    }),
  );
  await catalogStarted;
  await page.locator("#loginButton").click();
  assert.equal(
    await page.evaluate(() =>
      window.fixture.requests.some((request) => request.type === "web_login"),
    ),
    false,
  );
  assert.equal(await page.locator("#loginForm").getAttribute("data-disconnect"), "true");
  releaseCatalog();
  await page.waitForFunction(() => document.documentElement.lang === "ar");
  await page.locator("#loginButton").click();
  await page.waitForFunction(() => window.fixture.held !== null);
  assert.deepEqual(
    await page.evaluate(() =>
      window.fixture.requests.filter((request) => request.type === "web_login"),
    ),
    [{ type: "web_login", disconnectFirst: true }],
  );
  check(
    "An account-state change during a delayed translation displays the disconnection warning before accepting consent",
  );
  await page.close();

  ({ page } = await open("fr"));
  await page.locator("#loginButton").click();
  await page.waitForFunction(() => window.fixture.held !== null);
  await page.evaluate(() => window.fixture.finish("web_login_timeout"));
  await page.waitForFunction(() => !document.getElementById("loginButton").disabled);
  assert.equal(await page.locator("#loginForm").getAttribute("aria-busy"), "false");
  assert.equal(await page.locator("#loginErrorBanner").isVisible(), true);
  await page.locator("#loginButton").click();
  await page.waitForFunction(() => window.fixture.held !== null);
  await page.evaluate(() =>
    window.fixture.finish(null, {
      userId: "synthetic-google-user",
      email: "google-user@example.invalid",
      firstName: "Synthetic",
      lastName: "User",
      countryCode: "FR",
    }),
  );
  await page.locator("#mainView").waitFor({ state: "visible" });
  assert.equal(await page.locator("#loginView").isVisible(), false);
  assert.equal(await page.locator("#accountEmail").textContent(), "google-user@example.invalid");
  assert.equal(await page.locator("input[type=password], input[type=email]").count(), 0);
  check(
    "A timed-out flow permits another attempt and successful web sign-in renders the account without a password field",
  );
  await page.close();
  assert.deepEqual(report.pageErrors, []);
  assert.deepEqual(report.blockedRequests, []);
  report.completed = true;
} catch (error) {
  report.failure = String(error.stack ?? error);
  process.exitCode = 1;
} finally {
  await browser.close();
  await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2) + "\n");
  process.stdout.write(JSON.stringify(report, null, 2));
}
