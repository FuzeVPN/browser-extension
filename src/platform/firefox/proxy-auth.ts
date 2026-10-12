// SPDX-License-Identifier: MPL-2.0

import type { ProxySession } from "../../core/api/types";
import { PROXY_AUTH_RESTORE_TIMEOUT_MS, PROXY_EXPIRY_MARGIN_MS } from "../../core/shared/config";
import {
  protectedBrowserContexts,
  readProxyConfiguration,
  requestUsesProxy,
  type ProxyChallenger,
} from "./proxy-controller";

export type ProxyAuthDetails = browser.webRequest._OnAuthRequiredDetails & { proxyInfo?: unknown };

const MAX_TRACKED_REQUESTS = 4_096;
const REQUEST_PROVENANCE_MS = 5 * 60_000;

type RequestRoutes = ReadonlyMap<boolean, ProxyChallenger | null | undefined>;

interface StartedRequest {
  startedAt: number;
  tabId: number;
  routeGeneration: number;
  routes: Promise<RequestRoutes>;
  incognito?: boolean;
  actualRoute?: unknown;
}

export type { ProxyAuthDependencies } from "../contracts/proxy-auth";
import type { ProxyAuthDependencies } from "../contracts/proxy-auth";

export class ProxyAuthHandler {
  private readonly attemptedSessionsByRequest = new Map<string, string>();
  private readonly startedRequests = new Map<string, StartedRequest>();
  private requestRoutes: Promise<RequestRoutes> = Promise.resolve(new Map());
  private requestRouteGeneration = 0;
  private reportedFailureSessionId: string | null = null;
  private readonly credentialResponses = new WeakMap<
    browser.webRequest.BlockingResponse,
    ProxySession
  >();

  constructor(private readonly dependencies: ProxyAuthDependencies) {}

  register(): void {
    // Capture a route generation at request start, not its URL. A historic endpoint
    // alone cannot distinguish a late FuzeVPN 407 from a new request using another
    // extension's proxy. Reads are shared until Firefox reports a setting change.
    this.requestRoutes = readRequestRoutes();
    browser.proxy.settings.onChange.addListener(() => {
      this.requestRouteGeneration++;
      this.requestRoutes = readRequestRoutes();
    });
    browser.webRequest.onBeforeRequest.addListener(
      (details) => {
        this.rememberRequest(
          details.requestId,
          details.tabId,
          details.incognito,
          (details as { proxyInfo?: unknown }).proxyInfo,
        );
        return undefined;
      },
      { urls: ["<all_urls>"] },
    );
    browser.webRequest.onAuthRequired.addListener(
      (details, callback) => {
        if (!callback) return {};
        void this.handle(details)
          .then((response) => {
            const session = this.credentialResponses.get(response);
            // Disconnect can also run between handle() resolving and this callback.
            callback(session && !this.canSendCredentials(session) ? { cancel: true } : response);
          })
          .catch(() => callback({}));
        return undefined;
      },
      { urls: ["<all_urls>"] },
      ["asyncBlocking"],
    );
    browser.webRequest.onCompleted.addListener((details) => this.cleanup(details.requestId), {
      urls: ["<all_urls>"],
    });
    browser.webRequest.onErrorOccurred.addListener((details) => this.cleanup(details.requestId), {
      urls: ["<all_urls>"],
    });
  }

  async handle(details: ProxyAuthDetails): Promise<browser.webRequest.BlockingResponse> {
    if (!details.isProxy) return {};
    // Capture ownership before waiting for startup restoration. The recovery
    // path may clear the stale proxy before it reports that no credentials are
    // available, but Firefox must still not display a login prompt for it.
    const configuredByFuzeVpn = await this.dependencies
      .isConfiguredProxyChallenge(details.challenger)
      .catch(() => false);
    if (!configuredByFuzeVpn) {
      if (this.attemptedSessionsByRequest.has(details.requestId)) return { cancel: true };
      const usedByFuzeVpn = await this.dependencies
        .wasUsedProxyChallenge(details.challenger)
        .catch(() => false);
      if (!usedByFuzeVpn) return {};
      const started = this.startedRequests.get(details.requestId);
      if (
        started?.routeGeneration === this.requestRouteGeneration &&
        this.dependencies.now() - started.startedAt < REQUEST_PROVENANCE_MS
      ) {
        // A pending route read can observe settings newer than the request. A
        // setting change also invalidates evidence while the tab scope is read.
        if (
          (await startedOnDifferentRoute(started, details.challenger)) &&
          started.routeGeneration === this.requestRouteGeneration
        )
          return {};
      }
      // Requests already in flight when a worker starts have no onBeforeRequest
      // record. Preserve cancel-only recovery for those potentially late 407s.
      return { cancel: true };
    }
    // Firefox exposes the effective proxy on authentication events, including system requests.
    // Never disclose credentials solely because the configured PAC mentions the same endpoint.
    if (!requestUsesProxy(details.proxyInfo, details.challenger)) return { cancel: true };
    const session = await withTimeout(
      this.dependencies.getSession(),
      this.dependencies.restoreTimeoutMs ?? PROXY_AUTH_RESTORE_TIMEOUT_MS,
    ).catch(() => null);
    if (!session || !this.canSendCredentials(session)) return { cancel: true };
    if (!challengerMatches(details.challenger, session)) return { cancel: true };
    if (
      !(await this.dependencies.isConfiguredProxyChallenge(details.challenger).catch(() => false))
    )
      return { cancel: true };
    // The final ownership read is asynchronous: never emit credentials captured
    // before a disconnect, expiration or session replacement during that read.
    if (!this.canSendCredentials(session)) return { cancel: true };
    if (this.attemptedSessionsByRequest.get(details.requestId) === session.id) {
      this.reportAuthenticationFailure(session);
      return { cancel: true };
    }
    this.attemptedSessionsByRequest.set(details.requestId, session.id);
    const response = {
      authCredentials: { username: session.username, password: session.password },
    };
    this.credentialResponses.set(response, session);
    return response;
  }

