// SPDX-License-Identifier: MPL-2.0

import type { ProxySession } from "../../../src/core/api/types";
import { ProxyAuthHandler } from "../../../src/platform/chromium/proxy-auth";
import { PlatformProxyService, proxyConfig } from "../../../src/platform/chromium/proxy-controller";
import { NOW, proxySession } from "./helpers";

type AuthListener = Parameters<typeof chrome.webRequest.onAuthRequired.addListener>[0];

const MAX_TRACKED_REQUESTS = 4_096;

function event<T>() {
  let listener: ((details: T) => unknown) | undefined;
  return {
    addListener: (value: typeof listener) => (listener = value),
    emit: (details: T) => listener?.(details),
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function fixture() {
  const session = proxySession();
  const before = event<{ requestId: string; tabId: number }>();
  const completed = event<{ requestId: string }>();
  const failed = event<{ requestId: string }>();
  let authListener: AuthListener | undefined;
  vi.stubGlobal("chrome", {
    extension: { isAllowedIncognitoAccess: async () => false },
    proxy: {
      settings: {
        get: async () => ({
          levelOfControl: "controlled_by_this_extension",
          value: proxyConfig(session),
        }),
        onChange: event(),
      },
    },
    webRequest: {
      onBeforeRequest: before,
      onAuthRequired: { addListener: (value: AuthListener) => (authListener = value) },
      onCompleted: completed,
      onErrorOccurred: failed,
    },
  });
  const proxy = new PlatformProxyService();
  const getSession = vi.fn(async (): Promise<ProxySession | null> => session);
  const onAuthenticationFailure = vi.fn(async () => undefined);
  const handler = new ProxyAuthHandler({
    getSession,
    isConfiguredProxyChallenge: (challenger) => proxy.isConfiguredProxyChallenge(challenger),
    wasUsedProxyChallenge: async () => true,
    isSessionCurrent: (candidate) => candidate === session,
    onAuthenticationFailure,
    now: () => NOW,
  });
  handler.register();
  const details = (requestId: string) =>
    ({
      isProxy: true,
      requestId,
      tabId: 1,
      challenger: { host: session.host, port: session.port },
    }) as chrome.webRequest.OnAuthRequiredDetails;
  const ending = { completed, failed };
  return {
    handler,
    session,
    getSession,
    onAuthenticationFailure,
    settle: () => new Promise<void>((resolve) => setImmediate(resolve)),
    start: (requestId: string) => before.emit({ requestId, tabId: 1 }),
    end: (kind: keyof typeof ending, requestId: string) => ending[kind].emit({ requestId }),
    challenge: (requestId: string) => handler.handle(details(requestId)),
    // Answers through Chrome's asyncBlocking callback, including its final guard.
    dispatch: (requestId: string) => {
      if (!authListener) throw new Error("authentication listener not registered");
      const response = deferred<chrome.webRequest.BlockingResponse>();
      authListener(details(requestId), response.resolve);
      return response.promise;
    },
    // The bound is internal bookkeeping: no Chrome event exposes its size.
    tracked: () => {
      const internals = handler as unknown as {
        startedRequests: ReadonlyMap<string, unknown>;
        attemptedSessionsByRequest: ReadonlyMap<string, unknown>;
      };
      return {
        started: internals.startedRequests.size,
        attempted: internals.attemptedSessionsByRequest.size,
      };
    },
  };
}

describe("Chromium proxy authentication after terminal request cleanup", () => {
  afterEach(() => vi.unstubAllGlobals());

  it.each(["completed", "failed"] as const)(
    "cancels an outstanding credential callback after %s cleaned its request",
    async (ending) => {
      const f = fixture();
      await f.settle();
      f.start("ended-while-restoring");
      const restoring = deferred<ProxySession | null>();
      f.getSession.mockReturnValueOnce(restoring.promise);
      const response = f.dispatch("ended-while-restoring");
      await f.settle();
      expect(f.getSession).toHaveBeenCalledOnce();

      f.end(ending, "ended-while-restoring");
      restoring.resolve(f.session);

      await expect(response).resolves.toEqual({ cancel: true });
      // No attempt is recorded after the terminal event that would have removed it.
      expect(f.tracked()).toEqual({ started: 0, attempted: 0 });
      f.start("later-request");
      expect((await f.dispatch("later-request")).authCredentials).toEqual({
        username: f.session.username,
        password: f.session.password,
      });
    },
  );

  it("cancels a credential response whose request ends before the asyncBlocking callback", async () => {
    const f = fixture();
    await f.settle();
    f.start("ended-before-callback");
    const handle = f.handler.handle.bind(f.handler);
    vi.spyOn(f.handler, "handle").mockImplementation(async (details) => {
      const result = await handle(details);
      expect(result.authCredentials).toBeDefined();
      f.end("failed", details.requestId);
      return result;
    });

    await expect(f.dispatch("ended-before-callback")).resolves.toEqual({ cancel: true });
  });

  it("cancels a pending credential response when its provenance is evicted", async () => {
    const f = fixture();
    await f.settle();
    f.start("evicted-while-restoring");
    const restoring = deferred<ProxySession | null>();
    f.getSession.mockReturnValueOnce(restoring.promise);
    const response = f.dispatch("evicted-while-restoring");
    await f.settle();
    expect(f.getSession).toHaveBeenCalledOnce();

    for (let index = 0; index < MAX_TRACKED_REQUESTS; index++) f.start(`newer-${String(index)}`);
    restoring.resolve(f.session);

    await expect(response).resolves.toEqual({ cancel: true });
    expect(f.tracked()).toEqual({ started: MAX_TRACKED_REQUESTS, attempted: 0 });
  });
});

describe("Chromium proxy authentication attempt bookkeeping", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("evicts attempt records together with abandoned request provenance", async () => {
    const f = fixture();
    await f.settle();
    for (let index = 0; index <= MAX_TRACKED_REQUESTS; index++) {
      const requestId = `unfinished-${String(index)}`;
      f.start(requestId);
      expect((await f.challenge(requestId)).authCredentials).toBeDefined();
    }

    expect(f.tracked()).toEqual({
      started: MAX_TRACKED_REQUESTS,
      attempted: MAX_TRACKED_REQUESTS,
    });
    // Without provenance an evicted request stays cancel-only, never re-authenticated.
    await expect(f.challenge("unfinished-0")).resolves.toEqual({ cancel: true });
    // A retained request still gets one attempt per session and reports its rejection.
    await expect(f.challenge(`unfinished-${String(MAX_TRACKED_REQUESTS)}`)).resolves.toEqual({
      cancel: true,
    });
    await f.settle();
    expect(f.onAuthenticationFailure).toHaveBeenCalledOnce();
    expect(f.getSession).toHaveBeenCalledTimes(MAX_TRACKED_REQUESTS + 2);
  });

  it.each(["completed", "failed"] as const)(
    "removes the attempt record with its provenance on %s",
    async (ending) => {
      const f = fixture();
      await f.settle();
      f.start("finished");
      expect((await f.challenge("finished")).authCredentials).toBeDefined();
      expect(f.tracked()).toEqual({ started: 1, attempted: 1 });

      f.end(ending, "finished");

      expect(f.tracked()).toEqual({ started: 0, attempted: 0 });
      await expect(f.challenge("finished")).resolves.toEqual({ cancel: true });
    },
  );
});
