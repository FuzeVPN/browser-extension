// SPDX-License-Identifier: MPL-2.0

import { createServer, type RequestListener } from "node:http";
import { ApiClient, ProxyCreationUncertainError } from "../../src/core/api/client";

const exchange = {
  clientId: "synthetic-extension",
  code: "synthetic-one-use-code",
  redirectUri: "https://synthetic-extension.invalid/auth",
  codeVerifier: "synthetic-pkce-verifier",
};

const proof = {
  deviceId: "synthetic-device",
  deviceTimestamp: 1_787_824_800,
  deviceNonce: "synthetic-nonce",
  deviceSignature: "synthetic-signature",
};

describe("API redirect boundary", () => {
  it.each([307, 308])(
    "does not transmit an authorization exchange to the destination of HTTP %i",
    async (status) => {
      await withRedirect(status, async (client) => {
        await expect(client.exchangeExtensionCode(exchange)).rejects.toMatchObject({
          name: "NetworkError",
          kind: "network",
        });
      });
    },
  );

  it.each([307, 308])(
    "keeps proxy creation uncertain without replaying the proof after HTTP %i",
    async (status) => {
      await withRedirect(status, async (client) => {
        await expect(
          client.createProxySession("synthetic-token", "synthetic-location", proof),
        ).rejects.toBeInstanceOf(ProxyCreationUncertainError);
      });
    },
  );
});

async function withRedirect(status: number, run: (client: ApiClient) => Promise<void>) {
  let destinationRequests = 0;
  let originRequests = 0;
  const destination = await localServer((_request, response) => {
    destinationRequests += 1;
    response.writeHead(201, { "Content-Type": "application/json" });
    response.end(
      JSON.stringify({
        access_token: "synthetic-redirected-session",
        expires_at: "2027-01-01T00:00:00Z",
      }),
    );
  });
  let origin: Awaited<ReturnType<typeof localServer>> | undefined;
  try {
    origin = await localServer((_request, response) => {
      originRequests += 1;
      response.writeHead(status, { Location: `${destination.url}/external-collector` });
      response.end();
    });
    expect(new URL(origin.url).origin).not.toBe(new URL(destination.url).origin);
    await run(new ApiClient(fetch, origin.url, 1_000));
    expect(originRequests).toBe(1);
    expect(destinationRequests).toBe(0);
  } finally {
    await origin?.close();
    await destination.close();
  }
}

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
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}
