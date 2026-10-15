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
import { selectedLocationMetadata } from "../shared/location-metadata";

const LOCAL_KEY = "fuzevpnState";
const SESSION_KEY = "fuzevpnProxySession";

export interface PersistedState {
  auth: AuthSession | null;
  profile: Profile | null;
  subscription: BillingSubscription | null;
  selectedLocationId: string | null;
  selectedLocation?: Location | null;
  autoConnect: boolean;
}

export interface TransientState {
  proxySession: ProxySession | null;
  activeLocation?: Location | null;
  refreshAttempts: number;
  refreshRetryAt?: number;
  retiredSessions: RetiredProxySession[];
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
  selectedLocation: null,
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
    selectedLocation:
      isAuth(value.auth) && isProfile(value.profile)
        ? selectedLocationMetadata(
            value.selectedLocation,
            typeof value.selectedLocationId === "string" ? value.selectedLocationId : null,
          )
        : null,
    autoConnect: value.autoConnect === true,
  };
}

function sanitizeTransient(value: unknown): TransientState {
  if (!isRecord(value)) return { ...EMPTY_TRANSIENT_STATE };
  const proxySession = isProxySession(value.proxySession) ? value.proxySession : null;
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
      typeof value.refreshAttempts === "number" && Number.isInteger(value.refreshAttempts)
        ? Math.max(0, value.refreshAttempts)
        : 0,
    ...(typeof value.refreshRetryAt === "number" &&
    Number.isSafeInteger(value.refreshRetryAt) &&
    value.refreshRetryAt > 0
      ? { refreshRetryAt: value.refreshRetryAt }
      : {}),
    retiredSessions: Array.isArray(value.retiredSessions)
      ? value.retiredSessions.filter(isRetiredProxySession)
      : [],
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

function isRetiredProxySession(value: unknown): value is RetiredProxySession {
  return (
    isRecord(value) &&
    typeof value.sessionId === "string" &&
    value.sessionId.length > 0 &&
    typeof value.expiresAt === "string" &&
    Number.isFinite(Date.parse(value.expiresAt))
  );
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
    typeof value.locationId === "string" &&
    value.scheme === "https" &&
    typeof value.host === "string" &&
    typeof value.port === "number" &&
    typeof value.username === "string" &&
    typeof value.password === "string" &&
    typeof value.issuedAt === "string" &&
    typeof value.expiresAt === "string" &&
    typeof value.refreshAfterSeconds === "number" &&
    Number.isFinite(Date.parse(value.expiresAt))
  );
}
