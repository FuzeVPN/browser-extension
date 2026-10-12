// SPDX-License-Identifier: MPL-2.0

import { readDiagnosticProbe } from "../../src/core/diagnostics/probe";
import { EMPTY_NETWORK_OBSERVATION } from "../../src/core/shared/network";
import { EMPTY_SNAPSHOT, type AppSnapshot } from "../../src/core/shared/state";

function fixture(initial: Partial<AppSnapshot> = {}) {
  const snapshot: AppSnapshot = {
    ...structuredClone(EMPTY_SNAPSHOT),
    status: "disconnected",
    ...initial,
  };
  let now = 1_000;
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => {
    now += 25;
    return new Response('{"ip":"8.8.8.8"}');
  });
  const verifyRoute = vi.fn<(mode: "direct" | "vpn") => Promise<boolean>>().mockResolvedValue(true);
  const run = () =>
    readDiagnosticProbe({
      getSnapshot: () => snapshot,
      verifyRoute,
      fetch: fetcher,
      now: () => now,
    });
  return { snapshot, fetcher, verifyRoute, run };
}

afterEach(() => vi.useRealTimers());

describe("isolated manual diagnostic probe", () => {
  it.each(["refused", "rejected"] as const)(
    "does not fetch or invent failure when route verification is %s",
    async (result) => {
      const f = fixture();
      if (result === "refused") f.verifyRoute.mockResolvedValue(false);
      else f.verifyRoute.mockRejectedValue(new Error("sensitive inspection details"));
      expect(await f.run()).toEqual(EMPTY_NETWORK_OBSERVATION);
      expect(f.fetcher).not.toHaveBeenCalled();
    },
  );

  it.each(["refused", "rejected"] as const)(
    "discards the observed response when final route verification is %s",
    async (result) => {
      const f = fixture();
      f.verifyRoute.mockResolvedValueOnce(true);
      if (result === "refused") f.verifyRoute.mockResolvedValueOnce(false);
      else f.verifyRoute.mockRejectedValueOnce(new Error("sensitive inspection details"));
      expect(await f.run()).toEqual(EMPTY_NETWORK_OBSERVATION);
      expect(f.fetcher).toHaveBeenCalledOnce();
      expect(f.verifyRoute).toHaveBeenCalledTimes(2);
    },
  );

  it.each([
    { status: "blocked", trafficBlocked: true },
    {
      status: "connected",
      protected: true,
      protectionRequested: true,
      trafficBlocked: true,
      activeLocationId: "synthetic-node",
    },
    { status: "disconnected", protectionRequested: true },
  ] satisfies Partial<AppSnapshot>[])("does not fetch an ineligible route %j", async (snapshot) => {
    const f = fixture(snapshot);
    expect(await f.run()).toEqual(EMPTY_NETWORK_OBSERVATION);
    expect(f.verifyRoute).not.toHaveBeenCalled();
    expect(f.fetcher).not.toHaveBeenCalled();
  });

  it("preserves a real network failure as unavailable", async () => {
    const f = fixture();
    f.fetcher.mockRejectedValue(new Error("synthetic network failure"));
    expect(await f.run()).toMatchObject({ status: "unavailable", ip: null, latencyMs: null });
    expect(f.fetcher).toHaveBeenCalledOnce();
  });

  it.each(["initial", "final"] as const)(
    "does not invent a network failure when %s route verification never completes",
    async (phase) => {
      vi.useFakeTimers();
      const f = fixture();
      if (phase === "final") f.verifyRoute.mockResolvedValueOnce(true);
      f.verifyRoute.mockImplementation(() => new Promise(() => undefined));
      const pending = f.run();
      await vi.advanceTimersByTimeAsync(8_000);
      expect(await pending).toEqual(EMPTY_NETWORK_OBSERVATION);
      expect(f.fetcher).toHaveBeenCalledTimes(phase === "initial" ? 0 : 1);
      expect(f.verifyRoute).toHaveBeenCalledTimes(phase === "initial" ? 1 : 2);
    },
  );

  it.each(["request", "body"] as const)(
    "preserves a bounded %s timeout as unavailable",
    async (phase) => {
      vi.useFakeTimers();
      const f = fixture();
      let requestSignal: AbortSignal | null | undefined;
      let responseCancelled = false;
      f.fetcher.mockImplementation((_url, init) => {
        requestSignal = init?.signal;
        return phase === "request"
          ? new Promise(() => undefined)
          : Promise.resolve(
              new Response(
                new ReadableStream<Uint8Array>({
                  cancel() {
                    responseCancelled = true;
                  },
                }),
              ),
            );
      });
      const pending = f.run();
      await vi.advanceTimersByTimeAsync(8_000);
      expect(await pending).toMatchObject({ status: "unavailable", ip: null });
      expect(f.fetcher).toHaveBeenCalledOnce();
      expect(requestSignal?.aborted).toBe(true);
      if (phase === "body") expect(responseCancelled).toBe(true);
    },
  );

  it("takes a fresh observation for each manual run without mutating the VPN snapshot", async () => {
    const f = fixture({
      status: "connected",
      protected: true,
      protectionRequested: true,
      activeLocationId: "synthetic-node",
    });
    const before = structuredClone(f.snapshot);
    expect(await f.run()).toMatchObject({ status: "ready", mode: "vpn", latencyMs: 25 });
    f.verifyRoute.mockResolvedValue(false);
    expect(await f.run()).toEqual(EMPTY_NETWORK_OBSERVATION);
    expect(f.fetcher).toHaveBeenCalledOnce();
    expect(f.verifyRoute).toHaveBeenCalledTimes(3);
    expect(f.snapshot).toEqual(before);
    expect(f.fetcher.mock.calls[0]).toEqual([
      "https://api.ipify.org?format=json",
      expect.objectContaining({
        credentials: "omit",
        cache: "no-store",
        redirect: "error",
        referrerPolicy: "no-referrer",
      }),
    ]);
  });

  it("discards a response when the route became blocked during HTTP", async () => {
    const f = fixture();
    f.fetcher.mockImplementation(async () => {
      f.snapshot.trafficBlocked = true;
      f.snapshot.status = "blocked";
      return new Response('{"ip":"8.8.8.8"}');
    });
    expect(await f.run()).toEqual(EMPTY_NETWORK_OBSERVATION);
    expect(f.fetcher).toHaveBeenCalledOnce();
  });
});
