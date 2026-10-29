// SPDX-License-Identifier: MPL-2.0

import { AppController } from "../../../src/core/background/state-machine";
import { DEFAULT_SECURITY_STATE } from "../../../src/core/shared/security";
import type { AppSnapshot } from "../../../src/core/shared/state";
import { ExtensionStorageService } from "../../../src/core/storage/storage";
import {
  BLOCKING_PROXY_ENDPOINT,
  PlatformProxyService,
  proxyConfig,
} from "../../../src/platform/firefox/proxy-controller";
import { authenticatedState, createHarness, NOW, proxySession } from "../../common/helpers";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** A guarded fixture starts from the blocking proxy, which restoration replaces. */
function fixture(killSwitchEnabled = true, guarded = false) {
  const h = createHarness({
    security: { ...DEFAULT_SECURITY_STATE, protectionRequested: true, killSwitchEnabled },
  });
  const session = proxySession(
    "ultra-firefox-restore",
    "frankfurt-01",
    new Date(NOW - 540_000).toISOString(),
  );
  const transient = {
    proxySession: session,
    refreshAttempts: 2,
    refreshRetryAt: NOW + 45_000,
    retiredSessions: [],
  };
  const local: Record<string, unknown> = {
    fuzevpnState: authenticatedState({ autoConnect: true }),
  };
  const sessionStore: Record<string, unknown> = { fuzevpnProxySession: structuredClone(transient) };
  const state = { level: "controlled_by_this_extension", hostAllowed: true };
  let value: unknown = proxyConfig(guarded ? BLOCKING_PROXY_ENDPOINT : session);
  const hooks: { afterSet?: () => void } = {};
  const sessionRemove = vi.fn(async (key: string) => {
    Reflect.deleteProperty(sessionStore, key);
  });
  vi.stubGlobal("browser", {
    extension: { isAllowedIncognitoAccess: async () => true },
    permissions: { contains: async () => state.hostAllowed },
    proxy: {
      settings: {
        get: async () => ({ value: structuredClone(value), levelOfControl: state.level }),
        set: async (details: { value: unknown }) => {
          value = structuredClone(details.value);
          state.level = "controlled_by_this_extension";
          hooks.afterSet?.();
        },
        clear: async () => {
          // Clearing our override cannot remove another extension's or policy's setting.
          if (state.level !== "controlled_by_this_extension") return;
          state.level = "controllable_by_this_extension";
          value = { proxyType: "system" };
        },
      },
    },
    storage: {
      local: {
        get: async () => structuredClone(local),
        set: async (items: Record<string, unknown>) => {
          Object.assign(local, structuredClone(items));
        },
        remove: async (key: string) => {
          Reflect.deleteProperty(local, key);
        },
      },
      session: {
        get: async () => structuredClone(sessionStore),
        set: async (items: Record<string, unknown>) => {
          Object.assign(sessionStore, structuredClone(items));
        },
        remove: sessionRemove,
      },
    },
  });
  const snapshots: AppSnapshot[] = [];
  const platformProxy = new PlatformProxyService();
  const controller = new AppController({
    api: h.api,
    storage: new ExtensionStorageService(),
    identity: h.identity,
    proxy: platformProxy,
    alarms: h.alarms,
    safety: h.safety,
    securityStorage: h.securityStorage,
    now: () => NOW,
    onStateChanged: (snapshot) => snapshots.push(snapshot),
  });
  return {
    ...h,
    controller,
    platformProxy,
    snapshots,
    session,
    state,
    hooks,
    transient,
    sessionStore,
    sessionRemove,
  };
}

type Fixture = ReturnType<typeof fixture>;

/** Holds the restoration's final identity read, which follows the traffic allowance. */
function holdFinalIdentityRead(h: Fixture) {
  const reached = deferred();
  const release = deferred();
  let held = false;
  const getDeviceId = h.identity.getDeviceId.bind(h.identity);
  vi.spyOn(h.identity, "getDeviceId").mockImplementation(async (userId) => {
    if (!held && h.safety.events.includes("allow")) {
      held = true;
      reached.resolve();
      await release.promise;
    }
    return getDeviceId(userId);
  });
  return { reached: reached.promise, release: release.resolve };
}