  cleanup(requestId: string): void {
    this.attemptedSessionsByRequest.delete(requestId);
    this.startedRequests.delete(requestId);
  }

  private rememberRequest(
    requestId: string,
    tabId: number,
    incognito?: boolean,
    actualRoute?: unknown,
  ): void {
    // Redirects retain their request ID and original provenance. Bound abandoned
    // requests as well as relying on onCompleted/onErrorOccurred for cleanup.
    if (this.startedRequests.has(requestId)) return;
    const now = this.dependencies.now();
    for (const [id, request] of this.startedRequests) {
      if (
        this.startedRequests.size < MAX_TRACKED_REQUESTS &&
        now - request.startedAt < REQUEST_PROVENANCE_MS
      )
        break;
      this.startedRequests.delete(id);
    }
    this.startedRequests.set(requestId, {
      startedAt: now,
      tabId,
      routeGeneration: this.requestRouteGeneration,
      routes: this.requestRoutes,
      ...(incognito === undefined ? {} : { incognito }),
      ...(actualRoute === undefined ? {} : { actualRoute }),
    });
  }

  private reportAuthenticationFailure(session: ProxySession): void {
    if (
      !this.dependencies.onAuthenticationFailure ||
      this.reportedFailureSessionId === session.id
    ) {
      return;
    }
    this.reportedFailureSessionId = session.id;
    // Cancel the challenged request independently of any storage/network work in
    // recovery. Concurrent rejected requests report this session only once.
    void Promise.resolve()
      .then(async () => {
        if (!this.canSendCredentials(session)) return false;
        const owned = await this.dependencies
          .isConfiguredProxyChallenge(session)
          .catch(() => false);
        if (!owned || !this.canSendCredentials(session)) return false;
        await this.dependencies.onAuthenticationFailure?.(session);
        return true;
      })
      .then((reported) => {
        if (!reported && this.reportedFailureSessionId === session.id)
          this.reportedFailureSessionId = null;
      })
      .catch(() => {
        if (this.reportedFailureSessionId === session.id) this.reportedFailureSessionId = null;
        // Do not log the rejected error: it could contain proxy credentials.
        console.warn("FuzeVPN: proxy authentication recovery failed.");
      });
  }

  private canSendCredentials(session: ProxySession): boolean {
    const expires = Date.parse(session.expiresAt);
    return (
      Number.isFinite(expires) &&
      expires > this.dependencies.now() + PROXY_EXPIRY_MARGIN_MS &&
      this.dependencies.isSessionCurrent(session)
    );
  }
}

async function startedOnDifferentRoute(
  started: StartedRequest,
  challenger: ProxyChallenger,
): Promise<boolean> {
  const routes = await started.routes;
  const isDifferent = (route: ProxyChallenger | null | undefined): boolean =>
    route === null || (route !== undefined && !sameEndpoint(route, challenger));
  if (started.actualRoute !== undefined && !requestUsesProxy(started.actualRoute, challenger))
    return true;
  if (routes.size === 1 && routes.has(false)) return isDifferent(routes.get(false));
  if (!routes.has(false) || !routes.has(true)) return false;
  const regular = isDifferent(routes.get(false));
  const privateWindow = isDifferent(routes.get(true));
  if (regular === privateWindow) return regular;
  if (started.incognito !== undefined) return started.incognito ? privateWindow : regular;
  // Retain conservative provenance for events which do not include private scope.
  if (started.tabId < 0) return false;
  try {
    const tab = await browser.tabs.get(started.tabId);
    return typeof tab.incognito === "boolean" && (tab.incognito ? privateWindow : regular);
  } catch {
    return false;
  }
}

async function readRequestRoutes(): Promise<RequestRoutes> {
  const contexts = await protectedBrowserContexts().catch(() => []);
  const routes = new Map<boolean, ProxyChallenger | null | undefined>();
  for (const incognito of contexts) routes.set(incognito, undefined);
  if (contexts.length === 0) return routes;
  try {
    // Firefox controls one global setting for both kinds of window. Asking for
    // incognito:true returns not_controllable and must not imply foreign ownership.
    const setting = await browser.proxy.settings.get({});
    const configuration = readProxyConfiguration(setting.value);
    const route =
      setting.levelOfControl !== "controlled_by_this_extension" ? null : configuration?.endpoint;
    for (const incognito of contexts) routes.set(incognito, route);
  } catch {
    // Unknown global settings are never evidence of foreign ownership.
  }
  return routes;
}

function sameEndpoint(left: ProxyChallenger, right: ProxyChallenger): boolean {
  return left.host.toLowerCase() === right.host.toLowerCase() && left.port === right.port;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("proxy_auth_restore_timeout")), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export function challengerMatches(
  challenger: browser.webRequest._OnAuthRequiredDetails["challenger"],
  session: ProxySession,
): boolean {
  return (
    challenger.host.toLowerCase() === session.host.toLowerCase() && challenger.port === session.port
  );
}
