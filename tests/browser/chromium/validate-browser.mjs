// SPDX-License-Identifier: MPL-2.0

import {
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { spawn } from "node:child_process";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import {
  fileHashes,
  formatJsonTree,
  guardPath,
  projectRoot,
  runDirectory,
  assertInsideProject,
  scopedEnvironment,
  sha256,
  sourceHashes,
  writeJson,
} from "../../../scripts/validation-common.mjs";
import { existingToolchain } from "../../../scripts/validation-toolchain.mjs";

const target = process.env.EXTENSION_TARGET || "chrome";
if (!["chrome", "edge"].includes(target)) throw new Error("Chromium target must be chrome or edge");
const targetDist = assertInsideProject(join(projectRoot, "dist", target));

const suites = [
  {
    name: "diagnostics",
    script: "browser-diagnostics-check.mjs",
    output: "DIAGNOSTICS_OUTPUT",
    report: "report.json",
    scope: "Built diagnostics page; synthetic runtime, thirty locales and JSON download",
  },
  {
    name: "diagnostics-integration",
    script: "browser-diagnostics-integration-check.mjs",
    output: "DIAGNOSTICS_INTEGRATION_OUTPUT",
    report: "report.json",
    scope: "Built worker and diagnostics tab; intercepted synthetic API only",
  },
  {
    name: "security",
    script: "browser-security-check.mjs",
    report: "report.json",
    scope: "Built worker plus source network fixtures",
  },
  {
    name: "proxy-auth",
    script: "browser-proxy-auth-check.mjs",
    output: "PROXY_AUTH_OUTPUT",
    report: "browser-corrected.json",
    scope: "Built worker; synthetic API and local TLS proxy",
  },
  {
    name: "device-identity",
    script: "browser-device-identity-check.mjs",
    stdoutReport: true,
    scope: "Source identity module in an isolated extension",
  },
  {
    name: "site-exclusions-network",
    script: "browser-site-exclusions-network-check.mjs",
    output: "SITE_EXCLUSIONS_NETWORK_OUTPUT",
    report: "report.json",
    scope: "Built worker; synthetic API and local network fixtures",
  },
  {
    name: "network-fixes",
    script: "browser-network-fixes-check.mjs",
    output: "NETWORK_FIXES_OUTPUT",
    report: "browser-network-fixes-report.json",
    scope: "Source controller/network modules with synthetic dependencies",
  },
  {
    name: "popup-regressions",
    script: "browser-popup-regressions.mjs",
    output: "POPUP_REGRESSION_OUTPUT",
    report: "browser-popup-regressions.json",
    scope: "Built worker and popup; synthetic API",
  },
  {
    name: "popup-audit-fixes",
    script: "browser-popup-audit-fixes-check.mjs",
    output: "POPUP_AUDIT_FIXES_OUTPUT",
    report: "browser-popup-audit-fixes.json",
    scope: "Built popup and synthetic runtime",
  },
  {
    name: "web-login-ui",
    script: "browser-web-login-ui-check.mjs",
    output: "WEB_LOGIN_UI_OUTPUT",
    report: "report.json",
    scope:
      "Built popup; centralized web login, explicit protection release, thirty locales and synthetic runtime",
  },
  {
    name: "web-auth-integration",
    script: "browser-web-auth-integration-check.mjs",
    output: "WEB_AUTH_INTEGRATION_OUTPUT",
    report: "report.json",
    scope: "Built extension; browser identity web flow and synthetic authorization API only",
  },
  {
    name: "legacy-worker",
    script: "browser-legacy-worker-check.mjs",
    output: "LEGACY_WORKER_OUTPUT",
    report: "report.json",
    scope: "Built popup and synthetic historical worker",
  },
  {
    name: "site-exclusions-ui",
    script: "browser-site-exclusions-ui-check.mjs",
    output: "SITE_EXCLUSIONS_UI_OUTPUT",
    report: "report.json",
    scope: "Built popup and synthetic runtime",
  },
  {
    name: "experience",
    script: "browser-experience-check.mjs",
    output: "EXPERIENCE_OUTPUT",
    report: "browser-experience-check.json",
    scope: "Built worker and popup; synthetic API and ipify",
  },
  {
    name: "logout-contracts",
    script: "browser-logout-contracts-check.mjs",
    output: "LOGOUT_CONTRACTS_OUTPUT",
    report: "report.json",
    scope: "Built worker and popup; synthetic API",
  },
  {
    name: "capacity-ui",
    script: "browser-capacity-ui-check.mjs",
    output: "CAPACITY_UI_OUTPUT",
    report: "report.json",
    scope: "Built popup; synthetic runtime, catalog capacity states and RTL locales",
  },
  {
    name: "capacity-integration",
    script: "browser-capacity-integration-check.mjs",
    output: "CAPACITY_INTEGRATION_OUTPUT",
    report: "report.json",
    scope: "Built worker; intercepted synthetic API capacity refusals and catalog refresh",
  },
  {
    name: "location-hierarchy",
    script: "browser-location-hierarchy-check.mjs",
    output: "LOCATION_HIERARCHY_OUTPUT",
    report: "report.json",
    scope:
      "Built popup; country and city selection, disclosure, keyboard, refresh and thirty locales",
  },
];
const args = process.argv.slice(2);
if (
  args.some((value) => value !== "--preflight" && !suites.some((suite) => suite.name === value))
) {
  throw new Error(
    `Usage: node run-browser.mjs [--preflight | ${suites.map((suite) => suite.name).join(" | ")}]`,
  );
}
const environment = scopedEnvironment();
const toolchain = await existingToolchain(environment);
Object.assign(process.env, environment, toolchain.environment);
await import(pathToFileURL(guardPath).href);
process.chdir(projectRoot);
const output = runDirectory(
  `browser-${target}`,
  args.includes("--preflight") ? "preflight" : "run",
);
await writeJson(join(output, "toolchain.json"), toolchain.evidence);
process.stdout.write(`Validation evidence: ${output}\n`);
if (args.includes("--preflight")) {
  process.stdout.write(`${JSON.stringify(toolchain.evidence, null, 2)}\n`);
} else {
  const selected = args.length ? suites.filter((suite) => args.includes(suite.name)) : suites;
  const inputs = captureInputs();
  await writeJson(join(output, "inputs.json"), inputs);
  const manifest = JSON.parse(readFileSync(join(targetDist, "manifest.json")));
  const packageInfo = JSON.parse(readFileSync(join(projectRoot, "package.json")));
  if (manifest.version !== packageInfo.version)
    throw new Error("Rebuild first: package and dist versions differ.");
  const summary = {
    startedAt: new Date().toISOString(),
    version: manifest.version,
    completeMatrix: selected.length === suites.length,
    toolchain: "toolchain.json",
    inputInventory: "inputs.json",
    pin: inputPin(inputs),
    suites: [],
    scope:
      "Existing Chromium suites; synthetic accounts/API/ipify and loopback fixtures. No production validation.",
    limitations: [
      "Source fixtures and mocked popup suites are identified separately from tests of the packaged worker.",
      "Node writes outside ExtensionsV2 are rejected. Native browser/Python output confinement uses scoped environment and isolated profile arguments, not an OS sandbox.",
      "Chrome 116, production infrastructure and exhaustive DNS/IPv6/WebRTC leak absence are not validated.",
    ],
  };
  const profileRoot = assertInsideProject(join(projectRoot, "node_modules/.cache/validation"));
  mkdirSync(profileRoot, { recursive: true });
  const profileRun = mkdtempSync(join(profileRoot, "b-"));
  for (const suite of selected) {
    const suiteDirectory = join(output, suite.name);
    mkdirSync(suiteDirectory, { recursive: true });
    // Keep native profile paths short enough for Chromium's Windows IndexedDB backend.
    const temporary = assertInsideProject(join(profileRun, String(selected.indexOf(suite))));
    mkdirSync(temporary, { recursive: true });
    const before = inputPin(captureInputs());
    process.stdout.write(`Running ${suite.name}...\n`);
    const startedAt = new Date().toISOString();
    const result = await runChild(join(import.meta.dirname, suite.script), suiteDirectory, {
      ...environment,
      ...toolchain.environment,
      TMP: temporary,
      TEMP: temporary,
      TMPDIR: temporary,
      CHROME_EXTENSION_DIR: targetDist,
      EXTENSION_PATH: targetDist,
      ...(suite.output ? { [suite.output]: suiteDirectory } : {}),
    });
    let report;
    let reportPath;
    let originalReportPath;
    let reportError;
    try {
      if (suite.stdoutReport) {
        report = result.stdout
          .split(/\r?\n/)
          .filter((line) => line.startsWith("{"))
          .map((line) => {
            try {
              return JSON.parse(line);
            } catch {
              return null;
            }
          })
          .findLast((value) => value && typeof value.checks === "number");
        if (!report) throw new Error("No identity summary in stdout");
        reportPath = join(suiteDirectory, "report.json");
        await writeJson(reportPath, report);
      } else {
        originalReportPath =
          findReport(suiteDirectory, suite.report) || findReport(temporary, suite.report);
        if (!originalReportPath) throw new Error(`Missing report ${suite.report}`);
        report = JSON.parse(readFileSync(originalReportPath, "utf8"));
        // Keep the machine-readable proof outside disposable browser profiles and caches.
        reportPath = join(suiteDirectory, suite.report);
        await writeJson(reportPath, report);
      }
    } catch (error) {
      reportError = String(error.message || error);
    }
    await formatJsonTree(suiteDirectory);
    if (reportPath) await writeJson(reportPath, report);
    const after = inputPin(captureInputs());
    const stable =
      JSON.stringify(before) === JSON.stringify(after) &&
      JSON.stringify(before) === JSON.stringify(summary.pin);
    const checks =
      typeof report?.checks === "number"
        ? report.checks
        : Array.isArray(report?.checks)
          ? report.checks.length
          : 0;
    const failedChecks = Array.isArray(report?.checks)
      ? report.checks.filter((check) => check.passed === false).length
      : 0;
    const passed =
      result.exitCode === 0 &&
      !result.timedOut &&
      !reportError &&
      checks > 0 &&
      failedChecks === 0 &&
      (!report?.chromium || report.chromium === toolchain.evidence.chromium.version) &&
      report?.passed !== false &&
      report?.completed !== false &&
      report?.result !== "FAIL" &&
      !report?.failure &&
      (!Array.isArray(report?.pageErrors) || report.pageErrors.length === 0) &&
      stable;
    const entry = {
      suite: suite.name,
      script: suite.script,
      scriptSha256: sha256(readFileSync(join(import.meta.dirname, suite.script))),
      scope: suite.scope,
      startedAt,
      completedAt: new Date().toISOString(),
      passed,
      checks,
      failedChecks,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      temporaryDirectory: relative(projectRoot, temporary).replaceAll("\\", "/"),
      chromium: report?.chromium || null,
      inputFilesStable: stable,
      before,
      after,
      report: reportPath ? relative(output, reportPath).replaceAll("\\", "/") : null,
      originalReport: originalReportPath
        ? relative(projectRoot, originalReportPath).replaceAll("\\", "/")
        : null,
      reportSha256: reportPath ? sha256(readFileSync(reportPath)) : null,
      reportError: reportError || null,
    };
    summary.suites.push(entry);
    await writeJson(join(suiteDirectory, "execution.json"), entry);
    await writeJson(join(output, "summary.json"), summary);
    process.stdout.write(
      `${passed ? "PASS" : "FAIL"} ${suite.name}: ${checks} checks; inputs ${stable ? "stable" : "changed"}\n`,
    );
  }
  summary.completedAt = new Date().toISOString();
  summary.success = summary.suites.every((suite) => suite.passed);
  summary.passedChecks = summary.suites
    .filter((suite) => suite.passed)
    .reduce((sum, suite) => sum + suite.checks, 0);
  summary.totalChecks = summary.suites.reduce((sum, suite) => sum + suite.checks, 0);
  summary.inputFilesStable =
    JSON.stringify(summary.pin) === JSON.stringify(inputPin(captureInputs()));
  summary.success &&= summary.inputFilesStable;
  await writeJson(join(output, "summary.json"), summary);
  if (!summary.success) process.exitCode = 1;
  process.stdout.write(
    `${summary.success ? "PASS" : "FAIL"}: ${summary.passedChecks}/${summary.totalChecks} checks; ${summary.suites.length} suites\n`,
  );
}

function captureInputs() {
  return { sources: sourceHashes(), dist: fileHashes(targetDist) };
}
function inputPin(inputs) {
  return {
    sourcesSha256: sha256(JSON.stringify(inputs.sources)),
    distSha256: sha256(JSON.stringify(inputs.dist)),
    manifestSha256: inputs.dist["manifest.json"],
    workerSha256: inputs.dist["background/service-worker.js"],
  };
}
function findReport(directory, filename) {
  const direct = join(directory, filename);
  if (existsSync(direct)) return direct;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (
      !entry.isDirectory() ||
      entry.isSymbolicLink() ||
      ["profile", "appdata", "local-appdata"].includes(entry.name)
    )
      continue;
    const found = findReport(join(directory, entry.name), filename);
    if (found) return found;
  }
  return null;
}
function runChild(script, outputDirectory, env) {
  return new Promise((done) => {
    const log = createWriteStream(join(outputDirectory, "run.log"));
    const preload = `--import=${JSON.stringify(pathToFileURL(guardPath).href)}`;
    const child = spawn(process.execPath, ["--import", pathToFileURL(guardPath).href, script], {
      cwd: projectRoot,
      env: { ...env, NODE_OPTIONS: `${env.NODE_OPTIONS || ""} ${preload}`.trim() },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let timedOut = false;
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
      log.write(chunk);
    });
    child.stderr.on("data", (chunk) => log.write(chunk));
    child.on("error", (error) => log.write(`${error.stack || error}\n`));
    const timeout = setTimeout(() => {
      timedOut = true;
      log.write(
        "Runner timeout after five minutes; terminating only this validation child tree.\n",
      );
      if (process.platform === "win32" && child.pid)
        spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
          windowsHide: true,
          stdio: "ignore",
        });
      else child.kill("SIGTERM");
    }, 300000);
    child.on("close", (exitCode) => {
      clearTimeout(timeout);
      log.end(() => done({ exitCode, stdout, timedOut }));
    });
  });
}
