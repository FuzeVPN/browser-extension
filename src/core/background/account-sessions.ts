// SPDX-License-Identifier: MPL-2.0

import { ApiError, NetworkError, type ApiService, type SessionRenewalService } from "../api/client";
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
  RenewableSession,
} from "../api/types";
import type { AccountSessionStorage } from "../storage/account-session-storage";

/** The access token is renewed once it expires within this margin. */
const EXPIRY_MARGIN_MS = 5 * 60_000;
/** A server which does not know the conversion is asked again after this delay. */
const CLASSIC_RETRY_MS = 24 * 60 * 60_000;
const RETRY_DELAYS_MS = [2_000, 5_000, 15_000, 60_000, 5 * 60_000];
const MAX_RETRY_DELAY_MS = 60 * 60_000;
/** A token this instance just asked for is not renewed again, whatever the clock says. */
const RECENT_ROTATION_MS = 30_000;
const REFUSED_RETENTION_MS = 24 * 60 * 60_000;
/** A server which cannot perform a conversion for this long will not recover it. */
const UNCONVERTIBLE_AFTER_MS = 24 * 60 * 60_000;
const MAX_SESSIONS = 4;

/** A rotation is stored before it is sent, and sent again unchanged until it is answered. */
interface PendingRotation {
  route: "upgrade" | "refresh";
  token: string;
  requestId: string;
}

interface SessionRecord {
  /** The token the account was signed in with: its identity for the rest of the extension. */
  handle: string;
  credentials: RenewableSession | null;
  pending: PendingRotation | null;
  /** The server did not know the conversion: the classic session is used until then. */
  classicUntil: number | null;
  /** No rotation is sent before this time, which a later worker respects too. */
  retryAt: number | null;
  /**
   * When the server first answered that it cannot perform the pending conversion, while
   * an earlier attempt may have been applied. One such answer may come from a single
   * instance during a deployment: it counts once this worker receives the same answer,
   * with no other in between, a day later.
   */
  unknownSince: number | null;
  /** The server refused this session: only a new sign-in restores the account. */
  refused: boolean;
  touchedAt: number;
}

interface SessionView {
  credentials: RenewableSession | null;
  pending: PendingRotation | null;
}

interface RuntimeState {
  failures: number;
  /** On the monotonic clock: a change of the system time neither shortens nor extends it. */
  retryAt: number | null;
  /** When this instance last received tokens for a request it had just built. */
  rotatedAt: number | null;
  /** Of an account which storage no longer holds: usable by this worker, never stored. */
  detached: boolean;
  /** The server may have applied the pending rotation: no answer says it did not. */
  doubt: boolean;
  /** When this worker last received the answer which `unknownSince` dates. */
  unknownAt: number | null;
}

interface AccountSessionsOptions {
  api: SessionRenewalService & Pick<ApiService, "logout">;
  storage: AccountSessionStorage;
  now?: () => number;
  /** Milliseconds which only move forward; the worker's performance clock by default. */
  monotonic?: () => number;
  requestId?: () => string;
}

/** The session cannot be renewed for now. It is kept, and nothing says it is refused. */
export class SessionRenewalUnavailableError extends Error {
  constructor(readonly retryAfterSeconds?: number) {
    super("session_renewal_unavailable");
    this.name = "SessionRenewalUnavailableError";
  }
}

/**
 * Renewable account sessions. The rest of the extension keeps the token an account was
 * signed in with as that account's identity; this class converts it once into a
 * renewable session and yields the access token to present to the API. A conversion, a
 * renewal and a logout of one session never overlap.
 */
export class AccountSessions {
  private readonly records = new Map<string, SessionRecord>();
  private readonly runtime = new Map<string, RuntimeState>();
  private readonly now: () => number;
  private readonly monotonic: () => number;
  private readonly requestId: () => string;
  private initialization: Promise<void> | null = null;
  private revision = 0;
  private readonly queues = new Map<string, Promise<unknown>>();
  private writes: Promise<unknown> = Promise.resolve();
  private following: Promise<unknown> = Promise.resolve();
  private followed = false;
  /** The account which storage holds; undefined until this instance is told. */
  private account: string | null | undefined;
  /** A change which storage did not take: the next change of account writes it again. */
  private unsaved = false;

