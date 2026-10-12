// SPDX-License-Identifier: MPL-2.0

import { format } from "prettier";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

export const projectRoot = resolve(import.meta.dirname, "..");
export const auditRoot = resolve(
  projectRoot,
  process.env.EXTENSIONS_VALIDATION_OUTPUT ||
    process.env.CHROME_VALIDATION_OUTPUT ||
    process.env.FIREFOX_VALIDATION_OUTPUT ||
    "audit/local",
);
export const runtimeRoot = join(auditRoot, "runtime");
export const guardPath = join(import.meta.dirname, "validation-scope-guard.mjs");

export function assertInsideProject(value) {
  const target = resolve(value);
  const child = relative(projectRoot, target);
  if (isAbsolute(child) || child === ".." || child.startsWith("../") || child.startsWith("..\\")) {
    throw new Error(`Validation output must remain inside ExtensionsV2: ${target}`);
  }
  let existing = target;
  while (!existsSync(existing)) existing = dirname(existing);
  const realChild = relative(realpathSync(projectRoot), realpathSync(existing));
  if (
    isAbsolute(realChild) ||
    realChild === ".." ||
    realChild.startsWith("../") ||
    realChild.startsWith("..\\")
  ) {
    throw new Error(`Validation output resolves outside ExtensionsV2: ${target}`);
  }
  return target;
}

export function scopedEnvironment() {
  const paths = {
    TMP: join(runtimeRoot, "node_modules/.tmp"),
    TEMP: join(runtimeRoot, "node_modules/.tmp"),
    TMPDIR: join(runtimeRoot, "node_modules/.tmp"),
    npm_config_cache: join(runtimeRoot, "node_modules/.npm-cache"),
    APPDATA: join(runtimeRoot, "node_modules/.appdata"),
    LOCALAPPDATA: join(runtimeRoot, "node_modules/.local-appdata"),
  };
  for (const value of new Set(Object.values(paths)))
    mkdirSync(assertInsideProject(value), { recursive: true });
  return {
    ...process.env,
    ...paths,
    NODE_DISABLE_COMPILE_CACHE: "1",
    PYTHONDONTWRITEBYTECODE: "1",
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "1",
    CHROME_VALIDATION_ROOT: projectRoot,
    CHROME_VALIDATION_GUARD_LOG: join(runtimeRoot, "blocked-writes.jsonl"),
  };
}

export function runDirectory(kind, label = "") {
  const stamp = new Date().toISOString().replaceAll(":", "-");
  const name = `${stamp}-${process.pid}${label ? `-${label.replace(/[^a-zA-Z0-9_-]/g, "-")}` : ""}`;
  const directory = assertInsideProject(join(auditRoot, kind, name));
  mkdirSync(directory, { recursive: true });
  return directory;
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function fileHashes(directory, { skipDirectories = [] } = {}) {
  const output = {};
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    if (entry.isSymbolicLink())
      throw new Error(
        `Symlinks are not permitted in validation inputs: ${join(directory, entry.name)}`,
      );
    const file = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (skipDirectories.includes(entry.name)) continue;
      for (const [key, value] of Object.entries(fileHashes(file, { skipDirectories })))
        output[`${entry.name}/${key}`] = value;
    } else output[entry.name] = sha256(readFileSync(file));
  }
  return output;
}

export function sourceHashes() {
  const output = {};
  for (const directory of ["src", "assets", "manifests", "tests", "scripts"]) {
    if (!existsSync(join(projectRoot, directory))) continue;
    for (const [key, value] of Object.entries(fileHashes(join(projectRoot, directory))))
      output[`${directory}/${key}`] = value;
  }
  for (const file of [
    "package.json",
    "package-lock.json",
    "vite.config.ts",
    "tsconfig.json",
    "eslint.config.mjs",
    "vitest.config.ts",
    "vitest.chromium.config.ts",
  ]) {
    if (existsSync(join(projectRoot, file)))
      output[file] = sha256(readFileSync(join(projectRoot, file)));
  }
  return output;
}

export async function writeJson(file, value) {
  const options = JSON.parse(readFileSync(join(projectRoot, ".prettierrc.json"), "utf8"));
  writeFileSync(
    assertInsideProject(file),
    await format(JSON.stringify(value), { ...options, parser: "json" }),
  );
}

export async function formatJsonTree(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const file = join(directory, entry.name);
    if (entry.isDirectory()) await formatJsonTree(file);
    else if (entry.isFile() && entry.name.endsWith(".json"))
      await writeJson(file, JSON.parse(readFileSync(file, "utf8")));
  }
}
