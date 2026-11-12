// SPDX-License-Identifier: MPL-2.0

import type { ProxySession } from "../../../src/core/api/types";
import { ProxyAuthHandler, type ProxyAuthDetails } from "../../../src/core/background/proxy-auth";
import { NOW, authenticatedState, createHarness, proxySession } from "../../common/helpers";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function challenge(session: ProxySession, requestId: string) {
  return {
    isProxy: true,
    requestId,
    tabId: 1,
    challenger: { host: session.host, port: session.port },
    proxyInfo: { type: "https", host: session.host, port: session.port },
  } as ProxyAuthDetails;
}

/** One request whose credentials the proxy refuses: a first 407, then a repeated one. */
async function refuse(handler: ProxyAuthHandler, session: ProxySession, requestId: string) {
  expect((await handler.handle(challenge(session, requestId))).authCredentials).toEqual({
    username: session.username,
    password: session.password,
  });
  await expect(handler.handle(challenge(session, requestId))).resolves.toEqual({ cancel: true });
}

describe("a proxy session refused again after its first rejection report", () => {
  afterEach(() => vi.restoreAllMocks());

  it("reports the later rejection of a session its owner kept", async () => {
    const session = proxySession();
    const onAuthenticationFailure = vi.fn(async () => undefined);
    const handler = new ProxyAuthHandler({
      getSession: async () => session,
      isConfiguredProxyChallenge: async () => true,
      wasUsedProxyChallenge: async () => true,
      isSessionCurrent: () => true,
      onAuthenticationFailure,
      now: () => NOW,
    });

    await refuse(handler, session, "first");
    await vi.waitFor(() => expect(onAuthenticationFailure).toHaveBeenCalledOnce());
    await onAuthenticationFailure.mock.results[0]?.value;

    // The owner handled that report and kept the session, which is refused again.
    await refuse(handler, session, "second");
    await vi.waitFor(() => expect(onAuthenticationFailure).toHaveBeenCalledTimes(2));
  });

  it("fails a session whose first report the controller dropped for a permission event", async () => {
    const h = createHarness({ persisted: authenticatedState() });
    await h.controller.initialize();
    expect(await h.controller.connect("frankfurt-01")).toEqual({ ok: true });
    const session = (await h.controller.getActiveSession())!;
    const onAuthenticationFailure = vi.fn((refused: ProxySession) =>
      h.controller.handleProxyAuthenticationFailure(refused),
    );
    const handler = new ProxyAuthHandler({
      getSession: () => h.controller.getActiveSession(),
      isConfiguredProxyChallenge: (challenger) => h.proxy.isConfiguredProxyChallenge(challenger),
      wasUsedProxyChallenge: async () => true,
      isSessionCurrent: (candidate) => h.controller.isSessionCurrentForProxyAuth(candidate),
      onAuthenticationFailure,
      now: () => NOW,
    });

    // The controller is verifying the reported session when a permission event arrives.
    const verifying = deferred();
    const release = deferred();
    const isActiveConfiguration = h.proxy.isActiveConfiguration.bind(h.proxy);
    vi.spyOn(h.proxy, "isActiveConfiguration").mockImplementationOnce(async (candidate) => {
      verifying.resolve();
      await release.promise;
      return isActiveConfiguration(candidate);
    });
    const suspend = vi.spyOn(h.safety, "suspend");
    await refuse(handler, session, "first");
    await verifying.promise;
    const permissions = h.controller.handleProxyPermissionsChanged();
    await vi.waitFor(() => expect(suspend).toHaveBeenCalled());
    release.resolve();
    await permissions;
    await onAuthenticationFailure.mock.results[0]?.value;

    // The permission check superseded the report and retained the session.
    expect(onAuthenticationFailure).toHaveBeenCalledOnce();
    expect(h.controller.getSnapshot()).toMatchObject({
      status: "connected",
      protected: true,
      error: null,
    });
    expect((await h.controller.getActiveSession())?.id).toBe(session.id);
    expect(h.controller.isSessionCurrentForProxyAuth(session)).toBe(true);

    // The proxy still refuses those credentials on the next request.
    await refuse(handler, session, "second");
    await vi.waitFor(() => expect(onAuthenticationFailure).toHaveBeenCalledTimes(2));
    await onAuthenticationFailure.mock.results[1]?.value;
    expect(h.controller.getSnapshot()).toMatchObject({
      protected: false,
      error: "proxy_authentication_failed",
    });
  });

  it("fails the session on its first undisturbed report", async () => {
    const h = createHarness({ persisted: authenticatedState() });
    await h.controller.initialize();
    expect(await h.controller.connect("frankfurt-01")).toEqual({ ok: true });
    const session = (await h.controller.getActiveSession())!;
    const onAuthenticationFailure = vi.fn((refused: ProxySession) =>
      h.controller.handleProxyAuthenticationFailure(refused),
    );
    const handler = new ProxyAuthHandler({
      getSession: () => h.controller.getActiveSession(),
      isConfiguredProxyChallenge: (challenger) => h.proxy.isConfiguredProxyChallenge(challenger),
      wasUsedProxyChallenge: async () => true,
      isSessionCurrent: (candidate) => h.controller.isSessionCurrentForProxyAuth(candidate),
      onAuthenticationFailure,
      now: () => NOW,
    });

    await refuse(handler, session, "first");
    await vi.waitFor(() => expect(onAuthenticationFailure).toHaveBeenCalledOnce());
    await onAuthenticationFailure.mock.results[0]?.value;

    expect(h.controller.getSnapshot()).toMatchObject({
      protected: false,
      error: "proxy_authentication_failed",
    });
    expect(h.controller.isSessionCurrentForProxyAuth(session)).toBe(false);
  });
});
