// SPDX-License-Identifier: MPL-2.0

import {
  DiagnosticService,
  DIAGNOSTIC_DRAFTS_KEY,
  DIAGNOSTIC_HISTORY_ALARM,
  DIAGNOSTIC_HISTORY_KEY,
} from "../../src/core/diagnostics/service";
import type { DiagnosticAccount } from "../../src/core/diagnostics/delivery";
import type { DiagnosticReadModel } from "../../src/core/diagnostics/collector";
import { EMPTY_SNAPSHOT } from "../../src/core/shared/state";
import { EMPTY_NETWORK_OBSERVATION } from "../../src/core/shared/network";

const NOW = Date.parse("2026-10-28T12:00:00Z");
const DAY = 86_400_000;
const OWNER = "owner-a";

async function fixture() {
  let now = NOW;
  let sequence = 0;
  let signedIn = true;
  let journalEntries = 0;
  const account: DiagnosticAccount = {
    ownerId: OWNER,
    token: "synthetic-token",
    expiresAt: NOW + 4 * DAY,
    generation: 1,
  };
  const local: Record<string, unknown> = {};
  const session: Record<string, unknown> = {};
  const area = (values: Record<string, unknown>) => ({
    get: vi.fn(async (key: string) => ({ [key]: structuredClone(values[key]) })),
    set: vi.fn(async (value: Record<string, unknown>) => {
      Object.assign(values, structuredClone(value));
    }),
  });
  const storage = { local: area(local), session: area(session) };
  const scheduled = new Map<string, { when: number }>();
  const alarms = {
    create: vi.fn(async (name: string, info: { when: number }) => {
      scheduled.set(name, info);
    }),
    get: vi.fn(async (name: string) => scheduled.get(name)),
    clear: vi.fn(async (name: string) => scheduled.delete(name)),
  };
  vi.stubGlobal("browser", { storage, alarms });
  vi.stubGlobal("fetch", async () => {
    throw new Error("no transport in these tests");
  });
  const onChanged = vi.fn();
  const service = new DiagnosticService({
    read: (): DiagnosticReadModel => ({
      snapshot: {
        ...structuredClone(EMPTY_SNAPSHOT),
        status: "disconnected",
        profile: {
          userId: OWNER,
          email: "synthetic@example.invalid",
          firstName: "Synthetic",
          lastName: "User",
          countryCode: "FR",
        },
      },
      safety: {
        blockingScope: "none",
        trafficBlocked: false,
        filterActive: false,
        webRtcProtected: false,
      },
      reconnectAttempts: 0,
      proxyCreationUncertain: false,
      proxyCleanupUncertain: false,
    }),
    inspectSafety: async () => ({
      blockingScope: "none" as const,
      trafficBlocked: false,
      filterActive: false,
      webRtcProtected: false,
    }),
    inspectWebRtc: async () => false,
    getProxyControl: async () => "controllable_by_this_extension" as const,
    verifyProxy: async () => null,
    probe: async () => ({ ...EMPTY_NETWORK_OBSERVATION }),
    getAccount: () => (signedIn ? account : null),
    canSendDiagnostics: async () => true,
    environment: async () => ({ browser_name: "chrome" as const }),
    now: () => now,
    language: () => "fr" as const,
    version: () => "1.1.1",
    onChanged,
    uuid: () => `a2000000-0000-4000-8000-${(++sequence).toString(16).padStart(12, "0")}`,
    connectionHistory: {
      initialize: async () => undefined,
      clear: () => {
        journalEntries = 0;
      },
      count: () => journalEntries,
      pruneExpired: async () => undefined,
      nextExpiry: () => null,
    },
  });
  await service.initialize();
  const internals = service as unknown as {
    work: Promise<void>;
    writes: Promise<void>;
    housekeepingUpdates: Promise<void>;
  };
  const flush = async () => {
    for (let turn = 0; turn < 3; turn++) {
      await internals.work;
      await internals.writes.catch(() => undefined);
      await internals.housekeepingUpdates.catch(() => undefined);
    }
  };
  await flush();
  const writesOf = (key: string) =>
    storage.session.set.mock.calls.filter(([value]) => key in value).length;
  return {
    service,
    flush,
    onChanged,
    alarms,
    scheduled,
    /** Everything counted from here on. */
    startCounting() {
      storage.session.set.mockClear();
      storage.local.set.mockClear();
      alarms.create.mockClear();
      alarms.get.mockClear();
      alarms.clear.mockClear();
      onChanged.mockClear();
    },
    cost: () => ({
      history: writesOf(DIAGNOSTIC_HISTORY_KEY),
      drafts: writesOf(DIAGNOSTIC_DRAFTS_KEY),
      local: storage.local.set.mock.calls.length,
      alarmsSet: alarms.create.mock.calls.length,
      alarmsRead: alarms.get.mock.calls.length,
      alarmsCleared: alarms.clear.mock.calls.length,
      broadcasts: onChanged.mock.calls.length,
    }),
    incidents: () =>
      (session[DIAGNOSTIC_DRAFTS_KEY] as { incidents: { code: string; count: number }[] })
        .incidents,
    enableAutomaticReports: () => {
      const state = service.state();
      return service.handle({
        type: "diagnostics_set_auto",
        enabled: true,
        workerId: state.workerId,
        accountEpoch: state.accountEpoch,
      });
    },
    setNow(value: number) {
      now = value;
    },
    signOut() {
      signedIn = false;
    },
    addJournalEntry() {
      journalEntries += 1;
      service.connectionHistoryChanged();
    },
  };
}

