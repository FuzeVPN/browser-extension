// SPDX-License-Identifier: MPL-2.0

import { authenticatedState, createHarness } from "./helpers";

async function connected() {
  const h = createHarness({ persisted: authenticatedState() });
  await h.controller.connect("frankfurt-01");
  await h.controller.refreshAccount();
  return h;
}

describe("proxy TLS event provenance", () => {
  afterEach(() => vi.restoreAllMocks());

  it("blocks a TLS failure attributed to the current HTTPS proxy", async () => {
    const h = await connected();
    const session = h.proxy.active!;
    await h.controller.handleProxyError("proxy_tls_error", false, {
      host: session.host,
      port: session.port,
    });
    expect(h.controller.getSnapshot()).toMatchObject({
      protected: false,
      trafficBlocked: true,
      error: "proxy_unavailable",
    });
    expect(h.controller.isSessionCurrentForProxyAuth(session)).toBe(false);
  });

  it("ignores a TLS event from another proxy endpoint", async () => {
    const h = await connected();
    const before = h.controller.getSnapshot();
    await h.controller.handleProxyError("proxy_tls_error", false, {
      host: "retired.proxy.example",
      port: 443,
    });
    expect(h.controller.getSnapshot()).toEqual(before);
  });

  it("does not escalate a generic failed transaction with an endpoint", async () => {
    const h = await connected();
    const before = h.controller.getSnapshot();
    await h.controller.handleProxyError("NS_ERROR_PROXY_CONNECTION_REFUSED", false, {
      host: h.proxy.active!.host,
      port: h.proxy.active!.port,
    });
    expect(h.controller.getSnapshot()).toEqual(before);
  });

  it("cannot replace a newer explicit stop after asynchronous route verification", async () => {
    const h = await connected();
    const session = h.proxy.active!;
    let finishCheck!: (value: boolean) => void;
    const routeCheck = new Promise<boolean>((resolve) => {
      finishCheck = resolve;
    });
    const configured = vi.spyOn(h.proxy, "isActiveConfiguration").mockReturnValueOnce(routeCheck);
    const handling = h.controller.handleProxyError("proxy_tls_error", false, {
      host: session.host,
      port: session.port,
    });
    await vi.waitFor(() => expect(configured).toHaveBeenCalledOnce());
    const stopping = h.controller.disconnect();
    await vi.waitFor(() => expect(h.controller.getSnapshot().status).toBe("disconnecting"));
    finishCheck(true);
    await Promise.all([handling, stopping]);
    expect(h.controller.getSnapshot()).toMatchObject({
      status: "disconnected",
      protectionRequested: false,
      protected: false,
      trafficBlocked: false,
      error: null,
    });
  });
});
