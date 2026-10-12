// SPDX-License-Identifier: MPL-2.0

import {
  ProxyAuthHandler,
  type ProxyAuthDependencies,
  type ProxyAuthDetails,
} from "../../src/core/background/proxy-auth";
import type { ProxySession } from "../../src/core/api/types";
import { NOW, proxySession } from "./helpers";

function details(requestId = "request-1"): ProxyAuthDetails {
  return {
    incognito: false,
    thirdParty: false,
    requestId,
    url: "https://example.com/",
    method: "GET",
    frameId: 0,
    parentFrameId: -1,
    tabId: 1,
    type: "main_frame",
    timeStamp: NOW,
    scheme: "basic",
    realm: "proxy",
    statusCode: 407,
    statusLine: "HTTP/1.1 407 Proxy Authentication Required",
    challenger: { host: "frankfurt-01.proxy.vpn1euro.com", port: 443 },
    isProxy: true,
    proxyInfo: { type: "https", host: proxySession().host, port: proxySession().port },
  };
}

function fixture(overrides: Partial<ProxyAuthDependencies> = {}) {
  const controls: { session: ProxySession | null; owned: boolean; current: boolean; now: number } =
    {
      session: proxySession(),
      owned: true,
      current: true,
      now: NOW,
    };
  const onAuthenticationFailure = vi.fn(async () => undefined);
  const dependencies: ProxyAuthDependencies = {
    getSession: async () => controls.session,
    isConfiguredProxyChallenge: async () => controls.owned,
    wasUsedProxyChallenge: async () => true,
    isSessionCurrent: (session) => controls.current && controls.session?.id === session.id,
    onAuthenticationFailure,
    now: () => controls.now,
    ...overrides,
  };
  return { controls, onAuthenticationFailure, handler: new ProxyAuthHandler(dependencies) };
}

describe("proxy authentication rejection reporting", () => {
  afterEach(() => vi.restoreAllMocks());

  it("reports a repeated 407 for the verified session, never the initial challenge", async () => {
    const f = fixture();
    expect((await f.handler.handle(details())).authCredentials).toBeDefined();
    expect(f.onAuthenticationFailure).not.toHaveBeenCalled();
    await expect(f.handler.handle(details())).resolves.toEqual({ cancel: true });
    await vi.waitFor(() =>
      expect(f.onAuthenticationFailure).toHaveBeenCalledExactlyOnceWith(f.controls.session),
    );
  });

  it("cancels immediately and deduplicates recovery while its callback remains pending", async () => {
    const recovery = vi.fn(() => new Promise<void>(() => undefined));
    const f = fixture({ onAuthenticationFailure: recovery });
    await Promise.all([f.handler.handle(details("one")), f.handler.handle(details("two"))]);
    await expect(
      Promise.all([f.handler.handle(details("one")), f.handler.handle(details("two"))]),
    ).resolves.toEqual([{ cancel: true }, { cancel: true }]);
    await vi.waitFor(() => expect(recovery).toHaveBeenCalledOnce());
  });

  it.each(["throw", "reject"] as const)(
    "contains callback %s without delaying cancellation or logging its sensitive error",
    async (failure) => {
      const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const recovery = vi.fn<() => Promise<void>>(() => {
        if (failure === "throw") throw new Error("sensitive credentials");
        return Promise.reject(new Error("sensitive credentials"));
      });
      const f = fixture({ onAuthenticationFailure: recovery });
      await f.handler.handle(details());
      await expect(f.handler.handle(details())).resolves.toEqual({ cancel: true });
      await vi.waitFor(() =>
        expect(warning).toHaveBeenCalledExactlyOnceWith(
          "FuzeVPN: proxy authentication recovery failed.",
        ),
      );
      expect(JSON.stringify(warning.mock.calls)).not.toContain("sensitive");
      recovery.mockImplementation(async () => undefined);
      await expect(f.handler.handle(details())).resolves.toEqual({ cancel: true });
      await vi.waitFor(() => expect(recovery).toHaveBeenCalledTimes(2));
    },
  );

  it.each(["disconnect", "expiration", "ownership"] as const)(
    "does not report a rejection after %s invalidates the original session",
    async (change) => {
      const f = fixture();
      await f.handler.handle(details());
      if (change === "disconnect") f.controls.current = false;
      if (change === "expiration") f.controls.now = Date.parse(f.controls.session!.expiresAt);
      if (change === "ownership") f.controls.owned = false;
      await expect(f.handler.handle(details())).resolves.toEqual({ cancel: true });
      expect(f.onAuthenticationFailure).not.toHaveBeenCalled();
    },
  );

  it("allows replacement credentials without attributing the old rejection to the new session", async () => {
    const f = fixture();
    await f.handler.handle(details());
    f.controls.session = proxySession("replacement-session");
    expect((await f.handler.handle(details())).authCredentials).toEqual({
      username: f.controls.session.username,
      password: f.controls.session.password,
    });
    expect(f.onAuthenticationFailure).not.toHaveBeenCalled();
  });

  it("ignores a website authentication challenge at the same endpoint", async () => {
    const f = fixture();
    await f.handler.handle(details());
    await expect(f.handler.handle({ ...details(), isProxy: false })).resolves.toEqual({});
    expect(f.onAuthenticationFailure).not.toHaveBeenCalled();
  });

  it("rechecks session and owner before delivering a deferred recovery report", async () => {
    let resolveOwnership!: (owned: boolean) => void;
    const ownership = new Promise<boolean>((resolve) => {
      resolveOwnership = resolve;
    });
    const ownershipCheck = vi.fn(async () => true);
    const f = fixture({ isConfiguredProxyChallenge: ownershipCheck });
    await f.handler.handle(details());
    ownershipCheck
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockReturnValueOnce(ownership);
    await expect(f.handler.handle(details())).resolves.toEqual({ cancel: true });
    f.controls.session = proxySession("replacement-session");
    resolveOwnership(true);
    await ownership;
    expect(f.onAuthenticationFailure).not.toHaveBeenCalled();
  });
});