const NOTHING = {
  history: 0,
  drafts: 0,
  local: 0,
  alarmsSet: 0,
  alarmsRead: 0,
  alarmsCleared: 0,
  broadcasts: 0,
};

afterEach(() => vi.unstubAllGlobals());

describe("the network state the popup asks for every few seconds", () => {
  it("costs nothing when it succeeds", async () => {
    const f = await fixture();
    const recorded = f.service.state().historyCount;
    const revision = f.service.state().revision;
    f.startCounting();

    for (let poll = 0; poll < 12; poll++) f.service.record("refresh_network", { ok: true }, 8);
    await f.flush();

    expect(f.cost()).toEqual(NOTHING);
    expect(f.service.state().historyCount).toBe(recorded);
    expect(f.service.state().revision).toBe(revision);
    expect(f.scheduled.has(DIAGNOSTIC_HISTORY_ALARM)).toBe(false);
  });

  it("does not push the events of a connection out of the technical history", async () => {
    const f = await fixture();
    f.service.record("connect", { ok: false, commandError: "proxy_unavailable" }, 900);
    await f.flush();
    const recorded = f.service.state().historyCount;

    // A popup left open for more than a quarter of an hour.
    for (let poll = 0; poll < 240; poll++) f.service.record("refresh_network", { ok: true }, 8);
    await f.flush();

    expect(f.service.state().historyCount).toBe(recorded);
  });

  it("is still recorded when it fails", async () => {
    const f = await fixture();
    const recorded = f.service.state().historyCount;
    f.startCounting();

    f.service.record("refresh_network", { ok: false, commandError: "storage_unavailable" }, 8);
    await f.flush();

    expect(f.service.state().historyCount).toBe(recorded + 1);
    expect(f.cost()).toMatchObject({ history: 1, broadcasts: 1 });
  });

  it("still ends the count of the failures which preceded it", async () => {
    const f = await fixture();
    expect(await f.enableAutomaticReports()).toMatchObject({ ok: true });
    for (let failure = 0; failure < 2; failure++) {
      f.service.record("refresh_network", { ok: false, commandError: "network_error" }, 8);
      await f.flush();
    }
    expect(f.incidents()).toMatchObject([{ code: "network_error", count: 2 }]);
    const recorded = f.service.state().historyCount;
    f.startCounting();

    f.service.record("refresh_network", { ok: true }, 8);
    f.service.record("refresh_network", { ok: true }, 8);
    await f.flush();

    expect(f.incidents()).toEqual([]);
    // The count is dropped once; the polls themselves are still no event.
    expect(f.cost()).toMatchObject({ history: 0, drafts: 1 });
    expect(f.service.state().historyCount).toBe(recorded);
  });

  it("leaves the count of failed connections alone", async () => {
    const f = await fixture();
    expect(await f.enableAutomaticReports()).toMatchObject({ ok: true });
    f.service.record("connect", { ok: false, commandError: "network_error" }, 900);
    await f.flush();

    f.service.record("refresh_network", { ok: true }, 8);
    await f.flush();

    expect(f.incidents()).toMatchObject([{ code: "network_error", count: 1 }]);
  });
});

