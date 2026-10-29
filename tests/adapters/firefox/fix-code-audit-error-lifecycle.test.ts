// SPDX-License-Identifier: MPL-2.0

import { registerPlatformEvents } from "../../../src/platform/firefox/bridge";
import type { ProxyErrorProvenance } from "../../../src/platform/contracts/extension-api";
import { authenticatedState, createHarness, NOW, proxySession } from "../../common/helpers";

const endpoint = { host: "proxy.example.com", port: 443 };
const MONOTONIC = 10000;

function event<T>() {
  let listener: ((details: T) => void) | undefined;
  return {
    addListener: (value: (details: T) => void) => {
      listener = value;
    },
    emit: (details: T) => listener?.(details),
  };
}

function bridge(onError?: (message: string, provenance?: ProxyErrorProvenance) => void) {
  const onBeforeRequest = event<{ requestId: unknown; timeStamp: unknown }>();
  const onCompleted = event<{ requestId: string }>();
  const onErrorOccurred = event<{
    requestId?: unknown;
    timeStamp?: unknown;
    url: string;
    error: string;
    proxyInfo?: unknown;
  }>();
  const proxyError = vi.fn(onError);
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
    proxyError,
    permissionsChanged: vi.fn(),
    diagnosticsConsentAdded: vi.fn(),
    diagnosticsConsentRemoved: vi.fn(),
    privacyChanged: vi.fn(),
  });
  const fail = (extra: Partial<Parameters<typeof onErrorOccurred.emit>[0]> = {}) =>
    onErrorOccurred.emit({
      url: "http://destination.example/private-path?private=query",
      error: "SEC_ERROR_UNKNOWN_ISSUER",
      proxyInfo: { type: "https", ...endpoint },
      ...extra,
    });
  return { onBeforeRequest, onCompleted, proxyError, fail };
}

function restoringController() {
  const session = { ...proxySession("predecessor"), ...endpoint };
  const h = createHarness({
    persisted: authenticatedState({ autoConnect: true }),
    transient: { proxySession: session, refreshAttempts: 0, retiredSessions: [] },
    activeProxy: session,
  });
  h.identity.deviceId = "browser-device-1";
  const handling: Promise<void>[] = [];
  const f = bridge((message, provenance) => {
    handling.push(h.controller.handleProxyError(message, false, provenance));
  });
  return { ...h, ...f, session, handling };
}

