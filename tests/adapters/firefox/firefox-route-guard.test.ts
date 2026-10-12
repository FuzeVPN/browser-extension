// SPDX-License-Identifier: MPL-2.0

import {
  PlatformRouteGuard,
  type GuardedRequest,
  type RouteGuardState,
} from "../../../src/core/background/route-guard";

const ROOT = "moz-extension://bca3eea0-32d4-497c-bd3b-4ae589202204/";
const endpoint = { host: "proxy.fuzevpn.example", port: 443 };
const proxyInfo = { type: "https", ...endpoint };
const current = () => true;

function fixture(
  initial: RouteGuardState = { mode: "proxy", endpoint, exclusions: [], isCurrent: current },
) {
  let state = initial;
  const readState = vi.fn(async () => state);
  const guard = new PlatformRouteGuard({
    readState,
    extensionRoot: () => ROOT,
    restoreTimeoutMs: 100,
  });
  return {
    guard,
    readState,
    setState: (next: RouteGuardState) => {
      state = next;
    },
  };
}

function request(change: Partial<GuardedRequest> = {}): GuardedRequest {
  return { url: "https://example.com/", type: "main_frame", ...change };
}

describe("Firefox actual request route guard", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("registers both blocking listeners synchronously without reading storage", () => {
    const onBeforeRequest = { addListener: vi.fn() };
    const onBeforeSendHeaders = { addListener: vi.fn() };
    vi.stubGlobal("browser", { webRequest: { onBeforeRequest, onBeforeSendHeaders } });
    const { guard, readState } = fixture();
    guard.register();
    for (const event of [onBeforeRequest, onBeforeSendHeaders]) {
      expect(event.addListener).toHaveBeenCalledWith(
        expect.any(Function),
        {
          urls: ["http://*/*", "https://*/*", "ws://*/*", "wss://*/*"],
        },
        ["blocking"],
      );
    }
    expect(readState).not.toHaveBeenCalled();
  });

  it("holds a wakeup request until local policy is restored", async () => {
    const { guard, readState } = fixture();
    let complete!: (value: RouteGuardState) => void;
    readState.mockImplementation(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    let settled = false;
    const response = guard.decide(request({ proxyInfo }), true).then((result) => {
      settled = true;
      return result;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    complete({ mode: "proxy", endpoint, exclusions: [], isCurrent: current });
    await expect(response).resolves.toEqual({});
  });

  it("defers absent proxy information only until the before-headers check", async () => {
    const { guard } = fixture();
    await expect(guard.decide(request(), false)).resolves.toEqual({});
    await expect(guard.decide(request(), true)).resolves.toEqual({ cancel: true });
    await expect(guard.decide(request({ proxyInfo }), true)).resolves.toEqual({});
  });

  it.each([
    { type: "direct" },
    null,
    { type: "http", ...endpoint },
    { type: "socks", ...endpoint },
    { type: "https", host: "other.example", port: 443 },
    { type: "https", host: endpoint.host, port: 80 },
    { type: "https", host: endpoint.host, port: "443" },
  ])("cancels an explicit wrong route both before and after resolution: %j", async (wrong) => {
    const { guard } = fixture();
    for (const resolved of [false, true])
      await expect(guard.decide(request({ proxyInfo: wrong }), resolved)).resolves.toEqual({
        cancel: true,
      });
  });

  it.each(["http:", "https:", "ws:", "wss:"])(
    "requires the expected proxy for %s",
    async (protocol) => {
      const { guard } = fixture();
      await expect(
        guard.decide(request({ url: `${protocol}//example.com/` }), true),
      ).resolves.toEqual({ cancel: true });
      await expect(
        guard.decide(request({ url: `${protocol}//example.com/`, proxyInfo }), true),
      ).resolves.toEqual({});
    },
  );

  it("lets only own exact API fetches bypass a pending restoration", async () => {
    const { guard, readState } = fixture();
    readState.mockRejectedValue(new Error("unreadable storage"));
    await expect(
      guard.decide(
        request({
          url: "https://api.fuzevpn.com:443/v1/me",
          type: "xmlhttprequest",
          originUrl: `${ROOT}background.js`,
        }),
        true,
      ),
    ).resolves.toEqual({});
    expect(readState).not.toHaveBeenCalled();
  });

  it.each([
    { type: "main_frame" },
    { type: "image" },
    { originUrl: "https://example.com/" },
    { originUrl: "moz-extension://another-extension/background.js" },
    { originUrl: undefined, documentUrl: `${ROOT}background.js` },
    { url: "http://api.fuzevpn.com/v1/me" },
    { url: "https://api.fuzevpn.com:444/v1/me" },
    { url: "https://api.fuzevpn.com./v1/me" },
    { url: "https://user@api.fuzevpn.com/v1/me" },
  ] satisfies Partial<GuardedRequest>[])(
    "does not widen the direct API exception: %j",
    async (change) => {
      const { guard } = fixture();
      await expect(
        guard.decide(
          request({
            url: "https://api.fuzevpn.com/v1/me",
            type: "xmlhttprequest",
            originUrl: `${ROOT}background.js`,
            ...change,
          }),
          true,
        ),
      ).resolves.toEqual({ cancel: true });
    },
  );

  it("blocks a redirect from an own API fetch to an unrelated direct destination", async () => {
    const { guard } = fixture();
    await expect(
      guard.decide(request({ type: "xmlhttprequest", originUrl: `${ROOT}background.js` }), true),
    ).resolves.toEqual({ cancel: true });
  });

  it("applies destination exclusions without exempting their page's other requests", async () => {
    const { guard } = fixture({
      mode: "block",
      isCurrent: current,
      exclusions: [
        { domain: "example.com", includeSubdomains: false },
        { domain: "other.com", includeSubdomains: true },
      ],
    });
    for (const host of ["example.com", "example.com.", "shop.other.com"])
      await expect(guard.decide(request({ url: `https://${host}/` }), true)).resolves.toEqual({});
    for (const host of ["shop.example.com", "example.com.evil.com", "elsewhere.com"])
      await expect(
        guard.decide(request({ url: `https://${host}/`, originUrl: "https://example.com/" }), true),
      ).resolves.toEqual({ cancel: true });
  });

  it("fails closed on invalid exclusion data instead of using it as an exception", async () => {
    const { guard } = fixture({
      mode: "block",
      isCurrent: current,
      exclusions: [{ domain: "127.0.0.1", includeSubdomains: true }],
    });
    await expect(guard.decide(request({ url: "https://127.0.0.1/" }), true)).resolves.toEqual({
      cancel: true,
    });
  });

  it("rechecks transitions before headers instead of retaining the earlier allowance", async () => {
    const { guard, setState } = fixture();
    await expect(guard.decide(request({ proxyInfo }), false)).resolves.toEqual({});
    setState({ mode: "block", exclusions: [], isCurrent: current });
    await expect(guard.decide(request({ proxyInfo }), true)).resolves.toEqual({ cancel: true });
  });

  it("rejects state invalidated while an asynchronous read was settling", async () => {
    const { guard } = fixture({ mode: "off", isCurrent: () => false });
    await expect(guard.decide(request(), true)).resolves.toEqual({ cancel: true });
  });

  it("allows ordinary direct traffic after a verified explicit release", async () => {
    const { guard } = fixture({ mode: "off", isCurrent: current });
    await expect(guard.decide(request(), true)).resolves.toEqual({});
  });

  it("fails closed on unavailable or timed-out restoration without unhandled rejection", async () => {
    vi.useFakeTimers();
    const { guard, readState } = fixture();
    readState.mockRejectedValueOnce(new Error("unreadable"));
    await expect(guard.decide(request(), true)).resolves.toEqual({ cancel: true });
    readState.mockImplementation(() => new Promise(() => undefined));
    const pending = guard.decide(request(), true);
    await vi.advanceTimersByTimeAsync(100);
    await expect(pending).resolves.toEqual({ cancel: true });
    expect(vi.getTimerCount()).toBe(0);
  });
});
