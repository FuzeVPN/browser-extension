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
import type { ProxyService } from "./proxy-controller";
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
      await this.safety.setExclusionGuard?.(null);
      this.error = false;
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
      await this.safety.setExclusionGuard(intersection);
      await this.safety.block(true);
      await this.proxy.updateExistingExclusions(previous, target);
      // Verify target rules below the separate, persistent intersection guard.
      // The latter still blocks old-only/new-only destinations until commit.
      this.safety.configureExclusions(target);
      await this.safety.block(true);
      const committed: SiteExclusionRecord = {
        version: 1,
        saved: this.record.saved,
        applied: this.record.saved,
        pending: false,
      };
      await this.storage.write(committed);
      await this.safety.setExclusionGuard(null);
      this.record = committed;
      this.error = false;
      this.configure();
    } catch (error) {
      this.record = journal;
      this.error = true;
      this.configure();
      await this.safety.setExclusionGuard(intersection).catch(() => undefined);
      await this.safety.block(true).catch(() => undefined);
      // If removal of the guard was uncertain after committing, restore the
      // durable pending journal. Either record can safely resume after restart.
      await this.storage.write(journal).catch(() => undefined);
      throw error;
    }
  }

  async retainGuard(): Promise<void> {
    this.error = true;
    this.configure();
    await this.safety.setExclusionGuard?.(
      this.unreadable
        ? []
        : intersectExclusions(
            effectiveExclusions(this.record.applied),
            effectiveExclusions(this.record.saved),
          ),
    );
    await this.safety.block(true);
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
      this.safety.configureExclusions([]);
      await this.safety.setExclusionGuard([]);
      await this.safety.block(true);
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
    await this.safety.setExclusionGuard([]);
    await this.safety.block(true);
    this.record = await this.storage.recoverForDisconnect();
    this.unreadable = false;
    this.configure();
  }

  private configure(): void {
    const previous = effectiveExclusions(this.record.applied);
    const target = effectiveExclusions(this.record.saved);
    this.proxy.configureExclusions?.(target);
    this.safety.configureExclusions?.(
      this.unreadable ? [] : this.record.pending ? intersectExclusions(previous, target) : target,
    );
  }
}
