// SPDX-License-Identifier: MPL-2.0

import { isExtensionRequest, type ExtensionRequest } from "../../src/core/shared/messages";

describe("extension message validation", () => {
  it("accepts only versioned, canonical and bounded site exclusion updates", () => {
    const valid = {
      type: "update_site_exclusions",
      expectedRevision: 0,
      enabled: true,
      entries: [{ domain: "example.com", includeSubdomains: true }],
    };
    expect(isExtensionRequest(valid)).toBe(true);
    expect(isExtensionRequest({ type: "retry_site_exclusions" })).toBe(true);
    for (const expectedRevision of [undefined, -1, 0.5, "0", NaN])
      expect(isExtensionRequest({ ...valid, expectedRevision })).toBe(false);
    for (const entries of [
      null,
      "example.com",
      [{ domain: "EXAMPLE.COM", includeSubdomains: true }],
      [{ domain: "api.ipify.org", includeSubdomains: false }],
      Array(101).fill(valid.entries[0]),
    ])
      expect(isExtensionRequest({ ...valid, entries })).toBe(false);
    expect(isExtensionRequest({ ...valid, enabled: "true" })).toBe(false);
  });
  it("accepts every independent security preference combination", () => {
    for (const killSwitchEnabled of [false, true]) {
      for (const webRtcProtectionEnabled of [false, true]) {
        expect(
          isExtensionRequest({
            type: "update_security_preferences",
            killSwitchEnabled,
            webRtcProtectionEnabled,
          }),
        ).toBe(true);
      }
    }
  });

  it("requires both preferences to be booleans without truthiness coercion", () => {
    const invalid = [undefined, null, "false", "true", 0, 1, [], {}, new Boolean(false)];
    for (const value of invalid) {
      expect(
        isExtensionRequest({
          type: "update_security_preferences",
          killSwitchEnabled: value,
          webRtcProtectionEnabled: true,
        }),
      ).toBe(false);
      expect(
        isExtensionRequest({
          type: "update_security_preferences",
          killSwitchEnabled: false,
          webRtcProtectionEnabled: value,
        }),
      ).toBe(false);
    }
    expect(isExtensionRequest({ type: "update_security_preferences" })).toBe(false);
  });

  it("accepts typed web login, location and device commands", () => {
    const valid: ExtensionRequest[] = [
      { type: "web_login", disconnectFirst: false },
      { type: "web_login", disconnectFirst: true },
      { type: "connect", locationId: "frankfurt-01" },
      { type: "change_location", locationId: "frankfurt-02" },
      { type: "select_location", locationId: "frankfurt-01" },
      { type: "set_location_favorite", locationId: "frankfurt-01", favorite: true },
      { type: "delete_device", deviceId: "browser-device-1" },
    ];
    for (const value of valid) expect(isExtensionRequest(value)).toBe(true);
  });

  it("rejects malformed favorite changes", () => {
    for (const favorite of [undefined, null, "true", 1, [], {}]) {
      expect(
        isExtensionRequest({ type: "set_location_favorite", locationId: "fr", favorite }),
      ).toBe(false);
    }
    for (const locationId of [undefined, null, false, "", "a".repeat(201)]) {
      expect(
        isExtensionRequest({ type: "set_location_favorite", locationId, favorite: true }),
      ).toBe(false);
    }
  });

  it("rejects legacy password login commands", () => {
    const invalid = [undefined, null, false, 123, [], {}];
    for (const value of invalid) {
      expect(isExtensionRequest({ type: "login", email: value, password: "password" })).toBe(false);
      expect(
        isExtensionRequest({ type: "login", email: "client@example.com", password: value }),
      ).toBe(false);
    }
    expect(isExtensionRequest({ type: "login" })).toBe(false);
    expect(
      isExtensionRequest({ type: "login", email: "client@example.com", password: "password" }),
    ).toBe(false);
  });

  it("requires an explicit disconnect choice and never accepts web authentication secrets or URLs", () => {
    for (const value of [undefined, null, 0, "false", [], {}])
      expect(isExtensionRequest({ type: "web_login", disconnectFirst: value })).toBe(false);
    for (const key of [
      "url",
      "code",
      "state",
      "codeVerifier",
      "redirectUri",
      "clientId",
      "password",
    ])
      expect(
        isExtensionRequest({ type: "web_login", disconnectFirst: false, [key]: "untrusted" }),
      ).toBe(false);
  });

  it("requires a non-empty string identifier for every location and device command", () => {
    for (const type of ["connect", "change_location", "select_location", "delete_device"]) {
      const key = type === "delete_device" ? "deviceId" : "locationId";
      for (const value of [undefined, null, false, 123, "", [], {}]) {
        expect(isExtensionRequest({ type, [key]: value })).toBe(false);
      }
      expect(isExtensionRequest({ type })).toBe(false);
    }
  });

  it("accepts recovery actions without requiring account credentials", () => {
    for (const type of [
      "get_snapshot",
      "refresh_network",
      "select_automatic_location",
      "retry_connection",
      "disconnect",
      "logout",
      "resend_verification",
      "refresh_account",
      "refresh_locations",
      "refresh_devices",
      "reset_device_identity",
    ]) {
      expect(isExtensionRequest({ type })).toBe(true);
    }
  });

  it("rejects malformed envelopes and non-string or unknown command types", () => {
    for (const value of [
      undefined,
      null,
      false,
      42,
      "disconnect",
      [],
      {},
      { type: "unknown_command" },
      { type: undefined },
      { type: null },
      { type: 1 },
      { type: ["disconnect"] },
      { type: { toString: () => "disconnect" } },
    ]) {
      expect(isExtensionRequest(value)).toBe(false);
    }
  });
});
