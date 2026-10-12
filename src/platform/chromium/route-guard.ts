// SPDX-License-Identifier: MPL-2.0

import type { RouteGuardDependencies } from "../contracts/route-guard";
export type { RouteGuardDependencies, RouteGuardState } from "../contracts/route-guard";

/** Chromium's request protection is enforced by verified DNR rules and proxy authentication. */
export class PlatformRouteGuard {
  constructor(dependencies: RouteGuardDependencies) {
    // Keep the cross-platform construction contract without installing an extra request hook.
    if (
      typeof dependencies.readState !== "function" ||
      typeof dependencies.extensionRoot !== "function"
    )
      throw new Error("Invalid route guard dependencies");
  }

  register(): void {
    // No blocking webRequest listener: Chromium MV3 uses the network-safety adapter.
  }
}
