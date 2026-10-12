// SPDX-License-Identifier: MPL-2.0

import {
  isDiagnosticId,
  parseDiagnosticReport,
  serializeDiagnosticReport,
  type DiagnosticReport,
} from "../shared/diagnostic-report";
import type {
  DiagnosticDeliveryStatus,
  DiagnosticReceipt,
  DiagnosticReportSummary,
  DiagnosticUiError,
} from "../shared/diagnostics-ui";
import { canSendDiagnostics } from "../shared/data-consent";

export const DIAGNOSTIC_DELIVERY_STORAGE_KEY = "fuzevpnDiagnosticDelivery";
const ENDPOINT = "https://api.fuzevpn.com/v1/diagnostics";
const HOUR = 60 * 60_000;
const TTL = 24 * HOUR;
const MAX_REPORTS = 20;
const MAX_STORAGE_BYTES = 1024 * 1024;
const TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 16 * 1024;
const SCHEDULE_RETRY_MS = 60_000;
const DELAYS = [0, 60_000, 5 * 60_000, 30 * 60_000, 2 * HOUR];

export interface DiagnosticAccount {
  ownerId: string;
  token: string;
  expiresAt: number;
  generation: number;
}

interface DeliveryOptions {
  read(): Promise<unknown>;
  write(value: unknown): Promise<void>;
  getAccount(): DiagnosticAccount | null;
  now(): number;
  random?(): number;
  fetch?: typeof fetch;
  onChanged(): void;
  schedule(when: number | null): Promise<void>;
  canSendDiagnostics?(): Promise<boolean>;
}

interface AccountSettings {
  ownerId: string;
  automatic: boolean;
  sessionRequired: boolean;
  attempts: number[];
  automaticReports: number[];
}

interface Entry {
  ownerId: string;
  id: string;
  body: string;
  queuedAt: number;
  expiresAt: number;
  status: DiagnosticDeliveryStatus;
  attempts: number;
  nextAttemptAt: number | null;
  error?: DiagnosticUiError;
  receipt?: DiagnosticReceipt;
}

interface StoredDelivery {
  version: 1;
  accounts: AccountSettings[];
  reports: Entry[];
}

interface ActiveDelivery {
  key: string;
  account: DiagnosticAccount;
  abort: AbortController;
  generation: number;
  permissionRevision: number;
  attempted: boolean;
  attemptAt: number;
}

type Outcome =
  | { kind: "received"; receipt: DiagnosticReceipt }
  | { kind: "session" }
  | { kind: "stop"; error: DiagnosticUiError }
  | { kind: "retry"; notBefore?: number };

export class DiagnosticDeliveryError extends Error {
  constructor(readonly code: DiagnosticUiError) {
    super(code);
    this.name = "DiagnosticDeliveryError";
  }
}

/** Consent and immutable delivery records are independent of the VPN state machine.
 * The injected account is used only in memory; neither tokens nor raw errors are stored. */
export class DiagnosticDelivery {
  private state: StoredDelivery = { version: 1, accounts: [], reports: [] };
  private initialization: Promise<void> | null = null;
  private changes: Promise<void> = Promise.resolve();
  private scheduling: Promise<void> = Promise.resolve();
  private scheduleRetry: ReturnType<typeof setTimeout> | undefined;
  private pumping: Promise<void> | null = null;
  private wakeRequested = false;
  private account: DiagnosticAccount | null = null;
  private generation = 0;
  private active: ActiveDelivery | null = null;
  private nativeConsentGranted = false;
  private permissionRevision = 0;
  private readonly cancelled = new Set<string>();
  private readonly automaticDisabled = new Set<string>();
  private readonly observedAccounts = new Map<string, DiagnosticAccount>();
  private readonly rejectedTokens = new Map<string, Set<string>>();
  private readonly resumeAccounts = new Set<string>();
  private readonly waitingAccounts = new Set<string>();
  private readonly fetcher: typeof fetch;

