// SPDX-License-Identifier: MPL-2.0

import { NetworkObserver } from "../../src/core/background/network-observer";
import type { NetworkObservation } from "../../src/core/shared/network";
import { EMPTY_SNAPSHOT, type AppSnapshot } from "../../src/core/shared/state";

const FALLBACK = "https://ipv4.icanhazip.com/";
const VPN: Partial<AppSnapshot> = {
  status: "connected",
  protected: true,
  protectionRequested: true,
  activeLocationId: "fr-paris",
};

/** What the popup writes after "VPN IP ·": an address, or nothing yet. */
function displayed(observation: NetworkObservation): string | null {
  return observation.status !== "unavailable" && observation.mode === "vpn" ? observation.ip : null;
}

/**
 * The production observer over simulated time. `tunnelReadyMs` models a tunnel which
 * refuses requests for a while after its session is created; `latencyMs` the reply of
 * an IP service once it is reachable.
 */
function setup(options: {
  remembered?: Record<string, string | null>;
  actual?: string;
  tunnelReadyMs?: number;
  latencyMs?: number;
}) {
  vi.useFakeTimers();
  const actual = options.actual ?? "8.8.4.4";
  const started = Date.now();
  let snapshot: AppSnapshot = { ...EMPTY_SNAPSHOT, status: "disconnected" };
  const elapsed = () => Date.now() - started;
  const timeline: { at: number; shown: string | null; status: string }[] = [];
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url) => {
    if (elapsed() < (options.tunnelReadyMs ?? 0))
      throw new TypeError("net::ERR_TUNNEL_CONNECTION_FAILED");
    await new Promise((resolve) => setTimeout(resolve, options.latencyMs ?? 0));
    return url === FALLBACK
      ? new Response(`${actual}\n`)
      : new Response(JSON.stringify({ ip: actual }));
  });
  const recall = vi.fn((locationId: string) => options.remembered?.[locationId] ?? null);
  const observer: NetworkObserver = new NetworkObserver({
    getSnapshot: () => snapshot,
    fetch: fetcher,
    verifyRoute: async () => true,
    onChanged: () => {
      const state = observer.getState();
      timeline.push({ at: elapsed(), shown: displayed(state), status: state.status });
    },
    recall,
    useFallback: true,
  });
  return {
    observer,
    fetcher,
    recall,
    timeline,
    elapsed,
    /** The controller publishes the connected state, then the popup asks for the address. */
    connect(changes: Partial<AppSnapshot> = VPN) {
      snapshot = { ...snapshot, ...changes };
      observer.observe(snapshot);
      return observer.refresh();
    },
    setSnapshot(changes: Partial<AppSnapshot>) {
      snapshot = { ...snapshot, ...changes };
      observer.observe(snapshot);
    },
    firstShownAt: (ip: string) => timeline.find((entry) => entry.shown === ip)?.at ?? null,
    verifiedAt: () => timeline.find((entry) => entry.status === "ready")?.at ?? null,
  };
}

afterEach(() => vi.useRealTimers());

