// SPDX-License-Identifier: MPL-2.0

import { ProxyAuthHandler, type ProxyAuthDetails } from "../../../src/core/background/proxy-auth";
import { proxyConfig } from "../../../src/core/background/proxy-controller";
import { NOW, proxySession } from "../../common/helpers";

type ProxySetting = import("../../../src/core/background/proxy-controller").ProxySettingsResult;
type Listener<T> = (details: T) => unknown;

function event<T>() {
  let listener: Listener<T> | undefined;
  return {
    addListener: (value: Listener<T>) => {
      listener = value;
    },
    emit: (value: T) => listener?.(value),
  };
}

function fixture(initialPermission?: Promise<boolean>) {
  const session = proxySession();
  const owned: ProxySetting = {
    levelOfControl: "controlled_by_this_extension",
    value: proxyConfig(session),
  };
  const foreign: ProxySetting = {
    levelOfControl: "controlled_by_other_extensions",
    value: proxyConfig(session),
  };
  const state = { regular: owned, private: owned, now: NOW, known: true };
  const before = event<{ requestId: string; tabId: number }>();
  const changed = event<ProxySetting>();
  const completed = event<{ requestId: string }>();
  const failed = event<{ requestId: string }>();
  const get = vi.fn(async ({ incognito }: { incognito?: boolean }) =>
    structuredClone(incognito ? state.private : state.regular),
  );
  const getSession = vi.fn(async () => session);
  const wasUsedProxyChallenge = vi.fn(async () => state.known);
  const permission = vi.fn(async () => initialPermission ?? true);
  const getTab = vi.fn(async (tabId: number) => ({ incognito: tabId === 2 }) as browser.tabs.Tab);
  vi.stubGlobal("browser", {
    extension: { isAllowedIncognitoAccess: permission },
    tabs: { get: getTab },
    proxy: { settings: { get, onChange: changed } },
    webRequest: {
      onBeforeRequest: before,
      onAuthRequired: { addListener: () => undefined },
      onCompleted: completed,
      onErrorOccurred: failed,
    },
  });
  const handler = new ProxyAuthHandler({
    getSession,
    isConfiguredProxyChallenge: async () =>
      state.regular.levelOfControl === "controlled_by_this_extension",
    wasUsedProxyChallenge,
    isSessionCurrent: () => true,
    now: () => state.now,
  });
  handler.register();
  const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
  const start = (requestId: string, incognito = false) =>
    before.emit({ requestId, tabId: incognito ? 2 : 1 });
  const challenge = (requestId: string) =>
    handler.handle({
      isProxy: true,
      requestId,
      challenger: { host: session.host, port: session.port },
      proxyInfo: { type: "https", host: session.host, port: session.port },
    } as ProxyAuthDetails);
  return {
    handler,
    state,
    session,
    foreign,
    get,
    getSession,
    getTab,
    wasUsedProxyChallenge,
    permission,
    before,
    changed,
    completed,
    failed,
    settle,
    start,
    challenge,
  };
}

