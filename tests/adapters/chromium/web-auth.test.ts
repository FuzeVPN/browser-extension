// SPDX-License-Identifier: MPL-2.0

import { createHash } from "node:crypto";
import { LANGUAGE_NAMES } from "../../../src/core/shared/language";
import {
  ExtensionWebAuthService,
  WebAuthError,
  WEB_AUTH_CLIENT_ID,
  type WebAuthCrypto,
  type WebAuthOptions,
} from "../../../src/core/auth/web-auth";

const START_URL = "https://app.fuzevpn.com/extension/connect";
const REDIRECT_URI = `https://${"a".repeat(32)}.chromiumapp.org/auth`;
const CODE = "A".repeat(42) + "Q";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function fixture(options: Partial<WebAuthOptions> = {}) {
  const response = deferred<string | undefined>();
  const launchWebAuthFlow = vi.fn<
    (details: { url: string; interactive: true }) => Promise<string | undefined>
  >(() => response.promise);
  const getRedirectURL = vi.fn(() => REDIRECT_URI);
  const randomSizes: number[] = [];
  let randomByte = 0;
  const cryptoImpl: WebAuthCrypto = {
    getRandomValues(array) {
      randomSizes.push(array.byteLength);
      array.fill(++randomByte);
      return array;
    },
    subtle: { digest: vi.fn(() => Promise.resolve(new ArrayBuffer(32))) },
  };
  const service = new ExtensionWebAuthService({
    startUrl: START_URL,
    identity: { getRedirectURL, launchWebAuthFlow },
    crypto: cryptoImpl,
    ...options,
  });
  const start = (index = 0) => new URL(launchWebAuthFlow.mock.calls[index]![0].url);
  const callback = (parameters: Record<string, string> = {}, index = 0) => {
    const url = new URL(REDIRECT_URI);
    url.searchParams.set("code", CODE);
    url.searchParams.set("state", start(index).searchParams.get("state")!);
    for (const [key, value] of Object.entries(parameters)) url.searchParams.set(key, value);
    return url.href;
  };
  return {
    service,
    response,
    launchWebAuthFlow,
    getRedirectURL,
    randomSizes,
    cryptoImpl,
    start,
    callback,
  };
}

async function prepare() {
  await Promise.resolve();
  await Promise.resolve();
}

