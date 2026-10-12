// SPDX-License-Identifier: MPL-2.0

import type { ProxySession } from "../../core/api/types";
import type { SiteExclusion } from "../../core/shared/site-exclusions";

export type ProxyControlLevel =
  | "not_controllable"
  | "controlled_by_other_extensions"
  | "controllable_by_this_extension"
  | "controlled_by_this_extension";

export interface ProxyChallenger {
  host: string;
  port: number;
}

export class ProxyControlError extends Error {
  constructor(
    readonly level:
      | ProxyControlLevel
      | "configuration_rejected"
      | "private_browsing_required"
      | "host_permissions_required",
  ) {
    super(level);
    this.name = "ProxyControlError";
  }
}

export interface ProxyService {
  getControlLevel(): Promise<ProxyControlLevel>;
  assertControllable(): Promise<void>;
  apply(session: ProxySession): Promise<void>;
  clear(): Promise<void>;
  isActiveConfiguration(session: ProxySession): Promise<boolean>;
  isConfiguredProxyChallenge(challenger: ProxyChallenger): Promise<boolean>;
  configureExclusions?(entries: SiteExclusion[]): void;
  updateExistingExclusions?(previous: SiteExclusion[], next: SiteExclusion[]): Promise<void>;
  isExclusionConfiguration?(): Promise<boolean>;
}
