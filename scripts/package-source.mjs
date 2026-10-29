// SPDX-License-Identifier: MPL-2.0

import { mkdir, readFile, open, unlink } from "node:fs/promises";
import { resolve } from "node:path";
import { projectRoot } from "./validation-common.mjs";
import { canonical, digest, verifyDist } from "./verify-dist.mjs";
import { publishArchive, safeOutput } from "./package.mjs";
import { TARGETS } from "./targets.mjs";
import { readPublicFile, readPublicSources } from "./public-inputs.mjs";

async function sourceInventory() {
  return Object.fromEntries(
    [...readPublicSources()].map(([name, contents]) => [name, digest(contents)]),
  );
}

const before = await sourceInventory();
const releaseDirectory = await safeOutput(resolve(projectRoot, "releases"));
await mkdir(releaseDirectory, { recursive: true });
const lockPath = await safeOutput(resolve(releaseDirectory, ".package.lock"));
const lock = await open(lockPath, "wx");
try {
  for (const target of TARGETS) await verifyDist(target);
  const entries = Object.keys(before).map((name) => [
    name,
    readPublicFile(resolve(projectRoot, name), name),
  ]);
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
