// SPDX-License-Identifier: MPL-2.0

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { resolve, sep } from "node:path";
import {
  auditPublication,
  inspectPublicPath,
  inspectPublicText,
} from "../../scripts/audit-publication.mjs";

const cache = resolve(import.meta.dirname, "../../node_modules/.cache/publication-tests");
const fixtures: string[] = [];
function fixture() {
  mkdirSync(cache, { recursive: true });
  const directory = mkdtempSync(resolve(cache, "case-"));
  fixtures.push(directory);
  const environment: NodeJS.ProcessEnv = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_")),
  );
  environment.GIT_CONFIG_NOSYSTEM = "1";
  environment.GIT_CONFIG_GLOBAL = process.platform === "win32" ? "NUL" : "/dev/null";
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: directory,
      env: environment,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
  git("init", "--initial-branch=main");
  git("config", "user.name", "FuzeVPN synthetic fixture");
  git("config", "user.email", "fixture@example.invalid");
  git("config", "commit.gpgSign", "false");
  return { directory, git };
}

afterEach(() => {
  for (const directory of fixtures.splice(0)) {
    if (!directory.startsWith(cache + sep)) throw new Error("Invalid fixture cleanup path");
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("public Git publication safety", () => {
  it.each([
    "prive/account.json",
    "PRIVATE/account.json",
    "audit/local/report.json",
    "audit/reports/VALIDATION.md",
    "publication/common/store-copy.fr.md",
    "publication/releases/package.zip",
    "reference/original-inventory.json",
    "doc private/presentation.md",
    "conserver/signing.json",
    "releases/package.zip",
    "docs/GITHUB_PUBLICATION.fr.md",
    "docs/PUBLICATION_CHROMIUM.md",
    "docs/PRODUCTION-TESTS.fr.md",
    ".env",
    ".npmrc",
    "key.pem",
    "../escape",
    "C:/escape",
  ])("refuses private, generated and escaping paths: %s", (name) => {
    expect(inspectPublicPath(name).length).toBeGreaterThan(0);
  });

  it.each([
    "src/core/shared/privacy.ts",
    "docs/ARCHITECTURE.md",
    "assets/flags/LICENSE.txt",
    "manifests/chrome.json",
    ".env.example",
  ])("allows public source and notices: %s", (name) => expect(inspectPublicPath(name)).toEqual([]));

  it("detects identifiable secrets without returning their values", () => {
    const token = "ghp_" + "A".repeat(36);
    const key = ["-----BEGIN", "PRIVATE KEY-----"].join(" ");
    expect(inspectPublicText(token)).toEqual(["github_token"]);
    expect(inspectPublicText(key)).toEqual(["private_key"]);
    expect(inspectPublicText('"password": "synthetic-password"')).toEqual([]);
    expect(JSON.stringify(inspectPublicText(token))).not.toContain(token);
  });

  it("catches an ignored private path forced into the index", () => {
    const f = fixture();
    writeFileSync(resolve(f.directory, ".gitignore"), "prive/\n");
    mkdirSync(resolve(f.directory, "prive"));
    writeFileSync(resolve(f.directory, "prive/account.json"), "{}\n");
    f.git("add", ".gitignore");
    expect(auditPublication(f.directory).passed).toBe(true);
    f.git("add", "-f", "prive/account.json");
    expect(auditPublication(f.directory).findings).toContainEqual({
      scope: "index",
      file: "prive/account.json",
      rule: "private_or_generated_path",
    });
  });

  it("detects a removed secret in reachable Git history", () => {
    const f = fixture();
    const token = "ghp_" + "A".repeat(36);
    writeFileSync(resolve(f.directory, "README.md"), token);
    f.git("add", "README.md");
    f.git("commit", "-m", "Synthetic secret fixture");
    writeFileSync(resolve(f.directory, "README.md"), "Public documentation\n");
    f.git("add", "README.md");
    f.git("commit", "-m", "Remove synthetic fixture");
    expect(auditPublication(f.directory).passed).toBe(true);
    const result = auditPublication(f.directory, { history: true });
    expect(result.commits).toBe(2);
    expect(result.passed).toBe(false);
    expect(result.findings.some((finding) => finding.rule === "github_token")).toBe(true);
    expect(JSON.stringify(result)).not.toContain(token);
  });

  it("rejects a Git symlink even when its working-tree file is ordinary", () => {
    const f = fixture();
    writeFileSync(resolve(f.directory, "link"), "../prive/account.json");
    const hash = f.git("hash-object", "-w", "link").toString().trim();
    f.git("update-index", "--add", "--cacheinfo", `120000,${hash},link`);
    expect(auditPublication(f.directory).findings).toContainEqual({
      scope: "index",
      file: "link",
      rule: "linked_or_unmerged_git_entry",
    });
  });

  it("refuses reading a public path through a linked parent directory", () => {
    const f = fixture();
    writeFileSync(resolve(f.directory, ".gitignore"), "private/\n");
    mkdirSync(resolve(f.directory, "private"));
    writeFileSync(resolve(f.directory, "private/data.json"), "{}\n");
    const hash = f.git("hash-object", "-w", "private/data.json").toString().trim();
    f.git("add", ".gitignore");
    f.git("update-index", "--add", "--cacheinfo", `100644,${hash},public/data.json`);
    symlinkSync(resolve(f.directory, "private"), resolve(f.directory, "public"), "junction");
    expect(auditPublication(f.directory).findings).toContainEqual({
      scope: "working_tree",
      file: "public/data.json",
      rule: "linked_or_non_file_input",
    });
  });
});
