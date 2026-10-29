// SPDX-License-Identifier: MPL-2.0

import { ApiError, type ApiService } from "../../../src/core/api/client";
import type {
  AuthSession,
  BillingSubscription,
  BrowserDeviceEnrollment,
  DeviceList,
  DeviceProof,
  ExtensionCodeExchange,
  Location,
  Profile,
  ProxySession,
} from "../../../src/core/api/types";
import type {
  DeviceIdentityService,
  DeviceRecoveryState,
} from "../../../src/core/device/device-identity";
import type {
  ProxyChallenger,
  ProxyControlLevel,
  ProxyService,
} from "../../../src/platform/chromium/proxy-controller";
import { ProxyControlError } from "../../../src/platform/chromium/proxy-controller";
import type { AlarmService } from "../../../src/core/background/session-refresh";
import { AppController } from "../../../src/core/background/state-machine";
import type { AppSnapshot } from "../../../src/core/shared/state";
import {
  DEFAULT_SECURITY_STATE,
  type SecurityState,
  type SecurityStatus,
} from "../../../src/core/shared/security";
import type { SecurityStorage } from "../../../src/core/storage/security-storage";
import type { NetworkSafetyService } from "../../../src/platform/chromium/network-safety";
import {
  EMPTY_PERSISTED_STATE,
  EMPTY_TRANSIENT_STATE,
  type PersistedState,
  type StorageService,
  type TransientState,
} from "../../../src/core/storage/storage";

export const NOW = Date.parse("2026-08-26T12:00:00Z");

export const AUTH: AuthSession = {
  accessToken: "api-access-token-for-tests",
  expiresAt: "2026-09-25T12:00:00Z",
};

export const PROFILE: Profile = {
  userId: "user-test",
  email: "client@example.com",
  firstName: "Martin",
  lastName: "Dupont",
  countryCode: "FR",
};

export const ACTIVE_SUBSCRIPTION: BillingSubscription = {
  status: "active",
  hasAccess: true,
  offerId: "monthly",
  startedAt: "2026-08-01T00:00:00Z",
  expiresAt: "2026-09-01T00:00:00Z",
  renewsAutomatically: true,
};

export const INACTIVE_SUBSCRIPTION: BillingSubscription = {
  status: "inactive",
  hasAccess: false,
  offerId: null,
  startedAt: null,
  expiresAt: null,
  renewsAutomatically: false,
};

export const LOCATIONS: Location[] = [
  {
    id: "frankfurt-01",
    city: "Frankfurt",
    countryCode: "DE",
    displayName: "Frankfurt 1",
    supportedProtocols: ["browser_proxy"],
  },
  {
    id: "frankfurt-02",
    city: "Frankfurt",
    countryCode: "DE",
    displayName: "Frankfurt 2",
    supportedProtocols: ["browser_proxy"],
  },
];

export function proxySession(
  id = "proxy-session-1",
  locationId = "frankfurt-01",
  issuedAt = "2026-08-26T12:00:00Z",
  expiresAt = "2026-08-26T12:10:00Z",
): ProxySession {
  return {
    id,
    locationId,
    scheme: "https",
    host: `${locationId}.proxy.vpn1euro.com`,
    port: 443,
    username: id,
    password: `temporary-password-${id}`,
    issuedAt,
    expiresAt,
    refreshAfterSeconds: 510,
  };
}

export class FakeApi implements ApiService {
  auth = AUTH;
  profile = PROFILE;
  subscription = ACTIVE_SUBSCRIPTION;
  locations = LOCATIONS;
  sessions: ProxySession[] = [proxySession()];
  createError: unknown = null;
  loginError: unknown = null;
  exchangedCodes: ExtensionCodeExchange[] = [];
  revoked: string[] = [];
  logoutCalls = 0;
  proofs: DeviceProof[] = [];
  enrollCalls = 0;
  enrollments: { token: string; name: string; publicKey: string }[] = [];
  deletedDevices: string[] = [];
  devices: DeviceList = { limit: 2, devices: [] };
  enrollError: unknown = null;
  replayProofOnce = false;
  createWait: Promise<void> | null = null;
  ignoreCreateAbort = false;

