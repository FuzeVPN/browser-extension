// SPDX-License-Identifier: MPL-2.0

import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { waitForRead } from "../../../scripts/browser-wait.mjs";

export const DISCONNECT_SCENARIOS = [
  "normal",
  "delayed-revocation",
  "failed-revocation",
  "omitted-after-revocation",
  "empty-catalog",
  "failed-catalog",
  "stale-catalog",
  "reopen-popup",
  "restart-worker",
  "concurrent-retry",
  "server-refusal",
];

// Serialized into the test-only extension copy. Only account API responses change;
// proxy settings, storage, protection logic and the built popup execute normally.
export function installDisconnectFixture() {
  const original = globalThis.fetch.bind(globalThis);
  const key = "disconnectStressControl";
  const statsKey = "disconnectStressStats";
  const stats = {
    posts: 0,
    deletes: 0,
    completedDeletes: 0,
    catalogs: 0,
    completedCatalogs: 0,
    held: false,
  };
  const ready = chrome.storage.session
    .get(statsKey)
    .then((stored) => Object.assign(stats, stored[statsKey] ?? {}));
  const save = () => chrome.storage.session.set({ [statsKey]: { ...stats } });
  globalThis.releaseDisconnectCatalog = () => {};
  globalThis.fetch = async (input, options = {}) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.hostname !== "api.fuzevpn.com") return original(input, options);
    await ready;
    const control = (await chrome.storage.session.get(key))[key] ?? {};
    const method = options.method ?? "GET";
    const reply = (body, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });
    if (url.pathname === "/v1/locations") {
      stats.catalogs++;
      await save();
      if (control.catalog === "held") {
        stats.held = true;
        await save();
        await new Promise((resolve) => {
          globalThis.releaseDisconnectCatalog = resolve;
        });
        stats.held = false;
      }
      if (control.catalog === "timeout") {
        await new Promise((_resolve, reject) => {
          const abort = () => reject(new DOMException("Synthetic catalog timeout", "AbortError"));
          if (options.signal?.aborted) abort();
          else options.signal?.addEventListener("abort", abort, { once: true });
        });
      }
      if (control.catalogDelay)
        await new Promise((resolve) => setTimeout(resolve, control.catalogDelay));
      stats.completedCatalogs++;
      await save();
      if (control.catalog === "error") return reply({ error: "server_error" }, 503);
      const response = await original(input, options);
      const body = await response.json();
      if (control.catalog === "empty") body.locations = [];
      if (["omit", "held", "timeout"].includes(control.catalog))
        body.locations = body.locations.filter((location) => location.id !== control.selectedId);
      return reply(body);
    }
    if (url.pathname === "/v1/proxy/sessions" && method === "POST") {
      stats.posts++;
      await save();
      if (control.refusal)
        return reply({ error: control.refusal }, control.refusal === "server_full" ? 409 : 400);
    }
    if (url.pathname.startsWith("/v1/proxy/sessions/") && method === "DELETE") {
      stats.deletes++;
      await save();
      if (control.revokeDelay)
        await new Promise((resolve) => setTimeout(resolve, control.revokeDelay));
      stats.completedDeletes++;
      await save();
      if (control.revokeFailure) return reply({ error: "server_error" }, 503);
    }
    return original(input, options);
  };
}

function watchPopup() {
  globalThis.disconnectWatch?.stop();
  const samples = [];
  const documentId = crypto.randomUUID();
  let active = true;
  let previous = "";
  const sample = () => {
    if (!active) return;
    const current = {
      label: document.querySelector("#locationName")?.textContent,
      status: document.querySelector("#statusLabel")?.textContent,
      disabled: document.querySelector("#protectButton")?.disabled,
      recovery: !document.querySelector("#recoveryPanel")?.classList.contains("hidden"),
    };
    const encoded = JSON.stringify(current);
    if (encoded !== previous) {
      samples.push({ documentId, at: performance.now(), ...current });
      previous = encoded;
    }
  };
  const observer = new MutationObserver(sample);
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    characterData: true,
  });
  const frame = () => {
    if (active) {
      sample();
      requestAnimationFrame(frame);
    }
  };
  frame();
  globalThis.disconnectWatch = {
    samples,
    stop() {
      sample();
      active = false;
      observer.disconnect();
      return samples;
    },
  };
}

function watchBootstrap() {
  const frames = [];
  const bad = [];
  let previous = "";
  const sample = () => {
    const main = document.querySelector("#mainView");
    if (main && getComputedStyle(main).display !== "none") {
      const label = document.querySelector("#locationName")?.textContent ?? "";
      if (label !== previous) {
        frames.push({ at: performance.now(), label });
        previous = label;
      }
      if (
        /Choisir un emplacement|Aucun emplacement|Choose (?:a )?location|No location/i.test(label)
      )
        bad.push({ at: performance.now(), label });
    }
    requestAnimationFrame(sample);
  };
  globalThis.disconnectBootstrap = { frames, bad };
  requestAnimationFrame(sample);
}

