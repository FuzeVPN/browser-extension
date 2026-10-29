// SPDX-License-Identifier: MPL-2.0

import type { ProxySession } from "../../core/api/types";
import { PROXY_AUTH_RESTORE_TIMEOUT_MS, PROXY_EXPIRY_MARGIN_MS } from "../../core/shared/config";
import { protectedBrowserContexts, type ProxyChallenger } from "./proxy-controller";

const MAX_TRACKED_REQUESTS = 4_096;
const REQUEST_PROVENANCE_MS = 5 * 60_000;
const REQUEST_ROUTE_RETRY_MS = 1_000;

type RequestRoutes = ReadonlyMap<boolean, ProxyChallenger | null | undefined>;

interface StartedRequest {
  requestId: string;
  startedAt: number;
  tabId: number;
  routeGeneration: number;
  routes: Promise<RequestRoutes>;
  verifiedRoutes: RequestRoutes | null;
}

import type { ProxyAuthDependencies } from "../contracts/proxy-auth";
export type { ProxyAuthDependencies } from "../contracts/proxy-auth";

export class ProxyAuthHandler {
  private readonly attemptedSessionsByRequest = new Map<string, string>();
  private readonly startedRequests = new Map<string, StartedRequest>();
  private requestRoutes: Promise<RequestRoutes> = Promise.resolve(new Map());
  private verifiedRequestRoutes: RequestRoutes | null = null;
  private requestRouteGeneration = 0;
  private pendingRequestRouteRead: Promise<RequestRoutes> | null = null;
  private requestRoutesNeedRecovery = false;
  private nextRequestRouteReadAt = 0;
  private reportedFailureSessionId: string | null = null;
  private readonly credentialResponses = new WeakMap<
    chrome.webRequest.BlockingResponse,
    { session: ProxySession; request: StartedRequest }
  >();

  constructor(private readonly dependencies: ProxyAuthDependencies) {}

  register(): void {
    // Capture a route generation at request start, not its URL. A historic endpoint
    // alone cannot distinguish a late FuzeVPN 407 from a new request using another
    // extension's proxy. Reads are shared until Chrome reports a setting change.
    this.refreshRequestRoutes();
    chrome.proxy.settings.onChange.addListener(() => {
      this.requestRouteGeneration++;
      this.refreshRequestRoutes();
    });
    chrome.webRequest.onBeforeRequest.addListener(
      (details) => {
        this.rememberRequest(details.requestId, details.tabId);
        return undefined;
      },
      { urls: ["<all_urls>"] },
    );
    chrome.webRequest.onAuthRequired.addListener(
      (details, callback) => {
        if (!callback) return {};
        void this.handle(details)
          .then((response) => {
            const credentials = this.credentialResponses.get(response);
            // Disconnect can also run between handle() resolving and this callback.
            callback(
              credentials &&
                (!this.canSendCredentials(credentials.session) ||
                  !this.isRequestProvenanceCurrent(credentials.request))
                ? { cancel: true }
                : response,
            );
          })
          .catch(() => callback({}));
        return undefined;
      },
      { urls: ["<all_urls>"] },
      ["asyncBlocking"],
    );
    chrome.webRequest.onCompleted.addListener((details) => this.cleanup(details.requestId), {
      urls: ["<all_urls>"],
    });
    chrome.webRequest.onErrorOccurred.addListener((details) => this.cleanup(details.requestId), {
      urls: ["<all_urls>"],
    });
  }

