// SPDX-License-Identifier: MPL-2.0

import {
  ApiError,
  NetworkError,
  type ApiService,
  type SessionRenewalService,
} from "../../src/core/api/client";
import type { RenewableSession } from "../../src/core/api/types";
import type { AccountSessionStorage } from "../../src/core/storage/account-session-storage";

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;
export const START = Date.parse("2026-11-12T10:00:00Z");

interface ServerSession {
  id: string;
  access: string;
  accessExpiresAt: number;
  /** 0 while the session is classic; the number of rotations afterwards. */
  generation: number;
  upgradeToken: string | null;
  lastRequest: string | null;
  refreshExpiresAt: number;
}

/** "lost" applies the rotation and loses its answer; an error refuses it untouched. */
type Fault = "lost" | Error;

export interface RenewalCall {
  route: "upgrade" | "refresh" | "logout";
  token: string;
  requestId?: string;
}

/**
 * The account-session rules of the API: one conversion per classic session, one
 * rotation per refresh token, the same answer for a repeated request, and the end of
 * the session for a different request made with a retired refresh token.
 */
export class FakeRenewalServer implements SessionRenewalService {
  readonly calls: RenewalCall[] = [];
  readonly faults: Fault[] = [];
  /** False for a server which does not know the conversion route. */
  supported = true;
  logoutError: Error | null = null;
  private readonly sessions = new Map<string, ServerSession>();
  private readonly issued = new Map<string, string>();
  private sequence = 0;

  constructor(private readonly now: () => number) {}

  /** A classic session, as a sign-in issues it. */
  signIn(token: string, lifetime = 30 * DAY): string {
    const id = `00000000-0000-4000-8000-${String(++this.sequence).padStart(12, "0")}`;
    this.sessions.set(id, {
      id,
      access: token,
      accessExpiresAt: this.now() + lifetime,
      generation: 0,
      upgradeToken: null,
      lastRequest: null,
      refreshExpiresAt: 0,
    });
    return token;
  }

  /** Whether an account route accepts this access token now. */
  accepts(access: string): boolean {
    return [...this.sessions.values()].some(
      (session) => session.access === access && session.accessExpiresAt > this.now(),
    );
  }

  get sessionCount(): number {
    return this.sessions.size;
  }

  get rotations(): RenewalCall[] {
    return this.calls.filter((call) => call.route !== "logout");
  }

  /** Ends every session, as a password reset or an account revocation does. */
  revokeAll(): void {
    this.sessions.clear();
  }

  upgradeSession(token: string, requestId: string): Promise<RenewableSession> {
    return this.rotate("upgrade", token, requestId);
  }

  refreshSession(token: string, requestId: string): Promise<RenewableSession> {
    return this.rotate("refresh", token, requestId);
  }

  async logout(token: string): Promise<void> {
    this.calls.push({ route: "logout", token });
    if (this.logoutError) throw this.logoutError;
    const renewable = /^fr1\.([^.]+)\.(\d+)$/.exec(token);
    if (renewable) {
      const session = this.sessions.get(renewable[1] ?? "");
      if (session && session.generation >= Number(renewable[2])) this.sessions.delete(session.id);
      return;
    }
    for (const session of this.sessions.values())
      if (session.access === token) this.sessions.delete(session.id);
  }

  private async rotate(
    route: "upgrade" | "refresh",
    token: string,
    requestId: string,
  ): Promise<RenewableSession> {
    this.calls.push({ route, token, requestId });
    await Promise.resolve();
    const fault = this.faults.shift();
    if (fault instanceof Error) throw fault;
    if (!this.supported && route === "upgrade") throw new ApiError("not_found", 404);
    if (!/^[A-Za-z0-9_-]{43}$/.test(requestId))
      throw new ApiError("invalid_session_request_id", 400);
    const result =
      route === "upgrade" ? this.upgrade(token, requestId) : this.refresh(token, requestId);
    if (fault === "lost") throw new NetworkError("timeout");
    return result;
  }