describe("a command which succeeds", () => {
  it("is recorded in the technical history as before", async () => {
    const f = await fixture();
    const recorded = f.service.state().historyCount;
    f.startCounting();

    f.service.record("connect", { ok: true }, 900);
    await f.flush();

    expect(f.service.state().historyCount).toBe(recorded + 1);
    expect(f.cost()).toMatchObject({ history: 1, broadcasts: 1 });
  });

  it("does not rewrite the drafts when it ends no count", async () => {
    const f = await fixture();
    f.startCounting();

    f.service.record("connect", { ok: true }, 900);
    f.service.record("refresh_account", { ok: true }, 120);
    await f.flush();

    expect(f.cost().drafts).toBe(0);
  });

  it("rewrites them when it ends the count of its own failures", async () => {
    const f = await fixture();
    expect(await f.enableAutomaticReports()).toMatchObject({ ok: true });
    f.service.record("connect", { ok: false, commandError: "network_error" }, 900);
    await f.flush();
    expect(f.incidents()).toHaveLength(1);
    f.startCounting();

    f.service.record("connect", { ok: true }, 900);
    await f.flush();

    expect(f.incidents()).toEqual([]);
    expect(f.cost().drafts).toBe(1);
  });
});

describe("the purge alarm of the technical history", () => {
  it("is set once for a deadline which does not change", async () => {
    const f = await fixture();
    f.startCounting();

    f.service.record("connect", { ok: true }, 900);
    await f.flush();
    const purgeAt = f.scheduled.get(DIAGNOSTIC_HISTORY_ALARM)?.when;
    expect(purgeAt).toBeGreaterThan(NOW);
    expect(f.cost()).toMatchObject({ alarmsSet: 1, alarmsRead: 1 });

    // Later events expire later: the earliest deadline stays the first one's.
    f.setNow(NOW + 5_000);
    f.service.record("disconnect", { ok: true }, 300);
    f.service.record("refresh_account", { ok: true }, 120);
    f.addJournalEntry();
    await f.flush();

    expect(f.scheduled.get(DIAGNOSTIC_HISTORY_ALARM)?.when).toBe(purgeAt);
    expect(f.cost()).toMatchObject({ alarmsSet: 1, alarmsRead: 1, alarmsCleared: 0 });
  });

  it("is set again after it fired while history remains", async () => {
    const f = await fixture();
    f.service.record("connect", { ok: true }, 900);
    await f.flush();
    f.setNow(NOW + 300_000);
    f.service.record("disconnect", { ok: true }, 300);
    await f.flush();
    const first = f.scheduled.get(DIAGNOSTIC_HISTORY_ALARM)!.when;

    // The browser removes a one-shot alarm when it delivers it.
    f.scheduled.delete(DIAGNOSTIC_HISTORY_ALARM);
    f.setNow(first);
    await f.service.historyAlarm();
    await f.flush();

    expect(f.service.state().historyCount).toBe(1);
    expect(f.scheduled.get(DIAGNOSTIC_HISTORY_ALARM)?.when).toBeGreaterThan(first);
  });

  it("is set again with the same deadline when it fired too early to purge", async () => {
    const f = await fixture();
    f.service.record("connect", { ok: true }, 900);
    await f.flush();
    const purgeAt = f.scheduled.get(DIAGNOSTIC_HISTORY_ALARM)!.when;

    f.scheduled.delete(DIAGNOSTIC_HISTORY_ALARM);
    f.setNow(NOW + 60_000);
    await f.service.historyAlarm();
    await f.flush();

    expect(f.scheduled.get(DIAGNOSTIC_HISTORY_ALARM)?.when).toBe(purgeAt);
  });

  it("is removed once when nothing is left to purge", async () => {
    const f = await fixture();
    f.service.record("connect", { ok: true }, 900);
    await f.flush();
    f.startCounting();

    expect(await f.service.handle({ type: "diagnostics_clear_history" })).toMatchObject({
      ok: true,
    });
    f.service.syncAccount();
    f.addJournalEntry();
    await f.flush();

    expect(f.scheduled.has(DIAGNOSTIC_HISTORY_ALARM)).toBe(false);
    // Removed once, and not again by each of the calls which follow.
    expect(f.cost().alarmsCleared).toBe(1);
  });

  it("is set again when the browser did not keep it", async () => {
    const f = await fixture();
    f.alarms.get.mockResolvedValueOnce(undefined);
    f.startCounting();

    f.service.record("connect", { ok: true }, 900);
    await f.flush();
    f.service.record("disconnect", { ok: true }, 300);
    await f.flush();

    expect(f.cost().alarmsSet).toBeGreaterThanOrEqual(2);
    expect(f.scheduled.has(DIAGNOSTIC_HISTORY_ALARM)).toBe(true);
  });
});

