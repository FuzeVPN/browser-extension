// SPDX-License-Identifier: MPL-2.0

import {
  EMPTY_SITE_EXCLUSION_POLICY,
  effectiveExclusions,
  intersectExclusions,
  normalizeSiteExclusion,
  validateSiteExclusionPolicy,
  type SiteExclusion,
} from "../../src/core/shared/site-exclusions";

const entry = (domain: string, includeSubdomains = true): SiteExclusion => ({
  domain,
  includeSubdomains,
});

describe("site exclusion domains", () => {
  it.each([
    ["  EXAMPLE.com ", "example.com"],
    ["https://Example.com:8443/path?q=1#anchor", "example.com"],
    ["example.com./", "example.com"],
    ["https://BÜCHER.de/", "xn--bcher-kva.de"],
    ["https://食狮.公司.cn", "xn--85x722f.xn--55qx5d.cn"],
    ["shop.example.co.uk", "shop.example.co.uk"],
    ["www.ck", "www.ck"],
    ["city.kawasaki.jp", "city.kawasaki.jp"],
    ["user.blogspot.com", "user.blogspot.com"],
  ])("normalizes %s", (input, expected) => {
    expect(normalizeSiteExclusion(input, false)).toEqual(entry(expected, false));
  });

  it.each([
    "",
    "localhost",
    "printer.local",
    "router.home.arpa",
    "printer.corp",
    "127.0.0.1",
    "0x7f000001",
    "2130706433",
    "127.1",
    "[::1]",
    "https://[2606:4700:4700::1111]/",
    "https://8.8.8.8",
    "*.example.com",
    "*example.com",
    ".example.com",
    "example.com..",
    "bad_label.example.com",
    "bad..example.com",
    "-bad.example.com",
    "https://name:secret@example.com",
    "https://example.com\n.evil.com",
    "https://example.com\\@evil.com",
    "ftp://example.com",
    "javascript:example.com",
    "com",
    "co.uk",
    "blogspot.com",
    "github.io",
    "foo.ck",
    "foo.kawasaki.jp",
    "公司.cn",
  ])("rejects unsafe or public suffix input %s", (input) => {
    expect(() => normalizeSiteExclusion(input, true)).toThrow();
  });

  it.each(["api.fuzevpn.com", "api.ipify.org", "api64.ipify.org"])(
    "reserves measurement and control destinations: %s",
    (domain) => {
      expect(() => normalizeSiteExclusion(domain, false)).toThrow("reserved");
      expect(() => normalizeSiteExclusion(domain.toUpperCase() + ".", true)).toThrow("reserved");
    },
  );

  it("reserves parent coverage, while allowing only the parent's exact hostname", () => {
    for (const domain of ["fuzevpn.com", "ipify.org"]) {
      expect(() => normalizeSiteExclusion(domain, true)).toThrow("reserved");
      expect(normalizeSiteExclusion(domain, false)).toEqual(entry(domain, false));
    }
    expect(normalizeSiteExclusion("myipify.org", true)).toEqual(entry("myipify.org"));
  });
});

describe("site exclusion policies", () => {
  const valid = { revision: 2, enabled: true, entries: [entry("example.com")] };

  it("validates an empty policy and 100 canonical unique domains", () => {
    expect(validateSiteExclusionPolicy(EMPTY_SITE_EXCLUSION_POLICY)).toBe(true);
    expect(
      validateSiteExclusionPolicy({
        ...valid,
        entries: Array.from({ length: 100 }, (_, index) =>
          entry(`host${String(index)}.example.com`),
        ),
      }),
    ).toBe(true);
  });

  it.each([
    null,
    [],
    { revision: -1, enabled: true, entries: [] },
    { revision: 0.5, enabled: true, entries: [] },
    { revision: Number.MAX_SAFE_INTEGER + 1, enabled: true, entries: [] },
    { revision: 0, enabled: "true", entries: [] },
    { revision: 0, enabled: true, entries: [entry("Example.com")] },
    { revision: 0, enabled: true, entries: [entry("https://example.com")] },
    { revision: 0, enabled: true, entries: [entry("example.com"), entry("example.com", false)] },
    { revision: 0, enabled: true, entries: [entry("api.ipify.org")] },
    { revision: 0, enabled: true, entries: [{ domain: "example.com", includeSubdomains: 1 }] },
    {
      revision: 0,
      enabled: true,
      entries: Array.from({ length: 101 }, (_, i) => entry(`h${String(i)}.com`)),
    },
  ])("rejects malformed or noncanonical policy %j", (value) => {
    expect(validateSiteExclusionPolicy(value)).toBe(false);
  });

  it("does not expose mutable saved objects and disables retained entries", () => {
    expect(effectiveExclusions({ ...valid, enabled: false })).toEqual([]);
    const result = effectiveExclusions(valid);
    result[0]!.domain = "changed.com";
    expect(valid.entries[0]!.domain).toBe("example.com");
  });

  it("intersects actual child coverage symmetrically", () => {
    const broad = [entry("example.com")];
    const narrow = [entry("shop.example.com", false)];
    expect(intersectExclusions(broad, narrow)).toEqual(narrow);
    expect(intersectExclusions(narrow, broad)).toEqual(narrow);
    expect(intersectExclusions([entry("example.com", false)], narrow)).toEqual([]);
    expect(intersectExclusions(broad, [entry("example.com", false)])).toEqual([
      entry("example.com", false),
    ]);
  });

  it("never broadens to neighbors and removes redundant intersection entries", () => {
    expect(intersectExclusions([entry("example.com")], [entry("otherexample.com")])).toEqual([]);
    const previous = [entry("example.com"), entry("shop.example.com")];
    const next = [entry("example.com"), entry("shop.example.com", false)];
    expect(intersectExclusions(previous, next)).toEqual([entry("example.com")]);
    expect(intersectExclusions(previous, [])).toEqual([]);
  });
});