  constructor(private readonly options: AccountSessionsOptions) {
    this.now = options.now ?? Date.now;
    this.monotonic = options.monotonic ?? (() => performance.now());
    this.requestId = options.requestId ?? randomRequestId;
  }

  /** Rejects while the stored sessions cannot be read; a later call reads them again. */
  initialize(): Promise<void> {
    this.initialization ??= this.options.storage.read().then(
      (stored) => {
        const decoded = decodeStored(stored);
        this.revision = decoded.revision;
        for (const record of decoded.sessions) {
          this.records.set(record.handle, record);
          const runtime = this.state(record.handle);
          // Nothing tells what became of a request which a previous worker stored.
          if (record.pending) runtime.doubt = true;
          const wait = (record.retryAt ?? 0) - this.now();
          if (wait > 0) runtime.retryAt = this.monotonic() + Math.min(wait, MAX_RETRY_DELAY_MS);
        }
      },
      (error: unknown) => {
        this.initialization = null;
        throw error;
      },
    );
    return this.initialization;
  }

  /** When the right to renew this account's session ends, once it is renewable. */
  expiryOf(handle: string): number | null {
    const record = this.records.get(handle);
    return record?.credentials && !record.refused
      ? Date.parse(record.credentials.refreshExpiresAt)
      : null;
  }

  /**
   * The access token to present for this account, renewed when it is about to expire.
   * Throws a 401 once the server has refused the session, and
   * SessionRenewalUnavailableError while it can neither be renewed nor used.
   */
  async credential(handle: string): Promise<string> {
    await this.ready();
    return this.exclusive(handle, async () => {
      const record = this.open(handle);
      const runtime = this.state(handle);
      if (record.refused) throw unauthorized();
      // A rotation in doubt is settled first, with its own token and identifier.
      let session = await this.rotate(record);
      if (!session.credentials) {
        const classic = record.classicUntil !== null && record.classicUntil > this.now();
        // A session whose account storage does not hold is ended, never converted.
        if (!session.pending && !classic && !this.deferred(runtime) && !runtime.detached)
          session = await this.rotate(record, "upgrade");
        // A classic session, or a conversion in doubt: the sign-in token is still tried.
        if (!session.credentials) return handle;
      }
      if (
        !session.pending &&
        !this.recent(runtime) &&
        !this.deferred(runtime) &&
        this.expiresSoon(record)
      )
        session = await this.rotate(record, "refresh");
      if (!session.credentials) return handle;
      // A renewal in doubt or postponed: only an unexpired token is worth trying.
      if (
        (session.pending || this.deferred(runtime)) &&
        Date.parse(session.credentials.expiresAt) <= this.now()
      )
        throw this.unavailable(runtime);
      return session.credentials.accessToken;
    });
  }

