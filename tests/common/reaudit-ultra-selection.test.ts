// SPDX-License-Identifier: MPL-2.0

import { ApiError, NetworkError } from "../../src/core/api/client";
import type { Location } from "../../src/core/api/types";
import { ALARM_RECONNECT } from "../../src/core/shared/config";
import { authenticatedState, createHarness, LOCATIONS, NOW, proxySession } from "./helpers";

const PARIS: Location = {
  id: "paris-01",
  city: "Paris",
  countryCode: "FR",
  displayName: "Paris 1",
  supportedProtocols: ["browser_proxy"],
};

const REMOTE_DEVICES = ["a", "b"].map((suffix) => ({
  deviceId: `remote-${suffix}`,
  name: `Browser ${suffix}`,
  kind: "browser_extension" as const,
  createdAt: "2026-08-26T12:00:00Z",
  profiles: [],
}));

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

async function ready(locations = LOCATIONS) {
  const h = createHarness({ persisted: authenticatedState() });
  h.api.locations = locations;
  h.identity.deviceId = "existing-device";
  await h.controller.initialize();
  await settle();
  return h;
}

type Harness = Awaited<ReturnType<typeof ready>>;

function selection(h: Harness) {
  return {
    snapshot: h.controller.getSnapshot().selectedLocationId,
    persisted: h.storage.persisted.selectedLocationId,
    security: h.securityStorage.state?.selectedLocationId,
  };
}

/** The superseded attempt hands its protection request to a prompt reconnection. */
async function expectReconnectionTo(h: Harness, locationId: string) {
  const reconnectAt = h.alarms.reconnectAt;
  expect(reconnectAt).not.toBeNull();
  expect(h.securityStorage.state).toMatchObject({
    nextRetryAt: reconnectAt,
    retrySuspended: false,
    capacityBlockedLocationId: null,
  });
  expect(h.controller.getSnapshot()).toMatchObject({
    status: "blocked",
    protectionRequested: true,
    nextRetryAt: reconnectAt,
    error: null,
  });
  h.setNow(reconnectAt!);
  await h.controller.handleAlarm(ALARM_RECONNECT);
  expect(h.controller.getSnapshot()).toMatchObject({
    status: "connected",
    protected: true,
    activeLocationId: locationId,
    selectedLocationId: locationId,
  });
  expect(selection(h)).toEqual({
    snapshot: locationId,
    persisted: locationId,
    security: locationId,
  });
}

