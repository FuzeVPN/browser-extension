// SPDX-License-Identifier: MPL-2.0

import { NetworkError } from "../../src/core/api/client";
import { DEFAULT_SECURITY_STATE } from "../../src/core/shared/security";
import { emptySiteExclusionRecord } from "../../src/core/storage/site-exclusion-storage";
import { AUTH, PROFILE, authenticatedState, createHarness } from "./helpers";

describe("audit follow-up: account ownership", () => {
  it("rejects a stale login before authenticating or replacing an active account", async () => {
    const h = createHarness({ persisted: authenticatedState() });
    await h.controller.connect("frankfurt-01");
    const persisted = structuredClone(h.storage.persisted);
    const session = await h.controller.getActiveSession();
    const login = vi.spyOn(h.api, "login");
    h.api.auth = { ...AUTH, accessToken: "synthetic-account-b" };
    h.api.profile = { ...PROFILE, userId: "account-b" };
    expect(await h.controller.login("b@example.invalid", "synthetic")).toEqual({
      ok: false,
      commandError: "login_requires_disconnect",
    });
    expect(login).not.toHaveBeenCalled();
    expect(h.storage.persisted).toEqual(persisted);
    expect(await h.controller.getActiveSession()).toEqual(session);
    expect(h.controller.getSnapshot()).toMatchObject({ protected: true, profile: PROFILE });
  });

  it("does not publish the previous account when a disconnected replacement fails hydration", async () => {
    const h = createHarness({ persisted: authenticatedState() });
    await h.controller.initialize();
    h.api.auth = { ...AUTH, accessToken: "synthetic-account-b" };
    vi.spyOn(h.api, "getProfile").mockRejectedValue(new NetworkError("network"));
    expect(await h.controller.login("b@example.invalid", "synthetic")).toMatchObject({ ok: false });
    expect(h.storage.persisted.profile).toBeNull();
    expect(h.controller.getSnapshot()).toMatchObject({
      profile: null,
      subscription: null,
      devices: [],
      currentDeviceId: null,
      protected: false,
      error: "network_error",
    });
  });

  it("allows a new account after an explicit disconnect", async () => {
    const h = createHarness({ persisted: authenticatedState() });
    await h.controller.connect("frankfurt-01");
    await h.controller.disconnect();
    h.api.auth = { ...AUTH, accessToken: "synthetic-account-b" };
    h.api.profile = { ...PROFILE, userId: "account-b" };
    expect(await h.controller.login("b@example.invalid", "synthetic")).toEqual({ ok: true });
    expect(h.controller.getSnapshot().profile?.userId).toBe("account-b");
  });

  it("allows retrying failed login hydration without disabling an accountless guard", async () => {
    const h = createHarness({ security: { ...DEFAULT_SECURITY_STATE, protectionRequested: true } });
    await h.controller.initialize();
    vi.spyOn(h.api, "getProfile").mockRejectedValueOnce(new NetworkError("network"));
    expect(await h.controller.login("test@example.invalid", "synthetic")).toMatchObject({
      ok: false,
      commandError: "network_error",
    });
    expect(h.controller.getSnapshot()).toMatchObject({ profile: null, trafficBlocked: true });
    expect(await h.controller.login("test@example.invalid", "synthetic")).toEqual({ ok: true });
    expect(h.controller.getSnapshot()).toMatchObject({ profile: PROFILE, protected: true });
    expect(h.safety.events).not.toContain("release");
  });

  it("does not replace the in-memory credential when saving a new account fails", async () => {
    const h = createHarness({ persisted: authenticatedState() });
    await h.controller.initialize();
    h.api.auth = { ...AUTH, accessToken: "synthetic-account-b" };
    vi.spyOn(h.storage, "writePersisted").mockRejectedValueOnce(new Error("unavailable"));
    expect(await h.controller.login("b@example.invalid", "synthetic")).toMatchObject({ ok: false });
    const profile = vi.spyOn(h.api, "getProfile");
    await h.controller.refreshAccount();
    expect(profile).toHaveBeenCalledWith(AUTH.accessToken, expect.any(AbortSignal));
    expect(h.storage.persisted.auth).toEqual(AUTH);
  });
});

