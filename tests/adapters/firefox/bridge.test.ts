// SPDX-License-Identifier: MPL-2.0

import { inspectWebRtc, registerPlatformEvents } from "../../../src/platform/firefox/bridge";
import type { PlatformEventHandlers } from "../../../src/platform/contracts/extension-api";

const endpoint = { host: "proxy.example.com", port: 443 };

function event<T>() {
  let listener: ((details: T) => void) | undefined;
  return {
    addListener: vi.fn((value: (details: T) => void) => {
      listener = value;
    }),
    emit: (details: T) => listener?.(details),
  };
}

function fixture() {
  const onError = event<{ message: string }>();
  const onErrorOccurred = event<{ url: string; error: string; proxyInfo?: unknown }>();
  const privacy = {
    get: vi.fn(async () => ({
      value: "proxy_only",
      levelOfControl: "controlled_by_this_extension",
    })),
    onChange: event<unknown>(),
  };
  const permissions = { onRemoved: event<unknown>(), onAdded: event<unknown>() };
  const handlers: PlatformEventHandlers = {
    proxyChanged: vi.fn(),
    proxyError: vi.fn(),
    permissionsChanged: vi.fn(),
    diagnosticsConsentAdded: vi.fn(),
    diagnosticsConsentRemoved: vi.fn(),
    privacyChanged: vi.fn(),
  };
  vi.stubGlobal("browser", {
    proxy: { onError, settings: { onChange: event<unknown>() } },
    webRequest: { onErrorOccurred },
    permissions,
    privacy: { network: { webRTCIPHandlingPolicy: privacy, networkPredictionEnabled: privacy } },
  });
  registerPlatformEvents(handlers);
  const fail = (change: { url?: string; error?: string; proxyInfo?: unknown } = {}) =>
    onErrorOccurred.emit({
      url: "http://destination.example.com/",
      error: "Le certificat n’est pas sûr car il est auto-signé.",
      proxyInfo: { type: "https", ...endpoint },
      ...change,
    });
  return { handlers, fail, onError, privacy, permissions };
}

describe("Firefox permission changes", () => {
  afterEach(() => vi.unstubAllGlobals());

  it.each([
    ["a host permission", { origins: ["<all_urls>"] }],
    ["an API permission", { permissions: ["proxy"] }],
  ])("report %s which is granted, as one which is withdrawn", (_name, change) => {
    const f = fixture();
    f.permissions.onAdded.emit(change);
    expect(f.handlers.permissionsChanged).toHaveBeenCalledOnce();
    f.permissions.onRemoved.emit(change);
    expect(f.handlers.permissionsChanged).toHaveBeenCalledTimes(2);
  });

  it("report a diagnostics consent alone to the diagnostics only", () => {
    const f = fixture();
    f.permissions.onAdded.emit({ data_collection: ["technicalAndInteraction"] });
    f.permissions.onRemoved.emit({ data_collection: ["technicalAndInteraction"] });

    expect(f.handlers.diagnosticsConsentAdded).toHaveBeenCalledOnce();
    expect(f.handlers.diagnosticsConsentRemoved).toHaveBeenCalledOnce();
    // The connection has nothing to verify again: its permissions are what they were.
    expect(f.handlers.permissionsChanged).not.toHaveBeenCalled();
  });

  it("report a consent granted together with a host permission to both", () => {
    const f = fixture();
    f.permissions.onAdded.emit({
      data_collection: ["technicalAndInteraction"],
      origins: ["<all_urls>"],
    });

    expect(f.handlers.diagnosticsConsentAdded).toHaveBeenCalledOnce();
    expect(f.handlers.permissionsChanged).toHaveBeenCalledOnce();
  });
});

