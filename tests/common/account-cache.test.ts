// SPDX-License-Identifier: MPL-2.0

import { ApiError } from "../../src/core/api/client";
import type { Location } from "../../src/core/api/types";
import { ACCOUNT_REFRESH_INTERVAL_MS } from "../../src/core/shared/config";
import {
  ACCOUNT_CACHE_KEY,
  decodeAccountCache,
  ExtensionAccountCacheStorage,
  type AccountCache,
  type AccountCacheStorage,
} from "../../src/core/storage/account-cache-storage";
import {
  ACTIVE_SUBSCRIPTION,
  authenticatedState,
  createHarness,
  INACTIVE_SUBSCRIPTION,
  LOCATIONS,
  NOW,
  PROFILE,
} from "./helpers";

const FIVE_MINUTES = 5 * 60_000;
const NEW_LOCATION: Location = {
  id: "paris-01",
  city: "Paris",
  countryCode: "FR",
  displayName: "Paris 1",
  supportedProtocols: ["browser_proxy"],
};

/** What one browser session keeps of an account between two workers. */
class KeptAccountCache implements AccountCacheStorage {
  record: { userId: string; cache: AccountCache } | null = null;
  unreadable = false;
  unwritable = false;
  writes = 0;

  async read(userId: string): Promise<AccountCache | null> {
    if (this.unreadable) throw new Error("session storage unavailable");
    return this.record?.userId === userId ? structuredClone(this.record.cache) : null;
  }

  async write(userId: string, cache: AccountCache): Promise<void> {
    if (this.unwritable) throw new Error("session storage unavailable");
    this.writes += 1;
    this.record = { userId, cache: structuredClone(cache) };
  }

  async clear(): Promise<void> {
    this.record = null;
  }
}

type Harness = ReturnType<typeof createHarness>;

async function settle(turns = 20) {
  for (let turn = 0; turn < turns; turn++) await new Promise<void>((done) => setImmediate(done));
}

/** The account reads a worker makes, counted from its creation. */
function accountReads(h: Harness) {
  const profile = vi.spyOn(h.api, "getProfile");
  const subscription = vi.spyOn(h.api, "getSubscription");
  const locations = vi.spyOn(h.api, "getLocations");
  return {
    counts: () => ({
      profile: profile.mock.calls.length,
      subscription: subscription.mock.calls.length,
      locations: locations.mock.calls.length,
    }),
  };
}

const NONE = { profile: 0, subscription: 0, locations: 0 };
const ONCE = { profile: 1, subscription: 1, locations: 1 };

/** A worker of a signed-in, disconnected browser, started and left to settle. */
async function worker(
  cache: AccountCacheStorage,
  at: number,
  previous?: Harness,
  prepare?: (h: Harness) => void,
) {
  const h = createHarness({
    persisted: previous?.storage.persisted ?? authenticatedState(),
    ...(previous?.securityStorage.state ? { security: previous.securityStorage.state } : {}),
    accountCache: cache,
  });
  h.setNow(at);
  prepare?.(h);
  const reads = accountReads(h);
  const writes = vi.spyOn(h.storage, "writePersisted");
  await h.controller.initialize();
  await settle();
  return { h, reads, writes };
}

afterEach(() => vi.restoreAllMocks());

