// SPDX-License-Identifier: MPL-2.0

// Built extension beside a second extension which really takes, then gives back, the
// proxy of the browser; all server data is synthetic.
// Optional: CHROME_EXTENSION_DIR, PLAYWRIGHT_MODULE_PATH, CHROMIUM_EXECUTABLE,
// PROXY_CONFLICT_OUTPUT. No production connection or credentials are used.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { waitForRead } from "../../../scripts/browser-wait.mjs";
import { reportErrorEvents } from "./page-error-events.mjs";
import { installSyntheticWebAuth, assertSyntheticTokenRequest } from "./synthetic-web-auth.mjs";

const root = resolve(import.meta.dirname, "../../..");
const playwright =
  process.env.PLAYWRIGHT_MODULE_PATH ??
  join(
    homedir(),
    ".cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs",
  );
const { chromium } = await import(pathToFileURL(resolve(playwright)).href);
const temporary = await mkdtemp(join(tmpdir(), "proxy-conflict-"));
const output = resolve(process.env.PROXY_CONFLICT_OUTPUT ?? temporary);
await mkdir(output, { recursive: true });
const extension = resolve(process.env.CHROME_EXTENSION_DIR ?? join(root, "dist/chrome"));
const french = JSON.parse(await readFile(join(extension, "_locales/fr/messages.json"), "utf8"));
const report = {
  timestamp: new Date().toISOString(),
  scope:
    "Built worker and popup beside a second extension which sets the proxy; isolated Chromium profile; intercepted synthetic API only",
  limitations: [
    "No production account or traffic tunnel is validated.",
    "Which of two extensions the browser lets set the proxy is the browser's rule: the suite observes that the second one holds it here, and does not establish that rule.",
  ],
  checks: [],
  pageErrors: [],
};
const location = {
  id: "conflict-fr",
  city: "Paris",
  country_code: "FR",
  display_name: "Paris conflict fixture",
  supported_protocols: ["browser_proxy"],
};
let sessions = 0;
let context;

function record(name, details) {
  report.checks.push({ name, passed: true, ...(details === undefined ? {} : { details }) });
  process.stdout.write(`PASS ${name}\n`);
}
async function reply(route, status, body) {
  await route.fulfill({
    status,
    ...(body === undefined ? {} : { contentType: "application/json", body: JSON.stringify(body) }),
  });
}
async function command(page, request) {
  if (request.type === "web_login") await installSyntheticWebAuth(context);
  return page.evaluate((value) => chrome.runtime.sendMessage(value), request);
}
async function snapshot(page) {
  return (await command(page, { type: "get_snapshot" })).snapshot;
}
/** Who the browser says holds its proxy, read from the extension itself. */
function controlLevel(page) {
  return page.evaluate(
    () =>
      new Promise((done) =>
        chrome.proxy.settings.get({}, (details) => done(details.levelOfControl)),
      ),
  );
}
function blockingRules(page) {
  return page.evaluate(async () =>
    [
      ...(await chrome.declarativeNetRequest.getDynamicRules()),
      ...(await chrome.declarativeNetRequest.getSessionRules()),
    ]
      .filter((rule) => rule.action.type === "block")
      .map((rule) => rule.id),
  );
}
/** What the popup shows of the recovery panel. */
function view(page) {
  return page.evaluate(() => {
    const at = (id) => document.getElementById(id);
    const shown = (node) => node.getClientRects().length > 0;
    const why = at("recoveryWhy");
    const summary = why.querySelector("summary");
    const answer = why.querySelector("p");
    return {
      panel: shown(at("recoveryPanel")),
      banner: shown(at("errorBanner")),
      title: at("recoveryStatus").textContent,
      help: at("recoveryHelp").textContent,
      why: shown(why),
      open: why.open,
      question: summary.textContent,
      answer: answer.textContent,
      // A closed disclosure keeps the boxes of its text: only `checkVisibility` tells it hidden.
      answerShown: answer.checkVisibility(),
      fit: document.querySelector(".shell").dataset.fit ?? "0",
      added: why.getBoundingClientRect().height - summary.getBoundingClientRect().height,
      actionsTop: at("retryButton").getBoundingClientRect().top + scrollY,
    };
  });
}
const held = (value) => value.error === "proxy_controlled_by_extension" && !value.protected;

