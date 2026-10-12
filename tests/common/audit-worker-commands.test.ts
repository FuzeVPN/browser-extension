// SPDX-License-Identifier: MPL-2.0

import type { ControllerDependencies } from "../../src/core/background/state-machine";
import type {
  CommandResult,
  ExtensionRequest,
  ExtensionResponse,
  StateChangedMessage,
} from "../../src/core/shared/messages";
import { EMPTY_SNAPSHOT, type AppSnapshot } from "../../src/core/shared/state";
import type { ProxySession } from "../../src/core/api/types";
import type { ProxySettingsResult } from "../../src/core/background/proxy-controller";
import { proxySession } from "./helpers";

const worker = vi.hoisted<{
  controller: Record<string, unknown>;
  publish: ControllerDependencies["onStateChanged"] | undefined;
  apiFailure: (() => Error) | undefined;
}>(() => ({
  controller: {},
  publish: undefined,
  apiFailure: undefined,
}));

vi.mock("../../src/core/background/state-machine", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/core/background/state-machine")>();
  // Keep the error constructor from the same module generation as failedCommand.
  const { ApiError } = await import("../../src/core/api/client");
  worker.apiFailure = () => new ApiError("rate_limited", 429, 23);
  return {
    ...original,
    AppController: vi.fn(function (this: Record<string, unknown>, deps: ControllerDependencies) {
      Object.assign(this, worker.controller);
      worker.publish = deps.onStateChanged;
    }),
  };
});

