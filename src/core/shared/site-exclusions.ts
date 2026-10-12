// SPDX-License-Identifier: MPL-2.0

import publicSuffixRules from "./vendor/public-suffix-rules.json";

export interface SiteExclusion {
  domain: string;
  includeSubdomains: boolean;
}

export interface SiteExclusionPolicy {
  revision: number;
  enabled: boolean;
  entries: SiteExclusion[];
}

export interface SiteExclusionsState {
  saved: SiteExclusionPolicy;
  applied: SiteExclusionPolicy;
  pending: boolean;
  error: boolean;
  /** A corrupt preference journal was reset during an explicit disconnect. */
  recoveryNotice?: "preferences_reset";
}

export const MAX_SITE_EXCLUSIONS = 100;
export const EMPTY_SITE_EXCLUSION_POLICY: SiteExclusionPolicy = {
  revision: 0,
  enabled: false,
  entries: [],
};
export const EMPTY_SITE_EXCLUSIONS: SiteExclusionsState = {
  saved: { ...EMPTY_SITE_EXCLUSION_POLICY, entries: [] },
  applied: { ...EMPTY_SITE_EXCLUSION_POLICY, entries: [] },
  pending: false,
  error: false,
};

const reservedDestinations = ["api.fuzevpn.com", "api.ipify.org", "api64.ipify.org"];
const localSuffixes = ["localhost", "local", "internal", "lan", "home", "home.arpa", "onion"];
const exactSuffixes = new Set<string>();
const wildcardSuffixes = new Set<string>();
const suffixExceptions = new Set<string>();
const knownRoots = new Set<string>();
for (const rule of publicSuffixRules) {
  const domain = rule.replace(/^(?:!|\*\.)/, "");
  const root = domain.split(".").at(-1);
  if (root) knownRoots.add(root);
  if (rule.startsWith("!")) suffixExceptions.add(domain);
  else if (rule.startsWith("*.")) wildcardSuffixes.add(domain);
  else exactSuffixes.add(domain);
}

export class SiteExclusionValidationError extends Error {
  constructor(readonly reason: "invalid" | "local" | "public_suffix" | "reserved") {
    super(reason);
    this.name = "SiteExclusionValidationError";
  }
}

/** Canonical ASCII hostname; paths, ports and queries do not narrow an exception. */
export function normalizeSiteExclusion(input: string, includeSubdomains: boolean): SiteExclusion {
  if (typeof input !== "string" || typeof includeSubdomains !== "boolean") {
    throw new SiteExclusionValidationError("invalid");
  }
  const text = input.trim();
  if (!text || text.length > 4096 || /[\s\\\p{Cc}]/u.test(text)) {
    throw new SiteExclusionValidationError("invalid");
  }
  let parsed: URL;
  try {
    parsed = new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(text) ? text : `https://${text}`);
  } catch {
    throw new SiteExclusionValidationError("invalid");
  }
  if (
    !["http:", "https:"].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password ||
    parsed.hostname.includes("*")
  ) {
    throw new SiteExclusionValidationError("invalid");
  }
  const domain = parsed.hostname.toLowerCase().replace(/\.$/, "");
  const labels = domain.split(".");
  if (
    domain.length > 253 ||
    labels.some((label) => !/^[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?$/.test(label)) ||
    /^\d+(?:\.\d+)*$/.test(domain)
  ) {
    throw new SiteExclusionValidationError("invalid");
  }
  if (
    labels.length < 2 ||
    !knownRoots.has(labels.at(-1) ?? "") ||
    localSuffixes.some((suffix) => domain === suffix || domain.endsWith(`.${suffix}`))
  ) {
    throw new SiteExclusionValidationError("local");
  }
  if (publicSuffixLength(labels) === labels.length) {
    throw new SiteExclusionValidationError("public_suffix");
  }
  if (
    reservedDestinations.some(
      (reserved) => domain === reserved || (includeSubdomains && reserved.endsWith(`.${domain}`)),
    )
  ) {
    throw new SiteExclusionValidationError("reserved");
  }
  return { domain, includeSubdomains };
}

/** Longest matching PSL rule, with exception rules taking precedence. */
function publicSuffixLength(labels: string[]): number {
  let length = 1;
  for (let index = 0; index < labels.length; index += 1) {
    const suffix = labels.slice(index).join(".");
    if (suffixExceptions.has(suffix)) return labels.length - index - 1;
    if (exactSuffixes.has(suffix)) length = Math.max(length, labels.length - index);
    if (index > 0 && wildcardSuffixes.has(suffix)) {
      length = Math.max(length, labels.length - index + 1);
    }
  }
  return length;
}

export function validateSiteExclusionPolicy(value: unknown): value is SiteExclusionPolicy {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const policy = value as Record<string, unknown>;
  if (
    !Number.isSafeInteger(policy.revision) ||
    (policy.revision as number) < 0 ||
    typeof policy.enabled !== "boolean" ||
    !Array.isArray(policy.entries) ||
    policy.entries.length > MAX_SITE_EXCLUSIONS
  ) {
    return false;
  }
  const seen = new Set<string>();
  for (const value of policy.entries as unknown[]) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const entry = value as Record<string, unknown>;
    if (typeof entry.domain !== "string" || typeof entry.includeSubdomains !== "boolean") {
      return false;
    }
    try {
      const normalized = normalizeSiteExclusion(entry.domain, entry.includeSubdomains);
      if (normalized.domain !== entry.domain || seen.has(normalized.domain)) return false;
      seen.add(normalized.domain);
    } catch {
      return false;
    }
  }
  return true;
}

export function effectiveExclusions(policy: SiteExclusionPolicy): SiteExclusion[] {
  return policy.enabled ? policy.entries.map((entry) => ({ ...entry })) : [];
}

/** Intersects destination coverage, including a broad domain against a narrower child. */
export function intersectExclusions(
  previous: SiteExclusion[],
  next: SiteExclusion[],
): SiteExclusion[] {
  const intersections: SiteExclusion[] = [];
  for (const oldEntry of previous) {
    for (const newEntry of next) {
      if (oldEntry.domain === newEntry.domain) {
        intersections.push({
          domain: oldEntry.domain,
          includeSubdomains: oldEntry.includeSubdomains && newEntry.includeSubdomains,
        });
      } else if (oldEntry.includeSubdomains && newEntry.domain.endsWith(`.${oldEntry.domain}`)) {
        intersections.push({ ...newEntry });
      } else if (newEntry.includeSubdomains && oldEntry.domain.endsWith(`.${newEntry.domain}`)) {
        intersections.push({ ...oldEntry });
      }
    }
  }
  const unique = [
    ...new Map(intersections.map((entry) => [JSON.stringify(entry), entry])).values(),
  ];
  return unique
    .filter(
      (entry) =>
        !unique.some(
          (other) =>
            other !== entry &&
            other.includeSubdomains &&
            (other.domain === entry.domain || entry.domain.endsWith(`.${other.domain}`)),
        ),
    )
    .sort((a, b) => a.domain.localeCompare(b.domain));
}
