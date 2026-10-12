// SPDX-License-Identifier: MPL-2.0

import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { assertTarget, TARGETS } from "./targets.mjs";
import { projectRoot, guardPath, scopedEnvironment } from "./validation-common.mjs";
import { existingToolchain } from "./validation-toolchain.mjs";

const [selected, ...filters] = process.argv.slice(2);
const targets = selected ? [assertTarget(selected)] : TARGETS;
if (targets.includes("firefox") && filters.length)
  throw new Error("Firefox native validation runs its complete suite");
const environment = scopedEnvironment();
// Native suites run successively so they cannot contend for TLS ports or browser profiles.
for (const target of targets) {
  // Locate the existing browser before the child receives an isolated LOCALAPPDATA.
  const toolchain =
    target === "firefox"
      ? undefined
      : await existingToolchain({ ...environment, EXTENSION_TARGET: target });
  const script =
    target === "firefox"
      ? "tests/browser/firefox/validate-browser.mjs"
      : "tests/browser/chromium/validate-browser.mjs";
  const status = await new Promise((done, reject) => {
    const child = spawn(
      process.execPath,
      ["--import", pathToFileURL(guardPath).href, resolve(projectRoot, script), ...filters],
      {
        cwd: projectRoot,
        env: { ...environment, ...toolchain?.environment, EXTENSION_TARGET: target },
        stdio: "inherit",
        windowsHide: true,
      },
    );
    child.once("error", reject);
    child.once("close", done);
  });
  if (status !== 0) {
    process.exitCode = 1;
    break;
  }
}
