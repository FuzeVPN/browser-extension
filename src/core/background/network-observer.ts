// SPDX-License-Identifier: MPL-2.0

import {
  EMPTY_NETWORK_OBSERVATION,
  NETWORK_OBSERVATION_POLL_MS,
  networkRouteKey,
  type NetworkObservation,
} from "../shared/network";
import type { AppSnapshot } from "../shared/state";

const IP_ENDPOINT = "https://api.ipify.org?format=json";
const FALLBACK_IP_ENDPOINT = "https://ipv4.icanhazip.com/";
const CACHE_MS = 30_000;
const TIMEOUT_MS = 8_000;
const PROVIDER_TIMEOUT_MS = 3_000;
const VPN_RETRY_DELAY_MS = 500;
const MAX_RESPONSE_BYTES = 1_024;

type RouteMode = "direct" | "vpn";

interface NetworkObserverOptions {
  getSnapshot(): AppSnapshot;
  verifyRoute(mode: RouteMode): Promise<boolean>;
  onChanged(): void;
  fetch?: typeof fetch;
  now?: () => number;
  useFallback?: boolean;
}

class UnverifiedRouteError extends Error {}
class TransportObservationError extends Error {}

interface PendingObservation {
  revision: number;
  abort: AbortController;
  promise: Promise<void>;
}

/** An on-demand observation of the current route, never an exemption from it. */
export class NetworkObserver {
  private state: NetworkObservation = { ...EMPTY_NETWORK_OBSERVATION };
  private routeKey: string | null = null;
  private revision = 0;
  private pending: PendingObservation | null = null;
  private failureCacheMs = NETWORK_OBSERVATION_POLL_MS;
  private readonly providerRetryAt = new Map<string, number>();
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;
  private readonly elapsedNow: () => number;

  constructor(private readonly options: NetworkObserverOptions) {
    this.fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.now = options.now ?? Date.now;
    this.elapsedNow = options.now ?? (() => performance.now());
  }

  getState(): NetworkObservation {
    return { ...this.state };
  }

  observe(snapshot: AppSnapshot): void {
    const nextKey = networkRouteKey(snapshot);
    if (nextKey === this.routeKey) return;
    this.routeKey = nextKey;
    this.revision += 1;
    this.pending?.abort.abort();
    this.pending = null;
    const mode = eligibleMode(snapshot);
    this.replace({
      ...EMPTY_NETWORK_OBSERVATION,
      mode,
      locationId: mode === "vpn" ? snapshot.activeLocationId : null,
    });
  }

  refresh(): Promise<void> {
    const snapshot = this.options.getSnapshot();
    this.observe(snapshot);
    const mode = eligibleMode(snapshot);
    if (!mode) return Promise.resolve();
    if (this.pending) return this.pending.promise;
    if (
      this.state.checkedAt !== null &&
      this.now() >= this.state.checkedAt &&
      this.now() - this.state.checkedAt <
        (this.state.status === "unavailable" ? this.failureCacheMs : CACHE_MS)
    )
      return Promise.resolve();

    const revision = this.revision;
    const abort = new AbortController();
    // Register the promise before notifying the UI, so another request deduplicates.
    const promise = Promise.resolve().then(() => this.probe(mode, revision, abort));
    this.pending = { revision, abort, promise };
    this.replace({
      ...this.state,
      status: "checking",
      mode,
      locationId: mode === "vpn" ? snapshot.activeLocationId : null,
    });
    return promise;
  }

