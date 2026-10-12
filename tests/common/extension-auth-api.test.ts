// SPDX-License-Identifier: MPL-2.0

import { ApiClient, NetworkError } from "../../src/core/api/client";
import { isExtensionRequest } from "../../src/core/shared/messages";

const exchange = {
  clientId: "fuzevpn-browser-extension",
  code: "A".repeat(43),
  redirectUri: `https://${"a".repeat(40)}.extensions.allizom.org/auth`,
  codeVerifier: "B".repeat(43),
};

describe("extension authorization exchange", () => {
  it("exchanges the one-use code in the POST body without cookies or an old session", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(
          JSON.stringify({ access_token: "extension-session", expires_at: "2027-01-01T00:00:00Z" }),
          { status: 201 },
        ),
      );
    const client = new ApiClient(fetcher);
    await expect(client.exchangeExtensionCode(exchange)).resolves.toEqual({
      accessToken: "extension-session",
      expiresAt: "2027-01-01T00:00:00Z",
    });
    const [url, options] = fetcher.mock.calls[0]!;
    expect(url).toBe("https://api.fuzevpn.com/v1/auth/extension/token");
    expect(options?.method).toBe("POST");
    expect(options?.credentials).toBe("omit");
    expect(new Headers(options?.headers).get("Authorization")).toBeNull();
    if (typeof options?.body !== "string") throw new Error("Expected a JSON request body");
    expect(JSON.parse(options.body)).toEqual({
      client_id: exchange.clientId,
      code: exchange.code,
      redirect_uri: exchange.redirectUri,
      code_verifier: exchange.codeVerifier,
    });
  });

  it.each([400, 503, 429])(
    "does not retry a consumed or refused code after HTTP%s",
    async (status) => {
      const error =
        status === 400
          ? "extension_auth_invalid_grant"
          : status === 503
            ? "extension_auth_unavailable"
            : "rate_limited";
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response(JSON.stringify({ error }), { status }));
      await expect(new ApiClient(fetcher).exchangeExtensionCode(exchange)).rejects.toMatchObject({
        code: error,
        status,
      });
      expect(fetcher).toHaveBeenCalledTimes(1);
    },
  );

  it("does not retry after the exchange committed but its response was lost", async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new TypeError("lost response"));
    await expect(new ApiClient(fetcher).exchangeExtensionCode(exchange)).rejects.toBeInstanceOf(
      NetworkError,
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each([
    { access_token: "", expires_at: "2027-01-01T00:00:00Z" },
    { access_token: "token", expires_at: "not-a-date" },
    { token: "google-token" },
  ])("rejects a response that cannot represent a FuzeVPN session", async (response) => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify(response), { status: 201 }));
    await expect(new ApiClient(fetcher).exchangeExtensionCode(exchange)).rejects.toMatchObject({
      kind: "invalid_response",
    });
  });
});

describe("web-login message boundary", () => {
  it.each([false, true])(
    "accepts an explicit boolean disconnect decision %s",
    (disconnectFirst) => {
      expect(isExtensionRequest({ type: "web_login", disconnectFirst })).toBe(true);
    },
  );

  it.each([undefined, null, "true", "false", 0, 1, {}, []])(
    "rejects a coerced or missing disconnect decision",
    (disconnectFirst) => {
      expect(isExtensionRequest({ type: "web_login", disconnectFirst })).toBe(false);
    },
  );

  it.each(["code", "redirect_uri", "client_id", "state", "code_verifier", "url", "token"])(
    "refuses caller-supplied authorization parameter %s",
    (field) => {
      expect(
        isExtensionRequest({ type: "web_login", disconnectFirst: false, [field]: "untrusted" }),
      ).toBe(false);
    },
  );
});
