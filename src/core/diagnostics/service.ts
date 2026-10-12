// SPDX-License-Identifier: MPL-2.0

import { extensionApi, configureTrustedStorage } from "@platform/bridge";
import type { CommandResult } from "../shared/messages";
import type { Language } from "../shared/language";
import {
  parseDiagnosticReport,
  serializeDiagnosticReport,
  type DiagnosticReport,
  type DiagnosticEnvironment,
  type DiagnosticError,
} from "../shared/diagnostic-report";
import type {
  DiagnosticResponse,
  DiagnosticUiState,
  DiagnosticReportSummary,
} from "../shared/diagnostics-ui";
import { isDiagnosticRequest } from "../shared/diagnostics-ui";
import { DiagnosticDelivery, DiagnosticDeliveryError, type DiagnosticAccount } from "./delivery";
import { DiagnosticHistory } from "./history";
import { canSendDiagnostics } from "../shared/data-consent";
import {
  collectDiagnostic,
  diagnosticError,
  diagnosticEnvironment,
  diagnosticOperation,
  operationStage,
  reportBase,
  type CollectorDependencies,
} from "./collector";

export const DIAGNOSTIC_ALARM = "fuzevpn-diagnostics-delivery";
export const DIAGNOSTIC_HISTORY_ALARM = "fuzevpn-diagnostics-history";
export const DIAGNOSTIC_HISTORY_KEY = "fuzevpnDiagnosticHistory";
export const DIAGNOSTIC_DRAFTS_KEY = "fuzevpnDiagnosticDrafts";
export const DIAGNOSTIC_DELIVERY_KEY = "fuzevpnDiagnosticDelivery";
const TTL = 86_400_000;
interface Draft {
  owner: string | null;
  report: DiagnosticReport;
}
interface Incident {
  owner: string;
  code: string;
  operation: string;
  count: number;
  first: number;
  reported: boolean;
}

interface ServiceDependencies extends CollectorDependencies {
  /** Await only startup work already started by the worker, never initiate account restoration. */
  whenReady?(): Promise<void>;
  getAccount(): DiagnosticAccount | null;
  language(): Language;
  version(): string;
  onChanged(state: DiagnosticUiState): void;
  uuid?(): string;
  environment?(): Promise<DiagnosticEnvironment>;
  canSendDiagnostics?(): Promise<boolean>;
}

/** Keeps diagnostics entirely outside the VPN command/error state machine. */
export class DiagnosticService {
  readonly delivery: DiagnosticDelivery;
  private readonly history: DiagnosticHistory;
  private initialization: Promise<void> | null = null;
  private loaded = false;
  private owner: string | null = null;
  private drafts: Draft[] = [];
  private incidents: Incident[] = [];
  private preparing = false;
  private epoch = 0;
  private revision = 0;
  private readonly workerId = crypto.randomUUID();
  private writes: Promise<void> = Promise.resolve();
  private work: Promise<void> = Promise.resolve();
  private housekeepingUpdates: Promise<void> = Promise.resolve();
  private draftRevision = 0;
  private persistedDraftRevision = 0;

  constructor(private readonly dependencies: ServiceDependencies) {
    this.history = new DiagnosticHistory({
      read: async (): Promise<unknown> =>
        (await extensionApi.storage.session.get(DIAGNOSTIC_HISTORY_KEY))[DIAGNOSTIC_HISTORY_KEY],
      write: async (value) => extensionApi.storage.session.set({ [DIAGNOSTIC_HISTORY_KEY]: value }),
      now: () => dependencies.now(),
    });
    this.delivery = new DiagnosticDelivery({
      read: async (): Promise<unknown> =>
        (await extensionApi.storage.local.get(DIAGNOSTIC_DELIVERY_KEY))[DIAGNOSTIC_DELIVERY_KEY],
      write: async (value) => extensionApi.storage.local.set({ [DIAGNOSTIC_DELIVERY_KEY]: value }),
      getAccount: () => dependencies.getAccount(),
      canSendDiagnostics: () => dependencies.canSendDiagnostics?.() ?? canSendDiagnostics(),
      now: () => dependencies.now(),
      onChanged: () => this.changed(),
      schedule: async (when) => {
        if (when === null) {
          await extensionApi.alarms.clear(DIAGNOSTIC_ALARM);
          return;
        }
        await extensionApi.alarms.create(DIAGNOSTIC_ALARM, {
          when: Math.max(dependencies.now() + 1_000, when),
        });
        if (!(await extensionApi.alarms.get(DIAGNOSTIC_ALARM)))
          throw new Error("diagnostic_alarm_unavailable");
      },
    });
  }

