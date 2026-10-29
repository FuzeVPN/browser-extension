// SPDX-License-Identifier: MPL-2.0

import { DEFAULT_SECURITY_STATE } from "../../src/core/shared/security";
import { authenticatedState, createHarness, NOW, proxySession } from "./helpers";

/** A guarded restoration: our blocking route is effective, the saved proxy is not. */
async function fixture(killSwitchEnabled: boolean) {
  const session = proxySession(
    "reaudit2-startup-restore",
    "frankfurt-01",
    new Date(NOW - 540_000).toISOString(),
  );
  const transient = {
    proxySession: session,
    refreshAttempts: 2,
    refreshRetryAt: NOW + 45_000,
    retiredSessions: [],
  };
  const h = createHarness({
    persisted: authenticatedState({ autoConnect: true }),
    security: { ...DEFAULT_SECURITY_STATE, protectionRequested: true, killSwitchEnabled },
    transient,
  });
  await h.proxy.ensureBlockingConfiguration();
  return { ...h, session, transient };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;
type LateLevel = "controlled_by_other_extensions" | "not_controllable";

/**
 * Hands proxy control to another owner as the restoration's guarded route test
 * reads the settings, after the early control check succeeded. Returns the trace
 * of control checks and of that loss, and the settings event reporting it if any.
 * When requested, the saved endpoint also fails TLS with that loss, during the
 * control check following it, or while the repair keeps the session, after startup
 * consumed or dropped its earlier failures.
 */
function loseControlAtGuardedTest(
  h: Fixture,
  level: LateLevel,
  reportEvent: boolean,
  tlsFailure?: "with the loss" | "at the next check" | "while the repair keeps it",
) {
  const trace: string[] = [];
  const reports: Promise<void>[] = [];
  const failTls = () =>
    reports.push(
      h.controller.handleProxyError("proxy_tls_error", false, {
        host: h.session.host,
        port: h.session.port,
      }),
    );
  let transientRead = false;
  const read = h.storage.readTransient.bind(h.storage);
  vi.spyOn(h.storage, "readTransient").mockImplementationOnce(async () => {
    const transient = await read();
    transientRead = true;
    return transient;
  });
  const assertControllable = h.proxy.assertControllable.bind(h.proxy);
  vi.spyOn(h.proxy, "assertControllable").mockImplementation(async () => {
    if (transientRead) {
      trace.push(`check:${h.proxy.level}`);
      if (tlsFailure === "at the next check" && trace.at(-2) === "loss") failTls();
    }
    return assertControllable();
  });
  const isGuardedConfiguration = h.proxy.isGuardedConfiguration.bind(h.proxy);
  vi.spyOn(h.proxy, "isGuardedConfiguration").mockImplementation(async () => {
    if (transientRead && !trace.includes("loss")) {
      trace.push("loss");
      h.proxy.level = level;
      if (tlsFailure === "with the loss") failTls();
      // The worker reads the control level before reporting the settings change.
      if (reportEvent)
        reports.push(
          h.proxy.getControlLevel().then((current) => h.controller.handleProxyControlLost(current)),
        );
    }
    return isGuardedConfiguration();
  });
  // The repair clause first suspends the guards, once the control check refused the loss.
  const suspend = h.safety.suspend.bind(h.safety);
  vi.spyOn(h.safety, "suspend").mockImplementation(async () => {
    if (tlsFailure === "while the repair keeps it" && trace.at(-1) === `check:${level}`) {
      trace.push("repair");
      failTls();
    }
    return suspend();
  });
  return { trace, reports };
}

describe("reaudit 2: startup restoration control loss at the guarded route test", () => {
  afterEach(() => vi.restoreAllMocks());

  const lateLevels = [
    ["controlled_by_other_extensions", "proxy_controlled_by_extension"],
    ["not_controllable", "proxy_controlled_by_policy"],
  ] as const;
  for (const [level, error] of lateLevels) {
    for (const reportEvent of [false, true]) {
      it.each([true, false])(
        `preserves the saved session when ${level} appears during that test${
          reportEvent ? ", reported by the settings event" : ""
        }, kill switch %s`,
        async (kill) => {
          const h = await fixture(kill);
          const loss = loseControlAtGuardedTest(h, level, reportEvent);

          await h.controller.initialize();
          await Promise.all(loss.reports);

          // The early control check passed: only the guarded route test saw the loss.
          expect(loss.trace.slice(0, 2)).toEqual(["check:controlled_by_this_extension", "loss"]);
          expect(h.storage.transient).toEqual(h.transient);
          expect(h.controller.getSnapshot()).toMatchObject({
            protected: false,
            status: "error",
            error,
          });
          expect(h.snapshots.filter((snapshot) => snapshot.protected)).toEqual([]);
          expect(h.safety.events).not.toContain("allow");
          expect(await h.controller.getActiveSession()).toBeNull();
          expect(h.controller.isSessionCurrentForProxyAuth(h.session)).toBe(false);
          expect(h.api.proofs).toHaveLength(0);

          // The event reporting returned control resumes the same session and budget.
          h.proxy.level = "controlled_by_this_extension";
          await h.controller.handleProxyControlLost(await h.proxy.getControlLevel());
          expect(h.controller.getSnapshot()).toMatchObject({ protected: true, error: null });
          expect(await h.controller.getActiveSession()).toEqual(h.session);
          expect(h.storage.transient).toEqual(h.transient);
          expect(h.alarms.retryAt).toBe(h.transient.refreshRetryAt);
          expect(h.api.proofs).toHaveLength(0);
        },
      );
    }
  }

  // These failures follow the point where startup consumes or drops its earlier ones, and a
  // guarded restoration refuses them at its authorization. The loss either discards the
  // session or keeps it with the failure, which the repairing startup then consumes.
  for (const [level, error] of lateLevels) {
    for (const tlsFailure of [
      "with the loss",
      "at the next check",
      "while the repair keeps it",
    ] as const) {
      it.each([true, false])(
        `discards the saved session when its endpoint fails TLS ${tlsFailure}, despite ${level}, kill switch %s`,
        async (kill) => {
          const h = await fixture(kill);
          const loss = loseControlAtGuardedTest(h, level, false, tlsFailure);

          await h.controller.initialize();
          await Promise.all(loss.reports);

          expect(loss.trace.slice(0, 3)).toEqual([
            "check:controlled_by_this_extension",
            "loss",
            `check:${level}`,
          ]);
          expect(loss.reports).toHaveLength(1);
          // A failure arriving once the session is kept for repair stays with it.
          if (tlsFailure === "while the repair keeps it")
            expect(h.storage.transient).toEqual(h.transient);
          else expect(h.storage.transient.proxySession).toBeNull();
          expect(h.controller.getSnapshot()).toMatchObject({ protected: false, error });
          expect(await h.controller.getActiveSession()).toBeNull();

          // Returned control never restores the refused credentials: the repairing
          // startup consumes a failure kept with them although it never installed them.
          h.proxy.level = "controlled_by_this_extension";
          await h.controller.handleProxyControlLost(await h.proxy.getControlLevel());
          expect(h.controller.isSessionCurrentForProxyAuth(h.session)).toBe(false);
          if (tlsFailure === "while the repair keeps it")
            expect(h.controller.getSnapshot()).toMatchObject({ error: "proxy_unavailable" });
          expect(h.snapshots.filter((snapshot) => snapshot.protected)).toEqual([]);
          expect(h.safety.events).not.toContain("allow");
          expect(await h.controller.getActiveSession()).toBeNull();
          expect(h.storage.transient.proxySession).toBeNull();
        },
      );
    }
  }

  for (const repairedBy of ["the settings event", "the failure's own initialization"] as const) {
    it.each([true, false])(
      `never authorizes a kept session whose endpoint fails TLS before ${repairedBy} repairs control, kill switch %s`,
      async (kill) => {
        const h = await fixture(kill);
        const loss = loseControlAtGuardedTest(h, "controlled_by_other_extensions", false);
        await h.controller.initialize();
        // The refused startup has returned: the session waits for its repair.
        expect(h.storage.transient).toEqual(h.transient);

        if (repairedBy === "the failure's own initialization")
          h.proxy.level = "controlled_by_this_extension";
        await h.controller.handleProxyError("proxy_tls_error", false, {
          host: h.session.host,
          port: h.session.port,
        });
        h.proxy.level = "controlled_by_this_extension";
        await h.controller.handleProxyControlLost(await h.proxy.getControlLevel());

        expect(loss.trace.slice(0, 2)).toEqual(["check:controlled_by_this_extension", "loss"]);
        expect(h.controller.isSessionCurrentForProxyAuth(h.session)).toBe(false);
        expect(h.controller.getSnapshot()).toMatchObject({ error: "proxy_unavailable" });
        expect(h.snapshots.filter((snapshot) => snapshot.protected)).toEqual([]);
        expect(h.safety.events).not.toContain("allow");
        expect(await h.controller.getActiveSession()).toBeNull();
        expect(h.storage.transient.proxySession).toBeNull();
      },
    );
  }

  it("still replaces the saved session when our controllable route is not guarded", async () => {
    const h = await fixture(false);
    // Without the kill switch, startup installs no guard: nothing protects the saved proxy.
    await h.proxy.clear();

    await h.controller.initialize();

    expect(h.api.proofs).toHaveLength(1);
    expect(h.storage.transient.proxySession?.id).not.toBe(h.session.id);
    expect(h.controller.getSnapshot()).toMatchObject({ protected: true, error: null });
  });
});
