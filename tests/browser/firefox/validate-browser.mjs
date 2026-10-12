// SPDX-License-Identifier: MPL-2.0

import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { guardPath, projectRoot, scopedEnvironment } from "../../../scripts/validation-common.mjs";

const environment = scopedEnvironment();
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