describe("Firefox code audit: bounded native request provenance", () => {
  beforeEach(() => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    vi.spyOn(performance, "now").mockReturnValue(MONOTONIC);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("correlates only the native request start and forwards synchronously without destination data", () => {
    const f = bridge();
    f.onBeforeRequest.emit({ requestId: "native-request", timeStamp: NOW - 100 });
    f.fail({ requestId: "native-request", timeStamp: NOW });
    expect(f.proxyError).toHaveBeenCalledExactlyOnceWith("proxy_tls_error", {
      ...endpoint,
      requestId: "native-request",
      requestStartedAt: NOW - 100,
      requestObservedAt: MONOTONIC,
      errorOccurredAt: NOW,
    });
  });

  it("does not turn the error event date into a request departure date", () => {
    const f = bridge();
    f.fail({ requestId: "not-observed-at-start", timeStamp: 1 });
    expect(f.proxyError).toHaveBeenCalledExactlyOnceWith("proxy_tls_error", {
      ...endpoint,
      requestId: "not-observed-at-start",
      errorOccurredAt: 1,
    });
  });

  it("dates a redirected request identity from its latest native start", () => {
    const f = bridge();
    f.onBeforeRequest.emit({ requestId: "redirected", timeStamp: NOW - 100 });
    f.onBeforeRequest.emit({ requestId: "redirected", timeStamp: NOW - 10 });
    f.fail({ requestId: "redirected", timeStamp: NOW });
    expect(f.proxyError).toHaveBeenLastCalledWith("proxy_tls_error", {
      ...endpoint,
      requestId: "redirected",
      requestStartedAt: NOW - 10,
      requestObservedAt: MONOTONIC,
      errorOccurredAt: NOW,
    });
  });

  it("does not borrow a departure date from another native request", () => {
    const f = bridge();
    f.onBeforeRequest.emit({ requestId: "another-request", timeStamp: NOW - 100 });
    f.fail({ requestId: "current-request", timeStamp: NOW });
    expect(f.proxyError).toHaveBeenLastCalledWith("proxy_tls_error", {
      ...endpoint,
      requestId: "current-request",
      errorOccurredAt: NOW,
    });
  });

  it.each(["completion", "proxy-error", "unclassified-error"])(
    "removes departure evidence after native %s",
    (ending) => {
      const f = bridge();
      f.onBeforeRequest.emit({ requestId: "ended", timeStamp: NOW - 100 });
      if (ending === "completion") f.onCompleted.emit({ requestId: "ended" });
      else
        f.fail({
          requestId: "ended",
          timeStamp: NOW - 1,
          error: ending === "proxy-error" ? "SEC_ERROR_UNKNOWN_ISSUER" : "NS_BINDING_ABORTED",
        });
      f.proxyError.mockClear();
      f.fail({ requestId: "ended", timeStamp: NOW });
      expect(f.proxyError).toHaveBeenCalledExactlyOnceWith("proxy_tls_error", {
        ...endpoint,
        requestId: "ended",
        errorOccurredAt: NOW,
      });
    },
  );

  it("caps tracking at 1024 requests and retains the newest request evidence", () => {
    const f = bridge();
    for (let index = 0; index <= 1024; index++)
      f.onBeforeRequest.emit({ requestId: `request-${String(index)}`, timeStamp: NOW - 10 });
    f.fail({ requestId: "request-0", timeStamp: NOW });
    expect(f.proxyError).toHaveBeenLastCalledWith("proxy_tls_error", {
      ...endpoint,
      requestId: "request-0",
      errorOccurredAt: NOW,
    });
    f.fail({ requestId: "request-1024", timeStamp: NOW });
    expect(f.proxyError).toHaveBeenLastCalledWith("proxy_tls_error", {
      ...endpoint,
      requestId: "request-1024",
      requestStartedAt: NOW - 10,
      requestObservedAt: MONOTONIC,
      errorOccurredAt: NOW,
    });
  });

  it.each([5 * 60 * 1000, 5 * 60 * 1000 + 1])(
    "expires request evidence after %i milliseconds while still dispatching the failure",
    (age) => {
      const f = bridge();
      f.onBeforeRequest.emit({ requestId: "expired", timeStamp: NOW });
      vi.mocked(Date.now).mockReturnValue(NOW + age);
      vi.mocked(performance.now).mockReturnValue(MONOTONIC + age);
      f.fail({ requestId: "expired", timeStamp: NOW + age });
      expect(f.proxyError).toHaveBeenCalledExactlyOnceWith("proxy_tls_error", {
        ...endpoint,
        requestId: "expired",
        errorOccurredAt: NOW + age,
      });
    },
  );

  it("retains departure evidence immediately before the tracking deadline", () => {
    const f = bridge();
    f.onBeforeRequest.emit({ requestId: "unexpired", timeStamp: NOW });
    vi.mocked(Date.now).mockReturnValue(NOW + 5 * 60 * 1000 - 1);
    vi.mocked(performance.now).mockReturnValue(MONOTONIC + 5 * 60 * 1000 - 1);
    f.fail({ requestId: "unexpired" });
    expect(f.proxyError).toHaveBeenCalledExactlyOnceWith("proxy_tls_error", {
      ...endpoint,
      requestId: "unexpired",
      requestStartedAt: NOW,
      requestObservedAt: MONOTONIC,
    });
  });

  it("retains monotonic request evidence when the wall clock moves backwards", () => {
    const f = bridge();
    f.onBeforeRequest.emit({ requestId: "clock-change", timeStamp: NOW });
    vi.mocked(Date.now).mockReturnValue(NOW - 1);
    f.fail({ requestId: "clock-change" });
    expect(f.proxyError).toHaveBeenCalledExactlyOnceWith("proxy_tls_error", {
      ...endpoint,
      requestId: "clock-change",
      requestStartedAt: NOW,
      requestObservedAt: MONOTONIC,
    });
  });

  it.each([NaN, Infinity, -1, MONOTONIC - 1])(
    "discards evidence if the monotonic clock becomes invalid or moves backwards: %s",
    (monotonicNow) => {
      const f = bridge();
      f.onBeforeRequest.emit({ requestId: "invalid-monotonic", timeStamp: NOW });
      vi.mocked(performance.now).mockReturnValue(monotonicNow);
      f.fail({ requestId: "invalid-monotonic" });
      expect(f.proxyError).toHaveBeenCalledExactlyOnceWith("proxy_tls_error", {
        ...endpoint,
        requestId: "invalid-monotonic",
      });
    },
  );

  it.each([NaN, Infinity, -1, 0, NOW + 1001, "invalid"])(
    "does not promote an invalid native date to lifecycle evidence: %s",
    (timeStamp) => {
      const f = bridge();
      f.onBeforeRequest.emit({ requestId: "invalid-date", timeStamp });
      f.fail({ requestId: "invalid-date", timeStamp });
      expect(f.proxyError).toHaveBeenCalledExactlyOnceWith("proxy_tls_error", {
        ...endpoint,
        requestId: "invalid-date",
      });
    },
  );

  it.each([undefined, null, 42, "", "x".repeat(257)])(
    "does not retain an invalid or excessive native request identity: %j",
    (requestId) => {
      const f = bridge();
      f.onBeforeRequest.emit({ requestId, timeStamp: NOW - 100 });
      f.fail({ requestId });
      expect(f.proxyError).toHaveBeenCalledExactlyOnceWith("proxy_tls_error", endpoint);
    },
  );

  it("treats contradictory native start and error dates as unknown", () => {
    const f = bridge();
    f.onBeforeRequest.emit({ requestId: "out-of-order", timeStamp: NOW });
    f.fail({ requestId: "out-of-order", timeStamp: NOW - 1 });
    expect(f.proxyError).toHaveBeenCalledExactlyOnceWith("proxy_tls_error", {
      ...endpoint,
      requestId: "out-of-order",
    });
  });

  it.each(["https:", "wss:"])(
    "retains explicit native proxy certificate attribution for %s requests",
    (protocol) => {
      const f = bridge();
      f.onBeforeRequest.emit({ requestId: "explicit-proxy-tls", timeStamp: NOW - 100 });
      f.fail({
        requestId: "explicit-proxy-tls",
        timeStamp: NOW,
        url: `${protocol}//destination.example/`,
        error: "NS_ERROR_PROXY_CERTIFICATE_INVALID",
      });
      expect(f.proxyError).toHaveBeenCalledExactlyOnceWith("NS_ERROR_PROXY_CERTIFICATE_INVALID", {
        ...endpoint,
        requestId: "explicit-proxy-tls",
        requestStartedAt: NOW - 100,
        requestObservedAt: MONOTONIC,
        errorOccurredAt: NOW,
      });
    },
  );

  it.each(["https:", "wss:"])(
    "does not attribute an ambiguous destination TLS error for %s to the proxy",
    (protocol) => {
      const f = bridge();
      f.onBeforeRequest.emit({ requestId: "destination-tls", timeStamp: NOW - 100 });
      f.fail({
        requestId: "destination-tls",
        timeStamp: NOW,
        url: `${protocol}//destination.example/`,
      });
      expect(f.proxyError).not.toHaveBeenCalled();
    },
  );
});

describe("Firefox code audit: native provenance across session succession", () => {
  beforeEach(() => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    vi.spyOn(performance, "now").mockReturnValue(MONOTONIC);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  async function successor() {
    const h = restoringController();
    await h.controller.initialize();
    h.onBeforeRequest.emit({ requestId: "predecessor-request", timeStamp: NOW });
    h.setNow(NOW + 10);
    vi.mocked(Date.now).mockReturnValue(NOW + 10);
    vi.mocked(performance.now).mockReturnValue(MONOTONIC + 10);
    await h.controller.disconnect();
    h.setNow(NOW + 20);
    vi.mocked(Date.now).mockReturnValue(NOW + 20);
    vi.mocked(performance.now).mockReturnValue(MONOTONIC + 20);
    const next = { ...proxySession("successor"), ...endpoint };
    h.api.sessions = [next];
    expect(await h.controller.connect(next.locationId)).toEqual({ ok: true });
    h.setNow(NOW + 30);
    vi.mocked(Date.now).mockReturnValue(NOW + 30);
    vi.mocked(performance.now).mockReturnValue(MONOTONIC + 30);
    return { ...h, next };
  }

  it("ignores a proven predecessor request at the reused endpoint even if its error occurs after succession", async () => {
    const h = await successor();
    h.fail({ requestId: "predecessor-request", timeStamp: NOW + 30 });
    await Promise.all(h.handling);
    expect(h.controller.getSnapshot()).toMatchObject({ protected: true, error: null });
    expect(h.controller.isSessionCurrentForProxyAuth(h.next)).toBe(true);
    expect(h.api.revoked).not.toContain(h.next.id);
  });

  it("treats an old wall-clock error date without observed departure as unknown", async () => {
    const h = await successor();
    h.fail({ requestId: "untracked-old-request", timeStamp: NOW + 1 });
    await Promise.all(h.handling);
    expect(h.controller.getSnapshot()).toMatchObject({
      protected: false,
      trafficBlocked: true,
      error: "proxy_unavailable",
    });
  });

  it("still invalidates the current session for a current native TLS failure", async () => {
    const h = await successor();
    h.onBeforeRequest.emit({ requestId: "successor-request", timeStamp: NOW + 25 });
    h.fail({ requestId: "successor-request", timeStamp: NOW + 30 });
    await Promise.all(h.handling);
    expect(h.controller.getSnapshot()).toMatchObject({
      protected: false,
      trafficBlocked: true,
      error: "proxy_unavailable",
    });
    expect(h.controller.isSessionCurrentForProxyAuth(h.next)).toBe(false);
  });

  it("keeps a current TLS failure conservative when its native dates contradict each other", async () => {
    const h = await successor();
    h.onBeforeRequest.emit({ requestId: "current-inconsistent-request", timeStamp: NOW + 25 });
    h.fail({ requestId: "current-inconsistent-request", timeStamp: NOW + 1 });
    await Promise.all(h.handling);
    expect(h.controller.getSnapshot()).toMatchObject({
      protected: false,
      trafficBlocked: true,
      error: "proxy_unavailable",
    });
  });

  it("does not hide a current TLS failure after the wall clock moves backwards", async () => {
    const h = await successor();
    h.setNow(NOW - 1000);
    vi.mocked(Date.now).mockReturnValue(NOW - 1000);
    h.onBeforeRequest.emit({ requestId: "current-clock-rollback", timeStamp: NOW - 1000 });
    h.fail({ requestId: "current-clock-rollback", timeStamp: NOW - 1000 });
    await Promise.all(h.handling);
    expect(h.controller.getSnapshot()).toMatchObject({
      protected: false,
      trafficBlocked: true,
      error: "proxy_unavailable",
    });
  });

  it.each([undefined, NOW + 30])(
    "handles unobserved departure conservatively when the error date is %s",
    async (timeStamp) => {
      const h = await successor();
      h.fail({ requestId: "untracked-request", timeStamp });
      await Promise.all(h.handling);
      expect(h.controller.getSnapshot()).toMatchObject({
        protected: false,
        trafficBlocked: true,
        error: "proxy_unavailable",
      });
    },
  );

  it.each(["https:", "wss:"])(
    "still fails closed for a current explicitly attributed proxy certificate error on %s",
    async (protocol) => {
      const h = await successor();
      h.onBeforeRequest.emit({ requestId: "successor-secure-request", timeStamp: NOW + 25 });
      h.fail({
        requestId: "successor-secure-request",
        timeStamp: NOW + 30,
        url: `${protocol}//destination.example/`,
        error: "NS_ERROR_PROXY_CERTIFICATE_INVALID",
      });
      await Promise.all(h.handling);
      expect(h.controller.getSnapshot()).toMatchObject({
        protected: false,
        trafficBlocked: true,
        error: "proxy_certificate_invalid",
      });
    },
  );
});
