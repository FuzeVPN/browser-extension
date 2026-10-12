// SPDX-License-Identifier: MPL-2.0

import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { By, Key } from "selenium-webdriver";

const languages = ["fr", "en", "de", "ar"];

export function firefoxDesignReview({
  getDriver,
  output,
  report,
  record,
  openPopup,
  send,
  snapshot,
  click: nativeClick,
  waitFor,
  extensionOrigin,
  setLocationsMode,
  rejectNextSession,
}) {
  report.design = { languages, captures: [], measurements: [] };
  async function resize(width, height) {
    const driver = getDriver();
    await driver.manage().window().setRect({ width, height });
    // Firefox's outer window has a minimum width. Resize the native browser
    // host to exercise a real 360px content viewport without modifying the page.
    await driver.setContext("chrome");
    try {
      await driver.executeScript(
        `const host=gBrowser.selectedBrowser;
        for(const property of ['width','min-width','max-width']) host.style.setProperty(property, arguments[0]+'px', 'important');`,
        width,
      );
    } finally {
      await driver.setContext("content");
    }
  }
  const click = async (selector) => {
    const elements = await getDriver().findElements(By.css(selector));
    if (elements[0])
      await getDriver().executeScript(
        "arguments[0].scrollIntoView({block:'center',inline:'nearest',behavior:'instant'})",
        elements[0],
      );
    await nativeClick(selector);
  };
  const visible = (selector) =>
    getDriver().executeScript(
      "return Boolean(document.querySelector(arguments[0])?.getClientRects().length)",
      selector,
    );

  async function capture(language, state, { text = [], primary = [], inView = [] } = {}) {
    const driver = getDriver();
    await driver.executeAsyncScript(`const done=arguments[arguments.length-1];
      (async()=>{await document.fonts.ready; await Promise.allSettled(document.getAnimations().filter(a=>a.effect?.getTiming().iterations!==Infinity).map(a=>a.finished)); window.scrollTo(0,0); await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))); done(true)})().catch(e=>done(String(e)));`);
    const measurement = await driver.executeScript(
      function ({ text, primary, inView }) {
        const visible = (node) => node.getClientRects().length > 0;
        const nodes = (selectors) =>
          selectors.flatMap((selector) =>
            [...document.querySelectorAll(selector)]
              .filter(visible)
              .map((node) => ({ selector, node })),
          );
        const rgba = (value) => value.match(/[\d.]+/g)?.map(Number) ?? [];
        const background = (node) => {
          for (let current = node; current; current = current.parentElement) {
            const value = getComputedStyle(current).backgroundColor;
            if ((rgba(value)[3] ?? 1) >= 0.99) return value;
          }
          return "rgb(255, 255, 255)";
        };
        const luminance = (color) => {
          const rgb = rgba(color)
            .slice(0, 3)
            .map((value) => {
              const channel = value / 255;
              return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
            });
          return 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
        };
        const box = (node) => {
          const r = node.getBoundingClientRect();
          return {
            width: r.width,
            height: r.height,
            left: r.left,
            right: r.right,
            top: r.top,
            bottom: r.bottom,
          };
        };
        const root = getComputedStyle(document.documentElement);
        return {
          language: document.documentElement.lang,
          direction: document.documentElement.dir,
          viewport: { width: innerWidth, height: innerHeight },
          body: box(document.body),
          horizontalOverflow: document.documentElement.scrollWidth - innerWidth,
          palette: ["--ink", "--paper", stateIsDiagnostic() ? "--gold" : "--signal"].map((name) =>
            root.getPropertyValue(name).trim(),
          ),
          fontFamily: root.fontFamily,
          fonts: [...document.fonts].map((font) => ({ family: font.family, status: font.status })),
          fontSources: [...document.styleSheets]
            .flatMap((sheet) => [...sheet.cssRules])
            .filter((rule) => rule.type === CSSRule.FONT_FACE_RULE)
            .map((rule) => rule.style.getPropertyValue("src")),
          fontRequests: performance
            .getEntriesByType("resource")
            .filter((entry) => /\.woff2(?:$|\?)/.test(entry.name))
            .map((entry) => entry.name),
          missingImages: [...document.images]
            .filter(visible)
            .filter((node) => !node.complete || node.naturalWidth === 0)
            .map((node) => node.src),
          text: nodes(text)
            .filter(({ node }) => !node.matches(":disabled") && node.textContent.trim())
            .map(({ selector, node }) => {
              const style = getComputedStyle(node);
              const a = luminance(style.color);
              const b = luminance(background(node));
              const size = Number.parseFloat(style.fontSize);
              return {
                selector,
                contrast: (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05),
                required:
                  size >= 24 || (size >= 18.66 && Number.parseInt(style.fontWeight) >= 700)
                    ? 3
                    : 4.5,
              };
            }),
          primary: nodes(primary).map(({ selector, node }) => ({ selector, ...box(node) })),
          inView: nodes(inView).map(({ selector, node }) => ({ selector, ...box(node) })),
        };
        function stateIsDiagnostic() {
          return location.pathname.includes("diagnostics-page");
        }
      },
      { text, primary, inView },
    );
    assert.equal(measurement.language, language);
    assert.equal(measurement.direction, language === "ar" ? "rtl" : "ltr");
    assert(measurement.horizontalOverflow <= 1, JSON.stringify(measurement));
    assert.deepEqual(measurement.palette, ["#101820", "#f3efe6", "#f4c95d"]);
    assert(measurement.fontFamily.includes("Archivo"));
    assert(
      measurement.fonts.some((font) => /Archivo/.test(font.family) && font.status === "loaded"),
    );
    assert(
      measurement.fontSources.some((source) =>
        source.includes("/brand/fonts/archivo-latin-vf.woff2"),
      ),
    );
    assert(measurement.fontRequests.every((url) => url.startsWith(`${extensionOrigin}/`)));
    assert.deepEqual(measurement.missingImages, []);
    for (const item of measurement.text)
      assert(item.contrast >= item.required, `${state}: ${JSON.stringify(item)}`);
    for (const item of measurement.primary)
      assert(item.width >= 44 && item.height >= 44, `${state}: ${JSON.stringify(item)}`);
    for (const item of measurement.inView)
      assert(
        item.top >= -1 &&
          item.bottom <= 601 &&
          item.left >= measurement.body.left - 1 &&
          item.right <= measurement.body.right + 1,
        `${state}: ${JSON.stringify(item)}`,
      );
    const filename = `design-${language}-${state}.png`;
    await writeFile(
      join(output, filename),
      Buffer.from(await driver.takeFullPageScreenshot(), "base64"),
    );
    report.design.captures.push({ language, state, filename });
    report.design.measurements.push({ language, state, ...measurement });
  }

  async function loggedOut(language) {
    if (!languages.includes(language)) return;
    await resize(360, 685);
    await capture(language, "login", {
      text: [
        "#loginView h1",
        "#loginView .muted",
        "#loginView .field span",
        "#loginButton",
        "#loginView a",
      ],
      primary: ["#loginButton"],
      inView: ["fr", "en"].includes(language) ? ["#loginButton"] : [],
    });
    await resize(520, 900);
  }

  async function connected() {
    const driver = getDriver();
    const main = {
      text: [
        "#statusLabel",
        "#statusDetail",
        "#mainView .card-label",
        "#mainView .card-value",
        "#publicIp",
        "#subscriptionExpiry",
        "#protectButton",
        "#changeLocationButton",
      ],
      primary: ["#protectButton"],
    };
    for (const language of languages) {
      await resize(360, 685);
      await openPopup();
      assert.equal(
        (await send({ type: "set_language_preference", preference: language })).ok,
        true,
      );
      await waitFor(
        () => driver.executeScript("return document.documentElement.lang"),
        (value) => value === language,
        "Design language",
      );
      await capture(language, "connected", {
        ...main,
        inView: ["fr", "en"].includes(language) ? ["#protectButton"] : [],
      });
      assert.equal((await send({ type: "disconnect" })).ok, true);
      await capture(language, "disconnected", main);
      rejectNextSession({ code: "network_error", status: 503 });
      const failed = await send({ type: "connect", locationId: "local-audit" });
      assert.equal(failed.ok, false);
      await waitFor(() => visible("#recoveryPanel"), Boolean, "Recovery design state");
      await capture(language, "recovery", {
        text: ["#recoveryPanel p", "#errorMessage", "#retryButton", "#recoveryDisconnectButton"],
        primary: ["#retryButton", "#recoveryDisconnectButton"],
      });
      // A generic HTTP 503 is deliberately ambiguous after a proxy POST. A
      // confirmed account logout clears that fixture's pending remote outcome.
      assert.equal((await send({ type: "logout" })).ok, true);
      assert.equal(
        (await send({ type: "login", email: "audit@example.invalid", password: "synthetic-only" }))
          .ok,
        true,
      );
      assert.equal((await send({ type: "connect", locationId: "local-audit" })).ok, true);
      await click("#settingsButton");
      const select = await driver.findElement(By.css("#languageSelect"));
      await driver.executeScript("arguments[0].focus()", select);
      await select.sendKeys(Key.TAB);
      const focus = await driver.executeScript(
        "const node=document.activeElement;const style=getComputedStyle(node); return {visible:node.matches(':focus-visible'),outlineStyle:style.outlineStyle,outlineWidth:parseFloat(style.outlineWidth)}",
      );
      assert(
        focus.visible && focus.outlineStyle !== "none" && focus.outlineWidth >= 2,
        JSON.stringify(focus),
      );
      report.design.measurements.push({ language, state: "keyboard-focus", focus });
      await capture(language, "settings", {
        text: ["#settingsTitle", "#settingsPanel .settings-section-title", "#settingsPanel .muted"],
      });
      await click("#manageDevicesButton");
      await waitFor(() => visible(".delete-device-button"), Boolean, "Design device list");
      await capture(language, "devices", {
        text: [
          "#devicesTitle",
          ".device-name",
          ".device-meta",
          ".device-current",
          ".delete-device-button",
        ],
      });
      await click('.delete-device-button[data-focus-key="remote-device"]');
      await capture(language, "device-confirmation", {
        text: ["#confirmationMessage"],
        primary: ["#confirmationCancelButton", "#confirmationAcceptButton"],
      });
      await click("#confirmationCancelButton");
      await click("#closeDevicesButton");
      await click("#manageExclusionsButton");
      await capture(language, "exclusions", {
        text: [
          "#exclusionsDialog h2",
          "#exclusionsDialog .muted",
          ".exclusion-help",
          ".exclusion-state",
        ],
      });
      await click("#closeExclusionsButton");
      await click("#closeSettingsButton");
      setLocationsMode("grouped");
      assert.equal((await send({ type: "refresh_locations" })).ok, true);
      assert.equal(
        (await send({ type: "set_location_favorite", locationId: "local-audit", favorite: true }))
          .ok,
        true,
      );
      await click("#changeLocationButton");
      const selector = {
        text: [
          "#locationDialogTitle",
          ".option-title",
          ".option-country",
          "#locationHierarchyHelp",
          ".location-filters button",
        ],
      };
      await capture(language, "locations", selector);
      await click("#favoriteLocationsFilter");
      await capture(language, "favorites", selector);
      await click("#allLocationsFilter");
      const search = await driver.findElement(By.css("#locationSearch"));
      await search.sendKeys("No matching destination");
      await capture(language, "locations-search-empty", { text: ["#locationEmpty"] });
      await search.clear();
      await search.sendKeys(" ", Key.BACK_SPACE);
      setLocationsMode("empty");
      assert.equal((await send({ type: "refresh_locations" })).ok, true);
      await capture(language, "locations-catalog-empty", { text: ["#locationEmpty"] });
      await click("#closeLocationButton");
      setLocationsMode("normal");
      assert.equal((await send({ type: "refresh_locations" })).ok, true);
      assert.equal(
        (await send({ type: "set_location_favorite", locationId: "local-audit", favorite: false }))
          .ok,
        true,
      );
      assert.equal((await snapshot()).protected, true);
      await resize(1360, 1000);
      await driver.get(`${extensionOrigin}/diagnostics-page/diagnostics.html`);
      await waitFor(
        () => driver.executeScript("return document.documentElement.lang"),
        (value) => value === language,
        "Diagnostic design language",
      );
      await capture(language, "diagnostics-desktop", {
        text: ["h1", "h2", ".intro", ".privacy-note"],
      });
      await resize(360, 685);
      await capture(language, "diagnostics-narrow", { text: ["h1", "h2"] });
      record(
        `${language}: Firefox design covers all screens with local Archivo, FuzeVPN palette, contrast, keyboard focus and no horizontal overflow`,
      );
    }
    await resize(520, 900);
    await openPopup();
    await send({ type: "set_language_preference", preference: "fr" });
    const cards = report.design.captures
      .map(
        ({ language, state, filename }) =>
          `<figure data-language="${language}"><figcaption>${language.toUpperCase()} — ${state}</figcaption><a href="${filename}"><img src="${filename}" alt="${language} ${state}" loading="lazy"></a></figure>`,
      )
      .join("\n");
    await writeFile(
      join(output, "APERCU.html"),
      `<!doctype html><html lang="fr"><meta charset="utf-8"><title>FuzeVPN Firefox 0.7.0 — aperçu</title><style>body{font:16px system-ui;margin:32px;background:#f3efe6;color:#101820}select{font:inherit;padding:8px}main{display:flex;flex-wrap:wrap;gap:24px}figure{margin:24px 0;width:520px}figcaption{padding:12px 0;font-weight:700}img{max-width:100%;height:auto;border:1px solid #d1c9bd}figure[hidden]{display:none}</style><h1>FuzeVPN Firefox 0.7.0</h1><p>Captures du véritable module Firefox, profil isolé et services locaux de démonstration.</p><label>Langue <select id="language">${languages.map((language) => `<option value="${language}">${language.toUpperCase()}</option>`).join("")}</select></label><main>${cards}</main><script>const select=document.querySelector('select');function filter(){document.querySelectorAll('figure').forEach(e=>e.hidden=e.dataset.language!==select.value)}select.addEventListener('change',filter);filter()</script></html>`,
      "utf8",
    );
  }

  return { loggedOut, connected };
}
