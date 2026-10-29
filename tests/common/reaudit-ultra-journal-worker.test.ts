// SPDX-License-Identifier: MPL-2.0

import type { ConnectionEvent } from "../../src/core/background/connection-journal";
import { DEFAULT_SECURITY_STATE } from "../../src/core/shared/security";
import { authenticatedState, createHarness, LOCATIONS, NOW } from "./helpers";

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

interface JournalResponse {
  ok: boolean;
  journal?: { events: ConnectionEvent[] };
}
type MessageListener = (
  message: unknown,
  sender: browser.runtime.MessageSender,
  sendResponse: (response: unknown) => void,
) => unknown;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function settle() {
  await new Promise<void>((done) => setImmediate(done));
}

const operationEvents = (events: ConnectionEvent[] | undefined) =>
  (events ?? []).filter((event) => event.event !== "state");

async function startWorker(prepare?: (harness: ReturnType<typeof createHarness>) => void) {
  vi.resetModules();
  const harness = createHarness({ persisted: authenticatedState() });
  prepare?.(harness);
  shared.harness = harness;
  const session: Record<string, unknown> = {};
  const local: Record<string, unknown> = {};
  const alarms = new Map<string, number>();
  let listener: MessageListener | undefined;
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
      getManifest: () => ({ version: "0.9.2" }),
      getURL: (path: string) => `${EXTENSION_ROOT}${path}`,
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
    storage: { local: area(local), session: area(session) },
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
    if (!url.startsWith(EXTENSION_ROOT))
      throw new Error("External transport forbidden in worker journal tests");
    return url.includes("/_locales/")
      ? new Response("{}", { status: 200 })
      : new Response(null, { status: 404 });
  });
  await import("../../src/core/background/service-worker");
  const send = <T>(request: unknown) =>
    new Promise<T>((resolve, reject) => {
      const accepted = listener?.(
        request,
        { id: EXTENSION_ID, url: `${EXTENSION_ROOT}diagnostics-page/diagnostics.html` },
        (response) => resolve(response as T),
      );
      if (accepted !== true) reject(new Error("Trusted request was rejected"));
    });
  return { send, harness, session };
}

