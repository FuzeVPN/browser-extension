// SPDX-License-Identifier: MPL-2.0

import { NetworkObserver } from "../../src/core/background/network-observer";
import { VpnAddressBook } from "../../src/core/background/vpn-addresses";
import { EMPTY_SNAPSHOT, type AppSnapshot } from "../../src/core/shared/state";

const VPN: Partial<AppSnapshot> = {
  status: "connected",
  protected: true,
  protectionRequested: true,
  activeLocationId: "fr-paris",
};

/** The observer and its address memory, wired as the service worker wires them. */
function setup(stored?: unknown) {
  vi.useFakeTimers();
  const storage = { value: stored };
  const read = vi.fn(async () => structuredClone(storage.value));
  const write = vi.fn(async (value: unknown) => {
    storage.value = structuredClone(value);
  });
  let snapshot: AppSnapshot = { ...EMPTY_SNAPSHOT, status: "disconnected" };
  const provider = { reachable: true, ip: "8.8.4.4" };
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => {
    if (!provider.reachable) throw new TypeError("net::ERR_TUNNEL_CONNECTION_FAILED");
    return new Response(JSON.stringify({ ip: provider.ip }));
  });
  const worker = () => {
    const book = new VpnAddressBook({ storage: { read, write } });
    const shown: (string | null)[] = [];
    const observer: NetworkObserver = new NetworkObserver({
      getSnapshot: () => snapshot,
      fetch: fetcher,
      verifyRoute: async () => true,
      recall: (locationId) => book.recall(locationId),
      onChanged: () => {
        book.record(observer.getState());
        shown.push(observer.getState().ip);
      },
      useFallback: true,
    });
    return { book, observer, shown };
  };
  return {
    storage,
    provider,
    fetcher,
    read,
    write,
    worker,
    publish(changes: Partial<AppSnapshot>, observer: NetworkObserver) {
      snapshot = { ...snapshot, ...changes };
      observer.observe(snapshot);
    },
    async measure(observer: NetworkObserver) {
      const pending = observer.refresh();
      await vi.advanceTimersByTimeAsync(6_000);
      await pending;
    },
  };
}

afterEach(() => vi.useRealTimers());

describe("the remembered VPN address across measurements and workers", () => {
  it("is stored by the first measurement and displayed at once by the next worker", async () => {
    const f = setup();
    const first = f.worker();
    await first.book.initialize();
    f.publish(VPN, first.observer);
    expect(first.observer.getState().ip).toBeNull();
    await f.measure(first.observer);
    expect(first.observer.getState()).toMatchObject({ status: "ready", ip: "8.8.4.4" });
    expect(f.write).toHaveBeenCalledTimes(1);

    const next = f.worker();
    await next.book.initialize();
    f.publish(
      { status: "disconnected", protected: false, protectionRequested: false },
      next.observer,
    );
    f.publish(VPN, next.observer);
    expect(next.observer.getState()).toMatchObject({ status: "idle", ip: "8.8.4.4" });
  });

  it("does not come back after a failed measurement when the session is renewed", async () => {
    const f = setup({
      version: 1,
      addresses: [{ locationId: "fr-paris", ip: "8.8.4.4", checkedAt: Date.now() - 60_000 }],
    });
    const w = f.worker();
    await w.book.initialize();
    f.publish(VPN, w.observer);
    expect(w.observer.getState().ip).toBe("8.8.4.4");

    f.provider.reachable = false;
    await f.measure(w.observer);
    expect(w.observer.getState()).toMatchObject({ status: "unavailable", ip: null });

    // A credential renewal, an error on a still protected route, a changed exclusion
    // policy: each rebuilds the observed route.
    f.publish({ status: "refreshing" }, w.observer);
    f.publish({ status: "connected" }, w.observer);
    expect(w.observer.getState()).toMatchObject({ status: "idle", ip: null });
    f.publish({ status: "error" }, w.observer);
    expect(w.observer.getState().ip).toBeNull();

    // A later worker, such as the one a reopened popup wakes, does not show it either.
    const next = f.worker();
    await next.book.initialize();
    f.publish({ status: "connected" }, next.observer);
    expect(next.observer.getState()).toMatchObject({ status: "idle", ip: null });
  });

  it("is remembered again by the next successful measurement", async () => {
    const f = setup();
    const w = f.worker();
    await w.book.initialize();
    f.publish(VPN, w.observer);
    f.provider.reachable = false;
    await f.measure(w.observer);
    expect(w.book.recall("fr-paris")).toBeNull();

    f.provider.reachable = true;
    await vi.advanceTimersByTimeAsync(6_000);
    await f.measure(w.observer);
    expect(w.observer.getState()).toMatchObject({ status: "ready", ip: "8.8.4.4" });
    expect(w.book.recall("fr-paris")).toBe("8.8.4.4");
  });

  it("is not written again by the repeated measurements of an open popup", async () => {
    const f = setup();
    const w = f.worker();
    await w.book.initialize();
    f.publish(VPN, w.observer);
    await f.measure(w.observer);
    for (let poll = 0; poll < 4; poll++) {
      await vi.advanceTimersByTimeAsync(31_000);
      await f.measure(w.observer);
    }
    expect(f.fetcher.mock.calls.length).toBeGreaterThanOrEqual(5);
    expect(f.write).toHaveBeenCalledTimes(1);
  });

  it("is shown for a route observed before the memory was read", async () => {
    const f = setup({
      version: 1,
      addresses: [{ locationId: "fr-paris", ip: "8.8.4.4", checkedAt: Date.now() - 60_000 }],
    });
    const w = f.worker();
    // The worker restores its connection before its storage read completes.
    f.publish(VPN, w.observer);
    expect(w.observer.getState()).toMatchObject({ status: "idle", ip: null });

    await w.book.initialize();
    w.observer.remind();
    expect(w.observer.getState()).toMatchObject({ status: "idle", ip: "8.8.4.4" });
    expect(w.shown.at(-1)).toBe("8.8.4.4");
  });

  it("is not recalled by a reminder once the route was measured or failed", async () => {
    const f = setup({
      version: 1,
      addresses: [{ locationId: "fr-paris", ip: "8.8.4.4", checkedAt: Date.now() - 60_000 }],
    });
    const w = f.worker();
    f.publish(VPN, w.observer);
    f.provider.ip = "9.9.9.9";
    await w.book.initialize();
    await f.measure(w.observer);
    w.observer.remind();
    expect(w.observer.getState()).toMatchObject({ status: "ready", ip: "9.9.9.9" });

    f.publish({ status: "disconnected", protected: false, protectionRequested: false }, w.observer);
    w.observer.remind();
    expect(w.observer.getState()).toMatchObject({ mode: "direct", ip: null });
  });
});
