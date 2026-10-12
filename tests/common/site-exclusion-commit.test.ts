// SPDX-License-Identifier: MPL-2.0

import { SiteExclusionController } from "../../src/core/background/site-exclusion-controller";
import {
  ExtensionSiteExclusionStorage,
  emptySiteExclusionRecord,
  SITE_EXCLUSIONS_KEY,
  type SiteExclusionRecord,
  type SiteExclusionStorage,
} from "../../src/core/storage/site-exclusion-storage";
import { FakeProxy, FakeSafety } from "./helpers";

const entry = { domain: "example.com", includeSubdomains: true };

describe("verified site exclusion commit", () => {
  it("verifies the target while the intersection guard still applies, before committing", async () => {
    const proxy = new FakeProxy();
    const safety = new FakeSafety();
    let record = emptySiteExclusionRecord();
    let commitObserved = false;
    const storage: SiteExclusionStorage = {
      read: async () => structuredClone(record),
      write: async (value) => {
        if (!value.pending) {
          expect(safety.exclusions).toEqual([entry]);
          expect(safety.exclusionGuard).toEqual([]);
          expect(safety.status.trafficBlocked).toBe(true);
          commitObserved = true;
        }
        record = structuredClone(value);
      },
    };
    const controller = new SiteExclusionController(storage, proxy, safety);
    await controller.initialize();
    await controller.stage(0, true, [entry]);
    await controller.apply();
    expect(commitObserved).toBe(true);
    expect(safety.exclusionGuard).toBeNull();
    expect(record.pending).toBe(false);
  });

  it("never commits an unverified target and retains the intersection on DNR failure", async () => {
    const safety = new FakeSafety();
    const originalBlock = safety.block.bind(safety);
    let count = 0;
    safety.block = async (kill) => {
      count += 1;
      if (count === 2) throw new Error("target rules refused");
      await originalBlock(kill);
    };
    let record = emptySiteExclusionRecord();
    const storage: SiteExclusionStorage = {
      read: async () => structuredClone(record),
      write: async (value) => {
        record = structuredClone(value);
      },
    };
    const controller = new SiteExclusionController(storage, new FakeProxy(), safety);
    await controller.initialize();
    await controller.stage(0, true, [entry]);
    await expect(controller.apply()).rejects.toThrow("target rules refused");
    expect(record.pending).toBe(true);
    expect(record.applied.revision).toBe(0);
    expect(safety.exclusions).toEqual([]);
    expect(safety.exclusionGuard).toEqual([]);
    expect(controller.getState()).toMatchObject({ pending: true, error: true });
    await controller.apply();
    expect(controller.getState()).toMatchObject({
      pending: false,
      error: false,
      applied: { entries: [entry] },
    });
  });

  it("restores a pending journal when guard removal fails after a successful commit", async () => {
    const safety = new FakeSafety();
    const setter = safety.setExclusionGuard.bind(safety);
    let rejectRemoval = true;
    safety.setExclusionGuard = async (entries) => {
      if (entries === null && rejectRemoval) throw new Error("guard removal uncertain");
      await setter(entries);
    };
    let record = emptySiteExclusionRecord();
    const storage: SiteExclusionStorage = {
      read: async () => structuredClone(record),
      write: async (value) => {
        record = structuredClone(value);
      },
    };
    const controller = new SiteExclusionController(storage, new FakeProxy(), safety);
    await controller.initialize();
    await controller.stage(0, true, [entry]);
    await expect(controller.apply()).rejects.toThrow();
    expect(record.pending).toBe(true);
    expect(safety.exclusionGuard).toEqual([]);
    rejectRemoval = false;
    await controller.apply();
    expect(record.pending).toBe(false);
  });
});

describe("Chrome policy key ordering", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("accepts Chrome reordering object keys while verifying every policy value", async () => {
    let value: SiteExclusionRecord | undefined;
    function reorder(item: unknown): unknown {
      if (Array.isArray(item)) return item.map(reorder);
      if (item && typeof item === "object")
        return Object.fromEntries(
          Object.entries(item)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([key, child]) => [key, reorder(child)]),
        );
      return item;
    }
    vi.stubGlobal("browser", {
      storage: {
        local: {
          get: async () => ({ [SITE_EXCLUSIONS_KEY]: reorder(value) }),
          set: async (items: Record<string, SiteExclusionRecord>) => {
            value = items[SITE_EXCLUSIONS_KEY];
          },
        },
      },
    });
    const storage = new ExtensionSiteExclusionStorage();
    const policy = { revision: 1, enabled: true, entries: [entry] };
    await storage.write({ version: 1, saved: policy, applied: policy, pending: false });
    expect(await storage.read()).toEqual({
      version: 1,
      saved: policy,
      applied: policy,
      pending: false,
    });
  });
});
