// SPDX-License-Identifier: MPL-2.0

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { readZip } from "../../scripts/zip.mjs";
import { inventory } from "../../scripts/verify-dist.mjs";
import { projectRoot, scopedEnvironment } from "../../scripts/validation-common.mjs";
import { inspectPublicPath } from "../../scripts/audit-publication.mjs";

const packageInfo = JSON.parse(await readFile(resolve(projectRoot, "package.json"), "utf8"));
const archive = resolve(
  projectRoot,
  "releases",
  `fuzevpn-extensions-v${packageInfo.version}-sources.zip`,
);
const bytes = await readFile(archive);
const sourceFiles = readZip(bytes);
const output = resolve(projectRoot, "audit/local/source-rebuild", randomUUID());
const extraction = resolve(output, "extracted");
await mkdir(extraction, { recursive: true });
assert(
  !extraction.split(/[\\/]/).includes("node_modules"),
  "Rebuild must be outside node_modules so Vite reads tsconfig",
);
for (const [name, contents] of sourceFiles) {
  assert(inspectPublicPath(name).length === 0, `Forbidden source entry ${name}`);
  const file = resolve(extraction, name);
  const child = relative(extraction, file);
  assert(
    child &&
      !isAbsolute(child) &&
      child !== ".." &&
      !child.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`),
    "Unsafe extraction path",
  );
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, contents, { flag: "wx" });
}
const npmCli =
  process.env.npm_execpath ?? resolve(dirname(process.execPath), "node_modules/npm/bin/npm-cli.js");
assert(existsSync(npmCli), "Run through npm run verify:sources or provide an installed npm CLI");
const environment = { ...scopedEnvironment(), npm_config_update_notifier: "false" };
async function run(args, name) {
  const chunks = [];
  const code = await new Promise((done, reject) => {
    const child = spawn(process.execPath, [npmCli, ...args], {
      cwd: extraction,
      env: environment,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (chunk) => chunks.push(chunk));
    child.stderr.on("data", (chunk) => chunks.push(chunk));
    child.once("error", reject);
    child.once("close", done);
  });
  await writeFile(resolve(output, `${name}.log`), Buffer.concat(chunks));
  assert.equal(code, 0, `${name} failed; inspect the ignored reconstruction log`);
}
process.stdout.write("Extracted clean source archive; installing the single lockfile.\n");
await run(["ci", "--no-audit", "--no-fund"], "npm-ci");
process.stdout.write("Building the three targets from the clean extraction.\n");
await run(["run", "build"], "build");
const distributions = {};
for (const target of ["chrome", "edge", "firefox"]) {
  const expected = await inventory(resolve(projectRoot, "dist", target));
  const actual = await inventory(resolve(extraction, "dist", target));
  assert.deepEqual(actual, expected, `${target} reconstruction differs byte for byte`);
  distributions[target] = { files: Object.keys(actual).length, byteIdentical: true };
}
await writeFile(
  resolve(output, "report.json"),
  JSON.stringify(
    {
      version: packageInfo.version,
      node: process.version,
      sourceArchiveSha256: createHash("sha256").update(bytes).digest("hex"),
      sourceFiles: sourceFiles.size,
      freshInstall: true,
      distributions,
      success: true,
    },
    null,
    2,
  ) + "\n",
);
process.stdout.write(
  `${JSON.stringify({ success: true, sourceFiles: sourceFiles.size, distributions })}\n`,
);
