// SPDX-License-Identifier: MPL-2.0

import { ApiError, NetworkError } from "../../src/core/api/client";
import { PROXY_CREATION_UNCERTAINTY_MS } from "../../src/core/shared/config";
import { DEFAULT_SECURITY_STATE, type SecurityState } from "../../src/core/shared/security";
import {
  ExtensionSecurityStorage,
  SECURITY_STORAGE_KEY,
} from "../../src/core/storage/security-storage";
import { authenticatedState, createHarness, NOW, proxySession } from "./helpers";

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
/** By then, a session created at NOW without its answer arriving has expired. */
const EXPIRED = NOW + PROXY_CREATION_UNCERTAINTY_MS;

type Harness = ReturnType<typeof createHarness>;

function sessionIssuedAt(time: number, id: string) {
  return proxySession(
    id,
    "frankfurt-01",
    new Date(time).toISOString(),
    new Date(time + 10 * MINUTE).toISOString(),
  );
}

/**
 * One incident: a session request left without an answer, then an explicit
 * disconnection. Nothing suspends retries any more; only the cleanup marker remains.
 */
async function incident(at = NOW) {
  const h = createHarness({ persisted: authenticatedState() });
  h.setNow(at);
  await h.controller.initialize();
  await h.controller.startupConnectionSettled();
  h.api.createError = new NetworkError("timeout");
  expect(await h.controller.connect("frankfurt-01")).toMatchObject({
    commandError: "proxy_creation_uncertain",
  });
  h.api.createError = null;
  expect(await h.controller.disconnect()).toEqual({ ok: true });
  expect(h.securityStorage.state).toMatchObject({
    protectionRequested: false,
    proxyCreationUncertain: false,
    proxyCleanupUncertain: true,
  });
  return h;
}

/** The next worker of the same browser profile. */
async function nextWorker(previous: Harness, at: number) {
  const h = createHarness({
    persisted: previous.storage.persisted,
    security: previous.securityStorage.state!,
  });
  h.setNow(at);
  await h.controller.initialize();
  await h.controller.startupConnectionSettled();
  return h;
}

async function logoutReport(h: Harness) {
  await h.controller.logout();
  return h.controller.getSnapshot().logoutOutcome?.proxySessions;
}

afterEach(() => vi.restoreAllMocks());

describe("the marker of a session nobody could name", () => {
  it("is stored with the time by which that session has expired", async () => {
    const h = await incident();

    expect(h.securityStorage.state?.proxyCleanupUncertainUntil).toBe(EXPIRED);
  });

  it("makes a logout report unconfirmed sessions while that session may live", async () => {
    const h = await incident();
    h.setNow(EXPIRED - 1);

    expect(await logoutReport(h)).toBe("unconfirmed");
  });

  it("is kept by a worker which starts while that session may live", async () => {
    const h = await nextWorker(await incident(), EXPIRED - 1);

    expect(h.securityStorage.state).toMatchObject({
      proxyCleanupUncertain: true,
      proxyCleanupUncertainUntil: EXPIRED,
    });
    expect(await logoutReport(h)).toBe("unconfirmed");
  });

  it("ends with the worker which starts once that session has expired", async () => {
    const h = await nextWorker(await incident(), EXPIRED);

    expect(h.securityStorage.state?.proxyCleanupUncertain).toBe(false);
    expect(h.securityStorage.state).not.toHaveProperty("proxyCleanupUncertainUntil");
    expect(await logoutReport(h)).toBe("confirmed");
  });

  it("no longer marks the logouts of the weeks which follow", async () => {
    let h = await incident();
    // Within the thirty days of the sign-in these tests use.
    for (const day of [1, 7, 29]) {
      h = await nextWorker(h, NOW + day * DAY);
      h.api.sessions = [sessionIssuedAt(NOW + day * DAY, `session-day-${String(day)}`)];
      expect(await h.controller.connect("frankfurt-01")).toEqual({ ok: true });
      expect(await h.controller.disconnect()).toEqual({ ok: true });
      expect(h.securityStorage.state?.proxyCleanupUncertain).toBe(false);
    }

    expect(await logoutReport(h)).toBe("confirmed");
  });

  it("ends at a logout of the same worker once that session has expired", async () => {
    const h = await incident();
    h.setNow(EXPIRED);

    expect(await logoutReport(h)).toBe("confirmed");
    expect(h.securityStorage.state?.proxyCleanupUncertain).toBe(false);
  });

  it("starts without the marker when the write which ends it fails", async () => {
    const previous = await incident();
    const h = createHarness({
      persisted: previous.storage.persisted,
      security: previous.securityStorage.state!,
    });
    h.setNow(EXPIRED);
    const refused = vi
      .spyOn(h.securityStorage, "write")
      .mockRejectedValueOnce(new Error("storage refused"));

    await h.controller.initialize();
    await h.controller.startupConnectionSettled();

    // The start-up neither fails nor waits for that write: a later one stores the end.
    expect(refused).toHaveBeenCalled();
    expect(h.controller.getSnapshot()).toMatchObject({ status: "disconnected", error: null });
    expect(await logoutReport(h)).toBe("confirmed");
    expect(h.securityStorage.state?.proxyCleanupUncertain).toBe(false);
  });
});