  async login(): Promise<AuthSession> {
    if (this.loginError) throw this.loginError;
    return this.auth;
  }

  async exchangeExtensionCode(exchange: ExtensionCodeExchange): Promise<AuthSession> {
    this.exchangedCodes.push({ ...exchange });
    if (this.loginError) throw this.loginError;
    return this.auth;
  }

  async getProfile(): Promise<Profile> {
    return this.profile;
  }

  async getSubscription(): Promise<BillingSubscription> {
    return this.subscription;
  }

  async getLocations(): Promise<Location[]> {
    return this.locations;
  }

  async createProxySession(
    _token: string,
    locationId: string,
    proof: DeviceProof,
    signal?: AbortSignal,
  ): Promise<ProxySession> {
    this.proofs.push(proof);
    if (this.replayProofOnce) {
      this.replayProofOnce = false;
      throw new ApiError("device_proof_replayed", 409);
    }
    if (this.createError) throw this.createError;
    const session = this.sessions.shift() ?? proxySession(`proxy-${locationId}`, locationId);
    const wait = this.createWait;
    if (wait) await wait;
    if (signal?.aborted && !this.ignoreCreateAbort) {
      throw new DOMException("Operation superseded", "AbortError");
    }
    return { ...session, locationId };
  }

  async enrollBrowserDevice(
    _token: string,
    _name: string,
    _publicKey: string,
    _signal?: AbortSignal,
  ): Promise<BrowserDeviceEnrollment> {
    if (_signal?.aborted) throw new DOMException("Operation superseded", "AbortError");
    this.enrollments.push({ token: _token, name: _name, publicKey: _publicKey });
    this.enrollCalls += 1;
    if (this.enrollError) throw this.enrollError;
    return {
      deviceId: "browser-device-1",
      name: "Chrome – Windows",
      kind: "browser_extension",
      createdAt: "2026-08-26T12:00:00Z",
    };
  }

  async getDevices(): Promise<DeviceList> {
    return structuredClone(this.devices);
  }

  async deleteDevice(_token: string, deviceId: string): Promise<void> {
    this.deletedDevices.push(deviceId);
    this.devices.devices = this.devices.devices.filter((device) => device.deviceId !== deviceId);
  }

  async revokeProxySession(_token: string, sessionId: string): Promise<void> {
    this.revoked.push(sessionId);
  }

  async resendVerification(): Promise<void> {}

  async logout(): Promise<void> {
    this.logoutCalls += 1;
  }
}

export class FakeIdentity implements DeviceIdentityService {
  deviceIds = new Map<string, string>();
  recoveries = new Map<string, DeviceRecoveryState>();
  legacyDeviceId: string | null = null;
  private generatedFor = new Set<string>();
  private keyVersions = new Map<string, number>();
  keyGenerations = 0;
  clearCalls = 0;
  proofCounter = 0;

  get deviceId(): string | null {
    return this.deviceIds.get(PROFILE.userId) ?? null;
  }

  set deviceId(value: string | null) {
    if (value === null) this.deviceIds.delete(PROFILE.userId);
    else this.deviceIds.set(PROFILE.userId, value);
  }

  async getDeviceId(userId: string): Promise<string | null> {
    return this.deviceIds.get(userId) ?? null;
  }

  async setDeviceId(userId: string, deviceId: string, expectedPublicKey?: string): Promise<void> {
    if (
      expectedPublicKey !== undefined &&
      (!this.generatedFor.has(userId) || this.publicKey(userId) !== expectedPublicKey)
    )
      throw new DOMException("Device identity changed", "AbortError");
    this.deviceIds.set(userId, deviceId);
  }

  async getRecovery(userId: string): Promise<DeviceRecoveryState> {
    return { ...(this.recoveries.get(userId) ?? { pending: false, exhausted: false }) };
  }

  async beginRecovery(userId: string, expectedDeviceId: string | null): Promise<boolean> {
    if (
      (this.deviceIds.get(userId) ?? null) !== expectedDeviceId ||
      this.recoveries.get(userId)?.pending
    )
      return false;
    this.deviceIds.delete(userId);
    this.generatedFor.delete(userId);
    this.generateFor(userId);
    this.recoveries.set(userId, { pending: true, exhausted: false });
    return true;
  }

