// SPDX-License-Identifier: MPL-2.0

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DISCONNECT_SCENARIOS } from "./disconnect-stress.mjs";
import { inventory, canonical } from "../../../scripts/verify-dist.mjs";

const root = resolve(import.meta.dirname, "../../..");
const output = resolve(
  process.env.DISCONNECT_STRESS_OUTPUT ?? join(root, "audit/local/disconnect-stress"),
);
await mkdir(output, { recursive: true });
const runRoot = await mkdtemp(join(output, "run-"));
const selected = process.argv[2];
const scenarios = selected ? [selected] : DISCONNECT_SCENARIOS;
assert(scenarios.every((scenario) => DISCONNECT_SCENARIOS.includes(scenario)));
const count = Number(process.env.DISCONNECT_STRESS_COUNT ?? 91);
assert(Number.isInteger(count) && count >= 1);
const originalFiles = await inventory(join(root, "dist/chrome"));
const harnessPaths = [
  "tests/browser/chromium/browser-disconnect-stress-check.mjs",
  "tests/browser/chromium/disconnect-stress.mjs",
  "tests/browser/chromium/browser-ip-worker-transport-check.mjs",
  "scripts/browser-wait.mjs",
];
async function harnessHashes() {
  return Object.fromEntries(
    await Promise.all(
      harnessPaths.map(async (path) => [
        path,
        createHash("sha256")
          .update(await readFile(join(root, path)))
          .digest("hex"),
      ]),
    ),
  );
}
const harness = await harnessHashes();
const report = {
  startedAt: new Date().toISOString(),
  runRoot,
  seed: 20261015,
  requestedCycles: scenarios.length * count,
  completedCycles: 0,
  passed: false,
  scope:
    "Eleven fresh isolated Chrome profiles; compiled toolbar popup, native proxy/protection/storage; synthetic account API and deterministic failure timing. No production account or personal browser profile.",
  artifact: {
    version: JSON.parse(await readFile(join(root, "dist/chrome/manifest.json"), "utf8")).version,
    files: originalFiles,
    inventorySha256: createHash("sha256").update(canonical(originalFiles)).digest("hex"),
  },
  harness,
  series: [],
};
try {
  for (const scenario of scenarios) {
    const directory = join(runRoot, scenario);
    await mkdir(directory);
    const status = await new Promise((resolveStatus, reject) => {
      const child = spawn(
        process.execPath,
        [fileURLToPath(new URL("./browser-ip-worker-transport-check.mjs", import.meta.url))],
        {
          cwd: root,
          windowsHide: true,
          stdio: "inherit",
          env: {
            ...process.env,
            NATIVE_IP_OUTPUT: directory,
            NATIVE_NODE_HOST: "127.0.0.1",
            NATIVE_DISCONNECT_SCENARIO: scenario,
            NATIVE_DISCONNECT_COUNT: String(count),
          },
        },
      );
      child.once("error", reject);
      child.once("close", resolveStatus);
    });
    assert.equal(status, 0, "Disconnect series failed: " + scenario);
    const latest = JSON.parse(await readFile(join(directory, "latest.json"), "utf8"));
    const series = JSON.parse(await readFile(latest.report, "utf8"));
    assert(series.passed && series.stress?.passed);
    assert.equal(series.stress.completed, count);
    assert.equal(series.stress.attempted, count);
    assert.equal(series.artifact.version, report.artifact.version);
    assert.equal(series.artifact.sourceWorkerSha256, originalFiles["background/service-worker.js"]);
    report.series.push({
      scenario,
      browser: series.browser,
      profile: join(series.runRoot, "profile"),
      report: latest.report,
      completed: series.stress.completed,
      attempted: series.stress.attempted,
    });
    report.completedCycles += series.stress.completed;
    await writeFile(join(runRoot, "report.json"), JSON.stringify(report, null, 2) + "\n");
    assert.equal(
      canonical(await inventory(join(root, "dist/chrome"))),
      canonical(originalFiles),
      "Built artifact changed during qualification",
    );
    assert.equal(
      canonical(await harnessHashes()),
      canonical(harness),
      "Qualification harness changed during the run",
    );
  }
  assert.equal(report.completedCycles, report.requestedCycles);
  report.passed = true;
} catch (error) {
  report.failure = String(error.stack ?? error);
  process.exitCode = 1;
} finally {
  report.finishedAt = new Date().toISOString();
  await writeFile(join(runRoot, "report.json"), JSON.stringify(report, null, 2) + "\n");
  await writeFile(
    join(output, "latest.json"),
    JSON.stringify(
      {
        report: join(runRoot, "report.json"),
        passed: report.passed,
        completedCycles: report.completedCycles,
      },
      null,
      2,
    ) + "\n",
  );
  process.stdout.write(
    JSON.stringify({
      report: join(runRoot, "report.json"),
      passed: report.passed,
      completedCycles: report.completedCycles,
      requestedCycles: report.requestedCycles,
    }) + "\n",
  );
  if (report.failure) process.stderr.write(report.failure + "\n");
}
