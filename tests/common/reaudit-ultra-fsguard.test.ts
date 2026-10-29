// SPDX-License-Identifier: MPL-2.0

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const guard = resolve(import.meta.dirname, "../../scripts/validation-scope-guard.mjs");
// Node 24 adds disposable temporary directories; older supported runtimes lack them.
const disposableDirectories = "mkdtempDisposableSync" in process.getBuiltinModule("node:fs");
const fixtures: string[] = [];

afterEach(() => {
  for (const directory of fixtures.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "validation-scope-guard-"));
  fixtures.push(directory);
  const inside = resolve(directory, "inside");
  const outside = resolve(directory, "outside");
  mkdirSync(inside);
  mkdirSync(outside);
  writeFileSync(resolve(inside, "source.txt"), "COPY\n");
  writeFileSync(resolve(outside, "sentinel.txt"), "ORIGINAL\n");
  return { directory, inside, outside };
}

function run(
  paths: ReturnType<typeof fixture>,
  source: string,
  log = resolve(paths.inside, "blocked.jsonl"),
) {
  const script = resolve(paths.directory, "probe.mjs");
  writeFileSync(script, source);
  const result = spawnSync(process.execPath, ["--import", pathToFileURL(guard).href, script], {
    cwd: paths.inside,
    env: {
      ...process.env,
      CHROME_VALIDATION_ROOT: paths.inside,
      CHROME_VALIDATION_GUARD_LOG: log,
      GUARD_FIXTURE_OUTSIDE: paths.outside,
      NODE_DISABLE_COMPILE_CACHE: "1",
    },
    encoding: "utf8",
    windowsHide: true,
    timeout: 15_000,
  });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  // A refused operation must not have created anything before being refused.
  expect(readdirSync(paths.outside)).toEqual(["sentinel.txt"]);
  expect(readFileSync(resolve(paths.outside, "sentinel.txt"), "utf8")).toBe("ORIGINAL\n");
}

describe("validation scope guard creation boundaries", () => {
  it("refuses writes, copies, opens and streams through dangling links to outside root", () => {
    const paths = fixture();
    const { inside, outside } = paths;
    symlinkSync(resolve(outside, "absolute.txt"), resolve(inside, "absolute.txt"), "file");
    symlinkSync("../outside/relative.txt", resolve(inside, "relative.txt"), "file");
    symlinkSync(resolve(outside, "chain.txt"), resolve(inside, "hop.txt"), "file");
    symlinkSync(resolve(inside, "hop.txt"), resolve(inside, "chain.txt"), "file");
    mkdirSync(resolve(inside, "tree"));
    writeFileSync(resolve(inside, "tree/absolute.txt"), "COPY\n");
    mkdirSync(resolve(inside, "destination"));
    symlinkSync(
      resolve(outside, "copied.txt"),
      resolve(inside, "destination/absolute.txt"),
      "file",
    );
    run(
      paths,
      `import assert from "node:assert/strict";
import fs from "node:fs";
import promises from "node:fs/promises";
for (const alias of ["absolute.txt", "relative.txt", "chain.txt"]) {
  assert.throws(() => fs.writeFileSync(alias, "CHANGED"), /outside ExtensionsV2/);
  assert.throws(() => fs.appendFileSync(alias, "CHANGED"), /outside ExtensionsV2/);
  assert.throws(() => fs.copyFileSync("source.txt", alias), /outside ExtensionsV2/);
  assert.throws(() => fs.openSync(alias, "w"), /outside ExtensionsV2/);
  assert.throws(() => fs.createWriteStream(alias), /outside ExtensionsV2/);
  await assert.rejects(async () => promises.writeFile(alias, "CHANGED"), /outside ExtensionsV2/);
  await assert.rejects(async () => promises.open(alias, "a"), /outside ExtensionsV2/);
}
assert.throws(() => fs.cpSync("tree", "destination", { recursive: true }), /outside ExtensionsV2/);
`,
    );
  });

  it("keeps dangling links that stay inside root writable and removable", () => {
    const paths = fixture();
    const { inside } = paths;
    symlinkSync(resolve(inside, "target.txt"), resolve(inside, "alias.txt"), "file");
    symlinkSync(resolve(inside, "missing.txt"), resolve(inside, "stale.txt"), "file");
    run(
      paths,
      `import assert from "node:assert/strict";
import fs from "node:fs";
fs.writeFileSync("alias.txt", "INSIDE");
assert.equal(fs.readFileSync("target.txt", "utf8"), "INSIDE");
fs.unlinkSync("stale.txt");
assert.equal(fs.existsSync("stale.txt"), false);
`,
    );
  });

  it("does not create a rejection log through a dangling link to outside root", () => {
    const paths = fixture();
    const log = resolve(paths.inside, "blocked.jsonl");
    symlinkSync(resolve(paths.outside, "blocked.jsonl"), log, "file");
    run(
      paths,
      `import assert from "node:assert/strict";
import fs from "node:fs";
import { resolve } from "node:path";
const sentinel = resolve(process.env.GUARD_FIXTURE_OUTSIDE, "sentinel.txt");
assert.throws(() => fs.writeFileSync(sentinel, "CHANGED"), /^Error: Blocked .*outside ExtensionsV2/);
`,
      log,
    );
  });

  it("validates the directory mkdtemp creates, including a sibling of root", () => {
    const paths = fixture();
    run(
      paths,
      `import assert from "node:assert/strict";
import fs from "node:fs";
import promises from "node:fs/promises";
import { join, sep } from "node:path";
const inside = process.env.CHROME_VALIDATION_ROOT;
const outside = process.env.GUARD_FIXTURE_OUTSIDE;
assert.throws(() => fs.mkdtempSync(inside), /outside ExtensionsV2/);
assert.throws(() => fs.mkdtempSync(join(outside, "created-")), /outside ExtensionsV2/);
await assert.rejects(async () => promises.mkdtemp(inside), /outside ExtensionsV2/);
assert.ok(fs.existsSync(fs.mkdtempSync("created-")));
assert.ok(fs.existsSync(fs.mkdtempSync(inside + sep)));
`,
    );
    expect(readdirSync(paths.directory).sort()).toEqual(["inside", "outside", "probe.mjs"]);
  });

  it.skipIf(!disposableDirectories)("wraps disposable temporary directories like mkdtemp", () => {
    const paths = fixture();
    run(
      paths,
      `import assert from "node:assert/strict";
import fs from "node:fs";
import promises from "node:fs/promises";
import { join } from "node:path";
const inside = process.env.CHROME_VALIDATION_ROOT;
const outside = process.env.GUARD_FIXTURE_OUTSIDE;
assert.throws(() => fs.mkdtempDisposableSync(join(outside, "created-")), /outside ExtensionsV2/);
assert.throws(() => fs.mkdtempDisposableSync(inside), /outside ExtensionsV2/);
await assert.rejects(async () => promises.mkdtempDisposable(join(outside, "created-")), /outside ExtensionsV2/);
const sync = fs.mkdtempDisposableSync("sync-");
assert.ok(fs.existsSync(sync.path));
sync.remove();
assert.equal(fs.existsSync(sync.path), false);
const asynchronous = await promises.mkdtempDisposable(join(inside, "async-"));
assert.ok(fs.existsSync(asynchronous.path));
await asynchronous.remove();
assert.equal(fs.existsSync(asynchronous.path), false);
`,
    );
    expect(readdirSync(paths.directory).sort()).toEqual(["inside", "outside", "probe.mjs"]);
    expect(existsSync(resolve(paths.inside, "blocked.jsonl"))).toBe(true);
  });
});
