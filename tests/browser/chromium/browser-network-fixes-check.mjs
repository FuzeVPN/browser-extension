// SPDX-License-Identifier: MPL-2.0

// Real Chrome regression checks, with isolated extensions, synthetic accounts and loopback traffic.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = resolve(import.meta.dirname, "../../..");
const output = resolve(
  process.env.NETWORK_FIXES_OUTPUT ??
    (await mkdtemp(join(tmpdir(), "fuzevpn-network-fixes-results-"))),
);
const scratch = await mkdtemp(join(tmpdir(), "fuzevpn-network-regressions-"));
const app = join(scratch, "app");
const other = join(scratch, "other");
const profile = join(scratch, "profile");
await Promise.all([mkdir(app), mkdir(other), mkdir(output, { recursive: true })]);
const base = {
  manifest_version: 3,
  version: "1.0",
  incognito: "spanning",
  permissions: ["proxy", "privacy", "storage", "declarativeNetRequest", "alarms"],
  host_permissions: ["<all_urls>"],
};
await writeFile(
  join(app, "manifest.json"),
  JSON.stringify({
    ...base,
    name: "FuzeVPN network regression fixture",
    background: { service_worker: "app.js" },
  }),
);
await writeFile(
  join(other, "manifest.json"),
  JSON.stringify({
    ...base,
    name: "Private-scope conflict fixture",
    background: { service_worker: "other.js" },
  }),
);
await writeFile(
  join(other, "other.js"),
  "globalThis.fixture = true; chrome.runtime.onStartup.addListener(() => {});",
);
await build({
  alias: { "@platform": join(root, "src/platform/chromium") },
  stdin: {
    resolveDir: root,
    loader: "ts",
    contents: `
    import {AppController} from './src/core/background/state-machine';
    import {PlatformProxyService} from './src/platform/chromium/proxy-controller';
    import {PlatformNetworkSafetyService,siteExclusionRules} from './src/platform/chromium/network-safety';
    import {normalizeSiteExclusion} from './src/core/shared/site-exclusions';
    import {ExtensionSiteExclusionStorage,emptySiteExclusionRecord} from './src/core/storage/site-exclusion-storage';
    import {FakeApi,FakeStorage,FakeIdentity,FakeAlarms,FakeSecurityStorage,NOW,authenticatedState} from './tests/adapters/chromium/helpers';
    const proxy=new PlatformProxyService(); const safety=new PlatformNetworkSafetyService();
    const storage=new FakeStorage(); storage.persisted=authenticatedState();
    const siteExclusionStorage=new ExtensionSiteExclusionStorage();
    const dependencies={api:new FakeApi(),storage,siteExclusionStorage,identity:new FakeIdentity(),proxy,alarms:new FakeAlarms(),safety,securityStorage:new FakeSecurityStorage(),now:()=>NOW,onStateChanged:()=>{}};
    let controller=new AppController(dependencies);
    chrome.proxy.settings.onChange.addListener(details=>void controller.handleProxyControlLost(details.levelOfControl));
    chrome.privacy.network.webRTCIPHandlingPolicy.onChange.addListener(()=>void controller.handlePrivacyChange());
    chrome.runtime.onStartup.addListener(()=>{});
    globalThis.audit={controller,proxy,safety,siteExclusionStorage,siteExclusionRules,normalizeSiteExclusion,emptySiteExclusionRecord};
  `,
  },
  platform: "browser",
  format: "iife",
  bundle: true,
  outfile: join(app, "app.js"),
});
const playwright =
  process.env.PLAYWRIGHT_MODULE_PATH ??
  join(
    homedir(),
    ".cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs",
  );
