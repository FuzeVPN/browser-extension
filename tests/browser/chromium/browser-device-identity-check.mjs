// SPDX-License-Identifier: MPL-2.0

// Real IndexedDB and WebCrypto regressions in a fresh, isolated Chromium profile.
// Run with node scripts/browser-device-identity-check.mjs. No build or network API required.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const root = resolve(import.meta.dirname, "../../..");
const require = createRequire(import.meta.url);
let playwrightPath = process.env.PLAYWRIGHT_MODULE_PATH;
if (!playwrightPath) {
  try {
    playwrightPath = require.resolve("playwright");
  } catch {
    playwrightPath = join(
      homedir(),
      ".cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs",
    );
  }
}
const { chromium } = await import(pathToFileURL(resolve(playwrightPath)).href);
const testRoot = await mkdtemp(join(tmpdir(), "fuzevpn-device-identity-"));
const fixture = join(testRoot, "extension");
await mkdir(fixture);
const source = await readFile(join(root, "src/core/device/device-identity.ts"), "utf8");
await writeFile(
  join(fixture, "identity.js"),
  ts
    .transpileModule(source, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
    })
    .outputText.replaceAll('"@platform/bridge"', '"./bridge.js"'),
);
await writeFile(
  join(fixture, "bridge.js"),
  ts.transpileModule(await readFile(join(root, "src/platform/chromium/bridge.ts"), "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
  }).outputText,
);
await writeFile(
  join(fixture, "manifest.json"),
  JSON.stringify({
    manifest_version: 3,
    name: "Isolated identity regression fixture",
    version: "1.0.0",
    permissions: ["storage"],
    background: { service_worker: "worker.js", type: "module" },
  }),
);
await writeFile(
  join(fixture, "worker.js"),
  'import * as identity from "./identity.js"; globalThis.identityModule = identity;',
);
const options = {
  channel: "chromium",
  headless: true,
  args: [
    `--disable-extensions-except=${fixture}`,
    `--load-extension=${fixture}`,
    "--host-resolver-rules=MAP * ~NOTFOUND",
    "--disable-background-networking",
  ],
};
if (process.env.CHROMIUM_EXECUTABLE) options.executablePath = process.env.CHROMIUM_EXECUTABLE;
const context = await chromium.launchPersistentContext(join(testRoot, "profile"), options);
const checks = [];
try {
  const worker =
    context.serviceWorkers()[0] ??
    (await context.waitForEvent("serviceworker", { timeout: 15000 }));
  await worker.evaluate(() => {
    const databaseName = "fuzevpn-device-identity";
    const legacyKey = "browser-p256-v1";
    const localIdKey = "fuzevpnBrowserDeviceId";
    const requestResult = (request) =>
      new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    const open = () => {
      const request = indexedDB.open(databaseName, 1);
      request.onupgradeneeded = () => request.result.createObjectStore("keys");
      return requestResult(request);
    };
    globalThis.fixture = {
      localIdKey,
      legacyKey,
      async reset() {
        await requestResult(indexedDB.deleteDatabase(databaseName));
        await chrome.storage.local.clear();
      },
      async seedLegacy(deviceId = "legacy-device") {
        const pair = await identityModule.generateDeviceKeyPair();
        const database = await open();
        try {
          const transaction = database.transaction("keys", "readwrite");
          transaction.objectStore("keys").put(pair, legacyKey);
          await new Promise((resolve, reject) => {
            transaction.oncomplete = resolve;
            transaction.onabort = () => reject(transaction.error);
          });
        } finally {
          database.close();
        }
        await chrome.storage.local.set({ [localIdKey]: deviceId });
        return identityModule.exportPublicKeySpkiBase64(pair.publicKey);
      },
      async read(key) {
        const database = await open();
        try {
          return await requestResult(
            database.transaction("keys", "readonly").objectStore("keys").get(key),
          );
        } finally {
          database.close();
        }
      },
      async write(key, record) {
        const database = await open();
        try {
          const transaction = database.transaction("keys", "readwrite");
          transaction.objectStore("keys").put(record, key);
          await new Promise((resolve, reject) => {
            transaction.oncomplete = resolve;
            transaction.onabort = () => reject(transaction.error);
          });
        } finally {
          database.close();
        }
      },
      async verifies(publicKey, proof) {
        const decode = (value) => {
          const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
          return Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
        };
        const key = await crypto.subtle.importKey(
          "spki",
          decode(publicKey),
          { name: "ECDSA", namedCurve: "P-256" },
          true,
          ["verify"],
        );
        return crypto.subtle.verify(
          { name: "ECDSA", hash: "SHA-256" },
          key,
          decode(proof.deviceSignature),
          new TextEncoder().encode(
            identityModule.buildDeviceProofPayload(
              proof.deviceId,
              "test-location",
              proof.deviceTimestamp,
              proof.deviceNonce,
            ),
          ),
        );
      },
    };
  });

  async function check(name, execute) {
    await worker.evaluate(() => fixture.reset());
    const result = await worker.evaluate(execute);
    assert.equal(result, true, name);
    checks.push(name);
    process.stdout.write(`PASS ${name}\n`);
  }

  await check(
    "A/B/A preserves separate device IDs and signing keys across service restart",
    async () => {
      let service = new identityModule.IndexedDbDeviceIdentityService();
      const publicA = await service.getPublicKeySpkiBase64("account-a");
      await service.setDeviceId("account-a", "device-a");
      const publicB = await service.getPublicKeySpkiBase64("account-b");
      await service.setDeviceId("account-b", "device-b");
      service = new identityModule.IndexedDbDeviceIdentityService();
      const proofA = await service.createProof(
        "account-a",
        "device-a",
        "test-location",
        Date.now(),
      );
      const proofB = await service.createProof(
        "account-b",
        "device-b",
        "test-location",
        Date.now(),
      );
      return (
        publicA !== publicB &&
        (await service.getDeviceId("account-a")) === "device-a" &&
        (await service.getDeviceId("account-b")) === "device-b" &&
        (await service.getPublicKeySpkiBase64("account-a")) === publicA &&
        (await fixture.verifies(publicA, proofA)) &&
        (await fixture.verifies(publicB, proofB)) &&
        !(await fixture.verifies(publicB, proofA))
      );
    },
  );

  await check("clearing A preserves B and refuses stale or cross-account proofs", async () => {
    const service = new identityModule.IndexedDbDeviceIdentityService();
    const publicA = await service.getPublicKeySpkiBase64("account-a");
    await service.setDeviceId("account-a", "device-a");
    const publicB = await service.getPublicKeySpkiBase64("account-b");
    await service.setDeviceId("account-b", "device-b");
    await service.clear("account-a");
    const results = await Promise.allSettled([
      service.createProof("account-a", "device-a", "test-location", Date.now()),
      service.createProof("account-b", "device-a", "test-location", Date.now()),
      service.setDeviceId("account-a", "late-enrollment"),
    ]);
    return (
      results.every(({ status }) => status === "rejected") &&
      (await service.getDeviceId("account-a")) === null &&
      (await service.getDeviceId("account-b")) === "device-b" &&
      (await service.getPublicKeySpkiBase64("account-b")) === publicB &&
      (await service.getPublicKeySpkiBase64("account-a")) !== publicA
    );
  });

  await check("legacy identity stays unassigned while B gets a separate identity", async () => {
    const publicLegacy = await fixture.seedLegacy();
    const service = new identityModule.IndexedDbDeviceIdentityService();
    const unknownOwner = await service.getDeviceId("account-b");
    await service.migrateLegacy("account-b", "different-device");
    const publicB = await service.getPublicKeySpkiBase64("account-b");
    await service.setDeviceId("account-b", "device-b");
    await service.migrateLegacy("account-a", "legacy-device");
    return (
      unknownOwner === null &&
      publicLegacy !== publicB &&
      (await service.getPublicKeySpkiBase64("account-a")) === publicLegacy &&
      (await service.getDeviceId("account-a")) === "legacy-device" &&
      (await service.getDeviceId("account-b")) === "device-b" &&
      (await service.getLegacyDeviceId()) === null &&
      (await fixture.read(fixture.legacyKey)) === undefined
    );
  });

  await check("migration preserves an already enrolled account identity", async () => {
    const service = new identityModule.IndexedDbDeviceIdentityService();
    const originalPublic = await service.getPublicKeySpkiBase64("account-a");
    await service.setDeviceId("account-a", "device-a");
    await fixture.seedLegacy();
    await service.migrateLegacy("account-a", "legacy-device");
    return (
      (await service.getDeviceId("account-a")) === "device-a" &&
      (await service.getPublicKeySpkiBase64("account-a")) === originalPublic &&
      (await service.getLegacyDeviceId()) === "legacy-device" &&
      (await fixture.read(fixture.legacyKey)) !== undefined
    );
  });

  await check(
    "migration recovers after local cleanup fails following its committed transaction",
    async () => {
      const publicLegacy = await fixture.seedLegacy();
      let service = new identityModule.IndexedDbDeviceIdentityService();
      const remove = chrome.storage.local.remove;
      let failed = false;
      try {
        chrome.storage.local.remove = async () => {
          throw new Error("Injected local cleanup failure");
        };
        try {
          await service.migrateLegacy("account-a", "legacy-device");
        } catch {
          failed = true;
        }
      } finally {
        chrome.storage.local.remove = remove;
      }
      service = new identityModule.IndexedDbDeviceIdentityService();
      const durableId = await service.getDeviceId("account-a");
      const remainingLegacyId = await service.getLegacyDeviceId();
      await service.migrateLegacy("account-a", "legacy-device");
      return (
        failed &&
        durableId === "legacy-device" &&
        remainingLegacyId === "legacy-device" &&
        (await service.getLegacyDeviceId()) === null &&
        (await service.getPublicKeySpkiBase64("account-a")) === publicLegacy
      );
    },
  );

  await check("aborted migration retains the original identity and safely retries", async () => {
    const publicLegacy = await fixture.seedLegacy();
    const service = new identityModule.IndexedDbDeviceIdentityService();
    const put = IDBObjectStore.prototype.put;
    let failed = false;
    try {
      IDBObjectStore.prototype.put = function (...args) {
        const request = put.apply(this, args);
        if (String(args[1]).startsWith("browser-p256-account-v1:")) this.transaction.abort();
        return request;
      };
      try {
        await service.migrateLegacy("account-a", "legacy-device");
      } catch {
        failed = true;
      }
    } finally {
      IDBObjectStore.prototype.put = put;
    }
    const legacyRetained =
      (await service.getLegacyDeviceId()) === "legacy-device" &&
      (await fixture.read(fixture.legacyKey)) !== undefined &&
      (await service.getDeviceId("account-a")) === null;
    await service.migrateLegacy("account-a", "legacy-device");
    return (
      failed &&
      legacyRetained &&
      (await service.getDeviceId("account-a")) === "legacy-device" &&
      (await service.getPublicKeySpkiBase64("account-a")) === publicLegacy
    );
  });

  await check("clear waits for an earlier generation and prevents key resurrection", async () => {
    const service = new identityModule.IndexedDbDeviceIdentityService();
    const generateKey = crypto.subtle.generateKey;
    let enter;
    let release;
    const entered = new Promise((resolve) => (enter = resolve));
    const gate = new Promise((resolve) => (release = resolve));
    let originalPublic;
    try {
      crypto.subtle.generateKey = async function (...args) {
        enter();
        await gate;
        return generateKey.apply(this, args);
      };
      const generating = service.getPublicKeySpkiBase64("account-a");
      await entered;
      const clearing = service.clear("account-a");
      release();
      originalPublic = await generating;
      await clearing;
    } finally {
      crypto.subtle.generateKey = generateKey;
      release?.();
    }
    const removed = (await fixture.read("browser-p256-account-v1:account-a")) === undefined;
    return (
      removed &&
      (await service.getDeviceId("account-a")) === null &&
      (await service.getPublicKeySpkiBase64("account-a")) !== originalPublic
    );
  });

  await check("the queue remains usable after a failed operation", async () => {
    const service = new identityModule.IndexedDbDeviceIdentityService();
    const invalid = await Promise.allSettled([service.getPublicKeySpkiBase64("")]);
    const publicKey = await service.getPublicKeySpkiBase64("account-a");
    await service.setDeviceId("account-a", "device-a");
    return (
      invalid[0].status === "rejected" &&
      publicKey.length > 80 &&
      (await service.getDeviceId("account-a")) === "device-a"
    );
  });

  await check(
    "pending recovery preserves its new key and budget across service restart",
    async () => {
      let service = new identityModule.IndexedDbDeviceIdentityService();
      const previous = await service.getPublicKeySpkiBase64("account-a");
      await service.setDeviceId("account-a", "old-device", previous);
      const started = await service.beginRecovery("account-a", "old-device");
      const candidate = await service.getPublicKeySpkiBase64("account-a");
      service = new identityModule.IndexedDbDeviceIdentityService();
      await service.allowRecoveryRetry("account-a", null);
      const repeated = await service.beginRecovery("account-a", null);
      const recovery = await service.getRecovery("account-a");
      const stored = await fixture.read("browser-p256-account-v1:account-a");
      return (
        started &&
        !repeated &&
        previous !== candidate &&
        recovery.pending &&
        !recovery.exhausted &&
        stored.privateKey.extractable === false &&
        stored.recovery.pending &&
        (await service.getDeviceId("account-a")) === null &&
        (await service.getPublicKeySpkiBase64("account-a")) === candidate
      );
    },
  );

  await check(
    "enrollment is bound to its exact public key and recovery ends only for its device",
    async () => {
      const service = new identityModule.IndexedDbDeviceIdentityService();
      const previous = await service.getPublicKeySpkiBase64("account-a");
      await service.setDeviceId("account-a", "old-device", previous);
      await service.beginRecovery("account-a", "old-device");
      const candidate = await service.getPublicKeySpkiBase64("account-a");
      const oldResponse = await Promise.allSettled([
        service.setDeviceId("account-a", "late-old-device", previous),
      ]);
      await service.setDeviceId("account-a", "new-device", candidate);
      await service.completeRecovery("account-a", "old-device");
      const beforeSuccess = await service.getRecovery("account-a");
      const proof = await service.createProof(
        "account-a",
        "new-device",
        "test-location",
        Date.now(),
      );
      await service.completeRecovery("account-a", "new-device");
      const afterSuccess = await service.getRecovery("account-a");
      return (
        oldResponse[0].status === "rejected" &&
        oldResponse[0].reason.name === "AbortError" &&
        beforeSuccess.pending &&
        !afterSuccess.pending &&
        !afterSuccess.exhausted &&
        (await service.getDeviceId("account-a")) === "new-device" &&
        (await service.getPublicKeySpkiBase64("account-a")) === candidate &&
        (await fixture.verifies(candidate, proof)) &&
        !(await fixture.verifies(previous, proof))
      );
    },
  );

  await check(
    "only explicit retry of the current exhausted candidate renews its rotation budget",
    async () => {
      let service = new identityModule.IndexedDbDeviceIdentityService();
      await service.getPublicKeySpkiBase64("account-a");
      await service.setDeviceId("account-a", "old-device");
      await service.beginRecovery("account-a", "old-device");
      const candidate = await service.getPublicKeySpkiBase64("account-a");
      await service.setDeviceId("account-a", "new-device", candidate);
      await service.markRecoveryExhausted("account-a", "old-device");
      const ignoredOldFailure = !(await service.getRecovery("account-a")).exhausted;
      await service.markRecoveryExhausted("account-a", "new-device");
      service = new identityModule.IndexedDbDeviceIdentityService();
      const before = await service.getRecovery("account-a");
      const repeated = await service.beginRecovery("account-a", "new-device");
      await service.allowRecoveryRetry("account-a", "old-device");
      const ignoredOldRetry = (await service.getRecovery("account-a")).exhausted;
      await service.allowRecoveryRetry("account-a", "new-device");
      const reopened = await service.getRecovery("account-a");
      const keptIdentity =
        (await service.getDeviceId("account-a")) === "new-device" &&
        (await service.getPublicKeySpkiBase64("account-a")) === candidate;
      const rotated = await service.beginRecovery("account-a", "new-device");
      return (
        ignoredOldFailure &&
        before.pending &&
        before.exhausted &&
        !repeated &&
        ignoredOldRetry &&
        !reopened.pending &&
        !reopened.exhausted &&
        keptIdentity &&
        rotated &&
        (await service.getPublicKeySpkiBase64("account-a")) !== candidate
      );
    },
  );

  await check(
    "unenrolled candidates keep their key after retry and recover independently by account",
    async () => {
      const service = new identityModule.IndexedDbDeviceIdentityService();
      const publicB = await service.getPublicKeySpkiBase64("account-b");
      await service.setDeviceId("account-b", "device-b", publicB);
      const oldA = await service.getPublicKeySpkiBase64("account-a");
      const started = await service.beginRecovery("account-a", null);
      const candidate = await service.getPublicKeySpkiBase64("account-a");
      await service.allowRecoveryRetry("account-a", null);
      const pending = await service.getRecovery("account-a");
      await service.markRecoveryExhausted("account-a", null);
      await service.allowRecoveryRetry("account-a", null);
      const sameKeyBeforeRotation =
        (await service.getPublicKeySpkiBase64("account-a")) === candidate;
      const rotated = await service.beginRecovery("account-a", null);
      return (
        started &&
        oldA !== candidate &&
        pending.pending &&
        !pending.exhausted &&
        sameKeyBeforeRotation &&
        rotated &&
        (await service.getPublicKeySpkiBase64("account-a")) !== candidate &&
        (await service.getPublicKeySpkiBase64("account-b")) === publicB &&
        (await service.getDeviceId("account-b")) === "device-b" &&
        !(await service.getRecovery("account-b")).pending
      );
    },
  );

  await check("concurrent service instances commit exactly one recovery rotation", async () => {
    const first = new identityModule.IndexedDbDeviceIdentityService();
    const second = new identityModule.IndexedDbDeviceIdentityService();
    const previous = await first.getPublicKeySpkiBase64("account-a");
    await first.setDeviceId("account-a", "old-device", previous);
    const started = await Promise.all([
      first.beginRecovery("account-a", "old-device"),
      second.beginRecovery("account-a", "old-device"),
    ]);
    const candidate = await first.getPublicKeySpkiBase64("account-a");
    return (
      started.filter(Boolean).length === 1 &&
      candidate !== previous &&
      (await second.getPublicKeySpkiBase64("account-a")) === candidate &&
      (await second.getRecovery("account-a")).pending
    );
  });

  await check(
    "late enrollment cannot bind a different key rotated during its public-key check",
    async () => {
      const first = new identityModule.IndexedDbDeviceIdentityService();
      const second = new identityModule.IndexedDbDeviceIdentityService();
      const previous = await first.getPublicKeySpkiBase64("account-a");
      await first.setDeviceId("account-a", "old-device", previous);
      const exportKey = crypto.subtle.exportKey;
      let enter;
      let release;
      const entered = new Promise((resolve) => (enter = resolve));
      const gate = new Promise((resolve) => (release = resolve));
      let result;
      try {
        crypto.subtle.exportKey = async function (...args) {
          enter();
          await gate;
          return exportKey.apply(this, args);
        };
        const enrolling = first.setDeviceId("account-a", "late-device", previous);
        const settled = Promise.allSettled([enrolling]);
        await entered;
        await second.beginRecovery("account-a", "old-device");
        release();
        result = (await settled)[0];
      } finally {
        crypto.subtle.exportKey = exportKey;
        release?.();
      }
      return (
        result.status === "rejected" &&
        result.reason.name === "AbortError" &&
        (await first.getDeviceId("account-a")) === null &&
        (await first.getPublicKeySpkiBase64("account-a")) !== previous &&
        (await first.getRecovery("account-a")).pending
      );
    },
  );

  await check(
    "a late rotation cannot replace a newer identity created while key generation waits",
    async () => {
      const first = new identityModule.IndexedDbDeviceIdentityService();
      const second = new identityModule.IndexedDbDeviceIdentityService();
      await first.getPublicKeySpkiBase64("account-a");
      await first.setDeviceId("account-a", "old-device");
      const generateKey = crypto.subtle.generateKey;
      let enter;
      let release;
      let waited = false;
      const entered = new Promise((resolve) => (enter = resolve));
      const gate = new Promise((resolve) => (release = resolve));
      let rotated;
      let newerPublic;
      try {
        crypto.subtle.generateKey = async function (...args) {
          if (!waited) {
            waited = true;
            enter();
            await gate;
          }
          return generateKey.apply(this, args);
        };
        const rotating = first.beginRecovery("account-a", "old-device");
        await entered;
        await second.clear("account-a");
        newerPublic = await second.getPublicKeySpkiBase64("account-a");
        await second.setDeviceId("account-a", "newer-device", newerPublic);
        release();
        rotated = await rotating;
      } finally {
        crypto.subtle.generateKey = generateKey;
        release?.();
      }
      return (
        !rotated &&
        (await first.getDeviceId("account-a")) === "newer-device" &&
        (await first.getPublicKeySpkiBase64("account-a")) === newerPublic &&
        !(await first.getRecovery("account-a")).pending
      );
    },
  );

  await check(
    "an aborted rotation preserves the old identity and leaves the budget available",
    async () => {
      const service = new identityModule.IndexedDbDeviceIdentityService();
      const previous = await service.getPublicKeySpkiBase64("account-a");
      await service.setDeviceId("account-a", "old-device", previous);
      const put = IDBObjectStore.prototype.put;
      let failed = false;
      try {
        IDBObjectStore.prototype.put = function (...args) {
          const request = put.apply(this, args);
          if (args[0]?.recovery?.pending) this.transaction.abort();
          return request;
        };
        try {
          await service.beginRecovery("account-a", "old-device");
        } catch {
          failed = true;
        }
      } finally {
        IDBObjectStore.prototype.put = put;
      }
      const preserved =
        (await service.getDeviceId("account-a")) === "old-device" &&
        (await service.getPublicKeySpkiBase64("account-a")) === previous &&
        !(await service.getRecovery("account-a")).pending;
      return failed && preserved && (await service.beginRecovery("account-a", "old-device"));
    },
  );

  await check(
    "existing account records without recovery metadata retain their original key",
    async () => {
      let service = new identityModule.IndexedDbDeviceIdentityService();
      const publicKey = await service.getPublicKeySpkiBase64("account-a");
      await service.setDeviceId("account-a", "device-a", publicKey);
      const recordKey = "browser-p256-account-v1:account-a";
      const legacyRecord = await fixture.read(recordKey);
      delete legacyRecord.keyId;
      delete legacyRecord.recovery;
      await fixture.write(recordKey, legacyRecord);
      service = new identityModule.IndexedDbDeviceIdentityService();
      const initial = await service.getRecovery("account-a");
      await service.allowRecoveryRetry("account-a");
      await service.markRecoveryExhausted("account-a");
      const wrongDevice = await service.beginRecovery("account-a", "another-device");
      await service.setDeviceId("account-a", "device-a", publicKey);
      const proof = await service.createProof("account-a", "device-a", "test-location", Date.now());
      const updated = await fixture.read(recordKey);
      return (
        !initial.pending &&
        !initial.exhausted &&
        !wrongDevice &&
        typeof updated.keyId === "string" &&
        (await service.getPublicKeySpkiBase64("account-a")) === publicKey &&
        (await service.getDeviceId("account-a")) === "device-a" &&
        (await fixture.verifies(publicKey, proof))
      );
    },
  );

  await check(
    "concurrent first-use enrollment candidates share one durable signing key",
    async () => {
      const first = new identityModule.IndexedDbDeviceIdentityService();
      const second = new identityModule.IndexedDbDeviceIdentityService();
      const publicKeys = await Promise.all([
        first.getPublicKeySpkiBase64("account-a"),
        second.getPublicKeySpkiBase64("account-a"),
      ]);
      await Promise.all([
        first.setDeviceId("account-a", "device-a", publicKeys[0]),
        second.setDeviceId("account-a", "device-a", publicKeys[1]),
      ]);
      return (
        publicKeys[0] === publicKeys[1] &&
        (await first.getDeviceId("account-a")) === "device-a" &&
        (await second.getPublicKeySpkiBase64("account-a")) === publicKeys[0]
      );
    },
  );

  process.stdout.write(
    JSON.stringify({ chromium: context.browser().version(), checks: checks.length, testRoot }) +
      "\n",
  );
} finally {
  await context.close();
}
