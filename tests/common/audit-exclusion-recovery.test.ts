// SPDX-License-Identifier: MPL-2.0

import { SiteExclusionController } from "../../src/core/background/site-exclusion-controller";
import {
  ExtensionSiteExclusionStorage,
  emptySiteExclusionRecord,
  InvalidSiteExclusionStorageError,
  SITE_EXCLUSION_RECOVERY_KEY,
  SITE_EXCLUSIONS_KEY,
  type SiteExclusionRecord,
} from "../../src/core/storage/site-exclusion-storage";
import { DEFAULT_SECURITY_STATE } from "../../src/core/shared/security";
import { authenticatedState, createHarness, FakeProxy, FakeSafety, proxySession } from "./helpers";

const entry = { domain: "example.com", includeSubdomains: true };

function corruptRecord(): unknown {
  return {
    version: 1,
    saved: { revision: 8, enabled: true, entries: [entry] },
    applied: { revision: 7, enabled: true, entries: [entry] },
    pending: false,
  };
}

function fixture(value: unknown = corruptRecord()) {
  const stored: Record<string, unknown> = { [SITE_EXCLUSIONS_KEY]: value };
  const controls = {
    readFailure: false,
    writeFailure: false,
    ignoreWrites: false,
    dropDiagnosis: false,
    beforeWrite: (): void => undefined,
    beforeRead: (): void => undefined,
  };
  const get = vi.fn(async () => {
    controls.beforeRead();
    if (controls.readFailure) throw new Error("storage unavailable");
    return structuredClone(stored);
  });
  const set = vi.fn(async (items: Record<string, unknown>) => {
    controls.beforeWrite();
    if (controls.writeFailure) throw new Error("quota exceeded");
    if (controls.ignoreWrites) return;
    const next = Object.fromEntries(
      Object.entries(structuredClone(items)).filter(
        ([key]) => !controls.dropDiagnosis || key !== SITE_EXCLUSION_RECOVERY_KEY,
      ),
    );
    Object.assign(stored, next);
  });
  vi.stubGlobal("browser", { storage: { local: { get, set } } });
  return { stored, controls, get, set, storage: new ExtensionSiteExclusionStorage() };
}

async function blockedController(f = fixture()) {
  const proxy = new FakeProxy();
  const safety = new FakeSafety();
  const controller = new SiteExclusionController(f.storage, proxy, safety);
  await expect(controller.initialize()).rejects.toBeInstanceOf(InvalidSiteExclusionStorageError);
  await controller.retainGuard();
  return { ...f, controller, proxy, safety };
}

