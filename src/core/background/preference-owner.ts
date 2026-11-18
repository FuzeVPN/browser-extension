// SPDX-License-Identifier: MPL-2.0

/** What is still to be returned to its defaults for the recorded owner. */
interface PendingReset {
  /** Names the reset of the locations: preferences which carry it were reset already. */
  locations?: string;
  /** The mark of the exclusions which the previous owner left: another content is not theirs. */
  exclusions?: string;
}

interface OwnerRecord {
  owner: string;
  pending?: PendingReset;
}

export interface PreferenceOwnerOptions {
  storage: {
    read(): Promise<unknown>;
    write(record: OwnerRecord): Promise<void>;
  };
  /** A stable digest of the account identifier: the identifier itself is not stored. */
  digest(userId: string): Promise<string>;
  /**
   * Favourite and recent locations, and the automatic choice, back to their defaults,
   * unless the reset which this token names was already done.
   */
  resetLocations(token: string): Promise<void>;
  /**
   * A mark of the saved site exclusions: the same content has the same mark. Rejects
   * while a change of theirs is not settled.
   */
  exclusionsMark(): Promise<string>;
  /**
   * Site exclusions back to none, if their mark is still the given one. Rejects while a
   * change of theirs is not settled: cancelled, it restores what was there before it.
   */
  resetExclusions(mark: string): Promise<void>;
  /** A name for one reset, never given twice. */
  token?: () => string;
  now?: () => number;
}

/** A failed reset is tried again, but not by every publication it causes itself. */
const RETRY_AFTER_MS = 30_000;
const DIGEST = /^[0-9a-f]{64}$/;
const TOKEN = /^[0-9a-f-]{36}$/;

/**
 * Site exclusions, favourite and recent locations stay in the browser profile, so that
 * an account finds them again after it signed out or its session ended. They belong to
 * the account which set them: another account signing in on the same profile starts
 * from the defaults, and inherits neither destinations which bypass the VPN nor the
 * locations which the previous account used.
 *
 * The new owner is recorded before anything is reset, with what remains to be reset.
 * Each step is struck off once done: an interrupted or failed reset is resumed where it
 * stopped, by this worker or the next, and never undoes what the new account has set
 * in the meantime.
 *
 * Neither step relies on a count of changes, which a failed attempt of the reset itself
 * moves like a choice of the new account does. The locations keep the name of the reset
 * which emptied them. The exclusions are reset for as long as they are, once settled,
 * exactly what the previous owner left.
 */
export class PreferenceOwner {
  private settled: string | null = null;
  private running: { userId: string; adoption: Promise<void> } | null = null;
  /** One account's failure does not delay another account's adoption. */
  private retry: { userId: string; at: number } | null = null;
  private readonly now: () => number;
  private readonly token: () => string;

  constructor(private readonly options: PreferenceOwnerOptions) {
    this.now = options.now ?? Date.now;
    this.token = options.token ?? (() => crypto.randomUUID());
  }

  /** Called with the account which is signed in, at each publication of its state. */
  adopt(userId: string): Promise<void> {
    if (this.settled === userId) return Promise.resolve();
    if (this.running?.userId === userId) return this.running.adoption;
    if (this.retry?.userId === userId && this.now() < this.retry.at) return Promise.resolve();
    const previous = this.running?.adoption.catch(() => undefined) ?? Promise.resolve();
    const adoption = previous.then(() => this.run(userId));
    const running = { userId, adoption };
    this.running = running;
    void adoption
      .then(
        () => {
          this.settled = userId;
          if (this.retry?.userId === userId) this.retry = null;
        },
        () => {
          this.retry = { userId, at: this.now() + RETRY_AFTER_MS };
        },
      )
      .finally(() => {
        if (this.running === running) this.running = null;
      });
    return adoption;
  }

  private async run(userId: string): Promise<void> {
    const owner = await this.options.digest(userId);
    let record = readRecord(await this.options.storage.read());
    if (record?.owner !== owner) {
      // Without a recorded owner the preferences were set before owners were recorded,
      // or by this very account: nothing says they are another account's.
      record =
        record === null
          ? { owner }
          : {
              owner,
              // Exclusions which are not settled have no mark yet: nothing is recorded,
              // and the owner changes at a later publication.
              pending: { exclusions: await this.options.exclusionsMark(), locations: this.token() },
            };
      await this.options.storage.write(record);
    }
    if (record.pending?.locations !== undefined) {
      await this.options.resetLocations(record.pending.locations);
      record = withPending(record, { ...record.pending, locations: undefined });
      await this.options.storage.write(record);
    }
    if (record.pending?.exclusions !== undefined) {
      await this.options.resetExclusions(record.pending.exclusions);
      record = withPending(record, { ...record.pending, exclusions: undefined });
      await this.options.storage.write(record);
    }
  }
}

function withPending(record: OwnerRecord, pending: Partial<PendingReset>): OwnerRecord {
  const remaining: PendingReset = {
    ...(pending.locations === undefined ? {} : { locations: pending.locations }),
    ...(pending.exclusions === undefined ? {} : { exclusions: pending.exclusions }),
  };
  return Object.keys(remaining).length > 0
    ? { owner: record.owner, pending: remaining }
    : { owner: record.owner };
}

/**
 * A stored record, or null when none can be read: nothing is then known of an owner.
 * That includes a record whose remaining steps cannot be read, since nothing says any
 * more what they were to reset.
 */
function readRecord(value: unknown): OwnerRecord | null {
  if (typeof value !== "object" || value === null) return null;
  const { owner, pending } = value as { owner?: unknown; pending?: unknown };
  if (typeof owner !== "string" || !DIGEST.test(owner)) return null;
  if (pending === undefined) return { owner };
  if (typeof pending !== "object" || pending === null) return null;
  const { locations, exclusions } = pending as { locations?: unknown; exclusions?: unknown };
  if (locations !== undefined && !(typeof locations === "string" && TOKEN.test(locations)))
    return null;
  if (exclusions !== undefined && !(typeof exclusions === "string" && DIGEST.test(exclusions)))
    return null;
  return withPending({ owner }, { locations, exclusions });
}

/** Hexadecimal SHA-256 of the account identifier, bound to this use. */
export function preferenceOwnerDigest(userId: string): Promise<string> {
  return hexDigest(`fuzevpn-preference-owner:${userId}`);
}

/** Hexadecimal SHA-256 of a preference's content: equal contents have equal marks. */
export function preferenceMark(content: string): Promise<string> {
  return hexDigest(`fuzevpn-preference-mark:${content}`);
}

async function hexDigest(text: string): Promise<string> {
  const bytes = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)),
  );
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
