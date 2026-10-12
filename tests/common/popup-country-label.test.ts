// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "vitest";
import { countryLabel } from "../../src/ui/popup/country-label";

describe("popup country labels", () => {
  const names = new Intl.DisplayNames(["en"], { type: "region" });

  it("localizes valid country codes, including lowercase server values", () => {
    expect(countryLabel("FR", names)).toBe("France");
    expect(countryLabel("de", names)).toBe("Germany");
  });

  it.each(["FRANCE", "F", "FR-FR", "1234", "<script>", ""])(
    "keeps rendering with malformed country %j",
    (code) => {
      expect(countryLabel(code, names)).toBe(code || "—");
    },
  );

  it("provides a label for an unassigned country code", () => {
    expect(countryLabel("XX", names)).toBe("XX");
    expect(
      countryLabel("XX", new Intl.DisplayNames(["en"], { type: "region", fallback: "none" })),
    ).toBe("XX");
  });
});
