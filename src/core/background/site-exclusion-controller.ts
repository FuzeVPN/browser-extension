// SPDX-License-Identifier: MPL-2.0

import {
  effectiveExclusions,
  intersectExclusions,
  validateSiteExclusionPolicy,
  type SiteExclusion,
  type SiteExclusionPolicy,
  type SiteExclusionsState,
} from "../shared/site-exclusions";
import {
  emptySiteExclusionRecord,
  InvalidSiteExclusionStorageError,
  type SiteExclusionRecord,
  type SiteExclusionStorage,
} from "../storage/site-exclusion-storage";
import { ProxyControlError, type ProxyService } from "./proxy-controller";
import { SafetyError, type NetworkSafetyService } from "./network-safety";

/** All methods run under the app controller's network mutation lock. */
export class SiteExclusionController {
  private record: SiteExclusionRecord = emptySiteExclusionRecord();
  private error = false;
  private unreadable = true;

  constructor(
    private readonly storage: SiteExclusionStorage | undefined,
    private readonly proxy: ProxyService,
    private readonly safety: NetworkSafetyService,
    private readonly armGuard?: (allowed: SiteExclusion[]) => Promise<void>,
  ) {}

  getState(): SiteExclusionsState {
    return structuredClone({
      saved: this.record.saved,
      applied: this.record.applied,
      pending: this.record.pending || this.unreadable,
      error: this.error,
      ...(this.record.recoveryNotice ? { recoveryNotice: this.record.recoveryNotice } : {}),
    });
  }

  get pending(): boolean {
    return this.record.pending || this.unreadable;
  }

  async initialize(): Promise<void> {
    try {
      this.record = this.storage ? await this.storage.read() : emptySiteExclusionRecord();
      this.unreadable = false;
      this.error = false;
      this.configure();
    } catch (error) {
      this.unreadable = true;
      this.error = true;
      this.configure();
      throw error;
    }
  }

  async stage(expectedRevision: number, enabled: boolean, entries: SiteExclusion[]): Promise<void> {
    if (!this.storage || this.pending || expectedRevision !== this.record.saved.revision)
      throw new Error("site_exclusion_revision_conflict");
    const target: SiteExclusionPolicy = { revision: expectedRevision + 1, enabled, entries };
    if (!validateSiteExclusionPolicy(target)) throw new Error("invalid_site_exclusions");
    // Syntax and DNS length do not establish Chrome RE2 support. Preflight even
    // disabled entries, so enabling a saved policy cannot arm an impossible journal.
    await this.safety.validateExclusions?.(entries);
    const journal: SiteExclusionRecord = {
      version: 1,
      saved: structuredClone(target),
      applied: this.record.applied,
      pending: true,
      ...(this.record.recoveryNotice ? { recoveryNotice: this.record.recoveryNotice } : {}),
    };
    // The journal is written BEFORE either network mechanism is changed. Retain
    // it in memory even on uncertain writes so the next operation cannot allow traffic.
    this.record = journal;
    try {
      await this.storage.write(journal);
    } catch (error) {
      this.error = true;
      throw error;
    }
    this.error = false;
  }

  async apply(): Promise<void> {
    if (this.unreadable) await this.initialize();
    if (!this.record.pending) {
      try {
        // An uncertain earlier commit may already be durable while its old
        // temporary route still needs restoring. Never remove that guard first.
        const target = effectiveExclusions(this.record.saved);
        this.configure();
        await this.restrictTraffic(target, [target]);
        await this.safety.setExclusionGuard?.(null);
        this.error = false;
      } catch (error) {
        this.error = true;
        throw error;
      }
      return;
    }
    if (
      !this.storage ||
      !this.proxy.updateExistingExclusions ||
      !this.proxy.configureExclusions ||
      !this.safety.configureExclusions ||
      !this.safety.setExclusionGuard
    )
      throw new SafetyError("traffic_guard_failed");
    const journal = structuredClone(this.record);
    const previous = effectiveExclusions(journal.applied);
    const target = effectiveExclusions(journal.saved);
    const intersection = intersectExclusions(previous, target);
    try {
      // Reconfirm durability after an uncertain first write, including explicit retry.
      await this.storage.write(this.record);
      this.configure();
      await this.restrictTraffic(intersection, [previous, target]);
      // Verify target rules below the separate, persistent intersection guard.
      // Keep the proxy's direct routes at the intersection too: raw ICE traffic
      // is not intercepted by DNR, even while its universal guard is active.
      this.safety.configureExclusions(target);
      await this.safety.block(true);
      const committed: SiteExclusionRecord = {
        version: 1,
        saved: this.record.saved,
        applied: this.record.saved,
        pending: false,
      };
      await this.storage.write(committed);
      // New-only direct routes are authorized only after the preference commit.
      // If this step is interrupted, either durable journal can resume safely.
      this.proxy.configureExclusions(target);
      await this.proxy.updateExistingExclusions(intersection, target);
      await this.proxy.ensureBlockingConfiguration();
      if (!(await this.proxy.isGuardedConfiguration()))
        throw new SafetyError("traffic_guard_failed");
      await this.safety.setExclusionGuard(null);
      this.record = committed;
      this.error = false;
      this.configure();
    } catch (error) {
      this.record = journal;
      this.error = true;
      this.configure();
      await this.restrictTraffic(intersection, [previous, target]).catch(() => undefined);
      // If removal of the guard was uncertain after committing, restore the
      // durable pending journal. Either record can safely resume after restart.
      await this.storage.write(journal).catch(() => undefined);
      throw error;
    }
  }