  private upgrade(token: string, requestId: string): RenewableSession {
    const session = [...this.sessions.values()].find(
      (candidate) => candidate.access === token || candidate.upgradeToken === token,
    );
    if (!session) throw new ApiError("unauthorized", 401);
    const access = this.accessFor(token, requestId);
    if (session.generation >= 1) {
      if (
        session.generation === 1 &&
        session.upgradeToken === token &&
        session.lastRequest === requestId &&
        session.access === access
      )
        return this.pair(session);
      throw new ApiError("session_upgrade_conflict", 409);
    }
    if (session.accessExpiresAt <= this.now()) throw new ApiError("unauthorized", 401);
    session.upgradeToken = token;
    return this.apply(session, access, requestId);
  }

  private refresh(token: string, requestId: string): RenewableSession {
    const parsed = /^fr1\.([^.]+)\.(\d+)$/.exec(token);
    const session = parsed ? this.sessions.get(parsed[1] ?? "") : undefined;
    const generation = Number(parsed?.[2]);
    if (
      !session ||
      session.generation < 1 ||
      session.refreshExpiresAt <= this.now() ||
      generation > session.generation
    )
      throw new ApiError("unauthorized", 401);
    const access = this.accessFor(token, requestId);
    if (generation < session.generation) {
      if (
        generation === session.generation - 1 &&
        session.lastRequest === requestId &&
        session.access === access
      )
        return this.pair(session);
      // A different request with a retired refresh token is a replay.
      this.sessions.delete(session.id);
      throw new ApiError("unauthorized", 401);
    }
    return this.apply(session, access, requestId);
  }

  private apply(session: ServerSession, access: string, requestId: string): RenewableSession {
    session.generation += 1;
    session.access = access;
    session.accessExpiresAt = this.now() + HOUR;
    session.refreshExpiresAt = this.now() + 365 * DAY;
    session.lastRequest = requestId;
    return this.pair(session);
  }

  /** The same token and request always derive the same access token. */
  private accessFor(token: string, requestId: string): string {
    const key = `${token}\n${requestId}`;
    let access = this.issued.get(key);
    if (!access) {
      access = `access-${String(this.issued.size + 1)}`;
      this.issued.set(key, access);
    }
    return access;
  }

  private pair(session: ServerSession): RenewableSession {
    return {
      accessToken: session.access,
      expiresAt: new Date(session.accessExpiresAt).toISOString(),
      refreshToken: `fr1.${session.id}.${String(session.generation)}`,
      refreshExpiresAt: new Date(session.refreshExpiresAt).toISOString(),
    };
  }
}

export class MemorySessionStorage implements AccountSessionStorage {
  value: unknown = undefined;
  readonly written: unknown[] = [];
  failRead = false;
  failWrite = false;

  async read(): Promise<unknown> {
    if (this.failRead) throw new Error("storage unavailable");
    return structuredClone(this.value);
  }

  async write(value: unknown): Promise<void> {
    if (this.failWrite) throw new Error("storage unavailable");
    this.value = structuredClone(value);
    this.written.push(structuredClone(value));
  }
}

const ACCOUNT_ROUTES = [
  "getProfile",
  "getSubscription",
  "createProxySession",
  "enrollBrowserDevice",
  "getDevices",
  "deleteDevice",
  "revokeProxySession",
  "resendVerification",
] as const;

/**
 * The given API with the account routes of the server: each refuses, with a 401 and
 * without any effect, a token which the server does not accept at that moment.
 */
export function accountRoutes<T extends ApiService>(
  api: T,
  server: FakeRenewalServer,
  presented: string[] = [],
): T {
  const guarded = new Set<string>(ACCOUNT_ROUTES);
  return new Proxy(api, {
    get(target, property, receiver) {
      const value: unknown = Reflect.get(target, property, receiver);
      if (typeof value !== "function") return value;
      if (property === "logout") return (token: string) => server.logout(token);
      if (typeof property !== "string" || !guarded.has(property))
        return (...args: unknown[]): unknown => Reflect.apply(value, target, args);
      return async (token: string, ...rest: unknown[]): Promise<unknown> => {
        presented.push(token);
        if (!server.accepts(token)) throw new ApiError("unauthorized", 401);
        return Reflect.apply(value, target, [token, ...rest]) as unknown;
      };
    },
  });
}
