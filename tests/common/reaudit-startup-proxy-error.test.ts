// SPDX-License-Identifier: MPL-2.0

import { registerPlatformEvents } from "../../src/platform/firefox/bridge";
import { authenticatedState, createHarness, PROFILE, proxySession } from "./helpers";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function event<T>() {
  let listener: ((details: T) => void) | undefined;
  return {
    addListener: (value: (details: T) => void) => {
      listener = value;
    },
    emit: (details: T) => listener?.(details),
  };
}

function restoringHarness() {
  const session = proxySession("restored-after-background-sleep");
  const h = createHarness({
    persisted: authenticatedState({ autoConnect: true }),
    transient: { proxySession: session, refreshAttempts: 0, retiredSessions: [] },
    activeProxy: session,
  });
  const reading = deferred();
  const releaseRead = deferred();
  const read = h.storage.readPersisted.bind(h.storage);
  vi.spyOn(h.storage, "readPersisted").mockImplementationOnce(async () => {
    reading.resolve();
    await releaseRead.promise;
    return read();
  });
  const onErrorOccurred = event<{ url: string; error: string; proxyInfo: unknown }>();
  const forwarded = vi.fn();
  const handling: Promise<void>[] = [];
  vi.stubGlobal("browser", {
    proxy: { settings: { onChange: event<unknown>() }, onError: event<unknown>() },
    webRequest: { onErrorOccurred },
    permissions: { onRemoved: event<unknown>(), onAdded: event<unknown>() },
    privacy: {
      network: {
        webRTCIPHandlingPolicy: { onChange: event<unknown>() },
        networkPredictionEnabled: { onChange: event<unknown>() },
      },
    },
  });
  registerPlatformEvents({
    proxyChanged: vi.fn(),
    proxyError(message, provenance) {
      forwarded(message, provenance);
      handling.push(h.controller.handleProxyError(message, false, provenance));
    },
    permissionsChanged: vi.fn(),
    diagnosticsConsentAdded: vi.fn(),
    diagnosticsConsentRemoved: vi.fn(),
    privacyChanged: vi.fn(),
  });
  const fail = (
    endpoint = { host: session.host, port: session.port },
    url = "http://destination.example/resource",
  ) => {
    onErrorOccurred.emit({
      url,
      error: "Le certificat n’est pas sûr car il est auto-signé.",
      proxyInfo: { type: "https", ...endpoint },
    });
  };
  return { ...h, session, reading, releaseRead, forwarded, handling, fail };
}

