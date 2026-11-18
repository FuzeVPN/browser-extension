// SPDX-License-Identifier: MPL-2.0

import { settleWorker, watched } from "./worker-settle";
import type { SiteExclusion } from "../../src/core/shared/site-exclusions";
import { authenticatedState, createHarness, FakeSafety, LOCATIONS, NOW } from "./helpers";

const shared = vi.hoisted<{ harness: ReturnType<typeof createHarness> | null }>(() => ({
  harness: null,
}));

vi.mock("../../src/core/api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/core/api/client")>()),
  ApiClient: function () {
    return shared.harness!.api;
  },
}));
vi.mock("../../src/core/storage/storage", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/core/storage/storage")>()),
  ExtensionStorageService: function () {
    return shared.harness!.storage;
  },
}));
vi.mock("../../src/core/device/device-identity", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/core/device/device-identity")>()),
  IndexedDbDeviceIdentityService: function () {
    return shared.harness!.identity;
  },
}));
vi.mock("../../src/core/background/proxy-controller", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/core/background/proxy-controller")>()),
  PlatformProxyService: function () {
    return shared.harness!.proxy;
  },
}));
vi.mock("../../src/core/background/network-safety", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/core/background/network-safety")>()),
  PlatformNetworkSafetyService: function () {
    return shared.harness!.safety;
  },
}));
vi.mock("../../src/core/background/session-refresh", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/core/background/session-refresh")>()),
  ExtensionAlarmService: function () {
    return shared.harness!.alarms;
  },
}));
vi.mock("../../src/core/storage/security-storage", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/core/storage/security-storage")>()),
  ExtensionSecurityStorage: function () {
    return shared.harness!.securityStorage;
  },
}));

const EXTENSION_ID = "fuzevpn-firefox@vpn1euro.com";
const EXTENSION_ROOT = "moz-extension://73d102e4-2b97-4f79-a2ca-c2449b331970/";
const LOCATION = LOCATIONS[0]!.id;

interface Decision {
  cancel?: boolean;
}
type RequestListener = (details: {
  url: string;
  type: string;
  proxyInfo?: unknown;
}) => Promise<Decision>;
type MessageListener = (
  message: unknown,
  sender: browser.runtime.MessageSender,
  sendResponse: (response: unknown) => void,
) => unknown;

/** The Firefox guard as the worker reads it: the exclusions which routes may bypass. */
class RouteSafety extends FakeSafety {
  routeExclusions: SiteExclusion[] = [];
  getRouteExclusions(): SiteExclusion[] {
    return this.routeExclusions.map((entry) => ({ ...entry }));
  }
  hasExclusionGuard(): boolean {
    return false;
  }
}

/** Lets the worker finish what it started: see `settleWorker`. */
const settle = () => settleWorker();

