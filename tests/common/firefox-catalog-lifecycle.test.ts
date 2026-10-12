// SPDX-License-Identifier: MPL-2.0

import { NetworkError } from "../../src/core/api/client";
import type { Location } from "../../src/core/api/types";
import { DEFAULT_SECURITY_STATE } from "../../src/core/shared/security";
import {
  AUTH,
  INACTIVE_SUBSCRIPTION,
  LOCATIONS,
  PROFILE,
  authenticatedState,
  createHarness,
  proxySession,
} from "./helpers";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

async function settleBackground() {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

function restoredAccount() {
  const session = proxySession();
  return createHarness({
    persisted: authenticatedState({ autoConnect: true }),
    transient: {
      proxySession: session,
      activeLocation: LOCATIONS[0],
      refreshAttempts: 0,
      retiredSessions: [],
    },
    activeProxy: session,
  });
}

describe("Firefox catalog restoration and account isolation", () => {
  it.each([null, "removed-location"])(
    "selects a visible idle default for %s before slow account hydration finishes",
    async (selectedLocationId) => {
      const h = createHarness({ persisted: authenticatedState({ selectedLocationId }) });
      const profile = deferred<typeof PROFILE>();
      vi.spyOn(h.api, "getProfile").mockReturnValue(profile.promise);
      await h.controller.initialize();
      await settleBackground();
      expect(h.controller.getSnapshot()).toMatchObject({
        status: "disconnected",
        selectedLocationId: LOCATIONS[0]!.id,
        locationsStatus: "ready",
      });
      // Catalog presentation does not silently rewrite durable user intent.
      expect(h.storage.persisted.selectedLocationId).toBe(selectedLocationId);
      profile.resolve(PROFILE);
      await settleBackground();
      expect(h.controller.getSnapshot().selectedLocationId).toBe(LOCATIONS[0]!.id);
    },
  );

  it("preserves a manual selection made while a catalog refresh is pending", async () => {
    const h = createHarness({ persisted: authenticatedState() });
    await h.controller.initialize();
    await settleBackground();
    const catalog = deferred<Location[]>();
    vi.spyOn(h.api, "getLocations").mockReturnValueOnce(catalog.promise);
    const refresh = h.controller.refreshAccount();
    await settleBackground();
    await h.controller.selectLocation(LOCATIONS[1]!.id);
    catalog.resolve([LOCATIONS[0]!]);
    await refresh;
    expect(h.controller.getSnapshot().selectedLocationId).toBe(LOCATIONS[1]!.id);
    expect(h.storage.persisted.selectedLocationId).toBe(LOCATIONS[1]!.id);
  });

  it.each(["active", "retry"])(
    "preserves a %s protection target absent from the refreshed catalog",
    async (mode) => {
      const h =
        mode === "active"
          ? restoredAccount()
          : createHarness({
              persisted: authenticatedState(),
              security: {
                ...DEFAULT_SECURITY_STATE,
                protectionRequested: true,
                selectedLocationId: LOCATIONS[0]!.id,
                retrySuspended: true,
              },
            });
      h.api.locations = [LOCATIONS[1]!];
      await h.controller.initialize();
      await h.controller.refreshAccount();
      expect(h.controller.getSnapshot().selectedLocationId).toBe(LOCATIONS[0]!.id);
      expect(h.securityStorage.state?.selectedLocationId).toBe(LOCATIONS[0]!.id);
      if (mode === "active") {
        expect(h.controller.getSnapshot().activeLocationId).toBe(LOCATIONS[0]!.id);
        expect(h.proxy.active?.locationId).toBe(LOCATIONS[0]!.id);
      }
    },
  );

  it("finishes local disconnected restoration while every remote account read is pending", async () => {
    const h = createHarness({ persisted: authenticatedState() });
    const profile = deferred<typeof PROFILE>();
    const subscription = deferred<typeof h.api.subscription>();
    const locations = deferred<Location[]>();
    vi.spyOn(h.api, "getProfile").mockReturnValue(profile.promise);
    vi.spyOn(h.api, "getSubscription").mockReturnValue(subscription.promise);
    vi.spyOn(h.api, "getLocations").mockReturnValue(locations.promise);
    await h.controller.initialize();
    expect(h.controller.getSnapshot()).toMatchObject({
      status: "disconnected",
      protectionRequested: false,
      trafficBlocked: false,
      locationsStatus: "loading",
      locations: [],
    });
    profile.resolve(PROFILE);
    subscription.resolve(h.api.subscription);
    locations.resolve(LOCATIONS);
    await settleBackground();
  });

  it("publishes locations before a slow subscription/profile refresh after wake", async () => {
    const h = restoredAccount();
    const profile = deferred<typeof PROFILE>();
    const subscription = deferred<typeof h.api.subscription>();
    vi.spyOn(h.api, "getProfile").mockReturnValue(profile.promise);
    vi.spyOn(h.api, "getSubscription").mockReturnValue(subscription.promise);
    await h.controller.initialize();
    await settleBackground();
    expect(h.controller.getSnapshot()).toMatchObject({
      protected: true,
      locationsStatus: "ready",
      locations: LOCATIONS,
      activeLocation: LOCATIONS[0],
    });
    profile.resolve(PROFILE);
    subscription.resolve(h.api.subscription);
    await settleBackground();
  });

  it("shares one catalog request across startup, account refresh and catalog retry", async () => {
    const h = restoredAccount();
    const locations = deferred<Location[]>();
    const request = vi.spyOn(h.api, "getLocations").mockReturnValue(locations.promise);
    await h.controller.initialize();
    const account = h.controller.refreshAccount();
    const retry = h.controller.refreshLocations();
    await settleBackground();
    expect(request).toHaveBeenCalledOnce();
    expect(h.controller.getSnapshot().locationsStatus).toBe("loading");
    locations.resolve(LOCATIONS);
    await Promise.all([account, retry]);
    expect(h.controller.getSnapshot().locationsStatus).toBe("ready");
  });

  it("retains the last catalog and VPN state when a catalog refresh fails", async () => {
    const h = restoredAccount();
    await h.controller.initialize();
    await settleBackground();
    vi.spyOn(h.api, "getLocations").mockRejectedValueOnce(new NetworkError("timeout"));
    expect(await h.controller.refreshLocations()).toEqual({
      ok: false,
      commandError: "request_timeout",
    });
    expect(h.controller.getSnapshot()).toMatchObject({
      status: "connected",
      protected: true,
      locations: LOCATIONS,
      locationsStatus: "error",
      locationsError: "request_timeout",
      error: null,
    });
  });

  it("distinguishes a successful empty catalog from a pending or failed read", async () => {
    const h = createHarness({ persisted: authenticatedState() });
    h.api.locations = [];
    await h.controller.initialize();
    await settleBackground();
    expect(h.controller.getSnapshot()).toMatchObject({
      locations: [],
      locationsStatus: "ready",
      locationsError: null,
    });
  });

  it.each(["success", "failure"])(
    "ignores an old account's late catalog %s after logout and a new login",
    async (outcome) => {
      const h = restoredAccount();
      const old = deferred<Location[]>();
      vi.spyOn(h.api, "getLocations").mockReturnValueOnce(old.promise);
      await h.controller.initialize();
      await settleBackground();
      await h.controller.logout();
      h.api.auth = { ...AUTH, accessToken: "next-owner-token" };
      h.api.profile = { ...PROFILE, userId: "next-owner" };
      h.api.locations = [{ ...LOCATIONS[0]!, id: "next-owner-location" }];
      await h.controller.login("next@example.invalid", "synthetic-password");
      const snapshot = h.controller.getSnapshot();
      if (outcome === "success") old.resolve(LOCATIONS);
      else old.reject(new NetworkError("network"));
      await settleBackground();
      expect(h.controller.getSnapshot()).toEqual(snapshot);
      expect(snapshot.locations).toEqual(h.api.locations);
      expect(snapshot.profile?.userId).toBe("next-owner");
    },
  );

  it("does not let a visible catalog bypass a fresh subscription rejection", async () => {
    const h = createHarness({ persisted: authenticatedState() });
    await h.controller.initialize();
    await settleBackground();
    expect(h.controller.getSnapshot().locations).toEqual(LOCATIONS);
    h.api.subscription = INACTIVE_SUBSCRIPTION;
    expect(await h.controller.connect(LOCATIONS[0]!.id)).toEqual({
      ok: false,
      commandError: "subscription_required",
    });
    expect(h.api.proofs).toHaveLength(0);
    expect(h.controller.getSnapshot()).toMatchObject({ protected: false, trafficBlocked: true });
  });

  it("stores only active public metadata with the session and restores its label before the catalog", async () => {
    const h = createHarness({ persisted: authenticatedState() });
    await h.controller.initialize();
    await h.controller.connect(LOCATIONS[0]!.id);
    expect(h.storage.transient.activeLocation).toEqual(LOCATIONS[0]);
    expect(h.storage.persisted).not.toHaveProperty("locations");
    expect(h.storage.persisted).not.toHaveProperty("activeLocation");
    const restored = createHarness({
      persisted: h.storage.persisted,
      transient: h.storage.transient,
      activeProxy: h.proxy.active!,
    });
    const catalog = deferred<Location[]>();
    vi.spyOn(restored.api, "getLocations").mockReturnValue(catalog.promise);
    await restored.controller.initialize();
    expect(restored.controller.getSnapshot()).toMatchObject({
      activeLocation: LOCATIONS[0],
      locations: [],
      locationsStatus: "loading",
      protected: true,
    });
    catalog.resolve([]);
    await settleBackground();
    expect(restored.controller.getSnapshot()).toMatchObject({
      activeLocation: LOCATIONS[0],
      locations: [],
      locationsStatus: "ready",
    });
  });

  it("still fails closed if persisted local policy cannot be read", async () => {
    const h = createHarness({ persisted: authenticatedState() });
    vi.spyOn(h.storage, "readPersisted").mockRejectedValue(new Error("unreadable storage"));
    const catalog = vi.spyOn(h.api, "getLocations");
    await h.controller.initialize();
    expect(h.controller.getSnapshot()).toMatchObject({
      protected: false,
      protectionRequested: true,
      trafficBlocked: true,
      error: "storage_unavailable",
    });
    expect(catalog).not.toHaveBeenCalled();
  });
});
