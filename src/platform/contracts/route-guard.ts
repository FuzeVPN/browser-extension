// SPDX-License-Identifier: MPL-2.0

import type { SiteExclusion } from "../../core/shared/site-exclusions";
import type { ProxyChallenger } from "./proxy";

export type RouteGuardState = (
  | { mode: "off" }
  | { mode: "block"; exclusions: SiteExclusion[] }
  | { mode: "proxy"; exclusions: SiteExclusion[]; endpoint: ProxyChallenger }
) & { isCurrent: () => boolean };

export interface RouteGuardDependencies {
  readState(): Promise<RouteGuardState>;
  extensionRoot(): string;
  restoreTimeoutMs?: number;
}