describe("a marker whose time was written by a clock running ahead", () => {
  it("ends one full delay after the worker which reads it, at the latest", async () => {
    const h = await incident();
    // Ten years ahead when the incident happened, then set right.
    h.securityStorage.state = {
      ...h.securityStorage.state!,
      proxyCleanupUncertainUntil: NOW + 3_650 * DAY,
    };

    const next = await nextWorker(h, NOW + MINUTE);
    expect(next.securityStorage.state?.proxyCleanupUncertainUntil).toBe(
      NOW + MINUTE + EXPIRED - NOW,
    );

    const later = await nextWorker(next, NOW + DAY);
    expect(later.securityStorage.state?.proxyCleanupUncertain).toBe(false);
    expect(await logoutReport(later)).not.toBe("unconfirmed");
  });
});

describe("what moves the time at which the marker ends", () => {
  it("is a later session which nobody could name either", async () => {
    const first = await incident();
    const h = await nextWorker(first, NOW + 10 * MINUTE);
    h.api.createError = new NetworkError("timeout");
    await h.controller.connect("frankfurt-01");
    h.api.createError = null;
    await h.controller.disconnect();

    expect(h.securityStorage.state?.proxyCleanupUncertainUntil).toBe(EXPIRED + 10 * MINUTE);
    // The first session has expired; the second may still live.
    const between = await nextWorker(h, EXPIRED + MINUTE);
    expect(await logoutReport(between)).toBe("unconfirmed");
    const after = await nextWorker(h, EXPIRED + 10 * MINUTE);
    expect(await logoutReport(after)).toBe("confirmed");
  });

  it("is not a later connection which succeeds, nor its renewals", async () => {
    const h = await nextWorker(await incident(), NOW + MINUTE);
    h.api.sessions = [
      sessionIssuedAt(NOW + MINUTE, "connected"),
      sessionIssuedAt(NOW + 9 * MINUTE, "renewed"),
    ];
    expect(await h.controller.connect("frankfurt-01")).toEqual({ ok: true });
    expect(h.securityStorage.state?.proxyCleanupUncertainUntil).toBe(EXPIRED);

    h.setNow(NOW + 9 * MINUTE);
    await h.controller.handleAlarm("fuzevpn-proxy-refresh");
    await h.controller.startupConnectionSettled();
    expect(h.proxy.active?.id).toBe("renewed");
    expect(h.securityStorage.state).toMatchObject({
      proxyCleanupUncertain: true,
      proxyCleanupUncertainUntil: EXPIRED,
    });

    // Connected without interruption since: the unknown session has expired all the same.
    h.setNow(EXPIRED);
    expect(await logoutReport(h)).toBe("confirmed");
  });
});

describe("a session request which the worker never saw end", () => {
  /** What storage holds while the request is in flight. */
  async function interrupted() {
    const h = createHarness({ persisted: authenticatedState() });
    await h.controller.initialize();
    await h.controller.startupConnectionSettled();
    let release!: () => void;
    h.api.createWait = new Promise<void>((resolve) => {
      release = resolve;
    });
    const connecting = h.controller.connect("frankfurt-01");
    await vi.waitFor(() => expect(h.api.proofs).toHaveLength(1));
    const stored = structuredClone(h.securityStorage.state!);
    release();
    await connecting;
    return { stored, persisted: h.storage.persisted };
  }

  async function workerAfter(at: number) {
    const { stored, persisted } = await interrupted();
    expect(stored).toMatchObject({
      proxyCreationUncertain: true,
      proxyCleanupUncertain: true,
      proxyCleanupUncertainUntil: EXPIRED,
    });
    const h = createHarness({ persisted, security: stored });
    h.setNow(at);
    h.api.sessions = [sessionIssuedAt(at, "after-restart")];
    await h.controller.initialize();
    await h.controller.startupConnectionSettled();
    return h;
  }

  it("is reported by a logout made while its session may live", async () => {
    const h = await workerAfter(EXPIRED - 1);

    expect(h.api.proofs).toHaveLength(0);
    expect(await logoutReport(h)).toBe("unconfirmed");
  });

  it("is no longer reported once its session has expired", async () => {
    const h = await workerAfter(EXPIRED);

    // The connection resumes by itself, and nothing is left to report.
    expect(h.controller.getSnapshot()).toMatchObject({ status: "connected", protected: true });
    expect(h.securityStorage.state?.proxyCleanupUncertain).toBe(false);
    expect(await logoutReport(h)).toBe("confirmed");
  });
});

