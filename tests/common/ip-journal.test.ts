// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it, vi } from "vitest";
import { IpJournal } from "../../src/core/background/ip-journal";

describe("local IP journal", () => {
  it("retains HTTP and native error codes without IP values, URLs or secrets", async () => {
    const journal = new IpJournal({
      read: async () => [
        {
          at: 1_000,
          event: "browser_error",
          netError: "net::ERR_PROXY_CONNECTION_FAILED",
          password: "secret",
          ip: "8.8.8.8",
          url: "https://api.ipify.org/",
        },
      ],
      write: async () => undefined,
      now: () => 1_000,
    });
    journal.record({
      event: "failure",
      code: "http_error",
      httpStatus: 403,
      durationMs: 371,
      mode: "vpn",
    });
    const result = await journal.snapshot();
    expect(result.entries).toHaveLength(2);
    expect(result.entries[0]?.netError).toBe("net::ERR_PROXY_CONNECTION_FAILED");
    expect(result.entries[1]?.httpStatus).toBe(403);
    expect(JSON.stringify(result)).not.toMatch(/secret|8\.8\.8\.8|https:/);
  });

  it("bounds its size and discards old events after worker restoration", async () => {
    let now = 1_000;
    const write = vi.fn(async () => undefined);
    const journal = new IpJournal({ read: async () => [], write, now: () => now });
    for (let index = 0; index < 100; index++) journal.record({ event: "ready", durationMs: index });
    expect((await journal.snapshot()).entries).toHaveLength(80);
    now += 600_001;
    expect((await journal.snapshot()).entries).toEqual([]);
  });
});