describe("a worker which starts after an earlier one refreshed the account", () => {
  it("reads the account from the API when nothing was kept", async () => {
    const cache = new KeptAccountCache();
    const first = await worker(cache, NOW);

    expect(first.reads.counts()).toEqual(ONCE);
    expect(cache.record).toEqual({
      userId: PROFILE.userId,
      cache: { locations: LOCATIONS, refreshedAt: NOW },
    });
  });

  it("reads nothing from the API while that refresh is recent", async () => {
    const cache = new KeptAccountCache();
    const first = await worker(cache, NOW);
    const written = cache.writes;

    const second = await worker(cache, NOW + FIVE_MINUTES, first.h);

    expect(second.reads.counts()).toEqual(NONE);
    // Nothing identical is written back, and the kept refresh keeps its date.
    expect(second.writes).not.toHaveBeenCalled();
    expect(cache.writes).toBe(written);
    expect(cache.record?.cache.refreshedAt).toBe(NOW);
    expect(second.h.controller.getSnapshot()).toMatchObject({
      status: "disconnected",
      profile: PROFILE,
      subscription: ACTIVE_SUBSCRIPTION,
      locations: LOCATIONS,
      locationsStatus: "ready",
      locationsError: null,
      selectedLocationId: "frankfurt-01",
    });
  });

  it("shows the kept catalogue from its first publication", async () => {
    const cache = new KeptAccountCache();
    const first = await worker(cache, NOW);
    // Without the cache, the list is empty until the API answers.
    expect(first.h.snapshots[0]).toMatchObject({ locations: [], locationsStatus: "idle" });

    const second = await worker(cache, NOW + FIVE_MINUTES, first.h);

    expect(second.h.snapshots.length).toBeGreaterThan(0);
    for (const published of second.h.snapshots)
      expect(published).toMatchObject({ locations: LOCATIONS, locationsStatus: "ready" });
  });

  it("reads the account again once that refresh is an hour old", async () => {
    const cache = new KeptAccountCache();
    const first = await worker(cache, NOW);
    const due = NOW + ACCOUNT_REFRESH_INTERVAL_MS;

    const early = await worker(cache, due - 1, first.h);
    expect(early.reads.counts()).toEqual(NONE);

    const late = await worker(cache, due, first.h, (h) => {
      h.api.locations = [...LOCATIONS, NEW_LOCATION];
      h.api.subscription = INACTIVE_SUBSCRIPTION;
    });
    expect(late.reads.counts()).toEqual(ONCE);
    // The kept rows were shown while the API was being read.
    expect(late.h.snapshots[0]).toMatchObject({ locations: LOCATIONS, locationsStatus: "idle" });
    expect(late.h.controller.getSnapshot()).toMatchObject({
      subscription: INACTIVE_SUBSCRIPTION,
      locations: [...LOCATIONS, NEW_LOCATION],
      locationsStatus: "ready",
    });
    expect(cache.record?.cache).toEqual({
      locations: [...LOCATIONS, NEW_LOCATION],
      refreshedAt: due,
    });
  });

  it("does not rely on a refresh dated after the present time", async () => {
    const cache = new KeptAccountCache();
    const first = await worker(cache, NOW);

    const second = await worker(cache, NOW - 1, first.h);

    expect(second.reads.counts()).toEqual(ONCE);
  });

  it("keeps old rows visible when the refresh which is due fails", async () => {
    const cache = new KeptAccountCache();
    const first = await worker(cache, NOW);

    const second = await worker(cache, NOW + ACCOUNT_REFRESH_INTERVAL_MS, first.h, (h) => {
      vi.spyOn(h.api, "getLocations").mockRejectedValue(new ApiError("network_error", 0));
    });

    expect(second.h.controller.getSnapshot()).toMatchObject({
      locations: LOCATIONS,
      locationsStatus: "error",
    });
    // The failed refresh is due again for the next worker.
    expect(cache.record?.cache.refreshedAt).toBe(NOW);
    const third = await worker(cache, NOW + ACCOUNT_REFRESH_INTERVAL_MS + 1, first.h);
    expect(third.reads.counts()).toEqual(ONCE);
  });

  it("still signs out an account which the server refuses at a due refresh", async () => {
    const cache = new KeptAccountCache();
    const first = await worker(cache, NOW);

    const second = await worker(cache, NOW + ACCOUNT_REFRESH_INTERVAL_MS, first.h, (h) => {
      vi.spyOn(h.api, "getProfile").mockRejectedValue(new ApiError("unauthorized", 401));
    });

    expect(second.h.controller.getSnapshot()).toMatchObject({
      status: "logged_out",
      profile: null,
      locations: [],
      error: "unauthorized",
    });
    expect(cache.record).toBeNull();
  });

  it("reads the API again when the catalogue it kept was empty", async () => {
    const cache = new KeptAccountCache();
    // The server once answered with no location at all.
    const first = await worker(cache, NOW, undefined, (h) => {
      h.api.locations = [];
    });
    expect(cache.record?.cache.locations).toEqual([]);

    const second = await worker(cache, NOW + FIVE_MINUTES, first.h);

    // An empty list is not relied on for an hour, and costs the user no selection.
    expect(second.reads.counts()).toEqual(ONCE);
    expect(second.h.controller.getSnapshot()).toMatchObject({
      locations: LOCATIONS,
      locationsStatus: "ready",
      selectedLocationId: "frankfurt-01",
    });
  });

  it("reads the API again when the stored subscription cannot be used", async () => {
    const cache = new KeptAccountCache();
    const first = await worker(cache, NOW);
    first.h.storage.persisted = { ...first.h.storage.persisted, subscription: null };

    const second = await worker(cache, NOW + FIVE_MINUTES, first.h);

    expect(second.reads.counts()).toEqual(ONCE);
  });

  it("never uses what was kept for another account", async () => {
    const cache = new KeptAccountCache();
    cache.record = {
      userId: "another-user",
      cache: { locations: [NEW_LOCATION], refreshedAt: NOW },
    };

    const second = await worker(cache, NOW + FIVE_MINUTES);

    expect(second.reads.counts()).toEqual(ONCE);
    expect(second.h.snapshots[0]).toMatchObject({ locations: [], locationsStatus: "idle" });
    expect(cache.record).toEqual({
      userId: PROFILE.userId,
      cache: { locations: LOCATIONS, refreshedAt: NOW + FIVE_MINUTES },
    });
  });

  it("reads the API as before when the cache cannot be read", async () => {
    const cache = new KeptAccountCache();
    const first = await worker(cache, NOW);
    cache.unreadable = true;

    const second = await worker(cache, NOW + FIVE_MINUTES, first.h);

    expect(second.reads.counts()).toEqual(ONCE);
    expect(second.h.controller.getSnapshot()).toMatchObject({
      status: "disconnected",
      locations: LOCATIONS,
      locationsStatus: "ready",
    });
  });

  it("refreshes the account normally when the cache cannot be written", async () => {
    const cache = new KeptAccountCache();
    cache.unwritable = true;

    const first = await worker(cache, NOW);

    expect(first.h.controller.getSnapshot()).toMatchObject({
      status: "disconnected",
      profile: PROFILE,
      locationsStatus: "ready",
      error: null,
    });
    expect(await first.h.controller.refreshAccount()).toEqual({ ok: true });
    expect(cache.record).toBeNull();
  });

  it("chooses the idle default against the kept catalogue, like a first load", async () => {
    const cache = new KeptAccountCache();
    const first = await worker(cache, NOW);
    // A refresh of the catalogue alone never replaces a selection: the next worker does.
    first.h.api.locations = [NEW_LOCATION];
    expect(await first.h.controller.refreshLocations()).toEqual({ ok: true });
    expect(first.h.controller.getSnapshot().selectedLocationId).toBe("frankfurt-01");

    const second = await worker(cache, NOW + FIVE_MINUTES, first.h);

    expect(second.reads.counts()).toEqual(NONE);
    expect(second.h.controller.getSnapshot()).toMatchObject({
      locations: [NEW_LOCATION],
      selectedLocationId: "paris-01",
    });
  });
});

