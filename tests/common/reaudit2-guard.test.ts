// SPDX-License-Identifier: MPL-2.0

import { ApiError, NetworkError } from "../../src/core/api/client";
import type { ProxySession } from "../../src/core/api/types";
import type { ProxyControlLevel } from "../../src/platform/contracts/proxy";
import { authenticatedState, createHarness } from "./helpers";

type Harness = ReturnType<typeof createHarness>;

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

async function changeControl(h: Harness, level: ProxyControlLevel) {
  h.proxy.level = level;
  await h.controller.handleProxyControlLost(level);
}

/** Leaves a failure that suspended the automatic retries on screen, without a session. */
async function blockedWithoutRetry(
  reason: "subscription_required" | "proxy_authentication_failed",
) {
  const h = createHarness({ persisted: authenticatedState() });
  await h.controller.initialize();
  if (reason === "subscription_required") {
    h.api.createError = new ApiError("subscription_required", 403);
    expect(await h.controller.connect("frankfurt-01")).toMatchObject({ ok: false });
  } else {
    expect(await h.controller.connect("frankfurt-01")).toEqual({ ok: true });
    await h.controller.handleProxyAuthenticationFailure(h.proxy.active!);
  }
  expect(await h.controller.getActiveSession()).toBeNull();
  expectBlockedBy(h, reason);
  return h;
}

function expectBlockedBy(h: Harness, reason: string | null) {
  expect(h.controller.getSnapshot()).toMatchObject({
    status: "blocked",
    protected: false,
    trafficBlocked: true,
    blockingScope: "all",
    error: reason,
    nextRetryAt: null,
  });
  expect(h.alarms.reconnectAt).toBeNull();
  expect(h.securityStorage.state).toMatchObject({ nextRetryAt: null, retrySuspended: true });
}

describe("guard route takeover over a block without automatic retries", () => {
  for (const reason of ["subscription_required", "proxy_authentication_failed"] as const) {
    for (const release of ["resumes our route", "lets us restore the route"] as const) {
      it(`shows the ${reason} block again once the release ${release}`, async () => {
        const h = await blockedWithoutRetry(reason);
        await changeControl(h, "controlled_by_other_extensions");
        expect(h.controller.getSnapshot()).toMatchObject({
          status: "error",
          protected: false,
          trafficBlocked: false,
          error: "proxy_controlled_by_extension",
        });

        if (release === "lets us restore the route") h.proxy.blockingRoute = false;
        await changeControl(
          h,
          release === "resumes our route"
            ? "controlled_by_this_extension"
            : "controllable_by_this_extension",
        );
        expect(await h.proxy.isGuardedConfiguration()).toBe(true);
        expectBlockedBy(h, reason);
      });
    }
  }

  it("keeps the reason through repeated takeovers, until a failure replaces it", async () => {
    const h = await blockedWithoutRetry("subscription_required");
    await changeControl(h, "controlled_by_other_extensions");
    await changeControl(h, "controlled_by_this_extension");
    expectBlockedBy(h, "subscription_required");

    // A takeover handed over to a policy still displaced the same reason.
    await changeControl(h, "controlled_by_other_extensions");
    await changeControl(h, "not_controllable");
    expect(h.controller.getSnapshot()).toMatchObject({
      status: "error",
      trafficBlocked: false,
      error: "proxy_controlled_by_policy",
    });
    await changeControl(h, "controlled_by_this_extension");
    expectBlockedBy(h, "subscription_required");
    // Our own setting changes leave it in place.
    await h.controller.handleProxyControlLost("controlled_by_this_extension");
    expectBlockedBy(h, "subscription_required");

    // A retry refused by the takeover is the latest failure: its control error does not
    // explain the block once the takeover ends, and the older reason is not restored.
    await changeControl(h, "controlled_by_other_extensions");
    expect(await h.controller.retryConnection(false)).toMatchObject({
      ok: false,
      commandError: "proxy_controlled_by_extension",
    });
    await changeControl(h, "controlled_by_this_extension");
    expectBlockedBy(h, null);
  });
});

