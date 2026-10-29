// SPDX-License-Identifier: MPL-2.0

import type { DeviceList, ProxySession } from "../../src/core/api/types";
import type { ConnectionEvent } from "../../src/core/background/connection-journal";
import type { DiagnosticResponse, DiagnosticUiState } from "../../src/core/shared/diagnostics-ui";
import type { ExtensionRequest, ExtensionResponse } from "../../src/core/shared/messages";
import type { PersistedState } from "../../src/core/storage/storage";
import { authenticatedState, createHarness, LOCATIONS, NOW } from "./helpers";

const shared = vi.hoisted<{ harness: ReturnType<typeof createHarness> | null }>(() => ({
  harness: null,
}));

// Run the real worker, controller, journal and diagnostics. Only their platform
// and transport dependencies use the in-memory services shared by common tests.
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

const ROOT = "moz-extension://73d102e4-2b97-4f79-a2ca-c2449b331970/";
const EXTENSION_ID = "fuzevpn-firefox@vpn1euro.com";
const JOURNAL_KEY = "fuzevpnConnectionJournal";
const REMOTE = {
  deviceId: "scope-remote-device",
  name: "remote",
  kind: "browser_extension" as const,
  createdAt: "2026-08-26T12:00:00Z",
  profiles: [],
};
type MessageListener = (
  request: unknown,
  sender: browser.runtime.MessageSender,
  respond: (response: unknown) => void,
) => unknown;
interface JournalResponse {
  ok: boolean;
  error?: string;
  journal?: { events: ConnectionEvent[] };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

async function settle() {
  await new Promise<void>((done) => setImmediate(done));
}

async function startWorker(
  options: {
    session?: Record<string, unknown>;
    readPersisted?: () => Promise<PersistedState>;
    rejectJournalWrites?: boolean;
  } = {},
) {
  vi.resetModules();
  const h = createHarness({ persisted: authenticatedState() });
  if (options.readPersisted)
    vi.spyOn(h.storage, "readPersisted").mockImplementation(options.readPersisted);
  shared.harness = h;
  const publications: { type: string; state?: DiagnosticUiState }[] = [];
  const session = options.session ?? {};
  const local: Record<string, unknown> = {};
  const alarms = new Map<string, number>();
  let listener: MessageListener | undefined;
  let onAlarm: ((alarm: { name: string }) => void) | undefined;
  const event = () => ({ addListener: vi.fn() });
  const area = (values: Record<string, unknown>) => ({
    get: async (key: string) => ({ [key]: structuredClone(values[key]) }),
    set: async (change: Record<string, unknown>) => {
      if (options.rejectJournalWrites && JOURNAL_KEY in change)
        throw new Error("scope-journal-write-unavailable");
      Object.assign(values, structuredClone(change));
    },
    remove: async (key: string) => {
      Reflect.deleteProperty(values, key);
    },
  });
  vi.stubGlobal("browser", {
    runtime: {
      id: EXTENSION_ID,
      getManifest: () => ({ version: "0.9.2" }),
      getURL: (path: string) => `${ROOT}${path}`,
      onMessage: { addListener: (callback: MessageListener) => (listener = callback) },
      onStartup: event(),
      onInstalled: event(),
      sendMessage: async (message: (typeof publications)[number]) => {
        publications.push(structuredClone(message));
      },
    },
    i18n: { getUILanguage: () => "fr", getMessage: (key: string) => key },
    storage: { local: area(local), session: area(session) },
    alarms: {
      onAlarm: { addListener: (callback: typeof onAlarm) => (onAlarm = callback) },
      create: async (name: string, info: { when: number }) => {
        alarms.set(name, info.when);
      },
      get: async (name: string) =>
        alarms.has(name) ? { name, scheduledTime: alarms.get(name) } : undefined,
      clear: async (name: string) => alarms.delete(name),
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
    if (!url.startsWith(ROOT)) throw new Error("No external transport in journal scope tests");
    return url.includes("/_locales/")
      ? new Response("{}", { status: 200 })
      : new Response(null, { status: 404 });
  });
  await import("../../src/core/background/service-worker");
  const send = <T>(request: unknown) =>
    new Promise<T>((resolve, reject) => {
      const accepted = listener?.(
        request,
        { id: EXTENSION_ID, url: `${ROOT}diagnostics-page/diagnostics.html` },
        (response) => resolve(response as T),
      );
      if (accepted !== true) reject(new Error("Worker rejected trusted request"));
    });
  const command = (request: ExtensionRequest) => send<ExtensionResponse>(request);
  const journal = async () => {
    const response = await send<JournalResponse>({ type: "get_connection_journal" });
    expect(response.ok).toBe(true);
    return response.journal!.events;
  };
  const state = () => send<DiagnosticResponse>({ type: "diagnostics_state" });
  const clear = async () => {
    expect((await send<DiagnosticResponse>({ type: "diagnostics_clear_history" })).ok).toBe(true);
    expect(await journal()).toEqual([]);
  };
  return { h, send, command, journal, state, clear, publications, alarm: () => onAlarm! };
}

type Worker = Awaited<ReturnType<typeof startWorker>>;
const operationEvents = (events: ConnectionEvent[]) => events.filter((e) => e.event !== "state");

async function ready() {
  const worker = await startWorker();
  expect((await worker.command({ type: "get_snapshot" })).ok).toBe(true);
  expect((await worker.state()).state.signedIn).toBe(true);
  await settle();
  return worker;
}

async function expectFreshCatalog(worker: Worker) {
  expect((await worker.command({ type: "refresh_locations" })).ok).toBe(true);
  const events = await worker.journal();
  expect(events).toContainEqual(expect.objectContaining({ event: "catalog", count: 2 }));
  expect(events).toContainEqual(
    expect.objectContaining({ event: "command", phase: "start", action: "refresh_locations" }),
  );
  expect(events).toContainEqual(
    expect.objectContaining({ event: "command", phase: "end", action: "refresh_locations" }),
  );
  expect((await worker.state()).state.connectionHistoryCount).toBe(events.length);
  return operationEvents(events);
}

describe("CODE-08 independent worker journal scopes", () => {
  beforeEach(() => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });
  afterEach(async () => {
    await settle();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it.each(["connect", "change_location", "select_automatic_location"] as const)(
    "allows a fresh refresh during erased %s preparation without reviving its traces",
    async (type) => {
      const worker = await ready();
      if (type !== "connect")
        expect((await worker.command({ type: "connect", locationId: LOCATIONS[0]!.id })).ok).toBe(
          true,
        );
      const { LocationPreferences } =
        await import("../../src/core/background/location-preferences");
      const wait = deferred<undefined>();
      const preparing = vi
        .spyOn(LocationPreferences.prototype, "initialize")
        .mockImplementationOnce(() => wait.promise);
      const pending = worker.command(
        type === "select_automatic_location" ? { type } : { type, locationId: LOCATIONS[1]!.id },
      );
      await vi.waitFor(() => expect(preparing).toHaveBeenCalled());
      await worker.clear();
      const acceptedAfterClear = await expectFreshCatalog(worker);
      wait.resolve(undefined);
      expect((await pending).ok).toBe(true);
      expect(operationEvents(await worker.journal())).toEqual(acceptedAfterClear);
    },
  );

  it("does not rebind an automatic target resolver after its preparation has already finished", async () => {
    const worker = await ready();
    expect((await worker.command({ type: "connect", locationId: LOCATIONS[0]!.id })).ok).toBe(true);
    const { LocationPreferences } = await import("../../src/core/background/location-preferences");
    const initialize = LocationPreferences.prototype.initialize;
    const wait = deferred<undefined>();
    const preparing = vi
      .spyOn(LocationPreferences.prototype, "initialize")
      .mockImplementationOnce(initialize)
      .mockImplementationOnce(() => wait.promise);
    const pending = worker.command({ type: "select_automatic_location" });
    await vi.waitFor(() => expect(preparing).toHaveBeenCalledTimes(2));
    await worker.clear();
    wait.resolve(undefined);
    expect((await pending).ok).toBe(true);
    expect(operationEvents(await worker.journal())).toEqual([]);
    await expectFreshCatalog(worker);
  });

  it.each(["connect", "change_location"] as const)(
    "drops delayed %s API failure after clear and accepts a new failure",
    async (type) => {
      const worker = await ready();
      if (type === "change_location")
        expect((await worker.command({ type: "connect", locationId: LOCATIONS[0]!.id })).ok).toBe(
          true,
        );
      const { ApiError } = await import("../../src/core/api/client");
      const late = deferred<ProxySession>();
      const creating = vi
        .spyOn(worker.h.api, "createProxySession")
        .mockReturnValueOnce(late.promise);
      const pending = worker.command({ type, locationId: LOCATIONS[1]!.id });
      await vi.waitFor(() => expect(creating).toHaveBeenCalledOnce());
      expect(await worker.journal()).toContainEqual(expect.objectContaining({ event: "target" }));
      await worker.clear();
      late.reject(new ApiError("invalid_location", 400));
      expect(await pending).toMatchObject({ ok: false, commandError: "invalid_location" });
      expect(operationEvents(await worker.journal())).toEqual([]);
      creating.mockRejectedValueOnce(new ApiError("invalid_location", 400));
      expect(await worker.command({ type: "connect", locationId: LOCATIONS[1]!.id })).toMatchObject(
        { ok: false, commandError: "invalid_location" },
      );
      expect(await worker.journal()).toContainEqual(
        expect.objectContaining({ event: "failure", source: "api", error: "invalid_location" }),
      );
    },
  );

  it("captures an alarm before initialize and keeps its late capacity refresh erased", async () => {
    const worker = await ready();
    expect((await worker.command({ type: "connect", locationId: LOCATIONS[0]!.id })).ok).toBe(true);
    const { AppController } = await import("../../src/core/background/state-machine");
    const { ApiError } = await import("../../src/core/api/client");
    const { ALARM_REFRESH } = await import("../../src/core/shared/config");
    const wait = deferred<undefined>();
    vi.spyOn(AppController.prototype, "initialize").mockImplementationOnce(() => wait.promise);
    const handling = vi.spyOn(AppController.prototype, "handleAlarm");
    const creating = vi
      .spyOn(worker.h.api, "createProxySession")
      .mockRejectedValueOnce(new ApiError("server_full", 409));
    worker.alarm()({ name: ALARM_REFRESH });
    await vi.waitFor(() => expect(handling).toHaveBeenCalledOnce());
    await worker.clear();
    wait.resolve(undefined);
    await handling.mock.results[0]!.value;
    expect(creating).toHaveBeenCalledOnce();
    expect(operationEvents(await worker.journal())).toEqual([]);
    await expectFreshCatalog(worker);
  });

  for (const revoked of [false, true]) {
    it.each(["DELETE", "GET"] as const)(
      `keeps quota recovery erased across pending %s, revoked=${String(revoked)}`,
      async (stage) => {
        const worker = await ready();
        const { ApiError } = await import("../../src/core/api/client");
        worker.h.api.devices.devices = [structuredClone(REMOTE)];
        if (revoked) {
          worker.h.identity.deviceId = "scope-revoked";
          const create = worker.h.api.createProxySession.bind(worker.h.api);
          vi.spyOn(worker.h.api, "createProxySession").mockImplementation(async (...args) => {
            if (args[2].deviceId === "scope-revoked")
              throw new ApiError("device_identity_revoked", 403);
            return create(...args);
          });
        }
        worker.h.api.enrollError = new ApiError("device_limit", 409);
        expect(
          await worker.command({ type: "connect", locationId: LOCATIONS[0]!.id }),
        ).toMatchObject({
          ok: false,
          snapshot: { error: revoked ? "device_revoked_limit" : "device_limit" },
        });
        expect((await worker.command({ type: "refresh_devices" })).ok).toBe(true);
        worker.h.api.enrollError = null;
        const deleting = deferred<undefined>();
        const listing = deferred<DeviceList>();
        const originalDelete = worker.h.api.deleteDevice.bind(worker.h.api);
        const deleteRequest = vi
          .spyOn(worker.h.api, "deleteDevice")
          .mockImplementationOnce(async (...args) => {
            if (stage === "DELETE") await deleting.promise;
            await originalDelete(...args);
          });
        const getRequest = vi.spyOn(worker.h.api, "getDevices");
        if (stage === "GET") getRequest.mockReturnValueOnce(listing.promise);
        const pending = worker.command({ type: "delete_device", deviceId: REMOTE.deviceId });
        await vi.waitFor(() => {
          expect(stage === "DELETE" ? deleteRequest : getRequest).toHaveBeenCalledOnce();
        });
        await worker.clear();
        if (stage === "DELETE") deleting.resolve(undefined);
        else listing.resolve(structuredClone(worker.h.api.devices));
        expect(await pending).toMatchObject({ ok: true, snapshot: { protected: true } });
        expect(worker.h.api.deletedDevices).toEqual([REMOTE.deviceId]);
        expect(operationEvents(await worker.journal())).toEqual([]);
        await expectFreshCatalog(worker);
      },
    );
  }

  it.each([0, 1, 3])(
    "publishes zero diagnostic count with %s restored entries while account ownership is unknown",
    async (oldCount) => {
      const oldEvents: ConnectionEvent[] = Array.from({ length: oldCount }, (_, index) => ({
        event: "command",
        action: "connect",
        phase: "end",
        at: NOW - 1000,
        sequence: index + 1,
      }));
      const session = {
        [JOURNAL_KEY]: structuredClone(oldEvents),
        fuzevpnDiagnosticHistory: { owner: "user-test", items: [], losses: [] },
      };
      let readable = false;
      const worker = await startWorker({
        session,
        rejectJournalWrites: true,
        readPersisted: async () => {
          if (!readable) throw new Error("scope-account-unavailable");
          return authenticatedState();
        },
      });
      const unknown = await worker.state();
      expect(unknown.state).toMatchObject({ signedIn: false, connectionHistoryCount: 0 });
      expect(await worker.send({ type: "get_connection_journal" })).toEqual({
        ok: false,
        error: "storage_unavailable",
      });
      const changed = worker.publications.filter(
        (message) => message.type === "diagnostics_changed",
      );
      expect(changed.length).toBeGreaterThan(0);
      for (const message of changed)
        expect(message.state).toMatchObject({ signedIn: false, connectionHistoryCount: 0 });
      expect(session[JOURNAL_KEY]).toEqual(oldEvents);
      readable = true;
      expect((await worker.command({ type: "get_snapshot" })).snapshot.profile?.userId).toBe(
        "user-test",
      );
      await expectFreshCatalog(worker);
      expect((await worker.journal()).some((event) => event.at === NOW - 1000)).toBe(false);
    },
  );

  it("waits for pending account restoration before answering count and journal requests", async () => {
    const reading = deferred<PersistedState>();
    const oldEvent: ConnectionEvent = {
      event: "command",
      action: "connect",
      phase: "end",
      at: NOW - 1000,
      sequence: 1,
    };
    const worker = await startWorker({
      session: { [JOURNAL_KEY]: [oldEvent] },
      readPersisted: () => reading.promise,
    });
    const answers: unknown[] = [];
    const state = worker.state();
    const exported = worker.send<JournalResponse>({ type: "get_connection_journal" });
    void state.then((response) => answers.push(response));
    void exported.then((response) => answers.push(response));
    await settle();
    expect(answers).toEqual([]);
    reading.resolve(authenticatedState());
    const known = await state;
    const journal = await exported;
    expect(known.state.signedIn).toBe(true);
    expect(journal.ok).toBe(true);
    expect(journal.journal!.events).not.toContainEqual(oldEvent);
    await expectFreshCatalog(worker);
  });
});
