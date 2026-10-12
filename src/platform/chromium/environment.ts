// SPDX-License-Identifier: MPL-2.0

import type { BrowserName, BrowserEnvironment } from "../contracts/environment";
export type { BrowserName, BrowserEnvironment } from "../contracts/environment";

const BRAND_NAMES: Readonly<Record<string, BrowserName>> = {
  "Google Chrome": "chrome",
  "Microsoft Edge": "edge",
  Brave: "brave",
  Opera: "opera",
  Chromium: "chromium",
};
const DEVICE_NAMES: Record<BrowserName, string> = {
  unknown: "Browser",
  chrome: "Google Chrome",
  edge: "Microsoft Edge",
  brave: "Brave",
  opera: "Opera",
  chromium: "Chromium",
};
const DETECTION_TIMEOUT_MS = 500;

interface Brand {
  name: BrowserName;
  version?: string;
}

/** Read only advertised browser identity; never retain the complete user agent. */
export async function detectBrowserEnvironment(
  source: unknown = typeof navigator === "undefined" ? undefined : navigator,
): Promise<BrowserEnvironment> {
  const data = property(source, "userAgentData");
  const brands = readBrands(property(data, "brands"));
  const brave = property(source, "brave");
  const isBrave = property(brave, "isBrave");
  const highEntropy = property(data, "getHighEntropyValues");
  const [braveResult, details] = await Promise.all([
    typeof isBrave === "function" ? bounded(() => Reflect.apply(isBrave, brave, [])) : false,
    typeof highEntropy === "function"
      ? bounded(() => Reflect.apply(highEntropy, data, [["fullVersionList"]]))
      : undefined,
  ]);
  const fullBrands = readBrands(property(details, "fullVersionList"));
  const has = (name: BrowserName) =>
    [...brands, ...fullBrands].some((brand) => brand.name === name);
  const rawAgent = property(source, "userAgent");
  const agent = typeof rawAgent === "string" && rawAgent.length <= 8_192 ? rawAgent : "";
  const products = {
    brave: /(?:^|\s)Brave\/([^\s()]+)/.exec(agent),
    edge: /(?:^|\s)(?:Edg|EdgA|EdgiOS)\/([^\s()]+)/.exec(agent),
    opera: /(?:^|\s)OPR\/([^\s()]+)/.exec(agent),
    chromium: /(?:^|\s)Chromium\/([^\s()]+)/.exec(agent),
    chrome: /(?:^|\s)Chrome\/([^\s()]+)/.exec(agent),
  };
  // Product brands win over the Chromium engine and compatibility UA tokens.
  const browserName: BrowserName =
    braveResult === true || has("brave") || products.brave
      ? "brave"
      : has("edge") || products.edge
        ? "edge"
        : has("opera") || products.opera
          ? "opera"
          : has("chrome")
            ? "chrome"
            : has("chromium") || products.chromium
              ? "chromium"
              : "unknown";
  if (browserName === "unknown") return { browserName };

  // Brave's client hints advertise a Chromium version, not the Brave product version.
  const browserVersion =
    browserName === "brave"
      ? version(products.brave?.[1])
      : (brandVersion(fullBrands, browserName) ??
        version(products[browserName]?.[1]) ??
        brandVersion(brands, browserName));
  return { browserName, ...(browserVersion ? { browserVersion } : {}) };
}

export function browserDeviceName(environment: BrowserEnvironment): string {
  return DEVICE_NAMES[environment.browserName];
}

function property(value: unknown, key: string): unknown {
  try {
    return value !== null && typeof value === "object"
      ? (value as Record<string, unknown>)[key]
      : undefined;
  } catch {
    return undefined;
  }
}

function version(value: unknown): string | undefined {
  if (typeof value !== "string" || !/^[0-9]{1,5}(?:\.[0-9]{1,5}){0,3}$/.test(value))
    return undefined;
  // Reduced user agents expose the major version followed by three synthetic zeroes.
  return value.replace(/\.0\.0\.0$/, "");
}

function readBrands(value: unknown): Brand[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 20).flatMap((entry: unknown) => {
    const brand = property(entry, "brand");
    if (typeof brand !== "string" || !Object.hasOwn(BRAND_NAMES, brand)) return [];
    const name = BRAND_NAMES[brand];
    return name ? [{ name, version: version(property(entry, "version")) }] : [];
  });
}

function brandVersion(brands: Brand[], name: BrowserName): string | undefined {
  const versions = new Set(
    brands.filter((brand) => brand.name === name).map((brand) => brand.version),
  );
  return versions.size === 1 ? versions.values().next().value : undefined;
}

/** Browser APIs are optional and may reject or never resolve. */
function bounded(read: () => unknown): Promise<unknown> {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => finish(undefined), DETECTION_TIMEOUT_MS);
    function finish(value: unknown): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    }
    void Promise.resolve()
      .then(read)
      .then(finish, () => finish(undefined));
  });
}