const { chromium } = await import(pathToFileURL(resolve(playwright)).href);
const options = {
  channel: "chromium",
  headless: true,
  args: [
    `--disable-extensions-except=${app},${other}`,
    `--load-extension=${app},${other}`,
    "--host-resolver-rules=MAP www.example.com 127.0.0.1, MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1",
    "--disable-background-networking",
  ],
  ...(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : {}),
};
let context;
let server;
const report = {
  timestamp: new Date().toISOString(),
  scratch,
  checks: [],
  isolation:
    "Temporary Chromium profile, two fixture extensions and loopback HTTP only; no production endpoint or credentials.",
  limitations: [
    "Real source controller/proxy/safety/exclusion storage with synthetic account, device identity and alarms; not the complete packaged worker.",
    "Private WebRTC override is verified through ChromeSetting; no external ICE/STUN/TURN measurement.",
  ],
};
function record(name, details) {
  report.checks.push({ name, passed: true, details });
  process.stdout.write(`PASS ${name}\n`);
}
async function workers() {
  for (let attempt = 0; attempt < 100; attempt++) {
    const found = context.serviceWorkers().toReversed();
    const appWorker = found.find((worker) => worker.url().endsWith("/app.js"));
    const otherWorker = found.find((worker) => worker.url().endsWith("/other.js"));
    if (appWorker && otherWorker) return { app: appWorker, other: otherWorker };
    await new Promise((done) => setTimeout(done, 100));
  }
  throw new Error(
    `Fixture extension workers unavailable: ${context
      .serviceWorkers()
      .map((worker) => worker.url())
      .join(", ")}`,
  );
}
async function awaitState(worker, predicate) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const snapshot = await worker.evaluate(() => audit.controller.getSnapshot());
    if (predicate(snapshot)) return snapshot;
    await new Promise((done) => setTimeout(done, 25));
  }
  throw new Error("Expected controller state unavailable");
}
try {
  context = await chromium.launchPersistentContext(profile, options);
  let ws = await workers();
  const ids = { app: new URL(ws.app.url()).hostname, other: new URL(ws.other.url()).hostname };
  report.chromium = context.browser().version();
  const extensionsPage = await context.newPage();
  await extensionsPage.goto("chrome://extensions/");
  for (const id of Object.values(ids)) {
    await extensionsPage.evaluate(
      (id) =>
        chrome.developerPrivate.updateExtensionConfiguration({
          extensionId: id,
          incognitoAccess: true,
        }),
      id,
    );
  }
  await extensionsPage.close();
  await context.close();
  context = await chromium.launchPersistentContext(profile, options);
  ws = await workers();
  assert.equal(await ws.app.evaluate(() => chrome.extension.isAllowedIncognitoAccess()), true);
  await ws.app.evaluate(async () => {
    await audit.controller.initialize();
    await audit.controller.connect("frankfurt-01");
  });
  await awaitState(ws.app, (state) => state.protected);

  const receivedPaths = [];
  server = createServer((request, response) => {
    receivedPaths.push(request.url);
    response.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "no-store" });
    response.end("<!doctype html><title>Private profile regression fixture</title>");
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const localUrl = `http://www.example.com:${server.address().port}`;
  const beforeWindow = await ws.app.evaluate(
    (url) => chrome.windows.create({ incognito: true, url }),
    `${localUrl}/before-conflict`,
  );
  assert.equal(beforeWindow.incognito, true);
  await new Promise((done) => setTimeout(done, 300));
  assert.equal(receivedPaths.length, 0);

  await ws.other.evaluate(async () => {
    await chrome.proxy.settings.set({ scope: "incognito_persistent", value: { mode: "direct" } });
    await chrome.privacy.network.webRTCIPHandlingPolicy.set({
      scope: "incognito_persistent",
      value: "default",
    });
  });
  const conflicted = await awaitState(ws.app, (state) => !state.protected && state.trafficBlocked);
  const effective = await ws.app.evaluate(async () => ({
    regular: await chrome.proxy.settings.get({ incognito: false }),
    private: await chrome.proxy.settings.get({ incognito: true }),
    privateWebRtc: await chrome.privacy.network.webRTCIPHandlingPolicy.get({ incognito: true }),
    sessionRules: await chrome.declarativeNetRequest.getSessionRules(),
  }));
  assert.equal(effective.regular.levelOfControl, "controlled_by_this_extension");
  assert.equal(effective.private.value.mode, "direct");
  assert.equal(effective.privateWebRtc.value, "default");
  assert.equal(
    effective.sessionRules.some((rule) => rule.id === 2001),
    false,
  );
  assert.equal(conflicted.webRtcProtected, false);
  const afterWindow = await ws.app.evaluate(
    (url) => chrome.windows.create({ incognito: true, url }),
    `${localUrl}/after-conflict`,
  );
  assert.equal(afterWindow.incognito, true);
  await new Promise((done) => setTimeout(done, 400));
  assert.equal(
    receivedPaths.length,
    0,
    "Private traffic reached loopback after a detected private-only takeover",
  );
  record(
    "Private-only proxy/WebRTC takeover removes authorization and blocks real private navigation",
    {
      protected: conflicted.protected,
      trafficBlocked: conflicted.trafficBlocked,
      receivedPaths,
      effective,
    },
  );

  await ws.other.evaluate(async () => {
    await chrome.proxy.settings.clear({ scope: "incognito_persistent" });
    await chrome.privacy.network.webRTCIPHandlingPolicy.clear({ scope: "incognito_persistent" });
  });
  await ws.app.evaluate(() => audit.controller.retryConnection());
  await awaitState(ws.app, (state) => state.protected);
  record("Connection can be retried after the private conflict is removed");

  const longPolicy = await ws.app.evaluate(async () => {
    const domain =
      "a".repeat(63) + "." + "b".repeat(63) + "." + "c".repeat(63) + "." + "d".repeat(57) + ".com";
    const entry = audit.normalizeSiteExclusion(domain, true);
    const regex = audit.siteExclusionRules([entry])[0].condition.regexFilter;
    const support = await chrome.declarativeNetRequest.isRegexSupported({
      regex,
      isCaseSensitive: false,
    });
    const before = await audit.siteExclusionStorage.read();
    let error = null;
    try {
      await audit.controller.updateSiteExclusions(0, true, [entry]);
    } catch (failure) {
      error = String(failure);
    }
    return {
      entry,
      support,
      error,
      before,
      after: await audit.siteExclusionStorage.read(),
      snapshot: audit.controller.getSnapshot(),
    };
  });
  assert.equal(longPolicy.support.isSupported, false);
  assert.equal(longPolicy.support.reason, "memoryLimitExceeded");
  assert.match(longPolicy.error, /invalid_site_exclusions/);
  assert.deepEqual(longPolicy.after, longPolicy.before);
  assert.equal(longPolicy.snapshot.siteExclusions.pending, false);
  assert.equal(longPolicy.snapshot.protected, true);
  record(
    "Uncompilable valid DNS name is rejected before journaling without interrupting protection",
    longPolicy,
  );

  await ws.app.evaluate(async (entry) => {
    // Recreate the exact durable record left by the vulnerable version.
    const record = audit.emptySiteExclusionRecord();
    record.saved = { revision: 1, enabled: true, entries: [entry] };
    record.pending = true;
    await audit.siteExclusionStorage.write(record);
  }, longPolicy.entry);
  // Restart the entire scratch browser, not just the controller, so the journal
  // and baseline must survive while session rules and worker memory are lost.
  await context.close();
  context = await chromium.launchPersistentContext(profile, options);
  ws = await workers();
  const recovered = await ws.app.evaluate(async () => {
    await audit.controller.initialize();
    const blocked = audit.controller.getSnapshot();
    await audit.controller.disconnect();
    return {
      blocked,
      after: audit.controller.getSnapshot(),
      persisted: await audit.siteExclusionStorage.read(),
      dynamic: await chrome.declarativeNetRequest.getDynamicRules(),
      session: await chrome.declarativeNetRequest.getSessionRules(),
    };
  });
  assert.equal(recovered.blocked.siteExclusions.pending, true);
  assert.equal(recovered.blocked.trafficBlocked, true);
  assert.equal(recovered.after.siteExclusions.pending, false);
  assert.equal(recovered.after.siteExclusions.error, false);
  assert.equal(recovered.after.trafficBlocked, false);
  assert.equal(recovered.after.protectionRequested, false);
  assert.equal(recovered.persisted.saved.revision, 1);
  assert.deepEqual(recovered.persisted.saved.entries, []);
  assert.equal(recovered.dynamic.length, 0);
  assert.equal(recovered.session.length, 0);
  record(
    "After a full browser restart, explicit disconnect rolls back a poisoned exclusion and releases the guard",
    recovered,
  );
  report.result = "PASS";
} catch (error) {
  report.result = "FAIL";
  report.error = String(error?.stack ?? error);
  console.error(report.error);
  process.exitCode = 1;
} finally {
  if (context) await context.close();
  if (server) await new Promise((done) => server.close(done));
  await writeFile(
    join(output, "browser-network-fixes-report.json"),
    JSON.stringify(report, null, 2),
  );
}
