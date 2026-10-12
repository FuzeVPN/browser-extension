// SPDX-License-Identifier: MPL-2.0

import { ExtensionStorageService } from "../../src/core/storage/storage";
import { popupSnapshot } from "../../src/ui/popup/snapshot";
import { NetworkError } from "../../src/core/api/client";
import { ACTIVE_SUBSCRIPTION, AUTH, PROFILE, authenticatedState, createHarness } from "./helpers";

describe("cached subscription recovery", () => {
  afterEach(() => vi.unstubAllGlobals());

  function storedSubscription(subscription: unknown) {
    const raw = { ...authenticatedState({ autoConnect: true }), subscription };
    const set = vi.fn();
    const remove = vi.fn();
    vi.stubGlobal("browser", {
      storage: { local: { get: async () => ({ fuzevpnState: raw }), set, remove } },
    });
    return { storage: new ExtensionStorageService(), raw, set, remove };
  }

  it.each([
    undefined,
    null,
    [],
    false,
    { ...ACTIVE_SUBSCRIPTION, expiresAt: "not-a-date" },
    { ...ACTIVE_SUBSCRIPTION, expiresAt: undefined },
    { ...ACTIVE_SUBSCRIPTION, startedAt: "not-a-date" },
    { ...ACTIVE_SUBSCRIPTION, offerId: 42 },
    { ...ACTIVE_SUBSCRIPTION, hasAccess: "true" },
    { ...ACTIVE_SUBSCRIPTION, renewsAutomatically: undefined },
  ])("discards only invalid billing metadata: %j", async (subscription) => {
    const f = storedSubscription(subscription);
    const persisted = await f.storage.readPersisted();
    expect(persisted).toEqual({ ...authenticatedState({ autoConnect: true }), subscription: null });
    expect(persisted.auth).toEqual(AUTH);
    expect(persisted.profile).toEqual(PROFILE);
    expect(f.raw.subscription).toBe(subscription);
    expect(f.set).not.toHaveBeenCalled();
    expect(f.remove).not.toHaveBeenCalled();
  });

  it("migrates omitted legacy metadata without changing entitlement, auth or stored bytes", async () => {
    const legacy = {
      status: "active",
      hasAccess: true,
      expiresAt: ACTIVE_SUBSCRIPTION.expiresAt,
      renewsAutomatically: true,
      ignored: "old metadata",
    };
    const f = storedSubscription(legacy);
    const persisted = await f.storage.readPersisted();
    expect(persisted.subscription).toEqual({
      status: legacy.status,
      hasAccess: true,
      offerId: null,
      startedAt: null,
      expiresAt: legacy.expiresAt,
      renewsAutomatically: true,
    });
    expect(f.raw.subscription).toEqual(legacy);
    expect(persisted.auth).toEqual(AUTH);
    expect(persisted.autoConnect).toBe(true);
    expect(f.set).not.toHaveBeenCalled();
  });

  it("restores the account and renders recovery controls offline after a corrupt cached expiry", async () => {
    const f = storedSubscription({ ...ACTIVE_SUBSCRIPTION, expiresAt: "not-a-date" });
    const persisted = await f.storage.readPersisted();
    const harness = createHarness({ persisted });
    harness.api.getProfile = async () => {
      throw new NetworkError("network");
    };
    await harness.controller.initialize();
    const snapshot = harness.controller.getSnapshot();
    const displayed = popupSnapshot(snapshot);
    expect(displayed.profile).toEqual(PROFILE);
    expect(displayed.subscription).toBeNull();
    expect(displayed.protectionRequested).toBe(true);
    expect(displayed.trafficBlocked).toBe(true);
    expect(displayed.protected).toBe(false);
    expect(harness.storage.persisted.auth).toEqual(AUTH);
    expect(harness.storage.persisted.autoConnect).toBe(true);
  });
});
