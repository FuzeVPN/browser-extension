// SPDX-License-Identifier: MPL-2.0

import { ApiError, NetworkError } from "../../src/core/api/client";
import {
  AUTH,
  authenticatedState,
  createHarness,
  INACTIVE_SUBSCRIPTION,
  proxySession,
} from "./helpers";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("audit: command results report the requested operation", () => {
  it("reports failed location change even when the previous connection is restored", async () => {
    const h = createHarness({ persisted: authenticatedState() });
    expect(await h.controller.connect("frankfurt-01")).toEqual({ ok: true });
    h.api.createError = new NetworkError("network");
    expect(await h.controller.changeLocation("frankfurt-02")).toEqual({
      ok: false,
      commandError: "proxy_creation_uncertain",
    });
    expect(h.controller.getSnapshot()).toMatchObject({
      protected: true,
      activeLocationId: "frankfurt-01",
    });
  });

  it("does not acknowledge a rejected connection or invalid location selection", async () => {
    const h = createHarness({ persisted: authenticatedState() });
    h.api.subscription = INACTIVE_SUBSCRIPTION;
    expect(await h.controller.connect("frankfurt-01")).toMatchObject({
      ok: false,
      commandError: "subscription_required",
    });
    expect(await h.controller.selectLocation("unavailable")).toEqual({
      ok: false,
      commandError: "invalid_location",
    });
  });

  it("distinguishes a superseded request from a successful connection", async () => {
    const h = createHarness({ persisted: authenticatedState() });
    const wait = deferred<undefined>();
    h.api.createWait = wait.promise;
    const connecting = h.controller.connect("frankfurt-01");
    await vi.waitFor(() => expect(h.api.proofs).toHaveLength(1));
    expect(await h.controller.disconnect()).toEqual({ ok: true });
    wait.resolve(undefined);
    expect(await connecting).toEqual({ ok: false, superseded: true });
    expect(h.controller.getSnapshot().protected).toBe(false);
  });

  it.each(["token_expired", "unknown_backend_code"])(
    "expires account on HTTP401 with %s",
    async (code) => {
      const h = createHarness({ persisted: authenticatedState() });
      await h.controller.connect("frankfurt-01");
      vi.spyOn(h.api, "getProfile").mockRejectedValue(new ApiError(code, 401));
      expect(await h.controller.refreshAccount()).toEqual({
        ok: false,
        commandError: "unauthorized",
      });
      expect(h.controller.getSnapshot()).toMatchObject({
        profile: null,
        protected: false,
        trafficBlocked: true,
        error: "unauthorized",
      });
    },
  );

  it("preserves invalid credentials feedback at login", async () => {
    const h = createHarness();
    h.api.loginError = new ApiError("invalid_credentials", 401);
    expect(await h.controller.login("client@example.com", "wrong")).toEqual({
      ok: false,
      commandError: "invalid_credentials",
    });
    expect(h.controller.getSnapshot().error).toBe("invalid_credentials");
  });

  it("returns the resend cooldown with the failed operation", async () => {
    const h = createHarness({ persisted: authenticatedState() });
    vi.spyOn(h.api, "resendVerification").mockRejectedValue(
      new ApiError("verification_email_cooldown", 429, 90),
    );
    expect(await h.controller.resendVerification()).toEqual({
      ok: false,
      commandError: "verification_email_cooldown",
      commandRetryAfterSeconds: 90,
    });
  });

  it("shows a rate limit and respects its header delay even without a JSON error code", async () => {
    const h = createHarness({ persisted: authenticatedState() });
    h.api.createError = new ApiError("server_error", 429, 120);
    expect(await h.controller.connect("frankfurt-01")).toEqual({
      ok: false,
      commandError: "rate_limited",
      commandRetryAfterSeconds: 120,
    });
    expect(h.controller.getSnapshot()).toMatchObject({
      error: "rate_limited",
      retryAfterSeconds: 120,
    });
    expect(h.securityStorage.state!.nextRetryAt).toBeGreaterThanOrEqual(
      h.securityStorage.state!.retryNotBefore!,
    );
  });

  it("deduplicates remote-device deletion and allows a later retry", async () => {
    const h = createHarness({ persisted: authenticatedState() });
    await h.controller.initialize();
    const wait = deferred<undefined>();
    const deleting = vi
      .spyOn(h.api, "deleteDevice")
      .mockReturnValueOnce(wait.promise)
      .mockResolvedValue(undefined);
    const first = h.controller.deleteDevice("remote-device");
    const repeated = h.controller.deleteDevice("remote-device");
    await vi.waitFor(() => expect(deleting).toHaveBeenCalledTimes(1));
    wait.resolve(undefined);
    expect(await first).toEqual({ ok: true });
    expect(await repeated).toEqual({ ok: true });
    await h.controller.deleteDevice("remote-device");
    expect(deleting).toHaveBeenCalledTimes(2);
  });

  it("does not reuse an old deletion command after the same account logs in again", async () => {
    const h = createHarness({ persisted: authenticatedState() });
    await h.controller.initialize();
    const wait = deferred<undefined>();
    const deleting = vi
      .spyOn(h.api, "deleteDevice")
      .mockReturnValueOnce(wait.promise)
      .mockResolvedValue(undefined);
    const old = h.controller.deleteDevice("remote-device");
    await vi.waitFor(() => expect(deleting).toHaveBeenCalledTimes(1));
    h.api.auth = { ...AUTH, accessToken: "new-account-session" };
    await h.controller.login("client@example.com", "test-password");
    expect(await h.controller.deleteDevice("remote-device")).toEqual({ ok: true });
    expect(deleting.mock.calls.map(([token]) => token)).toEqual([
      AUTH.accessToken,
      "new-account-session",
    ]);
    wait.resolve(undefined);
    expect(await old).toEqual({ ok: false, superseded: true });
  });

  it("treats an already absent remote device as deleted without resetting the browser identity", async () => {
    const h = createHarness({ persisted: authenticatedState() });
    await h.controller.connect("frankfurt-01");
    const clear = vi.spyOn(h.identity, "clear");
    vi.spyOn(h.api, "deleteDevice").mockRejectedValue(new ApiError("not_found", 404));
    expect(await h.controller.deleteDevice("remote-device")).toEqual({ ok: true });
    expect(clear).not.toHaveBeenCalled();
    expect(h.controller.getSnapshot().protected).toBe(true);
  });

  it("stops a current-device deletion if local disconnection fails", async () => {
    const h = createHarness({ persisted: authenticatedState() });
    await h.controller.connect("frankfurt-01");
    const deleting = vi.spyOn(h.api, "deleteDevice");
    vi.spyOn(h.proxy, "clear").mockRejectedValue(new Error("unavailable"));
    const result = await h.controller.deleteDevice("browser-device-1");
    expect(result.ok).toBe(false);
    expect(deleting).not.toHaveBeenCalled();
    expect(h.controller.getSnapshot().protected).toBe(false);
  });
});

