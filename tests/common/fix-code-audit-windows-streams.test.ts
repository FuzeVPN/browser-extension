// SPDX-License-Identifier: MPL-2.0

import { spawnSync } from "node:child_process";
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = resolve(import.meta.dirname, "../..");
const evidence = resolve(root, "audit/local/fixes-code-audit-2026-10-28/scope_guard");
const fixtures: string[] = [];

function fixture() {
  mkdirSync(evidence, { recursive: true });
  const directory = mkdtempSync(resolve(evidence, "streams-"));
  const child = relative(evidence, directory);
  if (!child || isAbsolute(child) || child.startsWith(".."))
    throw new Error("Invalid stream fixture path");
  fixtures.push(directory);
  const project = resolve(directory, "project");
  mkdirSync(project);
  const outside = resolve(directory, "outside.txt");
  const alias = resolve(project, "alias.txt");
  writeFileSync(outside, "OUTSIDE DEFAULT STREAM");
  writeFileSync(`${outside}:existing`, "OUTSIDE NAMED STREAM");
  linkSync(outside, alias);
  writeFileSync(resolve(project, "inside.txt"), "INSIDE");
  return { directory, project, outside, alias };
}

function run(f: ReturnType<typeof fixture>, source: string, log?: string) {
  const before = {
    content: readFileSync(f.outside, "utf8"),
    named: readFileSync(`${f.outside}:existing`, "utf8"),
    mtime: statSync(f.outside).mtimeMs,
  };
  const script = resolve(f.directory, "probe.mjs");
  writeFileSync(
    script,
    `import assert from "node:assert/strict";
import fs from "node:fs";
import p from "node:fs/promises";
import {resolve} from "node:path";
import {pathToFileURL} from "node:url";
const reject = (operation, pattern = /Blocked .*hard-linked/) => assert.rejects(async () => operation(), pattern);
const callback = operation => new Promise((done, reject) => operation((error, value) => error ? reject(error) : done(value)));
${source}
console.log("PASS");
`,
  );
  const result = spawnSync(
    process.execPath,
    ["--import", pathToFileURL(resolve(root, "scripts/validation-scope-guard.mjs")).href, script],
    {
      cwd: f.project,
      env: {
        ...process.env,
        CHROME_VALIDATION_ROOT: f.project,
        CHROME_VALIDATION_GUARD_LOG: log ?? resolve(f.project, "blocked.jsonl"),
        STREAM_FIXTURE_OUTSIDE: f.outside,
        STREAM_FIXTURE_DIRECTORY: f.directory,
        NODE_DISABLE_COMPILE_CACHE: "1",
      },
      encoding: "utf8",
      windowsHide: true,
      timeout: 15_000,
    },
  );
  const after = {
    content: readFileSync(f.outside, "utf8"),
    named: readFileSync(`${f.outside}:existing`, "utf8"),
    mtime: statSync(f.outside).mtimeMs,
  };
  writeFileSync(
    resolve(f.directory, "result.json"),
    JSON.stringify(
      { status: result.status, stdout: result.stdout, stderr: result.stderr, before, after },
      null,
      2,
    ),
  );
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toContain("PASS");
  expect(after).toEqual(before);
  expect(existsSync(`${f.outside}:new`)).toBe(false);
}

afterAll(() => {
  if (fixtures.length)
    writeFileSync(resolve(evidence, "stream-fixtures.json"), JSON.stringify(fixtures, null, 2));
});

