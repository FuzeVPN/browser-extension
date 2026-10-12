// SPDX-License-Identifier: MPL-2.0

const DIAGNOSTICS_DATA_PERMISSION = "technicalAndInteraction" as const;

/** Firefox reports optional data consent separately from extension permissions. */
export async function canSendDiagnostics(): Promise<boolean> {
  try {
    const permissions = await browser.permissions.getAll();
    return (
      Array.isArray(permissions.data_collection) &&
      permissions.data_collection.includes(DIAGNOSTICS_DATA_PERMISSION)
    );
  } catch {
    return false;
  }
}

/** Call from the user gesture without awaiting another operation first. */
export function requestDiagnosticsConsent(): Promise<boolean> {
  try {
    return browser.permissions
      .request({ data_collection: [DIAGNOSTICS_DATA_PERMISSION] })
      .catch(() => false);
  } catch {
    return Promise.resolve(false);
  }
}
