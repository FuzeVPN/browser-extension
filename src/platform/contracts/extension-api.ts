// SPDX-License-Identifier: MPL-2.0

/** The promise-based, browser-independent subset used by the shared application. */
export interface ExtensionEvent<Listener> {
  addListener(listener: Listener): void;
  removeListener(listener: Listener): void;
  hasListener(listener: Listener): boolean;
}

export interface StorageArea {
  get(keys?: string | string[] | Record<string, unknown> | null): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
}

export interface MessageSender {
  id?: string;
  url?: string;
  origin?: string;
  tab?: { id?: number; incognito?: boolean };
  frameId?: number;
}

export interface Alarm {
  name: string;
  scheduledTime: number;
  periodInMinutes?: number;
}

export interface ExtensionApi {
  storage: { local: StorageArea; session: StorageArea };
  runtime: {
    id?: string;
    getURL(path: string): string;
    getManifest(): { version: string };
    getPlatformInfo(): Promise<{ os: string; arch: string }>;
    sendMessage(message: unknown): Promise<unknown>;
    onMessage: ExtensionEvent<
      (message: unknown, sender: MessageSender, sendResponse: (value: unknown) => void) => unknown
    >;
    onStartup: ExtensionEvent<() => void>;
    onInstalled: ExtensionEvent<() => void>;
  };
  i18n: {
    getUILanguage(): string;
    getMessage(key: string, substitutions?: string | string[]): string;
  };
  alarms: {
    create(name: string, info: { when: number }): Promise<void>;
    get(name: string): Promise<Alarm | undefined>;
    clear(name: string): Promise<boolean>;
    onAlarm: ExtensionEvent<(alarm: Alarm) => void>;
  };
  action: {
    setBadgeText(details: { text: string }): Promise<void>;
    setTitle(details: { title: string }): Promise<void>;
    setIcon(details: { imageData: Record<number, ImageData> }): Promise<void>;
  };
}

/** Native request route; the controller must also revalidate its current session. */
export interface ProxyErrorProvenance {
  host: string;
  port: number;
  /** Native opaque identity, retained in memory only; not a session identity. */
  requestId?: string;
  /** Epoch milliseconds from the latest onBeforeRequest (redirect leg) of this requestId. */
  requestStartedAt?: number;
  /** Same-worker monotonic receipt time of that native onBeforeRequest event. */
  requestObservedAt?: number;
  /** Native error event date; this does not establish when the request began. */
  errorOccurredAt?: number;
}

export interface PlatformEventHandlers {
  proxyChanged(): void;
  proxyError(message: string, provenance?: ProxyErrorProvenance): void;
  permissionsChanged(): void;
  diagnosticsConsentRemoved(): void;
  diagnosticsConsentAdded(): void;
  privacyChanged(): void;
}
