// SPDX-License-Identifier: MPL-2.0

// Built diagnostics UI with synthetic state only. External requests use local fixtures or are blocked.
import assert from "node:assert/strict";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, join, relative, extname } from "node:path";
import { pathToFileURL } from "node:url";
import { SUPPORTED_LANGUAGES, localeDirectory } from "../../../scripts/supported-locales.mjs";
import { inspectDesign, inspectReducedMotion } from "./browser-design-review.mjs";

const root = resolve(import.meta.dirname, "../../..");
const extension = resolve(process.env.CHROME_EXTENSION_DIR || join(root, "dist/chrome"));
const output = resolve(
  process.env.DIAGNOSTICS_OUTPUT || join(root, "security-audit/diagnostics/browser-ui"),
);
if (relative(root, output).startsWith("..")) throw new Error("Output must stay inside Chrome");
if (!process.env.PLAYWRIGHT_MODULE_PATH)
  throw new Error("Use the scoped browser validation runner");
const { chromium } = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE_PATH).href);
const catalog = JSON.parse(await readFile(join(extension, "_locales/fr/messages.json"), "utf8"));
const evidence = {
  scope: "Built diagnostics page, isolated Chromium, synthetic runtime only",
  checks: [],
  pageErrors: [],
  blockedRequests: [],
};
await mkdir(output, { recursive: true });
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_EXECUTABLE,
  headless: true,
  args: ["--disable-background-networking", "--host-resolver-rules=MAP * ~NOTFOUND"],
});
evidence.chromium = browser.version();
const context = await browser.newContext({
  viewport: { width: 850, height: 900 },
  acceptDownloads: true,
});
const state = {
  version: 1,
  workerId: "diagnostic-fixture",
  accountEpoch: 0,
  revision: 1,
  language: "fr",
  signedIn: false,
  autoReporting: false,
  preparing: false,
  historyCount: 12,
  connectionHistoryCount: 1,
  reports: [],
};
const contents = new Map();
const requests = [];
let serial = 0;
let legacy = false;
let heldType = null;
let held = null;
const clone = (value) => structuredClone(value);
const record = (name) => evidence.checks.push({ name, passed: true });
function makeReport() {
  const id = `a1000000-0000-4000-8000-${String(++serial).padStart(12, "0")}`;
  const report = {
    schema_version: 1,
    report_id: id,
    report_type: "full",
    platform: "chrome_extension",
    app_version: "0.6.0",
    created_at: "2026-09-16T12:00:00Z",
    consent: { mode: "manual", notice_version: 1 },
    protocol: "browser_proxy",
    state: "disconnected",
    occurrences: 1,
    snapshot: { traffic_blocked: false, webrtc_protected: false },
    chrome: { blocking_scope: "none", probe_result: "passed", probe_latency_ms: 20 },
    checks: [
      { id: "proxy_settings", result: "passed" },
      { id: "kill_switch", result: "skipped" },
      { id: "connectivity", result: "passed", duration_ms: 20 },
    ],
    truncated: false,
    dropped_events: 0,
  };
  contents.set(id, report);
  state.reports.unshift({
    id,
    type: "full",
    createdAt: report.created_at,
    status: "ready",
    attempts: 0,
    nextAttemptAt: null,
    canSend: state.signedIn,
  });
  return id;
}
async function publish(patch = {}) {
  if (Object.hasOwn(patch, "signedIn") && patch.signedIn !== state.signedIn)
    state.accountEpoch += 1;
  Object.assign(state, patch);
  state.revision += 1;
  await Promise.all(
    context
      .pages()
      .filter((page) => !page.isClosed())
      .map((page) =>
        page
          .evaluate((state) => window.diagnosticFixtureEmit?.(state), clone(state))
          .catch(() => undefined),
      ),
  );
}
await context.route("**/*", async (route) => {
  const url = new URL(route.request().url());
  if (url.origin === "https://fuzevpn.com")
    return route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><title>Local legal-link fixture</title>",
    });
  if (url.origin !== "https://diagnostics.invalid") {
    evidence.blockedRequests.push(url.origin);
    return route.abort();
  }
  const file = resolve(extension, `.${decodeURIComponent(url.pathname)}`);
  if (relative(extension, file).startsWith("..")) return route.abort();
  try {
    await route.fulfill({
      body: await readFile(file),
      contentType: {
        ".html": "text/html",
        ".js": "text/javascript",
        ".css": "text/css",
        ".json": "application/json",
        ".svg": "image/svg+xml",
        ".woff2": "font/woff2",
      }[extname(file)],
    });
  } catch {
    await route.fulfill({ status: 404, body: "Missing local asset" });
  }
});
await context.exposeBinding("diagnosticFixtureRequest", async (_source, request) => {
  requests.push(clone(request));
  if (legacy) return undefined;
  if (["diagnostics_set_auto", "diagnostics_send"].includes(request.type)) {
    assert.equal(request.workerId, state.workerId, "Consent must target the current worker");
    assert.equal(
      request.accountEpoch,
      state.accountEpoch,
      "Consent must target the current account",
    );
  }
  if (request.type === "get_connection_journal")
    return {
      ok: true,
      journal: {
        schemaVersion: 1,
        extensionVersion: "0.9.2",
        events: [
          {
            event: "failure",
            source: "local",
            reason: "catalog_missing",
            error: "invalid_location",
            count: 1,
            requestedPresent: false,
            at: 1_792_173_000_000,
            sequence: 1,
          },
        ],
      },
    };
  let error;
  let reportId;
  let report;
  const summary = state.reports.find((item) => item.id === request.reportId);
  switch (request.type) {
    case "diagnostics_state":
      break;
    case "diagnostics_run":
      await publish({ preparing: true });
      reportId = makeReport();
      await publish({ preparing: false });
      break;
    case "diagnostics_report":
      report = clone(contents.get(request.reportId));
      break;
    case "diagnostics_set_auto":
      assert.deepEqual(
        Object.keys(request).sort(),
        ["type", "enabled", "workerId", "accountEpoch"].sort(),
      );
      if (state.signedIn) state.autoReporting = request.enabled;
      else error = "session_required";
      break;
    case "diagnostics_clear_history":
      state.historyCount = 0;
      state.connectionHistoryCount = 0;
      break;
    case "diagnostics_send":
      assert.deepEqual(
        Object.keys(request).sort(),
        ["type", "reportId", "consent", "noticeVersion", "workerId", "accountEpoch"].sort(),
      );
      assert.equal(request.consent, true);
      assert.equal(request.noticeVersion, 1);
      if (!state.signedIn) error = "session_required";
      else if (summary?.canSend) Object.assign(summary, { status: "pending", canSend: false });
      else error = "not_found";
      break;
    case "diagnostics_cancel":
      if (summary) Object.assign(summary, { status: "cancelled", canSend: false });
      break;
    case "diagnostics_delete":
      state.reports = state.reports.filter((item) => item.id !== request.reportId);
      contents.delete(request.reportId);
      break;
    default:
      throw new Error("Unexpected non-diagnostic command");
  }
  state.revision += 1;
  const response = {
    diagnosticsVersion: 1,
    ok: !error,
    state: clone(state),
    ...(error ? { error } : {}),
    ...(reportId ? { reportId } : {}),
    ...(report ? { report } : {}),
  };
  if (request.type === heldType) {
    heldType = null;
    return new Promise((resolve) => {
      held = () => resolve(response);
    });
  }
  return response;
});
await context.addInitScript((catalog) => {
  const listeners = [];
  window.diagnosticFixtureEmit = (state) =>
    listeners.forEach((listener) => listener({ type: "diagnostics_changed", state }));
  window.chrome = {
    i18n: {
      getUILanguage: () => "fr",
      getMessage: (key, values = []) =>
        (catalog[key]?.message ?? key).replace(/\$([1-9])/g, (_, index) => values[index - 1] ?? ""),
    },
    runtime: {
      getURL: (path) => `https://diagnostics.invalid/${path}`,
      onMessage: { addListener: (listener) => listeners.push(listener) },
      sendMessage: (request) => window.diagnosticFixtureRequest(request),
    },
  };
}, catalog);
async function open() {
  const page = await context.newPage();
  page.on("pageerror", (error) => evidence.pageErrors.push(error.message));
  await page.goto("https://diagnostics.invalid/diagnostics-page/diagnostics.html");
  await page.waitForFunction(() => document.documentElement.lang === "fr");
  if (!legacy) await page.waitForFunction(() => !document.getElementById("runButton").disabled);
  return page;
}
async function waitUntil(condition) {
  const deadline = Date.now() + 10_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("Synthetic fixture wait timed out");
    await new Promise((done) => setTimeout(done, 20));
  }
}
async function reportLoaded(page) {
  await page.waitForFunction(() => {
    const ready =
      !document.getElementById("exportButton").disabled &&
      !document.getElementById("runButton").disabled;
    if (!ready) return false;
    try {
      const report = JSON.parse(document.getElementById("reportJson").textContent);
      return report.report_id === document.getElementById("reportSelect").value;
    } catch {
      return false;
    }
  });
}

