// SPDX-License-Identifier: MPL-2.0

import { ExtensionProxyCleanupStorage } from "../../src/core/storage/proxy-cleanup-storage";
import { authenticatedState, createHarness, PROFILE } from "./helpers";

const CLEANUP_KEY = "fuzevpnPendingProxyRevocations";
const VALID_RECORD = { version: 1, sessions: [] };
// One entry lost its fields: the whole record is refused rather than partly forgotten.
const INVALID_RECORD = { version: 1, sessions: [{}] };

type Harness = ReturnType<typeof createHarness>;
type Stop = "disconnect" | "logout";

/** The browser's local storage, already holding a cleanup record. */
function browserStorage(record: unknown) {
  const data: Record<string, unknown> = { [CLEANUP_KEY]: record };
  vi.stubGlobal("browser", {
    storage: {
      local: {
        get: async () => structuredClone(data),
        set: async (value: Record<string, unknown>) => {
          Object.assign(data, structuredClone(value));
        },
      },
    },
  });
}

/** A worker over the real cleanup storage; a restarted one starts from the stores alone. */
function worker(previous?: Harness) {
  const h = createHarness({
    persisted: previous ? previous.storage.persisted : authenticatedState(),
    ...(previous ? { transient: previous.storage.transient } : {}),
    ...(previous?.securityStorage.state ? { security: previous.securityStorage.state } : {}),
    cleanupStorage: new ExtensionProxyCleanupStorage(),
  });
  if (previous) {
    // The browser keeps its traffic rules and proxy setting across the restart.
    h.safety.status = structuredClone(previous.safety.status);
    h.proxy.level = previous.proxy.level;
    h.proxy.blockingRoute = previous.proxy.blockingRoute;
  }
  return h;
}

/** The next worker, in which the user signs in again if needed and connects. */
async function connectInNextWorker(previous: Harness, stop: Stop) {
  const next = worker(previous);
  await next.controller.initialize();
  if (stop === "logout")
    expect(await next.controller.login(PROFILE.email, "synthetic")).toEqual({ ok: true });
  expect(await next.controller.connect("frankfurt-01")).toEqual({ ok: true });
  expect(next.controller.getSnapshot()).toMatchObject({
    status: "connected",
    protected: true,
    trafficBlocked: false,
    error: null,
  });
}

describe("a stored proxy cleanup record which cannot be read back", () => {
  afterEach(() => vi.unstubAllGlobals());

  it.each<Stop>(["disconnect", "logout"])(
    "connects in the next worker after an explicit %s while the record is valid",
    async (stop) => {
      browserStorage(VALID_RECORD);
      const first = worker();
      await first.controller.initialize();
      expect(first.controller.getSnapshot()).toMatchObject({
        status: "disconnected",
        trafficBlocked: false,
        error: null,
      });

      expect(await first.controller[stop]()).toEqual({ ok: true });

      await connectInNextWorker(first, stop);
    },
  );

  it.each<Stop>(["disconnect", "logout"])(
    "lets the next worker connect once an explicit %s recorded its unknown cleanup",
    async (stop) => {
      browserStorage(INVALID_RECORD);
      // Nothing is forgotten silently: the storage refuses the whole record.
      await expect(new ExtensionProxyCleanupStorage().read()).rejects.toThrow(
        "proxy_cleanup_storage_invalid",
      );
      const first = worker();
      await first.controller.initialize();

      // The explicit stop releases the guard and durably reports the cleanup as unknown.
      expect(await first.controller[stop]()).toEqual({ ok: true });
      expect(first.controller.getSnapshot()).toMatchObject({
        protectionRequested: false,
        trafficBlocked: false,
        error: null,
      });
      expect(first.securityStorage.state?.proxyCleanupUncertain).toBe(true);
      if (stop === "logout")
        expect(first.controller.getSnapshot().logoutOutcome?.proxySessions).toBe("unconfirmed");

      // A record which nobody can read must not keep refusing every later worker.
      await connectInNextWorker(first, stop);
    },
  );
});
