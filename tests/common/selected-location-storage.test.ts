// SPDX-License-Identifier: MPL-2.0

import { ExtensionStorageService } from "../../src/core/storage/storage";
import { popupSnapshot } from "../../src/ui/popup/snapshot";
import { EMPTY_SNAPSHOT } from "../../src/core/shared/state";
import { AUTH, PROFILE, LOCATIONS, authenticatedState } from "./helpers";

describe("selected location storage compatibility", () => {
  afterEach(() => vi.unstubAllGlobals());

  async function read(value: unknown) {
    vi.stubGlobal("browser", {
      storage: { local: { get: async () => ({ fuzevpnState: value }) } },
    });
    return new ExtensionStorageService().readPersisted();
  }

  it("reads older accounts without metadata without resetting authentication", async () => {
    const legacy = authenticatedState();
    delete legacy.selectedLocation;
    const state = await read(legacy);
    expect(state.auth).toEqual(AUTH);
    expect(state.selectedLocationId).toBe(LOCATIONS[0]!.id);
    expect(state.selectedLocation).toBeNull();
  });

  it("strips unexpected fields from both persisted metadata and popup responses", async () => {
    const selectedLocation = {
      ...LOCATIONS[0]!,
      password: "not-a-location-field",
      host: "private.invalid",
    };
    const state = await read({ ...authenticatedState(), selectedLocation });
    expect(state.selectedLocation).toEqual(LOCATIONS[0]);
    const snapshot = popupSnapshot({
      ...EMPTY_SNAPSHOT,
      profile: PROFILE,
      selectedLocationId: LOCATIONS[0]!.id,
      selectedLocation,
    });
    expect(snapshot.selectedLocation).toEqual(LOCATIONS[0]);
    expect(JSON.stringify(snapshot.selectedLocation)).not.toContain("password");
  });

  it.each([
    { selectedLocation: LOCATIONS[1] },
    { selectedLocation: { ...LOCATIONS[0]!, countryCode: "INVALID" } },
    { selectedLocation: { ...LOCATIONS[0]!, supportedProtocols: [false] } },
    { selectedLocation: { ...LOCATIONS[0]!, supportedProtocols: ["wireguard"] } },
    { selectedLocation: LOCATIONS[0], profile: null },
    { selectedLocation: LOCATIONS[0], auth: null },
  ])(
    "discards metadata with a mismatched identifier, malformed fields or no owner: %j",
    async (override) => {
      expect((await read({ ...authenticatedState(), ...override })).selectedLocation).toBeNull();
    },
  );
});
