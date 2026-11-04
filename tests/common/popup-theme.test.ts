// SPDX-License-Identifier: MPL-2.0

import {
  THEME_STORAGE_KEY,
  isThemePreference,
  readThemePreference,
  resolveTheme,
  toggledTheme,
  writeThemePreference,
} from "../../src/ui/popup/theme";

function memoryStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
  };
}

describe("popup theme preference", () => {
  it.each(["system", "light", "dark"] as const)("reads a saved %s preference", (preference) => {
    expect(readThemePreference(memoryStorage({ [THEME_STORAGE_KEY]: preference }))).toBe(
      preference,
    );
  });

  it.each([null, "", "Dark", "auto", "sepia"])(
    "follows the system for a missing or invalid value: %s",
    (value) => {
      const storage = memoryStorage(value === null ? {} : { [THEME_STORAGE_KEY]: value });
      expect(readThemePreference(storage)).toBe("system");
    },
  );

  it("follows the system when storage is unavailable or throws", () => {
    expect(readThemePreference(null)).toBe("system");
    const throwing = {
      getItem: () => {
        throw new Error("SecurityError");
      },
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
    };
    expect(readThemePreference(throwing)).toBe("system");
    expect(() => writeThemePreference("dark", throwing)).not.toThrow();
  });

  it("saves the chosen preference under its own key only", () => {
    const storage = memoryStorage({ other: "kept" });
    writeThemePreference("dark", storage);
    expect([...storage.values]).toEqual([
      ["other", "kept"],
      [THEME_STORAGE_KEY, "dark"],
    ]);
  });

  it("resolves the system preference from the browser and keeps explicit choices", () => {
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
    expect(resolveTheme("dark", false)).toBe("dark");
    expect(resolveTheme("light", true)).toBe("light");
  });

  it("toggles to the opposite of the theme currently shown", () => {
    expect(toggledTheme("system", true)).toBe("light");
    expect(toggledTheme("system", false)).toBe("dark");
    expect(toggledTheme("dark", false)).toBe("light");
    expect(toggledTheme("light", true)).toBe("dark");
  });

  it("accepts only the three preferences", () => {
    expect(["system", "light", "dark"].every(isThemePreference)).toBe(true);
    expect([undefined, null, 1, "auto", "Dark"].some(isThemePreference)).toBe(false);
  });
});