  constructor(private readonly options: DeliveryOptions) {
    this.fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  initialize(): Promise<void> {
    if (!this.initialization) {
      const pending = (async () => {
        let stored: unknown;
        try {
          stored = await this.options.read();
          this.state = decodeStored(stored);
          for (const account of this.state.accounts) {
            if (account.sessionRequired) this.waitingAccounts.add(account.ownerId);
          }
          for (const entry of this.state.reports) {
            if (entry.status === "session_required") this.waitingAccounts.add(entry.ownerId);
          }
        } catch {
          throw new DiagnosticDeliveryError("storage_unavailable");
        }
        // An interrupted request may already have reached the server. Keep its
        // body and attempt count; only an idempotent retry can establish receipt.
        await this.recoverInterrupted();
        this.notify();
        await this.reschedule();
      })();
      this.initialization = pending;
      void pending.catch(() => {
        if (this.initialization === pending) this.initialization = null;
      });
    }
    return this.initialization;
  }

  syncAccount(): void {
    const next = this.currentAccount();
    if (sameAccount(this.account, next)) return;
    this.account = next;
    this.generation++;
    this.active?.abort.abort();
    if (next) {
      const previous = this.observedAccounts.get(next.ownerId);
      this.observedAccounts.set(next.ownerId, { ...next });
      if (this.rejectedTokens.get(next.ownerId)?.has(next.token)) {
        this.waitingAccounts.add(next.ownerId);
        this.resumeAccounts.delete(next.ownerId);
      } else if (
        previous &&
        (previous.token !== next.token || previous.generation !== next.generation)
      )
        this.resumeAccounts.add(next.ownerId);
    }
    this.notify();
    this.kick();
  }

  /** Invalidate synchronously: a permission event must abort a live upload before any await. */
  permissionsRemoved(): void {
    this.permissionRevision++;
    this.nativeConsentGranted = false;
    this.active?.abort.abort();
    this.notify();
    void this.reschedule().catch(() => undefined);
  }

  permissionsChanged(): void {
    this.permissionRevision++;
    this.nativeConsentGranted = false;
    this.kick();
  }

  getAuto(ownerId: string): boolean {
    return (
      !this.automaticDisabled.has(ownerId) &&
      this.state.accounts.some((account) => account.ownerId === ownerId && account.automatic)
    );
  }

  async setAuto(ownerId: string, enabled: boolean): Promise<void> {
    if (!enabled) {
      this.automaticDisabled.add(ownerId);
      for (const entry of this.state.reports) {
        if (entry.ownerId === ownerId && isQueued(entry) && isAutomatic(entry))
          this.invalidate(entryKey(entry));
      }
    }
    await this.initialize();
    this.requireOwner(ownerId);
    if (enabled) await this.requireNativeConsent();
    await this.change(async (next) => {
      this.requireOwner(ownerId);
      if (enabled) await this.requireNativeConsent();
      this.requireOwner(ownerId);
      settings(next, ownerId).automatic = enabled;
      if (!enabled)
        next.reports = next.reports.filter(
          (entry) => !(entry.ownerId === ownerId && isQueued(entry) && isAutomatic(entry)),
        );
    });
    if (enabled) this.automaticDisabled.delete(ownerId);
    await this.reschedule();
    this.kick();
  }

  async enqueue(report: DiagnosticReport, ownerId: string): Promise<void> {
    let body: string;
    try {
      body = serializeDiagnosticReport(report);
    } catch {
      throw new DiagnosticDeliveryError("invalid_report");
    }
    const prepared = parseDiagnosticReport(body);
    await this.initialize();
    this.requireOwner(ownerId);
    await this.requireNativeConsent();
    await this.change(async (next) => {
      this.requireOwner(ownerId);
      await this.requireNativeConsent();
      this.requireOwner(ownerId);
      const existing = next.reports.find(
        (entry) => entry.ownerId === ownerId && entry.id === prepared.report_id,
      );
      if (existing) {
        if (existing.body !== body) throw new DiagnosticDeliveryError("invalid_report");
        return;
      }
      if (this.cancelled.has(key(ownerId, prepared.report_id)))
        throw new DiagnosticDeliveryError("not_found");
      const automatic = prepared.consent.mode === "automatic_opt_in";
      const account = settings(next, ownerId);
      if (automatic && (!account.automatic || this.automaticDisabled.has(ownerId)))
        throw new DiagnosticDeliveryError("consent_required");
      if (automatic && account.automaticReports.length >= 5)
        throw new DiagnosticDeliveryError("queue_full");
      if (next.reports.length >= MAX_REPORTS) throw new DiagnosticDeliveryError("queue_full");
      const now = this.options.now();
      next.reports.push({
        ownerId,
        id: prepared.report_id,
        body,
        queuedAt: now,
        expiresAt: now + TTL,
        status: "pending",
        attempts: 0,
        nextAttemptAt: now,
      });
      if (automatic) account.automaticReports.push(now);
    });
    // Once committed, enqueue has succeeded. Dispatch does not depend on the alarm API.
    this.kick();
    await this.reschedule();
  }

  list(ownerId: string): DiagnosticReportSummary[] {
    return this.state.reports
      .filter((entry) => entry.ownerId === ownerId && entry.expiresAt > this.options.now())
      .map((entry) => {
        const report = parseDiagnosticReport(entry.body);
        const status = this.cancelled.has(entryKey(entry))
          ? "cancelled"
          : entry.status === "pending" &&
              (this.currentAccount()?.ownerId !== ownerId || this.waitingAccounts.has(ownerId))
            ? "session_required"
            : entry.status;
        return {
          id: entry.id,
          type: report.report_type,
          createdAt: report.created_at,
          status,
          attempts: entry.attempts,
          nextAttemptAt:
            status === "pending" && this.nativeConsentGranted ? entry.nextAttemptAt : null,
          canSend: false,
          ...(status === "pending" && !this.nativeConsentGranted
            ? { error: "data_collection_required" as const }
            : entry.error
              ? { error: entry.error }
              : {}),
          ...(status === "received" && entry.receipt ? { receipt: { ...entry.receipt } } : {}),
        };
      });
  }

  getReport(id: string, ownerId: string): DiagnosticReport | null {
    const entry = this.state.reports.find(
      (value) =>
        value.id === id && value.ownerId === ownerId && value.expiresAt > this.options.now(),
    );
    return entry ? parseDiagnosticReport(entry.body) : null;
  }

  async cancel(id: string, ownerId: string): Promise<void> {
    this.invalidate(key(ownerId, id));
    await this.initialize();
    await this.change((next) => {
      const entry = next.reports.find((value) => value.id === id && value.ownerId === ownerId);
      if (!entry) throw new DiagnosticDeliveryError("not_found");
      if (entry.status === "received") return;
      entry.status = "cancelled";
      entry.nextAttemptAt = null;
      delete entry.error;
    });
    if (
      this.state.reports.some(
        (entry) => entry.id === id && entry.ownerId === ownerId && entry.status === "received",
      )
    ) {
      this.cancelled.delete(key(ownerId, id));
      this.notify();
    }
    await this.reschedule();
  }

  async remove(id: string, ownerId: string): Promise<void> {
    this.invalidate(key(ownerId, id));
    await this.initialize();
    await this.change((next) => {
      next.reports = next.reports.filter((entry) => entry.id !== id || entry.ownerId !== ownerId);
    });
    await this.reschedule();
  }

  pump(): Promise<void> {
    if (this.pumping) {
      this.wakeRequested = true;
      return this.pumping;
    }
    let completed = false;
    const pending = (async () => {
      try {
        await this.initialize();
        await this.recoverInterrupted();
        do {
          this.wakeRequested = false;
          this.syncAccount();
          await this.resumeWaiting();
          for (;;) {
            const claimed = await this.claim();
            if (!claimed) break;
            await this.deliver(claimed.entry, claimed.active);
          }
        } while (this.needsAnotherPass());
        await this.reschedule();
        completed = true;
      } catch (error) {
        // A storage failure must not leave an uncertain persisted attempt stuck
        // until the worker restarts, nor spin an immediately due alarm.
        await this.reschedule(true).catch(() => undefined);
        throw error;
      }
    })();
    this.pumping = pending;
    void pending
      .finally(() => {
        if (this.pumping === pending) {
          this.active?.abort.abort();
          this.active = null;
          this.pumping = null;
          // An enqueue can arrive while the last alarm update is awaiting Chrome.
          // Retry that wake only after a successful pass, never spin on storage errors.
          if (completed && this.wakeRequested) this.kick();
        }
      })
      .catch(() => undefined);
    return pending;
  }

  private recoverInterrupted(): Promise<void> {
    return this.change((next) => {
      for (const entry of next.reports) {
        if (entry.status !== "sending") continue;
        if (this.waitingAccounts.has(entry.ownerId)) {
          settings(next, entry.ownerId).sessionRequired = true;
          entry.status = "session_required";
          entry.error = "session_required";
          entry.nextAttemptAt = null;
          continue;
        }
        entry.status = entry.attempts >= DELAYS.length ? "failed" : "pending";
        entry.error = "delivery_failed";
        entry.nextAttemptAt = entry.status === "pending" ? this.retryAt(entry.attempts) : null;
      }
    });
  }

  private async resumeWaiting(): Promise<void> {
    const account = this.account;
    const owner = account?.ownerId;
    if (owner && this.rejectedTokens.get(owner)?.has(account.token)) {
      await this.change((next) => {
        settings(next, owner).sessionRequired = true;
      });
      return;
    }
    if (!owner || !this.resumeAccounts.delete(owner)) return;
    try {
      await this.change((next) => {
        if (!sameAccount(account, this.currentAccount())) return;
        settings(next, owner).sessionRequired = false;
        for (const entry of next.reports) {
          if (entry.ownerId !== owner || entry.status !== "session_required") continue;
          entry.status = entry.attempts >= DELAYS.length ? "failed" : "pending";
          entry.nextAttemptAt = entry.status === "pending" ? this.options.now() : null;
          delete entry.error;
        }
      });
      if (sameAccount(account, this.currentAccount())) this.waitingAccounts.delete(owner);
    } catch (error) {
      this.resumeAccounts.add(owner);
      throw error;
    }
  }

  private async claim(): Promise<{ entry: Entry; active: ActiveDelivery } | null> {
    let claimed: { entry: Entry; active: ActiveDelivery } | null = null;
    await this.change(async (next) => {
      if (!(await this.hasNativeConsent())) return;
      const account = this.currentAccount();
      if (
        !account ||
        !sameAccount(account, this.account) ||
        this.rejectedTokens.get(account.ownerId)?.has(account.token) ||
        this.waitingAccounts.has(account.ownerId)
      )
        return;
      const limits = settings(next, account.ownerId);
      const now = this.options.now();
      const entry = next.reports.find(
        (candidate) =>
          candidate.ownerId === account.ownerId &&
          candidate.status === "pending" &&
          (candidate.nextAttemptAt ?? now) <= now &&
          !this.cancelled.has(entryKey(candidate)) &&
          !(
            isAutomatic(candidate) &&
            (!limits.automatic || this.automaticDisabled.has(account.ownerId))
          ),
      );
      if (!entry) return;
      if (entry.attempts >= DELAYS.length) {
        entry.status = "failed";
        entry.error = "delivery_failed";
        entry.nextAttemptAt = null;
        this.wakeRequested = true;
        return;
      }
      if (limits.attempts.length >= 10) {
        for (const pending of next.reports) {
          if (pending.ownerId === account.ownerId && pending.status === "pending")
            pending.nextAttemptAt = Math.max(
              pending.nextAttemptAt ?? now,
              (limits.attempts[0] ?? now) + HOUR,
            );
        }
        return;
      }
      const active: ActiveDelivery = {
        key: entryKey(entry),
        account: { ...account },
        abort: new AbortController(),
        generation: this.generation,
        permissionRevision: this.permissionRevision,
        attempted: false,
        attemptAt: now,
      };
      this.active = active;
      entry.status = "sending";
      entry.attempts++;
      entry.nextAttemptAt = null;
      delete entry.error;
      limits.attempts.push(now);
      claimed = { entry: { ...entry }, active };
    });
    return claimed;
  }

  private async deliver(entry: Entry, active: ActiveDelivery): Promise<void> {
    let outcome: Outcome = { kind: "retry" };
    try {
      if ((await this.hasNativeConsent()) && this.isCurrent(active)) {
        active.attempted = true;
        outcome = await sendReport(
          this.fetcher,
          entry,
          active.account.token,
          active.abort.signal,
          () => this.options.now(),
        );
      }
    } finally {
      const current = this.isCurrent(active);
      if (outcome.kind === "session" && current) {
        const rejected = this.rejectedTokens.get(entry.ownerId) ?? new Set<string>();
        rejected.add(active.account.token);
        this.rejectedTokens.set(entry.ownerId, rejected);
        this.waitingAccounts.add(entry.ownerId);
        this.resumeAccounts.delete(entry.ownerId);
      }
      await this.change((next) => {
        const saved = next.reports.find((candidate) => entryKey(candidate) === active.key);
        if (saved?.status !== "sending" || this.cancelled.has(active.key)) return;
        if (!active.attempted) {
          // No request left the extension. Permission loss while persisting a
          // claim must not consume an HTTP attempt or the hourly upload quota.
          saved.attempts = Math.max(0, saved.attempts - 1);
          const limits = settings(next, entry.ownerId);
          const reserved = limits.attempts.lastIndexOf(active.attemptAt);
          if (reserved >= 0) limits.attempts.splice(reserved, 1);
          saved.status = "pending";
          saved.nextAttemptAt = this.options.now();
          return;
        }
        if (!current || !this.isCurrent(active)) {
          saved.status = saved.attempts >= DELAYS.length ? "failed" : "pending";
          saved.nextAttemptAt = saved.status === "pending" ? this.retryAt(saved.attempts) : null;
          return;
        }
        if (outcome.kind === "received") {
          saved.status = "received";
          saved.receipt = outcome.receipt;
          saved.nextAttemptAt = null;
          delete saved.error;
        } else if (outcome.kind === "session") {
          settings(next, entry.ownerId).sessionRequired = true;
          saved.status = "session_required";
          saved.nextAttemptAt = null;
          saved.error = "session_required";
        } else if (outcome.kind === "stop" || saved.attempts >= DELAYS.length) {
          saved.status =
            outcome.kind === "stop" && outcome.error === "expired" ? "expired" : "failed";
          saved.nextAttemptAt = null;
          saved.error = outcome.kind === "stop" ? outcome.error : "delivery_failed";
        } else {
          saved.nextAttemptAt = Math.max(this.retryAt(saved.attempts), outcome.notBefore ?? 0);
          saved.status = saved.nextAttemptAt >= saved.expiresAt ? "expired" : "pending";
          saved.error = saved.status === "expired" ? "expired" : "delivery_failed";
          if (saved.status === "expired") saved.nextAttemptAt = null;
        }
      });
      if (this.active === active) this.active = null;
    }
  }

  private retryAt(attempts: number): number {
    const delay = DELAYS[attempts] ?? 2 * HOUR;
    const random = Math.max(0, Math.min(1, this.options.random?.() ?? Math.random()));
    return this.options.now() + delay + Math.floor(delay * 0.2 * random);
  }

  private currentAccount(): DiagnosticAccount | null {
    const account = this.options.getAccount();
    return account &&
      validOwner(account.ownerId) &&
      typeof account.token === "string" &&
      account.token.trim() &&
      Number.isFinite(account.expiresAt) &&
      account.expiresAt > this.options.now() &&
      Number.isSafeInteger(account.generation)
      ? { ...account }
      : null;
  }

  private requireOwner(ownerId: string): void {
    if (!validOwner(ownerId) || this.currentAccount()?.ownerId !== ownerId)
      throw new DiagnosticDeliveryError("session_required");
  }

  private isCurrent(active: ActiveDelivery): boolean {
    return (
      !active.abort.signal.aborted &&
      this.nativeConsentGranted &&
      active.permissionRevision === this.permissionRevision &&
      active.generation === this.generation &&
      !this.cancelled.has(active.key) &&
      sameAccount(active.account, this.currentAccount())
    );
  }

  private async hasNativeConsent(): Promise<boolean> {
    const revision = this.permissionRevision;
    let allowed = false;
    try {
      allowed = await (this.options.canSendDiagnostics?.() ?? canSendDiagnostics());
    } catch {
      // Native permission errors never authorize a diagnostic upload.
    }
    if (revision !== this.permissionRevision) return false;
    const changed = allowed !== this.nativeConsentGranted;
    this.nativeConsentGranted = allowed;
    if (!allowed) this.active?.abort.abort();
    if (changed) this.notify();
    return allowed;
  }

  private async requireNativeConsent(): Promise<void> {
    if (!(await this.hasNativeConsent()))
      throw new DiagnosticDeliveryError("data_collection_required");
  }

  private invalidate(value: string): void {
    this.cancelled.add(value);
    if (this.active?.key === value) this.active.abort.abort();
    this.notify();
  }

  private change(update: (state: StoredDelivery) => void | Promise<void>): Promise<void> {
    const operation = this.changes.then(async () => {
      const next = structuredClone(this.state);
      const now = this.options.now();
      next.reports = next.reports.filter((entry) => entry.expiresAt > now);
      for (const account of next.accounts) {
        account.attempts = account.attempts.filter((at) => at > now - HOUR);
        account.automaticReports = account.automaticReports.filter((at) => at > now - HOUR);
      }
      await update(next);
      // Reserve receipt space so a confirmed upload can always replace pending metadata.
      const receiptReserve = next.reports.filter((entry) => !entry.receipt).length * 512;
      if (byteLength(JSON.stringify(next)) + receiptReserve > MAX_STORAGE_BYTES)
        throw new DiagnosticDeliveryError("queue_full");
      if (JSON.stringify(next) === JSON.stringify(this.state)) return;
      try {
        await this.options.write(next);
      } catch {
        throw new DiagnosticDeliveryError("storage_unavailable");
      }
      this.state = next;
      this.notify();
    });
    this.changes = operation.catch(() => undefined);
    return operation;
  }

  private reschedule(afterFailure = false): Promise<void> {
    // Serialize alarm updates and calculate their deadline when executed, so an older
    // failed update cannot replace a newer successful schedule or its fallback.
    this.scheduling = this.scheduling
      .catch(() => undefined)
      .then(async () => {
        const account = this.currentAccount();
        let when: number | null = null;
        for (const entry of this.state.reports) {
          const deadline =
            entry.status === "pending" &&
            entry.ownerId === account?.ownerId &&
            this.nativeConsentGranted &&
            !this.waitingAccounts.has(entry.ownerId) &&
            !(isAutomatic(entry) && !this.getAuto(entry.ownerId)) &&
            !this.cancelled.has(entryKey(entry))
              ? Math.min(entry.expiresAt, entry.nextAttemptAt ?? this.options.now())
              : entry.expiresAt;
          when = when === null ? deadline : Math.min(when, deadline);
        }
        if (afterFailure && this.state.reports.some(isQueued))
          when = Math.min(
            ...this.state.reports.map((entry) => entry.expiresAt),
            this.options.now() + SCHEDULE_RETRY_MS,
          );
        if (when === null) this.clearScheduleRetry();
        try {
          await this.options.schedule(when);
          this.clearScheduleRetry();
        } catch {
          // Best effort while this worker lives; initialize() restores durable work
          // after suspension. One timer retries scheduling without bypassing claim's
          // deadlines, account/consent checks, attempt limits or retention.
          if (when !== null && this.scheduleRetry === undefined)
            this.scheduleRetry = setTimeout(() => {
              this.scheduleRetry = undefined;
              this.kick();
            }, SCHEDULE_RETRY_MS);
        }
      });
    return this.scheduling;
  }

  private clearScheduleRetry(): void {
    clearTimeout(this.scheduleRetry);
    this.scheduleRetry = undefined;
  }

  private kick(): void {
    void this.pump().catch(() => this.notify());
  }

  private needsAnotherPass(): boolean {
    return this.wakeRequested;
  }

  private notify(): void {
    try {
      this.options.onChanged();
    } catch {
      /* UI observers never control delivery. */
    }
  }
}

function settings(state: StoredDelivery, ownerId: string): AccountSettings {
  let account = state.accounts.find((value) => value.ownerId === ownerId);
  if (!account) {
    account = {
      ownerId,
      automatic: false,
      sessionRequired: false,
      attempts: [],
      automaticReports: [],
    };
    state.accounts.push(account);
  }
  return account;
}

function key(ownerId: string, id: string): string {
  return JSON.stringify([ownerId, id]);
}
function entryKey(entry: Entry): string {
  return key(entry.ownerId, entry.id);
}
function isQueued(entry: Entry): boolean {
  return ["pending", "sending", "session_required"].includes(entry.status);
}
function isAutomatic(entry: Entry): boolean {
  return parseDiagnosticReport(entry.body).consent.mode === "automatic_opt_in";
}
function sameAccount(left: DiagnosticAccount | null, right: DiagnosticAccount | null): boolean {
  return left === null || right === null
    ? left === right
    : left.ownerId === right.ownerId &&
        left.token === right.token &&
        left.generation === right.generation &&
        left.expiresAt === right.expiresAt;
}
function validOwner(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function timestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function decodeStored(value: unknown): StoredDelivery {
  if (value === undefined || value === null) return { version: 1, accounts: [], reports: [] };
  if (
    !object(value) ||
    value.version !== 1 ||
    !Array.isArray(value.accounts) ||
    !Array.isArray(value.reports) ||
    value.reports.length > MAX_REPORTS ||
    byteLength(JSON.stringify(value)) > MAX_STORAGE_BYTES
  )
    throw new Error("invalid_delivery_storage");
  const accounts: AccountSettings[] = [];
  for (const item of value.accounts) {
    if (
      !object(item) ||
      !validOwner(item.ownerId) ||
      typeof item.automatic !== "boolean" ||
      !(item.sessionRequired === undefined || typeof item.sessionRequired === "boolean") ||
      !Array.isArray(item.attempts) ||
      item.attempts.length > 10 ||
      !item.attempts.every(timestamp) ||
      !Array.isArray(item.automaticReports) ||
      item.automaticReports.length > 5 ||
      !item.automaticReports.every(timestamp) ||
      accounts.some((other) => other.ownerId === item.ownerId)
    )
      throw new Error("invalid_delivery_storage");
    accounts.push({
      ownerId: item.ownerId,
      automatic: item.automatic,
      sessionRequired: item.sessionRequired === true,
      attempts: [...item.attempts].sort((a, b) => a - b),
      automaticReports: [...item.automaticReports].sort((a, b) => a - b),
    });
  }
  const reports: Entry[] = [];
  for (const item of value.reports) {
    if (
      !object(item) ||
      !validOwner(item.ownerId) ||
      !isDiagnosticId(item.id) ||
      typeof item.body !== "string" ||
      !timestamp(item.queuedAt) ||
      !timestamp(item.expiresAt) ||
      item.expiresAt !== item.queuedAt + TTL ||
      typeof item.status !== "string" ||
      ![
        "pending",
        "sending",
        "session_required",
        "received",
        "failed",
        "cancelled",
        "expired",
      ].includes(item.status) ||
      !Number.isSafeInteger(item.attempts) ||
      (item.attempts as number) < 0 ||
      (item.attempts as number) > DELAYS.length ||
      !(item.nextAttemptAt === null || timestamp(item.nextAttemptAt)) ||
      reports.some((other) => other.ownerId === item.ownerId && other.id === item.id)
    )
      throw new Error("invalid_delivery_storage");
    const report = parseDiagnosticReport(item.body);
    if (report.report_id !== item.id || serializeDiagnosticReport(report) !== item.body)
      throw new Error("invalid_delivery_storage");
    const receipt = item.status === "received" ? decodeReceipt(item.receipt, item.id) : undefined;
    if (item.status === "received" && !receipt) throw new Error("invalid_delivery_storage");
    const safeErrors: DiagnosticUiError[] = [
      "session_required",
      "delivery_failed",
      "content_unavailable",
      "expired",
    ];
    reports.push({
      ownerId: item.ownerId,
      id: item.id,
      body: item.body,
      queuedAt: item.queuedAt,
      expiresAt: item.expiresAt,
      status: item.status as DiagnosticDeliveryStatus,
      attempts: item.attempts as number,
      nextAttemptAt: item.nextAttemptAt,
      ...(typeof item.error === "string" && safeErrors.includes(item.error as DiagnosticUiError)
        ? { error: item.error as DiagnosticUiError }
        : {}),
      ...(receipt ? { receipt } : {}),
    });
  }
  return { version: 1, accounts, reports };
}

async function sendReport(
  fetcher: typeof fetch,
  entry: Entry,
  token: string,
  signal: AbortSignal,
  now: () => number,
): Promise<Outcome> {
  const abort = new AbortController();
  const cancel = () => abort.abort();
  signal.addEventListener("abort", cancel, { once: true });
  if (signal.aborted) abort.abort();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let rejectCancelled: (() => void) | undefined;
  let observed: Response | undefined;
  const cancelled = new Promise<never>((_, reject) => {
    rejectCancelled = () => reject(new Error("delivery_interrupted"));
    abort.signal.addEventListener("abort", rejectCancelled, { once: true });
    if (abort.signal.aborted) rejectCancelled();
    timer = setTimeout(() => abort.abort(), TIMEOUT_MS);
  });
  try {
    return await Promise.race([
      cancelled,
      (async (): Promise<Outcome> => {
        const response = await fetcher(ENDPOINT, {
          method: "POST",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: entry.body,
          signal: abort.signal,
          credentials: "omit",
          cache: "no-store",
          redirect: "error",
          referrerPolicy: "no-referrer",
        });
        observed = response;
        let payload: unknown = null;
        try {
          payload = await readResponse(response, abort.signal);
        } catch {
          /* HTTP status remains useful. */
        }
        return classifyResponse(response, payload, entry.id, now());
      })(),
    ]);
  } catch {
    return observed ? classifyResponse(observed, null, entry.id, now()) : { kind: "retry" };
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", cancel);
    if (rejectCancelled) abort.signal.removeEventListener("abort", rejectCancelled);
    abort.abort();
  }
}

function classifyResponse(response: Response, payload: unknown, id: string, now: number): Outcome {
  if (response.status === 200 || response.status === 201) {
    const receipt = decodeReceipt(payload, id);
    return receipt?.duplicate === (response.status === 200)
      ? { kind: "received", receipt }
      : { kind: "retry" };
  }
  if (response.status === 401) return { kind: "session" };
  if (response.status === 404) return { kind: "stop", error: "expired" };
  if ([400, 409, 413, 415].includes(response.status))
    return { kind: "stop", error: "delivery_failed" };
  if (
    response.status === 503 &&
    object(payload) &&
    payload.error === "diagnostic_content_unavailable"
  )
    return { kind: "stop", error: "content_unavailable" };
  if (response.status === 429 || response.status >= 500) {
    const notBefore = retryDeadline(response.headers.get("Retry-After"), now);
    return { kind: "retry", ...(notBefore === undefined ? {} : { notBefore }) };
  }
  return { kind: "stop", error: "delivery_failed" };
}

async function readResponse(response: Response, signal: AbortSignal): Promise<unknown> {
  if (!response.body) return null;
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let size = 0;
  let text = "";
  const cancel = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    for (;;) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) throw new Error("response_too_large");
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return text ? (JSON.parse(text) as unknown) : null;
  } finally {
    signal.removeEventListener("abort", cancel);
    cancel();
    reader.releaseLock();
  }
}

