// SPDX-License-Identifier: MPL-2.0

import { DEFAULT_SECURITY_STATE } from "../../src/core/shared/security";
import {
  ExtensionSecurityStorage,
  SECURITY_STORAGE_KEY,
} from "../../src/core/storage/security-storage";
import { ExtensionStorageService } from "../../src/core/storage/storage";

describe("independent security preferences", () => {
  let local: Record<string, unknown> = {};
  let rejectWrite = false;
  let ignoreWrite = false;

  beforeEach(() => {
    local = {};
    rejectWrite = false;
    ignoreWrite = false;
    vi.stubGlobal("browser", {
      storage: {
        local: {
          get: async (key: string) => ({ [key]: structuredClone(local[key]) }),
          set: async (data: Record<string, unknown>) => {
            if (rejectWrite) throw new Error("storage unavailable");
            if (!ignoreWrite) Object.assign(local, structuredClone(data));
          },
          remove: async (key: string) => {
            Reflect.deleteProperty(local, key);
          },
        },
      },
    });
  });

  afterEach(() => vi.unstubAllGlobals());

  it("enables both preferences by default and migrates existing reconnect intent once", async () => {
    const storage = new ExtensionSecurityStorage();
    await expect(storage.read(true, "paris")).resolves.toEqual({
      ...DEFAULT_SECURITY_STATE,
      protectionRequested: true,
      selectedLocationId: "paris",
    });
    await expect(storage.read(false, "frankfurt")).resolves.toEqual({
      ...DEFAULT_SECURITY_STATE,
      protectionRequested: true,
      selectedLocationId: "paris",
    });
  });

  it("keeps new installations unarmed", async () => {
    await expect(new ExtensionSecurityStorage().read(false, null)).resolves.toEqual(
      DEFAULT_SECURITY_STATE,
    );
  });

  it("keeps explicit preferences and intent when account storage is cleared", async () => {
    const state = {
      ...DEFAULT_SECURITY_STATE,
      killSwitchEnabled: false,
      webRtcProtectionEnabled: false,
      protectionRequested: true,
      reconnectAttempts: 4,
      nextRetryAt: 1_800_000_000_000,
      retryNotBefore: 1_800_000_000_000,
      retrySuspended: true,
      proxyCreationUncertain: true,
      proxyCleanupUncertain: true,
      selectedLocationId: "frankfurt",
      capacityBlockedLocationId: "frankfurt",
    };
    const storage = new ExtensionSecurityStorage();
    await storage.write(state);
    local.fuzevpnState = { auth: { accessToken: "must-not-be-in-security-state" } };
    await new ExtensionStorageService().clearPersisted();
    await expect(storage.read(false, null)).resolves.toEqual(state);
    expect(local.fuzevpnState).toBeUndefined();
    expect(JSON.stringify(local[SECURITY_STORAGE_KEY])).not.toContain("accessToken");
  });

  it("sanitizes preferences and retry metadata without importing account fields", async () => {
    local[SECURITY_STORAGE_KEY] = {
      killSwitchEnabled: "false",
      webRtcProtectionEnabled: null,
      protectionRequested: true,
      reconnectAttempts: -1,
      nextRetryAt: Infinity,
      retryNotBefore: -1,
      retrySuspended: "true",
      proxyCreationUncertain: "true",
      proxyCleanupUncertain: "true",
      selectedLocationId: 42,
      accessToken: "secret",
    };
    await expect(new ExtensionSecurityStorage().read(false, null)).resolves.toEqual({
      ...DEFAULT_SECURITY_STATE,
      protectionRequested: true,
    });
  });

  it.each(["", "x".repeat(257), 42, { id: "full-server" }])(
    "does not restore malformed capacity blocks: %j",
    async (capacityBlockedLocationId) => {
      local[SECURITY_STORAGE_KEY] = { ...DEFAULT_SECURITY_STATE, capacityBlockedLocationId };
      const actual = await new ExtensionSecurityStorage().read(false, null);
      expect(actual.capacityBlockedLocationId).toBeNull();
    },
  );

  it.each([null, [], "corrupt", {}, { protectionRequested: "false" }])(
    "rejects unknown persisted intent instead of disarming protection: %j",
    async (value) => {
      local[SECURITY_STORAGE_KEY] = value;
      await expect(new ExtensionSecurityStorage().read(true, "paris")).rejects.toThrow(
        "security_storage_failed",
      );
    },
  );

  it("does not report a migrated intent until storage confirms it", async () => {
    rejectWrite = true;
    await expect(new ExtensionSecurityStorage().read(true, "paris")).rejects.toThrow(
      "storage unavailable",
    );
  });

  it("rejects an acknowledged write that Firefox does not retain", async () => {
    ignoreWrite = true;
    await expect(new ExtensionSecurityStorage().write(DEFAULT_SECURITY_STATE)).rejects.toThrow(
      "security_storage_failed",
    );
  });

  it("does not mistake a partial write for successful persistence", async () => {
    local[SECURITY_STORAGE_KEY] = { protectionRequested: false };
    ignoreWrite = true;
    await expect(new ExtensionSecurityStorage().write(DEFAULT_SECURITY_STATE)).rejects.toThrow(
      "security_storage_failed",
    );
  });
});
