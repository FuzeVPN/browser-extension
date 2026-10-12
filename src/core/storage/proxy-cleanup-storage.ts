// SPDX-License-Identifier: MPL-2.0

import { extensionApi } from "@platform/bridge";
export interface PendingProxyRevocation {
  userId: string;
  sessionId: string;
  expiresAt: string;
}

export interface ProxyCleanupStorage {
  read(): Promise<PendingProxyRevocation[]>;
  write(sessions: PendingProxyRevocation[]): Promise<void>;
}

const CLEANUP_KEY = "fuzevpnPendingProxyRevocations";

/** Account-bound identifiers only; never stores an API token or proxy credentials. */
export class ExtensionProxyCleanupStorage implements ProxyCleanupStorage {
  async read(): Promise<PendingProxyRevocation[]> {
    const stored = await extensionApi.storage.local.get(CLEANUP_KEY);
    const record: unknown = stored[CLEANUP_KEY];
    if (record === undefined) return [];
    if (!isRecord(record) || record.version !== 1 || !isSessionList(record.sessions))
      throw new Error("proxy_cleanup_storage_invalid");
    return record.sessions.map(({ userId, sessionId, expiresAt }) => ({
      userId,
      sessionId,
      expiresAt,
    }));
  }

  async write(sessions: PendingProxyRevocation[]): Promise<void> {
    if (!isSessionList(sessions)) throw new Error("proxy_cleanup_storage_invalid");
    await extensionApi.storage.local.set({ [CLEANUP_KEY]: { version: 1, sessions } });
    if (JSON.stringify(await this.read()) !== JSON.stringify(sessions))
      throw new Error("proxy_cleanup_storage_unverified");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isSessionList(value: unknown): value is PendingProxyRevocation[] {
  return (
    Array.isArray(value) &&
    value.every(
      (session: unknown) =>
        isRecord(session) &&
        typeof session.userId === "string" &&
        session.userId.length > 0 &&
        typeof session.sessionId === "string" &&
        session.sessionId.length > 0 &&
        typeof session.expiresAt === "string" &&
        Number.isFinite(Date.parse(session.expiresAt)),
    )
  );
}
