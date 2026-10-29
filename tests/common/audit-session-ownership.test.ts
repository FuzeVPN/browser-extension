// SPDX-License-Identifier: MPL-2.0

import { ApiError, NetworkError } from "../../src/core/api/client";
import { ALARM_REFRESH, MAX_REFRESH_ATTEMPTS } from "../../src/core/shared/config";
import { NOW, authenticatedState, createHarness, proxySession } from "./helpers";

const REFRESH_NOW = NOW + 510_000;

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function freshSession(id: string, locationId = "frankfurt-01", issuedAt = REFRESH_NOW) {
  return proxySession(
    id,
    locationId,
    new Date(issuedAt).toISOString(),
    new Date(issuedAt + 600_000).toISOString(),
  );
}

async function liveHarness(refreshAttempts = 0, refreshRetryAt?: number) {
  const previous = proxySession("previous-session");
  const h = createHarness({
    persisted: authenticatedState({ autoConnect: true }),
    transient: {
      proxySession: previous,
      refreshAttempts,
      ...(refreshRetryAt === undefined ? {} : { refreshRetryAt }),
      retiredSessions: [],
    },
    activeProxy: previous,
  });
  h.identity.deviceId = "browser-device-1";
  await h.controller.initialize();
  await h.controller.refreshAccount();
  h.setNow(REFRESH_NOW);
  return h;
}

describe("session ownership after concurrent connection commands", () => {
  it.each(["connect", "refresh", "change-location"] as const)(
    "never retains revoked credentials when preferences supersede %s during identity finalization",
    async (action) => {
      const h =
        action === "connect"
          ? createHarness({ persisted: authenticatedState() })
          : await liveHarness();
      if (action === "connect") {
        h.identity.deviceId = "browser-device-1";
        await h.controller.initialize();
        await h.controller.refreshAccount();
        h.setNow(REFRESH_NOW);
      }
      const locationId = action === "change-location" ? "frankfurt-02" : "frankfurt-01";
      const replacement = freshSession(`pending-${action}`, locationId);
      h.api.sessions = [replacement, freshSession(`retained-${action}`, locationId)];
      const entered = deferred();
      const finishRecovery = deferred();
      vi.spyOn(h.identity, "completeRecovery").mockImplementationOnce(async () => {
        entered.resolve();
        await finishRecovery.promise;
      });

      const connecting =
        action === "connect"
          ? h.controller.connect(locationId)
          : action === "refresh"
            ? h.controller.handleAlarm(ALARM_REFRESH)
            : h.controller.changeLocation(locationId);
      await entered.promise;
      const changing = h.controller.updateSecurityPreferences(true, false);
      await Promise.resolve();
      finishRecovery.resolve();
      await Promise.all([connecting, changing]);

      const active = await h.controller.getActiveSession();
      expect(active).not.toBeNull();
      expect(h.api.revoked).not.toContain(active!.id);
      expect(h.proxy.active?.id).toBe(active!.id);
      expect(h.storage.transient.proxySession?.id).toBe(active!.id);
      expect(h.controller.getSnapshot()).toMatchObject({
        status: "connected",
        protected: true,
        securityPreferences: { killSwitchEnabled: true, webRtcProtectionEnabled: false },
      });
    },
  );

  it("ignores a second refresh while the first replacement is still being installed", async () => {
    const h = await liveHarness();
    const replacement = freshSession("single-authorized-refresh");
    h.api.sessions = [replacement];
    const create = vi.spyOn(h.api, "createProxySession");
    const finishApply = deferred();
    h.proxy.applyWait = finishApply.promise;
    const first = h.controller.handleAlarm(ALARM_REFRESH);
    await vi.waitFor(() => expect(h.proxy.applyCalls).toBe(1));

    h.api.createError = new ApiError("rate_limited", 429, 30);
    let secondSettled = false;
    const second = h.controller.handleAlarm(ALARM_REFRESH).then(() => {
      secondSettled = true;
    });
    try {
      await vi.waitFor(() => expect(secondSettled).toBe(true));
      expect(create).toHaveBeenCalledOnce();
    } finally {
      h.proxy.applyWait = null;
      finishApply.resolve();
      await Promise.all([first, second]);
    }

    expect(h.api.revoked).not.toContain(replacement.id);
    expect(h.storage.transient).toMatchObject({
      proxySession: { id: replacement.id },
      refreshAttempts: 0,
    });
    expect(await h.controller.getActiveSession()).toMatchObject({ id: replacement.id });
    expect(h.controller.getSnapshot()).toMatchObject({ status: "connected", protected: true });
  });

  it.each(["disconnect", "logout"] as const)(
    "revokes the discarded replacement when %s supersedes identity finalization",
    async (action) => {
      const h = await liveHarness();
      const replacement = freshSession(`discarded-by-${action}`);
      h.api.sessions = [replacement];
      const entered = deferred();
      const finishRecovery = deferred();
      vi.spyOn(h.identity, "completeRecovery").mockImplementationOnce(async () => {
        entered.resolve();
        await finishRecovery.promise;
      });
      const refresh = h.controller.handleAlarm(ALARM_REFRESH);
      await entered.promise;
      const stopping = h.controller[action]();
      await Promise.resolve();
      finishRecovery.resolve();
      await Promise.all([refresh, stopping]);

      expect(h.api.revoked).toContain(replacement.id);
      expect(h.storage.transient.proxySession).toBeNull();
      expect(h.proxy.active).toBeNull();
      expect(await h.controller.getActiveSession()).toBeNull();
      expect(h.controller.getSnapshot()).toMatchObject({
        protected: false,
        activeLocationId: null,
      });
    },
  );
});

