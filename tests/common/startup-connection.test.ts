// SPDX-License-Identifier: MPL-2.0

import { NetworkError } from "../../src/core/api/client";
import { AppController } from "../../src/core/background/state-machine";
import { DEFAULT_SECURITY_STATE, type SecurityState } from "../../src/core/shared/security";
import { authenticatedState, createHarness, NOW, proxySession } from "./helpers";

/** Protection is requested, and no session is left to restore: one must be created. */
const REQUESTED: SecurityState = {
  ...DEFAULT_SECURITY_STATE,
  protectionRequested: true,
  selectedLocationId: "frankfurt-01",
};

async function settle(turns = 20) {
  for (let turn = 0; turn < turns; turn++) await new Promise<void>((done) => setImmediate(done));
}

/** A worker whose server does not answer the session request until told to. */
function slowServer() {
  const h = createHarness({ persisted: authenticatedState(), security: REQUESTED });
  let answer!: () => void;
  h.api.createWait = new Promise<void>((resolve) => {
    answer = resolve;
  });
  h.api.sessions = [proxySession("created-after-start-up")];
  return { h, answer };
}

afterEach(() => vi.restoreAllMocks());

describe("the connection which a restoration finds due", () => {
  it("is made after the restoration, which does not wait for it", async () => {
    const { h, answer } = slowServer();

    await h.controller.initialize();

    // The restoration has ended, and says so: the connection is in progress.
    expect(h.controller.getSnapshot()).toMatchObject({
      status: "connecting",
      protected: false,
      protectionRequested: true,
    });
    // Its request reaches the server, which does not answer yet.
    await vi.waitFor(() => expect(h.api.proofs).toHaveLength(1));
    expect(h.controller.getSnapshot().status).toBe("connecting");
    expect(h.safety.status.trafficBlocked).toBe(true);

    answer();
    await h.controller.startupConnectionSettled();
    expect(h.controller.getSnapshot()).toMatchObject({ status: "connected", protected: true });
    expect(h.proxy.active?.id).toBe("created-after-start-up");
  });

  it("does not keep a Disconnect waiting for the server", async () => {
    const { h, answer } = slowServer();
    await h.controller.initialize();

    // The server has still not answered.
    expect(await h.controller.disconnect()).toEqual({ ok: true });
    expect(h.controller.getSnapshot()).toMatchObject({
      status: "disconnected",
      protected: false,
      protectionRequested: false,
      trafficBlocked: false,
    });

    answer();
    await h.controller.startupConnectionSettled();
    await settle();
    // The session which that request created is not used.
    expect(h.proxy.active).toBeNull();
    expect(h.controller.getSnapshot()).toMatchObject({ status: "disconnected", protected: false });
  });

  it("is not begun for a Disconnect which was waiting for the restoration", async () => {
    const { h } = slowServer();

    const restoring = h.controller.initialize();
    const stopping = h.controller.disconnect();
    await Promise.all([restoring, stopping]);
    await h.controller.startupConnectionSettled();

    expect(h.api.proofs).toHaveLength(0);
    expect(h.controller.getSnapshot()).toMatchObject({
      status: "disconnected",
      protectionRequested: false,
    });
  });

  it("reports its failure as any connection does, and leaves its retry scheduled", async () => {
    const h = createHarness({ persisted: authenticatedState(), security: REQUESTED });
    h.api.createError = new NetworkError("network");

    await h.controller.initialize();
    await h.controller.startupConnectionSettled();

    expect(h.controller.getSnapshot()).toMatchObject({ protected: false, status: "blocked" });
    expect(h.controller.getSnapshot().error).not.toBeNull();
    expect(h.safety.status.trafficBlocked).toBe(true);
    expect(h.alarms.reconnectAt).toBeGreaterThan(NOW);
  });

  it("is announced once it has begun, with a promise which ends with it", async () => {
    const h = createHarness({ persisted: authenticatedState(), security: REQUESTED });
    const announced: Promise<void>[] = [];
    h.controller = new AppController({
      api: h.api,
      storage: h.storage,
      identity: h.identity,
      proxy: h.proxy,
      alarms: h.alarms,
      safety: h.safety,
      securityStorage: h.securityStorage,
      now: () => NOW,
      onStateChanged: (snapshot) => h.snapshots.push(snapshot),
      onStartupConnection: (ended) => announced.push(ended),
    });
    let answer!: () => void;
    h.api.createWait = new Promise<void>((resolve) => {
      answer = resolve;
    });

    await h.controller.initialize();
    expect(announced).toHaveLength(1);
    let ended = false;
    void announced[0]!.then(() => {
      ended = true;
    });
    await settle();
    expect(ended).toBe(false);

    answer();
    await announced[0];
    expect(h.controller.getSnapshot()).toMatchObject({ status: "connected", protected: true });
  });

  it("is not announced by a restoration which has nothing to connect", async () => {
    const h = createHarness({ persisted: authenticatedState() });
    const announce = vi.fn();
    h.controller = new AppController({
      api: h.api,
      storage: h.storage,
      identity: h.identity,
      proxy: h.proxy,
      alarms: h.alarms,
      safety: h.safety,
      securityStorage: h.securityStorage,
      now: () => NOW,
      onStateChanged: (snapshot) => h.snapshots.push(snapshot),
      onStartupConnection: announce,
    });

    await h.controller.initialize();
    await h.controller.startupConnectionSettled();

    expect(announce).not.toHaveBeenCalled();
    expect(h.controller.getSnapshot().status).toBe("disconnected");
  });
});