export async function evaluateDisconnectWorker(loader, extensionId, expression) {
  const target = (await loader.send("Target.getTargets")).targetInfos.find(
    (item) => item.type === "service_worker" && item.url.includes(extensionId),
  );
  assert(target, "Extension worker target missing");
  const { sessionId } = await loader.send("Target.attachToTarget", {
    targetId: target.targetId,
    flatten: false,
  });
  let timer;
  let receive;
  const pending = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error("Worker inspection timed out")), 5000);
    receive = ({ sessionId: from, message }) => {
      if (from !== sessionId) return;
      const reply = JSON.parse(message);
      if (reply.id !== 1) return;
      reply.error ? reject(new Error(reply.error.message)) : resolve(reply.result);
    };
    loader.on("Target.receivedMessageFromTarget", receive);
  });
  try {
    await loader.send("Target.sendMessageToTarget", {
      sessionId,
      message: JSON.stringify({
        id: 1,
        method: "Runtime.evaluate",
        params: { expression, returnByValue: true, awaitPromise: true },
      }),
    });
    const result = await pending;
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
    return result.result?.value;
  } finally {
    clearTimeout(timer);
    loader.off("Target.receivedMessageFromTarget", receive);
    await loader.send("Target.detachFromTarget", { sessionId }).catch(() => undefined);
  }
}

async function toolbarClient(context, loader, extensionId) {
  const browserPage = context.pages().find((page) => !page.isClosed());
  if (browserPage) await browserPage.bringToFront();
  await waitForRead(
    () =>
      evaluateDisconnectWorker(
        loader,
        extensionId,
        'chrome.runtime.getContexts({contextTypes:["POPUP"]}).then(items=>items.length)',
      ),
    (count) => count === 0,
    { timeoutMs: 5000, message: "The previous toolbar popup has not finished closing" },
  );
  await evaluateDisconnectWorker(loader, extensionId, "chrome.action.openPopup()");
  const info = await waitForRead(
    async () =>
      (await loader.send("Target.getTargets")).targetInfos.find(
        (target) => target.url === `chrome-extension://${extensionId}/popup/popup.html`,
      ),
    Boolean,
    { timeoutMs: 5000, message: "Native toolbar popup target missing" },
  );
  const { sessionId } = await loader.send("Target.attachToTarget", {
    targetId: info.targetId,
    flatten: false,
  });
  let sequence = 0;
  let loaded;
  const pending = new Map();
  const receive = ({ sessionId: from, message }) => {
    if (from !== sessionId) return;
    const result = JSON.parse(message);
    if (result.method === "Page.loadEventFired") loaded?.();
    const request = pending.get(result.id);
    if (request) {
      clearTimeout(request.timer);
      pending.delete(result.id);
      result.error
        ? request.reject(new Error(result.error.message))
        : request.resolve(result.result);
    }
  };
  loader.on("Target.receivedMessageFromTarget", receive);
  async function rpc(method, params = {}) {
    const id = ++sequence;
    const reply = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error("Native popup RPC timeout: " + method));
      }, 25000);
      pending.set(id, { resolve, reject, timer });
    });
    try {
      await loader.send("Target.sendMessageToTarget", {
        sessionId,
        message: JSON.stringify({ id, method, params }),
      });
    } catch (error) {
      clearTimeout(pending.get(id)?.timer);
      pending.delete(id);
      throw error;
    }
    return reply;
  }
  async function read(expression) {
    const result = await rpc("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (result.exceptionDetails)
      throw new Error(
        result.exceptionDetails.text + " " + result.exceptionDetails.exception?.description,
      );
    return result.result?.value;
  }
  const contexts = await read(
    'chrome.runtime.getContexts({contextTypes:["POPUP"]}).then(items=>items.map(c=>({type:c.contextType,tabId:c.tabId})))',
  );
  assert(contexts.some((item) => item.type === "POPUP" && item.tabId === -1));
  await rpc("Page.enable");
  await rpc("Page.addScriptToEvaluateOnNewDocument", {
    source: "(" + watchBootstrap.toString() + ")()",
  });
  const pageLoaded = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Native popup reload did not finish")), 5000);
    loaded = () => {
      clearTimeout(timer);
      resolve();
    };
  });
  await rpc("Page.reload", { ignoreCache: true });
  await pageLoaded;
  return {
    read,
    async close() {
      loader.off("Target.receivedMessageFromTarget", receive);
      await loader.send("Target.closeTarget", { targetId: info.targetId });
    },
    async screenshot(path) {
      const result = await rpc("Page.captureScreenshot", { format: "png" });
      await writeFile(path, Buffer.from(result.data, "base64"));
    },
  };
}