  /**
   * After a 401 on an account route: the access token to send the request with once
   * more, or null when the refusal stands.
   */
  async recover(handle: string, rejected: string): Promise<string | null> {
    await this.ready();
    return this.exclusive(handle, async () => {
      const record = this.records.get(handle);
      if (!record || record.refused) return null;
      const runtime = this.state(handle);
      // Another instance may have stored the token which replaced the refused one.
      await this.adoptStored(record);
      let session = this.view(record);
      if (session.pending) {
        // The refusal may be the rotation in doubt, already applied by the server.
        if (!this.deferred(runtime)) session = await this.rotate(record);
        // A conversion which the server certainly did not apply explains nothing, and
        // one which it has been unable to perform for a day will not be recovered: the
        // refusal of the sign-in token stands. Otherwise nothing can be said yet.
        if (
          session.pending &&
          (session.pending.route !== "upgrade" ||
            (runtime.doubt && !this.unconvertible(record, runtime)))
        )
          throw this.unavailable(runtime);
      }
      const current = session.credentials?.accessToken ?? handle;
      if (current !== rejected) {
        // The request is sent once more, and a refusal of that is final. A token which
        // this instance was issued a moment ago is good for it. Any other was recovered
        // with an earlier request and may be as old as that request: it is renewed
        // first, and nothing is sent again while it cannot be.
        if (!session.credentials || this.recent(runtime)) return current;
        if (this.deferred(runtime)) throw this.unavailable(runtime);
        session = await this.rotate(record, "refresh");
        if (session.pending || this.deferred(runtime)) throw this.unavailable(runtime);
        return session.credentials?.accessToken ?? null;
      }
      // The sign-in token of a classic session: nothing can replace it.
      if (!session.credentials) {
        // Whatever session an unanswered conversion left on the server ends with it.
        if (session.pending && runtime.doubt)
          void this.options.api.logout(handle).catch(() => undefined);
        return null;
      }
      // Expired for the server, or revoked: one renewal tells which, and its own
      // refusal is the one which ends the session.
      if (this.deferred(runtime)) throw this.unavailable(runtime);
      session = await this.rotate(record, "refresh");
      // A renewal which was not made says nothing about the session.
      if (session.pending || this.deferred(runtime)) throw this.unavailable(runtime);
      const next = session.credentials?.accessToken;
      return next && next !== rejected ? next : null;
    });
  }

  /** Renews in the background what the account will need next; never throws. */
  touch(handle: string): void {
    void this.credential(handle).catch(() => undefined);
  }

  /** Sends again the rotations a previous worker left unanswered; never throws. */
  resume(): void {
    void this.initialize().then(
      () => {
        for (const record of this.records.values())
          if (record.pending && !record.refused) this.touch(record.handle);
      },
      () => undefined,
    );
  }

  /**
   * Told which account storage holds, each time it is read or written. The session of
   * any other account leaves storage at once: this worker can still end it on the
   * server, and no later worker finds its tokens. The first time, a session left in
   * storage without its account is ended on the server as well.
   */
  follow(handle: string | null): void {
    // Known at once: a session opened before the lines below run belongs to it or not.
    this.account = handle;
    this.following = this.following
      .then(() => this.initialize())
      .then(() => {
        const startup = !this.followed;
        this.followed = true;
        let changed = false;
        for (const record of this.records.values()) {
          const runtime = this.state(record.handle);
          const detached = record.handle !== handle;
          if (runtime.detached !== detached) {
            runtime.detached = detached;
            changed = true;
          }
          // Stored by an earlier worker for an account which is gone: nothing owns it.
          if (detached && startup) {
            changed = true;
            void this.logout(record.handle).catch(() => undefined);
          }
        }
        return changed || this.unsaved ? this.persist() : undefined;
      })
      .catch(() => undefined);
  }

  /**
   * Ends the session on the server. A renewable session is ended with its refresh
   * token, which the server accepts after the access token expired or was replaced.
   */
  async logout(handle: string): Promise<void> {
    // Stored sessions which cannot be read leave the sign-in token as the only credential.
    await this.initialize().catch(() => undefined);
    return this.exclusive(handle, async () => {
      const record = this.records.get(handle);
      if (!record) return this.options.api.logout(handle);
      const runtime = this.state(handle);
      // A conversion in doubt is settled first when it can be: its refresh token ends
      // the session at any generation, the sign-in token only the one just converted.
      if (record.pending?.route === "upgrade" && runtime.doubt && !this.deferred(runtime))
        await this.rotate(record).catch(() => undefined);
      const token = record.credentials?.refreshToken ?? handle;
      try {
        await this.options.api.logout(token);
      } catch (error) {
        // Nothing of a session the user left stays in storage, and this worker may
        // retry. The session of an account which storage still holds stays with it.
        runtime.detached = handle !== this.account;
        await this.persist().catch(() => undefined);
        throw error;
      }
      this.records.delete(handle);
      this.runtime.delete(handle);
      await this.persist().catch(() => undefined);
    });
  }

