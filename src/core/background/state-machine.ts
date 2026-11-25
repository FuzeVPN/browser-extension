// SPDX-License-Identifier: MPL-2.0

import {
  ApiError,
  NetworkError,
  ProxyCreationUncertainError,
  isDefinitiveProxyCreationRejection,
  type ApiService,
} from "../api/client";
import type { AdBlockingChoice, AuthSession, Device, Location, ProxySession } from "../api/types";
import { WebAuthError, type WebAuthorization, type WebAuthService } from "../auth/web-auth";
import {
  ALARM_EXPIRY,
  ALARM_REFRESH,
  ACCOUNT_REFRESH_INTERVAL_MS,
  ALARM_RECONNECT,
  API_TIMEOUT_MS,
  EXPIRY_RECONNECT_DELAY_MS,
  MAX_REFRESH_ATTEMPTS,
  PROXY_CREATION_UNCERTAINTY_MS,
  PROXY_EXPIRY_MARGIN_MS,
  REFRESH_RETRY_MS,
  RESTORATION_RETRY_MS,
  RETRY_SPREAD,
  STABLE_CONNECTION_MS,
  STARTUP_PREFLIGHT_TIMEOUT_MS,
} from "../shared/config";
import {
  EMPTY_AD_BLOCKING,
  EMPTY_SNAPSHOT,
  type AppErrorCode,
  type AppSnapshot,
  type LogoutOutcome,
} from "../shared/state";
import {
  EMPTY_PERSISTED_STATE,
  type PersistedState,
  type RetiredProxySession,
  type StorageService,
  type TransientState,
} from "../storage/storage";
import type { DeviceIdentityService } from "../device/device-identity";
import { type ProxyControlLevel, ProxyControlError, type ProxyService } from "./proxy-controller";
import { computeRefreshAt, type AlarmService } from "./session-refresh";
import {
  DEFAULT_SECURITY_STATE,
  isRetryCause,
  withCreationUncertainty,
  withSuspensionCause,
  type SecurityState,
  type SecurityStatus,
} from "../shared/security";
import type { SecurityStorage } from "../storage/security-storage";
import { SafetyError, type NetworkSafetyService } from "./network-safety";
import type { SiteExclusion } from "../shared/site-exclusions";
import type { SiteExclusionStorage } from "../storage/site-exclusion-storage";
import { SiteExclusionController } from "./site-exclusion-controller";
import { ProxyCleanupLedger } from "./proxy-cleanup-ledger";
import type { ProxyCleanupStorage } from "../storage/proxy-cleanup-storage";
import type { AccountCache, AccountCacheStorage } from "../storage/account-cache-storage";
import type { CommandResult } from "../shared/messages";
import type { ConnectionTrace } from "./connection-journal";
import { LocationPreferenceError } from "./location-preferences";
import type { ProxyErrorProvenance } from "../../platform/contracts/extension-api";

import { browserDeviceName, detectBrowserEnvironment } from "../shared/browser-environment";

export interface ControllerDependencies {
  webAuth?: WebAuthService;
  api: ApiService;
  storage: StorageService;
  identity: DeviceIdentityService;
  proxy: ProxyService;
  alarms: AlarmService;
  securityStorage: SecurityStorage;
  safety: NetworkSafetyService;
  siteExclusionStorage?: SiteExclusionStorage;
  cleanupStorage?: ProxyCleanupStorage;
  /** What the last account refresh received; without it every worker reads the API. */
  accountCache?: AccountCacheStorage;
  now(): number;
  onStateChanged(snapshot: AppSnapshot): void;
  onConnectionEvent?(event: ConnectionTrace): void;
  /** Capture the journal generation before asynchronous work starts. */
  captureConnectionEvents?(): (event: ConnectionTrace) => void;
  /** Optional observer; diagnostic failures must never affect account/VPN operations. */
  onDiagnosticAccountChanged?(): void;
  /** Per-stage network deadline; production uses the API request deadline. */
  remoteCleanupTimeoutMs?: number;
  /** Between 0 and 1, to spread the retry delays; production draws it at random. */
  random?(): number;
  /**
   * A restoration left a connection to be made, which has just begun: the promise ends
   * with it. Its outcome is an event of its own, after the restoration's.
   */
  onStartupConnection?(ended: Promise<void>): void;
  /** Deadline of the read-only checks before start-up; production uses its constant. */
  startupPreflightTimeoutMs?: number;
  /** When a renewable account session ends; null leaves the sign-in expiry in force. */
  accountSessionExpiry?(auth: AuthSession): number | null;
  /** Undefined preserves a manual selection; null means Auto has no available target. */
  resolveAutomaticLocation?(
    locations: Location[],
  ): string | null | undefined | Promise<string | null | undefined>;
}

type RemoteResult = "confirmed" | "unconfirmed";
type ConnectionRecorder = (event: ConnectionTrace) => void;

interface PendingProxyCreation {
  token: string;
  sequence: number;
  settled: Promise<void>;
  outcome: "pending" | "rejected" | "created" | "uncertain";
}

interface KnownRemoteSession {
  expiresAt: string;
  sequence: number;
  userId?: string;
  revocation?: Promise<RemoteResult>;
  revocationSettled?: boolean;
  expiredBy?: number;
}

/** What a committed credential replaced, until its own account is published. */
interface ReplacedAccount {
  auth: AuthSession;
  persisted: PersistedState;
  snapshot: AppSnapshot;
  logoutSequence: number;
}

export class AppController {
  private snapshot: AppSnapshot = { ...EMPTY_SNAPSHOT };
  private persisted: PersistedState = { ...EMPTY_PERSISTED_STATE };
  private activeSession: ProxySession | null = null;
  private readonly sessionActivatedAt = new WeakMap<ProxySession, number>();
  /** Current native TLS refusals; a refused session can never be authorized again. */
  private readonly sessionProxyRefusals = new WeakMap<ProxySession, AppErrorCode>();
  private readonly sessionLocations = new WeakMap<ProxySession, Location>();
  private readonly sessionRenewals = new WeakMap<
    ProxySession,
    Pick<TransientState, "refreshAttempts" | "refreshRetryAt">
  >();
  private authorizedSessionId: string | null = null;
  private initialization: Promise<void> | null = null;
  private startupStorageLoaded = false;
  private startupSecondaryStorageLoaded = false;
  private startupGuardFailure: AppErrorCode | null = null;
  private startupGeneration = 0;
  private startupInProgress = false;
  /** The restoration which the guard last refused, and when it ended: see ready(). */
  private unsettledRestoration: { ended: Promise<void>; at: number } | null = null;
  /** What storage holds of the security state, as this worker last read or wrote it. */
  private storedSecurityKey: string | null = null;
  /** The connection which a restoration found due, made once that restoration has ended. */
  private startupConnection: (() => Promise<unknown>) | null = null;
  private startupConnectionEnd: Promise<void> | null = null;
  private readonly startupProxyFailures: {
    generation: number;
    error: AppErrorCode;
    host: string;
    port: number;
  }[] = [];
  private startupProxyFailureOverflow = false;
  private readonly startupRecoveryCommands = new Set<Promise<CommandResult>>();
  private startupStopRequests = 0;
  // Permission/control events bump this on reaching the controller, before
  // awaiting startup: an authorization re-verifies control until none arrived
  // during its final check.
  private proxyControlRevision = 0;
  private startupStorageRecovery: "none" | "temporary_guard" | "preserve_guard" = "none";
  // The stored record of a guard armed for unreadable stores; null until it is read.
  private temporaryGuardMarker: boolean | null = null;
  private operationId = 0;
  // The operation current when a status was last published (see ownsBusyStatus).
  private statusOperation = 0;
  // Internal recovery operations may change operationId without replacing user intent.
  private connectionIntentRevision = 0;
  // Bumped by each accepted selection: an older connection attempt must not
  // replace it with another target.
  private selectionRevision = 0;
  private deviceQuotaRecovery: {
    intentRevision: number;
    accountGeneration: number;
    promise: Promise<CommandResult>;
  } | null = null;
  private operationAbort: AbortController | null = null;
  private webLoginAttempt: symbol | null = null;
  /** Gives up the sign-in window of the pending attempt, while it can still be given up. */
  private webLoginCancel: (() => void) | null = null;
  private accountAbort = new AbortController();
  private accountRevision = 0;
  private committedAccountRevision = 0;
  private locationsRevision = 0;
  private locationsRequest: { revision: number; promise: Promise<Location[]> } | null = null;
  /** When the API last gave this account's profile, subscription and catalogue together. */
  private accountRefreshedAt: number | null = null;
  /** The catalogue as the API last returned it, before any location was removed locally. */
  private receivedCatalog: Location[] | null = null;
  private deviceListRevision = 0;
  /** Requests about the ad blocker reach the service one after the other, in their order. */
  private adBlockingRequests: Promise<unknown> = Promise.resolve();
  /** The account whose choice for the ad blocker the snapshot shows. */
  private adBlockingUserId: string | null = null;
  private deviceSessionRevision = 0;
  private deviceQuotaError: "device_limit" | "device_revoked_limit" | null = null;
  // The error a guard route takeover replaced, with the operation then current: a later
  // operation publishes its own outcome instead (see reverifyGuardRoute).
  private takeoverDisplacedError: { operation: number; error: AppErrorCode | null } | null = null;
  // The reason of a failed connection which a failed account request replaced, with the
  // operation then current (see connectionErrorToKeep).
  private displacedConnectionError: {
    operation: number;
    error: AppErrorCode | null;
    shown: AppErrorCode;
  } | null = null;
  // When the published retry delay was received: it runs from then, for every reader.
  private retryAfterSince: number | null = null;
  private readonly deviceDeletions = new Map<string, Promise<void>>();
  private readonly deviceDeletionCommands = new Map<string, Promise<CommandResult>>();
  private readonly pendingSessions = new Map<ProxySession, string>();
  private readonly proxyCreations = new Set<PendingProxyCreation>();
  private readonly remoteSessions = new Map<string, Map<string, KnownRemoteSession>>();
  private readonly uncertainCreationTokens = new Set<string>();
  /**
   * Tokens whose ambiguous creation still suspends automatic retries: until a creation
   * of that token commits or protection is released. uncertainCreationTokens remembers
   * them longer, for the cleanup a logout reports.
   */
  private readonly retrySuspendingTokens = new Set<string>();
  private readonly cleanupRequestedTokens = new Set<string>();
  private readonly activeRemoteCleanups = new Map<string, number>();
  private historicalCleanupUncertain = false;
  /**
   * When every session which that marker may stand for has expired: none is left to
   * revoke from then on. Null while the marker is not set.
   */
  private historicalCleanupUntil: number | null = null;
  /** The same time for the creation sent last, which counts while one is in flight. */
  private creationCleanupUntil = 0;
  private creationSequence = 0;
  private creationMarkerOwner = 0;
  /** The deadline of the marker which the creation owning it found: an earlier unknown's. */
  private creationMarkerPrevious: { sequence: number; until: number | undefined } | null = null;
  /**
   * A failure since the last creation marker suspended automatic retries for a cause of
   * its own, not only for that marker: settling the creation must not resume them.
   */
  private failureSuspendedRetries = false;
  /** An expiry has just ended the session: its reconnection is to be made at once. */
  private expiryReconnection = false;
  private logoutSequence = 0;
  private logoutInProgress: Promise<CommandResult> | null = null;
  private logoutLocalCleanupPending = false;
  private logoutUnmigratedAccount: { token: string; userId: string } | null = null;
  // API tokens issued to authentications which have not published their account yet,
  // by operation.
  private readonly unpublishedAuthentications = new Map<number, string>();
  // Revocations of issued API tokens which no account owns any more.
  private readonly abandonedApiRevocations = new Set<Promise<RemoteResult>>();
  // Abandoned API tokens whose revocation failed, retried by the next logout.
  // Like revocations in flight, they are kept in memory only.
  private readonly unconfirmedApiTokens = new Set<string>();
  private accountGeneration = 0;
  private diagnosticAccountChanging = false;
  private diagnosticAccountGeneration = 0;
  private logoutGeneration = -1;
  private stateMutation: Promise<void> = Promise.resolve();
  private retiredSessions: RetiredProxySession[] = [];
  private security: SecurityState = { ...DEFAULT_SECURITY_STATE };
  private safetyStatus: SecurityStatus = {
    trafficBlocked: false,
    webRtcProtected: false,
    filterActive: false,
  };
  // Startup authentication can read transient credentials without waiting on API restoration.
  private credentialsAllowed = true;
  private readonly exclusions: SiteExclusionController;
  private exclusionsApplying = false;
  private readonly cleanup: ProxyCleanupLedger;

  constructor(private readonly dependencies: ControllerDependencies) {
    this.cleanup = new ProxyCleanupLedger(dependencies.cleanupStorage, () => dependencies.now());
    this.exclusions = new SiteExclusionController(
      dependencies.siteExclusionStorage,
      dependencies.proxy,
      dependencies.safety,
      async (allowed) => {
        this.dependencies.proxy.configureExclusions?.(allowed);
        await this.blockSafety(true);
      },
    );
  }

  async updateSiteExclusions(
    expectedRevision: number,
    enabled: boolean,
    entries: SiteExclusion[],
  ): Promise<void> {
    await this.initialize();
    if (!this.startupSecondaryStorageLoaded) throw new LocalError("storage_unavailable");
    await this.withStateMutation(async () => {
      try {
        await this.exclusions.stage(expectedRevision, enabled, entries);
      } catch (error) {
        if (this.exclusions.pending) {
          await this.exclusions.retainGuard().catch(() => undefined);
          await this.inspectSafety();
        }
        this.publish({});
        throw error;
      }
      await this.applySiteExclusions();
    });
  }

  async retrySiteExclusions(): Promise<void> {
    await this.initialize();
    if (!this.startupSecondaryStorageLoaded) throw new LocalError("storage_unavailable");
    await this.withStateMutation(() => this.applySiteExclusions());
  }

  private async applySiteExclusions(): Promise<void> {
    const operationId = this.operationId;
    const previousStatus = this.snapshot.status;
    const previouslyProtected = this.snapshot.protected;
    this.exclusionsApplying = true;
    this.publish({ protected: false });
    try {
      await this.exclusions.apply();
      if (this.security.protectionRequested) {
        await this.blockSafety(this.security.killSwitchEnabled);
        if (
          this.isCurrent(operationId) &&
          this.credentialsAllowed &&
          this.activeSession &&
          !this.isProxyExpired(this.activeSession)
        ) {
          await this.authorizeSession(this.activeSession, operationId);
          this.exclusionsApplying = false;
          this.publish({
            status: previouslyProtected ? previousStatus : "connected",
            protected: true,
            error: null,
          });
        }
      } else if (this.isCurrent(operationId)) {
        await this.dependencies.proxy.clear();
        await this.dependencies.safety.setWebRtc(false);
        await this.dependencies.safety.release();
      }
      await this.inspectSafety();
      this.exclusionsApplying = false;
      this.publish({});
    } catch (error) {
      if (
        error instanceof DOMException &&
        error.name === "AbortError" &&
        !this.isCurrent(operationId) &&
        !this.exclusions.pending &&
        !this.exclusions.getState().error
      ) {
        // The policy is complete. The newer network operation now owns the
        // traffic guard; its cancellation must not become a policy failure.
        await this.inspectSafety();
        this.exclusionsApplying = false;
        this.publish({ protected: false });
        return;
      }
      await this.exclusions.retainGuard().catch(() => undefined);
      await this.inspectSafety();
      this.exclusionsApplying = false;
      this.publish({ protected: false });
      throw error;
    }
  }

  initialize(observer?: ConnectionRecorder): Promise<void> {
    // An explicit logout disabled credentials, but its only legacy cleanup
    // metadata is not yet durable. Only the local-stop retry may consume it.
    if (this.logoutUnmigratedAccount && this.logoutLocalCleanupPending) return Promise.resolve();
    if (this.startupRecoveryCommands.size) {
      // Native change events and popup reads can arrive while an explicit stop
      // repairs unread stores. Finish that intent before startup can restore one.
      return Promise.allSettled([...this.startupRecoveryCommands]).then(() =>
        this.initialize(observer),
      );
    }
    if (!this.initialization) {
      // Commands and events that capture a connection observer pass it, so a
      // restoration they retry records into the history they started in; a caller
      // joining a restoration in progress keeps that restoration's binding. Startup
      // and passive reads bind each trace late: the first publication establishes
      // the account boundary that purges restored history.
      const pending = this.doInitialize(observer).then(() => this.beginStartupConnection());
      this.initialization = pending;
      const resetUnreadInitialization = () => {
        if (this.initialization !== pending) return;
        if (!this.startupSecondaryStorageLoaded || this.startupGuardFailure !== null) {
          this.initialization = null;
          // Stores which could not be read are read again by every caller: they are
          // what a start-up cannot do without. A refused guard waits for its cause.
          this.unsettledRestoration = this.startupSecondaryStorageLoaded
            ? { ended: pending.catch(() => undefined), at: performance.now() }
            : null;
        } else this.unsettledRestoration = null;
      };
      void pending.then(resetUnreadInitialization, resetUnreadInitialization);
    }
    return this.initialization;
  }

  /**
   * For those who only read the state: a popup which polls, a request which Firefox
   * holds, a proxy challenge. A restoration which the guard refused is tried again by
   * whoever asks for something, and by the events which report a change. Those who only
   * read do not each run it again: they are given the one which ended, and a new one
   * every RESTORATION_RETRY_MS at most.
   */
  ready(): Promise<void> {
    const unsettled = this.unsettledRestoration;
    if (
      unsettled &&
      !this.initialization &&
      this.startupRecoveryCommands.size === 0 &&
      performance.now() - unsettled.at < RESTORATION_RETRY_MS
    )
      return unsettled.ended;
    return this.initialize();
  }

  /**
   * A restoration which finds protection requested and no session to restore leaves
   * the connection to be made here, once it has ended: nothing which awaits the
   * restoration, a Disconnect least of all, then waits for the network behind it. The
   * connection is started before any of them goes on, and publishes that it is in
   * progress: a command of theirs supersedes it as it does any other.
   */
  private beginStartupConnection(): void {
    const connect = this.startupConnection;
    this.startupConnection = null;
    // An explicit stop which awaits this restoration must find no connection begun.
    if (!connect || this.startupStopRequests > 0) return;
    const ended = connect().then(
      () => undefined,
      // What the restoration itself did with a failure it could not report otherwise.
      (error: unknown) => this.enterFailure(error, this.operationId, false).catch(() => undefined),
    );
    this.startupConnectionEnd = ended;
    void ended.then(() => {
      if (this.startupConnectionEnd === ended) this.startupConnectionEnd = null;
    });
    try {
      this.dependencies.onStartupConnection?.(ended);
    } catch {
      // An observer of the connection cannot prevent it.
    }
  }

  /** Resolves once the connection which a restoration left to make has ended, if any. */
  startupConnectionSettled(): Promise<void> {
    return this.startupConnectionEnd ?? Promise.resolve();
  }

  getSnapshot(): AppSnapshot {
    const snapshot = structuredClone(this.snapshot);
    // "blocked" describes the guard as last published. It never replaces the stored
    // status, which a later publication without a status must find again once the
    // guard is released.
    if (
      snapshot.trafficBlocked &&
      !snapshot.protected &&
      snapshot.status !== "connecting" &&
      snapshot.status !== "refreshing" &&
      snapshot.status !== "disconnecting"
    )
      snapshot.status = "blocked";
    // A delay the server asked for runs from when it was received: a popup opened later
    // is given what remains of it, not the whole delay again.
    if (snapshot.retryAfterSeconds !== null && this.retryAfterSince !== null) {
      const elapsed = Math.floor((this.dependencies.now() - this.retryAfterSince) / 1_000);
      snapshot.retryAfterSeconds = Math.max(0, snapshot.retryAfterSeconds - Math.max(0, elapsed));
    }
    return snapshot;
  }

  hasRestoredAccount(): boolean {
    return this.startupStorageLoaded;
  }

  isSessionCurrentForProxyAuth(session: ProxySession): boolean {
    if (!this.canUseCredentials() || this.isProxyExpired(session)) return false;
    // A transient session can service startup authentication before full account
    // restoration. Terminal transitions disable credentials synchronously.
    const active = this.activeSession;
    if (this.hasProxyRefusal(session) || (active && this.hasProxyRefusal(active))) return false;
    return (
      !active ||
      (!this.isProxyExpired(active) &&
        active.expiresAt === session.expiresAt &&
        active.id === session.id &&
        active.host.toLowerCase() === session.host.toLowerCase() &&
        active.port === session.port &&
        active.username === session.username &&
        active.password === session.password)
    );
  }

  /** Only a candidate, possibly refused since: callers guard it by isSessionCurrentForProxyAuth. */
  async getActiveSession(): Promise<ProxySession | null> {
    const operationId = this.operationId;
    if (!this.canUseCredentials()) return null;
    if (
      this.activeSession &&
      !this.isProxyExpired(this.activeSession) &&
      !this.startupProxyErrorCode(this.activeSession)
    )
      return this.activeSession;
    const transient = await this.dependencies.storage.readTransient().catch(() => null);
    if (
      this.canUseCredentials() &&
      transient?.proxySession &&
      !this.startupProxyErrorCode(transient.proxySession) &&
      !this.isProxyExpired(transient.proxySession)
    ) {
      const owner = this.persisted.profile?.userId;
      if (owner && (await this.dependencies.identity.getRecovery(owner)).pending) return null;
      if (!this.canUseCredentials() || !this.isCurrent(operationId)) return null;
      return transient.proxySession;
    }
    await this.ready();
    // Credentials which the restoration left to be created are worth waiting for: the
    // request which asks for them is answered once they exist, within its own deadline.
    await this.startupConnectionSettled();
    return this.canUseCredentials() &&
      this.activeSession &&
      !this.isProxyExpired(this.activeSession)
      ? this.activeSession
      : null;
  }

  login(email: string, password: string): Promise<CommandResult> {
    return this.authenticateAccount((signal) =>
      this.dependencies.api.login(email.trim(), password, signal),
    );
  }

  async webLogin(disconnectFirst: boolean, locale?: string): Promise<CommandResult> {
    if (this.webLoginAttempt) return { ok: false, commandError: "web_login_busy" };
    const webAuth = this.dependencies.webAuth;
    if (!webAuth) return { ok: false, commandError: "web_login_unavailable" };
    const attempt = Symbol("web-login");
    this.webLoginAttempt = attempt;
    // The browsers offer no way to close or find the sign-in window again. The user may
    // give the attempt up from the popup: a later return of that window is discarded.
    const givenUp = new AbortController();
    this.webLoginCancel = () => givenUp.abort();
    // Read again wherever it matters: it changes while this command awaits.
    const isGivenUp = () => givenUp.signal.aborted;
    const waitingAccount = this.accountGeneration;
    try {
      await this.initialize();
      // Startup creates its own operation. The later authentication boundary checks
      // the current operation after initialization, before any account can be replaced.
      if (waitingAccount !== this.accountGeneration) return supersededCommand();
      if (!this.startupSecondaryStorageLoaded)
        return failedCommand(new LocalError("storage_unavailable"));
      // A stale logged-out popup cannot silently replace a now-signed-in account.
      if (this.persisted.profile) {
        this.publish({ error: "login_requires_disconnect" });
        return { ok: false, commandError: "login_requires_disconnect" };
      }
      const mustDisconnect =
        this.activeSession !== null ||
        this.security.protectionRequested ||
        this.safetyStatus.trafficBlocked;
      if (mustDisconnect && !disconnectFirst) {
        this.publish({ error: "login_requires_disconnect" });
        return { ok: false, commandError: "login_requires_disconnect" };
      }
      // Given up before anything was changed: protection is not released for a
      // sign-in which the user no longer wants.
      if (givenUp.signal.aborted) {
        this.publish({ error: "web_login_cancelled" });
        return { ok: false, commandError: "web_login_cancelled" };
      }
      if (disconnectFirst) {
        // Only the explicitly labelled UI action may release protection for web login.
        // Keep this operation boundary: logout/connect during cleanup must cancel login.
        const requested = this.security.protectionRequested;
        const stopOperation = this.operationId + 1;
        const stopped = await this.disconnectInitialized();
        if (!stopped.ok) return stopped;
        this.assertCurrent(stopOperation);
        if (this.security.protectionRequested || this.safetyStatus.trafficBlocked)
          return failedCommand(new LocalError("traffic_guard_failed"));
        // Given up while protection was being released for it. The release could not
        // be interrupted halfway; what it released for nothing is requested again, so
        // that the user is back where the sign-in found them.
        if (isGivenUp()) {
          if (requested) {
            try {
              await this.requestProtectionAgain();
            } catch (error) {
              // The guard could not be closed again: that is what the user must know.
              this.publish({ error: mapError(error) });
              return failedCommand(error);
            }
          }
          this.publish({ error: "web_login_cancelled" });
          return { ok: false, commandError: "web_login_cancelled" };
        }
      }
      return await this.authenticateAccount(async (signal) => {
        // The window ends with its operation, or when the user gives it up.
        const waiting = new AbortController();
        const stopWaiting = () => waiting.abort();
        signal.addEventListener("abort", stopWaiting, { once: true });
        givenUp.signal.addEventListener("abort", stopWaiting, { once: true });
        if (signal.aborted || givenUp.signal.aborted) stopWaiting();
        let authorization: WebAuthorization;
        try {
          authorization = await webAuth.authorize(waiting.signal, locale);
        } catch (error) {
          // Given up by the user, not superseded by another command: it ends like a
          // sign-in window which the user closed.
          if (givenUp.signal.aborted && !signal.aborted)
            throw new WebAuthError("web_login_cancelled");
          throw error;
        } finally {
          signal.removeEventListener("abort", stopWaiting);
          givenUp.signal.removeEventListener("abort", stopWaiting);
          // The one-use code is in hand, or the attempt is over: nothing is left to give up.
          if (this.webLoginAttempt === attempt) this.webLoginCancel = null;
        }
        assertNotAborted(signal);
        // A window which returned although it was given up is discarded: its code is
        // never exchanged.
        if (givenUp.signal.aborted) throw new WebAuthError("web_login_cancelled");
        let auth: AuthSession;
        try {
          // A one-use code must never be retried automatically after a lost response.
          auth = await this.dependencies.api.exchangeExtensionCode(authorization, signal);
        } catch (error) {
          if (error instanceof ApiError && error.code === "extension_auth_invalid_grant")
            throw new WebAuthError("web_login_denied");
          if (error instanceof ApiError && error.code === "extension_auth_unavailable")
            throw new WebAuthError("web_login_unavailable");
          throw error;
        }
        // An issued token is never dropped: the authentication revokes it when
        // superseded, and a locally expired one may be clock skew, not dead.
        if (Date.parse(auth.expiresAt) <= this.dependencies.now()) {
          this.abandonApiSession(auth.accessToken);
          throw new NetworkError("invalid_response");
        }
        return auth;
      }, this.operationId);
    } catch (error) {
      return failedCommand(error);
    } finally {
      if (this.webLoginAttempt === attempt) {
        this.webLoginAttempt = null;
        this.webLoginCancel = null;
        this.emit();
      }
    }
  }

  /**
   * After a release which turned out to be for nothing: the protection is requested
   * again and the guard closed as the preferences ask, without an account to connect.
   */
  private async requestProtectionAgain(): Promise<void> {
    const operation = this.startOperation();
    await this.withStateMutation(async () => {
      this.assertCurrent(operation.id);
      const released = this.security;
      this.security = { ...released, protectionRequested: true };
      try {
        await this.blockSafety(this.security.killSwitchEnabled);
        this.assertCurrent(operation.id);
        await this.writeSecurity();
      } catch (error) {
        // Nothing is requested which is neither enforced nor stored.
        this.security = released;
        throw error;
      } finally {
        await this.inspectSafety();
      }
    });
  }

  /**
   * Gives up a sign-in which is waiting for its window. Once the window has returned
   * its code, or without a pending sign-in, there is nothing to give up.
   */
  cancelWebLogin(): CommandResult {
    this.webLoginCancel?.();
    return { ok: true };
  }

