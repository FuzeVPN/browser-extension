// SPDX-License-Identifier: MPL-2.0

import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { inspectPublicPath, inspectPublicText } from "./audit-publication.mjs";
import { assertInsideProject, projectRoot } from "./validation-common.mjs";

export const SOURCE_DIRECTORIES = ["src", "assets", "manifests", "scripts", "tests", "docs"];
export const SOURCE_ROOT_FILES = [
  "package.json",
  "package-lock.json",
  "vite.config.ts",
  "vitest.config.ts",
  "vitest.chromium.config.ts",
  "tsconfig.json",
  "eslint.config.mjs",
  ".prettierrc.json",
  ".prettierignore",
  ".gitignore",
  ".gitattributes",
  "README.md",
  "BUILDING.md",
  "CONTRIBUTING.md",
  "SECURITY.md",
  "LICENSE",
];
const OPTIONAL_NOTICES = ["THIRD_PARTY_NOTICES.md", "THIRD-PARTY-NOTICES.md", "SOURCE_NOTICE.txt"];

export function assertPublicEntry(name, contents) {
  if (
    inspectPublicPath(name).length ||
    /\.map$/i.test(name) ||
    inspectPublicText(Buffer.from(contents).toString("utf8")).length
  )
    throw new Error(`Forbidden public archive input: ${name}`);
}

export function readPublicFile(file, name) {
  file = assertInsideProject(file);
  if (!lstatSync(file).isFile()) throw new Error(`Public input is not a regular file: ${name}`);
  const contents = readFileSync(file);
  assertPublicEntry(name, contents);
  return contents;
}

export function readPublicTree(directory, prefix = "") {
  directory = assertInsideProject(directory);
  if (!lstatSync(directory).isDirectory())
    throw new Error(`Public input is not a directory: ${directory}`);
  const files = new Map();
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const name = prefix ? `${prefix}/${entry.name}` : entry.name;
    const file = assertInsideProject(resolve(directory, entry.name));
    if (inspectPublicPath(name).length) throw new Error(`Forbidden public archive input: ${name}`);
    if (entry.isDirectory()) {
      for (const [child, contents] of readPublicTree(file, name)) files.set(child, contents);
    } else files.set(name, readPublicFile(file, name));
  }
  return files;
}

/** Validate the complete source release before producing any build or archive. */
export function readPublicSources() {
  const files = new Map();
  for (const directory of SOURCE_DIRECTORIES)
    for (const [name, contents] of readPublicTree(resolve(projectRoot, directory), directory))
      files.set(name, contents);
  for (const name of SOURCE_ROOT_FILES)
    files.set(name, readPublicFile(resolve(projectRoot, name), name));
  for (const name of OPTIONAL_NOTICES) {
    const file = assertInsideProject(resolve(projectRoot, name));
    if (lstatSync(file, { throwIfNoEntry: false })) files.set(name, readPublicFile(file, name));
  }
  return files;
}
