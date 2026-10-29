// SPDX-License-Identifier: MPL-2.0

import type { ProxyErrorProvenance } from "../../src/platform/contracts/extension-api";
import { registerPlatformEvents } from "../../src/platform/firefox/bridge";
import { ProxyAuthHandler } from "../../src/platform/firefox/proxy-auth";
import { authenticatedState, createHarness, NOW, proxySession } from "./helpers";

interface NativeRequest {
  requestId?: unknown;
  timeStamp?: unknown;
  url?: string;
  requestBody?: unknown;
}

interface NativeFailure extends NativeRequest {
  url: string;
  error: string;
  proxyInfo?: unknown;
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function event<T = unknown>() {
  let listener: ((details: T) => void) | undefined;
  return {
    addListener: (value: (details: T) => void) => {
      listener = value;
    },
    emit: (details: T) => listener?.(details),
  };
}

function simulatedFirefox(
  onProxyError: (message: string, provenance?: ProxyErrorProvenance) => void = () => {},
) {
  const onBeforeRequest = event<NativeRequest>();
  const onCompleted = event<NativeRequest>();
  const onErrorOccurred = event<NativeFailure>();
  const forwarded = vi.fn(onProxyError);
  vi.stubGlobal("browser", {
    proxy: { settings: { onChange: event() }, onError: event() },
    webRequest: { onBeforeRequest, onCompleted, onErrorOccurred },
    permissions: { onRemoved: event(), onAdded: event() },
    privacy: {
      network: {
        webRTCIPHandlingPolicy: { onChange: event() },
        networkPredictionEnabled: { onChange: event() },
      },
    },
  });
  registerPlatformEvents({
    proxyChanged: vi.fn(),
    proxyError: forwarded,
    permissionsChanged: vi.fn(),
    diagnosticsConsentAdded: vi.fn(),
    diagnosticsConsentRemoved: vi.fn(),
    privacyChanged: vi.fn(),
  });
  const fail = (details: Partial<NativeFailure> = {}) => {
    onErrorOccurred.emit({
      url: "http://synthetic-destination.example/resource",
      error: "SEC_ERROR_UNKNOWN_ISSUER",
      proxyInfo: { type: "https", host: "frankfurt-01.proxy.vpn1euro.com", port: 443 },
      ...details,
    });
  };
  return { onBeforeRequest, onCompleted, onErrorOccurred, forwarded, fail };
}

function restoringHarness() {
  const session = proxySession("audit-restored-session");
  const h = createHarness({
    persisted: authenticatedState({ autoConnect: true }),
    transient: { proxySession: session, refreshAttempts: 0, retiredSessions: [] },
    activeProxy: session,
  });
  h.identity.deviceId = "audit-device";
  const handling: Promise<void>[] = [];
  const native = simulatedFirefox((message, provenance) => {
    handling.push(h.controller.handleProxyError(message, false, provenance));
  });
  const fail = (
    endpoint = { host: session.host, port: session.port },
    details: Partial<NativeFailure> = {},
  ) => native.fail({ proxyInfo: { type: "https", ...endpoint }, ...details });
  return { ...h, session, handling, native, fail };
}

type Harness = ReturnType<typeof restoringHarness>;
type PauseTarget = "storage" | "securityStorage" | "identity" | "proxy" | "alarms" | "safety";

function pause(h: Harness, target: PauseTarget, method: string, nth = 1) {
  const reached = deferred();
  const release = deferred();
  const object = h[target] as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
  const original = object[method]!.bind(object);
  let count = 0;
  vi.spyOn(object, method).mockImplementation(async (...args: unknown[]) => {
    if (++count === nth) {
      reached.resolve();
      await release.promise;
    }
    return original(...args);
  });
  return { reached, release };
}

async function finish(h: Harness, initializing: Promise<void>) {
  await initializing;
  await Promise.all(h.handling);
}

function expectFailedClosed(h: Harness, afterSnapshot = 0) {
  expect(h.controller.getSnapshot()).toMatchObject({
    protected: false,
    trafficBlocked: true,
    error: "proxy_unavailable",
  });
  expect(h.snapshots.slice(afterSnapshot).some((snapshot) => snapshot.protected)).toBe(false);
  expect(h.controller.isSessionCurrentForProxyAuth(h.session)).toBe(false);
}

async function connectedSuccessor(h: Harness) {
  await h.controller.disconnect();
  h.setNow(NOW + 1_000);
  vi.mocked(Date.now).mockReturnValue(NOW + 1_000);
  vi.mocked(performance.now).mockReturnValue(2_000);
  const successor = proxySession(
    "audit-successor",
    h.session.locationId,
    new Date(NOW + 1_000).toISOString(),
  );
  h.api.sessions = [successor];
  expect(await h.controller.connect(successor.locationId)).toEqual({ ok: true });
  expect(h.controller.getSnapshot().protected).toBe(true);
  vi.mocked(Date.now).mockReturnValue(NOW + 2_000);
  vi.mocked(performance.now).mockReturnValue(3_000);
  h.setNow(NOW + 2_000);
  return successor;
}

describe("Code audit COND01 / OBS-FF: Firefox startup failures", () => {
  beforeEach(() => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    vi.spyOn(performance, "now").mockReturnValue(1_000);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it.each([
    ["storage", "configureTrustedContexts", 1],
    ["storage", "readPersisted", 1],
    ["securityStorage", "read", 1],
    ["identity", "getDeviceId", 1],
    ["storage", "readTransient", 1],
    ["identity", "getRecovery", 1],
    ["proxy", "isActiveConfiguration", 1],
    ["alarms", "scheduleSession", 1],
    ["proxy", "isActiveConfiguration", 2],
    ["securityStorage", "write", 1],
    ["alarms", "clearReconnect", 1],
    ["safety", "allow", 1],
    ["proxy", "isActiveConfiguration", 3],
    ["identity", "getDeviceId", 2],
    ["identity", "completeRecovery", 1],
    ["safety", "setWebRtc", 2],
  ] as const)(
    "rejects credentials and protected publication at %s.%s #%i",
    async (target, method, nth) => {
      const h = restoringHarness();
      const gate = pause(h, target, method, nth);
      const initializing = h.controller.initialize();
      await gate.reached.promise;
      const afterSnapshot = h.snapshots.length;
      h.fail();
      expect(h.controller.isSessionCurrentForProxyAuth(h.session)).toBe(false);
      gate.release.resolve();
      await finish(h, initializing);
      expectFailedClosed(h, afterSnapshot);
      expect(await h.controller.getActiveSession()).toBeNull();
    },
  );

  it("preserves a useful startup error after twenty repeated foreign endpoints", async () => {
    const h = restoringHarness();
    const startup = pause(h, "storage", "readPersisted");
    const initializing = h.controller.initialize();
    await startup.reached.promise;
    h.fail();
    for (let index = 0; index < 20; index++)
      h.fail({ host: "historical-other.proxy.example", port: 443 });
    expect(h.controller.isSessionCurrentForProxyAuth(h.session)).toBe(false);
    startup.release.resolve();
    await finish(h, initializing);
    expectFailedClosed(h);
    expect(h.safety.events).not.toContain("allow");
    expect(await h.controller.getActiveSession()).toBeNull();
  });

  it("deduplicates endpoint casing and retains the useful error beyond the distinct endpoint cap", async () => {
    const h = restoringHarness();
    const startup = pause(h, "storage", "readPersisted");
    const initializing = h.controller.initialize();
    await startup.reached.promise;
    h.fail();
    h.fail({ host: h.session.host.toUpperCase(), port: h.session.port });
    // The public behavior is fail-closed; this size assertion also verifies the
    // required bound without exposing a diagnostic API or retaining request data.
    const pending = h.controller as unknown as { startupProxyFailures: readonly unknown[] };
    expect(pending.startupProxyFailures).toHaveLength(1);
    for (let index = 0; index < 256; index++)
      h.fail({ host: `foreign-${String(index)}.proxy.example`, port: 443 });
    expect(pending.startupProxyFailures.length).toBeLessThanOrEqual(128);
    expect(h.controller.isSessionCurrentForProxyAuth(h.session)).toBe(false);
    startup.release.resolve();
    await finish(h, initializing);
    expectFailedClosed(h);
    expect(h.safety.events).not.toContain("allow");
  });

  it("fails closed on an unknown restored endpoint after too many distinct startup failures", async () => {
    const h = restoringHarness();
    const startup = pause(h, "storage", "readPersisted");
    const initializing = h.controller.initialize();
    await startup.reached.promise;
    for (let index = 0; index < 256; index++)
      h.fail({ host: `unrelated-${String(index)}.proxy.example`, port: 443 });
    expect(h.controller.isSessionCurrentForProxyAuth(h.session)).toBe(false);
    startup.release.resolve();
    await finish(h, initializing);
    expectFailedClosed(h);
    expect(h.safety.events).not.toContain("allow");
  });

  it.each(["transient-read", "startup-guard"] as const)(
    "retains a matching error across a failed %s generation",
    async (failure) => {
      const h = restoringHarness();
      const startup = pause(h, "storage", "readPersisted");
      if (failure === "transient-read")
        vi.spyOn(h.storage, "readTransient").mockRejectedValueOnce(
          new Error("synthetic unread store"),
        );
      else
        vi.spyOn(h.safety, "suspend").mockRejectedValueOnce(new Error("synthetic guard failure"));
      const initializing = h.controller.initialize();
      await startup.reached.promise;
      h.fail();
      startup.release.resolve();
      await finish(h, initializing);
      await h.controller.initialize();
      expect(h.controller.getSnapshot()).toMatchObject({
        protected: false,
        error: "proxy_unavailable",
      });
      expect(h.safety.events).not.toContain("allow");
      expect(await h.controller.getActiveSession()).toBeNull();
    },
  );

  it("cancels credentials when a startup error arrives during the final ownership read", async () => {
    const h = restoringHarness();
    const startup = pause(h, "storage", "readPersisted");
    const initializing = h.controller.initialize();
    await startup.reached.promise;
    const reachedFinalRead = deferred();
    const releaseFinalRead = deferred();
    let reads = 0;
    const auth = new ProxyAuthHandler({
      now: () => NOW,
      getSession: () => h.controller.getActiveSession(),
      isSessionCurrent: (session) => h.controller.isSessionCurrentForProxyAuth(session),
      isConfiguredProxyChallenge: async () => {
        if (++reads === 2) {
          reachedFinalRead.resolve();
          await releaseFinalRead.promise;
        }
        return true;
      },
      wasUsedProxyChallenge: async () => false,
    });
    const credentials = auth.handle({
      isProxy: true,
      requestId: "audit-auth-request",
      challenger: { host: h.session.host, port: h.session.port },
      proxyInfo: { type: "https", host: h.session.host, port: h.session.port },
    } as Parameters<ProxyAuthHandler["handle"]>[0]);
    await reachedFinalRead.promise;
    h.fail();
    releaseFinalRead.resolve();
    expect(await credentials).toEqual({ cancel: true });
    startup.release.resolve();
    await finish(h, initializing);
    expectFailedClosed(h);
    expect(h.safety.events).not.toContain("allow");
  });

  it("keeps a cached request start before B from invalidating B at the same endpoint", async () => {
    const h = restoringHarness();
    await h.controller.initialize();
    h.native.onBeforeRequest.emit({ requestId: "old-request-before-B", timeStamp: NOW });
    const successor = await connectedSuccessor(h);
    h.fail(undefined, { requestId: "old-request-before-B", timeStamp: NOW + 2_000 });
    expect(h.native.forwarded).toHaveBeenLastCalledWith("proxy_tls_error", {
      host: successor.host,
      port: successor.port,
      requestId: "old-request-before-B",
      requestStartedAt: NOW,
      requestObservedAt: 1_000,
      errorOccurredAt: NOW + 2_000,
    });
    await Promise.all(h.handling);
    expect(h.controller.getSnapshot()).toMatchObject({ protected: true, error: null });
    expect(await h.controller.getActiveSession()).toEqual(successor);
    expect(h.controller.isSessionCurrentForProxyAuth(successor)).toBe(true);
    expect(h.api.revoked).not.toContain(successor.id);
  });

  it.each(["current-start", "unknown-start", "completed-start", "evicted-start"] as const)(
    "rejects B for a current native error with %s",
    async (provenance) => {
      const h = restoringHarness();
      await h.controller.initialize();
      const requestId = "request-error-for-B";
      if (provenance === "completed-start" || provenance === "evicted-start") {
        h.native.onBeforeRequest.emit({ requestId, timeStamp: NOW });
        if (provenance === "completed-start") h.native.onCompleted.emit({ requestId });
        else
          for (let index = 0; index < 1_024; index++)
            h.native.onBeforeRequest.emit({
              requestId: `bounded-${String(index)}`,
              timeStamp: NOW,
            });
      }
      const successor = await connectedSuccessor(h);
      if (provenance === "current-start")
        h.native.onBeforeRequest.emit({ requestId, timeStamp: NOW + 1_000 });
      h.fail(undefined, { requestId, timeStamp: NOW + 2_000 });
      await Promise.all(h.handling);
      expect(h.controller.getSnapshot()).toMatchObject({
        protected: false,
        trafficBlocked: true,
        error: "proxy_unavailable",
      });
      expect(h.controller.isSessionCurrentForProxyAuth(successor)).toBe(false);
      expect(await h.controller.getActiveSession()).toBeNull();
    },
  );

  it("rejects a current request after the wall clock moves behind B's activation", async () => {
    const h = restoringHarness();
    await h.controller.initialize();
    const successor = await connectedSuccessor(h);
    vi.mocked(Date.now).mockReturnValue(NOW - 10_000);
    vi.mocked(performance.now).mockReturnValue(4_000);
    h.setNow(NOW - 10_000);
    h.native.onBeforeRequest.emit({
      requestId: "current-after-clock-rollback",
      timeStamp: NOW - 10_000,
    });
    h.fail(undefined, { requestId: "current-after-clock-rollback", timeStamp: NOW - 9_999 });
    await Promise.all(h.handling);
    expect(h.controller.getSnapshot()).toMatchObject({
      protected: false,
      trafficBlocked: true,
      error: "proxy_unavailable",
    });
    expect(h.controller.isSessionCurrentForProxyAuth(successor)).toBe(false);
    expect(await h.controller.getActiveSession()).toBeNull();
  });

  it("keeps an old native error date fail-closed when its request start is unknown", async () => {
    const h = restoringHarness();
    await h.controller.initialize();
    const successor = await connectedSuccessor(h);
    h.fail(undefined, { requestId: "unknown-start-old-date", timeStamp: 1 });
    await Promise.all(h.handling);
    expect(h.controller.getSnapshot()).toMatchObject({
      protected: false,
      trafficBlocked: true,
      error: "proxy_unavailable",
    });
    expect(h.controller.isSessionCurrentForProxyAuth(successor)).toBe(false);
    expect(await h.controller.getActiveSession()).toBeNull();
  });
});

describe("Code audit OBS-FF: simulated native request lifecycle", () => {
  beforeEach(() => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    vi.spyOn(performance, "now").mockReturnValue(1_000);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("dates the latest native start across redirects and forwards only bounded provenance", () => {
    const native = simulatedFirefox();
    native.onBeforeRequest.emit({
      requestId: "redirected",
      timeStamp: NOW - 100,
      url: "http://synthetic-start.example/private-path",
      requestBody: { raw: "synthetic-request-body" },
    });
    native.onBeforeRequest.emit({ requestId: "redirected", timeStamp: NOW - 10 });
    native.fail({ requestId: "redirected", timeStamp: NOW });
    expect(native.forwarded).toHaveBeenCalledExactlyOnceWith("proxy_tls_error", {
      host: "frankfurt-01.proxy.vpn1euro.com",
      port: 443,
      requestId: "redirected",
      requestStartedAt: NOW - 10,
      requestObservedAt: 1_000,
      errorOccurredAt: NOW,
    });
  });

  it.each(["completed", "unclassified-error", "classified-error"] as const)(
    "removes start evidence after %s",
    (ending) => {
      const native = simulatedFirefox();
      const requestId = "finished-request";
      native.onBeforeRequest.emit({ requestId, timeStamp: NOW - 100 });
      if (ending === "completed") native.onCompleted.emit({ requestId });
      else if (ending === "unclassified-error")
        native.fail({
          requestId,
          timeStamp: NOW - 10,
          error: "NS_ERROR_ABORT",
          proxyInfo: undefined,
        });
      else native.fail({ requestId, timeStamp: NOW - 10 });
      native.forwarded.mockClear();
      native.fail({ requestId, timeStamp: NOW });
      expect(native.forwarded).toHaveBeenCalledExactlyOnceWith("proxy_tls_error", {
        host: "frankfurt-01.proxy.vpn1euro.com",
        port: 443,
        requestId,
        errorOccurredAt: NOW,
      });
    },
  );

  it("expires abandoned request evidence at five minutes and still delivers the error", () => {
    const native = simulatedFirefox();
    native.onBeforeRequest.emit({ requestId: "expired", timeStamp: NOW });
    vi.mocked(Date.now).mockReturnValue(NOW + 300_000);
    vi.mocked(performance.now).mockReturnValue(1_000 + 300_000);
    native.fail({ requestId: "expired", timeStamp: NOW + 300_000 });
    expect(native.forwarded).toHaveBeenCalledExactlyOnceWith("proxy_tls_error", {
      host: "frankfurt-01.proxy.vpn1euro.com",
      port: 443,
      requestId: "expired",
      errorOccurredAt: NOW + 300_000,
    });
  });

  it("keeps native start evidence just before its retention deadline", () => {
    const native = simulatedFirefox();
    native.onBeforeRequest.emit({ requestId: "not-expired", timeStamp: NOW - 10 });
    vi.mocked(Date.now).mockReturnValue(NOW + 299_999);
    vi.mocked(performance.now).mockReturnValue(1_000 + 299_999);
    native.fail({ requestId: "not-expired", timeStamp: NOW + 299_999 });
    expect(native.forwarded).toHaveBeenLastCalledWith(
      "proxy_tls_error",
      expect.objectContaining({ requestStartedAt: NOW - 10 }),
    );
  });

  it("evicts the oldest start beyond 1024 requests while preserving delivery for both errors", () => {
    const native = simulatedFirefox();
    for (let index = 0; index < 1_025; index++)
      native.onBeforeRequest.emit({ requestId: `request-${String(index)}`, timeStamp: NOW });
    native.fail({ requestId: "request-0", timeStamp: NOW });
    native.fail({ requestId: "request-1024", timeStamp: NOW });
    expect(native.forwarded).toHaveBeenNthCalledWith(1, "proxy_tls_error", {
      host: "frankfurt-01.proxy.vpn1euro.com",
      port: 443,
      requestId: "request-0",
      errorOccurredAt: NOW,
    });
    expect(native.forwarded).toHaveBeenNthCalledWith(2, "proxy_tls_error", {
      host: "frankfurt-01.proxy.vpn1euro.com",
      port: 443,
      requestId: "request-1024",
      requestStartedAt: NOW,
      requestObservedAt: 1_000,
      errorOccurredAt: NOW,
    });
  });

  it.each([undefined, 0, -1, Number.NaN, Number.POSITIVE_INFINITY, NOW + 1_001, "native-date"])(
    "keeps a request start unknown for invalid native time %s",
    (timeStamp) => {
      const native = simulatedFirefox();
      native.onBeforeRequest.emit({ requestId: "invalid-time", timeStamp });
      native.fail({ requestId: "invalid-time", timeStamp: NOW });
      expect(native.forwarded).toHaveBeenCalledExactlyOnceWith("proxy_tls_error", {
        host: "frankfurt-01.proxy.vpn1euro.com",
        port: 443,
        requestId: "invalid-time",
        errorOccurredAt: NOW,
      });
    },
  );

  it.each([undefined, "", "x".repeat(257), 42])(
    "discards an invalid request ID without dropping a proxy error (%s)",
    (requestId) => {
      const native = simulatedFirefox();
      native.onBeforeRequest.emit({ requestId, timeStamp: NOW - 100 });
      native.fail({ requestId, timeStamp: NOW });
      expect(native.forwarded).toHaveBeenCalledExactlyOnceWith("proxy_tls_error", {
        host: "frankfurt-01.proxy.vpn1euro.com",
        port: 443,
        errorOccurredAt: NOW,
      });
    },
  );

  it("does not invent a start from an error timestamp when no beforeRequest was observed", () => {
    const native = simulatedFirefox();
    native.fail({ requestId: "already-in-flight", timeStamp: 1 });
    expect(native.forwarded).toHaveBeenCalledExactlyOnceWith("proxy_tls_error", {
      host: "frankfurt-01.proxy.vpn1euro.com",
      port: 443,
      requestId: "already-in-flight",
      errorOccurredAt: 1,
    });
  });

  it("preserves monotonic start evidence across wall-clock rollback", () => {
    const native = simulatedFirefox();
    native.onBeforeRequest.emit({ requestId: "rollback", timeStamp: NOW - 100 });
    vi.mocked(Date.now).mockReturnValue(NOW - 1);
    native.fail({ requestId: "rollback", timeStamp: NOW - 1 });
    expect(native.forwarded).toHaveBeenCalledExactlyOnceWith("proxy_tls_error", {
      host: "frankfurt-01.proxy.vpn1euro.com",
      port: 443,
      requestId: "rollback",
      requestStartedAt: NOW - 100,
      requestObservedAt: 1_000,
      errorOccurredAt: NOW - 1,
    });
  });

  it("keeps contradictory native start and error dates unknown", () => {
    const native = simulatedFirefox();
    native.onBeforeRequest.emit({ requestId: "inconsistent-date", timeStamp: NOW });
    native.fail({ requestId: "inconsistent-date", timeStamp: NOW - 1 });
    expect(native.forwarded).toHaveBeenCalledExactlyOnceWith("proxy_tls_error", {
      host: "frankfurt-01.proxy.vpn1euro.com",
      port: 443,
      requestId: "inconsistent-date",
    });
  });
});
