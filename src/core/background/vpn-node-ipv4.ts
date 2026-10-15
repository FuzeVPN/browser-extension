// SPDX-License-Identifier: MPL-2.0

import { isIpv4, isPublicIpv4, isVpnNodeAddress } from "../shared/ip-address";
import type { AppSnapshot } from "../shared/state";

const RESOLVERS = ["https://dns.google/resolve", "https://cloudflare-dns.com/dns-query"];

/** Resolve the active node's A record; never substitute a hostname or an AAAA record. */
export class VpnNodeIpv4 {
  private host: string | null = null;
  private ip: string | null = null;
  private status: "idle" | "checking" | "ready" | "unavailable" = "idle";
  private pending: AbortController | null = null;
  private retryAt = 0;
  private readonly cache = new Map<string, { ip: string; expiresAt: number }>();

  constructor(
    private readonly onChanged: () => void,
    private readonly fetcher: typeof fetch = globalThis.fetch.bind(globalThis),
    private readonly now: () => number = Date.now,
  ) {}

  observe(snapshot: AppSnapshot): void {
    const host =
      snapshot.protected && isVpnNodeAddress(snapshot.vpnNodeAddress)
        ? snapshot.vpnNodeAddress.toLowerCase()
        : null;
    if (host !== this.host) {
      this.pending?.abort();
      this.pending = null;
      this.host = host;
      this.ip = null;
      this.status = "idle";
      this.retryAt = 0;
    }
    if (!host) return;
    const cached = this.cache.get(host);
    if (isIpv4(host) || (cached && cached.expiresAt > this.now())) {
      this.ip = isIpv4(host) ? host : (cached?.ip ?? null);
      this.status = "ready";
      return;
    }
    if (this.pending || this.retryAt > this.now()) return;
    this.ip = null;
    this.status = "checking";
    const pending = new AbortController();
    this.pending = pending;
    void this.resolve(host, pending.signal)
      .then((answer) => {
        if (this.pending !== pending) return;
        this.ip = answer.ip;
        this.status = "ready";
        if (this.cache.size >= 64) this.cache.delete(this.cache.keys().next().value ?? "");
        this.cache.set(host, { ip: answer.ip, expiresAt: this.now() + answer.ttl * 1000 });
      })
      .catch(() => {
        if (this.pending !== pending) return;
        this.status = "unavailable";
        this.retryAt = this.now() + 5000;
      })
      .finally(() => {
        if (this.pending !== pending) return;
        this.pending = null;
        this.onChanged();
      });
  }

  getState(snapshot: AppSnapshot): {
    vpnNodeAddress: string | null;
    vpnNodeAddressStatus: "idle" | "checking" | "ready" | "unavailable";
  } {
    const current = snapshot.protected && snapshot.vpnNodeAddress?.toLowerCase() === this.host;
    return {
      vpnNodeAddress: current ? this.ip : null,
      vpnNodeAddressStatus: current ? this.status : "idle",
    };
  }

  private async resolve(host: string, signal: AbortSignal): Promise<{ ip: string; ttl: number }> {
    for (const endpoint of RESOLVERS) {
      if (signal.aborted) break;
      const request = new AbortController();
      const cancel = () => request.abort();
      signal.addEventListener("abort", cancel, { once: true });
      const timer = setTimeout(cancel, 3000);
      try {
        const url = new URL(endpoint);
        url.searchParams.set("name", host);
        url.searchParams.set("type", "A");
        if (url.hostname === "dns.google") url.searchParams.set("edns_client_subnet", "0.0.0.0/0");
        const response = await this.fetcher(url.href, {
          credentials: "omit",
          referrerPolicy: "no-referrer",
          redirect: "error",
          cache: "no-store",
          headers: { Accept: "application/dns-json" },
          signal: request.signal,
        });
        if (!response.ok) continue;
        const text = await response.text();
        if (text.length > 16_384) continue;
        const answer = dnsIpv4(JSON.parse(text) as unknown, host);
        if (answer) return answer;
      } catch {
        // The other resolver is independent of an IP echo service or the first resolver.
      } finally {
        clearTimeout(timer);
        signal.removeEventListener("abort", cancel);
      }
    }
    throw new Error("node_ipv4_unavailable");
  }
}

function dnsIpv4(value: unknown, host: string): { ip: string; ttl: number } | null {
  if (!value || typeof value !== "object") return null;
  const body = value as { Status?: unknown; Answer?: unknown };
  if (body.Status !== 0 || !Array.isArray(body.Answer)) return null;
  const records = body.Answer.slice(0, 64) as ({
    name?: unknown;
    type?: unknown;
    data?: unknown;
    TTL?: unknown;
  } | null)[];
  const names = new Set([host]);
  for (let i = 0; i < 8; i++) {
    for (const record of records) {
      if (
        record?.type === 5 &&
        typeof record.name === "string" &&
        names.has(record.name.toLowerCase().replace(/\.$/, "")) &&
        typeof record.data === "string"
      )
        names.add(record.data.toLowerCase().replace(/\.$/, ""));
    }
  }
  for (const record of records) {
    if (
      record?.type === 1 &&
      typeof record.name === "string" &&
      names.has(record.name.toLowerCase().replace(/\.$/, "")) &&
      typeof record.data === "string" &&
      isPublicIpv4(record.data)
    )
      return {
        ip: record.data,
        ttl: typeof record.TTL === "number" ? Math.max(0, Math.min(record.TTL, 300)) : 60,
      };
  }
  return null;
}
