// SPDX-License-Identifier: MPL-2.0

import { readWebAuthIdentity, isValidRedirectUri } from "@platform/web-auth";
import type { WebAuthIdentity } from "../../platform/contracts/web-auth";
export type { WebAuthIdentity } from "../../platform/contracts/web-auth";

export const WEB_AUTH_CLIENT_ID = "fuzevpn-browser-extension";
export const WEB_AUTH_TIMEOUT_MS = 5 * 60 * 1_000;

const RANDOM_BYTES = 32;
const NATIVE_RETRY_INTERVAL_MS = 1_000;
const MAX_RETURN_URL_LENGTH = 2_048;
// A 32-byte code uses 43 unpadded base64url characters; unused bits must be zero.
const OPAQUE_CODE = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;
const LOCALE = /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})?$/;

export interface WebAuthorization {
  clientId: string;
  code: string;
  redirectUri: string;
  codeVerifier: string;
}

export interface WebAuthService {
  authorize(signal?: AbortSignal, locale?: string): Promise<WebAuthorization>;
}

export interface WebAuthCrypto {
  getRandomValues(array: Uint8Array): Uint8Array;
  subtle: Pick<SubtleCrypto, "digest">;
}

export interface WebAuthOptions {
  /** Trusted configuration only; never accept the authentication page from a message or tab. */
  startUrl: string;
  identity?: WebAuthIdentity;
  crypto?: WebAuthCrypto;
  timeoutMs?: number;
  now?: () => number;
}

export class WebAuthError extends Error {
  constructor(
    readonly code:
      | "web_login_unavailable"
      | "web_login_busy"
      | "web_login_timeout"
      | "web_login_invalid_callback"
      | "web_login_denied"
      | "web_login_cancelled",
  ) {
    super(code);
    this.name = "WebAuthError";
  }
}

interface Attempt {
  deadline: number;
  settled: boolean;
  timer: ReturnType<typeof setTimeout>;
  signal?: AbortSignal;
  onAbort: () => void;
  preparationAbort: AbortController;
  nativeStartedAt: number;
  nativePending: boolean;
  resolve: (authorization: WebAuthorization) => void;
  reject: (error: Error) => void;
}

/**
 * PKCE secrets are confined to the background context and disappear on termination.
 * The browsers do not offer cancellation of an interactive identity window. Local
 * cancellation/expiration retires its attempt, so a hidden, stalled native flow
 * cannot prevent an explicit retry. Retired responses are discarded. Launches after
 * abandonment are spaced to avoid accumulating windows through rapid cancellation.
 */
export class ExtensionWebAuthService implements WebAuthService {
  private readonly startUrl: string;
  private readonly identity: WebAuthIdentity;
  private readonly cryptoImpl: WebAuthCrypto;
  private readonly timeoutMs: number;
  private readonly now: () => number;
  private active: Attempt | null = null;
  private nativeRetryAt = 0;

  constructor(options: WebAuthOptions) {
    this.startUrl = validateStartUrl(options.startUrl);
    this.identity = options.identity ?? platformIdentity();
    this.cryptoImpl = options.crypto ?? globalThis.crypto;
    this.timeoutMs = options.timeoutMs ?? WEB_AUTH_TIMEOUT_MS;
    this.now = options.now ?? Date.now;
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0 || this.timeoutMs > 10 * 60 * 1_000)
      throw new WebAuthError("web_login_unavailable");
  }

  authorize(signal?: AbortSignal, locale?: string): Promise<WebAuthorization> {
    if (signal?.aborted) return Promise.reject(cancelled());
    if (this.active) return Promise.reject(new WebAuthError("web_login_busy"));
    let canonicalLocale: string | undefined;
    if (locale !== undefined) {
      const candidate = locale.replaceAll("_", "-");
      if (!LOCALE.test(candidate)) return Promise.reject(new WebAuthError("web_login_unavailable"));
      try {
        [canonicalLocale] = Intl.getCanonicalLocales(candidate);
      } catch {
        return Promise.reject(new WebAuthError("web_login_unavailable"));
      }
    }

    return new Promise<WebAuthorization>((resolve, reject) => {
      const attempt: Attempt = {
        deadline: this.now() + this.timeoutMs,
        settled: false,
        timer: setTimeout(() => {
          this.reject(attempt, new WebAuthError("web_login_timeout"));
        }, this.timeoutMs),
        signal,
        onAbort: () => this.reject(attempt, cancelled()),
        preparationAbort: new AbortController(),
        nativeStartedAt: 0,
        nativePending: false,
        resolve,
        reject,
      };
      this.active = attempt;
      signal?.addEventListener("abort", attempt.onAbort, { once: true });
      // Catch an abort that raced with listener installation.
      if (signal?.aborted) attempt.onAbort();
      void this.run(attempt, canonicalLocale);
    });
  }

  private async run(attempt: Attempt, locale?: string): Promise<void> {
    try {
      if (!this.isCurrent(attempt)) return;
      const redirectUri = validateRedirectUri(this.identity.getRedirectURL("auth"));
      const state = randomValue(this.cryptoImpl);
      const codeVerifier = randomValue(this.cryptoImpl);
      const challenge = base64Url(
        new Uint8Array(
          await this.cryptoImpl.subtle.digest("SHA-256", new TextEncoder().encode(codeVerifier)),
        ),
      );
      if (!this.isCurrent(attempt)) return;

      const retryDelay = this.nativeRetryAt - performance.now();
      if (retryDelay > 0) {
        await waitForNativeRetry(retryDelay, attempt.preparationAbort.signal);
        if (!this.isCurrent(attempt)) return;
      }

      const start = new URL(this.startUrl);
      start.searchParams.set("client_id", WEB_AUTH_CLIENT_ID);
      start.searchParams.set("redirect_uri", redirectUri);
      start.searchParams.set("state", state);
      start.searchParams.set("code_challenge", challenge);
      start.searchParams.set("code_challenge_method", "S256");
      if (locale) start.searchParams.set("locale", locale);

      let response: string | undefined;
      attempt.nativeStartedAt = performance.now();
      attempt.nativePending = true;
      try {
        response = await this.identity.launchWebAuthFlow({ url: start.href, interactive: true });
      } catch (error) {
        // Browser errors are never passed through: they may include the authentication URL.
        const dismissed =
          typeof error === "object" &&
          error !== null &&
          "message" in error &&
          [
            "User cancelled or denied access.",
            "The user did not approve access.",
            "User cancelled the flow.",
          ].includes(String(error.message));
        throw new WebAuthError(dismissed ? "web_login_cancelled" : "web_login_unavailable");
      } finally {
        // Only this attempt changes: an older promise must never release or
        // invalidate a newer attempt when it eventually settles.
        attempt.nativePending = false;
      }
      if (!this.isCurrent(attempt)) return;
      const code = validateResponse(response, redirectUri, state);
      this.finish(attempt);
      attempt.resolve({ clientId: WEB_AUTH_CLIENT_ID, code, redirectUri, codeVerifier });
    } catch (error) {
      if (!this.isCurrent(attempt)) return;
      this.reject(
        attempt,
        error instanceof WebAuthError ? error : new WebAuthError("web_login_unavailable"),
      );
    }
  }

  private isCurrent(attempt: Attempt): boolean {
    if (attempt.settled || this.active !== attempt) return false;
    if (attempt.signal?.aborted) {
      this.reject(attempt, cancelled());
      return false;
    }
    // Timers may run late after a suspension: a valid-looking return never extends the deadline.
    if (this.now() >= attempt.deadline) {
      this.reject(attempt, new WebAuthError("web_login_timeout"));
      return false;
    }
    return true;
  }

  private reject(attempt: Attempt, error: Error): void {
    if (attempt.settled) return;
    if (attempt.nativePending)
      this.nativeRetryAt = Math.max(
        this.nativeRetryAt,
        attempt.nativeStartedAt + NATIVE_RETRY_INTERVAL_MS,
      );
    this.finish(attempt);
    attempt.reject(error);
  }

  private finish(attempt: Attempt): void {
    attempt.settled = true;
    clearTimeout(attempt.timer);
    attempt.signal?.removeEventListener("abort", attempt.onAbort);
    attempt.preparationAbort.abort();
    if (this.active === attempt) this.active = null;
  }
}

