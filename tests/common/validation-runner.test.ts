// SPDX-License-Identifier: MPL-2.0

import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "../..");
const fixturePrefix = join(root, "node_modules/.cache/validation-runner-");
const fixtures: string[] = [];

afterEach(() => {
  for (const directory of fixtures.splice(0)) {
    if (!directory.startsWith(fixturePrefix)) throw new Error("Invalid runner fixture path");
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("validation runner result", () => {
  it.each([
    { pass: true, mutate: false, success: true },
    { pass: false, mutate: false, success: false },
    { pass: true, mutate: true, success: false },
  ])(
    "reports success=$success for tests passing=$pass and source mutation=$mutate",
    ({ pass, mutate, success }) => {
      const fixture = createFixture();
      const result = spawnSync(process.execPath, [join(fixture, "scripts/validate-tests.mjs")], {
        cwd: fixture,
        env: {
          ...process.env,
          FIREFOX_VALIDATION_OUTPUT: "evidence",
          RUNNER_FIXTURE_PASS: String(pass),
          RUNNER_FIXTURE_MUTATE: String(mutate),
          NODE_DISABLE_COMPILE_CACHE: "1",
        },
        encoding: "utf8",
        windowsHide: true,
        timeout: 15_000,
      });
      expect(result.status, result.stderr).toBe(success ? 0 : 1);
      const runs = readdirSync(join(fixture, "evidence/unit-tests"));
      expect(runs).toHaveLength(1);
      const report = JSON.parse(
        readFileSync(join(fixture, "evidence/unit-tests", runs[0]!, "run.json"), "utf8"),
      ) as unknown;
      expect(report).toMatchObject({
        success,
        total: 1,
        passed: pass ? 1 : 0,
        failed: pass ? 0 : 1,
        inputFilesStable: !mutate,
        changedInputs: mutate ? ["src/fixture.ts"] : [],
      });
    },
  );
});

function createFixture(): string {
  mkdirSync(join(root, "node_modules/.cache"), { recursive: true });
  const fixture = mkdtempSync(fixturePrefix);
  fixtures.push(fixture);
  for (const directory of ["scripts", "src", "assets", "manifests", "tests", "node_modules/vitest"])
    mkdirSync(join(fixture, directory), { recursive: true });
  for (const file of ["validate-tests.mjs", "validation-common.mjs", "validation-scope-guard.mjs"])
    copyFileSync(join(root, "scripts", file), join(fixture, "scripts", file));
  copyFileSync(join(root, ".prettierrc.json"), join(fixture, ".prettierrc.json"));
  writeFileSync(join(fixture, "package.json"), '{"type":"module"}');
  for (const file of ["package-lock.json", "tsconfig.json", "vite.config.ts", "eslint.config.mjs"])
    writeFileSync(join(fixture, file), "{}");
  writeFileSync(join(fixture, "src/fixture.ts"), "export const value = 1;");
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
  return {close() {
    if (process.env.RUNNER_FIXTURE_MUTATE === "true")
      writeFileSync("src/fixture.ts", "export const value = 2;");
  }};
}
`,
  );
  return fixture;
}
