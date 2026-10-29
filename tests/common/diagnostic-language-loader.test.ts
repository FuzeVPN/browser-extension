// SPDX-License-Identifier: MPL-2.0

import { DiagnosticLanguageLoader } from "../../src/ui/diagnostics-page/language-loader";
import { Translator } from "../../src/core/shared/translator";
import type { Language } from "../../src/core/shared/language";

type Messages = Awaited<ReturnType<Translator["forLanguage"]>>;
type OnLoaded = (language: Language, messages: Messages) => void;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  return { promise, resolve, reject };
}

describe("diagnostic language catalog recovery", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("retries a failed catalog after five seconds without another state update", async () => {
    let unavailable = true;
    const load = vi.fn(async (language: Language) => {
      if (language === "ar" && unavailable) throw new Error("catalog_unavailable");
      return { title: { message: language } };
    });
    const loaded = vi.fn<OnLoaded>();
    const failed = vi.fn();
    const subject = new DiagnosticLanguageLoader({
      translator: new Translator(load),
      loaded,
      failed,
    });
    subject.request("ar");
    await vi.advanceTimersByTimeAsync(0);
    expect(failed).toHaveBeenCalledTimes(1);
    expect(loaded).not.toHaveBeenCalled();
    for (let index = 0; index < 10; index++) subject.request("ar");
    unavailable = false;
    await vi.advanceTimersByTimeAsync(4_999);
    expect(load.mock.calls.filter(([language]) => language === "ar")).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(load.mock.calls.filter(([language]) => language === "ar")).toHaveLength(2);
    expect(loaded).toHaveBeenCalledTimes(1);
    const [language, message] = loaded.mock.calls[0]!;
    expect(language).toBe("ar");
    expect(message("title")).toBe("ar");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("deduplicates requests while a catalog is loading or already loaded", async () => {
    const result = deferred<(key: string) => string>();
    const forLanguage = vi.fn(() => result.promise);
    const loaded = vi.fn<OnLoaded>();
    const subject = new DiagnosticLanguageLoader({
      translator: { forLanguage },
      loaded,
      failed: vi.fn(),
    });
    subject.request("fr");
    subject.request("fr");
    expect(forLanguage).toHaveBeenCalledTimes(1);
    result.resolve((key) => `fr:${key}`);
    await vi.advanceTimersByTimeAsync(0);
    subject.request("fr");
    expect(forLanguage).toHaveBeenCalledTimes(1);
    expect(loaded).toHaveBeenCalledTimes(1);
  });

  it("cancels an old retry when the requested language changes", async () => {
    const forLanguage = vi.fn(async (language: Language) => {
      if (language === "ar") throw new Error("catalog_unavailable");
      return (key: string) => `${language}:${key}`;
    });
    let languageFailure = false;
    const loaded = vi.fn<OnLoaded>(() => {
      languageFailure = false;
    });
    const subject = new DiagnosticLanguageLoader({
      translator: { forLanguage },
      loaded,
      failed: () => {
        languageFailure = true;
      },
    });
    subject.request("ar");
    await vi.advanceTimersByTimeAsync(0);
    expect(languageFailure).toBe(true);
    subject.request("de");
    await vi.advanceTimersByTimeAsync(0);
    expect(languageFailure).toBe(false);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(forLanguage.mock.calls.map(([language]) => language)).toEqual(["ar", "de"]);
    expect(loaded).toHaveBeenCalledWith("de", expect.any(Function));
  });

  it.each(["success", "failure"])(
    "ignores a late %s after returning to the previously loaded language",
    async (outcome) => {
      const older = deferred<(key: string) => string>();
      const forLanguage = vi.fn((language: Language) =>
        language === "ar" ? older.promise : Promise.resolve((key: string) => `fr:${key}`),
      );
      const loaded = vi.fn<OnLoaded>();
      const failed = vi.fn();
      const subject = new DiagnosticLanguageLoader({
        translator: { forLanguage },
        loaded,
        failed,
      });
      subject.request("fr");
      await vi.advanceTimersByTimeAsync(0);
      subject.request("ar");
      subject.request("fr");
      await vi.advanceTimersByTimeAsync(0);
      if (outcome === "success") older.resolve((key) => `ar:${key}`);
      else older.reject(new Error("late_catalog_failure"));
      await vi.advanceTimersByTimeAsync(0);
      expect(loaded.mock.calls.map(([language]) => language)).toEqual(["fr", "fr"]);
      expect(failed).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("cancels a scheduled retry when the page is disposed", async () => {
    const forLanguage = vi.fn(async () => {
      throw new Error("catalog_unavailable");
    });
    const subject = new DiagnosticLanguageLoader({
      translator: { forLanguage },
      loaded: vi.fn(),
      failed: vi.fn(),
    });
    subject.request("ar");
    await vi.advanceTimersByTimeAsync(0);
    subject.dispose();
    subject.request("de");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(forLanguage).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("ignores a catalog that resolves after the page is disposed", async () => {
    const result = deferred<(key: string) => string>();
    const loaded = vi.fn<OnLoaded>();
    const failed = vi.fn();
    const subject = new DiagnosticLanguageLoader({
      translator: { forLanguage: () => result.promise },
      loaded,
      failed,
    });
    subject.request("fr");
    subject.dispose();
    result.resolve((key) => key);
    await vi.advanceTimersByTimeAsync(0);
    expect(loaded).not.toHaveBeenCalled();
    expect(failed).not.toHaveBeenCalled();
  });
});
