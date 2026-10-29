// SPDX-License-Identifier: MPL-2.0

import {
  BLOCKING_PROXY_ENDPOINT,
  PlatformProxyService,
  proxyConfig,
} from "../../../src/platform/chromium/proxy-controller";
import { proxySession } from "./helpers";
import {
  intersectExclusions,
  validateSiteExclusionPolicy,
} from "../../../src/core/shared/site-exclusions";

function fixture() {
  type Setting = chrome.types.ChromeSettingGetResult<chrome.proxy.ProxyConfig>;
  const underlying: Setting = {
    value: { mode: "system" },
    levelOfControl: "controllable_by_this_extension",
  };
  const state = {
    regular: structuredClone(underlying),
    private: null as Setting | null,
    incognito: false,
    ignoreSet: false,
  };
  const set = vi.fn(async ({ value }: { value: chrome.proxy.ProxyConfig }) => {
    if (!state.ignoreSet) {
      state.regular = { value, levelOfControl: "controlled_by_this_extension" };
    }
  });
  const storageGet = vi.fn(async () => ({}));
  vi.stubGlobal("chrome", {
    extension: { isAllowedIncognitoAccess: async () => state.incognito },
    proxy: {
      settings: {
        get: async ({ incognito }: { incognito?: boolean }) =>
          structuredClone(incognito ? (state.private ?? state.regular) : state.regular),
        set,
        clear: async () => {
          state.regular = structuredClone(underlying);
        },
      },
    },
    storage: { session: { get: storageGet, set: async () => undefined } },
  });
  return { state, set, storageGet, underlying };
}

describe("Chromium HTTPS route while no proxy session exists", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("accepts a 198-entry internal intersection while user policies remain limited to 100", async () => {
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
    expect(state.regular.value).toEqual(proxyConfig(BLOCKING_PROXY_ENDPOINT, intersection));
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

  it("installs a verified TLS blocking route without depending on storage", async () => {
    const { state, storageGet } = fixture();
    const proxy = new PlatformProxyService();
    await expect(proxy.isGuardedConfiguration()).resolves.toBe(false);
    await proxy.ensureBlockingConfiguration();
    expect(state.regular.value).toEqual(proxyConfig(BLOCKING_PROXY_ENDPOINT));
    expect(state.regular.value.rules?.bypassList).toEqual([
      "https://api.fuzevpn.com:443",
      "<-loopback>",
    ]);
    await expect(proxy.isGuardedConfiguration()).resolves.toBe(true);
    await expect(proxy.isActiveConfiguration(proxySession())).resolves.toBe(false);
    expect(storageGet).not.toHaveBeenCalled();
  });

  it("retains a valid owned session route during refresh", async () => {
    const { state, set } = fixture();
    state.regular = {
      value: proxyConfig(proxySession()),
      levelOfControl: "controlled_by_this_extension",
    };
    await new PlatformProxyService().ensureBlockingConfiguration();
    expect(set).not.toHaveBeenCalled();
    expect(state.regular.value).toEqual(proxyConfig(proxySession()));
  });

  it("restores the expected exclusions without discarding the existing session endpoint", async () => {
    const { state } = fixture();
    const session = proxySession();
    state.regular = {
      value: proxyConfig(session, [{ domain: "old.example.com", includeSubdomains: true }]),
      levelOfControl: "controlled_by_this_extension",
    };
    const exclusions = [{ domain: "new.example.com", includeSubdomains: false }];
    const proxy = new PlatformProxyService();
    proxy.configureExclusions(exclusions);
    await proxy.ensureBlockingConfiguration();
    expect(state.regular.value).toEqual(proxyConfig(session, exclusions));
    await expect(proxy.isActiveConfiguration(session)).resolves.toBe(true);
  });

  it("does not accept a broader bypass policy as a guarded route", async () => {
    const { state } = fixture();
    state.regular = {
      value: {
        mode: "fixed_servers",
        rules: { singleProxy: { scheme: "https", ...BLOCKING_PROXY_ENDPOINT }, bypassList: ["*"] },
      },
      levelOfControl: "controlled_by_this_extension",
    };
    const proxy = new PlatformProxyService();
    await expect(proxy.isGuardedConfiguration()).resolves.toBe(false);
    await proxy.ensureBlockingConfiguration();
    expect(state.regular.value).toEqual(proxyConfig(BLOCKING_PROXY_ENDPOINT));
  });

  it("preserves exact destination exclusions without adding a direct fallback", async () => {
    const { state } = fixture();
    const exclusions = [{ domain: "example.com", includeSubdomains: false }];
    const proxy = new PlatformProxyService();
    proxy.configureExclusions(exclusions);
    await proxy.ensureBlockingConfiguration();
    expect(state.regular.value).toEqual(proxyConfig(BLOCKING_PROXY_ENDPOINT, exclusions));
    expect(state.regular.value.rules?.fallbackProxy).toBeUndefined();
  });

  it("verifies inherited private routing and rejects an independent direct override", async () => {
    const { state } = fixture();
    state.incognito = true;
    const proxy = new PlatformProxyService();
    await proxy.ensureBlockingConfiguration();
    await expect(proxy.isGuardedConfiguration()).resolves.toBe(true);
    state.private = {
      value: { mode: "direct" },
      levelOfControl: "controlled_by_this_extension",
      incognitoSpecific: true,
    };
    await expect(proxy.isGuardedConfiguration()).resolves.toBe(false);
    await expect(proxy.ensureBlockingConfiguration()).rejects.toThrow("configuration_rejected");
  });

  it("rejects ignored writes and external ownership without claiming confinement", async () => {
    const { state, set } = fixture();
    state.ignoreSet = true;
    const proxy = new PlatformProxyService();
    await expect(proxy.ensureBlockingConfiguration()).rejects.toThrow("configuration_rejected");
    state.regular.levelOfControl = "controlled_by_other_extensions";
    set.mockClear();
    await expect(proxy.ensureBlockingConfiguration()).rejects.toThrow(
      "controlled_by_other_extensions",
    );
    expect(set).not.toHaveBeenCalled();
  });

  it("recognizes the persistent route after worker restoration and restores underlying settings", async () => {
    const { state, underlying } = fixture();
    await new PlatformProxyService().ensureBlockingConfiguration();
    const restored = new PlatformProxyService();
    await expect(restored.isGuardedConfiguration()).resolves.toBe(true);
    await restored.clear();
    expect(state.regular).toEqual(underlying);
    await expect(restored.isGuardedConfiguration()).resolves.toBe(false);
  });
});
