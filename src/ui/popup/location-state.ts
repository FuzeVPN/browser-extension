// SPDX-License-Identifier: MPL-2.0

import type { AppSnapshot } from "../../core/shared/state";
import type { Location } from "../../core/api/types";

export function displayedLocation(snapshot: AppSnapshot): Location | null {
  const selectedId = snapshot.protected ? snapshot.activeLocationId : snapshot.selectedLocationId;
  if (!snapshot.protected && snapshot.locationPreferences.automatic) {
    const recommendation = snapshot.locations.find(
      ({ id }) => id === snapshot.locationPreferences.recommendedLocationId,
    );
    if (recommendation) return recommendation;
  }
  return (
    snapshot.locations.find(({ id }) => id === selectedId) ??
    (snapshot.protected && snapshot.activeLocation?.id === selectedId
      ? snapshot.activeLocation
      : !snapshot.protected && snapshot.selectedLocation?.id === selectedId
        ? snapshot.selectedLocation
        : null)
  );
}

export function missingLocationMessage(snapshot: AppSnapshot): string {
  if (snapshot.locationsStatus === "error") return "locationsRefreshError";
  if (snapshot.locations.length)
    return snapshot.protected ? "unavailableLocation" : "chooseLocation";
  return snapshot.locationsStatus === "ready" ? "noLocation" : "refreshingLocations";
}
