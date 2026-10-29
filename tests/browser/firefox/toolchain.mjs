// SPDX-License-Identifier: MPL-2.0

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { projectRoot, sha256 } from "../../../scripts/validation-common.mjs";

export function existingFirefoxToolchain(environment) {
  // Read browser metadata without executing Firefox or creating a browser session.
  if (process.platform !== "win32")
    throw new Error("Firefox metadata preflight currently requires Windows file-version metadata.");
  const executable = resolve(
    process.env.FIREFOX_EXECUTABLE || "C:/Program Files/Mozilla Firefox/firefox.exe",
  );
  const gecko = resolve(
    process.env.GECKODRIVER_EXECUTABLE ||
      join(projectRoot, "node_modules/.cache/firefox-validation/geckodriver-0.37.1.exe"),
  );
  const python = resolve(
    process.env.PYTHON_EXECUTABLE ||
      join(homedir(), ".cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe"),
  );
  for (const file of [executable, gecko, python])
    if (!existsSync(file))
      throw new Error(`Existing native tool missing; preflight never downloads tools: ${file}`);
  const probe = (command, arguments_) => {
    const result = spawnSync(command, arguments_, {
      cwd: projectRoot,
      env: environment,
      encoding: "utf8",
      windowsHide: true,
      timeout: 30000,
    });
    if (result.status !== 0)
      throw new Error(
        `Native metadata preflight failed: ${result.stderr || result.error || command}`,
      );
    return result.stdout.trim();
  };
  const firefoxVersion = probe("powershell", [
    "-NoProfile",
    "-Command",
    `(Get-Item -LiteralPath '${executable.replaceAll("'", "''")}').VersionInfo.ProductVersion`,
  ]);
  const geckoVersion = probe(gecko, ["--version"]).match(/^geckodriver (\d+\.\d+\.\d+)\b/)?.[1];
  const pythonVersions = JSON.parse(
    probe(python, [
      "-B",
      "-c",
      "import json,sys,cryptography; print(json.dumps({'python':sys.version.split()[0],'cryptography':cryptography.__version__}))",
    ]),
  );
  const lock = JSON.parse(readFileSync(join(projectRoot, "package-lock.json"), "utf8"));
  const packageVersions = {};
  for (const name of ["selenium-webdriver", "geckodriver"]) {
    const installed = JSON.parse(
      readFileSync(join(projectRoot, "node_modules", name, "package.json"), "utf8"),
    ).version;
    const pinned = lock.packages[`node_modules/${name}`]?.version;
    if (installed !== pinned)
      throw new Error(`Native package ${name} ${installed} differs from lockfile ${pinned}`);
    packageVersions[name] = installed;
  }
  const commonPin = JSON.parse(
    readFileSync(join(projectRoot, "scripts/browser-toolchain.json"), "utf8"),
  );
  const expected = {
    node: commonPin.node,
    firefox: "158.0.1",
    geckodriver: "0.37.1",
    python: commonPin.python,
    cryptography: commonPin.cryptography,
  };
  const actual = {
    node: process.versions.node,
    firefox: firefoxVersion,
    geckodriver: geckoVersion,
    ...pythonVersions,
  };
  for (const [name, version] of Object.entries(expected))
    if (actual[name] !== version)
      throw new Error(
        `Unsupported native toolchain: ${name} ${actual[name]} instead of ${version}`,
      );
  const report = {
    actual,
    expected,
    packages: packageVersions,
    nodeExecutable: process.execPath,
    firefoxExecutable: executable,
    firefoxSha256: sha256(readFileSync(executable)),
    geckodriverExecutable: gecko,
    geckodriverSha256: sha256(readFileSync(gecko)),
    pythonExecutable: python,
    browserStarted: false,
    installedAnything: false,
  };
  return {
    environment: {
      FIREFOX_EXECUTABLE: executable,
      GECKODRIVER_EXECUTABLE: gecko,
      PYTHON_EXECUTABLE: python,
      MOZ_HEADLESS: "1",
    },
    evidence: report,
  };
}