  /**
   * A fetch which presents the current access token in place of the account's sign-in
   * token, and sends the request once more after a renewal when the token is refused.
   */
  fetcher(base: typeof fetch): typeof fetch {
    return async (input, init) => {
      const handle = /^Bearer (\S+)$/.exec(new Headers(init?.headers).get("Authorization") ?? "");
      if (!handle?.[1]) return base(input, init);
      const send = (token: string) => {
        const headers = new Headers(init?.headers);
        headers.set("Authorization", `Bearer ${token}`);
        return base(input, { ...init, headers });
      };
      const refusal = () =>
        new Response(JSON.stringify({ error: "unauthorized" }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        });
      let credential: string;
      try {
        credential = await this.credential(handle[1]);
      } catch (error) {
        if (isUnauthorized(error)) return refusal();
        throw new TypeError("session_renewal_unavailable", { cause: error });
      }
      const response = await send(credential);
      if (response.status !== 401 || init?.signal?.aborted) return response;
      let next: string | null;
      try {
        next = await this.recover(handle[1], credential);
      } catch (error) {
        if (isUnauthorized(error)) return response;
        throw new TypeError("session_renewal_unavailable", { cause: error });
      }
      return next ? send(next) : response;
    };
  }

  private async ready(): Promise<void> {
    try {
      await this.initialize();
    } catch {
      // Without its stored session an account can be neither renewed nor refused.
      throw new SessionRenewalUnavailableError();
    }
  }

  /** One conversion, renewal or logout at a time for a session; sessions do not wait for each other. */
  private exclusive<T>(handle: string, task: () => Promise<T>): Promise<T> {
    const run = (this.queues.get(handle) ?? Promise.resolve()).then(task, task);
    const settled = run.catch(() => undefined);
    this.queues.set(handle, settled);
    void settled.then(() => {
      if (this.queues.get(handle) === settled) this.queues.delete(handle);
    });
    return run;
  }

  private open(handle: string): SessionRecord {
    let record = this.records.get(handle);
    if (!record) {
      record = {
        handle,
        credentials: null,
        pending: null,
        classicUntil: null,
        retryAt: null,
        unknownSince: null,
        refused: false,
        touchedAt: this.now(),
      };
      this.records.set(handle, record);
    }
    record.touchedAt = this.now();
    return record;
  }

  private state(handle: string): RuntimeState {
    let runtime = this.runtime.get(handle);
    if (!runtime) {
      runtime = {
        failures: 0,
        retryAt: null,
        rotatedAt: null,
        // Until this instance is told which account storage holds, every session may be it.
        detached: this.account !== undefined && handle !== this.account,
        doubt: false,
        unknownAt: null,
      };
      this.runtime.set(handle, runtime);
    }
    return runtime;
  }

  /** The tokens and the pending rotation as they are now, after any await. */
  private view(record: SessionRecord): SessionView {
    return { credentials: record.credentials, pending: record.pending };
  }

  private deferred(runtime: RuntimeState): boolean {
    return runtime.retryAt !== null && runtime.retryAt > this.monotonic();
  }

  private recent(runtime: RuntimeState): boolean {
    return runtime.rotatedAt !== null && this.monotonic() - runtime.rotatedAt < RECENT_ROTATION_MS;
  }

  private unavailable(runtime: RuntimeState): SessionRenewalUnavailableError {
    const remaining = Math.ceil(((runtime.retryAt ?? 0) - this.monotonic()) / 1_000);
    return new SessionRenewalUnavailableError(remaining > 0 ? remaining : undefined);
  }

  /** Both times are those of answers of the server, never the time elapsed since. */
  private unconvertible(record: SessionRecord, runtime: RuntimeState): boolean {
    return (
      record.unknownSince !== null &&
      runtime.unknownAt !== null &&
      runtime.unknownAt - record.unknownSince >= UNCONVERTIBLE_AFTER_MS
    );
  }

