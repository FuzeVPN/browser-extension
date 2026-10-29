// SPDX-License-Identifier: MPL-2.0

import type { ConnectionEvent } from "../../src/core/background/connection-journal";
import type { DiagnosticResponse } from "../../src/core/shared/diagnostics-ui";
import type { PersistedState } from "../../src/core/storage/storage";
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
const HISTORY_KEY = "fuzevpnDiagnosticHistory";
const EXTENSION_ID = "fuzevpn-firefox@vpn1euro.com";
const EXTENSION_HOST = "73d102e4-2b97-4f79-a2ca-c2449b331970";
const OLD_EVENT: ConnectionEvent = {
  event: "command",
  action: "connect",
  phase: "end",
  at: NOW - 1000,
  sequence: 1,
};
const ACCOUNT_B = authenticatedState({ profile: { ...PROFILE, userId: "account-b" } });

interface JournalResponse {
  ok: boolean;
  error?: string;
  journal?: { schemaVersion: number; events: ConnectionEvent[] };
}
interface SnapshotResponse {
  ok: boolean;
  snapshot: { profile: { userId: string } | null; error: string | null };
}
type MessageListener = (
  message: unknown,
  sender: browser.runtime.MessageSender,
  sendResponse: (response: unknown) => void,
) => unknown;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

async function settle() {
  await new Promise<void>((done) => setImmediate(done));
}

/** The old worker lost only the journal purge, while the history owner reached B. */
async function failedPurgeState(): Promise<Record<string, unknown>> {
  const { ConnectionJournal } = await import("../../src/core/background/connection-journal");
  const session: Record<string, unknown> = {
    [HISTORY_KEY]: { owner: "account-b", items: [], losses: [] },
  };
  let failNext = false;
  const journal = new ConnectionJournal({
    storage: {
      read: async () => session[JOURNAL_KEY],
      write: async (events) => {
        if (failNext) {
          failNext = false;
          throw new Error("synthetic-journal-purge-failure");
        }
        session[JOURNAL_KEY] = structuredClone(events);
      },
    },
    now: () => NOW - 1000,
  });
  await journal.initialize();
  journal.record({ event: OLD_EVENT.event, action: OLD_EVENT.action, phase: OLD_EVENT.phase });
  await journal.pruneExpired();
  expect(session[JOURNAL_KEY]).toEqual([OLD_EVENT]);
  failNext = true;
  journal.clear();
  await settle();
  expect(await journal.snapshot()).toEqual([]);
  expect(session[JOURNAL_KEY]).toEqual([OLD_EVENT]);
  return structuredClone(session);
}