  async initialize(): Promise<void> {
    if (this.loaded) return;
    this.initialization ??= this.load().catch((error: unknown) => {
      this.initialization = null;
      throw error;
    });
    await this.initialization;
  }

  private async load(): Promise<void> {
    await this.dependencies.whenReady?.();
    await configureTrustedStorage();
    // Firefox does not expose setAccessLevel. Session storage is trusted-only;
    // the manifest and package audit prohibit content scripts and injection.
    this.owner = this.currentOwner();
    let historyEpoch = this.epoch;
    try {
      await this.history.initialize(this.owner);
      const stored: unknown = (await extensionApi.storage.session.get(DIAGNOSTIC_DRAFTS_KEY))[
        DIAGNOSTIC_DRAFTS_KEY
      ];
      if (stored && typeof stored === "object") {
        const data = stored as { drafts?: unknown; incidents?: unknown };
        if (Array.isArray(data.drafts))
          for (const value of data.drafts.slice(-20)) {
            try {
              if (!value || typeof value !== "object") continue;
              const item = value as Draft;
              if (
                item.owner !== null &&
                (typeof item.owner !== "string" || item.owner.length > 256)
              )
                continue;
              const report = parseDiagnosticReport(item.report);
              if (
                report.report_type === "full" &&
                this.isFresh(report) &&
                this.drafts.length < 20 &&
                !this.drafts.some(
                  (draft) =>
                    draft.owner === item.owner && draft.report.report_id === report.report_id,
                ) &&
                new TextEncoder().encode(
                  JSON.stringify([...this.drafts, { owner: item.owner, report }]),
                ).length <= 1_048_576
              )
                this.drafts.push({ owner: item.owner, report });
            } catch {
              /* Invalid diagnostic drafts never affect the account. */
            }
          }
        if (Array.isArray(data.incidents))
          for (const value of data.incidents.slice(-100)) {
            if (!value || typeof value !== "object") continue;
            const item = value as Incident;
            if (
              historyEpoch !== this.epoch ||
              item.owner !== this.owner ||
              typeof item.owner !== "string" ||
              typeof item.code !== "string" ||
              typeof item.operation !== "string" ||
              !Number.isSafeInteger(item.count) ||
              item.count < 1 ||
              !Number.isFinite(item.first) ||
              typeof item.reported !== "boolean" ||
              item.first > this.dependencies.now() ||
              item.first < this.dependencies.now() - 600_000
            )
              continue;
            const safe = diagnosticError(item.code, item.operation as DiagnosticError["operation"]);
            if (
              safe.code !== item.code ||
              ![
                "unknown",
                "startup",
                "authenticate",
                "register",
                "connect",
                "disconnect",
                "refresh",
                "probe",
                "restore",
                "renew",
                "update",
                "repair",
              ].includes(item.operation)
            )
              continue;
            if (
              this.incidents.some(
                (incident) =>
                  incident.owner === item.owner &&
                  incident.code === item.code &&
                  incident.operation === item.operation,
              )
            )
              continue;
            this.incidents.push({
              owner: item.owner,
              code: safe.code,
              operation: item.operation,
              count: Math.min(item.count, 1_000_000),
              first: item.first,
              reported: item.reported,
            });
          }
      }
      // Rewrite the accepted drafts as well: an overdue alarm may have been
      // missed while this worker was suspended, so filtering memory is not enough.
      await this.persist();
      await this.delivery.initialize();
    } finally {
      // This also runs when delivery storage fails: local export must never use the
      // history of an account that changed while initialization was awaiting storage.
      while (historyEpoch !== this.epoch || this.owner !== this.currentOwner()) {
        this.syncAccount();
        historyEpoch = this.epoch;
        this.incidents = [];
        await this.history.clear(this.owner);
      }
      await this.scheduleHousekeeping();
    }
    this.loaded = true;
    this.syncAccount();
    this.changed();
    void this.delivery.pump().catch(() => undefined);
  }

