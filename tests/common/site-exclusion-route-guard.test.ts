// SPDX-License-Identifier: MPL-2.0

import { SiteExclusionController } from "../../src/core/background/site-exclusion-controller";
import {
  emptySiteExclusionRecord,
  InvalidSiteExclusionStorageError,
  type SiteExclusionRecord,
  type SiteExclusionStorage,
} from "../../src/core/storage/site-exclusion-storage";
import {
  intersectExclusions,
  validateSiteExclusionPolicy,
  type SiteExclusion,
} from "../../src/core/shared/site-exclusions";
import { PlatformProxyService as ChromiumProxyService } from "../../src/platform/chromium/proxy-controller";
import {
  PlatformProxyService as FirefoxProxyService,
  proxyConfig as firefoxProxyConfig,
  readProxyConfiguration,
} from "../../src/platform/firefox/proxy-controller";
import {
  ProxyControlError,
  type ProxyChallenger,
  type ProxyControlLevel,
  type ProxyService,
} from "../../src/platform/contracts/proxy";
import type { ProxySession } from "../../src/core/api/types";
import { FakeSafety, proxySession } from "./helpers";

const previous: SiteExclusion[] = [
  { domain: "example.com", includeSubdomains: true },
  { domain: "old.example.org", includeSubdomains: false },
];
const target: SiteExclusion[] = [
  { domain: "shop.example.com", includeSubdomains: false },
  { domain: "new.example.net", includeSubdomains: false },
];
const intersection = intersectExclusions(previous, target);
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
const largePrevious: SiteExclusion[] = [
  { domain: "a.example.com", includeSubdomains: true },
  ...Array.from({ length: 99 }, (_, index) => ({
    domain: `h${String(index)}.b.example.com`,
    includeSubdomains: false,
  })),
];
const largeTarget: SiteExclusion[] = [
  { domain: "b.example.com", includeSubdomains: true },
  ...Array.from({ length: 99 }, (_, index) => ({
    domain: `h${String(index)}.a.example.com`,
    includeSubdomains: false,
  })),
];
const largeIntersection = intersectExclusions(largePrevious, largeTarget);

class Policies implements SiteExclusionStorage {
  record: SiteExclusionRecord = {
    version: 1,
    saved: { revision: 1, enabled: true, entries: structuredClone(previous) },
    applied: { revision: 1, enabled: true, entries: structuredClone(previous) },
    pending: false,
  };
  writes = 0;
  failWrite = 0;
  unreadable = false;
  beforeWrite?: (value: SiteExclusionRecord) => void;
  async read() {
    if (this.unreadable) throw new InvalidSiteExclusionStorageError();
    return structuredClone(this.record);
  }
  async write(value: SiteExclusionRecord) {
    this.beforeWrite?.(value);
    this.writes += 1;
    if (this.writes === this.failWrite) throw new Error("journal unavailable");
    this.record = structuredClone(value);
  }
  async recoverForDisconnect() {
    this.record = emptySiteExclusionRecord();
    this.unreadable = false;
    return structuredClone(this.record);
  }
}

