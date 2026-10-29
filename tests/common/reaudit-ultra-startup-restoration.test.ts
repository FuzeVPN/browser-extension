// SPDX-License-Identifier: MPL-2.0

import { ProxyControlError } from "../../src/core/background/proxy-controller";
import { DEFAULT_SECURITY_STATE } from "../../src/core/shared/security";
import { authenticatedState, createHarness, NOW, proxySession } from "./helpers";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function fixture(killSwitchEnabled = true, configured = true) {
  const session = proxySession(
    "ultra-startup-restore",
    "frankfurt-01",
    new Date(NOW - 540_000).toISOString(),
  );
  const transient = {
    proxySession: session,
    refreshAttempts: 2,
    refreshRetryAt: NOW + 45_000,
    retiredSessions: [{ sessionId: "ultra-startup-retired", expiresAt: session.expiresAt }],
  };
  const h = createHarness({
    persisted: authenticatedState({ autoConnect: true }),
    security: { ...DEFAULT_SECURITY_STATE, protectionRequested: true, killSwitchEnabled },
    transient,
    ...(configured ? { activeProxy: session } : {}),
  });
  return { ...h, session, transient };
}

type Fixture = ReturnType<typeof fixture>;
type LateLevel = "controlled_by_other_extensions" | "not_controllable";

/** Records each session the controller authorizes from now on. */
function recordAuthorizations(h: Fixture): string[] {
  const controller = h.controller as unknown as { authorizedSessionId: string | null };
  let current = controller.authorizedSessionId;
  const authorized: string[] = [];
  Object.defineProperty(controller, "authorizedSessionId", {
    configurable: true,
    get: () => current,
    set: (id: string | null) => {
      current = id;
      if (id !== null) authorized.push(id);
    },
  });
  return authorized;
}

/** Holds the restoration's final identity read, which follows the traffic allowance. */
function holdFinalIdentityRead(h: Fixture) {
  const reached = deferred();
  const release = deferred();
  let held = false;
  const getDeviceId = h.identity.getDeviceId.bind(h.identity);
  vi.spyOn(h.identity, "getDeviceId").mockImplementation(async (userId) => {
    if (!held && h.safety.events.includes("allow")) {
      held = true;
      reached.resolve();
      await release.promise;
    }
    return getDeviceId(userId);
  });
  return { reached: reached.promise, release: release.resolve };
}

/** Hands proxy control to another owner once the given startup step resolves. */
function loseControlAfter(
  h: Fixture,
  boundary: "readTransient" | "getRecovery" | "scheduleSession",
  level: LateLevel,
) {
  const lose = <T>(value: T): T => {
    h.proxy.level = level;
    return value;
  };
  if (boundary === "readTransient") {
    const read = h.storage.readTransient.bind(h.storage);
    vi.spyOn(h.storage, "readTransient").mockImplementationOnce(async () => lose(await read()));
  } else if (boundary === "getRecovery") {
    const getRecovery = h.identity.getRecovery.bind(h.identity);
    vi.spyOn(h.identity, "getRecovery").mockImplementationOnce(async (userId) =>
      lose(await getRecovery(userId)),
    );
  } else {
    const schedule = h.alarms.scheduleSession.bind(h.alarms);
    vi.spyOn(h.alarms, "scheduleSession").mockImplementationOnce(async (...args) =>
      lose(await schedule(...args)),
    );
  }
}

/**
 * Hands proxy control to another owner at a restoration step whose next check
 * only sees the restored configuration become inactive, not the refusal itself.
 */
function loseControlUnseen(
  h: Fixture,
  boundary: "authorization check" | "traffic allowance" | "proxy write",
  level: LateLevel,
) {
  if (boundary === "proxy write") {
    const apply = h.proxy.apply.bind(h.proxy);
    // Like the native adapters, the write's own verification then rejects it.
    vi.spyOn(h.proxy, "apply").mockImplementationOnce(async (session) => {
      await apply(session);
      h.proxy.level = level;
      throw new ProxyControlError("configuration_rejected");
    });
  } else if (boundary === "traffic allowance") {
    const allow = h.safety.allow.bind(h.safety);
    vi.spyOn(h.safety, "allow").mockImplementationOnce(async () => {
      await allow();
      h.proxy.level = level;
    });
  } else {
    // The authorization's first control check is the first one after scheduling.
    let scheduled = false;
    const schedule = h.alarms.scheduleSession.bind(h.alarms);
    vi.spyOn(h.alarms, "scheduleSession").mockImplementationOnce(async (...args) => {
      await schedule(...args);
      scheduled = true;
    });
    const assertControllable = h.proxy.assertControllable.bind(h.proxy);
    vi.spyOn(h.proxy, "assertControllable").mockImplementation(async () => {
      await assertControllable();
      if (!scheduled) return;
      scheduled = false;
      h.proxy.level = level;
    });
  }
}

