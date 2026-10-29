// SPDX-License-Identifier: MPL-2.0

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { linkSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const repository = resolve(import.meta.dirname, "../..");
const guard = resolve(repository, "scripts/validation-scope-guard.mjs");
const evidence = resolve(repository, "audit/local/fixes-code-audit-2026-10-28/filesystem_tests");
const runs: { directory: string; status: number | null; sha256: string }[] = [];
const forms = [
  { name: "default-path", suffix: "::$DATA", representation: "path", uppercase: false },
  { name: "default-buffer", suffix: "::$DATA", representation: "buffer", uppercase: false },
  { name: "default-url", suffix: "::$DATA", representation: "url", uppercase: false },
  { name: "default-case", suffix: "::$dAtA", representation: "path", uppercase: true },
  { name: "named-implicit", suffix: ":audit-stream", representation: "path", uppercase: false },
  { name: "named-path", suffix: ":audit-stream:$DATA", representation: "path", uppercase: false },
  {
    name: "named-buffer",
    suffix: ":audit-stream:$DATA",
    representation: "buffer",
    uppercase: false,
  },
  { name: "named-url", suffix: ":audit-stream:$DATA", representation: "url", uppercase: false },
  { name: "named-case", suffix: ":AuDiT-StReAm:$dAtA", representation: "path", uppercase: true },
  { name: "named-case-url", suffix: ":AuDiT-StReAm:$dAtA", representation: "url", uppercase: true },
] as const;

function fixture(name: string) {
  mkdirSync(evidence, { recursive: true });
  const directory = mkdtempSync(resolve(evidence, `${name}-`));
  const child = relative(evidence, directory);
  if (!child || isAbsolute(child) || child.startsWith(".."))
    throw new Error("Invalid filesystem evidence fixture");
  const inside = resolve(directory, "in-root");
  const outside = resolve(directory, "out-of-root");
  mkdirSync(inside);
  mkdirSync(outside);
  const carrier = resolve(outside, "carrier.txt");
  writeFileSync(carrier, "CARRIER_ORIGINAL");
  writeFileSync(`${carrier}:audit-stream`, "STREAM_ORIGINAL");
  linkSync(carrier, resolve(inside, "alias.txt"));
  writeFileSync(resolve(inside, "source.txt"), "COPY_SOURCE");
  expect(statSync(carrier).nlink).toBeGreaterThan(1);
  expect(readFileSync(`${carrier}::$DATA`, "utf8")).toBe("CARRIER_ORIGINAL");
  expect(readFileSync(resolve(inside, "alias.txt:audit-stream:$DATA"), "utf8")).toBe(
    "STREAM_ORIGINAL",
  );
  return { directory, inside, outside, carrier };
}

function runProbe(
  paths: ReturnType<typeof fixture>,
  source: string,
  log = resolve(paths.inside, "guard.jsonl"),
) {
  const script = resolve(paths.directory, "probe.mjs");
  const sha256 = createHash("sha256").update(readFileSync(guard)).digest("hex");
  writeFileSync(script, source);
  const result = spawnSync(process.execPath, ["--import", pathToFileURL(guard).href, script], {
    cwd: paths.inside,
    env: {
      ...process.env,
      CHROME_VALIDATION_ROOT: paths.inside,
      CHROME_VALIDATION_GUARD_LOG: log,
      STREAM_FIXTURE_OUTSIDE: paths.outside,
      NODE_DISABLE_COMPILE_CACHE: "1",
    },
    encoding: "utf8",
    windowsHide: true,
    timeout: 15_000,
  });
  runs.push({ directory: paths.directory, status: result.status, sha256 });
  writeFileSync(
    resolve(paths.directory, "result.json"),
    JSON.stringify(
      {
        node: process.version,
        platform: process.platform,
        guardSha256: sha256,
        status: result.status,
        error: result.error?.message,
        stdout: result.stdout,
        stderr: result.stderr,
        carrier: readFileSync(paths.carrier, "utf8"),
        stream: readFileSync(`${paths.carrier}:audit-stream`, "utf8"),
      },
      null,
      2,
    ),
  );
  expect(result.error).toBeUndefined();
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  expect(readFileSync(paths.carrier, "utf8")).toBe("CARRIER_ORIGINAL");
  expect(readFileSync(`${paths.carrier}:audit-stream`, "utf8")).toBe("STREAM_ORIGINAL");
}

afterAll(() => {
  if (process.platform !== "win32") return;
  mkdirSync(evidence, { recursive: true });
  writeFileSync(resolve(evidence, "runs.json"), JSON.stringify(runs, null, 2));
});

describe.skipIf(process.platform !== "win32")("CODE09 shared NTFS stream API boundaries", () => {
  it.each(forms)(
    "blocks mutations and permits reads for $name",
    (form) => {
      const paths = fixture(form.name);
      runProbe(
        paths,
        `import assert from "node:assert/strict";
import fs from "node:fs";
import p from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
const form = ${JSON.stringify(form)};
const results = [];
const callback = action => new Promise((done, reject) => action((error, value) => error ? reject(error) : done(value)));
const represent = path => form.representation === "url" ? pathToFileURL(path) : form.representation === "buffer" ? Buffer.from(path) : path;
const streamPath = name => {
  const path = resolve(name);
  return represent((form.uppercase ? path.toUpperCase() : path) + form.suffix);
};
const target = streamPath("alias.txt");
const expected = form.suffix.startsWith("::") ? "CARRIER_ORIGINAL" : "STREAM_ORIGINAL";
const outsideCarrier = resolve(process.env.STREAM_FIXTURE_OUTSIDE, "carrier.txt");
const snapshot = (carrier = outsideCarrier) => {
  const stat = fs.statSync(carrier);
  return {
    carrier: fs.readFileSync(carrier, "utf8"),
    stream: fs.readFileSync(carrier + ":audit-stream", "utf8"),
    size: stat.size, mode: stat.mode, mtimeMs: stat.mtimeMs, links: stat.nlink,
  };
};
const original = snapshot();
async function blocked(name, action, before = original, carrier = outsideCarrier, reason = "hard-linked") {
  let error;
  try { await action(); } catch (caught) { error = caught; }
  const after = snapshot(carrier);
  const rejection = error instanceof Error && error.message.startsWith("Blocked ") && error.message.includes(reason);
  const unchanged = JSON.stringify(before) === JSON.stringify(after);
  results.push({ name, rejection, unchanged, code: error?.code, message: error?.message, before, after });
}
const finishStream = create => new Promise((done, reject) => {
  const stream = create();
  stream.once("error", reject);
  stream.once("finish", done);
  stream.end("CHANGED");
});
const invoke = (name, args, variant) => variant === "sync" ? fs[name + "Sync"](...args) : variant === "promises" ? p[name](...args) : callback(done => fs[name](...args, done));
const pathMutations = [
  ["writeFile", [target, "CHANGED"]],
  ["appendFile", [target, "CHANGED"]],
  ["truncate", [target, 0]],
  ["copyFile", ["source.txt", target]],
  ["cp", ["source.txt", target]],
  ["chmod", [target, 0o444]],
  ["chown", [target, 0, 0]],
  ["utimes", [target, 1100000000, 1100000000]],
  ["lutimes", [target, 1100000000, 1100000000]],
  ["rename", [target, "renamed.txt"]],
  ["link", [target, "new-link.txt"]],
  ["unlink", [target]],
  ["rm", [target]],
];
for (const variant of ["sync", "callback", "promises"]) {
  for (const [name, args] of pathMutations)
    await blocked(name + "." + variant, () => invoke(name, args, variant));
  for (const flags of ["w", "w+", "a", "a+", "r+", "wx", "ax", fs.constants.O_RDWR, fs.constants.O_WRONLY | fs.constants.O_TRUNC])
    await blocked("open." + variant + "." + flags, () => invoke("open", [target, flags], variant));
  assert.equal(await invoke("readFile", [target, "utf8"], variant), expected);
}
assert.equal(await new Promise((done, reject) => {
  let text = "";
  const stream = fs.createReadStream(target, { encoding: "utf8" });
  stream.on("data", chunk => text += chunk);
  stream.on("end", () => done(text));
  stream.on("error", reject);
}), expected);
await blocked("createWriteStream", () => finishStream(() => fs.createWriteStream(target)));
await blocked("WriteStream.constructor", () => finishStream(() => new fs.WriteStream(target)));
const fd = fs.openSync(target, "r");
const fdMutations = [
  ["write", ["CHANGED"]], ["writev", [[Buffer.from("CHANGED")]]],
  ["ftruncate", [0]], ["fchmod", [0o444]], ["fchown", [0, 0]],
  ["futimes", [1100000000, 1100000000]],
  ["writeFile", ["CHANGED"]], ["appendFile", ["CHANGED"]],
];
try {
  for (const variant of ["sync", "callback"])
    for (const [name, args] of fdMutations)
      await blocked("descriptor.read-open." + name + "." + variant, () => invoke(name, [fd, ...args], variant));
  await blocked("descriptor.createWriteStream", () => finishStream(() => fs.createWriteStream(null, { fd, autoClose: false })));
  await blocked("descriptor.WriteStream.constructor", () => finishStream(() => new fs.WriteStream(null, { fd, autoClose: false })));
} finally { fs.closeSync(fd); }
const callbackFd = await callback(done => fs.open(target, "r", done));
try { await blocked("callback-open.descriptor.write", () => callback(done => fs.write(callbackFd, "CHANGED", done))); }
finally { fs.closeSync(callbackFd); }
const handleMutations = [
  ["write", [Buffer.from("CHANGED")]], ["writev", [[Buffer.from("CHANGED")]]],
  ["writeFile", ["CHANGED"]], ["appendFile", ["CHANGED"]], ["truncate", [0]],
  ["chmod", [0o444]], ["chown", [0, 0]], ["utimes", [1100000000, 1100000000]],
];
const handle = await p.open(target, "r");
try {
  assert.equal(await handle.readFile("utf8"), expected);
  for (const [name, args] of handleMutations)
    await blocked("FileHandle.read-open." + name, () => handle[name](...args));
  await blocked("FileHandle.read-open.createWriteStream", () => finishStream(() => handle.createWriteStream({ autoClose: false })));
} finally { await handle.close(); }
// Descriptors opened while a carrier was private must re-check it after a new link.
for (const kind of ["sync", "callback", "FileHandle"]) {
  const carrier = resolve("late-" + kind + ".txt");
  fs.writeFileSync(carrier, "CARRIER_ORIGINAL");
  fs.writeFileSync(carrier + ":audit-stream", "STREAM_ORIGINAL");
  const path = streamPath(carrier);
  const descriptor = kind === "FileHandle" ? await p.open(path, "r+") : kind === "callback" ? await callback(done => fs.open(path, "r+", done)) : fs.openSync(path, "r+");
  fs.linkSync(carrier, carrier + ".alias");
  const before = snapshot(carrier);
  try {
    if (kind === "FileHandle") {
      for (const [name, args] of handleMutations)
        await blocked("FileHandle.late-share." + name, () => descriptor[name](...args), before, carrier);
      await blocked("FileHandle.late-share.createWriteStream", () => finishStream(() => descriptor.createWriteStream({ autoClose: false })), before, carrier);
    } else {
      for (const [name, args] of fdMutations)
        await blocked(kind + ".late-share." + name, () => invoke(name, [descriptor, ...args], kind), before, carrier);
      await blocked(kind + ".late-share.createWriteStream", () => finishStream(() => fs.createWriteStream(null, { fd: descriptor, autoClose: false })), before, carrier);
    }
    fs.unlinkSync(carrier + ".alias");
    if (kind === "FileHandle") await descriptor.writeFile("ALLOWED");
    else fs.writeSync(descriptor, "ALLOWED");
    assert.equal(fs.readFileSync(path, "utf8").startsWith("ALLOWED"), true);
  } finally {
    if (kind === "FileHandle") await descriptor.close(); else fs.closeSync(descriptor);
  }
}
// Ordinary shared carriers are permitted copy sources; private streams remain writable.
for (const variant of ["sync", "callback", "promises"]) {
  const copied = "copied-" + variant + ".txt";
  await invoke("copyFile", ["alias.txt", copied], variant);
  assert.equal(fs.readFileSync(copied, "utf8"), "CARRIER_ORIGINAL");
  const cpDestination = "cp-" + variant + ".txt";
  await invoke("cp", ["alias.txt", cpDestination], variant);
  assert.equal(fs.readFileSync(cpDestination, "utf8"), "CARRIER_ORIGINAL");
  const privateCarrier = resolve("private-" + variant + ".txt");
  fs.writeFileSync(privateCarrier, "PRIVATE");
  const path = streamPath(privateCarrier);
  await invoke("writeFile", [path, "PRIVATE"], variant);
  await invoke("appendFile", [path, "_WRITE"], variant);
  assert.equal(fs.readFileSync(path, "utf8"), "PRIVATE_WRITE");
  await invoke("truncate", [path, 7], variant);
  assert.equal(fs.readFileSync(path, "utf8"), "PRIVATE");
  await invoke("copyFile", ["source.txt", path], variant);
  assert.equal(fs.readFileSync(path, "utf8"), "COPY_SOURCE");
}
const outsideTarget = represent(outsideCarrier + form.suffix);
await blocked("outside.stream.writeFile", () => fs.writeFileSync(outsideTarget, "CHANGED"), original, outsideCarrier, "outside ExtensionsV2");
console.log(JSON.stringify({ form, total: results.length, passed: results.filter(row => row.rejection && row.unchanged).length, results }));
assert.deepEqual(results.filter(row => !row.rejection || !row.unchanged).map(row => ({ name: row.name, message: row.message, unchanged: row.unchanged })), []);
`,
      );
    },
    20_000,
  );

  it.each(["sync", "callback", "FileHandle"])(
    "rejects %s descriptor mutations after its stream carrier is moved or replaced",
    (kind) => {
      const paths = fixture(`carrier-identity-${kind}`);
      runProbe(
        paths,
        `import assert from "node:assert/strict";
import fs from "node:fs";
import p from "node:fs/promises";
import { resolve } from "node:path";
const kind = ${JSON.stringify(kind)};
const results = [];
const callback = action => new Promise((done, reject) => action((error, value) => error ? reject(error) : done(value)));
const finishStream = create => new Promise((done, reject) => {
  const stream = create();
  stream.once("error", reject); stream.once("finish", done); stream.end("CHANGED");
});
const snapshot = carrier => ({
  content: fs.readFileSync(carrier, "utf8"),
  stream: fs.readFileSync(carrier + ":audit-stream", "utf8"),
  mtimeMs: fs.statSync(carrier).mtimeMs, mode: fs.statSync(carrier).mode,
});
for (const suffix of ["::$DATA", ":audit-stream:$DATA"])
  for (const access of ["readonly-shared", "writable-before-share"])
    for (const change of ["renamed", "unlinked", "replaced"]) {
      const name = [suffix.startsWith("::") ? "default" : "named", access, change].join("-");
      const carrier = resolve(name + ".txt");
      const survivor = carrier + ".survivor";
      if (access === "readonly-shared") fs.linkSync("alias.txt", carrier);
      else {
        fs.writeFileSync(carrier, "CARRIER_ORIGINAL");
        fs.writeFileSync(carrier + ":audit-stream", "STREAM_ORIGINAL");
      }
      const target = carrier + suffix;
      const flags = access === "readonly-shared" ? "r" : "r+";
      const descriptor = kind === "FileHandle" ? await p.open(target, flags) : kind === "callback" ? await callback(done => fs.open(target, flags, done)) : fs.openSync(target, flags);
      fs.linkSync(carrier, survivor);
      if (change === "renamed") fs.renameSync(carrier, carrier + ".moved");
      else fs.unlinkSync(carrier);
      if (change === "replaced") fs.writeFileSync(carrier, "REPLACEMENT");
      const before = snapshot(survivor);
      const mutations = kind === "FileHandle" ? [
        ["write", [Buffer.from("CHANGED")]], ["writev", [[Buffer.from("CHANGED")]]],
        ["writeFile", ["CHANGED"]], ["appendFile", ["CHANGED"]], ["truncate", [0]],
        ["chmod", [0o444]], ["chown", [0, 0]], ["utimes", [1100000000, 1100000000]],
      ] : [
        ["write", ["CHANGED"]], ["writev", [[Buffer.from("CHANGED")]]],
        ["writeFile", ["CHANGED"]], ["appendFile", ["CHANGED"]], ["ftruncate", [0]],
        ["fchmod", [0o444]], ["fchown", [0, 0]], ["futimes", [1100000000, 1100000000]],
      ];
      try {
        const check = async (method, action) => {
          let error;
          try { await action(); } catch (caught) { error = caught; }
          const after = snapshot(survivor);
          const rejection = error instanceof Error && /^Blocked write through missing or replaced stream carrier/.test(error.message);
          const unchanged = JSON.stringify(before) === JSON.stringify(after);
          results.push({ name: name + "." + method, rejection, unchanged, code: error?.code, message: error?.message, before, after });
        };
        for (const [method, args] of mutations)
          await check(method, () => kind === "FileHandle" ? descriptor[method](...args) : kind === "sync" ? fs[method + "Sync"](descriptor, ...args) : callback(done => fs[method](descriptor, ...args, done)));
        await check("createWriteStream", () => finishStream(() => kind === "FileHandle" ? descriptor.createWriteStream({ autoClose: false }) : fs.createWriteStream(null, { fd: descriptor, autoClose: false })));
        assert.equal(kind === "FileHandle" ? await descriptor.readFile("utf8") : fs.readFileSync(descriptor, "utf8"), suffix.startsWith("::") ? "CARRIER_ORIGINAL" : "STREAM_ORIGINAL");
        if (change === "replaced") assert.equal(fs.readFileSync(carrier, "utf8"), "REPLACEMENT");
      } finally {
        if (kind === "FileHandle") await descriptor.close(); else fs.closeSync(descriptor);
      }
    }
console.log(JSON.stringify({ kind, total: results.length, passed: results.filter(row => row.rejection && row.unchanged).length, results }));
assert.deepEqual(results.filter(row => !row.rejection || !row.unchanged).map(row => ({ name: row.name, message: row.message, unchanged: row.unchanged })), []);
`,
      );
    },
    20_000,
  );

  it("does not append rejection logs through an ADS of a shared carrier", () => {
    const paths = fixture("shared-stream-log");
    runProbe(
      paths,
      `import assert from "node:assert/strict";
import fs from "node:fs";
import { resolve } from "node:path";
assert.throws(() => fs.writeFileSync(resolve(process.env.STREAM_FIXTURE_OUTSIDE, "carrier.txt"), "CHANGED"), /Blocked write outside ExtensionsV2/);
console.log(JSON.stringify({ total: 1, passed: 1 }));
`,
      resolve(paths.inside, "alias.txt:audit-stream:$DATA"),
    );
  });
});
