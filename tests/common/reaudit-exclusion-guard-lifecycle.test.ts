// SPDX-License-Identifier: MPL-2.0

import { SafetyError } from "../../src/core/background/network-safety";
import { intersectExclusions, type SiteExclusion } from "../../src/core/shared/site-exclusions";
import type {
  SiteExclusionRecord,
  SiteExclusionStorage,
} from "../../src/core/storage/site-exclusion-storage";
import { authenticatedState, createHarness } from "./helpers";

const previous: SiteExclusion[] = [
  { domain: "example.com", includeSubdomains: true },
  { domain: "old.example.org", includeSubdomains: false },
];
const target: SiteExclusion[] = [
  { domain: "shop.example.com", includeSubdomains: false },
  { domain: "new.example.net", includeSubdomains: false },
];
const intersection = intersectExclusions(previous, target);
const committedCoverage = intersectExclusions(target, target);

class Policies implements SiteExclusionStorage {
  record: SiteExclusionRecord = {
    version: 1,
    saved: { revision: 1, enabled: true, entries: structuredClone(previous) },
    applied: { revision: 1, enabled: true, entries: structuredClone(previous) },
    pending: false,
  };
  rejectCommit = false;

  async read() {
    return structuredClone(this.record);
  }

  async write(record: SiteExclusionRecord) {
    if (this.rejectCommit && !record.pending) throw new Error("exclusion commit unavailable");
    this.record = structuredClone(record);
  }
}

async function connected() {
  const policies = new Policies();
  const h = createHarness({ persisted: authenticatedState(), siteExclusionStorage: policies });
  await h.controller.initialize();
  expect(await h.controller.connect("frankfurt-01")).toEqual({ ok: true });
  expect(await h.controller.updateSecurityPreferences(false, true)).toEqual({ ok: true });
  return { ...h, policies };
}

type Harness = Awaited<ReturnType<typeof connected>>;
type Trigger = "preferences" | "certificate" | "expiry";

async function failProxy(h: Harness) {
  const session = h.proxy.active!;
  await h.controller.handleProxyError("ERR_PROXY_CERTIFICATE_INVALID", true, {
    host: session.host,
    port: session.port,
  });
}

async function trigger(h: Harness, name: Trigger) {
  if (name === "preferences")
    expect(await h.controller.updateSecurityPreferences(false, true)).toEqual({ ok: true });
  else if (name === "certificate") await failProxy(h);
  else {
    h.setNow(Date.parse("2026-09-26T12:00:00Z"));
    await h.controller.retryConnection();
  }
}

async function stagePending(h: Harness) {
  h.policies.rejectCommit = true;
  await expect(h.controller.updateSiteExclusions(1, true, target)).rejects.toThrow(
    "exclusion commit unavailable",
  );
  expect(h.policies.record.pending).toBe(true);
  expect(h.proxy.activeExclusions).toEqual(intersection);
  expect(h.safety.exclusionGuard).toEqual(intersection);
  expect(await h.proxy.isGuardedConfiguration()).toBe(true);
}

async function failAfterCommit(h: Harness) {
  const allowing = vi
    .spyOn(h.safety, "allow")
    .mockRejectedValueOnce(new SafetyError("traffic_guard_failed"));
  await expect(h.controller.updateSiteExclusions(1, true, target)).rejects.toThrow();
  allowing.mockRestore();
  expect(h.controller.getSnapshot().siteExclusions).toMatchObject({
    pending: false,
    error: true,
  });
}

function expectReleased(h: Harness) {
  expect(h.proxy.active).toBeNull();
  expect(h.proxy.blockingRoute).toBe(false);
  expect(h.safety.exclusionGuard).toBeNull();
  expect(h.safety.status).toMatchObject({
    webRtcProtected: false,
    filterActive: false,
    trafficBlocked: false,
  });
  expect(h.controller.getSnapshot()).toMatchObject({
    protected: false,
    protectionRequested: false,
    siteExclusions: { pending: false, error: false },
  });
}

