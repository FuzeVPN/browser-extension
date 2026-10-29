// SPDX-License-Identifier: MPL-2.0

import { AppController } from "../../src/core/background/state-machine";
import { DEFAULT_SECURITY_STATE } from "../../src/core/shared/security";
import { ExtensionProxyCleanupStorage } from "../../src/core/storage/proxy-cleanup-storage";
import {
  ExtensionSecurityStorage,
  SECURITY_STORAGE_KEY,
} from "../../src/core/storage/security-storage";
import { ExtensionSiteExclusionStorage } from "../../src/core/storage/site-exclusion-storage";
import { ExtensionStorageService } from "../../src/core/storage/storage";
import {
  PlatformProxyService as ChromiumProxy,
  proxyConfig as chromiumConfig,
} from "../../src/platform/chromium/proxy-controller";
import {
  PlatformProxyService as FirefoxProxy,
  proxyConfig as firefoxConfig,
} from "../../src/platform/firefox/proxy-controller";
import { authenticatedState, createHarness, NOW, PROFILE, proxySession } from "./helpers";

type Platform = "firefox" | "chromium";
type Refusal = "host" | "private" | "policy" | "extension";

const refusals = [
  { platform: "firefox", refusal: "host", error: "host_permissions_required" },
  { platform: "firefox", refusal: "private", error: "private_browsing_required" },
  { platform: "chromium", refusal: "policy", error: "proxy_controlled_by_policy" },
  { platform: "chromium", refusal: "extension", error: "proxy_controlled_by_extension" },
] as const;

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** Real proxy/storage adapters; only the native browser surface and network guard are fake. */
function fixture(platform: Platform, refusal: Refusal, killSwitchEnabled = true) {
  const h = createHarness();
  const session = proxySession(
    "audit-startup-preserved",
    "frankfurt-01",
    new Date(NOW - 540_000).toISOString(),
  );
  const transient = {
    proxySession: session,
    refreshAttempts: 1,
    refreshRetryAt: NOW + 60_000,
    retiredSessions: [],
  };
  const local: Record<string, unknown> = {
    fuzevpnState: authenticatedState({ autoConnect: true }),
    [SECURITY_STORAGE_KEY]: {
      ...DEFAULT_SECURITY_STATE,
      protectionRequested: true,
      killSwitchEnabled,
    },
  };
  const sessionStore: Record<string, unknown> = { fuzevpnProxySession: structuredClone(transient) };
  const state = { allowed: false, failedRead: "" };
  let value: browser.proxy.ProxyConfig | chrome.proxy.ProxyConfig =
    platform === "firefox" ? firefoxConfig(session) : chromiumConfig(session);
  let owned = true;
  const localGet = vi.fn(async (key: string) => {
    if (state.failedRead === key) throw new Error(`native local read unavailable: ${key}`);
    return structuredClone(local);
  });
  const localSet = vi.fn(async (items: Record<string, unknown>) => {
    Object.assign(local, structuredClone(items));
  });
  const localRemove = vi.fn(async (key: string) => {
    Reflect.deleteProperty(local, key);
  });
  const sessionGet = vi.fn(async (key: string) => {
    if (state.failedRead === key) throw new Error(`native session read unavailable: ${key}`);
    return structuredClone(sessionStore);
  });
  const sessionSet = vi.fn(async (items: Record<string, unknown>) => {
    Object.assign(sessionStore, structuredClone(items));
  });
  const sessionRemove = vi.fn(async (key: string) => {
    Reflect.deleteProperty(sessionStore, key);
  });
  const proxyGet = vi.fn(async () => ({
    value: structuredClone(value),
    levelOfControl:
      !state.allowed && refusal === "policy"
        ? "not_controllable"
        : !state.allowed && refusal === "extension"
          ? "controlled_by_other_extensions"
          : owned
            ? "controlled_by_this_extension"
            : "controllable_by_this_extension",
  }));
  const proxySet = vi.fn(
    async (setting: { value: browser.proxy.ProxyConfig | chrome.proxy.ProxyConfig }) => {
      value = setting.value;
      owned = true;
    },
  );
  const proxyClear = vi.fn(async () => {
    value = platform === "firefox" ? { proxyType: "system" } : { mode: "system" };
    owned = false;
  });
  const native = {
    extension: {
      isAllowedIncognitoAccess: async () =>
        platform !== "firefox" || refusal !== "private" || state.allowed,
    },
    permissions: {
      contains: async () => platform !== "firefox" || refusal !== "host" || state.allowed,
    },
    proxy: { settings: { get: proxyGet, set: proxySet, clear: proxyClear } },
    storage: {
      local: {
        get: localGet,
        set: localSet,
        remove: localRemove,
        setAccessLevel: vi.fn(async () => undefined),
      },
      session: {
        get: sessionGet,
        set: sessionSet,
        remove: sessionRemove,
        setAccessLevel: vi.fn(async () => undefined),
      },
    },
  };
  // The common project resolves storage's bridge to Firefox. Both globals expose
  // the same native storage so direct Chromium adapter coverage is equivalent.
  vi.stubGlobal("browser", native);
  vi.stubGlobal("chrome", native);
  const proxy = platform === "firefox" ? new FirefoxProxy() : new ChromiumProxy();
  const controller = new AppController({
    api: h.api,
    identity: h.identity,
    alarms: h.alarms,
    safety: h.safety,
    storage: new ExtensionStorageService(),
    securityStorage: new ExtensionSecurityStorage(),
    cleanupStorage: new ExtensionProxyCleanupStorage(),
    siteExclusionStorage: new ExtensionSiteExclusionStorage(),
    proxy,
    now: () => NOW,
    onStateChanged: () => undefined,
  });
  return {
    ...h,
    controller,
    proxy,
    state,
    session,
    transient,
    local,
    sessionStore,
    localGet,
    localSet,
    localRemove,
    sessionGet,
    sessionSet,
    sessionRemove,
    proxyGet,
    proxySet,
    proxyClear,
  };
}