describe("the diagnostics state sent to open pages", () => {
  it("is not sent again when a publication changes nothing in it", async () => {
    const f = await fixture();
    const revision = f.service.state().revision;
    f.startCounting();

    for (let publication = 0; publication < 6; publication++) f.service.syncAccount();
    await f.flush();

    expect(f.cost()).toEqual(NOTHING);
    expect(f.service.state().revision).toBe(revision);
  });

  it("is sent when the account it describes changes", async () => {
    const f = await fixture();
    f.startCounting();

    f.signOut();
    f.service.syncAccount();
    f.service.syncAccount();

    expect(f.onChanged).toHaveBeenCalledTimes(1);
    expect(f.onChanged).toHaveBeenLastCalledWith(expect.objectContaining({ signedIn: false }));
  });

  it("is sent when the connection journal grows", async () => {
    const f = await fixture();
    f.startCounting();

    f.addJournalEntry();
    await f.flush();

    expect(f.onChanged).toHaveBeenCalledTimes(1);
    expect(f.onChanged).toHaveBeenLastCalledWith(
      expect.objectContaining({ connectionHistoryCount: 1 }),
    );
  });

  it("is not sent to the other pages by a request which only reads it", async () => {
    const f = await fixture();
    f.service.syncAccount();
    const before = f.service.state().revision;
    f.startCounting();

    // The page which asks is answered; the others already hold this state.
    const answer = await f.service.handle({ type: "diagnostics_state" });
    expect(answer).toMatchObject({ ok: true, state: { revision: before } });
    expect(await f.service.handle({ type: "diagnostics_state" })).toMatchObject({ ok: true });

    expect(f.onChanged).not.toHaveBeenCalled();
    expect(f.service.state().revision).toBe(before);
  });

  it("is sent by a request which changes it, with a later revision", async () => {
    const f = await fixture();
    f.service.syncAccount();
    f.service.record("connect", { ok: false, commandError: "network_error" });
    await f.flush();
    const before = f.service.state().revision;
    f.startCounting();

    expect(await f.service.handle({ type: "diagnostics_clear_history" })).toMatchObject({
      ok: true,
    });

    expect(f.onChanged).toHaveBeenCalled();
    expect(f.service.state().revision).toBeGreaterThan(before);
    expect(f.service.state().historyCount).toBe(0);
  });
});
