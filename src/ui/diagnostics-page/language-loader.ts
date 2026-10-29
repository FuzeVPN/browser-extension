// SPDX-License-Identifier: MPL-2.0

import type { Language } from "../../core/shared/language";
import type { Translator } from "../../core/shared/translator";

type Messages = Awaited<ReturnType<Translator["forLanguage"]>>;

interface LanguageLoaderOptions {
  translator: Pick<Translator, "forLanguage">;
  loaded(language: Language, messages: Messages): void;
  failed(): void;
}

/** Retry local catalog failures without allowing old requests to replace a newer language. */
export class DiagnosticLanguageLoader {
  private desiredLanguage: Language | null = null;
  private loadedLanguage: Language | null = null;
  private pending = false;
  private sequence = 0;
  private retry: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;

  constructor(private readonly options: LanguageLoaderOptions) {}

  request(language: Language): void {
    if (this.disposed) return;
    if (
      language === this.desiredLanguage &&
      (this.pending || this.loadedLanguage === language || this.retry !== undefined)
    )
      return;
    this.desiredLanguage = language;
    clearTimeout(this.retry);
    this.retry = undefined;
    this.load(language);
  }

  dispose(): void {
    this.disposed = true;
    ++this.sequence;
    clearTimeout(this.retry);
    this.retry = undefined;
  }

  private load(language: Language): void {
    const sequence = ++this.sequence;
    this.pending = true;
    void this.options.translator.forLanguage(language).then(
      (messages) => {
        if (sequence !== this.sequence || this.disposed) return;
        this.pending = false;
        this.loadedLanguage = language;
        this.options.loaded(language, messages);
      },
      () => {
        if (sequence !== this.sequence || this.disposed) return;
        this.pending = false;
        this.retry = setTimeout(() => {
          this.retry = undefined;
          this.load(language);
        }, 5_000);
        this.options.failed();
      },
    );
  }
}
