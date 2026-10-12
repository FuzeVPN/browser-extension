// SPDX-License-Identifier: MPL-2.0

import { ExtensionAlarmService, computeRefreshAt } from "../../src/core/background/session-refresh";
import { ALARM_EXPIRY, ALARM_RECONNECT, ALARM_REFRESH } from "../../src/core/shared/config";
import { NOW, proxySession } from "./helpers";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("verified Chrome alarm scheduling", () => {
  let scheduled: Map<string, browser.alarms.Alarm>;
  const create = vi.fn<(name: string, info: { when: number }) => void | Promise<void>>();
  const get = vi.fn<(name: string) => Promise<browser.alarms.Alarm | undefined>>();
  const clear = vi.fn<(name: string) => Promise<boolean>>();
  const service = new ExtensionAlarmService();

  beforeEach(() => {
    scheduled = new Map();
    create.mockReset().mockImplementation((name, info) => {
      scheduled.set(name, { name, scheduledTime: info.when });
    });
    get.mockReset().mockImplementation(async (name) => scheduled.get(name));
    clear.mockReset().mockImplementation(async (name) => scheduled.delete(name));
    vi.stubGlobal("browser", { alarms: { create, get, clear } });
    vi.spyOn(Date, "now").mockReturnValue(NOW);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("awaits confirmation when Chrome 108 create returns void", async () => {
    const confirmation = deferred<browser.alarms.Alarm>();
    get.mockReturnValueOnce(confirmation.promise);
    let completed = false;
    const operation = service.scheduleRetry(NOW + 1_000).then(() => {
      completed = true;
    });
    await Promise.resolve();
    expect(create.mock.results[0]?.value).toBeUndefined();
    expect(get).toHaveBeenCalledWith(ALARM_REFRESH);
    expect(completed).toBe(false);
    confirmation.resolve({ name: ALARM_REFRESH, scheduledTime: NOW + 1_000 });
    await operation;
    expect(completed).toBe(true);
  });

  it("awaits promise-based creation before reading the alarm on newer Chrome", async () => {
    const creation = deferred<undefined>();
    create.mockImplementationOnce(async (name, info) => {
      await creation.promise;
      scheduled.set(name, { name, scheduledTime: info.when });
    });
    const operation = service.scheduleReconnect(NOW + 30_000);
    await Promise.resolve();
    expect(get).not.toHaveBeenCalled();
    creation.resolve(undefined);
    await operation;
    expect(get).toHaveBeenCalledWith(ALARM_RECONNECT);
    expect(scheduled.get(ALARM_RECONNECT)?.scheduledTime).toBe(NOW + 30_000);
  });

  it.each([
    ["missing", undefined],
    ["stale deadline", { name: ALARM_REFRESH, scheduledTime: NOW - 30_000 }],
    ["postponed deadline", { name: ALARM_REFRESH, scheduledTime: NOW + 60_000 }],
    ["wrong name", { name: ALARM_EXPIRY, scheduledTime: NOW + 1_000 }],
  ] as const)("rejects a %s alarm despite a completed create call", async (_kind, alarm) => {
    get.mockResolvedValueOnce(alarm);
    await expect(service.scheduleRetry(NOW + 1_000)).rejects.toThrow("alarm_not_scheduled");
  });

  it("rejects when void creation leaves the previous alarm unchanged", async () => {
    scheduled.set(ALARM_RECONNECT, { name: ALARM_RECONNECT, scheduledTime: NOW - 1_000 });
    create.mockImplementationOnce(() => {});
    await expect(service.scheduleReconnect(NOW + 30_000)).rejects.toThrow("alarm_not_scheduled");
  });

  it("propagates a rejected creation without attempting confirmation", async () => {
    const failure = new Error("alarm_limit_reached");
    create.mockRejectedValueOnce(failure);
    await expect(service.scheduleRetry(NOW + 30_000)).rejects.toBe(failure);
    expect(get).not.toHaveBeenCalled();
  });

  it("propagates a synchronous creation failure on older Chrome", async () => {
    const failure = new Error("invalid_alarm");
    create.mockImplementationOnce(() => {
      throw failure;
    });
    await expect(service.scheduleReconnect(NOW + 30_000)).rejects.toBe(failure);
    expect(get).not.toHaveBeenCalled();
  });

  it("propagates a rejected confirmation", async () => {
    const failure = new Error("alarm_read_failed");
    get.mockRejectedValueOnce(failure);
    await expect(service.scheduleRetry(NOW + 30_000)).rejects.toBe(failure);
  });

  it("confirms both session deadlines without moving a short renewal deadline", async () => {
    const session = proxySession();
    await service.scheduleSession(session, NOW + 1_000);
    expect(scheduled.get(ALARM_REFRESH)?.scheduledTime).toBe(NOW + 1_000);
    expect(scheduled.get(ALARM_EXPIRY)?.scheduledTime).toBe(Date.parse(session.expiresAt));
    expect(get.mock.calls.map(([name]) => name).sort()).toEqual(
      [ALARM_REFRESH, ALARM_EXPIRY].sort(),
    );
  });

  it("keeps the existing computed session deadlines", async () => {
    const session = proxySession();
    await service.scheduleSession(session);
    expect(scheduled.get(ALARM_REFRESH)?.scheduledTime).toBe(computeRefreshAt(session, NOW));
    expect(scheduled.get(ALARM_EXPIRY)?.scheduledTime).toBe(Date.parse(session.expiresAt));
  });

  it("clears exhausted refresh retries while confirming the expiry alarm", async () => {
    scheduled.set(ALARM_REFRESH, { name: ALARM_REFRESH, scheduledTime: NOW });
    const session = proxySession();
    await service.scheduleSession(session, null);
    expect(scheduled.has(ALARM_REFRESH)).toBe(false);
    expect(create).toHaveBeenCalledExactlyOnceWith(ALARM_EXPIRY, {
      when: Date.parse(session.expiresAt),
    });
    expect(get).toHaveBeenCalledExactlyOnceWith(ALARM_EXPIRY);
  });

  it("rejects session scheduling if its expiry alarm is missing", async () => {
    get.mockImplementation(async (name) =>
      name === ALARM_EXPIRY ? undefined : scheduled.get(name),
    );
    await expect(service.scheduleSession(proxySession())).rejects.toThrow("alarm_not_scheduled");
  });

  it("accepts an elapsed requested deadline without delaying expiry further", async () => {
    const session = proxySession();
    const expiresAt = Date.parse(session.expiresAt);
    vi.mocked(Date.now).mockReturnValue(expiresAt + 60_000);
    await service.scheduleSession(session, null);
    expect(create).toHaveBeenCalledExactlyOnceWith(ALARM_EXPIRY, { when: expiresAt });
  });
});
