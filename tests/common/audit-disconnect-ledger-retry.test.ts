// SPDX-License-Identifier: MPL-2.0

import { NetworkError } from "../../src/core/api/client";
import type { PendingProxyRevocation } from "../../src/core/storage/proxy-cleanup-storage";
import { AUTH, NOW, PROFILE, authenticatedState, createHarness } from "./helpers";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function cleanup(initial: PendingProxyRevocation[] = []) {
  let sessions = structuredClone(initial);
  return {
    async read() {
      return structuredClone(sessions);
    },
    async write(value: PendingProxyRevocation[]) {
      sessions = structuredClone(value);
    },
    get sessions() {
      return structuredClone(sessions);
    },
  };
}

const pending = (sessionId: string, userId = PROFILE.userId): PendingProxyRevocation => ({
  userId,
  sessionId,
  expiresAt: new Date(NOW + 600_000).toISOString(),
});
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("opportunistic disconnect cleanup after worker restart", () => {
  it("retries a durable failed revocation after restart without waiting for its response", async () => {
    const ledger = cleanup();
    const first = createHarness({ persisted: authenticatedState(), cleanupStorage: ledger });
    await first.controller.initialize();
    expect(await first.controller.connect("frankfurt-01")).toEqual({ ok: true });
    vi.spyOn(first.api, "revokeProxySession").mockRejectedValue(new NetworkError("network"));
    expect(await first.controller.disconnect()).toEqual({ ok: true });
    await settle();
    expect(ledger.sessions.map(({ sessionId }) => sessionId)).toEqual(["proxy-session-1"]);
    const restarted = createHarness({
      persisted: first.storage.persisted,
      security: first.securityStorage.state!,
      cleanupStorage: ledger,
    });
    await restarted.controller.initialize();
    const response = deferred();
    const revoke = vi
      .spyOn(restarted.api, "revokeProxySession")
      .mockImplementation(async () => response.promise);

    expect(await restarted.controller.disconnect()).toEqual({ ok: true });
    await settle();

    expect(revoke).toHaveBeenCalledExactlyOnceWith(AUTH.accessToken, "proxy-session-1");
    expect(restarted.controller.getSnapshot()).toMatchObject({
      status: "disconnected",
      protected: false,
      trafficBlocked: false,
    });
    expect(ledger.sessions).toHaveLength(1);
    response.resolve();
    await vi.waitFor(() => expect(ledger.sessions).toEqual([]));
  });

  it("only revokes live entries owned by the current account", async () => {
    const ledger = cleanup([
      pending("current-account"),
      pending("other-account", "another-user"),
      { ...pending("expired"), expiresAt: new Date(NOW - 1).toISOString() },
    ]);
    const h = createHarness({ persisted: authenticatedState(), cleanupStorage: ledger });
    const revoke = vi.spyOn(h.api, "revokeProxySession");
    await h.controller.initialize();

    expect(await h.controller.disconnect()).toEqual({ ok: true });
    await vi.waitFor(() => expect(revoke).toHaveBeenCalledTimes(1));

    expect(revoke).toHaveBeenCalledWith(AUTH.accessToken, "current-account");
    await vi.waitFor(() =>
      expect(ledger.sessions.map(({ sessionId }) => sessionId)).toEqual(["other-account"]),
    );
  });

  it("retains failed cleanup for the next disconnect and absorbs its rejection", async () => {
    const ledger = cleanup([pending("retry-later")]);
    const h = createHarness({ persisted: authenticatedState(), cleanupStorage: ledger });
    const revoke = vi
      .spyOn(h.api, "revokeProxySession")
      .mockRejectedValueOnce(new NetworkError("network"));
    await h.controller.initialize();

    expect(await h.controller.disconnect()).toEqual({ ok: true });
    await settle();
    expect(ledger.sessions.map(({ sessionId }) => sessionId)).toEqual(["retry-later"]);
    expect(await h.controller.disconnect()).toEqual({ ok: true });
    await vi.waitFor(() => expect(ledger.sessions).toEqual([]));
    expect(revoke).toHaveBeenCalledTimes(2);
  });

  it("keeps logout waiting for an in-flight opportunistic revocation before confirming cleanup", async () => {
    const ledger = cleanup([pending("logout-waits")]);
    const h = createHarness({ persisted: authenticatedState(), cleanupStorage: ledger });
    const response = deferred();
    const revoke = vi
      .spyOn(h.api, "revokeProxySession")
      .mockImplementation(async () => response.promise);
    const logoutApi = vi.spyOn(h.api, "logout");
    await h.controller.initialize();
    expect(await h.controller.disconnect()).toEqual({ ok: true });
    await settle();
    let completed = false;

    const loggingOut = h.controller.logout().then((result) => {
      completed = true;
      return result;
    });
    await settle();

    expect(completed).toBe(false);
    expect(logoutApi).not.toHaveBeenCalled();
    expect(revoke).toHaveBeenCalledTimes(1);
    response.resolve();
    expect(await loggingOut).toEqual({ ok: true });
    expect(logoutApi).toHaveBeenCalledExactlyOnceWith(AUTH.accessToken);
    expect(h.controller.getSnapshot().logoutOutcome).toEqual({
      apiSession: "confirmed",
      proxySessions: "confirmed",
    });
    expect(ledger.sessions).toEqual([]);
    expect(revoke).toHaveBeenCalledTimes(1);
  });
});
