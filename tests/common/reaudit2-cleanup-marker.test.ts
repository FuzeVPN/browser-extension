// SPDX-License-Identifier: MPL-2.0

import type { ProxySession } from "../../src/core/api/types";
import { ALARM_RECONNECT, ALARM_REFRESH, REFRESH_RETRY_MS } from "../../src/core/shared/config";
import type {
  PendingProxyRevocation,
  ProxyCleanupStorage,
} from "../../src/core/storage/proxy-cleanup-storage";
import { NOW, PROFILE, authenticatedState, createHarness, proxySession } from "./helpers";

type Harness = ReturnType<typeof createHarness>;

function pending(session: ProxySession): PendingProxyRevocation {
  return { userId: PROFILE.userId, sessionId: session.id, expiresAt: session.expiresAt };
}

class MemoryCleanup implements ProxyCleanupStorage {
  sessions: PendingProxyRevocation[] = [];

  async read(): Promise<PendingProxyRevocation[]> {
    return structuredClone(this.sessions);
  }

  async write(sessions: PendingProxyRevocation[]): Promise<void> {
    this.sessions = structuredClone(sessions);
  }
}

// Each cause fails the attempt after its POST returned an ID which the ledger recorded,
// before the attempt commits that creation.
const CAUSES = [
  ["transient-write", "unknown_error"],
  ["invalid-response", "invalid_response"],
  ["near-expiry", "session_expired"],
] as const;

type Cause = (typeof CAUSES)[number][0];

function arm(h: Harness, cause: Cause, session: ProxySession): void {
  if (cause === "transient-write") {
    const write = h.storage.writeTransient.bind(h.storage);
    let armed = true;
    vi.spyOn(h.storage, "writeTransient").mockImplementation(async (state) => {
      if (armed && state.proxySession?.id === session.id) {
        armed = false;
        throw new Error("transient_write_failed");
      }
      await write(state);
    });
  }
  h.api.sessions = [
    cause === "invalid-response"
      ? { ...session, password: "" }
      : cause === "near-expiry"
        ? { ...session, expiresAt: new Date(NOW + 1_000).toISOString() }
        : session,
  ];
}

async function connected(): Promise<{ h: Harness; ledger: MemoryCleanup; previous: ProxySession }> {
  const ledger = new MemoryCleanup();
  const h = createHarness({ persisted: authenticatedState(), cleanupStorage: ledger });
  await h.controller.initialize();
  h.api.sessions = [proxySession("active-1")];
  expect(await h.controller.connect("frankfurt-01")).toEqual({ ok: true });
  return { h, ledger, previous: h.proxy.active! };
}

/** An idle stop: the next worker starts from the durable stores only. */
async function expectNoHistoricalUnknownAfterRestart(h: Harness, ledger: MemoryCleanup) {
  const restarted = createHarness({
    persisted: h.storage.persisted,
    transient: h.storage.transient,
    security: h.securityStorage.state!,
    cleanupStorage: ledger,
    ...(h.proxy.active ? { activeProxy: h.proxy.active } : {}),
  });
  await restarted.controller.initialize();
  expect(restarted.controller.getDiagnosticReadState()).toMatchObject({
    proxyCreationUncertain: false,
    proxyCleanupUncertain: false,
  });
  expect(restarted.controller.getSnapshot().error).not.toBe("proxy_creation_uncertain");
  expect(await restarted.controller.logout()).toEqual({ ok: true });
  expect(restarted.controller.getSnapshot().logoutOutcome?.proxySessions).toBe("confirmed");
  expect(restarted.securityStorage.state?.proxyCleanupUncertain).toBe(false);
  expect(ledger.sessions).toEqual([]);
}

afterEach(() => vi.restoreAllMocks());

