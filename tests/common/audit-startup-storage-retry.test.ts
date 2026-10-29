// SPDX-License-Identifier: MPL-2.0

import { ALARM_REFRESH } from "../../src/core/shared/config";
import { DEFAULT_SECURITY_STATE } from "../../src/core/shared/security";
import { AUTH, NOW, PROFILE, authenticatedState, createHarness, proxySession } from "./helpers";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function connectedHarness() {
  const session = proxySession(
    "restored-session",
    "frankfurt-01",
    new Date(NOW - 540_000).toISOString(),
  );
  const transient = {
    proxySession: session,
    refreshAttempts: 1,
    refreshRetryAt: NOW + 60_000,
    retiredSessions: [{ sessionId: "retired-before-restart", expiresAt: session.expiresAt }],
  };
  const h = createHarness({
    persisted: authenticatedState({ autoConnect: true }),
    security: { ...DEFAULT_SECURITY_STATE, protectionRequested: true },
    transient,
    activeProxy: session,
  });
  return { ...h, session, transient };
}

describe("startup retry after an unavailable transient store", () => {
  it("preserves unknown credentials and resumes the same session after one failed read", async () => {
    const h = connectedHarness();
    const persistedRead = vi.spyOn(h.storage, "readPersisted");
    const transientRead = vi
      .spyOn(h.storage, "readTransient")
      .mockRejectedValueOnce(new Error("storage temporarily unavailable"));
    const clear = vi.spyOn(h.storage, "clearTransient");
    const write = vi.spyOn(h.storage, "writeTransient");
    const accountWrite = vi.spyOn(h.storage, "writePersisted");

    await h.controller.initialize();

    expect(h.controller.getSnapshot()).toMatchObject({
      protected: false,
      trafficBlocked: true,
      error: "storage_unavailable",
    });
    expect(h.storage.persisted.auth).toEqual(AUTH);
    expect(h.storage.transient).toEqual(h.transient);
    expect(clear).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
    expect(accountWrite).not.toHaveBeenCalled();
    expect(h.safety.events).not.toContain("allow");
    expect(h.safety.events).not.toContain("release");

    await h.controller.initialize();

    expect(transientRead).toHaveBeenCalledTimes(2);
    expect(persistedRead).toHaveBeenCalledTimes(1);
    expect(clear).not.toHaveBeenCalled();
    expect(h.storage.transient).toEqual(h.transient);
    expect(await h.controller.getActiveSession()).toEqual(h.session);
    expect(h.controller.getSnapshot()).toMatchObject({
      profile: PROFILE,
      status: "refreshing",
      protected: true,
      trafficBlocked: false,
      error: null,
    });
    expect(h.alarms.session).toEqual(h.session);
    expect(h.alarms.retryAt).toBe(h.transient.refreshRetryAt);
    expect(h.api.proofs).toHaveLength(0);
  });

  it("leaves unknown transient data intact while repeated reads and an alarm remain unavailable", async () => {
    const h = connectedHarness();
    const transientRead = vi
      .spyOn(h.storage, "readTransient")
      .mockRejectedValue(new Error("storage unavailable"));
    const clear = vi.spyOn(h.storage, "clearTransient");
    const write = vi.spyOn(h.storage, "writeTransient");

    await h.controller.initialize();
    await h.controller.handleAlarm(ALARM_REFRESH);

    expect(transientRead).toHaveBeenCalledTimes(2);
    expect(clear).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
    expect(h.storage.transient).toEqual(h.transient);
    expect(h.controller.getSnapshot()).toMatchObject({
      protected: false,
      trafficBlocked: true,
      error: "storage_unavailable",
    });
    expect(h.api.proofs).toHaveLength(0);
    expect(await h.controller.getActiveSession()).toBeNull();
  });

  it("does not turn its temporary guard into a request to reconnect after repeated failures", async () => {
    const h = createHarness({ persisted: authenticatedState() });
    const transientRead = vi
      .spyOn(h.storage, "readTransient")
      .mockRejectedValueOnce(new Error("first temporary failure"))
      .mockRejectedValueOnce(new Error("second temporary failure"));

    await h.controller.initialize();
    expect(h.controller.getSnapshot()).toMatchObject({
      protected: false,
      trafficBlocked: true,
      protectionRequested: false,
    });
    await h.controller.initialize();
    await h.controller.initialize();

    expect(transientRead).toHaveBeenCalledTimes(3);
    expect(h.controller.getSnapshot()).toMatchObject({
      status: "disconnected",
      profile: PROFILE,
      protectionRequested: false,
      protected: false,
      trafficBlocked: false,
    });
    expect(h.api.proofs).toHaveLength(0);
    expect(h.storage.persisted.autoConnect).toBe(false);
  });

  it("does not confirm remote cleanup when unread legacy credentials could not be migrated", async () => {
    const h = connectedHarness();
    vi.spyOn(h.storage, "readTransient").mockRejectedValue(new Error("storage unavailable"));
    await h.controller.initialize();

    expect(await h.controller.logout()).toEqual({ ok: true });

    expect(h.controller.getSnapshot()).toMatchObject({
      status: "logged_out",
      protected: false,
      trafficBlocked: false,
      logoutOutcome: { apiSession: "confirmed", proxySessions: "unconfirmed" },
    });
    expect(h.storage.persisted.auth).toBeNull();
    expect(h.storage.transient.proxySession).toBeNull();
    expect(h.api.revoked).toEqual([]);
    expect(h.securityStorage.state?.proxyCleanupUncertain).toBe(true);
    const restarted = createHarness({
      persisted: h.storage.persisted,
      security: h.securityStorage.state!,
    });
    await restarted.controller.initialize();
    expect(await restarted.controller.logout()).toEqual({ ok: true });
    expect(restarted.controller.getSnapshot().logoutOutcome?.proxySessions).toBe("unconfirmed");
  });

  it.each(["disconnect", "logout"] as const)(
    "keeps an explicit %s dominant when native events and reads arrive during recovery",
    async (action) => {
      const h = connectedHarness();
      const transientRead = vi
        .spyOn(h.storage, "readTransient")
        .mockRejectedValue(new Error("storage unavailable"));
      await h.controller.initialize();
      const writing = deferred();
      const releaseWrite = deferred();
      const events: Promise<unknown>[] = [];
      const clearProxy = h.proxy.clear.bind(h.proxy);
      vi.spyOn(h.proxy, "clear").mockImplementation(async () => {
        await clearProxy();
        events.push(h.controller.handleProxyControlLost("controllable_by_this_extension"));
      });
      const setWebRtc = h.safety.setWebRtc.bind(h.safety);
      vi.spyOn(h.safety, "setWebRtc").mockImplementation(async (enabled) => {
        await setWebRtc(enabled);
        if (!enabled) events.push(h.controller.handlePrivacyChange());
      });
      if (action === "disconnect") {
        const write = h.storage.writePersisted.bind(h.storage);
        vi.spyOn(h.storage, "writePersisted").mockImplementation(async (value) => {
          events.push(h.controller.initialize());
          writing.resolve();
          await releaseWrite.promise;
          await write(value);
        });
      } else {
        const clear = h.storage.clearPersisted.bind(h.storage);
        vi.spyOn(h.storage, "clearPersisted").mockImplementation(async () => {
          events.push(h.controller.initialize());
          writing.resolve();
          await releaseWrite.promise;
          await clear();
        });
      }

      const stopping = h.controller[action]();
      await writing.promise;
      transientRead.mockRestore();
      expect(h.api.proofs).toHaveLength(0);
      releaseWrite.resolve();
      expect(await stopping).toEqual({ ok: true });
      await Promise.all(events);
      await h.controller.initialize();

      expect(h.controller.getSnapshot()).toMatchObject({
        status: action === "disconnect" ? "disconnected" : "logged_out",
        profile: action === "disconnect" ? PROFILE : null,
        protectionRequested: false,
        protected: false,
        trafficBlocked: false,
      });
      expect(h.storage.transient.proxySession).toBeNull();
      expect(h.storage.persisted.auth).toEqual(action === "disconnect" ? AUTH : null);
      expect(await h.controller.getActiveSession()).toBeNull();
      expect(h.api.proofs).toHaveLength(0);
    },
  );
});
