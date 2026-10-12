// SPDX-License-Identifier: MPL-2.0

/** Chromium has no Mozilla data-collection gate. Account and report consent remain in core. */
export function canSendDiagnostics(): Promise<boolean> {
  return Promise.resolve(true);
}

export function requestDiagnosticsConsent(): Promise<boolean> {
  return Promise.resolve(true);
}