export async function runDisconnectSeries({
  context,
  loader,
  popup,
  extensionId,
  runRoot,
  scenario,
  count,
  onBeforeConnect,
  closeTunnels,
}) {
  assert(DISCONNECT_SCENARIOS.includes(scenario));
  await popup.close();
  let client = await toolbarClient(context, loader, extensionId);
  const invoke = (value) => client.read(`chrome.runtime.sendMessage(${JSON.stringify(value)})`);
  const state = async () => (await invoke({ type: "get_snapshot" })).snapshot;
  const configure = (value) =>
    client.read(`chrome.storage.session.set({disconnectStressControl:${JSON.stringify(value)}})`);
  const stats = () =>
    client.read(
      'chrome.storage.session.get("disconnectStressStats").then(s=>s.disconnectStressStats)',
    );
  const waitState = (predicate, message, timeoutMs = 10000) =>
    waitForRead(state, predicate, { timeoutMs, intervalMs: 15, message });
  await invoke({ type: "set_language_preference", preference: "fr" });
  const first = await waitState((s) => s.protected, "Initial protected node missing");
  const selectedId = first.selectedLocationId;
  const expectedLabel = first.activeLocation.displayName;
  let seed = 20261015;
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed;
  };
  const cycles = [];
  let attempted = 0;
  try {
    for (let index = 0; index < count; index++) {
      attempted++;
      const started = Date.now();
      await configure({ catalog: "normal", selectedId });
      if (index > 0) {
        closeTunnels();
        await onBeforeConnect(index + 1);
        await client.read('document.querySelector("#protectButton").click()');
        await waitState(
          (s) => s.protected && s.activeLocationId === selectedId,
          "Explicit reconnect failed",
        );
      }
      await waitForRead(
        () => client.read('document.querySelector("#locationName")?.textContent'),
        (value) => value?.includes(expectedLabel),
        { timeoutMs: 5000 },
      );
      await waitForRead(
        () => client.read('document.querySelector("#protectButton")?.textContent'),
        (value) => value === "Déconnecter",
        { timeoutMs: 5000 },
      );
      await client.read(
        "new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)))",
      );
      await client.read(`(${watchPopup.toString()})()`);
      const before = await stats();
      let earlierSamples = [];
      const variation = random();
      const control = { catalog: "normal", selectedId, catalogDelay: variation % 19 };
      if (scenario === "delayed-revocation") control.revokeDelay = 30 + (variation % 90);
      if (scenario === "failed-revocation") control.revokeFailure = true;
      if (
        ["omitted-after-revocation", "reopen-popup", "restart-worker", "server-refusal"].includes(
          scenario,
        )
      )
        control.catalog = "omit";
      if (scenario === "empty-catalog") control.catalog = "empty";
      if (scenario === "failed-catalog")
        control.catalog = index === count - 1 ? "timeout" : "error";
      if (scenario === "stale-catalog") control.catalog = "held";
      if (scenario === "restart-worker") control.revokeDelay = 250;
      await configure(control);
      let stale;
      if (scenario === "stale-catalog") {
        await client.read(
          'globalThis.staleCatalogReply=chrome.runtime.sendMessage({type:"refresh_locations"});undefined',
        );
        await waitForRead(stats, (s) => s.held, {
          timeoutMs: 3000,
          message: "Stale catalog fixture was not held",
        });
        await configure({ ...control, catalog: "normal" });
        stale = true;
      } else if (
        ![
          "failed-catalog",
          "normal",
          "delayed-revocation",
          "failed-revocation",
          "concurrent-retry",
        ].includes(scenario)
      ) {
        await invoke({ type: "refresh_locations" });
      }
      await client.read('document.querySelector("#protectButton").click()');
      if (scenario === "concurrent-retry") {
        await client.read(
          'globalThis.concurrentRetry=chrome.runtime.sendMessage({type:"retry_connection"})',
        );
        await client.read('chrome.alarms.create("fuzevpn-proxy-reconnect",{when:Date.now()})');
      }
      let stopped = await waitState(
        (s) => s.status === "disconnected" && !s.protectionRequested && !s.trafficBlocked,
        "Stop was overridden by another command",
      );
      assert.equal(stopped.selectedLocationId, selectedId);
      assert.equal(stopped.selectedLocation?.displayName, expectedLabel);
      assert.equal(stopped.activeLocationId, null);
      if (scenario === "restart-worker") {
        const previousIdentity = stopped.snapshotVersion.workerId;
        const target = (await loader.send("Target.getTargets")).targetInfos.find(
          (item) => item.type === "service_worker" && item.url.includes(extensionId),
        );
        assert(target, "Running extension worker target not found");
        assert((await loader.send("Target.closeTarget", { targetId: target.targetId })).success);
        stopped = await waitState(
          (s) => s.status === "disconnected" && !s.protectionRequested,
          "Worker restart restored protection after explicit stop",
        );
        assert.notEqual(stopped.snapshotVersion.workerId, previousIdentity);
      }
      if (scenario === "reopen-popup") {
        const samples = await client.read("globalThis.disconnectWatch.stop()");
        earlierSamples = samples;
        assert(
          samples.every((sample) => sample.label?.includes(expectedLabel)),
          JSON.stringify(samples),
        );
        await client.close();
        client = await toolbarClient(context, loader, extensionId);
        await waitForRead(
          () => client.read('document.querySelector("#locationName")?.textContent'),
          (value) => value?.includes(expectedLabel),
          { timeoutMs: 5000 },
        );
        await client.read(`(${watchPopup.toString()})()`);
      }
      if (stale) {
        await waitForRead(stats, (s) => s.completedCatalogs > before.completedCatalogs, {
          timeoutMs: 3000,
        });
        await waitState(
          (s) => s.locationsStatus === "ready",
          "Fresh catalog missing before stale reply",
        );
        await evaluateDisconnectWorker(
          loader,
          extensionId,
          "globalThis.releaseDisconnectCatalog()",
        );
        await client.read("globalThis.staleCatalogReply");
      }
      if (scenario !== "restart-worker")
        await waitForRead(stats, (s) => s.completedDeletes > before.completedDeletes, {
          timeoutMs: 5000,
          message: "Revocation fixture did not finish",
        });
      if (scenario === "failed-catalog")
        await waitState(
          (s) => s.locationsStatus === "error",
          "Catalog failure not observed",
          20000,
        );
      else
        await waitState(
          (s) => s.locationsStatus !== "loading",
          "Post-disconnect catalog did not settle",
        );
      if (scenario === "omitted-after-revocation") {
        await invoke({ type: "refresh_locations" });
        await invoke({ type: "refresh_locations" });
      }
      if (scenario === "server-refusal") {
        const refusal = index % 2 ? "invalid_location" : "server_full";
        await configure({ ...control, refusal });
        await onBeforeConnect(count + index + 2);
        await client.read('document.querySelector("#protectButton").click()');
        await waitState(
          (s) => s.error === refusal && !s.protected,
          "Authoritative server rejection was not displayed",
        );
        await client.read(
          "new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)))",
        );
        await client.read('document.querySelector("#recoveryDisconnectButton").click()');
        await waitState(
          (s) => s.status === "disconnected" && !s.protectionRequested,
          "Stop after server refusal failed",
        );
      }
      await client.read(
        "new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)))",
      );
      const samples = await client.read("globalThis.disconnectWatch.stop()");
      assert(samples.length > 0);
      assert(
        samples.every((sample) => sample.label?.includes(expectedLabel)),
        "Lost label during transition: " + JSON.stringify(samples),
      );
      const bootstrap = await client.read("globalThis.disconnectBootstrap");
      assert.equal(
        bootstrap.bad.length,
        0,
        "A newly opened popup displayed an empty selection: " + JSON.stringify(bootstrap),
      );
      const final = await state();
      assert.equal(final.status, "disconnected");
      assert.equal(final.protectionRequested, false);
      assert.equal(final.trafficBlocked, false);
      assert.equal(final.selectedLocationId, selectedId);
      const after = await stats();
      assert.equal(
        after.posts - before.posts,
        scenario === "server-refusal" ? 1 : 0,
        "Unexpected reconnection after stop",
      );
      assert.equal(await client.read('document.querySelector("#protectButton").disabled'), false);
      const cycle = {
        index: index + 1,
        scenario,
        variation,
        durationMs: Date.now() - started,
        selectedId,
        samples: [...earlierSamples, ...samples],
        bootstrap,
        postsAfterStop: after.posts - before.posts,
      };
      cycles.push(cycle);
      if (index === 0 || (index + 1) % 10 === 0 || index + 1 === count)
        process.stdout.write(`PASS disconnect ${scenario} ${index + 1}/${count}\n`);
      if (index === 0 || index + 1 === count)
        await client.screenshot(join(runRoot, `disconnect-${index + 1}.png`));
    }
    return {
      passed: true,
      attempted,
      completed: cycles.length,
      seed: 20261015,
      scenario,
      selectedId,
      cycles,
    };
  } catch (error) {
    await writeFile(
      join(runRoot, "disconnect-failure.json"),
      JSON.stringify(
        {
          attempted,
          completed: cycles.length,
          scenario,
          failure: String(error.stack ?? error),
          snapshot: await state().catch(() => null),
          samples: await client.read("globalThis.disconnectWatch?.samples").catch(() => null),
          cycles,
        },
        null,
        2,
      ),
    );
    await client.screenshot(join(runRoot, "disconnect-failure.png")).catch(() => undefined);
    throw error;
  }
}
