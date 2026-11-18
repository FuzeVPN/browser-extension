// SPDX-License-Identifier: MPL-2.0

import type { NetworkSafetyService } from "../../src/core/background/network-safety";
import { DEFAULT_SECURITY_STATE } from "../../src/core/shared/security";
import { authenticatedState, createHarness, FakeSafety, NOW } from "./helpers";

type Harness = ReturnType<typeof createHarness>;

/** A guard which can attest that nothing of this extension is in place. */
class BrowserGuard extends FakeSafety implements NetworkSafetyService {
  /** A rule or a setting which some earlier worker left behind. */
  leftover = false;
  attestations = 0;
  async verifyReleased(): Promise<boolean> {
    this.attestations += 1;
    return (
      !this.leftover &&
      !this.status.filterActive &&
      !this.status.trafficBlocked &&
      !this.status.webRtcProtected
    );
  }
}

/** What a start-up wrote or released, apart from closing the guard at its first instruction. */
function changes(h: Harness, guard: FakeSafety) {
  return {
    released: guard.events.filter((event) => event !== "suspend"),
    proxyCleared: h.proxy.clearCalls,
  };
}

function watch(h: Harness) {
  return {
    security: vi.spyOn(h.securityStorage, "write"),
    transient: vi.spyOn(h.storage, "clearTransient"),
    alarms: vi.spyOn(h.alarms, "clearAll"),
  };
}

afterEach(() => vi.restoreAllMocks());

describe("a worker which starts with nothing requested and nothing in place", () => {
  it.each([
    ["an account which is signed in", authenticatedState(), "disconnected"],
    ["nobody signed in", undefined, "logged_out"],
  ] as const)("releases nothing, with %s", async (_name, persisted, status) => {
    const guard = new BrowserGuard();
    // A first worker creates the stores, as an installation does.
    const first = createHarness({ ...(persisted ? { persisted } : {}), safety: guard });
    await first.controller.initialize();

    const next = createHarness({
      persisted: first.storage.persisted,
      security: first.securityStorage.state!,
      safety: guard,
    });
    guard.events = [];
    const written = watch(next);
    await next.controller.initialize();

    expect(guard.attestations).toBeGreaterThan(0);
    expect(changes(next, guard)).toEqual({ released: [], proxyCleared: 0 });
    expect(written.security).not.toHaveBeenCalled();
    expect(written.transient).not.toHaveBeenCalled();
    expect(written.alarms).not.toHaveBeenCalled();
    expect(next.controller.getSnapshot()).toMatchObject({
      status,
      protected: false,
      protectionRequested: false,
      trafficBlocked: false,
    });
  });

  it("still releases nothing after a connection which was ended on purpose", async () => {
    const guard = new BrowserGuard();
    const first = createHarness({ persisted: authenticatedState(), safety: guard });
    await first.controller.initialize();
    expect(await first.controller.connect("frankfurt-01")).toEqual({ ok: true });
    expect(await first.controller.disconnect()).toEqual({ ok: true });

    const next = createHarness({
      persisted: first.storage.persisted,
      transient: first.storage.transient,
      security: first.securityStorage.state!,
      safety: guard,
    });
    guard.events = [];
    const written = watch(next);
    await next.controller.initialize();

    expect(changes(next, guard)).toEqual({ released: [], proxyCleared: 0 });
    expect(written.security).not.toHaveBeenCalled();
    // A connection is still made as before.
    expect(await next.controller.connect("frankfurt-01")).toEqual({ ok: true });
    expect(next.controller.getSnapshot()).toMatchObject({ status: "connected", protected: true });
  });
});

describe("a worker which finds something left in place", () => {
  async function started(prepare: (h: Harness, guard: BrowserGuard) => void) {
    const guard = new BrowserGuard();
    const h = createHarness({
      persisted: authenticatedState(),
      security: { ...DEFAULT_SECURITY_STATE },
      safety: guard,
    });
    prepare(h, guard);
    await h.controller.initialize();
    return { h, guard };
  }

  it("releases it when a rule or a setting of its own remains", async () => {
    const { h, guard } = await started((_h, safety) => {
      safety.leftover = true;
    });

    expect(guard.events).toContain("release");
    expect(h.proxy.clearCalls).toBeGreaterThan(0);
    expect(h.controller.getSnapshot()).toMatchObject({ status: "disconnected" });
  });

  it("releases it when the proxy is still under its control", async () => {
    const { h, guard } = await started((harness) => {
      harness.proxy.level = "controlled_by_this_extension";
      harness.proxy.blockingRoute = true;
    });

    expect(h.proxy.clearCalls).toBeGreaterThan(0);
    expect(h.proxy.level).toBe("controllable_by_this_extension");
    expect(guard.events).toContain("release");
  });

  it("releases it when sessions remain to forget", async () => {
    const { h, guard } = await started((harness) => {
      harness.storage.transient = {
        proxySession: null,
        refreshAttempts: 0,
        retiredSessions: [
          { sessionId: "retired", expiresAt: new Date(NOW + 60_000).toISOString() },
        ],
      };
    });

    expect(guard.events).toContain("release");
    expect(h.storage.transient.retiredSessions).toEqual([]);
  });

  it("releases it when the stored state is not the released one", async () => {
    const { h, guard } = await started((harness) => {
      harness.securityStorage.state = {
        ...DEFAULT_SECURITY_STATE,
        reconnectAttempts: 2,
        backoffLevel: 2,
      };
    });

    expect(guard.events).toContain("release");
    expect(h.securityStorage.state).toMatchObject({ reconnectAttempts: 0 });
    expect(h.securityStorage.state).not.toHaveProperty("backoffLevel");
  });

  it("releases it when a guard of unreadable stores was recorded", async () => {
    const { h, guard } = await started((harness) => {
      harness.securityStorage.temporaryGuard = true;
    });

    expect(guard.events).toContain("release");
    expect(h.securityStorage.temporaryGuard).toBe(false);
  });

  it("releases everything on a platform which attests nothing", async () => {
    const guard = new FakeSafety();
    const h = createHarness({ persisted: authenticatedState(), safety: guard });
    await h.controller.initialize();

    expect(guard.events).toContain("release");
    expect(h.proxy.clearCalls).toBeGreaterThan(0);
  });

  it("releases everything when the attestation fails", async () => {
    const { guard } = await started((_h, safety) => {
      vi.spyOn(safety, "verifyReleased").mockRejectedValue(new Error("rules unreadable"));
    });

    expect(guard.events).toContain("release");
  });
});
