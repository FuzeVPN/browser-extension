// SPDX-License-Identifier: MPL-2.0

import type { ProxySession } from "../../../src/core/api/types";
import { ProxyAuthHandler } from "../../../src/platform/chromium/proxy-auth";
import { PlatformProxyService, proxyConfig } from "../../../src/platform/chromium/proxy-controller";
import { NOW, proxySession } from "./helpers";

type ProxySetting = chrome.types.ChromeSettingGetResult<chrome.proxy.ProxyConfig>;

function event<T>() {
  let listener: ((details: T) => unknown) | undefined;
  return {
    addListener: (value: typeof listener) => (listener = value),
    emit: (details: T) => listener?.(details),
  };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => (resolve = done));
  return { promise, resolve };
}

function fixture(
  options: { initialFailure?: "settings" | "permission"; incognito?: boolean } = {},
) {
  const session = proxySession();
  const owned: ProxySetting = {
    levelOfControl: "controlled_by_this_extension",
    value: proxyConfig(session),
  };
  const state = { now: NOW, session, regular: owned, private: owned };
  const before = event<{ requestId: string; tabId: number }>();
  const changed = event<ProxySetting>();
  const get = vi.fn(async ({ incognito }: { incognito?: boolean }) =>
    structuredClone(incognito ? state.private : state.regular),
  );
  const permission = vi.fn(async () => options.incognito ?? false);
  if (options.initialFailure === "settings")
    get.mockRejectedValueOnce(new Error("transient settings read failure"));
  if (options.initialFailure === "permission")
    permission.mockRejectedValueOnce(new Error("transient permission read failure"));
  vi.stubGlobal("chrome", {
    extension: { isAllowedIncognitoAccess: permission },
    tabs: { get: async (tabId: number) => ({ incognito: tabId === 2 }) },
    proxy: { settings: { get, onChange: changed } },
    webRequest: {
      onBeforeRequest: before,
      onAuthRequired: event(),
      onCompleted: event(),
      onErrorOccurred: event(),
    },
  });
  const proxy = new PlatformProxyService();
  const getSession = vi.fn(async () => state.session);
  const handler = new ProxyAuthHandler({
    getSession,
    isConfiguredProxyChallenge: (challenger) => proxy.isConfiguredProxyChallenge(challenger),
    wasUsedProxyChallenge: async () => true,
    isSessionCurrent: (candidate) => candidate === state.session,
    now: () => state.now,
  });
  handler.register();
  return {
    state,
    get,
    getSession,
    permission,
    changed,
    settle: () => new Promise<void>((resolve) => setImmediate(resolve)),
    start: (requestId: string, incognito = false) =>
      before.emit({ requestId, tabId: incognito ? 2 : 1 }),
    challenge: (requestId: string, candidate: ProxySession = state.session) =>
      handler.handle({
        documentLifecycle: "active",
        frameType: "outermost_frame",
        isProxy: true,
        requestId,
        url: "https://example.invalid/",
        method: "GET",
        frameId: 0,
        parentFrameId: -1,
        tabId: 1,
        type: "main_frame",
        timeStamp: state.now,
        scheme: "basic",
        statusCode: 407,
        statusLine: "HTTP/1.1 407 Proxy Authentication Required",
        challenger: { host: candidate.host, port: candidate.port },
      }),
  };
}

