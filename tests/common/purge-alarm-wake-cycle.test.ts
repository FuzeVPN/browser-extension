// SPDX-License-Identifier: MPL-2.0

import { settleWorker, watched } from "./worker-settle";
import { NetworkError } from "../../src/core/api/client";
import type { ConnectionEvent } from "../../src/core/background/connection-journal";
import {
  DIAGNOSTIC_HISTORY_ALARM,
  DIAGNOSTIC_HISTORY_KEY,
} from "../../src/core/diagnostics/service";
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

const JOURNAL_KEY = "fuzevpnConnectionJournal";
const EXTENSION_ID = "fuzevpn-firefox@vpn1euro.com";
const EXTENSION_ROOT = "moz-extension://73d102e4-2b97-4f79-a2ca-c2449b331970/";
/** Technical history is retained ten minutes, to the millisecond after. */
const RETENTION_MS = 600_001;

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
  };
}

/** Lets the worker finish what it started: see `settleWorker`. */
const settle = () => settleWorker();

async function startWorker(
  kept: ReturnType<typeof browserSession>,
  prepare?: (harness: ReturnType<typeof createHarness>) => void,
) {
  vi.resetModules();
  const harness = createHarness({ persisted: authenticatedState() });
  prepare?.(harness);
  shared.harness = harness;
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
    fireControllerAlarm(name: string, scheduledTime: number) {
      onAlarm?.({ name, scheduledTime });
    },
  };
}

const journal = (kept: ReturnType<typeof browserSession>) =>
  (kept.session[JOURNAL_KEY] as ConnectionEvent[] | undefined) ?? [];
const historyItems = (kept: ReturnType<typeof browserSession>) =>
  (kept.session[DIAGNOSTIC_HISTORY_KEY] as { items?: unknown[] } | undefined)?.items ?? [];

