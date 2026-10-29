// SPDX-License-Identifier: MPL-2.0

import { AppController } from "../../../src/core/background/state-machine";
import { DEFAULT_SECURITY_STATE } from "../../../src/core/shared/security";
import type { AppSnapshot } from "../../../src/core/shared/state";
import { ExtensionStorageService } from "../../../src/core/storage/storage";
import {
  BLOCKING_PROXY_ENDPOINT,
  PlatformProxyService,
  proxyConfig,
} from "../../../src/platform/chromium/proxy-controller";
import { authenticatedState, createHarness, NOW, proxySession } from "./helpers";

/** A guarded restoration: our blocking proxy is effective, the saved proxy is not. */
function fixture(killSwitchEnabled: boolean) {
  const h = createHarness({
    security: { ...DEFAULT_SECURITY_STATE, protectionRequested: true, killSwitchEnabled },
  });
  const session = proxySession(
    "reaudit2-chromium-restore",
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
  // Another owner's setting overrides ours, which becomes effective again on release.
  const state: { level: string; foreign: unknown } = {
    level: "controlled_by_this_extension",
    foreign: null,
  };
  let value: unknown = proxyConfig(BLOCKING_PROXY_ENDPOINT);
  const sessionRemove = vi.fn(async (key: string) => {
    Reflect.deleteProperty(sessionStore, key);
  });
  vi.stubGlobal("chrome", {
    extension: { isAllowedIncognitoAccess: async () => false },
    proxy: {
      settings: {
        get: async () => ({
          value: structuredClone(state.foreign ?? value),
          levelOfControl: state.level,
        }),
        set: async (details: { value: unknown }) => {
          value = structuredClone(details.value);
          if (state.foreign === null) state.level = "controlled_by_this_extension";
        },
        clear: async () => {
          // Clearing our override cannot remove another extension's or policy's setting.
          if (state.level !== "controlled_by_this_extension") return;
          state.level = "controllable_by_this_extension";
          value = { mode: "system" };
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
        setAccessLevel: async () => undefined,
      },
      session: {
        get: async () => structuredClone(sessionStore),
        set: async (items: Record<string, unknown>) => {
          Object.assign(sessionStore, structuredClone(items));
        },
        remove: sessionRemove,
        setAccessLevel: async () => undefined,
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
    transient,
    sessionStore,
    sessionRemove,
  };
}

describe("reaudit 2: Chromium startup restoration losing control at the guarded route test", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  for (const [level, error] of [
    ["controlled_by_other_extensions", "proxy_controlled_by_extension"],
    ["not_controllable", "proxy_controlled_by_policy"],
  ] as const) {
    it.each([true, false])(
      `keeps the stored session when ${level} appears as that test reads the settings, kill switch %s`,
      async (kill) => {
        const h = fixture(kill);
        // The saved proxy's configuration check precedes the early control check.
        let configurationChecked = false;
        const isActiveConfiguration = h.platformProxy.isActiveConfiguration.bind(h.platformProxy);
        vi.spyOn(h.platformProxy, "isActiveConfiguration").mockImplementation(async (session) => {
          const active = await isActiveConfiguration(session);
          configurationChecked = true;
          return active;
        });
        let lost = false;
        const isGuardedConfiguration = h.platformProxy.isGuardedConfiguration.bind(h.platformProxy);
        vi.spyOn(h.platformProxy, "isGuardedConfiguration").mockImplementation(async () => {
          if (configurationChecked && !lost) {
            lost = true;
            h.state.level = level;
            h.state.foreign = { mode: "direct" };
          }
          return isGuardedConfiguration();
        });

        await h.controller.initialize();

        expect(lost).toBe(true);
        expect(h.sessionStore.fuzevpnProxySession).toEqual(h.transient);
        expect(h.sessionRemove).not.toHaveBeenCalled();
        expect(h.controller.getSnapshot()).toMatchObject({ protected: false, error });
        expect(h.snapshots.filter((snapshot) => snapshot.protected)).toEqual([]);
        expect(h.safety.events).not.toContain("allow");

        // Released control restores our guard; its settings event resumes the session.
        h.state.level = "controlled_by_this_extension";
        h.state.foreign = null;
        await h.controller.handleProxyControlLost(await h.platformProxy.getControlLevel());
        expect(h.controller.getSnapshot()).toMatchObject({ protected: true, error: null });
        expect(await h.controller.getActiveSession()).toEqual(h.session);
        expect(h.sessionStore.fuzevpnProxySession).toEqual(h.transient);
        expect(h.alarms.retryAt).toBe(h.transient.refreshRetryAt);
        expect(h.api.proofs).toHaveLength(0);
      },
    );
  }
});