describe("proxy route provenance recovery", () => {
  afterEach(() => vi.unstubAllGlobals());

  it.each(["settings", "permission"] as const)(
    "recovers a transient %s failure for later requests without onChange",
    async (initialFailure) => {
      const f = fixture({ initialFailure });
      await f.settle();
      f.state.now += 1_000;
      f.start("started-without-proof");
      await f.settle();

      await expect(f.challenge("started-without-proof")).resolves.toEqual({ cancel: true });
      expect(f.getSession).not.toHaveBeenCalled();
      f.start("after-healthy-read");
      expect((await f.challenge("after-healthy-read")).authCredentials).toEqual({
        username: f.state.session.username,
        password: f.state.session.password,
      });
    },
  );

  it("deduplicates concurrent recovery reads and bounds repeated failures until repair", async () => {
    const f = fixture();
    f.get.mockRejectedValue(new Error("settings unavailable"));
    await f.settle();
    expect(f.get).toHaveBeenCalledTimes(1);
    f.state.now += 1_000;
    for (let index = 0; index < 50; index++) f.start(`retry-one-${String(index)}`);
    await f.settle();
    expect(f.get).toHaveBeenCalledTimes(2);
    for (let index = 0; index < 50; index++) f.start(`same-time-${String(index)}`);
    f.state.now += 999;
    f.start("before-next-retry");
    await f.settle();
    expect(f.get).toHaveBeenCalledTimes(2);
    f.state.now++;
    f.start("retry-two");
    await f.settle();
    expect(f.get).toHaveBeenCalledTimes(3);

    f.get.mockImplementation(async ({ incognito }) =>
      structuredClone(incognito ? f.state.private : f.state.regular),
    );
    f.state.now += 1_000;
    f.start("repair-trigger");
    await f.settle();
    expect(f.get).toHaveBeenCalledTimes(4);
    await expect(f.challenge("repair-trigger")).resolves.toEqual({ cancel: true });
    f.start("repaired");
    expect((await f.challenge("repaired")).authCredentials).toBeDefined();
  });

  it("keeps verified regular scope while recovering a failed private scope", async () => {
    const f = fixture({ incognito: true });
    f.get.mockImplementationOnce(async () => structuredClone(f.state.regular));
    f.get.mockRejectedValueOnce(new Error("private settings unavailable"));
    await f.settle();
    expect(f.get).toHaveBeenCalledTimes(2);
    const pending = deferred();
    f.get.mockImplementation(async ({ incognito }) => {
      await pending.promise;
      return structuredClone(incognito ? f.state.private : f.state.regular);
    });
    f.state.now += 1_000;
    f.start("regular-trigger");
    for (let index = 0; index < 10; index++) f.start(`private-pending-${String(index)}`, true);
    f.start("regular-during-recovery");
    await f.settle();
    expect(f.get).toHaveBeenCalledTimes(4);
    pending.resolve();
    await f.settle();

    expect((await f.challenge("regular-trigger")).authCredentials).toBeDefined();
    expect((await f.challenge("regular-during-recovery")).authCredentials).toBeDefined();
    await expect(f.challenge("private-pending-0")).resolves.toEqual({ cancel: true });
    f.start("private-after-recovery", true);
    expect((await f.challenge("private-after-recovery")).authCredentials).toBeDefined();
  });

  it("does not let a stale recovery read overwrite a newer route generation", async () => {
    const f = fixture({ initialFailure: "settings" });
    await f.settle();
    const stale = structuredClone(f.state.regular);
    const pending = deferred();
    f.get.mockImplementationOnce(async () => {
      await pending.promise;
      return stale;
    });
    f.state.now += 1_000;
    f.start("before-route-change");
    await f.settle();

    f.state.session = proxySession("replacement", "frankfurt-02");
    f.state.regular = {
      levelOfControl: "controlled_by_this_extension",
      value: proxyConfig(f.state.session),
    };
    f.changed.emit(f.state.regular);
    await f.settle();
    f.start("new-generation");
    pending.resolve();
    await f.settle();

    await expect(f.challenge("before-route-change")).resolves.toEqual({ cancel: true });
    expect((await f.challenge("new-generation")).authCredentials).toEqual({
      username: f.state.session.username,
      password: f.state.session.password,
    });
  });

  it("uses the current session after recovery without authorizing an earlier unknown request", async () => {
    const f = fixture({ initialFailure: "settings" });
    await f.settle();
    const pending = deferred();
    f.get.mockImplementationOnce(async () => {
      await pending.promise;
      return structuredClone(f.state.regular);
    });
    f.state.now += 1_000;
    f.start("before-session-rotation");
    await f.settle();
    f.state.session = proxySession("same-endpoint-rotation");
    pending.resolve();
    await f.settle();

    await expect(f.challenge("before-session-rotation")).resolves.toEqual({ cancel: true });
    f.start("current-session");
    expect((await f.challenge("current-session")).authCredentials).toEqual({
      username: f.state.session.username,
      password: f.state.session.password,
    });
  });
});
