// SPDX-License-Identifier: MPL-2.0

import { SafetyError, type NetworkSafetyService } from "../../src/core/background/network-safety";
import { DEFAULT_SECURITY_STATE } from "../../src/core/shared/security";
import {
  emptySiteExclusionRecord,
  type SiteExclusionStorage,
} from "../../src/core/storage/site-exclusion-storage";
import { authenticatedState, createHarness, FakeSafety, NOW, proxySession } from "./helpers";

const MINUTE = 60_000;

/**
 * The guard as a browser keeps it while no worker runs: its rules, and the allowance a
 * completed authorization left. It can attest that both are exactly in place.
 */
class BrowserGuard extends FakeSafety implements NetworkSafetyService {
  /** Whether requests pass at this moment. */
  allowed = false;
  /** False once something altered the rules while no worker ran. */
  intact = true;
  attestations = 0;

  override async suspend(): Promise<void> {
    await super.suspend();
    this.allowed = false;
  }
  override async block(kill: boolean): Promise<void> {
    await super.block(kill);
    this.allowed = false;
  }
  override async allow(): Promise<void> {
    await super.allow();
    this.allowed = true;
  }
  override async release(): Promise<void> {
    await super.release();
    this.allowed = false;
  }
  async verifyAllowance(): Promise<boolean> {
    this.attestations += 1;
    return this.intact && this.allowed && this.status.filterActive;
  }
}

type Harness = ReturnType<typeof createHarness>;

async function settle(turns = 20) {
  for (let turn = 0; turn < turns; turn++) await new Promise<void>((done) => setImmediate(done));
}

/** A first worker which connects, then is stopped by the browser. */
async function connectedThenStopped(
  guard: FakeSafety,
  killSwitchEnabled = true,
  webRtcProtectionEnabled = true,
) {
  const h = createHarness({
    persisted: authenticatedState(),
    security: { ...DEFAULT_SECURITY_STATE, killSwitchEnabled, webRtcProtectionEnabled },
    safety: guard,
  });
  await h.controller.initialize();
  expect(await h.controller.connect("frankfurt-01")).toEqual({ ok: true });
  await settle();
  expect(h.controller.getSnapshot()).toMatchObject({ status: "connected", protected: true });
  guard.events = [];
  return h;
}

/** The worker which the browser starts next, over what the first one left. */
function nextWorker(
  previous: Harness,
  guard: FakeSafety,
  options: {
    at?: number;
    siteExclusionStorage?: SiteExclusionStorage;
    startupPreflightTimeoutMs?: number;
  } = {},
) {
  const h = createHarness({
    persisted: previous.storage.persisted,
    transient: previous.storage.transient,
    security: previous.securityStorage.state!,
    activeProxy: previous.proxy.active!,
    safety: guard,
    ...(options.siteExclusionStorage ? { siteExclusionStorage: options.siteExclusionStorage } : {}),
    ...(options.startupPreflightTimeoutMs === undefined
      ? {}
      : { startupPreflightTimeoutMs: options.startupPreflightTimeoutMs }),
  });
  h.setNow(options.at ?? NOW + MINUTE);
  return h;
}

/** Whether the guard was closed at any moment of what the events record. */
const closed = (guard: FakeSafety) =>
  guard.events.some((event) => event === "suspend" || event === "block" || event === "release");

afterEach(() => vi.restoreAllMocks());

