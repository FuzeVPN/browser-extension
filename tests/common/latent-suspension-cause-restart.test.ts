// SPDX-License-Identifier: MPL-2.0

import { ApiError } from "../../src/core/api/client";
import { authenticatedState, createHarness } from "./helpers";

type Harness = ReturnType<typeof createHarness>;

/** A connection which the server refuses, leaving requested protection suspended. */
async function refusedConnection(code: string, status: number) {
  const h = createHarness({ persisted: authenticatedState() });
  await h.controller.initialize();
  h.api.createError = new ApiError(code, status);
  expect(await h.controller.connect("frankfurt-01")).toEqual({ ok: false, commandError: code });

  // Protection stays requested and guarded, with its automatic retries suspended.
  expect(h.controller.getSnapshot()).toMatchObject({
    status: "blocked",
    protected: false,
    trafficBlocked: true,
    error: code,
    nextRetryAt: null,
  });
  expect(h.securityStorage.state).toMatchObject({
    protectionRequested: true,
    retrySuspended: true,
    proxyCreationUncertain: false,
  });
  return h;
}

/** The worker is killed: a new one finds the same stores and the browser state left behind. */
async function restartWorker(h: Harness) {
  const restarted = createHarness({
    persisted: h.storage.persisted,
    transient: h.storage.transient,
    security: h.securityStorage.state ?? undefined,
  });
  restarted.identity.deviceIds = new Map(h.identity.deviceIds);
  restarted.safety.status = structuredClone(h.safety.status);
  restarted.proxy.level = h.proxy.level;
  restarted.proxy.active = h.proxy.active;
  restarted.proxy.blockingRoute = h.proxy.blockingRoute;
  // The server would still refuse, but a suspended protection asks nothing by itself.
  restarted.api.createError = h.api.createError;
  await restarted.controller.initialize();
  expect(restarted.api.proofs).toHaveLength(0);
  expect(restarted.controller.getSnapshot()).toMatchObject({
    status: "blocked",
    protected: false,
    trafficBlocked: true,
    nextRetryAt: null,
  });
  return restarted;
}

describe("the cause of suspended protection after a worker restart", () => {
  it("still reports a full location, whose block is stored", async () => {
    const h = await refusedConnection("server_full", 409);
    expect(h.securityStorage.state?.capacityBlockedLocationId).toBe("frankfurt-01");

    const restarted = await restartWorker(h);
    expect(restarted.controller.getSnapshot().error).toBe("server_full");
  });

  it.each([
    ["subscription_required", 403],
    ["email_verification_required", 403],
    ["device_limit", 409],
  ] as const)("still reports %s, which only the user can resolve", async (code, status) => {
    const h = await refusedConnection(code, status);

    const restarted = await restartWorker(h);
    // The user is still told what to resolve, not that the proxy is unavailable.
    expect(restarted.controller.getSnapshot().error).toBe(code);
  });
});