describe("retained session renewal after a failed location change", () => {
  it("keeps an exhausted renewal budget suspended without creating another session", async () => {
    const retryAt = NOW + 550_000;
    const h = await liveHarness(MAX_REFRESH_ATTEMPTS, retryAt);
    const previous = h.proxy.active!;
    const schedule = vi.spyOn(h.alarms, "scheduleSession");
    const create = vi.spyOn(h.api, "createProxySession");
    vi.spyOn(h.api, "getSubscription").mockRejectedValueOnce(new NetworkError("network"));

    expect(await h.controller.changeLocation("frankfurt-02")).toMatchObject({
      ok: false,
      commandError: "network_error",
    });
    expect(h.storage.transient).toMatchObject({
      proxySession: { id: previous.id },
      refreshAttempts: MAX_REFRESH_ATTEMPTS,
      refreshRetryAt: retryAt,
    });
    expect(schedule).toHaveBeenLastCalledWith(previous, null);
    h.setNow(retryAt);
    await h.controller.handleAlarm(ALARM_REFRESH);

    expect(create).not.toHaveBeenCalled();
    expect(h.alarms.retryAt).toBeNull();
    expect(h.proxy.active?.id).toBe(previous.id);
    expect(h.controller.getSnapshot().protected).toBe(true);
  });

  it("preserves the remaining attempts and exact deadline before renewing the retained server", async () => {
    const retryAt = NOW + 550_000;
    const h = await liveHarness(2, retryAt);
    const previous = h.proxy.active!;
    const schedule = vi.spyOn(h.alarms, "scheduleSession");
    const create = vi.spyOn(h.api, "createProxySession");
    vi.spyOn(h.api, "getSubscription").mockRejectedValueOnce(new NetworkError("network"));

    expect(await h.controller.changeLocation("frankfurt-02")).toMatchObject({
      ok: false,
      commandError: "network_error",
    });
    expect(h.storage.transient).toMatchObject({
      proxySession: { id: previous.id },
      refreshAttempts: 2,
      refreshRetryAt: retryAt,
    });
    expect(schedule).toHaveBeenLastCalledWith(previous, retryAt);
    h.setNow(retryAt - 1);
    await h.controller.handleAlarm(ALARM_REFRESH);
    expect(create).not.toHaveBeenCalled();
    expect(h.storage.transient.refreshAttempts).toBe(2);

    const replacement = freshSession("renewed-at-retained-deadline", previous.locationId, retryAt);
    h.api.sessions = [replacement];
    h.setNow(retryAt);
    await h.controller.handleAlarm(ALARM_REFRESH);

    expect(create).toHaveBeenCalledOnce();
    expect(h.proxy.active?.id).toBe(replacement.id);
    expect(h.storage.transient).toMatchObject({
      proxySession: { id: replacement.id },
      refreshAttempts: 0,
    });
    expect(h.storage.transient.refreshRetryAt).toBeUndefined();
    expect(h.controller.getSnapshot()).toMatchObject({ status: "connected", protected: true });
  });
});
