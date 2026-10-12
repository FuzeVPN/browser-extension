// SPDX-License-Identifier: MPL-2.0

import { extensionApi } from "@platform/bridge";
import type { DeviceProof } from "../api/types";

const DATABASE_NAME = "fuzevpn-device-identity";
const DATABASE_VERSION = 1;
const KEY_STORE = "keys";
const KEY_RECORD = "browser-p256-v1";
const ACCOUNT_KEY_PREFIX = "browser-p256-account-v1:";
const LOCAL_DEVICE_ID_KEY = "fuzevpnBrowserDeviceId";
const PROOF_CONTEXT = "VPN1EURO-PROXY-SESSION-V1";
const NONCE_BYTES = 24;

interface StoredKeyPair {
  privateKey: CryptoKey;
  publicKey: CryptoKey;
}

interface StoredIdentity extends StoredKeyPair {
  deviceId: string | null;
  keyId?: string;
  recovery?: DeviceRecoveryState;
}

export interface DeviceRecoveryState {
  pending: boolean;
  exhausted: boolean;
}

export interface DeviceIdentityService {
  getDeviceId(userId: string): Promise<string | null>;
  setDeviceId(userId: string, deviceId: string, expectedPublicKey?: string): Promise<void>;
  getRecovery(userId: string): Promise<DeviceRecoveryState>;
  beginRecovery(userId: string, expectedDeviceId: string | null): Promise<boolean>;
  markRecoveryExhausted(userId: string, expectedDeviceId?: string | null): Promise<void>;
  allowRecoveryRetry(userId: string, expectedDeviceId?: string | null): Promise<void>;
  completeRecovery(userId: string, expectedDeviceId: string): Promise<void>;
  getPublicKeySpkiBase64(userId: string): Promise<string>;
  createProof(
    userId: string,
    deviceId: string,
    locationId: string,
    now: number,
  ): Promise<DeviceProof>;
  clear(userId: string): Promise<void>;
  getLegacyDeviceId(): Promise<string | null>;
  migrateLegacy(userId: string, expectedDeviceId: string): Promise<void>;
}

export class IndexedDbDeviceIdentityService implements DeviceIdentityService {
  private mutation: Promise<void> = Promise.resolve();

  getDeviceId(userId: string): Promise<string | null> {
    return this.serialize(async () => {
      const stored = await readKeyRecord(accountKey(userId));
      return validIdentity(stored) ? stored.deviceId : null;
    });
  }

  setDeviceId(userId: string, deviceId: string, expectedPublicKey?: string): Promise<void> {
    return this.serialize(async () => {
      const key = accountKey(userId);
      const stored = await mutateKeyRecord(key, (current) => {
        if (!validIdentity(current) || !deviceId) throw new Error("device_identity_unavailable");
        if (current.keyId) return { result: current };
        const record = { ...current, keyId: crypto.randomUUID() };
        return { record, result: record };
      });
      // Export before opening the write transaction: WebCrypto cannot keep an
      // IndexedDB transaction alive. keyId binds the later commit to this key.
      if (
        expectedPublicKey !== undefined &&
        (await exportPublicKeySpkiBase64(stored.publicKey)) !== expectedPublicKey
      )
        throw identityChanged();
      await mutateKeyRecord(key, (current) => {
        if (!validIdentity(current) || current.keyId !== stored.keyId) throw identityChanged();
        if (current.deviceId !== stored.deviceId && current.deviceId !== deviceId)
          throw identityChanged();
        return { record: { ...current, deviceId }, result: undefined };
      });
    });
  }

  getRecovery(userId: string): Promise<DeviceRecoveryState> {
    return this.serialize(async () => recoveryState(await readKeyRecord(accountKey(userId))));
  }

  beginRecovery(userId: string, expectedDeviceId: string | null): Promise<boolean> {
    return this.serialize(async () => {
      const key = accountKey(userId);
      const previous = await readKeyRecord(key);
      const previousId = validIdentity(previous) ? previous.deviceId : null;
      if (previousId !== expectedDeviceId || recoveryState(previous).pending) return false;
      const record = await newIdentity();
      record.recovery = { pending: true, exhausted: false };
      return mutateKeyRecord(key, (current) => {
        const currentId = validIdentity(current) ? current.deviceId : null;
        const changedKey =
          validIdentity(previous) !== validIdentity(current) ||
          (validIdentity(previous) && validIdentity(current) && previous.keyId !== current.keyId);
        if (currentId !== expectedDeviceId || changedKey || recoveryState(current).pending)
          return { result: false };
        return { record, result: true };
      });
    });
  }

  markRecoveryExhausted(userId: string, expectedDeviceId?: string | null): Promise<void> {
    return this.serialize(() =>
      mutateKeyRecord(accountKey(userId), (current) => {
        if (
          !validIdentity(current) ||
          (expectedDeviceId !== undefined && current.deviceId !== expectedDeviceId) ||
          !recoveryState(current).pending
        )
          return { result: undefined };
        return {
          record: { ...current, recovery: { pending: true, exhausted: true } },
          result: undefined,
        };
      }),
    );
  }