try {
  const rival = join(temporary, "rival");
  await mkdir(rival, { recursive: true });
  await writeFile(
    join(rival, "manifest.json"),
    `${JSON.stringify(
      {
        manifest_version: 3,
        name: "Proxy rival (validation fixture)",
        version: "1.0.0",
        permissions: ["proxy"],
        background: { service_worker: "worker.js" },
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(join(rival, "worker.js"), "chrome.runtime.onInstalled.addListener(() => {});\n");
  await writeFile(join(rival, "page.html"), "<!doctype html><title>Proxy rival</title>\n");

  context = await chromium.launchPersistentContext(join(temporary, "profile"), {
    channel: "chromium",
    headless: true,
    viewport: { width: 360, height: 600 },
    ...(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : {}),
    args: [
      `--disable-extensions-except=${extension},${rival}`,
      `--load-extension=${extension},${rival}`,
      "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1, EXCLUDE [::1]",
      "--disable-background-networking",
    ],
  });
  context.setDefaultTimeout(15000);
  report.chromium = context.browser().version();
  await context.route(/^https?:\/\//, (route) => route.abort("blockedbyclient"));
  await context.route(/^https:\/\/api(?:64)?\.ipify\.org\//, (route) =>
    reply(route, 200, { ip: "203.0.113.8" }),
  );
  await context.route("https://api.fuzevpn.com/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    const method = route.request().method();
    if (path === "/v1/auth/extension/token") {
      await assertSyntheticTokenRequest(context, route.request());
      return reply(route, 201, {
        access_token: "synthetic-conflict-token",
        expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      });
    }
    if (path === "/v1/me")
      return reply(route, 200, {
        user_id: "conflict-user",
        email: "conflict@example.invalid",
        first_name: "Conflict",
        last_name: "Fixture",
        country_code: "FR",
      });
    if (path === "/v1/billing/subscription")
      return reply(route, 200, {
        status: "active",
        has_access: true,
        offer_id: "synthetic",
        started_at: null,
        expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        renews_automatically: false,
      });
    if (path === "/v1/locations") return reply(route, 200, { locations: [location] });
    if (path === "/v1/devices/browser") {
      const body = route.request().postDataJSON();
      return reply(route, 201, {
        device_id: "conflict-device",
        name: body.name,
        kind: "browser_extension",
        created_at: new Date().toISOString(),
      });
    }
    if (path === "/v1/devices") return reply(route, 200, { limit: 5, devices: [] });
    if (path === "/v1/proxy/sessions" && method === "POST") {
      const id = `conflict-session-${String(++sessions)}`;
      return reply(route, 201, {
        id,
        location_id: location.id,
        scheme: "https",
        host: "synthetic.conflict.proxy.invalid",
        port: 443,
        username: id,
        password: "synthetic-proxy-password",
        issued_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 1_200_000).toISOString(),
        refresh_after_seconds: 900,
      });
    }
    if (
      path === "/v1/auth/logout" ||
      (path.startsWith("/v1/proxy/sessions/") && method === "DELETE")
    )
      return reply(route, 204);
    return reply(route, 404, { error: "not_found" });
  });

  const workers = await waitForRead(
    () => context.serviceWorkers().map((worker) => worker.url()),
    (urls) => urls.length === 2,
    { message: "the workers of the two extensions" },
  );
  const own = workers.find((url) => url.endsWith("/background/service-worker.js"));
  const other = workers.find((url) => url.endsWith("/worker.js"));
  assert(own && other, JSON.stringify(workers));
  // The address of an extension has no origin a URL parser tells: its first three parts.
  const home = (url) => url.split("/").slice(0, 3).join("/");
  const page = await context.newPage();
  page.on("pageerror", (error) => report.pageErrors.push(error.message));
  await reportErrorEvents(page, (message) => report.pageErrors.push(message));
  await page.goto(`${home(own)}/popup/popup.html`);
  const rivalPage = await context.newPage();
  await rivalPage.goto(`${home(other)}/page.html`);
  const rivalTakes = () =>
    rivalPage.evaluate(
      () =>
        new Promise((done) =>
          chrome.proxy.settings.set(
            {
              value: {
                mode: "pac_script",
                pacScript: {
                  data: "function FindProxyForURL(url, host) { return 'DIRECT'; }",
                },
              },
              scope: "regular",
            },
            () => done(chrome.runtime.lastError?.message ?? null),
          ),
        ),
    );
  const rivalGivesBack = () =>
    rivalPage.evaluate(
      () =>
        new Promise((done) =>
          chrome.proxy.settings.clear({ scope: "regular" }, () =>
            done(chrome.runtime.lastError?.message ?? null),
          ),
        ),
    );

  assert.equal((await command(page, { type: "web_login", disconnectFirst: false })).ok, true);
  await page.locator("#mainView").waitFor({ state: "visible" });
  assert.equal(
    (await command(page, { type: "set_language_preference", preference: "fr" })).ok,
    true,
  );
  await page.waitForFunction(() => document.documentElement.lang === "fr");
  const connected = await command(page, { type: "connect", locationId: location.id });
  assert.equal(connected.ok, true, JSON.stringify(connected));
  assert.equal(connected.snapshot.protected, true);
  assert.equal(await controlLevel(page), "controlled_by_this_extension");
  assert.equal((await view(page)).panel, false);
  record("Connected beside another extension which sets no proxy");

  // The other extension sets a proxy of its own: the browser gives it the setting.
  assert.equal(await rivalTakes(), null);
  const lost = await waitForRead(() => snapshot(page), held, {
    message: "the proxy another extension took is reported",
  });
  assert.equal(await controlLevel(page), "controlled_by_other_extensions");
  assert.notDeepEqual(await blockingRules(page), [], "No rule blocks the traffic left unprotected");
  record("A proxy which another extension takes is reported as such, the traffic staying blocked", {
    status: lost.status,
    blockingScope: lost.blockingScope,
    blockingRules: await blockingRules(page),
  });

  await page.locator("#recoveryWhy summary").waitFor({ state: "visible" });
  const closed = await view(page);
  assert.equal(closed.panel, true);
  assert.equal(closed.title, french.proxyConflictTitle.message);
  assert.equal(
    closed.help,
    french.proxyConflictHelp.message.replace("$1", french.retryConnection.message),
  );
  assert.equal(closed.question, french.proxyConflictWhy.message);
  assert.equal(closed.open, false);
  assert.equal(closed.answerShown, false);
  // The panel says it, with what to do: the banner would repeat it in fewer words.
  assert.equal(closed.banner, false);
  await page.screenshot({ path: join(output, "conflict.png"), animations: "disabled" });
  await page.locator("#recoveryWhy summary").click();
  const opened = await waitForRead(
    () => view(page),
    (value) => value.open && value.answerShown,
    { message: "the explanation opened" },
  );
  assert.equal(opened.answer, french.proxyConflictWhyText.message);
  assert.equal(opened.fit, closed.fit);
  assert(
    Math.abs(opened.actionsTop - closed.actionsTop - opened.added) < 0.5,
    JSON.stringify({ closed, opened }),
  );
  await page.screenshot({ path: join(output, "conflict-explained.png"), animations: "disabled" });
  record(
    "The popup says that another extension holds the proxy and what to do, and explains on request why it shows now",
  );

  // For as long as the other extension holds the proxy, trying again changes nothing.
  let revision = (await snapshot(page)).snapshotVersion.revision;
  await page.locator("#retryButton").click();
  await waitForRead(
    () => snapshot(page),
    (value) => value.snapshotVersion.revision > revision && held(value) && value.status === "error",
    { message: "a retry under the other extension fails the same way" },
  );
  const again = await view(page);
  assert.equal(again.panel, true);
  assert.equal(again.title, french.proxyConflictTitle.message);
  assert.equal(await controlLevel(page), "controlled_by_other_extensions");
  record("A retry while the other extension holds the proxy shows the same warning");

  // The other extension gives the proxy back: the retry of the warning resumes.
  assert.equal(await rivalGivesBack(), null);
  // The browser then says the setting free, or back to what this extension had set.
  const released = await waitForRead(
    () => controlLevel(page),
    (level) => level !== "controlled_by_other_extensions",
    { message: "the proxy given back" },
  );
  assert.equal((await snapshot(page)).protected, false);
  assert.notDeepEqual(await blockingRules(page), [], "No rule blocks the traffic left unprotected");
  revision = (await snapshot(page)).snapshotVersion.revision;
  await page.locator("#retryButton").click();
  const resumed = await waitForRead(
    () => snapshot(page),
    (value) => value.status === "connected" && value.protected && value.error === null,
    { message: "the protection resumed once the proxy is given back" },
  );
  assert(resumed.snapshotVersion.revision > revision);
  assert.equal(await controlLevel(page), "controlled_by_this_extension");
  const after = await waitForRead(
    () => view(page),
    (value) => !value.panel,
    { message: "the warning withdrawn" },
  );
  assert.equal(after.why, false);
  assert.equal(after.open, false);
  record("The proxy given back, the retry of the warning resumes the protection", {
    levelOnceGivenBack: released,
    sessionsCreated: sessions,
  });

  assert.equal((await command(page, { type: "disconnect" })).ok, true);
  assert.deepEqual(report.pageErrors, []);
  record("The conflict and its recovery finish without an error reported by the popup");
  report.completed = true;
} catch (error) {
  report.failure = String(error.stack ?? error);
  process.exitCode = 1;
} finally {
  if (context) await context.close();
  await writeFile(join(output, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`Report: ${join(output, "report.json")}\n`);
}
