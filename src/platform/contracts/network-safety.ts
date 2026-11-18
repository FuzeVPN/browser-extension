// SPDX-License-Identifier: MPL-2.0

import type { SecurityStatus } from "../../core/shared/security";
import type { SiteExclusion } from "../../core/shared/site-exclusions";

export class SafetyError extends Error {
  constructor(readonly code: "traffic_guard_failed" | "webrtc_control_unavailable") {
    super(code);
    this.name = "SafetyError";
  }
}

export interface NetworkSafetyService {
  /** Reject rules Firefox cannot compile before committing a policy journal. */
  validateExclusions?(entries: SiteExclusion[]): Promise<void>;
  /** Set the expected policy before block/allow/inspect. Does not write Firefox settings. */
  configureExclusions?(entries: SiteExclusion[]): void;
  /** Persist a stricter transaction guard until the definitive policy is committed. */
  setExclusionGuard?(entries: SiteExclusion[] | null): Promise<void>;
  suspend(): Promise<void>;
  /**
   * Whether the rules in place are exactly those which block() then allow() leave, the
   * allowance included: nothing would be rewritten. Reads only, and never throws. A
   * platform which cannot attest it leaves this out: its guard is closed at every start.
   */
  verifyAllowance?(killSwitchEnabled: boolean): Promise<boolean>;
  /**
   * Whether nothing of this extension is in place: no rule of its own in either store,
   * and no privacy setting under its control. release() would then change nothing.
   * Reads only, and never throws. A platform which cannot attest it leaves this out.
   */
  verifyReleased?(): Promise<boolean>;
  /** Request rules only; a blocking claim also requires ProxyService's verified route. */
  block(killSwitchEnabled: boolean): Promise<void>;
  allow(): Promise<void>;
  release(): Promise<void>;
  setWebRtc(enabled: boolean): Promise<void>;
  inspect(): Promise<SecurityStatus>;
}
