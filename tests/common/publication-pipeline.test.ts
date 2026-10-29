// SPDX-License-Identifier: MPL-2.0

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { SOURCE_DIRECTORIES, SOURCE_ROOT_FILES } from "../../scripts/public-inputs.mjs";

const root = resolve(import.meta.dirname, "../..");
const cache = join(root, "audit/local/fixes-2026-10-19/build_supply_chain/pipeline-tests");
const PIPELINE_TIMEOUT = 180_000;
let fixture: string;
let project: string;
let releaseHashes = new Map<string, string>();
function run(script: string, args: string[] = [], env: NodeJS.ProcessEnv = {}) {
  const result = spawnSync(process.execPath, [join(project, script), ...args], {
    cwd: project,
    env: { ...process.env, ...env },
    windowsHide: true,
    encoding: "utf8",
    timeout: PIPELINE_TIMEOUT,
  });
  if (result.error) throw result.error;
  return { status: result.status, output: result.stdout + result.stderr };
}
async function archives() {
  return (await readdir(join(project, "releases")).catch(() => [])).filter((name) =>
    name.endsWith(".zip"),
  );
}
const hash = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");

beforeAll(async () => {
  await mkdir(cache, { recursive: true });
  fixture = await mkdtemp(join(cache, "case-"));
  project = join(fixture, "project");
  await mkdir(project);
  for (const name of SOURCE_ROOT_FILES) await cp(join(root, name), join(project, name));
  for (const directory of SOURCE_DIRECTORIES) await mkdir(join(project, directory));
  for (const directory of ["assets", "manifests", "scripts"])
    await cp(join(root, directory), join(project, directory), { recursive: true });
  const files: Record<string, string> = {
    "src/core/background/service-worker.ts": 'console.log("Synthetic worker");\n',
    "src/core/shared/vendor/public-suffix-rules.json": "[]\n",
    "src/ui/popup/popup.html": '<script type="module" src="./popup.ts"></script>\n',
    "src/ui/popup/popup.ts": 'document.title = "Synthetic popup";\n',
    "src/ui/diagnostics-page/diagnostics.html":
      '<script type="module" src="./diagnostics.ts"></script>\n',
    "src/ui/diagnostics-page/diagnostics.ts": 'document.title = "Synthetic diagnostics";\n',
    "src/ui/privacy-page/privacy.html": '<script type="module" src="./privacy.ts"></script>\n',
    "src/ui/privacy-page/privacy.ts": 'document.title = "Synthetic privacy notice";\n',
    "docs/README.md": "Synthetic source documentation.\n",
    "tests/synthetic.test.ts": "// Synthetic source archive fixture.\n",
  };
  for (const [name, contents] of Object.entries(files)) {
    await mkdir(dirname(join(project, name)), { recursive: true });
    await writeFile(join(project, name), contents);
  }
  await mkdir(join(project, "tests/reconstruction"));
  await cp(
    join(root, "tests/reconstruction/verify-source-rebuild.mjs"),
    join(project, "tests/reconstruction/verify-source-rebuild.mjs"),
  );
  const result = run("scripts/build.mjs");
  if (result.status !== 0) throw new Error(`Synthetic fixture build failed: ${result.output}`);
  expect(result.output).toContain("Built firefox 0.9.2");
  expect(result.status).toBe(0);
}, PIPELINE_TIMEOUT);

afterAll(async () => {
  if (!fixture.startsWith(cache + sep)) throw new Error("Invalid pipeline fixture cleanup");
  await rm(fixture, { recursive: true, force: true });
}, PIPELINE_TIMEOUT);

