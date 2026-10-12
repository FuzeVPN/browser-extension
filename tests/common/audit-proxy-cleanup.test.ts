// SPDX-License-Identifier: MPL-2.0

import { ApiError, NetworkError } from "../../src/core/api/client";
import {
  ExtensionProxyCleanupStorage,
  type PendingProxyRevocation,
  type ProxyCleanupStorage,
} from "../../src/core/storage/proxy-cleanup-storage";
import { AUTH, PROFILE, NOW, authenticatedState, createHarness } from "./helpers";

class MemoryCleanup implements ProxyCleanupStorage {
  sessions: PendingProxyRevocation[] = [];
  failWrite = false;
  async read(): Promise<PendingProxyRevocation[]> {
    return structuredClone(this.sessions);
  }
  async write(sessions: PendingProxyRevocation[]): Promise<void> {
    if (this.failWrite) throw new Error("storage_unavailable");
    this.sessions = structuredClone(sessions);
  }
}

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("durable proxy revocation ledger", () => {
  it("retries failed disconnect revocation after worker restart before confirming logout", async () => {
    const cleanupStorage = new MemoryCleanup();
    const first = createHarness({ persisted: authenticatedState(), cleanupStorage });
    await first.controller.initialize();
    await first.controller.connect("frankfurt-01");
    first.api.revokeProxySession = async () => {
      throw new NetworkError("network");
    };
    await first.controller.disconnect();
    await settle();
    expect(cleanupStorage.sessions.map(({ sessionId }) => sessionId)).toEqual(["proxy-session-1"]);
    const restarted = createHarness({
      persisted: first.storage.persisted,
      security: first.securityStorage.state!,
      cleanupStorage,
    });
    await restarted.controller.initialize();
    await restarted.controller.logout();
    expect(restarted.api.revoked).toEqual(["proxy-session-1"]);
    expect(cleanupStorage.sessions).toEqual([]);
    expect(restarted.controller.getSnapshot().logoutOutcome?.proxySessions).toBe("confirmed");
  });

  it("does not confirm a revocation that fails again after restart", async () => {
    const cleanupStorage = new MemoryCleanup();
    cleanupStorage.sessions = [
      {
        userId: PROFILE.userId,
        sessionId: "still-live",
        expiresAt: new Date(NOW + 600_000).toISOString(),
      },
    ];
    const h = createHarness({ persisted: authenticatedState(), cleanupStorage });
    h.api.revokeProxySession = async () => {
      throw new ApiError("server_error", 503);
    };
    await h.controller.initialize();
    await h.controller.logout();
    expect(h.controller.getSnapshot().logoutOutcome?.proxySessions).toBe("unconfirmed");
    expect(cleanupStorage.sessions).toHaveLength(1);
  });

  it("never uses another account token for a retained revocation", async () => {
    const cleanupStorage = new MemoryCleanup();
    cleanupStorage.sessions = [
      {
        userId: "account-a",
        sessionId: "a-session",
        expiresAt: new Date(NOW + 600_000).toISOString(),
      },
    ];
    const h = createHarness({ persisted: authenticatedState(), cleanupStorage });
    await h.controller.initialize();
    await h.controller.logout();
    expect(h.api.revoked).toEqual([]);
    expect(h.controller.getSnapshot().logoutOutcome?.proxySessions).toBe("unconfirmed");
    expect(JSON.stringify(cleanupStorage.sessions)).not.toContain(AUTH.accessToken);
  });

  it("does not reactivate credentials or confirm a pending cleanup after account data was cleared", async () => {
    const cleanupStorage = new MemoryCleanup();
    cleanupStorage.sessions = [
      {
        userId: PROFILE.userId,
        sessionId: "interrupted-logout",
        expiresAt: new Date(NOW + 600_000).toISOString(),
      },
    ];
    const h = createHarness({ cleanupStorage });
    await h.controller.initialize();
    await h.controller.logout();
    expect(await h.controller.getActiveSession()).toBeNull();
    expect(h.controller.getSnapshot().logoutOutcome?.proxySessions).toBe("unconfirmed");
  });

  it("does not count expired records as live sessions", async () => {
    const cleanupStorage = new MemoryCleanup();
    cleanupStorage.sessions = [
      { userId: PROFILE.userId, sessionId: "expired", expiresAt: new Date(NOW - 1).toISOString() },
    ];
    const h = createHarness({ persisted: authenticatedState(), cleanupStorage });
    await h.controller.initialize();
    await h.controller.logout();
    expect(h.api.revoked).toEqual([]);
    expect(h.controller.getSnapshot().logoutOutcome?.proxySessions).toBe("confirmed");
  });

  it("does not authorize credentials whose durable tracking failed", async () => {
    const cleanupStorage = new MemoryCleanup();
    const h = createHarness({ persisted: authenticatedState(), cleanupStorage });
    await h.controller.initialize();
    cleanupStorage.failWrite = true;
    await h.controller.connect("frankfurt-01");
    await settle();
    expect(h.controller.getSnapshot().protected).toBe(false);
    expect(h.controller.getSnapshot().trafficBlocked).toBe(true);
    expect(h.api.revoked).toEqual(["proxy-session-1"]);
  });

  it("does not claim cleanup when its durable record cannot be read", async () => {
    const cleanupStorage = new MemoryCleanup();
    vi.spyOn(cleanupStorage, "read").mockRejectedValue(new Error("storage_unavailable"));
    const h = createHarness({ persisted: authenticatedState(), cleanupStorage });
    await h.controller.initialize();
    await h.controller.logout();
    expect(h.controller.getSnapshot().logoutOutcome?.proxySessions).toBe("unconfirmed");
    expect(await h.controller.getActiveSession()).toBeNull();
  });
});

describe("Chrome cleanup metadata", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("migrates absent metadata and round-trips identifiers without secrets", async () => {
    const data: Record<string, unknown> = {};
    vi.stubGlobal("browser", {
      storage: {
        local: {
          get: async () => structuredClone(data),
          set: async (value: Record<string, unknown>) =>
            Object.assign(data, structuredClone(value)),
        },
      },
    });
    const storage = new ExtensionProxyCleanupStorage();
    expect(await storage.read()).toEqual([]);
    const sessions = [
      {
        userId: PROFILE.userId,
        sessionId: "known",
        expiresAt: new Date(NOW + 600_000).toISOString(),
      },
    ];
    await storage.write(sessions);
    expect(await storage.read()).toEqual(sessions);
    expect(JSON.stringify(data)).not.toMatch(/accessToken|username|password/);
  });
  it("rejects invalid retained state instead of silently forgetting sessions", async () => {
    vi.stubGlobal("browser", {
      storage: {
        local: {
          get: async () => ({ fuzevpnPendingProxyRevocations: { version: 1, sessions: [{}] } }),
        },
      },
    });
    await expect(new ExtensionProxyCleanupStorage().read()).rejects.toThrow(
      "proxy_cleanup_storage_invalid",
    );
  });
});