describe("reaudit ultra: Firefox startup restoration with the native adapters", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  for (const level of ["controlled_by_other_extensions", "not_controllable"] as const) {
    // Recovery is read before the restored configuration check; scheduling follows it.
    for (const boundary of ["getRecovery", "scheduleSession"] as const) {
      it.each([true, false])(
        `keeps the stored session when ${level} appears at ${boundary}, kill switch %s`,
        async (kill) => {
          const h = fixture(kill);
          if (boundary === "getRecovery") {
            const getRecovery = h.identity.getRecovery.bind(h.identity);
            vi.spyOn(h.identity, "getRecovery").mockImplementationOnce(async (userId) => {
              const recovery = await getRecovery(userId);
              h.state.level = level;
              return recovery;
            });
          } else {
            const schedule = h.alarms.scheduleSession.bind(h.alarms);
            vi.spyOn(h.alarms, "scheduleSession").mockImplementationOnce(async (...args) => {
              await schedule(...args);
              h.state.level = level;
            });
          }

          await h.controller.initialize();

          expect(h.sessionStore.fuzevpnProxySession).toEqual(h.transient);
          expect(h.sessionRemove).not.toHaveBeenCalled();
          expect(h.controller.getSnapshot().protected).toBe(false);
          expect(h.safety.events).not.toContain("allow");

          h.state.level = "controlled_by_this_extension";
          await h.controller.initialize();
          expect(h.controller.getSnapshot().protected).toBe(true);
          expect(await h.controller.getActiveSession()).toEqual(h.session);
          expect(h.alarms.retryAt).toBe(h.transient.refreshRetryAt);
        },
      );
    }

    // The next checks there only see an inactive configuration, or a rejected write.
    for (const boundary of ["traffic allowance", "proxy write"] as const) {
      it.each([true, false])(
        `keeps the stored session when ${level} unconfigures it at the ${boundary}, kill switch %s`,
        async (kill) => {
          const h = fixture(kill, boundary === "proxy write");
          if (boundary === "proxy write") {
            h.hooks.afterSet = () => {
              h.hooks.afterSet = undefined;
              h.state.level = level;
            };
          } else {
            const allow = h.safety.allow.bind(h.safety);
            vi.spyOn(h.safety, "allow").mockImplementationOnce(async () => {
              await allow();
              h.state.level = level;
            });
          }

          await h.controller.initialize();

          expect(h.sessionStore.fuzevpnProxySession).toEqual(h.transient);
          expect(h.sessionRemove).not.toHaveBeenCalled();
          expect(h.controller.getSnapshot()).toMatchObject({
            protected: false,
            error:
              level === "not_controllable"
                ? "proxy_controlled_by_policy"
                : "proxy_controlled_by_extension",
          });
          expect(h.snapshots.filter((snapshot) => snapshot.protected)).toEqual([]);

          h.state.level = "controlled_by_this_extension";
          await h.controller.initialize();
          expect(h.controller.getSnapshot().protected).toBe(true);
          expect(await h.controller.getActiveSession()).toEqual(h.session);
          expect(h.alarms.retryAt).toBe(h.transient.refreshRetryAt);
        },
      );
    }

    it.each([true, false])(
      `never authorizes a stored endpoint that failed TLS once ${level} appearing at getRecovery is repaired, kill switch %s`,
      async (kill) => {
        const h = fixture(kill);
        const getRecovery = h.identity.getRecovery.bind(h.identity);
        vi.spyOn(h.identity, "getRecovery").mockImplementationOnce(async (userId) => {
          const recovery = await getRecovery(userId);
          h.state.level = level;
          return recovery;
        });
        const initializing = h.controller.initialize();
        // Delivered during startup, for the stored endpoint its traffic used.
        const refusing = h.controller.handleProxyError("proxy_tls_error", false, {
          host: h.session.host,
          port: h.session.port,
        });
        await initializing;
        await refusing;

        expect(h.sessionStore.fuzevpnProxySession).toEqual(h.transient);
        expect(h.sessionRemove).not.toHaveBeenCalled();
        expect(h.controller.getSnapshot().protected).toBe(false);

        // The startup that repairs control consumes the endpoint's failure.
        h.state.level = "controlled_by_this_extension";
        await h.controller.initialize();
        expect(h.snapshots.filter((snapshot) => snapshot.protected)).toEqual([]);
        expect(h.safety.events).not.toContain("allow");
        expect(await h.controller.getActiveSession()).toBeNull();
        expect(h.sessionStore.fuzevpnProxySession).toBeUndefined();
      },
    );
  }

  it.each([true, false])(
    "keeps the stored session when control is lost at the final identity read and reported afterwards, kill switch %s",
    async (kill) => {
      const h = fixture(kill);
      const hold = holdFinalIdentityRead(h);
      const initializing = h.controller.initialize();
      await hold.reached;
      const beforeLoss = h.snapshots.length;
      h.state.level = "controlled_by_other_extensions";
      hold.release();
      // proxy.settings.onChange reaches the controller only after reading the level.
      await initializing;
      await h.controller.handleProxyControlLost(await h.platformProxy.getControlLevel());

      expect(h.snapshots.slice(beforeLoss).filter((snapshot) => snapshot.protected)).toEqual([]);
      expect(h.sessionStore.fuzevpnProxySession).toEqual(h.transient);
      expect(h.sessionRemove).not.toHaveBeenCalled();
      expect(h.controller.getSnapshot().error).toBe("proxy_controlled_by_extension");

      h.state.level = "controlled_by_this_extension";
      await h.controller.handleProxyControlLost(await h.platformProxy.getControlLevel());
      expect(h.controller.getSnapshot().protected).toBe(true);
      expect(await h.controller.getActiveSession()).toEqual(h.session);
    },
  );

  it("keeps the stored session and never publishes protection after host revocation at the final identity read", async () => {
    const h = fixture();
    const hold = holdFinalIdentityRead(h);
    const initializing = h.controller.initialize();
    await hold.reached;
    const beforeLoss = h.snapshots.length;
    h.state.hostAllowed = false;
    const event = h.controller.handleProxyPermissionsChanged();
    hold.release();
    await initializing;
    await event;

    expect(h.snapshots.slice(beforeLoss).filter((snapshot) => snapshot.protected)).toEqual([]);
    expect(h.sessionStore.fuzevpnProxySession).toEqual(h.transient);
    expect(h.sessionRemove).not.toHaveBeenCalled();
    expect(h.controller.getSnapshot().error).toBe("host_permissions_required");

    h.state.hostAllowed = true;
    await h.controller.handleProxyPermissionsChanged();
    expect(h.controller.getSnapshot().protected).toBe(true);
    expect(await h.controller.getActiveSession()).toEqual(h.session);
  });
});
