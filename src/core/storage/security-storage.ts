// SPDX-License-Identifier: MPL-2.0

import { extensionApi } from "@platform/bridge";
import { DEFAULT_SECURITY_STATE, type SecurityState } from "../shared/security";

export const SECURITY_STORAGE_KEY = "fuzevpnSecurityState";

export interface SecurityStorage {
  read(legacyAutoConnect: boolean, selectedLocationId: string | null): Promise<SecurityState>;
  write(state: SecurityState): Promise<void>;
}

/** Separate from account storage so logout cannot accidentally disarm the traffic guard. */
export class ExtensionSecurityStorage implements SecurityStorage {
  async read(
    legacyAutoConnect: boolean,
    selectedLocationId: string | null,
  ): Promise<SecurityState> {
    const result = await extensionApi.storage.local.get(SECURITY_STORAGE_KEY);
    if (result[SECURITY_STORAGE_KEY] === undefined) {
      const migrated = sanitize({
        ...DEFAULT_SECURITY_STATE,
        protectionRequested: legacyAutoConnect,
        selectedLocationId,
      });
      await this.write(migrated);
      return migrated;
    }
    const existing: unknown = result[SECURITY_STORAGE_KEY];
    if (!isRecord(existing) || typeof existing.protectionRequested !== "boolean") {
      // Unknown intent must not be interpreted as a voluntary disconnect.
      throw new Error("security_storage_failed");
    }
    return sanitize(existing);
  }

  async write(state: SecurityState): Promise<void> {
    const safe = sanitize(state);
    await extensionApi.storage.local.set({ [SECURITY_STORAGE_KEY]: safe });
    const stored = await extensionApi.storage.local.get(SECURITY_STORAGE_KEY);
    const actual: unknown = stored[SECURITY_STORAGE_KEY];
    if (!isRecord(actual) || !Object.entries(safe).every(([key, value]) => actual[key] === value)) {
      throw new Error("security_storage_failed");
    }
  }
}

function sanitize(value: unknown): SecurityState {
  if (!isRecord(value)) return { ...DEFAULT_SECURITY_STATE };
  return {
    killSwitchEnabled: value.killSwitchEnabled !== false,
    webRtcProtectionEnabled: value.webRtcProtectionEnabled !== false,
    protectionRequested: value.protectionRequested === true,
    reconnectAttempts:
      typeof value.reconnectAttempts === "number" &&
      Number.isSafeInteger(value.reconnectAttempts) &&
      value.reconnectAttempts >= 0
        ? value.reconnectAttempts
        : 0,
    nextRetryAt:
      typeof value.nextRetryAt === "number" &&
      Number.isSafeInteger(value.nextRetryAt) &&
      value.nextRetryAt > 0
        ? value.nextRetryAt
        : null,
    retrySuspended: value.retrySuspended === true,
    proxyCreationUncertain: value.proxyCreationUncertain === true,
    proxyCleanupUncertain: value.proxyCleanupUncertain === true,
    retryNotBefore:
      typeof value.retryNotBefore === "number" &&
      Number.isSafeInteger(value.retryNotBefore) &&
      value.retryNotBefore > 0
        ? value.retryNotBefore
        : null,
    selectedLocationId:
      typeof value.selectedLocationId === "string" &&
      value.selectedLocationId.length > 0 &&
      value.selectedLocationId.length <= 256
        ? value.selectedLocationId
        : null,
    capacityBlockedLocationId:
      typeof value.capacityBlockedLocationId === "string" &&
      value.capacityBlockedLocationId.length > 0 &&
      value.capacityBlockedLocationId.length <= 256
        ? value.capacityBlockedLocationId
        : null,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
