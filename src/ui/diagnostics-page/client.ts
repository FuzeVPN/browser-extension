// SPDX-License-Identifier: MPL-2.0

import { extensionApi } from "@platform/bridge";
import type {
  DiagnosticRequest,
  DiagnosticResponse,
  DiagnosticUiError,
  DiagnosticUiState,
} from "../../core/shared/diagnostics-ui";
import { isLanguagePreference } from "../../core/shared/language";

const statuses = new Set([
  "ready",
  "pending",
  "sending",
  "session_required",
  "received",
  "failed",
  "cancelled",
  "expired",
]);
const errors = new Set([
  "unavailable",
  "storage_unavailable",
  "session_required",
  "consent_required",
  "data_collection_required",
  "not_found",
  "queue_full",
  "invalid_report",
  "delivery_failed",
  "content_unavailable",
  "expired",
]);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function integer(value: unknown, maximum = Number.MAX_SAFE_INTEGER): boolean {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= maximum;
}

export function isDiagnosticUiState(value: unknown): value is DiagnosticUiState {
  if (
    !record(value) ||
    value.version !== 1 ||
    typeof value.workerId !== "string" ||
    !value.workerId ||
    value.workerId.length > 200 ||
    !integer(value.revision) ||
    (value.accountEpoch !== undefined && !integer(value.accountEpoch)) ||
    !isLanguagePreference(value.language) ||
    value.language === "auto" ||
    typeof value.signedIn !== "boolean" ||
    typeof value.autoReporting !== "boolean" ||
    typeof value.preparing !== "boolean" ||
    !integer(value.historyCount, 200) ||
    !Array.isArray(value.reports) ||
    value.reports.length > 200
  )
    return false;
  const ids = new Set<string>();
  return value.reports.every((summary: unknown) => {
    if (
      !record(summary) ||
      typeof summary.id !== "string" ||
      !uuid.test(summary.id) ||
      summary.id === "00000000-0000-0000-0000-000000000000" ||
      ids.has(summary.id) ||
      (summary.type !== "simple" && summary.type !== "full") ||
      typeof summary.createdAt !== "string" ||
      !Number.isFinite(Date.parse(summary.createdAt)) ||
      typeof summary.status !== "string" ||
      !statuses.has(summary.status) ||
      !integer(summary.attempts) ||
      typeof summary.canSend !== "boolean" ||
      (summary.nextAttemptAt !== null && !integer(summary.nextAttemptAt)) ||
      (summary.error !== undefined &&
        (typeof summary.error !== "string" || !errors.has(summary.error)))
    )
      return false;
    ids.add(summary.id);
    if (summary.status === "received" && summary.receipt === undefined) return false;
    if (summary.receipt !== undefined) {
      const receipt = summary.receipt;
      if (
        !record(receipt) ||
        receipt.status !== "received" ||
        receipt.client_report_id !== summary.id ||
        typeof receipt.report_id !== "string" ||
        !uuid.test(receipt.report_id) ||
        typeof receipt.received_at !== "string" ||
        !Number.isFinite(Date.parse(receipt.received_at)) ||
        typeof receipt.expires_at !== "string" ||
        !Number.isFinite(Date.parse(receipt.expires_at)) ||
        typeof receipt.duplicate !== "boolean"
      )
        return false;
    }
    return true;
  });
}

/** Isolated from the popup's VPN request/error handling. */
export class DiagnosticConnection {
  state: DiagnosticUiState | null = null;
  available = false;
  error: DiagnosticUiError | null = null;
  private readonly retiredWorkers = new Set<string>();
  private accountBoundary = 0;

  constructor(
    private readonly changed: () => void,
    private readonly send: (request: DiagnosticRequest) => Promise<unknown> = (request) =>
      extensionApi.runtime.sendMessage(request),
    private readonly timeoutMs = 15_000,
  ) {}

  receive(message: unknown): void {
    if (!record(message) || message.type !== "diagnostics_changed") return;
    if (isDiagnosticUiState(message.state) && this.accept(message.state)) {
      if (this.error === "unavailable") {
        this.error = null;
        this.changed();
      }
    }
  }

  private accept(next: DiagnosticUiState): boolean {
    if (this.state?.workerId === next.workerId && next.revision < this.state.revision) return false;
    if (this.state?.workerId !== next.workerId) {
      if (this.retiredWorkers.has(next.workerId)) return false;
      if (this.state) this.retiredWorkers.add(this.state.workerId);
    }
    if (this.state?.workerId !== next.workerId || this.state.signedIn !== next.signedIn)
      this.accountBoundary += 1;
    this.state = structuredClone(next);
    this.available = true;
    this.changed();
    return true;
  }

  async requestWithDataConsent(
    request: DiagnosticRequest,
    requestConsent: () => Promise<boolean>,
    contextUnchanged: () => boolean = () => true,
  ): Promise<DiagnosticResponse | null> {
    const context = this.state;
    const boundary = this.accountBoundary;
    if (!this.available || !context?.signedIn) return null;
    // Invoked synchronously in the user gesture; no prior permission lookup or await.
    const granted = await requestConsent();
    if (!this.consentContextCurrent(context, boundary) || !contextUnchanged()) return null;
    if (!granted) {
      this.error = "data_collection_required";
      this.changed();
      return null;
    }
    return this.request(request);
  }

  private consentContextCurrent(context: DiagnosticUiState, boundary: number): boolean {
    return (
      this.available &&
      this.state?.signedIn === true &&
      this.state.workerId === context.workerId &&
      this.state.accountEpoch === context.accountEpoch &&
      this.accountBoundary === boundary
    );
  }

  async request(request: DiagnosticRequest): Promise<DiagnosticResponse | null> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const previous = this.state;
    try {
      const response: unknown = await Promise.race([
        this.send(request),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("diagnostics_unavailable")), this.timeoutMs);
        }),
      ]);
      if (
        !record(response) ||
        response.diagnosticsVersion !== 1 ||
        typeof response.ok !== "boolean" ||
        !isDiagnosticUiState(response.state) ||
        (response.error !== undefined &&
          (typeof response.error !== "string" || !errors.has(response.error)))
      )
        throw new Error("diagnostics_unavailable");
      if (this.retiredWorkers.has(response.state.workerId)) return null;
      if (
        this.state?.workerId === response.state.workerId &&
        response.state.revision < this.state.revision
      )
        return response as unknown as DiagnosticResponse;
      this.error = response.ok
        ? null
        : ((response.error as DiagnosticUiError | undefined) ?? "unavailable");
      this.accept(response.state);
      this.changed();
      return response as unknown as DiagnosticResponse;
    } catch {
      if (this.state !== previous && this.available) return null;
      this.available = false;
      this.error = "unavailable";
      this.changed();
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
}

export function diagnosticErrorKey(error: DiagnosticUiError): string {
  if (error === "unavailable") return "diagnosticsUnavailable";
  if (error === "session_required") return "diagnosticsAccountRequired";
  if (error === "consent_required") return "diagnosticsConsent";
  if (error === "data_collection_required") return "diagnosticsDataCollectionRequired";
  if (error === "queue_full") return "diagnosticsQueueFull";
  if (["not_found", "content_unavailable", "expired"].includes(error))
    return "diagnosticsContentUnavailable";
  return "diagnosticsFailure";
}
