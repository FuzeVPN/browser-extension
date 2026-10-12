// SPDX-License-Identifier: MPL-2.0

import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build, runnerImport } from "vite";
import { projectRoot, sourceHashes } from "./validation-common.mjs";
import { distributionDirectory, manifestBytes, manifestFor, selectTargets } from "./targets.mjs";

export const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

export async function inventory(directory) {
  const result = {};
  const entries = (await readdir(directory, { withFileTypes: true })).sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  );
  for (const entry of entries) {
    const file = resolve(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Symlink is not a distribution input: ${file}`);
    if (entry.isDirectory()) {
      for (const [name, hash] of Object.entries(await inventory(file)))
        result[`${entry.name}/${name}`] = hash;
    } else if (entry.isFile()) result[entry.name] = digest(await readFile(file));
    else throw new Error(`Unsupported distribution entry: ${file}`);
  }
  return result;
}

export function canonical(value) {
  return JSON.stringify(
    Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))),
  );
}

export async function verifyDist(target) {
  const directory = distributionDirectory(target);
  const before = canonical(sourceHashes());
  const manifest = await manifestFor(target);
  const { module: configuration } = await runnerImport(resolve(projectRoot, "vite.config.ts"));
  const result = await build({
    ...configuration.makeBuildConfig(target, directory),
    configFile: false,
    envFile: false,
    logLevel: "silent",
    build: {
      ...configuration.makeBuildConfig(target, directory).build,
      write: false,
      emptyOutDir: false,
      copyPublicDir: false,
    },
  });
  const expected = await inventory(resolve(projectRoot, "assets"));
  expected["manifest.json"] = digest(manifestBytes(manifest));
  for (const bundle of Array.isArray(result) ? result : [result]) {
    if (!bundle.output) throw new Error("Packaging requires a finite production build");
    for (const output of bundle.output) {
      if (Object.hasOwn(expected, output.fileName))
        throw new Error(`Output collision: ${output.fileName}`);
      expected[output.fileName] = digest(output.type === "chunk" ? output.code : output.source);
    }
  }
  const actual = await inventory(directory);
  const differences = [...new Set([...Object.keys(expected), ...Object.keys(actual)])].filter(
    (name) => expected[name] !== actual[name],
  );
  if (differences.length)
    throw new Error(`Stale or unexpected ${target} files: ${differences.join(", ")}`);
  if (before !== canonical(sourceHashes())) throw new Error("Sources changed during verification");
  return {
    target,
    version: manifest.version,
    sourceSha256: digest(before),
    files: JSON.parse(canonical(actual)),
  };
}

export async function verifyChromiumParity() {
  const chrome = await inventory(distributionDirectory("chrome"));
  const edge = await inventory(distributionDirectory("edge"));
  delete chrome["manifest.json"];
  delete edge["manifest.json"];
  if (canonical(chrome) !== canonical(edge))
    throw new Error("Chrome/Edge differ outside manifest.json");
  return { files: Object.keys(chrome).length, sha256: digest(canonical(chrome)) };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  for (const target of selectTargets())
    process.stdout.write(`${JSON.stringify(await verifyDist(target))}\n`);
}
