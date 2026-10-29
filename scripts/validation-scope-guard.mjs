// SPDX-License-Identifier: MPL-2.0

// Loaded before Node validation tools and inherited by Node child processes.
// Native browser/Python outputs are scoped separately by their environment and profile arguments.
// This is validation instrumentation, not an OS sandbox: inherited descriptors,
// native code and concurrent filesystem replacement are outside its guarantees.
import fs from "node:fs";
import promises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { dirname, isAbsolute, parse, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(process.env.CHROME_VALIDATION_ROOT || resolve(import.meta.dirname, ".."));
const native = {
  existsSync: fs.existsSync,
  realpathSync: fs.realpathSync,
  readlinkSync: fs.readlinkSync,
  appendFileSync: fs.appendFileSync,
  statSync: fs.statSync,
  lstatSync: fs.lstatSync,
  fstatSync: fs.fstatSync,
  readdirSync: fs.readdirSync,
};
const realRoot = native.realpathSync(root);
const descriptorPaths = new Map();
const filePath = (value) => resolve(value instanceof URL ? fileURLToPath(value) : String(value));
function carrierPath(target) {
  if (process.platform !== "win32") return target;
  // NTFS streams share their carrier's links and real location, but stat/fstat
  // on a stream can report a different link count. Skip the volume's colon.
  const colon = target.indexOf(":", parse(target).root.length);
  return colon < 0 ? target : target.slice(0, colon);
}
function trackedPath(path) {
  let carrier;
  if (carrierPath(path) !== path) {
    try {
      carrier = native.statSync(carrierPath(path), { bigint: true, throwIfNoEntry: false });
    } catch {
      // Opening a stream for reading must not require additional permissions.
      // Its writes will fail closed if the carrier cannot be identified.
    }
  }
  return { path, carrier };
}
const outside = (base, target) => {
  const path = relative(base, target);
  return isAbsolute(path) || path === ".." || path.startsWith("../") || path.startsWith("..\\");
};

function sharedFile(value) {
  const stat =
    typeof value === "number"
      ? native.fstatSync(value)
      : native.statSync(carrierPath(value), { throwIfNoEntry: false });
  // The other link names cannot be enumerated portably, so reject all shared
  // regular files conservatively, even when every known alias is inside root.
  return stat?.isFile() && stat.nlink > 1;
}

const linkLimit = 40;

// Where an operation on `target` may land: the real path of its deepest existing
// entry plus the missing names below it. A dangling link is followed, as an
// open or a creation through it would be, instead of validating its parent.
// Every checked path is resolved this way, even for an operation which acts on
// the link itself, such as a removal or lutimes.
function landing(target, links = 0) {
  let existing = target;
  let entry;
  while (
    !(entry = native.lstatSync(existing, { throwIfNoEntry: false })) &&
    dirname(existing) !== existing
  )
    existing = dirname(existing);
  const missing = relative(existing, target);
  if (!entry?.isSymbolicLink() || native.existsSync(existing))
    return resolve(native.realpathSync(existing), missing);
  // Follow at most linkLimit dangling links. A cycle or a longer chain has no
  // known landing, so every checked operation on it is refused, even a removal
  // or lutimes of the link itself, which the OS allows.
  if (links >= linkLimit) return undefined;
  const link = native.readlinkSync(existing);
  return landing(resolve(native.realpathSync(dirname(existing)), link, missing), links + 1);
}

// Why an operation on `target` is refused, or undefined when it stays in root.
function refusal(target) {
  target = carrierPath(target);
  const real = landing(target);
  if (outside(root, target) || (real !== undefined && outside(realRoot, real)))
    return "write outside ExtensionsV2";
  if (real === undefined) return `write to link cycle or chain over ${linkLimit} links`;
  return undefined;
}

function scoped(target) {
  return refusal(target) === undefined;
}

function blocked(target, operation, reason) {
  const message = { at: new Date().toISOString(), pid: process.pid, operation, path: target };
  const log = process.env.CHROME_VALIDATION_GUARD_LOG;
  // Logging a rejection must not itself follow an external or shared alias.
  if (log && scoped(resolve(log)) && !sharedFile(resolve(log)))
    native.appendFileSync(log, `${JSON.stringify(message)}\n`);
  throw new Error(`Blocked ${reason} (${operation}): ${target}`);
}

function check(value, operation, mutatesFile = false) {
  const descriptor = typeof value === "number" ? value : value?.fd;
  if (typeof descriptor === "number") {
    const tracked = descriptorPaths.get(descriptor);
    if (mutatesFile && tracked) check(tracked.path, operation, true);
    if (mutatesFile && tracked && carrierPath(tracked.path) !== tracked.path) {
      const current = native.statSync(carrierPath(tracked.path), {
        bigint: true,
        throwIfNoEntry: false,
      });
      if (!current || current.dev !== tracked.carrier?.dev || current.ino !== tracked.carrier?.ino)
        blocked(tracked.path, operation, "write through missing or replaced stream carrier");
    }
    if (mutatesFile && sharedFile(descriptor))
      blocked(`descriptor ${descriptor}`, operation, "write to hard-linked file");
    return;
  }
  const target = filePath(value);
  const reason = refusal(target);
  if (reason) blocked(target, operation, reason);
  // Removing/renaming a stream also mutates the carrier. Removing an ordinary
  // hard-link name remains safe and must stay available for alias cleanup.
  if ((mutatesFile || carrierPath(target) !== target) && sharedFile(target))
    blocked(target, operation, "write to hard-linked file");
}

function checkCopyTree(value, operation, seen = new Set()) {
  const target = filePath(value);
  check(target, operation, true);
  const stat = native.statSync(target, { throwIfNoEntry: false });
  if (stat?.isDirectory()) {
    const path = native.realpathSync(target);
    if (seen.has(path)) return;
    seen.add(path);
    for (const entry of native.readdirSync(target))
      checkCopyTree(resolve(target, entry), operation, seen);
  }
}

const both = new Set(["rename", "link"]);
const destination = new Set(["copyFile", "cp", "symlink"]);
// mkdtemp appends random characters to the prefix's last name: a prefix naming
// root creates a sibling of root, so check the created path, not the prefix.
const temporary = new Set(["mkdtemp", "mkdtempDisposable"]);
const temporaryPath = (prefix) =>
  `${prefix instanceof URL ? fileURLToPath(prefix) : String(prefix)}XXXXXX`;
const mutatesFile = new Set([
  "appendFile",
  "copyFile",
  "truncate",
  "writeFile",
  "chmod",
  "chown",
  "lchmod",
  "lchown",
  "utimes",
  "lutimes",
]);
for (const name of [
  "appendFile",
  "copyFile",
  "cp",
  "mkdir",
  "mkdtemp",
  // Node 24 only; absent methods are skipped on older runtimes.
  "mkdtempDisposable",
  "rename",
  "rm",
  "rmdir",
  "truncate",
  "unlink",
  "writeFile",
  "chmod",
  "chown",
  "lchmod",
  "lchown",
  "utimes",
  "lutimes",
  "link",
  "symlink",
]) {
  for (const [object, property] of [
    [fs, name],
    [fs, `${name}Sync`],
    [promises, name],
  ]) {
    const original = object[property];
    if (!original) continue;
    object[property] = function (...args) {
      if (both.has(name)) {
        check(args[0], property);
        check(args[1], property);
      } else if (name === "cp") checkCopyTree(args[1], property);
      else if (temporary.has(name)) check(temporaryPath(args[0]), property);
      else check(args[destination.has(name) ? 1 : 0], property, mutatesFile.has(name));
      return original.apply(this, args);
    };
  }
}

const writingFlags = (flags) =>
  typeof flags === "number"
    ? Boolean(
        flags &
        (fs.constants.O_WRONLY |
          fs.constants.O_RDWR |
          fs.constants.O_CREAT |
          fs.constants.O_TRUNC |
          fs.constants.O_APPEND),
      )
    : typeof flags === "string" && /[wa+]/.test(flags);
for (const [object, name] of [
  [fs, "open"],
  [fs, "openSync"],
  [promises, "open"],
]) {
  const original = object[name];
  object[name] = function (file, flags, ...args) {
    const path = filePath(file);
    if (writingFlags(flags)) check(file, name, true);
    if (object === fs && name === "open") {
      const wrap = (callback) =>
        function (error, descriptor) {
          if (!error) descriptorPaths.set(descriptor, trackedPath(path));
          return callback.apply(this, arguments);
        };
      if (typeof flags === "function" && args.length === 0) flags = wrap(flags);
      else if (typeof args.at(-1) === "function") args[args.length - 1] = wrap(args.at(-1));
    }
    const result = original.call(this, file, flags, ...args);
    if (object !== promises) {
      if (name === "openSync") descriptorPaths.set(result, trackedPath(path));
      return result;
    }
    return result.then((handle) => {
      const tracked = trackedPath(path);
      const descriptor = handle.fd;
      descriptorPaths.set(descriptor, tracked);
      const close = handle.close;
      handle.close = async function (...args) {
        const result = await close.apply(this, args);
        if (descriptorPaths.get(descriptor) === tracked) descriptorPaths.delete(descriptor);
        return result;
      };
      for (const method of [
        "appendFile",
        "writeFile",
        "write",
        "writev",
        "truncate",
        "chmod",
        "chown",
        "utimes",
        "createWriteStream",
      ]) {
        const original = handle[method];
        handle[method] = function (...args) {
          check(path, `FileHandle.${method}`, true);
          check(handle.fd, `FileHandle.${method}`, true);
          return original.apply(this, args);
        };
      }
      return handle;
    });
  };
}
for (const name of ["close", "closeSync"]) {
  const original = fs[name];
  fs[name] = function (descriptor, ...args) {
    const tracked = descriptorPaths.get(descriptor);
    const forget = () => {
      if (descriptorPaths.get(descriptor) === tracked) descriptorPaths.delete(descriptor);
    };
    if (name === "close") {
      const callback = args.at(-1);
      if (typeof callback === "function")
        args[args.length - 1] = function (error) {
          if (!error) forget();
          return callback.apply(this, arguments);
        };
      else if (args.length === 0 || (args.length === 1 && args[0] === undefined))
        args[0] = (error) => {
          if (error) throw error;
          forget();
        };
    }
    const result = original.call(this, descriptor, ...args);
    if (name === "closeSync") forget();
    return result;
  };
}
for (const method of ["write", "writev", "ftruncate", "fchmod", "fchown", "futimes"]) {
  for (const name of [method, `${method}Sync`]) {
    const original = fs[name];
    if (!original) continue;
    fs[name] = function (descriptor, ...args) {
      check(descriptor, name, true);
      return original.call(this, descriptor, ...args);
    };
  }
}
function checkStream(file, options, operation) {
  if (options?.fd !== undefined && options.fd !== null) check(options.fd, operation, true);
  else check(file, operation, true);
}
for (const name of ["createWriteStream", "WriteStream"]) {
  const original = fs[name];
  fs[name] = new Proxy(original, {
    apply(target, receiver, args) {
      checkStream(args[0], args[1], name);
      return Reflect.apply(target, receiver, args);
    },
    construct(target, args, newTarget) {
      checkStream(args[0], args[1], name);
      return Reflect.construct(target, args, newTarget);
    },
  });
}
syncBuiltinESMExports();
