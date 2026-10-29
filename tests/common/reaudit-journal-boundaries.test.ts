// SPDX-License-Identifier: MPL-2.0

import { ApiError } from "../../src/core/api/client";
import type { ProxySession } from "../../src/core/api/types";
import {
  ConnectionJournal,
  type ConnectionEvent,
} from "../../src/core/background/connection-journal";
import { AppController } from "../../src/core/background/state-machine";
import { authenticatedState, createHarness, LOCATIONS, NOW } from "./helpers";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

async function fixture(initialize = true) {
  let stored: ConnectionEvent[] = [];
  const journal = new ConnectionJournal({
    storage: {
      read: async () => structuredClone(stored),
      write: async (events) => {
        stored = structuredClone(events);
      },
    },
    now: () => NOW,
  });
  await journal.initialize();
  const h = createHarness({ persisted: authenticatedState() });
  h.controller = new AppController({
    api: h.api,
    storage: h.storage,
    identity: h.identity,
    proxy: h.proxy,
    alarms: h.alarms,
    safety: h.safety,
    securityStorage: h.securityStorage,
    now: () => NOW,
    onStateChanged: (snapshot) => h.snapshots.push(snapshot),
    captureConnectionEvents: () => journal.capture(),
  });
  if (initialize) {
    await h.controller.initialize();
    await new Promise<void>((done) => setImmediate(done));
    await journal.pruneExpired();
  }
  return { h, journal, stored: () => structuredClone(stored) };
}

describe("journal operation and independent refresh boundaries", () => {
  afterEach(() => vi.restoreAllMocks());

  it("drops a connection's first catalog and target when clear occurs during its catalog request", async () => {
    const f = await fixture();
    const catalog = deferred<typeof LOCATIONS>();
    const request = vi.spyOn(f.h.api, "getLocations").mockReturnValueOnce(catalog.promise);
    const connecting = f.h.controller.connect(LOCATIONS[0]!.id);
    await vi.waitFor(() => expect(request).toHaveBeenCalled());
    f.journal.clear();
    catalog.resolve(LOCATIONS);
    expect(await connecting).toEqual({ ok: true });
    await f.journal.pruneExpired();
    expect(await f.journal.snapshot()).toEqual([]);
    expect(f.stored()).toEqual([]);
  });

  it("keeps the captured generation of a connection queued during account restoration", async () => {
    const f = await fixture(false);
    const persisted = deferred<ReturnType<typeof authenticatedState>>();
    const reading = vi.spyOn(f.h.storage, "readPersisted").mockReturnValueOnce(persisted.promise);
    const connecting = f.h.controller.connect(LOCATIONS[0]!.id);
    await vi.waitFor(() => expect(reading).toHaveBeenCalled());
    f.journal.clear();
    persisted.resolve(authenticatedState());
    expect(await connecting).toEqual({ ok: true });
    expect((await f.journal.snapshot()).some((event) => event.event === "target")).toBe(false);
    expect(await f.h.controller.changeLocation(LOCATIONS[1]!.id)).toEqual({ ok: true });
    expect((await f.journal.snapshot()).some((event) => event.event === "target")).toBe(true);
  });

  it("records a new catalog refresh after clear although its operation ID has not changed", async () => {
    const f = await fixture();
    const previous = (await f.journal.snapshot()).find((event) => event.event === "catalog");
    expect(previous).toBeDefined();
    f.journal.clear();
    expect(await f.h.controller.refreshLocations()).toEqual({ ok: true });
    const current = await f.journal.snapshot();
    expect(current).toEqual([
      expect.objectContaining({ event: "catalog", operation: previous!.operation, count: 2 }),
    ]);
  });

  it("invalidates an old standalone refresh but accepts the next one after clear", async () => {
    const f = await fixture();
    const catalog = deferred<typeof LOCATIONS>();
    const request = vi.spyOn(f.h.api, "getLocations").mockReturnValueOnce(catalog.promise);
    const refreshing = f.h.controller.refreshLocations();
    await vi.waitFor(() => expect(request).toHaveBeenCalled());
    f.journal.clear();
    catalog.resolve(LOCATIONS);
    expect(await refreshing).toEqual({ ok: true });
    expect(await f.journal.snapshot()).toEqual([]);
    expect(await f.h.controller.refreshLocations()).toEqual({ ok: true });
    expect(await f.journal.snapshot()).toEqual([
      expect.objectContaining({ event: "catalog", count: 2 }),
    ]);
  });

  it("drops a delayed API failure from an erased connection and records a later connection", async () => {
    const f = await fixture();
    const response = deferred<ProxySession>();
    const create = vi.spyOn(f.h.api, "createProxySession").mockReturnValueOnce(response.promise);
    const connecting = f.h.controller.connect(LOCATIONS[0]!.id);
    await vi.waitFor(() => expect(create).toHaveBeenCalled());
    expect((await f.journal.snapshot()).some((event) => event.event === "target")).toBe(true);
    f.journal.clear();
    response.reject(new ApiError("invalid_location", 400));
    expect(await connecting).toMatchObject({ ok: false, commandError: "invalid_location" });
    expect(await f.journal.snapshot()).toEqual([]);
    expect(await f.h.controller.connect(LOCATIONS[0]!.id)).toEqual({ ok: true });
    const current = await f.journal.snapshot();
    expect(current.some((event) => event.event === "target")).toBe(true);
    expect(current.some((event) => event.event === "failure")).toBe(false);
  });
});
