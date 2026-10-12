// SPDX-License-Identifier: MPL-2.0

import { ExtensionStorageService } from "../../src/core/storage/storage";
import { LOCATIONS, proxySession } from "./helpers";

describe("active location metadata storage", () => {
  afterEach(() => vi.unstubAllGlobals());

  async function read(proxy: unknown, location?: unknown) {
    vi.stubGlobal("browser", {
      storage: {
        session: {
          get: async () => ({
            fuzevpnProxySession: {
              proxySession: proxy,
              activeLocation: location,
              refreshAttempts: 1,
              retiredSessions: [],
            },
          }),
        },
      },
    });
    return new ExtensionStorageService().readTransient();
  }

  it("restores the session label independently of the selectable catalog", async () => {
    const session = proxySession();
    const location = { ...LOCATIONS[0]!, id: session.locationId };
    expect(await read(session, location)).toMatchObject({
      proxySession: session,
      activeLocation: location,
    });
  });

  it.each([
    undefined,
    null,
    {},
    { ...LOCATIONS[0]!, id: "another-location" },
    { ...LOCATIONS[0]!, supportedProtocols: [false] },
    { ...LOCATIONS[0]!, countryCode: "INVALID" },
  ])(
    "ignores absent or invalid labels without losing a valid legacy session: %j",
    async (location) => {
      const session = proxySession();
      expect(await read(session, location)).toMatchObject({
        proxySession: session,
        activeLocation: null,
      });
    },
  );

  it("never restores a location label without a valid session", async () => {
    expect(await read(null, LOCATIONS[0])).toMatchObject({
      proxySession: null,
      activeLocation: null,
    });
  });

  it("keeps only the public location fields", async () => {
    const session = proxySession();
    const location = { ...LOCATIONS[0]!, id: session.locationId };
    const restored = await read(session, { ...location, privateMetadata: "discard" });
    expect(restored.activeLocation).toEqual(location);
    expect(restored.activeLocation?.supportedProtocols).not.toBe(location.supportedProtocols);
  });
});
