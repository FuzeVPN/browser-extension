// SPDX-License-Identifier: MPL-2.0

import { extensionApi } from "@platform/bridge";
import {
  EMPTY_SITE_EXCLUSION_POLICY,
  validateSiteExclusionPolicy,
  type SiteExclusionPolicy,
} from "../shared/site-exclusions";

export interface SiteExclusionRecord {
  version: 1;
  saved: SiteExclusionPolicy;
  applied: SiteExclusionPolicy;
  pending: boolean;
  recoveryNotice?: "preferences_reset";
}

export interface SiteExclusionStorage {
  read(): Promise<SiteExclusionRecord>;
  write(record: SiteExclusionRecord): Promise<void>;
  /** Only after an explicit disconnect has cleared the proxy and armed a guard. */
  recoverForDisconnect?(): Promise<SiteExclusionRecord>;
}

export class InvalidSiteExclusionStorageError extends Error {
  constructor() {
    super("invalid_site_exclusion_storage");
    this.name = "InvalidSiteExclusionStorageError";
  }
}

export function emptySiteExclusionRecord(): SiteExclusionRecord {
  return structuredClone({
    version: 1,
    saved: EMPTY_SITE_EXCLUSION_POLICY,
    applied: EMPTY_SITE_EXCLUSION_POLICY,
    pending: false,
  });
}

export const SITE_EXCLUSIONS_KEY = "fuzevpnSiteExclusions";
export const SITE_EXCLUSION_RECOVERY_KEY = "fuzevpnSiteExclusionRecovery";

export class ExtensionSiteExclusionStorage implements SiteExclusionStorage {
  async read(): Promise<SiteExclusionRecord> {
    const stored = await extensionApi.storage.local.get(SITE_EXCLUSIONS_KEY);
    const value: unknown = stored[SITE_EXCLUSIONS_KEY];
    if (value === undefined) return emptySiteExclusionRecord();
    if (!isRecord(value)) throw new InvalidSiteExclusionStorageError();
    return structuredClone(value);
  }

  async write(record: SiteExclusionRecord): Promise<void> {
    if (!isRecord(record)) throw new InvalidSiteExclusionStorageError();
    await extensionApi.storage.local.set({ [SITE_EXCLUSIONS_KEY]: record });
    const actual = await this.read();
    if (canonical(actual) !== canonical(record))
      throw new Error("site_exclusion_storage_unverified");
  }

  async recoverForDisconnect(): Promise<SiteExclusionRecord> {
    // A read error is not evidence of corruption. Never overwrite unread data.
    const stored = await extensionApi.storage.local.get(SITE_EXCLUSIONS_KEY);
    const value: unknown = stored[SITE_EXCLUSIONS_KEY];
    if (value === undefined) return emptySiteExclusionRecord();
    if (isRecord(value)) return structuredClone(value);

    const recovered = emptySiteExclusionRecord();
    recovered.saved.revision = recovered.applied.revision = recoveryRevision(value);
    recovered.recoveryNotice = "preferences_reset";
    // Keep a bounded diagnosis rather than duplicating an arbitrarily large or
    // malformed value into Chrome's limited storage quota.
    const diagnosis = {
      reason: "invalid_site_exclusion_storage",
      capturedAt: Date.now(),
      summary: corruptionSummary(value),
    };
    await extensionApi.storage.local.set({
      [SITE_EXCLUSIONS_KEY]: recovered,
      [SITE_EXCLUSION_RECOVERY_KEY]: diagnosis,
    });
    const actual = await extensionApi.storage.local.get([
      SITE_EXCLUSIONS_KEY,
      SITE_EXCLUSION_RECOVERY_KEY,
    ]);
    if (
      !isRecord(actual[SITE_EXCLUSIONS_KEY]) ||
      canonical(actual[SITE_EXCLUSIONS_KEY]) !== canonical(recovered) ||
      canonical(actual[SITE_EXCLUSION_RECOVERY_KEY]) !== canonical(diagnosis)
    ) {
      throw new Error("site_exclusion_storage_unverified");
    }
    return structuredClone(recovered);
  }
}

function isRecord(value: unknown): value is SiteExclusionRecord {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  if (
    item.version !== 1 ||
    typeof item.pending !== "boolean" ||
    (item.recoveryNotice !== undefined && item.recoveryNotice !== "preferences_reset") ||
    !validateSiteExclusionPolicy(item.saved) ||
    !validateSiteExclusionPolicy(item.applied)
  )
    return false;
  return item.pending
    ? item.saved.revision === item.applied.revision + 1
    : canonical(item.saved) === canonical(item.applied);
}

function recoveryRevision(value: unknown): number {
  const item = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const revisions = [item.saved, item.applied].map((policy) =>
    policy && typeof policy === "object" ? (policy as Record<string, unknown>).revision : undefined,
  );
  // Preserve valid revision history where possible, while recovering an invalid
  // maximum revision instead of creating a policy that can never be edited.
  return (
    Math.max(
      0,
      ...revisions.filter(
        (revision): revision is number =>
          typeof revision === "number" &&
          Number.isSafeInteger(revision) &&
          revision >= 0 &&
          revision < Number.MAX_SAFE_INTEGER - 1,
      ),
    ) + 1
  );
}

function corruptionSummary(value: unknown): Record<string, unknown> {
  const item = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const policySummary = (policy: unknown): Record<string, unknown> => {
    const record = policy && typeof policy === "object" ? (policy as Record<string, unknown>) : {};
    return {
      revision: typeof record.revision === "number" ? record.revision : null,
      enabled: typeof record.enabled === "boolean" ? record.enabled : null,
      entryCount: Array.isArray(record.entries) ? record.entries.length : null,
    };
  };
  return {
    valueType: value === null ? "null" : Array.isArray(value) ? "array" : typeof value,
    version: typeof item.version === "number" ? item.version : null,
    pending: typeof item.pending === "boolean" ? item.pending : null,
    saved: policySummary(item.saved),
    applied: policySummary(item.applied),
  };
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
