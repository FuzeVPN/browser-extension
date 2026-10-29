// SPDX-License-Identifier: MPL-2.0

import { ALARM_REFRESH, MAX_REFRESH_ATTEMPTS } from "../../src/core/shared/config";
import { NOW, authenticatedState, createHarness, proxySession } from "./helpers";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("renewal ownership after a discarded location write", () => {
  afterEach(() => vi.restoreAllMocks());

  it.each([2, MAX_REFRESH_ATTEMPTS])(
    "preserves the retained session's %s attempts and exact retry deadline",
    async (attempts) => {
      const previous = proxySession("retained-original");
      const retryAt = NOW + 550_000;
      const h = createHarness({
        persisted: authenticatedState({ autoConnect: true }),
        transient: {
          proxySession: previous,
          refreshAttempts: attempts,
          refreshRetryAt: retryAt,
          retiredSessions: [],
        },
        activeProxy: previous,
      });
      h.identity.deviceId = "browser-device-1";
      await h.controller.initialize();
      await h.controller.refreshAccount();
      h.setNow(NOW + 510_000);
      const replacement = proxySession(
        "discarded-location",
        "frankfurt-02",
        new Date(NOW + 510_000).toISOString(),
        new Date(NOW + 1_110_000).toISOString(),
      );
      h.api.sessions = [replacement];
      const entered = deferred();
      const release = deferred();
      const write = h.storage.writeTransient.bind(h.storage);
      vi.spyOn(h.storage, "writeTransient").mockImplementation(async (state) => {
        if (state.proxySession?.id === replacement.id) {
          entered.resolve();
          await release.promise;
        }
        await write(state);
      });
      const selecting = h.controller.changeLocation(replacement.locationId);
      await entered.promise;
      const operation = h.controller as unknown as { operationId: number };
      const selectingId = operation.operationId;
      const settings = h.controller.updateSecurityPreferences(true, false);
      await vi.waitFor(() => expect(operation.operationId).toBeGreaterThan(selectingId));
      release.resolve();
      expect(await selecting).toEqual({ ok: false, superseded: true });
      expect(await settings).toEqual({ ok: true });

      expect(h.storage.transient).toMatchObject({
        proxySession: { id: previous.id },
        refreshAttempts: attempts,
        refreshRetryAt: retryAt,
      });
      expect(h.proxy.active?.id).toBe(previous.id);
      expect(h.api.revoked).toContain(replacement.id);
      expect(h.api.revoked).not.toContain(previous.id);
      expect(h.alarms.retryAt).toBe(attempts === MAX_REFRESH_ATTEMPTS ? null : retryAt);
      const create = vi.spyOn(h.api, "createProxySession");
      h.setNow(retryAt - 1);
      await h.controller.handleAlarm(ALARM_REFRESH);
      expect(create).not.toHaveBeenCalled();
      h.setNow(retryAt);
      await h.controller.handleAlarm(ALARM_REFRESH);
      expect(create).toHaveBeenCalledTimes(attempts === MAX_REFRESH_ATTEMPTS ? 0 : 1);
    },
  );
});
