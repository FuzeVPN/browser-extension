// SPDX-License-Identifier: MPL-2.0

import { ApiError } from "../../src/core/api/client";
import { authenticatedState, createHarness } from "./helpers";

type Harness = ReturnType<typeof createHarness>;

const ACCOUNT_READS = [
  [
    "refreshAccount",
    (h: Harness) => vi.spyOn(h.api, "getProfile"),
    (h: Harness) => h.controller.refreshAccount(),
  ],
  [
    "refreshDevices",
    (h: Harness) => vi.spyOn(h.api, "getDevices"),
    (h: Harness) => h.controller.refreshDevices(),
  ],
] as const;

async function connected() {
  const h = createHarness({ persisted: authenticatedState() });
  await h.controller.initialize();
  expect(await h.controller.connect("frankfurt-01")).toEqual({ ok: true });
  expect(h.controller.getSnapshot()).toMatchObject({
    status: "connected",
    protected: true,
    error: null,
  });
  return h;
}

describe("the status of a live connection across a failed account read", () => {
  afterEach(() => vi.restoreAllMocks());

  it.each(ACCOUNT_READS)(
    "is connected again once %s succeeds after a 503",
    async (_name, request, read) => {
      const h = await connected();
      const session = h.proxy.active!;

      request(h).mockRejectedValueOnce(new ApiError("server_error", 503));
      expect(await read(h)).toEqual({ ok: false, commandError: "proxy_unavailable" });
      // The account read failed; the VPN session itself is untouched.
      expect(h.proxy.active).toEqual(session);
      expect(h.storage.transient.proxySession).toEqual(session);
      expect(await h.controller.getActiveSession()).toEqual(session);
      expect(h.controller.getSnapshot()).toMatchObject({
        protected: true,
        activeLocationId: "frankfurt-01",
        error: "proxy_unavailable",
      });

      expect(await read(h)).toEqual({ ok: true });
      expect(h.proxy.active).toEqual(session);
      expect(h.controller.getSnapshot()).toMatchObject({ protected: true, error: null });
      expect(h.controller.getSnapshot().status).toBe("connected");
    },
  );
});
