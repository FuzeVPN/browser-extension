// SPDX-License-Identifier: MPL-2.0

import type { ExtensionRequest } from "../../core/shared/messages";
import type { SiteExclusionPolicy, SiteExclusionsState } from "../../core/shared/site-exclusions";

export interface ExclusionIntent {
  base: SiteExclusionPolicy;
  target: Pick<SiteExclusionPolicy, "enabled" | "entries">;
}

type ExclusionRetry =
  | { type: "complete" }
  | { type: "conflict" }
  | Extract<ExtensionRequest, { type: "retry_site_exclusions" | "update_site_exclusions" }>;

/** Retry only the original intent or its journal, never overwrite a newer preference. */
export function exclusionRetry(
  intent: ExclusionIntent | null,
  state: SiteExclusionsState,
): ExclusionRetry {
  if (!intent) return { type: "retry_site_exclusions" };
  if (samePolicy(intent.target, state.saved)) {
    if (state.pending || state.error) return { type: "retry_site_exclusions" };
    return samePolicy(intent.target, state.applied) ? { type: "complete" } : { type: "conflict" };
  }
  if (
    state.pending ||
    state.error ||
    state.saved.revision !== intent.base.revision ||
    !samePolicy(intent.base, state.saved)
  )
    return { type: "conflict" };
  return {
    type: "update_site_exclusions",
    expectedRevision: state.saved.revision,
    ...structuredClone(intent.target),
  };
}

function samePolicy(
  left: Pick<SiteExclusionPolicy, "enabled" | "entries">,
  right: Pick<SiteExclusionPolicy, "enabled" | "entries">,
): boolean {
  return (
    left.enabled === right.enabled &&
    left.entries.length === right.entries.length &&
    left.entries.every(
      (entry, index) =>
        entry.domain === right.entries[index]?.domain &&
        entry.includeSubdomains === right.entries[index].includeSubdomains,
    )
  );
}
