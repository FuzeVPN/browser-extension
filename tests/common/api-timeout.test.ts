// SPDX-License-Identifier: MPL-2.0

import { createServer, type RequestListener } from "node:http";
import { ApiClient, ProxyCreationUncertainError } from "../../src/core/api/client";

const proof = {
  deviceId: "device-1",
  deviceTimestamp: 1_787_824_800,
  deviceNonce: "nonce-base64url",
  deviceSignature: "signature-base64url",
};

describe("API response deadline", () => {
  it.each([200, 401, 403, 429, 503])(
    "bounds a slow HTTP %i body while preserving received rejections",
    async (status) => {
      let bodyCompleted = false;
      const server = await localServer((_request, response) => {
        response.writeHead(status, {
          "Content-Type": "application/json",
          "Retry-After": "120",
        });
        response.write("{");
        const timer = setTimeout(() => {
          bodyCompleted = true;
          response.end(status === 200 ? '"locations":[]}' : '"error":"server_error"}');
        }, 350);
        response.on("close", () => clearTimeout(timer));
      });
      let headersReceived = false;
      const fetchWithHeaders: typeof fetch = async (input, init) => {
        const response = await fetch(input, init);
        headersReceived = true;
        return response;
      };
      try {
        const client = new ApiClient(fetchWithHeaders, server.url, 100);
        await expect(client.getLocations()).rejects.toMatchObject(
          status === 200
            ? { name: "NetworkError", kind: "timeout" }
            : { name: "ApiError", status, code: "server_error", retryAfterSeconds: 120 },
        );
        expect(headersReceived).toBe(true);
        expect(bodyCompleted).toBe(false);
      } finally {
        await server.close();
      }
    },
  );

  it("decodes a streamed body completed within the deadline", async () => {
    const server = await localServer((_request, response) => {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.write('{"locations":');
      response.end("[]}");
    });
    try {
      await expect(new ApiClient(fetch, server.url, 1_000).getLocations()).resolves.toEqual([]);
    } finally {
      await server.close();
    }
  });

  it.each([200, 401, 429, 503])(
    "keeps caller cancellation distinct from an HTTP %i response during body reading",
    async (status) => {
      const server = await localServer((_request, response) => {
        response.writeHead(status, { "Content-Type": "application/json", "Retry-After": "120" });
        response.write("{");
      });
      const caller = new AbortController();
      const cancellingFetch: typeof fetch = async (input, init) => {
        const response = await fetch(input, init);
        setTimeout(() => caller.abort(), 20);
        return response;
      };
      try {
        const client = new ApiClient(cancellingFetch, server.url, 1_000);
        await expect(client.getLocations(caller.signal)).rejects.toMatchObject({
          name: "AbortError",
        });
      } finally {
        await server.close();
      }
    },
  );

  it.each([200, 401, 403, 429, 503])(
    "handles a connection failure after HTTP %i headers without losing a rejection",
    async (status) => {
      const server = await localServer((_request, response) => {
        response.writeHead(status, { "Content-Type": "application/json", "Retry-After": "120" });
        response.write("{");
      });
      const disconnectingFetch: typeof fetch = async (input, init) => {
        const response = await fetch(input, init);
        server.dropConnections();
        return response;
      };
      try {
        const client = new ApiClient(disconnectingFetch, server.url, 1_000);
        await expect(client.getLocations()).rejects.toMatchObject(
          status === 200
            ? { name: "NetworkError", kind: "network" }
            : { name: "ApiError", status, code: "server_error", retryAfterSeconds: 120 },
        );
      } finally {
        await server.close();
      }
    },
  );

  it.each([401, 403, 429, 503])(
    "preserves the creation contract when an HTTP %i body times out",
    async (status) => {
      const server = await localServer((_request, response) => {
        response.writeHead(status, { "Content-Type": "application/json", "Retry-After": "120" });
        response.write("{");
      });
      try {
        const client = new ApiClient(fetch, server.url, 100);
        const operation = client.createProxySession("token", "location", proof);
        if (status < 500)
          await expect(operation).rejects.toMatchObject({
            name: "ApiError",
            status,
            retryAfterSeconds: 120,
          });
        else await expect(operation).rejects.toBeInstanceOf(ProxyCreationUncertainError);
      } finally {
        await server.close();
      }
    },
  );
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