describe("exact publication pipeline rejects unsafe inputs before writing artifacts", () => {
  it(
    "rejects private assets before build, dist audit and the first installable ZIP",
    async () => {
      const name = ".env.production";
      const secret = "FUZE_ACCOUNT=synthetic@example.invalid\nFUZE_PASSWORD=SYNTHETIC-ONLY\n";
      const manifest = await readFile(join(project, "dist/chrome/manifest.json"));
      await writeFile(join(project, "assets", name), secret);
      try {
        const build = run("scripts/build.mjs");
        expect(build.status).toBe(1);
        expect(build.output).toContain(name);
        expect(await readFile(join(project, "dist/chrome/manifest.json"))).toEqual(manifest);
        await writeFile(join(project, "dist/chrome", name), secret);
        for (const script of [
          "scripts/audit-dist.mjs",
          "scripts/package.mjs",
          "scripts/package-source.mjs",
        ]) {
          const result = run(script);
          expect(result.status).toBe(1);
          expect(result.output).toContain(name);
        }
        expect(await archives()).toEqual([]);
      } finally {
        await unlink(join(project, "assets", name));
        await unlink(join(project, "dist/chrome", name));
      }
    },
    PIPELINE_TIMEOUT,
  );

  it.each(["assets", "docs"])(
    "rejects a linked %s input root",
    async (name) => {
      const original = join(project, name);
      const saved = join(project, `${name}-saved`);
      const target = join(fixture, `outside-${name}`);
      await mkdir(target);
      await writeFile(join(target, "account.txt"), "Synthetic private source\n");
      await rename(original, saved);
      await symlink(target, original, "junction");
      try {
        for (const script of [
          "scripts/build.mjs",
          "scripts/package.mjs",
          "scripts/package-source.mjs",
        ]) {
          const result = run(script);
          expect(result.status).toBe(1);
          expect(result.output).toContain("path is a link");
        }
        expect(await archives()).toEqual([]);
      } finally {
        await unlink(original);
        await rename(saved, original);
      }
    },
    PIPELINE_TIMEOUT,
  );

  it(
    "refuses a linked root file before loading the build configuration",
    async ({ skip }) => {
      const file = join(project, "vite.config.ts");
      const saved = join(project, "vite.config.saved.ts");
      await rename(file, saved);
      try {
        try {
          await symlink(saved, file, "file");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "EPERM") skip();
          throw error;
        }
        expect((await lstat(file)).isSymbolicLink()).toBe(true);
        const result = run("scripts/build.mjs");
        expect(result.status).toBe(1);
        expect(result.output).toContain("path is a link");
      } finally {
        await unlink(file).catch(() => {});
        await rename(saved, file);
      }
    },
    PIPELINE_TIMEOUT,
  );

  it(
    "refuses a linked dist target before Vite can empty its destination",
    async () => {
      const output = join(project, "dist/chrome");
      const saved = join(project, "dist/chrome-saved");
      const target = join(project, "internal-data");
      await mkdir(target);
      await writeFile(join(target, "must-survive.txt"), "Synthetic protected data\n");
      await rename(output, saved);
      await symlink(target, output, "junction");
      try {
        const result = run("scripts/build.mjs");
        expect(result.status).toBe(1);
        expect(result.output).toContain("path is a link");
        expect(await readdir(target)).toEqual(["must-survive.txt"]);
      } finally {
        await unlink(output);
        await rename(saved, output);
      }
    },
    PIPELINE_TIMEOUT,
  );

  it(
    "confines source extraction before following an output junction",
    async () => {
      const sourcePackage = run("scripts/package-source.mjs");
      expect(sourcePackage.status, sourcePackage.output).toBe(0);
      const target = join(fixture, "outside-reconstruction");
      await mkdir(target);
      await writeFile(join(target, "must-survive.txt"), "Synthetic protected data\n");
      await mkdir(join(project, "audit/local"), { recursive: true });
      const output = join(project, "audit/local/source-rebuild");
      await symlink(target, output, "junction");
      try {
        const result = run("tests/reconstruction/verify-source-rebuild.mjs");
        // This fixture uses the exact reconstruction script alongside synthetic tests.
        expect(result.status).toBe(1);
        expect(result.output).toContain("path is a link");
        expect(await readdir(target)).toEqual(["must-survive.txt"]);
      } finally {
        await unlink(output);
      }
    },
    PIPELINE_TIMEOUT,
  );

  it(
    "packages ordinary sources for all three browsers",
    async () => {
      const audited = run("scripts/audit-dist.mjs");
      expect(audited.status, audited.output).toBe(0);
      const packaged = run("scripts/package.mjs");
      expect(packaged.status, packaged.output).toBe(0);
      releaseHashes = new Map(
        await Promise.all(
          (await archives()).map(
            async (name) => [name, hash(await readFile(join(project, "releases", name)))] as const,
          ),
        ),
      );
      expect(releaseHashes.size).toBe(4);
    },
    PIPELINE_TIMEOUT,
  );

  it(
    "preserves existing same-version installable and source archives",
    async () => {
      expect(releaseHashes.size).toBe(4);
      expect(run("scripts/package.mjs", ["chrome"]).status).toBe(0);
      expect(run("scripts/package-source.mjs").status).toBe(0);
      for (const [name, checksum] of releaseHashes)
        expect(hash(await readFile(join(project, "releases", name)))).toBe(checksum);
    },
    PIPELINE_TIMEOUT,
  );
});
