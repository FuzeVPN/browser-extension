// SPDX-License-Identifier: MPL-2.0

import { extensionApi, configureTrustedStorage } from "@platform/bridge";
import type {
  AuthSession,
  BillingSubscription,
  Location,
  Profile,
  ProxySession,
} from "../api/types";
import { normalizeSubscription } from "../shared/subscription";

const LOCAL_KEY = "fuzevpnState";
const SESSION_KEY = "fuzevpnProxySession";
const MAX_RETIRED_SESSION_RECORDS = 256;
const MAX_CLEANUP_SESSION_ID_LENGTH = 1_024;
const MAX_CLEANUP_EXPIRY_LENGTH = 64;

export interface PersistedState {
  auth: AuthSession | null;
  profile: Profile | null;
  subscription: BillingSubscription | null;
  selectedLocationId: string | null;
  autoConnect: boolean;
}

export interface TransientState {
  proxySession: ProxySession | null;
  activeLocation?: Location | null;
  refreshAttempts: number;
  refreshRetryAt?: number;
  retiredSessions: RetiredProxySession[];
  cleanupUncertain?: boolean;
}

export interface RetiredProxySession {
  sessionId: string;
  expiresAt: string;
}

export const EMPTY_PERSISTED_STATE: PersistedState = {
  auth: null,
  profile: null,
  subscription: null,
  selectedLocationId: null,
  autoConnect: false,
};

export const EMPTY_TRANSIENT_STATE: TransientState = {
  proxySession: null,
  activeLocation: null,
  refreshAttempts: 0,
  retiredSessions: [],
};

export interface StorageService {
  configureTrustedContexts(): Promise<void>;
  readPersisted(): Promise<PersistedState>;
  writePersisted(state: PersistedState): Promise<void>;
  clearPersisted(): Promise<void>;
  readTransient(): Promise<TransientState>;
  writeTransient(state: TransientState): Promise<void>;
  clearTransient(): Promise<void>;
}

export class ExtensionStorageService implements StorageService {
  configureTrustedContexts(): Promise<void> {
    return configureTrustedStorage();
  }

  async readPersisted(): Promise<PersistedState> {
    const result = await extensionApi.storage.local.get(LOCAL_KEY);
    return sanitizePersisted(result[LOCAL_KEY]);
  }

  async writePersisted(state: PersistedState): Promise<void> {
    await extensionApi.storage.local.set({ [LOCAL_KEY]: state });
  }

  async clearPersisted(): Promise<void> {
    await extensionApi.storage.local.remove(LOCAL_KEY);
  }

  async readTransient(): Promise<TransientState> {
    const result = await extensionApi.storage.session.get(SESSION_KEY);
    return sanitizeTransient(result[SESSION_KEY]);
  }

  async writeTransient(state: TransientState): Promise<void> {
    await extensionApi.storage.session.set({ [SESSION_KEY]: state });
  }

  async clearTransient(): Promise<void> {
    await extensionApi.storage.session.remove(SESSION_KEY);
  }
}

function sanitizePersisted(value: unknown): PersistedState {
  if (!isRecord(value)) return { ...EMPTY_PERSISTED_STATE };
  return {
    auth: isAuth(value.auth) ? value.auth : null,
    profile: isProfile(value.profile) ? value.profile : null,
    subscription: normalizeSubscription(value.subscription),
    selectedLocationId:
      typeof value.selectedLocationId === "string" ? value.selectedLocationId : null,
    autoConnect: value.autoConnect === true,
  };
}

function sanitizeTransient(value: unknown): TransientState {
  if (!isRecord(value))
    return {
      ...EMPTY_TRANSIENT_STATE,
      ...(value !== undefined && value !== null ? { cleanupUncertain: true } : {}),
    };
  const proxySession = isProxySession(value.proxySession) ? value.proxySession : null;
  const cleanup = sanitizeCleanupMetadata(value, proxySession !== null);
  return {
    proxySession,
    activeLocation:
      proxySession &&
      isLocation(value.activeLocation) &&
      value.activeLocation.id === proxySession.locationId
        ? {
            id: value.activeLocation.id,
            city: value.activeLocation.city,
            countryCode: value.activeLocation.countryCode,
            displayName: value.activeLocation.displayName,
            supportedProtocols: [...value.activeLocation.supportedProtocols],
          }
        : null,
    refreshAttempts:
      typeof value.refreshAttempts === "number" && Number.isSafeInteger(value.refreshAttempts)
        ? Math.max(0, value.refreshAttempts)
        : 0,
    ...(typeof value.refreshRetryAt === "number" &&
    Number.isSafeInteger(value.refreshRetryAt) &&
    value.refreshRetryAt > 0
      ? { refreshRetryAt: value.refreshRetryAt }
      : {}),
    retiredSessions: cleanup.retiredSessions,
    ...(cleanup.cleanupUncertain ? { cleanupUncertain: true } : {}),
  };
}