function validateStartUrl(value: string): string {
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      value.includes("?") ||
      value.includes("#") ||
      url.href !== value
    )
      throw new WebAuthError("web_login_unavailable");
    return url.href;
  } catch {
    throw new WebAuthError("web_login_unavailable");
  }
}

function validateRedirectUri(value: string): string {
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      !isValidRedirectUri(url) ||
      url.port ||
      url.username ||
      url.password ||
      url.pathname !== "/auth" ||
      url.search ||
      url.hash ||
      value.includes("?") ||
      value.includes("#") ||
      url.href !== value
    )
      throw new WebAuthError("web_login_unavailable");
    return value;
  } catch {
    throw new WebAuthError("web_login_unavailable");
  }
}

function validateResponse(value: string | undefined, redirectUri: string, state: string): string {
  if (!value || value.length > MAX_RETURN_URL_LENGTH)
    throw new WebAuthError("web_login_invalid_callback");
  try {
    const url = new URL(value);
    const redirect = new URL(redirectUri);
    if (
      url.origin !== redirect.origin ||
      url.pathname !== redirect.pathname ||
      url.username ||
      url.password ||
      url.hash ||
      value.includes("#") ||
      !value.startsWith(`${redirectUri}?`) ||
      url.searchParams.toString() !== url.search.slice(1) ||
      // Reject URL normalisation (encoded paths, explicit default ports, whitespace, etc.).
      url.href !== value
    )
      throw new WebAuthError("web_login_invalid_callback");
    for (const key of url.searchParams.keys()) {
      if (!["code", "state", "error"].includes(key) || url.searchParams.getAll(key).length !== 1)
        throw new WebAuthError("web_login_invalid_callback");
    }
    if (url.searchParams.get("state") !== state)
      throw new WebAuthError("web_login_invalid_callback");

    const code = url.searchParams.get("code");
    const error = url.searchParams.get("error");
    if (error !== null) {
      if (
        code !== null ||
        !["access_denied", "login_required", "temporarily_unavailable"].includes(error)
      )
        throw new WebAuthError("web_login_invalid_callback");
      throw new WebAuthError(
        error === "access_denied" ? "web_login_denied" : "web_login_unavailable",
      );
    }
    if (!code || !OPAQUE_CODE.test(code)) throw new WebAuthError("web_login_invalid_callback");
    return code;
  } catch (error) {
    throw error instanceof WebAuthError ? error : new WebAuthError("web_login_invalid_callback");
  }
}

function platformIdentity(): WebAuthIdentity {
  try {
    return readWebAuthIdentity();
  } catch {
    throw new WebAuthError("web_login_unavailable");
  }
}

function randomValue(cryptoImpl: WebAuthCrypto): string {
  const bytes = new Uint8Array(RANDOM_BYTES);
  cryptoImpl.getRandomValues(bytes);
  return base64Url(bytes);
}

function base64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function cancelled(): DOMException {
  return new DOMException("Web authentication cancelled", "AbortError");
}

function waitForNativeRetry(delayMs: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      reject(cancelled());
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, delayMs);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}
