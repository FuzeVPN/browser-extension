// SPDX-License-Identifier: MPL-2.0

import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { readFileSync, existsSync } from "node:fs";
import {
  guardPath,
  projectRoot,
  runDirectory,
  scopedEnvironment,
  sourceHashes,
  writeJson,
} from "./validation-common.mjs";

Object.assign(process.env, scopedEnvironment());
await import(pathToFileURL(guardPath).href);
process.chdir(projectRoot);

const filters = process.argv.slice(2);
if (filters.some((argument) => argument.startsWith("-") || argument.includes(".."))) {
  throw new Error("Pass only test filenames or test name fragments; no command-line options.");
}
const output = runDirectory("unit-tests", filters.length ? "targeted" : "all");
const before = sourceHashes();
await writeJson(join(output, "inputs.json"), before);
const startedAt = new Date().toISOString();
const { startVitest } = await import("vitest/node");
const context = await startVitest(
  "test",
  filters,
  {
    root: projectRoot,
    run: true,
    watch: false,
    environment: "node",
    globals: true,
    clearMocks: true,
    cache: false,
    pool: "threads",
    maxWorkers: 2,
    include: ["tests/**/*.test.ts"],
    coverage: { enabled: false },
    experimental: { fsModuleCache: false },
    deps: { optimizer: { ssr: { enabled: false }, client: { enabled: false } } },
    reporters: ["default", "json"],
    outputFile: { json: join(output, "tests.json") },
    execArgv: ["--import", pathToFileURL(guardPath).href],
  },
  {
    configFile: existsSync(join(projectRoot, "vitest.config.ts"))
      ? join(projectRoot, "vitest.config.ts")
      : false,
    envFile: false,
    root: projectRoot,
    cacheDir: join(output, "vite-cache"),
    optimizeDeps: { noDiscovery: true, include: [] },
  },
);

await context?.close();
const tests = JSON.parse(readFileSync(join(output, "tests.json"), "utf8"));
await writeJson(join(output, "tests.json"), tests);
const after = sourceHashes();
const changedInputs = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(
  (file) => before[file] !== after[file],
);
const inputFilesStable = changedInputs.length === 0;
// Vitest's JSON success only reflects suites and assertions; asynchronous
// failures can leave it true while the context and process report an error.
const unhandledErrors = context?.state.getUnhandledErrors().length ?? 0;
const executionExitCode = Number(process.exitCode ?? 0);
const success =
  tests.success === true && inputFilesStable && unhandledErrors === 0 && executionExitCode === 0;
if (!success && executionExitCode === 0) process.exitCode = 1;
await writeJson(join(output, "run.json"), {
  startedAt,
  completedAt: new Date().toISOString(),
  node: process.version,
  vitest: JSON.parse(readFileSync(join(projectRoot, "node_modules/vitest/package.json"))).version,
  filters,
  success,
  total: tests.numTotalTests,
  passed: tests.numPassedTests,
  failed: tests.numFailedTests,
  unhandledErrors,
  exitCode: Number(process.exitCode ?? 0),
  changedInputs,
  inputFilesStable,
  scope:
    "Existing unit tests; ExtensionsV2-scoped temporary/cache files; writes outside ExtensionsV2 rejected by the Node preloader.",
});
process.stdout.write(`Validation evidence: ${output}\n`);
