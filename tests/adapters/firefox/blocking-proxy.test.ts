// SPDX-License-Identifier: MPL-2.0

import { runInNewContext } from "node:vm";
import {
  BLOCKING_PROXY_ENDPOINT,
  PlatformProxyService,
  proxyConfig,
  readProxyConfiguration,
  type ProxySettingsResult,
} from "../../../src/platform/firefox/proxy-controller";
import {
  intersectExclusions,
  validateSiteExclusionPolicy,
} from "../../../src/core/shared/site-exclusions";

function fixture() {
  const underlying: ProxySettingsResult = {
    value: { proxyType: "system" },
    levelOfControl: "controllable_by_this_extension",
  };
  const state = { setting: structuredClone(underlying), ignoreSet: false, permitted: true };
  const set = vi.fn(async ({ value }: { value: browser.proxy.ProxyConfig }) => {
    if (!state.ignoreSet) state.setting = { value, levelOfControl: "controlled_by_this_extension" };
  });
  const storageGet = vi.fn(async () => ({}));
  vi.stubGlobal("browser", {
    extension: { isAllowedIncognitoAccess: async () => state.permitted },
    permissions: { contains: async () => true },
    proxy: {
      settings: {
        get: async () => structuredClone(state.setting),
        set,
        clear: async () => {
          state.setting = structuredClone(underlying);
        },
      },
    },
    storage: { session: { get: storageGet, set: async () => undefined } },
  });
  return { state, set, storageGet, underlying };
}