  private expiresSoon(record: SessionRecord): boolean {
    return (
      record.credentials !== null &&
      Date.parse(record.credentials.expiresAt) - this.now() <= EXPIRY_MARGIN_MS
    );
  }

  private defer(record: SessionRecord, runtime: RuntimeState, retryAfterSeconds?: number): void {
    const step = RETRY_DELAYS_MS[Math.min(runtime.failures, RETRY_DELAYS_MS.length - 1)] ?? 0;
    runtime.failures += 1;
    const requested = retryAfterSeconds === undefined ? step : retryAfterSeconds * 1_000;
    const delay = Math.min(Math.max(requested, 1_000), MAX_RETRY_DELAY_MS);
    runtime.retryAt = this.monotonic() + delay;
    record.retryAt = this.now() + delay;
  }

  /**
   * Sends the pending rotation, or starts the given one. On return the record holds the
   * new tokens, or still holds its pending rotation when the answer is not known.
   * Throws a 401 once the server has refused the session.
   */
  private async rotate(
    record: SessionRecord,
    route?: PendingRotation["route"],
  ): Promise<SessionView> {
    const runtime = this.state(record.handle);
    let replayed = true;
    if (!record.pending) {
      const token = route === "upgrade" ? record.handle : record.credentials?.refreshToken;
      if (!route || !token) return this.view(record);
      // Another instance of the extension may already have rotated this session: a
      // second request with the same token would end it.
      if (await this.adoptStored(record)) return this.view(record);
      record.pending = { route, token, requestId: this.requestId() };
      record.unknownSince = runtime.unknownAt = null;
      runtime.doubt = false;
      replayed = false;
      try {
        // Stored before it is sent: a lost answer is recovered with the same request.
        await this.persist();
      } catch {
        record.pending = null;
        this.defer(record, runtime);
        return this.view(record);
      }
    } else if (this.deferred(runtime)) return this.view(record);
    const pending = record.pending;
    let result: RenewableSession;
    try {
      result =
        pending.route === "upgrade"
          ? await this.options.api.upgradeSession(pending.token, pending.requestId)
          : await this.options.api.refreshSession(pending.token, pending.requestId);
    } catch (error) {
      await this.settleFailure(record, runtime, pending, error);
      return this.view(record);
    }
    record.credentials = result;
    record.pending = null;
    record.classicUntil = null;
    record.retryAt = null;
    record.unknownSince = runtime.unknownAt = null;
    runtime.doubt = false;
    runtime.failures = 0;
    runtime.retryAt = null;
    // Tokens recovered with an earlier request may be as old as that request: they
    // are not taken for fresh ones, and are renewed at once if they are about to expire.
    runtime.rotatedAt = replayed ? null : this.monotonic();
    // One write stores the tokens and removes the request. If it fails, the stored
    // request returns these same tokens to a later worker.
    await this.persist().catch(() => undefined);
    return this.view(record);
  }

