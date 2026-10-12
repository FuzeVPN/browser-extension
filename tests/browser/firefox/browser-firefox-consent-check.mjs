// SPDX-License-Identifier: MPL-2.0

import assert from "node:assert/strict";
import { mkdir, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

/** Native Firefox consent checks; no browser API or production endpoint is mocked. */
export async function firefoxConsentCheck({
  driver,
  extensionId,
  extensionOrigin,
  output,
  received,
  privileged,
  extension,
  send,
  snapshot,
  openPopup,
  permissions,
  click,
  waitFor,
  record,
  setDiagnosticMode,
  loginViaWeb,
}) {
  const nativePermissions = () =>
    extension("const done=arguments[arguments.length-1]; browser.permissions.getAll().then(done);");
  const diagnostics = () => send({ type: "diagnostics_state" });
  const uploads = () => received.api.filter((request) => request.path === "/v1/diagnostics");
  const downloadPath = join(output, "downloads");
  await mkdir(downloadPath, { recursive: true });

  async function changeNativePermission(allowed) {
    assert.equal(
      await privileged(
        `const done=arguments[arguments.length-1]; const [id,allowed]=arguments;
        (async()=>{const {ExtensionPermissions}=ChromeUtils.importESModule("resource://gre/modules/ExtensionPermissions.sys.mjs");
        const {ExtensionParent}=ChromeUtils.importESModule("resource://gre/modules/ExtensionParent.sys.mjs");
        const addon=ExtensionParent.GlobalManager.getExtension(id);
        await ExtensionPermissions[allowed?"add":"remove"](id,{permissions:[],origins:[],data_collection:["technicalAndInteraction"]},addon);
        done(true);})().catch(e=>done({error:String(e)}));`,
        extensionId,
        allowed,
      ),
      true,
    );
    await waitFor(
      nativePermissions,
      (value) => value.data_collection?.includes("technicalAndInteraction") === allowed,
      "Actual native data-collection permission changed",
    );
  }

  async function answerNativePrompt(accept) {
    const details = await waitFor(
      () =>
        privileged(
          `const done=arguments[arguments.length-1]; const win=Services.wm.getMostRecentWindow("navigator:browser");
          const notification=win.PopupNotifications.getNotification("addon-webext-permissions",win.gBrowser.selectedBrowser);
          const node=win.document.getElementById("addon-webext-permissions-notification");
          done(notification && node && node.button && !node.button.disabled ? {
            id:notification.id, text:node.textContent, primary:node.button.label,
            secondary:node.secondaryButton?.label, shown:win.PopupNotifications.isPanelOpen
          }:null);`,
        ),
      Boolean,
      "Native Firefox optional data-collection prompt",
    );
    assert.equal(details.id, "addon-webext-permissions");
    assert.match(details.text, /technical|interaction|techniques|interactions/i);
    assert.equal(
      await privileged(
        `const done=arguments[arguments.length-1]; const win=Services.wm.getMostRecentWindow("navigator:browser");
        const node=win.document.getElementById("addon-webext-permissions-notification");
        const button=arguments[0]?node.button:node.secondaryButton;
        button.click();done(true);`,
        accept,
      ),
      true,
    );
    return details;
  }

  async function localReport() {
    const created = await send({ type: "diagnostics_run" });
    assert.equal(created.ok, true, JSON.stringify(created));
    assert(created.reportId);
    const state = await waitFor(
      diagnostics,
      (value) => value.state.reports.some((item) => item.id === created.reportId && item.canSend),
      "Local diagnostic report ready",
    );
    return state.state.reports.find((item) => item.id === created.reportId);
  }

  async function openDiagnostics() {
    await driver.get(`${extensionOrigin}/diagnostics-page/diagnostics.html`);
    await waitFor(
      () => driver.executeScript("return document.querySelector('#runButton').disabled"),
      (value) => value === false,
      "Local diagnostics UI ready",
    );
  }

  async function localUiReport() {
    await click("#runButton");
    await waitFor(
      () => driver.executeScript("return document.querySelector('#sendConsent').disabled"),
      (value) => value === false,
      "Local diagnostic UI report ready",
    );
    return driver.executeScript("return document.querySelector('#reportSelect').value");
  }

  const manifest = await driver.executeScript("return browser.runtime.getManifest()");
  const packageInfo = JSON.parse(await readFile(new URL("../../../package.json", import.meta.url)));
  assert.equal(manifest.version, packageInfo.version);
  const declared = manifest.browser_specific_settings.gecko.data_collection_permissions;
  assert.deepEqual(
    [...declared.required].sort(),
    [
      "authenticationInfo",
      "personallyIdentifyingInfo",
      "browsingActivity",
      "websiteContent",
    ].sort(),
  );
  assert.deepEqual(declared.optional, ["technicalAndInteraction"]);
  assert(Array.isArray((await nativePermissions()).data_collection));
  record("Firefox recognizes the declared required and optional data-collection categories");

  assert.equal(await permissions(true), true);
  await openPopup();
  await changeNativePermission(false);
  const login = await loginViaWeb();
  assert.equal(login.ok, true, JSON.stringify(login));
  const connected = await send({ type: "connect", locationId: "local-audit" });
  assert.equal(connected.ok, true, JSON.stringify(connected));
  await send({ type: "refresh_network" });
  const protectedState = await waitFor(
    snapshot,
    (value) => value.protected && value.network.status === "ready",
    "VPN and IP observation without optional diagnostics consent",
  );
  assert.equal(protectedState.network.ip, "9.9.9.9");
  record("Declining optional diagnostics collection leaves VPN and IP observation operational");

  const local = await localReport();
  const rejectedAuto = await send({ type: "diagnostics_set_auto", enabled: true });
  assert.equal(rejectedAuto.ok, false);
  assert.equal(rejectedAuto.error, "data_collection_required");
  const rejectedSend = await send({
    type: "diagnostics_send",
    reportId: local.id,
    consent: true,
    noticeVersion: 1,
  });
  assert.equal(rejectedSend.ok, false);
  assert.equal(rejectedSend.error, "data_collection_required");
  assert.equal(uploads().length, 0);
  record("Absent native permission blocks automatic opt-in and manual uploads before any POST");

  await openDiagnostics();
  const uiReportId = await localUiReport();
  await click("#exportButton");
  const exported = await waitFor(
    () => readdir(downloadPath),
    (files) => files.includes(`fuzevpn-diagnostic-${uiReportId}.json`),
    "Local diagnostic export without native permission",
  );
  const exportedReport = JSON.parse(
    await readFile(
      join(
        downloadPath,
        exported.find((file) => file.endsWith(".json")),
      ),
      "utf8",
    ),
  );
  assert.equal(exportedReport.report_id, uiReportId);
  assert.equal(uploads().length, 0);
  record("Local diagnostic generation and JSON export work without collection permission");

  await click("#sendConsent");
  await click("#sendButton");
  const deniedPrompt = await answerNativePrompt(false);
  await waitFor(
    () => driver.executeScript("return !document.querySelector('#pageError').hidden"),
    Boolean,
    "Manual native consent rejection completes",
  );
  assert(!(await nativePermissions()).data_collection.includes("technicalAndInteraction"));
  assert.equal(uploads().length, 0);
  record(
    "Manual Send opens a native Firefox permission prompt and respects rejection",
    deniedPrompt,
  );

  await click("#sendConsent");
  await click("#sendButton");
  const acceptedPrompt = await answerNativePrompt(true);
  await waitFor(
    nativePermissions,
    (value) => value.data_collection.includes("technicalAndInteraction"),
    "Manual native consent granted",
  );
  await waitFor(
    diagnostics,
    (value) =>
      value.state.reports.some((item) => item.id === uiReportId && item.status === "received"),
    "Consented report accepted by synthetic API",
  );
  assert.equal(uploads().length, 1);
  record(
    "Manual Send accepts native consent and existing report consent before delivery",
    acceptedPrompt,
  );

  await changeNativePermission(false);
  await openPopup();
  await click("#settingsButton");
  await click("#diagnosticsAuto");
  await answerNativePrompt(false);
  await waitFor(
    () =>
      driver.executeScript(
        "return !document.querySelector('#diagnosticsAuto').checked && !document.querySelector('#diagnosticsAuto').disabled",
      ),
    Boolean,
    "Popup native consent rejection restores the switch",
  );
  assert.equal((await diagnostics()).state.autoReporting, false);
  await click("#diagnosticsAuto");
  await answerNativePrompt(true);
  await waitFor(
    diagnostics,
    (value) => value.state.autoReporting,
    "Popup automatic opt-in accepted",
  );
  assert.equal((await send({ type: "diagnostics_set_auto", enabled: false })).ok, true);
  record(
    "Popup automatic diagnostics control requests native consent and handles rejection and approval",
  );

  await changeNativePermission(false);
  await openDiagnostics();
  await click("#autoReporting");
  await answerNativePrompt(false);
  await waitFor(
    diagnostics,
    (value) => !value.state.autoReporting,
    "Automatic native consent rejection preserves opt-out",
  );
  await click("#autoReporting");
  await answerNativePrompt(true);
  await waitFor(
    diagnostics,
    (value) => value.state.autoReporting,
    "Automatic native opt-in accepted",
  );
  assert((await nativePermissions()).data_collection.includes("technicalAndInteraction"));
  assert.equal((await send({ type: "diagnostics_set_auto", enabled: false })).ok, true);
  record(
    "Automatic diagnostics switch requests native consent and preserves separate internal opt-in",
  );

  setDiagnosticMode("hold");
  const heldId = await localUiReport();
  await click("#sendConsent");
  await click("#sendButton");
  const held = await waitFor(
    () => received.diagnostics.find((item) => item.id === heldId),
    Boolean,
    "Consented diagnostic upload is in flight",
  );
  await changeNativePermission(false);
  await waitFor(() => held.aborted, Boolean, "Revocation interrupts in-flight diagnostic POST");
  const suspended = await waitFor(
    diagnostics,
    (value) =>
      value.state.reports.some(
        (item) =>
          item.id === heldId &&
          item.status === "pending" &&
          item.error === "data_collection_required",
      ),
    "Revoked report queue suspended",
  );
  const uploadsAfterRevocation = uploads().length;
  assert.equal(
    await extension(
      `const done=arguments[arguments.length-1]; browser.alarms.create("fuzevpn-diagnostics-delivery",{when:Date.now()+100}).then(()=>done(true));`,
    ),
    true,
  );
  await new Promise((done) => setTimeout(done, 1300));
  assert.equal(uploads().length, uploadsAfterRevocation);
  const after = await snapshot();
  assert.equal(after.protected, true);
  assert.equal(after.activeLocationId, protectedState.activeLocationId);
  assert.equal(after.network.ip, protectedState.network.ip);
  record(
    "Native consent revocation aborts active delivery and blocks alarm retries while VPN stays protected",
    {
      report: suspended.state.reports.find((item) => item.id === heldId),
      uploadsAfterRevocation,
    },
  );

  setDiagnosticMode("success");
  assert.equal((await send({ type: "diagnostics_cancel", reportId: heldId })).ok, true);
  await changeNativePermission(true);
  await new Promise((done) => setTimeout(done, 300));
  assert.equal((await diagnostics()).state.autoReporting, false);
  assert.equal(uploads().length, uploadsAfterRevocation);
  record(
    "Regranting native consent does not recreate a disabled automatic opt-in or cancelled upload",
  );
}
