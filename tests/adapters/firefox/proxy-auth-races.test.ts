// SPDX-License-Identifier: MPL-2.0

import type { ProxySession } from "../../../src/core/api/types";
import {
  ProxyAuthHandler,
  type ProxyAuthDependencies,
  type ProxyAuthDetails,
} from "../../../src/core/background/proxy-auth";
import { NOW, authenticatedState, createHarness, proxySession } from "../../common/helpers";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function authDetails(overrides: Partial<ProxyAuthDetails> = {}): ProxyAuthDetails {
  return {
    thirdParty: false,
    requestId: "late-proxy-request",
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
    ...overrides,
  };
}

function dependencies(overrides: Partial<ProxyAuthDependencies> = {}): ProxyAuthDependencies {
  return {
    getSession: async () => proxySession(),
    isConfiguredProxyChallenge: async () => true,
    wasUsedProxyChallenge: async () => true,
    isSessionCurrent: () => true,
    now: () => NOW,
    ...overrides,
  };
}

describe("late proxy authentication", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("cancels a remembered proxy challenge that starts after disconnect cleared the proxy", async () => {
    const handler = new ProxyAuthHandler(
      dependencies({
        getSession: async () => null,
        isConfiguredProxyChallenge: async () => false,
        isSessionCurrent: () => false,
      }),
    );

    await expect(handler.handle(authDetails())).resolves.toEqual({ cancel: true });
  });

  it("cancels a remembered proxy challenge even if session storage is unavailable after logout", async () => {
    const handler = new ProxyAuthHandler(
      dependencies({
        getSession: async () => Promise.reject(new Error("session storage unavailable")),
        isConfiguredProxyChallenge: async () => false,
        isSessionCurrent: () => false,
      }),
    );

    await expect(handler.handle(authDetails())).resolves.toEqual({ cancel: true });
  });

  it("uses remembered endpoints only for cancellation, never to authorize credentials", async () => {
    const handler = new ProxyAuthHandler(
      dependencies({ isConfiguredProxyChallenge: async () => false }),
    );

    await expect(handler.handle(authDetails())).resolves.toEqual({ cancel: true });
  });

  it("leaves an unrelated proxy challenge to Chrome", async () => {
    const handler = new ProxyAuthHandler(
      dependencies({
        getSession: async () => null,
        isConfiguredProxyChallenge: async () => false,
        wasUsedProxyChallenge: async () => false,
        isSessionCurrent: () => false,
      }),
    );

    await expect(
      handler.handle(authDetails({ challenger: { host: "work.example.com", port: 8080 } })),
    ).resolves.toEqual({});
  });

  it("does not cancel website authentication at a remembered proxy host", async () => {
    const getSession = vi.fn(async () => proxySession());
    const wasUsedProxyChallenge = vi.fn(async () => true);
    const handler = new ProxyAuthHandler(dependencies({ getSession, wasUsedProxyChallenge }));

    await expect(handler.handle(authDetails({ isProxy: false }))).resolves.toEqual({});
    expect(getSession).not.toHaveBeenCalled();
    expect(wasUsedProxyChallenge).not.toHaveBeenCalled();
  });

  it("cancels a delayed challenge from the previous location after switching locations", async () => {
    const replacement = {
      ...proxySession("new-session", "frankfurt-02"),
      host: "frankfurt-02.proxy.vpn1euro.com",
    };
    const handler = new ProxyAuthHandler(
      dependencies({
        getSession: async () => replacement,
        isConfiguredProxyChallenge: async () => false,
      }),
    );

    await expect(handler.handle(authDetails())).resolves.toEqual({ cancel: true });
  });

  it("rejects credentials invalidated while the final proxy ownership check is pending", async () => {
    const checking = deferred<undefined>();
    const ownership = deferred<boolean>();
    let checks = 0;
    let current = true;
    const handler = new ProxyAuthHandler(
      dependencies({
        isConfiguredProxyChallenge: async () => {
          if (++checks === 1) return true;
          checking.resolve(undefined);
          return ownership.promise;
        },
        isSessionCurrent: () => current,
      }),
    );

    const response = handler.handle(authDetails());
    await checking.promise;
    current = false;
    ownership.resolve(true);

    await expect(response).resolves.toEqual({ cancel: true });
  });

  it("checks expiration again after the final proxy ownership check", async () => {
    const session = proxySession();
    const checking = deferred<undefined>();
    const ownership = deferred<boolean>();
    let checks = 0;
    let now = NOW;
    const handler = new ProxyAuthHandler(
      dependencies({
        getSession: async () => session,
        isConfiguredProxyChallenge: async () => {
          if (++checks === 1) return true;
          checking.resolve(undefined);
          return ownership.promise;
        },
        now: () => now,
      }),
    );

    const response = handler.handle(authDetails());
    await checking.promise;
    now = Date.parse(session.expiresAt);
    ownership.resolve(true);

    await expect(response).resolves.toEqual({ cancel: true });
  });

  it("rejects a malformed expiration date", async () => {
    const handler = new ProxyAuthHandler(
      dependencies({ getSession: async () => ({ ...proxySession(), expiresAt: "invalid" }) }),
    );

    await expect(handler.handle(authDetails())).resolves.toEqual({ cancel: true });
  });

  it("still supplies credentials for a verified current session", async () => {
    const session = proxySession();
    const handler = new ProxyAuthHandler(dependencies({ getSession: async () => session }));

    await expect(handler.handle(authDetails())).resolves.toEqual({
      authCredentials: { username: session.username, password: session.password },
    });
  });

  it.each(["disconnect", "expiration"] as const)(
    "revalidates credentials before Chrome receives the callback after %s",
    async (event) => {
      type AuthListener = Parameters<typeof browser.webRequest.onAuthRequired.addListener>[0];
      let listener: AuthListener | undefined;
      vi.stubGlobal("browser", {
        extension: { isAllowedIncognitoAccess: async () => false },
        proxy: {
          settings: {
            get: async () => ({
              value: { proxyType: "none" },
              levelOfControl: "controllable_by_this_extension",
            }),
            onChange: { addListener: () => undefined },
          },
        },
        webRequest: {
          onBeforeRequest: { addListener: () => undefined },
          onAuthRequired: {
            addListener: (registered: AuthListener) => {
              listener = registered;
            },
          },
          onCompleted: { addListener: () => undefined },
          onErrorOccurred: { addListener: () => undefined },
        },
      });
      const session = proxySession();
      let current = true;
      let now = NOW;
      const handler = new ProxyAuthHandler(
        dependencies({
          getSession: async (): Promise<ProxySession> => session,
          isSessionCurrent: () => current,
          now: () => now,
        }),
      );
      const handle = handler.handle.bind(handler);
      vi.spyOn(handler, "handle").mockImplementation(async (details) => {
        const result = await handle(details);
        expect(result.authCredentials).toBeDefined();
        if (event === "disconnect") current = false;
        else now = Date.parse(session.expiresAt);
        return result;
      });
      handler.register();
      if (!listener) throw new Error("authentication listener not registered");
      const response = deferred<browser.webRequest.BlockingResponse>();
      void listener(authDetails(), response.resolve);

      await expect(response.promise).resolves.toEqual({ cancel: true });
    },
  );
});

