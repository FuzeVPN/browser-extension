// SPDX-License-Identifier: MPL-2.0

import {
  ConnectionJournal,
  type ConnectionEvent,
} from "../../src/core/background/connection-journal";
import { AppController } from "../../src/core/background/state-machine";
import { DEFAULT_SECURITY_STATE } from "../../src/core/shared/security";
import { authenticatedState, createHarness, LOCATIONS, NOW } from "./helpers";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const operationEvents = (events: ConnectionEvent[]) =>
  events.filter((event) => event.event !== "state");

/** A connected controller whose effective proxy configuration was lost while control remains. */
async function fixture() {
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
  await h.controller.initialize();
  expect(await h.controller.connect(LOCATIONS[0]!.id)).toEqual({ ok: true });
  await h.proxy.clear();
  return { h, journal, stored: () => structuredClone(stored) };
}

describe("reconnections keep the journal generation of the command that started them", () => {
  afterEach(() => vi.restoreAllMocks());

  it("drops a preference command's reconnect traces when the journal is cleared during its write", async () => {
    const f = await fixture();
    const gate = deferred<undefined>();
    const write = f.h.securityStorage.write.bind(f.h.securityStorage);
    const writing = vi.spyOn(f.h.securityStorage, "write").mockImplementationOnce(async (state) => {
      await gate.promise;
      await write(state);
    });
    const updating = f.h.controller.updateSecurityPreferences(false, false);
    await vi.waitFor(() => expect(writing).toHaveBeenCalledOnce());
    f.journal.clear();
    gate.resolve(undefined);
    expect(await updating).toEqual({ ok: true });
    // The reconnection itself still happens; only its history belongs to the erased journal.
    expect(f.h.controller.getSnapshot().protected).toBe(true);
    await f.journal.pruneExpired();
    expect(operationEvents(await f.journal.snapshot())).toEqual([]);
    expect(operationEvents(f.stored())).toEqual([]);
  });

  it("drops a permission repair's reconnect traces when the journal is cleared during guard suspension", async () => {
    const f = await fixture();
    const gate = deferred<undefined>();
    const suspend = vi.spyOn(f.h.safety, "suspend").mockImplementationOnce(() => gate.promise);
    const repairing = f.h.controller.handleProxyPermissionsChanged();
    await vi.waitFor(() => expect(suspend).toHaveBeenCalledOnce());
    f.journal.clear();
    gate.resolve(undefined);
    await repairing;
    expect(f.h.controller.getSnapshot().protected).toBe(true);
    await f.journal.pruneExpired();
    expect(operationEvents(await f.journal.snapshot())).toEqual([]);
    expect(operationEvents(f.stored())).toEqual([]);
  });

  it("records the reconnection of a preference command started after the clear", async () => {
    const f = await fixture();
    f.journal.clear();
    expect(await f.h.controller.updateSecurityPreferences(false, false)).toEqual({ ok: true });
    expect(await f.journal.snapshot()).toContainEqual(
      expect.objectContaining({ event: "target", source: "requested" }),
    );
  });

  it("records the reconnection of a permission event received after the clear", async () => {
    const f = await fixture();
    f.journal.clear();
    await f.h.controller.handleProxyPermissionsChanged();
    expect(f.h.controller.getSnapshot().protected).toBe(true);
    expect(await f.journal.snapshot()).toContainEqual(
      expect.objectContaining({ event: "target", source: "requested" }),
    );
  });
});

/** Protection requested at startup, but another extension controlled the proxy setting. */
async function guardRefusedFixture() {
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
  const h = createHarness({
    persisted: authenticatedState(),
    security: {
      ...DEFAULT_SECURITY_STATE,
      protectionRequested: true,
      selectedLocationId: LOCATIONS[0]!.id,
    },
  });
  h.proxy.level = "controlled_by_other_extensions";
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
  await h.controller.initialize();
  expect(h.controller.getSnapshot()).toMatchObject({
    protected: false,
    error: "proxy_controlled_by_extension",
  });
  return { h, journal, stored: () => structuredClone(stored) };
}

describe("startup guard repairs keep the journal generation of the command that started them", () => {
  afterEach(() => vi.restoreAllMocks());

  it("drops the restoration traces of a preference command cleared during its write", async () => {
    const f = await guardRefusedFixture();
    const gate = deferred<undefined>();
    const write = f.h.securityStorage.write.bind(f.h.securityStorage);
    const writing = vi.spyOn(f.h.securityStorage, "write").mockImplementationOnce(async (state) => {
      await gate.promise;
      await write(state);
      // Control returns before the command retries the refused restoration.
      f.h.proxy.level = "controllable_by_this_extension";
    });
    const updating = f.h.controller.updateSecurityPreferences(true, false);
    await vi.waitFor(() => expect(writing).toHaveBeenCalledOnce());
    f.journal.clear();
    gate.resolve(undefined);
    expect(await updating).toEqual({ ok: true });
    expect(f.h.controller.getSnapshot().protected).toBe(true);
    await f.journal.pruneExpired();
    expect(operationEvents(await f.journal.snapshot())).toEqual([]);
    expect(operationEvents(f.stored())).toEqual([]);
  });

  it("drops the restoration traces of a permission event cleared during its re-initialization", async () => {
    const f = await guardRefusedFixture();
    f.h.proxy.level = "controllable_by_this_extension";
    const gate = deferred<undefined>();
    const block = f.h.safety.block.bind(f.h.safety);
    const blocking = vi.spyOn(f.h.safety, "block").mockImplementationOnce(async (killSwitch) => {
      await gate.promise;
      await block(killSwitch);
    });
    const repairing = f.h.controller.handleProxyPermissionsChanged();
    await vi.waitFor(() => expect(blocking).toHaveBeenCalledOnce());
    f.journal.clear();
    gate.resolve(undefined);
    await repairing;
    expect(f.h.controller.getSnapshot().protected).toBe(true);
    await f.journal.pruneExpired();
    expect(operationEvents(await f.journal.snapshot())).toEqual([]);
    expect(operationEvents(f.stored())).toEqual([]);
  });

  it("records the restoration of a permission event received after the clear", async () => {
    const f = await guardRefusedFixture();
    f.journal.clear();
    f.h.proxy.level = "controllable_by_this_extension";
    await f.h.controller.handleProxyPermissionsChanged();
    expect(f.h.controller.getSnapshot().protected).toBe(true);
    expect(await f.journal.snapshot()).toContainEqual(
      expect.objectContaining({ event: "target", source: "requested" }),
    );
  });
});
