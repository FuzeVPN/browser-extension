// SPDX-License-Identifier: MPL-2.0

import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { build, runnerImport } from "vite";
import { projectRoot } from "./validation-common.mjs";
import { distributionDirectory, manifestBytes, manifestFor, selectTargets } from "./targets.mjs";

const targets = selectTargets();
// Normal builds use the checked-in assets unchanged. Regeneration is an explicit command.
const { module: configuration } = await runnerImport(resolve(projectRoot, "vite.config.ts"));
for (const target of targets) {
  const directory = distributionDirectory(target);
  const manifest = await manifestFor(target);
  await build({
    ...configuration.makeBuildConfig(target, directory),
    configFile: false,
    envFile: false,
    logLevel: "warn",
  });
  await writeFile(resolve(directory, "manifest.json"), manifestBytes(manifest));
  process.stdout.write(`Built ${target} ${manifest.version}\n`);
}
