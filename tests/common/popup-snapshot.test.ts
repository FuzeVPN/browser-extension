// SPDX-License-Identifier: MPL-2.0

import { PopupSnapshotOrder, popupSnapshot } from "../../src/ui/popup/snapshot";
import { EMPTY_SNAPSHOT } from "../../src/core/shared/state";
import { networkRouteKey } from "../../src/core/shared/network";
import { ACTIVE_SUBSCRIPTION, PROFILE } from "./helpers";

describe("popup compatibility during extension updates", () => {
  const connected = {
    ...structuredClone(EMPTY_SNAPSHOT),
    profile: PROFILE,
    status: "connected" as const,
    protected: true,
    protectionRequested: true,
    activeLocationId: "frankfurt-01",
  };

  it("renders a 0.4.1 snapshot without discarding its connected account", () => {
    const legacy = { ...connected, siteExclusions: undefined, blockingScope: undefined };
    const normalized = popupSnapshot(legacy);
    expect(normalized).toMatchObject({
      profile: PROFILE,
      protected: true,
      status: "connected",
      siteExclusionsAvailable: false,
    });
    expect(normalized.siteExclusions).toEqual(EMPTY_SNAPSHOT.siteExclusions);
    expect(networkRouteKey(legacy)).toBe(networkRouteKey(normalized));
    expect(legacy.siteExclusions).toBeUndefined();
  });

  it("keeps legacy capability unavailable across repeated renders and preserves errors/devices", () => {
    const device = {
      deviceId: "legacy-device",
      name: "Chrome",
      kind: "browser_extension",
      profiles: [],
      createdAt: "2026-09-08T00:00:00Z",
    };
    const first = popupSnapshot({
      ...connected,
      devices: [device],
      siteExclusions: undefined,
      error: "invalid_credentials",
    });
    const second = popupSnapshot(first);
    expect(second.siteExclusionsAvailable).toBe(false);
    expect(second.devices).toEqual([device]);
    expect(second.error).toBe("invalid_credentials");
  });

  it("enables site exclusions only when a complete current state arrives", () => {
    expect(popupSnapshot(connected).siteExclusionsAvailable).toBe(true);
    for (const siteExclusions of [
      null,
      {},
      { saved: {} },
      { ...connected.siteExclusions, applied: null },
    ]) {
      const result = popupSnapshot({ ...connected, siteExclusions });
      expect(result.siteExclusionsAvailable).toBe(false);
      expect(result.profile).toEqual(PROFILE);
    }
  });

  it("preserves saved exceptions and conservative blocking scope from the current worker", () => {
    const policy = {
      revision: 4,
      enabled: true,
      entries: [{ domain: "example.com", includeSubdomains: false }],
    };
    const result = popupSnapshot({
      ...connected,
      blockingScope: "unverified",
      siteExclusions: { saved: policy, applied: policy, pending: false, error: false },
    });
    expect(result.siteExclusionsAvailable).toBe(true);
    expect(result.siteExclusions.saved).toEqual(policy);
    expect(result.blockingScope).toBe("unverified");
    result.siteExclusions.saved.entries.length = 0;
    expect(policy.entries).toHaveLength(1);
  });

  it("fills older optional presentation fields without inventing account or protection state", () => {
    const result = popupSnapshot({
      ...connected,
      network: undefined,
      locationPreferences: undefined,
      siteExclusions: undefined,
    });
    expect(result.network.status).toBe("idle");
    expect(result.locationPreferences.favoriteIds).toEqual([]);
    expect(result.protected).toBe(true);
    expect(result.profile).toEqual(PROFILE);
  });

  it("preserves a recovered exclusions notice without reporting an unfinished change", () => {
    const siteExclusions = {
      ...structuredClone(connected.siteExclusions),
      recoveryNotice: "preferences_reset" as const,
    };
    const result = popupSnapshot({ ...connected, siteExclusions });
    expect(result.siteExclusionsAvailable).toBe(true);
    expect(result.siteExclusions).toMatchObject({
      recoveryNotice: "preferences_reset",
      pending: false,
      error: false,
    });
    expect(result.siteExclusions).not.toBe(siteExclusions);
    expect(popupSnapshot(connected).siteExclusions.recoveryNotice).toBeUndefined();
    expect(
      popupSnapshot({ ...connected, siteExclusions: undefined }).siteExclusions.recoveryNotice,
    ).toBeUndefined();
  });

  it("rejects absent or malformed core responses for a visible communication error", () => {
    for (const value of [
      undefined,
      null,
      {},
      [],
      { ...connected, status: "not_a_state" },
      { ...connected, profile: undefined },
      { ...connected, securityPreferences: null },
      { ...connected, snapshotVersion: null },
      { ...connected, snapshotVersion: { workerId: "", revision: 1 } },
      { ...connected, snapshotVersion: { workerId: "worker", revision: -1 } },
      { ...connected, snapshotVersion: { workerId: "worker", revision: 0.5 } },
      { ...connected, snapshotVersion: { workerId: "worker", revision: Number.MAX_VALUE } },
    ])
      expect(() => popupSnapshot(value)).toThrow("invalid_popup_snapshot");
  });

  it("keeps server quotas and never invents a limit for absent or invalid legacy data", () => {
    for (const deviceLimit of [1, 5, 12])
      expect(popupSnapshot({ ...connected, deviceLimit }).deviceLimit).toBe(deviceLimit);
    for (const deviceLimit of [undefined, null, 0, -1, 1.5, "5"])
      expect(popupSnapshot({ ...connected, deviceLimit }).deviceLimit).toBeNull();
  });

  it("rejects malformed nested account and list fields before rendering", () => {
    for (const patch of [
      { profile: { userId: "user" } },
      { profile: { ...PROFILE, email: [] } },
      { locations: [null] },
      { locations: [{ id: "fr", displayName: {} }] },
      {
        devices: [
          { deviceId: "bad", name: "Device", kind: "vpn", profiles: [], createdAt: "not-a-date" },
        ],
      },
      { effectiveLanguage: "auto" },
      { effectiveLanguage: "bad-locale" },
      { selectedLocationId: {} },
      { retryAfterSeconds: Infinity },
    ])
      expect(() => popupSnapshot({ ...connected, ...patch })).toThrow("invalid_popup_snapshot");
  });

  it("adapts malformed optional observations and preferences conservatively", () => {
    const result = popupSnapshot({
      ...connected,
      network: { ...connected.network, status: "ready", checkedAt: NaN },
      locationPreferences: { ...connected.locationPreferences, favoriteIds: [null] },
      blockingScope: "made_up_scope",
      trafficBlocked: true,
    });
    expect(result.network).toEqual(EMPTY_SNAPSHOT.network);
    expect(result.locationPreferences).toEqual(EMPTY_SNAPSHOT.locationPreferences);
    expect(result.blockingScope).toBe("all");
    expect(result.profile).toEqual(PROFILE);
    expect(result.protected).toBe(true);
  });

  it("keeps account and protection controls available when an old worker sends corrupt billing metadata", () => {
    const input = {
      ...connected,
      subscription: { ...ACTIVE_SUBSCRIPTION, expiresAt: "not-a-date" },
      trafficBlocked: true,
      blockingScope: "except_excluded" as const,
      webRtcProtected: true,
      error: "network_error" as const,
    };
    const normalized = popupSnapshot(input);
    expect(normalized).toMatchObject({
      subscription: null,
      profile: PROFILE,
      status: "connected",
      protected: true,
      protectionRequested: true,
      trafficBlocked: true,
      blockingScope: "except_excluded",
      webRtcProtected: true,
      error: "network_error",
    });
    expect(input.subscription.expiresAt).toBe("not-a-date");
  });

  it("normalizes legacy billing details and copies valid subscriptions", () => {
    const legacy = {
      status: "active",
      hasAccess: true,
      expiresAt: ACTIVE_SUBSCRIPTION.expiresAt,
      renewsAutomatically: true,
    };
    expect(popupSnapshot({ ...connected, subscription: legacy }).subscription).toEqual({
      ...legacy,
      offerId: null,
      startedAt: null,
    });
    const subscription = { ...ACTIVE_SUBSCRIPTION };
    const normalized = popupSnapshot({ ...connected, subscription });
    expect(normalized.subscription).toEqual(subscription);
    expect(normalized.subscription).not.toBe(subscription);
  });

  it("copies optional lists and observations without mutating the worker response", () => {
    const input = {
      ...connected,
      locationPreferences: {
        ...connected.locationPreferences,
        unavailableFavoriteIds: ["retired"],
      },
    };
    const result = popupSnapshot(input);
    result.locationPreferences.unavailableFavoriteIds?.push("other");
    result.network.ip = "203.0.113.20";
    expect(input.locationPreferences.unavailableFavoriteIds).toEqual(["retired"]);
    expect(input.network.ip).toBeNull();
  });

  it("adapts optional logout results without making up a confirmed remote outcome", () => {
    for (const logoutOutcome of [
      undefined,
      null,
      {},
      { apiSession: "confirmed" },
      { apiSession: "confirmed", proxySessions: "unknown" },
    ])
      expect(popupSnapshot({ ...connected, logoutOutcome }).logoutOutcome).toBeNull();
    const logoutOutcome = { apiSession: "confirmed", proxySessions: "unconfirmed" };
    const result = popupSnapshot({ ...connected, logoutOutcome });
    expect(result.logoutOutcome).toEqual(logoutOutcome);
    expect(result.logoutOutcome).not.toBe(logoutOutcome);
  });
});

