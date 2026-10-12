// SPDX-License-Identifier: MPL-2.0

import { runInNewContext } from "node:vm";
import {
  PlatformProxyService,
  proxyConfig,
  readProxyConfiguration,
  requestUsesProxy,
} from "../../src/core/background/proxy-controller";
import { ProxyAuthHandler, type ProxyAuthDetails } from "../../src/core/background/proxy-auth";
import { NOW, proxySession } from "./helpers";

function evaluatePac(config = proxyConfig(proxySession())) {
  const script = decodeURIComponent(config.autoConfigUrl!.split(",").slice(1).join(","));
  const context: { FindProxyForURL?: (url: string, host: string) => string } = {};
  // An isolated evaluator supplies no DNS functions, so accidental DNS use fails this test.
  runInNewContext(script, context, { timeout: 100 });
  return (url: string) => context.FindProxyForURL!(url, new URL(url).hostname);
}

describe("Firefox PAC routing and preflight", () => {
  afterEach(() => vi.unstubAllGlobals());

  it.each([
    "http://example.com/",
    "https://example.com/",
    "ws://example.com/socket",
    "wss://example.com/socket",
    "https://api.fuzevpn.com:444/",
    "http://api.fuzevpn.com/",
    "https://api.fuzevpn.com.evil.example/",
    "https://evil.api.fuzevpn.com/",
    "https://api.fuzevpn.com./",
    "http://localhost/",
    "http://127.0.0.1/",
    "http://192.168.1.1/",
  ])("routes %s through TLS with no fallback", (url) => {
    expect(evaluatePac()(url)).toBe(`HTTPS ${proxySession().host}:443`);
  });

  it.each(["https://api.fuzevpn.com/v1", "https://api.fuzevpn.com:443/v1"])(
    "routes only the control API's exact secure origin directly: %s",
    (url) => {
      expect(evaluatePac()(url)).toBe("DIRECT");
    },
  );

  it("matches excluded destinations, root dots and subdomains without matching neighbors", () => {
    const route = evaluatePac(
      proxyConfig(proxySession(), [
        { domain: "example.com", includeSubdomains: false },
        { domain: "example.org", includeSubdomains: true },
      ]),
    );
    for (const url of [
      "https://example.com/",
      "https://example.com./",
      "http://example.org:8080/",
      "https://child.example.org./",
    ]) {
      expect(route(url)).toBe("DIRECT");
    }
    for (const url of [
      "https://child.example.com/",
      "https://otherexample.com/",
      "https://example.org.evil.com/",
      "https://otherexample.org/",
    ]) {
      expect(route(url)).toBe(`HTTPS ${proxySession().host}:443`);
    }
  });

  it("never trusts altered PAC code or unsafe metadata", () => {
    const config = proxyConfig(proxySession());
    const source = decodeURIComponent(config.autoConfigUrl!.split(",").slice(1).join(","));
    for (const changed of [
      source + "\n// extra code",
      source.replace("HTTPS ", "PROXY "),
      source.replace('return "DIRECT"', 'return "DIRECT; HTTPS attacker.example:443"'),
    ]) {
      expect(
        readProxyConfiguration({
          ...config,
          autoConfigUrl: config.autoConfigUrl!.split(",")[0]! + "," + encodeURIComponent(changed),
        }),
      ).toBeNull();
    }
    expect(
      readProxyConfiguration({ ...config, autoConfigUrl: config.autoConfigUrl! + "%invalid" }),
    ).toBeNull();
    expect(() => proxyConfig({ host: "proxy.example; DIRECT", port: 443 })).toThrow(
      "configuration_rejected",
    );
  });

  it.each([
    undefined,
    null,
    {},
    { type: "direct" },
    { type: "http", ...proxySession() },
    { type: "https", host: "attacker.example", port: 443 },
    { type: "https", host: proxySession().host, port: 80 },
  ])("rejects an ineffective TLS proxy route: %j", (route) => {
    expect(requestUsesProxy(route, proxySession())).toBe(false);
  });

  it("accepts the exact effective TLS proxy, case-insensitively", () => {
    expect(
      requestUsesProxy(
        { type: "https", host: proxySession().host.toUpperCase(), port: 443 },
        proxySession(),
      ),
    ).toBe(true);
  });

  it.each([
    { privateAccess: false, hosts: true, error: "private_browsing_required" },
    { privateAccess: true, hosts: false, error: "host_permissions_required" },
  ])(
    "rejects connection before writing settings when $error",
    async ({ privateAccess, hosts, error }) => {
      const set = vi.fn();
      vi.stubGlobal("browser", {
        extension: { isAllowedIncognitoAccess: async () => privateAccess },
        permissions: { contains: async () => hosts },
        proxy: {
          settings: {
            set,
            get: async () => ({ levelOfControl: "controllable_by_this_extension" }),
          },
        },
      });
      await expect(new PlatformProxyService().apply(proxySession())).rejects.toThrow(error);
      expect(set).not.toHaveBeenCalled();
    },
  );

  it.each([
    undefined,
    { type: "http", host: proxySession().host, port: 443 },
    { type: "https", host: "other.example", port: 443 },
  ])(
    "does not disclose credentials without matching effective proxy evidence: %j",
    async (proxyInfo) => {
      const getSession = vi.fn(async () => proxySession());
      const handler = new ProxyAuthHandler({
        getSession,
        isConfiguredProxyChallenge: async () => true,
        wasUsedProxyChallenge: async () => true,
        isSessionCurrent: () => true,
        now: () => NOW,
      });
      await expect(
        handler.handle({
          isProxy: true,
          requestId: "untrusted-route",
          challenger: proxySession(),
          proxyInfo,
        } as unknown as ProxyAuthDetails),
      ).resolves.toEqual({ cancel: true });
      expect(getSession).not.toHaveBeenCalled();
    },
  );
});
