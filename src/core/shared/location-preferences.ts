// SPDX-License-Identifier: MPL-2.0

export interface LocationPreferencesState {
  favoriteIds: string[];
  unavailableFavoriteIds?: string[];
  recentIds: string[];
  automatic: boolean;
  recommendedLocationId: string | null;
}

export const EMPTY_LOCATION_PREFERENCES: LocationPreferencesState = {
  favoriteIds: [],
  recentIds: [],
  automatic: false,
  recommendedLocationId: null,
};
