// SPDX-License-Identifier: MPL-2.0

import { NetworkError } from "../../src/core/api/client";
import { AUTH, authenticatedState, createHarness, PROFILE } from "./helpers";

type Harness = ReturnType<typeof createHarness>;

/** A login whose account read failed keeps its credential without a profile. */
async function credentialWithoutProfile() {
  const h = createHarness();
  await h.controller.initialize();
  vi.spyOn(h.api, "getProfile").mockRejectedValueOnce(new NetworkError("network"));
  expect(await h.controller.login(PROFILE.email, "synthetic")).toEqual({
    ok: false,
    commandError: "network_error",
  });
  expect(h.storage.persisted).toMatchObject({ auth: AUTH, profile: null });
  expect(h.controller.getSnapshot().profile).toBeNull();
  return h;
}

/** A signed-in account whose API credential expired while this worker stayed alive. */
async function expiredCredential() {
  const h = createHarness({ persisted: authenticatedState() });
  await h.controller.initialize();
  expect(h.controller.getSnapshot()).toMatchObject({ status: "disconnected", profile: PROFILE });
  h.setNow(Date.parse(AUTH.expiresAt));
  return h;
}

const DEVICE_COMMANDS = [
  ["deleteDevice", (h: Harness) => h.controller.deleteDevice("remote-device")],
  ["resetDeviceIdentity", (h: Harness) => h.controller.resetDeviceIdentity()],
] as const;

describe("device commands without a usable account", () => {
  afterEach(() => vi.restoreAllMocks());

  it("reports a device list refresh without a profile as a failed command", async () => {
    const h = await credentialWithoutProfile();
    await expect(h.controller.refreshDevices()).resolves.toEqual({
      ok: false,
      commandError: "unauthorized",
    });
  });

  it.each(DEVICE_COMMANDS)(
    "reports %s without a profile as a failed command",
    async (_name, command) => {
      const h = await credentialWithoutProfile();
      await expect(command(h)).resolves.toMatchObject({ ok: false });
    },
  );

  it("reports a device list refresh with an expired credential as a failed command", async () => {
    const h = await expiredCredential();
    await expect(h.controller.refreshDevices()).resolves.toEqual({
      ok: false,
      commandError: "api_token_expired",
    });
  });

  it("reports deleteDevice with an expired credential as a failed command", async () => {
    const h = await expiredCredential();
    await expect(h.controller.deleteDevice("remote-device")).resolves.toMatchObject({ ok: false });
  });
});