describe("worker security commands keep the journal generation captured at receipt", () => {
  beforeEach(() => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });
  afterEach(async () => {
    await settle();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("does not recreate a preference reconnect's traces after a diagnostics history clear", async () => {
    const worker = await startWorker();
    expect(await worker.send({ type: "get_snapshot" })).toMatchObject({ ok: true });
    expect(await worker.send({ type: "connect", locationId: LOCATIONS[0]!.id })).toMatchObject({
      ok: true,
    });
    // Lose the effective browser configuration while proxy control remains available.
    await worker.harness.proxy.clear();
    const gate = deferred<undefined>();
    const write = worker.harness.securityStorage.write.bind(worker.harness.securityStorage);
    const writing = vi
      .spyOn(worker.harness.securityStorage, "write")
      .mockImplementationOnce(async (state) => {
        await gate.promise;
        await write(state);
      });
    const updating = worker.send({
      type: "update_security_preferences",
      killSwitchEnabled: false,
      webRtcProtectionEnabled: false,
    });
    await vi.waitFor(() => expect(writing).toHaveBeenCalledOnce());
    expect(await worker.send({ type: "diagnostics_clear_history" })).toMatchObject({ ok: true });
    const cleared = await worker.send<JournalResponse>({ type: "get_connection_journal" });
    expect(cleared.journal?.events).toEqual([]);
    gate.resolve(undefined);
    expect(await updating).toMatchObject({ ok: true, snapshot: { protected: true } });
    const exported = await worker.send<JournalResponse>({ type: "get_connection_journal" });
    expect(exported.ok).toBe(true);
    expect(operationEvents(exported.journal?.events)).toEqual([]);
    await settle();
    expect(operationEvents(worker.session[JOURNAL_KEY] as ConnectionEvent[] | undefined)).toEqual(
      [],
    );
  });

  it("hands the controller the recorder captured when the preference command was received", async () => {
    const worker = await startWorker();
    expect(await worker.send({ type: "get_snapshot" })).toMatchObject({ ok: true });
    expect(await worker.send({ type: "connect", locationId: LOCATIONS[0]!.id })).toMatchObject({
      ok: true,
    });
    await worker.harness.proxy.clear();
    const { AppController } = await import("../../src/core/background/state-machine");
    const update = AppController.prototype.updateSecurityPreferences;
    // Erase history after receipt but before the controller runs: only the
    // recorder captured at receipt still belongs to the erased journal.
    vi.spyOn(AppController.prototype, "updateSecurityPreferences").mockImplementationOnce(
      async function (this: InstanceType<typeof AppController>, ...args) {
        expect(await worker.send({ type: "diagnostics_clear_history" })).toMatchObject({
          ok: true,
        });
        return update.apply(this, args);
      },
    );
    expect(
      await worker.send({
        type: "update_security_preferences",
        killSwitchEnabled: false,
        webRtcProtectionEnabled: false,
      }),
    ).toMatchObject({ ok: true, snapshot: { protected: true } });
    const exported = await worker.send<JournalResponse>({ type: "get_connection_journal" });
    expect(exported.ok).toBe(true);
    expect(operationEvents(exported.journal?.events)).toEqual([]);
  });
});

describe("worker commands keep a retried startup guard repair in their journal generation", () => {
  beforeEach(() => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });
  afterEach(async () => {
    await settle();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  /** Protection requested at startup, but another extension controlled the proxy setting. */
  async function startRefusedGuard() {
    const worker = await startWorker((harness) => {
      harness.securityStorage.state = {
        ...DEFAULT_SECURITY_STATE,
        protectionRequested: true,
        selectedLocationId: LOCATIONS[0]!.id,
      };
      harness.proxy.level = "controlled_by_other_extensions";
    });
    expect(await worker.send({ type: "get_snapshot" })).toMatchObject({
      snapshot: { protected: false, error: "proxy_controlled_by_extension" },
    });
    // Control is back: the next command retries the startup restoration.
    worker.harness.proxy.level = "controllable_by_this_extension";
    return worker;
  }

  it.each([
    ["connect", { type: "connect", locationId: LOCATIONS[0]!.id }],
    ["select_location", { type: "select_location", locationId: LOCATIONS[0]!.id }],
    ["change_location", { type: "change_location", locationId: LOCATIONS[0]!.id }],
    ["select_automatic_location", { type: "select_automatic_location" }],
    ["refresh_account", { type: "refresh_account" }],
    ["refresh_locations", { type: "refresh_locations" }],
  ])(
    "drops the restoration retried by %s when history is cleared during it",
    async (_name, message) => {
      const worker = await startRefusedGuard();
      const gate = deferred<undefined>();
      const block = worker.harness.safety.block.bind(worker.harness.safety);
      const blocking = vi
        .spyOn(worker.harness.safety, "block")
        .mockImplementationOnce(async (killSwitch) => {
          await gate.promise;
          await block(killSwitch);
        });
      const command = worker.send(message);
      await vi.waitFor(() => expect(blocking).toHaveBeenCalledOnce());
      expect(await worker.send({ type: "diagnostics_clear_history" })).toMatchObject({ ok: true });
      gate.resolve(undefined);
      // The restoration itself still happens; only its history belongs to the erased journal.
      expect(await command).toMatchObject({ ok: true, snapshot: { protected: true } });
      const exported = await worker.send<JournalResponse>({ type: "get_connection_journal" });
      expect(exported.ok).toBe(true);
      expect(operationEvents(exported.journal?.events)).toEqual([]);
      await settle();
      expect(operationEvents(worker.session[JOURNAL_KEY] as ConnectionEvent[] | undefined)).toEqual(
        [],
      );
    },
  );

  it("records the restoration a location command retries when history is kept", async () => {
    const worker = await startRefusedGuard();
    expect(await worker.send({ type: "connect", locationId: LOCATIONS[0]!.id })).toMatchObject({
      ok: true,
      snapshot: { protected: true },
    });
    const exported = await worker.send<JournalResponse>({ type: "get_connection_journal" });
    expect(exported.journal?.events).toContainEqual(
      expect.objectContaining({ event: "target", source: "requested" }),
    );
  });
});
