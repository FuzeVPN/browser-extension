// SPDX-License-Identifier: MPL-2.0

import { NetworkObserver } from "../../src/core/background/network-observer";
import { NetworkError } from "../../src/core/api/client";
import { MAX_REFRESH_ATTEMPTS } from "../../src/core/shared/config";
import {
  emptySiteExclusionRecord,
  type SiteExclusionRecord,
} from "../../src/core/storage/site-exclusion-storage";
import { authenticatedState, createHarness, NOW, proxySession } from "./helpers";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function observation(h: ReturnType<typeof createHarness>) {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockImplementation(async (url) =>
      (typeof url === "string" ? url : url instanceof URL ? url.href : url.url).includes(
        "icanhazip",
      )
        ? new Response("1.1.1.1\n")
        : new Response('{"ip":"1.1.1.1"}'),
    );
  // These tests exercise controller publications and observer cancellation. The
  // route-inspection contract is accepted here; native adapter checks are separate.
  const verifyRoute = vi.fn<() => Promise<boolean>>().mockResolvedValue(true);
  const observer = new NetworkObserver({
    getSnapshot: () => h.controller.getSnapshot(),
    verifyRoute,
    fetch: fetcher,
    now: () => NOW,
    useFallback: true,
    onChanged() {},
  });
  return { observer, fetcher, verifyRoute };
}

