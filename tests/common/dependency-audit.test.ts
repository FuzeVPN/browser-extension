// SPDX-License-Identifier: MPL-2.0

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  auditOutcome,
  readExceptions,
  reportedAdvisories,
} from "../../scripts/audit-dependencies.mjs";

const PICOMATCH = "GHSA-fc5q-39xc-vjpf";
const advisory = (name: string, id: string, severity: string) => ({
  source: 1,
  name,
  title: `${name} advisory`,
  url: `https://github.com/advisories/${id}`,
  severity,
  range: "*",
});
/** A report as `npm audit --json` gives it: dependents name the package they inherit from. */
const report = (...advisories: ReturnType<typeof advisory>[]) => ({
  auditReportVersion: 2,
  vulnerabilities: {
    ...Object.fromEntries(
      advisories.map((entry) => [
        entry.name,
        { name: entry.name, severity: entry.severity, via: [entry] },
      ]),
    ),
    vite: { name: "vite", severity: "high", via: ["picomatch", "tinyglobby"] },
    tinyglobby: { name: "tinyglobby", severity: "high", via: ["picomatch"] },
  },
});
const exception = {
  advisory: PICOMATCH,
  package: "picomatch",
  reason: "No released version fixes it, and it is a build tool only.",
  until: "2026-12-18",
};
const high = advisory("picomatch", PICOMATCH, "high");

describe("the dependency gate of the workflow", () => {
  it("passes a lockfile with no advisory", () => {
    expect(auditOutcome({ vulnerabilities: {} }, [], "2026-11-18")).toEqual({
      blocking: [],
      accepted: [],
      unused: [],
    });
  });

  it("fails on an advisory of high or critical severity, as npm audit does", () => {
    for (const severity of ["high", "critical"]) {
      const outcome = auditOutcome(report(advisory("left-pad", PICOMATCH, severity)), [], "x");
      expect(outcome.blocking).toEqual([
        expect.objectContaining({ id: PICOMATCH, package: "left-pad", severity, expired: null }),
      ]);
    }
  });

  it("lets advisories of lower severity pass, as npm audit does at this level", () => {
    const lower = report(
      advisory("minimatch", "GHSA-g3hv-75wg-m249", "moderate"),
      advisory("other", "GHSA-aaaa-bbbb-cccc", "low"),
    );
    expect(auditOutcome(lower, [], "2026-11-18").blocking).toEqual([]);
  });

  it("counts an advisory once, however many packages inherit it", () => {
    expect(reportedAdvisories(report(high))).toEqual([
      { id: PICOMATCH, package: "picomatch", severity: "high", url: high.url },
    ]);
  });

  it("accepts the advisory which an exception names, through its last day", () => {
    for (const today of ["2026-11-18", "2026-12-18"]) {
      const outcome = auditOutcome(report(high), [exception], today);
      expect(outcome.blocking).toEqual([]);
      expect(outcome.accepted).toEqual([
        expect.objectContaining({ id: PICOMATCH, until: "2026-12-18" }),
      ]);
    }
  });

  it("fails again once the exception has ended, and says when it did", () => {
    const outcome = auditOutcome(report(high), [exception], "2026-12-19");
    expect(outcome.accepted).toEqual([]);
    expect(outcome.blocking).toEqual([
      expect.objectContaining({ id: PICOMATCH, expired: "2026-12-18" }),
    ]);
  });

  it("accepts nothing else: another advisory, or the same one in another package", () => {
    const others = report(
      high,
      advisory("picomatch-fork", PICOMATCH, "high"),
      advisory("picomatch", "GHSA-zzzz-yyyy-xxxx", "critical"),
    );
    // picomatch itself carries two advisories: the one excepted, and another.
    const outcome = auditOutcome(
      {
        vulnerabilities: {
          ...others.vulnerabilities,
          picomatch: {
            via: [high, advisory("picomatch", "GHSA-zzzz-yyyy-xxxx", "critical")],
          },
        },
      },
      [exception],
      "2026-11-18",
    );
    expect(outcome.accepted.map(({ id }) => id)).toEqual([PICOMATCH]);
    expect(outcome.blocking.map(({ id, package: name }) => [id, name]).sort()).toEqual([
      [PICOMATCH, "picomatch-fork"],
      ["GHSA-zzzz-yyyy-xxxx", "picomatch"],
    ]);
  });

  it("names an exception which no longer accepts anything", () => {
    const outcome = auditOutcome({ vulnerabilities: {} }, [exception], "2026-11-18");
    expect(outcome.unused).toEqual([expect.objectContaining({ advisory: PICOMATCH })]);
    expect(outcome.blocking).toEqual([]);
  });

  it.each([
    ["no advisory", { ...exception, advisory: "picomatch" }],
    ["no package", { ...exception, package: "" }],
    ["no reason", { ...exception, reason: "temporary" }],
    ["no end date", { ...exception, until: "later" }],
    ["an end date which is none", { ...exception, until: "2026-13-45" }],
  ])("refuses an exception with %s", (_name, entry) => {
    expect(() => readExceptions([entry])).toThrow();
  });

  it("refuses a report it cannot read rather than pass it", () => {
    expect(() => auditOutcome(null, [], "2026-11-18")).toThrow();
    expect(() => auditOutcome({ error: { code: "ENOTFOUND" } }, [], "2026-11-18")).toThrow();
  });

  it("keeps listed exceptions readable, each for one advisory and three months at most", () => {
    const listed = readExceptions(
      JSON.parse(
        readFileSync(
          new URL("../../scripts/dependency-audit-exceptions.json", import.meta.url),
          "utf8",
        ),
      ),
    );
    expect(new Set(listed.map(({ advisory: id }) => id)).size).toBe(listed.length);
    for (const { until } of listed) {
      // Written on 18 November 2026: an exception is looked at again within three months.
      expect(Date.parse(until)).toBeLessThanOrEqual(Date.parse("2027-02-18"));
    }
  });
});
