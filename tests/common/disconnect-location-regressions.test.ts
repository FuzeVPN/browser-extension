// SPDX-License-Identifier: MPL-2.0

import { ALARM_EXPIRY, ALARM_RECONNECT } from "../../src/core/shared/config";
import type { Location } from "../../src/core/api/types";
import { ApiError } from "../../src/core/api/client";
import { displayedLocation } from "../../src/ui/popup/location-state";
import { LOCATIONS, authenticatedState, createHarness } from "./helpers";

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function connected() {
  const h = createHarness({ persisted: authenticatedState() });
  await h.controller.initialize();
  await h.controller.connect(LOCATIONS[0]!.id);
  return h;
}

describe("disconnect and location recovery", () => {
  it("keeps an explicit disconnect final when a due reconnect alarm arrives during cleanup", async () => {
    const h = await connected();
    h.setNow(Date.parse(h.proxy.active!.expiresAt) + 1);
    await h.controller.handleAlarm(ALARM_EXPIRY);
    const retryAt = h.controller.getSnapshot().nextRetryAt;
    expect(retryAt).not.toBeNull();
    h.setNow(retryAt!);
    // A capacity-limited catalog can omit the old node until its lease is released.
    h.api.locations = [LOCATIONS[1]!];
    const clearing = deferred();
    const clear = vi.spyOn(h.alarms, "clearAll").mockImplementationOnce(() => clearing.promise);
    const disconnect = h.controller.disconnect();
    await vi.waitFor(() => expect(clear).toHaveBeenCalledOnce());
    expect(h.controller.getSnapshot().status).toBe("disconnecting");
    const alarm = h.controller.handleAlarm(ALARM_RECONNECT);
    await new Promise<void>((done) => setImmediate(done));
    clearing.resolve();
    const [result] = await Promise.all([disconnect, alarm]);
    expect(result).toEqual({ ok: true });
    expect(h.controller.getSnapshot()).toMatchObject({
      status: "disconnected",
      protected: false,
      protectionRequested: false,
      trafficBlocked: false,
      error: null,
      nextRetryAt: null,
    });
    expect(h.api.proofs).toHaveLength(1);
    expect(h.proxy.active).toBeNull();
  });

  it("reloads the selectable catalog after revocation releases the previous node", async () => {
    const h = await connected();
    h.api.locations = [LOCATIONS[1]!];
    await h.controller.refreshLocations();
    expect(h.controller.getSnapshot().activeLocationId).toBe(LOCATIONS[0]!.id);
    const revocation = deferred();
    const revoke = vi.spyOn(h.api, "revokeProxySession").mockImplementation(async () => {
      await revocation.promise;
      h.api.locations = LOCATIONS;
    });
    expect(await h.controller.disconnect()).toEqual({ ok: true });
    expect(h.controller.getSnapshot().protectionRequested).toBe(false);
    await vi.waitFor(() => expect(revoke).toHaveBeenCalledOnce());
    revocation.resolve();
    await vi.waitFor(() => expect(h.controller.getSnapshot().locations).toEqual(LOCATIONS));
    const snapshot = h.controller.getSnapshot();
    expect(snapshot.selectedLocationId).toBe(LOCATIONS[0]!.id);
    expect(displayedLocation(snapshot)).toEqual(LOCATIONS[0]);
    expect(snapshot).toMatchObject({ status: "disconnected", error: null, trafficBlocked: false });
  });

  it("cancels a pending manual retry when disconnect becomes the newer intent", async () => {
    const h = await connected();
    h.api.createError = new ApiError("server_full", 409);
    await h.controller.retryConnection();
    const writing = deferred();
    const write = vi
      .spyOn(h.securityStorage, "write")
      .mockImplementationOnce(() => writing.promise);
    const retry = h.controller.retryConnection();
    await vi.waitFor(() => expect(write).toHaveBeenCalledOnce());
    const disconnect = h.controller.disconnect();
    await vi.waitFor(() => expect(h.controller.getSnapshot().status).toBe("disconnecting"));
    writing.resolve();
    expect(await retry).toEqual({ ok: false, superseded: true });
    expect(await disconnect).toEqual({ ok: true });
    expect(h.controller.getSnapshot()).toMatchObject({
      status: "disconnected",
      protectionRequested: false,
      trafficBlocked: false,
      error: null,
    });
  });

  it("ignores a catalog started before disconnect when it arrives after the released-node catalog", async () => {
    const h = await connected();
    const oldCatalog = deferred<Location[]>();
    const getLocations = vi.spyOn(h.api, "getLocations").mockReturnValueOnce(oldCatalog.promise);
    const refresh = h.controller.refreshLocations();
    await vi.waitFor(() => expect(getLocations).toHaveBeenCalledOnce());
    expect(await h.controller.disconnect()).toEqual({ ok: true });
    await vi.waitFor(() => expect(getLocations).toHaveBeenCalledTimes(2));
    oldCatalog.resolve([LOCATIONS[1]!]);
    await refresh;
    expect(h.controller.getSnapshot().locations).toEqual(LOCATIONS);
    expect(displayedLocation(h.controller.getSnapshot())).toEqual(LOCATIONS[0]);
  });

  it("does not refresh an account after logout supersedes delayed revocation", async () => {
    const h = await connected();
    const revocation = deferred();
    vi.spyOn(h.api, "revokeProxySession").mockReturnValue(revocation.promise);
    await h.controller.disconnect();
    const getLocations = vi.spyOn(h.api, "getLocations");
    const logout = h.controller.logout();
    await vi.waitFor(() => expect(h.controller.getSnapshot().profile).toBeNull());
    revocation.resolve();
    await logout;
    expect(getLocations).not.toHaveBeenCalled();
  });
});
