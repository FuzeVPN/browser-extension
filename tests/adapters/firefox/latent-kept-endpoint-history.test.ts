// SPDX-License-Identifier: MPL-2.0

import {
  PlatformProxyService,
  proxyConfig,
  type ProxySettingsResult,
} from "../../../src/core/background/proxy-controller";
import { proxySession } from "../../common/helpers";

const ENDPOINTS_KEY = "fuzevpnProxyEndpoints";
const EXCLUSIONS = [{ domain: "example.com", includeSubdomains: false }];

function browserFixture() {
  const underlying: ProxySettingsResult = {
    value: { proxyType: "system" },
    levelOfControl: "controllable_by_this_extension",
  };
  const state = { setting: structuredClone(underlying) };
  let stored: Record<string, unknown> = {};
  const set = vi.fn(async ({ value }: { value: browser.proxy.ProxyConfig }) => {
    state.setting = { value, levelOfControl: "controlled_by_this_extension" };
  });
  vi.stubGlobal("browser", {
    extension: { isAllowedIncognitoAccess: async () => true },
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
    storage: {
      session: {
        get: async () => structuredClone(stored),
        set: async (items: Record<string, unknown>) => {
          Object.assign(stored, structuredClone(items));
        },
      },
    },
  });
  return {
    state,
    set,
    endpoints: () => stored[ENDPOINTS_KEY],
    // The owned proxy setting persists; session storage does not.
    restartBrowser() {
      stored = {};
    },
  };
}

describe("history of a session endpoint kept by the blocking route", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("still recognizes the kept endpoint once a later background page replaced it", async () => {
    const firefox = browserFixture();
    const session = proxySession();
    const replacement = proxySession("replacement-session", "frankfurt-02");
    await new PlatformProxyService().apply(session);
    expect(firefox.endpoints()).toEqual([{ host: session.host, port: session.port }]);

    firefox.restartBrowser();
    const restored = new PlatformProxyService();
    restored.configureExclusions(EXCLUSIONS);
    await restored.ensureBlockingConfiguration();
    expect(firefox.state.setting.value).toEqual(proxyConfig(session, EXCLUSIONS));
    expect(await restored.wasUsedProxyChallenge(session)).toBe(true);

    // The background page is suspended; its successor connects to another node.
    const resumed = new PlatformProxyService();
    resumed.configureExclusions(EXCLUSIONS);
    await resumed.apply(replacement);
    expect(firefox.state.setting.value).toEqual(proxyConfig(replacement, EXCLUSIONS));
    expect(await resumed.isConfiguredProxyChallenge(session)).toBe(false);
    expect(await resumed.wasUsedProxyChallenge(replacement)).toBe(true);

    // A request still in flight through the kept endpoint may answer 407 only now.
    expect(await resumed.wasUsedProxyChallenge(session)).toBe(true);
  });

  it("recognizes the kept endpoint in the background page that kept it", async () => {
    const firefox = browserFixture();
    const session = proxySession();
    const replacement = proxySession("replacement-session", "frankfurt-02");
    await new PlatformProxyService().apply(session);

    firefox.restartBrowser();
    const restored = new PlatformProxyService();
    restored.configureExclusions(EXCLUSIONS);
    await restored.ensureBlockingConfiguration();
    await restored.apply(replacement);

    expect(await restored.isConfiguredProxyChallenge(session)).toBe(false);
    expect(await restored.wasUsedProxyChallenge(session)).toBe(true);
  });

  it("recognizes the kept endpoint after a suspension within one browser session", async () => {
    const firefox = browserFixture();
    const session = proxySession();
    const replacement = proxySession("replacement-session", "frankfurt-02");
    await new PlatformProxyService().apply(session);

    const restored = new PlatformProxyService();
    restored.configureExclusions(EXCLUSIONS);
    await restored.ensureBlockingConfiguration();
    expect(firefox.state.setting.value).toEqual(proxyConfig(session, EXCLUSIONS));

    const resumed = new PlatformProxyService();
    resumed.configureExclusions(EXCLUSIONS);
    await resumed.apply(replacement);

    expect(await resumed.isConfiguredProxyChallenge(session)).toBe(false);
    expect(await resumed.wasUsedProxyChallenge(session)).toBe(true);
  });

  it("still recognizes an already guarded endpoint of the previous browser session", async () => {
    const firefox = browserFixture();
    const session = proxySession();
    const replacement = proxySession("replacement-session", "frankfurt-02");
    await new PlatformProxyService().apply(session);

    firefox.restartBrowser();
    firefox.set.mockClear();
    const restored = new PlatformProxyService();
    await restored.ensureBlockingConfiguration();
    // The inherited route already is a guarded one: it is kept without any write.
    expect(firefox.set).not.toHaveBeenCalled();
    expect(firefox.state.setting.value).toEqual(proxyConfig(session));
    await restored.apply(replacement);

    expect(await restored.isConfiguredProxyChallenge(session)).toBe(false);
    expect(await restored.wasUsedProxyChallenge(session)).toBe(true);
  });
});
