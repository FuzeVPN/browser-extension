// SPDX-License-Identifier: MPL-2.0

import { VpnNodeIpv4 } from "../../src/core/background/vpn-node-ipv4";
import { EMPTY_SNAPSHOT } from "../../src/core/shared/state";

const host = "gravelines-03.fuzevpn.com";
const ipv4 = "146.59.151.151";
const connected = (vpnNodeAddress = host) => ({
  ...structuredClone(EMPTY_SNAPSHOT),
  protected: true,
  vpnNodeAddress,
});
const dns = (name = host, ip = ipv4, ttl = 300) =>
  new Response(JSON.stringify({ Status: 0, Answer: [{ name, type: 1, data: ip, TTL: ttl }] }));

describe("VPN node IPv4 resolution", () => {
  it("publishes a literal IPv4 without any network lookup", () => {
    const fetcher = vi.fn<typeof fetch>();
    const resolver = new VpnNodeIpv4(vi.fn(), fetcher);
    const snapshot = connected(ipv4);
    resolver.observe(snapshot);
    expect(resolver.getState(snapshot)).toEqual({
      vpnNodeAddress: ipv4,
      vpnNodeAddressStatus: "ready",
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("resolves the real node name to its A record and reuses the DNS TTL", async () => {
    let now = 0;
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => dns(host, ipv4, 60));
    const changed = vi.fn();
    const resolver = new VpnNodeIpv4(changed, fetcher, () => now);
    const snapshot = connected();
    resolver.observe(snapshot);
    resolver.observe(snapshot);
    expect(resolver.getState(snapshot)).toEqual({
      vpnNodeAddress: null,
      vpnNodeAddressStatus: "checking",
    });
    await vi.waitFor(() => expect(resolver.getState(snapshot).vpnNodeAddress).toBe(ipv4));
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, options] = fetcher.mock.calls[0]!;
    expect(new URL(url as string).searchParams.get("type")).toBe("A");
    expect(options).toMatchObject({
      credentials: "omit",
      redirect: "error",
      referrerPolicy: "no-referrer",
    });
    resolver.observe(EMPTY_SNAPSHOT);
    resolver.observe(snapshot);
    expect(resolver.getState(snapshot).vpnNodeAddress).toBe(ipv4);
    expect(fetcher).toHaveBeenCalledTimes(1);
    now = 60_001;
    resolver.observe(snapshot);
    await vi.waitFor(() => expect(changed).toHaveBeenCalledTimes(2));
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("uses the second DNS resolver when the first is unavailable", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError("failed"))
      .mockResolvedValueOnce(dns());
    const resolver = new VpnNodeIpv4(vi.fn(), fetcher);
    const snapshot = connected();
    resolver.observe(snapshot);
    await vi.waitFor(() => expect(resolver.getState(snapshot).vpnNodeAddress).toBe(ipv4));
    expect(new URL(fetcher.mock.calls[1]?.[0] as string).hostname).toBe("cloudflare-dns.com");
  });

  it("accepts an A record through CNAME but never an AAAA or unrelated answer", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          Status: 0,
          Answer: [
            { name: host + ".", type: 28, data: "2001:4860::1" },
            { name: "unrelated.example.com", type: 1, data: "8.8.8.8" },
            { name: host, type: 5, data: "alias.fuzevpn.com." },
            { name: "alias.fuzevpn.com", type: 1, data: ipv4, TTL: 300 },
          ],
        }),
      ),
    );
    const resolver = new VpnNodeIpv4(vi.fn(), fetcher);
    const snapshot = connected();
    resolver.observe(snapshot);
    await vi.waitFor(() => expect(resolver.getState(snapshot).vpnNodeAddress).toBe(ipv4));
  });

  it("keeps IPv6-only DNS unavailable without exposing the hostname and throttles retries", async () => {
    let now = 0;
    const fetcher = vi.fn<typeof fetch>().mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            Status: 0,
            Answer: [{ name: host, type: 28, data: "2001:4860::1" }],
          }),
        ),
    );
    const resolver = new VpnNodeIpv4(vi.fn(), fetcher, () => now);
    const snapshot = connected();
    resolver.observe(snapshot);
    await vi.waitFor(() =>
      expect(resolver.getState(snapshot).vpnNodeAddressStatus).toBe("unavailable"),
    );
    expect(resolver.getState(snapshot).vpnNodeAddress).toBeNull();
    resolver.observe(snapshot);
    expect(fetcher).toHaveBeenCalledTimes(2);
    now = 5001;
    resolver.observe(snapshot);
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(4));
  });

  it("discards delayed DNS after switching nodes or disconnecting", async () => {
    let release!: (value: Response) => void;
    const fetcher = vi.fn<typeof fetch>().mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const changed = vi.fn();
    const resolver = new VpnNodeIpv4(changed, fetcher);
    const previous = connected();
    resolver.observe(previous);
    const next = connected("185.159.157.10");
    resolver.observe(next);
    release(dns());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(resolver.getState(next).vpnNodeAddress).toBe(next.vpnNodeAddress);
    expect(resolver.getState(previous).vpnNodeAddress).toBeNull();
    expect(changed).not.toHaveBeenCalled();
    resolver.observe(EMPTY_SNAPSHOT);
    expect(resolver.getState(next).vpnNodeAddress).toBeNull();
    expect(fetcher.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  });
});