describe("what refreshes the account whatever its age", () => {
  it("is the popup's refresh, which dates the cache again", async () => {
    const cache = new KeptAccountCache();
    const first = await worker(cache, NOW);
    const second = await worker(cache, NOW + FIVE_MINUTES, first.h, (h) => {
      h.api.subscription = INACTIVE_SUBSCRIPTION;
    });
    expect(second.reads.counts()).toEqual(NONE);

    second.h.setNow(NOW + FIVE_MINUTES + 1_000);
    expect(await second.h.controller.refreshAccount()).toEqual({ ok: true });

    expect(second.reads.counts()).toEqual(ONCE);
    expect(second.h.controller.getSnapshot().subscription).toEqual(INACTIVE_SUBSCRIPTION);
    expect(cache.record?.cache.refreshedAt).toBe(NOW + FIVE_MINUTES + 1_000);
  });

  it("is a connection, which reads the subscription and the catalogue itself", async () => {
    const cache = new KeptAccountCache();
    const first = await worker(cache, NOW);
    const second = await worker(cache, NOW + FIVE_MINUTES, first.h, (h) => {
      h.api.locations = [...LOCATIONS, NEW_LOCATION];
    });

    expect(await second.h.controller.connect("paris-01")).toEqual({ ok: true });

    expect(second.reads.counts()).toMatchObject({ subscription: 1, locations: 1 });
    expect(second.h.controller.getSnapshot()).toMatchObject({
      status: "connected",
      activeLocationId: "paris-01",
    });
  });

  it("keeps the catalogue a manual refresh received, without dating the account again", async () => {
    const cache = new KeptAccountCache();
    const first = await worker(cache, NOW);
    first.h.setNow(NOW + 60_000);
    first.h.api.locations = [...LOCATIONS, NEW_LOCATION];

    expect(await first.h.controller.refreshLocations()).toEqual({ ok: true });
    await settle();

    expect(cache.record?.cache).toEqual({
      locations: [...LOCATIONS, NEW_LOCATION],
      refreshedAt: NOW,
    });
  });
});