describe("a worker which the history purge alarm started", () => {
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

  /** A first worker whose start-up is recorded, then left to be stopped by the browser. */
  async function firstWorker(
    kept: ReturnType<typeof browserSession>,
    prepare?: (harness: ReturnType<typeof createHarness>) => void,
  ) {
    await startWorker(kept, prepare);
    await vi.waitFor(() => expect(kept.alarms.get(DIAGNOSTIC_HISTORY_ALARM)).toBeDefined());
    await settle();
    expect(journal(kept).some((entry) => entry.event === "state")).toBe(true);
    const purgeAt = kept.alarms.get(DIAGNOSTIC_HISTORY_ALARM)!;
    expect(purgeAt).toBe(NOW + RETENTION_MS);
    return purgeAt;
  }

  it("purges the retained history and schedules no further wake", async () => {
    const kept = browserSession();
    const purgeAt = await firstWorker(kept);

    now = purgeAt;
    const worker = await startWorker(kept);
    worker.fireHistoryAlarm(purgeAt);
    await settle();

    expect(journal(kept)).toEqual([]);
    expect(historyItems(kept)).toEqual([]);
    expect(kept.alarms.has(DIAGNOSTIC_HISTORY_ALARM)).toBe(false);
    // The start-up itself was complete: only its history was left out.
    expect(await worker.send({ type: "get_snapshot" })).toMatchObject({
      ok: true,
      snapshot: { profile: PROFILE, locationsStatus: "ready" },
    });
  });

  it("does not repeat a start-up failure which the previous worker recorded", async () => {
    const kept = browserSession();
    const unreadable = (harness: ReturnType<typeof createHarness>) => {
      vi.spyOn(harness.storage, "readPersisted").mockRejectedValue(
        new Error("storage_unavailable"),
      );
    };
    await startWorker(kept, unreadable);
    await vi.waitFor(() => expect(historyItems(kept)).toHaveLength(1));
    await settle();
    const purgeAt = kept.alarms.get(DIAGNOSTIC_HISTORY_ALARM)!;
    expect(purgeAt).toBe(NOW + RETENTION_MS);

    now = purgeAt;
    const worker = await startWorker(kept, unreadable);
    worker.fireHistoryAlarm(purgeAt);
    await settle();

    expect(historyItems(kept)).toEqual([]);
    expect(journal(kept)).toEqual([]);
    expect(kept.alarms.has(DIAGNOSTIC_HISTORY_ALARM)).toBe(false);
  });

  it("does not repeat a start-up error state which the previous worker recorded", async () => {
    const kept = browserSession();
    const refusedGuard = (harness: ReturnType<typeof createHarness>) => {
      harness.securityStorage.state = {
        ...harness.securityStorage.state!,
        protectionRequested: true,
        selectedLocationId: LOCATIONS[0]!.id,
      };
      harness.proxy.level = "controlled_by_other_extensions";
    };
    const purgeAt = await firstWorker(kept, refusedGuard);

    now = purgeAt;
    const worker = await startWorker(kept, refusedGuard);
    worker.fireHistoryAlarm(purgeAt);
    await settle();

    expect(historyItems(kept)).toEqual([]);
    expect(journal(kept)).toEqual([]);
    expect(kept.alarms.has(DIAGNOSTIC_HISTORY_ALARM)).toBe(false);
    expect(await worker.send({ type: "get_snapshot" })).toMatchObject({
      snapshot: { protected: false, error: "proxy_controlled_by_extension" },
    });
  });

  it("records a start-up failure which the previous worker had not left", async () => {
    const kept = browserSession();
    const purgeAt = await firstWorker(kept);
    const lostControl = (harness: ReturnType<typeof createHarness>) => {
      harness.securityStorage.state = {
        ...harness.securityStorage.state!,
        protectionRequested: true,
        selectedLocationId: LOCATIONS[0]!.id,
      };
      harness.proxy.level = "controlled_by_other_extensions";
    };

    // The purge starts a worker which finds the proxy taken since.
    now = purgeAt;
    const worker = await startWorker(kept, lostControl);
    worker.fireHistoryAlarm(purgeAt);
    await vi.waitFor(() => expect(historyItems(kept)).toHaveLength(1));
    await settle();

    // What is new is recorded, whatever started the worker.
    expect(historyItems(kept)).toEqual([
      expect.objectContaining({
        at: purgeAt,
        event: expect.objectContaining({
          event: "error",
          code: "proxy_controlled_by_extension",
        }) as unknown,
      }),
    ]);
    expect(journal(kept)).toEqual([
      expect.objectContaining({
        event: "state",
        error: "proxy_controlled_by_extension",
        at: purgeAt,
      }),
    ]);
    const nextPurge = kept.alarms.get(DIAGNOSTIC_HISTORY_ALARM)!;
    expect(nextPurge).toBeGreaterThan(purgeAt);
    expect(nextPurge).toBeLessThanOrEqual(purgeAt + RETENTION_MS);

    // The worker which purges that record finds the same failure: nothing is new, and
    // nothing is left to wake another worker for.
    now = nextPurge;
    const last = await startWorker(kept, lostControl);
    last.fireHistoryAlarm(nextPurge);
    await vi.waitFor(() => expect(historyItems(kept)).toEqual([]));
    await settle();
    expect(historyItems(kept)).toEqual([]);
    expect(journal(kept)).toEqual([]);
    expect(kept.alarms.has(DIAGNOSTIC_HISTORY_ALARM)).toBe(false);
  });

  it("records the connection which its start-up leaves to make, as an attempt of its own", async () => {
    const kept = browserSession();
    const purgeAt = await firstWorker(kept);

    // Protection is requested and no session is left: the start-up has one to create.
    now = purgeAt;
    const worker = await startWorker(kept, (harness) => {
      harness.securityStorage.state = {
        ...harness.securityStorage.state!,
        protectionRequested: true,
        selectedLocationId: LOCATIONS[0]!.id,
      };
      harness.api.createError = new NetworkError("network");
    });
    worker.fireHistoryAlarm(purgeAt);

    // A request was sent and failed: that is no repetition of what a worker left.
    await vi.waitFor(() =>
      expect(journal(kept)).toContainEqual(expect.objectContaining({ event: "failure" })),
    );
    await vi.waitFor(() => expect(JSON.stringify(historyItems(kept))).toContain('"event":"error"'));
    expect(await worker.send({ type: "get_snapshot" })).toMatchObject({
      snapshot: { protected: false, protectionRequested: true },
    });
  });

  it("keeps history again from the first command it receives", async () => {
    const kept = browserSession();
    const purgeAt = await firstWorker(kept);
    now = purgeAt;
    const worker = await startWorker(kept);
    worker.fireHistoryAlarm(purgeAt);
    await settle();
    expect(journal(kept)).toEqual([]);

    // The popup opens a few seconds later, while this worker is still running.
    const openedAt = NOW + 605_000;
    now = openedAt;
    expect(await worker.send({ type: "get_snapshot" })).toMatchObject({ ok: true });
    await settle();
    // The journal restarts from the state the command found.
    expect(journal(kept)).toEqual([
      expect.objectContaining({ event: "state", status: "disconnected", at: openedAt }),
    ]);

    expect(await worker.send({ type: "refresh_locations" })).toMatchObject({ ok: true });
    await settle();
    expect(journal(kept)).toContainEqual(
      expect.objectContaining({ event: "command", action: "refresh_locations", phase: "end" }),
    );
    expect(journal(kept)).toContainEqual(expect.objectContaining({ event: "catalog", count: 2 }));
    expect(historyItems(kept)).toHaveLength(1);
    // What was recorded is purged in its turn.
    expect(kept.alarms.get(DIAGNOSTIC_HISTORY_ALARM)).toBe(openedAt + RETENTION_MS);
  });

  it("is given nothing more to purge by a popup which stays open", async () => {
    const kept = browserSession();
    const purgeAt = await firstWorker(kept);
    now = purgeAt;
    const worker = await startWorker(kept);
    worker.fireHistoryAlarm(purgeAt);
    await settle();

    const openedAt = NOW + 605_000;
    now = openedAt;
    expect(await worker.send({ type: "get_snapshot" })).toMatchObject({ ok: true });
    await settle();
    const recorded = historyItems(kept).length;
    const nextPurge = kept.alarms.get(DIAGNOSTIC_HISTORY_ALARM);
    expect(nextPurge).toBe(openedAt + RETENTION_MS);

    // The popup asks for the network state every five seconds.
    for (let poll = 1; poll <= 6; poll++) {
      now = openedAt + poll * 5_000;
      expect(await worker.send({ type: "refresh_network" })).toMatchObject({ ok: true });
      await settle();
    }

    expect(historyItems(kept)).toHaveLength(recorded);
    expect(kept.alarms.get(DIAGNOSTIC_HISTORY_ALARM)).toBe(nextPurge);
  });

  it("keeps history again from another alarm of the same wake", async () => {
    const kept = browserSession();
    const purgeAt = await firstWorker(kept);
    now = purgeAt;
    const worker = await startWorker(kept);
    worker.fireHistoryAlarm(purgeAt);
    await settle();
    expect(kept.alarms.has(DIAGNOSTIC_HISTORY_ALARM)).toBe(false);

    worker.fireControllerAlarm("fuzevpn-proxy-reconnect", purgeAt);
    await settle();

    expect(journal(kept)).toEqual([expect.objectContaining({ event: "state" })]);
    expect(kept.alarms.get(DIAGNOSTIC_HISTORY_ALARM)).toBeDefined();
  });
});

