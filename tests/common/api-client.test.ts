// SPDX-License-Identifier: MPL-2.0

import { ApiClient, ApiError, NetworkError } from "../../src/core/api/client";
import { decodeLocations } from "../../src/core/api/types";

describe("API client", () => {
  const proof = {
    deviceId: "device-1",
    deviceTimestamp: 1_787_824_800,
    deviceNonce: "nonce-base64url",
    deviceSignature: "signature-base64url",
  };
  it("logs in using the deployed 201 contract and decodes the session", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(
          JSON.stringify({ access_token: "token", expires_at: "2026-09-25T12:00:00Z" }),
          { status: 201 },
        ),
      );
    const client = new ApiClient(fetchMock, "https://api.fuzevpn.com", 1_000);
    await expect(client.login("client@example.com", "not-persisted")).resolves.toEqual({
      accessToken: "token",
      expiresAt: "2026-09-25T12:00:00Z",
    });
    const request = fetchMock.mock.calls[0]?.[1];
    expect(new Headers(request?.headers).get("Authorization")).toBeNull();
  });

  it("invokes the native fetch implementation with the worker global context", async () => {
    let receiverWasGlobal = false;
    const receiverAwareFetch = function (this: unknown) {
      receiverWasGlobal = this === globalThis;
      return Promise.resolve(new Response(JSON.stringify({ locations: [] }), { status: 200 }));
    } as typeof fetch;
    const client = new ApiClient(receiverAwareFetch, "https://api.fuzevpn.com", 1_000);

    await expect(client.getLocations()).resolves.toEqual([]);
    expect(receiverWasGlobal).toBe(true);
  });

  it("uses typed application errors without exposing a raw response", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(JSON.stringify({ error: "subscription_required" }), { status: 403 }),
      );
    const client = new ApiClient(fetchMock, "https://api.fuzevpn.com", 1_000);
    await expect(
      client.createProxySession("secret-token", "frankfurt-01", proof),
    ).rejects.toMatchObject({
      code: "subscription_required",
      status: 403,
    } satisfies Partial<ApiError>);
  });

  it("accepts both creation and idempotent browser-device enrollment responses", async () => {
    const payload = {
      device_id: "device-1",
      name: "Chrome – Windows",
      kind: "browser_extension",
      created_at: "2026-08-27T12:00:00Z",
    };
    for (const status of [200, 201]) {
      const client = new ApiClient(
        vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(payload), { status })),
        "https://api.fuzevpn.com",
        1_000,
      );
      await expect(
        client.enrollBrowserDevice("token", "Chrome – Windows", "public-key"),
      ).resolves.toMatchObject({ deviceId: "device-1" });
    }
  });

  it("sends the complete signed device proof when creating a proxy session", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          id: "session-1",
          location_id: "frankfurt-01",
          scheme: "https",
          host: "frankfurt-01.proxy.vpn1euro.com",
          port: 443,
          username: "session-1",
          password: "temporary-secret",
          issued_at: "2026-08-27T12:00:00Z",
          expires_at: "2026-08-27T12:10:00Z",
          refresh_after_seconds: 510,
        }),
        { status: 201 },
      ),
    );
    const client = new ApiClient(fetchMock, "https://api.fuzevpn.com", 1_000);

    await client.createProxySession("secret-token", "frankfurt-01", proof);

    const body = fetchMock.mock.calls[0]?.[1]?.body;
    if (typeof body !== "string") throw new Error("expected JSON request body");
    expect(JSON.parse(body)).toEqual({
      location_id: "frankfurt-01",
      device_id: proof.deviceId,
      device_timestamp: proof.deviceTimestamp,
      device_nonce: proof.deviceNonce,
      device_signature: proof.deviceSignature,
    });
  });

  it("rejects malformed JSON responses", async () => {
    const client = new ApiClient(
      vi.fn<typeof fetch>().mockResolvedValue(new Response("not-json", { status: 200 })),
      "https://api.fuzevpn.com",
      1_000,
    );
    await expect(client.getLocations()).rejects.toMatchObject({
      kind: "invalid_response",
    } satisfies Partial<NetworkError>);
  });

  it("filters locations that do not advertise browser_proxy", () => {
    const decoded = decodeLocations({
      locations: [
        {
          id: "frankfurt-01",
          city: "Frankfurt",
          country_code: "DE",
          display_name: "Frankfurt 1",
          supported_protocols: ["wireguard", "browser_proxy"],
        },
        {
          id: "legacy",
          city: "Paris",
          country_code: "FR",
          display_name: "Paris",
          supported_protocols: ["wireguard"],
        },
      ],
    });
    expect(decoded?.map((location) => location.id)).toEqual(["frankfurt-01"]);
  });
});
