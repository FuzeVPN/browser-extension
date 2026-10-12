// SPDX-License-Identifier: MPL-2.0

import type { AppSnapshot } from "../../core/shared/state";
import type { Location } from "../../core/api/types";

export function displayedLocation(snapshot: AppSnapshot): Location | null {
  const selectedId = snapshot.protected
    ? snapshot.activeLocationId
    : snapshot.locationPreferences.automatic
      ? snapshot.locationPreferences.recommendedLocationId
      : snapshot.selectedLocationId;
  return (
    snapshot.locations.find(({ id }) => id === selectedId) ??
    (snapshot.protected && snapshot.activeLocation?.id === selectedId
      ? snapshot.activeLocation
      : null)
  );
}

export function missingLocationMessage(snapshot: AppSnapshot): string {
  if (snapshot.locationsStatus === "error") return "locationsRefreshError";
  if (snapshot.locations.length)
    return snapshot.protected ? "unavailableLocation" : "chooseLocation";
  return snapshot.locationsStatus === "ready" ? "noLocation" : "refreshingLocations";
}