  private async settleFailure(
    record: SessionRecord,
    runtime: RuntimeState,
    pending: PendingRotation,
    error: unknown,
  ): Promise<void> {
    if (!(error instanceof ApiError)) {
      // No answer, or an unreadable one: the server may have applied the rotation.
      runtime.doubt = true;
      this.defer(record, runtime);
      await this.persist().catch(() => undefined);
      return;
    }
    if (
      error.status === 401 ||
      (error.status === 409 && error.code === "session_upgrade_conflict")
    ) {
      // Refused, unless another instance of the extension stored a newer result.
      if (await this.adoptStored(record)) return;
      record.refused = true;
      record.credentials = null;
      record.pending = null;
      record.classicUntil = null;
      record.retryAt = null;
      record.unknownSince = runtime.unknownAt = null;
      await this.persist().catch(() => undefined);
      throw unauthorized();
    }
    // These two answers settle a request only if no earlier attempt may have been
    // applied: a server which lost an answer and then no longer knows the route, or an
    // intermediary which damaged the request, says nothing about that attempt.
    if (error.status === 404 && pending.route === "upgrade" && !runtime.doubt) {
      // The server does not know renewable sessions yet: the classic session goes on.
      record.pending = null;
      record.retryAt = null;
      record.classicUntil = this.now() + CLASSIC_RETRY_MS;
      await this.persist().catch(() => undefined);
      return;
    }
    if (error.status === 400 && !runtime.doubt) {
      // Refused before any rotation: a later attempt builds a new request.
      record.pending = null;
      if (pending.route === "upgrade") record.classicUntil = this.now() + CLASSIC_RETRY_MS;
      this.defer(record, runtime, error.retryAfterSeconds);
      await this.persist().catch(() => undefined);
      return;
    }
    // The request is kept. A server which answers that it cannot perform the conversion
    // may be one instance among others: the answer only counts once it has lasted.
    if (pending.route === "upgrade" && (error.status === 404 || error.status === 400)) {
      const now = this.now();
      // A system clock which moved back starts the day again.
      if (record.unknownSince === null || record.unknownSince > now) record.unknownSince = now;
      runtime.unknownAt = now;
    } else record.unknownSince = runtime.unknownAt = null;
    // A session in transition, a rate limit or a server failure: same request, later.
    // Only these answers are given before the server changes anything.
    const untouched =
      error.status === 429 ||
      (error.status === 409 && error.code === "session_transition") ||
      (error.status === 503 && error.code === "session_renewal_unavailable");
    if (!untouched) runtime.doubt = true;
    this.defer(record, runtime, error.retryAfterSeconds);
    await this.persist().catch(() => undefined);
  }

  private async adoptStored(record: SessionRecord): Promise<boolean> {
    let stored: StoredSessions;
    try {
      stored = decodeStored(await this.options.storage.read());
    } catch {
      return false;
    }
    const other = stored.sessions.find((candidate) => candidate.handle === record.handle);
    if (
      stored.revision <= this.revision ||
      !other ||
      other.refused ||
      (!other.credentials && !other.pending)
    )
      return false;
    this.revision = stored.revision;
    record.credentials = other.credentials;
    record.pending = other.pending;
    record.classicUntil = other.classicUntil;
    record.unknownSince = other.unknownSince;
    this.state(record.handle).doubt = other.pending !== null;
    return true;
  }

  /** Stores the sessions as they are when the write starts; writes never overlap. */
  private persist(): Promise<void> {
    const write = this.writes.then(() => this.store());
    this.writes = write.then(
      () => {
        this.unsaved = false;
      },
      () => {
        this.unsaved = true;
      },
    );
    return write;
  }

  private async store(): Promise<void> {
    const now = this.now();
    const live = (record: SessionRecord) =>
      record.pending !== null ||
      (record.credentials !== null && Date.parse(record.credentials.refreshExpiresAt) > now);
    const kept = [...this.records.values()]
      .filter((record) => {
        if (this.runtime.get(record.handle)?.detached) return false;
        const expired =
          record.credentials !== null &&
          now - Date.parse(record.credentials.refreshExpiresAt) > REFUSED_RETENTION_MS;
        const stale = record.refused && now - record.touchedAt > REFUSED_RETENTION_MS;
        // A classic session which may be converted again holds nothing worth keeping.
        const empty =
          !record.credentials &&
          !record.pending &&
          !record.refused &&
          (record.classicUntil === null || record.classicUntil <= now);
        return !((expired && !record.pending) || stale || empty);
      })
      // A session which can still be renewed is never the one left out.
      .sort(
        (left, right) =>
          Number(live(right)) - Number(live(left)) || right.touchedAt - left.touchedAt,
      )
      .filter((record, index) => index < MAX_SESSIONS || live(record));
    // Counted before the write: a record this instance wrote is never taken for another's.
    const revision = ++this.revision;
    await this.options.storage.write({
      version: 1,
      revision,
      sessions: kept.map((record) => ({
        handle: record.handle,
        credentials: record.credentials ? { ...record.credentials } : null,
        pending: record.pending ? { ...record.pending } : null,
        classicUntil: record.classicUntil,
        retryAt: record.retryAt,
        unknownSince: record.unknownSince,
        refused: record.refused,
        touchedAt: record.touchedAt,
      })),
    });
  }
}

