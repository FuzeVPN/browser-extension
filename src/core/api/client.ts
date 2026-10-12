// SPDX-License-Identifier: MPL-2.0

import { API_BASE_URL, API_TIMEOUT_MS } from "../shared/config";
import {
  decodeApiError,
  decodeAuthSession,
  decodeBrowserDeviceEnrollment,
  decodeDeviceList,
  decodeLocations,
  decodeProfile,
  decodeProxySession,
  decodeSubscription,
  type AuthSession,
  type BillingSubscription,
  type BrowserDeviceEnrollment,
  type DeviceList,
  type DeviceProof,
  type ExtensionCodeExchange,
  type Location,
  type Profile,
  type ProxySession,
} from "./types";

// Bound decoded response resources independently of account or device quotas.
export const MAX_API_RESPONSE_BYTES = 4 * 1024 * 1024;

export class ApiError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    readonly retryAfterSeconds?: number,
  ) {
    super(code);
    this.name = "ApiError";
  }
}

export class NetworkError extends Error {
  constructor(readonly kind: "network" | "timeout" | "invalid_response") {
    super(kind);
    this.name = "NetworkError";
  }
}

/** A non-idempotent session creation may have committed without a usable response. */
export class ProxyCreationUncertainError extends Error {
  constructor() {
    super("proxy_creation_uncertain");
    this.name = "ProxyCreationUncertainError";
  }
}

/** Rejections that establish that the non-idempotent creation did not commit. */
export function isDefinitiveProxyCreationRejection(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    ((error.status >= 400 && error.status < 500) ||
      // Only a complete JSON rejection can establish that no session was created.
      (error.status === 503 && error.code === "capacity_unavailable"))
  );
}

type Decoder<T> = (value: unknown) => T | null;

export interface ApiService {
  login(email: string, password: string, signal?: AbortSignal): Promise<AuthSession>;
  exchangeExtensionCode(
    exchange: ExtensionCodeExchange,
    signal?: AbortSignal,
  ): Promise<AuthSession>;
  getProfile(token: string, signal?: AbortSignal): Promise<Profile>;
  getSubscription(token: string, signal?: AbortSignal): Promise<BillingSubscription>;
  getLocations(signal?: AbortSignal): Promise<Location[]>;
  createProxySession(
    token: string,
    locationId: string,
    proof: DeviceProof,
    signal?: AbortSignal,
  ): Promise<ProxySession>;
  enrollBrowserDevice(
    token: string,
    name: string,
    publicKey: string,
    signal?: AbortSignal,
  ): Promise<BrowserDeviceEnrollment>;
  getDevices(token: string, signal?: AbortSignal): Promise<DeviceList>;
  deleteDevice(token: string, deviceId: string, signal?: AbortSignal): Promise<void>;
  revokeProxySession(token: string, sessionId: string): Promise<void>;
  resendVerification(token: string, signal?: AbortSignal): Promise<void>;
  logout(token: string): Promise<void>;
}

export class ApiClient implements ApiService {
  private readonly fetchImpl: typeof fetch;

  constructor(
    fetchImpl: typeof fetch = globalThis.fetch,
    private readonly baseUrl = API_BASE_URL,
    private readonly timeoutMs = API_TIMEOUT_MS,
  ) {
    this.fetchImpl = (input, init) => fetchImpl.call(globalThis, input, init);
  }

  login(email: string, password: string, signal?: AbortSignal): Promise<AuthSession> {
    return this.request("/v1/auth/login", {
      method: "POST",
      body: { email, password },
      expectedStatus: 201,
      decoder: decodeAuthSession,
      signal,
    });
  }

  exchangeExtensionCode(
    exchange: ExtensionCodeExchange,
    signal?: AbortSignal,
  ): Promise<AuthSession> {
    return this.request("/v1/auth/extension/token", {
      method: "POST",
      body: {
        client_id: exchange.clientId,
        code: exchange.code,
        redirect_uri: exchange.redirectUri,
        code_verifier: exchange.codeVerifier,
      },
      expectedStatus: 201,
      decoder: decodeAuthSession,
      signal,
    });
  }

  getProfile(token: string, signal?: AbortSignal): Promise<Profile> {
    return this.request("/v1/me", {
      method: "GET",
      token,
      expectedStatus: 200,
      decoder: decodeProfile,
      signal,
    });
  }

  getSubscription(token: string, signal?: AbortSignal): Promise<BillingSubscription> {
    return this.request("/v1/billing/subscription", {
      method: "GET",
      token,
      expectedStatus: 200,
      decoder: decodeSubscription,
      signal,
    });
  }