describe("Firefox proxy TLS errors received while restoring a background", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("consumes a certain HTTP proxy TLS error before authorizing stored credentials", async () => {
    const h = restoringHarness();
    const initializing = h.controller.initialize();
    await h.reading.promise;
    const firstSnapshotAfterError = h.snapshots.length;
    h.fail();
    expect(h.forwarded).toHaveBeenCalledExactlyOnceWith("proxy_tls_error", {
      host: h.session.host,
      port: h.session.port,
    });
    const credentialsCurrentWhileRestoring = h.controller.isSessionCurrentForProxyAuth(h.session);
    h.releaseRead.resolve();
    await Promise.all([initializing, ...h.handling]);

    expect(credentialsCurrentWhileRestoring).toBe(false);
    expect(h.safety.events).not.toContain("allow");
    expect(h.snapshots.slice(firstSnapshotAfterError).some((snapshot) => snapshot.protected)).toBe(
      false,
    );
    expect(h.controller.getSnapshot()).toMatchObject({
      protected: false,
      trafficBlocked: true,
      error: "proxy_unavailable",
    });
    expect(await h.controller.getActiveSession()).toBeNull();
    expect(h.controller.isSessionCurrentForProxyAuth(h.session)).toBe(false);
  });

  it.each(["host", "port"] as const)(
    "does not apply an error from a different proxy %s to the restored session",
    async (different) => {
      const h = restoringHarness();
      const initializing = h.controller.initialize();
      await h.reading.promise;
      h.fail({
        host: different === "host" ? "another.proxy.example" : h.session.host,
        port: different === "port" ? h.session.port + 1 : h.session.port,
      });
      const credentialsCurrentWhileRestoring = h.controller.isSessionCurrentForProxyAuth(h.session);
      h.releaseRead.resolve();
      await Promise.all([initializing, ...h.handling]);

      expect(credentialsCurrentWhileRestoring).toBe(true);
      expect(await h.controller.getActiveSession()).toEqual(h.session);
      expect(h.controller.getSnapshot()).toMatchObject({
        status: "connected",
        protected: true,
        error: null,
      });
      expect(h.api.revoked).not.toContain(h.session.id);
    },
  );

  it.each(["before-allow", "before-finalization"] as const)(
    "consumes an error delivered %s without publishing a protected session",
    async (stage) => {
      const h = restoringHarness();
      h.identity.deviceId = "browser-device-1";
      const reachedStage = deferred();
      const releaseStage = deferred();
      if (stage === "before-allow") {
        vi.spyOn(h.alarms, "clearReconnect").mockImplementationOnce(async () => {
          reachedStage.resolve();
          await releaseStage.promise;
        });
      } else {
        vi.spyOn(h.identity, "completeRecovery").mockImplementationOnce(async () => {
          reachedStage.resolve();
          await releaseStage.promise;
        });
      }
      const initializing = h.controller.initialize();
      await h.reading.promise;
      h.releaseRead.resolve();
      await reachedStage.promise;
      const firstSnapshotAfterError = h.snapshots.length;
      const firstSafetyEventAfterError = h.safety.events.length;
      h.fail();
      const credentialsCurrentAfterError = h.controller.isSessionCurrentForProxyAuth(h.session);
      releaseStage.resolve();
      await Promise.all([initializing, ...h.handling]);

      expect(credentialsCurrentAfterError).toBe(false);
      expect(h.safety.events.slice(firstSafetyEventAfterError)).not.toContain("allow");
      expect(
        h.snapshots.slice(firstSnapshotAfterError).some((snapshot) => snapshot.protected),
      ).toBe(false);
      expect(h.controller.getSnapshot()).toMatchObject({
        protected: false,
        trafficBlocked: true,
        error: "proxy_unavailable",
      });
      expect(await h.controller.getActiveSession()).toBeNull();
    },
  );

  it("does not replace a failed ownership check with a TLS diagnosis for an unverified route", async () => {
    const h = restoringHarness();
    const initializing = h.controller.initialize();
    await h.reading.promise;
    h.proxy.level = "controlled_by_other_extensions";
    h.fail();
    h.releaseRead.resolve();
    await Promise.all([initializing, ...h.handling]);

    expect(h.controller.getSnapshot()).toMatchObject({
      protected: false,
      error: "proxy_controlled_by_extension",
    });
    expect(h.safety.events).not.toContain("allow");
    expect(await h.controller.getActiveSession()).toBeNull();
  });

  it.each(["https:", "wss:"])(
    "keeps an ambiguous %s TLS failure outside the proxy attribution path",
    async (scheme) => {
      const h = restoringHarness();
      const initializing = h.controller.initialize();
      await h.reading.promise;
      h.fail(undefined, `${scheme}//destination.example/resource`);
      h.releaseRead.resolve();
      await Promise.all([initializing, ...h.handling]);

      expect(h.forwarded).not.toHaveBeenCalled();
      expect(await h.controller.getActiveSession()).toEqual(h.session);
      expect(h.controller.getSnapshot()).toMatchObject({
        status: "connected",
        protected: true,
        error: null,
      });
    },
  );

  it.each(["disconnect", "logout"] as const)(
    "does not carry a startup error into a successor after an explicit %s",
    async (action) => {
      const h = restoringHarness();
      const initializing = h.controller.initialize();
      await h.reading.promise;
      h.fail();
      const stopping = h.controller[action]();
      h.releaseRead.resolve();
      await Promise.all([initializing, ...h.handling]);
      expect(await stopping).toEqual({ ok: true });
      expect(h.controller.getSnapshot()).toMatchObject({
        status: action === "logout" ? "logged_out" : "disconnected",
        protectionRequested: false,
        protected: false,
        trafficBlocked: false,
        error: null,
      });

      if (action === "logout") {
        h.api.profile = { ...PROFILE, userId: "new-account-after-logout" };
        h.api.auth = { ...h.api.auth, accessToken: "new-account-access-token" };
        expect(await h.controller.login("next@example.com", "synthetic-password")).toEqual({
          ok: true,
        });
      }
      const successor = proxySession(`successor-after-${action}`);
      h.api.sessions = [successor];
      expect(await h.controller.connect("frankfurt-01")).toEqual({ ok: true });
      await Promise.all(h.handling);

      expect(await h.controller.getActiveSession()).toEqual(successor);
      expect(h.controller.getSnapshot()).toMatchObject({
        status: "connected",
        protected: true,
        error: null,
        profile: { userId: action === "logout" ? "new-account-after-logout" : PROFILE.userId },
      });
      expect(h.api.revoked).not.toContain(successor.id);
    },
  );
});
