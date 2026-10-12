// SPDX-License-Identifier: MPL-2.0

import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { projectRoot, sha256 } from "./validation-common.mjs";

export async function existingToolchain(environment) {
  const target = environment.EXTENSION_TARGET || process.env.EXTENSION_TARGET;
  const expected = JSON.parse(
    readFileSync(
      join(
        projectRoot,
        target === "edge"
          ? "scripts/browser-toolchain-edge.json"
          : "scripts/browser-toolchain.json",
      ),
      "utf8",
    ),
  );
  const require = createRequire(join(projectRoot, "package.json"));
  const bundled = join(homedir(), ".cache/codex-runtimes/codex-primary-runtime/dependencies");
  let playwrightModule = process.env.PLAYWRIGHT_MODULE_PATH;
  if (!playwrightModule) {
    try {
      playwrightModule = require.resolve("playwright");
    } catch {
      playwrightModule = join(bundled, "node/node_modules/playwright/index.mjs");
    }
  }
  playwrightModule = resolve(playwrightModule);
  if (!existsSync(playwrightModule))
    throw new Error(
      "Existing Playwright module missing. Set PLAYWRIGHT_MODULE_PATH; no dependency is installed automatically.",
    );
  // Resolve the already installed browser before applying the isolated LOCALAPPDATA.
  const { chromium } = await import(pathToFileURL(playwrightModule).href);
  const chromiumExecutable = resolve(
    target === "edge"
      ? process.env.EDGE_EXECUTABLE ||
          "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"
      : process.env.CHROMIUM_EXECUTABLE || chromium.executablePath(),
  );
  if (!existsSync(chromiumExecutable))
    throw new Error(
      "Existing Chromium binary missing. Set CHROMIUM_EXECUTABLE; this runner never downloads a browser.",
    );
  const pythonExecutable = resolve(
    process.env.PYTHON_EXECUTABLE || join(bundled, "python/python.exe"),
  );
  if (!existsSync(pythonExecutable))
    throw new Error(
      "Existing Python binary missing. Set PYTHON_EXECUTABLE; this runner never installs Python.",
    );
  const python = spawnSync(
    pythonExecutable,
    [
      "-B",
      "-c",
      "import json,sys,cryptography; print(json.dumps({'python':sys.version.split()[0],'cryptography':cryptography.__version__}))",
    ],
    {
      cwd: projectRoot,
      env: environment,
      encoding: "utf8",
      windowsHide: true,
      timeout: 30000,
    },
  );
  if (python.status !== 0)
    throw new Error(
      `Existing Python/cryptography preflight failed: ${python.stderr || python.error || python.status}`,
    );
  const pythonVersions = JSON.parse(python.stdout.trim());
  const playwrightPackage = JSON.parse(
    readFileSync(join(dirname(playwrightModule), "package.json"), "utf8"),
  );
  const versionProbe =
    process.platform === "win32"
      ? spawnSync(
          "powershell",
          [
            "-NoProfile",
            "-Command",
            `(Get-Item -LiteralPath '${chromiumExecutable.replaceAll("'", "''")}').VersionInfo.ProductVersion`,
          ],
          {
            cwd: projectRoot,
            env: environment,
            encoding: "utf8",
            windowsHide: true,
            timeout: 30000,
          },
        )
      : spawnSync(chromiumExecutable, ["--version"], {
          cwd: projectRoot,
          env: environment,
          encoding: "utf8",
          timeout: 30000,
        });
  const chromiumVersion = versionProbe.stdout?.match(/\b\d+\.\d+\.\d+\.\d+\b/)?.[0];
  if (versionProbe.status !== 0 || !chromiumVersion)
    throw new Error("Cannot verify the existing Chromium executable version.");
  const actual = {
    node: process.versions.node,
    playwright: playwrightPackage.version,
    chromium: chromiumVersion,
    ...pythonVersions,
  };
  for (const [tool, version] of Object.entries(expected)) {
    if (actual[tool] !== version)
      throw new Error(
        `Unsupported validation toolchain: ${tool} ${actual[tool]} instead of pinned ${version}. Select the documented existing runtime; changing the pin requires a new complete validation.`,
      );
  }
  return {
    environment: {
      PLAYWRIGHT_MODULE_PATH: playwrightModule,
      CHROMIUM_EXECUTABLE: chromiumExecutable,
      PYTHON_EXECUTABLE: pythonExecutable,
    },
    evidence: {
      node: { version: process.version, executable: process.execPath },
      playwright: { version: playwrightPackage.version, module: playwrightModule },
      chromium: {
        executable: chromiumExecutable,
        executableSha256: sha256(readFileSync(chromiumExecutable)),
        version: chromiumVersion,
      },
      python: { executable: pythonExecutable, ...pythonVersions },
      installedAnything: false,
      expectedVersions: expected,
      toolAccess:
        "Existing executables and libraries may be read outside ExtensionsV2; output profiles, temporary files and caches are scoped inside ExtensionsV2.",
    },
  };
}
