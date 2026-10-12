// SPDX-License-Identifier: MPL-2.0

import {
  ApiClient,
  MAX_API_RESPONSE_BYTES,
  ProxyCreationUncertainError,
} from "../../src/core/api/client";
import { createServer } from "node:http";
import { gzipSync } from "node:zlib";
import {
  decodeAuthSession,
  decodeBrowserDeviceEnrollment,
  decodeDeviceList,
  decodeLocations,
  decodeProfile,
  decodeProxySession,
} from "../../src/core/api/types";
import { ExtensionStorageService } from "../../src/core/storage/storage";

const date = "2026-09-12T12:00:00Z";
const location = {
  id: "location-1",
  city: "Montréal",
  country_code: "CA",
  display_name: "Canada",
  supported_protocols: ["browser_proxy"],
};
const device = {
  device_id: "device-1",
  name: "Chrome",
  kind: "browser_extension",
  created_at: date,
  profiles: [],
};
const session = {
  id: "session-1",
  location_id: "location-1",
  scheme: "https",
  host: "proxy.example.invalid",
  port: 443,
  username: "session-1",
  password: "synthetic",
  issued_at: date,
  expires_at: "2026-09-12T12:10:00Z",
  refresh_after_seconds: 510,
};
const proof = {
  deviceId: "device-1",
  deviceTimestamp: 1_787_824_800,
  deviceNonce: "nonce-base64url",
  deviceSignature: "signature-base64url",
};

describe("required API identities", () => {
  afterEach(() => vi.unstubAllGlobals());

  it.each(["", " \t\r\n"])(
    "rejects an empty API token %j, including cached sessions",
    async (token) => {
      expect(decodeAuthSession({ access_token: token, expires_at: date })).toBeNull();
      vi.stubGlobal("browser", {
        storage: {
          local: {
            get: async () => ({
              fuzevpnState: { auth: { accessToken: token, expiresAt: date } },
            }),
          },
        },
      });
      await expect(new ExtensionStorageService().readPersisted()).resolves.toMatchObject({
        auth: null,
      });
    },
  );

  it.each(["", " \t"])(
    "rejects empty opaque identifiers %j without changing display metadata",
    (id) => {
      expect(
        decodeProfile({ user_id: id, email: "", first_name: "", last_name: "", country_code: "" }),
      ).toBeNull();
      expect(decodeLocations({ locations: [{ ...location, id }] })).toBeNull();
      expect(decodeDeviceList({ limit: 1, devices: [{ ...device, device_id: id }] })).toBeNull();
      expect(decodeBrowserDeviceEnrollment({ ...device, device_id: id })).toBeNull();
      expect(decodeProxySession({ ...session, id })).toBeNull();
      expect(decodeProxySession({ ...session, location_id: id })).toBeNull();
    },
  );

  it("rejects duplicate location identities before filtering unsupported protocols", () => {
    expect(
      decodeLocations({
        locations: [location, { ...location, supported_protocols: ["wireguard"] }],
      }),
    ).toBeNull();
  });

  it("rejects duplicate device identities without inventing an account quota", () => {
    expect(
      decodeDeviceList({ limit: 12, devices: [device, { ...device, name: "Other" }] }),
    ).toBeNull();
    expect(decodeDeviceList({ limit: 12, devices: [device] })).toMatchObject({ limit: 12 });
  });

  it.each([Number.MAX_SAFE_INTEGER + 1, Infinity, 1.5])(
    "rejects unsafe integer metadata %s",
    (value) => {
      expect(decodeDeviceList({ limit: value, devices: [] })).toBeNull();
      expect(decodeProxySession({ ...session, refresh_after_seconds: value })).toBeNull();
    },
  );

  it("keeps optional/unknown display data and long valid identifiers compatible", () => {
    expect(
      decodeProfile({
        user_id: "opaque-user",
        email: "",
        first_name: "",
        last_name: "",
        country_code: "",
      }),
    ).not.toBeNull();
    expect(
      decodeLocations({
        locations: [{ ...location, id: "a".repeat(201), country_code: "unexpected", city: "" }],
      }),
    ).toHaveLength(1);
    expect(decodeAuthSession({ access_token: "opaque-token", expires_at: date })).not.toBeNull();
  });
});