/**
 * The API as the controller uses it, with each account token replaced by the access
 * token of its renewable session. A request refused with a 401 is sent once more after
 * a renewal; a renewal which cannot be made is a network failure, never a refusal.
 */
export class RenewingApi implements ApiService {
  constructor(
    private readonly api: ApiService,
    private readonly sessions: AccountSessions,
  ) {}

  login(email: string, password: string, signal?: AbortSignal): Promise<AuthSession> {
    return this.api.login(email, password, signal);
  }

  exchangeExtensionCode(
    exchange: ExtensionCodeExchange,
    signal?: AbortSignal,
  ): Promise<AuthSession> {
    return this.api.exchangeExtensionCode(exchange, signal);
  }

  getLocations(signal?: AbortSignal): Promise<Location[]> {
    return this.api.getLocations(signal);
  }

  getProfile(token: string, signal?: AbortSignal): Promise<Profile> {
    return this.authorized(token, signal, (credential) => this.api.getProfile(credential, signal));
  }

  getSubscription(token: string, signal?: AbortSignal): Promise<BillingSubscription> {
    return this.authorized(token, signal, (credential) =>
      this.api.getSubscription(credential, signal),
    );
  }

  async createProxySession(
    token: string,
    locationId: string,
    proof: DeviceProof,
    signal?: AbortSignal,
  ): Promise<ProxySession> {
    try {
      return await this.renewed(token, signal, (credential) =>
        this.api.createProxySession(credential, locationId, proof, signal),
      );
    } catch (error) {
      // No creation was accepted with a credential which could not be renewed: a
      // definite refusal, where a network failure would leave the creation in doubt.
      if (error instanceof SessionRenewalUnavailableError)
        throw new ApiError("proxy_unavailable", 409, error.retryAfterSeconds);
      throw error;
    }
  }

  enrollBrowserDevice(
    token: string,
    name: string,
    publicKey: string,
    signal?: AbortSignal,
  ): Promise<BrowserDeviceEnrollment> {
    return this.authorized(token, signal, (credential) =>
      this.api.enrollBrowserDevice(credential, name, publicKey, signal),
    );
  }

  getDevices(token: string, signal?: AbortSignal): Promise<DeviceList> {
    return this.authorized(token, signal, (credential) => this.api.getDevices(credential, signal));
  }

  deleteDevice(token: string, deviceId: string, signal?: AbortSignal): Promise<void> {
    return this.authorized(token, signal, (credential) =>
      this.api.deleteDevice(credential, deviceId, signal),
    );
  }

  revokeProxySession(token: string, sessionId: string): Promise<void> {
    return this.authorized(token, undefined, (credential) =>
      this.api.revokeProxySession(credential, sessionId),
    );
  }

  resendVerification(token: string, signal?: AbortSignal): Promise<void> {
    return this.authorized(token, signal, (credential) =>
      this.api.resendVerification(credential, signal),
    );
  }

  logout(token: string): Promise<void> {
    return this.sessions.logout(token);
  }

  async prepareSession(token: string, signal?: AbortSignal): Promise<void> {
    await this.authorized(token, signal, () => Promise.resolve());
  }

  private async authorized<T>(
    handle: string,
    signal: AbortSignal | undefined,
    call: (credential: string) => Promise<T>,
  ): Promise<T> {
    try {
      return await this.renewed(handle, signal, call);
    } catch (error) {
      if (error instanceof SessionRenewalUnavailableError) throw new NetworkError("network");
      throw error;
    }
  }

