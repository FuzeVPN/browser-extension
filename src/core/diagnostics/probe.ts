// SPDX-License-Identifier: MPL-2.0

import { NetworkObserver } from "../background/network-observer";
import { EMPTY_NETWORK_OBSERVATION, type NetworkObservation } from "../shared/network";
import type { AppSnapshot } from "../shared/state";

interface DiagnosticProbeOptions {
  getSnapshot(): AppSnapshot;
  verifyRoute(mode: "direct" | "vpn"): Promise<boolean>;
  fetch?: typeof fetch;
  now?: () => number;
}

/** A manual diagnostic gets its own observation, with no business-state publication.
 * A refused route is not evidence of a failed network request. */
export async function readDiagnosticProbe(
  options: DiagnosticProbeOptions,
): Promise<NetworkObservation> {
  const result = { routeUnverified: false };
  const observer = new NetworkObserver({
    ...options,
    verifyRoute: async (mode) => {
      result.routeUnverified = true;
      try {
        if (await options.verifyRoute(mode)) {
          result.routeUnverified = false;
          return true;
        }
      } catch {
        // Read failures do not authorize a probe or establish a network failure.
      }
      return false;
    },
    onChanged: () => undefined,
  });
  await observer.refresh();
  return result.routeUnverified ? { ...EMPTY_NETWORK_OBSERVATION } : observer.getState();
}
