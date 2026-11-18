// SPDX-License-Identifier: MPL-2.0

/**
 * The dependency gate of the workflow. It fails on any advisory of high or critical
 * severity which `npm audit` reports for the lockfile, as `npm audit --audit-level=high`
 * does, except the advisories listed in `dependency-audit-exceptions.json`.
 *
 * An exception names one advisory and the package it concerns, says why it is accepted,
 * and carries the date after which it is no longer accepted. It exists for an advisory
 * which no released version of the package fixes: the gate would otherwise fail on every
 * commit, whatever it changes, and say nothing more about the others.
 */

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const BLOCKING = new Set(["high", "critical"]);
const EXCEPTIONS_FILE = resolve(
  fileURLToPath(new URL(".", import.meta.url)),
  "dependency-audit-exceptions.json",
);

/** An advisory identifier as GitHub writes it. */
const canonical = (id) => `GHSA${id.slice(4).toLowerCase()}`;

/** The advisories of an `npm audit --json` report, each once. */
export function reportedAdvisories(report) {
  if (!report || typeof report !== "object" || typeof report.vulnerabilities !== "object")
    throw new Error("Unreadable npm audit report");
  const found = new Map();
  for (const vulnerability of Object.values(report.vulnerabilities ?? {})) {
    for (const via of vulnerability?.via ?? []) {
      // A dependent of a vulnerable package names it; the package itself carries the advisory.
      if (!via || typeof via !== "object") continue;
      const match = /GHSA(?:-[0-9a-z]{4}){3}/i.exec(String(via.url ?? ""))?.[0];
      const id = match ? canonical(match) : undefined;
      // One advisory may concern several packages: each of them is reported.
      const key = `${String(via.name)}:${id ?? String(via.source ?? via.title)}`;
      found.set(key, {
        id: id ?? null,
        package: String(via.name),
        severity: String(via.severity),
        url: String(via.url ?? ""),
      });
    }
  }
  return [...found.values()];
}

/** The listed exceptions, or an error which says what one of them lacks. */
export function readExceptions(listed) {
  if (!Array.isArray(listed)) throw new Error("The exceptions must be a list");
  return listed.map((entry, index) => {
    const { advisory, package: name, reason, until } = entry ?? {};
    if (typeof advisory !== "string" || !/^GHSA(?:-[0-9a-z]{4}){3}$/i.test(advisory))
      throw new Error(`Exception ${index + 1} names no advisory`);
    if (typeof name !== "string" || !name)
      throw new Error(`Exception ${advisory} names no package`);
    if (typeof reason !== "string" || reason.trim().length < 20)
      throw new Error(`Exception ${advisory} gives no reason`);
    if (
      typeof until !== "string" ||
      !/^\d{4}-\d{2}-\d{2}$/.test(until) ||
      Number.isNaN(Date.parse(until))
    )
      throw new Error(`Exception ${advisory} has no end date`);
    return { advisory: canonical(advisory), package: name, reason, until };
  });
}

/**
 * What the gate decides for a report: the advisories which fail it, those which an
 * exception accepts until its date, and the exceptions which no longer accept anything.
 * `today` is a date as `YYYY-MM-DD`.
 */
export function auditOutcome(report, listed, today) {
  const exceptions = readExceptions(listed);
  const blocking = [];
  const accepted = [];
  const used = new Set();
  for (const advisory of reportedAdvisories(report)) {
    if (!BLOCKING.has(advisory.severity)) continue;
    const exception = exceptions.find(
      (entry) => entry.advisory === advisory.id && entry.package === advisory.package,
    );
    if (exception) used.add(exception);
    // An exception is accepted through its last day.
    if (exception && today <= exception.until)
      accepted.push({ ...advisory, until: exception.until });
    else blocking.push({ ...advisory, expired: exception ? exception.until : null });
  }
  return { blocking, accepted, unused: exceptions.filter((entry) => !used.has(entry)) };
}

function main() {
  const audit = spawnSync("npm audit --json", {
    shell: true,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  let report;
  try {
    report = JSON.parse(audit.stdout);
  } catch {
    throw new Error(`npm audit gave no report: ${String(audit.stderr ?? audit.error).trim()}`);
  }
  if (report.error) throw new Error(`npm audit failed: ${JSON.stringify(report.error)}`);
  const today = new Date().toISOString().slice(0, 10);
  const outcome = auditOutcome(report, JSON.parse(readFileSync(EXCEPTIONS_FILE, "utf8")), today);
  for (const advisory of outcome.accepted)
    console.log(
      `Accepted until ${advisory.until}: ${advisory.id} (${advisory.package}, ${advisory.severity})`,
    );
  for (const exception of outcome.unused)
    console.log(`No longer reported, to remove from the exceptions: ${exception.advisory}`);
  for (const advisory of outcome.blocking)
    console.error(
      `${advisory.severity}: ${advisory.id ?? advisory.url} (${advisory.package})` +
        (advisory.expired ? `, its exception ended on ${advisory.expired}` : ""),
    );
  console.log(JSON.stringify({ passed: outcome.blocking.length === 0, today, ...outcome }));
  if (outcome.blocking.length > 0) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
