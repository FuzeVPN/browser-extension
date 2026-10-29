// SPDX-License-Identifier: MPL-2.0

import type { DiagnosticReport } from "./diagnostic-report";
import type { Language } from "./language";

export type DiagnosticDeliveryStatus =
  | "ready"
  | "pending"
  | "sending"
  | "session_required"
  | "received"
  | "failed"
  | "cancelled"
  | "expired";

export type DiagnosticUiError =
  | "unavailable"
  | "storage_unavailable"
  | "session_required"
  | "consent_required"
  | "data_collection_required"
  | "not_found"
  | "queue_full"
  | "invalid_report"
  | "delivery_failed"
  | "content_unavailable"
  | "expired";

export interface DiagnosticReceipt {
  report_id: string;
  client_report_id: string;
  received_at: string;
  expires_at: string;
  status: "received";
  duplicate: boolean;
}

export interface DiagnosticReportSummary {
  id: string;
  type: "simple" | "full";
  createdAt: string;
  status: DiagnosticDeliveryStatus;
  attempts: number;
  nextAttemptAt: number | null;
  canSend: boolean;
  error?: DiagnosticUiError;
  receipt?: DiagnosticReceipt;
}

export interface DiagnosticUiState {
  version: 1;
  workerId: string;
  revision: number;
  accountEpoch?: number;
  language: Language;
  signedIn: boolean;
  autoReporting: boolean;
  preparing: boolean;
  historyCount: number;
  connectionHistoryCount?: number;
  reports: DiagnosticReportSummary[];
}

export type DiagnosticRequest =
  | { type: "diagnostics_state" }
  | { type: "diagnostics_set_auto"; enabled: boolean }
  | { type: "diagnostics_run" }
  | { type: "diagnostics_report"; reportId: string }
  | { type: "diagnostics_send"; reportId: string; consent: true; noticeVersion: 1 }
  | { type: "diagnostics_cancel"; reportId: string }
  | { type: "diagnostics_delete"; reportId: string }
  | { type: "diagnostics_clear_history" };

/** Origin of an account-sensitive consent action, checked by the worker at commit. */
export interface DiagnosticConsentContext {
  workerId: string;
  accountEpoch: number;
}

export type DiagnosticWorkerRequest =
  | Exclude<DiagnosticRequest, { type: "diagnostics_set_auto" | "diagnostics_send" }>
  | (Extract<DiagnosticRequest, { type: "diagnostics_set_auto" | "diagnostics_send" }> &
      DiagnosticConsentContext);

export interface DiagnosticResponse {
  diagnosticsVersion: 1;
  ok: boolean;
  state: DiagnosticUiState;
  error?: DiagnosticUiError;
  report?: DiagnosticReport;
  reportId?: string;
}

export interface DiagnosticsChangedMessage {
  type: "diagnostics_changed";
  state: DiagnosticUiState;
}

export function isDiagnosticRequest(value: unknown): value is DiagnosticWorkerRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  const noExtra = (...keys: string[]) => Object.keys(candidate).every((key) => keys.includes(key));
  const hasConsentContext = () =>
    typeof candidate.workerId === "string" &&
    candidate.workerId.length > 0 &&
    candidate.workerId.length <= 200 &&
    typeof candidate.accountEpoch === "number" &&
    Number.isSafeInteger(candidate.accountEpoch) &&
    candidate.accountEpoch >= 0;
  switch (candidate.type) {
    case "diagnostics_state":
    case "diagnostics_run":
    case "diagnostics_clear_history":
      return noExtra("type");
    case "diagnostics_set_auto":
      return (
        noExtra("type", "enabled", "workerId", "accountEpoch") &&
        typeof candidate.enabled === "boolean" &&
        hasConsentContext()
      );
    case "diagnostics_send":
      if (
        !noExtra("type", "reportId", "consent", "noticeVersion", "workerId", "accountEpoch") ||
        !hasConsentContext() ||
        candidate.consent !== true ||
        candidate.noticeVersion !== 1
      )
        return false;
      break;
    case "diagnostics_report":
    case "diagnostics_cancel":
    case "diagnostics_delete":
      if (!noExtra("type", "reportId")) return false;
      break;
    default:
      return false;
  }
  return (
    typeof candidate.reportId === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(candidate.reportId) &&
    candidate.reportId !== "00000000-0000-0000-0000-000000000000"
  );
}
