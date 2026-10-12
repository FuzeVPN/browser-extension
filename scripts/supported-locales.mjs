// SPDX-License-Identifier: MPL-2.0

export const SUPPORTED_LANGUAGES = [
  "en",
  "es",
  "pt-BR",
  "de",
  "fr",
  "ar",
  "tr",
  "ja",
  "id",
  "ru",
  "it",
  "ko",
  "pl",
  "nl",
  "hi",
  "vi",
  "uk",
  "th",
  "zh-CN",
  "zh-TW",
  "fa",
  "ur",
  "fil",
  "ms",
  "ro",
  "cs",
  "sv",
  "da",
  "no",
  "el",
];

export const CHROME_LOCALE_DIRECTORIES = SUPPORTED_LANGUAGES.map(localeDirectory);

export function localeDirectory(language) {
  if (language === "pt-BR") return "pt_BR";
  if (language === "zh-CN") return "zh_CN";
  if (language === "zh-TW") return "zh_TW";
  return language;
}