describe("explicit recovery of corrupt exclusion preferences", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("keeps automatic initialization and retry closed without overwriting corruption", async () => {
    const h = await blockedController();
    await expect(h.controller.apply()).rejects.toBeInstanceOf(InvalidSiteExclusionStorageError);
    expect(h.controller.getState()).toMatchObject({ pending: true, error: true });
    expect(h.safety.status.trafficBlocked).toBe(true);
    expect(h.safety.exclusionGuard).toEqual([]);
    expect(h.set).not.toHaveBeenCalled();
    expect(h.stored[SITE_EXCLUSIONS_KEY]).toEqual(corruptRecord());
  });

  it("durably resets corruption under a universal guard and preserves a visible notice", async () => {
    const h = await blockedController();
    h.controls.beforeWrite = () => {
      expect(h.safety.status.trafficBlocked).toBe(true);
      expect(h.safety.exclusionGuard).toEqual([]);
      expect(h.safety.exclusions).toEqual([]);
      expect(h.safety.events).not.toContain("release");
    };
    await h.controller.rollback();
    expect(h.controller.getState()).toEqual({
      saved: { revision: 9, enabled: false, entries: [] },
      applied: { revision: 9, enabled: false, entries: [] },
      pending: false,
      error: false,
      recoveryNotice: "preferences_reset",
    });
    expect(h.safety.exclusionGuard).toBeNull();
    // The parent owns releasing the baseline after saving the explicit stop intent.
    expect(h.safety.status.trafficBlocked).toBe(true);
    expect(h.proxy.applyCalls).toBe(0);
    expect(h.stored[SITE_EXCLUSION_RECOVERY_KEY]).toMatchObject({
      reason: "invalid_site_exclusion_storage",
      summary: { saved: { revision: 8, entryCount: 1 }, applied: { revision: 7, entryCount: 1 } },
    });
    const restarted = new SiteExclusionController(h.storage, h.proxy, h.safety);
    await restarted.initialize();
    expect(restarted.getState()).toEqual(h.controller.getState());
  });

  it.each(["writeFailure", "ignoreWrites", "dropDiagnosis"] as const)(
    "retains the guard if recovery is not durably verified: %s",
    async (failure) => {
      const h = await blockedController();
      h.controls[failure] = true;
      await expect(h.controller.rollback()).rejects.toThrow();
      expect(h.controller.getState()).toMatchObject({ pending: true, error: true });
      expect(h.safety.exclusionGuard).toEqual([]);
      expect(h.safety.status.trafficBlocked).toBe(true);
      expect(h.safety.events).not.toContain("release");
    },
  );

  it("never replaces unread data when Chrome storage is temporarily unavailable", async () => {
    const h = await blockedController();
    h.controls.readFailure = true;
    await expect(h.controller.rollback()).rejects.toThrow("storage unavailable");
    expect(h.set).not.toHaveBeenCalled();
    expect(h.stored[SITE_EXCLUSIONS_KEY]).toEqual(corruptRecord());
    expect(h.safety.status.trafficBlocked).toBe(true);
  });

  it("rechecks corruption before resetting and preserves a policy that became readable", async () => {
    const h = await blockedController();
    const valid: SiteExclusionRecord = {
      version: 1,
      saved: { revision: 10, enabled: true, entries: [entry] },
      applied: { revision: 10, enabled: true, entries: [entry] },
      pending: false,
    };
    let reads = 0;
    h.controls.beforeRead = () => {
      if (++reads === 2) h.stored[SITE_EXCLUSIONS_KEY] = valid;
    };
    await h.controller.rollback();
    expect(h.controller.getState()).toMatchObject({ saved: valid.saved, error: false });
    expect(h.controller.getState().recoveryNotice).toBeUndefined();
    expect(h.set).not.toHaveBeenCalled();
  });

  it("keeps the notice during a failed edit and removes it only after a successful commit", async () => {
    const h = await blockedController();
    await h.controller.rollback();
    await h.controller.stage(9, true, [entry]);
    expect(h.controller.getState().recoveryNotice).toBe("preferences_reset");
    h.proxy.rejectExclusions = true;
    await expect(h.controller.apply()).rejects.toThrow();
    expect((await h.storage.read()).recoveryNotice).toBe("preferences_reset");
    h.proxy.rejectExclusions = false;
    await h.controller.apply();
    expect(h.controller.getState().recoveryNotice).toBeUndefined();
    expect((await h.storage.read()).recoveryNotice).toBeUndefined();
    expect(h.controller.getState().applied.entries).toEqual([entry]);
  });

  it("bounds the diagnosis and recovers unusable revisions without copying arbitrary data", async () => {
    const f = fixture({
      version: 999,
      saved: { revision: Number.MAX_SAFE_INTEGER, entries: Array(10_000).fill("x".repeat(100)) },
      secret: "never duplicate arbitrary fields",
    });
    const recovered = await f.storage.recoverForDisconnect();
    expect(recovered.saved.revision).toBe(1);
    expect(recovered.saved.entries).toEqual([]);
    expect(recovered.recoveryNotice).toBe("preferences_reset");
    const diagnosis = JSON.stringify(f.stored[SITE_EXCLUSION_RECOVERY_KEY]);
    expect(diagnosis.length).toBeLessThan(1_024);
    expect(diagnosis).not.toContain("secret");
    expect(diagnosis).not.toContain("xxxxxxxx");
    expect(JSON.parse(diagnosis)).toMatchObject({ summary: { saved: { entryCount: 10_000 } } });
  });

  it.each(["disconnect", "logout"] as const)(
    "%s clears the proxy before resetting corruption and releases navigation",
    async (action) => {
      const f = fixture();
      const session = proxySession();
      const h = createHarness({
        persisted: authenticatedState({ autoConnect: true }),
        activeProxy: session,
        transient: { proxySession: session, refreshAttempts: 0, retiredSessions: [] },
        siteExclusionStorage: f.storage,
        security: { ...DEFAULT_SECURITY_STATE, protectionRequested: true },
      });
      await h.controller.initialize();
      expect(h.controller.getSnapshot().trafficBlocked).toBe(true);
      f.controls.beforeWrite = () => {
        expect(h.proxy.active).toBeNull();
        expect(h.proxy.clearCalls).toBeGreaterThan(0);
        expect(h.safety.status.trafficBlocked).toBe(true);
      };
      await h.controller[action]();
      expect(h.controller.getSnapshot()).toMatchObject({
        status: action === "disconnect" ? "disconnected" : "logged_out",
        protected: false,
        protectionRequested: false,
        trafficBlocked: false,
        siteExclusions: {
          pending: false,
          error: false,
          saved: { enabled: false, entries: [] },
          recoveryNotice: "preferences_reset",
        },
      });
      expect(h.securityStorage.state?.protectionRequested).toBe(false);
    },
  );

  it("does not reset corruption or release the guard when proxy clearing fails", async () => {
    const f = fixture();
    const h = createHarness({
      persisted: authenticatedState(),
      siteExclusionStorage: f.storage,
    });
    await h.controller.initialize();
    vi.spyOn(h.proxy, "clear").mockRejectedValue(new Error("proxy clear rejected"));
    await h.controller.disconnect();
    expect(f.set).not.toHaveBeenCalled();
    expect(h.controller.getSnapshot()).toMatchObject({
      trafficBlocked: true,
      siteExclusions: { pending: true, error: true },
    });
  });

  it("preserves readable pending preferences on normal explicit rollback", async () => {
    const record = emptySiteExclusionRecord();
    record.saved = { revision: 1, enabled: true, entries: [entry] };
    record.pending = true;
    const f = fixture(record);
    const controller = new SiteExclusionController(f.storage, new FakeProxy(), new FakeSafety());
    await controller.initialize();
    await controller.rollback();
    expect(controller.getState()).toMatchObject({
      pending: false,
      error: false,
      saved: { revision: 1, enabled: false, entries: [] },
    });
    expect(controller.getState().recoveryNotice).toBeUndefined();
    expect(f.stored[SITE_EXCLUSION_RECOVERY_KEY]).toBeUndefined();
  });
});
