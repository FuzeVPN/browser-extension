// SPDX-License-Identifier: MPL-2.0

import { SiteExclusionController } from "../../src/core/background/site-exclusion-controller";
import {
  ExtensionSiteExclusionStorage,
  emptySiteExclusionRecord,
  SITE_EXCLUSIONS_KEY,
  type SiteExclusionRecord,
  type SiteExclusionStorage,
} from "../../src/core/storage/site-exclusion-storage";
import { DEFAULT_SECURITY_STATE } from "../../src/core/shared/security";
import { ALARM_REFRESH, MAX_REFRESH_ATTEMPTS } from "../../src/core/shared/config";
import {
  FakeProxy,
  FakeSafety,
  NOW,
  authenticatedState,
  createHarness,
  proxySession,
} from "./helpers";
import type { SiteExclusion } from "../../src/core/shared/site-exclusions";

const broad: SiteExclusion = { domain: "example.com", includeSubdomains: true };
const narrow: SiteExclusion = { domain: "shop.example.com", includeSubdomains: false };
const other: SiteExclusion = { domain: "example.org", includeSubdomains: false };

class MemoryPolicies implements SiteExclusionStorage {
  record = emptySiteExclusionRecord();
  writes: SiteExclusionRecord[] = [];
  failRead = false;
  failWrite = 0;
  afterWrite: ((record: SiteExclusionRecord) => Promise<void>) | null = null;
  async read() {
    if (this.failRead) throw new Error("read failed");
    return structuredClone(this.record);
  }
  async write(value: SiteExclusionRecord) {
    this.writes.push(structuredClone(value));
    if (this.failWrite === this.writes.length) throw new Error("write failed");
    this.record = structuredClone(value);
    await this.afterWrite?.(value);
  }
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("durable site exclusion transactions", () => {
  it("rejects unsupported Chrome regexes before creating a pending journal or changing protection", async () => {
    const storage = new MemoryPolicies();
    const proxy = new FakeProxy();
    class RejectingSafety extends FakeSafety {
      validateExclusions = vi.fn(async () => {
        throw new Error("invalid_site_exclusions");
      });
    }
    const safety = new RejectingSafety();
    const controller = new SiteExclusionController(storage, proxy, safety);
    await controller.initialize();
    await expect(controller.stage(0, true, [broad])).rejects.toThrow("invalid_site_exclusions");
    expect(storage.writes).toEqual([]);
    expect(safety.events).toEqual([]);
    expect(controller.getState()).toMatchObject({
      pending: false,
      error: false,
      saved: { revision: 0 },
    });
  });

  it("rolls back a previously persisted impossible policy without applying its target", async () => {
    const storage = new MemoryPolicies();
    storage.record = {
      version: 1,
      saved: { revision: 2, enabled: true, entries: [other] },
      applied: { revision: 1, enabled: true, entries: [broad] },
      pending: true,
    };
    const proxy = new FakeProxy();
    proxy.rejectExclusions = true;
    const safety = new FakeSafety();
    const controller = new SiteExclusionController(storage, proxy, safety);
    await controller.initialize();
    await controller.rollback();
    expect(storage.record).toMatchObject({
      pending: false,
      saved: { revision: 2, entries: [broad] },
      applied: { revision: 2, entries: [broad] },
    });
    expect(controller.getState()).toMatchObject({ pending: false, error: false });
    // The parent release still owns removal of the baseline after restoring durable state.
    expect(safety.status.trafficBlocked).toBe(true);
    expect(safety.exclusionGuard).toBeNull();
    expect(proxy.applyCalls).toBe(0);
  });

  it("keeps a universal rollback guard when restoring the journal fails", async () => {
    const storage = new MemoryPolicies();
    const safety = new FakeSafety();
    const controller = new SiteExclusionController(storage, new FakeProxy(), safety);
    await controller.initialize();
    await controller.stage(0, true, [broad]);
    storage.failWrite = storage.writes.length + 1;
    await expect(controller.rollback()).rejects.toThrow("write failed");
    expect(controller.getState()).toMatchObject({ pending: true, error: true });
    expect(safety.exclusionGuard).toEqual([]);
    expect(safety.status.trafficBlocked).toBe(true);
    storage.failWrite = 0;
    await controller.rollback();
    expect(controller.getState()).toMatchObject({
      pending: false,
      error: false,
      saved: { revision: 1, entries: [] },
    });
  });

  it("journals before routing and retains the coverage intersection until commit", async () => {
    const storage = new MemoryPolicies();
    const proxy = new FakeProxy();
    const safety = new FakeSafety();
    const controller = new SiteExclusionController(storage, proxy, safety);
    await controller.initialize();
    await controller.stage(0, true, [broad]);
    await controller.apply();
    const previous = structuredClone(storage.record);
    await controller.stage(1, true, [narrow, other]);
    const gate = deferred();
    proxy.exclusionWait = gate.promise;
    const applying = controller.apply();
    await vi.waitFor(() => expect(safety.status.trafficBlocked).toBe(true));
    await vi.waitFor(() => expect(safety.exclusions).toEqual([narrow]));
    expect(storage.record).toMatchObject({ pending: true, applied: previous.applied });
    expect(controller.getState()).toMatchObject({ pending: true, saved: { revision: 2 } });
    gate.resolve();
    await applying;
    expect(storage.record.pending).toBe(false);
    expect(safety.exclusions).toEqual([narrow, other]);
    expect(controller.getState()).toMatchObject({
      pending: false,
      error: false,
      applied: { revision: 2 },
    });
  });

  it("preserves a restrictive guard on proxy failure and resumes after worker recreation", async () => {
    const storage = new MemoryPolicies();
    const proxy = new FakeProxy();
    const safety = new FakeSafety();
    const first = new SiteExclusionController(storage, proxy, safety);
    await first.initialize();
    await first.stage(0, true, [broad]);
    proxy.rejectExclusions = true;
    await expect(first.apply()).rejects.toThrow();
    expect(storage.record.pending).toBe(true);
    expect(safety.exclusions).toEqual([]);
    expect(safety.status.trafficBlocked).toBe(true);
    const restarted = new SiteExclusionController(storage, proxy, safety);
    await restarted.initialize();
    proxy.rejectExclusions = false;
    await restarted.apply();
    expect(restarted.getState()).toMatchObject({
      pending: false,
      error: false,
      applied: { entries: [broad] },
    });
  });

  it("rejects stale versions and duplicate entries without changing storage", async () => {
    const storage = new MemoryPolicies();
    const controller = new SiteExclusionController(storage, new FakeProxy(), new FakeSafety());
    await controller.initialize();
    await expect(controller.stage(1, true, [broad])).rejects.toThrow("revision_conflict");
    await expect(controller.stage(0, true, [broad, broad])).rejects.toThrow(
      "invalid_site_exclusions",
    );
    expect(storage.writes).toHaveLength(0);
  });

  it("retains the intersection when the definitive storage write fails", async () => {
    const storage = new MemoryPolicies();
    const safety = new FakeSafety();
    const controller = new SiteExclusionController(storage, new FakeProxy(), safety);
    await controller.initialize();
    await controller.stage(0, true, [broad]);
    storage.failWrite = 3;
    await expect(controller.apply()).rejects.toThrow("write failed");
    expect(controller.getState()).toMatchObject({ pending: true, error: true });
    expect(safety.exclusions).toEqual([]);
    expect(safety.status.trafficBlocked).toBe(true);
    storage.failWrite = 0;
    await controller.apply();
    expect(controller.getState()).toMatchObject({ pending: false, error: false });
  });

  it("does not silently discard unreadable policy storage", async () => {
    const storage = new MemoryPolicies();
    storage.failRead = true;
    const safety = new FakeSafety();
    const controller = new SiteExclusionController(storage, new FakeProxy(), safety);
    await expect(controller.initialize()).rejects.toThrow();
    await controller.retainGuard();
    expect(controller.getState()).toMatchObject({ pending: true, error: true });
    expect(safety.exclusions).toEqual([]);
    storage.failRead = false;
    await controller.apply();
    expect(controller.getState()).toMatchObject({ pending: false, error: false });
  });
});

describe("site exclusions in the connection lifecycle", () => {
  async function connected(storage = new MemoryPolicies()) {
    const harness = createHarness({
      persisted: authenticatedState(),
      siteExclusionStorage: storage,
    });
    await harness.controller.initialize();
    await harness.controller.connect("frankfurt-01");
    expect(harness.controller.getSnapshot().protected).toBe(true);
    return { ...harness, policies: storage };
  }

  it("applies connected edits, keeps the session and preserves preferences after logout", async () => {
    const h = await connected();
    const session = h.proxy.active;
    await h.controller.updateSiteExclusions(0, true, [broad]);
    expect(h.proxy.active).toBe(session);
    expect(h.proxy.activeExclusions).toEqual([broad]);
    expect(h.controller.getSnapshot()).toMatchObject({
      protected: true,
      siteExclusions: { applied: { revision: 1 } },
    });
    await h.controller.logout();
    expect(h.controller.getSnapshot().siteExclusions.saved.entries).toEqual([broad]);
    expect(h.policies.record.pending).toBe(false);
    expect(h.proxy.active).toBeNull();
  });

  it("edits exclusions during an outage without creating or restoring a session", async () => {
    const h = await connected();
    await h.controller.updateSiteExclusions(0, true, [broad]);
    await h.controller.handleProxyError("ERR_PROXY_CERTIFICATE_INVALID", true);
    const count = h.proxy.applyCalls;
    expect(await h.controller.getActiveSession()).toBeNull();
    await h.controller.updateSiteExclusions(1, true, [narrow]);
    expect(h.proxy.applyCalls).toBe(count);
    expect(await h.controller.getActiveSession()).toBeNull();
    expect(h.proxy.activeExclusions).toEqual([narrow]);
    expect(h.controller.getSnapshot()).toMatchObject({
      protected: false,
      trafficBlocked: true,
      blockingScope: "except_excluded",
    });
  });

  it("serializes renewal behind an exclusion edit", async () => {
    const h = await connected();
    const gate = deferred();
    h.proxy.exclusionWait = gate.promise;
    const editing = h.controller.updateSiteExclusions(0, true, [broad]);
    await vi.waitFor(() => expect(h.controller.getSnapshot().siteExclusions.pending).toBe(true));
    h.api.sessions = [proxySession("renewed")];
    const renewal = h.controller.handleAlarm(ALARM_REFRESH);
    gate.resolve();
    await Promise.all([editing, renewal]);
    expect(h.controller.getSnapshot()).toMatchObject({
      protected: true,
      siteExclusions: { pending: false },
    });
    expect(h.proxy.activeExclusions).toEqual([broad]);
  });

  it.each([false, true])(
    "does not strand an edited session when a renewal is deferred (exhausted: %s)",
    async (exhausted) => {
      const h = await connected();
      h.storage.transient.refreshAttempts = exhausted ? MAX_REFRESH_ATTEMPTS : 1;
      h.storage.transient.refreshRetryAt = NOW + 100_000;
      const sessionCount = h.api.proofs.length;
      const gate = deferred();
      h.proxy.exclusionWait = gate.promise;
      const updating = vi.spyOn(h.proxy, "updateExistingExclusions");
      const reading = vi.spyOn(h.storage, "readTransient");
      const editing = h.controller.updateSiteExclusions(0, true, [broad]);
      await vi.waitFor(() => expect(updating).toHaveBeenCalledOnce());
      const renewal = h.controller.handleAlarm(ALARM_REFRESH);
      await vi.waitFor(() => expect(reading).toHaveBeenCalledOnce());
      gate.resolve();
      await Promise.all([editing, renewal]);
      expect(h.controller.getSnapshot()).toMatchObject({
        status: "connected",
        protected: true,
        trafficBlocked: false,
        siteExclusions: { pending: false, error: false, applied: { entries: [broad] } },
      });
      expect(h.proxy.activeExclusions).toEqual([broad]);
      expect(h.api.proofs).toHaveLength(sessionCount);
      expect(h.alarms.retryAt).toBe(exhausted ? null : NOW + 100_000);
    },
  );

  it("does not reauthorize when a simultaneous disconnect supersedes an edit", async () => {
    const h = await connected();
    const gate = deferred();
    h.proxy.exclusionWait = gate.promise;
    const editing = h.controller.updateSiteExclusions(0, true, [broad]);
    await vi.waitFor(() => expect(h.controller.getSnapshot().siteExclusions.pending).toBe(true));
    h.safety.events = [];
    const disconnecting = h.controller.disconnect();
    await vi.waitFor(() => expect(h.controller.getSnapshot().status).toBe("disconnecting"));
    gate.resolve();
    await Promise.all([editing, disconnecting]);
    expect(h.safety.events).not.toContain("allow");
    expect(h.controller.getSnapshot()).toMatchObject({
      protected: false,
      protectionRequested: false,
      siteExclusions: { pending: false },
    });
    expect(h.proxy.active).toBeNull();
  });

  it("does not report a committed policy as failed when disconnect interrupts reauthorization", async () => {
    const h = await connected();
    const gate = deferred();
    const allowing = deferred();
    const original = h.safety.allow.bind(h.safety);
    const allowance = vi.spyOn(h.safety, "allow").mockImplementationOnce(async () => {
      await original();
      allowing.resolve();
      await gate.promise;
    });
    const editing = h.controller.updateSiteExclusions(0, true, [broad]);
    await allowing.promise;
    expect(h.policies.record.pending).toBe(false);
    const disconnecting = h.controller.disconnect();
    await vi.waitFor(() => expect(h.controller.getSnapshot().status).toBe("disconnecting"));
    gate.resolve();
    await expect(editing).resolves.toBeUndefined();
    await disconnecting;
    expect(h.controller.getSnapshot()).toMatchObject({
      protected: false,
      protectionRequested: false,
      siteExclusions: { pending: false, error: false, applied: { entries: [broad] } },
    });
    allowance.mockRestore();
    await h.controller.connect("frankfurt-01");
    expect(h.controller.getSnapshot().protected).toBe(true);
  });

  it("still reports an interrupted policy application when disconnect supersedes it", async () => {
    const h = await connected();
    const gate = deferred();
    const updating = vi
      .spyOn(h.proxy, "updateExistingExclusions")
      .mockImplementationOnce(async () => {
        await gate.promise;
        throw new DOMException("Proxy update interrupted", "AbortError");
      });
    const editing = h.controller.updateSiteExclusions(0, true, [broad]);
    const outcome = editing.then(
      () => null,
      (error: unknown) => error,
    );
    await vi.waitFor(() => expect(updating).toHaveBeenCalledOnce());
    const disconnecting = h.controller.disconnect();
    await vi.waitFor(() => expect(h.controller.getSnapshot().status).toBe("disconnecting"));
    gate.resolve();
    expect(await outcome).toMatchObject({
      name: "AbortError",
      message: "Proxy update interrupted",
    });
    await disconnecting;
    expect(h.controller.getSnapshot().protected).toBe(false);
  });

  it("guards even with kill switch disabled after an uncertain journal write and supports retry", async () => {
    const h = await connected();
    await h.controller.updateSecurityPreferences(false, true);
    h.policies.failWrite = 1;
    await expect(h.controller.updateSiteExclusions(0, true, [broad])).rejects.toThrow();
    expect(h.controller.getSnapshot()).toMatchObject({
      protected: false,
      trafficBlocked: true,
      siteExclusions: { pending: true, error: true },
    });
    h.policies.failWrite = 0;
    await h.controller.retrySiteExclusions();
    expect(h.controller.getSnapshot()).toMatchObject({
      protected: true,
      trafficBlocked: false,
      siteExclusions: { pending: false, error: false },
    });
  });

  it("recovers a durable transaction before authorizing restored credentials", async () => {
    const storage = new MemoryPolicies();
    storage.record = {
      ...emptySiteExclusionRecord(),
      saved: { revision: 1, enabled: true, entries: [broad] },
      pending: true,
    };
    const session = proxySession();
    const h = createHarness({
      persisted: authenticatedState({ autoConnect: true }),
      activeProxy: session,
      transient: { proxySession: session, refreshAttempts: 0, retiredSessions: [] },
      siteExclusionStorage: storage,
      security: { ...DEFAULT_SECURITY_STATE, protectionRequested: true, killSwitchEnabled: false },
    });
    await h.controller.initialize();
    expect(storage.record.pending).toBe(false);
    expect(h.controller.getSnapshot()).toMatchObject({
      protected: true,
      siteExclusions: { applied: { revision: 1 } },
    });
    expect(h.safety.events.indexOf("block")).toBeLessThan(h.safety.events.indexOf("allow"));
  });
});

describe("Chrome site exclusion storage", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("defaults absent storage and rejects corrupted journals", async () => {
    const stored: { value?: unknown } = {};
    vi.stubGlobal("browser", {
      storage: { local: { get: async () => ({ [SITE_EXCLUSIONS_KEY]: stored.value }) } },
    });
    const storage = new ExtensionSiteExclusionStorage();
    expect(await storage.read()).toEqual(emptySiteExclusionRecord());
    stored.value = {
      ...emptySiteExclusionRecord(),
      saved: { revision: 10, enabled: true, entries: [broad] },
    };
    await expect(storage.read()).rejects.toThrow("invalid_site_exclusion_storage");
  });
  it("detects a silently ignored write", async () => {
    vi.stubGlobal("browser", {
      storage: { local: { get: async () => ({}), set: async () => undefined } },
    });
    const storage = new ExtensionSiteExclusionStorage();
    await expect(
      storage.write({
        ...emptySiteExclusionRecord(),
        pending: true,
        saved: { revision: 1, enabled: true, entries: [broad] },
      }),
    ).rejects.toThrow("unverified");
  });
});
