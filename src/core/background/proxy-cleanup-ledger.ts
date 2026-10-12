// SPDX-License-Identifier: MPL-2.0

import type { ProxySession } from "../api/types";
import type { PendingProxyRevocation, ProxyCleanupStorage } from "../storage/proxy-cleanup-storage";

/** Survives worker/browser shutdown and explicit account logout without retaining secrets. */
export class ProxyCleanupLedger {
  private sessions: PendingProxyRevocation[] = [];
  private initialization: Promise<void> | null = null;
  private mutation: Promise<void> = Promise.resolve();
  private readable = false;

  constructor(
    private readonly storage: ProxyCleanupStorage | undefined,
    private readonly now: () => number,
  ) {}

  initialize(): Promise<void> {
    this.initialization ??= (async () => {
      this.sessions = (await this.storage?.read()) ?? [];
      this.readable = true;
    })().catch((error: unknown) => {
      this.initialization = null;
      throw error;
    });
    return this.initialization;
  }

  forAccount(userId: string): PendingProxyRevocation[] {
    return this.sessions
      .filter((entry) => entry.userId === userId && Date.parse(entry.expiresAt) > this.now())
      .map((entry) => ({ ...entry }));
  }

  hasOutstanding(): boolean {
    return (
      !this.readable || this.sessions.some((entry) => Date.parse(entry.expiresAt) > this.now())
    );
  }

  add(userId: string, session: Pick<ProxySession, "id" | "expiresAt">): Promise<void> {
    return this.update((entries) => {
      if (entries.some((entry) => entry.userId === userId && entry.sessionId === session.id))
        return entries;
      return [...entries, { userId, sessionId: session.id, expiresAt: session.expiresAt }];
    });
  }

  complete(userId: string, sessionId: string): Promise<void> {
    return this.update((entries) =>
      entries.filter((entry) => entry.userId !== userId || entry.sessionId !== sessionId),
    );
  }

  private update(
    transform: (sessions: PendingProxyRevocation[]) => PendingProxyRevocation[],
  ): Promise<void> {
    const result = this.mutation.then(async () => {
      await this.initialize();
      const next = transform(
        this.sessions.filter((entry) => Date.parse(entry.expiresAt) > this.now()),
      );
      if (JSON.stringify(next) === JSON.stringify(this.sessions)) return;
      // Keep the old record if durability cannot be verified; do not claim cleanup success.
      await this.storage?.write(next);
      this.sessions = next;
    });
    this.mutation = result.catch(() => undefined);
    return result;
  }
}