describe("network observations across guarded controller recovery", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("discards a delayed VPN reply after explicit disconnect and measures the direct route", async () => {
    const h = createHarness({ persisted: authenticatedState() });
    expect(await h.controller.connect("frankfurt-01")).toEqual({ ok: true });
    const f = observation(h);
    const late = deferred<Response>();
    f.fetcher.mockReturnValueOnce(late.promise);
    vi.useFakeTimers();
    const pending = f.observer.refresh();
    await vi.advanceTimersByTimeAsync(500);
    expect(f.fetcher).toHaveBeenCalledOnce();

    expect(await h.controller.disconnect()).toEqual({ ok: true });
    const allowsAfterDisconnect = h.safety.events.filter((event) => event === "allow").length;
    const postsAfterDisconnect = h.api.proofs.length;
    f.observer.observe(h.controller.getSnapshot());
    await f.observer.refresh();
    late.resolve(new Response('{"ip":"9.9.9.9"}'));
    await pending;
    await vi.advanceTimersByTimeAsync(8_000);

    expect(f.fetcher).toHaveBeenCalledTimes(2);
    expect(f.fetcher.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    expect(f.observer.getState()).toMatchObject({
      status: "ready",
      mode: "direct",
      locationId: null,
      ip: "1.1.1.1",
    });
    expect(h.api.proofs).toHaveLength(postsAfterDisconnect);
    expect(h.safety.events.filter((event) => event === "allow")).toHaveLength(
      allowsAfterDisconnect,
    );
    expect(h.controller.getSnapshot()).toMatchObject({
      status: "disconnected",
      protectionRequested: false,
      protected: false,
    });
  });

  it("stops transport retry rounds when logout changes the account without an observe notification", async () => {
    const h = createHarness({ persisted: authenticatedState() });
    expect(await h.controller.connect("frankfurt-01")).toEqual({ ok: true });
    const f = observation(h);
    f.fetcher.mockRejectedValue(new TypeError("fixture tunnel unavailable"));
    vi.useFakeTimers();
    const pending = f.observer.refresh();
    await vi.advanceTimersByTimeAsync(500);
    expect(f.fetcher).toHaveBeenCalledTimes(2);

    expect(await h.controller.logout()).toEqual({ ok: true });
    const allowsAfterLogout = h.safety.events.filter((event) => event === "allow").length;
    const postsAfterLogout = h.api.proofs.length;
    await vi.advanceTimersByTimeAsync(8_000);
    await pending;

    expect(f.fetcher).toHaveBeenCalledTimes(2);
    expect(f.observer.getState()).toMatchObject({ status: "idle", ip: null, mode: "direct" });
    expect(h.api.proofs).toHaveLength(postsAfterLogout);
    expect(h.safety.events.filter((event) => event === "allow")).toHaveLength(allowsAfterLogout);
    expect(h.controller.getSnapshot()).toMatchObject({
      status: "logged_out",
      profile: null,
      protectionRequested: false,
    });
  });

  it("keeps observation inert under a failed exclusion journal and resumes after explicit repair", async () => {
    let record: SiteExclusionRecord = emptySiteExclusionRecord();
    let refuseCommit = false;
    const h = createHarness({
      persisted: authenticatedState(),
      siteExclusionStorage: {
        async read() {
          return structuredClone(record);
        },
        async write(next) {
          if (refuseCommit && !next.pending) throw new Error("fixture commit unavailable");
          record = structuredClone(next);
        },
      },
    });
    expect(await h.controller.connect("frankfurt-01")).toEqual({ ok: true });
    const f = observation(h);
    refuseCommit = true;
    await expect(
      h.controller.updateSiteExclusions(0, true, [
        { domain: "example.com", includeSubdomains: false },
      ]),
    ).rejects.toThrow("fixture commit unavailable");
    const guarded = h.controller.getSnapshot();
    const allowsWhileGuarded = h.safety.events.filter((event) => event === "allow").length;
    const postsWhileGuarded = h.api.proofs.length;
    await f.observer.refresh();

    expect(f.fetcher).not.toHaveBeenCalled();
    expect(f.verifyRoute).not.toHaveBeenCalled();
    expect(h.safety.events.filter((event) => event === "allow")).toHaveLength(allowsWhileGuarded);
    expect(h.api.proofs).toHaveLength(postsWhileGuarded);
    expect(h.controller.getSnapshot()).toEqual(guarded);
    expect(await h.proxy.isGuardedConfiguration()).toBe(true);

    refuseCommit = false;
    await h.controller.retrySiteExclusions();
    expect(h.controller.getSnapshot()).toMatchObject({
      protected: true,
      siteExclusions: { pending: false, error: false },
    });
    const repairedPosts = h.api.proofs.length;
    const repairedAllows = h.safety.events.filter((event) => event === "allow").length;
    vi.useFakeTimers();
    const pending = f.observer.refresh();
    await vi.advanceTimersByTimeAsync(500);
    await pending;

    expect(f.observer.getState()).toMatchObject({ status: "ready", mode: "vpn", ip: "1.1.1.1" });
    expect(h.api.proofs).toHaveLength(repairedPosts);
    expect(h.safety.events.filter((event) => event === "allow")).toHaveLength(repairedAllows);
  });

  it("leaves an exhausted retained-session renewal budget untouched through all IP transport retries", async () => {
    const session = proxySession("fixture-retained-budget");
    const retryAt = NOW + 30_000;
    const h = createHarness({
      persisted: authenticatedState({ autoConnect: true }),
      transient: {
        proxySession: session,
        refreshAttempts: MAX_REFRESH_ATTEMPTS,
        refreshRetryAt: retryAt,
        retiredSessions: [],
      },
      activeProxy: session,
    });
    h.identity.deviceId = "browser-device-1";
    await h.controller.initialize();
    await h.controller.refreshAccount();
    vi.spyOn(h.api, "getSubscription").mockRejectedValueOnce(new NetworkError("network"));
    expect(await h.controller.changeLocation("frankfurt-02")).toMatchObject({
      ok: false,
      commandError: "network_error",
    });
    expect(h.controller.getSnapshot()).toMatchObject({ status: "error", protected: true });
    const beforeTransient = structuredClone(h.storage.transient);
    expect(beforeTransient).toMatchObject({
      refreshAttempts: MAX_REFRESH_ATTEMPTS,
      refreshRetryAt: retryAt,
    });
    const beforeRetryAt = h.alarms.retryAt;
    const f = observation(h);
    f.fetcher.mockRejectedValue(new TypeError("fixture tunnel unavailable"));
    const posts = h.api.proofs.length;
    const allows = h.safety.events.filter((event) => event === "allow").length;
    vi.useFakeTimers();
    const pending = f.observer.refresh();
    await vi.advanceTimersByTimeAsync(8_000);
    await pending;

    expect(f.fetcher).toHaveBeenCalledTimes(6);
    expect(f.observer.getState()).toMatchObject({ status: "unavailable", mode: "vpn", ip: null });
    expect(h.storage.transient).toEqual(beforeTransient);
    expect(h.alarms.retryAt).toBe(beforeRetryAt);
    expect(h.api.proofs).toHaveLength(posts);
    expect(h.safety.events.filter((event) => event === "allow")).toHaveLength(allows);
    expect(h.controller.getSnapshot()).toMatchObject({ status: "error", protected: true });
  });
});
