// SPDX-License-Identifier: MPL-2.0

import { ApiError } from "../../src/core/api/client";
import type { Location } from "../../src/core/api/types";
import type { ConnectionTrace } from "../../src/core/background/connection-journal";
import {
  AppController,
  type ControllerDependencies,
} from "../../src/core/background/state-machine";
import { displayedLocation } from "../../src/ui/popup/location-state";
import {
  INACTIVE_SUBSCRIPTION,
  LOCATIONS,
  NOW,
  authenticatedState,
  createHarness,
} from "./helpers";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function settleBackground() {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

function tracedHarness(
  onConnectionEvent: NonNullable<ControllerDependencies["onConnectionEvent"]>,
  resolveAutomaticLocation?: ControllerDependencies["resolveAutomaticLocation"],
) {
  const h = createHarness({ persisted: authenticatedState() });
  h.controller = new AppController({
    api: h.api,
    storage: h.storage,
    identity: h.identity,
    proxy: h.proxy,
    alarms: h.alarms,
    securityStorage: h.securityStorage,
    safety: h.safety,
    now: () => NOW,
    onStateChanged: (snapshot) => h.snapshots.push(snapshot),
    onConnectionEvent,
    resolveAutomaticLocation,
  });
  return h;
}

describe("connection progress and catalog evidence", () => {
  it("keeps the connection busy while its catalog is loading with traffic safely blocked", async () => {
    const h = createHarness({ persisted: authenticatedState() });
    await h.controller.initialize();
    await settleBackground();
    const catalog = deferred<Location[]>();
    vi.spyOn(h.api, "getLocations").mockReturnValueOnce(catalog.promise);

    const connecting = h.controller.connect(LOCATIONS[0]!.id);
    await settleBackground();
    const whileLoading = h.controller.getSnapshot();
    catalog.resolve(LOCATIONS);
    expect(await connecting).toEqual({ ok: true });

    expect(whileLoading).toMatchObject({
      status: "connecting",
      protectionRequested: true,
      protected: false,
      trafficBlocked: true,
      locationsStatus: "loading",
      selectedLocationId: LOCATIONS[0]!.id,
      error: null,
    });
  });

  it("connects the known explicit selection once when the fresh catalog omits it", async () => {
    const events: ConnectionTrace[] = [];
    const h = tracedHarness((event) => events.push(event));
    await h.controller.initialize();
    await settleBackground();
    expect(displayedLocation(h.controller.getSnapshot())).toEqual(LOCATIONS[0]);
    h.api.locations = [LOCATIONS[1]!];

    const create = vi.spyOn(h.api, "createProxySession");
    expect(await h.controller.connect(LOCATIONS[0]!.id)).toEqual({ ok: true });

    const snapshot = h.controller.getSnapshot();
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0]![1]).toBe(LOCATIONS[0]!.id);
    expect(snapshot).toMatchObject({
      status: "connected",
      protectionRequested: true,
      protected: true,
      trafficBlocked: false,
      locations: [LOCATIONS[1]],
      selectedLocationId: LOCATIONS[0]!.id,
      activeLocationId: LOCATIONS[0]!.id,
      activeLocation: LOCATIONS[0],
      error: null,
    });
    expect(displayedLocation(snapshot)).toEqual(LOCATIONS[0]);
    expect(h.storage.persisted.selectedLocationId).toBe(LOCATIONS[0]!.id);
    expect(h.storage.transient.activeLocation).toEqual(LOCATIONS[0]);
    expect(events).toContainEqual(
      expect.objectContaining({
        event: "catalog",
        count: 1,
        selectedPresent: false,
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        event: "target",
        source: "requested",
        count: 1,
        requestedPresent: false,
      }),
    );
    expect(events.some((event) => event.event === "failure")).toBe(false);
    expect(events.some((event) => event.source === "api")).toBe(false);
  });

  it("keeps the old protection until an omitted known replacement is accepted", async () => {
    const h = createHarness({ persisted: authenticatedState() });
    await h.controller.initialize();
    await settleBackground();
    expect(await h.controller.connect(LOCATIONS[0]!.id)).toEqual({ ok: true });
    const previous = h.proxy.active;
    const create = vi.spyOn(h.api, "createProxySession");
    const acceptance = deferred<undefined>();
    h.api.createWait = acceptance.promise;
    h.api.locations = [LOCATIONS[0]!];

    const changing = h.controller.changeLocation(LOCATIONS[1]!.id);
    await settleBackground();
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0]![1]).toBe(LOCATIONS[1]!.id);
    expect(h.proxy.active).toEqual(previous);
    expect(h.controller.getSnapshot()).toMatchObject({
      status: "connecting",
      protected: true,
      trafficBlocked: false,
      activeLocationId: LOCATIONS[0]!.id,
      locations: [LOCATIONS[0]],
    });

    acceptance.resolve(undefined);
    expect(await changing).toEqual({ ok: true });
    const snapshot = h.controller.getSnapshot();
    expect(snapshot).toMatchObject({
      status: "connected",
      protected: true,
      trafficBlocked: false,
      activeLocationId: LOCATIONS[1]!.id,
      selectedLocationId: LOCATIONS[1]!.id,
      activeLocation: LOCATIONS[1],
      locations: [LOCATIONS[0]],
    });
    expect(displayedLocation(snapshot)).toEqual(LOCATIONS[1]);
    expect(h.storage.transient.activeLocation).toEqual(LOCATIONS[1]);
    expect(h.storage.persisted.selectedLocationId).toBe(LOCATIONS[1]!.id);
  });

  it("rejects a target absent both before the click and from the refreshed catalog", async () => {
    const events: ConnectionTrace[] = [];
    const h = tracedHarness((event) => events.push(event));
    await h.controller.initialize();
    await settleBackground();
    h.api.locations = [LOCATIONS[1]!];
    const create = vi.spyOn(h.api, "createProxySession");

    expect(await h.controller.connect("never-catalogued")).toEqual({
      ok: false,
      commandError: "invalid_location",
    });

    expect(create).not.toHaveBeenCalled();
    expect(events).toContainEqual(
      expect.objectContaining({
        event: "failure",
        source: "local",
        reason: "catalog_missing",
      }),
    );
    expect(h.controller.getSnapshot()).toMatchObject({
      status: "blocked",
      protected: false,
      trafficBlocked: true,
    });
  });

  it.each([
    [400, "invalid_location"],
    [409, "server_full"],
  ] as const)(
    "respects API %i %s for a known target omitted from the catalog",
    async (status, code) => {
      const events: ConnectionTrace[] = [];
      const h = tracedHarness((event) => events.push(event));
      await h.controller.initialize();
      await settleBackground();
      h.api.locations = [LOCATIONS[1]!];
      h.api.createError = new ApiError(code, status);
      const create = vi.spyOn(h.api, "createProxySession");

      expect(await h.controller.connect(LOCATIONS[0]!.id)).toEqual({
        ok: false,
        commandError: code,
      });

      expect(create).toHaveBeenCalledTimes(1);
      expect(create.mock.calls[0]![1]).toBe(LOCATIONS[0]!.id);
      expect(h.proxy.applyCalls).toBe(0);
      expect(h.storage.transient.proxySession).toBeNull();
      expect(h.controller.getSnapshot()).toMatchObject({
        status: "blocked",
        protected: false,
        trafficBlocked: true,
        error: code,
      });
      expect(events).toContainEqual(
        expect.objectContaining({
          event: "failure",
          source: "api",
          error: code,
          httpStatus: status,
        }),
      );
      expect(events.some((event) => event.reason === "catalog_missing")).toBe(false);
    },
  );

  it("resolves Auto from the fresh catalog instead of reusing the old explicit target", async () => {
    const h = tracedHarness(
      () => undefined,
      (locations) => locations[0]?.id ?? null,
    );
    await h.controller.initialize();
    await settleBackground();
    h.api.locations = [LOCATIONS[1]!];
    const create = vi.spyOn(h.api, "createProxySession");

    expect(await h.controller.connect(LOCATIONS[0]!.id)).toEqual({ ok: true });

    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0]![1]).toBe(LOCATIONS[1]!.id);
    expect(h.controller.getSnapshot()).toMatchObject({
      status: "connected",
      protected: true,
      activeLocationId: LOCATIONS[1]!.id,
      locations: [LOCATIONS[1]],
    });
  });

  it("cancels safely during hydration before a known omitted target can create a session", async () => {
    const h = createHarness({ persisted: authenticatedState() });
    await h.controller.initialize();
    await settleBackground();
    const catalog = deferred<Location[]>();
    vi.spyOn(h.api, "getLocations").mockReturnValueOnce(catalog.promise);
    const create = vi.spyOn(h.api, "createProxySession");

    const connecting = h.controller.connect(LOCATIONS[0]!.id);
    await settleBackground();
    expect(await h.controller.disconnect()).toEqual({ ok: true });
    catalog.resolve([LOCATIONS[1]!]);
    expect(await connecting).toEqual({ ok: false, superseded: true });

    expect(create).not.toHaveBeenCalled();
    expect(h.controller.getSnapshot()).toMatchObject({
      status: "disconnected",
      protected: false,
      protectionRequested: false,
      trafficBlocked: false,
    });
    expect(h.proxy.active).toBeNull();
    expect(h.storage.transient.proxySession).toBeNull();
  });

  it("requires fresh entitlement even when the omitted target was known before the click", async () => {
    const h = createHarness({ persisted: authenticatedState() });
    await h.controller.initialize();
    await settleBackground();
    h.api.locations = [LOCATIONS[1]!];
    h.api.subscription = INACTIVE_SUBSCRIPTION;
    const create = vi.spyOn(h.api, "createProxySession");

    expect(await h.controller.connect(LOCATIONS[0]!.id)).toEqual({
      ok: false,
      commandError: "subscription_required",
    });

    expect(create).not.toHaveBeenCalled();
    expect(h.controller.getSnapshot()).toMatchObject({
      status: "blocked",
      protected: false,
      trafficBlocked: true,
      error: "subscription_required",
    });
    expect(h.proxy.active).toBeNull();
  });

  it("awaits the initial shared catalog before creating a proxy session", async () => {
    const h = createHarness({ persisted: authenticatedState() });
    const catalog = deferred<Location[]>();
    const requests = vi.spyOn(h.api, "getLocations").mockReturnValue(catalog.promise);
    await h.controller.initialize();
    const connecting = h.controller.connect(LOCATIONS[0]!.id);
    await settleBackground();

    const creationsBeforeCatalog = h.api.proofs.length;
    const catalogRequests = requests.mock.calls.length;
    catalog.resolve(LOCATIONS);
    expect(await connecting).toEqual({ ok: true });

    expect(creationsBeforeCatalog).toBe(0);
    expect(catalogRequests).toBe(1);
    expect(h.api.proofs).toHaveLength(1);
    expect(h.controller.getSnapshot()).toMatchObject({
      status: "connected",
      protected: true,
      trafficBlocked: false,
    });
  });

  it("distinguishes a server invalid_location while the selection remains in the catalog", async () => {
    const events: ConnectionTrace[] = [];
    const h = tracedHarness((event) => events.push(event));
    await h.controller.initialize();
    await settleBackground();
    h.api.createError = new ApiError("invalid_location", 400);

    expect(await h.controller.connect(LOCATIONS[0]!.id)).toEqual({
      ok: false,
      commandError: "invalid_location",
    });

    expect(h.api.proofs).toHaveLength(1);
    expect(h.controller.getSnapshot()).toMatchObject({
      status: "blocked",
      protected: false,
      trafficBlocked: true,
      locations: LOCATIONS,
      error: "invalid_location",
    });
    expect(displayedLocation(h.controller.getSnapshot())).toEqual(LOCATIONS[0]);
    expect(events).toContainEqual(
      expect.objectContaining({
        event: "failure",
        source: "api",
        error: "invalid_location",
        httpStatus: 400,
      }),
    );
    expect(events.some((event) => event.reason === "catalog_missing")).toBe(false);
  });

  it("continues connecting when the optional connection journal throws", async () => {
    const logger = vi.fn(() => {
      throw new Error("journal unavailable");
    });
    const h = tracedHarness(logger);
    await h.controller.initialize();
    await settleBackground();
    expect(await h.controller.connect(LOCATIONS[0]!.id)).toEqual({ ok: true });
    expect(logger).toHaveBeenCalled();
    expect(h.controller.getSnapshot()).toMatchObject({ status: "connected", protected: true });
  });

  it.each(["no_target", "automatic_empty"] as const)(
    "labels a locally missing target as %s without inventing an API rejection",
    async (reason) => {
      const events: ConnectionTrace[] = [];
      const h = tracedHarness(
        (event) => events.push(event),
        reason === "automatic_empty" ? () => null : undefined,
      );
      h.api.locations = [];
      h.storage.persisted = authenticatedState({ selectedLocationId: null });
      await h.controller.initialize();
      await settleBackground();
      const result = await h.controller.connect(null);
      expect(result).toEqual({ ok: false, commandError: "invalid_location" });
      expect(h.api.proofs).toHaveLength(0);
      expect(events).toContainEqual(
        expect.objectContaining({
          event: "failure",
          source: "local",
          reason,
          error: "invalid_location",
        }),
      );
      expect(events.some((event) => event.source === "api")).toBe(false);
    },
  );

  it("records a missing manual selection locally without changing its command result", async () => {
    const events: ConnectionTrace[] = [];
    const h = tracedHarness((event) => events.push(event));
    await h.controller.initialize();
    await settleBackground();
    expect(await h.controller.selectLocation("missing-row")).toEqual({
      ok: false,
      commandError: "invalid_location",
    });
    expect(events).toContainEqual(
      expect.objectContaining({
        event: "failure",
        source: "local",
        reason: "select_missing",
        error: "invalid_location",
      }),
    );
  });
});