function expectPreserved(h: ReturnType<typeof fixture>) {
  expect(h.sessionStore.fuzevpnProxySession).toEqual(h.transient);
  expect(h.sessionRemove).not.toHaveBeenCalled();
  expect(h.proxyClear).not.toHaveBeenCalled();
  expect(h.api.proofs).toHaveLength(0);
  expect(h.api.revoked).toHaveLength(0);
  expect(h.controller.isSessionCurrentForProxyAuth(h.session)).toBe(false);
  expect(h.safety.events).not.toContain("allow");
}

async function expectRepaired(h: ReturnType<typeof fixture>) {
  h.state.allowed = true;
  h.state.failedRead = "";
  await h.controller.initialize();
  expect(await h.controller.getActiveSession()).toEqual(h.session);
  expect(h.controller.isSessionCurrentForProxyAuth(h.session)).toBe(true);
  expect(h.controller.getSnapshot()).toMatchObject({ protected: true, error: null });
  expect(h.alarms.session).toEqual(h.session);
  expect(h.alarms.retryAt).toBe(h.transient.refreshRetryAt);
  expect(h.api.proofs).toHaveLength(0);
  expect(h.api.revoked).toHaveLength(0);
}

describe("CODE02/CODE03: startup failures preserve readable native sessions", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  for (const sample of refusals) {
    it.each([true, false])(
      `${sample.platform}/${sample.refusal}: preserves and repairs with kill switch %s`,
      async (kill) => {
        const h = fixture(sample.platform, sample.refusal, kill);
        await h.controller.initialize();
        expect(h.controller.getSnapshot()).toMatchObject({ protected: false, error: sample.error });
        expect(await h.controller.getActiveSession()).toBeNull();
        expectPreserved(h);
        await expectRepaired(h);
      },
    );

    it(`${sample.platform}/${sample.refusal}: disabling both preferences reports refusal without cleanup`, async () => {
      const h = fixture(sample.platform, sample.refusal);
      await h.controller.initialize();
      expect(await h.controller.updateSecurityPreferences(false, false)).toEqual({
        ok: false,
        commandError: sample.error,
      });
      expect(h.local[SECURITY_STORAGE_KEY]).toMatchObject({
        killSwitchEnabled: false,
        webRtcProtectionEnabled: false,
        protectionRequested: true,
      });
      expectPreserved(h);
      expect(await h.controller.getActiveSession()).toBeNull();
      await expectRepaired(h);
    });
  }

  it.each(["firefox", "chromium"] as const)(
    "%s: alarm clearing failure after guard refusal cannot erase credentials",
    async (platform) => {
      const h = fixture(platform, platform === "firefox" ? "host" : "policy");
      vi.spyOn(h.alarms, "clearAll").mockRejectedValue(new Error("native alarms unavailable"));
      await h.controller.initialize();
      expect(h.controller.getSnapshot().protected).toBe(false);
      expect(await h.controller.getActiveSession()).toBeNull();
      expectPreserved(h);
      vi.mocked(h.alarms.clearAll).mockRestore();
      await expectRepaired(h);
    },
  );

  for (const platform of ["firefox", "chromium"] as const) {
    it(`${platform}: independent guard suspension failure retains credentials until repair`, async () => {
      const h = fixture(platform, platform === "firefox" ? "host" : "policy");
      h.state.allowed = true;
      const suspend = vi
        .spyOn(h.safety, "suspend")
        .mockRejectedValue(new Error("guard suspension unavailable"));
      await h.controller.initialize();
      expect(h.controller.getSnapshot().protected).toBe(false);
      expect(await h.controller.getActiveSession()).toBeNull();
      expectPreserved(h);
      suspend.mockRestore();
      await expectRepaired(h);
    });

    it.each(
      ["fuzevpnPendingProxyRevocations", "fuzevpnSiteExclusions", "fuzevpnProxySession"].flatMap(
        (key) => [true, false].map((allowed) => ({ key, allowed })),
      ),
    )(
      `${platform}: secondary read $key fails closed with control allowed=$allowed and repairs the same session`,
      async ({ key, allowed }) => {
        const h = fixture(platform, platform === "firefox" ? "host" : "policy");
        h.state.allowed = allowed;
        h.state.failedRead = key;
        await h.controller.initialize();
        expect(h.controller.getSnapshot()).toMatchObject({
          protected: false,
          error: allowed ? "storage_unavailable" : "traffic_guard_failed",
        });
        expect(await h.controller.connect("frankfurt-01")).toEqual({
          ok: false,
          commandError: "storage_unavailable",
        });
        expect(await h.controller.getActiveSession()).toBeNull();
        expectPreserved(h);
        await expectRepaired(h);
      },
    );

    it(`${platform}: a new transient read failure during preference repair reports storage failure`, async () => {
      const h = fixture(platform, platform === "firefox" ? "host" : "policy");
      await h.controller.initialize();
      h.sessionGet
        .mockResolvedValueOnce(structuredClone(h.sessionStore))
        .mockRejectedValueOnce(new Error("read failed during preference repair"));
      expect(await h.controller.updateSecurityPreferences(false, false)).toEqual({
        ok: false,
        commandError: "storage_unavailable",
      });
      expectPreserved(h);
      expect(await h.controller.getActiveSession()).toBeNull();
      await expectRepaired(h);
    });

    it.each(["disconnect", "logout"] as const)(
      `${platform}: explicit %s dominates a concurrent startup repair`,
      async (action) => {
        const h = fixture(platform, platform === "firefox" ? "host" : "policy");
        h.state.allowed = true;
        h.state.failedRead = "fuzevpnProxySession";
        await h.controller.initialize();
        const writing = deferred();
        const release = deferred();
        const startupReads: Promise<void>[] = [];
        const repairDuringWrite = async () => {
          h.state.failedRead = "";
          startupReads.push(
            h.controller.initialize(),
            h.controller.handleProxyPermissionsChanged(),
          );
          writing.resolve();
          await release.promise;
        };
        if (action === "disconnect") {
          const write = h.localSet.getMockImplementation()!;
          h.localSet.mockImplementation(async (items) => {
            if ("fuzevpnState" in items) await repairDuringWrite();
            await write(items);
          });
        } else {
          const remove = h.localRemove.getMockImplementation()!;
          h.localRemove.mockImplementation(async (key) => {
            if (key === "fuzevpnState") await repairDuringWrite();
            await remove(key);
          });
        }
        const stopping = h.controller[action]();
        await writing.promise;
        expect(h.api.proofs).toHaveLength(0);
        release.resolve();
        expect(await stopping).toEqual({ ok: true });
        await Promise.all(startupReads);
        await h.controller.initialize();
        expect(h.controller.getSnapshot()).toMatchObject({
          status: action === "logout" ? "logged_out" : "disconnected",
          profile: action === "logout" ? null : PROFILE,
          protected: false,
          protectionRequested: false,
          trafficBlocked: false,
        });
        expect(h.sessionStore.fuzevpnProxySession).toBeUndefined();
        expect(await h.controller.getActiveSession()).toBeNull();
        expect(h.api.proofs).toHaveLength(0);
      },
    );
  }
});
