// SPDX-License-Identifier: MPL-2.0

import {
  EMPTY_NETWORK_OBSERVATION,
  NETWORK_OBSERVATION_POLL_MS,
  networkRouteKey,
  type NetworkObservation,
} from "../shared/network";
import type { AppSnapshot } from "../shared/state";

const DIRECT_IP_ENDPOINT = "https://api64.ipify.org?format=json";
const VPN_IP_ENDPOINT = "https://api.ipify.org?format=json";
const CACHE_MS = 30_000;
const TIMEOUT_MS = 8_000;
const RETRY_DELAY_MS = 750;
const MAX_RESPONSE_BYTES = 1_024;

type RouteMode = "direct" | "vpn";

interface NetworkObserverOptions {
  getSnapshot(): AppSnapshot;
  verifyRoute(mode: RouteMode): Promise<boolean>;
  onChanged(): void;
  fetch?: typeof fetch;
  now?: () => number;
  retryTransientFailures?: boolean;
}

class TransientObservationError extends Error {}

class RateLimitedObservationError extends Error {
  constructor(readonly cacheMs: number) {
    super("network_observation_rate_limited");
  }
}

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
      ...EMPTY_NETWORK_OBSERVATION,
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
        this.readWithRetry(mode, revision, abort.signal),
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
    } catch (error) {
      if (!this.isCurrent(revision)) return;
      this.failureCacheMs =
        error instanceof RateLimitedObservationError ? error.cacheMs : NETWORK_OBSERVATION_POLL_MS;
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

  private async readWithRetry(
    mode: RouteMode,
    revision: number,
    signal: AbortSignal,
  ): Promise<{ ip: string; latencyMs: number }> {
    try {
      return await this.readCurrentRoute(mode, revision, signal);
    } catch (error) {
      this.assertCurrent(revision, signal);
      if (!this.options.retryTransientFailures || !(error instanceof TransientObservationError))
        throw error;
      // One retry on the same endpoint, within the original eight-second deadline.
      // Route verification runs again before any new request is sent.
      await waitForRetry(signal);
      this.assertCurrent(revision, signal);
      return this.readCurrentRoute(mode, revision, signal);
    }
  }

  private async readCurrentRoute(
    mode: RouteMode,
    revision: number,
    signal: AbortSignal,
  ): Promise<{ ip: string; latencyMs: number }> {
    if (!(await this.options.verifyRoute(mode))) throw new Error("network_route_unverified");
    this.assertCurrent(revision, signal);
    const startedAt = this.elapsedNow();
    const endpoint = mode === "vpn" ? VPN_IP_ENDPOINT : DIRECT_IP_ENDPOINT;
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
      throw new TransientObservationError("network_observation_transport_failed");
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
      throw new RateLimitedObservationError(
        Number.isFinite(delay) ? Math.max(CACHE_MS, delay) : CACHE_MS,
      );
    }
    if (!response.redirected && (response.status === 408 || response.status >= 500)) {
      void response.body?.cancel().catch(() => undefined);
      throw new TransientObservationError("network_observation_service_unavailable");
    }
    if (!response.ok || response.redirected) throw new Error("network_observation_failed");
    const raw = await readBoundedBody(response, signal);
    this.assertCurrent(revision, signal);
    const value: unknown = JSON.parse(raw);
    const ip = parsePublicIp(value, mode);
    if (!ip) throw new Error("network_observation_invalid_ip");
    const latencyMs = Math.max(0, Math.round(this.elapsedNow() - startedAt));
    if (!(await this.options.verifyRoute(mode))) throw new Error("network_route_unverified");
    this.assertCurrent(revision, signal);
    return { ip, latencyMs };
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
    }, RETRY_DELAY_MS);
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
      const chunk = await reader.read();
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

function parsePublicIp(value: unknown, mode: RouteMode): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const ip = (value as Record<string, unknown>).ip;
  if (typeof ip !== "string" || ip.length > 45) return null;
  if (isPublicIpv4(ip)) return ip;
  if (mode === "vpn") return null;
  if (!ip.includes(":") || !/^[0-9a-f:]+$/i.test(ip)) return null;
  try {
    // URL supplies the browser's IPv6 parser and canonical compression.
    const normalized = new URL(`https://[${ip}]/`).hostname.slice(1, -1);
    const halves = normalized.split("::");
    const head = halves[0] ? halves[0].split(":") : [];
    const tail = halves[1] ? halves[1].split(":") : [];
    const words =
      halves.length === 1
        ? head
        : [...head, ...Array<string>(8 - head.length - tail.length).fill("0"), ...tail];
    const first = Number.parseInt(words[0] ?? "", 16);
    const second = Number.parseInt(words[1] ?? "", 16);
    // Conservatively accept global unicast, excluding documentation and special-use blocks.
    if (first < 0x2000 || first > 0x3fff) return null;
    if (first === 0x2001 && (second < 0x0200 || second === 0x0db8)) return null;
    if (first === 0x3fff && second <= 0x0fff) return null;
    return normalized;
  } catch {
    return null;
  }
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
