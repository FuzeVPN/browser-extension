// SPDX-License-Identifier: MPL-2.0

import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { SUPPORTED_LANGUAGES, localeDirectory } from "../../../scripts/supported-locales.mjs";

const rivalId = "proxy-rival@validation.invalid";
/** A browser shows a popup at most this tall. */
const popupHeight = 600;

/**
 * Native Firefox check of a proxy which another extension takes. A second extension is
 * really installed and really sets the proxy of the browser: no browser API is mocked.
 */
export async function firefoxProxyConflictCheck({
  driver,
  dist,
  output,
  privileged,
  send,
  snapshot,
  openPopup,
  permissions,
  click,
  waitFor,
  record,
  loginViaWeb,
}) {
  const catalog = async (language) =>
    JSON.parse(
      await readFile(join(dist, `_locales/${localeDirectory(language)}/messages.json`), "utf8"),
    );
  // A closed disclosure keeps the boxes of its text: only `checkVisibility` tells it hidden.
  // The actions are measured by the block which holds them: a button under the pointer
  // rises by a pixel, and is read midway while it does.
  const view = () =>
    driver.executeScript(
      `const shell=document.querySelector('.shell'); const why=document.getElementById('recoveryWhy');
      const summary=why.querySelector('summary'); const answer=why.querySelector('p');
      const shown=(node)=>Boolean(node.getClientRects().length); const at=(id)=>document.getElementById(id);
      return { language: document.documentElement.lang, panel: shown(at('recoveryPanel')), banner: shown(at('errorBanner')),
        title: at('recoveryStatus').textContent, help: at('recoveryHelp').textContent, retry: at('retryButton').textContent,
        why: shown(why), open: why.open, question: summary.textContent, answer: answer.textContent, answerShown: answer.checkVisibility(),
        fit: shell.dataset.fit ?? '0', height: shell.offsetHeight,
        added: why.getBoundingClientRect().height - summary.getBoundingClientRect().height, actionsTop: at('retryButton').parentElement.getBoundingClientRect().top + scrollY,
        target: summary.getBoundingClientRect().height, wide: document.documentElement.scrollWidth > innerWidth,
        actionsBottom: at('retryButton').parentElement.getBoundingClientRect().bottom + scrollY };`,
    );
  const held = (value) => value.error === "proxy_controlled_by_extension" && !value.protected;

  const login = await loginViaWeb();
  assert.equal(login.ok, true, JSON.stringify(login));
  assert.equal(await permissions(true), true);
  await openPopup();
  const connected = await send({ type: "connect", locationId: "local-audit" });
  assert.equal(connected.ok, true, JSON.stringify(connected));
  assert.equal(connected.snapshot.protected, true);

  const rival = join(output, "proxy-rival");
  await mkdir(rival, { recursive: true });
  await writeFile(
    join(rival, "manifest.json"),
    `${JSON.stringify(
      {
        manifest_version: 2,
        name: "Proxy rival (validation fixture)",
        version: "1.0",
        browser_specific_settings: { gecko: { id: rivalId } },
        permissions: ["proxy"],
        background: { scripts: ["background.js"] },
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(
    join(rival, "background.js"),
    'browser.proxy.settings.set({ value: { proxyType: "none" } }).catch(() => undefined);\n',
  );
  assert.equal(await driver.installAddon(rival, true), rivalId);
  // Firefox lets an extension set the proxy only once it may run in private windows.
  assert.equal(
    await privileged(
      `const done=arguments[arguments.length-1]; const [id]=arguments;
      (async()=>{const {ExtensionPermissions}=ChromeUtils.importESModule("resource://gre/modules/ExtensionPermissions.sys.mjs");
      await ExtensionPermissions.add(id,{permissions:["internal:privateBrowsingAllowed"],origins:[]});
      const {AddonManager}=ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
      const addon=await AddonManager.getAddonByID(id); await addon.reload(); done(true);})().catch(e=>done({error:String(e),stack:e.stack}));`,
      rivalId,
    ),
    true,
  );
  const lost = await waitFor(snapshot, held, "The proxy another extension took is reported", 20000);
  record("Firefox: a proxy which another extension takes is reported as such", {
    status: lost.status,
    blockingScope: lost.blockingScope,
  });

  const measurements = [];
  const scrolling = [];
  const moved = [];
  for (const language of SUPPORTED_LANGUAGES) {
    assert.equal((await send({ type: "set_language_preference", preference: language })).ok, true);
    const texts = await catalog(language);
    const closed = await waitFor(
      view,
      (value) =>
        value.language === language &&
        value.title === texts.proxyConflictTitle.message &&
        !value.open,
      `Warning of ${language}`,
    );
    assert.equal(closed.panel, true);
    assert.equal(
      closed.help,
      texts.proxyConflictHelp.message.replace("$1", texts.retryConnection.message),
    );
    assert.equal(closed.retry, texts.retryConnection.message);
    assert.equal(closed.question, texts.proxyConflictWhy.message);
    assert.equal(closed.why, true);
    assert.equal(closed.answerShown, false);
    // The panel says it, with what to do: the banner would repeat it in fewer words.
    assert.equal(closed.banner, false);
    assert.equal(closed.wide, false, `Horizontal overflow in ${language}`);
    assert(closed.target >= 24, `Small disclosure in ${language}: ${String(closed.target)}`);
    if (closed.height > popupHeight) scrolling.push(`${language}: ${String(closed.height)}`);
    await click("#recoveryWhy summary");
    const opened = await waitFor(
      view,
      (value) => value.open && value.answerShown,
      `Explanation of ${language}`,
    );
    assert.equal(opened.answer, texts.proxyConflictWhyText.message);
    // What the reader opened moves nothing else: the layout is the one fitted without it.
    // The actions are lower by the height of the text, to the fraction of a pixel.
    const shift = opened.actionsTop - closed.actionsTop;
    if (opened.fit !== closed.fit || Math.abs(shift - opened.added) >= 0.5)
      moved.push(
        `${language}: level ${closed.fit} then ${opened.fit}, actions ${String(shift)} px lower for a text of ${String(opened.added)} px`,
      );
    assert(opened.added > 0);
    assert(
      opened.actionsBottom <= popupHeight,
      `The actions leave the popup in ${language}: ${JSON.stringify(opened)}`,
    );
    await click("#recoveryWhy summary");
    await waitFor(view, (value) => !value.open, `Explanation of ${language} closed`);
    measurements.push({ language, level: closed.fit, height: closed.height });
  }
  assert.deepEqual(scrolling, [], "The warning scrolls in some languages");
  assert.deepEqual(moved, [], "Opening the explanation moves the rest in some languages");
  record(
    "Firefox: the warning of a proxy held by another extension fits the popup in seventy languages, and its explanation opens without moving the rest",
    {
      tallest: Math.max(...measurements.map((entry) => entry.height)),
      levels: [...new Set(measurements.map((entry) => entry.level))].sort(),
    },
  );
  assert.equal((await send({ type: "set_language_preference", preference: "fr" })).ok, true);
  await waitFor(view, (value) => value.language === "fr", "French restored");

  // For as long as the other extension holds the proxy, trying again changes nothing.
  let revision = (await snapshot()).snapshotVersion.revision;
  await click("#retryButton");
  await waitFor(
    snapshot,
    (value) => value.snapshotVersion.revision > revision && held(value) && value.status === "error",
    "A retry under the other extension fails the same way",
    20000,
  );
  assert.equal((await view()).panel, true);
  record("Firefox: a retry while the other extension holds the proxy shows the same warning");

  // The other extension gone, the browser gives the proxy back. The warning leaves with
  // the explanation the reader had opened, the traffic stays blocked, and the usual
  // recovery panel offers to try again.
  await click("#recoveryWhy summary");
  await waitFor(view, (value) => value.open, "Explanation opened before the release");
  await driver.uninstallAddon(rivalId);
  const released = await waitFor(
    snapshot,
    (value) => value.error === null && !value.protected,
    "The proxy given back is seen",
    20000,
  );
  assert.equal(released.status, "blocked");
  assert.equal(released.blockingScope, "all");
  const usual = await waitFor(view, (value) => value.panel && !value.why, "Usual recovery panel");
  assert.equal(usual.help, (await catalog("fr")).recoveryHelp.message);
  assert.equal(usual.open, false);
  revision = released.snapshotVersion.revision;
  await click("#retryButton");
  const resumed = await waitFor(
    snapshot,
    (value) => value.status === "connected" && value.protected && value.error === null,
    "Protection resumed once the other extension is gone",
    20000,
  );
  assert(resumed.snapshotVersion.revision > revision);
  const after = await waitFor(view, (value) => !value.panel, "Warning withdrawn");
  assert.equal(after.why, false);
  assert.equal(after.open, false);
  record("Firefox: the other extension removed, the retry of the warning resumes the protection");
}