describe("mandatory exclusion guard across connection lifecycle cleanup", () => {
  afterEach(() => vi.restoreAllMocks());

  it.each<Trigger>(["preferences", "certificate", "expiry"])(
    "retains the pending intersection after %s with the kill switch disabled",
    async (name) => {
      const h = await connected();
      if (name === "preferences") await failProxy(h);
      await stagePending(h);

      await trigger(h, name);

      expect(await h.proxy.isGuardedConfiguration()).toBe(true);
      expect(h.proxy.activeExclusions).toEqual(intersection);
      expect(h.safety.exclusionGuard).toEqual(intersection);
      expect(h.safety.status).toMatchObject({ webRtcProtected: true, filterActive: true });
      expect(h.policies.record.pending).toBe(true);
      expect(h.controller.getSnapshot()).toMatchObject({
        protected: false,
        protectionRequested: true,
        siteExclusions: { pending: true, error: true },
      });
    },
  );

  it.each<Trigger>(["preferences", "certificate", "expiry"])(
    "retains the committed target while only exclusion error remains after %s",
    async (name) => {
      const h = await connected();
      if (name === "preferences") await failProxy(h);
      // Fail after the policy commit, when AppController tries to restore the
      // requested session or disconnected state. The saved target is now valid.
      if (name === "preferences") {
        // Delay failure until the post-commit controller call to blockSafety.
        let reject = true;
        const block = h.safety.block.bind(h.safety);
        vi.spyOn(h.safety, "block").mockImplementation(async (kill) => {
          if (reject && !h.policies.record.pending && h.policies.record.saved.revision === 2) {
            reject = false;
            throw new SafetyError("traffic_guard_failed");
          }
          await block(kill);
        });
      } else
        vi.spyOn(h.safety, "allow").mockRejectedValueOnce(new SafetyError("traffic_guard_failed"));
      await expect(h.controller.updateSiteExclusions(1, true, target)).rejects.toThrow();
      vi.restoreAllMocks();
      expect(h.policies.record).toMatchObject({
        pending: false,
        saved: { revision: 2, entries: target },
        applied: { revision: 2, entries: target },
      });
      expect(h.controller.getSnapshot().siteExclusions).toMatchObject({
        pending: false,
        error: true,
      });

      await trigger(h, name);

      expect(await h.proxy.isGuardedConfiguration()).toBe(true);
      expect(h.proxy.activeExclusions).toEqual(committedCoverage);
      expect(h.safety.exclusionGuard).toEqual(committedCoverage);
      expect(h.controller.getSnapshot()).toMatchObject({
        protected: false,
        protectionRequested: true,
        siteExclusions: { pending: false, error: true },
      });
    },
  );

  it.each(["disconnect", "logout"] as const)(
    "rolls back a pending edit and releases all guards on explicit %s",
    async (command) => {
      const h = await connected();
      await stagePending(h);
      h.policies.rejectCommit = false;

      expect(await h.controller[command]()).toEqual({ ok: true });

      expectReleased(h);
      expect(h.policies.record).toMatchObject({
        pending: false,
        saved: { revision: 2, entries: previous },
        applied: { revision: 2, entries: previous },
      });
    },
  );

  it.each(["disconnect", "logout"] as const)(
    "releases an error-only guard without undoing the committed target on explicit %s",
    async (command) => {
      const h = await connected();
      await failAfterCommit(h);

      expect(await h.controller[command]()).toEqual({ ok: true });

      expectReleased(h);
      expect(h.policies.record).toMatchObject({
        pending: false,
        saved: { revision: 2, entries: target },
        applied: { revision: 2, entries: target },
      });
    },
  );

  it("keeps a universal rollback guard only until storage recovers for explicit disconnect", async () => {
    const h = await connected();
    await stagePending(h);

    expect(await h.controller.disconnect()).toMatchObject({ ok: false });
    expect(h.policies.record.pending).toBe(true);
    expect(await h.proxy.isGuardedConfiguration()).toBe(true);
    expect(h.proxy.activeExclusions).toEqual(intersection);
    // Rollback itself uses an empty guard. Failure handling may retain only the
    // previous/target intersection, never their union or a new-only destination.
    expect(h.safety.exclusionGuard).toEqual([]);

    h.policies.rejectCommit = false;
    expect(await h.controller.disconnect()).toEqual({ ok: true });
    expectReleased(h);
    expect(h.policies.record.saved.entries).toEqual(previous);
  });

  it("repairs a pending edit, authorizes its target, then permits ordinary kill-switch-off cleanup", async () => {
    const h = await connected();
    await stagePending(h);
    h.policies.rejectCommit = false;

    await h.controller.retrySiteExclusions();

    expect(h.policies.record.pending).toBe(false);
    expect(h.policies.record.applied.entries).toEqual(target);
    expect(h.proxy.activeExclusions).toEqual(target);
    expect(h.controller.getSnapshot()).toMatchObject({
      protected: true,
      siteExclusions: { pending: false, error: false },
    });
    await failProxy(h);
    expect(h.proxy.active).toBeNull();
    expect(h.proxy.blockingRoute).toBe(false);
    expect(h.controller.getSnapshot().protectionRequested).toBe(true);
  });

  it("repairs an error-only guard and reauthorizes the already committed target", async () => {
    const h = await connected();
    await failAfterCommit(h);

    await h.controller.retrySiteExclusions();

    expect(h.controller.getSnapshot()).toMatchObject({
      protected: true,
      siteExclusions: { pending: false, error: false },
    });
    expect(h.policies.record.applied.entries).toEqual(target);
    expect(h.proxy.activeExclusions).toEqual(target);
    expect(h.safety.exclusionGuard).toBeNull();
  });
});
