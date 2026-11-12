// SPDX-License-Identifier: MPL-2.0

import { ProxyAuthHandler, type ProxyAuthDetails } from "../../../src/core/background/proxy-auth";
import { proxyConfig } from "../../../src/core/background/proxy-controller";
import { NOW, proxySession } from "../../common/helpers";

const MAX_TRACKED_REQUESTS = 4_096;

function event<T>() {
  let listener: ((details: T) => unknown) | undefined;
  return {
    addListener: (value: typeof listener) => (listener = value),
    emit: (details: T) => listener?.(details),
  };
}

function fixture() {
  const session = proxySession();
  const before = event<{ requestId: string; tabId: number }>();
  const completed = event<{ requestId: string }>();
  const failed = event<{ requestId: string }>();
  vi.stubGlobal("browser", {
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
      onAuthRequired: { addListener: () => undefined },
      onCompleted: completed,
      onErrorOccurred: failed,
    },
  });
  const handler = new ProxyAuthHandler({
    getSession: async () => session,
    isConfiguredProxyChallenge: async () => true,
    wasUsedProxyChallenge: async () => true,
    isSessionCurrent: () => true,
    now: () => NOW,
  });
  handler.register();
  const ending = { completed, failed };
  return {
    session,
    start: (requestId: string) => before.emit({ requestId, tabId: 1 }),
    end: (kind: keyof typeof ending, requestId: string) => ending[kind].emit({ requestId }),
    challenge: (requestId: string) =>
      handler.handle({
        isProxy: true,
        requestId,
        tabId: 1,
        challenger: { host: session.host, port: session.port },
        proxyInfo: { type: "https", host: session.host, port: session.port },
      } as ProxyAuthDetails),
    // The bound is internal bookkeeping: no Firefox event exposes its size.
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

describe("Firefox proxy authentication attempt bookkeeping", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("bounds the attempt records of requests which never finish", async () => {
    const f = fixture();
    for (let index = 0; index <= MAX_TRACKED_REQUESTS; index++) {
      const requestId = `unfinished-${String(index)}`;
      f.start(requestId);
      expect((await f.challenge(requestId)).authCredentials).toBeDefined();
    }

    expect(f.tracked()).toEqual({
      started: MAX_TRACKED_REQUESTS,
      attempted: MAX_TRACKED_REQUESTS,
    });
  });

  it("still cancels the repeated challenge of a request whose provenance was evicted", async () => {
    const f = fixture();
    f.start("long-lived");
    expect((await f.challenge("long-lived")).authCredentials).toBeDefined();

    // Newer requests push its provenance out of the bound; its attempt record stays.
    for (let index = 0; index < MAX_TRACKED_REQUESTS; index++) f.start(`newer-${String(index)}`);
    expect(f.tracked()).toEqual({ started: MAX_TRACKED_REQUESTS, attempted: 1 });

    // The proxy refused those credentials: they are not offered a second time.
    await expect(f.challenge("long-lived")).resolves.toEqual({ cancel: true });
  });

  it.each(["completed", "failed"] as const)(
    "removes the attempt record with its provenance on %s",
    async (ending) => {
      const f = fixture();
      f.start("finished");
      expect((await f.challenge("finished")).authCredentials).toBeDefined();
      expect(f.tracked()).toEqual({ started: 1, attempted: 1 });

      f.end(ending, "finished");

      expect(f.tracked()).toEqual({ started: 0, attempted: 0 });
    },
  );
});