  /** Called synchronously at account boundaries, before any network/storage await. */
  syncAccount(force = false): void {
    const owner = this.currentOwner();
    if (force || owner !== this.owner) {
      this.owner = owner;
      this.epoch += 1;
      this.incidents = [];
      if (this.loaded) {
        void this.history
          .clear(owner)
          .finally(() => this.scheduleHousekeeping())
          .catch(() => undefined);
        void this.persist().catch(() => undefined);
      }
    }
    this.delivery.syncAccount();
    if (this.loaded) this.changed();
  }

  permissionsRemoved(): void {
    this.delivery.permissionsRemoved();
  }

  permissionsChanged(): void {
    this.delivery.permissionsChanged();
  }

  state(): DiagnosticUiState {
    this.pruneDrafts();
    const account = this.dependencies.getAccount();
    const queued = this.owner === null ? [] : this.delivery.list(this.owner);
    const queuedIds = new Set(queued.map((report) => report.id));
    const drafts: DiagnosticReportSummary[] = this.drafts
      .filter((item) => item.owner === this.owner && !queuedIds.has(item.report.report_id))
      .map((item) => ({
        id: item.report.report_id,
        type: "full",
        createdAt: item.report.created_at,
        status: "ready",
        attempts: 0,
        nextAttemptAt: null,
        canSend: this.loaded && account !== null && item.owner === account.ownerId,
      }));
    return {
      version: 1,
      workerId: this.workerId,
      revision: this.revision,
      accountEpoch: this.epoch,
      language: this.dependencies.language(),
      signedIn: account !== null,
      autoReporting: account !== null && this.delivery.getAuto(account.ownerId),
      preparing: this.preparing,
      historyCount: this.history.snapshot().events.length,
      reports: [...drafts, ...queued].sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    };
  }

  async handle(request: unknown): Promise<DiagnosticResponse> {
    try {
      if (!isDiagnosticRequest(request)) throw new DiagnosticDeliveryError("invalid_report");
      await this.initialize().catch(() => {
        if (!["diagnostics_state", "diagnostics_run", "diagnostics_report"].includes(request.type))
          throw new DiagnosticDeliveryError("storage_unavailable");
      });
      this.syncAccount();
      let report: DiagnosticReport | undefined;
      let reportId: string | undefined;
      switch (request.type) {
        case "diagnostics_state":
          break;
        case "diagnostics_set_auto": {
          const account = this.requireAccount();
          await this.delivery.setAuto(account.ownerId, request.enabled);
          break;
        }
        case "diagnostics_run":
          reportId = await this.run();
          break;
        case "diagnostics_report":
          report = this.findReport(request.reportId);
          break;
        case "diagnostics_send": {
          const account = this.requireAccount();
          report = this.findReport(request.reportId);
          const draft = this.drafts.find((item) => item.report.report_id === request.reportId);
          if (draft?.owner !== account.ownerId)
            throw new DiagnosticDeliveryError("session_required");
          await this.delivery.enqueue(report, account.ownerId);
          this.drafts = this.drafts.filter((item) => item !== draft);
          // Delivery is already durable. A failed draft cleanup is retried by
          // housekeeping and must not turn the accepted send into a failure.
          await this.persist().catch(() => undefined);
          break;
        }
        case "diagnostics_cancel":
          if (this.owner === null) throw new DiagnosticDeliveryError("not_found");
          await this.delivery.cancel(request.reportId, this.owner);
          break;
        case "diagnostics_delete": {
          this.drafts = this.drafts.filter(
            (item) => !(item.owner === this.owner && item.report.report_id === request.reportId),
          );
          if (this.owner !== null) await this.delivery.remove(request.reportId, this.owner);
          await this.persist();
          break;
        }
        case "diagnostics_clear_history":
          await this.history.clear(this.owner).finally(() => this.scheduleHousekeeping());
          break;
      }
      this.changed();
      return {
        diagnosticsVersion: 1,
        ok: true,
        state: this.state(),
        ...(report ? { report } : {}),
        ...(reportId ? { reportId } : {}),
      };
    } catch (error) {
      return {
        diagnosticsVersion: 1,
        ok: false,
        state: this.state(),
        error: error instanceof DiagnosticDeliveryError ? error.code : "unavailable",
      };
    }
  }

  async alarm(): Promise<void> {
    await this.initialize();
    this.syncAccount();
    await this.delivery.pump();
  }