/** Model actual routing separately from the expectation configured in memory. */
class ExactProxy implements ProxyService {
  level: ProxyControlLevel = "controlled_by_this_extension";
  expected: SiteExclusion[] = [];
  route: { endpoint: ProxyChallenger; entries: SiteExclusion[] } | null = {
    endpoint: { host: proxySession().host, port: proxySession().port },
    entries: structuredClone(previous),
  };
  updates: { entries: SiteExclusion[]; pending: boolean }[] = [];
  beforeUpdate?: (entries: SiteExclusion[]) => void;
  afterUpdate?: (entries: SiteExclusion[]) => void;
  constructor(private readonly policies: Policies) {}
  async getControlLevel() {
    return this.level;
  }
  async assertControllable() {
    if (
      this.level !== "controlled_by_this_extension" &&
      this.level !== "controllable_by_this_extension"
    )
      throw new ProxyControlError(this.level);
  }
  configureExclusions(entries: SiteExclusion[]) {
    this.expected = structuredClone(entries);
  }
  async updateExistingExclusions(oldEntries: SiteExclusion[], newEntries: SiteExclusion[]) {
    await this.assertControllable();
    if (!this.route) return;
    if (same(this.route.entries, newEntries)) return;
    if (!same(this.route.entries, oldEntries))
      throw new ProxyControlError("configuration_rejected");
    this.beforeUpdate?.(newEntries);
    this.route.entries = structuredClone(newEntries);
    this.updates.push({
      entries: structuredClone(newEntries),
      pending: this.policies.record.pending,
    });
    this.afterUpdate?.(newEntries);
  }
  async ensureBlockingConfiguration() {
    await this.assertControllable();
    if (await this.isGuardedConfiguration()) return;
    this.route = {
      endpoint: { host: "127.0.0.1", port: 9 },
      entries: structuredClone(this.expected),
    };
    this.level = "controlled_by_this_extension";
  }
  async isGuardedConfiguration() {
    return (
      this.level === "controlled_by_this_extension" &&
      this.route !== null &&
      same(this.route.entries, this.expected)
    );
  }
  async isExclusionConfiguration() {
    return !this.route || (await this.isGuardedConfiguration());
  }
  async apply(session: ProxySession) {
    this.route = { endpoint: { host: session.host, port: session.port }, entries: this.expected };
  }
  async clear() {
    this.route = null;
    this.level = "controllable_by_this_extension";
  }
  async isActiveConfiguration(session: ProxySession) {
    return same(this.route?.endpoint, { host: session.host, port: session.port });
  }
  async isConfiguredProxyChallenge(challenger: ProxyChallenger) {
    return same(this.route?.endpoint, challenger);
  }
}

function fixture(policies = new Policies()) {
  const proxy = new ExactProxy(policies);
  const safety = new FakeSafety();
  const arm = vi.fn(async (allowed: SiteExclusion[]) => {
    expect(safety.status.webRtcProtected).toBe(true);
    proxy.configureExclusions(allowed);
    await proxy.ensureBlockingConfiguration();
    expect(await proxy.isGuardedConfiguration()).toBe(true);
    await safety.block(true);
  });
  const controller = new SiteExclusionController(policies, proxy, safety, arm);
  return { policies, proxy, safety, arm, controller };
}

