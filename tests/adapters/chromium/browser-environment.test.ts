// SPDX-License-Identifier: MPL-2.0

import {
  browserDeviceName,
  detectBrowserEnvironment,
  type BrowserName,
} from "../../../src/platform/chromium/environment";

const chromeAgent = "Mozilla/5.0 private.example.invalid Chrome/141.0.0.0 Safari/537.36";
const chromium = { brand: "Chromium", version: "141" };
const chromeBrand = { brand: "Google Chrome", version: "141" };
const grease = { brand: "Not.A/Brand", version: "99" };

describe("advertised browser environment", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it.each([
    [grease, chromium, chromeBrand],
    [chromeBrand, grease, chromium],
    [chromium, chromeBrand, grease],
  ])("recognises the Chrome brand independently of client-hint ordering %j", async (...brands) => {
    expect(await detectBrowserEnvironment({ userAgentData: { brands } })).toEqual({
      browserName: "chrome",
      browserVersion: "141",
    });
  });

  it("requests only the full browser versions and keeps the matching product version", async () => {
    const data = {
      brands: [grease, chromium, { brand: "Microsoft Edge", version: "142" }],
      getHighEntropyValues: vi.fn(function (this: unknown, hints: string[]) {
        expect(this).toBe(data);
        expect(hints).toEqual(["fullVersionList"]);
        return Promise.resolve({
          fullVersionList: [
            { brand: "Chromium", version: "141.0.7339.24" },
            { brand: "Microsoft Edge", version: "142.0.3346.21" },
          ],
          architecture: "sensitive-not-requested",
        });
      }),
    };
    expect(await detectBrowserEnvironment({ userAgentData: data, userAgent: chromeAgent })).toEqual(
      {
        browserName: "edge",
        browserVersion: "142.0.3346.21",
      },
    );
    expect(data.getHighEntropyValues).toHaveBeenCalledOnce();
  });

  it.each([
    { brands: [chromeBrand, chromium, { brand: "Microsoft Edge", version: "142" }], name: "edge" },
    { brands: [{ brand: "Microsoft Edge", version: "142" }, chromium, chromeBrand], name: "edge" },
    { brands: [chromeBrand, { brand: "Opera", version: "127" }, chromium], name: "opera" },
  ])("prefers a specific browser over compatibility brands: $name", async ({ brands, name }) => {
    expect((await detectBrowserEnvironment({ userAgentData: { brands } })).browserName).toBe(name);
  });

  it.each([
    { token: "Edg/142.0.1.2", name: "edge", version: "142.0.1.2" },
    { token: "OPR/127.0.5778.24", name: "opera", version: "127.0.5778.24" },
    { token: "Chromium/141.0.7390.12", name: "chromium", version: "141.0.7390.12" },
  ])("recognises an explicit product UA token without client hints: $name", async (value) => {
    expect(await detectBrowserEnvironment({ userAgent: `${chromeAgent} ${value.token}` })).toEqual({
      browserName: value.name,
      browserVersion: value.version,
    });
  });

  it("lets the Edge UA override generic Chrome client hints", async () => {
    expect(
      await detectBrowserEnvironment({
        userAgent: `${chromeAgent} Edg/142.0.1.2`,
        userAgentData: { brands: [chromeBrand, chromium] },
      }),
    ).toEqual({ browserName: "edge", browserVersion: "142.0.1.2" });
  });

  it("checks Brave before accepting the advertised Chrome brand without borrowing its version", async () => {
    const brave = {
      isBrave: vi.fn(function (this: unknown) {
        expect(this).toBe(brave);
        return Promise.resolve(true);
      }),
    };
    expect(
      await detectBrowserEnvironment({
        userAgent: chromeAgent,
        userAgentData: { brands: [chromium, chromeBrand] },
        brave,
      }),
    ).toEqual({ browserName: "brave" });
    expect(brave.isBrave).toHaveBeenCalledOnce();
  });

  it("does not call the Chromium version advertised by Brave its product version", async () => {
    expect(
      await detectBrowserEnvironment({
        userAgent: chromeAgent,
        userAgentData: {
          brands: [chromium, { brand: "Brave", version: "141" }],
          getHighEntropyValues: async () => ({
            fullVersionList: [{ brand: "Brave", version: "141.0.7390.12" }],
          }),
        },
      }),
    ).toEqual({ browserName: "brave" });
  });

  it("keeps a Brave product version only when explicitly exposed as such", async () => {
    expect(await detectBrowserEnvironment({ userAgent: `${chromeAgent} Brave/1.82.172` })).toEqual({
      browserName: "brave",
      browserVersion: "1.82.172",
    });
  });

  it("does not identify Google Chrome from its ambiguous compatibility token alone", async () => {
    const environment = await detectBrowserEnvironment({ userAgent: chromeAgent });
    expect(environment).toEqual({ browserName: "unknown" });
    expect(browserDeviceName(environment)).toBe("Browser");
  });

  it("recognises an explicit Chromium brand without claiming Google Chrome", async () => {
    expect(
      await detectBrowserEnvironment({ userAgentData: { brands: [grease, chromium] } }),
    ).toEqual({
      browserName: "chromium",
      browserVersion: "141",
    });
  });

  it.each([false, "true", 1, null])(
    "does not mistake a non-true Brave answer %j for Brave",
    async (answer) => {
      expect(
        await detectBrowserEnvironment({
          userAgentData: { brands: [chromeBrand] },
          brave: { isBrave: async () => answer },
        }),
      ).toEqual({ browserName: "chrome", browserVersion: "141" });
    },
  );

  it.each(["reject", "throw"])("contains optional browser API failures: %s", async (failure) => {
    const fail = () => {
      if (failure === "throw") throw new Error("private-error");
      return Promise.reject(new Error("private-error"));
    };
    expect(
      await detectBrowserEnvironment({
        userAgent: `${chromeAgent} Edg/142.0.1.2`,
        userAgentData: { getHighEntropyValues: fail },
        brave: { isBrave: fail },
      }),
    ).toEqual({ browserName: "edge", browserVersion: "142.0.1.2" });
  });

  it("bounds unresolved Brave and client-hint calls together and ignores a late rejection", async () => {
    vi.useFakeTimers();
    let rejectBrave!: (reason: Error) => void;
    const result = detectBrowserEnvironment({
      userAgent: chromeAgent,
      userAgentData: {
        brands: [chromeBrand],
        getHighEntropyValues: () => new Promise(() => {}),
      },
      brave: {
        isBrave: () =>
          new Promise((_resolve, reject) => {
            rejectBrave = reject;
          }),
      },
    });
    await vi.advanceTimersByTimeAsync(500);
    expect(await result).toEqual({ browserName: "chrome", browserVersion: "141" });
    rejectBrave(new Error("late-private-error"));
    await Promise.resolve();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("contains unavailable navigator properties without retaining their errors", async () => {
    const source = {
      get userAgentData() {
        throw new Error("private-error");
      },
      get brave() {
        throw new Error("private-error");
      },
      get userAgent() {
        throw new Error("private-error");
      },
    };
    expect(await detectBrowserEnvironment(source)).toEqual({ browserName: "unknown" });
  });

  it.each(["141.secret", "1.2.3.4.5", "100000.1", "", null])(
    "omits an invalid product version %j",
    async (invalidVersion) => {
      expect(
        await detectBrowserEnvironment({
          userAgentData: { brands: [{ brand: "Microsoft Edge", version: invalidVersion }] },
        }),
      ).toEqual({ browserName: "edge" });
    },
  );

  it("does not invent a version from conflicting duplicated brands", async () => {
    expect(
      await detectBrowserEnvironment({
        userAgentData: { brands: [chromeBrand, { brand: "Google Chrome", version: "142" }] },
      }),
    ).toEqual({ browserName: "chrome" });
  });

  it("omits synthetic zero components from a reduced UA version", async () => {
    expect(await detectBrowserEnvironment({ userAgent: `${chromeAgent} Edg/142.0.0.0` })).toEqual({
      browserName: "edge",
      browserVersion: "142",
    });
  });

  it("falls back safely when navigator is absent", async () => {
    vi.stubGlobal("navigator", undefined);
    expect(await detectBrowserEnvironment()).toEqual({ browserName: "unknown" });
  });

  it.each([
    ["chrome", "Google Chrome"],
    ["edge", "Microsoft Edge"],
    ["brave", "Brave"],
    ["opera", "Opera"],
    ["chromium", "Chromium"],
    ["unknown", "Browser"],
  ] satisfies [BrowserName, string][])(
    "names the device for %s without identifiers",
    (browserName, name) => {
      expect(browserDeviceName({ browserName, browserVersion: "141" })).toBe(name);
    },
  );
});
