// SPDX-License-Identifier: MPL-2.0

import type { Language } from "../../core/shared/language";

export function normalizeLocationSearch(value: string, language: Language): string {
  // Turkish İ must become i before its dot is removed by accent folding.
  return value
    .toLocaleLowerCase(language)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim();
}

export function matchesLocationSearch(
  text: string,
  countryCode: string,
  query: string,
  language: Language,
): boolean {
  const normalized = normalizeLocationSearch(text, language);
  const code = countryCode.toUpperCase();
  return query
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .every((part) => {
      // ISO country codes have language-independent casing (IT and it are identical).
      const codeQuery = part.toUpperCase();
      return (
        normalized.includes(normalizeLocationSearch(part, language)) ||
        (/^[A-Z]{1,2}$/.test(codeQuery) && code.includes(codeQuery))
      );
    });
}
