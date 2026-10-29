// SPDX-License-Identifier: MPL-2.0

import { extensionApi } from "@platform/bridge";
import type {
  DiagnosticRequest,
  DiagnosticResponse,
  DiagnosticUiError,
  DiagnosticUiState,
  DiagnosticWorkerRequest,
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
    (value.connectionHistoryCount !== undefined && !integer(value.connectionHistoryCount, 200)) ||
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
  private currentError: DiagnosticUiError | null = null;
  private errorGeneration = 0;
  private readonly retiredWorkers = new Set<string>();
  private accountBoundary = 0;
  private actionGeneration = 0;

  constructor(
    private readonly changed: () => void,
    private readonly send: (request: DiagnosticWorkerRequest) => Promise<unknown> = (request) =>
      extensionApi.runtime.sendMessage(request),
    private readonly timeoutMs = 15_000,
  ) {}

  get error(): DiagnosticUiError | null {
    return this.currentError;
  }

  set error(value: DiagnosticUiError | null) {
    this.currentError = value;
    this.errorGeneration += 1;
  }

  receive(message: unknown): void {
    if (!record(message) || message.type !== "diagnostics_changed") return;
    if (isDiagnosticUiState(message.state) && this.accept(message.state)) {
      if (this.error === "unavailable") {
        // Proof of liveness clears a transport error without superseding a pending action.
        this.currentError = null;
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
    if (
      this.state?.workerId !== next.workerId ||
      this.state.signedIn !== next.signedIn ||
      this.state.accountEpoch !== next.accountEpoch
    ) {
      this.accountBoundary += 1;
      if (this.state) this.error = null;
    }
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
    const generation = ++this.actionGeneration;
    const errorGeneration = this.errorGeneration;
    const context = this.state;
    const boundary = this.accountBoundary;
    if (!this.available || !context?.signedIn) return null;
    const bound = this.bindConsentContext(request, context);
    if (!bound) return null;
    // Invoked synchronously in the user gesture; no prior permission lookup or await.
    const granted = await requestConsent();
    if (!this.consentContextCurrent(context, boundary) || !contextUnchanged()) return null;
    if (!granted) {
      if (generation === this.actionGeneration && errorGeneration === this.errorGeneration) {
        this.error = "data_collection_required";
        this.changed();
      }
      return null;
    }
    return this.transmit(bound, generation, errorGeneration);
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
    const generation = ++this.actionGeneration;
    const errorGeneration = this.errorGeneration;
    const bound = this.bindConsentContext(request, this.state);
    return bound ? this.transmit(bound, generation, errorGeneration) : null;
  }

  private bindConsentContext(
    request: DiagnosticRequest,
    context: DiagnosticUiState | null,
  ): DiagnosticWorkerRequest | null {
    if (request.type !== "diagnostics_set_auto" && request.type !== "diagnostics_send")
      return request;
    if (!this.available || !context?.signedIn || context.accountEpoch === undefined) {
      this.error = "session_required";
      this.changed();
      return null;
    }
    return { ...request, workerId: context.workerId, accountEpoch: context.accountEpoch };
  }

  private async transmit(
    request: DiagnosticWorkerRequest,
    generation: number,
    errorGeneration: number,
  ): Promise<DiagnosticResponse | null> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const previous = this.state;
    const boundary = this.accountBoundary;
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
      const next = response.state;
      if (this.retiredWorkers.has(next.workerId)) return null;
      // A reply predating a confirmed worker change cannot establish another unknown worker.
      // Revisions remain comparable for replies from the worker already confirmed.
      if (
        this.state &&
        this.state.workerId !== next.workerId &&
        previous?.workerId !== this.state.workerId
      )
        return null;
      const sameContext = (state: DiagnosticUiState | null) =>
        state !== null &&
        state.workerId === next.workerId &&
        state.accountEpoch === next.accountEpoch &&
        state.signedIn === next.signedIn;
      const currentContext = previous
        ? boundary === this.accountBoundary && sameContext(previous) && sameContext(this.state)
        : !this.state || sameContext(this.state);
      // State freshness and the action owning the error are independent: an older
      // action can still deliver a newer state without replacing a later refusal.
      if (
        generation === this.actionGeneration &&
        errorGeneration === this.errorGeneration &&
        currentContext
      )
        this.error = response.ok
          ? null
          : ((response.error as DiagnosticUiError | undefined) ?? "unavailable");
      this.accept(next);
      this.changed();
      return response as unknown as DiagnosticResponse;
    } catch {
      if (
        generation !== this.actionGeneration ||
        errorGeneration !== this.errorGeneration ||
        boundary !== this.accountBoundary
      )
        return null;
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