  async retainGuard(): Promise<void> {
    this.error = true;
    this.configure();
    const previous = effectiveExclusions(this.record.applied);
    const target = effectiveExclusions(this.record.saved);
    await this.restrictTraffic(this.unreadable ? [] : intersectExclusions(previous, target), [
      previous,
      target,
    ]);
  }

  /** Explicit disconnect calls this after clearing our proxy; never apply a failed target. */
  async rollback(): Promise<void> {
    if (this.unreadable) {
      try {
        await this.initialize();
      } catch (error) {
        if (!(error instanceof InvalidSiteExclusionStorageError)) throw error;
        await this.recoverCorruptRecord();
      }
    }
    if (!this.record.pending) {
      await this.safety.setExclusionGuard?.(null);
      this.error = false;
      return;
    }
    if (!this.storage || !this.safety.configureExclusions || !this.safety.setExclusionGuard)
      throw new SafetyError("traffic_guard_failed");
    const previous: SiteExclusionPolicy = {
      ...structuredClone(this.record.applied),
      // Preserve monotonic revisions when canceling a staged change.
      revision: this.record.saved.revision,
    };
    try {
      // A poisoned target may never compile. Use an empty temporary policy and
      // a universal guard while the last committed preference is restored.
      const applied = effectiveExclusions(this.record.applied);
      const target = effectiveExclusions(this.record.saved);
      this.safety.configureExclusions([]);
      await this.restrictTraffic([], [applied, target, intersectExclusions(applied, target)]);
      const restored: SiteExclusionRecord = {
        version: 1,
        saved: previous,
        applied: previous,
        pending: false,
        ...(this.record.recoveryNotice ? { recoveryNotice: this.record.recoveryNotice } : {}),
      };
      await this.storage.write(restored);
      this.record = restored;
      this.configure();
      await this.safety.setExclusionGuard(null);
      this.error = false;
    } catch (error) {
      // Keep the universal guard if durability or removal is uncertain. A
      // successful restored journal is retained so a later disconnect can finish.
      this.error = true;
      this.configure();
      throw error;
    }
  }

  private async recoverCorruptRecord(): Promise<void> {
    if (
      !this.storage?.recoverForDisconnect ||
      !this.safety.configureExclusions ||
      !this.safety.setExclusionGuard
    ) {
      throw new SafetyError("traffic_guard_failed");
    }
    // Only rollback reaches this path, after the parent has verified proxy.clear().
    // Keep a universal guard until the replacement and its diagnosis are durable.
    this.safety.configureExclusions([]);
    await this.restrictTraffic([], []);
    this.record = await this.storage.recoverForDisconnect();
    this.unreadable = false;
    this.configure();
  }

  private configure(): void {
    const previous = effectiveExclusions(this.record.applied);
    const target = effectiveExclusions(this.record.saved);
    const allowed = this.unreadable
      ? []
      : this.record.pending
        ? intersectExclusions(previous, target)
        : target;
    this.proxy.configureExclusions?.(allowed);
    this.safety.configureExclusions?.(allowed);
  }

  /** Confine both browser requests and raw ICE before exposing a pending policy. */
  private async restrictTraffic(
    allowed: SiteExclusion[],
    accepted: SiteExclusion[][],
  ): Promise<void> {
    if (
      !this.proxy.configureExclusions ||
      !this.proxy.updateExistingExclusions ||
      !this.safety.setExclusionGuard
    )
      throw new SafetyError("traffic_guard_failed");
    const updateExistingExclusions = this.proxy.updateExistingExclusions.bind(this.proxy);
    const setExclusionGuard = this.safety.setExclusionGuard.bind(this.safety);
    let failure: Error | undefined;
    const attempt = async (operation: () => Promise<void>) => {
      try {
        await operation();
      } catch (error) {
        failure ??= error instanceof Error ? error : new SafetyError("traffic_guard_failed");
      }
    };
    // Attempt each independent mechanism even if another one is unavailable.
    // The fallback route must still be installed when a DNR write is rejected.
    await attempt(() => this.safety.setWebRtc(true));
    await attempt(() => this.safety.suspend());
    this.proxy.configureExclusions(allowed);
    await attempt(async () => {
      // Explicit disconnect already cleared our proxy. Do not feed a poisoned
      // target back through a routing compiler when no owned route remains.
      if ((await this.proxy.getControlLevel()) === "controllable_by_this_extension") return;
      const candidates = [
        ...new Map(
          [...accepted, allowed].map((entries) => [JSON.stringify(entries), entries]),
        ).values(),
      ];
      for (const [index, candidate] of candidates.entries()) {
        try {
          await updateExistingExclusions(candidate, allowed);
          return;
        } catch (error) {
          // Restart can observe the old route, an already restricted route, or
          // a target written just before an uncertain post-commit operation.
          if (
            !(error instanceof ProxyControlError) ||
            error.level !== "configuration_rejected" ||
            index === candidates.length - 1
          )
            throw error;
        }
      }
    });
    await attempt(() => setExclusionGuard(allowed));
    await attempt(async () => {
      if (this.armGuard) await this.armGuard(allowed);
      else {
        await this.proxy.ensureBlockingConfiguration();
        await this.safety.block(true);
      }
    });
    if (!(await this.proxy.isGuardedConfiguration().catch(() => false)))
      failure ??= new SafetyError("traffic_guard_failed");
    if (failure !== undefined) throw failure;
  }
}
