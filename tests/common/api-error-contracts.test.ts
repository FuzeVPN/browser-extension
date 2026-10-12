// SPDX-License-Identifier: MPL-2.0

import { ApiClient, ApiError, ProxyCreationUncertainError } from "../../src/core/api/client";

describe("HTTP error contracts", () => {
  const proof = {
    deviceId: "device-1",
    deviceTimestamp: 1_787_824_800,
    deviceNonce: "nonce-base64url",
    deviceSignature: "signature-base64url",
  };

  it.each([400, 401, 403, 409, 429, 500, 503])(
    "preserves a non-JSON HTTP %i rejection without retaining the raw body",
    async (status) => {
      const client = responseClient(status, "<html>private gateway detail</html>");
      const error: unknown = await client.getProfile("token").catch((value: unknown) => value);
      expect(error).toBeInstanceOf(ApiError);
      expect(error).toMatchObject({ status, code: "server_error" });
      expect(JSON.stringify(error)).not.toContain("private gateway detail");
    },
  );

  it.each(["", "{", "null"])("retains the 401 status with body %j", async (body) => {
    await expect(responseClient(401, body).getProfile("token")).rejects.toMatchObject({
      name: "ApiError",
      status: 401,
    });
  });

  it.each(["expired_token", "unrecognized_auth_error"])(
    "retains the 401 status independently of business code %s",
    async (error) => {
      await expect(
        responseClient(401, JSON.stringify({ error })).getProfile("token"),
      ).rejects.toMatchObject({ name: "ApiError", status: 401, code: error });
    },
  );

  it("preserves invalid_credentials on a rejected login", async () => {
    await expect(
      responseClient(401, '{"error":"invalid_credentials"}').login("test@example.invalid", "wrong"),
    ).rejects.toMatchObject({ name: "ApiError", status: 401, code: "invalid_credentials" });
  });

  it.each([401, 403, 429])(
    "does not classify a reliable HTML HTTP %i rejection as an uncertain creation",
    async (status) => {
      const error: unknown = await responseClient(status, "<h1>Rejected</h1>")
        .createProxySession("token", "location", proof)
        .catch((value: unknown) => value);
      expect(error).toBeInstanceOf(ApiError);
      expect(error).not.toBeInstanceOf(ProxyCreationUncertainError);
      expect(error).toMatchObject({ status });
    },
  );

  it("keeps HTTP 5xx creation uncertainty even when Retry-After is present", async () => {
    await expect(
      responseClient(503, "<h1>Gateway failure</h1>", "120").createProxySession(
        "token",
        "location",
        proof,
      ),
    ).rejects.toBeInstanceOf(ProxyCreationUncertainError);
  });
});

describe("Retry-After response header", () => {
  const now = Date.parse("2026-09-12T12:00:00.250Z");
  beforeEach(() => {
    vi.spyOn(Date, "now").mockReturnValue(now);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([429, 503])("uses seconds from an HTML HTTP %i response", async (status) => {
    await expect(
      responseClient(status, "<h1>Try later</h1>", "120").getLocations(),
    ).rejects.toMatchObject({ status, retryAfterSeconds: 120 });
  });

  it.each([
    ["0", 0],
    [" 00120 ", 120],
    ["2592000", 2_592_000],
    ["Sat, 12 Sep 2026 12:02:00 GMT", 120],
    ["Saturday, 12-Sep-26 12:02:00 GMT", 120],
    ["Sat Sep 12 12:02:00 2026", 120],
    ["Sat, 12 Sep 2026 11:00:00 GMT", 0],
  ])("gives valid header %j precedence over the JSON delay", async (header, seconds) => {
    await expect(
      responseClient(
        429,
        '{"error":"rate_limited","retry_after_seconds":900}',
        header,
      ).getLocations(),
    ).rejects.toMatchObject({ code: "rate_limited", retryAfterSeconds: seconds });
  });

  it.each([
    null,
    "",
    "-1",
    "1.5",
    "+120",
    "NaN",
    "Infinity",
    "1e3",
    "2026-09-12",
    "not a date",
    "999999999999999999999999999999",
    "Sat, 31 Feb 2026 12:00:00 GMT",
  ])("falls back to JSON for missing, invalid or unrepresentable header %j", async (header) => {
    await expect(
      responseClient(
        429,
        '{"error":"rate_limited","retry_after_seconds":90.2}',
        header,
      ).getLocations(),
    ).rejects.toMatchObject({ retryAfterSeconds: 91 });
  });

  it.each(["-1", "1e309", "9007199254740991", '"120"', "null"])(
    "ignores invalid or unrepresentable JSON delay %s without an invented deadline",
    async (retry) => {
      await expect(
        responseClient(
          429,
          `{"error":"rate_limited","retry_after_seconds":${retry}}`,
        ).getLocations(),
      ).rejects.toMatchObject({ status: 429, retryAfterSeconds: undefined });
    },
  );

  it("preserves zero from the JSON fallback", async () => {
    await expect(
      responseClient(429, '{"error":"rate_limited","retry_after_seconds":0}').getLocations(),
    ).rejects.toMatchObject({ retryAfterSeconds: 0 });
  });

  it("uses the JSON fallback on no-content error responses without a valid header", async () => {
    await expect(responseClient(429, "", "invalid").getLocations()).rejects.toMatchObject({
      status: 429,
      retryAfterSeconds: undefined,
    });
  });
});

function responseClient(status: number, body: string, retryAfter: string | null = null): ApiClient {
  return new ApiClient(
    async () =>
      new Response(body, {
        status,
        headers: retryAfter === null ? {} : { "Retry-After": retryAfter },
      }),
    "https://example.invalid",
    1_000,
  );
}