  private async authenticateAccount(
    authenticate: (signal: AbortSignal) => Promise<AuthSession>,
    expectedOperation?: number,
  ): Promise<CommandResult> {
    await this.initialize();
    if (this.logoutUnmigratedAccount) {
      const cleanup = await this.retryLocalLogoutCleanup();
      if (!cleanup.ok) return cleanup;
      await this.initialize();
    }
    if (expectedOperation !== undefined && !this.isCurrent(expectedOperation))
      return supersededCommand();
    if (!this.startupSecondaryStorageLoaded)
      return failedCommand(new LocalError("storage_unavailable"));
    // A stale extension page must not replace the owner of live or pending
    // proxy credentials. The ordinary UI already requires disconnection first.
    if (
      this.persisted.auth &&
      (this.activeSession || (this.persisted.profile && this.security.protectionRequested))
    ) {
      this.publish({ error: "login_requires_disconnect" });
      return { ok: false, commandError: "login_requires_disconnect" };
    }
    this.accountGeneration += 1;
    const diagnosticGeneration = this.beginDiagnosticAccountChange();
    const operation = this.startOperation();
    this.cancelAccountRefreshes();
    this.publish({
      status: "connecting",
      protected: false,
      error: null,
      retryAfterSeconds: null,
      logoutOutcome: null,
    });
    const commit: { replaced: ReplacedAccount | null } = { replaced: null };
    try {
      const auth = await authenticate(operation.signal);
      // This transaction owns the issued token until its account is published,
      // unless a logout claims it first. Neither may drop it without revocation.
      this.unpublishedAuthentications.set(operation.id, auth.accessToken);
      this.assertCurrent(operation.id);
      await this.withStateMutation(async () => {
        this.assertCurrent(operation.id);
        const persisted = { ...EMPTY_PERSISTED_STATE, auth };
        try {
          await this.dependencies.storage.writePersisted(persisted);
          this.assertCurrent(operation.id);
        } catch (error) {
          // Still under the mutation lock: an abandoned credential must not be
          // restorable by a later worker or startup retry.
          await this.dependencies.storage.writePersisted(this.persisted).catch(() => undefined);
          throw error;
        }
        // A superseded authentication still owning the credential it committed
        // abandons it, so that credential is no account to restore.
        const abandoning = [...this.unpublishedAuthentications].some(
          ([id, token]) => id !== operation.id && token === this.persisted.auth?.accessToken,
        );
        commit.replaced = {
          auth,
          persisted: abandoning ? { ...EMPTY_PERSISTED_STATE } : this.persisted,
          snapshot: this.snapshot,
          logoutSequence: this.logoutSequence,
        };
        this.persisted = persisted;
        this.deviceQuotaError = null;
        this.logoutLocalCleanupPending = false;
        // Once the account credential changes, no old account fields may be
        // published while hydration of the new account is pending or failing.
        this.snapshot = { ...EMPTY_SNAPSHOT, status: "connecting" };
        this.emit();
        this.security = {
          ...this.security,
          capacityBlockedLocationId: null,
        };
        await this.writeSecurity();
        this.assertCurrent(operation.id);
      });
      await this.hydrateAccount(operation.signal, operation.trace);
      // The published account owns the credential from here on, and an
      // unpublished credential it replaced is gone for good.
      if (commit.replaced) this.abandonReplacedCredential(commit.replaced);
      commit.replaced = null;
      this.unpublishedAuthentications.delete(operation.id);
      this.assertCurrent(operation.id);
      const currentDeviceId = await this.dependencies.identity.getDeviceId(this.requireUserId());
      this.assertCurrent(operation.id);
      this.publish({
        status: "disconnected",
        protected: false,
        currentDeviceId,
        error: null,
      });
      if (this.security.protectionRequested)
        return await this.connectInitialized(this.security.selectedLocationId);
      return { ok: true };
    } catch (error) {
      if (commit.replaced) {
        // A cancelled authentication must not stay restorable once superseded.
        const restored =
          !this.isCurrent(operation.id) && (await this.restoreReplacedAccount(commit.replaced));
        // Otherwise the replaced credential is gone for good: a current failure
        // keeps the committed one, or another operation took over the account.
        if (!restored) this.abandonReplacedCredential(commit.replaced);
      }
      const abandoned = this.unpublishedAuthentications.get(operation.id);
      if (abandoned !== undefined) {
        this.unpublishedAuthentications.delete(operation.id);
        // A current failure keeps its committed credential, and another operation
        // may have published its account. Otherwise no account owns this token.
        if (this.persisted.auth?.accessToken !== abandoned) this.abandonApiSession(abandoned);
      }
      if (!this.isCurrent(operation.id)) return supersededCommand();
      if (error instanceof ApiError && error.code === "invalid_credentials")
        this.publish({ status: "error", protected: false, error: "invalid_credentials" });
      else await this.handleOperationError(error, false);
      return failedCommand(error);
    } finally {
      this.endDiagnosticAccountChange(diagnosticGeneration);
    }
  }

  /**
   * Rolls back a superseded authentication whose credential no account has
   * published, and tells whether the replaced account is current again. A
   * stale connection still hydrating that credential then fails as
   * unauthorized and keeps its guard: it never adopts a cancelled authentication.
   */
  private async restoreReplacedAccount(replaced: ReplacedAccount): Promise<boolean> {
    const { persisted, snapshot } = replaced;
    let restored = false;
    await this.withStateMutation(async () => {
      // Logout, an account reset or a newer login may already own the account,
      // and a newer operation may have published this credential's account.
      // Logout claims what it found even before its first mutation.
      if (
        this.persisted.auth !== replaced.auth ||
        this.persisted.profile ||
        this.logoutSequence !== replaced.logoutSequence
      )
        return;
      // Memory first: logout and account resets replace it outside this lock.
      this.persisted = persisted;
      restored = true;
      this.cancelAccountRefreshes();
      // Only an idle status depends on the account; a newer operation owns the others.
      const idle = this.snapshot.status === "disconnected" || this.snapshot.status === "logged_out";
      this.publish({
        status: !idle ? this.snapshot.status : persisted.auth ? "disconnected" : "logged_out",
        profile: snapshot.profile,
        subscription: snapshot.subscription,
        selectedLocationId: snapshot.selectedLocationId,
        currentDeviceId: snapshot.currentDeviceId,
        devices: snapshot.devices,
        deviceLimit: snapshot.deviceLimit,
        locations: snapshot.locations,
        locationsStatus: snapshot.locationsStatus,
        locationsError: snapshot.locationsError,
      });
      // A failed write leaves only a credential which is being revoked.
      await this.dependencies.storage.writePersisted(persisted).catch(() => undefined);
    }).catch(() => undefined);
    return restored;
  }

  /** Revokes the unpublished credential which a committed one replaced for good. */
  private abandonReplacedCredential({ auth, persisted }: ReplacedAccount): void {
    const replaced = persisted.auth?.accessToken;
    // A published account's token may still own proxy cleanups; it keeps its lifecycle.
    if (replaced && !persisted.profile && replaced !== auth.accessToken)
      this.abandonApiSession(replaced);
  }

  async connect(
    locationId: string | null,
    observer = this.captureConnectionObserver(),
  ): Promise<CommandResult> {
    this.connectionIntentRevision += 1;
    await this.initialize(observer);
    if (!this.startupSecondaryStorageLoaded)
      return failedCommand(new LocalError("storage_unavailable"));
    if (this.startupGuardFailure) return { ok: false, commandError: this.startupGuardFailure };
    if (
      this.activeSession?.id === this.authorizedSessionId &&
      !this.isProxyExpired(this.activeSession)
    ) {
      return this.changeLocation(locationId ?? this.activeSession.locationId, observer);
    }
    return this.connectInitialized(locationId, true, observer);
  }

  private async connectInitialized(
    requestedLocationId: string | null,
    manual = false,
    observer = this.captureConnectionObserver(),
  ): Promise<CommandResult> {
    const requestedLocation = manual
      ? this.snapshot.locations.find((location) => location.id === requestedLocationId)
      : undefined;
    const waitingId = this.operationId;
    // A selection accepted while this attempt waits below also replaces its target.
    const selectionRevision = this.selectionRevision;
    const userId = this.persisted.profile?.userId;
    const deletingDevice = userId ? this.deviceDeletions.get(userId) : undefined;
    if (deletingDevice) {
      await deletingDevice;
      if (!this.isCurrent(waitingId)) return supersededCommand();
    }
    const token = this.persisted.auth?.accessToken;
    if (!manual && this.security.capacityBlockedLocationId)
      return { ok: false, commandError: "server_full" };
    const operation = this.startOperation(observer);
    this.publish({ status: "connecting", protected: false, error: null, retryAfterSeconds: null });
    let created: ProxySession | null = null;
    try {
      if (manual && !(await this.allowExplicitDeviceRecovery())) return supersededCommand();
      await this.withStateMutation(async () => {
        this.assertCurrent(operation.id);
        this.assertSelectionOwner(selectionRevision, requestedLocationId);
        this.security = withSuspensionCause(
          {
            ...this.security,
            protectionRequested: true,
            retrySuspended: false,
            selectedLocationId: requestedLocationId ?? this.security.selectedLocationId,
            ...(manual ? { capacityBlockedLocationId: null } : {}),
          },
          null,
        );
        // An earlier request still unanswered keeps its marker: only its answer settles
        // it, and resumes the retries which this attempt may leave deferred.
        if (
          ![...this.proxyCreations].some(
            (creation) => creation.sequence === this.creationMarkerOwner,
          )
        )
          this.creationMarkerOwner = 0;
        await this.blockSafety(this.security.killSwitchEnabled);
        this.assertCurrent(operation.id);
        await this.writeSecurity();
        this.assertCurrent(operation.id);
        await this.inspectSafety();
      });
      if (this.security.retryNotBefore && this.security.retryNotBefore > this.dependencies.now()) {
        await this.withStateMutation(async () => {
          this.assertCurrent(operation.id);
          this.security = {
            ...this.security,
            nextRetryAt: this.security.proxyCreationUncertain ? null : this.security.retryNotBefore,
          };
          await this.writeSecurity();
          if (this.security.nextRetryAt)
            await this.dependencies.alarms.scheduleReconnect(this.security.nextRetryAt);
          this.publish({ status: "error", error: "rate_limited", protected: false });
        });
        return { ok: false, commandError: "rate_limited" };
      }
      await this.dependencies.proxy.assertControllable();
      this.assertCurrent(operation.id);
      await this.hydrateAccount(operation.signal, operation.trace);
      this.assertCurrent(operation.id);
      const automatic = await this.dependencies.resolveAutomaticLocation?.(this.snapshot.locations);
      this.assertCurrent(operation.id);
      const locationId =
        automatic !== undefined
          ? automatic
          : (requestedLocationId ??
            this.security.selectedLocationId ??
            this.persisted.selectedLocationId);
      this.traceConnection(
        {
          event: "target",
          source:
            automatic !== undefined
              ? "automatic"
              : requestedLocationId !== null
                ? "requested"
                : this.security.selectedLocationId !== null
                  ? "security"
                  : "persisted",
          count: this.snapshot.locations.length,
          requestedPresent: this.snapshot.locations.some((location) => location.id === locationId),
        },
        operation.trace,
      );
      if (!locationId) {
        this.traceConnection(
          {
            event: "failure",
            source: "local",
            reason: automatic === null ? "automatic_empty" : "no_target",
            error: "invalid_location",
          },
          operation.trace,
        );
        throw new LocalError("invalid_location");
      }
      const retainedLocation = automatic === undefined ? requestedLocation : undefined;
      this.assertCanConnect(locationId, retainedLocation, operation.trace);
      await this.dependencies.proxy.assertControllable();
      created = await this.createSignedProxySession(
        locationId,
        operation.signal,
        retainedLocation,
        operation.trace,
        selectionRevision,
      );
      this.assertCurrent(operation.id);
      this.assertSessionLocation(created, locationId);
      const sessionToApply = created;
      await this.withStateMutation(async () => {
        this.assertCurrent(operation.id);
        this.assertSelectionOwner(selectionRevision, locationId);
        await this.writeTransient({
          proxySession: sessionToApply,
          refreshAttempts: 0,
          retiredSessions: this.retiredSessions,
        });
        this.assertCurrent(operation.id);
        await this.commitCreationMarker(sessionToApply);
        this.assertCurrent(operation.id);
        this.activeSession = sessionToApply;
        this.sessionActivatedAt.set(sessionToApply, performance.now());
        this.credentialsAllowed = true;
        await this.dependencies.proxy.apply(sessionToApply);
        this.assertCurrent(operation.id);
        this.persisted = { ...this.persisted, selectedLocationId: locationId, autoConnect: true };
        await this.dependencies.storage.writePersisted(this.persisted);
        this.assertCurrent(operation.id);
        await this.dependencies.alarms.scheduleSession(sessionToApply);
        this.assertCurrent(operation.id);
        await this.authorizeSession(sessionToApply, operation.id);
        this.publish({
          status: "connected",
          protected: true,
          activeLocationId: locationId,
          selectedLocationId: locationId,
          autoConnect: true,
          error: null,
        });
      });
      return { ok: true };
    } catch (error) {
      if (!this.isCurrent(operation.id) || error instanceof SelectionSupersededError) {
        if (created) {
          if (!this.isRetainedAuthorizedSession(created, token))
            void this.safeRevoke(created.id, token);
          await this.settleDiscardedCreation(created, token);
        } else if (error instanceof SelectionSupersededError)
          await this.resumeSelection(operation.id);
        return supersededCommand();
      }
      this.traceConnection(
        {
          event: "failure",
          error: mapError(error),
          ...(error instanceof ApiError
            ? { source: "api", httpStatus: error.status }
            : error instanceof LocalError
              ? { source: "local" }
              : {}),
        },
        operation.trace,
      );
      if (created) {
        void this.safeRevoke(created.id, token);
        await this.settleFailedCreation(created);
      }
      if (isUnauthorized(error)) await this.handleOperationError(error, false);
      else await this.enterFailure(error, operation.id);
      return failedCommand(error);
    } finally {
      if (created) this.pendingSessions.delete(created);
      if (token) this.forgetCompletedToken(token);
    }
  }

  async selectLocation(
    locationId: string,
    observer = this.captureConnectionObserver(),
  ): Promise<CommandResult> {
    this.connectionIntentRevision += 1;
    const trace = this.captureConnectionTrace(this.operationId, observer);
    await this.initialize(observer);
    if (!this.startupSecondaryStorageLoaded)
      return failedCommand(new LocalError("storage_unavailable"));
    if (!this.snapshot.locations.some((location) => location.id === locationId)) {
      this.traceConnection(
        {
          event: "failure",
          source: "local",
          reason: "select_missing",
          error: "invalid_location",
          count: this.snapshot.locations.length,
          requestedPresent: false,
        },
        trace,
      );
      this.publish({ status: "error", error: "invalid_location" });
      return { ok: false, commandError: "invalid_location" };
    }
    const signal = this.accountAbort.signal;
    await this.withStateMutation(async () => {
      assertNotAborted(signal);
      const previousAccount = this.persisted;
      const account = { ...previousAccount, selectedLocationId: locationId };
      this.persisted = account;
      try {
        await this.dependencies.storage.writePersisted(account);
      } catch (error) {
        if (this.persisted === account) this.persisted = previousAccount;
        throw error;
      }
      assertNotAborted(signal);
      const previousSecurity = this.security;
      const security = {
        ...previousSecurity,
        selectedLocationId: locationId,
        capacityBlockedLocationId: null,
      };
      this.security = security;
      try {
        await this.writeSecurity();
      } catch (error) {
        // The stored target is still the previous one: a selection which could not be
        // saved must not become the target of the next attempt either.
        if (this.security === security) this.security = previousSecurity;
        if (this.persisted === account) {
          this.persisted = previousAccount;
          await this.dependencies.storage.writePersisted(previousAccount).catch(() => undefined);
        }
        throw error;
      }
      assertNotAborted(signal);
      // A pending connection attempt must not commit another target over this choice.
      this.selectionRevision += 1;
      this.publish({
        status: this.activeSession ? "connected" : "disconnected",
        selectedLocationId: locationId,
        error: null,
      });
    });
    return { ok: true };
  }

  async changeLocation(
    locationId: string,
    observer = this.captureConnectionObserver(),
  ): Promise<CommandResult> {
    this.connectionIntentRevision += 1;
    await this.initialize(observer);
    if (!this.startupSecondaryStorageLoaded)
      return failedCommand(new LocalError("storage_unavailable"));
    const previous = this.activeSession;
    if (previous?.id !== this.authorizedSessionId || this.isProxyExpired(previous)) {
      return this.connect(locationId, observer);
    }
    const requestedLocation = this.snapshot.locations.find(
      (location) => location.id === locationId,
    );
    const keepRequestedSession =
      previous.locationId === locationId && !this.dependencies.resolveAutomaticLocation;
    const token = this.persisted.auth?.accessToken;
    const deviceSessionRevision = this.deviceSessionRevision;
    const operation = this.startOperation(observer);
    const selectionRevision = this.selectionRevision;
    if (!keepRequestedSession)
      this.publish({
        status: "connecting",
        protected: !this.hasProxyRefusal(previous),
        error: null,
        retryAfterSeconds: null,
      });
    let replacement: ProxySession | null = null;
    try {
      if (keepRequestedSession) {
        const renewalScheduled = await this.clearCapacityBlock(operation.id);
        await this.selectRetainedLocation(
          previous,
          operation.id,
          renewalScheduled,
          selectionRevision,
        );
        return { ok: true };
      }
      if (!(await this.allowExplicitDeviceRecovery())) return supersededCommand();
      const renewalScheduled = await this.clearCapacityBlock(operation.id);
      await this.dependencies.proxy.assertControllable();
      this.assertCurrent(operation.id);
      await this.refreshEntitlement(operation.signal, operation.trace);
      this.assertCurrent(operation.id);
      const automatic = await this.dependencies.resolveAutomaticLocation?.(this.snapshot.locations);
      this.assertCurrent(operation.id);
      this.traceConnection(
        {
          event: "target",
          source: automatic !== undefined ? "automatic" : "requested",
          count: this.snapshot.locations.length,
          requestedPresent: this.snapshot.locations.some(
            (location) => location.id === (automatic !== undefined ? automatic : locationId),
          ),
        },
        operation.trace,
      );
      if (automatic === null) {
        this.traceConnection(
          {
            event: "failure",
            source: "local",
            reason: "automatic_empty",
            error: "invalid_location",
          },
          operation.trace,
        );
        throw new LocalError("invalid_location");
      }
      if (automatic !== undefined) locationId = automatic;
      if (previous.locationId === locationId) {
        await this.selectRetainedLocation(
          previous,
          operation.id,
          renewalScheduled,
          selectionRevision,
        );
        return { ok: true };
      }
      const retainedLocation = automatic === undefined ? requestedLocation : undefined;
      this.assertCanConnect(locationId, retainedLocation, operation.trace);
      await this.dependencies.proxy.assertControllable();
      replacement = await this.createSignedProxySession(
        locationId,
        operation.signal,
        retainedLocation,
        operation.trace,
        selectionRevision,
      );
      this.assertCurrent(operation.id);
      this.assertSessionLocation(replacement, locationId);
      const sessionToApply = replacement;
      let immediatelyRevoked: string[] = [];
      await this.withStateMutation(async () => {
        this.assertCurrent(operation.id);
        this.assertSelectionOwner(selectionRevision, locationId);
        await this.writeTransient({
          proxySession: sessionToApply,
          refreshAttempts: 0,
          retiredSessions: this.retiredSessions,
        });
        this.assertCurrent(operation.id);
        await this.commitCreationMarker(sessionToApply);
        this.assertCurrent(operation.id);
        this.activeSession = sessionToApply;
        this.sessionActivatedAt.set(sessionToApply, performance.now());
        this.credentialsAllowed = true;
        await this.dependencies.proxy.apply(sessionToApply);
        this.assertCurrent(operation.id);
        this.persisted = { ...this.persisted, selectedLocationId: locationId, autoConnect: true };
        await this.dependencies.storage.writePersisted(this.persisted);
        this.assertCurrent(operation.id);
        await this.dependencies.alarms.scheduleSession(sessionToApply);
        this.assertCurrent(operation.id);
        immediatelyRevoked = [previous.id, ...this.retiredSessionIds()];
        await this.writeTransient({
          proxySession: sessionToApply,
          refreshAttempts: 0,
          retiredSessions: [],
        });
        this.assertCurrent(operation.id);
        this.retiredSessions = [];
        await this.authorizeSession(sessionToApply, operation.id);
        this.publish({
          status: "connected",
          protected: true,
          activeLocationId: locationId,
          selectedLocationId: locationId,
          error: null,
        });
      });
      void this.safeRevokeMany(immediatelyRevoked, token);
      return { ok: true };
    } catch (error) {
      if (replacement && !this.isRetainedAuthorizedSession(replacement, token))
        void this.safeRevoke(replacement.id, token);
      if (!this.isCurrent(operation.id) || error instanceof SelectionSupersededError) {
        if (replacement) await this.settleDiscardedCreation(replacement, token);
        else if (error instanceof SelectionSupersededError)
          await this.resumeSelection(operation.id);
        return supersededCommand();
      }
      if (replacement) await this.settleFailedCreation(replacement);
      this.traceConnection(
        {
          event: "failure",
          error: mapError(error),
          ...(error instanceof ApiError
            ? { source: "api", httpStatus: error.status }
            : error instanceof LocalError
              ? { source: "local" }
              : {}),
        },
        operation.trace,
      );
      if (isUnauthorized(error)) {
        await this.handleOperationError(error, false);
        return failedCommand(error);
      }
      const restored = await this.withStateMutation(async () => {
        if (!this.isCurrent(operation.id)) return false;
        if (this.deviceSessionRevision !== deviceSessionRevision) return false;
        if (replacement && replacement.id !== previous.id)
          this.retiredSessions = addRetiredSession(
            this.retiredSessions,
            replacement.id,
            replacement.expiresAt,
          );
        if (this.isProxyExpired(previous) || this.hasProxyRefusal(previous, replacement))
          return false;
        const renewal = this.sessionRenewals.get(previous);
        if (!renewal) return false;
        this.activeSession = previous;
        await this.writeTransient({
          proxySession: previous,
          ...renewal,
          retiredSessions: this.retiredSessions,
        });
        this.assertCurrent(operation.id);
        try {
          if (!(await this.dependencies.proxy.isActiveConfiguration(previous)))
            await this.dependencies.proxy.apply(previous);
          this.assertCurrent(operation.id);
          await this.scheduleRetainedSession(previous, operation.id);
          this.assertCurrent(operation.id);
          await this.authorizeSession(previous, operation.id);
          this.publish({
            status: "error",
            protected: true,
            activeLocationId: previous.locationId,
            error: mapError(error),
          });
          return true;
        } catch {
          // The fallback is no longer safe; normal fatal cleanup follows.
        }
        if (!this.isCurrent(operation.id)) return false;
        return false;
      }).catch(() => false);
      if (restored) return failedCommand(error);
      if (this.isCurrent(operation.id)) await this.enterFailure(error, operation.id);
      return failedCommand(error);
    } finally {
      if (replacement) this.pendingSessions.delete(replacement);
      if (token) this.forgetCompletedToken(token);
    }
  }

  async disconnect(): Promise<CommandResult> {
    this.connectionIntentRevision += 1;
    this.startupStopRequests += 1;
    this.credentialsAllowed = false;
    try {
      await this.initialize();
    } finally {
      this.startupStopRequests -= 1;
    }
    if (!this.startupStorageLoaded) return failedCommand(new LocalError("storage_unavailable"));
    return this.trackStartupRecoveryCommand(this.disconnectInitialized());
  }

  private async disconnectInitialized(): Promise<CommandResult> {
    const operation = this.startOperation();
    const token = this.persisted.auth?.accessToken;
    const revoke = [
      ...(this.activeSession ? [this.activeSession.id] : []),
      ...this.retiredSessionIds(),
      ...[...this.pendingSessions]
        .filter(([, creatingToken]) => creatingToken === token)
        .map(([session]) => session.id),
      ...[...(token ? (this.remoteSessions.get(token)?.entries() ?? []) : [])]
        .filter(([, session]) => session.userId === this.persisted.profile?.userId)
        .map(([sessionId]) => sessionId),
    ];
    this.credentialsAllowed = false;
    this.activeSession = null;
    this.publish({
      status: "disconnecting",
      protected: false,
      error: null,
      retryAfterSeconds: null,
    });
    let result: CommandResult = { ok: true };
    const cleanupState = { preserveUnknownCredentials: false };
    try {
      await this.withStateMutation(async () => {
        this.assertCurrent(operation.id);
        const cleanupDurable = await this.prepareCleanupBeforeStop(operation.id);
        cleanupState.preserveUnknownCredentials = !cleanupDurable;
        this.assertCurrent(operation.id);
        if (token)
          revoke.push(
            ...[...(this.remoteSessions.get(token)?.entries() ?? [])]
              .filter(([, session]) => session.userId === this.persisted.profile?.userId)
              .map(([sessionId]) => sessionId),
          );
        await this.releaseProtection(operation.id, cleanupDurable);
        this.persisted = { ...this.persisted, autoConnect: false };
        await this.dependencies.storage.writePersisted(this.persisted);
        this.assertCurrent(operation.id);
        if (!cleanupDurable) result = failedCommand(new SafetyError("traffic_guard_failed"));
        this.publish({
          status: this.persisted.auth ? "disconnected" : "logged_out",
          protected: false,
          activeLocationId: null,
          autoConnect: false,
          error: cleanupDurable ? null : "traffic_guard_failed",
        });
      });
    } catch (error) {
      if (this.isCurrent(operation.id)) {
        if (cleanupState.preserveUnknownCredentials) {
          // Failure to record cleanup uncertainty must not erase the only
          // remaining legacy IDs through enterFailure's terminal cleanup.
          await this.inspectSafety();
          this.publish({ protected: false, error: mapError(error) });
        } else await this.enterFailure(error, operation.id, false);
        result = failedCommand(error);
      } else result = supersededCommand();
    }
    void this.safeRevokeMany(revoke, token);
    return result;
  }

  private trackStartupRecoveryCommand(command: Promise<CommandResult>): Promise<CommandResult> {
    if (this.startupSecondaryStorageLoaded && this.startupGuardFailure === null) return command;
    this.startupRecoveryCommands.add(command);
    const finished = () => {
      this.startupRecoveryCommands.delete(command);
    };
    void command.then(finished, finished);
    return command;
  }

  logout(): Promise<CommandResult> {
    this.connectionIntentRevision += 1;
    if (this.logoutInProgress && this.accountGeneration === this.logoutGeneration)
      return this.logoutInProgress;
    this.logoutGeneration = this.accountGeneration;
    const diagnosticGeneration = this.beginDiagnosticAccountChange();
    const logout = this.performLogout(diagnosticGeneration);
    this.logoutInProgress = logout;
    void logout
      .finally(() => {
        if (this.logoutInProgress === logout) this.logoutInProgress = null;
      })
      .catch(() => undefined);
    return logout;
  }

  private async performLogout(diagnosticGeneration: number): Promise<CommandResult> {
    this.startupStopRequests += 1;
    this.credentialsAllowed = false;
    try {
      await this.initialize();
    } finally {
      this.startupStopRequests -= 1;
    }
    if (!this.startupStorageLoaded) {
      // No account could be read, so none was left: its diagnostics are not changing.
      this.endDiagnosticAccountChange(diagnosticGeneration);
      return failedCommand(new LocalError("storage_unavailable"));
    }
    return this.trackStartupRecoveryCommand(this.logoutInitialized());
  }

