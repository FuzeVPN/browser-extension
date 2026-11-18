// SPDX-License-Identifier: MPL-2.0

import { extensionApi } from "@platform/bridge";
import type { Location } from "../api/types";

export const ACCOUNT_CACHE_KEY = "fuzevpnAccountCache";
const MAX_CACHED_LOCATIONS = 2_000;

/** What the last account refresh received, for the workers which follow it. */
export interface AccountCache {
  /** The catalogue as the API last returned it. */
  locations: Location[];
  /** When the profile, the subscription and the catalogue were last read together. */
  refreshedAt: number;
}

export interface AccountCacheStorage {
  /** What was kept for this account, or null: another account's is never returned. */
  read(userId: string): Promise<AccountCache | null>;
  write(userId: string, cache: AccountCache): Promise<void>;
  clear(): Promise<void>;
}

/**
 * Kept in session storage: it lasts as long as the browser stays open, and the first
 * worker of a browser session reads the account from the API. The record names its
 * account by a digest, never by the identifier itself.
 */
export class ExtensionAccountCacheStorage implements AccountCacheStorage {
  /** Operations apply in the order they were asked for, whatever a digest takes. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly digest: (userId: string) => Promise<string>) {}

  read(userId: string): Promise<AccountCache | null> {
    return this.enqueue(async () => {
      const owner = await this.digest(userId);
      const stored = await extensionApi.storage.session.get(ACCOUNT_CACHE_KEY);
      return decodeAccountCache(stored[ACCOUNT_CACHE_KEY], owner);
    });
  }

  write(userId: string, cache: AccountCache): Promise<void> {
    return this.enqueue(async () => {
      const owner = await this.digest(userId);
      await extensionApi.storage.session.set({
        [ACCOUNT_CACHE_KEY]: {
          owner,
          refreshedAt: cache.refreshedAt,
          locations: cache.locations,
        },
      });
    });
  }

  clear(): Promise<void> {
    return this.enqueue(() => extensionApi.storage.session.remove(ACCOUNT_CACHE_KEY));
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task);
    this.queue = run.catch(() => undefined);
    return run;
  }
}

/** A stored record of this owner, or null when anything in it cannot be relied on. */
export function decodeAccountCache(value: unknown, owner: string): AccountCache | null {
  if (!isRecord(value) || value.owner !== owner) return null;
  const { refreshedAt, locations } = value;
  if (typeof refreshedAt !== "number" || !Number.isSafeInteger(refreshedAt) || refreshedAt <= 0)
    return null;
  if (!Array.isArray(locations) || locations.length > MAX_CACHED_LOCATIONS) return null;
  const decoded: Location[] = [];
  const identifiers = new Set<string>();
  for (const item of locations as unknown[]) {
    if (
      !isRecord(item) ||
      typeof item.id !== "string" ||
      item.id.length === 0 ||
      identifiers.has(item.id) ||
      typeof item.city !== "string" ||
      typeof item.countryCode !== "string" ||
      typeof item.displayName !== "string" ||
      !Array.isArray(item.supportedProtocols) ||
      !item.supportedProtocols.every((protocol) => typeof protocol === "string")
    )
      return null;
    identifiers.add(item.id);
    decoded.push({
      id: item.id,
      city: item.city,
      countryCode: item.countryCode,
      displayName: item.displayName,
      supportedProtocols: [...item.supportedProtocols],
    });
  }
  return { locations: decoded, refreshedAt };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
