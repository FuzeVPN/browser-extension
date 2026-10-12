// SPDX-License-Identifier: MPL-2.0

import { extensionApi } from "@platform/bridge";
import { localeDirectory, type Language } from "./language";

export interface CatalogEntry {
  message: string;
  placeholders?: Record<string, { content: string }>;
}
export type Catalog = Record<string, CatalogEntry>;
export type CatalogLoader = (language: Language) => Promise<Catalog>;

export class Translator {
  private readonly catalogs = new Map<Language, Promise<Catalog>>();
  constructor(private readonly loader: CatalogLoader = loadCatalog) {}

  async forLanguage(
    language: Language,
  ): Promise<(key: string, substitutions?: string[]) => string> {
    const english = await this.load("en");
    const selected = language === "en" ? english : await this.load(language);
    return (key, substitutions = []) => {
      const entry = selected[key] ?? english[key];
      return entry ? interpolate(entry, substitutions) : key;
    };
  }

  private load(language: Language): Promise<Catalog> {
    let pending = this.catalogs.get(language);
    if (!pending) {
      pending = this.loader(language).catch((error: unknown) => {
        this.catalogs.delete(language);
        throw error;
      });
      this.catalogs.set(language, pending);
    }
    return pending;
  }
}

export function interpolate(entry: CatalogEntry, substitutions: string[]): string {
  const placeholders = new Map(
    Object.entries(entry.placeholders ?? {}).map(([name, value]) => [
      name.toLowerCase(),
      value.content,
    ]),
  );
  // Substitution values are inserted once, never reinterpreted as message syntax.
  const substitute = (text: string) =>
    text.replace(/\$\$|\$([1-9])/g, (token, index: string | undefined) =>
      index ? (substitutions[Number(index) - 1] ?? "") : token.slice(1),
    );
  return entry.message.replace(
    /\$\$|\$([1-9])|\$([a-z_][a-z0-9_]*)\$/gi,
    (token, index: string | undefined, name: string | undefined) => {
      if (index) return substitutions[Number(index) - 1] ?? "";
      if (name) return substitute(placeholders.get(name.toLowerCase()) ?? token);
      return "$";
    },
  );
}

async function loadCatalog(language: Language): Promise<Catalog> {
  const response = await fetch(
    extensionApi.runtime.getURL(`_locales/${localeDirectory(language)}/messages.json`),
  );
  if (!response.ok) throw new Error("language_catalog_unavailable");
  return (await response.json()) as Catalog;
}