describe("the VPN address displayed when a location is connected again", () => {
  it("is shown with the connected state, a second and a half before it can be measured", async () => {
    // A new tunnel refuses requests for 1.2 s, then an IP service answers in 300 ms.
    const f = setup({
      remembered: { "fr-paris": "8.8.4.4" },
      tunnelReadyMs: 1_200,
      latencyMs: 300,
    });
    const pending = f.connect();
    expect(displayed(f.observer.getState())).toBe("8.8.4.4");
    expect(f.observer.getState()).toMatchObject({ status: "checking", checkedAt: null });
    expect(f.fetcher).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(5_000);
    await pending;
    expect(f.firstShownAt("8.8.4.4")).toBe(0);
    expect(f.verifiedAt()).toBe(1_800);
    expect(f.observer.getState()).toMatchObject({ status: "ready", ip: "8.8.4.4" });
    // The address never disappeared between its display and its verification.
    expect(f.timeline.every((entry) => entry.shown === "8.8.4.4")).toBe(true);
  });

  it("still waits for its measurement the first time a location is used", async () => {
    const f = setup({ tunnelReadyMs: 1_200, latencyMs: 300 });
    const pending = f.connect();
    expect(displayed(f.observer.getState())).toBeNull();
    await vi.advanceTimersByTimeAsync(5_000);
    await pending;
    expect(f.firstShownAt("8.8.4.4")).toBe(1_800);
    expect(f.verifiedAt()).toBe(1_800);
  });

  it("keeps the measurement schedule unchanged", async () => {
    const attempts: number[] = [];
    const f = setup({ remembered: { "fr-paris": "8.8.4.4" }, tunnelReadyMs: 1_200 });
    f.fetcher.mockImplementation(async () => {
      attempts.push(f.elapsed());
      if (f.elapsed() < 1_200) throw new TypeError("net::ERR_TUNNEL_CONNECTION_FAILED");
      return new Response(JSON.stringify({ ip: "8.8.4.4" }));
    });
    const pending = f.connect();
    await vi.advanceTimersByTimeAsync(5_000);
    await pending;
    // The settling delay, both providers per round and the rounds are those of a
    // location used for the first time.
    expect(attempts).toEqual([500, 500, 1_000, 1_000, 1_500]);
  });

  it("is replaced by the measured address when the location changed its own", async () => {
    const f = setup({ remembered: { "fr-paris": "8.8.4.4" }, actual: "9.9.9.9", latencyMs: 100 });
    const pending = f.connect();
    expect(displayed(f.observer.getState())).toBe("8.8.4.4");
    await vi.advanceTimersByTimeAsync(5_000);
    await pending;
    expect(f.observer.getState()).toMatchObject({ status: "ready", ip: "9.9.9.9" });
    expect(f.timeline.map((entry) => entry.shown)).toEqual(["8.8.4.4", "8.8.4.4", "9.9.9.9"]);
  });

  it("is cleared by a measurement which finally fails, and not shown again on that route", async () => {
    const f = setup({
      remembered: { "fr-paris": "8.8.4.4" },
      tunnelReadyMs: Number.POSITIVE_INFINITY,
    });
    const pending = f.connect();
    expect(displayed(f.observer.getState())).toBe("8.8.4.4");
    await vi.advanceTimersByTimeAsync(5_000);
    await pending;
    expect(f.observer.getState()).toMatchObject({ status: "unavailable", ip: null });

    // The popup asks again five seconds later: the failed route shows no stale address.
    await vi.advanceTimersByTimeAsync(5_000);
    const retried = f.observer.refresh();
    expect(f.observer.getState()).toMatchObject({ status: "checking", ip: null });
    await vi.advanceTimersByTimeAsync(5_000);
    await retried;
    expect(f.timeline.at(-1)).toMatchObject({ shown: null, status: "unavailable" });
  });

  it("belongs to its location only", async () => {
    const f = setup({
      remembered: { "fr-paris": "8.8.4.4", "de-berlin": "9.9.9.9" },
      latencyMs: 100,
    });
    void f.connect();
    expect(displayed(f.observer.getState())).toBe("8.8.4.4");
    void f.connect({ ...VPN, activeLocationId: "de-berlin" });
    expect(f.observer.getState()).toMatchObject({ ip: "9.9.9.9", locationId: "de-berlin" });
    void f.connect({ ...VPN, activeLocationId: "us-newyork" });
    expect(f.observer.getState()).toMatchObject({ ip: null, locationId: "us-newyork" });
    await vi.advanceTimersByTimeAsync(5_000);
  });

  it("is never used for the direct route", async () => {
    const f = setup({ remembered: { "fr-paris": "8.8.4.4" }, actual: "1.1.1.1" });
    const pending = f.connect({ status: "disconnected", activeLocationId: "fr-paris" });
    expect(f.recall).not.toHaveBeenCalled();
    expect(f.observer.getState()).toMatchObject({ mode: "direct", ip: null });
    await vi.advanceTimersByTimeAsync(5_000);
    await pending;
    expect(f.observer.getState()).toMatchObject({ mode: "direct", ip: "1.1.1.1" });
  });

  it("is not displayed while the traffic guard or an exclusion change owns the route", () => {
    const f = setup({ remembered: { "fr-paris": "8.8.4.4" } });
    f.setSnapshot({ ...VPN, trafficBlocked: true });
    expect(f.observer.getState()).toMatchObject({ mode: null, ip: null });
    f.setSnapshot({ ...VPN, status: "connecting" });
    expect(f.observer.getState()).toMatchObject({ mode: null, ip: null });
  });

  it.each(["2606:4700:4700::1111", "192.168.1.20", "10.0.0.8", "not-an-address", ""])(
    "ignores a remembered value which is not a public IPv4: %j",
    (remembered) => {
      const f = setup({ remembered: { "fr-paris": remembered } });
      void f.connect();
      expect(f.observer.getState()).toMatchObject({ status: "checking", ip: null });
    },
  );

  it("measures normally when the memory itself fails", async () => {
    const f = setup({ latencyMs: 100 });
    f.recall.mockImplementation(() => {
      throw new Error("memory unavailable");
    });
    const pending = f.connect();
    expect(f.observer.getState()).toMatchObject({ status: "checking", ip: null });
    await vi.advanceTimersByTimeAsync(5_000);
    await pending;
    expect(f.observer.getState()).toMatchObject({ status: "ready", ip: "8.8.4.4" });
  });

  it("uses a memory loaded after the route was first observed", () => {
    const remembered: Record<string, string | null> = {};
    const f = setup({ remembered });
    f.setSnapshot(VPN);
    expect(f.observer.getState()).toMatchObject({ status: "idle", ip: null });
    remembered["fr-paris"] = "8.8.4.4";
    void f.observer.refresh();
    expect(f.observer.getState()).toMatchObject({ status: "checking", ip: "8.8.4.4" });
  });

  it("is never reported as a measurement", async () => {
    const f = setup({
      remembered: { "fr-paris": "8.8.4.4" },
      tunnelReadyMs: 1_200,
      latencyMs: 300,
    });
    const pending = f.connect();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(f.observer.getState()).toMatchObject({
      status: "checking",
      ip: "8.8.4.4",
      checkedAt: null,
      latencyMs: null,
    });
    await vi.advanceTimersByTimeAsync(5_000);
    await pending;
  });
});