/** Holds the restoration's device recovery completion. */
function holdRecoveryCompletion(h: Fixture) {
  const reached = deferred();
  const release = deferred();
  h.identity.deviceId = "browser-device-1";
  const completeRecovery = h.identity.completeRecovery.bind(h.identity);
  vi.spyOn(h.identity, "completeRecovery").mockImplementationOnce(async (...args) => {
    reached.resolve();
    await release.promise;
    await completeRecovery(...args);
  });
  return { reached: reached.promise, release: release.resolve };
}

describe("reaudit ultra: startup restoration boundaries", () => {
  afterEach(() => vi.restoreAllMocks());

  const lateLevels = [
    ["controlled_by_other_extensions", "proxy_controlled_by_extension"],
    ["not_controllable", "proxy_controlled_by_policy"],
  ] as const;
  // Each boundary follows the successful initial guard. The first two precede the
  // restored configuration check, which the lost control already makes fail.
  const lateBoundaries = ["readTransient", "getRecovery", "scheduleSession"] as const;
  for (const [level, error] of lateLevels) {
    for (const boundary of lateBoundaries) {
      it.each([true, false])(
        `preserves the saved session when ${level} appears at ${boundary}, kill switch %s`,
        async (kill) => {
          const h = fixture(kill);
          loseControlAfter(h, boundary, level);

          await h.controller.initialize();

          expect(h.storage.transient).toEqual(h.transient);
          expect(h.controller.getSnapshot()).toMatchObject({
            protected: false,
            status: "error",
            error,
          });
          expect(h.safety.events).not.toContain("allow");
          expect(await h.controller.getActiveSession()).toBeNull();
          expect(h.controller.isSessionCurrentForProxyAuth(h.session)).toBe(false);

          // Restored control resumes the same session and renewal budget.
          h.proxy.level = "controlled_by_this_extension";
          await h.controller.initialize();
          expect(h.controller.getSnapshot().protected).toBe(true);
          expect(await h.controller.getActiveSession()).toEqual(h.session);
          expect(h.storage.transient).toEqual(h.transient);
          expect(h.alarms.retryAt).toBe(h.transient.refreshRetryAt);
          expect(h.api.proofs).toHaveLength(0);
        },
      );
    }
  }

  // The restoration first sees these losses as an unavailable configuration.
  const unseenBoundaries = ["authorization check", "traffic allowance", "proxy write"] as const;
  for (const [level, error] of lateLevels) {
    for (const boundary of unseenBoundaries) {
      it.each([true, false])(
        `preserves the saved session when ${level} unconfigures it at the ${boundary}, kill switch %s`,
        async (kill) => {
          const h = fixture(kill, boundary !== "proxy write");
          // A guarded restoration writes its saved proxy again.
          if (boundary === "proxy write") await h.proxy.ensureBlockingConfiguration();
          loseControlUnseen(h, boundary, level);

          await h.controller.initialize();

          expect(h.storage.transient).toEqual(h.transient);
          expect(h.controller.getSnapshot()).toMatchObject({
            protected: false,
            status: "error",
            error,
          });
          expect(h.snapshots.filter((snapshot) => snapshot.protected)).toEqual([]);
          expect(h.securityStorage.state?.retrySuspended).toBe(false);
          expect(await h.controller.getActiveSession()).toBeNull();
          expect(h.controller.isSessionCurrentForProxyAuth(h.session)).toBe(false);

          h.proxy.level = "controlled_by_this_extension";
          await h.controller.initialize();
          expect(h.controller.getSnapshot()).toMatchObject({ protected: true, error: null });
          expect(await h.controller.getActiveSession()).toEqual(h.session);
          expect(h.storage.transient).toEqual(h.transient);
          expect(h.alarms.retryAt).toBe(h.transient.refreshRetryAt);
          expect(h.api.proofs).toHaveLength(0);
        },
      );
    }
  }

  it("a TLS refusal during the restoration still discards the session when control is lost too", async () => {
    const h = fixture(false);
    let refusing: Promise<void> | undefined;
    const schedule = h.alarms.scheduleSession.bind(h.alarms);
    vi.spyOn(h.alarms, "scheduleSession").mockImplementationOnce(async (...args) => {
      await schedule(...args);
      // Delivered while the restored session is installed, before its authorization.
      refusing = h.controller.handleProxyError("proxy_tls_error", false, {
        host: h.session.host,
        port: h.session.port,
      });
      h.proxy.level = "controlled_by_other_extensions";
    });

    await h.controller.initialize();
    await refusing;

    expect(refusing).toBeDefined();
    expect(h.storage.transient.proxySession).toBeNull();
    expect(h.snapshots.filter((snapshot) => snapshot.protected)).toEqual([]);
    expect(await h.controller.getActiveSession()).toBeNull();
  });

  it.each([true, false])(
    "a stored endpoint failing TLS before its restoration installs it is discarded despite lost control, kill switch %s",
    async (kill) => {
      const h = fixture(kill, false);
      // A guarded restoration writes its saved proxy again.
      await h.proxy.ensureBlockingConfiguration();
      let refusing: Promise<void> | undefined;
      let transientRead = false;
      const read = h.storage.readTransient.bind(h.storage);
      vi.spyOn(h.storage, "readTransient").mockImplementationOnce(async () => {
        transientRead = true;
        return read();
      });
      const isGuardedConfiguration = h.proxy.isGuardedConfiguration.bind(h.proxy);
      vi.spyOn(h.proxy, "isGuardedConfiguration").mockImplementation(async () => {
        if (transientRead && !refusing)
          // No session is active yet: only the startup failure records the refusal.
          refusing = h.controller.handleProxyError("proxy_tls_error", false, {
            host: h.session.host,
            port: h.session.port,
          });
        return isGuardedConfiguration();
      });
      loseControlAfter(h, "scheduleSession", "controlled_by_other_extensions");

      await h.controller.initialize();
      await refusing;

      expect(refusing).toBeDefined();
      expect(h.storage.transient.proxySession).toBeNull();
      expect(h.snapshots.filter((snapshot) => snapshot.protected)).toEqual([]);
      expect(h.safety.events).not.toContain("allow");
      expect(await h.controller.getActiveSession()).toBeNull();
    },
  );

  // Control lost there unconfigures the stored session before any restoration.
  for (const [level, error] of lateLevels) {
    for (const boundary of ["readTransient", "getRecovery"] as const) {
      it.each([true, false])(
        `a stored endpoint failing TLS during startup is never authorized once ${level} appearing at ${boundary} is repaired, kill switch %s`,
        async (kill) => {
          const h = fixture(kill);
          loseControlAfter(h, boundary, level);
          const initializing = h.controller.initialize();
          // Delivered during startup, for the stored endpoint its traffic used.
          const refusing = h.controller.handleProxyError("proxy_tls_error", false, {
            host: h.session.host,
            port: h.session.port,
          });
          await initializing;
          await refusing;

          // The control refusal stays repairable and keeps the endpoint's failure.
          expect(h.storage.transient).toEqual(h.transient);
          expect(h.controller.getSnapshot()).toMatchObject({ protected: false, error });
          expect(await h.controller.getActiveSession()).toBeNull();
          expect(h.controller.isSessionCurrentForProxyAuth(h.session)).toBe(false);

          // The startup that repairs control consumes that failure.
          h.proxy.level = "controlled_by_this_extension";
          await h.controller.initialize();
          expect(h.snapshots.filter((snapshot) => snapshot.protected)).toEqual([]);
          expect(h.safety.events).not.toContain("allow");
          expect(h.controller.getSnapshot()).toMatchObject({
            protected: false,
            error: "proxy_unavailable",
          });
          expect(await h.controller.getActiveSession()).toBeNull();
          expect(h.storage.transient.proxySession).toBeNull();
        },
      );
    }
  }

  it("a restoration unconfigured by lost control lends no credentials while its failure is classified", async () => {
    // Without the kill switch, only that classification checks control after the loss.
    const h = fixture(false);
    loseControlUnseen(h, "traffic allowance", "controlled_by_other_extensions");
    let unconfigured = false;
    const isActiveConfiguration = h.proxy.isActiveConfiguration.bind(h.proxy);
    vi.spyOn(h.proxy, "isActiveConfiguration").mockImplementation(async (session) => {
      const active = await isActiveConfiguration(session);
      if (!active && h.safety.events.includes("allow")) unconfigured = true;
      return active;
    });
    const lent: string[] = [];
    let checks = 0;
    const assertControllable = h.proxy.assertControllable.bind(h.proxy);
    vi.spyOn(h.proxy, "assertControllable").mockImplementation(async () => {
      if (unconfigured) {
        checks += 1;
        if (h.controller.isSessionCurrentForProxyAuth(h.session)) lent.push("proxy auth");
        if (await h.controller.getActiveSession()) lent.push("active session");
      }
      return assertControllable();
    });

    await h.controller.initialize();

    expect(h.controller.getSnapshot().error).toBe("proxy_controlled_by_extension");
    expect(checks).toBeGreaterThan(0);
    expect(lent).toEqual([]);
    expect(h.storage.transient).toEqual(h.transient);
  });

  it.each([true, false])(
    "a control loss reported only after the final checks never confirms the restoration, kill switch %s",
    async (kill) => {
      const h = fixture(kill);
      const hold = holdFinalIdentityRead(h);
      const initializing = h.controller.initialize();
      await hold.reached;
      const beforeLoss = h.snapshots.length;
      h.proxy.level = "controlled_by_other_extensions";
      hold.release();
      // The worker reads the control level before calling the controller, so the
      // settings event may reach it only after the restoration's final awaits.
      await initializing;
      await h.controller.handleProxyControlLost(await h.proxy.getControlLevel());

      expect(h.snapshots.slice(beforeLoss).filter((snapshot) => snapshot.protected)).toEqual([]);
      expect(h.storage.transient).toEqual(h.transient);
      expect(h.controller.getSnapshot()).toMatchObject({
        protected: false,
        error: "proxy_controlled_by_extension",
      });
      expect(await h.controller.getActiveSession()).toBeNull();

      // The event reporting returned control repairs the preserved restoration.
      h.proxy.level = "controlled_by_this_extension";
      await h.controller.handleProxyControlLost(await h.proxy.getControlLevel());
      expect(h.controller.getSnapshot()).toMatchObject({ protected: true, error: null });
      expect(await h.controller.getActiveSession()).toEqual(h.session);
      expect(h.storage.transient).toEqual(h.transient);
    },
  );

  it.each([true, false])(
    "a permission event arriving during the final control check forces another check, kill switch %s",
    async (kill) => {
      const h = fixture(kill);
      const reached = deferred();
      const release = deferred();
      let held = false;
      let denied = false;
      const assertControllable = h.proxy.assertControllable.bind(h.proxy);
      vi.spyOn(h.proxy, "assertControllable").mockImplementation(async () => {
        if (denied) throw new ProxyControlError("host_permissions_required");
        await assertControllable();
        // The first check after the allowance is the final one; it already succeeded.
        if (!held && h.safety.events.includes("allow")) {
          held = true;
          reached.resolve();
          await release.promise;
        }
      });
      const initializing = h.controller.initialize();
      await reached.promise;
      const beforeLoss = h.snapshots.length;
      denied = true;
      const event = h.controller.handleProxyPermissionsChanged();
      release.resolve();
      await initializing;
      await event;

      expect(h.snapshots.slice(beforeLoss).filter((snapshot) => snapshot.protected)).toEqual([]);
      expect(h.storage.transient).toEqual(h.transient);
      expect(h.controller.getSnapshot()).toMatchObject({
        protected: false,
        error: "host_permissions_required",
      });
      expect(await h.controller.getActiveSession()).toBeNull();
    },
  );

  for (const action of ["disconnect", "logout"] as const) {
    it.each([true, false])(
      `${action} arriving as the authorization resolves neither publishes protection nor keeps the allowance, kill switch %s`,
      async (kill) => {
        const h = fixture(kill);
        const controller = h.controller as unknown as { authorizedSessionId: string | null };
        let stopping: Promise<unknown> | undefined;
        let beforeStop = 0;
        // Lands the stop between the authorization's last check and the publication
        // of the restored state that awaits it.
        const stopOnceAuthorized = (remaining: number): void => {
          if (controller.authorizedSessionId === h.session.id) {
            beforeStop = h.snapshots.length;
            stopping = h.controller[action]();
          } else if (remaining > 0) queueMicrotask(() => stopOnceAuthorized(remaining - 1));
        };
        const allow = h.safety.allow.bind(h.safety);
        vi.spyOn(h.safety, "allow").mockImplementationOnce(async () => {
          await allow();
          stopOnceAuthorized(1_000);
        });
        const initializing = h.controller.initialize();
        // Registered before the stop awaits startup, so it observes the guard first.
        let settledBlocked: boolean | undefined;
        let settledSinceAllowance: string[] = [];
        const settled = initializing.then(() => {
          settledBlocked = h.safety.status.trafficBlocked;
          settledSinceAllowance = h.safety.events.slice(h.safety.events.lastIndexOf("allow"));
        });
        await settled;

        expect(stopping).toBeDefined();
        expect(settledSinceAllowance).toContain("block");
        expect(settledBlocked).toBe(kill);
        expect(await stopping).toEqual({ ok: true });
        expect(h.snapshots.slice(beforeStop).filter((snapshot) => snapshot.protected)).toEqual([]);
        expect(await h.controller.getActiveSession()).toBeNull();
        expect(h.storage.transient.proxySession).toBeNull();
        expect(h.controller.getSnapshot().protectionRequested).toBe(false);
      },
    );
  }

  it.each([true, false])(
    "a host revocation event during the final identity read neither publishes protection nor destroys the session, kill switch %s",
    async (kill) => {
      const h = fixture(kill);
      const hold = holdFinalIdentityRead(h);
      let denied = false;
      const assertControllable = h.proxy.assertControllable.bind(h.proxy);
      vi.spyOn(h.proxy, "assertControllable").mockImplementation(async () => {
        if (denied) throw new ProxyControlError("host_permissions_required");
        await assertControllable();
      });
      const initializing = h.controller.initialize();
      await hold.reached;
      const beforeLoss = h.snapshots.length;
      denied = true;
      const event = h.controller.handleProxyPermissionsChanged();
      hold.release();
      await initializing;
      await event;

      expect(h.snapshots.slice(beforeLoss).filter((snapshot) => snapshot.protected)).toEqual([]);
      expect(h.storage.transient).toEqual(h.transient);
      expect(h.controller.getSnapshot()).toMatchObject({
        protected: false,
        error: "host_permissions_required",
      });
      expect(await h.controller.getActiveSession()).toBeNull();

      // The permission grant event repairs the preserved restoration.
      denied = false;
      await h.controller.handleProxyPermissionsChanged();
      expect(h.controller.getSnapshot()).toMatchObject({ protected: true, error: null });
      expect(await h.controller.getActiveSession()).toEqual(h.session);
      expect(h.storage.transient).toEqual(h.transient);
    },
  );

  it("a permission event that keeps control does not prevent the restoration", async () => {
    const h = fixture();
    const hold = holdFinalIdentityRead(h);
    const initializing = h.controller.initialize();
    await hold.reached;
    const event = h.controller.handleProxyPermissionsChanged();
    hold.release();
    await initializing;
    await event;

    expect(h.controller.getSnapshot()).toMatchObject({ protected: true, error: null });
    expect(await h.controller.getActiveSession()).toEqual(h.session);
    expect(h.storage.transient).toEqual(h.transient);
  });

  const boundaries = [
    ["final identity read", holdFinalIdentityRead],
    ["recovery completion", holdRecoveryCompletion],
  ] as const;
  for (const action of ["disconnect", "logout"] as const) {
    for (const [boundary, hold] of boundaries) {
      it.each([true, false])(
        `${action} during the ${boundary} cannot authorize or publish a restored protected state, kill switch %s`,
        async (kill) => {
          const h = fixture(kill);
          const held = hold(h);
          const initializing = h.controller.initialize();
          await held.reached;
          const beforeStop = h.snapshots.length;
          const stopping = h.controller[action]();
          // The authorization itself refuses the stopped restoration, not only its publication.
          const authorized = recordAuthorizations(h);
          expect(await h.controller.getActiveSession()).toBeNull();
          expect(h.controller.isSessionCurrentForProxyAuth(h.session)).toBe(false);
          held.release();
          await initializing;

          expect(await stopping).toEqual({ ok: true });
          expect(authorized).toEqual([]);
          expect(h.snapshots.slice(beforeStop).filter((snapshot) => snapshot.protected)).toEqual(
            [],
          );
          expect(await h.controller.getActiveSession()).toBeNull();
          expect(h.storage.transient.proxySession).toBeNull();
          expect(h.controller.getSnapshot().protectionRequested).toBe(false);
        },
      );
    }
  }
});
