// SPDX-License-Identifier: MPL-2.0

import { extensionApi, hasExtensionApi } from "@platform/bridge";
import {
  isLanguagePreference,
  resolveLanguage,
  type LanguagePreference,
  type LanguageState,
} from "../shared/language";
import { Translator } from "../shared/translator";
import type { LanguageStorage } from "../storage/language-storage";

export class LanguageController {
  private state: LanguageState;
  private initialization: Promise<void> | null = null;
  private changes: Promise<void> = Promise.resolve();
  private translate: (key: string, substitutions?: string[]) => string = nativeMessage;

  constructor(
    private readonly storage: LanguageStorage,
    private readonly browserLanguage: () => string,
    private readonly translator = new Translator(),
  ) {
    this.state = {
      languagePreference: "auto",
      effectiveLanguage: resolveLanguage("auto", browserLanguage()),
    };
  }

  initialize(): Promise<void> {
    this.initialization ??= (async () => {
      const preference = await this.storage.read();
      const language = resolveLanguage(preference, this.browserLanguage());
      try {
        this.translate = await this.translator.forLanguage(language);
        this.state = { languagePreference: preference, effectiveLanguage: language };
      } catch {
        this.translate = await this.translator.forLanguage("en");
        this.state = { languagePreference: preference, effectiveLanguage: "en" };
      }
    })().catch((error: unknown) => {
      this.initialization = null;
      throw error;
    });
    return this.initialization;
  }

  getState(): LanguageState {
    return { ...this.state };
  }
  message(key: string, substitutions?: string[]): string {
    return this.translate(key, substitutions);
  }

  async setPreference(preference: LanguagePreference): Promise<void> {
    if (!isLanguagePreference(preference)) throw new Error("invalid_language");
    const update = this.changes.then(async () => {
      await this.initialize();
      const effectiveLanguage = resolveLanguage(preference, this.browserLanguage());
      const translate = await this.translator.forLanguage(effectiveLanguage);
      await this.storage.write(preference);
      this.state = { languagePreference: preference, effectiveLanguage };
      this.translate = translate;
    });
    this.changes = update.catch(() => undefined);
    await update;
  }
}

function nativeMessage(key: string, substitutions?: string[]): string {
  return !hasExtensionApi() ? key : extensionApi.i18n.getMessage(key, substitutions) || key;
}
