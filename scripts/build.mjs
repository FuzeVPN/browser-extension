// SPDX-License-Identifier: MPL-2.0

import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { build, runnerImport } from "vite";
import { assertInsideProject, projectRoot } from "./validation-common.mjs";
import { distributionDirectory, manifestBytes, manifestFor, selectTargets } from "./targets.mjs";
import { readPublicSources } from "./public-inputs.mjs";

const targets = selectTargets();
readPublicSources();
// Check every output before the first build is allowed to empty a directory.
for (const target of targets) distributionDirectory(target);
// Normal builds use the checked-in assets unchanged. Regeneration is an explicit command.
const { module: configuration } = await runnerImport(resolve(projectRoot, "vite.config.ts"));
for (const target of targets) {
  const directory = distributionDirectory(target);
  const manifest = await manifestFor(target);
  readPublicSources();
  await build({
    ...configuration.makeBuildConfig(target, directory),
    configFile: false,
    envFile: false,
    logLevel: "warn",
  });
  await writeFile(
    assertInsideProject(resolve(directory, "manifest.json")),
    manifestBytes(manifest),
  );
  process.stdout.write(`Built ${target} ${manifest.version}\n`);
}
