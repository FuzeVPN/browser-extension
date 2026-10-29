// SPDX-License-Identifier: MPL-2.0

import type { ProxySession } from "../../src/core/api/types";
import { ExtensionAlarmService } from "../../src/core/background/session-refresh";
import { ExtensionStorageService } from "../../src/core/storage/storage";
import { authenticatedState, createHarness, LOCATIONS, NOW, proxySession } from "./helpers";

describe("restored proxy session validation", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function fixture(session: unknown, refreshAttempts: unknown = 0) {
    const alarms = new Map<string, { name: string; scheduledTime: number }>();
    const create = vi.fn(async (name: string, options: { when: number }) => {
      if (!Number.isFinite(options.when)) throw new TypeError("invalid alarm time");
      alarms.set(name, { name, scheduledTime: options.when });
    });
    vi.stubGlobal("browser", {
      storage: {
        session: {
          get: async () => ({
            fuzevpnProxySession: {
              proxySession: session,
              activeLocation: LOCATIONS[0],
              refreshAttempts,
              retiredSessions: [],
            },
          }),
        },
      },
      alarms: {
        create,
        get: async (name: string) => alarms.get(name),
        clear: async (name: string) => alarms.delete(name),
      },
    });
    return { storage: new ExtensionStorageService(), create };
  }

  it.each([
    ["issuedAt", "invalid-date"],
    ["issuedAt", ""],
    ["expiresAt", "invalid-date"],
    ["expiresAt", ""],
    ["expiresAt", "2026-08-26T11:59:59Z"],
    ["expiresAt", "2026-08-26T12:00:00Z"],
    ["port", 0],
    ["port", 65_536],
    ["port", 443.5],
    ["port", NaN],
    ["port", Infinity],
    ["refreshAfterSeconds", 0],
    ["refreshAfterSeconds", -1],
    ["refreshAfterSeconds", 1.5],
    ["refreshAfterSeconds", NaN],
    ["refreshAfterSeconds", Infinity],
    ["refreshAfterSeconds", Number.MAX_SAFE_INTEGER + 1],
    ["id", " "],
    ["locationId", ""],
    ["host", ""],
    ["username", ""],
    ["password", ""],
  ])("does not restore credentials with corrupt %s=%s", async (field, value) => {
    const f = fixture({ ...proxySession(), [field]: value });
    expect(await f.storage.readTransient()).toMatchObject({
      proxySession: null,
      activeLocation: null,
    });
  });

  it.each([NaN, Infinity, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    "resets an invalid refresh attempt count: %s",
    async (refreshAttempts) => {
      const session = proxySession();
      const f = fixture(session, refreshAttempts);
      expect(await f.storage.readTransient()).toMatchObject({
        proxySession: session,
        refreshAttempts: 0,
      });
    },
  );

  async function restore(session: ProxySession) {
    const f = fixture(session);
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    const restored = await f.storage.readTransient();
    const h = createHarness({
      persisted: authenticatedState({ autoConnect: true }),
      transient: restored,
      activeProxy: session,
    });
    const nativeAlarms = new ExtensionAlarmService();
    vi.spyOn(h.alarms, "scheduleSession").mockImplementation((value, at) =>
      nativeAlarms.scheduleSession(value, at),
    );
    const createSession = h.api.createProxySession.bind(h.api);
    const replacement = vi
      .spyOn(h.api, "createProxySession")
      .mockImplementation(async (...arguments_) => {
        expect(h.safety.status.trafficBlocked).toBe(true);
        return createSession(...arguments_);
      });
    await h.controller.initialize();
    return { ...f, h, replacement };
  }

  it("restores a valid session without requesting replacement credentials", async () => {
    const session = proxySession();
    const { h, create, replacement } = await restore(session);
    expect(h.controller.getSnapshot()).toMatchObject({
      status: "connected",
      protected: true,
      trafficBlocked: false,
      activeLocationId: session.locationId,
    });
    expect(await h.controller.getActiveSession()).toEqual(session);
    expect(h.api.proofs).toHaveLength(0);
    expect(replacement).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledTimes(2);
  });

  it("replaces a corrupt legacy session under the guard and schedules finite alarms", async () => {
    const corrupt = { ...proxySession("corrupt-session"), issuedAt: "invalid-date" };
    const { h, create, replacement } = await restore(corrupt);
    expect(h.api.proofs).toHaveLength(1);
    expect(replacement).toHaveBeenCalledOnce();
    expect(h.controller.getSnapshot()).toMatchObject({
      status: "connected",
      protected: true,
      trafficBlocked: false,
    });
    expect((await h.controller.getActiveSession())?.id).not.toBe(corrupt.id);
    expect(h.securityStorage.state).toMatchObject({ retrySuspended: false, nextRetryAt: null });
    expect(h.safety.events.indexOf("block")).toBeLessThan(h.safety.events.indexOf("allow"));
    expect(create).toHaveBeenCalledTimes(2);
    expect(create.mock.calls.every(([, options]) => Number.isFinite(options.when))).toBe(true);
  });
});