  private async logoutInitialized(): Promise<CommandResult> {
    if (!this.persisted.auth && this.snapshot.logoutOutcome && this.logoutLocalCleanupPending)
      return this.retryLocalLogoutCleanup();
    if (!this.persisted.auth && this.snapshot.logoutOutcome)
      return this.security.protectionRequested || this.safetyStatus.trafficBlocked
        ? { ok: false, commandError: this.snapshot.error ?? "traffic_guard_failed" }
        : { ok: true };
    const operation = this.startOperation();
    this.cancelAccountRefreshes();
    this.credentialsAllowed = false;
    const accountSignal = this.accountAbort.signal;
    const logoutSequence = ++this.logoutSequence;
    const token = this.persisted.auth?.accessToken;
    let unreadStartupCleanup = !this.startupSecondaryStorageLoaded;
    const logoutAccount =
      token && this.persisted.profile ? { token, userId: this.persisted.profile.userId } : null;
    if (unreadStartupCleanup) {
      try {
        await this.withStateMutation(async () => {
          this.assertCurrent(operation.id);
          const transient = await this.dependencies.storage.readTransient();
          this.assertCurrent(operation.id);
          if (transient.cleanupUncertain) await this.recordCleanupUncertainty();
          await this.cleanup.initialize();
          this.assertCurrent(operation.id);
          const owner = this.persisted.profile?.userId;
          const sessions = [
            ...(transient.proxySession ? [transient.proxySession] : []),
            ...transient.retiredSessions.map((session) => ({
              id: session.sessionId,
              expiresAt: session.expiresAt,
            })),
          ];
          for (const session of sessions) {
            if (!token || !owner) throw new LocalError("storage_unavailable");
            await this.cleanup.add(owner, session);
            this.assertCurrent(operation.id);
            this.rememberRemoteSession(token, session, 0, owner);
          }
          this.restoreCleanupForAccount();
          unreadStartupCleanup = false;
        });
      } catch {
        // Explicit logout still removes local credentials, while reporting unknown cleanup.
      }
      if (!this.isCurrent(operation.id)) return supersededCommand();
    }
    // A superseded authentication may already hold an issued token which no
    // account published. From here on, this logout owns its revocation.
    const abandonedTokens = [...new Set(this.unpublishedAuthentications.values())].filter(
      (abandoned) => abandoned !== token,
    );
    this.unpublishedAuthentications.clear();
    this.lapseHistoricalCleanup();
    const creationCutoff = this.creationSequence;
    if (token)
      this.activeRemoteCleanups.set(token, (this.activeRemoteCleanups.get(token) ?? 0) + 1);
    const creations = [...this.proxyCreations].filter((creation) => creation.token === token);
    if (token) {
      if (this.activeSession) this.rememberRemoteSession(token, this.activeSession, 0);
      for (const session of this.retiredSessions)
        this.rememberRemoteSession(
          token,
          { id: session.sessionId, expiresAt: session.expiresAt },
          0,
        );
      const knownMarker =
        this.creationMarkerOwner > 0 &&
        [...(this.remoteSessions.get(token)?.values() ?? [])].some(
          (session) => session.sequence === this.creationMarkerOwner,
        );
      // A creation marker which a refusal keeps standing after its session has expired
      // has nothing left to report: the historical marker ended with that session.
      if (
        this.security.proxyCreationUncertain &&
        this.historicalCleanupUncertain &&
        creations.length === 0 &&
        !knownMarker
      )
        this.uncertainCreationTokens.add(token);
      if (this.historicalCleanupUncertain || unreadStartupCleanup)
        this.uncertainCreationTokens.add(token);
    }
    const logoutOutcome: LogoutOutcome = { apiSession: "pending", proxySessions: "pending" };
    this.credentialsAllowed = false;
    this.activeSession = null;
    this.persisted = { ...EMPTY_PERSISTED_STATE };
    this.logoutLocalCleanupPending = true;
    this.publish({ status: "disconnecting", protected: false, error: null, logoutOutcome });
    let releaseError: unknown = null;
    const cleanupState = { preserveUnknown: false };
    await this.withStateMutation(async () => {
      this.assertCurrent(operation.id);
      let cleanupDurable = !unreadStartupCleanup;
      if (unreadStartupCleanup) {
        this.raiseHistoricalCleanup();
        this.security = { ...this.security, proxyCleanupUncertain: true };
        try {
          // Unknown legacy credentials may be erased by the explicit local stop below.
          // Record their unresolved remote cleanup before removing the only local copy.
          await this.writeSecurity();
          cleanupDurable = true;
          // That durable unknown replaces a ledger record nobody can read, which would
          // otherwise refuse every later startup.
          await this.cleanup.resetInvalid().catch(() => undefined);
        } catch (error) {
          releaseError = error;
        }
        this.assertCurrent(operation.id);
      }
      cleanupState.preserveUnknown = !cleanupDurable;
      if (!cleanupDurable) this.logoutUnmigratedAccount = logoutAccount;
      try {
        await this.releaseProtection(operation.id, cleanupDurable);
      } catch (error) {
        releaseError ??= error;
      }
      if (cleanupDurable) await this.clearLocalLogout(operation.id, logoutOutcome);
    }).catch((error: unknown) => {
      releaseError = error;
    });
    if (releaseError && this.isCurrent(operation.id) && !cleanupState.preserveUnknown)
      await this.enterFailure(releaseError, operation.id, false);
    else if (releaseError && this.isCurrent(operation.id)) {
      await this.inspectSafety();
      this.publish({ protected: false, error: mapError(releaseError) });
    }
    // A pending POST must be allowed to return its ID before this token is
    // invalidated. These bounded waits never hold the state mutation lock.
    const timeoutMs = this.dependencies.remoteCleanupTimeoutMs ?? API_TIMEOUT_MS;
    const settled = await beforeDeadline(
      Promise.all(creations.map((creation) => creation.settled)),
      timeoutMs,
    );
    let proxySessions: RemoteResult =
      settled.completed &&
      !unreadStartupCleanup &&
      !this.historicalCleanupUncertain &&
      creations.every((creation) => creation.outcome !== "uncertain") &&
      (!token || !this.uncertainCreationTokens.has(token))
        ? "confirmed"
        : "unconfirmed";
    if (token) {
      const known = [...(this.remoteSessions.get(token) ?? [])]
        .filter(([, session]) => session.sequence <= creationCutoff)
        .map(([id]) => id);
      const revoked = await beforeDeadline(
        Promise.all(known.map((id) => this.revokeRemoteSession(token, id))),
        timeoutMs,
      );
      if (!revoked.completed || revoked.value.some((result) => result !== "confirmed"))
        proxySessions = "unconfirmed";
    }
    // Settled creations of this token have left proxyCreations: any remaining
    // POST, such as one an earlier logout timed out on, may still return an ID.
    if (this.cleanup.hasOutstanding() || this.proxyCreations.size > 0)
      proxySessions = "unconfirmed";
    this.publishLogoutOutcome(logoutSequence, accountSignal, { proxySessions });
    // Tokens abandoned until now are reported too: this logout awaits those
    // still being revoked, and retries those whose revocation failed.
    const unconfirmedTokens = [...this.unconfirmedApiTokens];
    this.unconfirmedApiTokens.clear();
    const apiTokens = new Set([
      ...(token ? [token] : []),
      ...abandonedTokens,
      ...unconfirmedTokens,
    ]);
    const apiResults = await Promise.all([
      ...[...apiTokens].map((apiToken) => this.revokeApiSession(apiToken)),
      ...this.abandonedApiRevocations,
    ]);
    // A token abandoned meanwhile cannot be confirmed revoked either.
    const apiSession: RemoteResult =
      apiResults.every((result) => result === "confirmed") && this.unconfirmedApiTokens.size === 0
        ? "confirmed"
        : "unconfirmed";
    this.publishLogoutOutcome(logoutSequence, accountSignal, { apiSession });
    if (!accountSignal.aborted && logoutSequence === this.logoutSequence) {
      await this.withStateMutation(async () => {
        if (accountSignal.aborted || logoutSequence !== this.logoutSequence) return;
        // Known failed revocations remain in the ledger. Only missing IDs or
        // unresolved creations require the separate durable unknown marker.
        this.historicalCleanupUncertain ||=
          unreadStartupCleanup ||
          creations.some((creation) => creation.outcome === "uncertain") ||
          (!!token && this.uncertainCreationTokens.has(token));
        // Whatever raised it was dated then: only a marker left without a date gets one.
        if (this.historicalCleanupUncertain)
          this.historicalCleanupUntil ??= this.dependencies.now() + PROXY_CREATION_UNCERTAINTY_MS;
        this.security = { ...this.security, proxyCleanupUncertain: this.cleanupUncertain() };
        await this.writeSecurity();
      }).catch(() => undefined);
    }
    if (token) {
      this.activeRemoteCleanups.set(token, (this.activeRemoteCleanups.get(token) ?? 1) - 1);
      this.cleanupRequestedTokens.add(token);
      this.forgetCompletedToken(token);
    }
    if (accountSignal.aborted || logoutSequence !== this.logoutSequence) return supersededCommand();
    return releaseError ? failedCommand(releaseError) : { ok: true };
  }

  /** Caller holds stateMutation; a missing in-memory token never confirms durable removal. */
  private async clearLocalLogout(id: number, logoutOutcome: LogoutOutcome): Promise<void> {
    this.assertCurrent(id);
    try {
      await this.dependencies.storage.clearPersisted();
    } catch {
      throw new LocalError("storage_unavailable");
    }
    this.assertCurrent(id);
    this.logoutLocalCleanupPending = false;
    this.logoutUnmigratedAccount = null;
    this.snapshot = { ...EMPTY_SNAPSHOT, logoutOutcome };
    this.emit();
  }

  private async retryLocalLogoutCleanup(): Promise<CommandResult> {
    const outcome = this.snapshot.logoutOutcome;
    if (!outcome) return failedCommand(new LocalError("storage_unavailable"));
    const operation = this.startOperation();
    const generation = this.accountGeneration;
    this.cancelAccountRefreshes();
    let failure: unknown = null;
    const cleanupState = { preserveUnknown: false };
    await this.withStateMutation(async () => {
      this.assertCurrent(operation.id);
      try {
        const cleanupDurable = await this.prepareCleanupBeforeStop(operation.id);
        cleanupState.preserveUnknown = !cleanupDurable;
        await this.releaseProtection(operation.id, cleanupDurable);
        if (!cleanupDurable) throw new SafetyError("traffic_guard_failed");
      } catch (error) {
        failure = error;
      }
      if (!cleanupState.preserveUnknown) await this.clearLocalLogout(operation.id, outcome);
    }).catch((error: unknown) => {
      failure = error;
    });
    if (!this.isCurrent(operation.id)) return supersededCommand();
    if (failure && !cleanupState.preserveUnknown)
      await this.enterFailure(failure, operation.id, false);
    if (generation !== this.accountGeneration) return supersededCommand();
    return failure ? failedCommand(failure) : { ok: true };
  }

  /** Bounded API logout; an unsent or unanswered revocation is never confirmed. */
  private async revokeApiSession(token: string): Promise<RemoteResult> {
    // An authenticator may reuse a token. Never invalidate a newer login
    // which is committing or currently using exactly this credential.
    if (this.isApiTokenInUse(token)) return "unconfirmed";
    const result = await beforeDeadline(
      this.dependencies.api.logout(token).then(
        () => "confirmed" as const,
        () => "unconfirmed" as const,
      ),
      this.dependencies.remoteCleanupTimeoutMs ?? API_TIMEOUT_MS,
    );
    return result.completed ? result.value : "unconfirmed";
  }

  private isApiTokenInUse(token: string): boolean {
    return (
      this.persisted.auth?.accessToken === token ||
      [...this.unpublishedAuthentications.values()].includes(token)
    );
  }

  /** Revokes a token no account owns without delaying its command; logout reports it. */
  private abandonApiSession(token: string): void {
    const revocation = this.revokeApiSession(token);
    const settle = (result: RemoteResult) => {
      this.abandonedApiRevocations.delete(revocation);
      // A reused token is revoked by its new owner.
      if (result === "confirmed" || this.isApiTokenInUse(token)) return;
      this.unconfirmedApiTokens.add(token);
      // A logout outcome already shown cannot have confirmed this token.
      const outcome = this.snapshot.logoutOutcome;
      if (outcome?.apiSession === "confirmed" && !this.persisted.auth)
        this.publish({ logoutOutcome: { ...outcome, apiSession: "unconfirmed" } });
    };
    this.abandonedApiRevocations.add(revocation);
    void revocation.then(settle, () => settle("unconfirmed"));
  }

  private publishLogoutOutcome(
    sequence: number,
    accountSignal: AbortSignal,
    result: Partial<LogoutOutcome>,
  ): void {
    if (sequence !== this.logoutSequence || accountSignal.aborted || this.persisted.auth) return;
    this.publish({
      logoutOutcome: {
        apiSession: "pending",
        proxySessions: "pending",
        ...this.snapshot.logoutOutcome,
        ...result,
      },
    });
  }

  async updateSecurityPreferences(
    killSwitchEnabled: boolean,
    webRtcProtectionEnabled: boolean,
    observer = this.captureConnectionObserver(),
  ): Promise<CommandResult> {
    await this.initialize(observer);
    if (!this.startupSecondaryStorageLoaded)
      return failedCommand(new LocalError("storage_unavailable"));
    const operation = this.startOperation(observer);
    if (this.startupGuardFailure) {
      // A refused startup guard owns a durable, still usable session. Persist
      // preferences and retry restoration instead of entering terminal cleanup.
      try {
        await this.withStateMutation(async () => {
          this.assertCurrent(operation.id);
          await this.writeSecurityPreferences(killSwitchEnabled, webRtcProtectionEnabled);
          this.assertCurrent(operation.id);
        });
        this.assertCurrent(operation.id);
        // A restoration which another event started during that write is never dropped:
        // two at once tear each other down. It ends first.
        const racing = this.initialization;
        if (racing) {
          await racing.catch(() => undefined);
          // It repaired the guard, possibly under the previous preferences: apply these
          // to its outcome like any other preference change.
          if (!this.startupGuardRefused())
            return await this.updateSecurityPreferences(
              killSwitchEnabled,
              webRtcProtectionEnabled,
              observer,
            );
        }
        // Only a settled restoration is replaced by the retry.
        if (this.initialization === racing) this.initialization = null;
        await this.initialize(observer);
        return this.startupRecoveryResult();
      } catch (error) {
        if (!this.isCurrent(operation.id)) return supersededCommand();
        this.publish({ protected: false, error: mapError(error) });
        return failedCommand(error);
      }
    }
    try {
      await this.withStateMutation(async () => {
        this.assertCurrent(operation.id);
        // Commit before applying: a restart must retry the requested preference.
        await this.writeSecurityPreferences(killSwitchEnabled, webRtcProtectionEnabled);
        this.assertCurrent(operation.id);
        if (this.security.protectionRequested) {
          await this.blockSafety(killSwitchEnabled);
          this.assertCurrent(operation.id);
          if (
            this.activeSession?.id === this.authorizedSessionId &&
            !this.isProxyExpired(this.activeSession) &&
            (await this.dependencies.proxy.isActiveConfiguration(this.activeSession))
          ) {
            await this.authorizeSession(this.activeSession, operation.id);
            await this.scheduleRetainedSession(this.activeSession, operation.id);
          } else {
            this.activeSession = null;
            this.credentialsAllowed = false;
            if (!this.requiresBlockingGuard()) await this.dependencies.proxy.clear();
          }
        } else {
          if (this.exclusions.pending || this.exclusions.getState().error)
            await this.blockSafety(true);
          else {
            await this.dependencies.safety.setWebRtc(false);
            await this.dependencies.safety.release();
          }
        }
        this.assertCurrent(operation.id);
        await this.inspectSafety();
        // A TLS refusal received after authorization still forbids protection.
        if (this.activeSession) this.assertNoProxyRefusal(this.activeSession);
        this.publish({
          status: this.activeSession
            ? "connected"
            : this.persisted.auth
              ? "disconnected"
              : "logged_out",
          protected: !!this.activeSession,
          error: null,
        });
      });
      if (
        this.security.protectionRequested &&
        !this.activeSession &&
        this.hasValidApiSession() &&
        !this.security.nextRetryAt &&
        !this.security.proxyCreationUncertain &&
        !this.security.retrySuspended
      )
        // The reconnection stays bound to the history this command started in.
        return await this.connectInitialized(this.security.selectedLocationId, false, observer);
      return { ok: true };
    } catch (error) {
      if (!this.isCurrent(operation.id)) return supersededCommand();
      await this.enterFailure(error, operation.id);
      return failedCommand(error);
    }
  }

  /** Read through a method: a restoration awaited meanwhile may have repaired it. */
  private startupGuardRefused(): boolean {
    return this.startupGuardFailure !== null;
  }

  /**
   * Caller holds stateMutation. Preferences which could not be stored are neither in
   * force nor published: the next worker would read the previous ones.
   */
  private async writeSecurityPreferences(
    killSwitchEnabled: boolean,
    webRtcProtectionEnabled: boolean,
  ): Promise<void> {
    const previous = this.security;
    const changed = { ...previous, killSwitchEnabled, webRtcProtectionEnabled };
    this.security = changed;
    try {
      await this.writeSecurity();
    } catch (error) {
      if (this.security === changed) this.security = previous;
      throw error;
    }
  }

  async retryConnection(
    automatic = false,
    observer = this.captureConnectionObserver(),
  ): Promise<CommandResult> {
    if (!automatic) this.connectionIntentRevision += 1;
    await this.initialize(observer);
    if (!this.startupSecondaryStorageLoaded)
      return failedCommand(new LocalError("storage_unavailable"));
    if (this.startupGuardFailure) return { ok: false, commandError: this.startupGuardFailure };
    if (!this.security.protectionRequested) return { ok: true };
    if (automatic && this.security.capacityBlockedLocationId)
      return { ok: false, commandError: "server_full" };
    if (!automatic) await this.clearCapacityBlock();
    if (!this.hasValidApiSession()) {
      await this.clearInvalidAccount("unauthorized");
      return { ok: false, commandError: "unauthorized" };
    }
    if (this.security.retryNotBefore && this.security.retryNotBefore > this.dependencies.now()) {
      if (this.security.proxyCreationUncertain) {
        this.publish({ error: "rate_limited" });
        return { ok: false, commandError: "rate_limited" };
      }
      await this.withStateMutation(async () => {
        this.security = {
          ...this.security,
          nextRetryAt: this.security.retryNotBefore,
          retrySuspended: false,
        };
        await this.writeSecurity();
        await this.dependencies.alarms.scheduleReconnect(
          this.security.retryNotBefore ?? this.dependencies.now(),
        );
        this.publish({});
      });
      return { ok: false, commandError: "rate_limited" };
    }
    if (
      this.activeSession?.id === this.authorizedSessionId &&
      !this.isProxyExpired(this.activeSession)
    )
      return this.refreshProxySession(!automatic, observer);
    return await this.connectInitialized(this.security.selectedLocationId, !automatic, observer);
  }

  async handlePrivacyChange(): Promise<void> {
    await this.initialize();
    if (!this.startupSecondaryStorageLoaded) return;
    if (this.startupGuardFailure) return;
    const id = this.operationId;
    const inspection: {
      failure: "traffic_guard_failed" | "webrtc_control_unavailable" | null;
    } = { failure: null };
    await this.withStateMutation(async () => {
      this.assertCurrent(id);
      await this.inspectSafety();
      this.assertCurrent(id);
      const guardRequired =
        this.security.protectionRequested ||
        this.exclusions.pending ||
        this.exclusions.getState().error;
      const webRtcRequired =
        (this.security.protectionRequested && this.security.webRtcProtectionEnabled) ||
        this.requiresTemporaryWebRtcProtection();
      if (webRtcRequired && !this.safetyStatus.webRtcProtected) {
        // A temporary blocked route needs RTC confinement even when the user's
        // optional setting for an authorized session is disabled.
        await this.dependencies.safety.setWebRtc(true).catch(() => undefined);
        this.assertCurrent(id);
        await this.inspectSafety();
        this.assertCurrent(id);
      }
      if (guardRequired) {
        if (!this.safetyStatus.filterActive) inspection.failure = "traffic_guard_failed";
        else if (webRtcRequired && !this.safetyStatus.webRtcProtected)
          inspection.failure = "webrtc_control_unavailable";
      }
      this.publish(inspection.failure ? { protected: false, error: inspection.failure } : {});
    });
    if (!this.isCurrent(id) || !this.security.protectionRequested) return;
    if (inspection.failure) await this.enterFailure(new SafetyError(inspection.failure), id);
  }

  async resendVerification(): Promise<CommandResult> {
    await this.initialize();
    if (!this.startupSecondaryStorageLoaded)
      return failedCommand(new LocalError("storage_unavailable"));
    const operation = { id: this.operationId, signal: this.accountAbort.signal };
    try {
      await this.dependencies.api.resendVerification(this.requireToken(), operation.signal);
      this.assertCurrent(operation.id);
      assertNotAborted(operation.signal);
      this.publish({
        status: this.snapshot.status,
        error: this.connectionErrorToKeep(),
        retryAfterSeconds: null,
      });
      return { ok: true };
    } catch (error) {
      if (!this.isCurrent(operation.id) || operation.signal.aborted) return supersededCommand();
      await this.handleOperationError(error, this.snapshot.protected);
      return failedCommand(error);
    }
  }

  async refreshAccount(): Promise<CommandResult> {
    const observer = this.captureConnectionObserver();
    const trace = this.captureConnectionTrace(this.operationId, observer);
    await this.initialize(observer);
    if (!this.startupSecondaryStorageLoaded)
      return failedCommand(new LocalError("storage_unavailable"));
    const operation = { id: this.operationId, signal: this.accountAbort.signal };
    try {
      if (!(await this.hydrateAccount(operation.signal, trace))) return supersededCommand();
      this.assertCurrent(operation.id);
      const kept = this.connectionErrorToKeep();
      this.publish({
        status: this.snapshot.status,
        protected: this.snapshot.protected,
        error:
          this.deviceQuotaError ??
          (isCapacityErrorCode(this.snapshot.error) ? this.snapshot.error : kept),
      });
      return { ok: true };
    } catch (error) {
      if (!this.isCurrent(operation.id)) return supersededCommand();
      await this.handleOperationError(error, this.snapshot.protected);
      return failedCommand(error);
    }
  }

  /** Refresh only the selectable catalog, without disturbing a connection error or intent. */
  async refreshLocations(): Promise<CommandResult> {
    const observer = this.captureConnectionObserver();
    const trace = this.captureConnectionTrace(this.operationId, observer);
    await this.initialize(observer);
    if (!this.startupSecondaryStorageLoaded)
      return failedCommand(new LocalError("storage_unavailable"));
    const signal = this.accountAbort.signal;
    try {
      await this.loadLocations(false, undefined, trace);
      assertNotAborted(signal);
      return { ok: true };
    } catch (error) {
      if (signal.aborted) return supersededCommand();
      if (isUnauthorized(error)) await this.handleOperationError(error, this.snapshot.protected);
      // Catalog failures have their own UI state and do not change VPN protection.
      return failedCommand(error);
    }
  }

  async refreshDevices(): Promise<CommandResult> {
    await this.initialize();
    if (!this.startupSecondaryStorageLoaded)
      return failedCommand(new LocalError("storage_unavailable"));
    const operation = { id: this.operationId, signal: this.accountAbort.signal };
    const revision = ++this.deviceListRevision;
    try {
      const token = this.requireToken();
      const userId = this.requireUserId();
      const result = await this.dependencies.api.getDevices(token, operation.signal);
      this.assertCurrent(operation.id);
      if (revision !== this.deviceListRevision) return supersededCommand();
      const currentDeviceId = await this.findBrowserDevice(
        userId,
        token,
        operation.signal,
        result.devices,
      );
      this.assertCurrent(operation.id);
      if (revision !== this.deviceListRevision) return supersededCommand();
      const kept = this.connectionErrorToKeep();
      this.publish({
        devices: result.devices,
        deviceLimit: result.limit,
        currentDeviceId,
        error:
          this.deviceQuotaError ??
          (isDeviceQuota(this.snapshot.error) ? this.snapshot.error : kept),
      });
      return { ok: true };
    } catch (error) {
      if (
        !this.isCurrent(operation.id) ||
        operation.signal.aborted ||
        revision !== this.deviceListRevision
      )
        return supersededCommand();
      await this.handleOperationError(error, this.snapshot.protected);
      return failedCommand(error);
    }
  }

  /** Reads the choice of the account for the ad blocker. */
  refreshAdBlocking(): Promise<CommandResult> {
    return this.adBlockingRequest((token, signal) =>
      this.dependencies.api.getAdBlocking(token, signal),
    );
  }

  /** Records the choice of the account: the service applies it to all its devices. */
  setAdBlocking(enabled: boolean): Promise<CommandResult> {
    return this.adBlockingRequest((token, signal) =>
      this.dependencies.api.setAdBlocking(token, enabled, signal),
    );
  }

  /**
   * A read or a change of the ad blocker, which publishes the state the service answers.
   * They are sent in the order they were asked: a read which overtook a change would
   * show the choice it replaced.
   */
  private async adBlockingRequest(
    call: (token: string, signal: AbortSignal) => Promise<AdBlockingChoice>,
  ): Promise<CommandResult> {
    await this.initialize();
    if (!this.startupSecondaryStorageLoaded)
      return failedCommand(new LocalError("storage_unavailable"));
    const signal = this.accountAbort.signal;
    const run = async (): Promise<CommandResult> => {
      try {
        assertNotAborted(signal);
        const userId = this.requireUserId();
        const choice = await call(this.requireToken(), signal);
        assertNotAborted(signal);
        this.adBlockingUserId = userId;
        this.publish({ adBlocking: { enabled: choice.enabled, available: choice.available } });
        return { ok: true };
      } catch (error) {
        if (signal.aborted) return supersededCommand();
        // As for the catalogue: only a refused credential concerns the account. Any
        // other failure is the caller's to show, and changes nothing of the connection.
        if (isUnauthorized(error)) await this.handleOperationError(error, this.snapshot.protected);
        return failedCommand(error);
      }
    };
    const result = this.adBlockingRequests.then(run, run);
    this.adBlockingRequests = result.catch(() => undefined);
    return result;
  }

  async deleteDevice(
    deviceId: string,
    observer = this.captureConnectionObserver(),
  ): Promise<CommandResult> {
    await this.initialize(observer);
    if (!this.startupSecondaryStorageLoaded)
      return failedCommand(new LocalError("storage_unavailable"));
    let key: string;
    try {
      key = JSON.stringify([this.requireUserId(), this.accountGeneration, deviceId]);
    } catch (error) {
      // Like every command, an account without a profile is a result, not a rejection.
      // Nothing else changes: this command neither clears that account nor replaces
      // what a logout in progress is publishing.
      return failedCommand(error);
    }
    const pending = this.deviceDeletionCommands.get(key);
    if (pending) return pending;
    const command = this.performDeleteDevice(deviceId, observer);
    this.deviceDeletionCommands.set(key, command);
    try {
      return await command;
    } finally {
      if (this.deviceDeletionCommands.get(key) === command) this.deviceDeletionCommands.delete(key);
    }
  }