describe("Firefox native proxy error bridge", () => {
  afterEach(() => vi.unstubAllGlobals());

  it.each([
    "Le certificat n’est pas sûr car il est auto-signé.",
    "Peer’s Certificate has expired.",
    "证书已过期。",
    "SEC_ERROR_UNKNOWN_ISSUER",
    "SSL_ERROR_UNSUPPORTED_VERSION",
    "MOZILLA_PKIX_ERROR_SELF_SIGNED_CERT",
  ])("normalizes an NSS failure without forwarding its description: %s", (error) => {
    const f = fixture();
    f.fail({ error });
    expect(f.handlers.proxyError).toHaveBeenCalledExactlyOnceWith("proxy_tls_error", endpoint);
  });

  it("delivers native provenance synchronously before a session can be replaced", () => {
    const f = fixture();
    f.fail({
      proxyInfo: { type: "https", host: endpoint.host.toUpperCase(), port: endpoint.port },
    });
    expect(f.handlers.proxyError).toHaveBeenCalledExactlyOnceWith("proxy_tls_error", endpoint);
  });

  it("also recognizes a WS request whose only TLS peer is its HTTPS proxy", () => {
    const f = fixture();
    f.fail({ url: "ws://destination.example.com/socket" });
    expect(f.handlers.proxyError).toHaveBeenCalledExactlyOnceWith("proxy_tls_error", endpoint);
  });

  it.each(["https://destination.example.com/", "wss://destination.example.com/socket"])(
    "does not attribute the destination's TLS failure to the proxy: %s",
    (url) => {
      const f = fixture();
      f.fail({ url });
      expect(f.handlers.proxyError).not.toHaveBeenCalled();
    },
  );

  it.each([
    undefined,
    null,
    { type: "direct" },
    { type: "http", ...endpoint },
    { type: "socks", ...endpoint },
    { type: "https", host: endpoint.host, port: "443" },
    { type: "https", host: "unsafe; DIRECT", port: 443 },
  ])("does not infer proxy TLS failure without a valid native TLS route: %j", (proxyInfo) => {
    const f = fixture();
    f.fail({ proxyInfo });
    expect(f.handlers.proxyError).not.toHaveBeenCalled();
  });

  it.each(["NS_ERROR_NET_RESET", "NS_BINDING_ABORTED", "NS_ERROR_ABORT", "NS_ERROR_FAILURE", ""])(
    "leaves a generic destination or cancellation failure unclassified: %s",
    (error) => {
      const f = fixture();
      f.fail({ error });
      expect(f.handlers.proxyError).not.toHaveBeenCalled();
    },
  );

  it("keeps explicit proxy errors bound to their native route", () => {
    const f = fixture();
    f.fail({ url: "https://destination.example.com/", error: "NS_ERROR_PROXY_CONNECTION_REFUSED" });
    expect(f.handlers.proxyError).toHaveBeenCalledExactlyOnceWith(
      "NS_ERROR_PROXY_CONNECTION_REFUSED",
      endpoint,
    );
  });

  it("does not promote an explicit proxy certificate error without native provenance", () => {
    const f = fixture();
    f.fail({ error: "NS_ERROR_PROXY_CERTIFICATE_INVALID", proxyInfo: undefined });
    expect(f.handlers.proxyError).not.toHaveBeenCalled();
  });

  it("normalizes PAC errors instead of treating arbitrary PAC text as a certificate diagnosis", () => {
    const f = fixture();
    f.onError.emit({ message: "CERT secret from an unrelated PAC" });
    expect(f.handlers.proxyError).toHaveBeenCalledExactlyOnceWith("proxy_configuration_error");
  });

  it.each([
    ["proxy_only", "controlled_by_this_extension", true],
    ["disable_non_proxied_udp", "controlled_by_this_extension", false],
    ["proxy_only", "controlled_by_other_extensions", false],
  ])(
    "verifies Firefox WebRTC policy %s controlled as %s",
    async (value, levelOfControl, expected) => {
      const f = fixture();
      f.privacy.get.mockResolvedValue({ value, levelOfControl });
      await expect(inspectWebRtc()).resolves.toBe(expected);
    },
  );
});
