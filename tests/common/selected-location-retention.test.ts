// SPDX-License-Identifier: MPL-2.0

import { ApiError, NetworkError } from "../../src/core/api/client";
import { displayedLocation } from "../../src/ui/popup/location-state";
import { popupSnapshot } from "../../src/ui/popup/snapshot";
import { EMPTY_SNAPSHOT } from "../../src/core/shared/state";
import {
  AUTH,
  PROFILE,
  LOCATIONS,
  INACTIVE_SUBSCRIPTION,
  authenticatedState,
  createHarness,
  proxySession,
} from "./helpers";

async function connected() {
  const h = createHarness({ persisted: authenticatedState() });
  await h.controller.initialize();
  await h.controller.connect(LOCATIONS[0]!.id);
  return h;
}

describe("selected location independent of the current catalog", () => {
  it("migrates a restored legacy session before disconnect even without a saved identifier or catalog", async () => {
    const session = proxySession();
    const h = createHarness({
      persisted: authenticatedState({ selectedLocationId: null, autoConnect: true }),
      transient: {
        proxySession: session,
        activeLocation: LOCATIONS[0],
        refreshAttempts: 0,
        retiredSessions: [],
      },
      activeProxy: session,
    });
    let release!: (profile: typeof PROFILE) => void;
    vi.spyOn(h.api, "getProfile").mockReturnValue(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    h.api.locations = [];
    await h.controller.initialize();
    expect(h.controller.getSnapshot().protected).toBe(true);
    await h.controller.disconnect();
    const snapshot = popupSnapshot(h.controller.getSnapshot());
    expect(snapshot.selectedLocationId).toBe(LOCATIONS[0]!.id);
    expect(displayedLocation(snapshot)).toEqual(LOCATIONS[0]);
    expect(h.storage.persisted).toMatchObject({
      selectedLocationId: LOCATIONS[0]!.id,
      selectedLocation: LOCATIONS[0],
    });
    release(PROFILE);
  });
  it.each(["missing", "empty", "failed"])(
    "retains its label throughout the first disconnect with a %s catalog",
    async (mode) => {
      const h = await connected();
      h.api.locations = mode === "empty" ? [] : [LOCATIONS[1]!];
      if (mode === "failed")
        vi.spyOn(h.api, "getLocations").mockRejectedValue(new NetworkError("network"));
      await h.controller.refreshLocations();
      const start = h.snapshots.length;
      expect(await h.controller.disconnect()).toEqual({ ok: true });
      await new Promise<void>((done) => setImmediate(done));
      const after = h.snapshots.slice(start);
      expect(after.length).toBeGreaterThan(0);
      for (const snapshot of after) {
        expect(snapshot.selectedLocationId).toBe(LOCATIONS[0]!.id);
        expect(displayedLocation(popupSnapshot(snapshot))).toEqual(LOCATIONS[0]);
      }
      expect(h.storage.persisted).toMatchObject({
        selectedLocationId: LOCATIONS[0]!.id,
        selectedLocation: LOCATIONS[0],
      });
      expect(h.storage.transient.proxySession).toBeNull();
    },
  );

  it("reconnects the known selected node when a successful fresh catalog still omits it", async () => {
    const h = await connected();
    h.api.locations = [LOCATIONS[1]!];
    await h.controller.refreshLocations();
    await h.controller.disconnect();
    expect(await h.controller.connect(LOCATIONS[0]!.id)).toEqual({ ok: true });
    expect(h.api.proofs).toHaveLength(2);
    expect(h.controller.getSnapshot().activeLocationId).toBe(LOCATIONS[0]!.id);
  });

  it("restores the selected label after a worker restart without silently choosing another node", async () => {
    const h = await connected();
    await h.controller.disconnect();
    await new Promise<void>((done) => setImmediate(done));
    const restored = createHarness({
      persisted: h.storage.persisted,
      security: h.securityStorage.state!,
    });
    restored.api.locations = [LOCATIONS[1]!];
    await restored.controller.initialize();
    await restored.controller.refreshAccount();
    const snapshot = restored.controller.getSnapshot();
    expect(snapshot.selectedLocationId).toBe(LOCATIONS[0]!.id);
    expect(displayedLocation(popupSnapshot(snapshot))).toEqual(LOCATIONS[0]);
    expect(snapshot.protected).toBe(false);
  });

  it.each(["server_full", "invalid_location"] as const)(
    "retains the selected name when the server really refuses it: %s",
    async (code) => {
      const h = await connected();
      h.api.locations = [LOCATIONS[1]!];
      await h.controller.disconnect();
      h.api.createError = new ApiError(code, code === "server_full" ? 409 : 400);
      expect(await h.controller.connect(LOCATIONS[0]!.id)).toMatchObject({
        ok: false,
        commandError: code,
      });
      expect(h.api.proofs).toHaveLength(2);
      expect(displayedLocation(popupSnapshot(h.controller.getSnapshot()))).toEqual(LOCATIONS[0]);
      expect(h.controller.getSnapshot().protected).toBe(false);
    },
  );

  it("still rejects an unknown node or a fresh subscription refusal", async () => {
    const h = await connected();
    await h.controller.disconnect();
    expect(await h.controller.connect("never-selected")).toMatchObject({
      ok: false,
      commandError: "invalid_location",
    });
    h.api.subscription = INACTIVE_SUBSCRIPTION;
    expect(await h.controller.connect(LOCATIONS[0]!.id)).toMatchObject({
      ok: false,
      commandError: "subscription_required",
    });
    expect(h.api.proofs).toHaveLength(1);
  });

  it("uses fresh catalog names without losing the saved selection after a later empty response", async () => {
    const h = await connected();
    await h.controller.disconnect();
    const renamed = { ...LOCATIONS[0]!, displayName: "Updated node label" };
    h.api.locations = [renamed];
    await h.controller.refreshAccount();
    h.api.locations = [];
    await h.controller.refreshAccount();
    expect(displayedLocation(popupSnapshot(h.controller.getSnapshot()))).toEqual(renamed);
  });

  it("clears metadata on logout and does not expose it to the next account", async () => {
    const h = await connected();
    await h.controller.logout();
    expect(h.controller.getSnapshot().selectedLocation).toBeNull();
    expect(h.storage.persisted.selectedLocation).toBeNull();
    h.api.auth = { ...AUTH, accessToken: "next-account-token" };
    h.api.profile = { ...PROFILE, userId: "next-account" };
    h.api.locations = [{ ...LOCATIONS[1]!, id: "next-account-node" }];
    await h.controller.login("next@example.invalid", "synthetic-password");
    expect(h.controller.getSnapshot().selectedLocation?.id).toBe("next-account-node");
  });

  it("keeps Auto recommendations while using the retained label if no recommendation exists", () => {
    const snapshot = {
      ...structuredClone(EMPTY_SNAPSHOT),
      profile: PROFILE,
      locations: [LOCATIONS[1]!],
      selectedLocationId: LOCATIONS[0]!.id,
      selectedLocation: LOCATIONS[0],
      locationPreferences: {
        ...EMPTY_SNAPSHOT.locationPreferences,
        automatic: true,
        recommendedLocationId: LOCATIONS[1]!.id,
      },
    };
    expect(displayedLocation(popupSnapshot(snapshot))).toEqual(LOCATIONS[1]);
    expect(displayedLocation(popupSnapshot({ ...snapshot, locations: [] }))).toEqual(LOCATIONS[0]);
  });
});
