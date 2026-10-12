// SPDX-License-Identifier: MPL-2.0

import type { AppSnapshot } from "./state";

// Successful observations stay cached for 30 seconds; failed ones can recover sooner.
export const NETWORK_OBSERVATION_POLL_MS = 5_000;

export interface NetworkObservation {
  status: "idle" | "checking" | "ready" | "unavailable";
  mode: "direct" | "vpn" | null;
  ip: string | null;
  checkedAt: number | null;
  latencyMs: number | null;
  locationId: string | null;
}

export const EMPTY_NETWORK_OBSERVATION: NetworkObservation = {
  status: "idle",
  mode: null,
  ip: null,
  checkedAt: null,
  latencyMs: null,
  locationId: null,
};

type NetworkRouteSnapshot = Pick<
  AppSnapshot,
  "status" | "protected" | "trafficBlocked" | "protectionRequested" | "activeLocationId" | "profile"
> & {
  siteExclusions?: { applied?: { revision?: number }; pending?: boolean; error?: boolean } | null;
};

export function networkRouteKey(snapshot: NetworkRouteSnapshot): string {
  return JSON.stringify([
    snapshot.status,
    snapshot.protected,
    snapshot.trafficBlocked,
    snapshot.protectionRequested,
    snapshot.activeLocationId,
    snapshot.profile?.userId ?? null,
    snapshot.siteExclusions?.applied?.revision ?? 0,
    snapshot.siteExclusions?.pending ?? false,
    snapshot.siteExclusions?.error ?? false,
  ]);
}