  private async renewed<T>(
    handle: string,
    signal: AbortSignal | undefined,
    call: (credential: string) => Promise<T>,
  ): Promise<T> {
    const credential = await untilAborted(this.sessions.credential(handle), signal);
    try {
      return await call(credential);
    } catch (error) {
      // A 401 means the request was refused before it had any effect.
      if (!isUnauthorized(error) || signal?.aborted) throw error;
      const next = await untilAborted(this.sessions.recover(handle, credential), signal);
      if (!next) throw error;
      return await call(next);
    }
  }
}

function unauthorized(): ApiError {
  return new ApiError("unauthorized", 401);
}

function isUnauthorized(error: unknown): boolean {
  return error instanceof ApiError && error.status === 401;
}

/**
 * The result, unless the caller gives up first: its request is then abandoned at once,
 * while the rotation it was waiting for runs to its end for the next caller.
 */
function untilAborted<T>(work: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return work;
  const cancelled = () => new DOMException("Operation cancelled", "AbortError");
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      reject(cancelled());
    };
    if (signal.aborted) {
      // The abandoned work still settles: its failure concerns no one.
      work.catch(() => undefined);
      abort();
      return;
    }
    signal.addEventListener("abort", abort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        if (signal.aborted) reject(cancelled());
        else resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", abort);
        reject(error instanceof Error ? error : new Error("session_renewal_failed"));
      },
    );
  });
}

/** 32 random bytes in canonical unpadded base64url: 43 characters. */
function randomRequestId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

interface StoredSessions {
  revision: number;
  sessions: SessionRecord[];
}

function decodeStored(stored: unknown): StoredSessions {
  if (!isRecord(stored) || stored.version !== 1 || !Array.isArray(stored.sessions))
    return { revision: 0, sessions: [] };
  const sessions: SessionRecord[] = [];
  for (const entry of stored.sessions as unknown[]) {
    const record = decodeRecord(entry);
    if (record && !sessions.some((known) => known.handle === record.handle)) sessions.push(record);
  }
  return {
    revision:
      typeof stored.revision === "number" && Number.isSafeInteger(stored.revision)
        ? Math.max(0, stored.revision)
        : 0,
    sessions,
  };
}

function decodeRecord(entry: unknown): SessionRecord | null {
  if (!isRecord(entry) || !isToken(entry.handle)) return null;
  const credentials = decodeCredentials(entry.credentials);
  const pending = decodePending(entry.pending);
  // A stored field which cannot be read leaves a session nothing can renew safely.
  if ((entry.credentials != null && !credentials) || (entry.pending != null && !pending))
    return null;
  if (pending?.route === "upgrade" && pending.token !== entry.handle) return null;
  if (pending?.route === "refresh" && !credentials) return null;
  return {
    handle: entry.handle,
    credentials,
    pending,
    classicUntil: timestamp(entry.classicUntil),
    retryAt: timestamp(entry.retryAt),
    unknownSince: timestamp(entry.unknownSince),
    refused: entry.refused === true,
    touchedAt: timestamp(entry.touchedAt) ?? 0,
  };
}

function decodeCredentials(value: unknown): RenewableSession | null {
  if (
    !isRecord(value) ||
    !isToken(value.accessToken) ||
    !isToken(value.refreshToken) ||
    !isDate(value.expiresAt) ||
    !isDate(value.refreshExpiresAt)
  )
    return null;
  return {
    accessToken: value.accessToken,
    expiresAt: value.expiresAt,
    refreshToken: value.refreshToken,
    refreshExpiresAt: value.refreshExpiresAt,
  };
}

function decodePending(value: unknown): PendingRotation | null {
  if (
    !isRecord(value) ||
    (value.route !== "upgrade" && value.route !== "refresh") ||
    !isToken(value.token) ||
    typeof value.requestId !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/.test(value.requestId)
  )
    return null;
  return { route: value.route, token: value.token, requestId: value.requestId };
}

function timestamp(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isToken(value: unknown): value is string {
  return typeof value === "string" && /^[\x21-\x7e]{1,512}$/.test(value);
}

function isDate(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}
