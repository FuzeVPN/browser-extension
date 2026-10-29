// SPDX-License-Identifier: MPL-2.0

import { afterEach, describe, expect, it, vi } from "vitest";
import { NetworkObserver } from "../../src/core/background/network-observer";
import { EMPTY_SNAPSHOT, type AppSnapshot } from "../../src/core/shared/state";

const PRIMARY = "https://api.ipify.org?format=json";
const FALLBACK = "https://ipv4.icanhazip.com/";

function setup(initial: Partial<AppSnapshot> = {}, useFallback = false) {
  let snapshot: AppSnapshot = { ...EMPTY_SNAPSHOT, status: "disconnected", ...initial };
  let now = 1_000;
  const fetcher = vi
    .fn<typeof fetch>()
    .mockImplementation(async (url) =>
      url === FALLBACK ? new Response("8.8.8.8\n") : ipResponse("8.8.8.8"),
    );
  const verifyRoute = vi.fn<(mode: "direct" | "vpn") => Promise<boolean>>().mockResolvedValue(true);
  const onChanged = vi.fn<() => void>();
  const observer = new NetworkObserver({
    getSnapshot: () => snapshot,
    fetch: fetcher,
    verifyRoute,
    onChanged,
    now: () => now,
    useFallback,
  });
  return {
    observer,
    fetcher,
    verifyRoute,
    onChanged,
    setSnapshot(changes: Partial<AppSnapshot>, notify = true) {
      snapshot = { ...snapshot, ...changes };
      if (notify) observer.observe(snapshot);
    },
    advance(ms: number) {
      now += ms;
    },
  };
}

function ipResponse(ip: string): Response {
  return new Response(JSON.stringify({ ip }));
}

function brokenBodyResponse(delayMs = 0): Response {
  let started = false;
  return new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        if (!started) {
          started = true;
          controller.enqueue(new TextEncoder().encode('{"ip":"'));
          return;
        }
        return new Promise<void>((resolve) => {
          setTimeout(() => {
            controller.error(new TypeError("Network connection terminated"));
            resolve();
          }, delayMs);
        });
      },
    }),
  );
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const VPN: Partial<AppSnapshot> = {
  status: "connected",
  protected: true,
  protectionRequested: true,
  activeLocationId: "fr-paris",
};

afterEach(() => vi.useRealTimers());

