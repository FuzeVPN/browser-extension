// SPDX-License-Identifier: MPL-2.0

export interface ReportedAdvisory {
  id: string | null;
  package: string;
  severity: string;
  url: string;
}
export interface AuditException {
  advisory: string;
  package: string;
  reason: string;
  until: string;
}
export interface AuditOutcome {
  blocking: (ReportedAdvisory & { expired: string | null })[];
  accepted: (ReportedAdvisory & { until: string })[];
  unused: AuditException[];
}
export function reportedAdvisories(report: unknown): ReportedAdvisory[];
export function readExceptions(listed: unknown): AuditException[];
export function auditOutcome(report: unknown, listed: unknown, today: string): AuditOutcome;
