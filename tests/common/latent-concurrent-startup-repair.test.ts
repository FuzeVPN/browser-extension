// SPDX-License-Identifier: MPL-2.0

import { SafetyError } from "../../src/core/background/network-safety";
import { DEFAULT_SECURITY_STATE } from "../../src/core/shared/security";
import { authenticatedState, createHarness, NOW, proxySession } from "./helpers";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

/**
 * A worker starting with a stored session while the browser refuses WebRTC control: the
 * startup guard is refused until the user stops asking for the kill switch and WebRTC
 * protection, and the session stays stored for that repair.
 */
async function refusedStartup() {
  const session = proxySession(
    "stored-before-refusal",
    "frankfurt-01",
    new Date(NOW - 60_000).toISOString(),
  );
  const transient = { proxySession: session, refreshAttempts: 0, retiredSessions: [] };
  const h = createHarness({
    persisted: authenticatedState({ autoConnect: true }),
    security: { ...DEFAULT_SECURITY_STATE, protectionRequested: true },
    transient,
    activeProxy: session,
  });
  const setWebRtc = h.safety.setWebRtc.bind(h.safety);
  vi.spyOn(h.safety, "setWebRtc").mockImplementation(async (enabled) => {
    if (enabled) throw new SafetyError("webrtc_control_unavailable");
    await setWebRtc(enabled);
  });
  await h.controller.initialize();
  expect(h.controller.getSnapshot()).toMatchObject({
    status: "error",
    protected: false,
    error: "webrtc_control_unavailable",
  });
  expect(h.storage.transient).toEqual(transient);
  expect(await h.controller.getActiveSession()).toBeNull();
  return { ...h, session, transient };
}

async function expectRestored(h: Awaited<ReturnType<typeof refusedStartup>>) {
  expect(h.controller.getSnapshot()).toMatchObject({
    status: "connected",
    protected: true,
    error: null,
    securityPreferences: { killSwitchEnabled: false, webRtcProtectionEnabled: false },
  });
  expect(h.storage.transient).toEqual(h.transient);
  expect(h.proxy.active).toEqual(h.session);
  expect(await h.controller.getActiveSession()).toEqual(h.session);
  expect(h.alarms.session).toEqual(h.session);
  expect(h.api.proofs).toHaveLength(0);
}

afterEach(() => vi.restoreAllMocks());

describe("a preference change which repairs a refused startup guard", () => {
  it("restores the stored session when no other event arrives", async () => {
    const h = await refusedStartup();
    expect(await h.controller.updateSecurityPreferences(false, false)).toEqual({ ok: true });
    await settle();
    await expectRestored(h);
  });

  it("restores the stored session when a popup read arrives during its write", async () => {
    const h = await refusedStartup();
    const guardSuspension = deferred();
    const sessionRead = deferred();
    let popupRead: Promise<void> | undefined;
    const write = h.securityStorage.write.bind(h.securityStorage);
    const suspend = h.safety.suspend.bind(h.safety);
    const readTransient = h.storage.readTransient.bind(h.storage);
    vi.spyOn(h.securityStorage, "write").mockImplementation(async (state) => {
      await write(state);
      if (popupRead || state.webRtcProtectionEnabled) return;
      // The read starts a restoration of its own, whose first guard call is slow.
      vi.spyOn(h.safety, "suspend").mockImplementationOnce(async () => {
        await guardSuspension.promise;
        await suspend();
      });
      popupRead = h.controller.initialize();
      // The next read of the session store, by whichever restoration, is slow too.
      vi.spyOn(h.storage, "readTransient").mockImplementationOnce(async () => {
        await sessionRead.promise;
        return readTransient();
      });
    });

    const changing = h.controller.updateSecurityPreferences(false, false);
    await settle();
    expect(popupRead).toBeDefined();
    expect(h.securityStorage.state).toMatchObject({
      killSwitchEnabled: false,
      webRtcProtectionEnabled: false,
      protectionRequested: true,
    });

    guardSuspension.resolve();
    await settle();
    sessionRead.resolve();
    expect(await changing).toEqual({ ok: true });
    await popupRead;
    await settle();

    // However the two restorations interleave, the stored session ends up restored.
    await expectRestored(h);
  });
});
