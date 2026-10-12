// SPDX-License-Identifier: MPL-2.0

export interface PublicationFinding {
  scope: string;
  file: string;
  rule: string;
}

export interface PublicationAudit {
  passed: boolean;
  publicFiles: number;
  stagedFiles: number;
  commits: number;
  gitBlobs: number;
  findings: PublicationFinding[];
}

export function inspectPublicPath(name: string): string[];
export function inspectPublicText(text: string): string[];
export function auditPublication(root: string, options?: { history?: boolean }): PublicationAudit;
