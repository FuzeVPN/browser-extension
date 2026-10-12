// SPDX-License-Identifier: MPL-2.0

export const LANGUAGE_NAMES = {
  en: "English",
  es: "Español",
  "pt-BR": "Português",
  de: "Deutsch",
  fr: "Français",
  ar: "العربية",
  tr: "Türkçe",
  ja: "日本語",
  id: "Bahasa Indonesia",
  ru: "Русский",
  it: "Italiano",
  ko: "한국어",
  pl: "Polski",
  nl: "Nederlands",
  hi: "हिन्दी",
  vi: "Tiếng Việt",
  uk: "Українська",
  th: "ไทย",
  "zh-CN": "简体中文",
  "zh-TW": "繁體中文",
  fa: "فارسی",
  ur: "اردو",
  fil: "Filipino",
  ms: "Bahasa Melayu",
  ro: "Română",
  cs: "Čeština",
  sv: "Svenska",
  da: "Dansk",
  no: "Norsk",
  el: "Ελληνικά",
} as const;

export type Language = keyof typeof LANGUAGE_NAMES;
export function languageDirection(language: Language): "ltr" | "rtl" {
  return language === "ar" || language === "fa" || language === "ur" ? "rtl" : "ltr";
}

export type LanguagePreference = "auto" | Language;
export interface LanguageState {
  languagePreference: LanguagePreference;
  effectiveLanguage: Language;
}

export function isLanguagePreference(value: unknown): value is LanguagePreference {
  return value === "auto" || (typeof value === "string" && Object.hasOwn(LANGUAGE_NAMES, value));
}

export function resolveLanguage(preference: LanguagePreference, browserLanguage: string): Language {
  if (preference !== "auto") return preference;
  const parts = browserLanguage.trim().toLowerCase().replaceAll("_", "-").split("-");
  const base = parts[0];
  if (base === "zh") {
    const traditional = parts.some((part) => ["hant", "tw", "hk", "mo"].includes(part));
    return traditional ? "zh-TW" : "zh-CN";
  }
  if (base === "pt") return "pt-BR";
  if (base === "nb" || base === "nn") return "no";
  if (base === "tl") return "fil";
  if (base === "in") return "id";
  return base && Object.hasOwn(LANGUAGE_NAMES, base) ? (base as Language) : "en";
}

export function localeDirectory(language: Language): string {
  if (language === "pt-BR") return "pt_BR";
  if (language === "zh-CN") return "zh_CN";
  if (language === "zh-TW") return "zh_TW";
  return language;
}
