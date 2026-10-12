// SPDX-License-Identifier: MPL-2.0

import { extensionApi } from "@platform/bridge";
import { isLanguagePreference, type LanguagePreference } from "../shared/language";

export const LANGUAGE_STORAGE_KEY = "fuzevpnLanguage";
export interface LanguageStorage {
  read(): Promise<LanguagePreference>;
  write(preference: LanguagePreference): Promise<void>;
}

export class ExtensionLanguageStorage implements LanguageStorage {
  async read(): Promise<LanguagePreference> {
    const result = await extensionApi.storage.local.get(LANGUAGE_STORAGE_KEY);
    const value: unknown = result[LANGUAGE_STORAGE_KEY];
    return isLanguagePreference(value) ? value : "auto";
  }
  async write(preference: LanguagePreference): Promise<void> {
    await extensionApi.storage.local.set({ [LANGUAGE_STORAGE_KEY]: preference });
  }
}