describe("Firefox HTTPS route while no proxy session exists", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("accepts a 198-entry internal intersection without widening the user policy limit", async () => {
    const { state } = fixture();
    const children = (parent: string) =>
      Array.from({ length: 99 }, (_, index) => ({
        domain: `child${String(index)}.${parent}.example.com`,
        includeSubdomains: false,
      }));
    const previous = [{ domain: "a.example.com", includeSubdomains: true }, ...children("b")];
    const next = [{ domain: "b.example.com", includeSubdomains: true }, ...children("a")];
    const intersection = intersectExclusions(previous, next);
    expect(intersection).toHaveLength(198);
    expect(validateSiteExclusionPolicy({ revision: 0, enabled: true, entries: intersection })).toBe(
      false,
    );
    const proxy = new PlatformProxyService();
    proxy.configureExclusions(intersection);
    await proxy.ensureBlockingConfiguration();
    expect(readProxyConfiguration(state.setting.value)?.exclusions).toEqual(intersection);
    await expect(proxy.isGuardedConfiguration()).resolves.toBe(true);
    const tooMany = [
      ...intersection,
      ...Array.from({ length: 3 }, (_, index) => ({
        domain: `extra${String(index)}.example.com`,
        includeSubdomains: false,
      })),
    ];
    expect(() => proxy.configureExclusions(tooMany)).toThrow("configuration_rejected");
    expect(() => proxyConfig(BLOCKING_PROXY_ENDPOINT, tooMany)).toThrow("configuration_rejected");
    const first = intersection[0];
    if (!first) throw new Error("Missing intersection fixture");
    const duplicateAcrossSegments = intersection.map((entry, index) =>
      index === 100 ? first : entry,
    );
    expect(() => proxy.configureExclusions(duplicateAcrossSegments)).toThrow(
      "configuration_rejected",
    );
  });

  it("round-trips 198 maximum-length route domains within the bounded PAC parser", () => {
    const entries = Array.from({ length: 198 }, (_, index) => ({
      domain: `${"a".repeat(63)}.${"b".repeat(63)}.${"c".repeat(63)}.${`n${String(index)}`.padEnd(57, "d")}.com`,
      includeSubdomains: true,
    }));
    expect(entries.every(({ domain }) => domain.length === 253)).toBe(true);
    const config = proxyConfig(BLOCKING_PROXY_ENDPOINT, entries);
    expect(config.autoConfigUrl?.length).toBeLessThan(300_000);
    expect(readProxyConfiguration(config)?.exclusions).toEqual(entries);
  });

  it("installs a verified local TLS route independently of storage", async () => {
    const { state, storageGet } = fixture();
    const proxy = new PlatformProxyService();
    await proxy.ensureBlockingConfiguration();
    expect(state.setting.value).toEqual(proxyConfig(BLOCKING_PROXY_ENDPOINT));
    await expect(proxy.isGuardedConfiguration()).resolves.toBe(true);
    expect(storageGet).not.toHaveBeenCalled();
    const configUrl = state.setting.value.autoConfigUrl;
    if (!configUrl) throw new Error("Missing blocking PAC");
    const script = decodeURIComponent(configUrl.split(",").slice(1).join(","));
    const context = { url: "", host: "" };
    const cases: { url: string; route: string }[] = [
      { url: "https://api.fuzevpn.com/v1/me", route: "DIRECT" },
      { url: "http://api.fuzevpn.com/v1/me", route: "HTTPS 127.0.0.1:9" },
      { url: "https://api.fuzevpn.com:444/v1/me", route: "HTTPS 127.0.0.1:9" },
      { url: "https://api.fuzevpn.com.attacker.example/", route: "HTTPS 127.0.0.1:9" },
      { url: "https://example.com/", route: "HTTPS 127.0.0.1:9" },
    ];
    for (const { url, route } of cases) {
      context.url = url;
      context.host = new URL(url).hostname;
      expect(runInNewContext(`${script}; FindProxyForURL(url, host)`, context)).toBe(route);
    }
  });

  it("preserves an exact owned proxy and its destination exclusions", async () => {
    const { state, set } = fixture();
    const exclusions = [{ domain: "example.com", includeSubdomains: false }];
    state.setting = {
      value: proxyConfig({ host: "proxy.example.com", port: 443 }, exclusions),
      levelOfControl: "controlled_by_this_extension",
    };
    const proxy = new PlatformProxyService();
    proxy.configureExclusions(exclusions);
    await proxy.ensureBlockingConfiguration();
    expect(set).not.toHaveBeenCalled();
    await expect(proxy.isGuardedConfiguration()).resolves.toBe(true);
  });

  it("restores the expected exclusions without discarding the existing session endpoint", async () => {
    const { state } = fixture();
    const endpoint = { host: "proxy.example.com", port: 443 };
    state.setting = {
      value: proxyConfig(endpoint, [{ domain: "old.example.com", includeSubdomains: true }]),
      levelOfControl: "controlled_by_this_extension",
    };
    const exclusions = [{ domain: "new.example.com", includeSubdomains: false }];
    const proxy = new PlatformProxyService();
    proxy.configureExclusions(exclusions);
    await proxy.ensureBlockingConfiguration();
    expect(state.setting.value).toEqual(proxyConfig(endpoint, exclusions));
    await expect(proxy.isGuardedConfiguration()).resolves.toBe(true);
  });

  it("repairs malformed owned PAC without introducing a direct fallback", async () => {
    const { state } = fixture();
    state.setting = {
      value: { proxyType: "autoConfig", autoConfigUrl: "data:,DIRECT" },
      levelOfControl: "controlled_by_this_extension",
    };
    const proxy = new PlatformProxyService();
    await expect(proxy.isGuardedConfiguration()).resolves.toBe(false);
    await proxy.ensureBlockingConfiguration();
    expect(state.setting.value).toEqual(proxyConfig(BLOCKING_PROXY_ENDPOINT));
  });

  it("rejects missing private permission, external ownership and ignored writes", async () => {
    const { state, set } = fixture();
    const proxy = new PlatformProxyService();
    state.permitted = false;
    await expect(proxy.ensureBlockingConfiguration()).rejects.toThrow("private_browsing_required");
    expect(set).not.toHaveBeenCalled();
    state.permitted = true;
    state.setting.levelOfControl = "controlled_by_other_extensions";
    await expect(proxy.ensureBlockingConfiguration()).rejects.toThrow(
      "controlled_by_other_extensions",
    );
    expect(set).not.toHaveBeenCalled();
    state.setting.levelOfControl = "controllable_by_this_extension";
    state.ignoreSet = true;
    await expect(proxy.ensureBlockingConfiguration()).rejects.toThrow("configuration_rejected");
  });

  it("recognizes a restored guard and explicitly restores underlying settings", async () => {
    const { state, underlying } = fixture();
    await new PlatformProxyService().ensureBlockingConfiguration();
    const restored = new PlatformProxyService();
    await expect(restored.isGuardedConfiguration()).resolves.toBe(true);
    await restored.clear();
    expect(state.setting).toEqual(underlying);
    await expect(restored.isGuardedConfiguration()).resolves.toBe(false);
  });
});
