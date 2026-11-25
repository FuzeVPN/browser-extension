// SPDX-License-Identifier: MPL-2.0

import { ApiClient, ApiError, NetworkError } from "../../src/core/api/client";
import { decodeAdBlocking, type AdBlockingChoice } from "../../src/core/api/types";
import { isExtensionRequest } from "../../src/core/shared/messages";
import { EMPTY_AD_BLOCKING, EMPTY_SNAPSHOT } from "../../src/core/shared/state";
import { EMPTY_PERSISTED_STATE } from "../../src/core/storage/storage";
import { authenticatedState, createHarness, PROFILE, UNAUTHORIZED } from "./helpers";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("the reply of the service about the ad blocker", () => {
  it("is the choice of the account and whether the service applies it", () => {
    expect(decodeAdBlocking({ ad_blocking: true, available: false, updated_at: null })).toEqual({
      enabled: true,
      available: false,
    });
    expect(
      decodeAdBlocking({ ad_blocking: false, available: true, updated_at: "2026-11-25T13:09:00Z" }),
    ).toEqual({ enabled: false, available: true });
  });

  it.each([
    ["nothing", null],
    ["a list", [true, true]],
    ["no choice", { available: true }],
    ["no availability", { ad_blocking: true }],
    ["a choice which is not a boolean", { ad_blocking: "true", available: true }],
    ["an availability which is not a boolean", { ad_blocking: true, available: 1 }],
  ])("is refused when it holds %s", (_name, value) => {
    expect(decodeAdBlocking(value)).toBeNull();
  });
});

describe("the requests of the API client about the ad blocker", () => {
  const reply = (body: unknown, status = 200, headers?: Record<string, string>) =>
    new Response(JSON.stringify(body), { status, headers });
  const client = (fetchMock: typeof fetch) =>
    new ApiClient(fetchMock, "https://api.fuzevpn.com", 1_000);

  it("reads the choice with the credential of the account", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(reply({ ad_blocking: true, available: true, updated_at: null }));
    await expect(client(fetchMock).getAdBlocking("account-token")).resolves.toEqual({
      enabled: true,
      available: true,
    });
    const [url, request] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://api.fuzevpn.com/v1/me/dns-filter");
    expect(request?.method).toBe("GET");
    expect(request?.body).toBeUndefined();
    expect(new Headers(request?.headers).get("Authorization")).toBe("Bearer account-token");
  });

  it.each([true, false])("writes the choice %s as the whole body, and nothing else", async (on) => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(reply({ ad_blocking: on, available: true, updated_at: "2026-11-25" }));
    await expect(client(fetchMock).setAdBlocking("account-token", on)).resolves.toEqual({
      enabled: on,
      available: true,
    });
    const [url, request] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://api.fuzevpn.com/v1/me/dns-filter");
    expect(request?.method).toBe("PUT");
    expect(request?.body).toBe(JSON.stringify({ ad_blocking: on }));
    expect(new Headers(request?.headers).get("Content-Type")).toBe("application/json");
    expect(new Headers(request?.headers).get("Authorization")).toBe("Bearer account-token");
  });

  it("reports a refusal of the service with its code", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(reply({ error: "rate_limited" }, 429, { "Retry-After": "12" }));
    await expect(client(fetchMock).setAdBlocking("account-token", true)).rejects.toMatchObject({
      code: "rate_limited",
      status: 429,
    } satisfies Partial<ApiError>);
  });

  it("refuses a reply it cannot read rather than guess a choice", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(reply({ ad_blocking: true }));
    await expect(client(fetchMock).getAdBlocking("account-token")).rejects.toMatchObject({
      kind: "invalid_response",
    } satisfies Partial<NetworkError>);
  });
});

describe("the commands of the popup about the ad blocker", () => {
  it("accepts a read, and a change which says the choice and nothing else", () => {
    expect(isExtensionRequest({ type: "refresh_ad_blocking" })).toBe(true);
    expect(isExtensionRequest({ type: "set_ad_blocking", enabled: true })).toBe(true);
    expect(isExtensionRequest({ type: "set_ad_blocking", enabled: false })).toBe(true);
  });

  it.each([
    ["no choice", { type: "set_ad_blocking" }],
    ["a choice which is not a boolean", { type: "set_ad_blocking", enabled: "true" }],
    ["another field", { type: "set_ad_blocking", enabled: true, available: false }],
  ])("refuses a change with %s", (_name, request) => {
    expect(isExtensionRequest(request)).toBe(false);
  });
});