describe("a worker which starts over a protected connection found exactly in place", () => {
  it.each([true, false])("never closes the guard, kill switch %s", async (kill) => {
    const guard = new BrowserGuard();
    const first = await connectedThenStopped(guard, kill);

    const h = nextWorker(first, guard);
    await h.controller.initialize();
    await settle();

    expect(guard.attestations).toBe(1);
    expect(closed(guard)).toBe(false);
    expect(guard.allowed).toBe(true);
    // The allowance is still confirmed by the restoration, in one replacement.
    expect(guard.events.filter((event) => event === "allow")).toHaveLength(1);
    expect(h.controller.getSnapshot()).toMatchObject({
      status: "connected",
      protected: true,
      error: null,
      activeLocationId: "frankfurt-01",
    });
    expect(await h.controller.getActiveSession()).toEqual(first.proxy.active);
    expect(h.proxy.applyCalls).toBe(0);
  });

  it("publishes no state between sleep and restoration", async () => {
    const guard = new BrowserGuard();
    const first = await connectedThenStopped(guard);

    const h = nextWorker(first, guard);
    await h.controller.initialize();
    await settle();

    expect(h.snapshots.length).toBeGreaterThan(0);
    for (const published of h.snapshots)
      expect(published).toMatchObject({ status: "connected", protected: true, error: null });
  });

  it("keeps the renewal of the restored session", async () => {
    const guard = new BrowserGuard();
    const first = await connectedThenStopped(guard);

    const h = nextWorker(first, guard);
    await h.controller.initialize();
    await settle();

    expect(h.alarms.session?.id).toBe(first.proxy.active?.id);
  });
});

describe("a worker which cannot be told that everything is in place", () => {
  it("closes the guard first on a platform which attests nothing", async () => {
    const guard = new FakeSafety();
    const first = await connectedThenStopped(guard);

    const h = nextWorker(first, guard);
    await h.controller.initialize();
    await settle();

    expect(guard.events[0]).toBe("suspend");
    expect(guard.events).toContain("block");
    expect(h.controller.getSnapshot()).toMatchObject({ status: "connected", protected: true });
  });

  it("closes the guard first when its rules were altered", async () => {
    const guard = new BrowserGuard();
    const first = await connectedThenStopped(guard);
    guard.intact = false;

    const h = nextWorker(first, guard);
    await h.controller.initialize();
    await settle();

    expect(guard.events[0]).toBe("suspend");
    // Rewritten, then allowed again once verified.
    expect(guard.events.indexOf("block")).toBeLessThan(guard.events.indexOf("allow"));
    expect(h.controller.getSnapshot()).toMatchObject({ status: "connected", protected: true });
  });

  it("closes the guard first when the browser kept no allowance", async () => {
    const guard = new BrowserGuard();
    const first = await connectedThenStopped(guard);
    // A browser restart empties the rules of its session.
    guard.allowed = false;

    const h = nextWorker(first, guard);
    await h.controller.initialize();

    expect(guard.events[0]).toBe("suspend");
  });

  it("closes the guard first when the session has expired", async () => {
    const guard = new BrowserGuard();
    const first = await connectedThenStopped(guard);

    const h = nextWorker(first, guard, { at: NOW + 20 * MINUTE });
    h.api.sessions = [
      proxySession(
        "after-expiry",
        "frankfurt-01",
        new Date(NOW + 20 * MINUTE).toISOString(),
        new Date(NOW + 30 * MINUTE).toISOString(),
      ),
    ];
    await h.controller.initialize();
    await settle();

    expect(guard.attestations).toBe(0);
    expect(guard.events[0]).toBe("suspend");
    expect(h.proxy.active?.id).toBe("after-expiry");
  });

  it("closes the guard first when the proxy is no longer this extension's", async () => {
    const guard = new BrowserGuard();
    const first = await connectedThenStopped(guard);

    const h = nextWorker(first, guard);
    h.proxy.level = "controlled_by_other_extensions";
    await h.controller.initialize();
    await settle();

    expect(guard.events[0]).toBe("suspend");
    expect(guard.allowed).toBe(false);
    expect(h.controller.getSnapshot()).toMatchObject({
      protected: false,
      error: "proxy_controlled_by_extension",
    });
  });

  it("closes the guard first when the saved exclusions cannot be read", async () => {
    const guard = new BrowserGuard();
    const first = await connectedThenStopped(guard);
    const unreadable: SiteExclusionStorage = {
      read: async () => {
        throw new Error("exclusions unreadable");
      },
      write: async () => undefined,
    };

    const h = nextWorker(first, guard, { siteExclusionStorage: unreadable });
    await h.controller.initialize();
    await settle();

    expect(guard.events[0]).toBe("suspend");
    expect(guard.allowed).toBe(false);
    expect(h.controller.getSnapshot().protected).toBe(false);
  });

  it("closes the guard first when the account has expired", async () => {
    const guard = new BrowserGuard();
    const first = await connectedThenStopped(guard);
    first.storage.persisted = {
      ...first.storage.persisted,
      auth: { ...first.storage.persisted.auth!, expiresAt: new Date(NOW).toISOString() },
    };

    const h = nextWorker(first, guard);
    await h.controller.initialize();
    await settle();

    expect(guard.attestations).toBe(0);
    expect(guard.events[0]).toBe("suspend");
    expect(guard.allowed).toBe(false);
    expect(h.controller.getSnapshot().profile).toBeNull();
  });

  it("closes the guard first when protection was not requested", async () => {
    const guard = new BrowserGuard();
    const h = createHarness({ persisted: authenticatedState(), safety: guard });
    await h.controller.initialize();
    guard.events = [];

    const next = createHarness({
      persisted: h.storage.persisted,
      security: h.securityStorage.state!,
      safety: guard,
    });
    await next.controller.initialize();

    expect(guard.attestations).toBe(0);
    expect(guard.events[0]).toBe("suspend");
  });
});