  getLocations(signal?: AbortSignal): Promise<Location[]> {
    return this.request("/v1/locations", {
      method: "GET",
      expectedStatus: 200,
      decoder: decodeLocations,
      signal,
    });
  }

  async createProxySession(
    token: string,
    locationId: string,
    proof: DeviceProof,
    signal?: AbortSignal,
  ): Promise<ProxySession> {
    if (signal?.aborted) throw new DOMException("Operation cancelled", "AbortError");
    try {
      return await this.request("/v1/proxy/sessions", {
        method: "POST",
        token,
        body: {
          location_id: locationId,
          device_id: proof.deviceId,
          device_timestamp: proof.deviceTimestamp,
          device_nonce: proof.deviceNonce,
          device_signature: proof.deviceSignature,
        },
        expectedStatus: 201,
        decoder: decodeProxySession,
        signal,
      });
    } catch (error) {
      if (isDefinitiveProxyCreationRejection(error)) throw error;
      throw new ProxyCreationUncertainError();
    }
  }

  enrollBrowserDevice(
    token: string,
    name: string,
    publicKey: string,
    signal?: AbortSignal,
  ): Promise<BrowserDeviceEnrollment> {
    return this.request("/v1/devices/browser", {
      method: "POST",
      token,
      body: { name, public_key: publicKey },
      expectedStatus: [200, 201],
      decoder: decodeBrowserDeviceEnrollment,
      signal,
    });
  }

  getDevices(token: string, signal?: AbortSignal): Promise<DeviceList> {
    return this.request("/v1/devices", {
      method: "GET",
      token,
      expectedStatus: 200,
      decoder: decodeDeviceList,
      signal,
    });
  }

  deleteDevice(token: string, deviceId: string, signal?: AbortSignal): Promise<void> {
    return this.requestVoid(`/v1/devices/${encodeURIComponent(deviceId)}`, {
      method: "DELETE",
      token,
      expectedStatus: 204,
      signal,
    });
  }

  revokeProxySession(token: string, sessionId: string): Promise<void> {
    return this.requestVoid(`/v1/proxy/sessions/${encodeURIComponent(sessionId)}`, {
      method: "DELETE",
      token,
      expectedStatus: 204,
    });
  }

  resendVerification(token: string, signal?: AbortSignal): Promise<void> {
    return this.requestVoid("/v1/auth/email/resend", {
      method: "POST",
      token,
      expectedStatus: 204,
      signal,
    });
  }

  logout(token: string): Promise<void> {
    return this.requestVoid("/v1/auth/logout", {
      method: "POST",
      token,
      expectedStatus: 204,
    });
  }

  private async request<T>(
    path: string,
    options: RequestOptions & { decoder: Decoder<T> },
  ): Promise<T> {
    return this.fetchAndRead(path, options, async (response) => {
      const value = await safeJson(response);
      const decoded = options.decoder(value);
      if (decoded === null) throw new NetworkError("invalid_response");
      return decoded;
    });
  }

  private async requestVoid(path: string, options: RequestOptions): Promise<void> {
    await this.fetchAndRead(path, options, () => undefined);
  }

  private async fetchAndRead<T>(
    path: string,
    options: RequestOptions,
    readResponse: (response: Response) => T | Promise<T>,
  ): Promise<T> {
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), this.timeoutMs);
    const { signal, dispose } = combineSignals(options.signal, timeout.signal);
    try {
      const headers = new Headers({ Accept: "application/json" });
      if (options.body !== undefined) headers.set("Content-Type", "application/json");
      if (options.token) headers.set("Authorization", `Bearer ${options.token}`);
      const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: options.method,
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        credentials: "omit",
        cache: "no-store",
        signal,
      });
      const expected = Array.isArray(options.expectedStatus)
        ? options.expectedStatus.includes(response.status)
        : response.status === options.expectedStatus;
      if (!expected) {
        const payload = decodeApiError(
          await safeJson(response).catch((error: unknown) => {
            // An HTTP rejection and its headers remain reliable when its body is
            // malformed, interrupted or too slow. Caller cancellation belongs to
            // the abandoned operation, so it must not surface an obsolete 401.
            if (response.status >= 400 && !options.signal?.aborted) return null;
            throw error;
          }),
        );
        throw new ApiError(
          payload?.error ?? "server_error",
          response.status,
          retryAfterSeconds(response.headers.get("Retry-After"), payload?.retryAfterSeconds),
        );
      }
      // Keep the deadline and error handling active while consuming the body.
      return await readResponse(response);
    } catch (error) {
      if (options.signal?.aborted) throw new DOMException("Operation cancelled", "AbortError");
      if (error instanceof ApiError || error instanceof NetworkError) throw error;
      if (timeout.signal.aborted) throw new NetworkError("timeout");
      throw new NetworkError("network");
    } finally {
      clearTimeout(timer);
      dispose();
    }
  }
}