  async historyAlarm(): Promise<void> {
    try {
      await this.initialize();
      this.syncAccount();
      await this.history.pruneExpired();
      this.pruneDrafts();
      await this.persist();
      this.changed();
    } finally {
      await this.scheduleHousekeeping();
    }
  }

  /** Never awaited by a business operation. No command arguments enter this path. */
  capture(command: string): (result: CommandResult, elapsed?: number) => void {
    const epoch = this.epoch;
    return (result, elapsed = 0) => {
      if (epoch === this.epoch) this.record(command, result, elapsed);
    };
  }

  record(command: string, result: CommandResult, elapsed = 0): void {
    if (command.startsWith("diagnostics_")) return;
    const operation = diagnosticOperation(command);
    const epoch = this.epoch;
    this.work = this.work
      .catch(() => undefined)
      .then(async () => {
        await this.initialize();
        if (epoch !== this.epoch) return;
        const error = result.commandError ? diagnosticError(result.commandError, operation) : null;
        await this.history
          .record({
            source: "controller",
            stage: error?.stage ?? operationStage(operation),
            event: result.superseded ? "cancelled" : error ? "error" : "end",
            offset_ms: 0,
            ...(error ? { code: error.code } : {}),
            duration_ms: Math.min(604_800_000, Math.max(0, Math.round(elapsed))),
          })
          .finally(() => this.scheduleHousekeeping());
        if (epoch !== this.epoch) return;
        if (result.superseded) return;
        if (error) await this.maybeAutomatic(error);
        else {
          this.incidents = this.incidents.filter((incident) => incident.operation !== operation);
          await this.persist();
        }
        this.changed();
      })
      .catch(() => undefined);
  }

  observeRecovery(): void {
    const snapshot = this.dependencies.read().snapshot;
    if (
      snapshot.status === "connected" &&
      snapshot.protected &&
      snapshot.error === null &&
      this.incidents.length
    ) {
      this.incidents = [];
      void this.persist().catch(() => undefined);
    }
  }

  private async run(): Promise<string> {
    if (this.preparing) throw new DiagnosticDeliveryError("unavailable");
    this.preparing = true;
    const epoch = this.epoch;
    const owner = this.owner;
    this.changed();
    try {
      const base = reportBase(
        this.uuid(),
        this.dependencies.now(),
        this.dependencies.version(),
        this.dependencies.read().snapshot.status,
        "full",
        await this.environment(),
      );
      const report = await collectDiagnostic(this.dependencies, base, this.history.snapshot());
      if (epoch !== this.epoch || owner !== this.currentOwner())
        throw new DiagnosticDeliveryError("session_required");
      this.pruneDrafts();
      serializeDiagnosticReport(report);
      if (
        this.drafts.length >= 20 ||
        new TextEncoder().encode(JSON.stringify([...this.drafts, { owner, report }])).length >
          1_048_576
      )
        throw new DiagnosticDeliveryError("queue_full");
      this.drafts.push({ owner, report });
      // A storage failure still leaves a sanitized in-memory report available to export.
      await this.persist().catch(() => undefined);
      return report.report_id;
    } finally {
      this.preparing = false;
      this.changed();
    }
  }

  private async maybeAutomatic(error: DiagnosticError): Promise<void> {
    const epoch = this.epoch;
    const account = this.dependencies.getAccount();
    if (!account || !this.delivery.getAuto(account.ownerId)) return;
    if (!(await this.nativeConsentGranted())) return;
    const terminal = [
      "storage_unavailable",
      "traffic_guard_failed",
      "webrtc_control_unavailable",
      "invalid_response",
      "proxy_creation_uncertain",
      "proxy_authentication_failed",
      "proxy_certificate_invalid",
      "unknown_error",
    ].includes(error.code);
    const repeated = ["network_error", "request_timeout", "proxy_unavailable"].includes(error.code);
    if (!terminal && !repeated) return;
    const now = this.dependencies.now();
    this.incidents = this.incidents.filter(
      (item) => item.owner === account.ownerId && item.first >= now - 600_000,
    );
    let incident = this.incidents.find(
      (item) => item.code === error.code && item.operation === error.operation,
    );
    if (!incident) {
      incident = {
        owner: account.ownerId,
        code: error.code,
        operation: error.operation,
        first: now,
        count: 0,
        reported: false,
      };
      this.incidents.push(incident);
    }
    incident.count = Math.min(1_000_000, incident.count + 1);
    if (incident.reported || (repeated && incident.count < 3)) {
      await this.persist();
      return;
    }
    const environment = await this.environment();
    if (
      epoch !== this.epoch ||
      this.dependencies.getAccount()?.ownerId !== account.ownerId ||
      !this.delivery.getAuto(account.ownerId) ||
      !(await this.nativeConsentGranted())
    )
      return;
    const report = parseDiagnosticReport({
      ...reportBase(
        this.uuid(),
        now,
        this.dependencies.version(),
        this.dependencies.read().snapshot.status,
        "simple",
        environment,
      ),
      error,
      occurrences: incident.count,
    });
    await this.delivery.enqueue(report, account.ownerId);
    incident.reported = true;
    await this.persist();
  }

