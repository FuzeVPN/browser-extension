// SPDX-License-Identifier: MPL-2.0

import { lstat, mkdir, readFile, open, unlink } from "node:fs/promises";
import { resolve } from "node:path";
import { projectRoot } from "./validation-common.mjs";
import { inventory, canonical, digest, verifyDist } from "./verify-dist.mjs";
import { publishArchive, safeOutput } from "./package.mjs";
import { TARGETS } from "./targets.mjs";
import { inspectPublicPath, inspectPublicText } from "./audit-publication.mjs";

const directories = ["src", "assets", "manifests", "scripts", "tests", "docs"];
const rootFiles = [
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

async function sourceInventory() {
  const files = {};
  for (const directory of directories) {
    for (const [name, hash] of Object.entries(await inventory(resolve(projectRoot, directory))))
      files[`${directory}/${name}`] = hash;
  }
  for (const name of rootFiles) files[name] = digest(await readFile(resolve(projectRoot, name)));
  // Notices may be added under either spelling, but never silently omit a present notice.
  for (const name of ["THIRD_PARTY_NOTICES.md", "THIRD-PARTY-NOTICES.md", "SOURCE_NOTICE.txt"]) {
    try {
      if ((await lstat(resolve(projectRoot, name))).isSymbolicLink())
        throw new Error("Source notice is a link");
      files[name] = digest(await readFile(resolve(projectRoot, name)));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  for (const name of Object.keys(files)) {
    if (
      inspectPublicPath(name).length ||
      inspectPublicText((await readFile(resolve(projectRoot, name))).toString("utf8")).length
    )
      throw new Error(`Forbidden source archive input: ${name}`);
  }
  return files;
}

const releaseDirectory = await safeOutput(resolve(projectRoot, "releases"));
await mkdir(releaseDirectory, { recursive: true });
const lockPath = await safeOutput(resolve(releaseDirectory, ".package.lock"));
const lock = await open(lockPath, "wx");
try {
  for (const target of TARGETS) await verifyDist(target);
  const before = await sourceInventory();
  const entries = await Promise.all(
    Object.keys(before).map(async (name) => [name, await readFile(resolve(projectRoot, name))]),
  );
  if (canonical(before) !== canonical(await sourceInventory()))
    throw new Error("Sources changed during source packaging");
  const packageInfo = JSON.parse(await readFile(resolve(projectRoot, "package.json"), "utf8"));
  const result = await publishArchive({
    directory: releaseDirectory,
    name: `fuzevpn-extensions-v${packageInfo.version}-sources.zip`,
    entries,
    expected: before,
  });
  process.stdout.write(`${JSON.stringify({ ...result, files: Object.keys(before).length })}\n`);
} finally {
  await lock.close();
  await unlink(lockPath);
}
