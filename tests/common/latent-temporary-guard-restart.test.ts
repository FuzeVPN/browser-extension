// SPDX-License-Identifier: MPL-2.0

import { EMPTY_PERSISTED_STATE } from "../../src/core/storage/storage";
import { authenticatedState, createHarness } from "./helpers";

type Harness = ReturnType<typeof createHarness>;

/** A startup whose session store cannot be read, by a user who never asked for protection. */
async function unreadableStartup(signedIn: boolean) {
  const h = createHarness({
    persisted: signedIn ? authenticatedState() : { ...EMPTY_PERSISTED_STATE },
  });
  vi.spyOn(h.storage, "readTransient").mockRejectedValueOnce(
    new Error("storage temporarily unavailable"),
  );
  await h.controller.initialize();

  // Unknown stores are guarded, but that guard is no request for protection.
  expect(h.controller.getSnapshot()).toMatchObject({
    protected: false,
    trafficBlocked: true,
    protectionRequested: false,
    error: "storage_unavailable",
  });
  expect(h.securityStorage.state?.protectionRequested).toBe(false);
  expect(h.safety.status).toMatchObject({ trafficBlocked: true, filterActive: true });
  expect(h.proxy.blockingRoute).toBe(true);
  expect(h.api.proofs).toHaveLength(0);
  return h;
}

/** The worker is killed: a new one finds the same stores and the browser state left behind. */
function restartWorker(h: Harness) {
  const restarted = createHarness({
    persisted: h.storage.persisted,
    transient: h.storage.transient,
    security: h.securityStorage.state ?? undefined,
  });
  restarted.securityStorage.temporaryGuard = h.securityStorage.temporaryGuard;
  restarted.safety.status = structuredClone(h.safety.status);
  restarted.safety.exclusionGuard = structuredClone(h.safety.exclusionGuard);
  restarted.proxy.level = h.proxy.level;
  restarted.proxy.active = h.proxy.active;
  restarted.proxy.blockingRoute = h.proxy.blockingRoute;
  restarted.proxy.activeExclusions = structuredClone(h.proxy.activeExclusions);
  return restarted;
}

function expectReleased(h: Harness, status: "disconnected" | "logged_out") {
  expect(h.controller.getSnapshot()).toMatchObject({
    status,
    protectionRequested: false,
    protected: false,
    trafficBlocked: false,
    error: null,
  });
  expect(h.api.proofs).toHaveLength(0);
  expect(h.securityStorage.state?.protectionRequested).toBe(false);
  expect(h.safety.status).toMatchObject({ trafficBlocked: false, filterActive: false });
  expect(h.proxy.blockingRoute).toBe(false);
  expect(h.proxy.active).toBeNull();
}

afterEach(() => vi.restoreAllMocks());

describe("the temporary guard of a startup whose stores were unreadable", () => {
  it("is armed without waiting for its own record to be stored", async () => {
    const h = createHarness({ persisted: authenticatedState() });
    vi.spyOn(h.storage, "readTransient").mockRejectedValueOnce(
      new Error("storage temporarily unavailable"),
    );
    // The store which records the guard does not answer either.
    vi.spyOn(h.securityStorage, "writeTemporaryGuard").mockReturnValue(new Promise(() => {}));
    await h.controller.initialize();
    expect(h.safety.status).toMatchObject({ trafficBlocked: true, filterActive: true });
    expect(h.controller.getSnapshot()).toMatchObject({
      trafficBlocked: true,
      error: "storage_unavailable",
    });
  });

  it("is released by the same worker once the stores are readable again", async () => {
    const h = await unreadableStartup(true);
    await h.controller.initialize();
    expectReleased(h, "disconnected");
  });

  it.each([
    ["signed-in", true, "disconnected"],
    ["signed-out", false, "logged_out"],
  ] as const)(
    "is released for a %s user when the worker restarts before that recovery",
    async (_label, signedIn, status) => {
      const h = await unreadableStartup(signedIn);

      const restarted = restartWorker(h);
      await restarted.controller.initialize();

      // Nobody asked for protection: the next worker neither connects nor keeps blocking.
      expectReleased(restarted, status);
    },
  );
});