  private async performDeleteDevice(
    deviceId: string,
    observer: ConnectionRecorder,
  ): Promise<CommandResult> {
    const accountSignal = this.accountAbort.signal;
    const accountGeneration = this.accountGeneration;
    let token: string;
    let userId: string;
    try {
      token = this.requireToken();
      userId = this.requireUserId();
    } catch (error) {
      return failedCommand(error);
    }
    const initialId = this.operationId;
    let intentRevision = this.connectionIntentRevision;
    const resumeAfterQuota =
      this.security.protectionRequested &&
      (this.deviceQuotaError !== null || isDeviceQuota(this.snapshot.error));
    let currentDeviceId: string | null;
    try {
      currentDeviceId = await this.findBrowserDevice(userId, token, accountSignal);
    } catch (error) {
      if (accountSignal.aborted || this.connectionIntentRevision !== intentRevision)
        return supersededCommand();
      await this.handleOperationError(error, this.snapshot.protected);
      return failedCommand(error);
    }
    if (accountSignal.aborted || this.connectionIntentRevision !== intentRevision)
      return supersededCommand();
    const deletingCurrent = currentDeviceId === deviceId;
    let finishDeletion: (() => void) | undefined;
    let deletion: Promise<void> | undefined;
    if (deletingCurrent) {
      const pending = this.deviceDeletions.get(userId);
      if (pending) {
        await pending;
        return supersededCommand();
      }
      deletion = new Promise<void>((resolve) => {
        finishDeletion = resolve;
      });
      this.deviceDeletions.set(userId, deletion);
    }
    try {
      if (deletingCurrent) {
        const disconnected = await this.disconnect();
        if (!disconnected.ok) return disconnected;
        if (!this.isCurrent(initialId + 1)) return supersededCommand();
        intentRevision = this.connectionIntentRevision;
      }
      const operation = { id: this.operationId, signal: accountSignal };
      // A sibling deletion's quota recovery advances the operation id without
      // replacing this account or intent, so it supersedes no reply to this DELETE.
      const ownsDeletion = () =>
        this.connectionIntentRevision === intentRevision &&
        !accountSignal.aborted &&
        this.accountGeneration === accountGeneration &&
        this.persisted.profile?.userId === userId &&
        this.persisted.auth?.accessToken === token &&
        (this.isCurrent(operation.id) ||
          (resumeAfterQuota && !this.activeSession && this.security.protectionRequested));
      ++this.deviceListRevision;
      try {
        await this.dependencies.api.deleteDevice(token, deviceId, operation.signal);
      } catch (error) {
        // An idempotent 404 confirms the absence like 204 and keeps its slot credit.
        if (!(error instanceof ApiError && error.status === 404 && error.code === "not_found")) {
          // Only an account rejection preempts a sibling's pending quota recovery;
          // a remote-device failure reports after it rather than overwriting it.
          let sibling: Promise<CommandResult> | null;
          while (
            !deletingCurrent &&
            !isUnauthorized(error) &&
            (sibling = this.siblingQuotaRecovery(intentRevision, accountGeneration)) !== null
          )
            await sibling;
          if (!ownsDeletion()) return supersededCommand();
          await this.handleOperationError(error, this.snapshot.protected);
          return failedCommand(error);
        }
      }
      await this.withStateMutation(async () => {
        // A completed current-device deletion still invalidates that identity
        // when another connection intent has arrived in the meantime.
        if (deletingCurrent && (await this.dependencies.identity.getDeviceId(userId)) === deviceId)
          await this.dependencies.identity.clear(userId);
        if (
          !accountSignal.aborted &&
          this.accountGeneration === accountGeneration &&
          this.persisted.profile?.userId === userId
        ) {
          // The server confirmed deletion. Reflect it before the list refresh,
          // whose failure must not leave the deleted device available to retry.
          ++this.deviceListRevision;
          this.publish({
            devices: this.snapshot.devices.filter((device) => device.deviceId !== deviceId),
            currentDeviceId:
              deletingCurrent && this.snapshot.currentDeviceId === deviceId
                ? null
                : this.snapshot.currentDeviceId,
          });
        }
      });
      if (!ownsDeletion()) return supersededCommand();
      const revision = ++this.deviceListRevision;
      let presentationError: unknown = null;
      try {
        const result = await this.dependencies.api.getDevices(token, operation.signal);
        if (!ownsDeletion()) return supersededCommand();
        if (revision === this.deviceListRevision)
          this.publish({
            devices: result.devices,
            deviceLimit: result.limit,
            currentDeviceId: deletingCurrent ? null : currentDeviceId,
            error: null,
          });
      } catch (error) {
        if (!ownsDeletion()) return supersededCommand();
        if (isUnauthorized(error)) {
          await this.handleOperationError(error, this.snapshot.protected);
          return failedCommand(error);
        }
        presentationError = error;
      }
      // The DELETE business action is confirmed. A presentation-only GET (or
      // its replacement by Refresh) cannot cancel using the freed device slot.
      if (
        ownsDeletion() &&
        resumeAfterQuota &&
        !deletingCurrent &&
        this.security.protectionRequested
      ) {
        // Every confirmed DELETE owns one newly freed slot. Serialize their
        // recoveries; a failed quota retry cannot invalidate another deletion.
        let sibling: Promise<CommandResult> | null;
        while ((sibling = this.siblingQuotaRecovery(intentRevision, accountGeneration)) !== null)
          await sibling;
        if (!ownsDeletion() || this.activeSession) return supersededCommand();
        const recovery = {
          intentRevision,
          accountGeneration,
          promise: this.connectInitialized(this.security.selectedLocationId, false, observer),
        };
        this.deviceQuotaRecovery = recovery;
        try {
          return await recovery.promise;
        } finally {
          if (this.deviceQuotaRecovery === recovery) this.deviceQuotaRecovery = null;
        }
      }
      if (presentationError && revision === this.deviceListRevision) {
        await this.handleOperationError(presentationError, this.snapshot.protected);
        return failedCommand(presentationError);
      }
      return { ok: true };
    } finally {
      if (deletion && this.deviceDeletions.get(userId) === deletion)
        this.deviceDeletions.delete(userId);
      finishDeletion?.();
    }
  }

  /**
   * The pending quota recovery of a sibling deletion within this intent and account.
   * Callers loop on it in their own frame: an async wait would yield between finding
   * none and their next step, letting a sibling start a concurrent recovery.
   */
  private siblingQuotaRecovery(
    intentRevision: number,
    accountGeneration: number,
  ): Promise<CommandResult> | null {
    const recovery = this.deviceQuotaRecovery;
    return recovery?.intentRevision === intentRevision &&
      recovery.accountGeneration === accountGeneration
      ? recovery.promise
      : null;
  }

  async resetDeviceIdentity(): Promise<CommandResult> {
    await this.initialize();
    if (!this.startupSecondaryStorageLoaded)
      return failedCommand(new LocalError("storage_unavailable"));
    let userId: string;
    try {
      userId = this.requireUserId();
    } catch (error) {
      return failedCommand(error);
    }
    const initialId = this.operationId;
    const disconnected = await this.disconnect();
    if (!disconnected.ok) return disconnected;
    if (!this.isCurrent(initialId + 1)) return supersededCommand();
    const operation = this.startOperation();
    await this.withStateMutation(async () => {
      this.assertCurrent(operation.id);
      await this.dependencies.identity.clear(userId);
      this.assertCurrent(operation.id);
      // A device-list refresh may have read the old identity while this reset was pending.
      ++this.deviceListRevision;
      this.publish({ currentDeviceId: null, error: null });
    });
    return { ok: true };
  }

  async handleAlarm(name: string, observer = this.captureConnectionObserver()): Promise<void> {
    // On the clock which dates the activation of a session.
    const deliveredAt = performance.now();
    await this.initialize(observer);
    if (!this.startupSecondaryStorageLoaded) return;
    if (name === ALARM_RECONNECT) {
      if (this.security.proxyCreationUncertain) {
        const until = this.security.proxyCreationUncertainUntil;
        if (until === undefined || !this.security.protectionRequested) return;
        if (until > this.dependencies.now()) {
          await this.dependencies.alarms.scheduleReconnect(
            Math.max(until, this.security.nextRetryAt ?? 0),
          );
          return;
        }
        const lapsed = await this.withStateMutation(() =>
          this.lapseCreationUncertainty(!this.activeSession),
        );
        if (!lapsed) {
          // Storage refused the end of the suspension, or a request is still unanswered.
          // The alarm which fired was the last one set: without another, nothing would
          // end the suspension before the next worker starts.
          await this.dependencies.alarms
            .scheduleReconnect(this.dependencies.now() + REFRESH_RETRY_MS)
            .catch(() => undefined);
          return;
        }
      }
      if (!this.security.protectionRequested || !this.security.nextRetryAt) return;
      if (this.security.nextRetryAt > this.dependencies.now()) {
        await this.dependencies.alarms.scheduleReconnect(this.security.nextRetryAt);
        return;
      }
      // An attempt in progress publishes its own outcome and schedules its own retry:
      // the deadline of an earlier failure must not replace it. A "refreshing" status
      // may rest after a renewal which already ended: it defers nothing.
      if (
        this.statusOperation === this.operationId &&
        (this.snapshot.status === "connecting" || this.snapshot.status === "disconnecting")
      )
        return;
      await this.retryConnection(true, observer);
      return;
    }
    if (name === ALARM_EXPIRY) {
      if (this.activeSession && this.isProxyExpired(this.activeSession)) {
        await this.expireSession();
        await this.reconnectAfterExpiry(observer);
      }
      return;
    }
    if (name !== ALARM_REFRESH || !this.activeSession) return;
    // Delivered late, after a sleep for instance, to a worker whose restoration replaced
    // the expired session meanwhile: the alarm was set for that one. The session created
    // since has a renewal of its own, and renewing it now would only create a second one.
    if ((this.sessionActivatedAt.get(this.activeSession) ?? 0) > deliveredAt) return;
    if (this.snapshot.status === "disconnecting") return;
    if (this.snapshot.status === "connecting") {
      const session = this.activeSession;
      const id = this.operationId;
      try {
        await this.withStateMutation(async () => {
          if (!this.isCurrent(id)) return;
          await this.scheduleRetainedSession(
            session,
            id,
            Math.min(
              this.dependencies.now() + REFRESH_RETRY_MS,
              Date.parse(session.expiresAt) - 10_000,
            ),
          );
        });
      } catch (error) {
        if (this.isCurrent(id)) throw error;
      }
      return;
    }
    await this.refreshProxySession(false, observer);
    // A renewal which fires late, after a sleep for instance, finds its session expired.
    await this.reconnectAfterExpiry(observer);
  }

  async handleProxyControlLost(level: ProxyControlLevel): Promise<void> {
    this.proxyControlRevision += 1;
    await this.initialize();
    if (!this.startupSecondaryStorageLoaded) return;
    const id = this.operationId;
    const previous = this.activeSession;
    if (!previous) {
      await this.reverifyGuardRoute(id);
      return;
    }
    if (!this.security.protectionRequested) return;
    // Queue behind our own setting changes, then confirm the complete effective configuration.
    const valid = await this.withStateMutation(async () => {
      if (!this.isCurrent(id) || this.activeSession?.id !== previous.id) return true;
      return this.dependencies.proxy.isActiveConfiguration(previous).catch(() => false);
    });
    if (valid || !this.isCurrent(id)) return;
    const confirmed = await this.dependencies.proxy.getControlLevel().catch(() => level);
    if (!this.isCurrent(id)) return;
    const operation = this.startOperation();
    this.publish({ protected: false });
    try {
      await this.withStateMutation(async () => {
        this.assertCurrent(operation.id);
        await this.blockSafety(this.security.killSwitchEnabled);
        this.assertCurrent(operation.id);
        if (
          confirmed !== "controllable_by_this_extension" &&
          confirmed !== "controlled_by_this_extension"
        )
          throw new ProxyControlError(confirmed);
        if (this.isProxyExpired(previous)) throw new LocalError("session_expired");
        await this.dependencies.proxy.apply(previous);
        this.assertCurrent(operation.id);
        await this.reauthorizeRetainedSession(previous, operation.id);
        this.publish({ status: "connected", protected: true, error: null });
      });
    } catch (error) {
      if (this.isCurrent(operation.id)) await this.enterFailure(error, operation.id);
    }
  }

  /** Without a session to restore, a blocking claim still depends on our guard route. */
  private async reverifyGuardRoute(id: number): Promise<void> {
    // Startup repair already re-inspected every guard while initializing this event.
    if (this.startupGuardFailure) return;
    const inspection: { failure: Error | null } = { failure: null };
    await this.withStateMutation(async () => {
      if (!this.isCurrent(id) || this.activeSession) return;
      if (
        !this.requiresBlockingGuard(
          this.security.protectionRequested && this.security.killSwitchEnabled,
        )
      )
        return;
      if (!(await this.dependencies.proxy.isGuardedConfiguration().catch(() => false))) {
        // Restore our own route when control permits. Another extension's route
        // never counts as the fallback that confines the remaining traffic.
        await this.dependencies.proxy.ensureBlockingConfiguration().catch((error: unknown) => {
          inspection.failure =
            error instanceof Error ? error : new SafetyError("traffic_guard_failed");
        });
        if (!this.isCurrent(id)) return;
      }
      await this.inspectSafety();
      // A takeover only withdraws the confinement claim: the request and WebRTC guards
      // stay closed and a scheduled reconnect keeps its deadline. If control is still
      // missing then, that attempt fails and suspends the automatic retries itself. An
      // attempt in progress keeps its status for the same reason: it checks control again.
      const attempt = this.ownsBusyStatus();
      const displaced =
        this.takeoverDisplacedError?.operation === id ? this.takeoverDisplacedError : null;
      if (inspection.failure) {
        // Keep what the takeover displaced, also when it moves from an extension to a policy.
        if (!displaced || !isProxyControlError(this.snapshot.error))
          this.takeoverDisplacedError = { operation: id, error: this.snapshot.error };
        this.publish({
          ...(attempt ? {} : { status: "error" as const }),
          protected: false,
          error: mapError(inspection.failure),
        });
      } else if (isProxyControlError(this.snapshot.error)) {
        // Our route is effective again: the takeover no longer explains the blocking state.
        // The error it displaced comes back for an attempt in progress (its own error) and
        // for a block that neither a scheduled reconnect nor a capacity block explains, even
        // one recorded during the takeover, which deferred its report. Otherwise a device
        // quota is shown again, or emit() rebuilds a capacity or uncertain-creation block.
        const restored =
          displaced && !isProxyControlError(displaced.error) ? displaced.error : null;
        this.takeoverDisplacedError = null;
        this.publish({
          error:
            attempt ||
            (restored !== null &&
              this.security.nextRetryAt === null &&
              !this.security.capacityBlockedLocationId)
              ? restored
              : this.deviceQuotaError,
        });
      } else this.publish({});
    });
  }

  /**
   * A busy status published by the current operation belongs to a sign-in, connection,
   * renewal or stop still in progress, which publishes its own outcome.
   */
  private ownsBusyStatus(): boolean {
    return (
      this.statusOperation === this.operationId &&
      (this.snapshot.status === "connecting" ||
        this.snapshot.status === "refreshing" ||
        this.snapshot.status === "disconnecting")
    );
  }

  async handleProxyError(
    error: string,
    _fatal: boolean,
    provenance?: ProxyErrorProvenance,
  ): Promise<void> {
    const observedSession = this.activeSession;
    const observedOperation = this.operationId;
    if (observedSession && provenance && this.isHistoricalProxyError(observedSession, provenance))
      return;
    if (
      provenance &&
      observedSession &&
      (error === "proxy_tls_error" || isProxyCertificateError(error)) &&
      provenance.host.toLowerCase() === observedSession.host.toLowerCase() &&
      provenance.port === observedSession.port
    ) {
      // Refuse before any await: an operation installing or retaining this
      // session must neither authorize it nor publish protection after delivery.
      this.sessionProxyRefusals.set(
        observedSession,
        isProxyCertificateError(error) ? "proxy_certificate_invalid" : "proxy_unavailable",
      );
      // The refused session is active: stop displaying it as protected even if
      // its termination below waits for, or cannot obtain, route verification.
      if (this.snapshot.protected) this.publish({ protected: false });
    }
    // A session kept for the startup repairing a refusal is not active either: its endpoint's
    // failures wait for that startup too.
    if (
      provenance &&
      ((!observedSession && !this.startupSecondaryStorageLoaded) ||
        this.startupInProgress ||
        this.startupGuardFailure !== null) &&
      (error === "proxy_tls_error" || isProxyCertificateError(error))
    ) {
      const host = provenance.host.toLowerCase();
      if (
        !this.startupProxyFailures.some(
          (failure) => failure.host === host && failure.port === provenance.port,
        )
      ) {
        if (this.startupProxyFailures.length < 128)
          this.startupProxyFailures.push({
            generation: this.startupGeneration || 1,
            error: isProxyCertificateError(error)
              ? "proxy_certificate_invalid"
              : "proxy_unavailable",
            host,
            port: provenance.port,
          });
        else this.startupProxyFailureOverflow = true;
      }
    }
    await this.initialize();
    if (!this.startupSecondaryStorageLoaded) return;
    if (provenance) {
      if (error !== "proxy_tls_error" && !isProxyCertificateError(error)) return;
      if (
        !observedSession ||
        !this.isCurrent(observedOperation) ||
        this.activeSession !== observedSession ||
        this.isHistoricalProxyError(observedSession, provenance) ||
        provenance.host.toLowerCase() !== observedSession.host.toLowerCase() ||
        provenance.port !== observedSession.port
      )
        return;
      const current = await this.withStateMutation(async () => {
        if (
          !this.isCurrent(observedOperation) ||
          this.activeSession !== observedSession ||
          this.isHistoricalProxyError(observedSession, provenance)
        )
          return false;
        return this.dependencies.proxy.isActiveConfiguration(observedSession).catch(() => false);
      });
      if (
        !current ||
        !this.isCurrent(observedOperation) ||
        this.activeSession !== observedSession ||
        this.isHistoricalProxyError(observedSession, provenance)
      )
        return;
      await this.failActiveSession(
        isProxyCertificateError(error) ? "proxy_certificate_invalid" : "proxy_unavailable",
      );
      return;
    }
    if (this.activeSession && isProxyCertificateError(error))
      await this.failActiveSession("proxy_certificate_invalid");
    // A generic failed transaction is not evidence of a failed whole session.
  }

  async handleProxyPermissionsChanged(observer = this.captureConnectionObserver()): Promise<void> {
    this.proxyControlRevision += 1;
    await this.initialize(observer);
    if (!this.startupSecondaryStorageLoaded) return;
    if (this.startupGuardFailure) return;
    if (!this.security.protectionRequested) return;
    const operation = this.startOperation(observer);
    try {
      // Remove the session-wide allowance before checking permissions that can
      // otherwise make Firefox stop delivering blocking webRequest events.
      await this.dependencies.safety.suspend();
      await this.withStateMutation(async () => {
        this.assertCurrent(operation.id);
        await this.dependencies.proxy.assertControllable();
        this.assertCurrent(operation.id);
        if (
          this.activeSession?.id === this.authorizedSessionId &&
          !this.isProxyExpired(this.activeSession) &&
          (await this.dependencies.proxy.isActiveConfiguration(this.activeSession))
        ) {
          await this.reauthorizeRetainedSession(this.activeSession, operation.id);
          this.publish({ status: "connected", protected: true });
        } else {
          this.activeSession = null;
          this.credentialsAllowed = false;
          this.publish({ status: "disconnected", protected: false, activeLocationId: null });
        }
      });
      if (
        this.isCurrent(operation.id) &&
        !this.activeSession &&
        this.hasValidApiSession() &&
        !this.security.nextRetryAt &&
        !this.security.proxyCreationUncertain &&
        !this.security.retrySuspended
      )
        await this.connectInitialized(this.security.selectedLocationId, false, observer);
    } catch (error) {
      if (this.isCurrent(operation.id)) await this.enterFailure(error, operation.id, false);
    }
  }

  async handleProxyAuthenticationFailure(session: ProxySession): Promise<void> {
    await this.initialize();
    if (!this.startupSecondaryStorageLoaded) return;
    const id = this.operationId;
    if (this.activeSession?.id !== session.id || !this.isSessionCurrentForProxyAuth(session))
      return;
    const configured = await this.withStateMutation(async () => {
      if (!this.isCurrent(id) || !this.isSessionCurrentForProxyAuth(session)) return false;
      return this.dependencies.proxy.isActiveConfiguration(session);
    });
    if (!configured || !this.isCurrent(id) || !this.isSessionCurrentForProxyAuth(session)) return;
    const token = this.persisted.auth?.accessToken;
    // Repeated rejection invalidates this session. A deliberate Retry can
    // obtain fresh credentials; do not automatically loop on authentication failures.
    await this.enterFailure(new LocalError("proxy_authentication_failed"), id, false);
    void this.safeRevoke(session.id, token);
  }