async function startWorker(options: {
  session: Record<string, unknown>;
  persisted: PersistedState;
  readPersisted?: () => Promise<PersistedState>;
  rejectJournalWrites?: boolean;
}) {
  vi.resetModules();
  const harness = createHarness({ persisted: structuredClone(options.persisted) });
  harness.api.profile = structuredClone(options.persisted.profile ?? PROFILE);
  if (options.readPersisted)
    vi.spyOn(harness.storage, "readPersisted").mockImplementation(options.readPersisted);
  shared.harness = harness;
  let listener: MessageListener | undefined;
  const alarms = new Map<string, number>();
  const local: Record<string, unknown> = {};
  const event = () => ({ addListener: vi.fn() });
  const area = (values: Record<string, unknown>) => ({
    get: async (key: string) => ({ [key]: structuredClone(values[key]) }),
    set: async (valuesToWrite: Record<string, unknown>) => {
      if (options.rejectJournalWrites && JOURNAL_KEY in valuesToWrite)
        throw new Error("synthetic-persistent-journal-failure");
      Object.assign(values, structuredClone(valuesToWrite));
    },
    remove: async (key: string) => {
      Reflect.deleteProperty(values, key);
    },
  });
  vi.stubGlobal("browser", {
    runtime: {
      id: EXTENSION_ID,
      getManifest: () => ({ version: "0.9.2" }),
      getURL: (path: string) => `moz-extension://${EXTENSION_HOST}/${path}`,
      onMessage: {
        addListener: (registered: MessageListener) => {
          listener = registered;
        },
      },
      onStartup: event(),
      onInstalled: event(),
      sendMessage: async () => undefined,
    },
    i18n: { getUILanguage: () => "fr", getMessage: (key: string) => key },
    storage: { local: area(local), session: area(options.session) },
    alarms: {
      onAlarm: event(),
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
    if (!url.startsWith(`moz-extension://${EXTENSION_HOST}/`))
      throw new Error("External transport forbidden in worker ownership tests");
    return url.includes("/_locales/")
      ? new Response("{}", { status: 200 })
      : new Response(null, { status: 404 });
  });
  await import("../../src/core/background/service-worker");
  const send = <T>(request: unknown) =>
    new Promise<T>((resolve, reject) => {
      const accepted = listener?.(
        request,
        {
          id: EXTENSION_ID,
          url: `moz-extension://${EXTENSION_HOST}/diagnostics-page/diagnostics.html`,
        },
        (response) => resolve(response as T),
      );
      if (accepted !== true) reject(new Error("Trusted request was rejected"));
    });
  return { send, harness };
}

describe("CODE-08 journal generation captured before worker preparation", () => {
  beforeEach(() => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });
  afterEach(async () => {
    await settle();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it.each(["connect", "change_location", "select_automatic_location"])(
    "does not admit erased %s traces when location preparation completes after clear",
    async (type) => {
      const worker = await startWorker({ session: {}, persisted: ACCOUNT_B });
      await worker.send({ type: "get_snapshot" });
      await worker.send({ type: "diagnostics_state" });
      if (type !== "connect") {
        expect(
          (
            await worker.send<SnapshotResponse>({
              type: "connect",
              locationId: LOCATIONS[0]!.id,
            })
          ).ok,
        ).toBe(true);
      }
      await settle();
      const { LocationPreferences } =
        await import("../../src/core/background/location-preferences");
      const prepared = deferred<undefined>();
      const preparation = vi
        .spyOn(LocationPreferences.prototype, "initialize")
        .mockImplementationOnce(() => prepared.promise);
      const pending = worker.send<SnapshotResponse>({
        type,
        ...(type !== "select_automatic_location" ? { locationId: LOCATIONS[1]!.id } : {}),
      });
      await vi.waitFor(() => expect(preparation).toHaveBeenCalled());
      const cleared = await worker.send<{ ok: boolean }>({ type: "diagnostics_clear_history" });
      expect(cleared.ok).toBe(true);
      prepared.resolve(undefined);
      expect((await pending).ok).toBe(true);
      const completed = await worker.send<JournalResponse>({ type: "get_connection_journal" });
      const operationTraces = completed.journal!.events.filter((event) =>
        ["catalog", "target", "failure", "command"].includes(event.event),
      );
      // A current state observation may legitimately remain; operation evidence may not.
      expect(operationTraces).toEqual([]);
      expect((await worker.send<SnapshotResponse>({ type: "refresh_locations" })).ok).toBe(true);
      const fresh = await worker.send<JournalResponse>({ type: "get_connection_journal" });
      expect(fresh.journal!.events).toContainEqual(
        expect.objectContaining({ event: "catalog", count: LOCATIONS.length }),
      );
    },
  );

  it("does not admit an API failure from a connect erased during worker preparation", async () => {
    const worker = await startWorker({ session: {}, persisted: ACCOUNT_B });
    await worker.send({ type: "get_snapshot" });
    await worker.send({ type: "diagnostics_state" });
    await settle();
    const { LocationPreferences } = await import("../../src/core/background/location-preferences");
    const { ApiError } = await import("../../src/core/api/client");
    const prepared = deferred<undefined>();
    const preparation = vi
      .spyOn(LocationPreferences.prototype, "initialize")
      .mockImplementationOnce(() => prepared.promise);
    vi.spyOn(worker.harness.api, "createProxySession").mockRejectedValueOnce(
      new ApiError("invalid_location", 400),
    );
    const connecting = worker.send<SnapshotResponse>({
      type: "connect",
      locationId: LOCATIONS[0]!.id,
    });
    await vi.waitFor(() => expect(preparation).toHaveBeenCalled());
    expect((await worker.send<{ ok: boolean }>({ type: "diagnostics_clear_history" })).ok).toBe(
      true,
    );
    prepared.resolve(undefined);
    expect((await connecting).ok).toBe(false);
    const completed = await worker.send<JournalResponse>({ type: "get_connection_journal" });
    expect(completed.journal!.events.filter((event) => event.event === "failure")).toEqual([]);
    expect(
      (
        await worker.send<SnapshotResponse>({
          type: "connect",
          locationId: LOCATIONS[0]!.id,
        })
      ).ok,
    ).toBe(true);
    const fresh = await worker.send<JournalResponse>({ type: "get_connection_journal" });
    expect(fresh.journal!.events).toContainEqual(expect.objectContaining({ event: "target" }));
  });

  it.each(["select_location", "select_automatic_location"] as const)(
    "keeps an erased %s recorder when preferences finish before the catalog changes",
    async (type) => {
      const worker = await startWorker({ session: {}, persisted: ACCOUNT_B });
      await worker.send({ type: "get_snapshot" });
      await worker.send({ type: "diagnostics_state" });
      await settle();
      const { LocationPreferences } =
        await import("../../src/core/background/location-preferences");
      const { AppController } = await import("../../src/core/background/state-machine");
      const preferences = deferred<undefined>();
      const writing = vi
        .spyOn(LocationPreferences.prototype, "setAutomatic")
        .mockImplementationOnce(() => preferences.promise);
      const selecting = worker.send<SnapshotResponse>({
        type,
        ...(type === "select_location" ? { locationId: LOCATIONS[0]!.id } : {}),
      });
      await vi.waitFor(() => expect(writing).toHaveBeenCalled());
      expect((await worker.send<{ ok: boolean }>({ type: "diagnostics_clear_history" })).ok).toBe(
        true,
      );
      const initialized = deferred<undefined>();
      const initialization = vi
        .spyOn(AppController.prototype, "initialize")
        .mockImplementationOnce(() => initialized.promise);
      preferences.resolve(undefined);
      await vi.waitFor(() => expect(initialization).toHaveBeenCalled());
      worker.harness.api.locations = [];
      expect((await worker.send<SnapshotResponse>({ type: "refresh_locations" })).ok).toBe(true);
      initialized.resolve(undefined);
      expect(await selecting).toMatchObject({ ok: false, commandError: "invalid_location" });
      const journal = await worker.send<JournalResponse>({ type: "get_connection_journal" });
      expect(journal.journal!.events).not.toContainEqual(
        expect.objectContaining({ event: "failure" }),
      );
      expect(journal.journal!.events).not.toContainEqual(
        expect.objectContaining({ event: "command", action: type }),
      );
      expect(journal.journal!.events).toContainEqual(
        expect.objectContaining({ event: "catalog", count: 0 }),
      );
    },
  );

  it("hides restored counts while account storage is unreadable and resumes after recovery", async () => {
    let readable = false;
    const session = await failedPurgeState();
    const worker = await startWorker({
      session,
      persisted: ACCOUNT_B,
      rejectJournalWrites: true,
      readPersisted: async () => {
        if (!readable) throw new Error("synthetic-account-storage-failure");
        return structuredClone(ACCOUNT_B);
      },
    });
    const state = await worker.send<DiagnosticResponse>({ type: "diagnostics_state" });
    expect(state.state.signedIn).toBe(false);
    expect(state.state.connectionHistoryCount).toBe(0);
    expect(await worker.send<JournalResponse>({ type: "get_connection_journal" })).toEqual({
      ok: false,
      error: "storage_unavailable",
    });
    expect(session[JOURNAL_KEY]).toEqual([OLD_EVENT]);
    readable = true;
    const snapshot = await worker.send<SnapshotResponse>({ type: "get_snapshot" });
    expect(snapshot.snapshot.profile?.userId).toBe("account-b");
    expect((await worker.send<SnapshotResponse>({ type: "refresh_locations" })).ok).toBe(true);
    const restored = await worker.send<DiagnosticResponse>({ type: "diagnostics_state" });
    expect(restored.state.signedIn).toBe(true);
    expect(restored.state.connectionHistoryCount).toBeGreaterThan(0);
    const exported = await worker.send<JournalResponse>({ type: "get_connection_journal" });
    expect(exported.ok).toBe(true);
    expect(exported.journal!.events).not.toContainEqual(OLD_EVENT);
    expect(exported.journal!.events).toContainEqual(expect.objectContaining({ event: "catalog" }));
  });

  it("waits for a pending account restore before exposing a journal or its count", async () => {
    const reading = deferred<PersistedState>();
    const worker = await startWorker({
      session: await failedPurgeState(),
      persisted: ACCOUNT_B,
      readPersisted: () => reading.promise,
    });
    const seen: unknown[] = [];
    const state = worker.send<DiagnosticResponse>({ type: "diagnostics_state" });
    const journal = worker.send<JournalResponse>({ type: "get_connection_journal" });
    void state.then((value) => seen.push(value));
    void journal.then((value) => seen.push(value));
    await settle();
    expect(seen).toEqual([]);
    reading.resolve(structuredClone(ACCOUNT_B));
    const restored = await state;
    expect(restored.state.signedIn).toBe(true);
    const exported = await journal;
    expect(exported.ok).toBe(true);
    expect(exported.journal!.events).not.toContainEqual(OLD_EVENT);
  });
});

async function journalFixture() {
  vi.resetModules();
  const { ConnectionJournal } = await import("../../src/core/background/connection-journal");
  const { AppController } = await import("../../src/core/background/state-machine");
  const { ApiError } = await import("../../src/core/api/client");
  let stored: ConnectionEvent[] = [];
  const journal = new ConnectionJournal({
    storage: {
      read: async () => structuredClone(stored),
      write: async (events) => {
        stored = structuredClone(events);
      },
    },
    now: () => NOW,
  });
  await journal.initialize();
  const h = createHarness({ persisted: authenticatedState() });
  h.controller = new AppController({
    api: h.api,
    storage: h.storage,
    identity: h.identity,
    proxy: h.proxy,
    alarms: h.alarms,
    safety: h.safety,
    securityStorage: h.securityStorage,
    now: () => NOW,
    onStateChanged: (snapshot) => h.snapshots.push(snapshot),
    captureConnectionEvents: () => journal.capture(),
  });
  await h.controller.initialize();
  return { h, journal, ApiError };
}

describe("CODE-08 autonomous alarms and quota deletion journal boundaries", () => {
  afterEach(() => vi.restoreAllMocks());

  it("keeps an alarm's entry generation through delayed initialize", async () => {
    const { h, journal, ApiError } = await journalFixture();
    expect(await h.controller.connect(LOCATIONS[0]!.id)).toEqual({ ok: true });
    const initialization = deferred<undefined>();
    vi.spyOn(h.controller, "initialize").mockImplementationOnce(() => initialization.promise);
    const create = vi
      .spyOn(h.api, "createProxySession")
      .mockRejectedValueOnce(new ApiError("server_full", 409));
    const { ALARM_REFRESH } = await import("../../src/core/shared/config");
    const renewing = h.controller.handleAlarm(ALARM_REFRESH);
    journal.clear();
    initialization.resolve(undefined);
    await renewing;
    expect(create).toHaveBeenCalledTimes(1);
    expect(h.controller.getSnapshot().error).toBe("server_full");
    expect(await journal.snapshot()).toEqual([]);
    expect(await h.controller.refreshLocations()).toEqual({ ok: true });
    expect(await journal.snapshot()).toContainEqual(expect.objectContaining({ event: "catalog" }));
  });

  it("keeps an alarm's generation through renewal preflight and capacity refresh", async () => {
    const { h, journal, ApiError } = await journalFixture();
    expect(await h.controller.connect(LOCATIONS[0]!.id)).toEqual({ ok: true });
    const transient = deferred<typeof h.storage.transient>();
    const reading = vi.spyOn(h.storage, "readTransient").mockReturnValueOnce(transient.promise);
    vi.spyOn(h.api, "createProxySession").mockRejectedValueOnce(new ApiError("server_full", 409));
    const { ALARM_REFRESH } = await import("../../src/core/shared/config");
    const renewing = h.controller.handleAlarm(ALARM_REFRESH);
    await vi.waitFor(() => expect(reading).toHaveBeenCalled());
    journal.clear();
    transient.resolve(structuredClone(h.storage.transient));
    await renewing;
    expect(h.controller.getSnapshot().error).toBe("server_full");
    expect(await journal.snapshot()).toEqual([]);
    expect(await h.controller.refreshLocations()).toEqual({ ok: true });
    expect(await journal.snapshot()).toContainEqual(expect.objectContaining({ event: "catalog" }));
  });

  it.each([false, true])(
    "keeps DELETE quota generation across its presentation GET, revoked=%s",
    async (revoked) => {
      const { h, journal, ApiError } = await journalFixture();
      const remote = {
        deviceId: "journal-remote",
        name: "remote",
        kind: "browser_extension" as const,
        createdAt: "2026-08-26T12:00:00Z",
        profiles: [],
      };
      h.api.devices.devices = [remote];
      if (revoked) {
        h.identity.deviceId = "journal-revoked";
        const create = h.api.createProxySession.bind(h.api);
        vi.spyOn(h.api, "createProxySession").mockImplementation(async (...args) => {
          if (args[2].deviceId === "journal-revoked")
            throw new ApiError("device_identity_revoked", 403);
          return create(...args);
        });
      }
      h.api.enrollError = new ApiError("device_limit", 409);
      expect(await h.controller.connect(LOCATIONS[0]!.id)).toMatchObject({ ok: false });
      expect(h.controller.getSnapshot().error).toBe(
        revoked ? "device_revoked_limit" : "device_limit",
      );
      await h.controller.refreshDevices();
      h.api.enrollError = null;
      const listing = deferred<typeof h.api.devices>();
      const get = vi.spyOn(h.api, "getDevices").mockReturnValueOnce(listing.promise);
      const deleting = h.controller.deleteDevice(remote.deviceId);
      await vi.waitFor(() => expect(get).toHaveBeenCalledOnce());
      journal.clear();
      listing.resolve(structuredClone(h.api.devices));
      expect(await deleting).toEqual({ ok: true });
      expect(h.controller.getSnapshot().protected).toBe(true);
      expect(await journal.snapshot()).toEqual([]);
      expect(await h.controller.refreshLocations()).toEqual({ ok: true });
      expect(await journal.snapshot()).toContainEqual(
        expect.objectContaining({ event: "catalog" }),
      );
    },
  );
});
