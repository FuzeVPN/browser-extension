// SPDX-License-Identifier: MPL-2.0

import { extensionApi } from "@platform/bridge";
import { ExtensionLanguageStorage } from "../../core/storage/language-storage";
import {
  isLanguagePreference,
  languageDirection,
  resolveLanguage,
  type Language,
} from "../../core/shared/language";
import { configureLegalLinks } from "../../core/shared/legal-links";
import { Translator } from "../../core/shared/translator";

async function initialize(): Promise<void> {
  const preference = await new ExtensionLanguageStorage().read().catch(() => "auto" as const);
  const requested = new URL(location.href).searchParams.get("lang");
  let language: Language = resolveLanguage(
    isLanguagePreference(requested) ? requested : preference,
    extensionApi.i18n.getUILanguage(),
  );
  const translator = new Translator();
  let translate: (key: string) => string;
  try {
    translate = await translator.forLanguage(language);
  } catch {
    language = "en";
    try {
      translate = await translator.forLanguage(language);
    } catch {
      // The complete English notice remains readable if a local catalog is unavailable.
      configureLegalLinks(language);
      return;
    }
  }
  document.documentElement.lang = language;
  document.documentElement.dir = languageDirection(language);
  document.title = translate("privacyNoticeTitle");
  document.querySelectorAll<HTMLElement>("[data-i18n]").forEach((node) => {
    const key = node.dataset.i18n;
    if (!key) return;
    const text = translate(key);
    if (text !== key) node.textContent = text;
  });
  configureLegalLinks(language);
}

void initialize().catch(() => undefined);