  private async doInitialize(observer?: ConnectionRecorder): Promise<void> {
    const startupGeneration = ++this.startupGeneration;
    this.startupInProgress = true;
    for (const failure of this.startupProxyFailures) failure.generation = startupGeneration;
    let recoveringUnreadStorage = this.startupStorageRecovery;
    const repairingGuardFailure = this.startupGuardFailure;
    let restoringStoredSession: ProxySession | null = null;
    // Readability belongs to this restoration attempt, including guard-repair retries.
    this.startupSecondaryStorageLoaded = false;
    // Set again by the refusals below, which the compiler cannot follow.
    this.startupGuardFailure = null as AppErrorCode | null;
    let guardFailure: Error | undefined;
    const noteGuardFailure = (error: unknown) => {
      this.credentialsAllowed = false;
      guardFailure ??= error instanceof Error ? error : new SafetyError("traffic_guard_failed");
    };
    // The allowance of a verified connection stayed in place while no worker ran.
    // Withdrawing it to grant it again a moment later protects nothing more, and fails
    // the requests which pages send meanwhile: it is kept while everything it relies
    // on is found exactly in place, and withdrawn at the first thing which is not.
    let keepAllowance = repairingGuardFailure === null && (await this.allowanceStandsAtStartup());
    // Whether the guard was found standing open in place of being closed and rewritten.
    // Assigned inside the mutation below, which the compiler cannot follow.
    let guardFoundOpen = false as boolean;
    /** A guard which refused: the stores stay readable, their credentials wait for a repair. */
    const refuseForGuard = async (failure: Error) => {
      // A refused guard does not make readable account/session stores unknown.
      // Keep their credentials durable, but never expose or renew them until repair.
      this.credentialsAllowed = false;
      this.activeSession = null;
      this.authorizedSessionId = null;
      this.startupGuardFailure = mapError(failure);
      await this.dependencies.alarms.clearAll().catch(() => undefined);
      await this.inspectSafety();
      this.publish({
        protected: false,
        activeLocationId: null,
        status: "error",
        error: this.startupGuardFailure,
      });
    };
    /** Withdraws a kept allowance. True when the guard refused: the start-up ends there. */
    const forfeitAllowance = async (): Promise<boolean> => {
      if (!keepAllowance) return false;
      keepAllowance = false;
      if (!guardFoundOpen) {
        // As the first instruction of a start-up which keeps nothing: a refusal is
        // noted, and dealt with where that start-up deals with it.
        await this.dependencies.safety.suspend().catch(noteGuardFailure);
        return false;
      }
      // What that start-up has done by now: closed, rewritten, inspected, published.
      await this.withStateMutation(async () => {
        await this.blockSafety(this.security.killSwitchEnabled).catch(noteGuardFailure);
        if (guardFailure) return;
        await this.inspectSafety();
        this.publish({ protected: false });
      });
      if (!guardFailure) return false;
      // Refused here as it may be at the first instruction, and repaired the same way:
      // that start-up reports it before it looks at the account or the session.
      await refuseForGuard(guardFailure);
      return true;
    };
    try {
      if (!keepAllowance) await this.dependencies.safety.suspend().catch(noteGuardFailure);
      if (!this.startupStorageLoaded) {
        await this.dependencies.storage.configureTrustedContexts();
        this.persisted = await this.dependencies.storage.readPersisted();
        this.security = await this.dependencies.securityStorage.read(
          this.persisted.autoConnect,
          this.persisted.selectedLocationId,
        );
        this.storedSecurityKey = securityKey(this.security);
        this.startupStorageLoaded = true;
        await this.restoreHistoricalCleanup();
      }
      // Retry unread secondary stores without resurrecting account/preferences
      // that an explicit disconnect or logout has already changed in memory.
      await this.cleanup.initialize();
      this.restoreCleanupForAccount();
      await this.exclusions.initialize();
      // Finish restoring the saved intent before a pending exclusion journal can
      // release its temporary guard. A guard that preceded the failed read (or
      // could not be inspected) remains protection requested across that recovery.
      if (recoveringUnreadStorage === "preserve_guard" && !this.security.protectionRequested) {
        this.security = { ...this.security, protectionRequested: true };
        await this.writeSecurity();
      }
      // The stores may have changed since they were found in place.
      if (this.exclusions.pending || !this.security.protectionRequested) await forfeitAllowance();
      if (this.exclusions.pending) {
        await this.exclusions.apply().catch(noteGuardFailure);
        if (!guardFailure && !this.security.protectionRequested) {
          await this.dependencies.proxy.clear();
          await this.dependencies.safety.setWebRtc(false);
          await this.dependencies.safety.release();
        }
      }
      await this.inspectSafety();
      // An interrupted first write or failed release may have left a durable guard.
      if (
        (this.safetyStatus.filterActive || this.safetyStatus.trafficBlocked) &&
        !this.security.protectionRequested &&
        recoveringUnreadStorage === "none" &&
        // An earlier worker armed that guard for unreadable stores and recorded it: it
        // is released like this worker's own, never read as interrupted protection.
        (await this.temporaryGuardRecorded())
      )
        recoveringUnreadStorage = "temporary_guard";
      if (
        (this.safetyStatus.filterActive || this.safetyStatus.trafficBlocked) &&
        !this.security.protectionRequested &&
        recoveringUnreadStorage !== "temporary_guard"
      ) {
        this.security = { ...this.security, protectionRequested: true };
        await this.writeSecurity();
      }
      const operation = this.startOperation(observer);
      const currentDeviceId = this.persisted.profile
        ? await this.dependencies.identity
            .getDeviceId(this.persisted.profile.userId)
            .catch(() => null)
        : null;
      const cachedAccount = await this.restoreAccountCache();
      // A recent refresh is not repeated by every worker: the popup asks for one when it
      // opens, and a connection reads the subscription and the catalogue itself.
      const cachedAge = cachedAccount ? this.dependencies.now() - cachedAccount.refreshedAt : -1;
      const accountFresh =
        cachedAccount !== null &&
        // An empty catalogue is more likely a passing answer than the offer: it is asked again.
        cachedAccount.locations.length > 0 &&
        this.persisted.subscription !== null &&
        cachedAge >= 0 &&
        cachedAge < ACCOUNT_REFRESH_INTERVAL_MS;
      const restoredSelection =
        this.security.selectedLocationId ?? this.persisted.selectedLocationId;
      this.snapshot = {
        ...EMPTY_SNAPSHOT,
        logoutOutcome: this.persisted.auth ? null : this.snapshot.logoutOutcome,
        profile: this.persisted.profile,
        subscription: this.persisted.subscription,
        // The kept catalogue stands for this worker's first one, with its idle default.
        selectedLocationId:
          accountFresh && !this.security.protectionRequested
            ? selectLocation(restoredSelection, cachedAccount.locations)
            : restoredSelection,
        currentDeviceId,
        // Kept rows are shown at once. Unless recent, they await the refresh below.
        ...(cachedAccount ? { locations: cachedAccount.locations } : {}),
        ...(accountFresh ? { locationsStatus: "ready" as const } : {}),
      };
      if (this.security.protectionRequested) {
        await this.withStateMutation(async () => {
          await this.dependencies.proxy.assertControllable().catch(noteGuardFailure);
          if (keepAllowance) {
            await this.inspectSafety();
            if (
              guardFailure ||
              !this.isTrafficAllowed() ||
              (this.security.webRtcProtectionEnabled && !this.safetyStatus.webRtcProtected)
            )
              keepAllowance = false;
            // Nothing is published either: no state stands between sleep and restoration.
            else guardFoundOpen = true;
          }
          if (keepAllowance) return;
          await this.blockSafety(this.security.killSwitchEnabled).catch(noteGuardFailure);
          await this.inspectSafety();
          this.publish({ protected: false });
        });
      }
      const transient = await this.dependencies.storage.readTransient();
      if (transient.cleanupUncertain) await this.recordCleanupUncertainty();
      if (transient.proxySession)
        this.sessionRenewals.set(transient.proxySession, {
          refreshAttempts: transient.refreshAttempts,
          ...(transient.refreshRetryAt === undefined
            ? {}
            : { refreshRetryAt: transient.refreshRetryAt }),
        });
      // Migrate sessions created before the durable ledger was introduced.
      // Do this before clearing expired-account or browser-session credentials.
      const owner = this.persisted.profile?.userId;
      const deviceRecovery = owner ? await this.dependencies.identity.getRecovery(owner) : null;
      if (
        !owner &&
        [
          ...(transient.proxySession ? [transient.proxySession] : []),
          ...transient.retiredSessions,
        ].some((session) => Date.parse(session.expiresAt) > this.dependencies.now())
      )
        // A sanitized account cannot supply ownership for surviving legacy IDs.
        // Preserve their unresolved cleanup without assigning them to a new login.
        await this.recordCleanupUncertainty();
      if (owner) {
        if (transient.proxySession) await this.cleanup.add(owner, transient.proxySession);
        for (const session of transient.retiredSessions)
          await this.cleanup.add(owner, { id: session.sessionId, expiresAt: session.expiresAt });
        this.restoreCleanupForAccount();
      }
      this.startupSecondaryStorageLoaded = true;
      this.startupStorageRecovery = "none";
      this.retiredSessions = transient.retiredSessions.filter(
        ({ expiresAt }) => Date.parse(expiresAt) > this.dependencies.now(),
      );
      if (guardFailure) {
        await refuseForGuard(guardFailure);
        return;
      }
      // An explicit stop may need these stores, but must never restore their
      // credentials or start a replacement connection while it awaits startup.
      if (this.startupStopRequests > 0) {
        await forfeitAllowance();
        return;
      }
      if (!this.hasValidApiSession()) {
        if (await forfeitAllowance()) return;
        const logoutOutcome = this.persisted.auth ? null : this.snapshot.logoutOutcome;
        // Nobody is signed in and nothing is in place: there is no account to remove
        // and nothing to release, at this start-up as at most of those of such a profile.
        if (
          recoveringUnreadStorage === "none" &&
          repairingGuardFailure === null &&
          isEmptyAccount(this.persisted) &&
          (await this.nothingInPlace(transient))
        ) {
          this.forgetReleasedProtection();
          this.credentialsAllowed = false;
          this.activeSession = null;
          this.snapshot = { ...EMPTY_SNAPSHOT, error: null };
          this.emit();
        } else await this.clearInvalidAccount(this.persisted.auth ? "api_token_expired" : null);
        if (logoutOutcome) this.publish({ logoutOutcome });
        return;
      }
      await this.withStateMutation(() => this.lapseCreationUncertainty(false));
      // An unanswered creation suspends the retries for as long as its marker stands,
      // which a refusal with a cause of its own can make longer than any session lives.
      if (this.security.proxyCreationUncertain) this.retrySuspendingTokens.add(this.requireToken());
      // The session it may have left is cleanup to report, and that has a time of its
      // own: the historical marker, raised with every unanswered creation, ends once
      // that session has expired. It alone says what a logout must report.
      if (this.historicalCleanupUncertain) this.uncertainCreationTokens.add(this.requireToken());
      const restoredConfiguration =
        transient.proxySession &&
        (await this.dependencies.proxy.isActiveConfiguration(transient.proxySession));
      if (
        this.security.protectionRequested &&
        !deviceRecovery?.pending &&
        transient.proxySession &&
        !this.isProxyExpired(transient.proxySession) &&
        !restoredConfiguration
      )
        // Control lost since the initial guard also unconfigures this session. Refuse
        // before consuming TLS failures: like the guard's refusal, a control refusal keeps
        // the session, its budget and its endpoint's failures for the startup repairing it.
        // An inconclusive check proves no loss: the restoration below checks control again
        // with the session marked as restoring, which a repair then preserves.
        await this.dependencies.proxy.assertControllable().catch((error: unknown) => {
          if (error instanceof ProxyControlError) throw error;
        });
      const restoredSessionForFailure = transient.proxySession;
      const startupProxyFailure =
        (restoredConfiguration === true || repairingGuardFailure !== null) &&
        restoredSessionForFailure &&
        this.startupProxyFailures.find(
          (failure) =>
            failure.generation === startupGeneration &&
            failure.host === restoredSessionForFailure.host.toLowerCase() &&
            failure.port === restoredSessionForFailure.port,
        );
      // Consume only an endpoint actually restored in this startup generation or, when this
      // startup repairs a refusal, the saved one: that refusal kept the session with the
      // failures recorded since, including during this startup.
      // Never authorize credentials already known to have failed TLS.
      if (
        (startupProxyFailure || this.startupProxyFailureOverflow) &&
        this.security.protectionRequested
      ) {
        if (await forfeitAllowance()) return;
        this.startupProxyFailures.splice(0, this.startupProxyFailures.length);
        this.startupProxyFailureOverflow = false;
        await this.enterFailure(
          new LocalError(startupProxyFailure ? startupProxyFailure.error : "proxy_unavailable"),
          operation.id,
        );
        return;
      }
      this.startupProxyFailures.splice(0, this.startupProxyFailures.length);
      this.startupProxyFailureOverflow = false;
      if (
        this.security.protectionRequested &&
        !deviceRecovery?.pending &&
        transient.proxySession &&
        !this.isProxyExpired(transient.proxySession) &&
        (restoredConfiguration || (await this.dependencies.proxy.isGuardedConfiguration()))
      ) {
        const restoredSession = transient.proxySession;
        restoringStoredSession = restoredSession;
        // A configuration which must be written again is not one found in place.
        if (!restoredConfiguration && (await forfeitAllowance())) return;
        await this.withStateMutation(async () => {
          this.activeSession = restoredSession;
          this.snapshot.activeLocation = transient.activeLocation ?? null;
          this.credentialsAllowed = true;
          if (!restoredConfiguration) {
            await this.dependencies.proxy.apply(restoredSession);
            this.assertCurrent(operation.id);
          }
          if (transient.refreshAttempts > 0 && transient.refreshRetryAt === undefined) {
            transient.refreshRetryAt = this.dependencies.now() + REFRESH_RETRY_MS;
            await this.writeTransient(transient);
          }
          const resumeAt = this.refreshResumeAt(restoredSession, transient);
          await this.dependencies.alarms.scheduleSession(
            restoredSession,
            resumeAt === null
              ? null
              : Math.max(computeRefreshAt(restoredSession, this.dependencies.now()), resumeAt),
          );
          await this.authorizeSession(restoredSession, operation.id);
          // A stop arriving as authorization resolves must neither see a protected
          // restore nor keep the traffic allowance just granted for it.
          if (this.startupStopRequests > 0) await this.blockSafety(this.security.killSwitchEnabled);
          this.assertNoStartupStop();
          this.publish({
            status:
              !this.security.proxyCreationUncertain &&
              this.security.capacityBlockedLocationId !== restoredSession.locationId &&
              transient.refreshAttempts > 0
                ? "refreshing"
                : "connected",
            protected: true,
            activeLocationId: restoredSession.locationId,
            selectedLocationId: this.security.selectedLocationId ?? restoredSession.locationId,
            error: this.security.proxyCreationUncertain
              ? "proxy_creation_uncertain"
              : this.security.capacityBlockedLocationId
                ? "server_full"
                : null,
          });
        });
        if (!accountFresh) void this.hydrateAccountBestEffort(observer);
        return;
      }
      // Nothing is restored: the allowance has nothing left to stand for.
      if (await forfeitAllowance()) return;
      // Refuse credentials before the control check below: both its outcomes withdraw them.
      this.credentialsAllowed = false;
      const unrestoredSession = transient.proxySession;
      if (
        this.security.protectionRequested &&
        !deviceRecovery?.pending &&
        unrestoredSession &&
        !this.isProxyExpired(unrestoredSession)
      )
        // Control lost after the early check also makes our guard route ineffective, which
        // the guarded test above reports only as an unguarded route. Refuse before clearing:
        // like the early check's refusal, this keeps the session and its budget for the
        // startup repairing it. An inconclusive check proves no loss: the clearing proceeds.
        // So does a TLS failure of its endpoint recorded after the earlier ones were consumed
        // or dropped, also during this check: the guarded restoration would have refused it.
        await this.dependencies.proxy.assertControllable().catch((error: unknown) => {
          if (error instanceof ProxyControlError && !this.hasProxyRefusal(unrestoredSession))
            throw error;
        });
      // A worker starts at the first request after each pause, most often with nothing
      // requested and nothing in place. Clearing and releasing all of it again changes
      // nothing then, at the cost of a dozen writes: it is done when something is found.
      const pristine =
        !this.security.protectionRequested &&
        recoveringUnreadStorage === "none" &&
        repairingGuardFailure === null &&
        (await this.nothingInPlace(transient));
      if (!pristine) {
        await this.clearTransientCredentials();
        await this.dependencies.alarms.clearAll();
      }
      if (this.security.protectionRequested) {
        if (this.security.retrySuspended || this.security.proxyCreationUncertain) {
          // The deadline of the marker ends its suspension: this worker, or the next,
          // resumes then.
          if (
            this.security.proxyCreationUncertain &&
            this.security.proxyCreationUncertainUntil !== undefined
          )
            await this.dependencies.alarms.scheduleReconnect(
              Math.max(this.security.proxyCreationUncertainUntil, this.security.nextRetryAt ?? 0),
            );
          this.publish({
            protected: false,
            status: "error",
            error: this.security.proxyCreationUncertain
              ? "proxy_creation_uncertain"
              : this.security.capacityBlockedLocationId
                ? "server_full"
                : // A refusal only the user can resolve is still what suspends protection.
                  (this.security.suspensionCause ?? "proxy_unavailable"),
          });
          return;
        }
        if (this.security.nextRetryAt && this.security.nextRetryAt > this.dependencies.now()) {
          await this.dependencies.alarms.scheduleReconnect(this.security.nextRetryAt);
          this.publish({
            protected: false,
            status: "error",
            error: this.security.retryCause ?? "proxy_unavailable",
          });
        } else
          this.startupConnection = () =>
            this.connectInitialized(this.security.selectedLocationId, false, observer);
        return;
      }
      if (pristine) this.forgetReleasedProtection();
      else await this.withStateMutation(() => this.releaseProtection(operation.id));
      this.publish({
        status: this.persisted.auth ? "disconnected" : "logged_out",
        protected: false,
        activeLocationId: null,
      });
      // Local policy restoration must not wait for remote account reads: the
      // Firefox request guard also awaits initialization when VPN is disconnected.
      if (!accountFresh) void this.hydrateAccountBestEffort(observer);
    } catch (error) {
      if (keepAllowance) {
        // Every path below was written for a guard closed since the first instruction,
        // and for what a start-up which keeps nothing has done by the time it restores:
        // the rules rewritten, and WebRTC restricted while requests are blocked. Each
        // step is attempted whatever the others do; the error being handled stands.
        keepAllowance = false;
        await (
          guardFoundOpen
            ? this.blockSafety(this.security.killSwitchEnabled)
            : this.dependencies.safety.suspend()
        ).catch(() => undefined);
      }
      if (
        this.startupStopRequests > 0 &&
        error instanceof DOMException &&
        error.name === "AbortError"
      ) {
        this.credentialsAllowed = false;
        this.activeSession = null;
        this.authorizedSessionId = null;
        return;
      }
      let errorCode = mapError(error);
      // Lost control also unconfigures a restoring session, which its configuration
      // checks and proxy write report as unavailable. Unless TLS refused the session
      // itself, report the control refusal instead: it stays repairable.
      if (
        restoringStoredSession &&
        errorCode === "proxy_unavailable" &&
        !this.hasProxyRefusal(restoringStoredSession)
      ) {
        // Every exit below refuses credentials: never lend them during this check.
        this.credentialsAllowed = false;
        errorCode = await this.dependencies.proxy
          .assertControllable()
          .then(() => errorCode, mapError);
      }
      if (
        this.startupSecondaryStorageLoaded &&
        (this.startupGuardFailure ||
          (repairingGuardFailure &&
            restoringStoredSession &&
            this.security.protectionRequested &&
            !this.isProxyExpired(restoringStoredSession) &&
            !isUnauthorized(error) &&
            !this.hasProxyRefusal(restoringStoredSession)) ||
          errorCode === "host_permissions_required" ||
          errorCode === "private_browsing_required" ||
          errorCode === "proxy_controlled_by_extension" ||
          errorCode === "proxy_controlled_by_policy")
      ) {
        // Permissions or proxy control may disappear at any awaited restoration
        // boundary; such refusals stay repairable, like the initial guard's.
        // Secondary alarm failures cannot turn a repairable refusal into cleanup.
        this.credentialsAllowed = false;
        this.activeSession = null;
        this.authorizedSessionId = null;
        this.startupGuardFailure ??= errorCode;
        await this.dependencies.safety.suspend().catch(() => undefined);
        await this.dependencies.alarms.clearAll().catch(() => undefined);
        await this.inspectSafety();
        this.publish({
          protected: false,
          activeLocationId: null,
          status: "error",
          error: this.startupGuardFailure,
        });
        return;
      }
      if (!this.startupSecondaryStorageLoaded) {
        // Unknown account/security data is not an empty account. Preserve both
        // stores and transient credentials until a later read can recover them.
        if (this.startupStorageRecovery === "none") {
          const previousSafety = await this.dependencies.safety.inspect().catch(() => null);
          // Only a guard that we added to a verified unguarded browser may be
          // released after re-reading an explicit disconnected preference.
          // Existing or unverifiable guards still imply interrupted protection.
          this.startupStorageRecovery =
            previousSafety?.blockingScope === "none" &&
            !previousSafety.filterActive &&
            !previousSafety.trafficBlocked
              ? "temporary_guard"
              : "preserve_guard";
        }
        this.credentialsAllowed = false;
        if (!this.startupStorageLoaded)
          this.security = { ...this.security, protectionRequested: true };
        // Its record, under a key of its own, is started first but never awaited: this path
        // exists because storage misbehaves, and a slow write must not delay the guard it
        // describes. A worker stopped before the recovery then leaves the next one a guard
        // to release, not to connect for.
        if (this.startupStorageRecovery === "temporary_guard") void this.recordTemporaryGuard();
        let reported: AppErrorCode = "storage_unavailable";
        try {
          // A policy not yet read cannot permit exclusions in the recovery guard.
          this.dependencies.safety.configureExclusions?.([]);
          await this.blockSafety(true);
        } catch {
          reported = "traffic_guard_failed";
        }
        await this.inspectSafety();
        this.publish({ protected: false, status: "error", error: reported });
        return;
      }
      // Even corrupt/unreadable account storage must not remove an existing persistent guard.
      this.security = { ...this.security, protectionRequested: true };
      await this.enterFailure(error, this.operationId, false);
    } finally {
      this.startupInProgress = false;
      if (this.startupSecondaryStorageLoaded && !this.startupGuardFailure) {
        this.startupProxyFailures.splice(0, this.startupProxyFailures.length);
        this.startupProxyFailureOverflow = false;
      }
    }
  }

  /**
   * Before anything is touched, on the first restoration of a worker: whether the
   * protected connection which storage describes is still exactly in place. The account,
   * the unexpired session, the saved exclusions, the proxy configuration and the rules
   * are read; nothing is written. Any doubt, or a platform which cannot attest its
   * rules, answers no: the guard is then closed first, as it always was. So does a
   * read which has not answered within its deadline: what it would say is given up, and
   * the allowance does not stand unchecked meanwhile. Never throws.
   */
  private async allowanceStandsAtStartup(): Promise<boolean> {
    if (!this.dependencies.safety.verifyAllowance) return false;
    const found = await beforeDeadline(
      this.readStandingAllowance(),
      this.dependencies.startupPreflightTimeoutMs ?? STARTUP_PREFLIGHT_TIMEOUT_MS,
    );
    return found.completed && found.value && this.startupStopRequests === 0;
  }

  private async readStandingAllowance(): Promise<boolean> {
    const safety = this.dependencies.safety;
    if (
      !safety.verifyAllowance ||
      this.startupStorageLoaded ||
      this.startupStorageRecovery !== "none" ||
      this.startupStopRequests > 0 ||
      this.startupProxyFailures.length > 0 ||
      this.startupProxyFailureOverflow
    )
      return false;
    try {
      const [persisted, transient] = await Promise.all([
        this.dependencies.storage.readPersisted(),
        this.dependencies.storage.readTransient(),
      ]);
      const session = transient.proxySession;
      if (
        !session ||
        this.isProxyExpired(session) ||
        !persisted.auth ||
        !persisted.profile ||
        this.apiSessionExpiry(persisted.auth) <= this.dependencies.now()
      )
        return false;
      // A stored session implies a stored security state: this read migrates nothing.
      const [security] = await Promise.all([
        this.dependencies.securityStorage.read(persisted.autoConnect, persisted.selectedLocationId),
        // The saved exclusions are part of what the proxy and the rules must match.
        this.exclusions.initialize(),
      ]);
      if (
        !security.protectionRequested ||
        this.exclusions.pending ||
        this.exclusions.getState().error
      )
        return false;
      const [configured, attested] = await Promise.all([
        this.dependencies.proxy.isActiveConfiguration(session),
        safety.verifyAllowance(security.killSwitchEnabled),
      ]);
      return configured && attested && this.startupStopRequests === 0;
    } catch {
      return false;
    }
  }

  private async hydrateAccount(
    signal: AbortSignal,
    trace = this.captureConnectionTrace(),
  ): Promise<boolean> {
    const revision = ++this.accountRevision;
    try {
      assertNotAborted(signal);
      const token = this.requireToken();
      const [profile, subscription] = await Promise.all([
        this.dependencies.api.getProfile(token, signal),
        this.dependencies.api.getSubscription(token, signal),
        this.loadLocations(false, undefined, trace),
      ]);
      return await this.withStateMutation(async () => {
        assertNotAborted(signal);
        if (revision < this.committedAccountRevision) return false;
        // A superseded authentication may have rolled back the credential this
        // profile was fetched for. It must never be attached to another one.
        if (!this.persisted.auth) throw new LocalError("unauthorized");
        if (this.persisted.auth.accessToken !== token) return false;
        const selected =
          this.snapshot.selectedLocationId ??
          selectLocation(this.persisted.selectedLocationId, this.snapshot.locations);
        const persisted = {
          ...this.persisted,
          profile,
          subscription,
          selectedLocationId: selected,
        };
        await this.dependencies.storage.writePersisted(persisted);
        assertNotAborted(signal);
        this.committedAccountRevision = revision;
        this.persisted = persisted;
        this.restoreCleanupForAccount();
        this.accountRefreshedAt = this.dependencies.now();
        this.storeAccountCache();
        this.publish({ profile, subscription, selectedLocationId: selected });
        return true;
      });
    } catch (error) {
      // Late failures from an old account must not invalidate the current account.
      assertNotAborted(signal);
      if (revision < this.committedAccountRevision) return false;
      // A rolled-back credential fails like a missing one, whichever request it aborted.
      if (!this.persisted.auth) throw new LocalError("unauthorized");
      throw error;
    }
  }

  /** What an earlier worker kept for the account in storage; never throws. */
  private async restoreAccountCache(): Promise<AccountCache | null> {
    const userId = this.persisted.profile?.userId;
    if (!userId || !this.persisted.auth) return null;
    // What this worker received itself is at least as recent as what it stored.
    if (this.accountRefreshedAt === null || !this.receivedCatalog) {
      let cached: AccountCache | null = null;
      try {
        cached = (await this.dependencies.accountCache?.read(userId)) ?? null;
      } catch {
        /* An unreadable cache is no cache: the account is read from the API. */
      }
      if (!cached) return null;
      this.accountRefreshedAt = cached.refreshedAt;
      this.receivedCatalog = cached.locations;
    }
    return { locations: this.receivedCatalog, refreshedAt: this.accountRefreshedAt };
  }

  /** Keeps the last refresh for the workers which follow; a failure only costs them a read. */
  private storeAccountCache(): void {
    const userId = this.persisted.profile?.userId;
    const cache = this.dependencies.accountCache;
    if (!cache || !userId || this.accountRefreshedAt === null || !this.receivedCatalog) return;
    try {
      void cache
        .write(userId, { locations: this.receivedCatalog, refreshedAt: this.accountRefreshedAt })
        .catch(() => undefined);
    } catch {
      /* Local caching cannot affect account operations. */
    }
  }

  /** Nothing kept for an account outlives it, in this worker or the next. */
  private forgetAccountCache(): void {
    this.accountRefreshedAt = null;
    this.receivedCatalog = null;
    try {
      void this.dependencies.accountCache?.clear().catch(() => undefined);
    } catch {
      /* Local caching cannot affect account operations. */
    }
  }

  private async hydrateAccountBestEffort(
    observer = this.captureConnectionObserver(),
  ): Promise<void> {
    const signal = this.accountAbort.signal;
    try {
      await this.hydrateAccount(signal, this.captureConnectionTrace(this.operationId, observer));
    } catch (error) {
      if (!signal.aborted && isUnauthorized(error)) await this.clearInvalidAccount("unauthorized");
    }
  }

  private async refreshEntitlement(
    signal: AbortSignal,
    trace = this.captureConnectionTrace(),
  ): Promise<void> {
    const revision = ++this.accountRevision;
    try {
      assertNotAborted(signal);
      const token = this.requireToken();
      const [subscription] = await Promise.all([
        this.dependencies.api.getSubscription(token, signal),
        this.loadLocations(false, undefined, trace),
      ]);
      await this.withStateMutation(async () => {
        assertNotAborted(signal);
        if (revision < this.committedAccountRevision) return;
        const persisted = { ...this.persisted, subscription };
        await this.dependencies.storage.writePersisted(persisted);
        assertNotAborted(signal);
        this.committedAccountRevision = revision;
        this.persisted = persisted;
        this.publish({ subscription });
      });
    } catch (error) {
      assertNotAborted(signal);
      if (revision < this.committedAccountRevision) return;
      throw error;
    }
  }

  private loadLocations(
    force = false,
    rejectedLocationId?: string,
    trace = this.captureConnectionTrace(),
  ): Promise<Location[]> {
    if (!force && this.locationsRequest?.revision === this.locationsRevision)
      return this.locationsRequest.promise;
    const token = this.requireToken();
    const revision = ++this.locationsRevision;
    const signal = this.accountAbort.signal;
    const previousSelection = this.snapshot.selectedLocationId;
    const initialCatalog = this.snapshot.locationsStatus === "idle";
    const assertOwner = () => {
      assertNotAborted(signal);
      if (this.persisted.auth?.accessToken !== token)
        throw new DOMException("Catalog owner changed", "AbortError");
    };
    const latestCatalog = async () => {
      // A refusal invalidates older GETs. Their callers must observe the replacement
      // catalog before choosing Auto, without publishing stale rows or stale errors.
      if (this.locationsRequest?.revision !== revision) await this.locationsRequest?.promise;
      assertOwner();
      return this.snapshot.locations;
    };
    const promise = (async () => {
      try {
        await this.withStateMutation(() => {
          assertOwner();
          if (revision === this.locationsRevision)
            this.publish({ locationsStatus: "loading", locationsError: null });
        });
        assertOwner();
        const received = await this.dependencies.api.getLocations(signal);
        const locations = rejectedLocationId
          ? received.filter((location) => location.id !== rejectedLocationId)
          : received;
        await this.withStateMutation(() => {
          assertOwner();
          if (revision !== this.locationsRevision) return;
          // The answer itself is kept, not what a refused location leaves of it.
          this.receivedCatalog = received;
          this.storeAccountCache();
          const mayChooseFallback =
            !this.activeSession &&
            !this.security.protectionRequested &&
            (initialCatalog || previousSelection === null) &&
            this.snapshot.selectedLocationId === previousSelection;
          this.publish({
            locations,
            locationsStatus: "ready",
            locationsError: null,
            // Publish idle defaults immediately, while preserving a live/retry target
            // or any selection the user changed during this request.
            ...(mayChooseFallback
              ? { selectedLocationId: selectLocation(this.snapshot.selectedLocationId, locations) }
              : {}),
          });
          this.traceConnection(
            {
              event: "catalog",
              count: locations.length,
              selectedPresent: locations.some(
                (location) => location.id === this.snapshot.selectedLocationId,
              ),
            },
            trace,
          );
        });
        assertOwner();
        return revision === this.locationsRevision ? locations : await latestCatalog();
      } catch (error) {
        assertOwner();
        if (revision !== this.locationsRevision) return latestCatalog();
        await this.withStateMutation(() => {
          assertOwner();
          if (revision === this.locationsRevision)
            // Previous rows stay visible; connection still requires fresh entitlement.
            this.publish({ locationsStatus: "error", locationsError: mapError(error) });
        });
        throw error;
      }
    })();
    this.locationsRequest = { revision, promise };
    void promise
      .finally(() => {
        if (this.locationsRequest?.revision === revision) this.locationsRequest = null;
      })
      .catch(() => undefined);
    return promise;
  }

  private async selectRetainedLocation(
    session: ProxySession,
    expectedId: number,
    renewalScheduled = false,
    selectionRevision?: number,
  ): Promise<void> {
    await this.withStateMutation(async () => {
      this.assertCurrent(expectedId);
      // Reselecting the same session is not a repair: keep any current TLS refusal,
      // even once a newer selection supersedes the reselection.
      this.assertNoProxyRefusal(session);
      this.assertSelectionOwner(selectionRevision, session.locationId);
      if (
        this.activeSession?.id !== session.id ||
        this.authorizedSessionId !== session.id ||
        !this.security.protectionRequested ||
        this.isProxyExpired(session)
      )
        throw new LocalError("session_expired");
      this.persisted = { ...this.persisted, selectedLocationId: session.locationId };
      await this.dependencies.storage.writePersisted(this.persisted);
      this.assertCurrent(expectedId);
      this.security = { ...this.security, selectedLocationId: session.locationId };
      await this.writeSecurity();
      this.assertCurrent(expectedId);
      if (this.isProxyExpired(session)) throw new LocalError("session_expired");
      if (!renewalScheduled) await this.scheduleRetainedSession(session, expectedId);
      this.assertNoProxyRefusal(session);
      this.publish({
        status: "connected",
        protected: true,
        selectedLocationId: session.locationId,
        activeLocationId: session.locationId,
        error: null,
        retryAfterSeconds: null,
      });
    });
  }

  /** Caller holds stateMutation: authorizes the active session again with its renewal. */
  private async reauthorizeRetainedSession(session: ProxySession, id: number): Promise<void> {
    await this.authorizeSession(session, id);
    await this.scheduleRetainedSession(session, id);
    // A TLS refusal received after authorization still forbids protection.
    this.assertNoProxyRefusal(session);
  }

  /** Caller holds stateMutation; retaining credentials also retains their renewal budget. */
  private async scheduleRetainedSession(
    session: ProxySession,
    expectedId: number,
    deferUntil = 0,
  ): Promise<void> {
    this.assertCurrent(expectedId);
    if (
      this.activeSession !== session ||
      this.authorizedSessionId !== session.id ||
      !this.credentialsAllowed ||
      !this.security.protectionRequested ||
      this.isProxyExpired(session)
    )
      return;
    let transient = await this.dependencies.storage.readTransient();
    this.assertCurrent(expectedId);
    if (this.activeSession !== session || !this.canUseCredentials() || this.isProxyExpired(session))
      return;
    if (transient.proxySession?.id !== session.id) {
      // The mutation queue has settled any superseded write. Commit the retained
      // session and its own budget before confirming selection or scheduling it.
      const renewal = this.sessionRenewals.get(session);
      if (!renewal) throw new SafetyError("traffic_guard_failed");
      transient = { proxySession: session, ...renewal, retiredSessions: this.retiredSessions };
      await this.writeTransient(transient);
      this.assertCurrent(expectedId);
    }
    const resumeAt = this.refreshResumeAt(session, transient);
    await this.dependencies.alarms.scheduleSession(
      session,
      resumeAt === null
        ? null
        : Math.max(computeRefreshAt(session, this.dependencies.now()), resumeAt, deferUntil),
    );
    this.assertCurrent(expectedId);
  }

  private async clearCapacityBlock(expectedId = this.operationId): Promise<boolean> {
    return this.withStateMutation(async () => {
      this.assertCurrent(expectedId);
      if (!this.security.capacityBlockedLocationId) return false;
      const blockedLocationId = this.security.capacityBlockedLocationId;
      this.security = { ...this.security, capacityBlockedLocationId: null, retrySuspended: false };
      await this.writeSecurity();
      this.assertCurrent(expectedId);
      const session = this.activeSession;
      if (session?.locationId === blockedLocationId && !this.isProxyExpired(session)) {
        await this.writeTransient({
          proxySession: session,
          refreshAttempts: 0,
          retiredSessions: this.retiredSessions,
        });
        this.assertCurrent(expectedId);
        await this.dependencies.alarms.scheduleSession(session);
        this.assertCurrent(expectedId);
        return true;
      }
      return false;
    });
  }

  /** Returns whether a newer selection superseded the refused target. */
  private async handleCapacityRejection(
    error: ApiError,
    locationId: string,
    expectedId: number,
    trace = this.captureConnectionTrace(expectedId),
    selectionRevision?: number,
  ): Promise<boolean> {
    const replaced = await this.withStateMutation(async () => {
      this.assertCurrent(expectedId);
      // A refusal of a target replaced by a newer selection still updates the catalog, and
      // capacity_unavailable still records its Retry-After, but must not select, block or
      // report that target again. server_full never records a delay here: its block is per
      // location, which a replaced target does not receive. Only an unreplaced refusal then
      // fails its direct attempt, whose failure may record that Retry-After.
      const superseded = this.isSelectionSuperseded(selectionRevision, locationId);
      // Invalidate every earlier catalog response before publishing the immediate removal.
      this.locationsRevision += 1;
      this.locationsRequest = null;
      const activeLocation = this.locationMetadata(this.activeSession);
      if (error.code === "server_full" && !superseded) {
        this.security = {
          ...this.security,
          capacityBlockedLocationId: locationId,
          selectedLocationId: locationId,
          retrySuspended: true,
          nextRetryAt: null,
        };
        await this.writeSecurity();
        this.assertCurrent(expectedId);
        this.persisted = { ...this.persisted, selectedLocationId: locationId };
        await this.dependencies.storage.writePersisted(this.persisted);
        this.assertCurrent(expectedId);
        await this.dependencies.alarms.clearReconnect();
        if (this.activeSession?.locationId === locationId)
          await this.dependencies.alarms.clearRefresh();
        this.assertCurrent(expectedId);
      } else if (error.code !== "server_full" && error.retryAfterSeconds) {
        this.security = {
          ...this.security,
          retryNotBefore: Math.max(
            this.security.retryNotBefore ?? 0,
            this.dependencies.now() + error.retryAfterSeconds * 1_000,
          ),
        };
        await this.writeSecurity();
        this.assertCurrent(expectedId);
      }
      this.publish({
        ...(error.code === "server_full"
          ? {
              locations: this.snapshot.locations.filter((location) => location.id !== locationId),
              ...(superseded ? {} : { selectedLocationId: locationId }),
            }
          : {}),
        activeLocation,
        // A takeover still in progress keeps explaining the unconfined route.
        ...(superseded || isProxyControlError(this.snapshot.error)
          ? {}
          : { error: mapError(error) }),
      });
      return superseded;
    });
    this.assertCurrent(expectedId);
    // A failed GET must leave the original refusal visible and the other locations usable.
    await this.loadLocations(
      false,
      error.code === "server_full" ? locationId : undefined,
      trace,
    ).catch(() => undefined);
    this.assertCurrent(expectedId);
    return replaced;
  }

