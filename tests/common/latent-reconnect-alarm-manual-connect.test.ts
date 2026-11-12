// SPDX-License-Identifier: MPL-2.0

import { ApiError } from "../../src/core/api/client";
import { ALARM_RECONNECT } from "../../src/core/shared/config";
import { authenticatedState, createHarness, NOW, PROFILE } from "./helpers";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

afterEach(() => vi.restoreAllMocks());

describe("a reconnect alarm falling due during a manual connection", () => {
  it("does not replace the manual attempt before its session request", async () => {
    const h = createHarness({ persisted: authenticatedState() });
    await h.controller.initialize();
    const slowAccount = deferred();
    const getProfile = vi
      .spyOn(h.api, "getProfile")
      .mockRejectedValueOnce(new ApiError("server_error", 503))
      .mockImplementationOnce(async () => {
        await slowAccount.promise;
        return PROFILE;
      });

    // A failed attempt schedules its automatic retry.
    expect(await h.controller.connect("frankfurt-01")).toMatchObject({ ok: false });
    expect(h.alarms.reconnectAt).toBe(NOW + 30_000);
    expect(h.api.proofs).toHaveLength(0);

    // The user retries by hand just before that deadline, on a slow account read.
    h.setNow(NOW + 29_000);
    const manual = h.controller.connect("frankfurt-01");
    await vi.waitFor(() => expect(getProfile).toHaveBeenCalledTimes(2));
    expect(h.controller.getSnapshot().status).toBe("connecting");

    // The alarm of the earlier failure fires while the manual attempt is in progress.
    h.setNow(NOW + 30_000);
    const alarm = h.controller.handleAlarm(ALARM_RECONNECT);
    await Promise.race([alarm, new Promise((resolve) => setTimeout(resolve, 50))]);
    slowAccount.resolve();

    expect(await manual).toEqual({ ok: true });
    await alarm;
    expect(h.api.proofs).toHaveLength(1);
    expect(h.controller.getSnapshot()).toMatchObject({
      status: "connected",
      protected: true,
      error: null,
    });
  });
});