  private findReport(id: string): DiagnosticReport {
    const draft = this.drafts.find(
      (item) => item.owner === this.owner && item.report.report_id === id,
    );
    const report =
      draft?.report ?? (this.owner === null ? null : this.delivery.getReport(id, this.owner));
    if (!report) throw new DiagnosticDeliveryError("not_found");
    return parseDiagnosticReport(report);
  }
  private requireAccount(): DiagnosticAccount {
    const account = this.dependencies.getAccount();
    if (!account) throw new DiagnosticDeliveryError("session_required");
    return account;
  }
  private currentOwner(): string | null {
    return (
      this.dependencies.getAccount()?.ownerId ??
      this.dependencies.read().snapshot.profile?.userId ??
      null
    );
  }
  private isFresh(report: DiagnosticReport): boolean {
    const created = Date.parse(report.created_at);
    return created <= this.dependencies.now() && created > this.dependencies.now() - TTL;
  }
  private pruneDrafts(): void {
    const fresh = this.drafts.filter((item) => this.isFresh(item.report));
    if (fresh.length === this.drafts.length) return;
    this.drafts = fresh;
    void this.persist().catch(() => undefined);
  }
  private uuid(): string {
    return this.dependencies.uuid?.() ?? crypto.randomUUID();
  }
  private environment(): Promise<DiagnosticEnvironment> {
    return this.dependencies.environment?.() ?? diagnosticEnvironment();
  }
  private async nativeConsentGranted(): Promise<boolean> {
    try {
      return await (this.dependencies.canSendDiagnostics?.() ?? canSendDiagnostics());
    } catch {
      return false;
    }
  }
  private persist(): Promise<void> {
    this.draftRevision++;
    this.writes = this.writes
      .catch(() => undefined)
      .then(async () => {
        const revision = this.draftRevision;
        try {
          await extensionApi.storage.session.set({
            [DIAGNOSTIC_DRAFTS_KEY]: {
              drafts: structuredClone(this.drafts),
              incidents: structuredClone(this.incidents),
            },
          });
          this.persistedDraftRevision = revision;
        } finally {
          await this.scheduleHousekeeping();
        }
      });
    return this.writes;
  }

  private scheduleHousekeeping(): Promise<void> {
    this.housekeepingUpdates = this.housekeepingUpdates
      .catch(() => undefined)
      .then(async () => {
        const historyExpiry = this.history.nextExpiry();
        const deadlines = this.drafts.map((draft) => Date.parse(draft.report.created_at) + TTL);
        if (historyExpiry !== null) deadlines.push(historyExpiry);
        if (this.draftRevision !== this.persistedDraftRevision)
          deadlines.push(this.dependencies.now() + 60_000);
        if (!deadlines.length) {
          await extensionApi.alarms.clear(DIAGNOSTIC_HISTORY_ALARM);
          return;
        }
        await extensionApi.alarms.create(DIAGNOSTIC_HISTORY_ALARM, {
          when: Math.max(this.dependencies.now() + 1_000, Math.min(...deadlines)),
        });
        if (!(await extensionApi.alarms.get(DIAGNOSTIC_HISTORY_ALARM)))
          throw new Error("diagnostic_history_alarm_unavailable");
      });
    return this.housekeepingUpdates;
  }
  private changed(): void {
    this.revision += 1;
    if (!this.loaded) return;
    try {
      this.dependencies.onChanged(this.state());
    } catch {
      /* UI is optional. */
    }
  }
}