  private async probe(mode: RouteMode, revision: number, abort: AbortController): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          abort.abort();
          reject(new Error("network_observation_timeout"));
        }, TIMEOUT_MS);
      });
      const result = await Promise.race([
        this.readProviders(mode, revision, abort.signal),
        deadline,
      ]);
      if (!this.isCurrent(revision)) return;
      this.replace({
        ...this.state,
        status: "ready",
        ip: result.ip,
        latencyMs: result.latencyMs,
        checkedAt: this.now(),
      });
    } catch {
      if (!this.isCurrent(revision)) return;
      const remainingCooldowns = this.providers(mode).map(
        (endpoint) => (this.providerRetryAt.get(endpoint) ?? 0) - this.now(),
      );
      this.failureCacheMs = remainingCooldowns.every((delay) => delay > 0)
        ? Math.min(...remainingCooldowns)
        : NETWORK_OBSERVATION_POLL_MS;
      this.replace({
        ...this.state,
        status: "unavailable",
        ip: null,
        latencyMs: null,
        checkedAt: this.now(),
      });
    } finally {
      clearTimeout(timer);
      abort.abort();
      if (this.pending?.revision === revision) this.pending = null;
    }
  }

  private providers(mode: RouteMode): string[] {
    const policy = this.options.getSnapshot().siteExclusions.applied;
    const fallbackExcluded =
      mode === "vpn" &&
      policy.enabled &&
      policy.entries.some(
        ({ domain, includeSubdomains }) =>
          domain === "ipv4.icanhazip.com" ||
          (includeSubdomains && "ipv4.icanhazip.com".endsWith(`.${domain}`)),
      );
    return this.options.useFallback && !fallbackExcluded
      ? [IP_ENDPOINT, FALLBACK_IP_ENDPOINT]
      : [IP_ENDPOINT];
  }

  private async readProviders(
    mode: RouteMode,
    revision: number,
    signal: AbortSignal,
  ): Promise<{ ip: string; latencyMs: number }> {
    const retryVpn = this.options.useFallback && mode === "vpn";
    if (retryVpn && this.state.checkedAt === null) {
      await waitForRetry(signal);
      this.assertCurrent(revision, signal);
    }
    let endpoints = this.providers(mode);
    for (let round = 0; round < (retryVpn ? 3 : 1); round++) {
      const retryEndpoints: string[] = [];
      for (const endpoint of endpoints) {
        this.assertCurrent(revision, signal);
        if ((this.providerRetryAt.get(endpoint) ?? 0) > this.now()) continue;
        try {
          return await this.readCurrentRoute(mode, revision, signal, endpoint);
        } catch (error) {
          this.assertCurrent(revision, signal);
          if (error instanceof UnverifiedRouteError) throw error;
          if (error instanceof TransportObservationError) retryEndpoints.push(endpoint);
        }
      }
      if (!retryVpn || round === 2 || retryEndpoints.length === 0) break;
      await waitForRetry(signal);
      this.assertCurrent(revision, signal);
      endpoints = retryEndpoints;
    }
    throw new Error("network_observation_failed");
  }

  private async readCurrentRoute(
    mode: RouteMode,
    revision: number,
    signal: AbortSignal,
    endpoint: string,
  ): Promise<{ ip: string; latencyMs: number }> {
    await this.verifyRoute(mode, revision, signal);
    this.assertCurrent(revision, signal);
    const startedAt = this.elapsedNow();
    const attempt = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cancel = (): void => undefined;
    let ip: string;
    try {
      const deadline = new Promise<never>((_, reject) => {
        cancel = () => {
          attempt.abort();
          reject(new DOMException("Network observation superseded", "AbortError"));
        };
        signal.addEventListener("abort", cancel, { once: true });
        if (this.options.useFallback)
          timer = setTimeout(() => {
            attempt.abort();
            reject(new Error("network_observation_timeout"));
          }, PROVIDER_TIMEOUT_MS);
      });
      ip = await Promise.race([this.readResponse(endpoint, revision, attempt.signal), deadline]);
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", cancel);
      attempt.abort();
    }
    const latencyMs = Math.max(0, Math.round(this.elapsedNow() - startedAt));
    await this.verifyRoute(mode, revision, signal);
    this.assertCurrent(revision, signal);
    return { ip, latencyMs };
  }

  private async verifyRoute(mode: RouteMode, revision: number, signal: AbortSignal): Promise<void> {
    let verified = false;
    try {
      verified = await this.options.verifyRoute(mode);
    } catch {
      /* An unavailable route inspection is not permission to try another provider. */
    }
    this.assertCurrent(revision, signal);
    if (!verified) throw new UnverifiedRouteError("network_route_unverified");
  }

  private async readResponse(
    endpoint: string,
    revision: number,
    signal: AbortSignal,
  ): Promise<string> {
    let response: Response;
    try {
      response = await this.fetcher(endpoint, {
        method: "GET",
        credentials: "omit",
        cache: "no-store",
        redirect: "error",
        referrerPolicy: "no-referrer",
        signal,
      });
    } catch {
      this.assertCurrent(revision, signal);
      throw new TransportObservationError("network_observation_transport_failed");
    }
    this.assertCurrent(revision, signal);
    if (response.status === 429) {
      void response.body?.cancel().catch(() => undefined);
      const retryAfter = response.headers.get("retry-after");
      const delay = retryAfter
        ? /^\d+$/.test(retryAfter)
          ? Number(retryAfter) * 1_000
          : Date.parse(retryAfter) - this.now()
        : CACHE_MS;
      this.providerRetryAt.set(
        endpoint,
        this.now() + (Number.isFinite(delay) ? Math.max(CACHE_MS, delay) : CACHE_MS),
      );
      throw new Error("network_observation_rate_limited");
    }
    if (!response.ok || response.redirected) {
      void response.body?.cancel().catch(() => undefined);
      throw new Error("network_observation_failed");
    }
    const raw = await readBoundedBody(response, signal);
    this.assertCurrent(revision, signal);
    const ip = endpoint === FALLBACK_IP_ENDPOINT ? raw.trim() : parsePublicIp(JSON.parse(raw));
    if (!ip || !isPublicIpv4(ip)) throw new Error("network_observation_invalid_ip");
    return ip;
  }

  private assertCurrent(revision: number, signal: AbortSignal): void {
    if (signal.aborted || !this.isCurrent(revision))
      throw new DOMException("Network observation superseded", "AbortError");
  }

  private isCurrent(revision: number): boolean {
    // Guard even if the caller has not yet published a changed snapshot.
    this.observe(this.options.getSnapshot());
    return revision === this.revision;
  }

  private replace(state: NetworkObservation): void {
    if (JSON.stringify(state) === JSON.stringify(this.state)) return;
    this.state = state;
    this.options.onChanged();
  }
}