describe("a newer accepted selection supersedes an older connection target", () => {
  it("discards a manual connection whose POST completes after the selection", async () => {
    const h = await ready();
    const release = deferred();
    h.api.createWait = release.promise;
    h.api.sessions = [proxySession("older-target", "frankfurt-01")];
    const connecting = h.controller.connect("frankfurt-01");
    await vi.waitFor(() => expect(h.api.proofs).toHaveLength(1));
    expect(await h.controller.selectLocation("frankfurt-02")).toEqual({ ok: true });
    release.resolve();
    expect(await connecting).toEqual({ ok: false, superseded: true });
    expect(selection(h)).toEqual({
      snapshot: "frankfurt-02",
      persisted: "frankfurt-02",
      security: "frankfurt-02",
    });
    expect(h.controller.getSnapshot()).toMatchObject({ activeLocationId: null, protected: false });
    expect(h.storage.transient.proxySession).toBeNull();
    expect(h.proxy.active).toBeNull();
    await vi.waitFor(() => expect(h.api.revoked).toContain("older-target"));
    h.api.createWait = null;
    await expectReconnectionTo(h, "frankfurt-02");
  });

  it("stops a connection before it engages protection for the older target", async () => {
    const h = await ready();
    const entered = deferred();
    const held = deferred();
    const allowRetry = h.identity.allowRecoveryRetry.bind(h.identity);
    vi.spyOn(h.identity, "allowRecoveryRetry").mockImplementationOnce(async (...args) => {
      entered.resolve();
      await held.promise;
      return allowRetry(...args);
    });
    const connecting = h.controller.connect("frankfurt-01");
    await entered.promise;
    // The selection is queued before the attempt records its target.
    const selecting = h.controller.selectLocation("frankfurt-02");
    await settle();
    held.resolve();
    expect(await selecting).toEqual({ ok: true });
    expect(await connecting).toEqual({ ok: false, superseded: true });
    expect(selection(h)).toEqual({
      snapshot: "frankfurt-02",
      persisted: "frankfurt-02",
      security: "frankfurt-02",
    });
    expect(h.api.proofs).toHaveLength(0);
    expect(h.securityStorage.state?.protectionRequested ?? false).toBe(false);
    expect(h.alarms.reconnectAt).toBeNull();
    expect(h.controller.getSnapshot()).toMatchObject({
      status: "disconnected",
      protectionRequested: false,
    });
  });

  it("keeps a selection accepted while the connection waits for a device deletion", async () => {
    const h = createHarness({ persisted: authenticatedState() });
    h.identity.deviceId = "browser-device-1";
    h.api.devices = {
      limit: 3,
      devices: [{ ...REMOTE_DEVICES[0]!, deviceId: "browser-device-1" }],
    };
    await h.controller.initialize();
    await settle();
    const entered = deferred();
    const held = deferred();
    const deleteDevice = h.api.deleteDevice.bind(h.api);
    vi.spyOn(h.api, "deleteDevice").mockImplementationOnce(async (...args) => {
      entered.resolve();
      await held.promise;
      return deleteDevice(...args);
    });
    const deleting = h.controller.deleteDevice("browser-device-1");
    await entered.promise;
    const connecting = h.controller.connect("frankfurt-01");
    await settle();
    expect(await h.controller.selectLocation("frankfurt-02")).toEqual({ ok: true });
    held.resolve();
    await deleting;
    expect(await connecting).toEqual({ ok: false, superseded: true });
    expect(selection(h)).toEqual({
      snapshot: "frankfurt-02",
      persisted: "frankfurt-02",
      security: "frankfurt-02",
    });
    expect(h.api.proofs).toHaveLength(0);
    expect(h.proxy.active).toBeNull();
    // The attempt announced itself after the selection: its status is settled.
    expect(h.controller.getSnapshot()).toMatchObject({
      status: "disconnected",
      activeLocationId: null,
    });
  });

  it("reschedules an automatic reconnection cancelled before its POST", async () => {
    const h = await ready();
    vi.spyOn(h.api, "getProfile").mockRejectedValueOnce(new NetworkError("network"));
    expect(await h.controller.connect("frankfurt-01")).toEqual({
      ok: false,
      commandError: "network_error",
    });
    const dueAt = h.alarms.reconnectAt;
    expect(dueAt).not.toBeNull();
    const entered = deferred();
    const held = deferred();
    const getSubscription = h.api.getSubscription.bind(h.api);
    vi.spyOn(h.api, "getSubscription").mockImplementationOnce(async () => {
      entered.resolve();
      await held.promise;
      return getSubscription();
    });
    h.setNow(dueAt!);
    const retrying = h.controller.handleAlarm(ALARM_RECONNECT);
    await entered.promise;
    expect(await h.controller.selectLocation("frankfurt-02")).toEqual({ ok: true });
    held.resolve();
    await retrying;
    expect(h.api.proofs).toHaveLength(0);
    // The consumed alarm is replaced: the popup must not announce a retry that never runs.
    expect(h.alarms.reconnectAt).toBeGreaterThan(dueAt!);
    await expectReconnectionTo(h, "frankfurt-02");
  });

  it("removes a late full target from the catalog without blocking the selection", async () => {
    const h = await ready();
    const posted = deferred();
    const release = deferred();
    vi.spyOn(h.api, "createProxySession").mockImplementationOnce(async () => {
      posted.resolve();
      await release.promise;
      throw new ApiError("server_full", 409);
    });
    const connecting = h.controller.connect("frankfurt-01");
    await posted.promise;
    expect(await h.controller.selectLocation("frankfurt-02")).toEqual({ ok: true });
    release.resolve();
    expect(await connecting).toEqual({ ok: false, superseded: true });
    expect(selection(h)).toEqual({
      snapshot: "frankfurt-02",
      persisted: "frankfurt-02",
      security: "frankfurt-02",
    });
    expect(h.controller.getSnapshot().locations.map((location) => location.id)).toEqual([
      "frankfurt-02",
    ]);
    expect(h.securityStorage.state?.capacityBlockedLocationId).toBeNull();
    expect(h.controller.getSnapshot().error).toBeNull();
    await expectReconnectionTo(h, "frankfurt-02");
  });

  it("keeps the server delay of a late capacity refusal for the replaced target", async () => {
    const h = await ready();
    const posted = deferred();
    const release = deferred();
    vi.spyOn(h.api, "createProxySession").mockImplementationOnce(async () => {
      posted.resolve();
      await release.promise;
      throw new ApiError("capacity_unavailable", 503, 30);
    });
    const connecting = h.controller.connect("frankfurt-01");
    await posted.promise;
    expect(await h.controller.selectLocation("frankfurt-02")).toEqual({ ok: true });
    release.resolve();
    expect(await connecting).toEqual({ ok: false, superseded: true });
    // The delay applies to the account, not only to the replaced target.
    expect(h.securityStorage.state?.retryNotBefore).toBe(NOW + 30_000);
    expect(h.alarms.reconnectAt).toBe(NOW + 30_000);
    expect(h.controller.getSnapshot().locations.map((location) => location.id)).toEqual([
      "frankfurt-01",
      "frankfurt-02",
    ]);
    await expectReconnectionTo(h, "frankfurt-02");
  });

  describe("when a settings change also cancelled the attempt", () => {
    async function cancelledRefusal(error: ApiError, cancelFirst = false) {
      const h = await ready();
      const posted = deferred();
      const release = deferred();
      vi.spyOn(h.api, "createProxySession").mockImplementationOnce(async () => {
        posted.resolve();
        await release.promise;
        throw error;
      });
      const connecting = h.controller.connect("frankfurt-01");
      await posted.promise;
      const { killSwitchEnabled, webRtcProtectionEnabled } =
        h.controller.getSnapshot().securityPreferences;
      // A new operation aborts the signal of the attempt whose POST is pending.
      const cancel = () =>
        h.controller.updateSecurityPreferences(killSwitchEnabled, webRtcProtectionEnabled);
      if (cancelFirst) expect(await cancel()).toEqual({ ok: true });
      expect(await h.controller.selectLocation("frankfurt-02")).toEqual({ ok: true });
      if (!cancelFirst) expect(await cancel()).toEqual({ ok: true });
      release.resolve();
      expect(await connecting).toEqual({ ok: false, superseded: true });
      expect(selection(h)).toEqual({
        snapshot: "frankfurt-02",
        persisted: "frankfurt-02",
        security: "frankfurt-02",
      });
      return h;
    }

    it.each([
      { order: "after", cancelFirst: false },
      { order: "before", cancelFirst: true },
    ])(
      "removes a late full target without blocking a selection made $order the cancellation",
      async ({ cancelFirst }) => {
        const h = await cancelledRefusal(new ApiError("server_full", 409), cancelFirst);
        expect(h.controller.getSnapshot().locations.map((location) => location.id)).toEqual([
          "frankfurt-02",
        ]);
        expect(h.controller.getSnapshot().error).toBeNull();
        await expectReconnectionTo(h, "frankfurt-02");
      },
    );

    it("keeps the server delay without reporting the replaced target", async () => {
      const h = await cancelledRefusal(new ApiError("capacity_unavailable", 503, 30));
      expect(h.securityStorage.state?.retryNotBefore).toBe(NOW + 30_000);
      expect(h.alarms.reconnectAt).toBe(NOW + 30_000);
      await expectReconnectionTo(h, "frankfurt-02");
    });

    it("resumes a selection accepted while the full refusal is being settled", async () => {
      const h = await ready();
      const posted = deferred();
      const release = deferred();
      vi.spyOn(h.api, "createProxySession").mockImplementationOnce(async () => {
        posted.resolve();
        await release.promise;
        throw new ApiError("server_full", 409);
      });
      const connecting = h.controller.connect("frankfurt-01");
      await posted.promise;
      const { killSwitchEnabled, webRtcProtectionEnabled } =
        h.controller.getSnapshot().securityPreferences;
      expect(
        await h.controller.updateSecurityPreferences(killSwitchEnabled, webRtcProtectionEnabled),
      ).toEqual({ ok: true });
      // The refusal still owns the selection when it records its capacity block.
      const entered = deferred();
      const held = deferred();
      const write = h.securityStorage.write.bind(h.securityStorage);
      vi.spyOn(h.securityStorage, "write").mockImplementation(async (state) => {
        if (state.capacityBlockedLocationId === "frankfurt-01") {
          entered.resolve();
          await held.promise;
        }
        return write(state);
      });
      release.resolve();
      await entered.promise;
      const selecting = h.controller.selectLocation("frankfurt-02");
      await settle();
      held.resolve();
      expect(await selecting).toEqual({ ok: true });
      expect(await connecting).toEqual({ ok: false, superseded: true });
      expect(selection(h)).toEqual({
        snapshot: "frankfurt-02",
        persisted: "frankfurt-02",
        security: "frankfurt-02",
      });
      expect(h.controller.getSnapshot().locations.map((location) => location.id)).toEqual([
        "frankfurt-02",
      ]);
      // The block that the selection cleared no longer suspends the requested protection.
      await expectReconnectionTo(h, "frankfurt-02");
    });
  });

  it("keeps the active session when a pending location change loses its target", async () => {
    const h = await ready([...LOCATIONS, PARIS]);
    expect(await h.controller.connect("frankfurt-01")).toEqual({ ok: true });
    const active = h.storage.transient.proxySession;
    const release = deferred();
    h.api.createWait = release.promise;
    h.api.sessions = [proxySession("replaced-target", "frankfurt-02")];
    const changing = h.controller.changeLocation("frankfurt-02");
    await vi.waitFor(() => expect(h.api.proofs).toHaveLength(2));
    expect(await h.controller.selectLocation(PARIS.id)).toEqual({ ok: true });
    release.resolve();
    expect(await changing).toEqual({ ok: false, superseded: true });
    expect(selection(h)).toEqual({ snapshot: PARIS.id, persisted: PARIS.id, security: PARIS.id });
    expect(h.controller.getSnapshot()).toMatchObject({
      status: "connected",
      protected: true,
      activeLocationId: "frankfurt-01",
    });
    expect(h.storage.transient.proxySession).toEqual(active);
    expect(h.proxy.active?.id).toBe(active?.id);
    await vi.waitFor(() => expect(h.api.revoked).toContain("replaced-target"));
  });

  it("keeps renewing the active session after a replaced target is refused as full", async () => {
    const h = await ready([...LOCATIONS, PARIS]);
    expect(await h.controller.connect("frankfurt-01")).toEqual({ ok: true });
    const active = h.storage.transient.proxySession;
    const posted = deferred();
    const release = deferred();
    vi.spyOn(h.api, "createProxySession").mockImplementationOnce(async () => {
      posted.resolve();
      await release.promise;
      throw new ApiError("server_full", 409);
    });
    const changing = h.controller.changeLocation("frankfurt-02");
    await posted.promise;
    expect(await h.controller.selectLocation(PARIS.id)).toEqual({ ok: true });
    release.resolve();
    expect(await changing).toEqual({ ok: false, superseded: true });
    expect(selection(h)).toEqual({ snapshot: PARIS.id, persisted: PARIS.id, security: PARIS.id });
    // The creation marker of the refused POST no longer suspends retries.
    expect(h.securityStorage.state).toMatchObject({
      retrySuspended: false,
      capacityBlockedLocationId: null,
    });
    expect(h.controller.getSnapshot()).toMatchObject({
      status: "connected",
      protected: true,
      activeLocationId: "frankfurt-01",
      error: null,
    });
    expect(h.controller.getSnapshot().locations.map((location) => location.id)).not.toContain(
      "frankfurt-02",
    );
    expect(h.storage.transient.proxySession).toEqual(active);
    expect(h.alarms.session?.id).toBe(active?.id);
  });

  it("does not reselect the retained location over a newer selection", async () => {
    const h = await ready([...LOCATIONS, PARIS]);
    expect(await h.controller.connect("frankfurt-01")).toEqual({ ok: true });
    h.api.createError = new ApiError("server_full", 409);
    await h.controller.changeLocation("frankfurt-02");
    h.api.createError = null;
    await settle();
    expect(h.securityStorage.state?.capacityBlockedLocationId).toBe("frankfurt-02");
    // Returning to the retained location first clears the other location's block.
    const entered = deferred();
    const held = deferred();
    const write = h.securityStorage.write.bind(h.securityStorage);
    vi.spyOn(h.securityStorage, "write").mockImplementationOnce(async (state) => {
      entered.resolve();
      await held.promise;
      return write(state);
    });
    const changing = h.controller.changeLocation("frankfurt-01");
    await entered.promise;
    const selecting = h.controller.selectLocation(PARIS.id);
    await settle();
    held.resolve();
    expect(await selecting).toEqual({ ok: true });
    expect(await changing).toEqual({ ok: false, superseded: true });
    expect(selection(h)).toEqual({ snapshot: PARIS.id, persisted: PARIS.id, security: PARIS.id });
    expect(h.controller.getSnapshot()).toMatchObject({
      status: "connected",
      activeLocationId: "frankfurt-01",
    });
  });

  it("lets a pending connection to the newly selected location complete", async () => {
    const h = await ready();
    const release = deferred();
    h.api.createWait = release.promise;
    const connecting = h.controller.connect("frankfurt-02");
    await vi.waitFor(() => expect(h.api.proofs).toHaveLength(1));
    expect(await h.controller.selectLocation("frankfurt-02")).toEqual({ ok: true });
    release.resolve();
    expect(await connecting).toEqual({ ok: true });
    expect(h.controller.getSnapshot()).toMatchObject({
      status: "connected",
      activeLocationId: "frankfurt-02",
      selectedLocationId: "frankfurt-02",
    });
  });

  it("ignores a rejected selection while a connection is pending", async () => {
    const h = await ready();
    const release = deferred();
    h.api.createWait = release.promise;
    const connecting = h.controller.connect("frankfurt-01");
    await vi.waitFor(() => expect(h.api.proofs).toHaveLength(1));
    expect(await h.controller.selectLocation("missing-row")).toEqual({
      ok: false,
      commandError: "invalid_location",
    });
    release.resolve();
    expect(await connecting).toEqual({ ok: true });
    expect(selection(h)).toEqual({
      snapshot: "frankfurt-01",
      persisted: "frankfurt-01",
      security: "frankfurt-01",
    });
  });
});

