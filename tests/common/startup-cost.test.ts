// SPDX-License-Identifier: MPL-2.0

import { DEFAULT_SECURITY_STATE, type SecurityState } from "../../src/core/shared/security";
import { authenticatedState, createHarness } from "./helpers";

type Harness = ReturnType<typeof createHarness>;

const REQUESTED: SecurityState = {
  ...DEFAULT_SECURITY_STATE,
  protectionRequested: true,
  selectedLocationId: "frankfurt-01",
};

/** Each restoration begins by closing the guard: this grows with every one of them. */
const restorations = (h: Harness) => h.safety.events.filter((event) => event === "suspend").length;

afterEach(() => vi.restoreAllMocks());

describe("the security state in storage", () => {
  async function connectedThenStopped() {
    const h = createHarness({ persisted: authenticatedState() });
    await h.controller.initialize();
    expect(await h.controller.connect("frankfurt-01")).toEqual({ ok: true });
    return h;
  }

  it("is not written again by a worker which restores a connection as it was left", async () => {
    const first = await connectedThenStopped();
    const next = createHarness({
      persisted: first.storage.persisted,
      transient: first.storage.transient,
      security: first.securityStorage.state!,
      activeProxy: first.proxy.active!,
    });
    const written = vi.spyOn(next.securityStorage, "write");

    await next.controller.initialize();

    expect(next.controller.getSnapshot()).toMatchObject({ status: "connected", protected: true });
    // The authorization which confirms the session changes nothing of what is stored.
    expect(written).not.toHaveBeenCalled();
    expect(next.securityStorage.state).toEqual(first.securityStorage.state);
  });

  it("is written when it changes, and holds what the controller holds", async () => {
    const h = await connectedThenStopped();
    const written = vi.spyOn(h.securityStorage, "write");

    expect(await h.controller.updateSecurityPreferences(true, false)).toEqual({ ok: true });

    expect(written).toHaveBeenCalled();
    expect(h.securityStorage.state).toMatchObject({ webRtcProtectionEnabled: false });
    written.mockClear();
    // The same preference again: storage already holds it.
    expect(await h.controller.updateSecurityPreferences(true, false)).toEqual({ ok: true });
    expect(written).not.toHaveBeenCalled();
  });

  it("is written again after a write which was left in doubt", async () => {
    const h = await connectedThenStopped();
    const write = h.securityStorage.write.bind(h.securityStorage);
    const written = vi
      .spyOn(h.securityStorage, "write")
      .mockRejectedValue(new Error("storage unavailable"));
    expect(await h.controller.updateSecurityPreferences(true, false)).toMatchObject({ ok: false });

    written.mockImplementation(write);
    written.mockClear();
    // Nothing says what storage holds: the next write is made, whatever it would hold.
    expect(await h.controller.updateSecurityPreferences(true, true)).toEqual({ ok: true });
    expect(written).toHaveBeenCalled();
    expect(h.securityStorage.state).toMatchObject({ webRtcProtectionEnabled: true });
  });
});

describe("a restoration which the guard refused", () => {
  let clock = 50_000;
  beforeEach(() => {
    clock = 50_000;
    vi.spyOn(performance, "now").mockImplementation(() => clock);
  });

  /** Protection is requested, and another extension holds the proxy. */
  async function refused() {
    const h = createHarness({ persisted: authenticatedState(), security: REQUESTED });
    h.proxy.level = "controlled_by_other_extensions";
    await h.controller.initialize();
    expect(h.controller.getSnapshot()).toMatchObject({
      protected: false,
      error: "proxy_controlled_by_extension",
    });
    return { h, once: restorations(h) };
  }

  it("is not run again by those who only read the state", async () => {
    const { h, once } = await refused();

    // An open popup polls every five seconds; Firefox asks for each web request.
    for (let poll = 0; poll < 5; poll++) {
      clock += 5_000;
      await h.controller.ready();
      expect(await h.controller.getActiveSession()).toBeNull();
    }

    expect(restorations(h)).toBe(once);
    expect(h.controller.getSnapshot().error).toBe("proxy_controlled_by_extension");
  });

  it("is run again for them every thirty seconds at most", async () => {
    const { h, once } = await refused();
    clock += 29_999;
    await h.controller.ready();
    expect(restorations(h)).toBe(once);

    clock += 1;
    await h.controller.ready();
    const twice = restorations(h);
    expect(twice).toBeGreaterThan(once);

    // Refused again: the next thirty seconds start from this attempt.
    clock += 29_999;
    await h.controller.ready();
    expect(restorations(h)).toBe(twice);
  });

  it("is run again at once by a command", async () => {
    const { h, once } = await refused();
    h.proxy.level = "controllable_by_this_extension";

    expect(await h.controller.retryConnection()).toEqual({ ok: true });

    expect(restorations(h)).toBeGreaterThan(once);
    expect(h.controller.getSnapshot()).toMatchObject({ status: "connected", protected: true });
    // Nothing is refused any more: those who read are given the restoration which succeeded.
    const before = restorations(h);
    await h.controller.ready();
    expect(restorations(h)).toBe(before);
  });

  it("is run again at once when the proxy settings are reported changed", async () => {
    const { h, once } = await refused();
    h.proxy.level = "controllable_by_this_extension";

    await h.controller.handleProxyControlLost("controllable_by_this_extension");
    await h.controller.startupConnectionSettled();

    expect(restorations(h)).toBeGreaterThan(once);
    expect(h.controller.getSnapshot().error).not.toBe("proxy_controlled_by_extension");
  });
});

describe("a restoration which could not read its stores", () => {
  it("is run again by every caller, readers included", async () => {
    const h = createHarness({ persisted: authenticatedState() });
    const read = vi
      .spyOn(h.storage, "readPersisted")
      .mockRejectedValueOnce(new Error("storage unavailable"));
    await h.controller.initialize();
    expect(h.controller.getSnapshot().error).toBe("storage_unavailable");

    // The stores answer again: the first reader finds the account.
    await h.controller.ready();

    expect(read).toHaveBeenCalledTimes(2);
    expect(h.controller.getSnapshot()).toMatchObject({ error: null, status: "disconnected" });
    expect(h.controller.getSnapshot().profile).not.toBeNull();
  });
});
