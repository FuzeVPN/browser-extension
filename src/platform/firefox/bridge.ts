// SPDX-License-Identifier: MPL-2.0

import type {
  ExtensionApi,
  PlatformEventHandlers,
  ProxyErrorProvenance,
} from "../contracts/extension-api";
import { requestUsesProxy } from "./proxy-controller";

export function hasExtensionApi(): boolean {
  return typeof browser !== "undefined";
}

/** Resolve the native API on access, including after a background restoration. */
export const extensionApi = new Proxy({} as ExtensionApi, {
  get(_target, property) {
    if (!hasExtensionApi()) throw new Error("extension_api_unavailable");
    return Reflect.get(browser, property) as unknown;
  },
});

export function configureTrustedStorage(): Promise<void> {
  // Firefox session storage is restricted to extension contexts. No content
  // scripts or injection permissions are shipped; audits enforce this boundary.
  return Promise.resolve();
}

export async function inspectWebRtc(): Promise<boolean> {
  const setting = await browser.privacy.network.webRTCIPHandlingPolicy.get({});
  return (
    setting.levelOfControl === "controlled_by_this_extension" && setting.value === "proxy_only"
  );
}

export function registerPlatformEvents(handlers: PlatformEventHandlers): void {
  // Only the native request-start event dates a request's departure. A redirect
  // leg keeps the requestId but resolves its own route, so date the latest leg:
  // an earlier leg never proves that the failing one is historical. Never keep a
  // URL or request body. Missing/expired evidence remains unknown so a current
  // proxy failure is still delivered.
  const lifecycle: Partial<Pick<typeof browser.webRequest, "onBeforeRequest" | "onCompleted">> =
    browser.webRequest;
  const requests = new Map<string, { startedAt: number; observedAt: number }>();
  const pruneRequests = (now: number) => {
    if (!Number.isFinite(now) || now < 0) {
      requests.clear();
      return;
    }
    for (const [requestId, request] of requests) {
      if (now - request.observedAt >= REQUEST_TRACKING_TTL_MS || now < request.observedAt)
        requests.delete(requestId);
    }
  };
  lifecycle.onBeforeRequest?.addListener(
    (details) => {
      const now = performance.now();
      pruneRequests(now);
      if (!Number.isFinite(now) || now < 0 || !validRequestId(details.requestId)) return;
      // A new leg replaces earlier evidence, even when its own date is unusable,
      // and becomes the newest entry for bounded eviction.
      requests.delete(details.requestId);
      if (!validNativeTime(details.timeStamp, Date.now())) return;
      if (requests.size >= MAX_TRACKED_REQUESTS) {
        const oldest = requests.keys().next().value;
        if (oldest !== undefined) requests.delete(oldest);
      }
      requests.set(details.requestId, { startedAt: details.timeStamp, observedAt: now });
    },
    { urls: ["<all_urls>"] },
  );
  lifecycle.onCompleted?.addListener((details) => requests.delete(details.requestId), {
    urls: ["<all_urls>"],
  });
  browser.proxy.settings.onChange.addListener(() => handlers.proxyChanged());
  browser.proxy.onError.addListener(() => handlers.proxyError("proxy_configuration_error"));
  browser.webRequest.onErrorOccurred.addListener(
    (details) => {
      const now = Date.now();
      pruneRequests(performance.now());
      const requestId = validRequestId(details.requestId) ? details.requestId : undefined;
      const request = requestId === undefined ? undefined : requests.get(requestId);
      if (requestId !== undefined) requests.delete(requestId);
      const provenance = tlsProxyEndpoint(
        (details as browser.webRequest._OnErrorOccurredDetails & { proxyInfo?: unknown }).proxyInfo,
      );
      if (provenance) {
        if (requestId !== undefined) provenance.requestId = requestId;
        const errorOccurredAt = validNativeTime(details.timeStamp, now)
          ? details.timeStamp
          : undefined;
        // Contradictory native dates cannot establish an old request or error.
        // Preserve conservative failure handling rather than hiding current TLS.
        if (!request || errorOccurredAt === undefined || request.startedAt <= errorOccurredAt) {
          if (errorOccurredAt !== undefined) provenance.errorOccurredAt = errorOccurredAt;
          if (request) {
            provenance.requestStartedAt = request.startedAt;
            provenance.requestObservedAt = request.observedAt;
          }
        }
      }
      if (provenance && /^(?:NS_ERROR_PROXY_|NS_ERROR_UNKNOWN_PROXY_HOST)/.test(details.error))
        handlers.proxyError(details.error, provenance);
      else if (provenance && isProxyTlsFailure(details.url, details.error))
        // Dispatch before any asynchronous lookup so the controller captures the
        // session which existed when this native error was delivered.
        handlers.proxyError("proxy_tls_error", provenance);
    },
    { urls: ["<all_urls>"] },
  );
  browser.permissions.onRemoved.addListener((removed) => {
    if (removed.data_collection?.includes("technicalAndInteraction"))
      handlers.diagnosticsConsentRemoved();
    if (removed.data_collection?.length && !removed.permissions?.length && !removed.origins?.length)
      return;
    handlers.permissionsChanged();
  });
  browser.permissions.onAdded.addListener((added) => {
    if (added.data_collection?.includes("technicalAndInteraction"))
      handlers.diagnosticsConsentAdded();
  });
  browser.privacy.network.webRTCIPHandlingPolicy.onChange.addListener(() =>
    handlers.privacyChanged(),
  );
  browser.privacy.network.networkPredictionEnabled.onChange.addListener(() =>
    handlers.privacyChanged(),
  );
}

const MAX_TRACKED_REQUESTS = 1024;
const REQUEST_TRACKING_TTL_MS = 5 * 60 * 1000;

function validRequestId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256;
}

function validNativeTime(value: unknown, now: number): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 && value <= now + 1000;
}

function tlsProxyEndpoint(proxyInfo: unknown): ProxyErrorProvenance | undefined {
  if (!proxyInfo || typeof proxyInfo !== "object") return undefined;
  const route = proxyInfo as Record<string, unknown>;
  if (typeof route.host !== "string" || typeof route.port !== "number") return undefined;
  const endpoint = { host: route.host.toLowerCase(), port: route.port };
  return requestUsesProxy(proxyInfo, endpoint) ? endpoint : undefined;
}

function isProxyTlsFailure(url: string, error: string): boolean {
  let protocol: string;
  try {
    protocol = new URL(url).protocol;
  } catch {
    return false;
  }
  // HTTPS/WSS has a second TLS peer: a certificate error there may belong to the
  // destination. HTTP/WS has only the HTTPS proxy's TLS connection to fail.
  if (protocol !== "http:" && protocol !== "ws:") return false;
  if (/^(?:SEC_ERROR_|SSL_ERROR_|MOZILLA_PKIX_ERROR_)/.test(error)) return true;
  // Firefox ChannelWrapper returns localized NSS descriptions, whereas generic
  // transport errors use symbolic names. Never match words such as "certificate"
  // in a particular language, or forward the potentially sensitive description.
  return error.length > 0 && !/^[A-Z][A-Z0-9_]*$/.test(error);
}