async function startWorker() {
  vi.resetModules();
  const safety = new RouteSafety();
  const harness = createHarness({ persisted: authenticatedState(), safety });
  shared.harness = harness;
  const local: Record<string, unknown> = {};
  const session: Record<string, unknown> = {};
  let onMessage: MessageListener | undefined;
  let onBeforeRequest: RequestListener | undefined;
  let onBeforeSendHeaders: RequestListener | undefined;
  let proxyChanged: (() => void) | undefined;
  const event = () => ({ addListener: vi.fn() });
  const area = (values: Record<string, unknown>) => ({
    get: async (key: string) => ({ [key]: structuredClone(values[key]) }),
    set: async (written: Record<string, unknown>) => {
      Object.assign(values, structuredClone(written));
    },
    remove: async (key: string) => {
      Reflect.deleteProperty(values, key);
    },
  });
  vi.stubGlobal("browser", {
    runtime: {
      id: EXTENSION_ID,
      getManifest: () => ({ version: "1.1.1" }),
      getURL: (path: string) => `${EXTENSION_ROOT}${path}`,
      onMessage: {
        addListener: (registered: MessageListener) => {
          onMessage = registered;
        },
      },
      onStartup: event(),
      onInstalled: event(),
      sendMessage: async () => undefined,
    },
    i18n: { getUILanguage: () => "fr", getMessage: (key: string) => key },
    storage: { local: watched(area(local)), session: watched(area(session)) },
    alarms: {
      onAlarm: event(),
      create: async () => undefined,
      get: async () => undefined,
      clear: async () => true,
    },
    proxy: {
      settings: {
        get: async () => ({
          value: { proxyType: "system" },
          levelOfControl: "controllable_by_this_extension",
        }),
        onChange: {
          addListener: (registered: () => void) => {
            proxyChanged = registered;
          },
        },
      },
      onError: event(),
    },
    permissions: {
      onRemoved: event(),
      onAdded: event(),
      getAll: async () => ({ data_collection: [] }),
    },
    privacy: {
      network: {
        webRTCIPHandlingPolicy: { onChange: event() },
        networkPredictionEnabled: { onChange: event() },
      },
    },
    webRequest: {
      onBeforeRequest: {
        addListener: (registered: RequestListener, _filter: unknown, extra?: string[]) => {
          // Other listeners only observe: the guard is the one which may block.
          if (extra?.includes("blocking")) onBeforeRequest = registered;
        },
      },
      onBeforeSendHeaders: {
        addListener: (registered: RequestListener, _filter: unknown, extra?: string[]) => {
          // Other listeners only observe: the guard is the one which may block.
          if (extra?.includes("blocking")) onBeforeSendHeaders = registered;
        },
      },
      onAuthRequired: event(),
      onCompleted: event(),
      onErrorOccurred: event(),
    },
    extension: { isAllowedIncognitoAccess: async () => true },
    action: { setBadgeText: async () => undefined, setTitle: async () => undefined },
  });
  vi.stubGlobal("fetch", async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith(EXTENSION_ROOT))
      throw new Error("External transport forbidden in route guard tests");
    return url.includes("/_locales/")
      ? new Response("{}", { status: 200 })
      : new Response(null, { status: 404 });
  });
  await import("../../src/core/background/service-worker");
  await settle();
  const send = <T>(request: unknown) =>
    new Promise<T>((resolve, reject) => {
      const accepted = onMessage?.(
        request,
        { id: EXTENSION_ID, url: `${EXTENSION_ROOT}popup/popup.html` },
        (response) => resolve(response as T),
      );
      if (accepted !== true) reject(new Error("Trusted request was rejected"));
    });
  /** One web request, as Firefox reports it: before it is sent, then with its route. */
  const request = async (url = "https://example.com/") => {
    const active = harness.proxy.active;
    const proxyInfo = active ? { type: "https", host: active.host, port: active.port } : null;
    const details = { url, type: "main_frame", proxyInfo };
    return [await onBeforeRequest!(details), await onBeforeSendHeaders!(details)];
  };
  return {
    harness,
    safety,
    send,
    request,
    headers: (url = "https://example.com/") => {
      const active = harness.proxy.active;
      return onBeforeSendHeaders!({
        url,
        type: "main_frame",
        proxyInfo: active ? { type: "https", host: active.host, port: active.port } : null,
      });
    },
    /** Firefox reports any change of the proxy settings, ours included. */
    proxyChanged: () => proxyChanged!(),
  };
}

async function connectedWorker() {
  const worker = await startWorker();
  expect(await worker.send({ type: "connect", locationId: LOCATION })).toMatchObject({ ok: true });
  await settle();
  // The settings changed when the session was applied.
  worker.proxyChanged();
  await settle();
  return worker;
}

const ALLOWED = [{}, {}];
const CANCELLED = [{ cancel: true }, { cancel: true }];