describe("guard route takeover during a connection attempt", () => {
  /** Holds the attempt's proxy-session request open, after its blocking guard is in place. */
  async function pendingConnection(refused: "nothing" | "device_limit") {
    const h = createHarness({ persisted: authenticatedState() });
    await h.controller.initialize();
    if (refused === "device_limit") {
      h.api.createError = new ApiError("device_limit", 409);
      expect(await h.controller.connect("frankfurt-01")).toMatchObject({ ok: false });
      expect(h.controller.getSnapshot()).toMatchObject({
        status: "blocked",
        error: "device_limit",
      });
      h.api.createError = null;
    }
    const response = deferred();
    h.api.createWait = response.promise;
    const connecting = h.controller.connect("frankfurt-01");
    await vi.waitFor(() => expect(h.api.proofs).toHaveLength(refused === "nothing" ? 1 : 2));
    expect(h.controller.getSnapshot()).toMatchObject({
      status: "connecting",
      trafficBlocked: true,
      error: null,
    });
    return { h, response, connecting, from: h.snapshots.length };
  }

  it.each(["nothing", "device_limit"] as const)(
    "keeps the attempt's status through a takeover and its release (earlier refusal: %s)",
    async (refused) => {
      const { h, response, connecting, from } = await pendingConnection(refused);
      await changeControl(h, "controlled_by_other_extensions");
      expect(h.controller.getSnapshot()).toMatchObject({
        status: "connecting",
        protected: false,
        trafficBlocked: false,
        error: "proxy_controlled_by_extension",
      });
      await changeControl(h, "not_controllable");
      expect(h.controller.getSnapshot()).toMatchObject({
        status: "connecting",
        error: "proxy_controlled_by_policy",
      });

      await changeControl(h, "controlled_by_this_extension");
      expect(h.controller.getSnapshot()).toMatchObject({
        status: "connecting",
        protected: false,
        trafficBlocked: true,
        blockingScope: "all",
        error: null,
      });

      response.resolve();
      expect(await connecting).toEqual({ ok: true });
      expect(h.controller.getSnapshot()).toMatchObject({
        status: "connected",
        protected: true,
        error: null,
      });
      expect(new Set(h.snapshots.slice(from).map((snapshot) => snapshot.status))).toEqual(
        new Set(["connecting", "connected"]),
      );
    },
  );

  it("leaves the verdict to the attempt while the takeover holds", async () => {
    const { h, response, connecting, from } = await pendingConnection("nothing");
    await changeControl(h, "controlled_by_other_extensions");
    expect(h.controller.getSnapshot()).toMatchObject({
      status: "connecting",
      error: "proxy_controlled_by_extension",
    });

    response.resolve();
    expect(await connecting).toMatchObject({
      ok: false,
      commandError: "proxy_controlled_by_extension",
    });
    expect(h.controller.getSnapshot()).toMatchObject({
      status: "error",
      protected: false,
      error: "proxy_controlled_by_extension",
    });
    expect(h.securityStorage.state).toMatchObject({ nextRetryAt: null, retrySuspended: true });
    // Only the attempt's own failure replaced its status.
    const statuses = h.snapshots.slice(from).map((snapshot) => snapshot.status);
    expect(statuses.at(-1)).toBe("error");
    expect(new Set(statuses.slice(0, -1))).toEqual(new Set(["connecting"]));
    expect(h.safety.events).not.toContain("allow");
  });
});

describe("guard route takeover over a capacity block recorded meanwhile", () => {
  afterEach(() => vi.restoreAllMocks());

  it.each([false, true])(
    "reports the block of a full location once our route is effective (takeover: %s)",
    async (takeover) => {
      // connect(F1) with its POST held, superseded by a settings command; a failed account
      // read is then displayed, which suspends no automatic retry.
      const h = createHarness({ persisted: authenticatedState() });
      h.identity.deviceId = "browser-device-1";
      await h.controller.initialize();
      await h.controller.refreshAccount();
      const response = deferred<ProxySession>();
      const create = vi.spyOn(h.api, "createProxySession").mockReturnValueOnce(response.promise);
      const connecting = h.controller.connect("frankfurt-01");
      await vi.waitFor(() => expect(create).toHaveBeenCalledOnce());
      expect(await h.controller.updateSecurityPreferences(true, false)).toEqual({ ok: true });
      vi.spyOn(h.api, "getProfile").mockRejectedValueOnce(new NetworkError("invalid_response"));
      expect(await h.controller.refreshAccount()).toMatchObject({
        ok: false,
        commandError: "invalid_response",
      });
      if (takeover) await changeControl(h, "controlled_by_other_extensions");

      // The discarded POST is refused for the location still selected: that refusal
      // blocks it, and while the takeover holds, the takeover keeps explaining the state.
      response.reject(new ApiError("server_full", 409));
      expect(await connecting).toMatchObject({ ok: false });
      await vi.waitFor(() =>
        expect(h.controller.getSnapshot().locations.map(({ id }) => id)).not.toContain(
          "frankfurt-01",
        ),
      );
      expect(h.securityStorage.state).toMatchObject({
        capacityBlockedLocationId: "frankfurt-01",
        retrySuspended: true,
        nextRetryAt: null,
      });
      if (takeover) {
        expect(h.controller.getSnapshot()).toMatchObject({
          status: "error",
          error: "proxy_controlled_by_extension",
        });
        await changeControl(h, "controlled_by_this_extension");
      }

      // The full location, not the older account read, explains the block.
      expect(h.controller.getSnapshot()).toMatchObject({
        status: "blocked",
        protected: false,
        trafficBlocked: true,
        error: "server_full",
      });
      expect(h.safety.events).not.toContain("allow");
    },
  );
});
