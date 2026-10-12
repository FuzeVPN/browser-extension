// SPDX-License-Identifier: MPL-2.0

import {
  PlatformProxyService,
  proxyConfig,
  readProxyConfiguration,
} from "../../../src/core/background/proxy-controller";
import type { SiteExclusion } from "../../../src/core/shared/site-exclusions";
import { proxySession } from "../../common/helpers";

const previous: SiteExclusion[] = [{ domain: "example.com", includeSubdomains: true }];
const next: SiteExclusion[] = [{ domain: "shop.example.com", includeSubdomains: false }];

function fixture(initial = proxyConfig(proxySession(), previous)) {
  let value = initial;
  let levelOfControl = "controlled_by_this_extension";
  const settings = {
    get: vi.fn(async () => ({ value: structuredClone(value), levelOfControl })),
    set: vi.fn(async (details: { value: browser.proxy.ProxyConfig }) => {
      value = structuredClone(details.value);
    }),
  };
  const storageSet = vi.fn(async () => undefined);
  vi.stubGlobal("browser", {
    extension: { isAllowedIncognitoAccess: async () => true },
    permissions: { contains: async () => true },
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

  it("preserves exact and subdomain policy separately in the generated PAC", () => {
    expect(readProxyConfiguration(proxyConfig(proxySession(), previous))?.exclusions).toEqual(
      previous,
    );
    expect(readProxyConfiguration(proxyConfig(proxySession(), next))?.exclusions).toEqual(next);
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
    const { settings, control } = fixture({ proxyType: "none" });
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
    fixture({ proxyType: "system" });
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
    { proxyType: "none" },
    { proxyType: "autoConfig", autoConfigUrl: "data:,DIRECT" },
    {
      ...proxyConfig(proxySession(), previous),
      passthrough: "<local>",
    },
    {
      ...proxyConfig(proxySession(), previous),
      autoConfigUrl: proxyConfig(proxySession(), previous).autoConfigUrl! + "tampered",
    },
  ] as browser.proxy.ProxyConfig[])("rejects unexpected owned configuration %j", async (value) => {
    const { settings } = fixture(value);
    await expect(
      new PlatformProxyService().updateExistingExclusions(previous, next),
    ).rejects.toThrow();
    expect(settings.set).not.toHaveBeenCalled();
  });

  it("rejects invalid expectations before touching Firefox", async () => {
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
        value: proxyConfig(
          { host: "other.example.com", port: 443 },
          readProxyConfiguration(details.value)!.exclusions,
        ),
      });
    });
    await expect(
      new PlatformProxyService().updateExistingExclusions(previous, next),
    ).rejects.toThrow();
  });
});