describe("audit follow-up: unread startup storage", () => {
  it("retries a failed initial read and preserves the account on recovery disconnect", async () => {
    const h = createHarness({ persisted: authenticatedState() });
    const persisted = structuredClone(h.storage.persisted);
    const read = vi
      .spyOn(h.storage, "readPersisted")
      .mockRejectedValueOnce(new Error("unavailable"));
    const write = vi.spyOn(h.storage, "writePersisted");
    await h.controller.initialize();
    expect(h.storage.persisted).toEqual(persisted);
    expect(write).not.toHaveBeenCalled();
    expect(h.controller.getSnapshot()).toMatchObject({
      trafficBlocked: true,
      error: "storage_unavailable",
    });
    expect(await h.controller.disconnect()).toEqual({ ok: true });
    expect(read).toHaveBeenCalledTimes(2);
    expect(h.storage.persisted.auth).toEqual(AUTH);
    expect(h.controller.getSnapshot()).toMatchObject({ status: "disconnected", profile: PROFILE });
    expect(h.api.proofs).toHaveLength(0);
  });

  it("does not overwrite unread stores or authenticate while storage remains unavailable", async () => {
    const h = createHarness({ persisted: authenticatedState() });
    vi.spyOn(h.storage, "readPersisted").mockRejectedValue(new Error("unavailable"));
    const write = vi.spyOn(h.storage, "writePersisted");
    const securityWrite = vi.spyOn(h.securityStorage, "write");
    const login = vi.spyOn(h.api, "login");
    await h.controller.initialize();
    for (const command of [
      () => h.controller.disconnect(),
      () => h.controller.logout(),
      () => h.controller.login("test@example.invalid", "synthetic"),
    ])
      expect(await command()).toEqual({ ok: false, commandError: "storage_unavailable" });
    expect(write).not.toHaveBeenCalled();
    expect(securityWrite).not.toHaveBeenCalled();
    expect(login).not.toHaveBeenCalled();
    expect(h.storage.persisted.auth).toEqual(AUTH);
    expect(h.controller.getSnapshot().trafficBlocked).toBe(true);
  });

  it("preserves security preferences when their initial read fails", async () => {
    const h = createHarness({ persisted: authenticatedState() });
    vi.spyOn(h.securityStorage, "read").mockRejectedValueOnce(new Error("unavailable"));
    const write = vi.spyOn(h.securityStorage, "write");
    await h.controller.initialize();
    expect(write).not.toHaveBeenCalled();
    await h.controller.initialize();
    expect(h.controller.getSnapshot()).toMatchObject({ profile: PROFILE, status: "disconnected" });
    expect(h.storage.persisted.auth).toEqual(AUTH);
  });

  it("never releases a pre-existing guard when retrying an unread disconnected preference", async () => {
    const h = createHarness({ persisted: authenticatedState() });
    h.safety.status = { trafficBlocked: true, filterActive: true, webRtcProtected: true };
    vi.spyOn(h.storage, "readPersisted").mockRejectedValueOnce(new Error("unavailable"));
    h.api.createError = new NetworkError("network");
    await h.controller.initialize();
    await h.controller.initialize();
    expect(h.controller.getSnapshot()).toMatchObject({
      protectionRequested: true,
      trafficBlocked: true,
    });
    expect(h.safety.events).not.toContain("release");
    expect(h.proxy.clearCalls).toBe(0);
  });

  it("treats an unverifiable previous guard conservatively on startup retry", async () => {
    const h = createHarness({ persisted: authenticatedState() });
    vi.spyOn(h.storage, "readPersisted").mockRejectedValueOnce(new Error("unavailable"));
    vi.spyOn(h.safety, "inspect").mockRejectedValueOnce(new Error("unavailable"));
    h.api.createError = new NetworkError("network");
    await h.controller.initialize();
    await h.controller.initialize();
    expect(h.controller.getSnapshot()).toMatchObject({
      protectionRequested: true,
      trafficBlocked: true,
    });
    expect(h.safety.events).not.toContain("release");
  });

  it("preserves an existing guard while finishing a pending exclusions journal after an unread startup", async () => {
    let record = { ...emptySiteExclusionRecord(), pending: true };
    record.saved.revision = 1;
    const h = createHarness({
      persisted: authenticatedState(),
      siteExclusionStorage: {
        read: async () => structuredClone(record),
        write: async (value) => {
          record = structuredClone(value);
        },
      },
    });
    h.safety.status = { trafficBlocked: true, filterActive: true, webRtcProtected: true };
    vi.spyOn(h.storage, "readPersisted").mockRejectedValueOnce(new Error("unavailable"));
    h.api.createError = new NetworkError("network");
    await h.controller.initialize();
    await h.controller.initialize();
    expect(record.pending).toBe(false);
    expect(h.controller.getSnapshot()).toMatchObject({
      protectionRequested: true,
      trafficBlocked: true,
    });
    expect(h.safety.events).not.toContain("release");
    expect(h.proxy.clearCalls).toBe(0);
  });

  it("preserves a guard when Chrome inspection returns an unverified scope instead of throwing", async () => {
    const h = createHarness({ persisted: authenticatedState() });
    h.safety.status = { trafficBlocked: true, filterActive: true, webRtcProtected: true };
    vi.spyOn(h.storage, "readPersisted").mockRejectedValueOnce(new Error("unavailable"));
    // FirefoxNetworkSafety.inspect catches native read failures and reports this state.
    vi.spyOn(h.safety, "inspect").mockResolvedValueOnce({
      trafficBlocked: false,
      filterActive: false,
      webRtcProtected: false,
      blockingScope: "unverified",
    });
    h.api.createError = new NetworkError("network");
    await h.controller.initialize();
    await h.controller.initialize();
    expect(h.controller.getSnapshot()).toMatchObject({
      protectionRequested: true,
      trafficBlocked: true,
    });
    expect(h.safety.events).not.toContain("release");
    expect(h.proxy.clearCalls).toBe(0);
  });
});
