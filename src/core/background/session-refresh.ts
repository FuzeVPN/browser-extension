// SPDX-License-Identifier: MPL-2.0

import { extensionApi } from "@platform/bridge";
import type { ProxySession } from "../api/types";
import { ALARM_EXPIRY, ALARM_REFRESH, ALARM_RECONNECT, REFRESH_RETRY_MS } from "../shared/config";

export interface AlarmService {
  scheduleSession(session: ProxySession, refreshAt?: number | null): Promise<void>;
  scheduleRetry(when: number): Promise<void>;
  scheduleReconnect(when: number): Promise<void>;
  clearReconnect(): Promise<void>;
  clearRefresh(): Promise<void>;
  clearAll(): Promise<void>;
}

export class ExtensionAlarmService implements AlarmService {
  async scheduleSession(
    session: ProxySession,
    refreshAt: number | null = computeRefreshAt(session, Date.now()),
  ): Promise<void> {
    await Promise.all([
      refreshAt === null
        ? extensionApi.alarms.clear(ALARM_REFRESH)
        : createVerifiedAlarm(ALARM_REFRESH, refreshAt),
      createVerifiedAlarm(ALARM_EXPIRY, Date.parse(session.expiresAt)),
    ]);
  }

  async scheduleRetry(when: number): Promise<void> {
    await createVerifiedAlarm(ALARM_REFRESH, when);
  }

  async clearRefresh(): Promise<void> {
    await extensionApi.alarms.clear(ALARM_REFRESH);
  }

  async scheduleReconnect(when: number): Promise<void> {
    await createVerifiedAlarm(ALARM_RECONNECT, when);
  }

  async clearReconnect(): Promise<void> {
    await extensionApi.alarms.clear(ALARM_RECONNECT);
  }

  async clearAll(): Promise<void> {
    await Promise.all([
      extensionApi.alarms.clear(ALARM_REFRESH),
      extensionApi.alarms.clear(ALARM_EXPIRY),
      extensionApi.alarms.clear(ALARM_RECONNECT),
    ]);
  }
}

async function createVerifiedAlarm(name: string, when: number): Promise<void> {
  // Chrome 108–110 returns void from create(); get() already supports promises.
  // scheduledTime remains the requested deadline even when Chrome fires late.
  await extensionApi.alarms.create(name, { when });
  const alarm = await extensionApi.alarms.get(name);
  if (alarm?.name !== name || alarm.scheduledTime !== when) {
    throw new Error("alarm_not_scheduled");
  }
}

export function computeRefreshAt(session: ProxySession, now: number): number {
  const issued = Date.parse(session.issuedAt);
  const expires = Date.parse(session.expiresAt);
  const requested = issued + session.refreshAfterSeconds * 1_000;
  return Math.max(now + 1_000, Math.min(requested, expires - REFRESH_RETRY_MS));
}