  async handle(
    details: chrome.webRequest.OnAuthRequiredDetails,
  ): Promise<chrome.webRequest.BlockingResponse> {
    if (!details.isProxy) return {};
    // Capture ownership before waiting for startup restoration. The recovery
    // path may clear the stale proxy before it reports that no credentials are
    // available, but Chrome must still not display a login prompt for it.
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
      if (this.isRequestProvenanceCurrent(started)) {
        // A pending route read can observe settings newer than the request. A
        // setting change also invalidates evidence while the tab scope is read.
        if (
          (await startedOnDifferentRoute(started, details.challenger)) &&
          this.isRequestProvenanceCurrent(started)
        )
          return {};
      }
      // Requests already in flight when a worker starts have no onBeforeRequest
      // record. Preserve cancel-only recovery for those potentially late 407s.
      return { cancel: true };
    }
    const started = this.startedRequests.get(details.requestId);
    // Current proxy settings cannot establish how an already pending request
    // reached its challenger. In particular, taking over an HTTP proxy with HTTPS
    // at the same endpoint must not release credentials on its old cleartext TCP
    // connection. Only a settled TLS route observed before request start is proof.
    if (
      !this.isRequestProvenanceCurrent(started) ||
      !(await startedOnVerifiedRoute(started, details.challenger)) ||
      !this.isRequestProvenanceCurrent(started)
    )
      return { cancel: true };
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
    if (!this.canSendCredentials(session) || !this.isRequestProvenanceCurrent(started))
      return { cancel: true };
    if (this.attemptedSessionsByRequest.get(details.requestId) === session.id) {
      this.reportAuthenticationFailure(session);
      return { cancel: true };
    }
    this.attemptedSessionsByRequest.set(details.requestId, session.id);
    const response = {
      authCredentials: { username: session.username, password: session.password },
    };
    this.credentialResponses.set(response, { session, request: started });
    return response;
  }

  cleanup(requestId: string): void {
    this.attemptedSessionsByRequest.delete(requestId);
    this.startedRequests.delete(requestId);
  }

  private refreshRequestRoutes(invalidate = true): void {
    const generation = this.requestRouteGeneration;
    // A pending read may observe a configuration installed after onBeforeRequest.
    // Never attach its eventual result to requests that have already started.
    if (invalidate) this.verifiedRequestRoutes = null;
    this.requestRoutesNeedRecovery = false;
    this.nextRequestRouteReadAt = this.dependencies.now() + REQUEST_ROUTE_RETRY_MS;
    const pending = readRequestRoutes();
    this.requestRoutes = pending;
    this.pendingRequestRouteRead = pending;
    void pending
      .then((routes) => {
        if (generation !== this.requestRouteGeneration || this.requestRoutes !== pending) return;
        this.verifiedRequestRoutes = routes;
        this.requestRoutesNeedRecovery =
          routes.size === 0 || [...routes.values()].some((route) => route === undefined);
      })
      .catch(() => {
        if (generation === this.requestRouteGeneration && this.requestRoutes === pending)
          this.requestRoutesNeedRecovery = true;
      })
      .finally(() => {
        if (this.pendingRequestRouteRead === pending) this.pendingRequestRouteRead = null;
      });
  }

  private isRequestProvenanceCurrent(
    started: StartedRequest | undefined,
  ): started is StartedRequest {
    if (started?.routeGeneration !== this.requestRouteGeneration) return false;
    // Terminal cleanup and eviction revoke a record that pending reads still hold.
    if (this.startedRequests.get(started.requestId) !== started) return false;
    const age = this.dependencies.now() - started.startedAt;
    return age >= 0 && age < REQUEST_PROVENANCE_MS;
  }

  private rememberRequest(requestId: string, tabId: number): void {
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
      // Attempts are recorded only under registered provenance: evict both.
      this.cleanup(id);
    }
    this.startedRequests.set(requestId, {
      requestId,
      startedAt: now,
      tabId,
      routeGeneration: this.requestRouteGeneration,
      routes: this.requestRoutes,
      verifiedRoutes: this.verifiedRequestRoutes,
    });
    // The triggering request keeps its original evidence. Retry unknown scopes
    // only for later requests, with one shared read and no autonomous retry loop.
    if (
      this.requestRoutesNeedRecovery &&
      !this.pendingRequestRouteRead &&
      now >= this.nextRequestRouteReadAt
    )
      this.refreshRequestRoutes(false);
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
  return startedRouteSatisfies(
    started,
    (route) => route === null || (route !== undefined && !sameEndpoint(route, challenger)),
  );
}

async function startedOnVerifiedRoute(
  started: StartedRequest,
  challenger: ProxyChallenger,
): Promise<boolean> {
  return startedRouteSatisfies(
    started,
    (route) => route !== null && route !== undefined && sameEndpoint(route, challenger),
    true,
  );
}

async function startedRouteSatisfies(
  started: StartedRequest,
  satisfies: (route: ProxyChallenger | null | undefined) => boolean,
  verifiedOnly = false,
): Promise<boolean> {
  const routes = verifiedOnly ? started.verifiedRoutes : await started.routes;
  if (!routes) return false;
  if (routes.size === 1 && routes.has(false)) return satisfies(routes.get(false));
  if (!routes.has(false) || !routes.has(true)) return false;
  const regular = satisfies(routes.get(false));
  const privateWindow = satisfies(routes.get(true));
  if (regular === privateWindow) return regular;
  // webRequest has no incognito field. Only a mixed-scope challenge needs the
  // tab's basic incognito flag; no URL/title or additional permission is needed.
  if (started.tabId < 0) return false;
  try {
    const tab = await chrome.tabs.get(started.tabId);
    return typeof tab.incognito === "boolean" && (tab.incognito ? privateWindow : regular);
  } catch {
    return false;
  }
}

async function readRequestRoutes(): Promise<RequestRoutes> {
  const contexts = await protectedBrowserContexts().catch(() => []);
  const routes = new Map<boolean, ProxyChallenger | null | undefined>();
  await Promise.all(
    contexts.map(async (incognito) => {
      routes.set(incognito, undefined);
      try {
        const setting = await chrome.proxy.settings.get({ incognito });
        const proxy = setting.value.rules?.singleProxy;
        if (setting.levelOfControl !== "controlled_by_this_extension") {
          routes.set(incognito, null);
        } else if (
          setting.value.mode === "fixed_servers" &&
          proxy?.scheme === "https" &&
          typeof proxy.host === "string" &&
          proxy.host.length > 0 &&
          typeof proxy.port === "number" &&
          Number.isInteger(proxy.port) &&
          proxy.port > 0 &&
          proxy.port <= 65535
        ) {
          routes.set(incognito, { host: proxy.host, port: proxy.port });
        }
      } catch {
        // Undefined scope means unknown, never evidence of foreign ownership.
      }
    }),
  );
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
  challenger: chrome.webRequest.OnAuthRequiredDetails["challenger"],
  session: ProxySession,
): boolean {
  return (
    challenger.host.toLowerCase() === session.host.toLowerCase() && challenger.port === session.port
  );
}