describe("the basis of the route decisions of Firefox", () => {
  let clock = 10_000;
  beforeEach(() => {
    clock = 10_000;
    vi.spyOn(performance, "now").mockImplementation(() => clock);
    // The account of the fixture is valid at that time.
    vi.spyOn(Date, "now").mockImplementation(() => NOW);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });
  afterEach(async () => {
    await settle();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("is read once for the requests of a page", async () => {
    const worker = await connectedWorker();
    const settings = vi.spyOn(worker.harness.proxy, "getControlLevel");
    const configuration = vi.spyOn(worker.harness.proxy, "isActiveConfiguration");

    for (let sent = 0; sent < 50; sent++) expect(await worker.request()).toEqual(ALLOWED);

    expect(settings).toHaveBeenCalledTimes(1);
    expect(configuration).toHaveBeenCalledTimes(1);
  });

  it("is read once by requests which arrive together", async () => {
    const worker = await connectedWorker();
    const settings = vi.spyOn(worker.harness.proxy, "getControlLevel");

    const decisions = await Promise.all(Array.from({ length: 20 }, () => worker.headers()));

    expect(decisions).toEqual(Array.from({ length: 20 }, () => ({})));
    expect(settings).toHaveBeenCalledTimes(1);
  });

  it("is read again when the proxy settings change", async () => {
    const worker = await connectedWorker();
    expect(await worker.request()).toEqual(ALLOWED);

    // Another extension takes the proxy: Firefox reports the change.
    worker.harness.proxy.level = "controlled_by_other_extensions";
    worker.proxyChanged();

    expect(await worker.headers()).toEqual({ cancel: true });
  });

  it("is read again when the published state changes what is routed", async () => {
    const worker = await connectedWorker();
    expect(await worker.request()).toEqual(ALLOWED);
    const settings = vi.spyOn(worker.harness.proxy, "getControlLevel");

    expect(await worker.send({ type: "disconnect" })).toMatchObject({ ok: true });
    await settle();
    settings.mockClear();

    // Disconnected, nothing is guarded: the proxy route is no longer asked for.
    expect(await worker.request()).toEqual(ALLOWED);
    expect(settings).toHaveBeenCalledTimes(1);
    expect(worker.harness.proxy.active).toBeNull();
  });

  it("is not read again by a publication which changes nothing of the routing", async () => {
    const worker = await connectedWorker();
    expect(await worker.request()).toEqual(ALLOWED);
    const settings = vi.spyOn(worker.harness.proxy, "getControlLevel");

    // The popup refreshes the catalogue: the account is published, the routes are the same.
    expect(await worker.send({ type: "refresh_locations" })).toMatchObject({ ok: true });
    await settle();
    settings.mockClear();

    expect(await worker.request()).toEqual(ALLOWED);
    expect(settings).not.toHaveBeenCalled();
  });

  it("is read again when the exclusions which routes may bypass change", async () => {
    const worker = await connectedWorker();
    expect(await worker.request("https://example.org/")).toEqual(ALLOWED);
    const settings = vi.spyOn(worker.harness.proxy, "getControlLevel");

    worker.safety.routeExclusions = [{ domain: "example.org", includeSubdomains: true }];

    expect(await worker.request("https://example.org/")).toEqual(ALLOWED);
    expect(settings).toHaveBeenCalledTimes(1);
  });

  it("is read again after a second, should a change ever go unreported", async () => {
    const worker = await connectedWorker();
    expect(await worker.request()).toEqual(ALLOWED);
    // The proxy is taken, and no event says so.
    worker.harness.proxy.level = "controlled_by_other_extensions";

    clock += 999;
    expect(await worker.request()).toEqual(ALLOWED);
    clock += 1;
    expect(await worker.request()).toEqual(CANCELLED);
  });

  it("decides a request by the state which replaced the one being read", async () => {
    const worker = await connectedWorker();
    clock += 1_000;
    // The settings are being read when Firefox reports a change of them: a renewal.
    let answer!: () => void;
    const read = new Promise<void>((resolve) => {
      answer = resolve;
    });
    const level = worker.harness.proxy.getControlLevel.bind(worker.harness.proxy);
    vi.spyOn(worker.harness.proxy, "getControlLevel").mockImplementationOnce(async () => {
      await read;
      return level();
    });
    const decision = worker.headers();
    await settle();
    worker.proxyChanged();
    answer();

    // The request is not failed for it: the state read next allows it.
    expect(await decision).toEqual({});
  });

  it("refuses a request whose state changed into one which blocks it", async () => {
    const worker = await connectedWorker();
    clock += 1_000;
    let answer!: () => void;
    const read = new Promise<void>((resolve) => {
      answer = resolve;
    });
    const level = worker.harness.proxy.getControlLevel.bind(worker.harness.proxy);
    vi.spyOn(worker.harness.proxy, "getControlLevel").mockImplementationOnce(async () => {
      await read;
      return level();
    });
    const decision = worker.headers();
    await settle();
    worker.harness.proxy.level = "controlled_by_other_extensions";
    worker.proxyChanged();
    answer();

    expect(await decision).toEqual({ cancel: true });
  });
});
