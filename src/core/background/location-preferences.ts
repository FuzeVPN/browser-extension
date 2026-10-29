// SPDX-License-Identifier: MPL-2.0

import type { Location } from "../api/types";
import type { LocationPreferencesState } from "../shared/location-preferences";
import type { NetworkObservation } from "../shared/network";

const MAX_FAVORITES = 100;
const MAX_RECENT = 5;
const MEASUREMENT_TTL_MS = 10 * 60_000;

export class LocationPreferenceError extends Error {
  constructor(readonly code: "location_favorites_limit") {
    super(code);
    this.name = "LocationPreferenceError";
  }
}

interface StoredLocationPreferences {
  favoriteIds: string[];
  recentIds: string[];
  automatic: boolean;
}

interface LocationPreferencesOptions {
  storage: {
    read(): Promise<unknown>;
    write(value: StoredLocationPreferences): Promise<void>;
  };
  onChanged(): void;
  now?: () => number;
}

interface LocationMeasurement {
  latencyMs: number;
  checkedAt: number;
}

/** Profile-local preferences; network samples remain in memory and never include an IP. */
export class LocationPreferences {
  private state: StoredLocationPreferences = {
    favoriteIds: [],
    recentIds: [],
    automatic: false,
  };
  private initialization: Promise<void> | null = null;
  private changes: Promise<void> = Promise.resolve();
  private readonly measurements = new Map<string, LocationMeasurement>();
  private readonly now: () => number;

  constructor(private readonly options: LocationPreferencesOptions) {
    this.now = options.now ?? Date.now;
  }

  initialize(): Promise<void> {
    this.initialization ??= this.options.storage
      .read()
      .then((value) => {
        const next = sanitizePreferences(value);
        if (samePreferences(next, this.state)) return;
        this.state = next;
        this.options.onChanged();
      })
      .catch((error: unknown) => {
        // A failed read must not replace existing preferences with empty defaults.
        this.initialization = null;
        throw error;
      });
    return this.initialization;
  }

  getState(locations: Location[]): LocationPreferencesState {
    const activeIds = new Set(locations.map((location) => location.id));
    const favoriteIds = this.state.favoriteIds.filter((id) => activeIds.has(id));
    const unavailableFavoriteIds = this.state.favoriteIds.filter((id) => !activeIds.has(id));
    const recentIds = this.state.recentIds.filter((id) => activeIds.has(id));
    const now = this.now();
    let measuredLocationId: string | null = null;
    let bestLatency = Number.POSITIVE_INFINITY;
    for (const location of locations) {
      const sample = this.measurements.get(location.id);
      if (
        sample &&
        sample.checkedAt <= now &&
        now - sample.checkedAt < MEASUREMENT_TTL_MS &&
        sample.latencyMs < bestLatency
      ) {
        measuredLocationId = location.id;
        bestLatency = sample.latencyMs;
      }
    }
    return {
      favoriteIds,
      ...(unavailableFavoriteIds.length ? { unavailableFavoriteIds } : {}),
      recentIds,
      automatic: this.state.automatic,
      recommendedLocationId: measuredLocationId ?? recentIds[0] ?? locations[0]?.id ?? null,
    };
  }

  setFavorite(locationId: string, favorite: boolean): Promise<void> {
    return this.update((current) => {
      assertLocationId(locationId);
      if (typeof favorite !== "boolean") throw new Error("invalid_location_preference");
      if (current.favoriteIds.includes(locationId) === favorite) return current;
      if (favorite && current.favoriteIds.length >= MAX_FAVORITES)
        throw new LocationPreferenceError("location_favorites_limit");
      return {
        ...current,
        favoriteIds: favorite
          ? [...current.favoriteIds, locationId]
          : current.favoriteIds.filter((id) => id !== locationId),
      };
    });
  }

  setAutomatic(automatic: boolean): Promise<void> {
    return this.update((current) => {
      if (typeof automatic !== "boolean") throw new Error("invalid_location_preference");
      return { ...current, automatic };
    });
  }

  recordConnected(locationId: string): Promise<void> {
    return this.update((current) => {
      assertLocationId(locationId);
      return {
        ...current,
        recentIds: [locationId, ...current.recentIds.filter((id) => id !== locationId)].slice(
          0,
          MAX_RECENT,
        ),
      };
    });
  }

  recordObservation(observation: NetworkObservation): void {
    const { status, mode, locationId, latencyMs, checkedAt } = observation;
    if (
      status !== "ready" ||
      mode !== "vpn" ||
      !isLocationId(locationId) ||
      latencyMs === null ||
      !Number.isSafeInteger(latencyMs) ||
      latencyMs < 0 ||
      checkedAt === null ||
      !Number.isSafeInteger(checkedAt) ||
      checkedAt <= 0 ||
      checkedAt > this.now() ||
      this.now() - checkedAt >= MEASUREMENT_TTL_MS
    )
      return;
    const previous = this.measurements.get(locationId);
    if (previous && previous.checkedAt >= checkedAt) return;
    this.measurements.set(locationId, { latencyMs, checkedAt });
    this.options.onChanged();
  }

  private update(
    transform: (current: StoredLocationPreferences) => StoredLocationPreferences,
  ): Promise<void> {
    const pending = this.changes.then(async () => {
      await this.initialize();
      const next = transform(this.state);
      if (samePreferences(next, this.state)) return;
      // Publish only after successful persistence; a rejected write leaves a retryable state.
      await this.options.storage.write({
        favoriteIds: [...next.favoriteIds],
        recentIds: [...next.recentIds],
        automatic: next.automatic,
      });
      this.state = next;
      this.options.onChanged();
    });
    this.changes = pending.catch(() => undefined);
    return pending;
  }
}

function sanitizePreferences(value: unknown): StoredLocationPreferences {
  return {
    favoriteIds: sanitizeIds(ownValue(value, "favoriteIds"), MAX_FAVORITES),
    recentIds: sanitizeIds(ownValue(value, "recentIds"), MAX_RECENT),
    automatic: ownValue(value, "automatic") === true,
  };
}

function sanitizeIds(value: unknown, limit: number): string[] {
  if (!Array.isArray(value)) return [];
  const result = new Set<string>();
  for (let index = 0; index < value.length && result.size < limit; index += 1) {
    const id = ownValue(value, String(index));
    if (isLocationId(id)) result.add(id);
  }
  return [...result];
}

function ownValue(value: unknown, key: string): unknown {
  if (!value || typeof value !== "object") return undefined;
  // Ignore inherited properties and accessor descriptors from malformed input.
  return Object.getOwnPropertyDescriptor(value, key)?.value;
}

function isLocationId(value: unknown): value is string {
  return typeof value === "string" && value.length <= 200 && value.trim().length > 0;
}

function assertLocationId(value: unknown): asserts value is string {
  if (!isLocationId(value)) throw new Error("invalid_location");
}

function samePreferences(a: StoredLocationPreferences, b: StoredLocationPreferences): boolean {
  return (
    a.automatic === b.automatic &&
    JSON.stringify(a.favoriteIds) === JSON.stringify(b.favoriteIds) &&
    JSON.stringify(a.recentIds) === JSON.stringify(b.recentIds)
  );
}