describe("ULTRA-08 residual: a failed attempt settles the creation its ledger recorded", () => {
  it.each(CAUSES)(
    "connect: %s clears the marker and restores no historical unknown",
    async (cause, error) => {
      const ledger = new MemoryCleanup();
      const h = createHarness({ persisted: authenticatedState(), cleanupStorage: ledger });
      await h.controller.initialize();
      arm(h, cause, proxySession("created-1"));

      expect(await h.controller.connect("frankfurt-01")).toEqual({
        ok: false,
        commandError: error,
      });
      await vi.waitFor(() => expect(ledger.sessions).toEqual([]));
      expect(h.api.revoked).toEqual(["created-1"]);
      // The recorded ID settled the creation: no unknown remains to suspend retries.
      expect(h.securityStorage.state).toMatchObject({
        proxyCreationUncertain: false,
        proxyCleanupUncertain: false,
      });
      expect(h.controller.getDiagnosticReadState()).toMatchObject({
        proxyCreationUncertain: false,
        proxyCleanupUncertain: false,
      });
      expect(h.controller.getSnapshot().error).toBe(error);

      await expectNoHistoricalUnknownAfterRestart(h, ledger);
    },
  );

  it.each(CAUSES)(
    "refresh: %s clears the marker and restores no historical unknown",
    async (cause, error) => {
      const { h, ledger, previous } = await connected();
      arm(h, cause, proxySession("renewal-1"));

      await h.controller.handleAlarm(ALARM_REFRESH);
      expect(h.api.revoked).toEqual(["renewal-1"]);
      await vi.waitFor(() => expect(ledger.sessions).toEqual([pending(previous)]));
      expect(h.securityStorage.state).toMatchObject({
        proxyCreationUncertain: false,
        proxyCleanupUncertain: false,
      });
      expect(h.controller.getSnapshot().error).toBe(error);

      await expectNoHistoricalUnknownAfterRestart(h, ledger);
    },
  );

  it.each(CAUSES)(
    "location change: %s clears the marker and restores no historical unknown",
    async (cause, error) => {
      const { h, ledger, previous } = await connected();
      arm(h, cause, proxySession("replacement-1", "frankfurt-02"));

      expect(await h.controller.changeLocation("frankfurt-02")).toEqual({
        ok: false,
        commandError: error,
      });
      expect(h.api.revoked).toEqual(["replacement-1"]);
      await vi.waitFor(() => expect(ledger.sessions).toEqual([pending(previous)]));
      // The live predecessor is restored, without a creation marker left behind.
      expect(h.proxy.active).toEqual(previous);
      expect(h.securityStorage.state).toMatchObject({
        proxyCreationUncertain: false,
        proxyCleanupUncertain: false,
        retrySuspended: false,
      });

      await expectNoHistoricalUnknownAfterRestart(h, ledger);
    },
  );
});

describe("ULTRA-08 residual: a settled creation no longer suspends automatic retries", () => {
  it("reconnects automatically after a connection whose session was already expiring", async () => {
    const h = createHarness({
      persisted: authenticatedState(),
      cleanupStorage: new MemoryCleanup(),
    });
    await h.controller.initialize();
    arm(h, "near-expiry", proxySession("created-1"));

    expect(await h.controller.connect("frankfurt-01")).toEqual({
      ok: false,
      commandError: "session_expired",
    });
    expect(h.securityStorage.state).toMatchObject({
      retrySuspended: false,
      nextRetryAt: NOW + 30_000,
    });
    expect(h.alarms.reconnectAt).toBe(NOW + 30_000);

    h.api.sessions = [proxySession("created-2")];
    h.setNow(NOW + 30_000);
    await h.controller.handleAlarm(ALARM_RECONNECT);
    expect(h.proxy.active?.id).toBe("created-2");
    expect(h.controller.getSnapshot()).toMatchObject({
      status: "connected",
      protected: true,
      error: null,
    });
  });

  it("retries the renewal of the retained session after a renewal that was already expiring", async () => {
    const { h, previous } = await connected();
    arm(h, "near-expiry", proxySession("renewal-1"));

    await h.controller.handleAlarm(ALARM_REFRESH);
    // The valid predecessor stays protected and its renewal is retried.
    expect(h.proxy.active).toEqual(previous);
    expect(h.storage.transient).toMatchObject({
      proxySession: previous,
      refreshAttempts: 1,
      refreshRetryAt: NOW + REFRESH_RETRY_MS,
    });
    expect(h.alarms.retryAt).toBe(NOW + REFRESH_RETRY_MS);
    expect(h.securityStorage.state?.retrySuspended).toBe(false);
    expect(h.controller.getSnapshot()).toMatchObject({
      status: "refreshing",
      protected: true,
      error: "session_expired",
    });

    h.api.sessions = [proxySession("renewal-2")];
    h.setNow(NOW + REFRESH_RETRY_MS);
    await h.controller.handleAlarm(ALARM_REFRESH);
    expect(h.proxy.active?.id).toBe("renewal-2");
    expect(h.controller.getSnapshot()).toMatchObject({
      status: "connected",
      protected: true,
      error: null,
    });
  });
});