type MessageListener = (
  message: unknown,
  sender: browser.runtime.MessageSender,
  sendResponse: (response: ExtensionResponse) => void,
) => boolean | undefined;
const EXTENSION_ID = "fuzevpn-firefox@vpn1euro.com";
const EXTENSION_HOST = "73d102e4-2b97-4f79-a2ca-c2449b331970";
const LOCATION_KEY = "fuzevpnLocationPreferences";
const LOCATION_ID = "frankfurt-01";
const COMMAND_METHODS = [
  "webLogin",
  "selectLocation",
  "connect",
  "changeLocation",
  "disconnect",
  "retryConnection",
  "updateSecurityPreferences",
  "logout",
  "resendVerification",
  "refreshAccount",
  "refreshLocations",
  "refreshDevices",
  "deleteDevice",
  "resetDeviceIdentity",
] as const;

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function fixture(
  options: {
    catalogsUnavailable?: boolean;
    favorites?: string[];
    initializationFailure?: Error;
    diagnosticRecorder?: boolean;
  } = {},
) {
  vi.resetModules();
  const { DiagnosticService } = await import("../../src/core/diagnostics/service");
  const diagnosticPermissionsRemoved = vi
    .spyOn(DiagnosticService.prototype, "permissionsRemoved")
    .mockImplementation(() => undefined);
  const diagnosticPermissionsChanged = vi
    .spyOn(DiagnosticService.prototype, "permissionsChanged")
    .mockImplementation(() => undefined);
  const diagnosticRecords =
    vi.fn<(event: string, result: CommandResult, elapsed?: number) => void>();
  if (options.diagnosticRecorder) {
    vi.spyOn(DiagnosticService.prototype, "capture").mockImplementation(
      (event) => (result, elapsed) => diagnosticRecords(event, result, elapsed),
    );
  }
  const snapshot: AppSnapshot = {
    ...structuredClone(EMPTY_SNAPSHOT),
    status: "disconnected",
    profile: {
      userId: "test-account",
      email: "user@example.com",
      firstName: "Test",
      lastName: "User",
      countryCode: "FR",
    },
    locations: [
      {
        id: LOCATION_ID,
        city: "Frankfurt",
        countryCode: "DE",
        displayName: "Frankfurt 1",
        supportedProtocols: ["browser_proxy"],
      },
    ],
  };
  const stored: Record<string, unknown> = {
    [LOCATION_KEY]: {
      favoriteIds: options.favorites ?? [],
      recentIds: [],
      automatic: false,
    },
  };
  const business = vi.fn<(...args: unknown[]) => Promise<CommandResult>>(async () => ({
    ok: true,
  }));
  const initialize = vi.fn<() => Promise<void>>(async () => undefined);
  if (options.initializationFailure)
    initialize.mockRejectedValueOnce(options.initializationFailure);
  const lifecycle = vi.fn<(...args: unknown[]) => Promise<void>>(async () => undefined);
  const getSnapshot = vi.fn(() => structuredClone(snapshot));
  const getActiveSession = vi.fn<() => Promise<ProxySession | null>>(async () => null);
  const isSessionCurrentForProxyAuth = vi.fn(() => true);
  const retries = { attempts: 0 };
  worker.controller = {
    initialize,
    getSnapshot,
    getActiveSession,
    isSessionCurrentForProxyAuth,
    ...(options.diagnosticRecorder
      ? {
          getDiagnosticReadState: () => ({
            snapshot: structuredClone(snapshot),
            reconnectAttempts: retries.attempts,
            safety: {},
            proxyCreationUncertain: false,
            proxyCleanupUncertain: false,
          }),
        }
      : {}),
    ...Object.fromEntries(
      [
        "handleAlarm",
        "handleProxyControlLost",
        "handleProxyError",
        "handlePrivacyChange",
        "handleProxyPermissionsChanged",
      ].map((name) => [name, (...args: unknown[]) => lifecycle(name, ...args)]),
    ),
    ...Object.fromEntries(
      COMMAND_METHODS.map((name) => [name, (...args: unknown[]) => business(name, ...args)]),
    ),
  };
  worker.publish = undefined;
  let listener: MessageListener | undefined;
  const events = new Map<string, (...args: unknown[]) => unknown>();
  const event = (name: string) => ({
    addListener: vi.fn((registered: (...args: unknown[]) => unknown) => {
      events.set(name, registered);
    }),
  });
  const sendMessage = vi.fn<(message: StateChangedMessage) => Promise<void>>(async () => undefined);
  const setTitle = vi.fn<(details: { title: string }) => Promise<void>>(async () => undefined);
  const storageWrite = vi.fn(async (value: Record<string, unknown>) => {
    Object.assign(stored, structuredClone(value));
  });
  const proxyGet = vi.fn<() => Promise<ProxySettingsResult>>(async () => ({
    value: { proxyType: "system" },
    levelOfControl: "controlled_by_other_extensions",
  }));
  vi.stubGlobal("browser", {
    runtime: {
      id: EXTENSION_ID,
      getURL: (path: string) => `moz-extension://${EXTENSION_HOST}/${path}`,
      onMessage: {
        addListener: vi.fn((registered: MessageListener) => {
          listener = registered;
        }),
      },
      onStartup: event("runtime.onStartup"),
      onInstalled: event("runtime.onInstalled"),
      sendMessage,
    },
    i18n: { getUILanguage: () => "fr", getMessage: (key: string) => `native:${key}` },
    alarms: { onAlarm: event("alarms.onAlarm") },
    proxy: {
      settings: {
        get: proxyGet,
        onChange: event("proxy.settings.onChange"),
      },
      onError: event("proxy.onError"),
    },
    permissions: {
      onRemoved: event("permissions.onRemoved"),
      onAdded: event("permissions.onAdded"),
      getAll: vi.fn(async () => ({ data_collection: [] })),
    },
    privacy: {
      network: {
        webRTCIPHandlingPolicy: { onChange: event("privacy.webRTCIPHandlingPolicy.onChange") },
        networkPredictionEnabled: { onChange: event("privacy.networkPredictionEnabled.onChange") },
      },
    },
    webRequest: {
      onBeforeRequest: event("webRequest.onBeforeRequest"),
      onBeforeSendHeaders: event("webRequest.onBeforeSendHeaders"),
      onAuthRequired: event("webRequest.onAuthRequired"),
      onCompleted: event("webRequest.onCompleted"),
      onErrorOccurred: event("webRequest.onErrorOccurred"),
    },
    storage: {
      local: {
        get: async (key: string) => ({ [key]: structuredClone(stored[key]) }),
        set: storageWrite,
      },
    },
    action: { setBadgeText: vi.fn(async () => undefined), setTitle },
  });
  const fetcher = vi.fn(async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith(`moz-extension://${EXTENSION_HOST}/`))
      throw new Error("External network access is forbidden in worker tests");
    if (url.includes("/_locales/") && !options.catalogsUnavailable)
      return new Response(JSON.stringify({}), { status: 200 });
    return new Response(null, { status: 404 });
  });
  vi.stubGlobal("fetch", fetcher);
  await import("../../src/core/background/service-worker");
  const sender: browser.runtime.MessageSender = {
    id: EXTENSION_ID,
    url: `moz-extension://${EXTENSION_HOST}/popup.html`,
  };
  const dispatch = (
    message: unknown,
    from: browser.runtime.MessageSender,
    respond: (response: ExtensionResponse) => void,
  ) => {
    if (!listener) throw new Error("Worker message listener was not registered");
    return listener(message, from, respond);
  };
  const send = (message: ExtensionRequest) =>
    new Promise<ExtensionResponse>((resolve, reject) => {
      if (dispatch(message, sender, resolve) !== true) reject(new Error("Message was rejected"));
    });
  const emitEvent = (name: string, ...args: unknown[]) => {
    const registered = events.get(name);
    if (!registered) throw new Error(`Event ${name} was not registered`);
    return registered(...args);
  };
  return {
    snapshot,
    stored,
    business,
    fetcher,
    send,
    dispatch,
    sender,
    sendMessage,
    setTitle,
    storageWrite,
    initialize,
    getSnapshot,
    getActiveSession,
    isSessionCurrentForProxyAuth,
    proxyGet,
    lifecycle,
    emitEvent,
    diagnosticRecords,
    diagnosticPermissionsRemoved,
    diagnosticPermissionsChanged,
    retries,
  };
}

