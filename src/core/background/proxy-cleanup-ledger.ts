// SPDX-License-Identifier: MPL-2.0

import type { ProxySession } from "../api/types";
import type { PendingProxyRevocation, ProxyCleanupStorage } from "../storage/proxy-cleanup-storage";

/** Survives worker/browser shutdown and explicit account logout without retaining secrets. */
export class ProxyCleanupLedger {
  private sessions: PendingProxyRevocation[] = [];
  private initialization: Promise<void> | null = null;
  private mutation: Promise<void> = Promise.resolve();
  private readable = false;
  private clockAnchor: { wall: number; elapsed: number } | null = null;

  constructor(
    private readonly storage: ProxyCleanupStorage | undefined,
    private readonly now: () => number,
    private readonly elapsed: () => number = () => performance.now(),
  ) {}

  initialize(): Promise<void> {
    this.clockAnchor ??= { wall: this.now(), elapsed: this.elapsed() };
    this.initialization ??= (async () => {
      this.sessions = (await this.storage?.read()) ?? [];
      this.readable = true;
    })().catch((error: unknown) => {
      this.initialization = null;
      throw error;
    });
    return this.initialization;
  }

  // Reads use the same proof as removal: a record whose expiry is not proven is
  // revoked and reported as outstanding, never confirmed by a wall clock alone.
  forAccount(userId: string): PendingProxyRevocation[] {
    const provenExpiry = this.provenExpiry();
    return this.sessions
      .filter((entry) => entry.userId === userId && Date.parse(entry.expiresAt) > provenExpiry)
      .map((entry) => ({ ...entry }));
  }

  hasOutstanding(): boolean {
    const provenExpiry = this.provenExpiry();
    return (
      !this.readable || this.sessions.some((entry) => Date.parse(entry.expiresAt) > provenExpiry)
    );
  }

  add(userId: string, session: Pick<ProxySession, "id" | "expiresAt">): Promise<void> {
    const { id, expiresAt } = session;
    const expiry = Date.parse(expiresAt);
    return this.update((entries) => {
      if (entries.some((entry) => entry.userId === userId && entry.sessionId === id))
        // Recovered metadata may extend a known session. Never discard that later
        // deadline or shorten one already retained for the same account and ID.
        return entries.map((entry) =>
          entry.userId === userId && entry.sessionId === id && expiry > Date.parse(entry.expiresAt)
            ? { ...entry, expiresAt }
            : entry,
        );
      return [...entries, { userId, sessionId: id, expiresAt }];
    });
  }

  complete(userId: string, sessionId: string, expiredBy?: number): Promise<boolean> {
    let completed = true;
    return this.update((entries, provenExpiry) =>
      entries.filter((entry) => {
        if (entry.userId !== userId || entry.sessionId !== sessionId) return true;
        // An expiry-only cleanup cannot remove metadata extended while it waited
        // in the queue, nor trust a wall clock that ran ahead of elapsed time.
        // A confirmed server revocation has no expiry restriction.
        if (
          expiredBy !== undefined &&
          !(Date.parse(entry.expiresAt) <= Math.min(expiredBy, provenExpiry))
        ) {
          completed = false;
          return true;
        }
        return false;
      }),
    ).then(() => completed);
  }

  /**
   * A wall clock ahead of time elapsed since the first read proves no expiry, of a
   * record or of an ID which has none.
   * Elapsed time may pause while the device sleeps. An expired record then waits for its DELETE
   * or a later worker, which is conservative; a jump before the first read stays undetectable.
   */
  provenExpiry(): number {
    const now = this.now();
    if (!this.clockAnchor) return now;
    return Math.min(now, this.clockAnchor.wall + this.elapsed() - this.clockAnchor.elapsed);
  }

  private update(
    transform: (
      sessions: PendingProxyRevocation[],
      provenExpiry: number,
    ) => PendingProxyRevocation[],
  ): Promise<void> {
    const result = this.mutation.then(async () => {
      await this.initialize();
      const provenExpiry = this.provenExpiry();
      const outstanding = this.sessions.filter(
        (entry) => Date.parse(entry.expiresAt) > provenExpiry,
      );
      const next = transform(outstanding, provenExpiry);
      if (JSON.stringify(next) === JSON.stringify(this.sessions)) return;
      try {
        await this.storage?.write(next);
      } catch (error) {
        // Keep the old record if durability cannot be verified; do not claim cleanup success.
        // A write which only purges expired records changes no outstanding one: a later
        // update retries it, and its failure must not fail an unrelated add or completion.
        if (JSON.stringify(next) !== JSON.stringify(outstanding)) throw error;
        return;
      }
      this.sessions = next;
    });
    this.mutation = result.catch(() => undefined);
    return result;
  }
}