describe("a worker which restores a protected connection", () => {
  it("reads nothing from the API while the refresh is recent", async () => {
    const cache = new KeptAccountCache();
    const first = await worker(cache, NOW);
    expect(await first.h.controller.connect("frankfurt-02")).toEqual({ ok: true });
    await settle();

    const h = createHarness({
      persisted: first.h.storage.persisted,
      transient: first.h.storage.transient,
      security: first.h.securityStorage.state!,
      activeProxy: first.h.proxy.active!,
      accountCache: cache,
    });
    h.setNow(NOW + FIVE_MINUTES);
    const reads = accountReads(h);
    await h.controller.initialize();
    await settle();

    expect(reads.counts()).toEqual(NONE);
    expect(h.controller.getSnapshot()).toMatchObject({
      status: "connected",
      protected: true,
      activeLocationId: "frankfurt-02",
      // A requested protection keeps its target: no idle default replaces it.
      selectedLocationId: "frankfurt-02",
      locations: LOCATIONS,
      locationsStatus: "ready",
    });
  });
});

describe("an account which leaves", () => {
  it("leaves nothing kept at logout", async () => {
    const cache = new KeptAccountCache();
    const first = await worker(cache, NOW);
    expect(cache.record).not.toBeNull();

    await first.h.controller.logout();
    await settle();

    expect(cache.record).toBeNull();
    const next = createHarness({ accountCache: cache });
    await next.controller.initialize();
    await settle();
    expect(next.controller.getSnapshot()).toMatchObject({ status: "logged_out", locations: [] });
  });

  it("leaves nothing kept when its session is refused", async () => {
    const cache = new KeptAccountCache();
    const first = await worker(cache, NOW);
    vi.spyOn(first.h.api, "getProfile").mockRejectedValue(new ApiError("unauthorized", 401));

    await first.h.controller.refreshAccount();
    await settle();

    expect(first.h.controller.getSnapshot().status).toBe("logged_out");
    expect(cache.record).toBeNull();
  });

  it("is not written back by a catalogue which answers after it left", async () => {
    const cache = new KeptAccountCache();
    const first = await worker(cache, NOW);
    let answer!: (locations: Location[]) => void;
    vi.spyOn(first.h.api, "getLocations").mockReturnValue(
      new Promise<Location[]>((resolve) => {
        answer = resolve;
      }),
    );
    const refresh = first.h.controller.refreshLocations();
    await settle();

    await first.h.controller.logout();
    answer([NEW_LOCATION]);
    await refresh;
    await settle();

    expect(cache.record).toBeNull();
  });
});