  private async refreshProxySession(
    manual = false,
    observer = this.captureConnectionObserver(),
  ): Promise<CommandResult> {
    const previous = this.activeSession;
    const deviceSessionRevision = this.deviceSessionRevision;
    const token = this.persisted.auth?.accessToken;
    if (previous?.id !== this.authorizedSessionId || !this.credentialsAllowed)
      return supersededCommand();
    if (this.isProxyExpired(previous)) {
      await this.expireSession();
      return { ok: false, commandError: "session_expired" };
    }
    let operation: { id: number; signal?: AbortSignal; trace: ConnectionRecorder } = {
      id: this.operationId,
      trace: this.captureConnectionTrace(this.operationId, observer),
    };
    const retiredBefore = this.retiredSessions.filter(
      ({ expiresAt }) => Date.parse(expiresAt) > this.dependencies.now(),
    );
    let replacement: ProxySession | null = null;
    let attempts = 0;
    try {
      await this.dependencies.proxy.assertControllable();
      this.assertCurrent(operation.id);
      const transient = await this.dependencies.storage.readTransient();
      attempts = manual ? 0 : transient.refreshAttempts;
      this.assertCurrent(operation.id);
      const resumeAt = manual ? 0 : this.refreshResumeAt(previous, transient);
      if (resumeAt === null || resumeAt > this.dependencies.now()) {
        await this.withStateMutation(async () => {
          this.assertCurrent(operation.id);
          if (resumeAt === null) await this.dependencies.alarms.clearRefresh();
          else await this.dependencies.alarms.scheduleRetry(resumeAt);
        });
        return {
          ok: false,
          commandError: this.security.proxyCreationUncertain
            ? "proxy_creation_uncertain"
            : "rate_limited",
        };
      }
      // A deferred or exhausted retry only maintains its alarm. It must not
      // supersede an exclusion transaction that will restore this live session.
      operation = this.startOperation(observer);
      this.publish({
        status: "refreshing",
        protected: !this.hasProxyRefusal(previous),
        error: null,
      });
      if (manual && !(await this.allowExplicitDeviceRecovery())) return supersededCommand();
      if (manual) await this.clearCapacityBlock(operation.id);
      replacement = await this.createSignedProxySession(
        previous.locationId,
        operation.signal,
        undefined,
        operation.trace,
      );
      this.assertCurrent(operation.id);
      this.assertSessionLocation(replacement, previous.locationId);
      const session = replacement;
      await this.withStateMutation(async () => {
        this.assertCurrent(operation.id);
        this.retiredSessions = addRetiredSession(retiredBefore, previous.id, previous.expiresAt);
        await this.writeTransient({
          proxySession: session,
          refreshAttempts: 0,
          retiredSessions: this.retiredSessions,
        });
        this.assertCurrent(operation.id);
        await this.commitCreationMarker(session);
        this.assertCurrent(operation.id);
        this.activeSession = session;
        this.sessionActivatedAt.set(session, performance.now());
        this.credentialsAllowed = true;
        await this.dependencies.proxy.apply(session);
        this.assertCurrent(operation.id);
        await this.dependencies.alarms.scheduleSession(session);
        await this.authorizeSession(session, operation.id);
        this.publish({
          status: "connected",
          protected: true,
          activeLocationId: session.locationId,
          error: null,
        });
      });
      return { ok: true };
    } catch (error) {
      if (!this.isCurrent(operation.id)) {
        if (replacement) {
          if (!this.isRetainedAuthorizedSession(replacement, token))
            void this.safeRevoke(replacement.id, token);
          await this.settleDiscardedCreation(replacement, token);
        }
        return supersededCommand();
      }
      if (replacement) {
        void this.safeRevoke(replacement.id, token);
        // Before the fallback reads the marker to suspend the predecessor's renewal.
        await this.settleFailedCreation(replacement);
      }
      if (isUnauthorized(error)) {
        await this.handleOperationError(error, false);
        return failedCommand(error);
      }
      const fallback = { retained: false };
      try {
        await this.withStateMutation(async () => {
          this.assertCurrent(operation.id);
          // SEC-01: never resurrect credentials after expiry, or declare protection from intent alone.
          if (
            this.deviceSessionRevision !== deviceSessionRevision ||
            this.isProxyExpired(previous) ||
            !(await this.dependencies.proxy.isActiveConfiguration(previous)) ||
            // After the last await: a later refusal reaches the predecessor itself.
            this.hasProxyRefusal(previous, replacement) ||
            (!canAutomaticallyRetry(mapError(error)) &&
              mapError(error) !== "server_full" &&
              !(error instanceof ProxyCreationUncertainError) &&
              // A settled replacement leaves no unknown: keep the live predecessor.
              !(error instanceof SettledCreationStorageError))
          )
            return;
          this.assertCurrent(operation.id);
          this.activeSession = previous;
          this.retiredSessions = retiredBefore;
          const delay = Math.max(
            REFRESH_RETRY_MS,
            error instanceof ApiError ? (error.retryAfterSeconds ?? 0) * 1000 : 0,
          );
          if (error instanceof ApiError && error.retryAfterSeconds)
            this.security = {
              ...this.security,
              retryNotBefore: Math.max(
                this.security.retryNotBefore ?? 0,
                this.dependencies.now() + error.retryAfterSeconds * 1000,
              ),
            };
          const retryAt = this.dependencies.now() + delay;
          const suspended =
            this.security.proxyCreationUncertain ||
            this.security.capacityBlockedLocationId === previous.locationId;
          await this.writeTransient({
            proxySession: previous,
            refreshAttempts: suspended ? MAX_REFRESH_ATTEMPTS : attempts + 1,
            ...(suspended ? {} : { refreshRetryAt: retryAt }),
            retiredSessions: retiredBefore,
          });
          this.assertCurrent(operation.id);
          if (
            !suspended &&
            attempts + 1 < MAX_REFRESH_ATTEMPTS &&
            retryAt < Date.parse(previous.expiresAt) - 10_000
          )
            await this.dependencies.alarms.scheduleRetry(retryAt);
          else await this.dependencies.alarms.clearRefresh();
          await this.authorizeSession(previous, operation.id);
          this.publish({
            status: suspended ? "connected" : "refreshing",
            protected: true,
            error: mapError(error),
          });
          fallback.retained = true;
        });
      } catch {
        /* Any unverifiable fallback is handled by the persistent guard below. */
      }
      if (!fallback.retained && this.isCurrent(operation.id))
        await this.enterFailure(error, operation.id);
      return failedCommand(error);
    } finally {
      if (replacement) this.pendingSessions.delete(replacement);
      if (token) this.forgetCompletedToken(token);
    }
  }

  private async expireSession(): Promise<void> {
    await this.enterFailure(
      new LocalError(this.security.capacityBlockedLocationId ? "server_full" : "session_expired"),
      this.operationId,
      true,
      true,
    );
    this.expiryReconnection = true;
  }

  /**
   * Makes at once the reconnection which an expiry left due. Its alarm stays set for a
   * worker which ends first. An unanswered creation, a capacity block, a server delay
   * or a cause of its own leave no reconnection due now: nothing is attempted.
   */
  private async reconnectAfterExpiry(observer?: ConnectionRecorder): Promise<void> {
    // Only the expiry which this event caused: a reconnection due for another reason
    // keeps its own time.
    if (!this.expiryReconnection) return;
    this.expiryReconnection = false;
    const due = this.security.nextRetryAt;
    if (
      due === null ||
      due > this.dependencies.now() + EXPIRY_RECONNECT_DELAY_MS ||
      !this.security.protectionRequested ||
      this.security.retrySuspended ||
      this.security.proxyCreationUncertain ||
      this.activeSession ||
      this.snapshot.status !== "error"
    )
      return;
    await this.retryConnection(true, observer);
  }

  private refreshResumeAt(session: ProxySession, transient: TransientState): number | null {
    if (this.security.proxyCreationUncertain) return null;
    if (this.security.capacityBlockedLocationId === session.locationId) return null;
    if (transient.refreshAttempts >= MAX_REFRESH_ATTEMPTS) return null;
    const scheduled = transient.refreshAttempts > 0 ? (transient.refreshRetryAt ?? 0) : 0;
    const resumeAt = Math.max(scheduled, this.security.retryNotBefore ?? 0);
    return resumeAt >= Date.parse(session.expiresAt) - 10_000 ? null : resumeAt;
  }

  private async failActiveSession(error: AppErrorCode): Promise<void> {
    await this.enterFailure(new LocalError(error), this.operationId);
  }

  private async clearInvalidAccount(error: AppErrorCode | null = null): Promise<void> {
    this.beginDiagnosticAccountChange();
    const operation = this.startOperation();
    this.cancelAccountRefreshes();
    this.credentialsAllowed = false;
    this.activeSession = null;
    this.retiredSessions = [];
    this.persisted = { ...EMPTY_PERSISTED_STATE };
    // From this instant the account is no longer the one of this profile. Its removal
    // below takes several steps: a command which is answered meanwhile, one which this
    // removal superseded for instance, must already find the account gone.
    this.snapshot = { ...EMPTY_SNAPSHOT, error };
    this.emit();
    let failure: unknown = null;
    await this.withStateMutation(async () => {
      this.assertCurrent(operation.id);
      try {
        if (this.security.protectionRequested) {
          // Automatic account expiry is not an explicit request to stop protection.
          await this.blockSafety(this.security.killSwitchEnabled);
          this.assertCurrent(operation.id);
          if (!this.requiresBlockingGuard()) await this.dependencies.proxy.clear();
          this.security = {
            ...this.security,
            nextRetryAt: null,
            retrySuspended: true,
            capacityBlockedLocationId: null,
          };
          await this.writeSecurity();
        } else await this.releaseProtection(operation.id);
      } catch (caught) {
        failure = caught;
      }
      const results = await Promise.allSettled([
        this.dependencies.storage.clearPersisted(),
        this.dependencies.storage.clearTransient(),
        this.dependencies.alarms.clearAll(),
      ]);
      if (results.some((result) => result.status === "rejected"))
        failure = new SafetyError("traffic_guard_failed");
      this.assertCurrent(operation.id);
      await this.inspectSafety();
      this.snapshot = { ...EMPTY_SNAPSHOT, error: failure ? mapError(failure) : error };
      this.emit();
    });
  }

  /** Caller holds stateMutation. Explicit release restores Chrome's underlying settings. */
  private async releaseProtection(id: number, clearStoredCredentials = true): Promise<void> {
    await this.dependencies.alarms.clearAll();
    this.assertCurrent(id);
    if (clearStoredCredentials) await this.dependencies.storage.clearTransient();
    this.assertCurrent(id);
    await this.dependencies.proxy.clear();
    this.assertCurrent(id);
    if (this.exclusions.pending || this.exclusions.getState().error) {
      await this.exclusions.rollback();
      await this.dependencies.proxy.clear();
    }
    this.assertCurrent(id);
    await this.dependencies.safety.setWebRtc(false);
    this.assertCurrent(id);
    await this.dependencies.safety.release();
    this.assertCurrent(id);
    // The guard is gone, whatever it had been armed for.
    await this.forgetTemporaryGuard();
    this.assertCurrent(id);
    this.security = this.releasedSecurity();
    this.retrySuspendingTokens.clear();
    this.creationMarkerOwner = 0;
    this.deviceQuotaError = null;
    await this.writeSecurity();
    this.assertCurrent(id);
    this.retiredSessions = [];
    await this.inspectSafety();
    this.startupStorageRecovery = "none";
    this.startupGuardFailure = null;
    this.startupProxyFailures.splice(0, this.startupProxyFailures.length);
    this.startupProxyFailureOverflow = false;
  }

  /** The security state once protection is released: nothing requested, nothing pending. */
  private releasedSecurity(): SecurityState {
    const released = withSuspensionCause(
      withCreationUncertainty(
        {
          ...this.security,
          protectionRequested: false,
          reconnectAttempts: 0,
          nextRetryAt: null,
          retrySuspended: false,
          retryNotBefore: null,
          capacityBlockedLocationId: null,
        },
        false,
      ),
      null,
    );
    // A deliberate disconnection ends the history of the retries as well.
    delete released.retryCause;
    delete released.backoffLevel;
    delete released.connectedSince;
    return released;
  }

  /**
   * At start-up, with no protection requested: whether a release would change nothing.
   * Storage holds the released state and no session, the proxy is not under this
   * extension's control, no guard of unreadable stores is recorded, and the platform
   * attests that none of its rules or settings is in place. Reads only; any doubt, or a
   * platform which attests nothing, answers no, and the release is made as it always was.
   */
  private async nothingInPlace(transient: TransientState): Promise<boolean> {
    const safety = this.dependencies.safety;
    if (
      !safety.verifyReleased ||
      this.security.protectionRequested ||
      this.exclusions.pending ||
      this.exclusions.getState().error ||
      transient.proxySession !== null ||
      transient.retiredSessions.length > 0 ||
      transient.refreshAttempts !== 0 ||
      transient.refreshRetryAt !== undefined ||
      transient.cleanupUncertain === true ||
      this.storedSecurityKey === null ||
      securityKey(this.storedSecurity(this.releasedSecurity())) !== this.storedSecurityKey
    )
      return false;
    try {
      const [recorded, level, released] = await Promise.all([
        this.temporaryGuardRecorded(),
        this.dependencies.proxy.getControlLevel(),
        safety.verifyReleased(),
      ]);
      return !recorded && level !== "controlled_by_this_extension" && released;
    } catch {
      return false;
    }
  }

  /** What a release leaves in memory, when there was nothing else for it to do. */
  private forgetReleasedProtection(): void {
    this.security = this.releasedSecurity();
    this.retrySuspendingTokens.clear();
    this.creationMarkerOwner = 0;
    this.deviceQuotaError = null;
    this.retiredSessions = [];
    this.startupStorageRecovery = "none";
    this.startupGuardFailure = null;
    this.startupProxyFailures.splice(0, this.startupProxyFailures.length);
    this.startupProxyFailureOverflow = false;
  }

  /** Only called under stateMutation, after transient credentials have been installed. */
  private async authorizeSession(session: ProxySession, id: number): Promise<void> {
    this.assertCurrent(id);
    this.assertNoStartupStop();
    this.assertNoProxyRefusal(session);
    if (this.exclusions.pending || this.exclusions.getState().error)
      throw new SafetyError("traffic_guard_failed");
    this.requireToken();
    if (!this.security.protectionRequested || this.isProxyExpired(session))
      throw new LocalError("session_expired");
    // Firefox permissions can be revoked while the event page sleeps.
    await this.dependencies.proxy.assertControllable();
    this.assertCurrent(id);
    if (!(await this.dependencies.proxy.isActiveConfiguration(session)))
      throw new LocalError("proxy_unavailable");
    this.assertCurrent(id);
    await this.inspectSafety();
    if (!this.safetyStatus.filterActive) throw new SafetyError("traffic_guard_failed");
    if (this.security.webRtcProtectionEnabled && !this.safetyStatus.webRtcProtected)
      throw new SafetyError("webrtc_control_unavailable");
    this.security = withSuspensionCause(
      {
        ...this.security,
        reconnectAttempts: 0,
        nextRetryAt: null,
        // The delays start over once this connection has lasted, not for having begun.
        connectedSince: this.security.connectedSince ?? this.dependencies.now(),
        retrySuspended: this.retriesSuspended(),
        selectedLocationId: this.security.capacityBlockedLocationId
          ? this.security.selectedLocationId
          : session.locationId,
      },
      null,
    );
    await this.writeSecurity();
    this.assertCurrent(id);
    await this.dependencies.alarms.clearReconnect();
    this.assertCurrent(id);
    await this.dependencies.proxy.assertControllable();
    this.assertCurrent(id);
    this.assertNoProxyRefusal(session);
    this.assertNoStartupStop();
    await this.dependencies.safety.allow();
    try {
      this.assertCurrent(id);
      this.assertNoStartupStop();
      this.requireToken();
      if (this.isProxyExpired(session)) throw new LocalError("session_expired");
      if (!(await this.dependencies.proxy.isActiveConfiguration(session)))
        throw new LocalError("proxy_unavailable");
      this.assertCurrent(id);
      await this.inspectSafety();
      if (!this.isTrafficAllowed()) throw new SafetyError("traffic_guard_failed");
      if (this.security.webRtcProtectionEnabled && !this.safetyStatus.webRtcProtected)
        throw new SafetyError("webrtc_control_unavailable");
      this.assertCurrent(id);
      const userId = this.requireUserId();
      const deviceId = await this.dependencies.identity.getDeviceId(userId);
      this.assertCurrent(id);
      if (deviceId) await this.dependencies.identity.completeRecovery(userId, deviceId);
      this.assertCurrent(id);
      await this.dependencies.safety.setWebRtc(this.security.webRtcProtectionEnabled);
      this.assertCurrent(id);
      await this.inspectSafety();
      if (this.security.webRtcProtectionEnabled && !this.safetyStatus.webRtcProtected)
        throw new SafetyError("webrtc_control_unavailable");
      this.assertCurrent(id);
      // Control may be lost during the awaits above before its native event can
      // reach this controller. Re-verify it, again whenever a permission or
      // control event arrives during that check, before confirming the session.
      let controlRevision: number;
      do {
        controlRevision = this.proxyControlRevision;
        await this.dependencies.proxy.assertControllable();
        this.assertCurrent(id);
      } while (controlRevision !== this.proxyControlRevision);
      // An explicit stop received during the final awaits still forbids authorization.
      this.assertNoStartupStop();
      this.assertNoProxyRefusal(session);
      this.authorizedSessionId = session.id;
      this.deviceQuotaError = null;
    } catch (error) {
      await this.blockSafety(this.security.killSwitchEnabled);
      throw error;
    }
  }

  private async enterFailure(
    error: unknown,
    expectedId: number,
    retry = true,
    // An expiry is no failed attempt: its retry is due at once and counts for no backoff.
    immediate = false,
  ): Promise<void> {
    if (!this.isCurrent(expectedId)) return;
    const operation = this.startOperation();
    const abandoned = this.activeSession;
    const abandonedToken = this.persisted.auth?.accessToken;
    this.credentialsAllowed = false;
    this.activeSession = null;
    const connectionError = mapError(error);
    this.deviceQuotaError =
      connectionError === "device_limit" || connectionError === "device_revoked_limit"
        ? connectionError
        : null;
    this.publish({ protected: false, activeLocationId: null });
    await this.withStateMutation(async () => {
      if (!this.isCurrent(operation.id)) return;
      let reported = mapError(error);
      try {
        if (this.security.protectionRequested) {
          // Revoke the temporary allowance BEFORE credentials/alarms are cleared.
          await this.blockSafety(this.security.killSwitchEnabled);
          this.assertCurrent(operation.id);
          if (!this.requiresBlockingGuard()) await this.dependencies.proxy.clear();
        }
      } catch (caught) {
        reported = mapError(caught);
      }
      this.assertCurrent(operation.id);
      const cleanup = await Promise.allSettled([
        this.clearTransientCredentials(),
        this.dependencies.alarms.clearAll(),
      ]);
      if (cleanup.some((result) => result.status === "rejected")) reported = "traffic_guard_failed";
      this.assertCurrent(operation.id);
      // The session is given up for good: the server need not hold it until it expires.
      // Each failure of a node which gives sessions would otherwise leave one behind.
      if (abandoned && !this.isProxyExpired(abandoned))
        void this.safeRevoke(abandoned.id, abandonedToken);
      const retryAfter = error instanceof ApiError ? (error.retryAfterSeconds ?? 0) : 0;
      // A connection which lasted starts the delays over. One which failed at once
      // goes on with them, although it had succeeded: so does a state stored by a
      // version which only counted the attempts.
      const since = this.security.connectedSince;
      const level =
        since !== undefined && this.dependencies.now() - since >= STABLE_CONNECTION_MS
          ? 0
          : (this.security.backoffLevel ?? this.security.reconnectAttempts);
      const delay = immediate
        ? EXPIRY_RECONNECT_DELAY_MS
        : Math.max(
            this.spread([30_000, 60_000, 120_000, 300_000][Math.min(level, 3)] ?? 300_000),
            retryAfter * 1000,
          );
      const retryNotBefore =
        Math.max(
          this.security.retryNotBefore ?? 0,
          retryAfter ? this.dependencies.now() + retryAfter * 1000 : 0,
        ) || null;
      // Unlike retriesSuspended(), the creation marker only defers a retryable failure:
      // settling that creation resumes it (see settleDiscardedCreation).
      const retryable =
        retry &&
        !(error instanceof DeviceRecoveryExhaustedError) &&
        this.security.protectionRequested &&
        this.hasValidApiSession() &&
        !this.security.capacityBlockedLocationId &&
        canAutomaticallyRetry(reported);
      const shouldRetry = retryable && !this.security.proxyCreationUncertain;
      // The unanswered creation is itself a failure which its deadline ends. Any other
      // cause which suspends the retries keeps them suspended once that deadline has
      // passed: the marker then loses its deadline and waits for its settlement.
      const deferredUntil =
        this.security.proxyCreationUncertain &&
        (retryable ||
          (retry &&
            reported === "proxy_creation_uncertain" &&
            this.security.protectionRequested &&
            this.hasValidApiSession() &&
            !this.security.capacityBlockedLocationId))
          ? (this.security.proxyCreationUncertainUntil ?? null)
          : null;
      this.failureSuspendedRetries = !retryable;
      const failed = withSuspensionCause(
        {
          ...this.security,
          reconnectAttempts:
            shouldRetry && !immediate
              ? this.security.reconnectAttempts + 1
              : this.security.reconnectAttempts,
          nextRetryAt: shouldRetry
            ? Math.max(this.dependencies.now() + delay, retryNotBefore ?? 0)
            : deferredUntil !== null
              ? Math.max(this.dependencies.now() + delay, retryNotBefore ?? 0, deferredUntil)
              : null,
          retrySuspended: !shouldRetry,
          retryNotBefore,
          backoffLevel: shouldRetry && !immediate ? level + 1 : level,
        },
        // Kept for the next worker, which could not ask the server again by itself.
        shouldRetry ? null : reported,
      );
      delete failed.connectedSince;
      if (failed.backoffLevel === 0) delete failed.backoffLevel;
      // A worker which starts before the retry reports this failure, not a generic one.
      if (failed.nextRetryAt !== null && isRetryCause(reported)) failed.retryCause = reported;
      else delete failed.retryCause;
      if (deferredUntil === null) delete failed.proxyCreationUncertainUntil;
      this.security = failed;
      try {
        await this.writeSecurity();
        this.assertCurrent(operation.id);
        if (this.security.nextRetryAt)
          await this.dependencies.alarms.scheduleReconnect(this.security.nextRetryAt);
      } catch {
        reported = "traffic_guard_failed";
        this.failureSuspendedRetries = true;
        this.security = { ...this.security, nextRetryAt: null };
      }
      this.assertCurrent(operation.id);
      await this.inspectSafety();
      this.publish({
        status: "error",
        protected: false,
        activeLocationId: null,
        error: reported,
        retryAfterSeconds: retryAfter || null,
      });
    });
  }

  /**
   * The failure which keeps the requested protection down, as the security state holds
   * it: the cause of the retry which is scheduled, or of its suspension. It lasts as
   * long as that retry or suspension does, whatever was published in between.
   */
  private standingFailure(): AppErrorCode | null {
    if (!this.security.protectionRequested || this.activeSession) return null;
    if (this.security.nextRetryAt !== null) return this.security.retryCause ?? null;
    return this.security.retrySuspended ? (this.security.suspensionCause ?? null) : null;
  }

  /** A delay moved by up to RETRY_SPREAD either way. */
  private spread(delay: number): number {
    const drawn = this.dependencies.random?.() ?? Math.random();
    const share = Math.min(1, Math.max(0, Number.isFinite(drawn) ? drawn : 0.5));
    return Math.round(delay * (1 - RETRY_SPREAD + 2 * RETRY_SPREAD * share));
  }

  private isTrafficAllowed(): boolean {
    return (
      this.safetyStatus.filterActive &&
      !this.safetyStatus.trafficBlocked &&
      this.safetyStatus.blockingScope !== "unverified" &&
      !this.exclusions.pending
    );
  }

  private async blockSafety(killSwitchEnabled: boolean): Promise<void> {
    const blocking = this.requiresBlockingGuard(killSwitchEnabled);
    let failure: Error | undefined;
    const attempt = async (operation: () => Promise<void>) => {
      try {
        await operation();
      } catch (error) {
        failure ??= error instanceof Error ? error : new SafetyError("traffic_guard_failed");
      }
    };
    await attempt(() => this.dependencies.safety.suspend());
    await attempt(() =>
      this.dependencies.safety.setWebRtc(blocking || this.security.webRtcProtectionEnabled),
    );
    if (blocking) await attempt(() => this.dependencies.proxy.ensureBlockingConfiguration());
    // Every independent guard is attempted even if another mechanism is unavailable.
    await attempt(() => this.dependencies.safety.block(blocking));
    if (failure !== undefined) throw failure;
  }

  private requiresBlockingGuard(killSwitchEnabled = this.security.killSwitchEnabled): boolean {
    return killSwitchEnabled || this.exclusions.pending || this.exclusions.getState().error;
  }

  private requiresTemporaryWebRtcProtection(): boolean {
    return (
      this.exclusions.pending ||
      this.exclusions.getState().error ||
      (this.security.protectionRequested &&
        this.security.killSwitchEnabled &&
        (this.activeSession?.id !== this.authorizedSessionId ||
          !this.credentialsAllowed ||
          !this.isTrafficAllowed()))
    );
  }

  /**
   * A startup failure of its endpoint or a current TLS refusal of the session itself
   * forbids reuse of a session. A refused successor at the same endpoint failed after
   * its predecessor's activation too.
   */
  private proxyRefusal(
    session: ProxySession,
    successor?: ProxySession | null,
  ): AppErrorCode | null {
    const refusal = this.startupProxyErrorCode(session) ?? this.sessionProxyRefusals.get(session);
    if (refusal) return refusal;
    return successor?.host.toLowerCase() === session.host.toLowerCase() &&
      successor.port === session.port
      ? (this.sessionProxyRefusals.get(successor) ?? null)
      : null;
  }

  private hasProxyRefusal(session: ProxySession, successor?: ProxySession | null): boolean {
    return this.proxyRefusal(session, successor) !== null;
  }

  private assertNoProxyRefusal(session: ProxySession): void {
    const refusal = this.proxyRefusal(session);
    if (refusal) throw new LocalError(refusal);
  }

  private startupRecoveryResult(): CommandResult {
    if (!this.startupSecondaryStorageLoaded)
      return failedCommand(new LocalError("storage_unavailable"));
    return this.startupGuardFailure
      ? { ok: false, commandError: this.startupGuardFailure }
      : { ok: true };
  }

  private startupProxyErrorCode(session: ProxySession): AppErrorCode | null {
    if (this.startupProxyFailureOverflow) return "proxy_unavailable";
    return (
      this.startupProxyFailures.find(
        (failure) =>
          failure.generation === (this.startupGeneration || 1) &&
          failure.host === session.host.toLowerCase() &&
          failure.port === session.port,
      )?.error ?? null
    );
  }

  private isHistoricalProxyError(session: ProxySession, provenance: ProxyErrorProvenance): boolean {
    const activatedAt = this.sessionActivatedAt.get(session);
    if (activatedAt === undefined) return false;
    // Wall-clock timestamps can move backwards. Only a request observed by the
    // current worker before activation proves that its failure is historical.
    const observedAt = provenance.requestObservedAt;
    return (
      typeof observedAt === "number" &&
      Number.isFinite(observedAt) &&
      observedAt >= 0 &&
      observedAt < activatedAt
    );
  }

  private async recordCleanupUncertainty(): Promise<void> {
    this.raiseHistoricalCleanup();
    this.security = { ...this.security, proxyCleanupUncertain: true };
    await this.writeSecurity();
  }

  /**
   * A session nobody can name may exist from now on. The server issues sessions which
   * last less than PROXY_CREATION_UNCERTAINTY_MS, sending included: past that time it
   * has expired, and the marker has nothing left to report.
   */
  private raiseHistoricalCleanup(): void {
    this.historicalCleanupUncertain = true;
    this.historicalCleanupUntil = Math.max(
      this.historicalCleanupUntil ?? 0,
      this.dependencies.now() + PROXY_CREATION_UNCERTAINTY_MS,
    );
  }

