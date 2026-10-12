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
  block(killSwitchEnabled: boolean): Promise<void>;
  allow(): Promise<void>;
  release(): Promise<void>;
  setWebRtc(enabled: boolean): Promise<void>;
  inspect(): Promise<SecurityStatus>;
}
