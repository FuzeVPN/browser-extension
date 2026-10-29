// SPDX-License-Identifier: MPL-2.0

import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "../..");
const fixtureRoot = join(root, "audit/local/validation-runner");
const fixturePrefix = join(fixtureRoot, "fixture-");
const fixtures: string[] = [];

afterEach(() => {
  for (const directory of fixtures.splice(0)) {
    if (!directory.startsWith(fixturePrefix)) throw new Error("Invalid runner fixture path");
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("validation runner result", () => {
  it.each([
    { pass: true, mutate: false, unhandledErrors: 0, exitCode: 0, success: true },
    { pass: false, mutate: false, unhandledErrors: 0, exitCode: 0, success: false },
    { pass: true, mutate: true, unhandledErrors: 0, exitCode: 0, success: false },
    { pass: true, mutate: false, unhandledErrors: 1, exitCode: 0, success: false },
    { pass: true, mutate: false, unhandledErrors: 0, exitCode: 7, success: false },
  ])(
    "reports success=$success for passing=$pass, mutation=$mutate, errors=$unhandledErrors and exit=$exitCode",
    ({ pass, mutate, unhandledErrors, exitCode, success }) => {
      const fixture = createFixture();
      const result = spawnSync(process.execPath, [join(fixture, "scripts/validate-tests.mjs")], {
        cwd: fixture,
        env: {
          ...process.env,
          EXTENSIONS_VALIDATION_OUTPUT: "evidence",
          CHROME_VALIDATION_ROOT: fixture,
          RUNNER_FIXTURE_PASS: String(pass),
          RUNNER_FIXTURE_MUTATE: String(mutate),
          RUNNER_FIXTURE_UNHANDLED_ERRORS: String(unhandledErrors),
          RUNNER_FIXTURE_EXIT_CODE: String(exitCode),
          NODE_DISABLE_COMPILE_CACHE: "1",
        },
        encoding: "utf8",
        windowsHide: true,
        timeout: 15_000,
      });
      const expectedExitCode = success ? 0 : exitCode || 1;
      expect(result.status, result.stderr).toBe(expectedExitCode);
      expect(readReport(fixture, "run.json")).toMatchObject({
        success,
        total: 1,
        passed: pass ? 1 : 0,
        failed: pass ? 0 : 1,
        inputFilesStable: !mutate,
        changedInputs: mutate ? ["src/fixture.ts"] : [],
        unhandledErrors,
        exitCode: expectedExitCode,
      });
    },
  );

  it.each([false, true])(
    "records the real Vitest outcome when an assertion passes and unhandled rejection=%s",
    (reject) => {
      const fixture = createFixture(true);
      writeFileSync(
        join(fixture, "tests/rejection.test.ts"),
        `it("passes its assertion", async () => {
  if (${String(reject)})
    setTimeout(() => { void Promise.reject(new Error("RUNNER_UNHANDLED_REJECTION")); }, 0);
  await new Promise(resolve => setTimeout(resolve, 50));
  expect(true).toBe(true);
});
`,
      );
      const result = spawnSync(process.execPath, [join(fixture, "scripts/validate-tests.mjs")], {
        cwd: fixture,
        env: {
          ...process.env,
          EXTENSIONS_VALIDATION_OUTPUT: "evidence",
          CHROME_VALIDATION_ROOT: fixture,
          NODE_DISABLE_COMPILE_CACHE: "1",
        },
        encoding: "utf8",
        windowsHide: true,
        timeout: 15_000,
      });
      expect(result.status, result.stderr).toBe(reject ? 1 : 0);
      // Vitest's JSON reporter counts assertions, so its success alone cannot
      // establish that the test run had no unhandled asynchronous failures.
      expect(readReport(fixture, "tests.json")).toMatchObject({
        success: true,
        numTotalTests: 1,
        numPassedTests: 1,
        numFailedTests: 0,
      });
      expect(readReport(fixture, "run.json")).toMatchObject({
        success: !reject,
        total: 1,
        passed: 1,
        failed: 0,
        unhandledErrors: reject ? 1 : 0,
        exitCode: reject ? 1 : 0,
        inputFilesStable: true,
      });
      if (reject) expect(result.stderr).toContain("RUNNER_UNHANDLED_REJECTION");
    },
    20_000,
  );
});

function readReport(fixture: string, filename: string): unknown {
  const runs = readdirSync(join(fixture, "evidence/unit-tests"));
  expect(runs).toHaveLength(1);
  return JSON.parse(
    readFileSync(join(fixture, "evidence/unit-tests", runs[0]!, filename), "utf8"),
  ) as unknown;
}

function createFixture(realVitest = false): string {
  mkdirSync(fixtureRoot, { recursive: true });
  const fixture = mkdtempSync(fixturePrefix);
  fixtures.push(fixture);
  for (const directory of ["scripts", "src", "assets", "manifests", "tests", "node_modules"])
    mkdirSync(join(fixture, directory), { recursive: true });
  for (const file of ["validate-tests.mjs", "validation-common.mjs", "validation-scope-guard.mjs"])
    copyFileSync(join(root, "scripts", file), join(fixture, "scripts", file));
  copyFileSync(join(root, ".prettierrc.json"), join(fixture, ".prettierrc.json"));
  writeFileSync(join(fixture, "package.json"), '{"type":"module"}');
  for (const file of ["package-lock.json", "tsconfig.json", "vite.config.ts", "eslint.config.mjs"])
    writeFileSync(join(fixture, file), "{}");
  writeFileSync(join(fixture, "src/fixture.ts"), "export const value = 1;");
  if (realVitest) {
    symlinkSync(
      join(root, "node_modules/vitest"),
      join(fixture, "node_modules/vitest"),
      "junction",
    );
    return fixture;
  }
  mkdirSync(join(fixture, "node_modules/vitest"));
  writeFileSync(
    join(fixture, "node_modules/vitest/package.json"),
    JSON.stringify({ type: "module", version: "fixture", exports: { "./node": "./node.mjs" } }),
  );
  // Only the test engine is synthetic. The unmodified runner and its actual
  // inventory/guard/report helpers execute in a separate process and fixture.
  writeFileSync(
    join(fixture, "node_modules/vitest/node.mjs"),
    `import {writeFileSync} from "node:fs";
export async function startVitest(_mode, _filters, options) {
  const success = process.env.RUNNER_FIXTURE_PASS === "true";
  writeFileSync(options.outputFile.json, JSON.stringify({success,
    numTotalTests: 1, numPassedTests: Number(success), numFailedTests: Number(!success)}));
  process.exitCode = Number(process.env.RUNNER_FIXTURE_EXIT_CODE || 0);
  return {state: {getUnhandledErrors() {
    return Array.from({length: Number(process.env.RUNNER_FIXTURE_UNHANDLED_ERRORS || 0)},
      () => new Error("Synthetic unhandled error"));
  }}, close() {
    if (process.env.RUNNER_FIXTURE_MUTATE === "true")
      writeFileSync("src/fixture.ts", "export const value = 2;");
  }};
}
`,
  );
  return fixture;
}