async function keyboardFocus(page, selector) {
  const focus = await page.locator(selector).evaluate((node) => {
    const style = getComputedStyle(node);
    const bounds = node.getBoundingClientRect();
    return {
      active: document.activeElement === node,
      visible: node.matches(":focus-visible"),
      outline: style.outlineStyle !== "none" && parseFloat(style.outlineWidth) >= 2,
      // Native focus scrolling rounds the document offset to whole CSS pixels.
      inView: bounds.top >= -1 && bounds.bottom <= innerHeight + 1,
    };
  });
  if (!focus.inView) {
    evidence.focusFailure = await page.locator(selector).evaluate((node) => {
      const box = node.getBoundingClientRect();
      const summary = document.querySelector("#jsonDetails summary").getBoundingClientRect();
      return {
        selector: node.id,
        box: { top: box.top, bottom: box.bottom, height: box.height },
        summary: { top: summary.top, bottom: summary.bottom },
        viewport: { width: innerWidth, height: innerHeight },
        scroll: { page: scrollY, element: node.scrollTop },
      };
    });
    await page.screenshot({ path: join(output, "diagnostics-focus-failure.png") });
  }
  assert.deepEqual(
    focus,
    { active: true, visible: true, outline: true, inView: true },
    `Keyboard focus must be visible on ${selector}`,
  );
}

