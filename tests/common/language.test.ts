// SPDX-License-Identifier: MPL-2.0

import { LanguageController } from "../../src/core/background/language-controller";
import {
  LANGUAGE_NAMES,
  isLanguagePreference,
  languageDirection,
  localeDirectory,
  resolveLanguage,
  type LanguagePreference,
} from "../../src/core/shared/language";
import { Translator, interpolate, type Catalog } from "../../src/core/shared/translator";
import {
  ExtensionLanguageStorage,
  LANGUAGE_STORAGE_KEY,
  type LanguageStorage,
} from "../../src/core/storage/language-storage";
import { ExtensionStorageService } from "../../src/core/storage/storage";
import { isExtensionRequest } from "../../src/core/shared/messages";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const english = { greeting: { message: "Hello $1" } };

describe("language selection", () => {
  it("uses RTL only for Arabic, Persian and Urdu", () => {
    const directions = Object.keys(LANGUAGE_NAMES).map((language) => [
      language,
      languageDirection(language as keyof typeof LANGUAGE_NAMES),
    ]);
    expect(
      directions.filter(([, direction]) => direction === "rtl").map(([language]) => language),
    ).toEqual(["ar", "fa", "ur"]);
    expect(directions.filter(([, direction]) => direction === "ltr")).toHaveLength(27);
  });
  it.each([
    ["en-GB", "en"],
    ["fr-CA", "fr"],
    ["es-MX", "es"],
    ["de-AT", "de"],
    ["pt-PT", "pt-BR"],
    ["pt_BR", "pt-BR"],
    ["pt", "pt-BR"],
    ["it-CH", "it"],
    ["nl-BE", "nl"],
    ["pl-PL", "pl"],
    ["sv-SE", "sv"],
    ["da-DK", "da"],
    ["ar-SA", "ar"],
    ["tr-TR", "tr"],
    ["ja-JP", "ja"],
    ["id-ID", "id"],
    ["in-ID", "id"],
    ["ru-RU", "ru"],
    ["ko-KR", "ko"],
    ["hi-IN", "hi"],
    ["vi-VN", "vi"],
    ["uk-UA", "uk"],
    ["th-TH", "th"],
    ["zh-CN", "zh-CN"],
    ["zh-SG", "zh-CN"],
    ["zh-Hans", "zh-CN"],
    ["zh-TW", "zh-TW"],
    ["zh-HK", "zh-TW"],
    ["zh-Hant", "zh-TW"],
    ["fa-IR", "fa"],
    ["ur-PK", "ur"],
    ["fil-PH", "fil"],
    ["tl-PH", "fil"],
    ["ms-MY", "ms"],
    ["ro-RO", "ro"],
    ["cs-CZ", "cs"],
    ["nb-NO", "no"],
    ["nn-NO", "no"],
    ["el-GR", "el"],
    ["", "en"],
  ])("resolves automatic %s to %s", (browser, expected) => {
    expect(resolveLanguage("auto", browser)).toBe(expected);
  });
  it("exposes the thirty supported languages in the requested order", () => {
    expect(Object.keys(LANGUAGE_NAMES)).toEqual([
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
    ]);
  });
  it.each([
    ["pt-BR", "pt_BR"],
    ["zh-CN", "zh_CN"],
    ["zh-TW", "zh_TW"],
    ["ja", "ja"],
  ] as const)("maps %s to the Chrome locale directory %s", (language, directory) => {
    expect(localeDirectory(language)).toBe(directory);
  });
  it("manual selection overrides Chrome", () => {
    expect(resolveLanguage("de", "fr")).toBe("de");
  });
  it.each([null, false, [], {}, "EN", "pt", "xx", "../../en", "toString"])(
    "rejects invalid preference %j",
    (value) => {
      expect(isLanguagePreference(value)).toBe(false);
      expect(isExtensionRequest({ type: "set_language_preference", preference: value })).toBe(
        false,
      );
    },
  );
  it("accepts a language-only command", () => {
    expect(isExtensionRequest({ type: "set_language_preference", preference: "pt-BR" })).toBe(true);
  });
});

describe("shared translations", () => {
  it("preserves positional, named and escaped substitutions without reinterpreting values", () => {
    expect(
      interpolate({ message: "$USER$: $2 / $$ / $1", placeholders: { user: { content: "$1" } } }, [
        "$2<script>",
        "next",
      ]),
    ).toBe("$2<script>: next / $ / $2<script>");
  });
  it("uses English for an absent key, never another chosen language", async () => {
    const translator = new Translator(async (language) =>
      language === "en" ? english : { title: { message: "Titel" } },
    );
    const de = await translator.forLanguage("de");
    expect(de("greeting", ["Ada"])).toBe("Hello Ada");
    expect(de("title")).toBe("Titel");
    expect(de("missing")).toBe("missing");
  });
  it("keeps translators independent when catalogs finish out of order", async () => {
    const wait = deferred<Catalog>();
    const translator = new Translator(async (language) =>
      language === "de" ? wait.promise : english,
    );
    const older = translator.forLanguage("de");
    const newer = await translator.forLanguage("en");
    wait.resolve({ greeting: { message: "Hallo $1" } });
    expect((await older)("greeting", ["Ada"])).toBe("Hallo Ada");
    expect(newer("greeting", ["Ada"])).toBe("Hello Ada");
  });
});

