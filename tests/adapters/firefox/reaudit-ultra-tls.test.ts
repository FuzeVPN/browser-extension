// SPDX-License-Identifier: MPL-2.0

import { AppController } from "../../../src/core/background/state-machine";
import type { ProxyErrorProvenance } from "../../../src/platform/contracts/extension-api";
import { registerPlatformEvents } from "../../../src/platform/firefox/bridge";
import {
  PlatformProxyService,
  readProxyConfiguration,
} from "../../../src/platform/firefox/proxy-controller";
import { authenticatedState, createHarness, NOW, proxySession } from "../../common/helpers";

interface Endpoint {
  host: string;
  port: number;
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

/** Simulated Firefox events driving the real bridge; returns the stubbed namespace. */
function nativeFirefox(onError: (message: string, provenance?: ProxyErrorProvenance) => void) {
  const onBeforeRequest = event<{ requestId: string; timeStamp: unknown }>();
  const onErrorOccurred = event<{
    requestId: string;
    timeStamp: number;
    url: string;
    error: string;
    proxyInfo: unknown;
  }>();
  const proxyError = vi.fn(onError);
  const settings: Record<string, unknown> = { onChange: event() };
  const permissions: Record<string, unknown> = { onAdded: event(), onRemoved: event() };
  const api: Record<string, unknown> = {
    proxy: { settings, onError: event() },
    webRequest: { onBeforeRequest, onCompleted: event(), onErrorOccurred },
    permissions,
    privacy: {
      network: {
        webRTCIPHandlingPolicy: { onChange: event() },
        networkPredictionEnabled: { onChange: event() },
      },
    },
  };
  vi.stubGlobal("browser", api);
  registerPlatformEvents({
    proxyChanged: vi.fn(),
    proxyError,
    permissionsChanged: vi.fn(),
    diagnosticsConsentAdded: vi.fn(),
    diagnosticsConsentRemoved: vi.fn(),
    privacyChanged: vi.fn(),
  });
  const start = (requestId: string, timeStamp: unknown = NOW) =>
    onBeforeRequest.emit({ requestId, timeStamp });
  const fail = (requestId: string, endpoint: Endpoint) =>
    onErrorOccurred.emit({
      requestId,
      timeStamp: NOW,
      url: "http://destination.example/",
      error: "SEC_ERROR_UNKNOWN_ISSUER",
      proxyInfo: { type: "https", host: endpoint.host, port: endpoint.port },
    });
  return { api, settings, permissions, proxyError, start, fail };
}

function monotonic(value: number) {
  vi.mocked(performance.now).mockReturnValue(value);
}

describe("reaudit ultra: Firefox TLS provenance of redirected requests", () => {
  beforeEach(() => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    vi.spyOn(performance, "now").mockReturnValue(1_000);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("dates the failure of a redirected leg from that leg's own native start", () => {
    const native = nativeFirefox(() => undefined);
    const endpoint = proxySession();
    native.start("redirected", NOW - 100);
    monotonic(3_000);
    native.start("redirected", NOW - 10);
    native.fail("redirected", endpoint);
    expect(native.proxyError).toHaveBeenCalledExactlyOnceWith("proxy_tls_error", {
      host: endpoint.host,
      port: endpoint.port,
      requestId: "redirected",
      requestStartedAt: NOW - 10,
      requestObservedAt: 3_000,
      errorOccurredAt: NOW,
    });
  });

  it("forgets the earlier leg when a redirected leg has no usable native date", () => {
    const native = nativeFirefox(() => undefined);
    const endpoint = proxySession();
    native.start("redirected", NOW - 100);
    monotonic(3_000);
    native.start("redirected", "invalid");
    native.fail("redirected", endpoint);
    expect(native.proxyError).toHaveBeenCalledExactlyOnceWith("proxy_tls_error", {
      host: endpoint.host,
      port: endpoint.port,
      requestId: "redirected",
      errorOccurredAt: NOW,
    });
  });

  it.each([false, true])(
    "blocks a successor only when a leg departed after its activation (redirected %s)",
    async (redirected) => {
      const predecessor = proxySession("redirect-predecessor");
      const h = createHarness({
        persisted: authenticatedState({ autoConnect: true }),
        transient: { proxySession: predecessor, refreshAttempts: 0, retiredSessions: [] },
        activeProxy: predecessor,
      });
      const handling: Promise<void>[] = [];
      const native = nativeFirefox((message, provenance) => {
        handling.push(h.controller.handleProxyError(message, false, provenance));
      });
      await h.controller.initialize();
      native.start("cross-route");
      await h.controller.disconnect();
      monotonic(2_000);
      const successor = proxySession("redirect-successor");
      h.api.sessions = [successor];
      expect(await h.controller.connect(successor.locationId)).toEqual({ ok: true });
      monotonic(3_000);
      if (redirected) native.start("cross-route");
      native.fail("cross-route", successor);
      await Promise.all(handling);

      // Only a departure observed before activation proves an error historical.
      expect(h.controller.getSnapshot()).toMatchObject(
        redirected
          ? { protected: false, error: "proxy_unavailable" }
          : { protected: true, error: null },
      );
      expect(h.controller.isSessionCurrentForProxyAuth(successor)).toBe(!redirected);
    },
  );
});

describe("reaudit ultra: Firefox TLS failure delivered while settings.set installs a session", () => {
  beforeEach(() => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    vi.spyOn(performance, "now").mockReturnValue(1_000);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it.each(["connect", "refresh"] as const)(
    "never authorizes the session after its TLS failure during %s",
    async (mode) => {
      const h = createHarness({ persisted: authenticatedState() });
      const handling: Promise<void>[] = [];
      const native = nativeFirefox((message, provenance) => {
        handling.push(h.controller.handleProxyError(message, false, provenance));
      });
      const session = proxySession(`settings-set-${mode}`);
      const route: { value: unknown; controlled: boolean; armed: boolean } = {
        value: {},
        controlled: false,
        armed: false,
      };
      const delivered = { snapshots: -1, events: -1, credentials: true };
      const sessionStore: Record<string, unknown> = {};
      Object.assign(native.api, {
        extension: { isAllowedIncognitoAccess: async () => true },
        storage: {
          session: {
            get: async (key: string) => ({ [key]: sessionStore[key] }),
            set: async (items: Record<string, unknown>) => {
              Object.assign(sessionStore, items);
            },
          },
        },
      });
      Object.assign(native.permissions, { contains: async () => true });
      Object.assign(native.settings, {
        get: async () => ({
          value: route.value,
          levelOfControl: route.controlled
            ? "controlled_by_this_extension"
            : "controllable_by_this_extension",
        }),
        clear: async () => {
          route.value = {};
          route.controlled = false;
        },
        set: async (details: { value: unknown }) => {
          route.value = details.value;
          route.controlled = true;
          if (!route.armed || readProxyConfiguration(details.value)?.endpoint.host !== session.host)
            return;
          // A request through the newly installed route fails before apply resolves.
          monotonic(1_100);
          native.start("during-settings-set");
          delivered.snapshots = h.snapshots.length;
          delivered.events = h.safety.events.length;
          native.fail("during-settings-set", session);
          delivered.credentials = h.controller.isSessionCurrentForProxyAuth(session);
        },
      });
      // Firefox PAC routes carry only the endpoint, which both sessions share.
      h.controller = new AppController({
        api: h.api,
        storage: h.storage,
        identity: h.identity,
        proxy: new PlatformProxyService(),
        alarms: h.alarms,
        safety: h.safety,
        securityStorage: h.securityStorage,
        now: () => NOW,
        onStateChanged: (snapshot) => h.snapshots.push(snapshot),
      });
      if (mode === "refresh")
        expect(await h.controller.connect(session.locationId)).toEqual({ ok: true });
      else await h.controller.initialize();
      h.api.sessions = [session];
      route.armed = true;

      const result =
        mode === "refresh"
          ? await h.controller.retryConnection()
          : await h.controller.connect(session.locationId);
      await Promise.all(handling);

      expect(delivered.snapshots).toBeGreaterThanOrEqual(0);
      expect(delivered.credentials).toBe(false);
      expect(result).toEqual({ ok: false, commandError: "proxy_unavailable" });
      expect(h.safety.events.slice(delivered.events)).not.toContain("allow");
      expect(h.snapshots.slice(delivered.snapshots).some((snapshot) => snapshot.protected)).toBe(
        false,
      );
      expect(h.controller.getSnapshot()).toMatchObject({
        protected: false,
        error: "proxy_unavailable",
      });
    },
  );
});
