// SPDX-License-Identifier: MPL-2.0

import type { ProxySession } from "../../core/api/types";
import type { ProxyChallenger } from "./proxy";

export interface ProxyAuthDependencies {
  getSession(): Promise<ProxySession | null>;
  isConfiguredProxyChallenge(challenger: ProxyChallenger): Promise<boolean>;
  wasUsedProxyChallenge(challenger: ProxyChallenger): Promise<boolean>;
  isSessionCurrent(session: ProxySession): boolean;
  onAuthenticationFailure?(session: ProxySession): Promise<void>;
  now(): number;
  restoreTimeoutMs?: number;
}
