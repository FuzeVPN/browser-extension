// SPDX-License-Identifier: MPL-2.0

import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = resolve(import.meta.dirname, "../..");
const evidence = resolve(root, "audit/local/fixes-reaudit-2026-10-27/build");
const fixtures: string[] = [];

function fixture() {
  mkdirSync(evidence, { recursive: true });
  const directory = mkdtempSync(resolve(evidence, "filesystem-"));
  const child = relative(evidence, directory);
  if (!child || isAbsolute(child) || child.startsWith(".."))
    throw new Error("Invalid filesystem fixture path");
  fixtures.push(directory);
  const project = resolve(directory, "project");
  mkdirSync(project);
  return { directory, project };
}

function run(directory: string, project: string, source: string, guarded = true) {
  const script = resolve(directory, "probe.mjs");
  writeFileSync(script, source);
  const result = spawnSync(
    process.execPath,
    [
      ...(guarded
        ? ["--import", pathToFileURL(resolve(root, "scripts/validation-scope-guard.mjs")).href]
        : []),
      script,
    ],
    {
      cwd: project,
      env: {
        ...process.env,
        CHROME_VALIDATION_ROOT: project,
        CHROME_VALIDATION_GUARD_LOG: resolve(project, "blocked.jsonl"),
        FILESYSTEM_SOURCE_ROOT: root,
        FILESYSTEM_FIXTURE: directory,
        NODE_DISABLE_COMPILE_CACHE: "1",
      },
      encoding: "utf8",
      windowsHide: true,
      timeout: 15_000,
    },
  );
  writeFileSync(
    resolve(directory, "result.json"),
    JSON.stringify(
      { status: result.status, stdout: result.stdout, stderr: result.stderr },
      null,
      2,
    ),
  );
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
}

afterAll(() => {
  // Fixtures and their rejection logs remain available as audit evidence.
  writeFileSync(resolve(evidence, "filesystem-fixtures.json"), JSON.stringify(fixtures, null, 2));
});

