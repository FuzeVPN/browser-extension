// SPDX-License-Identifier: MPL-2.0

import { NetworkError } from "../../src/core/api/client";
import { SiteExclusionController } from "../../src/core/background/site-exclusion-controller";
import { ALARM_RECONNECT, ALARM_REFRESH } from "../../src/core/shared/config";
import { DEFAULT_SECURITY_STATE } from "../../src/core/shared/security";
import {
  emptySiteExclusionRecord,
  InvalidSiteExclusionStorageError,
  type SiteExclusionRecord,
} from "../../src/core/storage/site-exclusion-storage";
import {
  AUTH,
  PROFILE,
  FakeProxy,
  FakeSafety,
  authenticatedState,
  createHarness,
  proxySession,
} from "./helpers";

const savedEntry = { domain: "example.com", includeSubdomains: true };
const newEntry = { domain: "example.org", includeSubdomains: false };

function policies() {
  let record = emptySiteExclusionRecord();
  record.saved = { revision: 5, enabled: true, entries: [savedEntry] };
  record.applied = structuredClone(record.saved);
  return {
    read: vi.fn(async () => structuredClone(record)),
    write: vi.fn(async (value: SiteExclusionRecord) => {
      record = structuredClone(value);
    }),
    get record() {
      return structuredClone(record);
    },
  };
}