describe("worker command responses and fallback publication", () => {
  beforeEach(() => vi.spyOn(console, "warn").mockImplementation(() => undefined));
  afterEach(async () => {
    // Let detached publication promises finish before replacing Chrome globals.
    await new Promise<void>((resolve) => setImmediate(resolve));
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  const commands: { request: ExtensionRequest; method: string; args: unknown[] }[] = [
    {
      request: { type: "web_login", disconnectFirst: false },
      method: "webLogin",
      args: [false, "fr"],
    },
    {
      request: { type: "select_automatic_location" },
      method: "selectLocation",
      args: [LOCATION_ID],
    },
    {
      request: { type: "select_location", locationId: LOCATION_ID },
      method: "selectLocation",
      args: [LOCATION_ID],
    },
    {
      request: { type: "connect", locationId: LOCATION_ID },
      method: "connect",
      args: [LOCATION_ID],
    },
    {
      request: { type: "change_location", locationId: LOCATION_ID },
      method: "changeLocation",
      args: [LOCATION_ID],
    },
    { request: { type: "disconnect" }, method: "disconnect", args: [] },
    { request: { type: "retry_connection" }, method: "retryConnection", args: [] },
    {
      request: {
        type: "update_security_preferences",
        killSwitchEnabled: true,
        webRtcProtectionEnabled: false,
      },
      method: "updateSecurityPreferences",
      args: [true, false],
    },
    { request: { type: "logout" }, method: "logout", args: [] },
    { request: { type: "resend_verification" }, method: "resendVerification", args: [] },
    { request: { type: "refresh_account" }, method: "refreshAccount", args: [] },
    { request: { type: "refresh_locations" }, method: "refreshLocations", args: [] },
    { request: { type: "refresh_devices" }, method: "refreshDevices", args: [] },
    {
      request: { type: "delete_device", deviceId: "old-device" },
      method: "deleteDevice",
      args: ["old-device"],
    },
    { request: { type: "reset_device_identity" }, method: "resetDeviceIdentity", args: [] },
  ];

  it.each(commands)(
    "preserves the business failure for $request.type",
    async ({ request, method, args }) => {
      const f = await fixture();
      const failure: CommandResult = {
        ok: false,
        commandError: "rate_limited",
        commandRetryAfterSeconds: 17,
      };
      f.business.mockResolvedValue(failure);
      await expect(f.send(request)).resolves.toMatchObject({
        ...failure,
        snapshot: { status: "disconnected", error: null },
      });
      expect(f.business).toHaveBeenCalledExactlyOnceWith(method, ...args);
    },
  );

  it("preserves a superseded result without changing it into success", async () => {
    const f = await fixture();
    f.business.mockResolvedValue({ ok: false, superseded: true });
    await expect(f.send({ type: "disconnect" })).resolves.toMatchObject({
      ok: false,
      superseded: true,
    });
  });

  it("leaves automatic selection to the refreshed catalog while already protected", async () => {
    const f = await fixture();
    f.snapshot.protected = true;
    f.snapshot.locations = [];
    await expect(f.send({ type: "select_automatic_location" })).resolves.toMatchObject({
      ok: true,
    });
    expect(f.business).toHaveBeenCalledExactlyOnceWith("connect", null);
  });

  it("preserves a capacity refusal through a catalog refresh response", async () => {
    const f = await fixture();
    f.snapshot.error = "server_full";
    await expect(f.send({ type: "refresh_locations" })).resolves.toMatchObject({
      ok: true,
      snapshot: { error: "server_full" },
    });
    expect(f.business).toHaveBeenCalledExactlyOnceWith("refreshLocations");
  });

  it("maps thrown API failures to command diagnostics independently of snapshot.error", async () => {
    const f = await fixture();
    if (!worker.apiFailure) throw new Error("API failure factory was not initialized");
    f.business.mockRejectedValue(worker.apiFailure());
    await expect(f.send({ type: "refresh_devices" })).resolves.toMatchObject({
      ok: false,
      commandError: "rate_limited",
      commandRetryAfterSeconds: 23,
      snapshot: { error: null },
    });
  });

  it("keeps snapshots and state publications available when both language catalogs fail", async () => {
    const f = await fixture({ catalogsUnavailable: true });
    await expect(f.send({ type: "get_snapshot" })).resolves.toMatchObject({
      ok: true,
      snapshot: { effectiveLanguage: "fr" },
    });
    f.snapshot.status = "blocked";
    f.snapshot.error = "proxy_authentication_failed";
    worker.publish?.(f.snapshot);
    await vi.waitFor(() =>
      expect(f.sendMessage.mock.calls.at(-1)?.[0]).toMatchObject({
        type: "state_changed",
        snapshot: { status: "blocked", error: "proxy_authentication_failed" },
      }),
    );
    expect(f.setTitle).toHaveBeenCalledWith({ title: "native:actionBlocked" });
    expect(
      f.fetcher.mock.calls.some(
        ([input]) => typeof input === "string" && input.includes("/_locales/en/"),
      ),
    ).toBe(true);
    expect(console.warn).toHaveBeenCalledWith(
      "Language preferences unavailable; using browser messages.",
    );
  });

  it("removes an unavailable favorite durably for an active account", async () => {
    const f = await fixture({ favorites: ["retired-location", LOCATION_ID] });
    await expect(
      f.send({ type: "set_location_favorite", locationId: "retired-location", favorite: false }),
    ).resolves.toMatchObject({
      ok: true,
      snapshot: { locationPreferences: { favoriteIds: [LOCATION_ID] } },
    });
    expect(f.stored[LOCATION_KEY]).toMatchObject({ favoriteIds: [LOCATION_ID] });
    expect(f.storageWrite).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(f.sendMessage).toHaveBeenCalled());
  });

  it("refuses adding an unavailable favorite without writing preferences", async () => {
    const f = await fixture();
    await expect(
      f.send({ type: "set_location_favorite", locationId: "retired-location", favorite: true }),
    ).resolves.toMatchObject({ ok: false, commandError: "invalid_location" });
    expect(f.storageWrite).not.toHaveBeenCalled();
  });

  it("requires an active account even when removing an unavailable favorite", async () => {
    const f = await fixture({ favorites: ["retired-location"] });
    f.snapshot.profile = null;
    await expect(
      f.send({ type: "set_location_favorite", locationId: "retired-location", favorite: false }),
    ).resolves.toMatchObject({ ok: false, commandError: "unauthorized" });
    expect(f.storageWrite).not.toHaveBeenCalled();
  });

  it.each([
    { id: "other-extension", url: `moz-extension://${EXTENSION_HOST}/popup.html` },
    { id: EXTENSION_ID, url: "https://example.com/" },
    { id: EXTENSION_ID },
    { id: EXTENSION_ID, url: `moz-extension://${EXTENSION_HOST}.attacker/popup.html` },
  ])("rejects messages from a sender outside the extension: $url", async (sender) => {
    const f = await fixture();
    const response = vi.fn();
    expect(f.dispatch({ type: "disconnect" }, sender, response)).toBe(false);
    expect(response).not.toHaveBeenCalled();
    expect(f.business).not.toHaveBeenCalled();
  });

  it.each([
    { type: "set_location_favorite", locationId: LOCATION_ID, favorite: "false" },
    { type: "login", email: "alice@example.test", password: "fixture-password" },
    { type: "web_login", disconnectFirst: false, password: "fixture-password" },
  ])("rejects malformed or obsolete commands from a trusted extension sender", async (request) => {
    const f = await fixture();
    const response = vi.fn();
    expect(f.dispatch(request, f.sender, response)).toBe(false);
    expect(response).not.toHaveBeenCalled();
    expect(f.storageWrite).not.toHaveBeenCalled();
  });

  it.each(["logout", "disconnect"] as const)(
    "does not open web authentication after a newer %s during language initialization",
    async (type) => {
      const f = await fixture();
      const { LanguageController } = await import("../../src/core/background/language-controller");
      const reading = deferred();
      const initializeLanguage = vi
        .spyOn(LanguageController.prototype, "initialize")
        .mockImplementation(() => reading.promise);
      const pending = f.send({ type: "web_login", disconnectFirst: true });
      expect(initializeLanguage).toHaveBeenCalled();
      const newer = f.send({ type });
      expect(f.business).toHaveBeenCalledWith(type);
      reading.resolve();
      const result = await pending;
      await newer;
      expect(result).toMatchObject({ ok: false, superseded: true });
      expect(f.business.mock.calls.some(([method]) => method === "webLogin")).toBe(false);
    },
  );

  it.each([false, true])(
    "keeps an in-flight request valid during catalog, device and language publications (protected=%s)",
    async (protectedMode) => {
      const f = await fixture();
      const session = proxySession();
      if (protectedMode) {
        const { proxyConfig } = await import("../../src/core/background/proxy-controller");
        Object.assign(f.snapshot, {
          status: "connected",
          protected: true,
          protectionRequested: true,
          activeLocationId: session.locationId,
          webRtcProtected: true,
        });
        f.proxyGet.mockResolvedValue({
          value: proxyConfig(session),
          levelOfControl: "controlled_by_this_extension",
        });
      }
      const reading = deferred();
      f.getActiveSession.mockImplementationOnce(async () => {
        await reading.promise;
        return protectedMode ? session : null;
      });
      const pending = f.emitEvent("webRequest.onBeforeSendHeaders", {
        url: "https://example.com/",
        type: "main_frame",
        ...(protectedMode
          ? { proxyInfo: { type: "https", host: session.host, port: session.port } }
          : {}),
      });
      await vi.waitFor(() => expect(f.getActiveSession).toHaveBeenCalled());
      f.snapshot.locations.push({ ...f.snapshot.locations[0]!, id: "another-location" });
      f.snapshot.deviceLimit = 99;
      f.snapshot.effectiveLanguage = "ar";
      f.snapshot.profile!.firstName = "Updated name";
      f.snapshot.error = "network_error";
      f.snapshot.status = "error";
      worker.publish?.(f.snapshot);
      reading.resolve();
      await expect(pending).resolves.toEqual({});
    },
  );

  it.each([
    [
      "protection intent",
      (snapshot: AppSnapshot): void => {
        snapshot.protectionRequested = true;
      },
    ],
    [
      "traffic guard",
      (snapshot: AppSnapshot): void => {
        snapshot.trafficBlocked = true;
      },
    ],
    [
      "blocking scope",
      (snapshot: AppSnapshot): void => {
        snapshot.blockingScope = "unverified";
      },
    ],
    [
      "protected status",
      (snapshot: AppSnapshot): void => {
        snapshot.protected = true;
      },
    ],
    [
      "kill switch",
      (snapshot: AppSnapshot): void => {
        snapshot.securityPreferences.killSwitchEnabled = false;
      },
    ],
    [
      "WebRTC preference",
      (snapshot: AppSnapshot): void => {
        snapshot.securityPreferences.webRtcProtectionEnabled = false;
      },
    ],
    [
      "WebRTC control",
      (snapshot: AppSnapshot): void => {
        snapshot.webRtcProtected = true;
      },
    ],
    [
      "active location",
      (snapshot: AppSnapshot): void => {
        snapshot.activeLocationId = "replacement";
      },
    ],
    [
      "account owner",
      (snapshot: AppSnapshot): void => {
        snapshot.profile!.userId = "replacement";
      },
    ],
    [
      "exclusion transaction",
      (snapshot: AppSnapshot): void => {
        snapshot.siteExclusions.pending = true;
      },
    ],
    [
      "exclusion error",
      (snapshot: AppSnapshot): void => {
        snapshot.siteExclusions.error = true;
      },
    ],
    [
      "connection transition",
      (snapshot: AppSnapshot): void => {
        snapshot.status = "connecting";
      },
    ],
  ] as const)("cancels an in-flight route read after a %s change", async (_name, mutate) => {
    const f = await fixture();
    const reading = deferred();
    f.getActiveSession.mockImplementationOnce(async () => {
      await reading.promise;
      return null;
    });
    const pending = f.emitEvent("webRequest.onBeforeSendHeaders", {
      url: "https://example.com/",
      type: "main_frame",
    });
    await vi.waitFor(() => expect(f.getActiveSession).toHaveBeenCalled());
    mutate(f.snapshot);
    worker.publish?.(f.snapshot);
    reading.resolve();
    await expect(pending).resolves.toEqual({ cancel: true });
  });

  it.each([
    "proxy.settings.onChange",
    "permissions.onRemoved",
    "privacy.webRTCIPHandlingPolicy.onChange",
    "privacy.networkPredictionEnabled.onChange",
  ])(
    "cancels a route read immediately on %s before controller recovery finishes",
    async (event) => {
      const f = await fixture();
      const reading = deferred();
      f.getActiveSession.mockImplementationOnce(async () => {
        await reading.promise;
        return null;
      });
      const pending = f.emitEvent("webRequest.onBeforeSendHeaders", {
        url: "https://example.com/",
        type: "main_frame",
      });
      await vi.waitFor(() => expect(f.getActiveSession).toHaveBeenCalled());
      f.emitEvent(event, ...(event === "permissions.onRemoved" ? [{}] : []));
      reading.resolve();
      await expect(pending).resolves.toEqual({ cancel: true });
    },
  );

  it("suspends diagnostics synchronously without invalidating VPN routing when only Mozilla diagnostic consent is removed", async () => {
    const f = await fixture();
    const reading = deferred();
    f.getActiveSession.mockImplementationOnce(async () => {
      await reading.promise;
      return null;
    });
    const pending = f.emitEvent("webRequest.onBeforeSendHeaders", {
      url: "https://example.com/",
      type: "main_frame",
    });
    await vi.waitFor(() => expect(f.getActiveSession).toHaveBeenCalled());
    f.emitEvent("permissions.onRemoved", { data_collection: ["technicalAndInteraction"] });
    expect(f.diagnosticPermissionsRemoved).toHaveBeenCalledTimes(1);
    reading.resolve();
    await expect(pending).resolves.toEqual({});
    expect(f.lifecycle).not.toHaveBeenCalled();
  });

  it("rechecks diagnostics on Mozilla consent grant without calling VPN lifecycle handlers", async () => {
    const f = await fixture();
    f.emitEvent("permissions.onAdded", { data_collection: ["technicalAndInteraction"] });
    expect(f.diagnosticPermissionsChanged).toHaveBeenCalledTimes(1);
    expect(f.lifecycle).not.toHaveBeenCalled();
    f.emitEvent("permissions.onAdded", { permissions: ["proxy"] });
    expect(f.diagnosticPermissionsChanged).toHaveBeenCalledTimes(1);
  });

  it("still repairs VPN permissions when the same event also removes Mozilla diagnostic consent", async () => {
    const f = await fixture();
    f.emitEvent("permissions.onRemoved", {
      data_collection: ["technicalAndInteraction"],
      permissions: ["proxy"],
    });
    expect(f.diagnosticPermissionsRemoved).toHaveBeenCalledTimes(1);
    await vi.waitFor(() =>
      expect(f.lifecycle).toHaveBeenCalledWith("handleProxyPermissionsChanged"),
    );
  });

  it("still rejects a proxy session revoked after its route was read", async () => {
    const f = await fixture();
    const session = proxySession();
    const { proxyConfig } = await import("../../src/core/background/proxy-controller");
    f.proxyGet.mockResolvedValue({
      value: proxyConfig(session),
      levelOfControl: "controlled_by_this_extension",
    });
    f.getActiveSession.mockResolvedValue(session);
    f.isSessionCurrentForProxyAuth.mockReturnValueOnce(true).mockReturnValue(false);
    await expect(
      f.emitEvent("webRequest.onBeforeSendHeaders", {
        url: "https://example.com/",
        type: "main_frame",
        proxyInfo: { type: "https", host: session.host, port: session.port },
      }),
    ).resolves.toEqual({ cancel: true });
    expect(f.isSessionCurrentForProxyAuth).toHaveBeenCalledTimes(2);
  });

  it("still rejects a changed exclusion policy before it is published", async () => {
    const f = await fixture();
    const { PlatformNetworkSafetyService } =
      await import("../../src/core/background/network-safety");
    vi.spyOn(PlatformNetworkSafetyService.prototype, "getRouteExclusions")
      .mockReturnValueOnce([])
      .mockReturnValue([{ domain: "example.com", includeSubdomains: false }]);
    await expect(
      f.emitEvent("webRequest.onBeforeSendHeaders", {
        url: "https://example.com/",
        type: "main_frame",
      }),
    ).resolves.toEqual({ cancel: true });
  });

  it("coalesces a synchronous burst into one publication of the latest snapshot", async () => {
    const f = await fixture();
    await f.send({ type: "get_snapshot" });
    for (let index = 0; index < 50; index += 1) {
      f.snapshot.status = "blocked";
      f.snapshot.trafficBlocked = true;
      f.snapshot.error = index === 49 ? "network_error" : "proxy_unavailable";
      worker.publish?.(f.snapshot);
    }
    await vi.waitFor(() => expect(f.sendMessage).toHaveBeenCalledOnce());
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(f.sendMessage).toHaveBeenCalledOnce();
    expect(f.setTitle).toHaveBeenCalledOnce();
    expect(f.sendMessage.mock.calls[0]?.[0].snapshot).toMatchObject({
      status: "blocked",
      error: "network_error",
      trafficBlocked: true,
    });
  });

  it("coalesces changes during an action update into one subsequent publication with ordered versions", async () => {
    const f = await fixture();
    await f.send({ type: "get_snapshot" });
    const action = deferred();
    f.setTitle.mockImplementationOnce(() => action.promise);
    worker.publish?.(f.snapshot);
    await vi.waitFor(() => expect(f.setTitle).toHaveBeenCalledOnce());
    expect(f.sendMessage).not.toHaveBeenCalled();
    for (let index = 0; index < 50; index += 1) {
      f.snapshot.status = "blocked";
      f.snapshot.trafficBlocked = true;
      f.snapshot.error = index === 49 ? "network_error" : "proxy_unavailable";
      worker.publish?.(f.snapshot);
    }
    const command = await f.send({ type: "get_snapshot" });
    action.resolve();
    await vi.waitFor(() => expect(f.sendMessage).toHaveBeenCalledTimes(2));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(f.setTitle).toHaveBeenCalledTimes(2);
    expect(f.sendMessage).toHaveBeenCalledTimes(2);
    const first = f.sendMessage.mock.calls[0]![0].snapshot;
    const second = f.sendMessage.mock.calls[1]![0].snapshot;
    for (const snapshot of [first, second]) {
      expect(snapshot).toMatchObject({ status: "blocked", error: "network_error" });
      expect(snapshot.snapshotVersion?.workerId).toBe(command.snapshot.snapshotVersion?.workerId);
    }
    expect(first.snapshotVersion!.revision).toBeGreaterThan(
      command.snapshot.snapshotVersion!.revision,
    );
    expect(second.snapshotVersion!.revision).toBeGreaterThan(first.snapshotVersion!.revision);
    expect(f.setTitle.mock.calls[1]).toEqual([{ title: "actionBlocked" }]);
  });

  it("publishes the latest change after a previous broadcast settles", async () => {
    const f = await fixture();
    await f.send({ type: "get_snapshot" });
    const broadcast = deferred();
    f.sendMessage.mockImplementationOnce(() => broadcast.promise);
    worker.publish?.(f.snapshot);
    await vi.waitFor(() => expect(f.sendMessage).toHaveBeenCalledOnce());
    f.snapshot.status = "error";
    f.snapshot.error = "proxy_unavailable";
    for (let index = 0; index < 20; index += 1) worker.publish?.(f.snapshot);
    const command = await f.send({ type: "get_snapshot" });
    broadcast.resolve();
    await vi.waitFor(() => expect(f.sendMessage).toHaveBeenCalledTimes(2));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(f.sendMessage).toHaveBeenCalledTimes(2);
    const latest = f.sendMessage.mock.calls[1]![0].snapshot;
    expect(latest).toMatchObject({ status: "error", error: "proxy_unavailable" });
    expect(latest.snapshotVersion!.revision).toBeGreaterThan(
      command.snapshot.snapshotVersion!.revision,
    );
  });

  it("does not strand subsequent publications after a snapshot capture failure", async () => {
    const f = await fixture();
    f.getSnapshot.mockImplementationOnce(() => {
      throw new Error("sensitive snapshot detail");
    });
    worker.publish?.(f.snapshot);
    await vi.waitFor(() =>
      expect(console.warn).toHaveBeenCalledWith("Background event failed", {
        event: "state_publication",
        code: "unknown_error",
      }),
    );
    f.snapshot.status = "blocked";
    worker.publish?.(f.snapshot);
    await vi.waitFor(() => expect(f.sendMessage).toHaveBeenCalledOnce());
    expect(f.sendMessage.mock.calls[0]?.[0].snapshot.status).toBe("blocked");
    expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toContain("sensitive");
  });

  const lifecycleEvents = [
    {
      event: "alarms.onAlarm",
      args: [{ name: "sensitive-alarm-detail" }],
      controllerArgs: ["handleAlarm", "sensitive-alarm-detail"],
    },
    { event: "runtime.onStartup", args: [], controllerArgs: [] },
    { event: "runtime.onInstalled", args: [{ reason: "update" }], controllerArgs: [] },
    {
      event: "proxy.settings.onChange",
      args: [{ levelOfControl: "controlled_by_other_extensions" }],
      controllerArgs: ["handleProxyControlLost", "controlled_by_other_extensions"],
    },
    {
      event: "proxy.onError",
      args: [{ message: "sensitive-proxy-detail" }],
      controllerArgs: ["handleProxyError", "sensitive-proxy-detail", false],
    },
    {
      event: "privacy.webRTCIPHandlingPolicy.onChange",
      args: [],
      controllerArgs: ["handlePrivacyChange"],
    },
  ];

  it("does not count three no-op background notifications as failures of an old network error", async () => {
    const f = await fixture({ diagnosticRecorder: true });
    await new Promise<void>((resolve) => setImmediate(resolve));
    f.snapshot.status = "error";
    f.snapshot.error = "network_error";
    f.snapshot.nextRetryAt = 1_000_000;
    f.diagnosticRecords.mockClear();
    f.emitEvent("proxy.settings.onChange", { levelOfControl: "controllable_by_this_extension" });
    f.emitEvent("proxy.onError", { message: "NS_ERROR_ABORT" });
    f.emitEvent("privacy.webRTCIPHandlingPolicy.onChange");
    await vi.waitFor(() => expect(f.lifecycle).toHaveBeenCalledTimes(3));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(f.diagnosticRecords).not.toHaveBeenCalled();
    expect(f.snapshot).toMatchObject({ status: "error", error: "network_error" });
  });

  it("records a new background failure when the operation changes a previously clean state", async () => {
    const f = await fixture({ diagnosticRecorder: true });
    await new Promise<void>((resolve) => setImmediate(resolve));
    f.diagnosticRecords.mockClear();
    f.lifecycle.mockImplementationOnce(async () => {
      f.snapshot.status = "blocked";
      f.snapshot.error = "webrtc_control_unavailable";
    });
    f.emitEvent("privacy.webRTCIPHandlingPolicy.onChange");
    await vi.waitFor(() =>
      expect(f.diagnosticRecords).toHaveBeenCalledExactlyOnceWith(
        "privacy.changed",
        { ok: false, commandError: "webrtc_control_unavailable" },
        expect.any(Number),
      ),
    );
  });

  it("records another real retry even when its resulting error code and state are unchanged", async () => {
    const f = await fixture({ diagnosticRecorder: true });
    await new Promise<void>((resolve) => setImmediate(resolve));
    f.snapshot.status = "error";
    f.snapshot.error = "network_error";
    f.snapshot.nextRetryAt = 1_000_000;
    f.diagnosticRecords.mockClear();
    f.lifecycle.mockImplementationOnce(async () => {
      f.retries.attempts += 1;
      f.snapshot.nextRetryAt = 1_060_000;
    });
    f.emitEvent("alarms.onAlarm", { name: "fuzevpn-proxy-reconnect" });
    await vi.waitFor(() =>
      expect(f.diagnosticRecords).toHaveBeenCalledExactlyOnceWith(
        "alarms.onAlarm",
        { ok: false, commandError: "network_error" },
        expect.any(Number),
      ),
    );
  });

  it.each(lifecycleEvents)(
    "handles a final $event rejection without logging sensitive details or preventing the next event",
    async ({ event, args, controllerArgs }) => {
      const f = await fixture();
      const original = structuredClone(f.snapshot);
      const handler = event.startsWith("runtime.") ? f.initialize : f.lifecycle;
      handler.mockClear();
      handler.mockRejectedValueOnce(new Error("sensitive-token https://private.invalid/path"));
      f.emitEvent(event, ...args);
      await vi.waitFor(() =>
        expect(console.warn).toHaveBeenCalledExactlyOnceWith("Background event failed", {
          event:
            event === "proxy.onError"
              ? "proxy.error"
              : event.startsWith("privacy.")
                ? "privacy.changed"
                : event,
          code: "unknown_error",
        }),
      );
      expect(handler.mock.calls[0]).toEqual(controllerArgs);
      expect(f.snapshot).toEqual(original);
      expect(f.business).not.toHaveBeenCalled();
      expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toMatch(/sensitive|private/);
      f.emitEvent(event, ...args);
      await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(2));
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(console.warn).toHaveBeenCalledOnce();
    },
  );

  it("normalizes a known API event failure without logging the raw exception", async () => {
    const f = await fixture();
    if (!worker.apiFailure) throw new Error("API failure factory was not initialized");
    f.lifecycle.mockRejectedValueOnce(worker.apiFailure());
    f.emitEvent("alarms.onAlarm", { name: "private-alarm" });
    await vi.waitFor(() =>
      expect(console.warn).toHaveBeenCalledExactlyOnceWith("Background event failed", {
        event: "alarms.onAlarm",
        code: "rate_limited",
      }),
    );
  });

  it("ignores a legitimate event cancellation and still handles the following event", async () => {
    const f = await fixture();
    f.lifecycle.mockRejectedValueOnce(new DOMException("sensitive cancellation", "AbortError"));
    f.emitEvent("alarms.onAlarm", { name: "test" });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(console.warn).not.toHaveBeenCalled();
    f.emitEvent("alarms.onAlarm", { name: "next" });
    await vi.waitFor(() => expect(f.lifecycle).toHaveBeenCalledTimes(2));
    expect(console.warn).not.toHaveBeenCalled();
  });

  it("catches initial startup rejection and permits a later successful initialization", async () => {
    const f = await fixture({ initializationFailure: new Error("sensitive startup failure") });
    await vi.waitFor(() =>
      expect(console.warn).toHaveBeenCalledExactlyOnceWith("Background event failed", {
        event: "initialize",
        code: "unknown_error",
      }),
    );
    f.emitEvent("runtime.onStartup");
    await vi.waitFor(() => expect(f.initialize).toHaveBeenCalledTimes(2));
    await expect(f.send({ type: "get_snapshot" })).resolves.toMatchObject({ ok: true });
    expect(console.warn).toHaveBeenCalledOnce();
  });
});
