// SPDX-License-Identifier: MPL-2.0

// Loaded before Node validation tools and inherited by Node child processes.
// Native browser/Python outputs are scoped separately by their environment and profile arguments.
import fs from "node:fs";
import promises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(process.env.CHROME_VALIDATION_ROOT || resolve(import.meta.dirname, ".."));
const native = {
  existsSync: fs.existsSync,
  realpathSync: fs.realpathSync,
  appendFileSync: fs.appendFileSync,
};
const realRoot = native.realpathSync(root);
const outside = (base, target) => {
  const path = relative(base, target);
  return isAbsolute(path) || path === ".." || path.startsWith("../") || path.startsWith("..\\");
};

function check(value, operation) {
  // Writes using a numeric descriptor refer to a stream opened by a checked open operation.
  if (typeof value === "number") return;
  const target = resolve(value instanceof URL ? fileURLToPath(value) : String(value));
  let existing = target;
  while (!native.existsSync(existing) && dirname(existing) !== existing)
    existing = dirname(existing);
  if (!outside(root, target) && !outside(realRoot, native.realpathSync(existing))) return;
  const message = { at: new Date().toISOString(), pid: process.pid, operation, path: target };
  const log = process.env.CHROME_VALIDATION_GUARD_LOG;
  if (log && !outside(root, resolve(log)))
    native.appendFileSync(log, `${JSON.stringify(message)}\n`);
  throw new Error(`Blocked write outside ExtensionsV2 (${operation}): ${target}`);
}

const both = new Set(["rename"]);
const destination = new Set(["copyFile", "cp", "link", "symlink"]);
for (const name of [
  "appendFile",
  "copyFile",
  "cp",
  "mkdir",
  "mkdtemp",
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
      } else check(args[destination.has(name) ? 1 : 0], property);
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
    if (writingFlags(flags)) check(file, name);
    return original.call(this, file, flags, ...args);
  };
}
const originalStream = fs.createWriteStream;
fs.createWriteStream = function (file, ...args) {
  check(file, "createWriteStream");
  return originalStream.call(this, file, ...args);
};
syncBuiltinESMExports();
