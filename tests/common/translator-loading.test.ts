// SPDX-License-Identifier: MPL-2.0

import type { Language } from "../../src/core/shared/language";
import { Translator, type Catalog } from "../../src/core/shared/translator";

const ENGLISH: Catalog = {
  greeting: { message: "Hello" },
  onlyEnglish: { message: "English only" },
};
const FRENCH: Catalog = { greeting: { message: "Bonjour" } };

/** A loader whose answers the test gives, one request at a time. */
function heldLoader() {
  const requests: {
    language: Language;
    answer(catalog: Catalog): void;
    fail(error: Error): void;
  }[] = [];
  const loader = (language: Language) =>
    new Promise<Catalog>((resolve, reject) => {
      requests.push({ language, answer: resolve, fail: reject });
    });
  return { loader, requests };
}

const turn = () => new Promise<void>((done) => setImmediate(done));

describe("loading the language catalogs", () => {
  it("asks for English and the selected language at once", async () => {
    const { loader, requests } = heldLoader();
    const translating = new Translator(loader).forLanguage("fr");
    await turn();

    // Neither waits for the other: both are asked before either answers.
    expect(requests.map((request) => request.language)).toEqual(["en", "fr"]);
    requests[1]!.answer(FRENCH);
    requests[0]!.answer(ENGLISH);
    const translate = await translating;

    expect(translate("greeting")).toBe("Bonjour");
    expect(translate("onlyEnglish")).toBe("English only");
    expect(translate("unknown")).toBe("unknown");
  });

  it("asks for English once when it is the selected language", async () => {
    const { loader, requests } = heldLoader();
    const translating = new Translator(loader).forLanguage("en");
    await turn();

    expect(requests.map((request) => request.language)).toEqual(["en"]);
    requests[0]!.answer(ENGLISH);
    expect((await translating)("greeting")).toBe("Hello");
  });

  it("uses the catalogs a preload started, without asking again", async () => {
    const { loader, requests } = heldLoader();
    const translator = new Translator(loader);

    translator.preload("fr");
    expect(requests.map((request) => request.language)).toEqual(["en", "fr"]);
    const translating = translator.forLanguage("fr");
    await turn();
    expect(requests).toHaveLength(2);

    requests[0]!.answer(ENGLISH);
    requests[1]!.answer(FRENCH);
    expect((await translating)("greeting")).toBe("Bonjour");
  });

  it("loads another language than the preloaded one when the state asks for it", async () => {
    const { loader, requests } = heldLoader();
    const translator = new Translator(loader);
    translator.preload("fr");

    const translating = translator.forLanguage("de");
    await turn();

    expect(requests.map((request) => request.language)).toEqual(["en", "fr", "de"]);
    requests[0]!.answer(ENGLISH);
    requests[2]!.answer({ greeting: { message: "Hallo" } });
    expect((await translating)("greeting")).toBe("Hallo");
  });

  it("forgets a preload which failed, and loads again when asked", async () => {
    const { loader, requests } = heldLoader();
    const translator = new Translator(loader);
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);

    translator.preload("fr");
    requests[0]!.fail(new Error("catalog unavailable"));
    requests[1]!.fail(new Error("catalog unavailable"));
    await turn();
    await turn();
    process.off("unhandledRejection", unhandled);
    // A preload reports nothing by itself.
    expect(unhandled).not.toHaveBeenCalled();

    const translating = translator.forLanguage("fr");
    await turn();
    expect(requests.map((request) => request.language)).toEqual(["en", "fr", "en", "fr"]);
    requests[2]!.answer(ENGLISH);
    requests[3]!.answer(FRENCH);
    expect((await translating)("greeting")).toBe("Bonjour");
  });

  it.each([
    ["English", 0],
    ["the selected language", 1],
  ])("reports a failure of %s to who asked for the language", async (_name, failing) => {
    const { loader, requests } = heldLoader();
    const translating = new Translator(loader).forLanguage("fr");
    await turn();

    requests[failing]!.fail(new Error("catalog unavailable"));
    requests[1 - failing]!.answer(failing === 0 ? FRENCH : ENGLISH);

    await expect(translating).rejects.toThrow("catalog unavailable");
  });
});
