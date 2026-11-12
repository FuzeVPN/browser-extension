// SPDX-License-Identifier: MPL-2.0

import type { NetworkObservation } from "../shared/network";
import { isPublicIpv4 } from "./network-observer";

const MAX_LOCATIONS = 64;
const RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
// A measurement which only confirms the stored address is written again once a day.
const CONFIRMATION_MS = 24 * 60 * 60 * 1_000;

interface RememberedAddress {
  ip: string;
  checkedAt: number;
}

export interface VpnAddressStorage {
  read(): Promise<unknown>;
  write(value: unknown): Promise<void>;
}

/**
 * The IPv4 last measured through each VPN location. A new tunnel refuses requests for
 * about a second, so no measurement can be displayed with the connected state; the
 * address measured last time can. It is only ever a previous measurement: the observer
 * shows it while it measures the new route, and replaces it with the result. A
 * measurement which finally fails forgets it, in every later worker too.
 */
export class VpnAddressBook {
  private readonly addresses = new Map<string, RememberedAddress>();
  // Locations forgotten before the stored record could be read.
  private readonly forgotten = new Set<string>();
  private initialization: Promise<void> | null = null;
  private loaded = false;
  private dirty = false;
  private writes: Promise<void> = Promise.resolve();
  private readonly now: () => number;

  constructor(private readonly options: { storage: VpnAddressStorage; now?: () => number }) {
    this.now = options.now ?? Date.now;
  }

  /** Never rejects: an unreadable memory only means no address is displayed early. */
  initialize(): Promise<void> {
    this.initialization ??= this.options.storage
      .read()
      .then((stored) => {
        // What this worker measured or forgot while the read was pending is newer.
        const measured = [...this.addresses];
        const forgotten = new Set(this.forgotten);
        const current = decode(stored, this.now());
        this.addresses.clear();
        for (const [locationId, address] of current)
          if (!forgotten.has(locationId)) this.keep(locationId, address);
        for (const [locationId, address] of measured) this.keep(locationId, address);
        this.forgotten.clear();
        this.loaded = true;
        // An address past its retention leaves the stored record as soon as it is read.
        if (this.dirty || storedCount(stored) > current.length) this.persist();
      })
      .catch(() => {
        this.initialization = null;
      });
    return this.initialization;
  }

  recall(locationId: string): string | null {
    const address = this.addresses.get(locationId);
    return address && this.isCurrent(address) ? address.ip : null;
  }

  /** Remembers a verified VPN measurement; a measurement which failed forgets its location. */
  record(observation: NetworkObservation): void {
    const { status, mode, locationId, ip, checkedAt } = observation;
    if (mode !== "vpn" || !isLocationId(locationId)) return;
    if (status === "unavailable") {
      this.forget(locationId);
      return;
    }
    if (
      status !== "ready" ||
      ip === null ||
      !isPublicIpv4(ip) ||
      !isTimestamp(checkedAt) ||
      checkedAt > this.now()
    )
      return;
    const previous = this.addresses.get(locationId);
    if (
      previous &&
      // An address dated after the present clock is replaced, never trusted.
      this.isCurrent(previous) &&
      (previous.checkedAt >= checkedAt ||
        (previous.ip === ip && checkedAt - previous.checkedAt < CONFIRMATION_MS))
    )
      return;
    this.keep(locationId, { ip, checkedAt });
    this.persist();
  }

  private forget(locationId: string): void {
    if (!this.loaded) this.forgotten.add(locationId);
    if (!this.addresses.delete(locationId) && this.loaded) return;
    this.persist();
  }

  private isCurrent(address: RememberedAddress): boolean {
    const age = this.now() - address.checkedAt;
    return age >= 0 && age < RETENTION_MS;
  }

  private keep(locationId: string, address: RememberedAddress): void {
    // Insertion order is the eviction order: the location measured last is kept longest.
    this.addresses.delete(locationId);
    this.addresses.set(locationId, address);
    while (this.addresses.size > MAX_LOCATIONS) {
      const oldest = this.addresses.keys().next();
      if (oldest.done) break;
      this.addresses.delete(oldest.value);
    }
  }

  private persist(): void {
    this.dirty = true;
    // Best effort, in order: a failed write costs one early display, never a measurement.
    this.writes = this.writes
      .then(() => this.initialize())
      .then(async () => {
        // A record which could not be read is never replaced by this worker's part of it.
        if (!this.loaded || !this.dirty) return;
        for (const [locationId, address] of this.addresses)
          if (!this.isCurrent(address)) this.addresses.delete(locationId);
        this.dirty = false;
        await this.options.storage.write({
          version: 1,
          addresses: [...this.addresses].map(([locationId, { ip, checkedAt }]) => ({
            locationId,
            ip,
            checkedAt,
          })),
        });
      })
      .catch(() => undefined);
  }
}

function decode(stored: unknown, now: number): [string, RememberedAddress][] {
  if (!isRecord(stored) || stored.version !== 1 || !Array.isArray(stored.addresses)) return [];
  const result: [string, RememberedAddress][] = [];
  for (const entry of stored.addresses.slice(-MAX_LOCATIONS) as unknown[]) {
    if (
      isRecord(entry) &&
      isLocationId(entry.locationId) &&
      typeof entry.ip === "string" &&
      isPublicIpv4(entry.ip) &&
      isTimestamp(entry.checkedAt) &&
      // Neither an address past its retention nor one dated after the present clock.
      entry.checkedAt <= now &&
      now - entry.checkedAt < RETENTION_MS
    )
      result.push([entry.locationId, { ip: entry.ip, checkedAt: entry.checkedAt }]);
  }
  return result;
}

/** The entries of a readable record, including those which are no longer kept. */
function storedCount(stored: unknown): number {
  return isRecord(stored) && stored.version === 1 && Array.isArray(stored.addresses)
    ? stored.addresses.length
    : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isLocationId(value: unknown): value is string {
  return typeof value === "string" && value.length <= 200 && value.trim().length > 0;
}

function isTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
