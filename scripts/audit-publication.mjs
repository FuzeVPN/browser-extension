// SPDX-License-Identifier: MPL-2.0

import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

/** Report rules and paths only; never echo suspected credentials. */
export function inspectPublicPath(name) {
  const findings = [];
  if (
    !name ||
    /[\\:]/.test(name) ||
    [...name].some((character) => character.charCodeAt(0) < 32) ||
    name.startsWith("/") ||
    name.split("/").includes("..")
  )
    findings.push("unsafe_path");
  if (
    /(?:^|\/)(?:prive|private|doc private|conserver|publication|reference|audit|releases|node_modules|dist|coverage|\.cache|\.git)(?:\/|$)/i.test(
      name,
    )
  )
    findings.push("private_or_generated_path");
  if (/^docs\/(?:GITHUB_PUBLICATION|PUBLICATION_CHROMIUM|PRODUCTION-TESTS)(?:[./]|$)/i.test(name))
    findings.push("internal_documentation");
  if (
    /(?:^|\/)(?:COMPTE_TEST_PRIVE[^/]*|\.npmrc|\.pypirc)$/i.test(name) ||
    /(?:^|\/)\.env(?:\.|$)/i.test(name) ||
    /\.(?:zip|xpi|crx|sha256|bundle|pem|key|pfx|p12|log|har|sqlite|sqlite3)$/i.test(name)
  )
    findings.push("private_or_generated_file");
  return findings;
}

export function inspectPublicText(text) {
  const rules = [
    ["private_key", /-----BEGIN (?:RSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/],
    ["github_token", /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{70,})\b/],
    ["aws_access_key", /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/],
    ["npm_token", /\bnpm_[A-Za-z0-9]{36,}\b/],
    ["slack_token", /\bxox[baprs]-\d{10,}-[A-Za-z0-9-]{20,}\b/],
    ["personal_machine_path", /[A-Z]:[\\/]+Users[\\/]+[^\\/\s"']+[\\/]+(?:Desktop|AppData)[\\/]/i],
  ];
  return rules.filter(([, pattern]) => pattern.test(text)).map(([rule]) => rule);
}

function git(root, args, options = {}) {
  try {
    return execFileSync("git", args, {
      cwd: root,
      windowsHide: true,
      maxBuffer: 64 * 1024 * 1024,
      ...options,
    });
  } catch {
    // A process error can contain its captured stdout: do not expose blob contents.
    throw new Error(`Git publication inspection failed (${args[0]})`);
  }
}

function entries(output, stage) {
  return output
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .map((line) => {
      const separator = line.indexOf("\t");
      const fields = line.slice(0, separator).split(" ");
      const [mode, hash] = stage ? fields : [fields[0], fields[2]];
      if (separator < 0 || !/^[0-9a-f]{40,64}$/.test(hash)) throw new Error("Invalid Git entry");
      return { mode, hash, name: line.slice(separator + 1), unmerged: stage && fields[2] !== "0" };
    });
}

function readBlobs(root, hashes) {
  if (!hashes.size) return new Map();
  const output = git(root, ["cat-file", "--batch"], { input: [...hashes].join("\n") + "\n" });
  const blobs = new Map();
  let cursor = 0;
  while (cursor < output.length) {
    const end = output.indexOf(10, cursor);
    if (end < 0) throw new Error("Invalid Git blob header");
    const [hash, type, sizeText] = output.subarray(cursor, end).toString("ascii").split(" ");
    const size = Number(sizeText);
    if (
      type !== "blob" ||
      !hashes.has(hash) ||
      !Number.isSafeInteger(size) ||
      size < 0 ||
      end + size + 2 > output.length
    )
      throw new Error("Invalid Git blob inventory");
    blobs.set(hash, output.subarray(end + 1, end + 1 + size));
    cursor = end + size + 2;
  }
  if (blobs.size !== hashes.size) throw new Error("Incomplete Git blob inventory");
  return blobs;
}

export function auditPublication(root, { history = false } = {}) {
  const findings = [];
  const blobs = new Map();
  const staged = entries(git(root, ["ls-files", "--stage", "-z"]), true);
  const commits = history
    ? git(root, ["rev-list", "--all"]).toString("utf8").trim().split(/\s+/).filter(Boolean)
    : [];
  for (const [scope, list] of [
    ["index", staged],
    ...commits.map((commit) => [
      commit,
      entries(git(root, ["ls-tree", "-r", "-z", commit]), false),
    ]),
  ]) {
    for (const entry of list) {
      for (const rule of inspectPublicPath(entry.name))
        findings.push({ scope, file: entry.name, rule });
      if (!["100644", "100755"].includes(entry.mode) || entry.unmerged) {
        findings.push({ scope, file: entry.name, rule: "linked_or_unmerged_git_entry" });
        continue;
      }
      if (!blobs.has(entry.hash)) blobs.set(entry.hash, []);
      blobs.get(entry.hash).push({ scope, file: entry.name });
    }
  }
  for (const [hash, bytes] of readBlobs(root, new Set(blobs.keys()))) {
    for (const rule of inspectPublicText(bytes.toString("utf8")))
      for (const file of blobs.get(hash)) findings.push({ ...file, rule });
  }
  const publicFiles = git(root, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"])
    .toString("utf8")
    .split("\0")
    .filter(Boolean);
  for (const name of new Set(publicFiles)) {
    const rules = inspectPublicPath(name);
    for (const rule of rules) findings.push({ scope: "working_tree", file: name, rule });
    if (rules.length) continue;
    const file = resolve(root, name);
    let linkedParent = false;
    const parents = name.split("/").slice(0, -1);
    for (let depth = 1; depth <= parents.length; depth++) {
      if (
        lstatSync(resolve(root, ...parents.slice(0, depth)), {
          throwIfNoEntry: false,
        })?.isSymbolicLink()
      ) {
        linkedParent = true;
        break;
      }
    }
    if (linkedParent) {
      findings.push({ scope: "working_tree", file: name, rule: "linked_or_non_file_input" });
      continue;
    }
    const stat = lstatSync(file, { throwIfNoEntry: false });
    if (!stat) continue; // Staged deletion: its old blob was inspected above.
    if (!stat.isFile() || stat.isSymbolicLink()) {
      findings.push({ scope: "working_tree", file: name, rule: "linked_or_non_file_input" });
      continue;
    }
    for (const rule of inspectPublicText(readFileSync(file, "utf8")))
      findings.push({ scope: "working_tree", file: name, rule });
  }
  const unique = [...new Map(findings.map((f) => [JSON.stringify(f), f])).values()];
  return {
    passed: unique.length === 0,
    publicFiles: new Set(publicFiles).size,
    stagedFiles: staged.length,
    commits: commits.length,
    gitBlobs: blobs.size,
    findings: unique,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.slice(2).some((argument) => argument !== "--history"))
      throw new Error("Unknown publication audit option");
    const result = auditPublication(process.cwd(), { history: process.argv.includes("--history") });
    process.stdout.write(JSON.stringify(result) + "\n");
    if (!result.passed) process.exitCode = 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Publication audit failed");
    process.exitCode = 1;
  }
}
