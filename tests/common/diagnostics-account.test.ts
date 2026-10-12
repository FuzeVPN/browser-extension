// SPDX-License-Identifier: MPL-2.0

import { AppController } from "../../src/core/background/state-machine";
import { AUTH, NOW, PROFILE, authenticatedState, createHarness, proxySession } from "./helpers";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("read-only diagnostic account context", () => {
  it("does not initialize, restore credentials, migrate storage or apply network settings", async () => {
    const session = proxySession();
    const h = createHarness({
      persisted: authenticatedState(),
      transient: { proxySession: session, refreshAttempts: 0, retiredSessions: [] },
      activeProxy: session,
    });
    const initialize = vi.spyOn(h.controller, "initialize");
    const readPersisted = vi.spyOn(h.storage, "readPersisted");
    const readTransient = vi.spyOn(h.storage, "readTransient");
    const configure = vi.spyOn(h.storage, "configureTrustedContexts");
    const readSecurity = vi.spyOn(h.securityStorage, "read");
    const profile = vi.spyOn(h.api, "getProfile");
    const inspectProxy = vi.spyOn(h.proxy, "isActiveConfiguration");
    expect(h.controller.getDiagnosticAccount()).toBeNull();
    expect(h.controller.getDiagnosticReadState().snapshot.profile).toBeNull();
    expect(await h.controller.verifyDiagnosticProxy()).toBeNull();
    for (const spy of [
      initialize,
      readPersisted,
      readTransient,
      configure,
      readSecurity,
      profile,
      inspectProxy,
    ])
      expect(spy).not.toHaveBeenCalled();
    expect(h.proxy.applyCalls).toBe(0);
    expect(h.proxy.clearCalls).toBe(0);
    expect(h.safety.events).toEqual([]);
  });

  it("reads a loaded account and rejects its credential exactly at expiry without refreshing it", async () => {
    const h = createHarness({ persisted: authenticatedState() });
    await h.controller.initialize();
    const profile = vi.spyOn(h.api, "getProfile");
    const readPersisted = vi.spyOn(h.storage, "readPersisted");
    const expiry = Date.parse(AUTH.expiresAt);
    h.setNow(expiry - 1);
    expect(h.controller.getDiagnosticAccount()).toMatchObject({
      ownerId: PROFILE.userId,
      token: AUTH.accessToken,
      expiresAt: expiry,
    });
    h.setNow(expiry);
    expect(h.controller.getDiagnosticAccount()).toBeNull();
    expect(profile).not.toHaveBeenCalled();
    expect(readPersisted).not.toHaveBeenCalled();
    expect(h.storage.persisted.auth).toEqual(AUTH);
  });

  it("exposes no account during login or incomplete profile hydration", async () => {
    const h = createHarness({ persisted: authenticatedState() });
    await h.controller.initialize();
    const oldGeneration = h.controller.getDiagnosticAccount()!.generation;
    const authentication = deferred<typeof AUTH>();
    const hydration = deferred<typeof PROFILE>();
    const login = vi.spyOn(h.api, "login").mockReturnValueOnce(authentication.promise);
    const profile = vi.spyOn(h.api, "getProfile").mockReturnValueOnce(hydration.promise);
    const operation = h.controller.login("new@example.invalid", "synthetic");
    await vi.waitFor(() => expect(login).toHaveBeenCalledOnce());
    expect(h.controller.getDiagnosticAccount()).toBeNull();
    authentication.resolve({ ...AUTH, accessToken: "synthetic-new-token" });
    await vi.waitFor(() => expect(profile).toHaveBeenCalledOnce());
    expect(h.controller.getDiagnosticAccount()).toBeNull();
    hydration.resolve({ ...PROFILE, userId: "new-owner" });
    expect(await operation).toEqual({ ok: true });
    expect(h.controller.getDiagnosticAccount()).toMatchObject({
      ownerId: "new-owner",
      token: "synthetic-new-token",
    });
    expect(h.controller.getDiagnosticAccount()!.generation).toBeGreaterThan(oldGeneration);
  });

  it("invalidates account context synchronously when logout begins and never restores it during remote cleanup", async () => {
    const h = createHarness({ persisted: authenticatedState(), remoteCleanupTimeoutMs: 5_000 });
    await h.controller.initialize();
    expect(h.controller.getDiagnosticAccount()).not.toBeNull();
    const remote = deferred<undefined>();
    const logout = vi.spyOn(h.api, "logout").mockImplementation(async () => remote.promise);
    const operation = h.controller.logout();
    expect(h.controller.getDiagnosticAccount()).toBeNull();
    await vi.waitFor(() => expect(logout).toHaveBeenCalledOnce());
    expect(h.controller.getDiagnosticAccount()).toBeNull();
    remote.resolve(undefined);
    await operation;
    expect(h.controller.getDiagnosticAccount()).toBeNull();
  });

  it("returns detached read models that cannot mutate live account or safety state", async () => {
    const h = createHarness({ persisted: authenticatedState() });
    await h.controller.initialize();
    const initial = h.controller.getDiagnosticReadState();
    const modified = h.controller.getDiagnosticReadState();
    modified.snapshot.profile!.userId = "different-owner";
    modified.snapshot.siteExclusions.saved.entries.push({
      domain: "private.example.invalid",
      includeSubdomains: true,
    });
    modified.safety.trafficBlocked = !modified.safety.trafficBlocked;
    expect(h.controller.getDiagnosticReadState()).toEqual(initial);
    expect(h.controller.getDiagnosticAccount()!.ownerId).toBe(PROFILE.userId);
  });

  it("inspects only an already loaded proxy and discards a result after disconnection", async () => {
    const h = createHarness({ persisted: authenticatedState() });
    await h.controller.connect("frankfurt-01");
    expect(await h.controller.verifyDiagnosticProxy()).toBe(true);
    const readTransient = vi.spyOn(h.storage, "readTransient");
    const verification = deferred<boolean>();
    vi.spyOn(h.proxy, "isActiveConfiguration").mockReturnValueOnce(verification.promise);
    const pending = h.controller.verifyDiagnosticProxy();
    await h.controller.disconnect();
    verification.resolve(true);
    expect(await pending).toBeNull();
    expect(readTransient).not.toHaveBeenCalled();
  });

  it("does not inspect a loaded proxy after expiry", async () => {
    const h = createHarness({ persisted: authenticatedState() });
    await h.controller.connect("frankfurt-01");
    const inspectProxy = vi.spyOn(h.proxy, "isActiveConfiguration");
    h.setNow(NOW + 600_000);
    expect(await h.controller.verifyDiagnosticProxy()).toBeNull();
    expect(inspectProxy).not.toHaveBeenCalled();
  });

  it("contains a diagnostic observer failure without changing login behavior", async () => {
    const h = createHarness();
    const observer = vi.fn(() => {
      throw new Error("synthetic-observer-failure");
    });
    const controller = new AppController({
      api: h.api,
      storage: h.storage,
      identity: h.identity,
      proxy: h.proxy,
      alarms: h.alarms,
      securityStorage: h.securityStorage,
      safety: h.safety,
      now: () => NOW,
      onStateChanged: () => {},
      onDiagnosticAccountChanged: observer,
    });
    expect(await controller.login("test@example.invalid", "synthetic")).toEqual({ ok: true });
    expect(observer).toHaveBeenCalled();
    expect(controller.getDiagnosticAccount()).toMatchObject({
      ownerId: PROFILE.userId,
      token: AUTH.accessToken,
    });
  });
});
