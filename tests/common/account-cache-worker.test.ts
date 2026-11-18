// SPDX-License-Identifier: MPL-2.0

import { settleWorker, watched } from "./worker-settle";
import { DIAGNOSTIC_HISTORY_ALARM } from "../../src/core/diagnostics/service";
import { ACCOUNT_REFRESH_INTERVAL_MS } from "../../src/core/shared/config";
import { ACCOUNT_CACHE_KEY } from "../../src/core/storage/account-cache-storage";
import { authenticatedState, createHarness, LOCATIONS, NOW, PROFILE } from "./helpers";

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

type MessageListener = (
  message: unknown,
  sender: browser.runtime.MessageSender,
  sendResponse: (response: unknown) => void,
) => unknown;
type AlarmListener = (alarm: { name: string; scheduledTime: number }) => void;

/** What one browser session keeps between two workers. */
function browserSession() {
  return {
    session: {} as Record<string, unknown>,
    local: {} as Record<string, unknown>,
    alarms: new Map<string, number>(),
    account: authenticatedState(),
  };
}

/** Lets the worker finish what it started: see `settleWorker`. */
const settle = () => settleWorker();

async function startWorker(
  kept: ReturnType<typeof browserSession>,
  prepare?: (harness: ReturnType<typeof createHarness>) => void,
) {
  vi.resetModules();
  // The account in local storage outlives a worker, and a browser session.
  const harness = createHarness({ persisted: kept.account });
  prepare?.(harness);
  shared.harness = harness;
  const reads = {
    profile: vi.spyOn(harness.api, "getProfile"),
    subscription: vi.spyOn(harness.api, "getSubscription"),
    locations: vi.spyOn(harness.api, "getLocations"),
  };
  let onMessage: MessageListener | undefined;
  let onAlarm: AlarmListener | undefined;
  const event = () => ({ addListener: vi.fn() });
  const area = (values: Record<string, unknown>) => ({
    get: async (key: string) => ({ [key]: structuredClone(values[key]) }),
    set: async (valuesToWrite: Record<string, unknown>) => {
      Object.assign(values, structuredClone(valuesToWrite));
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
    storage: { local: watched(area(kept.local)), session: watched(area(kept.session)) },
    alarms: {
      onAlarm: {
        addListener: (registered: AlarmListener) => {
          onAlarm = registered;
        },
      },
      create: async (name: string, info: { when: number }) => {
        kept.alarms.set(name, info.when);
      },
      get: async (name: string) =>
        kept.alarms.has(name) ? { name, scheduledTime: kept.alarms.get(name) } : undefined,
      clear: async (name: string) => kept.alarms.delete(name),
    },
    proxy: {
      settings: {
        get: async () => ({
          value: { proxyType: "system" },
          levelOfControl: "controllable_by_this_extension",
        }),
        onChange: event(),
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
      onBeforeRequest: event(),
      onBeforeSendHeaders: event(),
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
      throw new Error("External transport forbidden in worker wake tests");
    return url.includes("/_locales/")
      ? new Response("{}", { status: 200 })
      : new Response(null, { status: 404 });
  });
  await import("../../src/core/background/service-worker");
  return {
    harness,
    /** How many times this worker read each part of the account from the API. */
    accountReads: () => ({
      profile: reads.profile.mock.calls.length,
      subscription: reads.subscription.mock.calls.length,
      locations: reads.locations.mock.calls.length,
    }),
    /** What the browser keeps of the account once this worker stops. */
    stop() {
      kept.account = structuredClone(harness.storage.persisted);
    },
    send: <T>(request: unknown) =>
      new Promise<T>((resolve, reject) => {
        const accepted = onMessage?.(
          request,
          { id: EXTENSION_ID, url: `${EXTENSION_ROOT}popup/popup.html` },
          (response) => resolve(response as T),
        );
        if (accepted !== true) reject(new Error("Trusted request was rejected"));
      }),
    /** The browser removes a one-shot alarm when it delivers it. */
    fireHistoryAlarm(scheduledTime: number) {
      kept.alarms.delete(DIAGNOSTIC_HISTORY_ALARM);
      onAlarm?.({ name: DIAGNOSTIC_HISTORY_ALARM, scheduledTime });
    },
  };
}

const NONE = { profile: 0, subscription: 0, locations: 0 };
const ONCE = { profile: 1, subscription: 1, locations: 1 };
const FIVE_MINUTES = 5 * 60_000;

type Worker = Awaited<ReturnType<typeof startWorker>>;
interface Reply {
  ok: boolean;
  snapshot: { status: string; locations: unknown[]; locationsStatus: string };
}

describe("the account a worker restores from its browser session", () => {
  let now = NOW;
  beforeEach(() => {
    now = NOW;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });
  afterEach(async () => {
    await settle();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  /** The first worker of a browser session, left to be stopped by the browser. */
  async function firstWorker(kept: ReturnType<typeof browserSession>): Promise<Worker> {
    const worker = await startWorker(kept);
    await vi.waitFor(() => expect(kept.session[ACCOUNT_CACHE_KEY]).toBeDefined());
    await settle();
    expect(worker.accountReads()).toEqual(ONCE);
    worker.stop();
    return worker;
  }

  it("is kept under a digest of the account, in session storage only", async () => {
    const kept = browserSession();
    await firstWorker(kept);

    expect(kept.session[ACCOUNT_CACHE_KEY]).toEqual({
      owner: expect.stringMatching(/^[0-9a-f]{64}$/) as string,
      refreshedAt: NOW,
      locations: LOCATIONS,
    });
    expect(JSON.stringify(kept.session[ACCOUNT_CACHE_KEY])).not.toContain(PROFILE.userId);
    expect(kept.local[ACCOUNT_CACHE_KEY]).toBeUndefined();
  });

  it("is not read from the API again by the workers of the following hour", async () => {
    const kept = browserSession();
    await firstWorker(kept);

    for (const elapsed of [FIVE_MINUTES, 30 * 60_000, ACCOUNT_REFRESH_INTERVAL_MS - 1]) {
      now = NOW + elapsed;
      const worker = await startWorker(kept);
      await settle();
      const reply = await worker.send<Reply>({ type: "get_snapshot" });

      expect(worker.accountReads()).toEqual(NONE);
      expect(reply).toMatchObject({
        ok: true,
        snapshot: {
          status: "disconnected",
          profile: PROFILE,
          locations: LOCATIONS,
          locationsStatus: "ready",
        },
      });
      worker.stop();
    }
  });

  it("is read from the API again an hour after its last refresh", async () => {
    const kept = browserSession();
    await firstWorker(kept);

    now = NOW + ACCOUNT_REFRESH_INTERVAL_MS;
    const worker = await startWorker(kept);
    await vi.waitFor(() => expect(worker.accountReads()).toEqual(ONCE));

    await vi.waitFor(() =>
      expect(kept.session[ACCOUNT_CACHE_KEY]).toMatchObject({ refreshedAt: now }),
    );
  });

  it("is read from the API by the first worker of the next browser session", async () => {
    const kept = browserSession();
    await firstWorker(kept);

    // Closing the browser empties session storage; the account stays in local storage.
    const reopened = { ...browserSession(), local: kept.local, account: kept.account };
    now = NOW + FIVE_MINUTES;
    const worker = await startWorker(reopened);
    await vi.waitFor(() => expect(worker.accountReads()).toEqual(ONCE));
  });

  it("costs the purge of the technical history no request to the API", async () => {
    const kept = browserSession();
    await firstWorker(kept);
    const purgeAt = kept.alarms.get(DIAGNOSTIC_HISTORY_ALARM)!;
    expect(purgeAt).toBeGreaterThan(NOW);

    now = purgeAt;
    const worker = await startWorker(kept);
    worker.fireHistoryAlarm(purgeAt);
    await settle();

    expect(worker.accountReads()).toEqual(NONE);
    expect(kept.alarms.has(DIAGNOSTIC_HISTORY_ALARM)).toBe(false);
  });

  it("is still refreshed by the popup, whatever its age", async () => {
    const kept = browserSession();
    await firstWorker(kept);

    now = NOW + FIVE_MINUTES;
    const worker = await startWorker(kept);
    await settle();
    expect(worker.accountReads()).toEqual(NONE);
    expect(await worker.send<Reply>({ type: "refresh_account" })).toMatchObject({ ok: true });

    expect(worker.accountReads()).toEqual(ONCE);
    // Kept without making the reply wait for it.
    await vi.waitFor(() =>
      expect(kept.session[ACCOUNT_CACHE_KEY]).toMatchObject({ refreshedAt: now }),
    );
  });

  it("leaves session storage when the account signs out", async () => {
    const kept = browserSession();
    await firstWorker(kept);

    now = NOW + FIVE_MINUTES;
    const worker = await startWorker(kept);
    await settle();
    expect(await worker.send<Reply>({ type: "logout" })).toMatchObject({
      snapshot: { status: "logged_out", locations: [] },
    });

    await vi.waitFor(() => expect(kept.session[ACCOUNT_CACHE_KEY]).toBeUndefined());
  });
});
