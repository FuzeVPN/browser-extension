// SPDX-License-Identifier: MPL-2.0

export type ThemePreference = "system" | "light" | "dark";
export type Theme = "light" | "dark";

export const THEME_STORAGE_KEY = "fuzevpnTheme";

type ThemeStorage = Pick<Storage, "getItem" | "setItem">;

export function isThemePreference(value: unknown): value is ThemePreference {
  return value === "system" || value === "light" || value === "dark";
}

/**
 * The theme is a purely visual popup choice. It is read synchronously so the first
 * frame already uses it; an unreadable or invalid value follows the system.
 */
export function readThemePreference(
  storage: ThemeStorage | null = popupStorage(),
): ThemePreference {
  try {
    const value = storage?.getItem(THEME_STORAGE_KEY);
    return isThemePreference(value) ? value : "system";
  } catch {
    return "system";
  }
}

export function writeThemePreference(
  preference: ThemePreference,
  storage: ThemeStorage | null = popupStorage(),
): void {
  try {
    storage?.setItem(THEME_STORAGE_KEY, preference);
  } catch {
    /* Unavailable storage keeps the choice for this popup only. */
  }
}

export function resolveTheme(preference: ThemePreference, systemDark: boolean): Theme {
  if (preference !== "system") return preference;
  return systemDark ? "dark" : "light";
}

/** The explicit theme a one-click toggle selects from the theme currently shown. */
export function toggledTheme(preference: ThemePreference, systemDark: boolean): Theme {
  return resolveTheme(preference, systemDark) === "dark" ? "light" : "dark";
}

function popupStorage(): ThemeStorage | null {
  try {
    return globalThis.localStorage;
  } catch {
    return null;
  }
}