  /** Ends the unknown cleanup whose sessions have all expired; storage follows the next write. */
  private lapseHistoricalCleanup(): boolean {
    const now = this.dependencies.now();
    if (
      !this.historicalCleanupUncertain ||
      this.historicalCleanupUntil === null ||
      this.historicalCleanupUntil > now ||
      // An unanswered creation which still suspends retries until a later time may
      // have left a session which lives until then.
      (this.security.proxyCreationUncertain &&
        (this.security.proxyCreationUncertainUntil ?? 0) > now)
    )
      return false;
    this.historicalCleanupUncertain = false;
    this.historicalCleanupUntil = null;
    // What these tokens left unknown has expired with the rest.
    this.uncertainCreationTokens.clear();
    this.security = { ...this.security, proxyCleanupUncertain: this.cleanupUncertain() };
    return true;
  }

  /**
   * The unknown cleanup an earlier worker recorded. A marker stored without its time,
   * by an earlier version, stands for sessions which existed before this worker: it
   * gets the time by which those have expired.
   */
  private async restoreHistoricalCleanup(): Promise<void> {
    // Both deadlines were written as a time of the wall clock, one delay ahead of it. One
    // found further ahead than that was written by a clock which has been set back since:
    // it would suspend, or report, for as long as that clock was ahead. No session lives
    // longer than the delay, so it is brought back to one delay from now. A clock set
    // forward since cannot be told from time which passed: such a deadline ends early.
    const latest = this.dependencies.now() + PROXY_CREATION_UNCERTAINTY_MS;
    const suspendedUntil = this.security.proxyCreationUncertainUntil;
    let changed = false;
    if (suspendedUntil !== undefined && suspendedUntil > latest) {
      this.security = {
        ...this.security,
        proxyCreationUncertainUntil: latest,
        // The retry which waits for that deadline, not one the server asked for.
        ...(this.security.nextRetryAt === suspendedUntil ? { nextRetryAt: latest } : {}),
      };
      changed = true;
    }
    this.historicalCleanupUncertain = this.security.proxyCleanupUncertain;
    this.historicalCleanupUntil = null;
    if (this.historicalCleanupUncertain) {
      const recorded = this.security.proxyCleanupUncertainUntil;
      this.historicalCleanupUntil = Math.min(recorded ?? latest, latest);
      changed =
        recorded === undefined || recorded > latest || this.lapseHistoricalCleanup() || changed;
    }
    if (!changed) return;
    // No change is needed to start: a failed write leaves it to the next worker.
    await this.persistSecurity().catch(() => undefined);
  }

  /**
   * The security state as stored: the cleanup marker goes with the time it ends at, and
   * the cause of a retry with that retry.
   */
  private storedSecurity(state: SecurityState = this.security): SecurityState {
    const stored = { ...state };
    // The cause of a retry goes with that retry.
    if (stored.nextRetryAt === null) delete stored.retryCause;
    delete stored.proxyCleanupUncertainUntil;
    if (!stored.proxyCleanupUncertain) return stored;
    const until = Math.max(
      this.historicalCleanupUncertain ? (this.historicalCleanupUntil ?? 0) : 0,
      this.proxyCreations.size > 0 ? this.creationCleanupUntil : 0,
    );
    if (until > 0) stored.proxyCleanupUncertainUntil = until;
    return stored;
  }

  /** Caller holds stateMutation. Preserve unknown legacy IDs unless uncertainty is durable. */
  private async prepareCleanupBeforeStop(id: number): Promise<boolean> {
    if (this.startupSecondaryStorageLoaded) return true;
    try {
      const transient = await this.dependencies.storage.readTransient();
      this.assertCurrent(id);
      await this.cleanup.initialize();
      this.assertCurrent(id);
      if (transient.cleanupUncertain) await this.recordCleanupUncertainty();
      const token = this.persisted.auth?.accessToken ?? this.logoutUnmigratedAccount?.token;
      const owner = this.persisted.profile?.userId ?? this.logoutUnmigratedAccount?.userId;
      const sessions = [
        ...(transient.proxySession ? [transient.proxySession] : []),
        ...transient.retiredSessions.map(({ sessionId, expiresAt }) => ({
          id: sessionId,
          expiresAt,
        })),
      ];
      for (const session of sessions) {
        if (!token || !owner) throw new LocalError("storage_unavailable");
        await this.cleanup.add(owner, session);
        this.assertCurrent(id);
        this.rememberRemoteSession(token, session, 0, owner);
      }
      this.restoreCleanupForAccount();
      return true;
    } catch {
      this.assertCurrent(id);
      try {
        await this.recordCleanupUncertainty();
        this.assertCurrent(id);
        // Now that the unknown cleanup is durable, a ledger record nobody can read is
        // replaced: it would otherwise refuse every later startup.
        await this.cleanup.resetInvalid().catch(() => undefined);
        this.assertCurrent(id);
        return true;
      } catch {
        this.assertCurrent(id);
        return false;
      }
    }
  }

  private async clearTransientCredentials(): Promise<void> {
    this.retiredSessions = this.retiredSessions.filter(
      ({ expiresAt }) => Date.parse(expiresAt) > this.dependencies.now(),
    );
    if (this.retiredSessions.length === 0) {
      await this.dependencies.storage.clearTransient();
      return;
    }
    // Keep only IDs for later cleanup, never usable proxy credentials.
    await this.writeTransient({
      proxySession: null,
      refreshAttempts: 0,
      retiredSessions: this.retiredSessions,
    });
  }

  private locationMetadata(session: ProxySession | null): Location | null {
    if (!session) return null;
    const location =
      this.snapshot.locations.find((location) => location.id === session.locationId) ??
      this.sessionLocations.get(session) ??
      (this.snapshot.activeLocation?.id === session.locationId
        ? this.snapshot.activeLocation
        : null);
    if (location) this.sessionLocations.set(session, location);
    return location;
  }

  private async writeTransient(state: TransientState): Promise<void> {
    await this.dependencies.storage.writeTransient({
      ...state,
      activeLocation: state.proxySession
        ? (state.activeLocation ?? this.locationMetadata(state.proxySession))
        : null,
    });
    if (state.proxySession)
      this.sessionRenewals.set(state.proxySession, {
        refreshAttempts: state.refreshAttempts,
        ...(state.refreshRetryAt === undefined ? {} : { refreshRetryAt: state.refreshRetryAt }),
      });
  }

  private isRetainedAuthorizedSession(session: ProxySession, token: string | undefined): boolean {
    return (
      this.persisted.auth?.accessToken === token &&
      this.security.protectionRequested &&
      this.isRetainedSession(session)
    );
  }

  /**
   * An operation ending without a replacement retains the live active session which
   * keeps its authorization, unless a current refusal forbids it (see assertNoRetainedRefusal).
   */
  private isRetainedSession(session: ProxySession | null): boolean {
    return (
      !!session &&
      this.activeSession === session &&
      this.authorizedSessionId === session.id &&
      this.credentialsAllowed &&
      !this.isProxyExpired(session) &&
      !this.hasProxyRefusal(session)
    );
  }

  /** Once an attempt ended, only an unsettled creation or a capacity block suspends retries. */
  private retriesSuspended(): boolean {
    return this.security.proxyCreationUncertain || !!this.security.capacityBlockedLocationId;
  }

  /**
   * Caller holds stateMutation and ends an operation without a replacement. Retaining is
   * not a repair: an authorized session refused since its authorization fails instead.
   */
  private assertNoRetainedRefusal(): void {
    const session = this.activeSession;
    if (session?.id === this.authorizedSessionId && this.credentialsAllowed)
      this.assertNoProxyRefusal(session);
  }

  /** Whether an earlier worker recorded its guard as armed for unreadable stores. */
  private async temporaryGuardRecorded(): Promise<boolean> {
    this.temporaryGuardMarker ??=
      (await this.dependencies.securityStorage.readTemporaryGuard?.().catch(() => false)) ?? false;
    return this.temporaryGuardMarker;
  }

  private async recordTemporaryGuard(): Promise<void> {
    if (this.temporaryGuardMarker === true) return;
    const written = await this.dependencies.securityStorage.writeTemporaryGuard?.(true).then(
      () => true,
      () => false,
    );
    // An unrecorded guard stays unknown: the next worker reads it as before.
    if (written) this.temporaryGuardMarker = true;
  }

  /** The guard was released, or protection now owns it: the record no longer applies. */
  private async forgetTemporaryGuard(): Promise<void> {
    if (!(await this.temporaryGuardRecorded())) return;
    const cleared = await this.dependencies.securityStorage.writeTemporaryGuard?.(false).then(
      () => true,
      () => false,
    );
    if (cleared) this.temporaryGuardMarker = false;
  }

  private async writeSecurity(): Promise<void> {
    // A guard which protection now owns is no longer the one of unreadable stores.
    if (this.security.protectionRequested) await this.forgetTemporaryGuard();
    try {
      await this.persistSecurity();
    } catch {
      throw new SafetyError("traffic_guard_failed");
    }
  }

  /**
   * Writes the security state unless storage already holds exactly it. Most
   * authorizations change nothing of it, the one which confirms a restored session at
   * each start among them: each would otherwise cost a write and its verification.
   */
  private async persistSecurity(): Promise<void> {
    const stored = this.storedSecurity();
    const key = securityKey(stored);
    if (key === this.storedSecurityKey) return;
    // Unknown while the write is in doubt: the next one is made whatever it holds.
    this.storedSecurityKey = null;
    await this.dependencies.securityStorage.write(stored);
    this.storedSecurityKey = key;
  }

  private async inspectSafety(): Promise<void> {
    this.safetyStatus = await this.dependencies.safety
      .inspect()
      .catch(() => ({ trafficBlocked: false, webRtcProtected: false, filterActive: false }));
    if (
      this.safetyStatus.trafficBlocked &&
      (!this.safetyStatus.webRtcProtected ||
        !(await this.dependencies.proxy.isGuardedConfiguration().catch(() => false)))
    ) {
      this.safetyStatus.trafficBlocked = false;
      this.safetyStatus.blockingScope = "unverified";
    }
    if (
      this.safetyStatus.blockingScope === "except_excluded" &&
      (this.exclusions.pending ||
        this.exclusions.getState().error ||
        !(await this.dependencies.proxy.isExclusionConfiguration?.().catch(() => false)))
    ) {
      this.safetyStatus.blockingScope = "unverified";
    }
  }

  private async safeRevoke(
    sessionId: string,
    token = this.persisted.auth?.accessToken,
  ): Promise<void> {
    if (!token) return;
    await this.revokeRemoteSession(token, sessionId);
  }

  private rememberRemoteSession(
    token: string,
    session: Pick<ProxySession, "id" | "expiresAt">,
    sequence: number,
    userId = this.persisted.profile?.userId,
  ): void {
    let known = this.remoteSessions.get(token);
    if (!known) {
      known = new Map();
      this.remoteSessions.set(token, known);
    }
    const previous = known.get(session.id);
    if (!previous) known.set(session.id, { expiresAt: session.expiresAt, sequence, userId });
    else if (
      Number.isFinite(Date.parse(session.expiresAt)) &&
      (!Number.isFinite(Date.parse(previous.expiresAt)) ||
        Date.parse(session.expiresAt) > Date.parse(previous.expiresAt))
    ) {
      previous.expiresAt = session.expiresAt;
      if (previous.expiredBy !== undefined && Date.parse(session.expiresAt) > previous.expiredBy) {
        // A prior expiration shortcut does not revoke a newly extended lifetime.
        delete previous.revocation;
        delete previous.expiredBy;
      }
    }
  }

  private restoreCleanupForAccount(): void {
    const token = this.persisted.auth?.accessToken;
    const owner = this.persisted.profile?.userId;
    if (!token || !owner) return;
    for (const session of this.cleanup.forAccount(owner))
      this.rememberRemoteSession(
        token,
        { id: session.sessionId, expiresAt: session.expiresAt },
        0,
        owner,
      );
  }

  private revokeRemoteSession(token: string, sessionId: string): Promise<RemoteResult> {
    this.rememberRemoteSession(token, { id: sessionId, expiresAt: "" }, 0);
    const session = this.remoteSessions.get(token)?.get(sessionId);
    if (!session) return Promise.resolve("unconfirmed");
    if (session.revocation) return session.revocation;
    const revocation = Promise.resolve()
      .then(async () => {
        // As for a ledger record, a wall clock jump alone never proves that an ID
        // without one, such as a creation whose record failed, expired remotely.
        const expiredBy = this.cleanup.provenExpiry();
        if (Date.parse(session.expiresAt) <= expiredBy) {
          const completed = session.userId
            ? await this.cleanup.complete(session.userId, sessionId, expiredBy)
            : true;
          if (completed && Date.parse(session.expiresAt) <= expiredBy) {
            session.expiredBy = expiredBy;
            return;
          }
        }
        await this.dependencies.api.revokeProxySession(token, sessionId);
        delete session.expiredBy;
        if (session.userId) await this.cleanup.complete(session.userId, sessionId);
      })
      .then(
        () => "confirmed" as const,
        () => "unconfirmed" as const,
      );
    session.revocation = revocation;
    session.revocationSettled = false;
    void revocation.then((result) => {
      if (session.revocation !== revocation) return;
      session.revocationSettled = true;
      // Share in-flight calls and confirmed success. A subsequent explicit
      // cleanup may retry an earlier failure; concurrent calls never duplicate.
      if (result === "unconfirmed" && session.revocation === revocation) delete session.revocation;
      this.forgetCompletedToken(token);
    });
    return revocation;
  }

  private forgetCompletedToken(token: string): void {
    if (
      !this.cleanupRequestedTokens.has(token) ||
      this.persisted.auth?.accessToken === token ||
      (this.activeRemoteCleanups.get(token) ?? 0) > 0 ||
      [...this.proxyCreations].some((creation) => creation.token === token) ||
      [...this.pendingSessions.values()].includes(token) ||
      [...(this.remoteSessions.get(token)?.values() ?? [])].some(
        (session) => session.revocation && !session.revocationSettled,
      )
    )
      return;
    this.remoteSessions.delete(token);
    this.uncertainCreationTokens.delete(token);
    this.retrySuspendingTokens.delete(token);
    this.cleanupRequestedTokens.delete(token);
    this.activeRemoteCleanups.delete(token);
  }

  private async safeRevokeMany(
    sessionIds: string[],
    token = this.persisted.auth?.accessToken,
  ): Promise<void> {
    await Promise.allSettled(
      [...new Set(sessionIds)].map((sessionId) => this.safeRevoke(sessionId, token)),
    );
  }

  private retiredSessionIds(): string[] {
    return [
      ...new Set(
        this.retiredSessions
          .filter(({ expiresAt }) => Date.parse(expiresAt) > this.dependencies.now())
          .map(({ sessionId }) => sessionId),
      ),
    ];
  }