describe("network observation", () => {
  it("reads the public IP without credentials, cache, redirects or a referrer", async () => {
    const f = setup();
    f.fetcher.mockImplementation(async () => {
      f.advance(75);
      return ipResponse("8.8.8.8");
    });
    await f.observer.refresh();
    expect(f.fetcher).toHaveBeenCalledWith(PRIMARY, {
      method: "GET",
      credentials: "omit",
      cache: "no-store",
      redirect: "error",
      referrerPolicy: "no-referrer",
      signal: expect.any(AbortSignal) as AbortSignal,
    });
    expect(f.verifyRoute.mock.calls).toEqual([["direct"], ["direct"]]);
    expect(f.observer.getState()).toEqual({
      status: "ready",
      mode: "direct",
      ip: "8.8.8.8",
      locationId: null,
      latencyMs: 75,
      checkedAt: 1_075,
    });
  });

  it.each(["connected", "error"] as const)(
    "observes the effective VPN route in %s",
    async (status) => {
      const f = setup({ ...VPN, status });
      await f.observer.refresh();
      expect(f.fetcher).toHaveBeenCalledWith("https://api.ipify.org?format=json", {
        method: "GET",
        credentials: "omit",
        cache: "no-store",
        redirect: "error",
        referrerPolicy: "no-referrer",
        signal: expect.any(AbortSignal) as AbortSignal,
      });
      expect(f.verifyRoute.mock.calls).toEqual([["vpn"], ["vpn"]]);
      expect(f.observer.getState()).toMatchObject({
        status: "ready",
        mode: "vpn",
        ip: "8.8.8.8",
        locationId: "fr-paris",
      });
    },
  );

  it.each([
    { ...VPN, status: "connecting" },
    { ...VPN, status: "refreshing" },
    { ...VPN, status: "disconnecting" },
    { ...VPN, status: "blocked", trafficBlocked: true },
    { ...VPN, trafficBlocked: true },
    { ...VPN, protected: false },
    { ...VPN, activeLocationId: null },
    { status: "disconnected", protectionRequested: true },
    { status: "logged_out", trafficBlocked: true },
  ] satisfies Partial<AppSnapshot>[])(
    "does not probe an ineligible or blocked route: %j",
    async (initial) => {
      const f = setup(initial);
      await f.observer.refresh();
      expect(f.fetcher).not.toHaveBeenCalled();
      expect(f.verifyRoute).not.toHaveBeenCalled();
      expect(f.observer.getState()).toMatchObject({ status: "idle", mode: null, ip: null });
    },
  );

  it("also supports a voluntarily disconnected logged-out browser", async () => {
    const f = setup({ status: "logged_out" });
    await f.observer.refresh();
    expect(f.observer.getState()).toMatchObject({ status: "ready", mode: "direct" });
  });

  it("deduplicates requests and retries only after the 30-second TTL", async () => {
    const f = setup();
    const response = deferred<Response>();
    f.fetcher.mockReturnValueOnce(response.promise);
    const first = f.observer.refresh();
    const second = f.observer.refresh();
    expect(first).toBe(second);
    response.resolve(ipResponse("8.8.4.4"));
    await first;
    f.advance(29_999);
    await f.observer.refresh();
    expect(f.fetcher).toHaveBeenCalledTimes(1);
    f.advance(1);
    await f.observer.refresh();
    expect(f.fetcher).toHaveBeenCalledTimes(2);
  });

  it("also throttles failed observations without declaring VPN failure", async () => {
    const f = setup(VPN);
    f.fetcher.mockRejectedValue(new Error("unavailable"));
    await f.observer.refresh();
    await f.observer.refresh();
    expect(f.fetcher).toHaveBeenCalledTimes(1);
    expect(f.observer.getState()).toMatchObject({ status: "unavailable", mode: "vpn", ip: null });
  });

  it("rechecks a failed observation after five seconds while preserving the successful cache", async () => {
    const f = setup(VPN);
    f.fetcher.mockRejectedValueOnce(new Error("temporary transport failure"));
    await f.observer.refresh();
    f.advance(4_999);
    await f.observer.refresh();
    expect(f.fetcher).toHaveBeenCalledOnce();
    f.advance(1);
    await f.observer.refresh();
    expect(f.observer.getState()).toMatchObject({ status: "ready", mode: "vpn", ip: "8.8.8.8" });
    f.advance(5_000);
    await f.observer.refresh();
    expect(f.fetcher).toHaveBeenCalledTimes(2);
  });

  it.each([
    "transport",
    "408",
    "503",
    "403",
    "redirect",
    "invalid",
    "ipv6",
    "private",
    "oversized",
  ])("uses the IPv4 fallback after a primary %s failure", async (failure) => {
    const f = setup(VPN, true);
    if (failure === "transport") f.fetcher.mockRejectedValueOnce(new TypeError("Network error"));
    else if (/^\d+$/.test(failure))
      f.fetcher.mockResolvedValueOnce(new Response("", { status: Number(failure) }));
    else {
      const responses: Record<string, Response> = {
        redirect: new Response("", { status: 302 }),
        invalid: new Response("<html>error</html>"),
        ipv6: ipResponse("2606:4700:4700::1111"),
        private: ipResponse("192.168.1.1"),
        oversized: new Response(" ".repeat(1_025)),
      };
      f.fetcher.mockResolvedValueOnce(responses[failure]!);
    }
    const pending = f.observer.refresh();
    expect(f.observer.refresh()).toBe(pending);
    expect(f.observer.getState().status).toBe("checking");
    await pending;
    expect(f.observer.getState()).toMatchObject({ status: "ready", mode: "vpn", ip: "8.8.8.8" });
    expect(f.verifyRoute.mock.calls).toEqual([["vpn"], ["vpn"], ["vpn"]]);
    expect(f.fetcher.mock.calls.map(([url]) => url)).toEqual([PRIMARY, FALLBACK]);
    for (const call of f.fetcher.mock.calls) {
      expect(call[1]).toMatchObject({
        credentials: "omit",
        redirect: "error",
        cache: "no-store",
      });
    }
  });

  it("retries failed providers after five seconds without changing VPN state", async () => {
    vi.useFakeTimers();
    const f = setup(VPN, true);
    f.fetcher.mockRejectedValue(new TypeError("Network error"));
    const first = f.observer.refresh();
    await vi.advanceTimersByTimeAsync(1_500);
    await first;
    expect(f.fetcher).toHaveBeenCalledTimes(6);
    expect(f.observer.getState()).toMatchObject({ status: "unavailable", mode: "vpn", ip: null });
    await f.observer.refresh();
    expect(f.fetcher).toHaveBeenCalledTimes(6);
    f.advance(5_000);
    const retry = f.observer.refresh();
    await vi.advanceTimersByTimeAsync(1_000);
    await retry;
    expect(f.fetcher).toHaveBeenCalledTimes(12);
  });

  it("waits for a fresh VPN tunnel and recovers on the third round when it becomes ready", async () => {
    vi.useFakeTimers();
    const f = setup(VPN, true);
    const started = Date.now();
    const attempts: number[] = [];
    f.fetcher.mockImplementation(async () => {
      attempts.push(Date.now() - started);
      if (Date.now() - started < 1_200) throw new TypeError("net::ERR_TUNNEL_CONNECTION_FAILED");
      return ipResponse("8.8.4.4");
    });
    const pending = f.observer.refresh();
    await vi.advanceTimersByTimeAsync(499);
    expect(f.fetcher).not.toHaveBeenCalled();
    expect(f.verifyRoute).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(attempts).toEqual([500, 500, 1_000, 1_000]);
    expect(f.observer.getState().status).toBe("checking");
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(attempts).toEqual([500, 500, 1_000, 1_000, 1_500]);
    expect(f.verifyRoute).toHaveBeenCalledTimes(6);
    expect(f.observer.getState()).toMatchObject({
      status: "ready",
      mode: "vpn",
      ip: "8.8.4.4",
      locationId: "fr-paris",
    });
  });

  it("retries transport errors while reading provider bodies and recovers in the next round", async () => {
    vi.useFakeTimers();
    const f = setup(VPN, true);
    f.fetcher
      .mockResolvedValueOnce(brokenBodyResponse())
      .mockResolvedValueOnce(brokenBodyResponse());
    const pending = f.observer.refresh();
    await vi.advanceTimersByTimeAsync(1_010);
    await pending;
    expect(f.fetcher.mock.calls.map(([url]) => url)).toEqual([PRIMARY, FALLBACK, PRIMARY]);
    expect(f.verifyRoute).toHaveBeenCalledTimes(4);
    expect(f.observer.getState()).toMatchObject({ status: "ready", ip: "8.8.8.8" });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("limits persistent body transport errors to three rounds", async () => {
    vi.useFakeTimers();
    const f = setup(VPN, true);
    f.fetcher.mockImplementation(async () => brokenBodyResponse());
    const pending = f.observer.refresh();
    await vi.advanceTimersByTimeAsync(1_510);
    await pending;
    expect(f.fetcher).toHaveBeenCalledTimes(6);
    expect(f.observer.getState()).toMatchObject({ status: "unavailable", ip: null });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps body transport retries inside the original eight-second deadline", async () => {
    vi.useFakeTimers();
    const f = setup(VPN, true);
    f.fetcher.mockImplementation(async () => brokenBodyResponse(2_500));
    const pending = f.observer.refresh();
    await vi.advanceTimersByTimeAsync(7_999);
    expect(f.observer.getState().status).toBe("checking");
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(f.fetcher.mock.calls.map(([url]) => url)).toEqual([PRIMARY, FALLBACK, PRIMARY]);
    expect(f.observer.getState()).toMatchObject({ status: "unavailable", ip: null });
    expect(f.fetcher.mock.calls.every(([, options]) => options?.signal?.aborted)).toBe(true);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(f.fetcher).toHaveBeenCalledTimes(3);
  });

  it("stops body transport recovery when route verification is refused", async () => {
    vi.useFakeTimers();
    const f = setup(VPN, true);
    f.fetcher.mockImplementation(async () => brokenBodyResponse());
    f.verifyRoute.mockResolvedValueOnce(true).mockResolvedValueOnce(true).mockResolvedValue(false);
    const pending = f.observer.refresh();
    await vi.advanceTimersByTimeAsync(1_010);
    await pending;
    expect(f.fetcher).toHaveBeenCalledTimes(2);
    expect(f.verifyRoute).toHaveBeenCalledTimes(3);
    expect(f.observer.getState()).toMatchObject({ status: "unavailable", ip: null });
  });

  it("does not repeat the initial delay when refreshing an already measured VPN route", async () => {
    vi.useFakeTimers();
    const f = setup(VPN, true);
    const first = f.observer.refresh();
    await vi.advanceTimersByTimeAsync(500);
    await first;
    f.advance(30_000);
    const pending = f.observer.refresh();
    expect(f.observer.getState()).toMatchObject({ status: "checking", ip: "8.8.8.8" });
    await vi.advanceTimersByTimeAsync(0);
    await pending;
    expect(f.fetcher).toHaveBeenCalledTimes(2);
    expect(f.observer.getState()).toMatchObject({ status: "ready", ip: "8.8.8.8" });
  });

  it("cancels the initial VPN wait without sending a request", async () => {
    vi.useFakeTimers();
    const f = setup(VPN, true);
    const pending = f.observer.refresh();
    await vi.advanceTimersByTimeAsync(499);
    f.setSnapshot({ status: "disconnecting", protected: false });
    await pending;
    await vi.advanceTimersByTimeAsync(2_000);
    expect(f.fetcher).not.toHaveBeenCalled();
    expect(f.observer.getState()).toMatchObject({ status: "idle", ip: null });
  });

  it("cancels between VPN retry rounds without sending another request", async () => {
    vi.useFakeTimers();
    const f = setup(VPN, true);
    f.fetcher.mockRejectedValue(new TypeError("net::ERR_TUNNEL_CONNECTION_FAILED"));
    const pending = f.observer.refresh();
    await vi.advanceTimersByTimeAsync(500);
    expect(f.fetcher).toHaveBeenCalledTimes(2);
    f.setSnapshot({ status: "disconnecting", protected: false });
    await pending;
    await vi.advanceTimersByTimeAsync(2_000);
    expect(f.fetcher).toHaveBeenCalledTimes(2);
    expect(f.observer.getState()).toMatchObject({ status: "idle", ip: null });
  });

  it.each(["invalid", "ipv6", "private", "429", "503", "oversized", "utf8"])(
    "does not repeat providers returning %s within the VPN retry loop",
    async (failure) => {
      vi.useFakeTimers();
      const f = setup(VPN, true);
      f.fetcher.mockImplementation(async (url) => {
        if (failure === "429") return new Response("", { status: 429 });
        if (failure === "503") return new Response("", { status: 503 });
        if (failure === "oversized") return new Response(" ".repeat(1_025));
        if (failure === "utf8") return new Response(new Uint8Array([0xff]));
        const body =
          failure === "ipv6"
            ? "2606:4700:4700::1111"
            : failure === "private"
              ? "192.168.1.1"
              : "invalid";
        return url === PRIMARY ? ipResponse(body) : new Response(body);
      });
      const pending = f.observer.refresh();
      await vi.advanceTimersByTimeAsync(1_500);
      await pending;
      expect(f.fetcher.mock.calls.map(([url]) => url)).toEqual([PRIMARY, FALLBACK]);
      expect(f.observer.getState()).toMatchObject({ status: "unavailable", ip: null });
    },
  );

  it("retries only the transport-failed provider after a malformed response from the other", async () => {
    vi.useFakeTimers();
    const f = setup(VPN, true);
    f.fetcher
      .mockResolvedValueOnce(ipResponse("2606:4700:4700::1111"))
      .mockRejectedValueOnce(new TypeError("net::ERR_TUNNEL_CONNECTION_FAILED"));
    const pending = f.observer.refresh();
    await vi.advanceTimersByTimeAsync(1_000);
    await pending;
    expect(f.fetcher.mock.calls.map(([url]) => url)).toEqual([PRIMARY, FALLBACK, FALLBACK]);
    expect(f.observer.getState()).toMatchObject({ status: "ready", ip: "8.8.8.8" });
  });

  it("keeps direct observations and manual diagnostics free of VPN startup waits and retry rounds", async () => {
    vi.useFakeTimers();
    const diagnostic = setup(VPN);
    diagnostic.fetcher.mockRejectedValue(new TypeError("net::ERR_TUNNEL_CONNECTION_FAILED"));
    await diagnostic.observer.refresh();
    expect(diagnostic.fetcher).toHaveBeenCalledOnce();
    const direct = setup({}, true);
    direct.fetcher.mockRejectedValue(new TypeError("net::ERR_TUNNEL_CONNECTION_FAILED"));
    await direct.observer.refresh();
    expect(direct.fetcher.mock.calls.map(([url]) => url)).toEqual([PRIMARY, FALLBACK]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("refuses the fallback when the proxy can no longer be verified", async () => {
    const f = setup(VPN, true);
    f.fetcher.mockRejectedValueOnce(new TypeError("Network error"));
    f.verifyRoute.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    await f.observer.refresh();
    expect(f.fetcher).toHaveBeenCalledOnce();
    expect(f.verifyRoute).toHaveBeenCalledTimes(2);
    expect(f.observer.getState().ip).toBeNull();
  });

  it.each([
    [null, 30_000],
    ["invalid", 30_000],
    ["60", 60_000],
    [new Date(61_000).toUTCString(), 60_000],
  ] as const)("respects IP-service throttling with Retry-After %j", async (retryAfter, cacheMs) => {
    const f = setup(VPN);
    f.fetcher.mockResolvedValueOnce(
      new Response("", {
        status: 429,
        headers: retryAfter ? { "retry-after": retryAfter } : {},
      }),
    );
    await f.observer.refresh();
    f.advance(cacheMs - 1);
    await f.observer.refresh();
    expect(f.fetcher).toHaveBeenCalledOnce();
    f.advance(1);
    await f.observer.refresh();
    expect(f.fetcher).toHaveBeenCalledTimes(2);
    expect(f.observer.getState().status).toBe("ready");
  });

  it("does not use the fallback when final proxy verification fails", async () => {
    const f = setup(VPN, true);
    f.verifyRoute.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    await f.observer.refresh();
    expect(f.fetcher).toHaveBeenCalledOnce();
    expect(f.observer.getState().ip).toBeNull();
  });

  it("does not use the fallback after a route change during the primary request", async () => {
    const f = setup(VPN, true);
    const response = deferred<Response>();
    f.fetcher.mockReturnValueOnce(response.promise);
    const pending = f.observer.refresh();
    await vi.waitFor(() => expect(f.fetcher).toHaveBeenCalledOnce());
    f.setSnapshot({ status: "disconnecting", protected: false });
    await pending;
    response.resolve(ipResponse("1.1.1.1"));
    expect(f.fetcher).toHaveBeenCalledOnce();
    expect(f.observer.getState()).toMatchObject({ status: "idle", mode: null, ip: null });
  });

  it("bounds a delayed fallback route check and request by the total eight-second deadline", async () => {
    vi.useFakeTimers();
    const f = setup(VPN, true);
    f.fetcher
      .mockRejectedValueOnce(new TypeError("Network error"))
      .mockReturnValueOnce(new Promise<Response>(() => undefined));
    f.verifyRoute
      .mockResolvedValueOnce(true)
      .mockImplementationOnce(
        () => new Promise((resolve) => setTimeout(() => resolve(true), 6_000)),
      );
    const pending = f.observer.refresh();
    await vi.advanceTimersByTimeAsync(7_999);
    expect(f.observer.getState().status).toBe("checking");
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(f.fetcher).toHaveBeenCalledTimes(2);
    expect(f.fetcher.mock.calls[1]?.[1]?.signal?.aborted).toBe(true);
    expect(f.observer.getState()).toMatchObject({ status: "unavailable", ip: null });
  });

  it.each(["fetch", "body"])(
    "uses the fallback after a primary %s hangs for three seconds",
    async (stage) => {
      vi.useFakeTimers();
      const f = setup(VPN, true);
      const cancel = vi.fn();
      if (stage === "fetch") f.fetcher.mockReturnValueOnce(new Promise<Response>(() => undefined));
      else
        f.fetcher.mockResolvedValueOnce(new Response(new ReadableStream<Uint8Array>({ cancel })));
      const pending = f.observer.refresh();
      await vi.advanceTimersByTimeAsync(3_499);
      expect(f.fetcher).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(1);
      await pending;
      expect(f.fetcher.mock.calls.map(([url]) => url)).toEqual([PRIMARY, FALLBACK]);
      expect(f.fetcher.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
      if (stage === "body") expect(cancel).toHaveBeenCalledOnce();
      expect(f.observer.getState()).toMatchObject({ status: "ready", ip: "8.8.8.8" });
    },
  );

  it("finishes after both providers hang without exceeding their three-second budgets", async () => {
    vi.useFakeTimers();
    const f = setup(VPN, true);
    f.fetcher.mockReturnValue(new Promise<Response>(() => undefined));
    const pending = f.observer.refresh();
    await vi.advanceTimersByTimeAsync(6_499);
    expect(f.observer.getState().status).toBe("checking");
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(f.fetcher).toHaveBeenCalledTimes(2);
    expect(f.fetcher.mock.calls.every(([, options]) => options?.signal?.aborted)).toBe(true);
    expect(f.observer.getState()).toMatchObject({ status: "unavailable", ip: null });
  });

  it("ignores a late primary reply after its timeout and successful fallback", async () => {
    vi.useFakeTimers();
    const f = setup(VPN, true);
    const response = deferred<Response>();
    f.fetcher.mockReturnValueOnce(response.promise);
    const pending = f.observer.refresh();
    await vi.advanceTimersByTimeAsync(3_500);
    await pending;
    response.resolve(ipResponse("1.1.1.1"));
    await vi.advanceTimersByTimeAsync(0);
    expect(f.observer.getState()).toMatchObject({ status: "ready", ip: "8.8.8.8" });
  });

  it("retains the IPv4 only while refreshing the same route and clears it on final failure", async () => {
    const f = setup(VPN, true);
    await f.observer.refresh();
    f.advance(30_000);
    const response = deferred<Response>();
    f.fetcher
      .mockReturnValueOnce(response.promise)
      .mockResolvedValueOnce(new Response("", { status: 503 }));
    const pending = f.observer.refresh();
    expect(f.observer.getState()).toMatchObject({ status: "checking", ip: "8.8.8.8" });
    response.resolve(new Response("", { status: 503 }));
    await pending;
    expect(f.observer.getState()).toMatchObject({ status: "unavailable", ip: null });
  });

  it("uses the plaintext fallback in direct mode too", async () => {
    const f = setup({}, true);
    f.fetcher.mockRejectedValueOnce(new Error("offline"));
    await f.observer.refresh();
    expect(f.fetcher.mock.calls.map(([url]) => url)).toEqual([PRIMARY, FALLBACK]);
    expect(f.observer.getState()).toMatchObject({ status: "ready", mode: "direct", ip: "8.8.8.8" });
  });

  it.each(["2606:4700:4700::1111", "192.168.1.1", "not-an-ip", '{"ip":"8.8.8.8"}'])(
    "rejects an invalid fallback body: %s",
    async (body) => {
      const f = setup(VPN, true);
      f.fetcher
        .mockResolvedValueOnce(new Response("", { status: 503 }))
        .mockResolvedValueOnce(new Response(body));
      await f.observer.refresh();
      expect(f.observer.getState()).toMatchObject({ status: "unavailable", ip: null });
    },
  );

  it("keeps provider cooldowns across route changes and uses the other provider", async () => {
    const f = setup(VPN, true);
    f.fetcher.mockResolvedValueOnce(
      new Response("", { status: 429, headers: { "retry-after": "60" } }),
    );
    await f.observer.refresh();
    f.setSnapshot({
      protected: false,
      protectionRequested: false,
      status: "disconnected",
      activeLocationId: null,
    });
    await f.observer.refresh();
    expect(f.fetcher.mock.calls.map(([url]) => url)).toEqual([PRIMARY, FALLBACK, FALLBACK]);
    f.advance(60_000);
    f.setSnapshot(VPN);
    await f.observer.refresh();
    expect(f.fetcher.mock.calls.at(-1)?.[0]).toBe(PRIMARY);
    expect(f.observer.getState()).toMatchObject({ status: "ready", mode: "vpn", ip: "8.8.8.8" });
  });

  it("retries an available fallback after five seconds while the primary is cooling down", async () => {
    vi.useFakeTimers();
    const f = setup(VPN, true);
    f.fetcher
      .mockResolvedValueOnce(new Response("", { status: 429, headers: { "retry-after": "60" } }))
      .mockRejectedValueOnce(new Error("offline"))
      .mockRejectedValueOnce(new Error("offline"))
      .mockRejectedValueOnce(new Error("offline"));
    const first = f.observer.refresh();
    await vi.advanceTimersByTimeAsync(1_500);
    await first;
    f.advance(4_999);
    await f.observer.refresh();
    expect(f.fetcher).toHaveBeenCalledTimes(4);
    f.advance(1);
    await f.observer.refresh();
    expect(f.fetcher.mock.calls.map(([url]) => url)).toEqual([
      PRIMARY,
      FALLBACK,
      FALLBACK,
      FALLBACK,
      FALLBACK,
    ]);
    expect(f.observer.getState().status).toBe("ready");
  });

  it("waits for the earliest provider cooldown when both providers return 429", async () => {
    const f = setup(VPN, true);
    f.fetcher
      .mockResolvedValueOnce(new Response("", { status: 429, headers: { "retry-after": "60" } }))
      .mockResolvedValueOnce(new Response("", { status: 429, headers: { "retry-after": "30" } }));
    await f.observer.refresh();
    f.advance(29_999);
    await f.observer.refresh();
    expect(f.fetcher).toHaveBeenCalledTimes(2);
    f.advance(1);
    await f.observer.refresh();
    expect(f.fetcher.mock.calls.map(([url]) => url)).toEqual([PRIMARY, FALLBACK, FALLBACK]);
    expect(f.observer.getState().status).toBe("ready");
  });

  it.each([
    ["ipv4.icanhazip.com", false, true, "vpn", false],
    ["icanhazip.com", true, true, "vpn", false],
    ["icanhazip.com", false, true, "vpn", true],
    ["other.icanhazip.com", true, true, "vpn", true],
    ["icanhazip.com", true, false, "vpn", true],
    ["icanhazip.com", true, true, "direct", true],
  ] as const)(
    "respects fallback exclusion %s (subdomains %s, enabled %s, mode %s)",
    async (domain, includeSubdomains, enabled, mode, allowed) => {
      const exclusions = structuredClone(EMPTY_SNAPSHOT.siteExclusions);
      exclusions.applied = { revision: 1, enabled, entries: [{ domain, includeSubdomains }] };
      const f = setup({ ...(mode === "vpn" ? VPN : {}), siteExclusions: exclusions }, true);
      f.fetcher.mockImplementation(async (url) => {
        if (url === PRIMARY) throw new Error("offline");
        return new Response("8.8.8.8\n");
      });
      await f.observer.refresh();
      expect(f.fetcher.mock.calls.map(([url]) => url)).toEqual(
        allowed ? [PRIMARY, FALLBACK] : [PRIMARY, PRIMARY, PRIMARY],
      );
      expect(f.observer.getState().status).toBe(allowed ? "ready" : "unavailable");
    },
  );

  it("discards a delayed fallback reply after switching VPN locations", async () => {
    const f = setup(VPN, true);
    const response = deferred<Response>();
    f.fetcher.mockRejectedValueOnce(new Error("offline")).mockReturnValueOnce(response.promise);
    const old = f.observer.refresh();
    await vi.waitFor(() => expect(f.fetcher).toHaveBeenCalledTimes(2));
    f.setSnapshot({ status: "connecting" });
    f.setSnapshot({ ...VPN, activeLocationId: "de-berlin" });
    await f.observer.refresh();
    response.resolve(new Response("1.1.1.1\n"));
    await old;
    expect(f.fetcher.mock.calls[1]?.[1]?.signal?.aborted).toBe(true);
    expect(f.observer.getState()).toMatchObject({
      status: "ready",
      ip: "8.8.8.8",
      locationId: "de-berlin",
    });
  });

  it("stops without a fallback when route verification throws", async () => {
    const f = setup(VPN, true);
    f.verifyRoute.mockRejectedValueOnce(new Error("inspection failed"));
    await f.observer.refresh();
    expect(f.fetcher).not.toHaveBeenCalled();
    expect(f.observer.getState()).toMatchObject({ status: "unavailable", ip: null });
  });

  it("refuses an unverified route before sending any request", async () => {
    const f = setup(VPN);
    f.verifyRoute.mockResolvedValue(false);
    await f.observer.refresh();
    expect(f.fetcher).not.toHaveBeenCalled();
    expect(f.observer.getState().status).toBe("unavailable");
  });

  it("discards a response when the route cannot be verified afterward", async () => {
    const f = setup(VPN);
    f.verifyRoute.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    await f.observer.refresh();
    expect(f.observer.getState()).toMatchObject({ status: "unavailable", ip: null });
  });

  it.each(["8.8.8.8", "1.1.1.1"])("accepts a direct public IPv4 address: %s", async (ip) => {
    const f = setup();
    f.fetcher.mockResolvedValue(ipResponse(ip));
    await f.observer.refresh();
    expect(f.observer.getState().status).toBe("ready");
    expect(f.observer.getState().ip).toBe(ip);
  });

  it.each(["2606:4700:4700::1111", "2001:4860:4860:0:0:0:0:8888"])(
    "rejects an IPv6 result in direct and VPN observations: %s",
    async (ip) => {
      for (const initial of [{}, VPN]) {
        const f = setup(initial);
        f.fetcher.mockResolvedValue(ipResponse(ip));
        await f.observer.refresh();
        expect(f.fetcher).toHaveBeenCalledTimes(1);
        expect(f.fetcher.mock.calls[0]?.[0]).toBe(PRIMARY);
        expect(f.observer.getState()).toMatchObject({
          status: "unavailable",
          ip: null,
          latencyMs: null,
        });
      }
    },
  );

  it.each([
    "",
    " 8.8.8.8",
    "8.8.8.8\n",
    "8.008.8.8",
    "256.8.8.8",
    "8.8.8",
    "0.0.0.0",
    "10.0.0.1",
    "127.0.0.1",
    "169.254.1.1",
    "172.16.1.1",
    "192.168.1.1",
    "100.64.0.1",
    "192.0.2.1",
    "198.51.100.1",
    "203.0.113.1",
    "198.18.0.1",
    "224.0.0.1",
    "255.255.255.255",
    "::",
    "::1",
    "fc00::1",
    "fe80::1",
    "ff02::1",
    "2001:db8::1",
    "::ffff:127.0.0.1",
    "2001:::1",
    "[2606:4700:4700::1111]",
    "2606:4700:4700::1111%en0",
    "3fff::1",
    "<img src=x onerror=alert(1)>",
  ])("rejects a malformed or non-public address: %j", async (ip) => {
    const f = setup();
    f.fetcher.mockResolvedValue(ipResponse(ip));
    await f.observer.refresh();
    expect(f.observer.getState()).toMatchObject({ status: "unavailable", ip: null });
  });

  it.each(["null", "[]", '"8.8.8.8"', "{}", '{"ip":88}', "<html>error</html>"])(
    "rejects an invalid JSON response: %s",
    async (body) => {
      const f = setup();
      f.fetcher.mockResolvedValue(new Response(body));
      await f.observer.refresh();
      expect(f.observer.getState().status).toBe("unavailable");
    },
  );

  it("rejects an HTTP failure and never follows a redirect response", async () => {
    for (const response of [
      new Response("unavailable", { status: 503 }),
      new Response("", { status: 302 }),
    ]) {
      const f = setup();
      f.fetcher.mockResolvedValue(response);
      await f.observer.refresh();
      expect(f.observer.getState().status).toBe("unavailable");
    }
    const f = setup();
    const response = ipResponse("8.8.8.8");
    Object.defineProperty(response, "redirected", { value: true });
    f.fetcher.mockResolvedValue(response);
    await f.observer.refresh();
    expect(f.observer.getState().status).toBe("unavailable");
  });

  it("bounds the response even when the server does not declare its size", async () => {
    const f = setup();
    const cancel = vi.fn();
    f.fetcher.mockResolvedValue(
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(" ".repeat(1_025)));
          },
          cancel,
        }),
      ),
    );
    await f.observer.refresh();
    expect(f.observer.getState().status).toBe("unavailable");
    expect(cancel).toHaveBeenCalled();
  });

  it("rejects a declared oversized body before reading it", async () => {
    const f = setup();
    f.fetcher.mockResolvedValue(
      new Response('{"ip":"8.8.8.8"}', { headers: { "content-length": "2048" } }),
    );
    await f.observer.refresh();
    expect(f.observer.getState().status).toBe("unavailable");
  });

  it.each(["fetch", "body", "route"])(
    "enforces the 8-second deadline while waiting for %s",
    async (stage) => {
      vi.useFakeTimers();
      const f = setup();
      if (stage === "fetch") f.fetcher.mockReturnValue(new Promise<Response>(() => undefined));
      if (stage === "body")
        f.fetcher.mockResolvedValue(new Response(new ReadableStream<Uint8Array>()));
      if (stage === "route") f.verifyRoute.mockReturnValue(new Promise<boolean>(() => undefined));
      const pending = f.observer.refresh();
      await vi.advanceTimersByTimeAsync(8_000);
      await pending;
      expect(f.observer.getState()).toMatchObject({ status: "unavailable", ip: null });
      if (stage !== "route") expect(f.fetcher.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    },
  );

  it("discards a delayed VPN A result after A to B to A and cancels its request", async () => {
    const f = setup(VPN);
    const response = deferred<Response>();
    f.fetcher.mockReturnValueOnce(response.promise);
    const old = f.observer.refresh();
    await vi.waitFor(() => expect(f.fetcher).toHaveBeenCalledOnce());
    const oldSignal = f.fetcher.mock.calls[0]?.[1]?.signal;
    f.setSnapshot({ status: "connecting" });
    f.setSnapshot({ status: "connected", activeLocationId: "de-berlin" });
    f.setSnapshot({ status: "connecting" });
    f.setSnapshot({ status: "connected", activeLocationId: "fr-paris" });
    expect(oldSignal?.aborted).toBe(true);
    expect(f.observer.getState()).toMatchObject({ status: "idle", ip: null });
    f.fetcher.mockResolvedValueOnce(ipResponse("1.1.1.1"));
    await f.observer.refresh();
    response.resolve(ipResponse("8.8.4.4"));
    await old;
    expect(f.observer.getState()).toMatchObject({
      status: "ready",
      ip: "1.1.1.1",
      locationId: "fr-paris",
    });
  });

  it("clears a personal IP immediately when connecting and clears VPN IP when disconnecting", async () => {
    const f = setup();
    await f.observer.refresh();
    f.setSnapshot({ status: "connecting", protectionRequested: true });
    expect(f.observer.getState()).toMatchObject({ status: "idle", mode: null, ip: null });
    f.setSnapshot(VPN);
    await f.observer.refresh();
    f.setSnapshot({ status: "disconnecting", protected: false });
    expect(f.observer.getState()).toMatchObject({ status: "idle", mode: null, ip: null });
  });

  it("invalidates on renewal and on account identity changes", async () => {
    const f = setup(VPN);
    await f.observer.refresh();
    f.setSnapshot({ status: "refreshing" });
    expect(f.observer.getState().ip).toBeNull();
    f.setSnapshot({ status: "connected" });
    f.fetcher.mockResolvedValueOnce(ipResponse("8.8.4.4"));
    await f.observer.refresh();
    f.setSnapshot({
      profile: {
        userId: "user-b",
        email: "b@example.invalid",
        firstName: "",
        lastName: "",
        countryCode: "FR",
      },
    });
    expect(f.observer.getState().ip).toBeNull();
  });

  it.each(["direct", "vpn"] as const)(
    "clears a cached %s observation on an exclusion error and measures again after recovery",
    async (mode) => {
      const f = setup(mode === "vpn" ? VPN : {});
      await f.observer.refresh();
      expect(f.observer.getState().ip).toBe("8.8.8.8");
      const exclusions = structuredClone(EMPTY_SNAPSHOT.siteExclusions);
      f.setSnapshot({ siteExclusions: { ...exclusions, error: true } });
      expect(f.observer.getState()).toMatchObject({ status: "idle", mode: null, ip: null });
      await f.observer.refresh();
      expect(f.fetcher).toHaveBeenCalledTimes(1);

      f.setSnapshot({ siteExclusions: exclusions });
      f.fetcher.mockResolvedValueOnce(ipResponse("1.1.1.1"));
      await f.observer.refresh();
      expect(f.fetcher).toHaveBeenCalledTimes(2);
      expect(f.observer.getState()).toMatchObject({ status: "ready", mode, ip: "1.1.1.1" });
    },
  );

  it.each([true, false])(
    "discards a pending measurement when only the exclusion error changes (notified: %s)",
    async (notify) => {
      const f = setup(VPN);
      const response = deferred<Response>();
      f.fetcher.mockReturnValueOnce(response.promise);
      const pending = f.observer.refresh();
      await vi.waitFor(() => expect(f.fetcher).toHaveBeenCalledOnce());
      f.setSnapshot(
        { siteExclusions: { ...structuredClone(EMPTY_SNAPSHOT.siteExclusions), error: true } },
        notify,
      );
      response.resolve(ipResponse("8.8.8.8"));
      await pending;
      expect(f.fetcher.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
      expect(f.observer.getState()).toMatchObject({ status: "idle", mode: null, ip: null });
    },
  );

  it("guards the current snapshot even before an observe notification arrives", async () => {
    const f = setup(VPN);
    const response = deferred<Response>();
    f.fetcher.mockReturnValueOnce(response.promise);
    const pending = f.observer.refresh();
    await Promise.resolve();
    await Promise.resolve();
    f.setSnapshot({ status: "blocked", protected: false, trafficBlocked: true }, false);
    response.resolve(ipResponse("8.8.8.8"));
    await pending;
    expect(f.observer.getState()).toMatchObject({ status: "idle", mode: null, ip: null });
  });

  it("returns a copy so the UI cannot mutate the observation", async () => {
    const f = setup();
    await f.observer.refresh();
    const copy = f.observer.getState();
    copy.ip = "127.0.0.1";
    expect(f.observer.getState().ip).toBe("8.8.8.8");
  });
});
