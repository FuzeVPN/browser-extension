// SPDX-License-Identifier: MPL-2.0

import type { ProxySession } from "../../../src/core/api/types";
import { ProxyAuthHandler } from "../../../src/platform/chromium/proxy-auth";
import {
  PlatformProxyService,
  PROXY_BYPASS_LIST,
  proxyConfig,
} from "../../../src/platform/chromium/proxy-controller";
import { NOW, proxySession } from "./helpers";
import { captureProxyAuthRequest } from "./proxy-auth-fixture";

function authDetails(
  overrides: Record<string, unknown> = {},
): chrome.webRequest.OnAuthRequiredDetails {
  return {
    requestId: "request-1",
    url: "https://example.com/",
    method: "GET",
    frameId: 0,
    parentFrameId: -1,
    tabId: 1,
    type: "main_frame",
    timeStamp: NOW,
    scheme: "basic",
    realm: "proxy",
    challenger: { host: "frankfurt-01.proxy.vpn1euro.com", port: 443 },
    isProxy: true,
    ...overrides,
  } as chrome.webRequest.OnAuthRequiredDetails;
}

describe("Chrome proxy", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("has only the exact HTTPS API origin and the implicit-bypass removal", () => {
    expect(PROXY_BYPASS_LIST).toEqual(["https://api.fuzevpn.com:443", "<-loopback>"]);
  });

  it.each([["<local>"], ["api.fuzevpn.com"], ["127.0.0.1"], []])(
    "rejects an altered bypass list %j",
    async (...bypassList) => {
      const session = proxySession();
      const config = proxyConfig(session);
      config.rules = { ...config.rules, bypassList };
      vi.stubGlobal("chrome", {
        extension: { isAllowedIncognitoAccess: async () => false },
        proxy: {
          settings: {
            get: async () => ({ levelOfControl: "controlled_by_this_extension", value: config }),
          },
        },
      });
      await expect(new PlatformProxyService().isActiveConfiguration(session)).resolves.toBe(false);
    },
  );

  it("does not provide credentials after another extension takes control", async () => {
    let checks = 0;
    const handler = new ProxyAuthHandler({
      wasUsedProxyChallenge: async () => false,
      isSessionCurrent: () => true,
      getSession: async () => proxySession(),
      isConfiguredProxyChallenge: async () => ++checks === 1,
      now: () => NOW,
    });
    await captureProxyAuthRequest(handler, "request-1");
    await expect(handler.handle(authDetails())).resolves.toEqual({ cancel: true });
  });

  it("does not provide credentials just because another proxy uses the same host", async () => {
    const handler = new ProxyAuthHandler({
      wasUsedProxyChallenge: async () => false,
      isSessionCurrent: () => true,
      getSession: async () => proxySession(),
      isConfiguredProxyChallenge: async () => false,
      now: () => NOW,
    });
    await expect(handler.handle(authDetails())).resolves.toEqual({});
  });

  it("builds the required HTTPS fixed-server configuration", () => {
    const config = proxyConfig(proxySession());
    expect(config).toEqual({
      mode: "fixed_servers",
      rules: {
        singleProxy: {
          scheme: "https",
          host: "frankfurt-01.proxy.vpn1euro.com",
          port: 443,
        },
        bypassList: [...PROXY_BYPASS_LIST],
      },
    });
  });

  it("never answers a non-proxy authentication challenge", async () => {
    const handler = await handlerFor(proxySession());
    await expect(handler.handle(authDetails({ isProxy: false }))).resolves.toEqual({});
  });

  it("never answers a challenger that does not match the active node", async () => {
    const handler = await handlerFor(proxySession());
    await expect(
      handler.handle(authDetails({ challenger: { host: "example.com", port: 443 } })),
    ).resolves.toEqual({});
  });

  it("cancels its own proxy challenge when startup credentials are unavailable", async () => {
    const handler = await handlerFor(null);
    await expect(handler.handle(authDetails())).resolves.toEqual({ cancel: true });
  });

  it("cancels its own proxy challenge when the known session has expired", async () => {
    const expired = proxySession(
      "expired-session",
      "frankfurt-01",
      "2026-08-26T11:40:00Z",
      "2026-08-26T11:50:00Z",
    );
    const handler = await handlerFor(expired);
    await expect(handler.handle(authDetails())).resolves.toEqual({ cancel: true });
  });

  it("does not block another proxy when session lookup fails", async () => {
    const handler = new ProxyAuthHandler({
      wasUsedProxyChallenge: async () => false,
      isSessionCurrent: () => true,
      getSession: async () => Promise.reject(new Error("storage unavailable")),
      isConfiguredProxyChallenge: async () => false,
      now: () => NOW,
    });
    await expect(handler.handle(authDetails())).resolves.toEqual({});
  });

  it("provides credentials once and cancels a repeated challenge", async () => {
    const session = proxySession();
    const handler = await handlerFor(session);
    await expect(handler.handle(authDetails())).resolves.toEqual({
      authCredentials: { username: session.username, password: session.password },
    });
    await expect(handler.handle(authDetails())).resolves.toEqual({ cancel: true });
  });

  it("allows replacement credentials on a request that already tried the previous session", async () => {
    const first = proxySession("session-a");
    const replacement = proxySession("session-b");
    let active = first;
    const handler = new ProxyAuthHandler({
      wasUsedProxyChallenge: async () => false,
      isSessionCurrent: () => true,
      getSession: async () => active,
      isConfiguredProxyChallenge: async () => true,
      now: () => NOW,
    });
    await captureProxyAuthRequest(handler, "request-1", first);

    await expect(handler.handle(authDetails())).resolves.toEqual({
      authCredentials: { username: first.username, password: first.password },
    });
    active = replacement;
    await expect(handler.handle(authDetails())).resolves.toEqual({
      authCredentials: { username: replacement.username, password: replacement.password },
    });
  });

  it("waits for startup restoration before answering its proxy challenge", async () => {
    const session = proxySession();
    let release!: (value: ProxySession) => void;
    const restored = new Promise<ProxySession>((resolve) => {
      release = resolve;
    });
    const handler = new ProxyAuthHandler({
      wasUsedProxyChallenge: async () => false,
      isSessionCurrent: () => true,
      getSession: async () => restored,
      isConfiguredProxyChallenge: async () => true,
      now: () => NOW,
      restoreTimeoutMs: 100,
    });
    await captureProxyAuthRequest(handler, "request-1", session);

    const response = handler.handle(authDetails());
    release(session);

    await expect(response).resolves.toEqual({
      authCredentials: { username: session.username, password: session.password },
    });
  });

  it("cancels its own proxy challenge when startup restoration times out", async () => {
    const handler = new ProxyAuthHandler({
      wasUsedProxyChallenge: async () => false,
      isSessionCurrent: () => true,
      getSession: () => new Promise<ProxySession | null>(() => undefined),
      isConfiguredProxyChallenge: async () => true,
      now: () => NOW,
      restoreTimeoutMs: 1,
    });
    await captureProxyAuthRequest(handler, "request-1");

    await expect(handler.handle(authDetails())).resolves.toEqual({ cancel: true });
  });
});

async function handlerFor(session: ProxySession | null): Promise<ProxyAuthHandler> {
  const handler = new ProxyAuthHandler({
    wasUsedProxyChallenge: async () => false,
    isSessionCurrent: () => true,
    getSession: async () => session,
    isConfiguredProxyChallenge: async (challenger) =>
      challenger.host.toLowerCase() === "frankfurt-01.proxy.vpn1euro.com" &&
      challenger.port === 443,
    now: () => NOW,
  });
  await captureProxyAuthRequest(handler, "request-1", session ?? proxySession());
  return handler;
}