  private async createSignedProxySession(
    locationId: string,
    signal?: AbortSignal,
    retainedLocation?: Location,
    trace = this.captureConnectionTrace(),
    selectionRevision?: number,
  ): Promise<ProxySession> {
    const token = this.requireToken();
    const userId = this.requireUserId();
    // The successful POST can itself fill the server and remove it from a concurrent GET.
    const location =
      this.snapshot.locations.find((candidate) => candidate.id === locationId) ??
      (retainedLocation?.id === locationId ? retainedLocation : null) ??
      (this.activeSession?.locationId === locationId
        ? this.locationMetadata(this.activeSession)
        : null);
    const id = this.operationId;
    const assertOwner = () => {
      this.assertCurrent(id);
      if (signal) assertNotAborted(signal);
      if (this.persisted.auth?.accessToken !== token || this.persisted.profile?.userId !== userId)
        throw new DOMException("Account request superseded", "AbortError");
    };
    let proofRetried = false;
    let rotated = false;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const recovery = await this.dependencies.identity.getRecovery(userId);
      assertOwner();
      if (recovery.exhausted) throw new DeviceRecoveryExhaustedError();
      let deviceId: string | null = null;
      try {
        deviceId = await this.ensureBrowserDevice(userId, token, signal);
        assertOwner();
        this.assertSelectionOwner(selectionRevision, locationId);
        const session = await this.createSignedProxySessionAttempt(
          locationId,
          deviceId,
          signal,
          trace,
          selectionRevision,
        );
        if (location) this.sessionLocations.set(session, location);
        return session;
      } catch (error) {
        assertOwner();
        if (isCapacityApiError(error)) {
          if (await this.handleCapacityRejection(error, locationId, id, trace, selectionRevision))
            throw new SelectionSupersededError();
          throw error;
        }
        if (
          !(error instanceof ApiError) ||
          error.status < 400 ||
          error.status >= 500 ||
          error.status === 401
        )
          throw error;
        if (error.code === "device_limit") {
          const pending = await this.dependencies.identity.getRecovery(userId);
          assertOwner();
          throw pending.pending ? new LocalError("device_revoked_limit") : error;
        }
        if (error.code === "device_proof_replayed" && !proofRetried) {
          proofRetried = true;
          continue;
        }
        let rejectedIdentity =
          error.code === "device_identity_revoked" || error.code === "invalid_device";
        if (error.code === "not_found" && deviceId) {
          const listing = await this.dependencies.api.getDevices(token, signal);
          assertOwner();
          rejectedIdentity = !listing.devices.some((device) => device.deviceId === deviceId);
          if (!rejectedIdentity) throw new LocalError("proxy_unavailable");
        }
        if (!rejectedIdentity) throw error;
        const expectedDeviceId = deviceId ?? (await this.dependencies.identity.getDeviceId(userId));
        assertOwner();
        await this.withStateMutation(async () => {
          assertOwner();
          if ((await this.dependencies.identity.getDeviceId(userId)) !== expectedDeviceId)
            throw new DOMException("Device identity superseded", "AbortError");
          assertOwner();
          // Never fall back to credentials issued for a rejected device, even if
          // a later enrollment fails for a transient reason.
          this.deviceSessionRevision += 1;
          this.credentialsAllowed = false;
          this.authorizedSessionId = null;
          this.activeSession = null;
          this.publish({ protected: false, activeLocationId: null });
          await this.blockSafety(this.security.killSwitchEnabled);
          assertOwner();
          if (!this.requiresBlockingGuard()) await this.dependencies.proxy.clear();
          await this.clearTransientCredentials();
          await this.dependencies.alarms.clearAll();
          assertOwner();
          this.security = { ...this.security, retrySuspended: false, nextRetryAt: null };
          await this.writeSecurity();
          assertOwner();
          const pending = await this.dependencies.identity.getRecovery(userId);
          assertOwner();
          if (rotated || pending.pending) {
            await this.dependencies.identity.markRecoveryExhausted(userId, expectedDeviceId);
            assertOwner();
            throw new DeviceRecoveryExhaustedError();
          }
          if (!(await this.dependencies.identity.beginRecovery(userId, expectedDeviceId)))
            throw new DOMException("Device identity superseded", "AbortError");
          assertOwner();
          rotated = true;
          ++this.deviceListRevision;
          this.publish({ currentDeviceId: null, error: null });
        });
      }
    }
    throw new DeviceRecoveryExhaustedError();
  }

  private async createSignedProxySessionAttempt(
    locationId: string,
    deviceId: string,
    signal?: AbortSignal,
    trace = this.captureConnectionTrace(),
    selectionRevision?: number,
  ): Promise<ProxySession> {
    const token = this.requireToken();
    const userId = this.requireUserId();
    // Renewed before anything is sent: a failure here leaves no creation in doubt.
    if (this.dependencies.api.prepareSession)
      await this.dependencies.api.prepareSession(token, signal);
    const proof = await this.dependencies.identity.createProof(
      userId,
      deviceId,
      locationId,
      this.dependencies.now(),
    );
    if (signal) assertNotAborted(signal);
    const sequence = ++this.creationSequence;
    let finish!: () => void;
    const creation: PendingProxyCreation = {
      token,
      sequence,
      settled: new Promise<void>((resolve) => {
        finish = resolve;
      }),
      outcome: "pending",
    };
    this.proxyCreations.add(creation);
    let sent = false;
    try {
      await this.withStateMutation(async () => {
        if (signal) assertNotAborted(signal);
        this.creationMarkerOwner = sequence;
        // A marker already set belongs to an earlier unknown creation: its deadline
        // applies again if this request is refused and leaves only that one unknown.
        this.creationMarkerPrevious = this.security.proxyCreationUncertain
          ? { sequence, until: this.security.proxyCreationUncertainUntil }
          : null;
        // Until a failure says otherwise, only this marker suspends automatic retries.
        this.failureSuspendedRetries = false;
        // A worker stopped during the request leaves the next one this time to wait for.
        this.creationCleanupUntil = this.dependencies.now() + PROXY_CREATION_UNCERTAINTY_MS;
        this.security = {
          ...this.security,
          proxyCreationUncertain: true,
          // A session this request creates without its answer arriving has expired by
          // then: the marker suspends automatic retries until that time, not for ever.
          proxyCreationUncertainUntil: this.dependencies.now() + PROXY_CREATION_UNCERTAINTY_MS,
          proxyCleanupUncertain: true,
          retrySuspended: true,
        };
        // A worker interrupted during the POST must not replay it at startup.
        await this.writeSecurity();
      });
      if (signal) assertNotAborted(signal);
      sent = true;
      // Once sent, allow the bounded API request to return its identifier.
      // Cancelling the user's intent must not throw away a committed session ID.
      const session = await this.dependencies.api.createProxySession(token, locationId, proof);
      creation.outcome = "created";
      this.rememberRemoteSession(token, session, sequence, userId);
      this.pendingSessions.set(session, token);
      try {
        await this.cleanup.add(userId, session);
      } catch {
        this.pendingSessions.delete(session);
        // The ID is known: its proven revocation, or a retried durable record,
        // settles this creation instead of leaving an unknown without identity.
        // The revocation is bounded by the API timeout and holds no state lock.
        if (
          (await this.revokeRemoteSession(token, session.id)) === "confirmed" ||
          (await this.cleanup.add(userId, session).then(
            () => true,
            () => false,
          ))
        ) {
          await this.clearCreationMarker(sequence, token);
          throw new SettledCreationStorageError();
        }
        // Only this worker's memory holds the ID: it stays a durable unknown,
        // even if a later logout of this worker revokes it.
        await this.recordUnknownCreation(creation);
        throw new ProxyCreationUncertainError();
      }
      return session;
    } catch (error) {
      // A creation which returned its ID has already been settled above.
      if (creation.outcome !== "pending") throw error;
      if (!sent || isDefinitiveProxyCreationRejection(error)) {
        creation.outcome = "rejected";
        if (
          sent &&
          signal?.aborted &&
          error instanceof ApiError &&
          (error.status === 429 || isCapacityApiError(error))
        ) {
          await this.settleDiscardedCreation(null, token, {
            sequence,
            userId,
            retryAfterSeconds: error.retryAfterSeconds,
            code: isCapacityApiError(error) ? error.code : "rate_limited",
            locationId,
            trace,
            selectionRevision,
          });
        } else await this.clearCreationMarker(sequence, token);
        throw error;
      }
      await this.recordUnknownCreation(creation);
      throw new ProxyCreationUncertainError();
    } finally {
      this.proxyCreations.delete(creation);
      finish();
      this.forgetCompletedToken(token);
    }
  }

  /**
   * Caller holds stateMutation. Past its deadline, an unanswered creation no longer
   * suspends automatic retries: a session it created has expired, so another creation
   * duplicates nothing. The cleanup marker keeps its own time, which ends no earlier.
   * With `resume`, a retry which nothing else scheduled is due at once. Returns whether
   * the marker ended.
   */
  private async lapseCreationUncertainty(resume: boolean): Promise<boolean> {
    const until = this.security.proxyCreationUncertainUntil;
    if (
      !this.security.proxyCreationUncertain ||
      until === undefined ||
      until > this.dependencies.now() ||
      // A request still in flight settles its own marker.
      this.proxyCreations.size > 0
    )
      return false;
    const previous = this.security;
    const lapsed = withCreationUncertainty(
      { ...previous, proxyCleanupUncertain: this.cleanupUncertain() },
      false,
    );
    this.security = {
      ...lapsed,
      // Only a capacity block still suspends them: a failure with a cause of its own
      // removed the deadline, and this lapse with it.
      retrySuspended: !!lapsed.capacityBlockedLocationId,
      nextRetryAt:
        lapsed.nextRetryAt ??
        (resume && lapsed.protectionRequested ? this.dependencies.now() : null),
    };
    try {
      await this.writeSecurity();
    } catch {
      // The marker which storage still holds keeps suspending: the next alarm or
      // worker lapses it again.
      this.security = previous;
      return false;
    }
    this.retrySuspendingTokens.clear();
    return true;
  }

  /** The POST may have created an ID which no ledger record or revocation settles. */
  private async recordUnknownCreation(creation: PendingProxyCreation): Promise<void> {
    creation.outcome = "uncertain";
    this.uncertainCreationTokens.add(creation.token);
    this.retrySuspendingTokens.add(creation.token);
    // The marker is global: an unknown ID created before a logout or an
    // account change still needs cleanup, and nothing else will record it.
    await this.withStateMutation(() => this.recordCleanupUncertainty()).catch(() => undefined);
  }

  /**
   * The only rule for the durable unknown cleanup marker. A POST still in flight
   * stays resolvable by its later ID or refusal. A creation leaves proxyCreations
   * only once its ID is recorded in the ledger, revoked or historical, or with the
   * write resolving its refusal: pendingSessions adds no unknown.
   */
  private cleanupUncertain(): boolean {
    return this.historicalCleanupUncertain || this.proxyCreations.size > 0;
  }

  private async clearCreationMarker(sequence: number, token: string): Promise<void> {
    await this.withStateMutation(async () => {
      this.forgetCreation(sequence);
      if (this.creationMarkerOwner !== sequence || this.persisted.auth?.accessToken !== token)
        return this.resolveCleanupMarker(token).catch(() => undefined);
      this.security = this.earlierCreationDeadline(
        sequence,
        withCreationUncertainty(
          { ...this.security, proxyCleanupUncertain: this.cleanupUncertain() },
          this.retrySuspendingTokens.has(token),
        ),
      );
      this.creationMarkerOwner = 0;
      await this.writeSecurity();
    });
  }

  /**
   * A refused creation leaves the marker to the earlier unknown creation it found, with
   * that creation's deadline: an attempt which created nothing postpones no retry.
   */
  private earlierCreationDeadline(sequence: number, state: SecurityState): SecurityState {
    const previous = this.creationMarkerPrevious;
    if (previous?.sequence !== sequence) return state;
    this.creationMarkerPrevious = null;
    if (!state.proxyCreationUncertain) return state;
    const next = { ...state };
    if (previous.until === undefined) delete next.proxyCreationUncertainUntil;
    else next.proxyCreationUncertainUntil = previous.until;
    return next;
  }

  /**
   * An attempt failed before committing a creation whose ID the ledger recorded: that
   * record, or the revocation completing it, is known cleanup. As on the settle paths,
   * the cleanup marker follows cleanupUncertain(), and the creation marker, which
   * suspends automatic retries, stays set only for an unknown creation of that token.
   */
  private async settleFailedCreation(session: ProxySession): Promise<void> {
    const token = this.pendingSessions.get(session);
    const sequence = token ? this.remoteSessions.get(token)?.get(session.id)?.sequence : undefined;
    // Once committed, or owned by a newer attempt, the marker is not this creation's to settle.
    if (!token || !sequence || this.creationMarkerOwner !== sequence) return;
    // A failed write keeps the recomputed marker in memory for the next security write.
    await this.clearCreationMarker(sequence, token).catch(() => undefined);
  }

  /**
   * Caller holds stateMutation. A resolved creation leaves proxyCreations with the
   * marker update it causes: a write queued behind it never counts it in flight.
   */
  private forgetCreation(sequence: number): void {
    for (const creation of this.proxyCreations)
      if (creation.sequence === sequence) this.proxyCreations.delete(creation);
  }

  /**
   * Caller holds stateMutation. A creation settled outside its account or marker
   * owner resumes nothing, but its unknown cleanup ends with its last cause.
   * A late result never writes another connected account's state: that account's
   * next security write persists the resolved marker.
   */
  private async resolveCleanupMarker(token: string | undefined): Promise<void> {
    if (!this.security.proxyCleanupUncertain || this.cleanupUncertain()) return;
    this.security = { ...this.security, proxyCleanupUncertain: false };
    if (this.persisted.auth && this.persisted.auth.accessToken !== token) return;
    await this.writeSecurity();
  }

  /** A superseded POST returned a durable ID or a retryable refusal, resolving its marker. */
  private async settleDiscardedCreation(
    session: ProxySession | null,
    token: string | undefined,
    throttled?: {
      sequence: number;
      userId: string;
      retryAfterSeconds: number | undefined;
      code: "rate_limited" | "server_full" | "capacity_unavailable";
      locationId: string;
      trace: ConnectionRecorder;
      selectionRevision?: number;
    },
  ): Promise<void> {
    const recovery: { id: number | null; refreshCapacity: boolean; reconnecting: boolean } = {
      id: null,
      refreshCapacity: false,
      reconnecting: false,
    };
    try {
      await this.withStateMutation(async () => {
        const known =
          throttled ??
          (token && session ? this.remoteSessions.get(token)?.get(session.id) : undefined);
        // A refused creation leaves with this update; one which returned its ID
        // already left when its attempt ended.
        if (throttled) this.forgetCreation(throttled.sequence);
        if (
          !token ||
          this.persisted.auth?.accessToken !== token ||
          known?.userId !== this.persisted.profile?.userId ||
          this.creationMarkerOwner !== known?.sequence
        )
          return this.resolveCleanupMarker(token);
        const id = this.operationId;
        recovery.id = id;
        const uncertain = this.retrySuspendingTokens.has(token);
        const current = this.activeSession;
        // A live authorized session proves no failure ended the connection: a
        // displayed account or capacity error must not cost it this renewal.
        const retained = this.isRetainedSession(current);
        const operationInProgress = ["connecting", "refreshing", "disconnecting"].includes(
          this.snapshot.status,
        );
        const resume =
          !uncertain &&
          this.security.protectionRequested &&
          this.hasValidApiSession() &&
          !operationInProgress &&
          (retained ||
            // Without a session, retries resume unless a failure suspended them for a
            // cause of its own. The displayed error does not decide: unless it ends the
            // account, a failed account, device or catalog read, or a rejected command, only
            // reports itself, whatever its code. So does a takeover of the guard route, which
            // suspends nothing: the resumed reconnect checks control again at its deadline
            // (see reverifyGuardRoute).
            (!current && !this.failureSuspendedRetries));
        recovery.refreshCapacity =
          resume &&
          (throttled?.code === "server_full" || throttled?.code === "capacity_unavailable");
        // As in handleCapacityRejection, a capacity refusal of a target replaced by a
        // newer selection neither blocks nor reports that target. Replaced or not, only
        // rate_limited and capacity_unavailable record a delay below; server_full records none.
        const replaced =
          !!throttled &&
          throttled.code !== "rate_limited" &&
          this.isSelectionSuperseded(throttled.selectionRevision, throttled.locationId);
        const full = throttled?.code === "server_full" && !replaced;
        this.security = {
          ...withCreationUncertainty(this.security, uncertain),
          proxyCleanupUncertain: this.cleanupUncertain(),
          ...(throttled && throttled.code !== "server_full"
            ? {
                retryNotBefore: Math.max(
                  this.security.retryNotBefore ?? 0,
                  this.dependencies.now() +
                    Math.max(REFRESH_RETRY_MS, (throttled.retryAfterSeconds ?? 0) * 1_000),
                ),
              }
            : {}),
          ...(resume && full
            ? { capacityBlockedLocationId: throttled.locationId, nextRetryAt: null }
            : {}),
        };
        // The settled marker no longer suspends retries; a capacity block still does.
        if (resume) this.security = { ...this.security, retrySuspended: this.retriesSuspended() };
        this.creationMarkerOwner = 0;
        await this.writeSecurity();
        this.assertCurrent(id);
        // An operation in progress owns a session refused since: it replaces or fails it.
        if (!operationInProgress) this.assertNoRetainedRefusal();
        if (resume && current) {
          const stored = await this.dependencies.storage.readTransient();
          this.assertCurrent(id);
          // A superseded write may have stored the discarded credentials before
          // the settings command retained the old, still authorized session.
          const transient: TransientState =
            stored.proxySession?.id === current.id
              ? stored
              : {
                  proxySession: current,
                  ...this.sessionRenewals.get(current),
                  refreshAttempts:
                    this.sessionRenewals.get(current)?.refreshAttempts ?? MAX_REFRESH_ATTEMPTS,
                  retiredSessions: this.retiredSessions,
                };
          if (stored.proxySession?.id !== current.id) {
            await this.writeTransient(transient);
            this.assertCurrent(id);
          }
          const resumeAt = this.refreshResumeAt(current, transient);
          await this.dependencies.alarms.scheduleSession(
            current,
            resumeAt === null
              ? null
              : Math.max(computeRefreshAt(current, this.dependencies.now()), resumeAt),
          );
          this.assertCurrent(id);
        } else if (resume) recovery.reconnecting = await this.resumeReconnection(id);
        // A takeover still in progress explains the blocking state until our route is
        // effective again; the refusal's delay already defers the resumed reconnect.
        this.publish({
          ...(resume && throttled && !replaced && !isProxyControlError(this.snapshot.error)
            ? { error: throttled.code, retryAfterSeconds: throttled.retryAfterSeconds ?? null }
            : resume && this.snapshot.error === "proxy_creation_uncertain"
              ? { error: null }
              : {}),
        });
      });
      if (recovery.refreshCapacity && recovery.id !== null && throttled) {
        const id = recovery.id;
        const superseded = await this.handleCapacityRejection(
          new ApiError(
            throttled.code,
            throttled.code === "server_full" ? 409 : 503,
            throttled.retryAfterSeconds,
          ),
          throttled.locationId,
          id,
          throttled.trace,
          throttled.selectionRevision,
        );
        // The refused target is no longer selected: requested protection follows the
        // selection, unless this settlement already scheduled that reconnection.
        if (superseded && !recovery.reconnecting) await this.resumeSelection(id);
      }
    } catch (error) {
      if (recovery.id !== null && this.isCurrent(recovery.id))
        await this.enterFailure(error, recovery.id);
    }
  }

  /** Caller holds stateMutation and has persisted the session identifier. */
  private async commitCreationMarker(session: ProxySession): Promise<void> {
    const token = this.pendingSessions.get(session);
    const known = token ? this.remoteSessions.get(token)?.get(session.id) : undefined;
    if (this.creationMarkerOwner !== known?.sequence) return;
    // The committed creation ends what an earlier ambiguous one suspended: a later
    // definitive refusal must not suspend the retries again in its name.
    if (token) this.retrySuspendingTokens.delete(token);
    this.security = withCreationUncertainty(
      {
        ...this.security,
        retrySuspended: false,
        proxyCleanupUncertain: this.cleanupUncertain(),
      },
      false,
    );
    this.creationMarkerOwner = 0;
    await this.writeSecurity();
  }

  private async findBrowserDevice(
    userId: string,
    token: string,
    signal?: AbortSignal,
    devices?: Device[],
  ): Promise<string | null> {
    const existing = await this.dependencies.identity.getDeviceId(userId);
    if (signal) assertNotAborted(signal);
    if (existing) return existing;
    const legacy = await this.dependencies.identity.getLegacyDeviceId();
    if (signal) assertNotAborted(signal);
    if (!legacy) return null;
    const ownedDevices = devices ?? (await this.dependencies.api.getDevices(token, signal)).devices;
    if (signal) assertNotAborted(signal);
    if (!ownedDevices.some((device) => device.deviceId === legacy)) return null;
    await this.withStateMutation(async () => {
      if (signal) assertNotAborted(signal);
      await this.dependencies.identity.migrateLegacy(userId, legacy);
      if (signal) assertNotAborted(signal);
    });
    return this.dependencies.identity.getDeviceId(userId);
  }

  private async ensureBrowserDevice(
    userId: string,
    token: string,
    signal?: AbortSignal,
  ): Promise<string> {
    const existing = await this.findBrowserDevice(userId, token, signal);
    if (signal) assertNotAborted(signal);
    if (existing) return existing;
    const publicKey = await this.dependencies.identity.getPublicKeySpkiBase64(userId);
    if (signal) assertNotAborted(signal);
    const name = browserDeviceName(await detectBrowserEnvironment());
    if (signal) assertNotAborted(signal);
    const enrolled = await this.dependencies.api.enrollBrowserDevice(
      token,
      name,
      publicKey,
      signal,
    );
    await this.withStateMutation(async () => {
      if (signal) assertNotAborted(signal);
      await this.dependencies.identity.setDeviceId(userId, enrolled.deviceId, publicKey);
      if (signal) assertNotAborted(signal);
      this.publish({ currentDeviceId: enrolled.deviceId });
    });
    return enrolled.deviceId;
  }

  private async allowExplicitDeviceRecovery(): Promise<boolean> {
    const userId = this.persisted.profile?.userId;
    if (!userId) return true;
    const id = this.operationId;
    return this.withStateMutation(async () => {
      if (!this.isCurrent(id) || this.persisted.profile?.userId !== userId) return false;
      const deviceId = await this.dependencies.identity.getDeviceId(userId);
      if (!this.isCurrent(id)) return false;
      await this.dependencies.identity.allowRecoveryRetry(userId, deviceId);
      return this.isCurrent(id);
    });
  }

  private assertCanConnect(
    locationId: string,
    retainedLocation: Location | undefined,
    trace: ConnectionRecorder,
  ): void {
    if (!this.persisted.subscription?.hasAccess) throw new LocalError("subscription_required");
    if (
      !this.snapshot.locations.some((location) => location.id === locationId) &&
      retainedLocation?.id !== locationId
    ) {
      this.traceConnection(
        {
          event: "failure",
          source: "local",
          reason: "catalog_missing",
          error: "invalid_location",
          count: this.snapshot.locations.length,
          requestedPresent: false,
        },
        trace,
      );
      throw new LocalError("invalid_location");
    }
  }

  private assertSessionLocation(session: ProxySession, locationId: string): void {
    if (
      session.locationId !== locationId ||
      !session.username ||
      !session.password ||
      !Number.isFinite(Date.parse(session.expiresAt))
    )
      throw new NetworkError("invalid_response");
    if (this.isProxyExpired(session)) throw new LocalError("session_expired");
  }

  private hasValidApiSession(): boolean {
    return Boolean(
      this.persisted.auth && this.apiSessionExpiry(this.persisted.auth) > this.dependencies.now(),
    );
  }

  /** A renewable session lasts as long as its right to be renewed. */
  private apiSessionExpiry(auth: AuthSession): number {
    return this.dependencies.accountSessionExpiry?.(auth) ?? Date.parse(auth.expiresAt);
  }

  /** Loaded account context only: no restoration, refresh or storage migration. */
  getDiagnosticAccount(): {
    ownerId: string;
    token: string;
    expiresAt: number;
    generation: number;
  } | null {
    const auth = this.persisted.auth;
    const profile = this.persisted.profile;
    if (
      this.diagnosticAccountChanging ||
      !this.startupStorageLoaded ||
      !auth ||
      !profile ||
      this.snapshot.profile?.userId !== profile.userId ||
      !this.hasValidApiSession()
    )
      return null;
    return {
      ownerId: profile.userId,
      token: auth.accessToken,
      // The validity was checked above. Where sessions are renewable no deadline is
      // reported: it moves with every rotation, and a conversion or a renewal must not
      // be taken for a change of account.
      expiresAt: this.dependencies.accountSessionExpiry
        ? Number.MAX_SAFE_INTEGER
        : Date.parse(auth.expiresAt),
      generation: this.diagnosticAccountGeneration,
    };
  }

  /** Internal read model. The diagnostic collector selects safe fields explicitly. */
  getDiagnosticReadState(): {
    snapshot: AppSnapshot;
    safety: SecurityStatus;
    reconnectAttempts: number;
    proxyCreationUncertain: boolean;
    proxyCleanupUncertain: boolean;
  } {
    return {
      snapshot: this.getSnapshot(),
      safety: { ...this.safetyStatus },
      reconnectAttempts: this.security.reconnectAttempts,
      proxyCreationUncertain: this.security.proxyCreationUncertain,
      proxyCleanupUncertain: this.security.proxyCleanupUncertain,
    };
  }

  /** Inspect only the already loaded proxy; never call getActiveSession/initialize. */
  async verifyDiagnosticProxy(): Promise<boolean | null> {
    const session = this.activeSession;
    if (!session || this.isProxyExpired(session)) return null;
    const configured = await this.dependencies.proxy.isActiveConfiguration(session);
    if (session !== this.activeSession || this.isProxyExpired(session)) return null;
    return configured;
  }

  private beginDiagnosticAccountChange(): number {
    this.diagnosticAccountChanging = true;
    this.diagnosticAccountGeneration += 1;
    this.notifyDiagnosticAccountChanged();
    return this.diagnosticAccountGeneration;
  }

  /** Ends the change this generation began, unless a newer one replaced it. */
  private endDiagnosticAccountChange(generation: number): void {
    if (this.diagnosticAccountGeneration !== generation) return;
    this.diagnosticAccountChanging = false;
    this.notifyDiagnosticAccountChanged();
  }

  private notifyDiagnosticAccountChanged(): void {
    try {
      this.dependencies.onDiagnosticAccountChanged?.();
    } catch {
      // A diagnostic observer is deliberately outside the account state machine.
    }
  }

  private requireToken(): string {
    if (!this.persisted.auth) throw new LocalError("unauthorized");
    if (this.apiSessionExpiry(this.persisted.auth) <= this.dependencies.now())
      throw new LocalError("api_token_expired");
    return this.persisted.auth.accessToken;
  }

  private requireUserId(): string {
    if (!this.persisted.profile?.userId) throw new LocalError("unauthorized");
    return this.persisted.profile.userId;
  }

  private isProxyExpired(session: ProxySession): boolean {
    return (
      !Number.isFinite(Date.parse(session.expiresAt)) ||
      Date.parse(session.expiresAt) <= this.dependencies.now() + PROXY_EXPIRY_MARGIN_MS
    );
  }

  private canUseCredentials(): boolean {
    return this.credentialsAllowed && this.startupStopRequests === 0;
  }

  private assertNoStartupStop(): void {
    if (this.startupStopRequests > 0)
      throw new DOMException("Explicit stop requested", "AbortError");
  }

  private cancelAccountRefreshes(): void {
    this.locationsRevision += 1;
    this.locationsRequest = null;
    this.accountAbort.abort();
    this.accountAbort = new AbortController();
    this.forgetAccountCache();
  }

  private startOperation(observer = this.captureConnectionObserver()): {
    id: number;
    signal: AbortSignal;
    trace: ConnectionRecorder;
  } {
    this.operationAbort?.abort();
    this.operationAbort = new AbortController();
    this.operationId += 1;
    return {
      id: this.operationId,
      signal: this.operationAbort.signal,
      trace: this.captureConnectionTrace(this.operationId, observer),
    };
  }

  private assertCurrent(id: number): void {
    if (id !== this.operationId) throw new DOMException("Operation superseded", "AbortError");
  }

  /**
   * A selection accepted after `revision` supersedes another target of the attempt that
   * captured it. Callers without a revision (renewals) or a target follow the selection.
   */
  private isSelectionSuperseded(revision: number | undefined, locationId: string | null): boolean {
    return (
      revision !== undefined &&
      revision !== this.selectionRevision &&
      locationId !== null &&
      locationId !== this.security.selectedLocationId
    );
  }

  private assertSelectionOwner(revision: number | undefined, locationId: string | null): void {
    if (this.isSelectionSuperseded(revision, locationId)) throw new SelectionSupersededError();
  }

  /**
   * A newer selection superseded an attempt before it created a session. Its creation
   * marker or capacity refusal no longer suspends retries, and requested protection
   * without a retained session reconnects to that selection, as after a discarded creation.
   */
  private async resumeSelection(expectedId: number): Promise<void> {
    try {
      await this.withStateMutation(async () => {
        if (!this.isCurrent(expectedId)) return;
        this.assertNoRetainedRefusal();
        const current = this.activeSession;
        const retained = this.isRetainedSession(current);
        const suspended = this.retriesSuspended();
        if (!current) {
          // The attempt may have been superseded before its guard, after a superseded
          // stop released the guards: requested protection without a session is guarded again.
          if (this.security.protectionRequested) {
            await this.blockSafety(this.security.killSwitchEnabled);
            this.assertCurrent(expectedId);
          }
          await this.resumeReconnection(expectedId);
        } else if (retained && this.security.retrySuspended !== suspended) {
          this.security = { ...this.security, retrySuspended: suspended };
          await this.writeSecurity();
          this.assertCurrent(expectedId);
        }
        if (!retained) {
          // The attempt may have announced itself after the selection was published, and
          // the guards may have changed since the last inspection: publish their real state.
          await this.inspectSafety();
          this.assertCurrent(expectedId);
          this.publish({ status: "disconnected" });
        }
      });
    } catch (error) {
      if (this.isCurrent(expectedId)) await this.enterFailure(error, expectedId);
    }
  }

  /**
   * Caller holds stateMutation after a discarded attempt left no session. Requested
   * protection reconnects promptly once nothing suspends automatic retries; returns
   * whether that reconnection was scheduled.
   */
  private async resumeReconnection(expectedId: number): Promise<boolean> {
    if (!this.security.protectionRequested || !this.hasValidApiSession() || this.retriesSuspended())
      return false;
    const nextRetryAt = Math.max(
      this.dependencies.now() + 1_000,
      this.security.retryNotBefore ?? 0,
    );
    this.security = { ...this.security, retrySuspended: false, nextRetryAt };
    await this.writeSecurity();
    this.assertCurrent(expectedId);
    await this.dependencies.alarms.scheduleReconnect(nextRetryAt);
    this.assertCurrent(expectedId);
    return true;
  }

  private isCurrent(id: number): boolean {
    return id === this.operationId;
  }

  private async withStateMutation<T>(mutation: () => T | Promise<T>): Promise<T> {
    if (!this.startupStorageLoaded) throw new LocalError("storage_unavailable");
    const previous = this.stateMutation;
    let release!: () => void;
    this.stateMutation = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await mutation();
    } finally {
      release();
    }
  }

  private async handleOperationError(error: unknown, protectedState: boolean): Promise<void> {
    if (isUnauthorized(error)) {
      await this.clearInvalidAccount(
        error instanceof LocalError && error.code === "api_token_expired"
          ? "api_token_expired"
          : "unauthorized",
      );
      return;
    }
    if (error instanceof DOMException && error.name === "AbortError") return;
    // The error this one replaces may be the reason of a failed connection whose retry
    // is pending: it comes back once an account request succeeds again. A takeover of
    // the proxy is not recorded: the route verification alone decides when it ends.
    const shown = mapError(error);
    const record = this.displacedConnectionError;
    const replaced =
      record?.operation === this.operationId && this.snapshot.error === record.shown
        ? record.error
        : this.snapshot.error;
    this.displacedConnectionError =
      this.connectionRetryPending() && !isProxyControlError(replaced)
        ? { operation: this.operationId, error: replaced, shown }
        : null;
    this.publish({
      // A failed account request ends no live session: its status stays what it was.
      status: protectedState ? this.snapshot.status : "error",
      protected: protectedState,
      error: shown,
      retryAfterSeconds: error instanceof ApiError ? (error.retryAfterSeconds ?? null) : null,
    });
  }

  /** A connection failed and its automatic retry is scheduled: its outcome is unchanged. */
  private connectionRetryPending(): boolean {
    return (
      this.security.protectionRequested &&
      !this.snapshot.protected &&
      this.security.nextRetryAt !== null
    );
  }

  /**
   * What a successful account, device or verification request leaves displayed. It
   * erases the error of such a request, never the reason of a failed connection which
   * is still waiting for its retry.
   */
  private connectionErrorToKeep(): AppErrorCode | null {
    const record = this.displacedConnectionError;
    this.displacedConnectionError = null;
    if (!this.connectionRetryPending()) return null;
    // The recorded reason comes back only while the failed request's own error is still
    // displayed: any other publication since then owns what is shown.
    return record?.operation === this.operationId && this.snapshot.error === record.shown
      ? record.error
      : this.snapshot.error;
  }

  private captureConnectionObserver(): ConnectionRecorder {
    let record: ConnectionRecorder | undefined;
    try {
      record =
        this.dependencies.captureConnectionEvents?.() ??
        ((event) => this.dependencies.onConnectionEvent?.(event));
    } catch {
      /* Local observation cannot affect connection behavior. */
    }
    return (event) => {
      try {
        record?.(event);
      } catch {
        /* Local observation cannot affect connection behavior. */
      }
    };
  }

  private captureConnectionTrace(
    operation = this.operationId,
    observer = this.captureConnectionObserver(),
  ): ConnectionRecorder {
    return (event) => observer({ ...event, operation });
  }

  private traceConnection(event: ConnectionTrace, trace: ConnectionRecorder): void {
    trace(event);
  }

  private publish(changes: Partial<AppSnapshot>): void {
    if (changes.status !== undefined) this.statusOperation = this.operationId;
    if (changes.retryAfterSeconds !== undefined)
      this.retryAfterSince = changes.retryAfterSeconds === null ? null : this.dependencies.now();
    this.snapshot = { ...this.snapshot, ...changes };
    // The choice shown for the ad blocker is that of one account, never of the next.
    if (
      this.snapshot.adBlocking?.enabled != null &&
      this.adBlockingUserId !== (this.snapshot.profile?.userId ?? null)
    )
      this.snapshot.adBlocking = EMPTY_AD_BLOCKING;
    this.snapshot.activeLocation = this.locationMetadata(this.activeSession);
    this.emit();
  }

  private emit(): void {
    if (this.startupGuardFailure && this.snapshot.error === null)
      this.snapshot.error = this.startupGuardFailure;
    if (this.security.capacityBlockedLocationId && this.snapshot.error === null)
      this.snapshot.error = "server_full";
    if (
      this.security.proxyCreationUncertain &&
      this.snapshot.error === null &&
      this.proxyCreations.size === 0 &&
      this.pendingSessions.size === 0
    )
      this.snapshot.error = "proxy_creation_uncertain";
    // A choice of location or a preference publishes that nothing is wrong with it. The
    // failure which still keeps protection down is not over for that: it is displayed
    // again, with the state it leaves, until its retry is made or its cause resolved.
    const standing = this.standingFailure();
    if (
      standing !== null &&
      this.snapshot.error === null &&
      (this.snapshot.status === "disconnected" || this.snapshot.status === "error")
    ) {
      this.snapshot.error = standing;
      this.snapshot.status = "error";
    }
    this.snapshot = {
      ...this.snapshot,
      webLoginPending: this.webLoginAttempt !== null,
      siteExclusions: {
        ...this.exclusions.getState(),
        pending: this.exclusions.pending || this.exclusionsApplying,
      },
      blockingScope:
        this.safetyStatus.blockingScope ??
        (this.safetyStatus.trafficBlocked
          ? "all"
          : this.safetyStatus.filterActive
            ? "none"
            : "unverified"),
      securityPreferences: {
        killSwitchEnabled: this.security.killSwitchEnabled,
        webRtcProtectionEnabled: this.security.webRtcProtectionEnabled,
      },
      protectionRequested: this.security.protectionRequested,
      autoConnect: this.security.protectionRequested,
      trafficBlocked: this.safetyStatus.trafficBlocked,
      webRtcProtected: this.safetyStatus.webRtcProtected,
      nextRetryAt: this.security.nextRetryAt,
    };
    if (
      this.exclusionsApplying ||
      !this.activeSession ||
      this.isProxyExpired(this.activeSession) ||
      !this.isTrafficAllowed() ||
      (this.security.webRtcProtectionEnabled && !this.safetyStatus.webRtcProtected)
    )
      this.snapshot.protected = false;
    this.dependencies.onStateChanged(this.getSnapshot());
  }
}

async function beforeDeadline<T>(
  operation: Promise<T>,
  timeoutMs: number,
): Promise<{ completed: true; value: T } | { completed: false }> {
  let timer!: ReturnType<typeof setTimeout>;
  const deadline = new Promise<{ completed: false }>((resolve) => {
    timer = setTimeout(() => resolve({ completed: false }), timeoutMs);
  });
  try {
    return await Promise.race([
      operation.then((value) => ({ completed: true as const, value })),
      deadline,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function assertNotAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new DOMException("Account request superseded", "AbortError");
}

class LocalError extends Error {
  constructor(readonly code: AppErrorCode) {
    super(code);
  }
}

class DeviceRecoveryExhaustedError extends LocalError {
  constructor() {
    super("proxy_unavailable");
  }
}

/** A created ID missed its ledger record, then was revoked or recorded: no unknown remains. */
class SettledCreationStorageError extends LocalError {
  constructor() {
    super("storage_unavailable");
  }
}

/** An older connection attempt lost its target to a newer accepted selection. */
class SelectionSupersededError extends DOMException {
  constructor() {
    super("Selection superseded", "AbortError");
  }
}

function selectLocation(selected: string | null, locations: Location[]): string | null {
  if (selected && locations.some((location) => location.id === selected)) return selected;
  return locations[0]?.id ?? null;
}

function isCapacityApiError(
  error: unknown,
): error is ApiError & { code: "server_full" | "capacity_unavailable"; status: 409 | 503 } {
  return (
    error instanceof ApiError &&
    ((error.status === 409 && error.code === "server_full") ||
      (error.status === 503 && error.code === "capacity_unavailable"))
  );
}

function isCapacityErrorCode(error: AppErrorCode | null): boolean {
  return error === "server_full" || error === "capacity_unavailable";
}

function addRetiredSession(
  pending: RetiredProxySession[],
  sessionId: string,
  expiresAt: string,
): RetiredProxySession[] {
  return [...pending.filter((item) => item.sessionId !== sessionId), { sessionId, expiresAt }];
}

function isProxyCertificateError(error: string): boolean {
  return error.toUpperCase().includes("CERT");
}

function isUnauthorized(error: unknown): boolean {
  return (
    (error instanceof ApiError && (error.status === 401 || error.code === "unauthorized")) ||
    (error instanceof LocalError &&
      (error.code === "unauthorized" || error.code === "api_token_expired"))
  );
}

export function mapError(error: unknown): AppErrorCode {
  if (error instanceof LocationPreferenceError) return error.code;
  if (error instanceof WebAuthError) return error.code;
  if (error instanceof ProxyCreationUncertainError) return "proxy_creation_uncertain";
  if (error instanceof LocalError || error instanceof SafetyError) return error.code;
  if (error instanceof ProxyControlError) {
    if (error.level === "private_browsing_required" || error.level === "host_permissions_required")
      return error.level;
    if (error.level === "configuration_rejected") return "proxy_unavailable";
    return error.level === "controlled_by_other_extensions"
      ? "proxy_controlled_by_extension"
      : "proxy_controlled_by_policy";
  }
  if (error instanceof NetworkError) {
    if (error.kind === "network") return "network_error";
    if (error.kind === "timeout") return "request_timeout";
    return "invalid_response";
  }
  if (error instanceof ApiError) {
    if (error.status === 401 && error.code !== "invalid_credentials") return "unauthorized";
    if (isCapacityApiError(error)) return error.code;
    if (error.status >= 500 && error.status < 600) return "proxy_unavailable";
    const known: AppErrorCode[] = [
      "invalid_credentials",
      "unauthorized",
      "email_verification_required",
      "verification_email_cooldown",
      "subscription_required",
      "device_limit",
      "device_identity_revoked",
      "device_proof_invalid",
      "device_proof_replayed",
      "invalid_device",
      "device_exists",
      "not_found",
      "invalid_location",
      "rate_limited",
      "proxy_unavailable",
      "email_delivery_unavailable",
    ];
    return known.includes(error.code as AppErrorCode)
      ? (error.code as AppErrorCode)
      : error.status === 429
        ? "rate_limited"
        : "unknown_error";
  }
  return "unknown_error";
}

export function failedCommand(error: unknown): CommandResult {
  if (error instanceof DOMException && error.name === "AbortError") return supersededCommand();
  return {
    ok: false,
    commandError: mapError(error),
    ...(error instanceof ApiError && error.retryAfterSeconds !== undefined
      ? { commandRetryAfterSeconds: error.retryAfterSeconds }
      : {}),
  };
}

function supersededCommand(): CommandResult {
  return { ok: false, superseded: true };
}

/** No account, and nothing which an account left to remove. */
function isEmptyAccount(persisted: PersistedState): boolean {
  return (
    persisted.auth === null &&
    persisted.profile === null &&
    persisted.subscription === null &&
    persisted.selectedLocationId === null &&
    !persisted.autoConnect
  );
}

/** The same state gives the same key, whatever the order in which it was assembled. */
function securityKey(state: SecurityState): string {
  return JSON.stringify(
    Object.entries(state)
      .filter(([, value]) => value !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
  );
}

function canAutomaticallyRetry(error: AppErrorCode): boolean {
  return isRetryCause(error);
}

function isProxyControlError(error: AppErrorCode | null): boolean {
  return error === "proxy_controlled_by_extension" || error === "proxy_controlled_by_policy";
}

function isDeviceQuota(error: AppErrorCode | null): boolean {
  return error === "device_limit" || error === "device_revoked_limit";
}