function cleanup() {
  return { read: vi.fn(async () => []), write: vi.fn(async () => undefined) };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("startup recovery after secondary storage failures", () => {
  it("refuses to edit an exclusion store that was never initialized", async () => {
    const store = policies();
    const controller = new SiteExclusionController(store, new FakeProxy(), new FakeSafety());
    await expect(controller.stage(0, true, [newEntry])).rejects.toThrow(
      "site_exclusion_revision_conflict",
    );
    expect(store.read).not.toHaveBeenCalled();
    expect(store.write).not.toHaveBeenCalled();
    expect(store.record.saved.revision).toBe(5);
  });

  it("retries an exclusion read without rereading or overwriting the loaded account", async () => {
    const store = policies();
    store.read.mockRejectedValueOnce(new Error("unavailable"));
    const h = createHarness({ persisted: authenticatedState(), siteExclusionStorage: store });
    const accountRead = vi.spyOn(h.storage, "readPersisted");
    const securityRead = vi.spyOn(h.securityStorage, "read");
    const accountWrite = vi.spyOn(h.storage, "writePersisted");
    const securityWrite = vi.spyOn(h.securityStorage, "write");
    await h.controller.initialize();
    expect(h.controller.getSnapshot()).toMatchObject({
      protected: false,
      trafficBlocked: true,
      error: "storage_unavailable",
      siteExclusions: { pending: true, error: true },
    });
    expect(accountWrite).not.toHaveBeenCalled();
    expect(securityWrite).not.toHaveBeenCalled();
    expect(h.safety.events).not.toContain("release");

    await h.controller.initialize();
    expect(store.read).toHaveBeenCalledTimes(2);
    expect(accountRead).toHaveBeenCalledTimes(1);
    expect(securityRead).toHaveBeenCalledTimes(1);
    expect(store.write).not.toHaveBeenCalled();
    expect(h.storage.persisted.auth).toEqual(AUTH);
    expect(h.controller.getSnapshot()).toMatchObject({
      profile: PROFILE,
      status: "disconnected",
      trafficBlocked: false,
      siteExclusions: { pending: false, error: false, saved: store.record.saved },
    });
    expect(h.api.proofs).toHaveLength(0);
  });

  it("loads exclusions after cleanup recovery and rejects the stale empty-store revision", async () => {
    const store = policies();
    const ledger = cleanup();
    ledger.read.mockRejectedValueOnce(new Error("unavailable"));
    const h = createHarness({
      persisted: authenticatedState(),
      siteExclusionStorage: store,
      cleanupStorage: ledger,
    });
    await h.controller.initialize();
    expect(store.read).not.toHaveBeenCalled();
    expect(h.controller.getSnapshot().siteExclusions.pending).toBe(true);
    await expect(h.controller.updateSiteExclusions(0, true, [newEntry])).rejects.toThrow(
      "site_exclusion_revision_conflict",
    );
    expect(ledger.read).toHaveBeenCalledTimes(2);
    expect(store.read).toHaveBeenCalledTimes(1);
    expect(store.write).not.toHaveBeenCalled();
    expect(store.record.saved).toEqual({ revision: 5, enabled: true, entries: [savedEntry] });
    await h.controller.updateSiteExclusions(5, true, [newEntry]);
    expect(store.record).toMatchObject({
      pending: false,
      saved: { revision: 6, entries: [newEntry] },
      applied: { revision: 6, entries: [newEntry] },
    });
  });

  it.each(["cleanup", "exclusions"] as const)(
    "refuses account, network and preference commands while %s remains unreadable",
    async (failedStore) => {
      const store = policies();
      const ledger = cleanup();
      const error = new Error("unavailable");
      if (failedStore === "cleanup") ledger.read.mockRejectedValue(error);
      else store.read.mockRejectedValue(error);
      const session = proxySession();
      const h = createHarness({
        persisted: authenticatedState(),
        transient: { proxySession: session, refreshAttempts: 0, retiredSessions: [] },
        activeProxy: session,
        siteExclusionStorage: store,
        cleanupStorage: ledger,
      });
      const persisted = structuredClone(h.storage.persisted);
      const transient = structuredClone(h.storage.transient);
      const accountWrite = vi.spyOn(h.storage, "writePersisted");
      const securityWrite = vi.spyOn(h.securityStorage, "write");
      const login = vi.spyOn(h.api, "login");
      const getProfile = vi.spyOn(h.api, "getProfile");
      const deleteDevice = vi.spyOn(h.api, "deleteDevice");
      const resendVerification = vi.spyOn(h.api, "resendVerification");
      await h.controller.initialize();
      for (const command of [
        () => h.controller.login("other@example.invalid", "synthetic"),
        () => h.controller.connect("frankfurt-01"),
        () => h.controller.changeLocation("frankfurt-02"),
        () => h.controller.selectLocation("frankfurt-02"),
        () => h.controller.updateSecurityPreferences(false, false),
        () => h.controller.retryConnection(),
        () => h.controller.refreshAccount(),
        () => h.controller.refreshLocations(),
        () => h.controller.refreshDevices(),
        () => h.controller.deleteDevice("browser-device-1"),
        () => h.controller.resetDeviceIdentity(),
        () => h.controller.resendVerification(),
      ])
        expect(await command()).toEqual({ ok: false, commandError: "storage_unavailable" });
      await expect(h.controller.updateSiteExclusions(0, true, [newEntry])).rejects.toThrow(
        "storage_unavailable",
      );
      await expect(h.controller.retrySiteExclusions()).rejects.toThrow("storage_unavailable");
      await h.controller.handleAlarm(ALARM_RECONNECT);
      await h.controller.handleAlarm(ALARM_REFRESH);
      await h.controller.handlePrivacyChange();
      await h.controller.handleProxyPermissionsChanged();
      await h.controller.handleProxyControlLost("controlled_by_other_extensions");
      await h.controller.handleProxyError("ERR_PROXY_CERTIFICATE_INVALID", true);
      await h.controller.handleProxyAuthenticationFailure(session);
      expect(h.storage.persisted).toEqual(persisted);
      expect(h.storage.transient).toEqual(transient);
      expect(store.record.saved.revision).toBe(5);
      expect(store.write).not.toHaveBeenCalled();
      expect(accountWrite).not.toHaveBeenCalled();
      expect(securityWrite).not.toHaveBeenCalled();
      expect(login).not.toHaveBeenCalled();
      expect(getProfile).not.toHaveBeenCalled();
      expect(deleteDevice).not.toHaveBeenCalled();
      expect(resendVerification).not.toHaveBeenCalled();
      expect(h.api.proofs).toHaveLength(0);
      expect(await h.controller.getActiveSession()).toBeNull();
      expect(h.controller.getSnapshot()).toMatchObject({
        protected: false,
        trafficBlocked: true,
        error: "storage_unavailable",
      });
      expect(h.safety.events).not.toContain("release");
      expect(h.safety.events).not.toContain("allow");
    },
  );

  it("restores the existing session and renewal after a temporary exclusion failure", async () => {
    const store = policies();
    store.read.mockRejectedValueOnce(new Error("unavailable"));
    const session = proxySession();
    const h = createHarness({
      persisted: authenticatedState(),
      security: { ...DEFAULT_SECURITY_STATE, protectionRequested: true },
      transient: { proxySession: session, refreshAttempts: 0, retiredSessions: [] },
      activeProxy: session,
      siteExclusionStorage: store,
    });
    const schedule = vi.spyOn(h.alarms, "scheduleSession");
    const clearTransient = vi.spyOn(h.storage, "clearTransient");
    await h.controller.initialize();
    expect(clearTransient).not.toHaveBeenCalled();
    expect(schedule).not.toHaveBeenCalled();
    expect(h.storage.transient.proxySession).toEqual(session);
    expect(await h.controller.getActiveSession()).toBeNull();
    await h.controller.initialize();
    expect(schedule).toHaveBeenCalledTimes(1);
    expect(h.alarms.session).toEqual(session);
    expect(await h.controller.getActiveSession()).toEqual(session);
    expect(h.controller.getSnapshot()).toMatchObject({
      profile: PROFILE,
      status: "connected",
      protected: true,
      siteExclusions: { pending: false, error: false, saved: { revision: 5 } },
    });
    expect(h.api.proofs).toHaveLength(0);
  });

  it.each(["existing", "unverified"] as const)(
    "preserves a %s guard when recovering a secondary read failure",
    async (guard) => {
      const store = policies();
      store.read.mockRejectedValueOnce(new Error("unavailable"));
      const h = createHarness({ persisted: authenticatedState(), siteExclusionStorage: store });
      if (guard === "existing")
        h.safety.status = { trafficBlocked: true, filterActive: true, webRtcProtected: true };
      else
        vi.spyOn(h.safety, "inspect").mockResolvedValueOnce({
          trafficBlocked: false,
          filterActive: false,
          webRtcProtected: false,
          blockingScope: "unverified",
        });
      h.api.createError = new NetworkError("network");
      await h.controller.initialize();
      await h.controller.initialize();
      expect(h.controller.getSnapshot()).toMatchObject({
        protectionRequested: true,
        protected: false,
        trafficBlocked: true,
      });
      expect(h.safety.events).not.toContain("release");
    },
  );

  it("keeps an explicit logout after cleanup recovery without restoring a cleared account", async () => {
    const ledger = cleanup();
    ledger.read.mockRejectedValue(new Error("unavailable"));
    const h = createHarness({ persisted: authenticatedState(), cleanupStorage: ledger });
    const accountRead = vi.spyOn(h.storage, "readPersisted");
    await h.controller.initialize();
    await h.controller.logout();
    expect(h.storage.persisted.auth).toBeNull();
    ledger.read.mockResolvedValue([]);
    await h.controller.initialize();
    expect(accountRead).toHaveBeenCalledTimes(1);
    expect(h.controller.getSnapshot()).toMatchObject({
      status: "logged_out",
      profile: null,
      protected: false,
      protectionRequested: false,
      trafficBlocked: false,
    });
    expect(h.api.proofs).toHaveLength(0);
  });

  it("keeps an explicit disconnect after cleanup recovery despite the earlier guard", async () => {
    const ledger = cleanup();
    ledger.read.mockRejectedValue(new Error("unavailable"));
    const h = createHarness({ persisted: authenticatedState(), cleanupStorage: ledger });
    h.safety.status = { trafficBlocked: true, filterActive: true, webRtcProtected: true };
    await h.controller.initialize();
    expect(await h.controller.disconnect()).toEqual({ ok: true });
    ledger.read.mockResolvedValue([]);
    await h.controller.initialize();
    expect(h.controller.getSnapshot()).toMatchObject({
      status: "disconnected",
      profile: PROFILE,
      protectionRequested: false,
      trafficBlocked: false,
    });
    expect(h.api.proofs).toHaveLength(0);
  });

  it.each(["disconnect", "logout"] as const)(
    "does not let native events or popup reads supersede %s while repairing startup exclusions",
    async (action) => {
      const store = policies();
      store.read.mockRejectedValue(new InvalidSiteExclusionStorageError());
      const recovered = emptySiteExclusionRecord();
      recovered.saved.revision = recovered.applied.revision = 6;
      recovered.recoveryNotice = "preferences_reset";
      const recoverForDisconnect = vi.fn(async () => {
        await store.write(recovered);
        store.read.mockResolvedValue(recovered);
        return structuredClone(recovered);
      });
      const h = createHarness({
        persisted: authenticatedState(),
        siteExclusionStorage: { ...store, recoverForDisconnect },
        security: { ...DEFAULT_SECURITY_STATE, protectionRequested: true },
      });
      await h.controller.initialize();
      expect(h.controller.getSnapshot().siteExclusions.error).toBe(true);
      const events: Promise<unknown>[] = [];
      const clearProxy = h.proxy.clear.bind(h.proxy);
      vi.spyOn(h.proxy, "clear").mockImplementation(async () => {
        await clearProxy();
        // Firefox dispatches change listeners without awaiting their promises.
        events.push(h.controller.handleProxyControlLost("controllable_by_this_extension"));
      });
      const setWebRtc = h.safety.setWebRtc.bind(h.safety);
      vi.spyOn(h.safety, "setWebRtc").mockImplementation(async (enabled) => {
        await setWebRtc(enabled);
        events.push(h.controller.handlePrivacyChange());
      });
      const writing = deferred();
      const releaseWrite = deferred();
      if (action === "disconnect") {
        const write = h.storage.writePersisted.bind(h.storage);
        vi.spyOn(h.storage, "writePersisted").mockImplementation(async (state) => {
          events.push(h.controller.initialize());
          writing.resolve();
          await releaseWrite.promise;
          await write(state);
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
      expect(recoverForDisconnect).toHaveBeenCalledTimes(1);
      expect(h.api.proofs).toHaveLength(0);
      releaseWrite.resolve();
      expect(await stopping).toEqual({ ok: true });
      await Promise.all(events);
      expect(h.controller.getSnapshot()).toMatchObject({
        status: action === "disconnect" ? "disconnected" : "logged_out",
        profile: action === "disconnect" ? PROFILE : null,
        protectionRequested: false,
        trafficBlocked: false,
        siteExclusions: {
          pending: false,
          error: false,
          recoveryNotice: "preferences_reset",
        },
      });
      if (action === "logout")
        expect(h.controller.getSnapshot().logoutOutcome).toEqual({
          apiSession: "confirmed",
          proxySessions: "confirmed",
        });
      expect(h.api.proofs).toHaveLength(0);
    },
  );

  it("preserves an unconfirmed logout outcome after secondary recovery and clears it for a new login", async () => {
    const ledger = cleanup();
    ledger.read.mockRejectedValue(new Error("unavailable"));
    const h = createHarness({ persisted: authenticatedState(), cleanupStorage: ledger });
    vi.spyOn(h.api, "logout").mockRejectedValue(new NetworkError("network"));
    await h.controller.logout();
    const outcome = { apiSession: "unconfirmed", proxySessions: "unconfirmed" };
    expect(h.controller.getSnapshot().logoutOutcome).toEqual(outcome);
    ledger.read.mockResolvedValue([]);
    await h.controller.initialize();
    expect(h.controller.getSnapshot()).toMatchObject({ profile: null, logoutOutcome: outcome });
    expect(await h.controller.login("fixture@example.invalid", "synthetic")).toEqual({
      ok: true,
    });
    expect(h.controller.getSnapshot()).toMatchObject({ profile: PROFILE, logoutOutcome: null });
  });
});
