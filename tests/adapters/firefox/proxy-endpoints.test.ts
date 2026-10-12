// SPDX-License-Identifier: MPL-2.0

import { PlatformProxyService, proxyConfig } from "../../../src/core/background/proxy-controller";
import { proxySession } from "../../common/helpers";

function chromeFixture() {
  const stored: Record<string, unknown> = {};
  let value: browser.proxy.ProxyConfig = { proxyType: "none" };
  let level = "controllable_by_this_extension";
  const get = vi.fn(async () => structuredClone(stored));
  const set = vi.fn(async (items: Record<string, unknown>) =>
    Object.assign(stored, structuredClone(items)),
  );
  const settings = {
    get: vi.fn(async () => ({ value, levelOfControl: level })),
    set: vi.fn(async (details: { value: browser.proxy.ProxyConfig }) => {
      value = details.value;
      level = "controlled_by_this_extension";
    }),
    clear: vi.fn(async () => {
      value = { proxyType: "none" };
      level = "controllable_by_this_extension";
    }),
  };
  vi.stubGlobal("browser", {
    extension: { isAllowedIncognitoAccess: async () => true },
    permissions: { contains: async () => true },
    proxy: { settings },
    storage: { session: { get, set } },
  });
  return {
    stored,
    settings,
    get,
    set,
    seed(config: browser.proxy.ProxyConfig, control = "controlled_by_this_extension") {
      value = config;
      level = control;
    },
  };
}

describe("cancel-only proxy endpoint history", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("recognizes a removed endpoint after worker restart without retaining credentials", async () => {
    const fixture = chromeFixture();
    const service = new PlatformProxyService();
    const session = proxySession();
    await service.apply(session);
    await service.clear();
    const restarted = new PlatformProxyService();
    expect(await restarted.isConfiguredProxyChallenge(session)).toBe(false);
    expect(await restarted.wasUsedProxyChallenge(session)).toBe(true);
    expect(fixture.stored).toEqual({
      fuzevpnProxyEndpoints: [{ host: session.host, port: session.port }],
    });
  });

  it("remembers an old version's owned configuration before clearing it", async () => {
    const fixture = chromeFixture();
    const session = proxySession();
    fixture.seed(proxyConfig(session));
    await new PlatformProxyService().clear();
    expect(await new PlatformProxyService().wasUsedProxyChallenge(session)).toBe(true);
  });

  it("does not adopt a proxy owned by another extension", async () => {
    const fixture = chromeFixture();
    const session = proxySession();
    fixture.seed(proxyConfig(session), "controlled_by_other_extensions");
    const service = new PlatformProxyService();
    await service.clear();
    expect(await service.wasUsedProxyChallenge(session)).toBe(false);
    expect(fixture.stored).toEqual({});
  });

  it("matches only the exact endpoint, including its port", async () => {
    chromeFixture();
    const session = proxySession();
    const service = new PlatformProxyService();
    await service.apply(session);
    expect(
      await service.wasUsedProxyChallenge({ host: session.host.toUpperCase(), port: session.port }),
    ).toBe(true);
    for (const host of [
      "proxy.example.com",
      `evil.${session.host}`,
      `${session.host}.example.com`,
    ]) {
      expect(await service.wasUsedProxyChallenge({ host, port: session.port })).toBe(false);
    }
    expect(await service.wasUsedProxyChallenge({ host: session.host, port: 80 })).toBe(false);
  });

  it("still removes the proxy and keeps an in-memory endpoint when history persistence fails", async () => {
    const fixture = chromeFixture();
    const session = proxySession();
    fixture.seed(proxyConfig(session));
    fixture.set.mockRejectedValue(new Error("storage unavailable"));
    const service = new PlatformProxyService();
    await service.clear();
    expect(fixture.settings.clear).toHaveBeenCalledOnce();
    expect(await service.isConfiguredProxyChallenge(session)).toBe(false);
    expect(await service.wasUsedProxyChallenge(session)).toBe(true);
  });

  it("does not configure a new endpoint before its history has been saved", async () => {
    const fixture = chromeFixture();
    fixture.set.mockRejectedValue(new Error("storage unavailable"));
    await expect(new PlatformProxyService().apply(proxySession())).rejects.toThrow(
      "storage unavailable",
    );
    expect(fixture.settings.set).not.toHaveBeenCalled();
  });

  it("merges stored and overlapping endpoint writes", async () => {
    const fixture = chromeFixture();
    const first = proxySession();
    const second = proxySession("second", "frankfurt-02");
    fixture.stored.fuzevpnProxyEndpoints = [{ host: "older.proxy.example.com", port: 443 }];
    const service = new PlatformProxyService();
    // Proxy writes themselves are serialized by AppController; the history also
    // serializes storage to prevent a slow history read dropping either endpoint.
    await Promise.allSettled([service.apply(first), service.apply(second)]);
    const restarted = new PlatformProxyService();
    expect(await restarted.wasUsedProxyChallenge(first)).toBe(true);
    expect(await restarted.wasUsedProxyChallenge(second)).toBe(true);
    expect(
      await restarted.wasUsedProxyChallenge({ host: "older.proxy.example.com", port: 443 }),
    ).toBe(true);
  });

  it("ignores malformed stored endpoints", async () => {
    const fixture = chromeFixture();
    fixture.stored.fuzevpnProxyEndpoints = [
      null,
      "example.com",
      { host: "bad.example", port: "443" },
      { host: "bad.example", port: 0 },
    ];
    expect(
      await new PlatformProxyService().wasUsedProxyChallenge({ host: "bad.example", port: 443 }),
    ).toBe(false);
  });
});