describe("audit: repeated proxy authentication failure", () => {
  it("blocks a rejected live session and waits for an explicit retry", async () => {
    const h = createHarness({ persisted: authenticatedState() });
    await h.controller.connect("frankfurt-01");
    const session = (await h.controller.getActiveSession())!;
    await h.controller.handleProxyAuthenticationFailure(session);
    expect(h.controller.getSnapshot()).toMatchObject({
      status: "blocked",
      protected: false,
      trafficBlocked: true,
      error: "proxy_authentication_failed",
      nextRetryAt: null,
    });
    expect(await h.controller.getActiveSession()).toBeNull();
    expect(h.controller.isSessionCurrentForProxyAuth(session)).toBe(false);
    expect((await h.controller.retryConnection()).ok).toBe(true);
    expect(h.controller.getSnapshot().protected).toBe(true);
  });

  it("ignores an old session and a challenge after a proxy takeover", async () => {
    const h = createHarness({ persisted: authenticatedState() });
    await h.controller.connect("frankfurt-01");
    await h.controller.handleProxyAuthenticationFailure(proxySession("obsolete"));
    expect(h.controller.getSnapshot().protected).toBe(true);
    const session = (await h.controller.getActiveSession())!;
    h.proxy.level = "controlled_by_other_extensions";
    await h.controller.handleProxyAuthenticationFailure(session);
    expect(h.controller.getSnapshot().error).toBeNull();
    expect(h.api.revoked).not.toContain(session.id);
  });

  it("ignores a failure if a disconnect arrives during configuration verification", async () => {
    const h = createHarness({ persisted: authenticatedState() });
    await h.controller.connect("frankfurt-01");
    const session = (await h.controller.getActiveSession())!;
    const wait = deferred<boolean>();
    const verifying = vi.spyOn(h.proxy, "isActiveConfiguration").mockReturnValueOnce(wait.promise);
    const report = h.controller.handleProxyAuthenticationFailure(session);
    await vi.waitFor(() => expect(verifying).toHaveBeenCalled());
    const disconnect = h.controller.disconnect();
    await vi.waitFor(() => expect(h.controller.getSnapshot().status).toBe("disconnecting"));
    wait.resolve(true);
    await Promise.all([report, disconnect]);
    expect(h.controller.getSnapshot()).toMatchObject({
      status: "disconnected",
      error: null,
      protectionRequested: false,
    });
  });
});