function decodeReceipt(value: unknown, id: string): DiagnosticReceipt | undefined {
  if (
    !object(value) ||
    Object.keys(value).some(
      (key) =>
        ![
          "report_id",
          "client_report_id",
          "received_at",
          "expires_at",
          "status",
          "duplicate",
        ].includes(key),
    ) ||
    !isDiagnosticId(value.report_id) ||
    value.report_id === id ||
    value.client_report_id !== id ||
    value.status !== "received" ||
    typeof value.duplicate !== "boolean" ||
    !date(value.received_at) ||
    !date(value.expires_at) ||
    Date.parse(value.expires_at) <= Date.parse(value.received_at)
  )
    return undefined;
  return {
    report_id: value.report_id,
    client_report_id: id,
    received_at: value.received_at,
    expires_at: value.expires_at,
    status: "received",
    duplicate: value.duplicate,
  };
}

function date(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 35) return false;
  const parts =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|[+-](\d{2}):(\d{2}))$/.exec(
      value,
    );
  if (!parts) return false;
  const year = Number(parts[1]);
  const month = Number(parts[2]);
  const day = Number(parts[3]);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return (
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= (days[month - 1] ?? 0) &&
    Number(parts[4]) <= 23 &&
    Number(parts[5]) <= 59 &&
    Number(parts[6]) <= 59 &&
    Number(parts[7] ?? 0) <= 23 &&
    Number(parts[8] ?? 0) <= 59 &&
    Number.isFinite(Date.parse(value))
  );
}

function retryDeadline(header: string | null, now: number): number | undefined {
  const value = header?.trim();
  if (!value) return undefined;
  let deadline: number;
  if (/^\d+$/.test(value)) {
    // Values beyond local retention can never be retried. Saturation also
    // avoids ignoring an otherwise valid, very large server delay.
    deadline = now + Math.min(Number(value) * 1000, TTL);
  } else if (
    /^(?:[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT|[A-Za-z]+, \d{2}-[A-Za-z]{3}-\d{2} \d{2}:\d{2}:\d{2} GMT|[A-Za-z]{3} [A-Za-z]{3} [ \d]\d \d{2}:\d{2}:\d{2} \d{4})$/.test(
      value,
    )
  )
    deadline = Date.parse(value);
  else return undefined;
  return Number.isSafeInteger(deadline) && Number.isFinite(new Date(deadline).getTime())
    ? Math.max(now, deadline)
    : undefined;
}