  allowRecoveryRetry(userId: string, expectedDeviceId?: string | null): Promise<void> {
    return this.serialize(() =>
      mutateKeyRecord(accountKey(userId), (current) => {
        if (
          !validIdentity(current) ||
          (expectedDeviceId !== undefined && current.deviceId !== expectedDeviceId) ||
          !recoveryState(current).exhausted
        )
          return { result: undefined };
        const record = { ...current };
        delete record.recovery;
        return { record, result: undefined };
      }),
    );
  }

  completeRecovery(userId: string, expectedDeviceId: string): Promise<void> {
    return this.serialize(() =>
      mutateKeyRecord(accountKey(userId), (current) => {
        if (!validIdentity(current) || current.deviceId !== expectedDeviceId)
          return { result: undefined };
        const record = { ...current };
        delete record.recovery;
        return { record, result: undefined };
      }),
    );
  }

  getPublicKeySpkiBase64(userId: string): Promise<string> {
    return this.serialize(async () => {
      const pair = await loadOrCreateIdentity(accountKey(userId));
      return exportPublicKeySpkiBase64(pair.publicKey);
    });
  }

  createProof(
    userId: string,
    deviceId: string,
    locationId: string,
    now: number,
  ): Promise<DeviceProof> {
    return this.serialize(async () => {
      const stored = await readKeyRecord(accountKey(userId));
      if (!validIdentity(stored) || stored.deviceId !== deviceId)
        throw new Error("device_identity_unavailable");
      return signDeviceProof(stored.privateKey, deviceId, locationId, now);
    });
  }

  clear(userId: string): Promise<void> {
    return this.serialize(() => deleteKeyRecord(accountKey(userId)));
  }

  getLegacyDeviceId(): Promise<string | null> {
    return this.serialize(readLegacyDeviceId);
  }

  // The caller must first verify ownership through the authenticated device list.
  migrateLegacy(userId: string, expectedDeviceId: string): Promise<void> {
    return this.serialize(async () => {
      const key = accountKey(userId);
      if (!expectedDeviceId || (await readLegacyDeviceId()) !== expectedDeviceId) return;
      if (await migrateLegacyRecord(key, expectedDeviceId))
        await extensionApi.storage.local.remove(LOCAL_DEVICE_ID_KEY);
    });
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutation.then(operation);
    // A failed storage operation must not prevent a later retry or clear.
    this.mutation = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

export async function exportPublicKeySpkiBase64(publicKey: CryptoKey): Promise<string> {
  const exported = await crypto.subtle.exportKey("spki", publicKey);
  return base64(new Uint8Array(exported));
}

export async function signDeviceProof(
  privateKey: CryptoKey,
  deviceId: string,
  locationId: string,
  now: number,
): Promise<DeviceProof> {
  const deviceTimestamp = Math.floor(now / 1_000);
  const nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
  const deviceNonce = base64Url(nonce);
  const payload = new TextEncoder().encode(
    buildDeviceProofPayload(deviceId, locationId, deviceTimestamp, deviceNonce),
  );
  const rawSignature = new Uint8Array(
    await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, privateKey, payload),
  );
  if (rawSignature.length !== 64) throw new Error("invalid_device_signature");
  return {
    deviceId,
    deviceTimestamp,
    deviceNonce,
    deviceSignature: base64Url(rawSignature),
  };
}

export function buildDeviceProofPayload(
  deviceId: string,
  locationId: string,
  timestamp: number,
  nonce: string,
): string {
  return `${PROOF_CONTEXT}\n${deviceId}\n${locationId}\n${String(timestamp)}\n${nonce}`;
}

async function loadOrCreateIdentity(key: string): Promise<StoredIdentity> {
  const stored = await readKeyRecord(key);
  if (validIdentity(stored)) return stored;
  const generated = await newIdentity();
  return mutateKeyRecord(key, (current) =>
    validIdentity(current) ? { result: current } : { record: generated, result: generated },
  );
}

async function newIdentity(): Promise<StoredIdentity> {
  const generated = await generateDeviceKeyPair();
  const pair = {
    privateKey: generated.privateKey,
    publicKey: generated.publicKey,
    deviceId: null,
    keyId: crypto.randomUUID(),
  };
  if (!validKeyPair(pair)) throw new Error("invalid_device_key_pair");
  return pair;
}

function recoveryState(value: unknown): DeviceRecoveryState {
  if (!validIdentity(value)) return { pending: false, exhausted: false };
  const exhausted = value.recovery?.exhausted === true;
  return { pending: exhausted || value.recovery?.pending === true, exhausted };
}

function identityChanged(): DOMException {
  return new DOMException("Device identity changed", "AbortError");
}

function accountKey(userId: string): string {
  if (!userId) throw new Error("device_identity_owner_required");
  return `${ACCOUNT_KEY_PREFIX}${userId}`;
}

async function readLegacyDeviceId(): Promise<string | null> {
  const result = await extensionApi.storage.local.get(LOCAL_DEVICE_ID_KEY);
  const value: unknown = result[LOCAL_DEVICE_ID_KEY];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function validIdentity(value: unknown): value is StoredIdentity {
  if (!validKeyPair(value)) return false;
  const deviceId = (value as Partial<StoredIdentity>).deviceId;
  return deviceId === null || (typeof deviceId === "string" && deviceId.length > 0);
}

export async function generateDeviceKeyPair(): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, [
    "sign",
    "verify",
  ]);
}