describe("site exclusion confinement of raw transports", () => {
  it("supports the 198-entry intersection of two valid 100-entry policies", async () => {
    const h = fixture();
    h.policies.record.saved.entries = structuredClone(largePrevious);
    h.policies.record.applied.entries = structuredClone(largePrevious);
    h.proxy.route!.entries = structuredClone(largePrevious);
    expect(largeIntersection).toHaveLength(198);
    await h.controller.initialize();
    await h.controller.stage(1, true, largeTarget);
    h.policies.beforeWrite = (record) => {
      if (!record.pending) expect(h.proxy.route?.entries).toEqual(largeIntersection);
    };
    await h.controller.apply();
    expect(h.proxy.route?.entries).toEqual(largeTarget);
  });

  it("accepts the internal intersection in both real adapters without widening saved policy limits", () => {
    expect(
      validateSiteExclusionPolicy({ revision: 1, enabled: true, entries: largePrevious }),
    ).toBe(true);
    expect(validateSiteExclusionPolicy({ revision: 1, enabled: true, entries: largeTarget })).toBe(
      true,
    );
    expect(
      validateSiteExclusionPolicy({ revision: 1, enabled: true, entries: largeIntersection }),
    ).toBe(false);
    expect(() => new ChromiumProxyService().configureExclusions(largeIntersection)).not.toThrow();
    expect(() => new FirefoxProxyService().configureExclusions(largeIntersection)).not.toThrow();
    const pac = firefoxProxyConfig(proxySession(), largeIntersection);
    expect(readProxyConfiguration(pac)?.exclusions).toEqual(largeIntersection);
  });

  it("reestablishes a committed route before removing a surviving recovery guard", async () => {
    const h = fixture();
    await h.proxy.clear();
    await h.controller.initialize();
    const setGuard = h.safety.setExclusionGuard.bind(h.safety);
    vi.spyOn(h.safety, "setExclusionGuard").mockImplementation(async (entries) => {
      if (entries === null) {
        expect(await h.proxy.isGuardedConfiguration()).toBe(true);
        expect(h.proxy.route?.entries).toEqual(previous);
      }
      await setGuard(entries);
    });
    await h.controller.apply();
    expect(h.controller.getState()).toMatchObject({ pending: false, error: false });
  });

  it("keeps only the intersection direct until the durable commit, preserving the endpoint", async () => {
    const h = fixture();
    await h.controller.initialize();
    await h.controller.stage(1, true, target);
    h.policies.beforeWrite = (record) => {
      if (!record.pending) {
        expect(h.proxy.route?.entries).toEqual(intersection);
        expect(h.safety.exclusionGuard).toEqual(intersection);
        expect(h.safety.exclusions).toEqual(target);
      }
    };
    await h.controller.apply();
    expect(h.proxy.route).toEqual({
      endpoint: { host: proxySession().host, port: proxySession().port },
      entries: target,
    });
    expect(h.proxy.updates).toEqual([
      { entries: intersection, pending: true },
      { entries: target, pending: false },
    ]);
    expect(h.controller.getState()).toMatchObject({ pending: false, error: false });
  });

  it.each(["previous", "intersection", "target", "absent"] as const)(
    "resumes a pending journal with the %s route without authorizing new-only destinations early",
    async (actual) => {
      const policies = new Policies();
      policies.record.saved = { revision: 2, enabled: true, entries: target };
      policies.record.pending = true;
      const h = fixture(policies);
      if (actual === "absent") await h.proxy.clear();
      else h.proxy.route!.entries = structuredClone({ previous, intersection, target }[actual]);
      const endpoint = h.proxy.route?.endpoint;
      policies.beforeWrite = (record) => {
        if (!record.pending) expect(h.proxy.route?.entries).toEqual(intersection);
      };
      await h.controller.initialize();
      await h.controller.apply();
      expect(h.proxy.route?.entries).toEqual(target);
      expect(h.proxy.route?.endpoint).toEqual(endpoint ?? { host: "127.0.0.1", port: 9 });
      expect(
        h.proxy.updates.every((event) => !event.pending || same(event.entries, intersection)),
      ).toBe(true);
    },
  );

  it.each(["before", "after"])(
    "restores pending intersection when target route fails %s its write, then resumes after restart",
    async (when) => {
      const h = fixture();
      await h.controller.initialize();
      await h.controller.stage(1, true, target);
      const fail = (entries: SiteExclusion[]) => {
        if (same(entries, target)) throw new Error("target route uncertain");
      };
      if (when === "before") h.proxy.beforeUpdate = fail;
      else h.proxy.afterUpdate = fail;
      await expect(h.controller.apply()).rejects.toThrow("target route uncertain");
      expect(h.policies.record.pending).toBe(true);
      expect(h.proxy.route?.entries).toEqual(intersection);
      expect(h.safety.exclusionGuard).toEqual(intersection);
      h.proxy.beforeUpdate = undefined;
      h.proxy.afterUpdate = undefined;
      const restarted = new SiteExclusionController(h.policies, h.proxy, h.safety, h.arm);
      await restarted.initialize();
      await restarted.apply();
      expect(restarted.getState()).toMatchObject({ pending: false, error: false });
      expect(h.proxy.route?.entries).toEqual(target);
    },
  );

  it("keeps the intersection when the commit fails and can cancel after restart", async () => {
    const h = fixture();
    await h.controller.initialize();
    await h.controller.stage(1, true, target);
    h.policies.failWrite = 3;
    await expect(h.controller.apply()).rejects.toThrow("journal unavailable");
    expect(h.proxy.route?.entries).toEqual(intersection);
    expect(h.proxy.updates.some((event) => same(event.entries, target))).toBe(false);
    h.policies.failWrite = 0;
    const restarted = new SiteExclusionController(h.policies, h.proxy, h.safety, h.arm);
    await restarted.initialize();
    await h.proxy.clear();
    await restarted.rollback();
    expect(h.proxy.route?.entries).toEqual([]);
    expect(h.policies.record).toMatchObject({
      pending: false,
      saved: { revision: 2, entries: previous },
      applied: { revision: 2, entries: previous },
    });
  });

  it("restores the proxy intersection if removal of the committed DNR guard is uncertain", async () => {
    const h = fixture();
    await h.controller.initialize();
    await h.controller.stage(1, true, target);
    const setGuard = h.safety.setExclusionGuard.bind(h.safety);
    vi.spyOn(h.safety, "setExclusionGuard").mockImplementation(async (entries) => {
      if (entries === null) throw new Error("guard removal uncertain");
      await setGuard(entries);
    });
    await expect(h.controller.apply()).rejects.toThrow("guard removal uncertain");
    expect(h.policies.record.pending).toBe(true);
    expect(h.proxy.route?.entries).toEqual(intersection);
  });

  it("still installs confinement when an independent DNR guard write fails", async () => {
    const h = fixture();
    await h.controller.initialize();
    await h.controller.stage(1, true, target);
    vi.spyOn(h.safety, "setExclusionGuard").mockRejectedValue(new Error("DNR unavailable"));
    await expect(h.controller.apply()).rejects.toThrow("DNR unavailable");
    expect(h.proxy.route?.entries).toEqual(intersection);
    expect(h.safety.status.webRtcProtected).toBe(true);
    expect(h.policies.record.pending).toBe(true);
  });

  it("replaces an unexpected owned route with a restrictive fallback and retains the journal", async () => {
    const h = fixture();
    await h.controller.initialize();
    await h.controller.stage(1, true, target);
    h.proxy.route!.entries = [{ domain: "unexpected.com", includeSubdomains: true }];
    await expect(h.controller.apply()).rejects.toThrow("configuration_rejected");
    expect(h.proxy.route).toEqual({
      endpoint: { host: "127.0.0.1", port: 9 },
      entries: intersection,
    });
    expect(h.policies.record.pending).toBe(true);
    await h.controller.apply();
    expect(h.proxy.route?.entries).toEqual(target);
  });

  it("never adopts a route controlled by another owner", async () => {
    const h = fixture();
    await h.controller.initialize();
    await h.controller.stage(1, true, target);
    h.proxy.level = "controlled_by_other_extensions";
    await expect(h.controller.apply()).rejects.toThrow("controlled_by_other_extensions");
    expect(h.proxy.route?.entries).toEqual(previous);
    expect(h.policies.record.pending).toBe(true);
  });

  it("holds a universal proxy guard during corrupt journal recovery after explicit clear", async () => {
    const h = fixture();
    h.policies.unreadable = true;
    await expect(h.controller.initialize()).rejects.toThrow("invalid_site_exclusion_storage");
    await h.proxy.clear();
    h.policies.recoverForDisconnect = async () => {
      expect(h.proxy.route).toEqual({ endpoint: { host: "127.0.0.1", port: 9 }, entries: [] });
      expect(h.safety.exclusionGuard).toEqual([]);
      h.policies.unreadable = false;
      return (h.policies.record = emptySiteExclusionRecord());
    };
    await h.controller.rollback();
    expect(h.controller.getState()).toMatchObject({ pending: false, error: false });
  });
});
