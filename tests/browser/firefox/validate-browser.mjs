// SPDX-License-Identifier: MPL-2.0

import { spawn } from "node:child_process";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  guardPath,
  projectRoot,
  runDirectory,
  scopedEnvironment,
  writeJson,
} from "../../../scripts/validation-common.mjs";
import { existingFirefoxToolchain } from "./toolchain.mjs";

const args = process.argv.slice(2);
if (args.length && (args.length !== 1 || args[0] !== "--preflight"))
  throw new Error("Usage: node tests/browser/firefox/validate-browser.mjs [--preflight]");
const environment = scopedEnvironment();
// Validate the existing tools before every run, without launching a browser.
const toolchain = existingFirefoxToolchain(environment);
Object.assign(environment, toolchain.environment);
const output = runDirectory("firefox", args[0] === "--preflight" ? "preflight" : "toolchain");
await writeJson(join(output, "toolchain.json"), toolchain.evidence);
process.stdout.write(`Firefox toolchain evidence: ${output}\n`);
if (args[0] === "--preflight")
  process.stdout.write(`${JSON.stringify(toolchain.evidence, null, 2)}\n`);
else
  for (const mode of ["web-auth", "consent", "full"]) {
    const env = { ...environment };
    delete env.FIREFOX_WEB_AUTH_ONLY;
    delete env.FIREFOX_CONSENT_ONLY;
    delete env.FIREFOX_LEGAL_ONLY;
    delete env.FIREFOX_DESIGN_ONLY;
    if (mode === "web-auth") env.FIREFOX_WEB_AUTH_ONLY = "1";
    if (mode === "consent") env.FIREFOX_CONSENT_ONLY = "1";
    const status = await new Promise((resolveStatus, reject) => {
      const child = spawn(
        process.execPath,
        [
          "--import",
          pathToFileURL(guardPath).href,
          resolve(projectRoot, "tests/browser/firefox/browser-firefox-check.mjs"),
        ],
        { cwd: projectRoot, env, stdio: "inherit", windowsHide: true },
      );
      child.once("error", reject);
      child.once("close", resolveStatus);
    });
    if (status !== 0) {
      process.exitCode = 1;
      break;
    }
  }