function validKeyPair(value: unknown): value is StoredKeyPair {
  if (!value || typeof value !== "object") return false;
  const pair = value as Partial<StoredKeyPair>;
  return (
    isP256Key(pair.privateKey, "private", "sign") &&
    !pair.privateKey.extractable &&
    isP256Key(pair.publicKey, "public", "verify")
  );
}

function isP256Key(key: CryptoKey | undefined, type: KeyType, usage: KeyUsage): key is CryptoKey {
  if (key?.type !== type || !key.usages.includes(usage)) return false;
  const algorithm = key.algorithm as EcKeyAlgorithm;
  return algorithm.name === "ECDSA" && algorithm.namedCurve === "P-256";
}

function base64(bytes: Uint8Array): string {
  return btoa(bytesToBinary(bytes));
}

function base64Url(bytes: Uint8Array): string {
  return base64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/u, "");
}

function bytesToBinary(bytes: Uint8Array): string {
  let result = "";
  for (const byte of bytes) result += String.fromCharCode(byte);
  return result;
}

async function readKeyRecord(key: string): Promise<unknown> {
  const database = await openDatabase();
  try {
    return await requestResult(
      database.transaction(KEY_STORE, "readonly").objectStore(KEY_STORE).get(key),
    );
  } finally {
    database.close();
  }
}

async function mutateKeyRecord<T>(
  key: string,
  mutation: (current: unknown) => { record?: StoredIdentity; result: T },
): Promise<T> {
  const database = await openDatabase();
  try {
    const transaction = database.transaction(KEY_STORE, "readwrite");
    const done = transactionDone(transaction);
    const store = transaction.objectStore(KEY_STORE);
    const request = store.get(key);
    let result!: T;
    let mutationError: unknown;
    request.onsuccess = () => {
      try {
        const updated = mutation(request.result);
        result = updated.result;
        if (updated.record) store.put(updated.record, key);
      } catch (error) {
        mutationError = error;
        transaction.abort();
      }
    };
    try {
      await done;
    } catch (error) {
      throw mutationError ?? error;
    }
    return result;
  } finally {
    database.close();
  }
}

async function deleteKeyRecord(key: string): Promise<void> {
  const database = await openDatabase();
  try {
    const transaction = database.transaction(KEY_STORE, "readwrite");
    transaction.objectStore(KEY_STORE).delete(key);
    await transactionDone(transaction);
  } finally {
    database.close();
  }
}

async function migrateLegacyRecord(key: string, deviceId: string): Promise<boolean> {
  const database = await openDatabase();
  try {
    const transaction = database.transaction(KEY_STORE, "readwrite");
    const store = transaction.objectStore(KEY_STORE);
    const scopedRequest = store.get(key);
    const legacyRequest = store.get(KEY_RECORD);
    let scopedRead = false;
    let legacyRead = false;
    let migrated = false;
    const migrate = () => {
      if (!scopedRead || !legacyRead) return;
      const scoped: unknown = scopedRequest.result;
      const legacy: unknown = legacyRequest.result;
      if (validIdentity(scoped)) {
        // The transaction committed but local cleanup may have been interrupted.
        migrated = scoped.deviceId === deviceId && legacy === undefined;
        return;
      }
      if (!validKeyPair(legacy)) return;
      store.put({ ...legacy, deviceId, keyId: crypto.randomUUID() }, key);
      store.delete(KEY_RECORD);
      migrated = true;
    };
    scopedRequest.onsuccess = () => {
      scopedRead = true;
      migrate();
    };
    legacyRequest.onsuccess = () => {
      legacyRead = true;
      migrate();
    };
    await transactionDone(transaction);
    return migrated;
  } finally {
    database.close();
  }
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(KEY_STORE)) {
        request.result.createObjectStore(KEY_STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error("device_identity_storage_unavailable"));
    request.onblocked = () => reject(new Error("device_identity_storage_blocked"));
  });
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error("device_identity_storage_unavailable"));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(new Error("device_identity_storage_unavailable"));
    transaction.onabort = () => reject(new Error("device_identity_storage_unavailable"));
  });
}
