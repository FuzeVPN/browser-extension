// SPDX-License-Identifier: MPL-2.0

import { createServer, type RequestListener } from "node:http";
import {
  ApiClient,
  ApiError,
  isDefinitiveProxyCreationRejection,
  ProxyCreationUncertainError,
} from "../../src/core/api/client";

const proof = {
  deviceId: "device-1",
  deviceTimestamp: 1_787_824_800,
  deviceNonce: "nonce-base64url",
  deviceSignature: "signature-base64url",
};

describe("proxy capacity refusal contracts", () => {
  it.each([
    [409, "server_full"],
    [503, "capacity_unavailable"],
  ] as const)(
    "preserves HTTP %i %s as a definite refusal with Retry-After",
    async (status, code) => {
      const client = new ApiClient(async () =>
        Response.json({ error: code }, { status, headers: { "Retry-After": "75" } }),
      );
      const error: unknown = await client
        .createProxySession("token", "location", proof)
        .catch((value: unknown) => value);
      expect(error).toBeInstanceOf(ApiError);
      expect(error).toMatchObject({ code, status, retryAfterSeconds: 75 });
      expect(isDefinitiveProxyCreationRejection(error)).toBe(true);
    },
  );

  it.each([
    [503, ""],
    [503, '{"error":"capacity_unavailable"'],
    [503, '{"error":"capacity_unavailable"} trailing data'],
    [503, '{"reason":"capacity_unavailable"}'],
    [503, '[{"error":"capacity_unavailable"}]'],
    [503, '{"error":"server_full"}'],
    [503, '{"error":"server_error"}'],
    [500, '{"error":"capacity_unavailable"}'],
    [502, '{"error":"capacity_unavailable"}'],
    [504, '{"error":"capacity_unavailable"}'],
    [201, '{"error":"capacity_unavailable"}'],
  ])("keeps creation uncertain for HTTP %i with body %j", async (status, body) => {
    const client = new ApiClient(async () => new Response(body, { status }));
    const error: unknown = await client
      .createProxySession("token", "location", proof)
      .catch((value: unknown) => value);
    expect(error).toBeInstanceOf(ProxyCreationUncertainError);
    expect(isDefinitiveProxyCreationRejection(error)).toBe(false);
  });

  it("waits for the complete body before recognizing a streamed capacity refusal", async () => {
    let finish!: () => void;
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"error":"capacity_unavailable"}'));
          finish = () => controller.close();
        },
      }),
      { status: 503 },
    );
    let settled = false;
    const operation = new ApiClient(async () => response)
      .createProxySession("token", "location", proof)
      .catch((error: unknown) => {
        settled = true;
        return error;
      });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(settled).toBe(false);
    finish();
    expect(await operation).toMatchObject({ code: "capacity_unavailable", status: 503 });
  });

  it.each(["timeout", "interrupted"] as const)(
    "keeps a complete JSON prefix uncertain when the HTTP 503 stream is %s",
    async (failure) => {
      const server = await localServer((_request, response) => {
        response.writeHead(503, {
          "Content-Type": "application/json",
          "Retry-After": "120",
        });
        response.write('{"error":"capacity_unavailable"}');
      });
      let headersReceived = false;
      const readHeaders: typeof fetch = async (input, init) => {
        const response = await fetch(input, init);
        headersReceived = true;
        if (failure === "interrupted") server.dropConnections();
        return response;
      };
      try {
        await expect(
          new ApiClient(readHeaders, server.url, 100).createProxySession(
            "token",
            "location",
            proof,
          ),
        ).rejects.toBeInstanceOf(ProxyCreationUncertainError);
        expect(headersReceived).toBe(true);
      } finally {
        await server.close();
      }
    },
  );

  it("keeps a lost creation response uncertain", async () => {
    const client = new ApiClient(async () => {
      throw new TypeError("synthetic connection lost");
    });
    await expect(client.createProxySession("token", "location", proof)).rejects.toBeInstanceOf(
      ProxyCreationUncertainError,
    );
  });

  it("uses only the uncached filtered catalog route without an availability request", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({ locations: [] }));
    const client = new ApiClient(fetcher, "https://example.invalid");
    await expect(client.getLocations()).resolves.toEqual([]);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls[0]?.[0]).toBe("https://example.invalid/v1/locations");
    expect(fetcher.mock.calls[0]?.[1]?.cache).toBe("no-store");
    expect(new Headers(fetcher.mock.calls[0]?.[1]?.headers).has("Authorization")).toBe(false);
  });
});

async function localServer(listener: RequestListener) {
  const server = createServer(listener);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing local server address");
  return {
    url: `http://127.0.0.1:${String(address.port)}`,
    dropConnections: () => server.closeAllConnections(),
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}