describe("the start-up failure of an account which is signed in", () => {
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

  const refusedGuard = (harness: ReturnType<typeof createHarness>) => {
    harness.securityStorage.state = {
      ...harness.securityStorage.state!,
      protectionRequested: true,
      selectedLocationId: LOCATIONS[0]!.id,
    };
    harness.proxy.level = "controlled_by_other_extensions";
  };

  it("is recorded in the diagnostic history", async () => {
    const kept = browserSession();
    await startWorker(kept, refusedGuard);

    await vi.waitFor(() => expect(historyItems(kept)).toHaveLength(1));
    expect(historyItems(kept)).toEqual([
      expect.objectContaining({
        event: expect.objectContaining({
          source: "controller",
          event: "error",
          code: "proxy_controlled_by_extension",
        }) as unknown,
      }),
    ]);
  });

  it("is recorded once while it lasts, not by every worker which a request starts", async () => {
    const kept = browserSession();
    await startWorker(kept, refusedGuard);
    await vi.waitFor(() => expect(historyItems(kept)).toHaveLength(1));
    await settle();

    // A page sends a request a minute later, then another: each starts a worker.
    for (const minute of [1, 2, 3]) {
      now = NOW + minute * 60_000;
      const worker = await startWorker(kept, refusedGuard);
      expect(await worker.send({ type: "get_snapshot" })).toMatchObject({
        snapshot: { error: "proxy_controlled_by_extension" },
      });
      await settle();
    }

    expect(historyItems(kept)).toHaveLength(1);
  });

  it("is recorded again when it comes back after a start-up which succeeded", async () => {
    const kept = browserSession();
    await startWorker(kept, refusedGuard);
    await vi.waitFor(() => expect(historyItems(kept)).toHaveLength(1));
    await settle();

    now = NOW + 60_000;
    await startWorker(kept);
    await settle();
    expect(historyItems(kept)).toHaveLength(1);

    now = NOW + 120_000;
    await startWorker(kept, refusedGuard);
    await vi.waitFor(() => expect(historyItems(kept)).toHaveLength(2));
  });
});

