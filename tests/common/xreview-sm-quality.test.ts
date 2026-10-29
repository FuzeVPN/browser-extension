// SPDX-License-Identifier: MPL-2.0

import { ApiError } from "../../src/core/api/client";
import {
  ConnectionJournal,
  type ConnectionEvent,
} from "../../src/core/background/connection-journal";
import { AppController } from "../../src/core/background/state-machine";
import { ALARM_RECONNECT } from "../../src/core/shared/config";
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

const retryingCommands: [string, (controller: AppController) => Promise<unknown>][] = [
  ["connect", (controller) => controller.connect(LOCATIONS[0]!.id)],
  ["selectLocation", (controller) => controller.selectLocation(LOCATIONS[0]!.id)],
  ["changeLocation", (controller) => controller.changeLocation(LOCATIONS[0]!.id)],
  ["retryConnection", (controller) => controller.retryConnection(false)],
  ["deleteDevice", (controller) => controller.deleteDevice("remote-device")],
  ["handleAlarm", (controller) => controller.handleAlarm(ALARM_RECONNECT)],
  ["refreshAccount", (controller) => controller.refreshAccount()],
  ["refreshLocations", (controller) => controller.refreshLocations()],
];

describe("startup guard repairs retried by any command keep that command's journal generation", () => {
  afterEach(() => vi.restoreAllMocks());

  it.each(retryingCommands)(
    "drops the restoration traces of %s when the journal is cleared during its re-initialization",
    async (_name, run) => {
      const f = await guardRefusedFixture();
      f.h.proxy.level = "controllable_by_this_extension";
      const gate = deferred<undefined>();
      const block = f.h.safety.block.bind(f.h.safety);
      const blocking = vi.spyOn(f.h.safety, "block").mockImplementationOnce(async (killSwitch) => {
        await gate.promise;
        await block(killSwitch);
      });
      const command = run(f.h.controller);
      await vi.waitFor(() => expect(blocking).toHaveBeenCalledOnce());
      f.journal.clear();
      gate.resolve(undefined);
      await command;
      // The restoration itself still happens; only its history belongs to the erased journal.
      expect(f.h.controller.getSnapshot().protected).toBe(true);
      await f.journal.pruneExpired();
      expect(operationEvents(await f.journal.snapshot())).toEqual([]);
      expect(operationEvents(f.stored())).toEqual([]);
    },
  );

  it("records the restoration retried by a command started after the clear", async () => {
    const f = await guardRefusedFixture();
    f.journal.clear();
    f.h.proxy.level = "controllable_by_this_extension";
    await f.h.controller.retryConnection(false);
    expect(f.h.controller.getSnapshot().protected).toBe(true);
    expect(await f.journal.snapshot()).toContainEqual(
      expect.objectContaining({ event: "target", source: "requested" }),
    );
  });
});

describe("sibling device-quota recoveries", () => {
  afterEach(() => vi.restoreAllMocks());

  it("serializes two recoveries whose presentation lists answer in the same tick", async () => {
    const devices = ["a", "b"].map((suffix) => ({
      deviceId: `remote-${suffix}`,
      name: `Browser ${suffix}`,
      kind: "browser_extension" as const,
      createdAt: "2026-08-26T12:00:00Z",
      profiles: [],
    }));
    const h = createHarness({ persisted: authenticatedState() });
    h.api.devices = { limit: 2, devices: structuredClone(devices) };
    h.api.enrollError = new ApiError("device_limit", 409);
    expect(await h.controller.connect(LOCATIONS[0]!.id)).toEqual({
      ok: false,
      commandError: "device_limit",
    });
    expect(await h.controller.refreshDevices()).toEqual({ ok: true });
    h.api.enrollError = null;
    const enrollments = h.api.enrollCalls;
    const replies: (() => void)[] = [];
    const listed = deferred<undefined>();
    const list = h.api.getDevices.bind(h.api);
    vi.spyOn(h.api, "getDevices").mockImplementation(async () => {
      const reply = deferred<undefined>();
      replies.push(() => reply.resolve(undefined));
      if (replies.length === devices.length) listed.resolve(undefined);
      await reply.promise;
      return list();
    });
    const commands = devices.map(({ deviceId }) => h.controller.deleteDevice(deviceId));
    await listed.promise;
    // Both deletions find no pending recovery in the same tick. The first one to
    // start its recovery must make the other wait instead of superseding it.
    for (const reply of replies) reply();
    expect(await Promise.all(commands)).toEqual([{ ok: true }, { ok: false, superseded: true }]);
    expect(h.api.enrollCalls).toBe(enrollments + 1);
    expect(h.controller.getSnapshot().protected).toBe(true);
  });
});