describe("the ad blocker of the account in the background", () => {
  const signedIn = () => createHarness({ persisted: authenticatedState() });

  it("is not known before it has been read", async () => {
    const h = signedIn();
    await h.controller.initialize();
    expect(h.controller.getSnapshot().adBlocking).toEqual(EMPTY_AD_BLOCKING);
    expect(h.api.adBlockingCalls).toEqual([]);
  });

  it("reads the choice of the account and publishes it", async () => {
    const h = signedIn();
    h.api.adBlocking = { enabled: true, available: true };
    expect(await h.controller.refreshAdBlocking()).toEqual({ ok: true });
    expect(h.controller.getSnapshot().adBlocking).toEqual({ enabled: true, available: true });
    expect(h.api.adBlockingCalls).toEqual(["read"]);
  });

  it("records a change and publishes what the service answers", async () => {
    const h = signedIn();
    expect(await h.controller.setAdBlocking(true)).toEqual({ ok: true });
    expect(h.api.adBlockingCalls).toEqual([true]);
    expect(h.controller.getSnapshot().adBlocking).toEqual({ enabled: true, available: true });
    expect(await h.controller.setAdBlocking(false)).toEqual({ ok: true });
    expect(h.controller.getSnapshot().adBlocking).toEqual({ enabled: false, available: true });
  });

  it("says when the service has turned the blocker off for everyone", async () => {
    const h = signedIn();
    h.api.adBlocking = { enabled: true, available: false };
    await h.controller.refreshAdBlocking();
    expect(h.controller.getSnapshot().adBlocking).toEqual({ enabled: true, available: false });
  });

  it.each([
    ["the network", new NetworkError("network"), { commandError: "network_error" }],
    [
      "a limit of the service",
      new ApiError("rate_limited", 429, 12),
      { commandError: "rate_limited", commandRetryAfterSeconds: 12 },
    ],
    ["a service without the route", new ApiError("not_found", 404), { commandError: "not_found" }],
    [
      "an unreadable reply",
      new NetworkError("invalid_response"),
      { commandError: "invalid_response" },
    ],
  ])(
    "reports a failure of %s to its caller, and changes nothing else",
    async (_name, error, result) => {
      const h = signedIn();
      h.api.adBlocking = { enabled: true, available: true };
      await h.controller.refreshAdBlocking();
      const before = h.controller.getSnapshot();
      h.api.adBlockingError = error;

      expect(await h.controller.setAdBlocking(false)).toEqual({ ok: false, ...result });
      expect(await h.controller.refreshAdBlocking()).toEqual({ ok: false, ...result });
      // Neither the connection nor its error is concerned, and the choice shown stays.
      expect(h.controller.getSnapshot()).toEqual(before);
      expect(h.controller.getSnapshot().error).toBeNull();
    },
  );

  it("signs the account out when its credential is refused", async () => {
    const h = signedIn();
    h.api.adBlockingError = UNAUTHORIZED;
    expect(await h.controller.setAdBlocking(true)).toEqual({
      ok: false,
      commandError: "unauthorized",
    });
    expect(h.storage.persisted).toEqual(EMPTY_PERSISTED_STATE);
    expect(h.controller.getSnapshot()).toEqual({ ...EMPTY_SNAPSHOT, error: "unauthorized" });
  });

  it("sends its requests one after the other, in the order they were asked", async () => {
    const h = signedIn();
    await h.controller.initialize();
    const recorded = deferred<AdBlockingChoice>();
    vi.spyOn(h.api, "setAdBlocking").mockImplementationOnce(() => recorded.promise);
    const change = h.controller.setAdBlocking(true);
    const read = h.controller.refreshAdBlocking();
    await settle();
    // A read sent now could be answered before the change is recorded.
    expect(h.api.adBlockingCalls).toEqual([]);

    h.api.adBlocking = { enabled: true, available: true };
    recorded.resolve({ enabled: true, available: true });
    expect(await change).toEqual({ ok: true });
    expect(await read).toEqual({ ok: true });
    expect(h.api.adBlockingCalls).toEqual(["read"]);
    expect(h.controller.getSnapshot().adBlocking).toEqual({ enabled: true, available: true });
  });

  it("goes on after a request which failed", async () => {
    const h = signedIn();
    h.api.adBlockingError = new NetworkError("network");
    expect((await h.controller.refreshAdBlocking()).ok).toBe(false);
    h.api.adBlockingError = null;
    expect(await h.controller.setAdBlocking(true)).toEqual({ ok: true });
  });

  it("abandons a request which a sign-out overtakes, and forgets the choice", async () => {
    const h = signedIn();
    h.api.adBlocking = { enabled: true, available: true };
    await h.controller.refreshAdBlocking();
    const answered = deferred<AdBlockingChoice>();
    vi.spyOn(h.api, "getAdBlocking").mockImplementationOnce(() => answered.promise);
    const read = h.controller.refreshAdBlocking();
    await settle();

    await h.controller.logout();
    expect(h.controller.getSnapshot().adBlocking).toEqual(EMPTY_AD_BLOCKING);
    answered.resolve({ enabled: true, available: true });
    expect(await read).toEqual({ ok: false, superseded: true });
    expect(h.controller.getSnapshot().adBlocking).toEqual(EMPTY_AD_BLOCKING);
  });

  it("never shows the choice of an account for another one", async () => {
    const h = signedIn();
    h.api.adBlocking = { enabled: true, available: true };
    await h.controller.refreshAdBlocking();
    expect(h.controller.getSnapshot().adBlocking?.enabled).toBe(true);

    // The service now answers for another account under the same credential.
    h.api.profile = { ...PROFILE, userId: "another-account" };
    await h.controller.refreshAccount();
    expect(h.controller.getSnapshot().adBlocking).toEqual(EMPTY_AD_BLOCKING);
  });
});
