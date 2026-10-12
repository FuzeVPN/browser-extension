// SPDX-License-Identifier: MPL-2.0

import { API_BASE_URL } from "../../core/shared/config";
import { normalizeSiteExclusion, type SiteExclusion } from "../../core/shared/site-exclusions";
import { requestUsesProxy } from "./proxy-controller";

import type { RouteGuardDependencies } from "../contracts/route-guard";
export type { RouteGuardState, RouteGuardDependencies } from "../contracts/route-guard";

/** Firefox exposes proxyInfo at runtime; its generated community typings omit it. */
export interface GuardedRequest {
  url: string;
  type: browser.webRequest.ResourceType;
  originUrl?: string;
  documentUrl?: string;
  proxyInfo?: unknown;
}

const API_ORIGIN = new URL(API_BASE_URL).origin;
const REQUEST_FILTER: browser.webRequest.RequestFilter = {
  urls: ["http://*/*", "https://*/*", "ws://*/*", "wss://*/*"],
};

/** Complements persistent DNR rules when a PAC fails or Firefox selects a direct route. */
export class PlatformRouteGuard {
  constructor(private readonly dependencies: RouteGuardDependencies) {}

  /** Called during background evaluation, before any awaited initialization. */
  register(): void {
    browser.webRequest.onBeforeRequest.addListener(
      (details) => this.decide(details, false),
      REQUEST_FILTER,
      ["blocking"],
    );
    browser.webRequest.onBeforeSendHeaders.addListener(
      (details) => this.decide(details, true),
      REQUEST_FILTER,
      ["blocking"],
    );
  }

  async decide(
    details: GuardedRequest,
    routeResolved: boolean,
  ): Promise<browser.webRequest.BlockingResponse> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const destination = new URL(details.url);
      if (!["http:", "https:", "ws:", "wss:"].includes(destination.protocol)) return {};
      // Origin equality alone treats every opaque moz-extension origin as "null" in
      // some URL implementations. Compare protocol and UUID hostname explicitly.
      if (isOwnApiRequest(details, destination, this.dependencies.extensionRoot())) return {};
      const state = await Promise.race([
        this.dependencies.readState(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("route_restore_timeout")),
            this.dependencies.restoreTimeoutMs ?? 10_000,
          );
        }),
      ]);
      if (!state.isCurrent()) return { cancel: true };
      if (state.mode === "off") return {};
      // A website must never receive the API's direct-route exception, including
      // navigation, images, fetches and redirects to the otherwise authorized API.
      if (destination.hostname.replace(/\.$/, "") === new URL(API_BASE_URL).hostname)
        return { cancel: true };
      if (isExcluded(destination.hostname, state.exclusions)) return {};
      if (state.mode === "block") return { cancel: true };
      // onBeforeRequest can precede proxy resolution. A reported wrong route is
      // rejected immediately; absent information MUST be checked at headers.
      if (!routeResolved && details.proxyInfo === undefined) return {};
      return requestUsesProxy(details.proxyInfo, state.endpoint) ? {} : { cancel: true };
    } catch {
      return { cancel: true };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}

function isOwnApiRequest(details: GuardedRequest, destination: URL, root: string): boolean {
  if (
    destination.origin !== API_ORIGIN ||
    destination.username ||
    destination.password ||
    details.type !== "xmlhttprequest" ||
    !details.originUrl
  )
    return false;
  const origin = new URL(details.originUrl);
  const extension = new URL(root);
  return (
    extension.protocol === "moz-extension:" &&
    origin.protocol === extension.protocol &&
    origin.hostname === extension.hostname &&
    !origin.username &&
    !origin.password &&
    !origin.port
  );
}

function isExcluded(hostname: string, exclusions: SiteExclusion[]): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  return exclusions.some((entry) => {
    // A corrupted or unvalidated read can never widen direct-route authorization.
    const normalized = normalizeSiteExclusion(entry.domain, entry.includeSubdomains);
    if (normalized.domain !== entry.domain) throw new Error("invalid_site_exclusions");
    return host === entry.domain || (entry.includeSubdomains && host.endsWith(`.${entry.domain}`));
  });
}
