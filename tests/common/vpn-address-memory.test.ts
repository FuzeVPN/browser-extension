// SPDX-License-Identifier: MPL-2.0

import { VpnAddressBook } from "../../src/core/background/vpn-addresses";
import type { NetworkObservation } from "../../src/core/shared/network";

const NOW = Date.parse("2026-11-12T10:00:00Z");
const DAY = 24 * 60 * 60 * 1_000;

function measured(
  locationId: string,
  ip: string,
  changes: Partial<NetworkObservation> = {},
): NetworkObservation {
  return {
    status: "ready",
    mode: "vpn",
    ip,
    checkedAt: NOW,
    latencyMs: 40,
    locationId,
    ...changes,
  };
}

function fixture(initial?: unknown) {
  const state = { now: NOW, stored: initial };
  const read = vi.fn(async () => structuredClone(state.stored));
  const write = vi.fn(async (value: unknown) => {
    state.stored = structuredClone(value);
  });
  const book = new VpnAddressBook({ storage: { read, write }, now: () => state.now });
  const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
  return { state, read, write, book, settle };
}

describe("the IPv4 remembered for each VPN location", () => {
  it("is the last verified VPN measurement of that location", async () => {
    const f = fixture();
    await f.book.initialize();
    expect(f.book.recall("fr-paris")).toBeNull();

    f.book.record(measured("fr-paris", "8.8.4.4"));
    f.book.record(measured("de-berlin", "9.9.9.9"));
    expect(f.book.recall("fr-paris")).toBe("8.8.4.4");
    expect(f.book.recall("de-berlin")).toBe("9.9.9.9");
    expect(f.book.recall("us-newyork")).toBeNull();

    f.state.now += 60_000;
    f.book.record(measured("fr-paris", "1.1.1.1", { checkedAt: f.state.now }));
    expect(f.book.recall("fr-paris")).toBe("1.1.1.1");
  });

  it.each([
    ["a measurement still in progress", { status: "checking" }],
    ["a failed measurement", { status: "unavailable" }],
    ["a direct measurement", { mode: "direct", locationId: null }],
    ["a measurement without a location", { locationId: null }],
    ["a measurement without a time", { checkedAt: null }],
    ["a measurement dated in the future", { checkedAt: NOW + 1 }],
    ["an IPv6 address", { ip: "2606:4700:4700::1111" }],
    ["a private address", { ip: "192.168.1.20" }],
    ["a malformed address", { ip: "8.8.4" }],
  ] as const)("never remembers %s", async (_label, changes) => {
    const f = fixture();
    await f.book.initialize();
    f.book.record(measured("fr-paris", "8.8.4.4", changes));
    await f.settle();
    expect(f.book.recall("fr-paris")).toBeNull();
    expect(f.write).not.toHaveBeenCalled();
  });

  it("forgets a location whose measurement finally failed, in the next worker too", async () => {
    const f = fixture();
    await f.book.initialize();
    f.book.record(measured("fr-paris", "8.8.4.4"));
    f.book.record(measured("de-berlin", "9.9.9.9"));
    await f.settle();

    f.book.record(measured("fr-paris", "8.8.4.4", { status: "unavailable", ip: null }));
    await f.settle();
    expect(f.book.recall("fr-paris")).toBeNull();
    expect(f.book.recall("de-berlin")).toBe("9.9.9.9");

    const restarted = new VpnAddressBook({
      storage: { read: f.read, write: f.write },
      now: () => f.state.now,
    });
    await restarted.initialize();
    expect(restarted.recall("fr-paris")).toBeNull();
    expect(restarted.recall("de-berlin")).toBe("9.9.9.9");
  });

  it("writes nothing for a failure on a location it does not remember", async () => {
    const f = fixture();
    await f.book.initialize();
    // The popup measures a failing route again every five seconds.
    for (let attempt = 0; attempt < 5; attempt++)
      f.book.record(measured("fr-paris", "8.8.4.4", { status: "unavailable", ip: null }));
    await f.settle();
    expect(f.write).not.toHaveBeenCalled();
  });

  it("does not bring back an address forgotten while its stored record was being read", async () => {
    const f = fixture({
      version: 1,
      addresses: [{ locationId: "fr-paris", ip: "8.8.4.4", checkedAt: NOW - 1_000 }],
    });
    const loading = f.book.initialize();
    f.book.record(measured("fr-paris", "8.8.4.4", { status: "unavailable", ip: null }));
    await loading;
    await f.settle();
    expect(f.book.recall("fr-paris")).toBeNull();
    expect(f.state.stored).toEqual({ version: 1, addresses: [] });
  });

  it("replaces an address dated after the present clock instead of keeping it", async () => {
    const f = fixture();
    await f.book.initialize();
    // Measured while the clock was two hours ahead, then the clock is corrected.
    f.state.now = NOW + 2 * 60 * 60 * 1_000;
    f.book.record(measured("fr-paris", "8.8.4.4", { checkedAt: f.state.now }));
    f.state.now = NOW;
    expect(f.book.recall("fr-paris")).toBeNull();

    f.book.record(measured("fr-paris", "9.9.9.9", { checkedAt: NOW }));
    expect(f.book.recall("fr-paris")).toBe("9.9.9.9");
    f.state.now = NOW + 3 * 60 * 60 * 1_000;
    expect(f.book.recall("fr-paris")).toBe("9.9.9.9");
  });

  it("drops stored addresses past their retention or dated in the future", async () => {
    const f = fixture({
      version: 1,
      addresses: [
        { locationId: "old", ip: "8.8.4.4", checkedAt: NOW - 90 * DAY },
        { locationId: "future", ip: "8.8.8.8", checkedAt: NOW + 400 * DAY },
        { locationId: "fr-paris", ip: "9.9.9.9", checkedAt: NOW - DAY },
      ],
    });
    await f.book.initialize();
    expect(f.book.recall("old")).toBeNull();
    expect(f.book.recall("future")).toBeNull();

    f.book.record(measured("de-berlin", "1.1.1.1"));
    await f.settle();
    // The next write no longer carries them.
    expect(f.state.stored).toEqual({
      version: 1,
      addresses: [
        { locationId: "fr-paris", ip: "9.9.9.9", checkedAt: NOW - DAY },
        { locationId: "de-berlin", ip: "1.1.1.1", checkedAt: NOW },
      ],
    });
  });

  it("removes an expired address from storage as soon as the record is read", async () => {
    const f = fixture({
      version: 1,
      addresses: [
        { locationId: "old", ip: "8.8.4.4", checkedAt: NOW - 30 * DAY },
        { locationId: "fr-paris", ip: "9.9.9.9", checkedAt: NOW - 30 * DAY + 1 },
      ],
    });
    await f.book.initialize();
    await f.settle();
    // No measurement and no failure: reading the record is enough.
    expect(f.write).toHaveBeenCalledTimes(1);
    expect(f.state.stored).toEqual({
      version: 1,
      addresses: [{ locationId: "fr-paris", ip: "9.9.9.9", checkedAt: NOW - 30 * DAY + 1 }],
    });
  });

  it("empties a stored record whose every address has expired", async () => {
    const f = fixture({
      version: 1,
      addresses: [{ locationId: "old", ip: "8.8.4.4", checkedAt: NOW - 45 * DAY }],
    });
    await f.book.initialize();
    await f.settle();
    expect(f.state.stored).toEqual({ version: 1, addresses: [] });
  });

  it("does not rewrite a stored record which holds only current addresses", async () => {
    const stored = {
      version: 1,
      addresses: [
        { locationId: "fr-paris", ip: "9.9.9.9", checkedAt: NOW - 29 * DAY },
        { locationId: "de-berlin", ip: "1.1.1.1", checkedAt: NOW - DAY },
      ],
    };
    const f = fixture(stored);
    await f.book.initialize();
    await f.settle();
    expect(f.write).not.toHaveBeenCalled();
    expect(f.state.stored).toEqual(stored);
  });

  it("removes an address from storage once it is thirty days old", async () => {
    const f = fixture();
    await f.book.initialize();
    f.book.record(measured("fr-paris", "8.8.4.4"));
    await f.settle();
    f.state.now = NOW + 31 * DAY;
    f.book.record(measured("de-berlin", "9.9.9.9", { checkedAt: f.state.now }));
    await f.settle();
    expect(f.state.stored).toEqual({
      version: 1,
      addresses: [{ locationId: "de-berlin", ip: "9.9.9.9", checkedAt: f.state.now }],
    });
  });

  it("never replaces a stored record which it could not read", async () => {
    const stored = {
      version: 1,
      addresses: [{ locationId: "de-berlin", ip: "9.9.9.9", checkedAt: NOW - 1_000 }],
    };
    const f = fixture(stored);
    f.read.mockRejectedValue(new Error("storage unavailable"));
    await f.book.initialize();
    f.book.record(measured("fr-paris", "8.8.4.4"));
    await f.settle();
    // The measurement is usable in this worker, and the unread record is left alone.
    expect(f.book.recall("fr-paris")).toBe("8.8.4.4");
    expect(f.write).not.toHaveBeenCalled();
    expect(f.state.stored).toEqual(stored);

    f.read.mockImplementation(async () => structuredClone(f.state.stored));
    await f.book.initialize();
    await f.settle();
    expect(f.state.stored).toMatchObject({
      addresses: [{ locationId: "de-berlin" }, { locationId: "fr-paris" }],
    });
  });

  it("survives a worker restart through its own storage record", async () => {
    const f = fixture();
    await f.book.initialize();
    f.book.record(measured("fr-paris", "8.8.4.4"));
    await f.settle();
    expect(f.state.stored).toEqual({
      version: 1,
      addresses: [{ locationId: "fr-paris", ip: "8.8.4.4", checkedAt: NOW }],
    });

    const restarted = new VpnAddressBook({
      storage: { read: f.read, write: f.write },
      now: () => f.state.now,
    });
    expect(restarted.recall("fr-paris")).toBeNull();
    await restarted.initialize();
    expect(restarted.recall("fr-paris")).toBe("8.8.4.4");
  });

  it("drops stored entries which are not a public IPv4 for a location", async () => {
    const f = fixture({
      version: 1,
      addresses: [
        { locationId: "fr-paris", ip: "8.8.4.4", checkedAt: NOW - 1_000 },
        { locationId: "ipv6", ip: "2606:4700:4700::1111", checkedAt: NOW - 1_000 },
        { locationId: "private", ip: "10.0.0.1", checkedAt: NOW - 1_000 },
        { locationId: "", ip: "9.9.9.9", checkedAt: NOW - 1_000 },
        { locationId: "undated", ip: "9.9.9.9" },
        "8.8.8.8",
      ],
    });
    await f.book.initialize();
    expect(f.book.recall("fr-paris")).toBe("8.8.4.4");
    for (const locationId of ["ipv6", "private", "", "undated"])
      expect(f.book.recall(locationId)).toBeNull();
  });

  it.each([null, "8.8.4.4", [], { version: 2, addresses: [] }, { version: 1 }])(
    "starts empty from an unusable stored value: %j",
    async (stored) => {
      const f = fixture(stored);
      await f.book.initialize();
      expect(f.book.recall("fr-paris")).toBeNull();
    },
  );

  it("forgets an address measured more than thirty days ago", async () => {
    const f = fixture();
    await f.book.initialize();
    f.book.record(measured("fr-paris", "8.8.4.4"));
    f.state.now = NOW + 30 * DAY - 1;
    expect(f.book.recall("fr-paris")).toBe("8.8.4.4");
    f.state.now = NOW + 30 * DAY;
    expect(f.book.recall("fr-paris")).toBeNull();
  });

  it("keeps the sixty-four locations measured last", async () => {
    const f = fixture();
    await f.book.initialize();
    for (let index = 0; index < 65; index++)
      f.book.record(
        measured(`location-${String(index)}`, `8.8.${String(index)}.1`, {
          checkedAt: NOW - 65 + index,
        }),
      );
    expect(f.book.recall("location-0")).toBeNull();
    expect(f.book.recall("location-1")).toBe("8.8.1.1");
    expect(f.book.recall("location-64")).toBe("8.8.64.1");
  });

  it("does not rewrite storage for a measurement which only confirms the address", async () => {
    const f = fixture();
    await f.book.initialize();
    f.book.record(measured("fr-paris", "8.8.4.4"));
    await f.settle();
    expect(f.write).toHaveBeenCalledTimes(1);

    // The popup measures the same route again every thirty seconds.
    f.state.now += 30_000;
    f.book.record(measured("fr-paris", "8.8.4.4", { checkedAt: f.state.now }));
    await f.settle();
    expect(f.write).toHaveBeenCalledTimes(1);

    f.state.now += DAY;
    f.book.record(measured("fr-paris", "8.8.4.4", { checkedAt: f.state.now }));
    await f.settle();
    expect(f.write).toHaveBeenCalledTimes(2);
  });

  it("keeps working in memory when its storage refuses the write", async () => {
    const f = fixture();
    await f.book.initialize();
    f.write.mockRejectedValueOnce(new Error("quota exceeded"));
    f.book.record(measured("fr-paris", "8.8.4.4"));
    await f.settle();
    expect(f.book.recall("fr-paris")).toBe("8.8.4.4");

    f.state.now += 1_000;
    f.book.record(measured("de-berlin", "9.9.9.9", { checkedAt: f.state.now }));
    await f.settle();
    expect(f.state.stored).toMatchObject({
      addresses: [{ locationId: "fr-paris" }, { locationId: "de-berlin" }],
    });
  });

  it("reads its storage again after a failed read, without losing a measurement", async () => {
    const f = fixture({
      version: 1,
      addresses: [{ locationId: "de-berlin", ip: "9.9.9.9", checkedAt: NOW - 1_000 }],
    });
    f.read.mockRejectedValueOnce(new Error("storage unavailable"));
    await expect(f.book.initialize()).resolves.toBeUndefined();
    expect(f.book.recall("de-berlin")).toBeNull();

    f.book.record(measured("fr-paris", "8.8.4.4"));
    await f.book.initialize();
    await f.settle();
    expect(f.book.recall("de-berlin")).toBe("9.9.9.9");
    expect(f.book.recall("fr-paris")).toBe("8.8.4.4");
  });
});