describe("a worker whose checks do not answer", () => {
  it("closes the guard first when the rules are not attested in time", async () => {
    const guard = new BrowserGuard();
    const first = await connectedThenStopped(guard);

    const h = nextWorker(first, guard, { startupPreflightTimeoutMs: 20 });
    vi.spyOn(guard, "verifyAllowance").mockImplementation(() => new Promise<boolean>(() => {}));
    await h.controller.initialize();
    await settle();

    // The allowance did not stand unchecked: the start-up went on as one which keeps nothing.
    expect(guard.events[0]).toBe("suspend");
    expect(h.controller.getSnapshot()).toMatchObject({ status: "connected", protected: true });
  });

  it("reads the exclusions once when their read outlasts the deadline", async () => {
    const guard = new BrowserGuard();
    const first = await connectedThenStopped(guard);
    let reads = 0;
    const slow: SiteExclusionStorage = {
      async read() {
        reads += 1;
        await new Promise<void>((done) => setTimeout(done, 80));
        return emptySiteExclusionRecord();
      },
      write: async () => undefined,
    };

    const h = nextWorker(first, guard, {
      startupPreflightTimeoutMs: 20,
      siteExclusionStorage: slow,
    });
    await h.controller.initialize();
    await settle();

    expect(guard.events[0]).toBe("suspend");
    // The start-up joined the read it had stopped waiting for: none ends after it.
    expect(reads).toBe(1);
    expect(h.controller.getSnapshot()).toMatchObject({ status: "connected", protected: true });
  });
});