interface RequestOptions {
  method: "GET" | "POST" | "DELETE";
  token?: string;
  body?: Record<string, unknown>;
  expectedStatus: number | number[];
  signal?: AbortSignal;
}

async function safeJson(response: Response): Promise<unknown> {
  if (!response.body) return null;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      // Fetch exposes decompressed bytes. Content-Length may describe compressed
      // data or be absent/incorrect, so enforce the budget on the stream itself.
      if (bytes > MAX_API_RESPONSE_BYTES) {
        void reader.cancel().catch(() => undefined);
        throw new NetworkError("invalid_response");
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } finally {
    reader.releaseLock();
  }
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new NetworkError("invalid_response");
  }
}

function retryAfterSeconds(
  header: string | null,
  fallback: number | undefined,
): number | undefined {
  const now = Date.now();
  const value = header?.trim();
  let requested: number | undefined;
  if (value && /^\d+$/.test(value)) requested = Number(value);
  else if (value) {
    const deadline = httpDate(value, now);
    if (deadline !== undefined) requested = Math.max(0, Math.ceil((deadline - now) / 1000));
  }
  // A valid header, including zero, takes precedence. Invalid/unrepresentable
  // values fall back to JSON; do not silently shorten a valid server deadline.
  return validRetryDelay(requested, now) ?? validRetryDelay(fallback, now);
}

function validRetryDelay(value: number | undefined, now: number): number | undefined {
  if (value === undefined || !Number.isFinite(value) || value < 0) return undefined;
  const seconds = Math.ceil(value);
  const deadline = now + seconds * 1000;
  // Chrome alarms use absolute timestamps, not a signed 32-bit setTimeout delay.
  // Reject deadlines outside the safe integer/Date range rather than cap them.
  if (!Number.isSafeInteger(deadline) || !Number.isFinite(new Date(deadline).getTime()))
    return undefined;
  return seconds;
}

function httpDate(value: string, now: number): number | undefined {
  const standard = /^(\w{3}), (\d{2}) (\w{3}) (\d{4}) (\d{2}):(\d{2}):(\d{2}) GMT$/.exec(value);
  const obsolete = /^(\w+), (\d{2})-(\w{3})-(\d{2}) (\d{2}):(\d{2}):(\d{2}) GMT$/.exec(value);
  const asctime = /^(\w{3}) (\w{3}) ( \d|\d{2}) (\d{2}):(\d{2}):(\d{2}) (\d{4})$/.exec(value);
  const parts = standard ?? obsolete;
  const weekday = parts?.[1] ?? asctime?.[1];
  const day = Number(parts?.[2] ?? asctime?.[3]);
  const monthName = parts?.[3] ?? asctime?.[2];
  let year = Number(parts?.[4] ?? asctime?.[7]);
  const hour = Number(parts?.[5] ?? asctime?.[4]);
  const minute = Number(parts?.[6] ?? asctime?.[5]);
  const second = Number(parts?.[7] ?? asctime?.[6]);
  if (!weekday || !monthName) return undefined;
  const months = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];
  const month = months.indexOf(monthName);
  const weekdays = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  if (!weekdays.some((name) => weekday === (obsolete ? name : name.slice(0, 3)))) return undefined;
  if (obsolete) year += Math.floor(new Date(now).getUTCFullYear() / 100) * 100;
  const date = new Date(0);
  date.setUTCFullYear(year, month, day);
  date.setUTCHours(hour, minute, second, 0);
  if (obsolete) {
    const latest = new Date(now);
    latest.setUTCFullYear(latest.getUTCFullYear() + 50);
    if (date.getTime() > latest.getTime()) date.setUTCFullYear((year -= 100));
  }
  if (
    month < 0 ||
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month ||
    date.getUTCDate() !== day ||
    date.getUTCHours() !== hour ||
    date.getUTCMinutes() !== minute ||
    date.getUTCSeconds() !== second
  )
    return undefined;
  return date.getTime();
}

function combineSignals(
  primary: AbortSignal | undefined,
  timeout: AbortSignal,
): { signal: AbortSignal; dispose: () => void } {
  if (!primary) return { signal: timeout, dispose: () => undefined };
  if (primary.aborted) return { signal: primary, dispose: () => undefined };
  const controller = new AbortController();
  const abort = () => controller.abort();
  primary.addEventListener("abort", abort, { once: true });
  timeout.addEventListener("abort", abort, { once: true });
  return {
    signal: controller.signal,
    dispose() {
      primary.removeEventListener("abort", abort);
      timeout.removeEventListener("abort", abort);
    },
  };
}
