// SPDX-License-Identifier: MPL-2.0

import { extensionApi } from "@platform/bridge";

export interface AccountSessionStorage {
  read(): Promise<unknown>;
  write(value: unknown): Promise<void>;
}

export const ACCOUNT_SESSIONS_KEY = "fuzevpnAccountSessions";

/**
 * The renewable sessions of the accounts signed in from this browser, in the same
 * storage area as the account they belong to. One write replaces the whole record, so
 * new tokens and the removal of their request are stored together.
 */
export class ExtensionAccountSessionStorage implements AccountSessionStorage {
  async read(): Promise<unknown> {
    const stored = await extensionApi.storage.local.get(ACCOUNT_SESSIONS_KEY);
    const sessions: unknown = stored[ACCOUNT_SESSIONS_KEY];
    return sessions;
  }

  async write(value: unknown): Promise<void> {
    await extensionApi.storage.local.set({ [ACCOUNT_SESSIONS_KEY]: value });
  }
}
