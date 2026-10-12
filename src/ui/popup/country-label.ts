// SPDX-License-Identifier: MPL-2.0

export function countryLabel(code: string, names: Intl.DisplayNames): string {
  const normalized = code.trim().toUpperCase();
  // Region formatting accepts more than country codes and throws for malformed values.
  // Keep unexpected server data readable without letting it interrupt the popup.
  if (!/^[A-Z]{2}$/.test(normalized)) return code || "—";
  try {
    return names.of(normalized) ?? normalized;
  } catch {
    return normalized;
  }
}