function waitForRetry(signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const cancel = (): void => {
      clearTimeout(timer);
      reject(new DOMException("Network observation superseded", "AbortError"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", cancel);
      resolve();
    }, VPN_RETRY_DELAY_MS);
    signal.addEventListener("abort", cancel, { once: true });
  });
}

function eligibleMode(snapshot: AppSnapshot): RouteMode | null {
  if (snapshot.siteExclusions.pending || snapshot.siteExclusions.error) return null;
  if (snapshot.trafficBlocked) return null;
  if (
    snapshot.protected &&
    snapshot.activeLocationId &&
    (snapshot.status === "connected" || snapshot.status === "error")
  )
    return "vpn";
  if (
    !snapshot.protected &&
    !snapshot.protectionRequested &&
    (snapshot.status === "disconnected" || snapshot.status === "logged_out")
  )
    return "direct";
  return null;
}

async function readBoundedBody(response: Response, signal: AbortSignal): Promise<string> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength && Number(declaredLength) > MAX_RESPONSE_BYTES)
    throw new Error("network_observation_oversized");
  if (!response.body) throw new Error("network_observation_empty");
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let total = 0;
  let text = "";
  const cancel = (): void => {
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    for (;;) {
      signal.throwIfAborted();
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await reader.read();
      } catch {
        signal.throwIfAborted();
        throw new TransportObservationError("network_observation_transport_failed");
      }
      signal.throwIfAborted();
      if (chunk.done) break;
      total += chunk.value.byteLength;
      if (total > MAX_RESPONSE_BYTES) throw new Error("network_observation_oversized");
      text += decoder.decode(chunk.value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    signal.removeEventListener("abort", cancel);
    void reader.cancel().catch(() => undefined);
  }
}

function parsePublicIp(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const ip = (value as Record<string, unknown>).ip;
  return typeof ip === "string" && isPublicIpv4(ip) ? ip : null;
}

function isPublicIpv4(ip: string): boolean {
  if (!/^(?:0|[1-9]\d{0,2})(?:\.(?:0|[1-9]\d{0,2})){3}$/.test(ip)) return false;
  const octets = ip.split(".").map(Number);
  if (octets.some((part) => part > 255)) return false;
  const [first, second, third] = octets;
  if (first === undefined || second === undefined || third === undefined) return false;
  return !(
    first === 0 ||
    first === 10 ||
    first === 127 ||
    first >= 224 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 &&
      ((second === 0 && (third === 0 || third === 2)) ||
        second === 168 ||
        (second === 88 && third === 99))) ||
    (first === 198 && (second === 18 || second === 19 || (second === 51 && third === 100))) ||
    (first === 203 && second === 0 && third === 113)
  );
}