describe("independent language persistence", () => {
  afterEach(() => vi.unstubAllGlobals());
  function fixture() {
    let saved: LanguagePreference = "auto";
    const storage: LanguageStorage = {
      read: async () => saved,
      write: vi.fn(async (value: LanguagePreference) => {
        saved = value;
      }),
    };
    const translator = new Translator(async () => english);
    return {
      storage,
      translator,
      controller: new LanguageController(storage, () => "fr-CA", translator),
    };
  }
  it("defaults to Chrome and restores a manual choice after restart", async () => {
    const f = fixture();
    await f.controller.initialize();
    expect(f.controller.getState()).toEqual({
      languagePreference: "auto",
      effectiveLanguage: "fr",
    });
    await f.controller.setPreference("pt-BR");
    const restarted = new LanguageController(f.storage, () => "fr", f.translator);
    await restarted.initialize();
    expect(restarted.getState().effectiveLanguage).toBe("pt-BR");
    await restarted.setPreference("auto");
    expect(restarted.getState().effectiveLanguage).toBe("fr");
  });
  it("serializes slow saves and keeps the last choice", async () => {
    const f = fixture();
    const wait = deferred<undefined>();
    const save = f.storage.write;
    vi.mocked(save).mockImplementationOnce(async () => wait.promise);
    const first = f.controller.setPreference("de");
    const second = f.controller.setPreference("es");
    await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    wait.resolve(undefined);
    await Promise.all([first, second]);
    expect(f.controller.getState().effectiveLanguage).toBe("es");
  });
  it("retains the committed choice on write failure and accepts the next change", async () => {
    const f = fixture();
    await f.controller.setPreference("de");
    vi.mocked(f.storage.write).mockRejectedValueOnce(new Error("disk full"));
    await expect(f.controller.setPreference("es")).rejects.toThrow("disk full");
    expect(f.controller.getState()).toEqual({ languagePreference: "de", effectiveLanguage: "de" });
    await f.controller.setPreference("sv");
    expect(f.controller.getState().effectiveLanguage).toBe("sv");
  });
  it("does not save a choice whose catalog cannot be loaded", async () => {
    const f = fixture();
    const controller = new LanguageController(
      f.storage,
      () => "en",
      new Translator(async (language) => {
        if (language === "de") throw new Error("missing");
        return english;
      }),
    );
    await controller.initialize();
    await expect(controller.setPreference("de")).rejects.toThrow("missing");
    expect(f.storage.write).not.toHaveBeenCalled();
    expect(controller.getState().effectiveLanguage).toBe("en");
  });

  it("retries initialization after both the selected catalog and English are unavailable", async () => {
    let available = false;
    const loader = vi.fn(async () => {
      if (!available) throw new Error("catalog_unavailable");
      return english;
    });
    const controller = new LanguageController(
      { read: async () => "de", write: async () => undefined },
      () => "fr",
      new Translator(loader),
    );
    await expect(controller.initialize()).rejects.toThrow("catalog_unavailable");
    available = true;
    await controller.initialize();
    expect(controller.getState()).toEqual({ languagePreference: "de", effectiveLanguage: "de" });
    expect(controller.message("greeting", ["Ada"])).toBe("Hello Ada");
  });

  it("keeps Chrome's native messages usable and retries the saved preference after a read failure", async () => {
    vi.stubGlobal("browser", {
      i18n: { getMessage: (key: string) => (key === "actionBlocked" ? "Browsing blocked" : "") },
    });
    const read = vi.fn<() => Promise<LanguagePreference>>();
    read.mockRejectedValueOnce(new Error("read_unavailable")).mockResolvedValue("de");
    const controller = new LanguageController(
      { read, write: async () => undefined },
      () => "fr",
      new Translator(async () => english),
    );
    await expect(controller.initialize()).rejects.toThrow("read_unavailable");
    expect(controller.message("actionBlocked")).toBe("Browsing blocked");
    await controller.initialize();
    expect(controller.getState().languagePreference).toBe("de");
    expect(read).toHaveBeenCalledTimes(2);
  });
  it("survives account clearing and uses only its dedicated key", async () => {
    const data: Record<string, unknown> = { fuzevpnState: { auth: "test" } };
    vi.stubGlobal("browser", {
      storage: {
        local: {
          get: async () => ({ ...data }),
          set: async (items: Record<string, unknown>) => {
            Object.assign(data, items);
          },
          remove: async (key: string) => {
            Reflect.deleteProperty(data, key);
          },
        },
      },
    });
    const storage = new ExtensionLanguageStorage();
    await storage.write("pl");
    await new ExtensionStorageService().clearPersisted();
    expect(await storage.read()).toBe("pl");
    expect(data).toEqual({ [LANGUAGE_STORAGE_KEY]: "pl" });
    data[LANGUAGE_STORAGE_KEY] = "unsupported";
    expect(await storage.read()).toBe("auto");
  });
});