  async markRecoveryExhausted(userId: string, expectedDeviceId?: string | null): Promise<void> {
    if (
      (expectedDeviceId !== undefined &&
        (this.deviceIds.get(userId) ?? null) !== expectedDeviceId) ||
      !this.recoveries.get(userId)?.pending
    )
      return;
    this.recoveries.set(userId, { pending: true, exhausted: true });
  }

  async allowRecoveryRetry(userId: string, expectedDeviceId?: string | null): Promise<void> {
    if (
      (expectedDeviceId !== undefined &&
        (this.deviceIds.get(userId) ?? null) !== expectedDeviceId) ||
      !this.recoveries.get(userId)?.exhausted
    )
      return;
    this.recoveries.delete(userId);
  }

  async completeRecovery(userId: string, expectedDeviceId: string): Promise<void> {
    if (this.deviceIds.get(userId) === expectedDeviceId) this.recoveries.delete(userId);
  }

  async getLegacyDeviceId(): Promise<string | null> {
    return this.legacyDeviceId;
  }

  async migrateLegacy(userId: string, expectedDeviceId: string): Promise<void> {
    if (this.legacyDeviceId !== expectedDeviceId) throw new Error("legacy_identity_changed");
    this.deviceIds.set(userId, expectedDeviceId);
    this.legacyDeviceId = null;
    this.generatedFor.add(userId);
  }

  async getPublicKeySpkiBase64(userId: string): Promise<string> {
    this.generateFor(userId);
    return this.publicKey(userId);
  }

  private generateFor(userId: string): void {
    if (!this.generatedFor.has(userId)) {
      this.generatedFor.add(userId);
      this.keyVersions.set(userId, (this.keyVersions.get(userId) ?? 0) + 1);
      this.keyGenerations += 1;
    }
  }

  private publicKey(userId: string): string {
    return `test-spki-public-key-${userId}-${String(this.keyVersions.get(userId) ?? 0)}`;
  }

  async createProof(
    _userId: string,
    deviceId: string,
    _locationId: string,
    now: number,
  ): Promise<DeviceProof> {
    this.proofCounter += 1;
    return {
      deviceId,
      deviceTimestamp: Math.floor(now / 1_000),
      deviceNonce: `nonce-${String(this.proofCounter)}`,
      deviceSignature: `signature-${String(this.proofCounter)}`,
    };
  }

  async clear(userId: string): Promise<void> {
    this.deviceIds.delete(userId);
    this.recoveries.delete(userId);
    this.generatedFor.delete(userId);
    this.clearCalls += 1;
  }
}

export class FakeStorage implements StorageService {
  persisted: PersistedState = { ...EMPTY_PERSISTED_STATE };
  transient: TransientState = { ...EMPTY_TRANSIENT_STATE };
  trustedConfigured = false;

  async configureTrustedContexts(): Promise<void> {
    this.trustedConfigured = true;
  }

  async readPersisted(): Promise<PersistedState> {
    return structuredClone(this.persisted);
  }

  async writePersisted(state: PersistedState): Promise<void> {
    this.persisted = structuredClone(state);
  }

  async clearPersisted(): Promise<void> {
    this.persisted = { ...EMPTY_PERSISTED_STATE };
  }

  async readTransient(): Promise<TransientState> {
    return structuredClone(this.transient);
  }

  async writeTransient(state: TransientState): Promise<void> {
    this.transient = structuredClone(state);
  }

  async clearTransient(): Promise<void> {
    this.transient = { ...EMPTY_TRANSIENT_STATE };
  }
}

