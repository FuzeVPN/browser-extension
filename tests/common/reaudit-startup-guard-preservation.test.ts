// SPDX-License-Identifier: MPL-2.0

import { AppController } from "../../src/core/background/state-machine";
import { DEFAULT_SECURITY_STATE } from "../../src/core/shared/security";
import { ExtensionStorageService } from "../../src/core/storage/storage";
import { registerPlatformEvents } from "../../src/platform/firefox/bridge";
import {
  PlatformProxyService,
  proxyConfig,
  type ProxySettingsResult,
} from "../../src/platform/firefox/proxy-controller";
import { authenticatedState, createHarness, NOW, PROFILE, proxySession } from "./helpers";

function event<T>() {
  let listener: ((details: T) => void) | undefined;
  return {
    addListener(value: (details: T) => void) {
      listener = value;
    },
    emit(details: T) {
      listener?.(details);
    },
  };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function fixture(hostAllowed = false) {
  const session = proxySession(
    "reaudit-startup-preserved",
    "frankfurt-01",
    new Date(NOW - 540_000).toISOString(),
  );
  const transient = {
    proxySession: session,
    refreshAttempts: 1,
    refreshRetryAt: NOW + 30_000,
    retiredSessions: [],
  };
  const h = createHarness({
    security: { ...DEFAULT_SECURITY_STATE, protectionRequested: true },
  });
  const state = { hostAllowed, transientReadable: true };
  const local: Record<string, unknown> = {
    fuzevpnState: authenticatedState({ autoConnect: true }),
  };
  const sessionStore: Record<string, unknown> = { fuzevpnProxySession: transient };
  let setting: ProxySettingsResult = {
    value: proxyConfig(session),
    levelOfControl: "controlled_by_this_extension",
  };
  const onRemoved = event<browser.permissions.Permissions>();
  const onPrivacy = event<unknown>();
  const pendingEvents: Promise<void>[] = [];
  const sessionGet = vi.fn(async () => {
    if (!state.transientReadable) throw new Error("native transient read unavailable");
    return structuredClone(sessionStore);
  });
  const localSet = vi.fn(async (items: Record<string, unknown>) => {
    Object.assign(local, structuredClone(items));
  });
  const localRemove = vi.fn(async (key: string) => {
    Reflect.deleteProperty(local, key);
  });
  const sessionRemove = vi.fn(async (key: string) => {
    Reflect.deleteProperty(sessionStore, key);
  });
  vi.stubGlobal("browser", {
    extension: { isAllowedIncognitoAccess: async () => true },
    permissions: {
      contains: async () => state.hostAllowed,
      onRemoved,
      onAdded: event<unknown>(),
    },
    proxy: {
      onError: event<unknown>(),
      settings: {
        onChange: event<unknown>(),
        get: async () => structuredClone(setting),
        set: async ({ value }: { value: browser.proxy.ProxyConfig }) => {
          setting = { value, levelOfControl: "controlled_by_this_extension" };
        },
        clear: async () => {
          setting = {
            value: { proxyType: "system" },
            levelOfControl: "controllable_by_this_extension",
          };
        },
      },
    },
    storage: {
      local: { get: async () => structuredClone(local), set: localSet, remove: localRemove },
      session: {
        get: sessionGet,
        set: async (items: Record<string, unknown>) => {
          Object.assign(sessionStore, structuredClone(items));
        },
        remove: sessionRemove,
      },
    },
    webRequest: { onErrorOccurred: event<unknown>() },
    privacy: {
      network: {
        webRTCIPHandlingPolicy: { onChange: onPrivacy },
        networkPredictionEnabled: { onChange: event<unknown>() },
      },
    },
  });
  const controller = new AppController({
    api: h.api,
    storage: new ExtensionStorageService(),
    identity: h.identity,
    proxy: new PlatformProxyService(),
    alarms: h.alarms,
    safety: h.safety,
    securityStorage: h.securityStorage,
    now: () => NOW,
    onStateChanged: () => undefined,
  });
  registerPlatformEvents({
    proxyChanged() {},
    proxyError() {},
    permissionsChanged() {
      pendingEvents.push(controller.handleProxyPermissionsChanged());
    },
    diagnosticsConsentAdded() {},
    diagnosticsConsentRemoved() {},
    privacyChanged() {
      pendingEvents.push(controller.handlePrivacyChange());
    },
  });
  return {
    ...h,
    controller,
    state,
    session,
    transient,
    sessionStore,
    onRemoved,
    onPrivacy,
    pendingEvents,
    sessionGet,
    localSet,
    localRemove,
    sessionRemove,
  };
}

describe("startup guard recovery preserves readable stored sessions", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("preserves a sleeping Firefox session when its host-removal event wakes the controller", async () => {
    const h = fixture();
    h.onRemoved.emit({ origins: ["<all_urls>"] });
    await Promise.all(h.pendingEvents);

    expect(h.controller.getSnapshot()).toMatchObject({
      protected: false,
      error: "host_permissions_required",
    });
    expect(h.sessionStore.fuzevpnProxySession).toEqual(h.transient);
    expect(h.sessionRemove).not.toHaveBeenCalled();
    expect(await h.controller.getActiveSession()).toBeNull();
    expect(h.controller.isSessionCurrentForProxyAuth(h.session)).toBe(false);
    expect(h.safety.events).not.toContain("allow");
    expect(h.api.proofs).toHaveLength(0);

    h.state.hostAllowed = true;
    await h.controller.initialize();

    expect(await h.controller.getActiveSession()).toEqual(h.session);
    expect(h.controller.getSnapshot()).toMatchObject({ protected: true, error: null });
    expect(h.alarms.retryAt).toBe(h.transient.refreshRetryAt);
    expect(h.api.proofs).toHaveLength(0);
  });

  it("persists preference changes during host refusal without destroying the saved session", async () => {
    const h = fixture();
    await h.controller.initialize();

    expect(await h.controller.updateSecurityPreferences(true, false)).toEqual({
      ok: false,
      commandError: "host_permissions_required",
    });

    expect(h.securityStorage.state?.webRtcProtectionEnabled).toBe(false);
    expect(h.sessionStore.fuzevpnProxySession).toEqual(h.transient);
    expect(h.sessionRemove).not.toHaveBeenCalled();
    expect(await h.controller.getActiveSession()).toBeNull();
    expect(h.api.proofs).toHaveLength(0);

    h.state.hostAllowed = true;
    await h.controller.initialize();

    expect(await h.controller.getActiveSession()).toEqual(h.session);
    expect(h.controller.getSnapshot()).toMatchObject({
      protected: true,
      error: null,
      securityPreferences: { webRtcProtectionEnabled: false },
    });
    expect(h.api.proofs).toHaveLength(0);
  });

  it("restores the same session if host access returns while the preference is committed", async () => {
    const h = fixture();
    await h.controller.initialize();
    const write = h.securityStorage.write.bind(h.securityStorage);
    vi.spyOn(h.securityStorage, "write").mockImplementation(async (state) => {
      await write(state);
      h.state.hostAllowed = true;
    });

    expect(await h.controller.updateSecurityPreferences(true, false)).toEqual({ ok: true });

    expect(await h.controller.getActiveSession()).toEqual(h.session);
    expect(h.controller.getSnapshot()).toMatchObject({
      protected: true,
      error: null,
      securityPreferences: { webRtcProtectionEnabled: false },
    });
    expect(h.alarms.retryAt).toBe(h.transient.refreshRetryAt);
    expect(h.api.proofs).toHaveLength(0);
  });

  it("keeps a native privacy event from destroying a session during an unverified startup guard", async () => {
    const h = fixture();
    const inspect = vi.spyOn(h.safety, "inspect").mockResolvedValue({
      trafficBlocked: false,
      filterActive: false,
      webRtcProtected: false,
      blockingScope: "unverified",
    });
    await h.controller.initialize();
    h.onPrivacy.emit({});
    await Promise.all(h.pendingEvents);

    expect(h.controller.getSnapshot()).toMatchObject({
      protected: false,
      trafficBlocked: false,
      blockingScope: "unverified",
      error: "host_permissions_required",
    });
    expect(h.sessionStore.fuzevpnProxySession).toEqual(h.transient);
    expect(h.sessionRemove).not.toHaveBeenCalled();
    expect(await h.controller.getActiveSession()).toBeNull();
    inspect.mockRestore();
    h.state.hostAllowed = true;
    await h.controller.initialize();
    expect(await h.controller.getActiveSession()).toEqual(h.session);
    expect(h.api.proofs).toHaveLength(0);
  });

  it("keeps a real failed storage read distinct from a refused guard during native events", async () => {
    const h = fixture();
    h.state.transientReadable = false;
    h.onRemoved.emit({ origins: ["<all_urls>"] });
    await Promise.all(h.pendingEvents);

    expect(h.sessionGet).toHaveBeenCalled();
    expect(h.sessionRemove).not.toHaveBeenCalled();
    expect(h.sessionStore.fuzevpnProxySession).toEqual(h.transient);
    expect(await h.controller.connect("frankfurt-01")).toEqual({
      ok: false,
      commandError: "storage_unavailable",
    });
    expect(await h.controller.getActiveSession()).toBeNull();
    expect(h.api.proofs).toHaveLength(0);

    h.state.hostAllowed = true;
    h.state.transientReadable = true;
    await h.controller.initialize();

    expect(await h.controller.getActiveSession()).toEqual(h.session);
    expect(h.controller.getSnapshot()).toMatchObject({ protected: true, error: null });
    expect(h.api.proofs).toHaveLength(0);
  });

  it("reports a new native storage failure while retrying the guard for a preference change", async () => {
    const h = fixture();
    await h.controller.initialize();
    h.sessionGet
      .mockResolvedValueOnce(structuredClone(h.sessionStore))
      .mockRejectedValueOnce(new Error("native transient read failed during guard repair"));

    expect(await h.controller.updateSecurityPreferences(true, false)).toEqual({
      ok: false,
      commandError: "storage_unavailable",
    });

    expect(h.sessionStore.fuzevpnProxySession).toEqual(h.transient);
    expect(h.sessionRemove).not.toHaveBeenCalled();
    expect(await h.controller.getActiveSession()).toBeNull();
    expect(h.api.proofs).toHaveLength(0);
    h.state.hostAllowed = true;
    await h.controller.initialize();
    expect(await h.controller.getActiveSession()).toEqual(h.session);
    expect(h.controller.getSnapshot()).toMatchObject({ protected: true, error: null });
    expect(h.api.proofs).toHaveLength(0);
  });

  it.each(["disconnect", "logout"] as const)(
    "keeps explicit %s dominant when a native event arrives during an unread-store stop",
    async (action) => {
      const h = fixture(true);
      h.state.transientReadable = false;
      await h.controller.initialize();
      const writing = deferred();
      const release = deferred();
      const popupReads: Promise<void>[] = [];
      const repairWhileWriting = async () => {
        h.state.transientReadable = true;
        h.onRemoved.emit({ origins: ["<all_urls>"] });
        popupReads.push(h.controller.initialize());
        writing.resolve();
        await release.promise;
      };
      if (action === "disconnect") {
        const write = h.localSet.getMockImplementation()!;
        h.localSet.mockImplementation(async (items) => {
          if ("fuzevpnState" in items) await repairWhileWriting();
          await write(items);
        });
      } else {
        const remove = h.localRemove.getMockImplementation()!;
        h.localRemove.mockImplementation(async (key) => {
          if (key === "fuzevpnState") await repairWhileWriting();
          await remove(key);
        });
      }

      const stopping = h.controller[action]();
      await writing.promise;
      expect(h.api.proofs).toHaveLength(0);
      release.resolve();
      expect(await stopping).toEqual({ ok: true });
      await Promise.all([...h.pendingEvents, ...popupReads]);
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
});
