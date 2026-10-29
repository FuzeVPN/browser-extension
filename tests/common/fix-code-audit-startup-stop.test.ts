// SPDX-License-Identifier: MPL-2.0

import { DEFAULT_SECURITY_STATE } from "../../src/core/shared/security";
import { ProxyControlError } from "../../src/core/background/proxy-controller";
import { authenticatedState, createHarness, proxySession } from "./helpers";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function refusedStartup() {
  const session = proxySession("stop-during-startup-repair");
  const h = createHarness({
    persisted: authenticatedState({ autoConnect: true }),
    security: { ...DEFAULT_SECURITY_STATE, protectionRequested: true },
    transient: { proxySession: session, refreshAttempts: 0, retiredSessions: [] },
    activeProxy: session,
  });
  const permission = vi
    .spyOn(h.proxy, "assertControllable")
    .mockRejectedValue(new ProxyControlError("host_permissions_required"));
  await h.controller.initialize();
  expect(await h.controller.getActiveSession()).toBeNull();
  permission.mockRestore();
  return { ...h, session };
}

describe("CODE02/CODE03: explicit stop dominates startup permission repair", () => {
  afterEach(() => vi.restoreAllMocks());

  it.each(["disconnect", "logout"] as const)(
    "%s reads recovered stores without restoring credentials or allowance",
    async (action) => {
      const h = await refusedStartup();

      expect(await h.controller[action]()).toEqual({ ok: true });

      expect(h.safety.events).not.toContain("allow");
      expect(h.api.proofs).toHaveLength(0);
      expect(await h.controller.getActiveSession()).toBeNull();
      expect(h.controller.isSessionCurrentForProxyAuth(h.session)).toBe(false);
      expect(h.controller.getSnapshot()).toMatchObject({
        status: action === "logout" ? "logged_out" : "disconnected",
        protected: false,
      });
    },
  );

  for (const boundary of ["scheduleSession", "clearReconnect"] as const) {
    it.each(["disconnect", "logout"] as const)(
      `%s blocks repair already waiting at ${boundary}`,
      async (action) => {
        const h = await refusedStartup();
        const waiting = deferred();
        const release = deferred();
        if (boundary === "scheduleSession") {
          const schedule = h.alarms.scheduleSession.bind(h.alarms);
          vi.spyOn(h.alarms, "scheduleSession").mockImplementationOnce(async (...args) => {
            waiting.resolve();
            await release.promise;
            await schedule(...args);
          });
        } else {
          const clear = h.alarms.clearReconnect.bind(h.alarms);
          vi.spyOn(h.alarms, "clearReconnect").mockImplementationOnce(async () => {
            waiting.resolve();
            await release.promise;
            await clear();
          });
        }

        const repair = h.controller.initialize();
        await waiting.promise;
        const stopping = h.controller[action]();
        const exposedAfterStop = await h.controller.getActiveSession();
        const acceptedAfterStop = h.controller.isSessionCurrentForProxyAuth(h.session);
        release.resolve();
        await repair;

        expect(await stopping).toEqual({ ok: true });
        expect(exposedAfterStop).toBeNull();
        expect(acceptedAfterStop).toBe(false);
        expect(h.safety.events).not.toContain("allow");
        expect(h.api.proofs).toHaveLength(0);
        expect(h.controller.getSnapshot()).toMatchObject({
          status: action === "logout" ? "logged_out" : "disconnected",
          protected: false,
        });
        expect(await h.controller.getActiveSession()).toBeNull();
      },
    );
  }
});
