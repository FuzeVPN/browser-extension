// SPDX-License-Identifier: MPL-2.0

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const guard = resolve(import.meta.dirname, "../../scripts/validation-scope-guard.mjs");
const fixtures: string[] = [];

afterEach(() => {
  for (const directory of fixtures.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "validation-scope-guard-links-"));
  fixtures.push(directory);
  const inside = resolve(directory, "inside");
  mkdirSync(inside);
  return { directory, inside };
}

// `${name}0` -> `${name}1` -> ... -> `${name}${length - 1}` -> missing `${name}-end.txt`.
function danglingChain(inside: string, name: string, length: number) {
  for (let index = 0; index < length; index += 1) {
    const target = index + 1 < length ? `${name}${String(index + 1)}` : `${name}-end.txt`;
    symlinkSync(target, resolve(inside, `${name}${String(index)}`), "file");
  }
}

function run(paths: ReturnType<typeof fixture>, source: string) {
  const script = resolve(paths.directory, "probe.mjs");
  writeFileSync(
    script,
    `import assert from "node:assert/strict";
import fs from "node:fs";
import promises from "node:fs/promises";
const unresolved = (operation) =>
  new RegExp(\`^Error: Blocked write to link cycle or chain over 40 links \\\\(\${operation}\\\\): \`);
${source}`,
  );
  const result = spawnSync(process.execPath, ["--import", pathToFileURL(guard).href, script], {
    cwd: paths.inside,
    env: {
      ...process.env,
      CHROME_VALIDATION_ROOT: paths.inside,
      CHROME_VALIDATION_GUARD_LOG: resolve(paths.inside, "blocked.jsonl"),
      NODE_DISABLE_COMPILE_CACHE: "1",
    },
    encoding: "utf8",
    windowsHide: true,
    timeout: 15_000,
  });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
}

describe("validation scope guard link chains", () => {
  it("reports an in-root link cycle as unresolved instead of outside root", () => {
    const paths = fixture();
    symlinkSync("b", resolve(paths.inside, "a"), "file");
    symlinkSync("a", resolve(paths.inside, "b"), "file");
    symlinkSync("self", resolve(paths.inside, "self"), "file");
    run(
      paths,
      `assert.throws(() => fs.writeFileSync("a", "CHANGED"), unresolved("writeFileSync"));
assert.throws(() => fs.openSync("b", "w"), unresolved("openSync"));
// The guard cannot tell where a cycle lands, so it also refuses operations on the
// links themselves, which the OS would allow.
assert.throws(() => fs.unlinkSync("a"), unresolved("unlinkSync"));
assert.throws(() => fs.lutimesSync("b", new Date(), new Date()), unresolved("lutimesSync"));
await assert.rejects(async () => promises.unlink("self"), unresolved("unlink"));
// A path outside root keeps its own reason.
assert.throws(
  () => fs.writeFileSync("../outside.txt", "CHANGED"),
  /^Error: Blocked write outside ExtensionsV2 \\(writeFileSync\\): /,
);
`,
    );
    expect(existsSync(resolve(paths.directory, "outside.txt"))).toBe(false);
  });

  it("follows 40 dangling links inside root and refuses a longer chain", () => {
    const paths = fixture();
    danglingChain(paths.inside, "short", 40);
    danglingChain(paths.inside, "long", 41);
    run(
      paths,
      `fs.unlinkSync("short0");
assert.equal(fs.lstatSync("short0", { throwIfNoEntry: false }), undefined);
assert.throws(() => fs.writeFileSync("long0", "CHANGED"), unresolved("writeFileSync"));
assert.throws(() => fs.unlinkSync("long0"), unresolved("unlinkSync"));
`,
    );
    expect(existsSync(resolve(paths.inside, "long-end.txt"))).toBe(false);
  });
});
