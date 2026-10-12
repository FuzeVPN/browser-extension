// SPDX-License-Identifier: MPL-2.0

import { ApiError } from "../../src/core/api/client";
import { AppController } from "../../src/core/background/state-machine";
import { ALARM_EXPIRY } from "../../src/core/shared/config";
import { chooseGroupLocation } from "../../src/ui/popup/location-groups";
import { authenticatedState, createHarness, LOCATIONS, NOW, PROFILE } from "./helpers";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

async function refusedChange(resolver: boolean) {
  const h = createHarness({ persisted: authenticatedState() });
  let now = NOW;
  let automatic: string | undefined;
  const controller = new AppController({
    api: h.api,
    storage: h.storage,
    identity: h.identity,
    proxy: h.proxy,
    alarms: h.alarms,
    safety: h.safety,
    securityStorage: h.securityStorage,
    now: () => now,
    onStateChanged: (snapshot) => h.snapshots.push(snapshot),
    ...(resolver ? { resolveAutomaticLocation: () => automatic } : {}),
  });
  h.identity.deviceId = "existing-device";
  await controller.initialize();
  await controller.connect(LOCATIONS[0]!.id);
  h.api.createError = new ApiError("server_full", 409);
  expect(await controller.changeLocation(LOCATIONS[1]!.id)).toMatchObject({
    ok: false,
    commandError: "server_full",
  });
  expect(controller.getSnapshot()).toMatchObject({
    activeLocationId: LOCATIONS[0]!.id,
    selectedLocationId: LOCATIONS[1]!.id,
    protected: true,
    error: "server_full",
  });
  return {
    ...h,
    controller,
    setNow(value: number) {
      now = value;
    },
    setAutomatic(value: string) {
      automatic = value;
    },
  };
}

describe.each([false, true])("selecting the retained server (resolver: %s)", (resolver) => {
  it("commits the group choice after a full refusal without creating or extending a session", async () => {
    const h = await refusedChange(resolver);
    const previous = structuredClone(h.storage.transient.proxySession);
    const alarms = structuredClone(h.alarms.session);
    const create = vi.spyOn(h.api, "createProxySession");
    const apply = vi.spyOn(h.proxy, "apply");
    const selected = chooseGroupLocation(LOCATIONS, h.controller.getSnapshot());
    expect(selected?.id).toBe(LOCATIONS[0]!.id);
    expect(await h.controller.changeLocation(selected!.id)).toEqual({ ok: true });
    expect(h.controller.getSnapshot()).toMatchObject({
      status: "connected",
      activeLocationId: LOCATIONS[0]!.id,
      selectedLocationId: LOCATIONS[0]!.id,
      protected: true,
      error: null,
    });
    expect(h.storage.persisted.selectedLocationId).toBe(LOCATIONS[0]!.id);
    expect(h.securityStorage.state).toMatchObject({
      selectedLocationId: LOCATIONS[0]!.id,
      capacityBlockedLocationId: null,
      protectionRequested: true,
    });
    expect(h.storage.transient.proxySession).toEqual(previous);
    expect(h.alarms.session).toEqual(alarms);
    expect(h.proxy.active).toEqual(previous);
    expect(create).not.toHaveBeenCalled();
    expect(apply).not.toHaveBeenCalled();
    h.setNow(Date.parse(previous!.expiresAt));
    await h.controller.handleAlarm(ALARM_EXPIRY);
    expect(h.controller.getSnapshot().protected).toBe(false);
    expect(await h.controller.getActiveSession()).toBeNull();
    expect(create).not.toHaveBeenCalled();
  });

  it.each(["disconnect", "logout"] as const)(
    "does not restore protection when %s supersedes a delayed selection write",
    async (action) => {
      const h = await refusedChange(resolver);
      const writing = deferred<undefined>();
      const release = deferred<undefined>();
      const write = h.storage.writePersisted.bind(h.storage);
      vi.spyOn(h.storage, "writePersisted").mockImplementationOnce(async (state) => {
        writing.resolve(undefined);
        await release.promise;
        await write(state);
      });
      const selecting = h.controller.changeLocation(LOCATIONS[0]!.id);
      await writing.promise;
      const stopping = h.controller[action]();
      await vi.waitFor(() => expect(h.controller.getSnapshot().status).toBe("disconnecting"));
      release.resolve(undefined);
      expect(await selecting).toMatchObject({ ok: false, superseded: true });
      await stopping;
      expect(h.controller.getSnapshot()).toMatchObject({
        status: action === "logout" ? "logged_out" : "disconnected",
        protected: false,
        protectionRequested: false,
        activeLocationId: null,
      });
      expect(h.securityStorage.state?.protectionRequested).toBe(false);
      expect(h.storage.transient.proxySession).toBeNull();
      expect(h.proxy.active).toBeNull();
      if (action === "logout") {
        expect(h.storage.persisted.auth).toBeNull();
        h.api.profile = { ...PROFILE, userId: "new-account" };
        h.api.locations = [LOCATIONS[1]!];
        h.api.createError = null;
        await h.controller.login("other@example.test", "test-password");
        expect(h.controller.getSnapshot()).toMatchObject({
          profile: { userId: "new-account" },
          selectedLocationId: LOCATIONS[1]!.id,
          protected: false,
        });
        expect(h.storage.persisted.profile?.userId).toBe("new-account");
      }
    },
  );

  it("does not claim protection if the retained session expires during its selection write", async () => {
    const h = await refusedChange(resolver);
    const previous = structuredClone(h.storage.transient.proxySession)!;
    const write = h.storage.writePersisted.bind(h.storage);
    vi.spyOn(h.storage, "writePersisted").mockImplementationOnce(async (state) => {
      h.setNow(Date.parse(previous.expiresAt));
      await write(state);
    });
    const create = vi.spyOn(h.api, "createProxySession");
    expect(await h.controller.changeLocation(LOCATIONS[0]!.id)).toMatchObject({
      ok: false,
      commandError: "session_expired",
    });
    expect(h.controller.getSnapshot().protected).toBe(false);
    expect(await h.controller.getActiveSession()).toBeNull();
    expect(create).not.toHaveBeenCalled();
  });
});

it("commits an automatic group result that resolves to the retained session", async () => {
  const h = await refusedChange(true);
  const previous = structuredClone(h.storage.transient.proxySession);
  const create = vi.spyOn(h.api, "createProxySession");
  h.setAutomatic(LOCATIONS[0]!.id);
  expect(await h.controller.changeLocation(LOCATIONS[1]!.id)).toEqual({ ok: true });
  expect(h.controller.getSnapshot().selectedLocationId).toBe(LOCATIONS[0]!.id);
  expect(h.storage.persisted.selectedLocationId).toBe(LOCATIONS[0]!.id);
  expect(h.securityStorage.state?.selectedLocationId).toBe(LOCATIONS[0]!.id);
  expect(h.storage.transient.proxySession).toEqual(previous);
  expect(create).not.toHaveBeenCalled();
});