describe("a newer accepted selection supersedes an in-flight quota recovery", () => {
  it("keeps the selection and the enrolled device, then reconnects to it", async () => {
    const h = createHarness({ persisted: authenticatedState() });
    h.api.devices = { limit: 2, devices: structuredClone(REMOTE_DEVICES) };
    h.api.enrollError = new ApiError("device_limit", 409);
    expect(await h.controller.connect("frankfurt-01")).toEqual({
      ok: false,
      commandError: "device_limit",
    });
    expect(await h.controller.refreshDevices()).toEqual({ ok: true });
    h.api.enrollError = null;
    vi.spyOn(h.api, "getDevices").mockRejectedValue(new NetworkError("network"));
    const enrolling = deferred();
    const held = deferred();
    const enroll = h.api.enrollBrowserDevice.bind(h.api);
    vi.spyOn(h.api, "enrollBrowserDevice").mockImplementationOnce(async (...args) => {
      const result = await enroll(...args);
      enrolling.resolve();
      await held.promise;
      return result;
    });
    const proofs = h.api.proofs.length;
    const deleting = h.controller.deleteDevice("remote-a");
    await enrolling.promise;
    expect(await h.controller.selectLocation("frankfurt-02")).toEqual({ ok: true });
    held.resolve();
    expect(await deleting).toEqual({ ok: false, superseded: true });
    expect(selection(h)).toEqual({
      snapshot: "frankfurt-02",
      persisted: "frankfurt-02",
      security: "frankfurt-02",
    });
    expect(h.controller.getSnapshot()).toMatchObject({ activeLocationId: null, protected: false });
    expect(h.api.proofs).toHaveLength(proofs);
    expect(h.storage.transient.proxySession).toBeNull();
    // The freed slot now belongs to this browser for the resumed connection.
    expect(h.identity.deviceId).toBe("browser-device-1");
    await expectReconnectionTo(h, "frankfurt-02");
    expect(h.api.enrollCalls).toBe(2);
  });
});
