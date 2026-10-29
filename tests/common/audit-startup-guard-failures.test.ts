// SPDX-License-Identifier: MPL-2.0

import { ProxyControlError } from "../../src/core/background/proxy-controller";
import { DEFAULT_SECURITY_STATE } from "../../src/core/shared/security";
import type { PendingProxyRevocation } from "../../src/core/storage/proxy-cleanup-storage";
import { authenticatedState, createHarness, NOW, proxySession } from "./helpers";

function restoringHarness() {
  const session = proxySession(
    "stored-before-permission-loss",
    "frankfurt-01",
    new Date(NOW - 540_000).toISOString(),
  );
  const transient = {
    proxySession: session,
    refreshAttempts: 1,
    refreshRetryAt: NOW + 60_000,
    retiredSessions: [
      { sessionId: "retired-before-permission-loss", expiresAt: session.expiresAt },
    ],
  };
  let ledger: PendingProxyRevocation[] = [];
  const h = createHarness({
    persisted: authenticatedState({ autoConnect: true }),
    security: { ...DEFAULT_SECURITY_STATE, protectionRequested: true },
    transient,
    activeProxy: session,
    cleanupStorage: {
      async read() {
        return structuredClone(ledger);
      },
      async write(entries) {
        ledger = structuredClone(entries);
      },
    },
  });
  return { ...h, session, transient, ledger: () => ledger };
}

describe("readable startup stores when the network guard is unavailable", () => {
  afterEach(() => vi.restoreAllMocks());

  it.each([
    ["private_browsing_required", "private_browsing_required"],
    ["host_permissions_required", "host_permissions_required"],
    ["controlled_by_other_extensions", "proxy_controlled_by_extension"],
    ["configuration_rejected", "proxy_unavailable"],
  ] as const)(
    "retains stored sessions and reports %s instead of storage failure",
    async (level, code) => {
      const h = restoringHarness();
      const read = vi.spyOn(h.storage, "readTransient");
      const denied = vi
        .spyOn(h.proxy, "assertControllable")
        .mockRejectedValue(new ProxyControlError(level));
      await h.controller.initialize();
      expect(read).toHaveBeenCalledOnce();
      expect(h.storage.transient).toEqual(h.transient);
      expect(
        h
          .ledger()
          .map((entry) => entry.sessionId)
          .sort(),
      ).toEqual(["retired-before-permission-loss", "stored-before-permission-loss"]);
      expect(h.controller.getSnapshot()).toMatchObject({ protected: false, error: code });
      expect(await h.controller.getActiveSession()).toBeNull();
      expect(await h.controller.connect("frankfurt-01")).toEqual({ ok: false, commandError: code });
      expect(await h.controller.refreshAccount()).toEqual({ ok: true });
      expect(h.controller.getSnapshot().error).toBe(code);
      expect(h.storage.transient).toEqual(h.transient);
      expect(h.api.proofs).toHaveLength(0);
      expect(h.safety.events).not.toContain("allow");
      expect(h.safety.events).not.toContain("release");
      expect(h.proxy.clearCalls).toBe(0);
      expect(h.alarms.session).toBeNull();
      expect(h.alarms.reconnectAt).toBeNull();

      denied.mockRestore();
      await h.controller.initialize();
      expect(await h.controller.getActiveSession()).toEqual(h.session);
      expect(h.controller.getSnapshot()).toMatchObject({ protected: true, error: null });
      expect(h.alarms.retryAt).toBe(h.transient.refreshRetryAt);
      expect(h.api.proofs).toHaveLength(0);
    },
  );

  it("keeps an actual unread transient store unknown even when permissions are also denied", async () => {
    const h = restoringHarness();
    vi.spyOn(h.proxy, "assertControllable").mockRejectedValue(
      new ProxyControlError("private_browsing_required"),
    );
    const read = vi
      .spyOn(h.storage, "readTransient")
      .mockRejectedValue(new Error("storage unavailable"));
    await h.controller.initialize();
    expect(read).toHaveBeenCalledOnce();
    expect(await h.controller.connect("frankfurt-01")).toEqual({
      ok: false,
      commandError: "storage_unavailable",
    });
    expect(h.storage.transient).toEqual(h.transient);
    expect(h.ledger()).toEqual([]);
    expect(h.api.proofs).toHaveLength(0);
    expect(h.proxy.clearCalls).toBe(0);
    expect(h.safety.events).not.toContain("allow");
  });

  it("disables proxy credentials before waiting for the independent local session read", async () => {
    const h = restoringHarness();
    vi.spyOn(h.proxy, "assertControllable").mockRejectedValue(
      new ProxyControlError("private_browsing_required"),
    );
    let finishRead!: (value: typeof h.transient) => void;
    const waiting = new Promise<typeof h.transient>((resolve) => {
      finishRead = resolve;
    });
    const read = vi.spyOn(h.storage, "readTransient").mockReturnValueOnce(waiting);
    const initializing = h.controller.initialize();
    await vi.waitFor(() => expect(read).toHaveBeenCalledOnce());
    expect(await h.controller.getActiveSession()).toBeNull();
    expect(h.controller.isSessionCurrentForProxyAuth(h.session)).toBe(false);
    finishRead(h.transient);
    await initializing;
    expect(h.api.proofs).toHaveLength(0);
  });

  it("does not reuse a successful store-read flag when a later guard-repair read fails", async () => {
    const h = restoringHarness();
    const denied = vi
      .spyOn(h.proxy, "assertControllable")
      .mockRejectedValue(new ProxyControlError("private_browsing_required"));
    await h.controller.initialize();
    expect(h.controller.getSnapshot().error).toBe("private_browsing_required");
    const read = vi
      .spyOn(h.storage, "readTransient")
      .mockRejectedValueOnce(new Error("storage unavailable during guard repair"));
    const clear = vi.spyOn(h.storage, "clearTransient");

    await h.controller.initialize();

    expect(read).toHaveBeenCalledOnce();
    expect(clear).not.toHaveBeenCalled();
    expect(h.storage.transient).toEqual(h.transient);
    expect(await h.controller.getActiveSession()).toBeNull();
    denied.mockRestore();
    await h.controller.initialize();
    expect(await h.controller.getActiveSession()).toEqual(h.session);
    expect(h.controller.getSnapshot()).toMatchObject({ protected: true, error: null });
    expect(h.api.proofs).toHaveLength(0);
  });

  it.each(["disconnect", "logout"] as const)(
    "does not restore a saved session after an explicit %s during guard recovery",
    async (action) => {
      const h = restoringHarness();
      const denied = vi
        .spyOn(h.proxy, "assertControllable")
        .mockRejectedValue(new ProxyControlError("host_permissions_required"));
      await h.controller.initialize();
      expect(await h.controller[action]()).toEqual({ ok: true });
      denied.mockRestore();
      await h.controller.initialize();
      expect(h.controller.getSnapshot()).toMatchObject({
        status: action === "logout" ? "logged_out" : "disconnected",
        protected: false,
        protectionRequested: false,
        trafficBlocked: false,
      });
      expect(h.storage.transient.proxySession).toBeNull();
      expect(h.api.proofs).toHaveLength(0);
    },
  );
});
