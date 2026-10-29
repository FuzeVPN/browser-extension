// SPDX-License-Identifier: MPL-2.0

import type { ProxySession } from "../../src/core/api/types";
import { AppController } from "../../src/core/background/state-machine";
import { ALARM_RECONNECT } from "../../src/core/shared/config";
import { authenticatedState, createHarness, NOW, proxySession } from "./helpers";

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

function harness(automatic = false) {
  const h = createHarness({ persisted: authenticatedState() });
  if (!automatic) return h;
  let now = NOW;
  // Production always supplies this resolver, even when automatic mode is off.
  const controller = new AppController({
    api: h.api,
    storage: h.storage,
    identity: h.identity,
    proxy: h.proxy,
    alarms: h.alarms,
    safety: h.safety,
    securityStorage: h.securityStorage,
    now: () => now,
    remoteCleanupTimeoutMs: 250,
    onStateChanged: (snapshot) => h.snapshots.push(snapshot),
    resolveAutomaticLocation: async () => undefined,
  });
  return {
    ...h,
    controller,
    setNow(value: number) {
      now = value;
    },
  };
}

type Harness = ReturnType<typeof harness>;

/**
 * Delivers a current TLS failure of the active session and holds its route verification:
 * an operation started meanwhile supersedes the handler before it ends the session.
 */
async function refuseDuringRouteRead(h: Harness, session: ProxySession) {
  const read = deferred();
  const release = deferred();
  const configured = h.proxy.isActiveConfiguration.bind(h.proxy);
  vi.spyOn(h.proxy, "isActiveConfiguration").mockImplementationOnce(async (candidate) => {
    read.resolve();
    await release.promise;
    return configured(candidate);
  });
  // No observed departure: the failure cannot be proven historical.
  const handling = h.controller.handleProxyError("proxy_tls_error", false, {
    host: session.host,
    port: session.port,
  });
  await read.promise;
  expect(h.controller.isSessionCurrentForProxyAuth(session)).toBe(false);
  return { handling, release: release.resolve, snapshots: h.snapshots.length };
}

/** The refused session ended through the failure path, which reconnects to the selection. */
async function expectRefusedSessionFailed(
  h: Harness,
  refused: ProxySession,
  selectedLocationId: string,
  snapshots: number,
) {
  expect(h.snapshots.slice(snapshots).some((snapshot) => snapshot.protected)).toBe(false);
  expect(h.controller.isSessionCurrentForProxyAuth(refused)).toBe(false);
  expect(h.controller.getSnapshot()).toMatchObject({
    // The failure keeps the kill switch blocking until the reconnection.
    status: "blocked",
    protected: false,
    activeLocationId: null,
    selectedLocationId,
    error: "proxy_unavailable",
  });
  expect(h.storage.transient.proxySession).toBeNull();
  expect(h.alarms.session).toBeNull();
  const reconnectAt = h.alarms.reconnectAt;
  expect(reconnectAt).not.toBeNull();
  h.setNow(reconnectAt!);
  await h.controller.handleAlarm(ALARM_RECONNECT);
  expect(h.controller.getSnapshot()).toMatchObject({
    status: "connected",
    protected: true,
    activeLocationId: selectedLocationId,
    error: null,
  });
  expect(h.proxy.active?.id).not.toBe(refused.id);
}

describe("xreview: a newer selection never retains a session refused by TLS", () => {
  afterEach(() => vi.restoreAllMocks());

  it.each([false, true])(
    "when it supersedes a reselection of the refused location (automatic resolver %s)",
    async (automatic) => {
      const h = harness(automatic);
      expect(await h.controller.connect("frankfurt-01")).toEqual({ ok: true });
      await h.controller.refreshAccount();
      const refused = h.proxy.active!;
      const tls = await refuseDuringRouteRead(h, refused);

      // The reselection supersedes the pending route verification of the error.
      const reselecting = h.controller.changeLocation(refused.locationId);
      await Promise.resolve();
      const selecting = h.controller.selectLocation("frankfurt-02");
      await settle();
      tls.release();

      expect(await selecting).toEqual({ ok: true });
      expect(await reselecting).toEqual({ ok: false, commandError: "proxy_unavailable" });
      await tls.handling;
      await expectRefusedSessionFailed(h, refused, "frankfurt-02", tls.snapshots);
    },
  );

  it("when it supersedes a change to another location before its POST", async () => {
    const h = harness();
    expect(await h.controller.connect("frankfurt-01")).toEqual({ ok: true });
    const refused = h.proxy.active!;
    const proofs = h.api.proofs.length;
    const tls = await refuseDuringRouteRead(h, refused);

    const changing = h.controller.changeLocation("frankfurt-02");
    const selecting = h.controller.selectLocation(refused.locationId);
    await settle();
    tls.release();

    expect(await selecting).toEqual({ ok: true });
    expect(await changing).toEqual({ ok: false, superseded: true });
    await tls.handling;
    // The replaced target was never requested.
    expect(h.api.proofs).toHaveLength(proofs);
    await expectRefusedSessionFailed(h, refused, refused.locationId, tls.snapshots);
  });

  it("when it supersedes a change to another location after its POST", async () => {
    const h = harness();
    expect(await h.controller.connect("frankfurt-01")).toEqual({ ok: true });
    const refused = h.proxy.active!;
    const proofs = h.api.proofs.length;
    const created = deferred();
    h.api.createWait = created.promise;
    h.api.sessions = [proxySession("discarded-target", "frankfurt-02")];
    const tls = await refuseDuringRouteRead(h, refused);

    const changing = h.controller.changeLocation("frankfurt-02");
    await settle();
    tls.release();
    await tls.handling;
    await vi.waitFor(() => expect(h.api.proofs).toHaveLength(proofs + 1));
    expect(await h.controller.selectLocation(refused.locationId)).toEqual({ ok: true });
    h.api.createWait = null;
    created.resolve();

    expect(await changing).toEqual({ ok: false, superseded: true });
    await vi.waitFor(() => expect(h.api.revoked).toContain("discarded-target"));
    await expectRefusedSessionFailed(h, refused, refused.locationId, tls.snapshots);
  });
});
