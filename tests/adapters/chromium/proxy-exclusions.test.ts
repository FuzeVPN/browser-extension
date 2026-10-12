// SPDX-License-Identifier: MPL-2.0

import {
  PlatformProxyService,
  PROXY_BYPASS_LIST,
  proxyConfig,
} from "../../../src/platform/chromium/proxy-controller";
import type { SiteExclusion } from "../../../src/core/shared/site-exclusions";
import { proxySession } from "./helpers";

const previous: SiteExclusion[] = [{ domain: "example.com", includeSubdomains: true }];
const next: SiteExclusion[] = [{ domain: "shop.example.com", includeSubdomains: false }];

function fixture(initial = proxyConfig(proxySession(), previous)) {
  let value = initial;
  let levelOfControl = "controlled_by_this_extension";
  const settings = {
    get: vi.fn(async () => ({ value: structuredClone(value), levelOfControl })),
    set: vi.fn(async (details: { value: chrome.proxy.ProxyConfig }) => {
      value = structuredClone(details.value);
    }),
  };
  const storageSet = vi.fn(async () => undefined);
  vi.stubGlobal("chrome", {
    extension: { isAllowedIncognitoAccess: async () => false },
    proxy: { settings },
    storage: { session: { get: async () => ({}), set: storageSet } },
  });
  return {
    settings,
    storageSet,
    control(level: string) {
      levelOfControl = level;
    },
  };
}

describe("proxy site exclusions", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("adds exact and child patterns separately, including the DNS root dot", () => {
    expect(proxyConfig(proxySession(), previous).rules?.bypassList).toEqual([
      ...PROXY_BYPASS_LIST,
      "example.com",
      "example.com.",
      "*.example.com",
      "*.example.com.",
    ]);
    expect(proxyConfig(proxySession(), next).rules?.bypassList).toEqual([
      ...PROXY_BYPASS_LIST,
      "shop.example.com",
      "shop.example.com.",
    ]);
  });

  it("uses configured expectations for applying and checking a session", async () => {
    fixture();
    const service = new PlatformProxyService();
    expect(await service.isActiveConfiguration(proxySession())).toBe(false);
    service.configureExclusions(previous);
    expect(await service.isActiveConfiguration(proxySession())).toBe(true);
    service.configureExclusions(next);
    expect(await service.isActiveConfiguration(proxySession())).toBe(false);
    await service.apply(proxySession());
    expect(await service.isActiveConfiguration(proxySession())).toBe(true);
  });

  it("changes only the existing owned bypass, without credentials or history writes", async () => {
    const { settings, storageSet } = fixture();
    const service = new PlatformProxyService();
    await service.updateExistingExclusions(previous, next);
    expect(settings.set).toHaveBeenCalledExactlyOnceWith({
      scope: "regular",
      value: proxyConfig(proxySession(), next),
    });
    expect(storageSet).not.toHaveBeenCalled();
  });

  it("recovers when a previous worker already wrote the target", async () => {
    const { settings } = fixture(proxyConfig(proxySession(), next));
    await new PlatformProxyService().updateExistingExclusions(previous, next);
    expect(settings.set).not.toHaveBeenCalled();
  });

  it("does not install a proxy when no owned proxy exists", async () => {
    const { settings, control } = fixture({ mode: "direct" });
    control("controllable_by_this_extension");
    await new PlatformProxyService().updateExistingExclusions(previous, next);
    expect(settings.set).not.toHaveBeenCalled();
  });

  it("verifies outage bypass coverage independently of a live session", async () => {
    const { control } = fixture();
    const service = new PlatformProxyService();
    expect(await service.isExclusionConfiguration()).toBe(false);
    service.configureExclusions(previous);
    expect(await service.isExclusionConfiguration()).toBe(true);
    service.configureExclusions(next);
    expect(await service.isExclusionConfiguration()).toBe(false);
    control("controlled_by_other_extensions");
    expect(await service.isExclusionConfiguration()).toBe(false);
    control("not_controllable");
    expect(await service.isExclusionConfiguration()).toBe(false);
    control("controllable_by_this_extension");
    expect(await service.isExclusionConfiguration()).toBe(true);
  });

  it("does not confirm accessibility for an unexpected owned proxy mode", async () => {
    fixture({ mode: "system" });
    expect(await new PlatformProxyService().isExclusionConfiguration()).toBe(false);
  });

  it.each(["not_controllable", "controlled_by_other_extensions"])(
    "does not modify another controller: %s",
    async (level) => {
      const { settings, control } = fixture();
      control(level);
      await expect(
        new PlatformProxyService().updateExistingExclusions(previous, next),
      ).rejects.toThrow();
      expect(settings.set).not.toHaveBeenCalled();
    },
  );

  it.each([
    { mode: "direct" },
    { mode: "pac_script", pacScript: { data: "DIRECT" } },
    {
      ...proxyConfig(proxySession(), previous),
      rules: { ...proxyConfig(proxySession(), previous).rules, bypassList: ["<local>"] },
    },
    {
      ...proxyConfig(proxySession(), previous),
      rules: {
        ...proxyConfig(proxySession(), previous).rules,
        fallbackProxy: { host: "other.example.com", port: 443, scheme: "https" },
      },
    },
  ] as chrome.proxy.ProxyConfig[])("rejects unexpected owned configuration %j", async (value) => {
    const { settings } = fixture(value);
    await expect(
      new PlatformProxyService().updateExistingExclusions(previous, next),
    ).rejects.toThrow();
    expect(settings.set).not.toHaveBeenCalled();
  });

  it("rejects invalid expectations before touching Chrome", async () => {
    const { settings } = fixture();
    const service = new PlatformProxyService();
    expect(() =>
      service.configureExclusions([{ domain: "*.com", includeSubdomains: true }]),
    ).toThrow();
    await expect(
      service.updateExistingExclusions(previous, [
        { domain: "api.ipify.org", includeSubdomains: false },
      ]),
    ).rejects.toThrow();
    expect(settings.get).not.toHaveBeenCalled();
  });

  it("fails verification if the target settings are rejected", async () => {
    const { settings } = fixture();
    settings.set.mockImplementation(async () => undefined);
    await expect(
      new PlatformProxyService().updateExistingExclusions(previous, next),
    ).rejects.toThrow("configuration_rejected");
  });

  it("fails verification if the server changes during the update", async () => {
    const { settings } = fixture();
    const original = settings.set.getMockImplementation()!;
    settings.set.mockImplementation(async (details) => {
      await original({
        value: {
          ...details.value,
          rules: {
            ...details.value.rules,
            singleProxy: { scheme: "https", host: "other.example.com", port: 443 },
          },
        },
      });
    });
    await expect(
      new PlatformProxyService().updateExistingExclusions(previous, next),
    ).rejects.toThrow();
  });
});