export class FakeProxy implements ProxyService {
  exclusions: import("../../../src/core/shared/site-exclusions").SiteExclusion[] = [];
  activeExclusions: import("../../../src/core/shared/site-exclusions").SiteExclusion[] = [];
  exclusionWait: Promise<void> | null = null;
  rejectExclusions = false;
  configureExclusions(
    entries: import("../../../src/core/shared/site-exclusions").SiteExclusion[],
  ): void {
    this.exclusions = structuredClone(entries);
  }
  async updateExistingExclusions(): Promise<void> {
    if (!this.active && !this.blockingRoute) return;
    if (this.exclusionWait) await this.exclusionWait;
    if (this.rejectExclusions) throw new Error("exclusion_update_failed");
    this.activeExclusions = structuredClone(this.exclusions);
  }
  async isExclusionConfiguration(): Promise<boolean> {
    return (
      !this.active || JSON.stringify(this.activeExclusions) === JSON.stringify(this.exclusions)
    );
  }
  level: ProxyControlLevel = "controllable_by_this_extension";
  active: ProxySession | null = null;
  blockingRoute = false;
  ensureBlockingCalls = 0;
  clearCalls = 0;
  applyCalls = 0;
  applyWait: Promise<void> | null = null;
  rejectApply = false;

  async getControlLevel(): Promise<ProxyControlLevel> {
    return this.level;
  }

  async assertControllable(): Promise<void> {
    if (
      this.level !== "controllable_by_this_extension" &&
      this.level !== "controlled_by_this_extension"
    )
      throw new ProxyControlError(this.level);
  }

  async ensureBlockingConfiguration(): Promise<void> {
    this.ensureBlockingCalls += 1;
    await this.assertControllable();
    if (await this.isGuardedConfiguration()) return;
    this.active = null;
    this.blockingRoute = true;
    this.activeExclusions = structuredClone(this.exclusions);
    this.level = "controlled_by_this_extension";
  }

  async isGuardedConfiguration(): Promise<boolean> {
    return (
      this.level === "controlled_by_this_extension" &&
      (this.active !== null || this.blockingRoute) &&
      JSON.stringify(this.activeExclusions) === JSON.stringify(this.exclusions)
    );
  }

  async apply(session: ProxySession): Promise<void> {
    this.applyCalls += 1;
    await this.assertControllable();
    if (this.rejectApply) throw new ProxyControlError("configuration_rejected");
    const wait = this.applyWait;
    if (wait) await wait;
    this.active = session;
    this.blockingRoute = false;
    this.activeExclusions = structuredClone(this.exclusions);
    this.level = "controlled_by_this_extension";
  }

  async clear(): Promise<void> {
    this.active = null;
    this.blockingRoute = false;
    this.clearCalls += 1;
    if (this.level === "controlled_by_this_extension")
      this.level = "controllable_by_this_extension";
  }

  async isActiveConfiguration(session: ProxySession): Promise<boolean> {
    return this.active?.id === session.id && this.level === "controlled_by_this_extension";
  }

  async isConfiguredProxyChallenge(challenger: ProxyChallenger): Promise<boolean> {
    return (
      this.level === "controlled_by_this_extension" &&
      this.active?.host.toLowerCase() === challenger.host.toLowerCase() &&
      this.active.port === challenger.port
    );
  }
}

export class FakeAlarms implements AlarmService {
  session: ProxySession | null = null;
  retryAt: number | null = null;
  reconnectAt: number | null = null;
  clearCalls = 0;

  async scheduleSession(session: ProxySession, refreshAt?: number | null): Promise<void> {
    this.session = session;
    this.retryAt = refreshAt ?? null;
  }

  async scheduleRetry(when: number): Promise<void> {
    this.retryAt = when;
  }

  async clearRefresh(): Promise<void> {
    this.retryAt = null;
  }

  async clearAll(): Promise<void> {
    this.session = null;
    this.retryAt = null;
    this.clearCalls += 1;
    this.reconnectAt = null;
  }

  async scheduleReconnect(when: number): Promise<void> {
    this.reconnectAt = when;
  }
  async clearReconnect(): Promise<void> {
    this.reconnectAt = null;
  }
}

