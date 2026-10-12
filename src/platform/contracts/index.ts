// SPDX-License-Identifier: MPL-2.0

export type {
  ExtensionApi,
  ExtensionEvent,
  StorageArea,
  PlatformEventHandlers,
} from "./extension-api";
export type { BrowserEnvironment, BrowserName } from "./environment";
export type { WebAuthIdentity } from "./web-auth";
export type { ProxyService, ProxyChallenger, ProxyControlLevel } from "./proxy";
export type { ProxyAuthDependencies } from "./proxy-auth";
export type { NetworkSafetyService } from "./network-safety";
export type { RouteGuardDependencies, RouteGuardState } from "./route-guard";
export type { StorageService } from "../../core/storage/storage";
export type { AlarmService } from "../../core/background/session-refresh";
export type { WebAuthService, WebAuthorization } from "../../core/auth/web-auth";