async function verifyLegalLinks(page, language, translated) {
  const websiteLanguage = ["fr", "en", "es", "de", "nl"].includes(language) ? language : "en";
  const links = await page.locator("a[data-legal-link]").evaluateAll((nodes) =>
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
  assert.equal(links.length, 2);
  for (const link of links) {
    const target =
      link.kind === "contact"
        ? ({ es: "contacto", de: "kontakt" }[websiteLanguage] ?? "contact")
        : link.kind;
    assert.equal(
      link.href,
      link.kind === "privacy"
        ? `https://diagnostics.invalid/privacy-page/privacy.html?lang=${language}`
        : `https://fuzevpn.com/${websiteLanguage}/${target}.html`,
    );
    assert.equal(link.hreflang, link.kind === "privacy" ? language : websiteLanguage);
    assert.equal(link.target, "_blank");
    assert.deepEqual(link.rel, ["noopener", "noreferrer"]);
    assert.equal(link.label, translated[link.key].message);
    assert.equal(link.tabIndex, 0);
  }
  assert.equal(await page.locator("#autoPrivacyLink").isVisible(), true);
}

let page;
try {
  page = await open();
  await verifyLegalLinks(page, "fr", catalog);
  const connectionDownloadEvent = page.waitForEvent("download");
  await page.locator("#connectionLogButton").click();
  const connectionDownload = await connectionDownloadEvent;
  assert.equal(connectionDownload.suggestedFilename(), "fuzevpn-connection-journal.json");
  const connectionExport = join(output, "connection-journal-export.json");
  await connectionDownload.saveAs(connectionExport);
  const connectionJournal = JSON.parse(await readFile(connectionExport, "utf8"));
  assert.equal(connectionJournal.schemaVersion, 1);
  assert.equal(connectionJournal.events[0].reason, "catalog_missing");
  assert.equal(connectionJournal.events[0].source, "local");
  assert.equal(state.signedIn, false);
  assert.equal(
    requests.some((request) =>
      ["diagnostics_run", "diagnostics_send", "diagnostics_set_auto"].includes(request.type),
    ),
    false,
  );
  record("Connection journal exports locally without an account, report, consent or upload");
  await page.screenshot({ path: join(output, "diagnostics-privacy-fr.png"), fullPage: true });
  assert.equal(await page.locator("#autoReporting").isChecked(), false);
  assert.equal(await page.locator("#autoReporting").isDisabled(), true);
  await page.locator("#runButton").click();
  await reportLoaded(page);
  const anonymousId = state.reports[0].id;
  assert.equal(await page.locator("#checkList li").count(), 3);
  assert.equal(await page.locator("#sendConsent").isChecked(), false);
  assert.equal(await page.locator("#sendButton").isDisabled(), true);
  const downloadEvent = page.waitForEvent("download");
  await page.locator("#exportButton").click();
  const download = await downloadEvent;
  assert.equal(download.suggestedFilename(), `fuzevpn-diagnostic-${anonymousId}.json`);
  const saved = join(output, "synthetic-export.json");
  await download.saveAs(saved);
  assert.deepEqual(JSON.parse(await readFile(saved, "utf8")), contents.get(anonymousId));
  assert.equal(
    requests.some((request) => request.type === "diagnostics_send"),
    false,
  );
  record(
    "Without an account: local report, check summary and validated Blob export; no sending or opt-in",
  );

  await publish({ signedIn: true });
  await page.locator("#autoReporting").check();
  await page.waitForFunction(
    () =>
      document.getElementById("autoReporting").checked &&
      !document.getElementById("autoReporting").disabled,
  );
  assert.equal(state.autoReporting, true);
  await page.locator("#autoReporting").uncheck();
  await page.waitForFunction(
    () =>
      !document.getElementById("autoReporting").checked &&
      !document.getElementById("autoReporting").disabled,
  );
  await page.locator("#runButton").click();
  await waitUntil(() => state.reports.length === 2);
  const signedInId = state.reports[0].id;
  await page.waitForFunction(
    (id) => document.getElementById("reportSelect").value === id,
    signedInId,
  );
  await reportLoaded(page);
  await page.locator("#sendConsent").check();
  await page.locator("#reportSelect").selectOption(anonymousId);
  await reportLoaded(page);
  assert.equal(await page.locator("#sendConsent").isChecked(), false);
  await page.locator("#reportSelect").selectOption(signedInId);
  await reportLoaded(page);
  assert.equal(await page.locator("#sendButton").isDisabled(), true);
  // Enter the report controls through the actual tab order, with no mouse clicks.
  await page.locator("#reportSelect").focus();
  await page.keyboard.press("Tab");
  await keyboardFocus(page, "#jsonDetails summary");
  await page.keyboard.press("Enter");
  assert.equal(await page.locator("#jsonDetails").evaluate((node) => node.open), true);
  await page.keyboard.press("Tab");
  await keyboardFocus(page, "#reportJson");
  await page.keyboard.press("Shift+Tab");
  await keyboardFocus(page, "#jsonDetails summary");
  await page.keyboard.press("Space");
  assert.equal(await page.locator("#jsonDetails").evaluate((node) => node.open), false);
  for (const selector of ["#exportButton", "#deleteButton", "#sendConsent"]) {
    await page.keyboard.press("Tab");
    await keyboardFocus(page, selector);
  }
  await page.keyboard.press("Space");
  assert.equal(await page.locator("#sendConsent").isChecked(), true);
  await page.keyboard.press("Tab");
  await keyboardFocus(page, "#sendPrivacyLink");
  const legalTabEvent = page.waitForEvent("popup");
  await page.keyboard.press("Enter");
  const legalTab = await legalTabEvent;
  await legalTab.waitForURL("https://diagnostics.invalid/privacy-page/privacy.html?lang=fr");
  assert.equal(await legalTab.evaluate(() => window.opener === null), true);
  await legalTab.close();
  assert.equal(await page.locator("#sendConsent").isChecked(), true);
  assert.equal(state.autoReporting, false);
  assert.equal(requests.filter((request) => request.type === "diagnostics_send").length, 0);
  await page.keyboard.press("Tab");
  await keyboardFocus(page, "#sendButton");
  await page.screenshot({ path: join(output, "diagnostics-keyboard-focus.png") });
  await page.keyboard.press("Enter");
  await page.waitForFunction(() =>
    document.getElementById("reportStatus").textContent.includes("En attente d’envoi"),
  );
  assert.equal(requests.filter((request) => request.type === "diagnostics_send").length, 1);
  record(
    "Tab navigation has visible focus; privacy opens separately without sending or changing consent, then explicit consent sends one report",
  );
  await page.close();
  page = await open();
  await reportLoaded(page);
  assert.equal(await page.locator("#sendConsent").isChecked(), false);
  assert.equal(await page.locator("#cancelButton").isVisible(), true);
  await page.locator("#cancelButton").click();
  await page.waitForFunction(
    () => document.getElementById("reportStatus").textContent === "Envoi annulé",
  );
  record(
    "Account opt-in stays separate from per-report consent; queue is restored after closing the page and can be cancelled",
  );

  for (const status of ["sending", "session_required", "failed", "expired"]) {
    state.reports[0].status = status;
    await publish();
    await page.waitForFunction(
      (text) => document.getElementById("reportStatus").textContent === text,
      catalog[`diagnosticsStatus_${status}`].message,
    );
    assert.equal(
      await page.locator("#cancelButton").isVisible(),
      ["sending", "session_required"].includes(status),
    );
    assert.equal(await page.locator("#sendButton").isDisabled(), true);
  }
  const invalidReceiptState = clone(state);
  invalidReceiptState.revision += 1;
  invalidReceiptState.reports[0].status = "received";
  await page.evaluate((value) => window.diagnosticFixtureEmit(value), invalidReceiptState);
  assert.equal((await page.locator("#reportStatus").textContent()).includes("Reçu par"), false);
  Object.assign(state.reports[0], {
    status: "received",
    receipt: {
      report_id: "b1000000-0000-4000-8000-000000000001",
      client_report_id: signedInId,
      status: "received",
      received_at: "2026-09-16T12:01:00Z",
      expires_at: "2026-10-16T12:01:00Z",
      duplicate: false,
    },
  });
  await publish();
  await page.waitForFunction(
    (text) => document.getElementById("reportStatus").textContent.includes(text),
    catalog.diagnosticsStatus_received.message,
  );
  assert.equal(await page.locator("#cancelButton").isVisible(), false);
  record(
    "Pending, sending, session-required, failed, expired and receipt-confirmed states remain distinct",
  );

  heldType = "diagnostics_report";
  await page.locator("#reportSelect").selectOption(anonymousId);
  await waitUntil(() => held !== null);
  await publish({ signedIn: false, autoReporting: false, reports: [], historyCount: 0 });
  held();
  held = null;
  await page.waitForFunction(() => document.getElementById("reportView").hidden);
  assert.equal(await page.locator("#reportJson").textContent(), "");
  assert.equal(await page.locator("#sendConsent").isChecked(), false);
  record("A delayed report reply after account change cannot restore content or consent");

  state.signedIn = true;
  state.accountEpoch += 1;
  const malformedId = makeReport();
  contents.get(malformedId).email = "synthetic-secret@example.invalid";
  await publish({ signedIn: true });
  await page.locator("#reportContentError").waitFor({ state: "visible" });
  assert.equal(await page.locator("#reportJson").textContent(), "");
  assert.equal(await page.locator("#exportButton").isDisabled(), true);
  assert.equal(await page.locator("#sendButton").isDisabled(), true);
  await page.locator("#deleteButton").click();
  await page.waitForFunction(() => document.getElementById("reportView").hidden);
  await publish({ historyCount: 10 });
  await page.locator("#clearHistoryButton").click();
  await page.waitForFunction(() => document.getElementById("clearHistoryButton").disabled);
  assert.equal(state.historyCount, 0);
  assert.equal(state.connectionHistoryCount, 0);
  record(
    "Malformed report content is neither displayed nor exported; local report and history deletion work",
  );

  makeReport();
  await publish();
  await reportLoaded(page);
  evidence.design = { screenshots: [], measurements: [] };
  for (const language of ["fr", "en", "de", "ar"]) {
    await publish({ language });
    await page.waitForFunction((language) => document.documentElement.lang === language, language);
    await page.evaluate(() => document.fonts.ready);
    const measurement = await inspectDesign(page, {
      text: [
        "h1",
        "h2",
        ".intro",
        ".muted",
        "#reportSummary",
        "#reportStatus",
        "#runButton",
        ".secondary",
        ".privacy-link",
      ],
      controls: [
        "#runButton",
        "#clearHistoryButton",
        "#reportSelect",
        "#exportButton",
        "#deleteButton",
      ],
      primary: ["#runButton"],
    });
    evidence.design.measurements.push({ language, ...measurement });
    const name = `design-diagnostics-${language}-desktop.png`;
    await page.screenshot({ path: join(output, name), fullPage: true, animations: "disabled" });
    evidence.design.screenshots.push(name);
  }
  evidence.design.reducedMotion = await inspectReducedMotion(page);
  record(
    "French, English, German and Arabic desktop workspaces have readable contrast, usable targets and reduced motion support",
  );
  await page.setViewportSize({ width: 360, height: 900 });
  for (const code of SUPPORTED_LANGUAGES) {
    await publish({ language: code });
    await page.waitForFunction((code) => document.documentElement.lang === code, code);
    const directory = localeDirectory(code);
    const translated = JSON.parse(
      await readFile(join(extension, `_locales/${directory}/messages.json`), "utf8"),
    );
    assert.equal(await page.locator("h1").textContent(), translated.diagnosticsTitle.message);
    await verifyLegalLinks(page, code, translated);
    const rtl = ["ar", "fa", "ur"].includes(code);
    const direction = await page.evaluate(() => {
      const check = document.querySelector("label.check");
      const input = check.querySelector("input").getBoundingClientRect();
      const label = check.querySelector("span").getBoundingClientRect();
      return {
        attribute: document.documentElement.dir,
        computed: getComputedStyle(document.documentElement).direction,
        checkboxBeforeLabel: input.x < label.x,
        json: getComputedStyle(document.getElementById("reportJson")).direction,
      };
    });
    assert.deepEqual(
      direction,
      {
        attribute: rtl ? "rtl" : "ltr",
        computed: rtl ? "rtl" : "ltr",
        checkboxBeforeLabel: !rtl,
        json: "ltr",
      },
      `Diagnostic direction and JSON isolation in ${code}`,
    );
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      true,
      `Overflow in ${code}`,
    );
    assert.equal(
      await page
        .locator("[data-i18n]")
        .evaluateAll((nodes) =>
          nodes.every((node) => node.textContent.trim() && node.textContent !== node.dataset.i18n),
        ),
      true,
    );
    await page.screenshot({ path: join(output, `diagnostics-${directory}.png`), fullPage: true });
  }
  record(
    "Diagnostics, consent, delivery and localized legal links cover all thirty languages without horizontal overflow at 360 px",
  );
  record("Diagnostic layouts follow RTL and return to LTR while exported JSON remains LTR");
  await page.close();
  legacy = true;
  state.language = "fr";
  page = await open();
  await page.locator("#pageError").waitFor({ state: "visible" });
  await verifyLegalLinks(page, "fr", catalog);
  assert.equal(await page.locator("#runButton").isDisabled(), true);
  assert.equal(await page.locator("#autoReporting").isDisabled(), true);
  assert.equal(
    await page.locator("#pageError").textContent(),
    catalog.diagnosticsUnavailable.message,
  );
  record(
    "A historical worker shows reload guidance and disables diagnostic controls without issuing VPN commands",
  );
  assert.equal(
    requests.every(
      (request) =>
        request.type.startsWith("diagnostics_") || request.type === "get_connection_journal",
    ),
    true,
  );
  assert.deepEqual(evidence.pageErrors, []);
  evidence.completed = true;
} catch (error) {
  evidence.failure = String(error.stack ?? error);
  process.exitCode = 1;
} finally {
  await browser.close();
  await writeFile(join(output, "report.json"), JSON.stringify(evidence, null, 2) + "\n");
  process.stdout.write(JSON.stringify(evidence, null, 2));
}