describe("a restoration which stops matching what was found in place", () => {
  it("reports a guard which refuses to close then as one to repair", async () => {
    const guard = new BrowserGuard();
    const first = await connectedThenStopped(guard);

    const h = nextWorker(first, guard);
    // Nothing is restored while the device is being recovered: the allowance is withdrawn.
    vi.spyOn(h.identity, "getRecovery").mockResolvedValueOnce({ pending: true, exhausted: false });
    vi.spyOn(guard, "block").mockRejectedValueOnce(new SafetyError("traffic_guard_failed"));
    await h.controller.initialize();
    await settle();

    expect(h.controller.getSnapshot()).toMatchObject({
      status: "error",
      error: "traffic_guard_failed",
      protected: false,
    });
    expect(await h.controller.getActiveSession()).toBeNull();
    // The session and its credentials were kept for the repair, as a refusal at the
    // first instruction keeps them.
    expect(h.storage.transient.proxySession).toEqual(first.storage.transient.proxySession);

    guard.events = [];
    await h.controller.initialize();
    await settle();
    expect(guard.events[0]).toBe("suspend");
    expect(h.controller.getSnapshot()).toMatchObject({ status: "connected", protected: true });
  });

  it("closes the guard when the device identity is being recovered", async () => {
    const guard = new BrowserGuard();
    const first = await connectedThenStopped(guard);

    const h = nextWorker(first, guard);
    vi.spyOn(h.identity, "getRecovery").mockResolvedValue({ pending: true, exhausted: false });
    await h.controller.initialize();
    await settle();

    expect(guard.attestations).toBe(1);
    // Closed and rewritten as soon as nothing is restored, before anything else.
    expect(guard.events).toContain("block");
    expect(guard.events.indexOf("block")).toBeLessThan(
      guard.events.includes("allow") ? guard.events.indexOf("allow") : Infinity,
    );
  });

  it("closes the guard when the restoration fails midway", async () => {
    const guard = new BrowserGuard();
    const first = await connectedThenStopped(guard);

    const h = nextWorker(first, guard);
    vi.spyOn(h.alarms, "scheduleSession").mockRejectedValueOnce(new Error("alarm refused"));
    await h.controller.initialize();
    await settle();

    expect(guard.events[0]).toBe("suspend");
    expect(guard.events).not.toContain("allow");
    expect(guard.allowed).toBe(false);
    // Fail-closed: the traffic guard blocks until the failure is dealt with.
    expect(h.controller.getSnapshot()).toMatchObject({ protected: false, status: "blocked" });
  });

  it("closes the guard when the guard itself no longer reads as open", async () => {
    const guard = new BrowserGuard();
    const first = await connectedThenStopped(guard);

    const h = nextWorker(first, guard);
    // Attested, then found without its filters when the restoration inspects it.
    const attest = guard.verifyAllowance.bind(guard);
    vi.spyOn(guard, "verifyAllowance").mockImplementation(async () => {
      const attested = await attest();
      guard.status.filterActive = false;
      return attested;
    });
    await h.controller.initialize();
    await settle();

    expect(guard.events[0]).toBe("suspend");
    expect(guard.events).toContain("block");
    expect(h.controller.getSnapshot()).toMatchObject({ status: "connected", protected: true });
  });

  it("is given up for an explicit disconnection received during the start-up", async () => {
    const guard = new BrowserGuard();
    const first = await connectedThenStopped(guard);

    const h = nextWorker(first, guard);
    const starting = h.controller.initialize();
    const stopping = h.controller.disconnect();
    await Promise.all([starting, stopping]);
    await settle();

    expect(guard.allowed).toBe(false);
    expect(guard.events).toContain("release");
    expect(h.controller.getSnapshot()).toMatchObject({
      status: "disconnected",
      protected: false,
      protectionRequested: false,
    });
    expect(await h.controller.getActiveSession()).toBeNull();
  });

  it.each([
    ["a platform which attests nothing", () => new FakeSafety()],
    ["a guard found open", () => new BrowserGuard()],
  ])(
    "restricts WebRTC while blocked after losing the proxy midway, with %s",
    async (_name, guardOf) => {
      // The user turned WebRTC protection off: while connected, WebRTC is unrestricted.
      const guard = guardOf();
      const first = await connectedThenStopped(guard, true, false);
      expect(guard.status.webRtcProtected).toBe(false);

      const h = nextWorker(first, guard);
      // Another extension takes the proxy while the session is being restored.
      const schedule = h.alarms.scheduleSession.bind(h.alarms);
      vi.spyOn(h.alarms, "scheduleSession").mockImplementationOnce(async (...args) => {
        await schedule(...args);
        h.proxy.level = "controlled_by_other_extensions";
      });
      await h.controller.initialize();
      await settle();

      expect(h.controller.getSnapshot()).toMatchObject({
        protected: false,
        error: "proxy_controlled_by_extension",
      });
      expect(guard.events).not.toContain("allow");
      // Requests are blocked, which WebRTC is not: it is restricted while nothing protects.
      expect(guard.status.webRtcProtected).toBe(true);
    },
  );

  it("is not tried again by a later restoration of the same worker", async () => {
    const guard = new BrowserGuard();
    const first = await connectedThenStopped(guard);
    const h = nextWorker(first, guard);
    h.proxy.level = "controlled_by_other_extensions";
    await h.controller.initialize();
    expect(guard.attestations).toBe(1);

    // Control comes back: the repair is a full restoration, guard closed first.
    h.proxy.level = "controlled_by_this_extension";
    guard.events = [];
    await h.controller.initialize();
    await settle();

    expect(guard.attestations).toBe(1);
    expect(guard.events[0]).toBe("suspend");
    expect(h.controller.getSnapshot()).toMatchObject({ status: "connected", protected: true });
  });
});
