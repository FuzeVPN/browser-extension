// SPDX-License-Identifier: MPL-2.0

import { ProxyControlError } from "../../src/core/background/proxy-controller";
import { ALARM_RECONNECT } from "../../src/core/shared/config";
import { authenticatedState, createHarness, NOW, proxySession } from "./helpers";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("initial connection ownership after permission changes", () => {
  afterEach(() => vi.restoreAllMocks());

  it("restarts a connection cancelled before its signed request was sent", async () => {
    const h = createHarness({ persisted: authenticatedState() });
    await h.controller.initialize();
    await h.controller.refreshAccount();
    h.identity.deviceId = "browser-device-1";
    const proof = await h.identity.createProof(
      "user-test",
      "browser-device-1",
      "frankfurt-01",
      NOW,
    );
    const signing = deferred<typeof proof>();
    const signer = vi.spyOn(h.identity, "createProof").mockReturnValueOnce(signing.promise);
    const create = vi.spyOn(h.api, "createProxySession");
    const connecting = h.controller.connect("frankfurt-01");
    await vi.waitFor(() => expect(signer).toHaveBeenCalledOnce());

    await h.controller.handleProxyPermissionsChanged();
    signing.resolve(proof);
    expect(await connecting).toEqual({ ok: false, superseded: true });
    expect(create).toHaveBeenCalledOnce();
    expect(h.controller.getSnapshot()).toMatchObject({ status: "connected", protected: true });
    expect(h.api.revoked).not.toContain(h.proxy.active!.id);
  });

  it("waits for a sent request before obtaining replacement credentials", async () => {
    const h = createHarness({ persisted: authenticatedState() });
    await h.controller.initialize();
    await h.controller.refreshAccount();
    const response = deferred<ReturnType<typeof proxySession>>();
    const create = vi.spyOn(h.api, "createProxySession").mockReturnValueOnce(response.promise);
    const connecting = h.controller.connect("frankfurt-01");
    await vi.waitFor(() => expect(create).toHaveBeenCalledOnce());

    await h.controller.handleProxyPermissionsChanged();
    expect(create).toHaveBeenCalledOnce();
    response.resolve(proxySession("discarded-permissions-request"));
    expect(await connecting).toEqual({ ok: false, superseded: true });
    expect(h.api.revoked).toContain("discarded-permissions-request");
    expect(h.alarms.reconnectAt).toBe(NOW + 1_000);
    h.setNow(NOW + 1_000);
    await h.controller.handleAlarm(ALARM_RECONNECT);
    expect(create).toHaveBeenCalledTimes(2);
    expect(h.controller.getSnapshot()).toMatchObject({ status: "connected", protected: true });
    expect(h.api.revoked).not.toContain(h.proxy.active!.id);
  });

  it("keeps a real permission loss suspended instead of retrying automatically", async () => {
    const h = createHarness({ persisted: authenticatedState() });
    await h.controller.initialize();
    await h.controller.refreshAccount();
    h.identity.deviceId = "browser-device-1";
    const proof = await h.identity.createProof(
      "user-test",
      "browser-device-1",
      "frankfurt-01",
      NOW,
    );
    const signing = deferred<typeof proof>();
    const signer = vi.spyOn(h.identity, "createProof").mockReturnValueOnce(signing.promise);
    const create = vi.spyOn(h.api, "createProxySession");
    const connecting = h.controller.connect("frankfurt-01");
    await vi.waitFor(() => expect(signer).toHaveBeenCalledOnce());
    vi.spyOn(h.proxy, "assertControllable").mockRejectedValue(
      new ProxyControlError("host_permissions_required"),
    );
    await h.controller.handleProxyPermissionsChanged();
    signing.resolve(proof);
    expect(await connecting).toEqual({ ok: false, superseded: true });
    expect(create).not.toHaveBeenCalled();
    expect(h.controller.getSnapshot()).toMatchObject({
      protected: false,
      trafficBlocked: true,
      error: "host_permissions_required",
      nextRetryAt: null,
    });
  });

  it("does not resume after an explicit disconnect while the discarded request settles", async () => {
    const h = createHarness({ persisted: authenticatedState() });
    await h.controller.initialize();
    await h.controller.refreshAccount();
    const response = deferred<ReturnType<typeof proxySession>>();
    const create = vi.spyOn(h.api, "createProxySession").mockReturnValueOnce(response.promise);
    const connecting = h.controller.connect("frankfurt-01");
    await vi.waitFor(() => expect(create).toHaveBeenCalledOnce());
    await h.controller.handleProxyPermissionsChanged();
    expect(await h.controller.disconnect()).toEqual({ ok: true });
    response.resolve(proxySession("discarded-after-stop"));
    expect(await connecting).toEqual({ ok: false, superseded: true });
    expect(h.alarms.reconnectAt).toBeNull();
    expect(h.controller.getSnapshot()).toMatchObject({
      status: "disconnected",
      protectionRequested: false,
      protected: false,
      trafficBlocked: false,
    });
    expect(h.api.revoked).toContain("discarded-after-stop");
  });
});