describe("popup snapshot ordering across replies and broadcasts", () => {
  const version = (workerId: string, revision: number) => ({
    snapshotVersion: { workerId, revision },
  });

  it("does not allow an old authenticated publication to replace a newer logout reply", () => {
    const order = new PopupSnapshotOrder();
    expect(order.accept(version("worker-a", 3))).toBe(true);
    expect(order.accept(version("worker-a", 5))).toBe(true);
    expect(order.accept(version("worker-a", 4))).toBe(false);
    expect(order.accept(version("worker-a", 5))).toBe(true);
    expect(order.accept(version("worker-a", 6))).toBe(true);
  });

  it("accepts a restarted worker but rejects late messages from every retired worker", () => {
    const order = new PopupSnapshotOrder();
    expect(order.accept(version("worker-a", 500))).toBe(true);
    expect(order.accept(version("worker-b", 1))).toBe(true);
    expect(order.accept(version("worker-a", 501))).toBe(false);
    expect(order.accept(version("worker-c", 1))).toBe(true);
    expect(order.accept(version("worker-b", 99))).toBe(false);
    expect(order.accept(version("worker-c", 2))).toBe(true);
  });

  it("supports legacy workers until an upgraded worker supplies an ordered snapshot", () => {
    const order = new PopupSnapshotOrder();
    expect(order.accept({})).toBe(true);
    expect(order.accept({})).toBe(true);
    expect(order.accept(version("upgraded", 1))).toBe(true);
    expect(order.accept({})).toBe(false);
    expect(order.accept(version("upgraded", 2))).toBe(true);
  });

  it("copies accepted versions so caller mutation cannot lower the revision gate", () => {
    const order = new PopupSnapshotOrder();
    const next = version("worker-a", 20);
    expect(order.accept(next)).toBe(true);
    next.snapshotVersion.revision = 1;
    expect(order.accept(version("worker-a", 19))).toBe(false);
  });
});