describe.skipIf(process.platform !== "win32")("NTFS stream carrier boundaries", () => {
  it.each(["sync", "callback", "promises"])(
    "checks stream carriers before %s writes and copy outputs",
    (variant) => {
      const f = fixture();
      run(
        f,
        `
const variant = ${JSON.stringify(variant)};
const call = (name, ...args) => variant === "sync" ? fs[name + "Sync"](...args)
  : variant === "promises" ? p[name](...args) : callback(done => fs[name](...args, done));
for (const stream of ["alias.txt:new", "alias.txt:existing:$DATA", "alias.txt::$DATA"]) {
  await reject(() => call("writeFile", stream, "CHANGED"));
  await reject(() => call("appendFile", stream, "CHANGED"));
  await reject(() => call("copyFile", "inside.txt", stream));
  await reject(() => call("cp", "inside.txt", stream));
  await reject(() => call("open", stream, "w"));
}
`,
      );
    },
  );

  it("normalizes Windows casing, buffers and file URLs without treating the drive colon as a stream", () => {
    const f = fixture();
    run(
      f,
      `
for (const path of [resolve("ALIAS.TXT:NEW"), Buffer.from(resolve("alias.txt:new")), pathToFileURL(resolve("alias.txt:new")), new URL(pathToFileURL(resolve("alias.txt:new")).href.replace(":new", "%3Anew"))])
  await reject(() => fs.writeFileSync(path, "CHANGED"));
fs.writeFileSync(pathToFileURL(resolve("inside.txt")), "ALLOWED");
fs.writeFileSync(resolve("inside.txt").toUpperCase(), "ALLOWED CASE");
fs.writeFileSync("inside.txt:new", "ALLOWED STREAM");
assert.equal(fs.readFileSync("inside.txt:new", "utf8"), "ALLOWED STREAM");
`,
    );
  });

  it.each(["sync", "callback", "promises"])(
    "checks shared ADS source/destination before %s rename and link operations",
    (variant) => {
      const f = fixture();
      run(
        f,
        `
const variant = ${JSON.stringify(variant)};
const call = (name, ...args) => variant === "sync" ? fs[name + "Sync"](...args)
  : variant === "promises" ? p[name](...args) : callback(done => fs[name](...args, done));
for (const name of ["rename", "link"]) {
  await reject(() => call(name, "alias.txt:existing", "inside.txt:new"));
  await reject(() => call(name, "inside.txt", "alias.txt:new"));
}
await reject(() => call("unlink", "alias.txt:existing"));
await reject(() => call("rm", "alias.txt:existing"));
await call("rename", "alias.txt", "renamed-alias.txt");
await call("link", "renamed-alias.txt", "second-alias.txt");
await call("unlink", "second-alias.txt");
await call("unlink", "renamed-alias.txt");
`,
      );
    },
  );

  it("resolves the carrier through a junction before creating a missing stream", () => {
    const f = fixture();
    symlinkSync(f.directory, resolve(f.project, "junction"), "junction");
    run(
      f,
      `
for (const path of ["junction/outside.txt:new", Buffer.from("junction/outside.txt:new"), pathToFileURL(resolve("junction/outside.txt:new"))])
  await reject(() => fs.writeFileSync(path, "CHANGED"), /Blocked .*outside ExtensionsV2/);
`,
    );
  });

  it.each(["sync", "callback", "callback-default", "promises"])(
    "tracks %s read descriptors for later stream mutations while allowing reads",
    (variant) => {
      const f = fixture();
      run(
        f,
        `
const variant = ${JSON.stringify(variant)};
const opened = variant === "sync" ? fs.openSync("alias.txt:existing", "r")
  : variant === "promises" ? await p.open("alias.txt:existing", "r")
  : variant === "callback-default" ? await callback(done => fs.open("alias.txt:existing", done))
  : await callback(done => fs.open("alias.txt:existing", "r", done));
const fd = typeof opened === "number" ? opened : opened.fd;
const data = Buffer.alloc(20);
assert.equal(fs.readSync(fd, data, 0, data.length, 0), data.length);
assert.equal(data.toString(), "OUTSIDE NAMED STREAM");
for (const operation of [() => fs.writeSync(fd, "CHANGED"), () => fs.writevSync(fd, [Buffer.from("CHANGED")]),
  () => fs.ftruncateSync(fd, 0), () => fs.fchmodSync(fd, 0o444), () => fs.futimesSync(fd, 1, 1),
  () => fs.writeFileSync(fd, "CHANGED"), () => fs.appendFileSync(fd, "CHANGED"),
  () => fs.createWriteStream(null, {fd}), () => new fs.WriteStream(null, {fd})]) await reject(operation);
if (typeof opened === "number") fs.closeSync(fd);
else { await reject(() => opened.writeFile("CHANGED")); await opened.close(); }
assert.equal(fs.readFileSync("alias.txt:existing", "utf8"), "OUTSIDE NAMED STREAM");
assert.equal(await p.readFile("alias.txt:existing", "utf8"), "OUTSIDE NAMED STREAM");
fs.copyFileSync("alias.txt", "read-copy.txt");
assert.equal(fs.readFileSync("read-copy.txt", "utf8"), "OUTSIDE DEFAULT STREAM");
await p.writeFile("stream-read-copy.txt", await p.readFile("alias.txt:existing"));
assert.equal(fs.readFileSync("stream-read-copy.txt", "utf8"), "OUTSIDE NAMED STREAM");
`,
      );
    },
  );

  it("blocks write-stream factories and constructors before stream creation", () => {
    const f = fixture();
    run(
      f,
      `
for (const path of ["alias.txt:new", pathToFileURL(resolve("alias.txt:new"))]) {
  await reject(() => fs.createWriteStream(path));
  await reject(() => new fs.WriteStream(path));
  await reject(() => fs.WriteStream(path));
}
`,
    );
  });

  it("rejects stale stream descriptors after their carrier is renamed or replaced", () => {
    const f = fixture();
    run(
      f,
      `
fs.writeFileSync("inside.txt:live", "LIVE STREAM");
const descriptor = fs.openSync("inside.txt:live", "r+");
fs.linkSync("inside.txt", "live-alias.txt");
fs.renameSync("inside.txt", "renamed-live.txt");
await reject(() => fs.writeSync(descriptor, "CHANGED"), /Blocked .*missing or replaced stream carrier/);
fs.writeFileSync("inside.txt", "REPLACEMENT");
await reject(() => fs.writeSync(descriptor, "CHANGED"), /Blocked .*missing or replaced stream carrier/);
fs.closeSync(descriptor);
assert.equal(fs.readFileSync("live-alias.txt:live", "utf8"), "LIVE STREAM");
const external = await p.open("alias.txt:existing", "r");
fs.renameSync("alias.txt", "renamed-external.txt");
await reject(() => external.writeFile("CHANGED"), /Blocked .*missing or replaced stream carrier/);
await external.close();
`,
    );
  });

  it("does not append rejection logs through a shared stream carrier", () => {
    const f = fixture();
    run(
      f,
      `
await reject(() => fs.writeFileSync(process.env.STREAM_FIXTURE_OUTSIDE, "CHANGED"), /Blocked .*outside ExtensionsV2/);
`,
      `${f.alias}:existing`,
    );
  });
});
