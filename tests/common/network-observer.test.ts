// SPDX-License-Identifier: MPL-2.0

import { afterEach, describe, expect, it, vi } from "vitest";
import { NetworkObserver } from "../../src/core/background/network-observer";
import { EMPTY_SNAPSHOT, type AppSnapshot } from "../../src/core/shared/state";
import { networkRouteKey } from "../../src/core/shared/network";

function setup(initial: Partial<AppSnapshot> = {}, retryTransientFailures = false) {
  let snapshot: AppSnapshot = { ...EMPTY_SNAPSHOT, status: "disconnected", ...initial };
  let now = 1_000;
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(ipResponse("8.8.8.8"));
  const verifyRoute = vi.fn<(mode: "direct" | "vpn") => Promise<boolean>>().mockResolvedValue(true);
  const onChanged = vi.fn<() => void>();
  const observer = new NetworkObserver({
    getSnapshot: () => snapshot,
    fetch: fetcher,
    verifyRoute,
    onChanged,
    now: () => now,
    retryTransientFailures,
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
  it("replaces a cached popup failure with a fresh successful diagnostic on the same route", async () => {
    const f = setup(VPN);
    f.fetcher.mockRejectedValueOnce(new TypeError("Request failed"));
    await f.observer.refresh();
    expect(f.observer.getState().status).toBe("unavailable");
    const route = networkRouteKey({ ...EMPTY_SNAPSHOT, ...VPN });
    expect(
      f.observer.acceptObservation(
        {
          status: "ready",
          mode: "vpn",
          ip: "8.8.4.4",
          checkedAt: 1_000,
          latencyMs: 371,
          locationId: "fr-paris",
        },
        route,
      ),
    ).toBe(true);
    expect(f.observer.getState()).toMatchObject({ status: "ready", ip: "8.8.4.4", latencyMs: 371 });
    await f.observer.refresh();
    expect(f.fetcher).toHaveBeenCalledOnce();
  });

  it("never adopts a diagnostic from another route or an IPv6 value", () => {
    const f = setup(VPN);
    const route = networkRouteKey({ ...EMPTY_SNAPSHOT, ...VPN });
    const result = {
      status: "ready",
      mode: "vpn",
      ip: "8.8.4.4",
      checkedAt: 1_000,
      latencyMs: 371,
      locationId: "fr-paris",
    } as const;
    expect(f.observer.acceptObservation(result, "obsolete-route")).toBe(false);
    expect(f.observer.acceptObservation({ ...result, ip: "2606:4700:4700::1111" }, route)).toBe(
      false,
    );
    f.setSnapshot({ activeLocationId: "gb-london" });
    expect(f.observer.acceptObservation(result, route)).toBe(false);
    expect(f.observer.getState().ip).toBeNull();
  });
  it("reads the public IP without credentials, cache, redirects or a referrer", async () => {
    const f = setup();
    f.fetcher.mockImplementation(async () => {
      f.advance(75);
      return ipResponse("8.8.8.8");
    });
    await f.observer.refresh();
    expect(f.fetcher).toHaveBeenCalledWith("https://api.ipify.org?format=json", {
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

  it.each(["transport", "408", "503"])(
    "recovers a temporary %s failure with one deduplicated retry through the same VPN endpoint",
    async (failure) => {
      vi.useFakeTimers();
      const f = setup(VPN, true);
      if (failure === "transport") f.fetcher.mockRejectedValueOnce(new TypeError("Network error"));
      else f.fetcher.mockResolvedValueOnce(new Response("", { status: Number(failure) }));
      const pending = f.observer.refresh();
      await vi.advanceTimersByTimeAsync(749);
      expect(f.observer.refresh()).toBe(pending);
      expect(f.fetcher).toHaveBeenCalledOnce();
      expect(f.observer.getState().status).toBe("checking");
      await vi.advanceTimersByTimeAsync(1);
      await pending;
      expect(f.observer.getState()).toMatchObject({ status: "ready", mode: "vpn", ip: "8.8.8.8" });
      expect(f.verifyRoute.mock.calls).toEqual([["vpn"], ["vpn"], ["vpn"]]);
      expect(f.fetcher).toHaveBeenCalledTimes(2);
      for (const call of f.fetcher.mock.calls) {
        expect(call[0]).toBe("https://api.ipify.org?format=json");
        expect(call[1]).toMatchObject({
          credentials: "omit",
          redirect: "error",
          cache: "no-store",
        });
      }
    },
  );

  it("limits persistent transient failures to two requests without changing VPN state", async () => {
    vi.useFakeTimers();
    const f = setup(VPN, true);
    f.fetcher.mockRejectedValue(new TypeError("Network error"));
    const pending = f.observer.refresh();
    await vi.advanceTimersByTimeAsync(750);
    await pending;
    expect(f.fetcher).toHaveBeenCalledTimes(2);
    expect(f.observer.getState()).toMatchObject({ status: "unavailable", mode: "vpn", ip: null });
    await f.observer.refresh();
    expect(f.fetcher).toHaveBeenCalledTimes(2);
  });

  it.each(["429", "redirect", "invalid", "ipv6", "oversized"])(
    "does not retry or widen the route for a %s response",
    async (kind) => {
      const f = setup(VPN, true);
      const responses: Record<string, Response> = {
        "429": new Response("", { status: 429 }),
        redirect: new Response("", { status: 302 }),
        invalid: new Response("<html>error</html>"),
        ipv6: ipResponse("2606:4700:4700::1111"),
        oversized: new Response(" ".repeat(1_025)),
      };
      f.fetcher.mockResolvedValue(responses[kind]!);
      await f.observer.refresh();
      expect(f.fetcher).toHaveBeenCalledOnce();
      expect(f.observer.getState()).toMatchObject({ status: "unavailable", mode: "vpn", ip: null });
    },
  );

  it("refuses a retry when the proxy can no longer be verified", async () => {
    vi.useFakeTimers();
    const f = setup(VPN, true);
    f.fetcher.mockRejectedValueOnce(new TypeError("Network error"));
    f.verifyRoute.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const pending = f.observer.refresh();
    await vi.advanceTimersByTimeAsync(750);
    await pending;
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
    const f = setup(VPN, true);
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

  it("does not retry a valid response whose final proxy verification fails", async () => {
    const f = setup(VPN, true);
    f.verifyRoute.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    await f.observer.refresh();
    expect(f.fetcher).toHaveBeenCalledOnce();
    expect(f.observer.getState().ip).toBeNull();
  });

  it("cancels a scheduled retry on a route change without leaking a direct request", async () => {
    vi.useFakeTimers();
    const f = setup(VPN, true);
    f.fetcher.mockRejectedValueOnce(new TypeError("Network error"));
    const pending = f.observer.refresh();
    await vi.advanceTimersByTimeAsync(749);
    f.setSnapshot({ status: "disconnecting", protected: false });
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(f.fetcher).toHaveBeenCalledOnce();
    expect(f.observer.getState()).toMatchObject({ status: "idle", mode: null, ip: null });
  });

  it("includes the retry in the original eight-second deadline", async () => {
    vi.useFakeTimers();
    const f = setup(VPN, true);
    f.fetcher
      .mockRejectedValueOnce(new TypeError("Network error"))
      .mockReturnValueOnce(new Promise<Response>(() => undefined));
    const pending = f.observer.refresh();
    await vi.advanceTimersByTimeAsync(7_999);
    expect(f.observer.getState().status).toBe("checking");
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(f.fetcher).toHaveBeenCalledTimes(2);
    expect(f.fetcher.mock.calls[1]?.[1]?.signal?.aborted).toBe(true);
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

  it.each(["8.8.8.8", "1.1.1.1"])("accepts a measured public IPv4 address: %s", async (ip) => {
    const f = setup();
    f.fetcher.mockResolvedValue(ipResponse(ip));
    await f.observer.refresh();
    expect(f.observer.getState().status).toBe("ready");
    expect(f.observer.getState().ip).toBe(
      ip.includes(":") ? new URL(`https://[${ip}]/`).hostname.slice(1, -1) : ip,
    );
  });

  it.each(["2606:4700:4700::1111", "2001:4860:4860:0:0:0:0:8888"])(
    "rejects an IPv6 result in both VPN and direct mode: %s",
    async (ip) => {
      const f = setup(VPN);
      f.fetcher.mockResolvedValue(ipResponse(ip));
      await f.observer.refresh();
      expect(f.fetcher).toHaveBeenCalledTimes(1);
      expect(f.fetcher.mock.calls[0]?.[0]).toBe("https://api.ipify.org?format=json");
      expect(f.observer.getState()).toMatchObject({
        status: "unavailable",
        mode: "vpn",
        ip: null,
        latencyMs: null,
      });
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
    await Promise.resolve();
    await Promise.resolve();
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