describe("the command which starts a worker", () => {
  beforeEach(() => {
    vi.spyOn(Date, "now").mockImplementation(() => NOW);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });
  afterEach(async () => {
    await settle();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("keeps its traces, although it arrived before the journal had an owner", async () => {
    const kept = browserSession();
    // What an earlier worker left in the journal has no known owner.
    kept.session[JOURNAL_KEY] = [
      { event: "state", status: "connected", at: NOW - 1_000, sequence: 1, protected: true },
    ];
    const worker = await startWorker(kept);

    // The first thing this worker receives: its restoration has only begun.
    expect(await worker.send({ type: "connect", locationId: LOCATIONS[0]!.id })).toMatchObject({
      ok: true,
      snapshot: { protected: true },
    });
    await settle();

    const events = journal(kept);
    expect(events).toContainEqual(
      expect.objectContaining({ event: "command", action: "connect", phase: "start" }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({ event: "command", action: "connect", phase: "end" }),
    );
    expect(events).toContainEqual(expect.objectContaining({ event: "target" }));
    // What the earlier worker left is still dropped: nothing says whose it was.
    expect(events.every((entry) => entry.at === NOW)).toBe(true);
    // In the order they happened.
    const phases = events.filter((entry) => entry.event === "command").map((entry) => entry.phase);
    expect(phases).toEqual(["start", "end"]);
  });

  it("loses them when the history is cleared while it runs", async () => {
    const kept = browserSession();
    const worker = await startWorker(kept);
    const connecting = worker.send({ type: "connect", locationId: LOCATIONS[0]!.id });
    expect(await worker.send({ type: "diagnostics_clear_history" })).toMatchObject({ ok: true });
    await connecting;
    await settle();

    expect(journal(kept).filter((entry) => entry.event === "command")).toEqual([]);
  });
});

describe("a worker which something else started", () => {
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

  it("records its start-up although the purge alarm arrives after a command", async () => {
    const kept = browserSession();
    await startWorker(kept);
    await vi.waitFor(() => expect(kept.alarms.get(DIAGNOSTIC_HISTORY_ALARM)).toBeDefined());
    await settle();
    const purgeAt = kept.alarms.get(DIAGNOSTIC_HISTORY_ALARM)!;

    now = purgeAt;
    const worker = await startWorker(kept);
    const opened = worker.send({ type: "get_snapshot" });
    worker.fireHistoryAlarm(purgeAt);
    expect(await opened).toMatchObject({ ok: true });
    await settle();

    expect(journal(kept).some((entry) => entry.event === "state")).toBe(true);
    expect(kept.alarms.get(DIAGNOSTIC_HISTORY_ALARM)).toBe(purgeAt + RETENTION_MS);
  });

  it("purges on time while it keeps running, and stays an ordinary worker", async () => {
    const kept = browserSession();
    const worker = await startWorker(kept);
    await vi.waitFor(() => expect(kept.alarms.get(DIAGNOSTIC_HISTORY_ALARM)).toBeDefined());
    await settle();
    const purgeAt = kept.alarms.get(DIAGNOSTIC_HISTORY_ALARM)!;

    // The alarm was scheduled after this worker started: it did not start it.
    now = purgeAt;
    worker.fireHistoryAlarm(purgeAt);
    await settle();
    expect(journal(kept)).toEqual([]);
    expect(historyItems(kept)).toEqual([]);
    expect(kept.alarms.has(DIAGNOSTIC_HISTORY_ALARM)).toBe(false);

    // A background event of this worker is still recorded without any command.
    worker.fireControllerAlarm("fuzevpn-proxy-reconnect", purgeAt);
    await settle();
    expect(historyItems(kept)).toHaveLength(1);
  });
});
