// SPDX-License-Identifier: MPL-2.0

import { displayedLocation, missingLocationMessage } from "../../src/ui/popup/location-state";
import { popupSnapshot } from "../../src/ui/popup/snapshot";
import { EMPTY_SNAPSHOT, type AppSnapshot } from "../../src/core/shared/state";
import { LOCATIONS, PROFILE } from "./helpers";

const firstLocation = LOCATIONS[0]!;
const secondLocation = LOCATIONS[1]!;

function connected(): AppSnapshot {
  return {
    ...structuredClone(EMPTY_SNAPSHOT),
    profile: PROFILE,
    status: "connected",
    protected: true,
    activeLocationId: firstLocation.id,
    activeLocation: structuredClone(firstLocation),
    locationsStatus: "loading",
  };
}

describe("Firefox location presentation during background restoration", () => {
  it("keeps the active server visible without adding it to selectable locations", () => {
    const snapshot = popupSnapshot(connected());
    expect(displayedLocation(snapshot)).toEqual(firstLocation);
    expect(snapshot.locations).toEqual([]);
    const fresh = { ...firstLocation, displayName: "Updated location name" };
    expect(displayedLocation({ ...snapshot, locations: [fresh] })).toEqual(fresh);
  });

  it("never displays cached active metadata for a different route or a disconnected account", () => {
    const snapshot = connected();
    for (const override of [
      { protected: false },
      { activeLocationId: secondLocation.id },
      { activeLocationId: null },
    ]) {
      const normalized = popupSnapshot({ ...snapshot, ...override });
      expect(normalized.activeLocation).toBeNull();
      expect(displayedLocation(normalized)).toBeNull();
    }
  });

  it("separates an unknown catalog, a network failure and a confirmed empty catalog", () => {
    expect(missingLocationMessage({ ...EMPTY_SNAPSHOT, locationsStatus: "idle" })).toBe(
      "refreshingLocations",
    );
    expect(missingLocationMessage({ ...EMPTY_SNAPSHOT, locationsStatus: "loading" })).toBe(
      "refreshingLocations",
    );
    expect(missingLocationMessage({ ...EMPTY_SNAPSHOT, locationsStatus: "error" })).toBe(
      "locationsRefreshError",
    );
    expect(missingLocationMessage({ ...EMPTY_SNAPSHOT, locationsStatus: "ready" })).toBe(
      "noLocation",
    );
  });

  it("accepts an older worker without making an unrequested catalog look empty", () => {
    const legacy = { ...connected(), locationsStatus: undefined, activeLocation: undefined };
    const normalized = popupSnapshot(legacy);
    expect(normalized.locationsStatus).toBe("idle");
    expect(displayedLocation(normalized)).toBeNull();
    expect(missingLocationMessage(normalized)).toBe("refreshingLocations");
    expect(popupSnapshot({ ...legacy, locations: LOCATIONS }).locationsStatus).toBe("ready");
  });

  it("does not label a populated catalog empty when a saved selection has disappeared", () => {
    const snapshot = { ...EMPTY_SNAPSHOT, locations: LOCATIONS, locationsStatus: "ready" as const };
    expect(displayedLocation(snapshot)).toBeNull();
    expect(missingLocationMessage(snapshot)).toBe("chooseLocation");
    expect(missingLocationMessage({ ...snapshot, protected: true })).toBe("unavailableLocation");
  });

  it("resolves the available automatic target even when the manual selection is stale", () => {
    const snapshot = {
      ...structuredClone(EMPTY_SNAPSHOT),
      locations: [secondLocation],
      selectedLocationId: firstLocation.id,
      locationPreferences: {
        ...EMPTY_SNAPSHOT.locationPreferences,
        automatic: true,
        recommendedLocationId: secondLocation.id,
      },
    };
    expect(displayedLocation(snapshot)).toEqual(secondLocation);
    expect(displayedLocation({ ...snapshot, locations: [] })).toBeNull();
  });

  it("discards malformed presentation metadata and keeps verified protection controls", () => {
    for (const activeLocation of [null, {}, { ...firstLocation, supportedProtocols: false }]) {
      const normalized = popupSnapshot({ ...connected(), activeLocation });
      expect(normalized.activeLocation).toBeNull();
      expect(normalized.protected).toBe(true);
      expect(normalized.profile).toEqual(PROFILE);
    }
  });
});