describe("validation filesystem boundaries", () => {
  it.each(["sync", "callback", "promises"])(
    "checks both endpoints of %s hard-link creation",
    (variant) => {
      const { directory, project } = fixture();
      writeFileSync(resolve(directory, "outside.txt"), "OUTSIDE\n");
      writeFileSync(resolve(project, "inside.txt"), "INSIDE\n");
      run(
        directory,
        project,
        `import assert from "node:assert/strict";
import fs from "node:fs";
import promises from "node:fs/promises";
import { resolve } from "node:path";
const variant = ${JSON.stringify(variant)};
const inside = process.env.CHROME_VALIDATION_ROOT;
const outside = process.env.FILESYSTEM_FIXTURE;
async function link(source, destination) {
  if (variant === "sync") return fs.linkSync(source, destination);
  if (variant === "promises") return promises.link(source, destination);
  return new Promise((done, reject) => fs.link(source, destination, error => error ? reject(error) : done()));
}
await assert.rejects(link(resolve(outside, "outside.txt"), resolve(inside, "alias.txt")), /outside ExtensionsV2/);
await assert.rejects(link(resolve(inside, "inside.txt"), resolve(outside, "alias.txt")), /outside ExtensionsV2/);
assert.equal(fs.existsSync(resolve(inside, "alias.txt")), false);
assert.equal(fs.existsSync(resolve(outside, "alias.txt")), false);
assert.equal(fs.readFileSync(resolve(outside, "outside.txt"), "utf8"), "OUTSIDE\\n");
`,
      );
    },
  );

  it("refuses writes through pre-existing shared aliases, including recursive copy outputs", () => {
    const { directory, project } = fixture();
    const outside = resolve(directory, "outside.txt");
    writeFileSync(outside, "OUTSIDE\n");
    linkSync(outside, resolve(project, "alias.txt"));
    mkdirSync(resolve(project, "source"));
    mkdirSync(resolve(project, "destination"));
    writeFileSync(resolve(project, "source/alias.txt"), "COPY\n");
    linkSync(outside, resolve(project, "destination/alias.txt"));
    run(
      directory,
      project,
      `import assert from "node:assert/strict";
import fs from "node:fs";
import promises from "node:fs/promises";
assert.throws(() => fs.writeFileSync("alias.txt", "CHANGED"), /hard-linked/);
await assert.rejects(new Promise((done, reject) => fs.writeFile("alias.txt", "CHANGED", error => error ? reject(error) : done())), /hard-linked/);
await assert.rejects(async () => promises.writeFile("alias.txt", "CHANGED"), /hard-linked/);
assert.throws(() => fs.appendFileSync("alias.txt", "CHANGED"), /hard-linked/);
assert.throws(() => fs.truncateSync("alias.txt"), /hard-linked/);
assert.throws(() => fs.openSync("alias.txt", "w"), /hard-linked/);
await assert.rejects(async () => promises.open("alias.txt", "r+"), /hard-linked/);
assert.throws(() => fs.createWriteStream("alias.txt"), /hard-linked/);
assert.throws(() => fs.copyFileSync("source/alias.txt", "alias.txt"), /hard-linked/);
assert.throws(() => fs.cpSync("source", "destination", { recursive: true }), /hard-linked/);
assert.equal(fs.readFileSync("alias.txt", "utf8"), "OUTSIDE\\n");
`,
    );
    expect(readFileSync(outside, "utf8")).toBe("OUTSIDE\n");
  });

  it("checks descriptors again after internal links and permits safe alias cleanup", () => {
    const { directory, project } = fixture();
    run(
      directory,
      project,
      `import assert from "node:assert/strict";
import fs from "node:fs";
import promises from "node:fs/promises";
fs.writeFileSync("sync.txt", "ORIGINAL");
const descriptor = fs.openSync("sync.txt", "r+");
fs.linkSync("sync.txt", "sync-alias.txt");
assert.throws(() => fs.writeSync(descriptor, "CHANGED"), /hard-linked/);
assert.throws(() => fs.createWriteStream(null, { fd: descriptor }), /hard-linked/);
fs.unlinkSync("sync-alias.txt");
fs.writeSync(descriptor, "ALLOWED");
fs.closeSync(descriptor);
fs.writeFileSync("promise.txt", "ORIGINAL");
const handle = await promises.open("promise.txt", "r+");
await promises.link("promise.txt", "promise-alias.txt");
await assert.rejects(async () => handle.writeFile("CHANGED"), /hard-linked/);
assert.throws(() => handle.createWriteStream(), /hard-linked/);
await promises.unlink("promise-alias.txt");
await handle.writeFile("ALLOWED");
await handle.close();
assert.equal(fs.readFileSync("promise.txt", "utf8"), "ALLOWEDL");
`,
    );
  });

  it("does not write rejection logs through an existing hard link", () => {
    const { directory, project } = fixture();
    const outside = resolve(directory, "outside.txt");
    writeFileSync(outside, "OUTSIDE\n");
    linkSync(outside, resolve(project, "blocked.jsonl"));
    run(
      directory,
      project,
      `import assert from "node:assert/strict";
import fs from "node:fs";
import { resolve } from "node:path";
assert.throws(() => fs.writeFileSync(resolve(process.env.FILESYSTEM_FIXTURE, "outside.txt"), "CHANGED"), /outside ExtensionsV2/);
`,
    );
    expect(readFileSync(outside, "utf8")).toBe("OUTSIDE\n");
  });

  it("preserves junction and lexical escape rejection before output writes", () => {
    const { directory, project } = fixture();
    mkdirSync(resolve(directory, "protected"));
    writeFileSync(resolve(directory, "protected/sentinel.txt"), "SURVIVE\n");
    symlinkSync(resolve(directory, "protected"), resolve(project, "junction"), "junction");
    run(
      directory,
      project,
      `import assert from "node:assert/strict";
import fs from "node:fs";
assert.throws(() => fs.writeFileSync("junction/sentinel.txt", "CHANGED"), /outside ExtensionsV2/);
assert.throws(() => fs.writeFileSync("../escaped.txt", "CHANGED"), /outside ExtensionsV2/);
`,
    );
    expect(readFileSync(resolve(directory, "protected/sentinel.txt"), "utf8")).toBe("SURVIVE\n");
    expect(existsSync(resolve(directory, "escaped.txt"))).toBe(false);
  });

  it("inventories and archives __proto__ at every level without changing public paths", () => {
    const { directory, project } = fixture();
    cpSync(resolve(root, "scripts"), resolve(project, "scripts"), { recursive: true });
    writeFileSync(resolve(project, "package.json"), '{"type":"module"}\n');
    mkdirSync(resolve(project, "assets/nested"), { recursive: true });
    mkdirSync(resolve(project, "src"));
    writeFileSync(resolve(project, "assets/__proto__"), "ROOT\n");
    writeFileSync(resolve(project, "assets/nested/__proto__"), "NESTED\n");
    writeFileSync(resolve(project, "src/__proto__"), "SOURCE\n");
    run(
      directory,
      project,
      `import assert from "node:assert/strict";
import fs from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
const base = process.env.CHROME_VALIDATION_ROOT;
const { inventory, canonical, digest } = await import(pathToFileURL(resolve(base, "scripts/verify-dist.mjs")));
const { fileHashes, sourceHashes, assertInsideProject } = await import(pathToFileURL(resolve(base, "scripts/validation-common.mjs")));
const { publishArchive, verifyArchive } = await import(pathToFileURL(resolve(base, "scripts/package.mjs")));
const { readZip } = await import(pathToFileURL(resolve(base, "scripts/zip.mjs")));
const assets = resolve(base, "assets");
fs.symlinkSync(assets, resolve(base, "linked-assets"), "junction");
await assert.rejects(inventory(resolve(base, "linked-assets")), /path is a link/);
assert.throws(() => fileHashes(resolve(base, "linked-assets")), /path is a link/);
const files = await inventory(assets);
assert.equal(Object.getPrototypeOf(files), null);
assert.deepEqual(Object.keys(files), ["__proto__", "nested/__proto__"]);
assert.equal(files.__proto__, digest("ROOT\\n"));
assert.equal(files["nested/__proto__"], digest("NESTED\\n"));
assert.equal(canonical(files), canonical(fileHashes(assets)));
assert.equal(sourceHashes()["src/__proto__"], digest("SOURCE\\n"));
const entries = Object.keys(files).map(name => [name, fs.readFileSync(resolve(assets, name))]);
const published = await publishArchive({directory: resolve(base, "releases"), name: "synthetic.zip", entries, expected: files});
assert.equal(published.preserved, false);
const bytes = fs.readFileSync(resolve(base, "releases/synthetic.zip"));
verifyArchive(bytes, files);
assert.deepEqual([...readZip(bytes).keys()], ["__proto__", "nested/__proto__"]);
assert.equal((await publishArchive({directory: resolve(base, "releases"), name: "synthetic.zip", entries, expected: files})).preserved, true);
assert.throws(() => assertInsideProject(resolve(base, "../outside.txt")), /inside ExtensionsV2/);
`,
    );
    expect(readdirSync(resolve(project, "releases"))).toEqual([
      "synthetic.sha256",
      "synthetic.zip",
    ]);
  });
});
