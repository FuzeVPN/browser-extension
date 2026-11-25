// SPDX-License-Identifier: MPL-2.0

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Native Firefox check of the ad blocker setting, against the real background and a
 * synthetic account API which records the choice. No filtering is exercised.
 * `service` is what that API holds and how it answers; `requests` what it received.
 */
export async function firefoxAdBlockerCheck({
  driver,
  dist,
  service,
  requests,
  send,
  snapshot,
  openPopup,
  click,
  waitFor,
  record,
}) {
  const french = JSON.parse(await readFile(join(dist, "_locales/fr/messages.json"), "utf8"));
  const view = () =>
    driver.executeScript(
      `const at=(id)=>document.getElementById(id); const shown=(node)=>Boolean(node.getClientRects().length);
      const control=at('adBlockingEnabled'); const row=at('adBlockingRow');
      return { language: document.documentElement.lang, row: shown(row), checked: control.checked, disabled: control.disabled,
        busy: control.getAttribute('aria-busy'), note: shown(at('adBlockingNote')) ? at('adBlockingNote').textContent : null,
        label: row.querySelector('.setting-label span').textContent, help: at('adBlockingHelp').textContent,
        aboveKillSwitch: row.nextElementSibling?.contains(at('killSwitchEnabled')) === true,
        banner: shown(at('errorBanner')), wide: document.documentElement.scrollWidth > innerWidth };`,
    );
  const settled = (matches, label) =>
    waitFor(view, (value) => value.busy === "false" && matches(value), label);
  const sent = (from) => requests.slice(from).map(({ method, body }) => body || method);

  await openPopup();
  assert.equal((await send({ type: "set_language_preference", preference: "fr" })).ok, true);
  await waitFor(view, (value) => value.language === "fr", "French popup");
  const before = await snapshot();
  assert(before.profile, "The ad blocker check needs a signed-in account");
  Object.assign(service, { enabled: false, available: true, mode: "normal" });

  let from = requests.length;
  await click("#settingsButton");
  let shown = await settled((value) => !value.disabled, "Choice of the account read");
  assert.deepEqual(sent(from), ["GET"]);
  assert.equal(requests.at(-1).authorized, true);
  assert.equal(shown.row && shown.aboveKillSwitch, true);
  assert.equal(shown.label, french.adBlocker.message);
  assert.equal(shown.help, french.adBlockerHelp.message);
  assert.deepEqual(
    { checked: shown.checked, note: shown.note, wide: shown.wide },
    { checked: false, note: null, wide: false },
  );
  record("Firefox: the ad blocker is read from the account when the settings open");

  from = requests.length;
  await click("#adBlockingEnabled");
  shown = await settled((value) => value.checked, "Choice recorded");
  assert.deepEqual(sent(from), ['{"ad_blocking":true}']);
  assert.equal(requests.at(-1).authorized, true);
  assert.equal(service.enabled, true);
  assert.equal(shown.note, null);
  let state = await snapshot();
  assert.deepEqual(state.adBlocking, { enabled: true, available: true });
  // The connection is left as it was.
  assert.equal(state.protected, before.protected);
  assert.equal(state.status, before.status);
  assert.equal(state.error, before.error);
  record("Firefox: a click records the ad blocker choice and leaves the connection as it was");

  // The service has turned the blocker off for everyone.
  await click("#closeSettingsButton");
  service.available = false;
  await click("#settingsButton");
  shown = await settled((value) => value.note !== null, "Blocker said to be turned off");
  assert.equal(shown.note, french.adBlockerPaused.message);
  assert.equal(shown.disabled, false);
  service.available = true;

  // A refusal of the service is said beside the setting, and nowhere else.
  service.mode = "limited";
  from = requests.length;
  await click("#adBlockingEnabled");
  shown = await settled(
    (value) => value.note === french.adBlockerFailed.message,
    "Refused change said",
  );
  assert.deepEqual(sent(from), ['{"ad_blocking":false}']);
  assert.equal(shown.checked, true);
  assert.equal(shown.banner, false);
  assert.equal(service.enabled, true);
  state = await snapshot();
  assert.equal(state.error, before.error);
  assert.equal(state.protected, before.protected);
  service.mode = "normal";
  await click("#adBlockingEnabled");
  shown = await settled((value) => !value.checked, "Choice recorded again");
  assert.equal(shown.note, null);
  assert.equal(service.enabled, false);
  await click("#closeSettingsButton");
  record(
    "Firefox: a blocker turned off by the service and a refused change are said beside the setting, without an error of the connection",
  );
}