export class FakeSafety implements NetworkSafetyService {
  exclusionGuard: import("../../../src/core/shared/site-exclusions").SiteExclusion[] | null = null;
  async setExclusionGuard(
    entries: import("../../../src/core/shared/site-exclusions").SiteExclusion[] | null,
  ): Promise<void> {
    this.exclusionGuard = structuredClone(entries);
  }
  exclusions: import("../../../src/core/shared/site-exclusions").SiteExclusion[] = [];
  configureExclusions(
    entries: import("../../../src/core/shared/site-exclusions").SiteExclusion[],
  ): void {
    this.exclusions = structuredClone(entries);
  }
  status: SecurityStatus = { trafficBlocked: false, webRtcProtected: false, filterActive: false };
  events: string[] = [];
  async suspend(): Promise<void> {
    this.events.push("suspend");
  }
  async block(kill: boolean): Promise<void> {
    this.events.push("block");
    this.status.trafficBlocked = kill;
    this.status.filterActive = true;
  }
  async allow(): Promise<void> {
    this.events.push("allow");
    this.status.trafficBlocked = false;
  }
  async release(): Promise<void> {
    this.exclusionGuard = null;
    this.events.push("release");
    this.status.trafficBlocked = false;
    this.status.filterActive = false;
  }
  async setWebRtc(enabled: boolean): Promise<void> {
    this.events.push(`webrtc:${String(enabled)}`);
    this.status.webRtcProtected = enabled;
  }
  async inspect(): Promise<SecurityStatus> {
    return {
      ...structuredClone(this.status),
      blockingScope: this.status.trafficBlocked
        ? this.exclusions.length
          ? "except_excluded"
          : "all"
        : "none",
    };
  }
}

export class FakeSecurityStorage implements SecurityStorage {
  state: SecurityState | null = null;
  async read(
    legacyAutoConnect: boolean,
    selectedLocationId: string | null,
  ): Promise<SecurityState> {
    this.state ??= {
      ...DEFAULT_SECURITY_STATE,
      protectionRequested: legacyAutoConnect,
      selectedLocationId,
    };
    return structuredClone(this.state);
  }
  async write(state: SecurityState): Promise<void> {
    this.state = structuredClone(state);
  }
}

export function createHarness(options?: {
  webAuth?: import("../../../src/core/auth/web-auth").WebAuthService;
  remoteCleanupTimeoutMs?: number;
  persisted?: PersistedState;
  transient?: TransientState;
  activeProxy?: ProxySession;
  security?: SecurityState;
  siteExclusionStorage?: import("../../../src/core/storage/site-exclusion-storage").SiteExclusionStorage;
  cleanupStorage?: import("../../../src/core/storage/proxy-cleanup-storage").ProxyCleanupStorage;
}) {
  const api = new FakeApi();
  const storage = new FakeStorage();
  const proxy = new FakeProxy();
  const alarms = new FakeAlarms();
  const identity = new FakeIdentity();
  const safety = new FakeSafety();
  const securityStorage = new FakeSecurityStorage();
  if (options?.security) securityStorage.state = structuredClone(options.security);
  let now = NOW;
  const snapshots: AppSnapshot[] = [];
  if (options?.persisted) storage.persisted = structuredClone(options.persisted);
  if (options?.transient) storage.transient = structuredClone(options.transient);
  if (options?.activeProxy) {
    proxy.active = options.activeProxy;
    proxy.level = "controlled_by_this_extension";
  }
  const controller = new AppController({
    webAuth: options?.webAuth,
    api,
    storage,
    identity,
    proxy,
    alarms,
    safety,
    securityStorage,
    siteExclusionStorage: options?.siteExclusionStorage,
    cleanupStorage: options?.cleanupStorage,
    now: () => now,
    remoteCleanupTimeoutMs: options?.remoteCleanupTimeoutMs ?? 250,
    onStateChanged: (snapshot) => snapshots.push(snapshot),
  });
  return {
    api,
    storage,
    proxy,
    alarms,
    safety,
    securityStorage,
    identity,
    controller,
    snapshots,
    setNow(value: number) {
      now = value;
    },
  };
}

export function authenticatedState(overrides?: Partial<PersistedState>): PersistedState {
  return {
    auth: AUTH,
    profile: PROFILE,
    subscription: ACTIVE_SUBSCRIPTION,
    selectedLocationId: "frankfurt-01",
    autoConnect: false,
    ...overrides,
  };
}

export const UNAUTHORIZED = new ApiError("unauthorized", 401);