describe("an unanswered creation whose retries a refusal keeps suspended", () => {
  /** The creation is left unanswered, then a retry is refused for a cause of its own. */
  async function refused() {
    const h = createHarness({ persisted: authenticatedState() });
    await h.controller.initialize();
    h.api.createError = new NetworkError("timeout");
    expect(await h.controller.connect("frankfurt-01")).toMatchObject({
      commandError: "proxy_creation_uncertain",
    });
    h.api.createError = new ApiError("subscription_required", 403);
    await h.controller.retryConnection();
    h.api.createError = null;
    // The marker stands without a deadline: only the user can resolve the refusal.
    expect(h.securityStorage.state).toMatchObject({
      proxyCreationUncertain: true,
      retrySuspended: true,
      suspensionCause: "subscription_required",
    });
    expect(h.securityStorage.state).not.toHaveProperty("proxyCreationUncertainUntil");
    return h;
  }

  it("is reported by a logout while the session it may have left can live", async () => {
    const h = await refused();

    expect(await logoutReport(await nextWorker(h, NOW + MINUTE))).toBe("unconfirmed");
  });

  it("is no longer reported once that session has expired, although retries stay suspended", async () => {
    const h = await refused();
    const later = await nextWorker(h, NOW + DAY);

    // The refusal still suspends the retries: that is another matter.
    expect(later.controller.getSnapshot()).toMatchObject({ protected: false });
    expect(later.api.proofs).toHaveLength(0);
    expect(await logoutReport(later)).toBe("confirmed");
    expect(later.securityStorage.state?.proxyCleanupUncertain).toBe(false);
  });

  it("is no longer reported by the worker which saw it either, a day later", async () => {
    const h = await refused();
    h.setNow(NOW + DAY);

    expect(await logoutReport(h)).toBe("confirmed");
  });
});

describe("a marker stored by an earlier version, without its time", () => {
  const LEGACY: SecurityState = { ...DEFAULT_SECURITY_STATE, proxyCleanupUncertain: true };

  async function upgraded(at: number, stored: SecurityState = LEGACY) {
    const h = createHarness({ persisted: authenticatedState(), security: stored });
    h.setNow(at);
    await h.controller.initialize();
    await h.controller.startupConnectionSettled();
    return h;
  }

  it("is dated by the first worker which reads it, and kept until then", async () => {
    // Set months ago: nothing says when, but its sessions existed before this worker.
    const h = await upgraded(NOW);

    expect(h.securityStorage.state).toMatchObject({
      proxyCleanupUncertain: true,
      proxyCleanupUncertainUntil: EXPIRED,
    });
    expect(await logoutReport(h)).toBe("unconfirmed");
  });

  it("is not dated again by the workers which follow", async () => {
    const first = await upgraded(NOW);
    const second = await upgraded(NOW + 5 * MINUTE, first.securityStorage.state!);

    expect(second.securityStorage.state?.proxyCleanupUncertainUntil).toBe(EXPIRED);
  });

  it("ends once the sessions which existed then have expired", async () => {
    const first = await upgraded(NOW);
    const later = await upgraded(EXPIRED, first.securityStorage.state!);

    expect(later.securityStorage.state?.proxyCleanupUncertain).toBe(false);
    expect(await logoutReport(later)).toBe("confirmed");
  });
});

describe("the stored time at which the cleanup marker ends", () => {
  let local: Record<string, unknown> = {};

  beforeEach(() => {
    local = {};
    vi.stubGlobal("browser", {
      storage: {
        local: {
          get: async (key: string) => ({ [key]: structuredClone(local[key]) }),
          set: async (data: Record<string, unknown>) => {
            Object.assign(local, structuredClone(data));
          },
        },
      },
    });
  });

  afterEach(() => vi.unstubAllGlobals());

  it("is kept with its marker", async () => {
    const storage = new ExtensionSecurityStorage();
    const state: SecurityState = {
      ...DEFAULT_SECURITY_STATE,
      proxyCleanupUncertain: true,
      proxyCleanupUncertainUntil: EXPIRED,
    };
    await storage.write(state);
    await expect(storage.read(false, null)).resolves.toEqual(state);
  });

  it.each([
    ["has no marker", { proxyCleanupUncertain: false, proxyCleanupUncertainUntil: EXPIRED }],
    ["is not a time", { proxyCleanupUncertain: true, proxyCleanupUncertainUntil: "soon" }],
    ["is not positive", { proxyCleanupUncertain: true, proxyCleanupUncertainUntil: 0 }],
    ["is no integer", { proxyCleanupUncertain: true, proxyCleanupUncertainUntil: 1.5 }],
  ])("is dropped when it %s", async (_label, stored) => {
    local[SECURITY_STORAGE_KEY] = { ...DEFAULT_SECURITY_STATE, ...stored };
    const read = await new ExtensionSecurityStorage().read(false, null);
    expect(read).not.toHaveProperty("proxyCleanupUncertainUntil");
    expect(read.proxyCleanupUncertain).toBe(stored.proxyCleanupUncertain);
  });
});