describe("request-bound proxy authentication ownership", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("leaves an unrelated proxy immediately without waiting for FuzeVPN restoration", async () => {
    const f = fixture();
    f.state.regular = f.foreign;
    f.state.private = f.foreign;
    f.state.known = false;
    f.getSession.mockImplementation(() => new Promise(() => undefined));
    await expect(f.challenge("unrelated")).resolves.toEqual({});
    expect(f.getSession).not.toHaveBeenCalled();
  });

  it("distinguishes a delayed first 407 from a new other-extension request at the same endpoint", async () => {
    const f = fixture();
    await f.settle();
    f.start("old-fuze-request");
    f.state.regular = f.foreign;
    f.state.private = f.foreign;
    f.changed.emit(f.foreign);
    await f.settle();
    f.start("new-foreign-request");
    await expect(f.challenge("old-fuze-request")).resolves.toEqual({ cancel: true });
    await expect(f.challenge("new-foreign-request")).resolves.toEqual({});
    expect(f.getSession).not.toHaveBeenCalled();
  });

  it("recognizes a new foreign request at worker startup despite the persisted endpoint history", async () => {
    const f = fixture();
    // Firefox's initial read has not completed yet; requests share its promise.
    f.state.regular = f.foreign;
    f.state.private = f.foreign;
    f.start("startup-foreign");
    await expect(f.challenge("startup-foreign")).resolves.toEqual({});
    expect(f.getSession).not.toHaveBeenCalled();
  });

  it("does not relabel an old request when startup permission resolves after a proxy change", async () => {
    let resolvePermission!: (allowed: boolean) => void;
    const permission = new Promise<boolean>((resolve) => {
      resolvePermission = resolve;
    });
    const f = fixture(permission);
    f.start("pending-startup-fuze");
    f.state.regular = f.foreign;
    f.state.private = f.foreign;
    f.changed.emit(f.foreign);
    f.start("pending-startup-foreign");
    resolvePermission(false);

    await expect(f.challenge("pending-startup-fuze")).resolves.toEqual({ cancel: true });
    await expect(f.challenge("pending-startup-foreign")).resolves.toEqual({});
    expect(f.getSession).not.toHaveBeenCalled();
  });

  it("does not relabel an old request when settings resolve after a proxy change", async () => {
    const f = fixture();
    await f.settle();
    let resolveRead!: () => void;
    const pendingRead = new Promise<void>((resolve) => {
      resolveRead = resolve;
    });
    f.get.mockImplementation(async ({ incognito }) => {
      await pendingRead;
      return structuredClone(incognito ? f.state.private : f.state.regular);
    });
    f.changed.emit(f.state.regular);
    f.start("pending-settings-fuze");
    await f.settle();
    f.state.regular = f.foreign;
    f.state.private = f.foreign;
    f.changed.emit(f.foreign);
    f.start("pending-settings-foreign");
    resolveRead();

    await expect(f.challenge("pending-settings-fuze")).resolves.toEqual({ cancel: true });
    await expect(f.challenge("pending-settings-foreign")).resolves.toEqual({});
    expect(f.getSession).not.toHaveBeenCalled();
  });

  it("uses global ownership without resolving a tab when private-query ownership differs", async () => {
    const f = fixture();
    f.state.regular = f.foreign;
    await f.settle();
    f.start("regular", false);
    f.start("private", true);
    await expect(f.challenge("regular")).resolves.toEqual({});
    await expect(f.challenge("private")).resolves.toEqual({});
    expect(f.getTab).not.toHaveBeenCalled();
    expect(f.getSession).not.toHaveBeenCalled();
  });

  it("keeps cancellation for a preexisting request whose start preceded worker registration", async () => {
    const f = fixture();
    f.state.regular = f.foreign;
    f.state.private = f.foreign;
    await expect(f.challenge("already-in-flight")).resolves.toEqual({ cancel: true });
    expect(f.getSession).not.toHaveBeenCalled();
  });

  it("does not mistake an incognito query's not_controllable value for lost global ownership", async () => {
    const f = fixture();
    f.state.private = { ...f.state.private, levelOfControl: "not_controllable" };
    await f.settle();
    f.start("regular", false);
    f.start("private", true);
    // Once global ownership is lost, both in-flight requests remain ours to cancel.
    f.state.regular = f.foreign;
    f.changed.emit(f.foreign);
    await expect(f.challenge("regular")).resolves.toEqual({ cancel: true });
    await expect(f.challenge("private")).resolves.toEqual({ cancel: true });
    expect(f.get.mock.calls.every(([query]) => !query.incognito)).toBe(true);
    expect(f.getSession).not.toHaveBeenCalled();
  });

  it("does not overwrite original provenance when Firefox repeats onBeforeRequest for a redirect", async () => {
    const f = fixture();
    await f.settle();
    f.start("redirected");
    f.state.regular = f.foreign;
    f.state.private = f.foreign;
    f.changed.emit(f.foreign);
    await f.settle();
    f.start("redirected");
    await expect(f.challenge("redirected")).resolves.toEqual({ cancel: true });
  });

  it("treats failed route reads as unknown and still cancels remembered late challenges", async () => {
    const f = fixture();
    f.get.mockRejectedValue(new Error("settings unavailable"));
    f.state.regular = f.foreign;
    f.state.private = f.foreign;
    f.changed.emit(f.foreign);
    f.start("unknown-route");
    await expect(f.challenge("unknown-route")).resolves.toEqual({ cancel: true });
  });

  it.each([
    {
      proxyType: "autoConfig",
      autoConfigUrl: 'data:,function FindProxyForURL() { return "HTTPS proxy.example.com:443"; }',
    },
    {
      proxyType: "manual",
      http: "proxy.example.com:0",
    },
  ] satisfies browser.proxy.ProxyConfig[])(
    "keeps an unfamiliar or invalid owned configuration unknown: %j",
    async (value) => {
      const f = fixture();
      f.state.regular = { levelOfControl: "controlled_by_this_extension", value };
      f.state.private = f.state.regular;
      await f.settle();
      f.start("unfamiliar-owned-route");
      f.state.regular = f.foreign;
      f.state.private = f.foreign;
      f.changed.emit(f.foreign);
      await expect(f.challenge("unfamiliar-owned-route")).resolves.toEqual({ cancel: true });
    },
  );

  it("uses a known global foreign route in every context without querying incognito settings", async () => {
    const f = fixture();
    f.state.regular = f.foreign;
    f.get.mockImplementation(async ({ incognito }) => {
      if (incognito) throw new Error("private settings unavailable");
      return structuredClone(f.state.regular);
    });
    f.changed.emit(f.foreign);
    f.start("private-unknown", true);
    f.start("regular-known", false);
    f.before.emit({ requestId: "no-tab-unknown", tabId: -1 });
    await expect(f.challenge("private-unknown")).resolves.toEqual({});
    await expect(f.challenge("no-tab-unknown")).resolves.toEqual({});
    await expect(f.challenge("regular-known")).resolves.toEqual({});
    expect(f.get.mock.calls.every(([query]) => !query.incognito)).toBe(true);
  });

  it.each([false, "unavailable"] as const)(
    "handles private permission %s conservatively",
    async (permission) => {
      const f = fixture();
      await f.settle();
      f.get.mockClear();
      f.state.regular = f.foreign;
      f.state.private = f.foreign;
      if (permission === false) f.permission.mockResolvedValue(false);
      else f.permission.mockRejectedValue(new Error("permission unavailable"));
      f.changed.emit(f.foreign);
      f.start("permission-route");
      await expect(f.challenge("permission-route")).resolves.toEqual(
        permission === false ? {} : { cancel: true },
      );
      expect(f.get.mock.calls.every(([query]) => !query.incognito)).toBe(true);
    },
  );

  it("retains proven authentication ownership even if a request began before FuzeVPN took control", async () => {
    const f = fixture();
    const owned = f.state.regular;
    f.state.regular = f.foreign;
    f.state.private = f.foreign;
    await f.settle();
    f.start("already-authenticated");
    f.state.regular = owned;
    f.state.private = owned;
    expect((await f.challenge("already-authenticated")).authCredentials).toBeDefined();
    f.state.regular = f.foreign;
    f.state.private = f.foreign;
    f.state.known = false;
    await expect(f.challenge("already-authenticated")).resolves.toEqual({ cancel: true });
    expect(f.getSession).toHaveBeenCalledOnce();
  });

  it("shares route reads across requests and bounds expired or abandoned provenance conservatively", async () => {
    const f = fixture();
    f.state.regular = f.foreign;
    f.state.private = f.foreign;
    await f.settle();
    for (let index = 0; index < 4_097; index++) f.start(`request-${String(index)}`);
    expect(f.get).toHaveBeenCalledOnce();
    await expect(f.challenge("request-0")).resolves.toEqual({ cancel: true });
    await expect(f.challenge("request-4096")).resolves.toEqual({});
    f.state.now += 5 * 60_000;
    await expect(f.challenge("request-4096")).resolves.toEqual({ cancel: true });
    f.start("after-expiration");
    await expect(f.challenge("after-expiration")).resolves.toEqual({});
  });

  it.each(["completed", "failed"] as const)("cleans provenance on %s", async (ending) => {
    const f = fixture();
    f.state.regular = f.foreign;
    f.state.private = f.foreign;
    await f.settle();
    f.start("finished");
    await expect(f.challenge("finished")).resolves.toEqual({});
    f[ending].emit({ requestId: "finished" });
    await expect(f.challenge("finished")).resolves.toEqual({ cancel: true });
  });
});
