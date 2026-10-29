// SPDX-License-Identifier: MPL-2.0

import { lstat, mkdir, readFile, writeFile, link, unlink, open } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { assertInsideProject, projectRoot } from "./validation-common.mjs";
import { distributionDirectory, selectTargets } from "./targets.mjs";
import { canonical, digest, verifyDist, verifyChromiumParity } from "./verify-dist.mjs";
import { createZip, readZip } from "./zip.mjs";
import { assertPublicEntry, readPublicFile, readPublicSources } from "./public-inputs.mjs";
import { auditDist } from "./audit-dist.mjs";

export async function safeOutput(path) {
  return assertInsideProject(path);
}

async function exists(path) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

export function verifyArchive(bytes, expected) {
  const files = Object.fromEntries(
    [...readZip(bytes)].map(([name, contents]) => [name, digest(contents)]),
  );
  if (canonical(files) !== canonical(expected))
    throw new Error("ZIP inventory differs from distribution");
}

export async function publishArchive({ directory, name, entries, expected }) {
  entries = [...entries];
  for (const [entry, contents] of entries) assertPublicEntry(entry, contents);
  directory = await safeOutput(directory);
  if (!/^[a-z0-9][a-z0-9.-]*\.zip$/.test(name)) throw new Error("Invalid publication filename");
  await mkdir(directory, { recursive: true });
  const zipPath = await safeOutput(resolve(directory, name));
  const hashPath = await safeOutput(resolve(directory, name.replace(/\.zip$/, ".sha256")));
  const hasZip = await exists(zipPath);
  const hasHash = await exists(hashPath);
  if (hasZip !== hasHash)
    throw new Error("Incomplete existing release. Use a new version; nothing was overwritten.");
  if (hasZip) {
    const bytes = await readFile(zipPath);
    verifyArchive(bytes, expected);
    const checksum = `${digest(bytes).toUpperCase()}  ${name}\n`;
    if ((await readFile(hashPath, "utf8")) !== checksum)
      throw new Error("Existing archive checksum differs");
    return { archive: name, sha256: digest(bytes), preserved: true };
  }
  const bytes = createZip(entries);
  verifyArchive(bytes, expected);
  const checksum = `${digest(bytes).toUpperCase()}  ${name}\n`;
  const stage = await safeOutput(resolve(projectRoot, "node_modules/.cache/package", randomUUID()));
  await mkdir(stage, { recursive: true });
  const stageZip = resolve(stage, name);
  const stageHash = resolve(stage, name.replace(/\.zip$/, ".sha256"));
  await writeFile(stageZip, bytes, { flag: "wx" });
  await writeFile(stageHash, checksum, { flag: "wx" });
  let committedZip = false;
  try {
    // Hard-link creation is atomic and never replaces an existing destination.
    await safeOutput(zipPath);
    await safeOutput(hashPath);
    await link(stageZip, zipPath);
    committedZip = true;
    await link(stageHash, hashPath);
  } catch (error) {
    if (committedZip) await unlink(zipPath);
    throw error;
  } finally {
    await unlink(stageZip);
    await unlink(stageHash);
  }
  return { archive: name, sha256: digest(bytes), preserved: false };
}

export async function packageTarget(target) {
  readPublicSources();
  await auditDist(target);
  const releaseDirectory = await safeOutput(resolve(projectRoot, "releases"));
  await mkdir(releaseDirectory, { recursive: true });
  const lockPath = resolve(releaseDirectory, ".package.lock");
  const lock = await open(await safeOutput(lockPath), "wx");
  try {
    const inputs = await verifyDist(target);
    if (target !== "firefox") await verifyChromiumParity();
    const directory = distributionDirectory(target);
    const entries = Object.keys(inputs.files).map((name) => [
      name,
      readPublicFile(resolve(directory, name), name),
    ]);
    const after = await verifyDist(target);
    if (canonical(inputs) !== canonical(after)) throw new Error("Inputs changed during packaging");
    const result = await publishArchive({
      directory: releaseDirectory,
      name: `fuzevpn-${target}-v${inputs.version}.zip`,
      entries,
      expected: inputs.files,
    });
    return { target, version: inputs.version, ...result };
  } finally {
    await lock.close();
    await unlink(lockPath);
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const targets = selectTargets();
  readPublicSources();
  // Reject an unsafe later target before publishing the first selected archive.
  for (const target of targets) await auditDist(target);
  for (const target of targets)
    process.stdout.write(`${JSON.stringify(await packageTarget(target))}\n`);
}
