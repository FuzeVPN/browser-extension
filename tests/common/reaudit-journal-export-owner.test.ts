// SPDX-License-Identifier: MPL-2.0

import type { ConnectionEvent } from "../../src/core/background/connection-journal";
import type { DiagnosticResponse } from "../../src/core/shared/diagnostics-ui";
import type { PersistedState } from "../../src/core/storage/storage";
import { EMPTY_PERSISTED_STATE } from "../../src/core/storage/storage";
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

function expectNoOldMetadata(response: JournalResponse) {
  expect(response.journal?.events ?? []).not.toContainEqual(OLD_EVENT);
  expect(response.journal?.events.some((event) => event.at === OLD_EVENT.at) ?? false).toBe(false);
}

describe("journal exports wait for an established account owner in the real worker", () => {
  beforeEach(() => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });
  afterEach(async () => {
    await settle();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("does not export old-account metadata while account storage is blocked, then resumes safely as B", async () => {
    const session = await failedPurgeState();
    const reading = deferred<PersistedState>();
    const worker = await startWorker({
      session,
      persisted: ACCOUNT_B,
      readPersisted: () => reading.promise,
    });
    const observed: JournalResponse[] = [];
    const exporting = worker.send<JournalResponse>({ type: "get_connection_journal" });
    void exporting.then((response) => observed.push(response));
    await settle();
    const responsesBeforeOwner = [...observed];
    reading.resolve(structuredClone(ACCOUNT_B));
    for (const response of responsesBeforeOwner) expectNoOldMetadata(response);
    const response = await exporting;
    expect(response.ok).toBe(true);
    expectNoOldMetadata(response);
    const snapshot = await worker.send<SnapshotResponse>({ type: "get_snapshot" });
    expect(snapshot.snapshot.profile?.userId).toBe("account-b");
    expectNoOldMetadata(await worker.send({ type: "get_connection_journal" }));
  });

  it("fails closed after unreadable account storage and remains safe across another worker restart", async () => {
    const session = await failedPurgeState();
    const reading = deferred<PersistedState>();
    let unreadable = false;
    const firstWorker = await startWorker({
      session,
      persisted: ACCOUNT_B,
      rejectJournalWrites: true,
      readPersisted: () =>
        unreadable
          ? Promise.reject(new Error("synthetic-account-storage-failure"))
          : reading.promise,
    });
    const exporting = firstWorker.send<JournalResponse>({ type: "get_connection_journal" });
    unreadable = true;
    reading.reject(new Error("synthetic-account-storage-failure"));
    const denied = await exporting;
    expect(denied.ok).toBe(false);
    expect(denied.error).toBe("storage_unavailable");
    expectNoOldMetadata(denied);
    expect(session[JOURNAL_KEY]).toEqual([OLD_EVENT]);
    await settle();

    const restartingRead = deferred<PersistedState>();
    const secondWorker = await startWorker({
      session,
      persisted: ACCOUNT_B,
      readPersisted: () => restartingRead.promise,
    });
    const observed: JournalResponse[] = [];
    const afterRestart = secondWorker.send<JournalResponse>({ type: "get_connection_journal" });
    void afterRestart.then((response) => observed.push(response));
    await settle();
    const responsesBeforeOwner = [...observed];
    restartingRead.resolve(structuredClone(ACCOUNT_B));
    for (const response of responsesBeforeOwner) expectNoOldMetadata(response);
    const recovered = await afterRestart;
    expect(recovered.ok).toBe(true);
    expectNoOldMetadata(recovered);
    expect(session[JOURNAL_KEY]).not.toContainEqual(OLD_EVENT);
  });

  it("allows an established guest to export a fresh journal without an old account's restored lines", async () => {
    const session = await failedPurgeState();
    const worker = await startWorker({ session, persisted: { ...EMPTY_PERSISTED_STATE } });
    const response = await worker.send<JournalResponse>({ type: "get_connection_journal" });
    expect(response.ok).toBe(true);
    expect(response.journal?.schemaVersion).toBe(1);
    expectNoOldMetadata(response);
    const snapshot = await worker.send<SnapshotResponse>({ type: "get_snapshot" });
    expect(snapshot.snapshot.profile).toBeNull();
    expectNoOldMetadata(await worker.send({ type: "get_connection_journal" }));
  });

  it("allows a healthy B restart without exposing the retained A journal", async () => {
    const session = await failedPurgeState();
    const worker = await startWorker({ session, persisted: ACCOUNT_B });
    const response = await worker.send<JournalResponse>({ type: "get_connection_journal" });
    expect(response.ok).toBe(true);
    expectNoOldMetadata(response);
    const snapshot = await worker.send<SnapshotResponse>({ type: "get_snapshot" });
    expect(snapshot.snapshot.profile?.userId).toBe("account-b");
  });

  it("drops erased operation traces through the worker but records a new refresh with the same operation ID", async () => {
    const worker = await startWorker({ session: {}, persisted: ACCOUNT_B });
    await worker.send({ type: "get_snapshot" });
    await worker.send({ type: "diagnostics_state" });
    const catalog = deferred<typeof LOCATIONS>();
    const request = vi
      .spyOn(worker.harness.api, "getLocations")
      .mockReturnValueOnce(catalog.promise);
    const connecting = worker.send<SnapshotResponse>({
      type: "connect",
      locationId: LOCATIONS[0]!.id,
    });
    await vi.waitFor(() => expect(request).toHaveBeenCalled());
    const cleared = await worker.send<{ ok: boolean }>({ type: "diagnostics_clear_history" });
    catalog.resolve(LOCATIONS);
    expect(cleared.ok).toBe(true);
    expect((await connecting).ok).toBe(true);
    const completed = await worker.send<JournalResponse>({ type: "get_connection_journal" });
    expect(completed.ok).toBe(true);
    expect(
      completed.journal?.events.some(
        (event) =>
          event.event === "catalog" ||
          event.event === "target" ||
          (event.event === "command" && event.action === "connect" && event.phase === "end"),
      ),
    ).toBe(false);
    // The actual connected state is a fresh observation; clearing history does not stop recording.
    expect(completed.journal?.events).toContainEqual(
      expect.objectContaining({ event: "state", status: "connected" }),
    );
    await worker.send({ type: "diagnostics_clear_history" });
    expect((await worker.send<SnapshotResponse>({ type: "refresh_locations" })).ok).toBe(true);
    const refreshed = await worker.send<JournalResponse>({ type: "get_connection_journal" });
    expect(refreshed.journal?.events).toContainEqual(
      expect.objectContaining({ event: "catalog", count: LOCATIONS.length }),
    );
  });

  it("rejects forged diagnostic context through the worker even without any UI guard", async () => {
    const worker = await startWorker({ session: {}, persisted: ACCOUNT_B });
    const state = (await worker.send<DiagnosticResponse>({ type: "diagnostics_state" })).state;
    expect(state.signedIn).toBe(true);
    expect(state.accountEpoch).toBeDefined();
    const contexts = [
      { workerId: `${state.workerId}-forged`, accountEpoch: state.accountEpoch },
      { workerId: state.workerId, accountEpoch: state.accountEpoch! + 1 },
    ];
    for (const context of contexts) {
      const automatic = await worker.send<DiagnosticResponse>({
        type: "diagnostics_set_auto",
        enabled: false,
        ...context,
      });
      expect(automatic.ok).toBe(false);
      expect(automatic.state.autoReporting).toBe(false);
      const manual = await worker.send<DiagnosticResponse>({
        type: "diagnostics_send",
        reportId: "a1000000-0000-4000-8000-000000000001",
        consent: true,
        noticeVersion: 1,
        ...context,
      });
      expect(manual.ok).toBe(false);
      expect(manual.state.reports).toEqual([]);
    }
    const current = await worker.send<DiagnosticResponse>({
      type: "diagnostics_set_auto",
      enabled: false,
      workerId: state.workerId,
      accountEpoch: state.accountEpoch,
    });
    expect(current.ok).toBe(true);
  });

  it("rejects a previous worker's diagnostic nonce after a healthy restart of the same account", async () => {
    const session: Record<string, unknown> = {};
    const firstWorker = await startWorker({ session, persisted: ACCOUNT_B });
    const original = (await firstWorker.send<DiagnosticResponse>({ type: "diagnostics_state" }))
      .state;
    await settle();
    const secondWorker = await startWorker({ session, persisted: ACCOUNT_B });
    const current = (await secondWorker.send<DiagnosticResponse>({ type: "diagnostics_state" }))
      .state;
    expect(current.workerId).not.toBe(original.workerId);
    const replayed = await secondWorker.send<DiagnosticResponse>({
      type: "diagnostics_set_auto",
      enabled: false,
      workerId: original.workerId,
      accountEpoch: original.accountEpoch,
    });
    expect(replayed.ok).toBe(false);
    expect(replayed.state.autoReporting).toBe(false);
    const fresh = await secondWorker.send<DiagnosticResponse>({
      type: "diagnostics_set_auto",
      enabled: false,
      workerId: current.workerId,
      accountEpoch: current.accountEpoch,
    });
    expect(fresh.ok).toBe(true);
  });
});