describe("API response resource budget", () => {
  it("accepts a complete JSON response exactly at the decoded byte budget", async () => {
    const prefix = '{"locations":[],"padding":"';
    const suffix = '"}';
    const response = new Response(
      prefix + "a".repeat(MAX_API_RESPONSE_BYTES - prefix.length - suffix.length) + suffix,
    );
    await expect(new ApiClient(async () => response).getLocations()).resolves.toEqual([]);
  });

  it.each([null, "1"])(
    "stops an oversized streamed response with Content-Length %j",
    async (header) => {
      const fixture = overflowingResponse(200, header);
      await expect(
        new ApiClient(async () => fixture.response).getLocations(),
      ).rejects.toMatchObject({
        name: "NetworkError",
        kind: "invalid_response",
      });
      expect(fixture.cancelled()).toBe(true);
      expect(fixture.pulls()).toBe(5);
    },
  );

  it("counts UTF-8 bytes rather than JavaScript characters", async () => {
    const response = new Response(
      JSON.stringify({ locations: [], padding: "é".repeat(MAX_API_RESPONSE_BYTES / 2) }),
    );
    await expect(new ApiClient(async () => response).getLocations()).rejects.toMatchObject({
      kind: "invalid_response",
    });
  });

  it("bounds decompressed bytes with native Fetch despite a small gzip Content-Length", async () => {
    const body = gzipSync(
      JSON.stringify({ locations: [], padding: "a".repeat(MAX_API_RESPONSE_BYTES) }),
    );
    expect(body.byteLength).toBeLessThan(MAX_API_RESPONSE_BYTES);
    const server = createServer((_request, response) => {
      response.writeHead(200, {
        "Content-Type": "application/json",
        "Content-Encoding": "gzip",
        "Content-Length": body.byteLength,
      });
      response.end(body);
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing loopback address");
    try {
      await expect(
        new ApiClient(fetch, `http://127.0.0.1:${String(address.port)}`, 1_000).getLocations(),
      ).rejects.toMatchObject({ name: "NetworkError", kind: "invalid_response" });
    } finally {
      server.closeAllConnections();
      await new Promise<void>((done, reject) => {
        server.close((error) => (error ? reject(error) : done()));
      });
    }
  });

  it("decodes a multibyte character split across stream chunks", async () => {
    const bytes = new TextEncoder().encode(JSON.stringify({ locations: [location] }));
    const split = bytes.indexOf(0xc3) + 1;
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(bytes.slice(0, split));
          controller.enqueue(bytes.slice(split));
          controller.close();
        },
      }),
    );
    await expect(new ApiClient(async () => response).getLocations()).resolves.toMatchObject([
      { city: "Montréal" },
    ]);
  });

  it.each([401, 429, 503])(
    "retains HTTP %i and Retry-After when its body exceeds the budget",
    async (status) => {
      const fixture = overflowingResponse(status);
      await expect(
        new ApiClient(async () => fixture.response).getLocations(),
      ).rejects.toMatchObject({
        name: "ApiError",
        status,
        retryAfterSeconds: 120,
      });
      expect(fixture.cancelled()).toBe(true);
    },
  );

  it.each([201, 503])(
    "keeps creation uncertainty after an oversized HTTP %i response",
    async (status) => {
      const fixture = overflowingResponse(status);
      await expect(
        new ApiClient(async () => fixture.response).createProxySession(
          "token",
          "location-1",
          proof,
        ),
      ).rejects.toBeInstanceOf(ProxyCreationUncertainError);
    },
  );
});

function overflowingResponse(status: number, contentLength: string | null = null) {
  let cancelled = false;
  let pulls = 0;
  const response = new Response(
    new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          pulls++;
          controller.enqueue(new Uint8Array(1024 * 1024).fill(0x20));
        },
        cancel() {
          cancelled = true;
        },
      },
      { highWaterMark: 0 },
    ),
    {
      status,
      headers: {
        "Retry-After": "120",
        ...(contentLength === null ? {} : { "Content-Length": contentLength }),
      },
    },
  );
  return { response, cancelled: () => cancelled, pulls: () => pulls };
}