describe("web authentication PKCE authorization", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("launches the trusted page interactively with 256-bit state and an S256 PKCE challenge", async () => {
    const context = fixture({ crypto: globalThis.crypto });
    const operation = context.service.authorize(undefined, "fr");
    await vi.waitFor(() => expect(context.launchWebAuthFlow).toHaveBeenCalledOnce());
    expect(context.getRedirectURL).toHaveBeenCalledExactlyOnceWith("auth");
    const start = context.start();
    expect(start.origin + start.pathname).toBe(START_URL);
    expect(start.searchParams.get("client_id")).toBe(WEB_AUTH_CLIENT_ID);
    expect(start.searchParams.get("redirect_uri")).toBe(REDIRECT_URI);
    expect(start.searchParams.get("code_challenge_method")).toBe("S256");
    expect(start.searchParams.get("locale")).toBe("fr");
    expect(start.searchParams.get("state")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(context.launchWebAuthFlow.mock.calls[0]![0].interactive).toBe(true);
    context.response.resolve(context.callback());
    const authorization = await operation;
    expect(authorization).toMatchObject({
      clientId: WEB_AUTH_CLIENT_ID,
      code: CODE,
      redirectUri: REDIRECT_URI,
    });
    expect(authorization.codeVerifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(start.searchParams.get("code_challenge")).toBe(
      createHash("sha256").update(authorization.codeVerifier).digest("base64url"),
    );
    expect(authorization.codeVerifier).not.toBe(start.searchParams.get("state"));
    expect(start.searchParams.has("code_verifier")).toBe(false);
    expect(start.searchParams.has("client_secret")).toBe(false);
  });

  it("requests distinct 32-byte CSPRNG values and never includes the verifier in the browser URL", async () => {
    const context = fixture();
    const operation = context.service.authorize();
    await prepare();
    expect(context.randomSizes).toEqual([32, 32]);
    expect(context.start().searchParams.has("locale")).toBe(false);
    context.response.resolve(context.callback());
    const authorization = await operation;
    expect(context.start().href).not.toContain(authorization.codeVerifier);
  });

  it.each(["en", "pt-BR", "zh-Hant", "ar"])(
    "passes the locale %s without changing the callback",
    async (locale) => {
      const context = fixture();
      const operation = context.service.authorize(undefined, locale);
      await prepare();
      expect(context.start().searchParams.get("locale")).toBe(locale);
      context.response.resolve(context.callback());
      await expect(operation).resolves.toMatchObject({ redirectUri: REDIRECT_URI });
    },
  );

  it.each(Object.keys(LANGUAGE_NAMES))("accepts the supported language %s", async (locale) => {
    const context = fixture();
    const operation = context.service.authorize(undefined, locale);
    await prepare();
    expect(context.start().searchParams.get("locale")).toBe(locale);
    context.response.resolve(context.callback());
    await expect(operation).resolves.toMatchObject({ redirectUri: REDIRECT_URI });
  });

  it.each([
    ["pt_BR", "pt-BR"],
    ["zh_CN", "zh-CN"],
    ["zh_TW", "zh-TW"],
    ["en_US", "en-US"],
  ])("serializes internal locale %s as canonical BCP47 %s", async (locale, expected) => {
    const context = fixture();
    const operation = context.service.authorize(undefined, locale);
    await prepare();
    expect(context.start().searchParams.get("locale")).toBe(expected);
    context.response.resolve(context.callback());
    await expect(operation).resolves.toMatchObject({ redirectUri: REDIRECT_URI });
  });

  it.each(["", "fr&redirect_uri=https://evil.example", "../fr", "FR", "a".repeat(30)])(
    "does not launch for an invalid locale %s",
    async (locale) => {
      const context = fixture();
      await expect(context.service.authorize(undefined, locale)).rejects.toMatchObject({
        code: "web_login_unavailable",
      });
      expect(context.launchWebAuthFlow).not.toHaveBeenCalled();
    },
  );

  it.each([
    "http://fuzevpn.com/extension/connect",
    "javascript:alert(1)",
    "https://user:password@fuzevpn.com/extension/connect",
    `${START_URL}?redirect_uri=https://evil.example`,
    `${START_URL}?`,
    `${START_URL}#fragment`,
    `${START_URL}#`,
    ` ${START_URL}`,
    "https://FUzevpn.com/extension/connect",
  ])("rejects an unsafe or ambiguous configured start URL %s", (startUrl) => {
    expect(() => fixture({ startUrl })).toThrow("web_login_unavailable");
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, 600_001])(
    "rejects an invalid local timeout %s",
    (timeoutMs) => {
      expect(() => fixture({ timeoutMs })).toThrow("web_login_unavailable");
    },
  );

  it("reports unavailable identity without leaking the authentication configuration", () => {
    vi.stubGlobal("chrome", {});
    expect(() => new ExtensionWebAuthService({ startUrl: START_URL })).toThrow(
      "web_login_unavailable",
    );
  });
});

describe("web authentication return validation", () => {
  it.each([
    ["missing response", () => undefined],
    ["invalid URL", () => "not a URL"],
    ["wrong state", (url: string) => new URL(url).href.replace(/state=[^&]+/, "state=other")],
    ["missing state", (url: string) => url.replace(/&state=[^&]+/, "")],
    ["repeated state", (url: string) => `${url}&state=other`],
    ["repeated code", (url: string) => `${url}&code=${CODE}`],
    ["encoded duplicate code", (url: string) => `${url}&%63ode=${CODE}`],
    ["unknown parameter", (url: string) => `${url}&access_token=secret`],
    ["fragment", (url: string) => `${url}#access_token=secret`],
    ["empty fragment", (url: string) => `${url}#`],
    ["wrong origin", (url: string) => url.replace(".chromiumapp.org", ".evil.example")],
    ["wrong extension", (url: string) => url.replace("a".repeat(32), "b".repeat(32))],
    ["wrong path", (url: string) => url.replace("/auth?", "/other?")],
    ["path suffix", (url: string) => url.replace("/auth?", "/auth/extra?")],
    ["encoded path", (url: string) => url.replace("/auth?", "/%61uth?")],
    ["wrong scheme", (url: string) => url.replace("https:", "http:")],
    ["credentials", (url: string) => url.replace("https://", "https://user:password@")],
    ["explicit default port", (url: string) => url.replace(".org/auth", ".org:443/auth")],
    ["leading whitespace", (url: string) => ` ${url}`],
    ["trailing query separator", (url: string) => `${url}&`],
    ["encoded parameter name", (url: string) => url.replace("code=", "%63ode=")],
    ["encoded opaque value", (url: string) => url.replace("code=A", "code=%41")],
    ["oversized URL", (url: string) => `${url}&extra=${"a".repeat(3_000)}`],
    ["mixed success and error", (url: string) => `${url}&error=access_denied`],
  ] as const)("rejects a %s callback", async (_name, transform) => {
    const context = fixture();
    const operation = context.service.authorize();
    await prepare();
    context.response.resolve(transform(context.callback()));
    await expect(operation).rejects.toMatchObject({ code: "web_login_invalid_callback" });
  });

  it.each([
    "",
    "abc",
    "A".repeat(32),
    "A".repeat(42),
    "A".repeat(44),
    "A".repeat(42) + "B",
    "A".repeat(42) + "_",
    "a".repeat(513),
    "access.token.jwt",
    "token with spaces",
    "<script>alert(1)</script>",
    "é".repeat(43),
  ])("rejects malformed authorization codes %s", async (code) => {
    const context = fixture();
    const operation = context.service.authorize();
    await prepare();
    context.response.resolve(context.callback({ code }));
    await expect(operation).rejects.toMatchObject({ code: "web_login_invalid_callback" });
  });

  it.each([
    ["access_denied", "web_login_denied"],
    ["login_required", "web_login_unavailable"],
    ["temporarily_unavailable", "web_login_unavailable"],
    ["server-provided-secret", "web_login_invalid_callback"],
  ])("maps server error %s to a controlled local error", async (error, expected) => {
    const context = fixture();
    const operation = context.service.authorize();
    await prepare();
    const url = new URL(context.callback());
    url.searchParams.delete("code");
    url.searchParams.set("error", error);
    context.response.resolve(url.href);
    await expect(operation).rejects.toMatchObject({
      name: "WebAuthError",
      code: expected,
      message: expected,
    });
  });

  it("requires state even when the return reports denial", async () => {
    const context = fixture();
    const operation = context.service.authorize();
    await prepare();
    context.response.resolve(`${REDIRECT_URI}?error=access_denied`);
    await expect(operation).rejects.toMatchObject({ code: "web_login_invalid_callback" });
  });

  it.each([
    "https://evil.example/auth",
    `https://${"a".repeat(32)}.chromiumapp.org/other`,
    `${REDIRECT_URI}?state=predefined`,
    `${REDIRECT_URI}#`,
    `https://${"x".repeat(32)}.chromiumapp.org/auth`,
  ])("rejects an unexpected identity redirect URL %s", async (redirect) => {
    const context = fixture();
    context.getRedirectURL.mockReturnValue(redirect);
    await expect(context.service.authorize()).rejects.toMatchObject({
      code: "web_login_unavailable",
    });
    expect(context.launchWebAuthFlow).not.toHaveBeenCalled();
  });

  it.each([
    ["The user did not approve access.", "web_login_cancelled"],
    ["User cancelled the flow.", "web_login_cancelled"],
    [`Navigation failed: ${START_URL}?state=SECRET`, "web_login_unavailable"],
  ])("does not propagate a browser error message %s", async (message, expected) => {
    const context = fixture();
    const operation = context.service.authorize();
    await prepare();
    context.response.reject(new Error(message));
    await expect(operation).rejects.toMatchObject({ code: expected, message: expected });
  });

  it("does not propagate a crypto failure or open the browser without PKCE", async () => {
    const context = fixture();
    vi.mocked(context.cryptoImpl.subtle.digest).mockRejectedValueOnce(new Error("verifier=SECRET"));
    await expect(context.service.authorize()).rejects.toEqual(
      new WebAuthError("web_login_unavailable"),
    );
    expect(context.launchWebAuthFlow).not.toHaveBeenCalled();
  });
});

describe("web authentication attempt lifecycle", () => {
  afterEach(() => vi.useRealTimers());

  it("rejects a concurrent call before random generation or a second native window", async () => {
    const context = fixture();
    const first = context.service.authorize();
    await expect(context.service.authorize()).rejects.toMatchObject({ code: "web_login_busy" });
    await prepare();
    expect(context.randomSizes).toEqual([32, 32]);
    expect(context.launchWebAuthFlow).toHaveBeenCalledOnce();
    context.response.resolve(context.callback());
    await first;
  });

  it("does not open a native window for a caller that was already aborted", async () => {
    const context = fixture();
    const controller = new AbortController();
    controller.abort();
    await expect(context.service.authorize(controller.signal)).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(context.randomSizes).toEqual([]);
    expect(context.launchWebAuthFlow).not.toHaveBeenCalled();
  });

  it("stops preparation when cancelled before the PKCE digest completes", async () => {
    const context = fixture();
    const digest = deferred<ArrayBuffer>();
    vi.mocked(context.cryptoImpl.subtle.digest).mockReturnValueOnce(digest.promise);
    const controller = new AbortController();
    const operation = context.service.authorize(controller.signal);
    controller.abort();
    await expect(operation).rejects.toMatchObject({ name: "AbortError" });
    digest.resolve(new ArrayBuffer(32));
    await prepare();
    expect(context.launchWebAuthFlow).not.toHaveBeenCalled();
  });

  it("isolates a cancelled native response from the replacement attempt and its lock", async () => {
    vi.useFakeTimers();
    const context = fixture();
    const controller = new AbortController();
    const operation = context.service.authorize(controller.signal);
    await prepare();
    const stale = context.callback();
    controller.abort();
    await expect(operation).rejects.toMatchObject({ name: "AbortError" });
    const nextResponse = deferred<string | undefined>();
    context.launchWebAuthFlow.mockReturnValueOnce(nextResponse.promise);
    const next = context.service.authorize();
    await prepare();
    expect(context.launchWebAuthFlow).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(context.launchWebAuthFlow).toHaveBeenCalledTimes(2);
    context.response.resolve(stale);
    await prepare();
    await expect(context.service.authorize()).rejects.toMatchObject({ code: "web_login_busy" });
    nextResponse.resolve(stale);
    await expect(next).rejects.toMatchObject({ code: "web_login_invalid_callback" });
  });

  it("retries after three expirations while all retired native flows remain pending", async () => {
    vi.useFakeTimers();
    const context = fixture({ timeoutMs: 30_000 });
    const responses = Array.from({ length: 4 }, () => deferred<string | undefined>());
    context.launchWebAuthFlow.mockImplementation(
      () => responses[context.launchWebAuthFlow.mock.calls.length - 1]!.promise,
    );
    const stale: string[] = [];
    for (let index = 0; index < 3; index++) {
      const operation = context.service.authorize();
      const failure = expect(operation).rejects.toMatchObject({ code: "web_login_timeout" });
      await prepare();
      expect(context.launchWebAuthFlow).toHaveBeenCalledTimes(index + 1);
      stale.push(context.callback({}, index));
      await vi.advanceTimersByTimeAsync(30_000);
      await failure;
    }
    const replacement = context.service.authorize();
    await prepare();
    expect(context.launchWebAuthFlow).toHaveBeenCalledTimes(4);
    responses[0]!.resolve(stale[0]);
    responses[1]!.reject(new Error("User cancelled the flow."));
    responses[2]!.resolve(stale[2]);
    await prepare();
    await expect(context.service.authorize()).rejects.toMatchObject({ code: "web_login_busy" });
    responses[3]!.resolve(context.callback({}, 3));
    await expect(replacement).resolves.toMatchObject({ code: CODE });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds rapid cancellation retries and cancels pending cooldowns without another native flow", async () => {
    vi.useFakeTimers();
    const context = fixture();
    const firstController = new AbortController();
    const first = context.service.authorize(firstController.signal);
    await prepare();
    firstController.abort();
    await expect(first).rejects.toMatchObject({ name: "AbortError" });
    const waitingController = new AbortController();
    const waiting = context.service.authorize(waitingController.signal);
    await prepare();
    await vi.advanceTimersByTimeAsync(999);
    expect(context.launchWebAuthFlow).toHaveBeenCalledOnce();
    waitingController.abort();
    await expect(waiting).rejects.toMatchObject({ name: "AbortError" });
    expect(vi.getTimerCount()).toBe(0);
    const response = deferred<string | undefined>();
    context.launchWebAuthFlow.mockReturnValueOnce(response.promise);
    const replacement = context.service.authorize();
    await prepare();
    await vi.advanceTimersByTimeAsync(1);
    expect(context.launchWebAuthFlow).toHaveBeenCalledTimes(2);
    response.resolve(context.callback({}, 1));
    await expect(replacement).resolves.toMatchObject({ code: CODE });
    context.response.resolve(context.callback());
    await prepare();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("checks the absolute deadline when a timer is delayed by worker suspension", async () => {
    let now = 1_000;
    const context = fixture({ now: () => now, timeoutMs: 30_000 });
    const operation = context.service.authorize();
    await prepare();
    now = 31_000;
    context.response.resolve(context.callback());
    await expect(operation).rejects.toMatchObject({ code: "web_login_timeout" });
  });

  it("releases the local lock after a definitive browser rejection", async () => {
    const context = fixture();
    const first = context.service.authorize();
    await prepare();
    context.response.reject(new Error("User cancelled the flow."));
    await expect(first).rejects.toMatchObject({ code: "web_login_cancelled" });
    const nextResponse = deferred<string | undefined>();
    context.launchWebAuthFlow.mockReturnValueOnce(nextResponse.promise);
    const next = context.service.authorize();
    await prepare();
    const start = new URL(context.launchWebAuthFlow.mock.calls[1]![0].url);
    nextResponse.resolve(`${REDIRECT_URI}?code=${CODE}&state=${start.searchParams.get("state")!}`);
    await expect(next).resolves.toMatchObject({ code: CODE });
  });

  it("removes its abort handler on success so a subsequent logout cannot alter the completed result", async () => {
    vi.useFakeTimers();
    const context = fixture();
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    const operation = context.service.authorize(controller.signal);
    await prepare();
    context.response.resolve(context.callback());
    await expect(operation).resolves.toMatchObject({ code: CODE });
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
    controller.abort();
    expect(vi.getTimerCount()).toBe(0);
  });
});