describe("controller proxy authentication validity", () => {
  it("invalidates captured credentials before an asynchronous proxy clear completes", async () => {
    const harness = createHarness({ persisted: authenticatedState() });
    await harness.controller.initialize();
    await harness.controller.connect("frankfurt-01");
    const captured = await harness.controller.getActiveSession();
    if (!captured) throw new Error("connected session missing");
    expect(harness.controller.isSessionCurrentForProxyAuth(captured)).toBe(true);

    const clearing = deferred<undefined>();
    const release = deferred<undefined>();
    const clear = harness.proxy.clear.bind(harness.proxy);
    vi.spyOn(harness.proxy, "clear").mockImplementation(async () => {
      clearing.resolve(undefined);
      await release.promise;
      await clear();
    });

    const disconnecting = harness.controller.disconnect();
    await clearing.promise;
    try {
      expect(harness.proxy.active?.id).toBe(captured.id);
      expect(harness.controller.getSnapshot().status).toBe("disconnecting");
      expect(harness.controller.isSessionCurrentForProxyAuth(captured)).toBe(false);
      await expect(harness.controller.getActiveSession()).resolves.toBeNull();
    } finally {
      release.resolve(undefined);
      await disconnecting;
    }
  });

  it("rejects captured sessions after replacement or expiration without waiting for an alarm", async () => {
    const original = proxySession("original-session");
    const replacement = proxySession("replacement-session", "frankfurt-02");
    const harness = createHarness({ persisted: authenticatedState() });
    harness.api.sessions = [original, replacement];
    await harness.controller.initialize();
    await harness.controller.connect("frankfurt-01");
    const capturedOriginal = await harness.controller.getActiveSession();
    if (!capturedOriginal) throw new Error("original session missing");
    expect(harness.controller.isSessionCurrentForProxyAuth(capturedOriginal)).toBe(true);

    await harness.controller.changeLocation("frankfurt-02");
    const capturedReplacement = await harness.controller.getActiveSession();
    if (!capturedReplacement) throw new Error("replacement session missing");
    expect(capturedReplacement.id).toBe(replacement.id);
    expect(harness.controller.isSessionCurrentForProxyAuth(capturedOriginal)).toBe(false);
    expect(harness.controller.isSessionCurrentForProxyAuth(capturedReplacement)).toBe(true);

    harness.setNow(Date.parse(capturedReplacement.expiresAt));
    expect(harness.controller.isSessionCurrentForProxyAuth(capturedReplacement)).toBe(false);
    expect(harness.controller.isSessionCurrentForProxyAuth(capturedOriginal)).toBe(false);
  });

  it("accepts valid transient startup credentials while full initialization is still pending", async () => {
    const session = proxySession("startup-session");
    const harness = createHarness({
      persisted: authenticatedState({ autoConnect: true }),
      transient: { proxySession: session, refreshAttempts: 0, retiredSessions: [] },
      activeProxy: session,
    });
    const reading = deferred<undefined>();
    const release = deferred<undefined>();
    const readPersisted = harness.storage.readPersisted.bind(harness.storage);
    vi.spyOn(harness.storage, "readPersisted").mockImplementation(async () => {
      reading.resolve(undefined);
      await release.promise;
      return readPersisted();
    });
    let initialized = false;
    const initializing = harness.controller.initialize().then(() => {
      initialized = true;
    });
    await reading.promise;
    try {
      const restored = await harness.controller.getActiveSession();
      if (!restored) throw new Error("transient startup credentials missing");
      expect(initialized).toBe(false);
      expect(restored.id).toBe(session.id);
      expect(harness.controller.isSessionCurrentForProxyAuth(restored)).toBe(true);
      const handler = new ProxyAuthHandler(
        dependencies({
          getSession: () => harness.controller.getActiveSession(),
          isSessionCurrent: (candidate) =>
            harness.controller.isSessionCurrentForProxyAuth(candidate),
          isConfiguredProxyChallenge: (challenger) =>
            harness.proxy.isConfiguredProxyChallenge(challenger),
        }),
      );
      await expect(handler.handle(authDetails())).resolves.toEqual({
        authCredentials: { username: session.username, password: session.password },
      });
    } finally {
      release.resolve(undefined);
      await initializing;
    }
    expect(harness.controller.getSnapshot().protected).toBe(true);
  });
});
