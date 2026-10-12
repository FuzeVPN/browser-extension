// SPDX-License-Identifier: MPL-2.0

import { ApiError, NetworkError, ProxyCreationUncertainError } from "../../src/core/api/client";
import type { ProxySession } from "../../src/core/api/types";
import { ALARM_EXPIRY, ALARM_RECONNECT, ALARM_REFRESH } from "../../src/core/shared/config";
import { AUTH, authenticatedState, createHarness, NOW, PROFILE, proxySession } from "./helpers";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

async function connectedHarness() {
  const h = createHarness({ persisted: authenticatedState(), remoteCleanupTimeoutMs: 20 });
  await h.controller.initialize();
  await h.controller.connect("frankfurt-01");
  return h;
}

afterEach(() => vi.restoreAllMocks());

describe("known proxy creations discarded by a newer settings command", () => {
  it("restores the consumed refresh alarm and renews the retained session before expiry", async () => {
    const h = await connectedHarness();
    const previous = h.proxy.active!;
    h.setNow(NOW + 510_000);
    const response = deferred<ProxySession>();
    const create = vi.spyOn(h.api, "createProxySession").mockReturnValueOnce(response.promise);
    const schedule = vi.spyOn(h.alarms, "scheduleSession");
    const refreshing = h.controller.handleAlarm(ALARM_REFRESH);
    await vi.waitFor(() => expect(create).toHaveBeenCalledOnce());
    await h.controller.updateSecurityPreferences(true, false);
    response.resolve(proxySession("discarded-rotation"));
    await refreshing;

    expect(h.api.revoked).toContain("discarded-rotation");
    expect(h.securityStorage.state).toMatchObject({
      proxyCreationUncertain: false,
      retrySuspended: false,
    });
    expect(h.proxy.active).toEqual(previous);
    expect(schedule).toHaveBeenCalledWith(previous, NOW + 511_000);
    expect(h.controller.getSnapshot()).toMatchObject({ protected: true, error: null });

    const replacement = proxySession(
      "next-rotation",
      "frankfurt-01",
      new Date(NOW + 511_000).toISOString(),
      new Date(NOW + 1_111_000).toISOString(),
    );
    h.api.sessions = [replacement];
    h.setNow(NOW + 511_000);
    await h.controller.handleAlarm(ALARM_REFRESH);
    h.setNow(Date.parse(previous.expiresAt));
    await h.controller.handleAlarm(ALARM_EXPIRY);
    expect(h.proxy.active).toEqual(replacement);
    expect(h.controller.getSnapshot()).toMatchObject({ status: "connected", protected: true });
  });

  it("resumes an initial connection interrupted by settings once its response is known", async () => {
    const h = createHarness({ persisted: authenticatedState() });
    await h.controller.initialize();
    const response = deferred<ProxySession>();
    const create = vi.spyOn(h.api, "createProxySession").mockReturnValueOnce(response.promise);
    const connecting = h.controller.connect("frankfurt-01");
    await vi.waitFor(() => expect(create).toHaveBeenCalledOnce());
    await h.controller.updateSecurityPreferences(true, false);
    response.resolve(proxySession("discarded-initial"));
    await connecting;
    expect(h.securityStorage.state).toMatchObject({
      proxyCreationUncertain: false,
      retrySuspended: false,
      nextRetryAt: NOW + 1_000,
    });
    expect(h.alarms.reconnectAt).toBe(NOW + 1_000);
    h.setNow(NOW + 1_000);
    await h.controller.handleAlarm(ALARM_RECONNECT);
    expect(h.controller.getSnapshot().protected).toBe(true);
    expect(h.proxy.active?.id).not.toBe("discarded-initial");
  });

  it("preserves the marker and alarms of a newer in-flight creation", async () => {
    const h = await connectedHarness();
    const oldResponse = deferred<ProxySession>();
    const nextResponse = deferred<ProxySession>();
    const create = vi
      .spyOn(h.api, "createProxySession")
      .mockReturnValueOnce(oldResponse.promise)
      .mockReturnValueOnce(nextResponse.promise);
    const refreshing = h.controller.handleAlarm(ALARM_REFRESH);
    await vi.waitFor(() => expect(create).toHaveBeenCalledOnce());
    await h.controller.updateSecurityPreferences(true, false);
    const retry = h.controller.retryConnection();
    await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(2));
    const security = structuredClone(h.securityStorage.state);
    const schedule = vi.spyOn(h.alarms, "scheduleSession");
    oldResponse.resolve(proxySession("discarded-old"));
    await refreshing;
    expect(h.securityStorage.state).toEqual(security);
    expect(schedule).not.toHaveBeenCalled();
    expect(h.controller.getSnapshot().status).toBe("refreshing");
    nextResponse.resolve(proxySession("newer-current"));
    await retry;
    expect(h.securityStorage.state?.proxyCreationUncertain).toBe(false);
    expect(h.proxy.active?.id).toBe("newer-current");
  });

  it("does not restore credentials or alarms after a deliberate disconnect", async () => {
    const h = await connectedHarness();
    const response = deferred<ProxySession>();
    const create = vi.spyOn(h.api, "createProxySession").mockReturnValueOnce(response.promise);
    const refreshing = h.controller.handleAlarm(ALARM_REFRESH);
    await vi.waitFor(() => expect(create).toHaveBeenCalledOnce());
    await h.controller.updateSecurityPreferences(true, false);
    await h.controller.disconnect();
    const schedule = vi.spyOn(h.alarms, "scheduleSession");
    response.resolve(proxySession("discarded-after-disconnect"));
    await refreshing;
    expect(schedule).not.toHaveBeenCalled();
    expect(h.storage.transient.proxySession).toBeNull();
    expect(h.proxy.active).toBeNull();
    expect(h.controller.getSnapshot()).toMatchObject({
      status: "disconnected",
      protectionRequested: false,
      protected: false,
    });
  });

  it("does not mutate a newly logged-in account when the old response arrives", async () => {
    const h = await connectedHarness();
    const response = deferred<ProxySession>();
    const create = vi.spyOn(h.api, "createProxySession").mockReturnValueOnce(response.promise);
    const refreshing = h.controller.handleAlarm(ALARM_REFRESH);
    await vi.waitFor(() => expect(create).toHaveBeenCalledOnce());
    await h.controller.updateSecurityPreferences(true, false);
    await h.controller.logout();
    h.api.auth = { ...AUTH, accessToken: "new-account-token" };
    h.api.profile = { ...PROFILE, userId: "new-account" };
    await h.controller.login("new@example.invalid", "synthetic-password");
    const security = structuredClone(h.securityStorage.state);
    const schedule = vi.spyOn(h.alarms, "scheduleSession");
    const revoke = vi.spyOn(h.api, "revokeProxySession");
    response.resolve(proxySession("discarded-old-account"));
    await refreshing;
    expect(revoke).toHaveBeenCalledWith(AUTH.accessToken, "discarded-old-account");
    expect(h.securityStorage.state).toEqual(security);
    expect(schedule).not.toHaveBeenCalled();
    expect(h.storage.transient.proxySession).toBeNull();
    expect(h.controller.getSnapshot()).toMatchObject({
      profile: { userId: "new-account" },
      protected: false,
    });
  });

  it("keeps renewal suspended when the discarded response is actually unknown", async () => {
    const h = await connectedHarness();
    const response = deferred<ProxySession>();
    const create = vi.spyOn(h.api, "createProxySession").mockReturnValueOnce(response.promise);
    const refreshing = h.controller.handleAlarm(ALARM_REFRESH);
    await vi.waitFor(() => expect(create).toHaveBeenCalledOnce());
    await h.controller.updateSecurityPreferences(true, false);
    const schedule = vi.spyOn(h.alarms, "scheduleSession");
    response.reject(new ProxyCreationUncertainError());
    await refreshing;
    await h.controller.handleAlarm(ALARM_REFRESH);
    expect(create).toHaveBeenCalledOnce();
    expect(schedule).not.toHaveBeenCalled();
    expect(h.securityStorage.state?.proxyCreationUncertain).toBe(true);
  });

  it("restores a late 429 retry only after its server deadline", async () => {
    const h = await connectedHarness();
    const previous = h.proxy.active!;
    h.setNow(NOW + 510_000);
    const response = deferred<ProxySession>();
    const create = vi.spyOn(h.api, "createProxySession").mockReturnValueOnce(response.promise);
    const refreshing = h.controller.handleAlarm(ALARM_REFRESH);
    await vi.waitFor(() => expect(create).toHaveBeenCalledOnce());
    await h.controller.updateSecurityPreferences(true, false);
    const schedule = vi.spyOn(h.alarms, "scheduleSession");
    response.reject(new ApiError("rate_limited", 429, 30));
    await refreshing;
    expect(h.securityStorage.state).toMatchObject({
      proxyCreationUncertain: false,
      retrySuspended: false,
      retryNotBefore: NOW + 540_000,
    });
    expect(schedule).toHaveBeenCalledWith(previous, NOW + 540_000);
    await h.controller.handleAlarm(ALARM_REFRESH);
    expect(create).toHaveBeenCalledOnce();
    h.setNow(NOW + 540_000);
    await h.controller.handleAlarm(ALARM_REFRESH);
    expect(create).toHaveBeenCalledTimes(2);
  });

  it("does not automatically retry a permanent late rejection", async () => {
    const h = await connectedHarness();
    const response = deferred<ProxySession>();
    const create = vi.spyOn(h.api, "createProxySession").mockReturnValueOnce(response.promise);
    const refreshing = h.controller.handleAlarm(ALARM_REFRESH);
    await vi.waitFor(() => expect(create).toHaveBeenCalledOnce());
    await h.controller.updateSecurityPreferences(true, false);
    const schedule = vi.spyOn(h.alarms, "scheduleSession");
    response.reject(new ApiError("subscription_required", 403));
    await refreshing;
    expect(schedule).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledOnce();
    expect(h.securityStorage.state?.retrySuspended).toBe(true);
  });

  it("does not erase genuine uncertainty from an earlier creation", async () => {
    const h = await connectedHarness();
    h.api.createError = new NetworkError("timeout");
    await h.controller.handleAlarm(ALARM_REFRESH);
    h.api.createError = null;
    const response = deferred<ProxySession>();
    const create = vi.spyOn(h.api, "createProxySession").mockReturnValueOnce(response.promise);
    const retry = h.controller.retryConnection();
    await vi.waitFor(() => expect(create).toHaveBeenCalledOnce());
    await h.controller.updateSecurityPreferences(true, false);
    const schedule = vi.spyOn(h.alarms, "scheduleSession");
    response.resolve(proxySession("discarded-manual-retry"));
    await retry;
    await h.controller.handleAlarm(ALARM_REFRESH);
    expect(create).toHaveBeenCalledOnce();
    expect(schedule).not.toHaveBeenCalled();
    expect(h.securityStorage.state?.proxyCreationUncertain).toBe(true);
  });

  it("repairs a discarded transient write using only the still-authorized session", async () => {
    const h = await connectedHarness();
    const previous = h.proxy.active!;
    const writing = deferred<undefined>();
    const release = deferred<undefined>();
    const write = h.storage.writeTransient.bind(h.storage);
    vi.spyOn(h.storage, "writeTransient").mockImplementationOnce(async (state) => {
      writing.resolve(undefined);
      await release.promise;
      await write(state);
    });
    h.api.sessions = [proxySession("discarded-during-write")];
    const refreshing = h.controller.handleAlarm(ALARM_REFRESH);
    await writing.promise;
    const settings = h.controller.updateSecurityPreferences(true, false);
    await Promise.resolve();
    release.resolve(undefined);
    await Promise.all([refreshing, settings]);
    expect(h.securityStorage.state?.proxyCreationUncertain).toBe(false);
    expect(h.storage.transient.proxySession).toEqual(previous);
    expect(h.proxy.active).toEqual(previous);
    expect(h.controller.getSnapshot().protected).toBe(true);
  });
});