function isLocation(value: unknown): value is Location {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    value.id.length > 0 &&
    typeof value.city === "string" &&
    typeof value.countryCode === "string" &&
    /^[A-Za-z]{2}$/.test(value.countryCode) &&
    typeof value.displayName === "string" &&
    Array.isArray(value.supportedProtocols) &&
    value.supportedProtocols.every((protocol) => typeof protocol === "string")
  );
}

function sanitizeCleanupMetadata(
  value: Record<string, unknown>,
  hasUsableSession: boolean,
): Pick<TransientState, "retiredSessions" | "cleanupUncertain"> {
  const retained = new Map<string, RetiredProxySession>();
  let cleanupUncertain = value.cleanupUncertain === true;
  const retain = (candidate: unknown, idKey: "id" | "sessionId") => {
    if (!isRecord(candidate)) {
      cleanupUncertain = true;
      return;
    }
    const sessionId = candidate[idKey];
    const expiresAt = candidate.expiresAt;
    if (
      typeof sessionId !== "string" ||
      sessionId.trim().length === 0 ||
      sessionId.length > MAX_CLEANUP_SESSION_ID_LENGTH ||
      /\p{Cc}/u.test(sessionId) ||
      typeof expiresAt !== "string" ||
      expiresAt.length > MAX_CLEANUP_EXPIRY_LENGTH ||
      !Number.isFinite(Date.parse(expiresAt))
    ) {
      cleanupUncertain = true;
      return;
    }
    const previous = retained.get(sessionId);
    if (!previous && retained.size >= MAX_RETIRED_SESSION_RECORDS) {
      cleanupUncertain = true;
      return;
    }
    if (!previous || Date.parse(expiresAt) > Date.parse(previous.expiresAt))
      retained.set(sessionId, { sessionId, expiresAt });
  };
  // Refusing credentials must not discard their only usable revocation metadata.
  // Expiration is evaluated later with the controller's clock, never with issuedAt.
  if (!hasUsableSession && value.proxySession !== null && value.proxySession !== undefined)
    retain(value.proxySession, "id");
  if (Array.isArray(value.retiredSessions)) {
    if (value.retiredSessions.length > MAX_RETIRED_SESSION_RECORDS) cleanupUncertain = true;
    for (const session of value.retiredSessions.slice(0, MAX_RETIRED_SESSION_RECORDS))
      retain(session, "sessionId");
  } else if (value.retiredSessions !== null && value.retiredSessions !== undefined)
    cleanupUncertain = true;
  return { retiredSessions: [...retained.values()], cleanupUncertain };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isAuth(value: unknown): value is AuthSession {
  return (
    isRecord(value) &&
    typeof value.accessToken === "string" &&
    value.accessToken.trim().length > 0 &&
    typeof value.expiresAt === "string" &&
    Number.isFinite(Date.parse(value.expiresAt))
  );
}

function isProfile(value: unknown): value is Profile {
  return (
    isRecord(value) &&
    typeof value.userId === "string" &&
    typeof value.email === "string" &&
    typeof value.firstName === "string" &&
    typeof value.lastName === "string" &&
    typeof value.countryCode === "string"
  );
}

function isProxySession(value: unknown): value is ProxySession {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    value.id.trim().length > 0 &&
    typeof value.locationId === "string" &&
    value.locationId.trim().length > 0 &&
    value.scheme === "https" &&
    typeof value.host === "string" &&
    value.host.trim().length > 0 &&
    typeof value.port === "number" &&
    Number.isInteger(value.port) &&
    value.port >= 1 &&
    value.port <= 65_535 &&
    typeof value.username === "string" &&
    value.username.length > 0 &&
    typeof value.password === "string" &&
    value.password.length > 0 &&
    typeof value.issuedAt === "string" &&
    Number.isFinite(Date.parse(value.issuedAt)) &&
    typeof value.expiresAt === "string" &&
    Number.isFinite(Date.parse(value.expiresAt)) &&
    Date.parse(value.expiresAt) > Date.parse(value.issuedAt) &&
    typeof value.refreshAfterSeconds === "number" &&
    Number.isSafeInteger(value.refreshAfterSeconds) &&
    value.refreshAfterSeconds > 0
  );
}