describe("the stored account cache", () => {
  const OWNER = "a".repeat(64);
  const record = (changes: Record<string, unknown> = {}) => ({
    owner: OWNER,
    refreshedAt: NOW,
    locations: structuredClone(LOCATIONS),
    ...changes,
  });

  it("is read back for its owner only", () => {
    expect(decodeAccountCache(record(), OWNER)).toEqual({ locations: LOCATIONS, refreshedAt: NOW });
    expect(decodeAccountCache(record(), "b".repeat(64))).toBeNull();
    expect(decodeAccountCache(record({ owner: undefined }), OWNER)).toBeNull();
  });

  it.each([
    ["no record", undefined],
    ["a list", []],
    ["a missing date", record({ refreshedAt: undefined })],
    ["a date which is no integer", record({ refreshedAt: 1.5 })],
    ["a date which is not positive", record({ refreshedAt: 0 })],
    ["a date as text", record({ refreshedAt: String(NOW) })],
    ["no catalogue", record({ locations: undefined })],
    ["a catalogue which is no list", record({ locations: { 0: LOCATIONS[0] } })],
    ["too many rows", record({ locations: new Array<Location>(2_001).fill(LOCATIONS[0]!) })],
    ["a row without identifier", record({ locations: [{ ...LOCATIONS[0], id: "" }] })],
    ["the same row twice", record({ locations: [LOCATIONS[0], LOCATIONS[0]] })],
    ["a row whose city is no text", record({ locations: [{ ...LOCATIONS[0], city: 1 }] })],
    ["a row without country", record({ locations: [{ ...LOCATIONS[0], countryCode: null }] })],
    ["a row without name", record({ locations: [{ ...LOCATIONS[0], displayName: undefined }] })],
    [
      "protocols which are no list",
      record({ locations: [{ ...LOCATIONS[0], supportedProtocols: "x" }] }),
    ],
    [
      "a protocol which is no text",
      record({ locations: [{ ...LOCATIONS[0], supportedProtocols: [1] }] }),
    ],
    ["a row which is no record", record({ locations: ["frankfurt-01"] })],
  ])("is not relied on with %s", (_name, stored) => {
    expect(decodeAccountCache(stored, OWNER)).toBeNull();
  });

  it("keeps the known fields of a row only", () => {
    const decoded = decodeAccountCache(
      record({ locations: [{ ...LOCATIONS[0], load: 0.4, password: "x" }] }),
      OWNER,
    );
    expect(decoded?.locations).toEqual([LOCATIONS[0]]);
  });
});

describe("the account cache in session storage", () => {
  function sessionStorage() {
    const values: Record<string, unknown> = {};
    const local = vi.fn();
    vi.stubGlobal("browser", {
      storage: {
        local: { get: local, set: local, remove: local },
        session: {
          get: async (key: string) => ({ [key]: structuredClone(values[key]) }),
          set: async (written: Record<string, unknown>) => {
            Object.assign(values, structuredClone(written));
          },
          remove: async (key: string) => {
            Reflect.deleteProperty(values, key);
          },
        },
      },
    });
    return { values, local };
  }
  const digest = async (userId: string) => (userId === PROFILE.userId ? "a" : "b").repeat(64);
  const CACHE: AccountCache = { locations: LOCATIONS, refreshedAt: NOW };

  afterEach(() => vi.unstubAllGlobals());

  it("names its account by a digest and stays out of local storage", async () => {
    const { values, local } = sessionStorage();
    const storage = new ExtensionAccountCacheStorage(digest);

    await storage.write(PROFILE.userId, CACHE);

    expect(values[ACCOUNT_CACHE_KEY]).toEqual({
      owner: "a".repeat(64),
      refreshedAt: NOW,
      locations: LOCATIONS,
    });
    const stored = JSON.stringify(values);
    expect(stored).not.toContain(PROFILE.userId);
    expect(stored).not.toContain(PROFILE.email);
    expect(local).not.toHaveBeenCalled();
  });

  it("returns what it kept to the same account only, until it is cleared", async () => {
    sessionStorage();
    const storage = new ExtensionAccountCacheStorage(digest);
    await storage.write(PROFILE.userId, CACHE);

    expect(await storage.read(PROFILE.userId)).toEqual(CACHE);
    expect(await storage.read("another-user")).toBeNull();
    await storage.clear();
    expect(await storage.read(PROFILE.userId)).toBeNull();
  });

  it("applies a removal asked after a write, however long the digest takes", async () => {
    const { values } = sessionStorage();
    let release!: () => void;
    const slow = new Promise<void>((resolve) => {
      release = resolve;
    });
    const storage = new ExtensionAccountCacheStorage(async (userId) => {
      await slow;
      return digest(userId);
    });

    const written = storage.write(PROFILE.userId, CACHE);
    const cleared = storage.clear();
    release();
    await Promise.all([written, cleared]);

    expect(values[ACCOUNT_CACHE_KEY]).toBeUndefined();
  });

  it("goes on after an operation which storage refused", async () => {
    const { values } = sessionStorage();
    const storage = new ExtensionAccountCacheStorage(digest);
    const refused = vi
      .spyOn(browser.storage.session, "set")
      .mockRejectedValueOnce(new Error("quota"));

    await expect(storage.write(PROFILE.userId, CACHE)).rejects.toThrow("quota");
    await storage.write(PROFILE.userId, CACHE);

    expect(refused).toHaveBeenCalledTimes(2);
    expect(values[ACCOUNT_CACHE_KEY]).toBeDefined();
  });
});
