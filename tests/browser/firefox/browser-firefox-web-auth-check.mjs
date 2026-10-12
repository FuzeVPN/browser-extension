// SPDX-License-Identifier: MPL-2.0

// Native Firefox identity flow against loopback HTTPS fixtures. No browser API is replaced.
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const clientOrigin = "https://app.fuzevpn.com";
const tokenPath = "/v1/auth/extension/token";
const token = "synthetic-firefox-token";
const canonical32 = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;

export function firefoxWebAuthFixture() {
  const attempts = [];
  const secrets = new Set();
  let mode = "success";
  let failure;
  let expectedRedirect;

  function complete(attempt) {
    assert.equal(attempt.completed, false, "A synthetic authorization completes only once");
    attempt.completed = true;
    const callback = new URL(attempt.url.searchParams.get("redirect_uri"));
    callback.searchParams.set("state", attempt.url.searchParams.get("state"));
    if (attempt.mode === "denied") callback.searchParams.set("error", "access_denied");
    else callback.searchParams.set("code", attempt.code);
    if (attempt.mode === "wrong-state")
      callback.searchParams.set("state", randomBytes(32).toString("base64url"));
    if (attempt.mode === "duplicate-code") callback.searchParams.append("code", attempt.code);
    attempt.response.writeHead(302, { Location: callback.href, "Cache-Control": "no-store" });
    attempt.response.end();
  }

  function handleWebRequest(request, response) {
    if (!/^app\.fuzevpn\.com(?::443)?$/.test(request.headers.host || "")) return false;
    const url = new URL(request.url, clientOrigin);
    if (url.pathname !== "/extension/connect") {
      response.writeHead(404).end();
      return true;
    }
    const attempt = {
      mode,
      url,
      response,
      requestMethod: request.method,
      code: randomBytes(32).toString("base64url"),
      completed: false,
      exchanged: false,
    };
    for (const value of [
      attempt.code,
      url.searchParams.get("state"),
      url.searchParams.get("code_challenge"),
    ])
      if (value) secrets.add(value);
    attempts.push(attempt);
    if (mode === "hold") return true;
    if (mode === "cancel") {
      response.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "no-store" });
      response.end(
        "<!doctype html><title>Local FuzeVPN sign-in</title><h1>Isolated authorization fixture</h1><p>No real account or Google provider is contacted.</p>",
      );
      return true;
    }
    complete(attempt);
    return true;
  }

  function exchange(path, method, payload, headers) {
    if (path !== tokenPath) return null;
    try {
      assert.equal(method, "POST");
      assert.deepEqual(Object.keys(payload).sort(), [
        "client_id",
        "code",
        "code_verifier",
        "redirect_uri",
      ]);
      const attempt = attempts.find((candidate) => candidate.code === payload.code);
      assert(attempt, "Code must have been issued by the isolated web authorization fixture");
      assert.equal(attempt.exchanged, false, "Authorization code must be exchanged only once");
      assert.equal(attempt.completed, true);
      assert(canonical32.test(payload.code));
      assert(canonical32.test(payload.code_verifier));
      assert.equal(payload.client_id, "fuzevpn-browser-extension");
      assert.equal(payload.redirect_uri, expectedRedirect);
      assert.equal(
        createHash("sha256").update(payload.code_verifier).digest("base64url"),
        attempt.url.searchParams.get("code_challenge"),
      );
      assert.equal(
        headers.authorization,
        undefined,
        "Token exchange must not reuse an account bearer token",
      );
      secrets.add(payload.code_verifier);
      attempt.exchanged = true;
      return [
        201,
        { access_token: token, expires_at: new Date(Date.now() + 3_600_000).toISOString() },
      ];
    } catch (error) {
      failure = error;
      return [400, { error: "invalid_authorization" }];
    }
  }

  return {
    handleWebRequest,
    exchange,
    complete,
    attempts,
    secrets,
    setMode(value) {
      mode = value;
    },
    setRedirect(value) {
      expectedRedirect = value;
    },
    assertHealthy() {
      if (failure) throw failure;
    },
    redact(value) {
      let result = String(value);
      for (const secret of secrets) result = result.replaceAll(secret, "[redacted]");
      return result;
    },
  };
}

export async function firefoxWebAuthLogin({ driver, fixture, click, snapshot, waitFor }) {
  fixture.setRedirect(await driver.executeScript("return browser.identity.getRedirectURL('auth')"));
  fixture.setMode("success");
  const previous = fixture.attempts.length;
  await waitFor(
    () => driver.executeScript("return document.querySelector('#loginButton').disabled"),
    (value) => value === false,
    "Web sign-in button ready",
  );
  await click("#loginButton");
  await waitFor(
    () => fixture.attempts[previous],
    Boolean,
    "Native Firefox identity reaches the isolated web authorization page",
  );
  const state = await waitFor(
    snapshot,
    (value) => value.profile && !value.webLoginPending,
    "Native Firefox web sign-in completes",
  );
  fixture.assertHealthy();
  return { ok: true, snapshot: state };
}

export async function firefoxWebAuthCheck({
  driver,
  fixture,
  output,
  received,
  extension,
  send,
  snapshot,
  openPopup,
  permissions,
  click,
  waitFor,
  record,
  navigate,
  protectedUrl,
}) {
  const manifest = await driver.executeScript("return browser.runtime.getManifest()");
  const packageInfo = JSON.parse(await readFile(new URL("../../../package.json", import.meta.url)));
  assert.equal(manifest.version, packageInfo.version);
  assert(manifest.permissions.includes("identity"));
  const redirectUri = await driver.executeScript("return browser.identity.getRedirectURL('auth')");
  const redirect = new URL(redirectUri);
  assert.equal(redirect.protocol, "https:");
  assert.match(redirect.hostname, /^[a-z0-9-]+\.extensions\.(?:allizom\.org|mozilla\.org)$/);
  assert.equal(redirect.pathname, "/auth");
  fixture.setRedirect(redirectUri);
  record("Native Firefox identity provides the stable extension callback", {
    extensionId: manifest.browser_specific_settings.gecko.id,
    redirectUri,
  });

  const tokenCount = () => received.api.filter(({ path }) => path === tokenPath).length;
  const settled = () =>
    waitFor(snapshot, (value) => value && !value.webLoginPending, "Native web sign-in settles");
  const windows = () =>
    extension("browser.windows.getAll().then(v=>arguments[arguments.length-1](v.map(w=>w.id)));");

  async function start(mode, locale = "fr") {
    fixture.setMode(mode);
    const previous = fixture.attempts.length;
    await waitFor(
      () => driver.executeScript("return document.querySelector('#loginButton').disabled"),
      (value) => value === false,
      "Web sign-in button ready",
    );
    await click("#loginButton");
    const attempt = await waitFor(
      () => fixture.attempts[previous],
      Boolean,
      "Native identity reaches loopback authorization endpoint",
    );
    assert.equal(attempt.requestMethod, "GET");
    assert.equal(attempt.url.origin + attempt.url.pathname, clientOrigin + "/extension/connect");
    const query = attempt.url.searchParams;
    assert.deepEqual([...query.keys()].sort(), [
      "client_id",
      "code_challenge",
      "code_challenge_method",
      "locale",
      "redirect_uri",
      "state",
    ]);
    assert.equal(query.get("client_id"), "fuzevpn-browser-extension");
    assert.equal(query.get("redirect_uri"), redirectUri);
    assert.equal(query.get("code_challenge_method"), "S256");
    assert(canonical32.test(query.get("state")));
    assert(canonical32.test(query.get("code_challenge")));
    assert.equal(query.get("locale"), locale);
    return attempt;
  }

  async function flowSecretsAbsent() {
    const stored = await extension(
      "Promise.all([browser.storage.local.get(null),browser.storage.session.get(null)]).then(arguments[arguments.length-1]);",
    );
    const encoded = JSON.stringify(stored);
    for (const secret of fixture.secrets)
      assert(
        !encoded.includes(secret),
        "PKCE verifier, authorization state or one-use code persisted",
      );
    assert(!/code_verifier|client_secret|code_challenge/.test(encoded));
    assert.equal(
      await driver.executeScript(
        "return document.querySelectorAll('input[type=email],input[type=password]').length",
      ),
      0,
    );
    assert.equal(received.api.filter(({ path }) => path === "/v1/auth/login").length, 0);
    fixture.assertHealthy();
  }

  async function capture(name) {
    await driver.executeAsyncScript(
      "const done=arguments[arguments.length-1]; document.fonts.ready.then(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))).then(()=>done(true));",
    );
    await writeFile(
      join(output, `${name}.png`),
      Buffer.from(await driver.takeFullPageScreenshot(), "base64"),
    );
  }

  for (const language of ["fr", "ar"]) {
    assert.equal((await send({ type: "set_language_preference", preference: language })).ok, true);
    await waitFor(
      () => driver.executeScript("return document.documentElement.lang"),
      (value) => value === language,
      "Web sign-in language applied",
    );
    const layout = await driver.executeScript(
      "return {lang:document.documentElement.lang,dir:document.documentElement.dir,width:innerWidth,scrollWidth:document.documentElement.scrollWidth,button:document.querySelector('#loginButton').innerText,fields:document.querySelectorAll('input[type=email],input[type=password]').length,visible:document.querySelector('#loginView').getClientRects().length>0}",
    );
    assert.equal(layout.dir, language === "ar" ? "rtl" : "ltr");
    assert.equal(layout.fields, 0);
    assert.equal(layout.visible, true);
    assert(layout.scrollWidth <= layout.width);
    assert(layout.button.trim());
    await capture(`web-sign-in-${language}`);
    record(`Centralized sign-in interface in ${language} has no account credential fields`, layout);
  }
  await send({ type: "set_language_preference", preference: "fr" });
  await flowSecretsAbsent();

  const before = tokenCount();
  await start("success");
  const signedIn = await settled();
  assert.equal(signedIn.profile?.userId, "firefox-audit");
  assert.equal(signedIn.subscription?.hasAccess, true);
  assert(signedIn.locations.some((location) => location.id === "local-audit"));
  assert.equal(signedIn.status, "disconnected");
  assert.equal(tokenCount(), before + 1);
  await flowSecretsAbsent();
  record(
    "Native Firefox authorization exchanges one code with matching PKCE S256 proof and hydrates the account",
    { tokenExchanges: 1, stateBytes: 32, verifierBytes: 32, redirectUri },
  );

  assert.equal(await permissions(true), true);
  await openPopup();
  assert.equal((await snapshot()).profile?.userId, "firefox-audit");
  record("Web-authenticated account is restored after the Firefox background is reloaded");
  const connected = await send({ type: "connect", locationId: "local-audit" });
  assert.equal(connected.ok, true, JSON.stringify(connected));
  await send({ type: "refresh_network" });
  const protectedState = await waitFor(
    snapshot,
    (value) => value.protected && value.network.status === "ready",
    "Authenticated proxy and protected IP observation ready",
  );
  assert.equal(protectedState.network.ip, "9.9.9.9");
  assert.equal((await navigate(`${protectedUrl}/web-auth-protected`)).title, "Proxied fixture");
  await openPopup();
  assert(!received.direct.includes("/web-auth-protected"));
  const privacy = await extension(
    "Promise.all([browser.privacy.network.webRTCIPHandlingPolicy.get({}),browser.privacy.network.networkPredictionEnabled.get({})]).then(arguments[arguments.length-1]);",
  );
  assert.equal(privacy[0].value, "disable_non_proxied_udp");
  assert.equal(privacy[1].value, false);
  record(
    "Web sign-in retains authenticated Firefox proxy routing, protected IP observation and WebRTC policy",
  );

  const report = await send({ type: "diagnostics_run" });
  assert.equal(report.ok, true, JSON.stringify(report));
  await waitFor(
    () => send({ type: "diagnostics_state" }),
    (value) => value.state?.reports.some((item) => item.id === report.reportId && item.canSend),
    "Local diagnostics remain available after web sign-in",
  );
  const nativeData = await extension(
    "browser.permissions.getAll().then(arguments[arguments.length-1]);",
  );
  assert(!nativeData.data_collection.includes("technicalAndInteraction"));
  const uploadsBefore = received.diagnostics.length;
  assert.equal(
    (await send({ type: "diagnostics_set_auto", enabled: true })).error,
    "data_collection_required",
  );
  assert.equal(received.diagnostics.length, uploadsBefore);
  record(
    "Web authentication preserves local diagnostics and requires native permission before diagnostic uploads",
  );

  assert.equal((await send({ type: "logout" })).ok, true);
  assert.equal((await snapshot()).profile, null);
  const afterLogout = await extension(
    "Promise.all([browser.proxy.settings.get({}),browser.privacy.network.webRTCIPHandlingPolicy.get({}),browser.privacy.network.networkPredictionEnabled.get({})]).then(arguments[arguments.length-1]);",
  );
  assert.notEqual(afterLogout[0].levelOfControl, "controlled_by_this_extension");
  assert.notEqual(afterLogout[1].levelOfControl, "controlled_by_this_extension");
  assert.notEqual(afterLogout[2].levelOfControl, "controlled_by_this_extension");
  record("Logout releases Firefox proxy and privacy settings after web authentication");

  for (const [scenario, error] of [
    ["denied", "web_login_denied"],
    ["wrong-state", "web_login_invalid_callback"],
    ["duplicate-code", "web_login_invalid_callback"],
  ]) {
    const count = tokenCount();
    await start(scenario);
    const rejected = await settled();
    assert.equal(rejected.profile, null);
    assert.equal(rejected.error, error);
    assert.equal(tokenCount(), count);
    await flowSecretsAbsent();
    await capture(`web-sign-in-${scenario}`);
    record(`Native ${scenario} callback does not create a session or exchange a code`);
  }

  const beforeWindows = await windows();
  const countBeforeCancel = tokenCount();
  await start("cancel");
  const nativeWindows = await waitFor(
    windows,
    (ids) => ids.some((id) => !beforeWindows.includes(id)),
    "Native authentication window ready for cancellation",
  );
  const nativeId = nativeWindows.find((id) => !beforeWindows.includes(id));
  await extension(
    "browser.windows.remove(arguments[0]).then(()=>arguments[arguments.length-1](true));",
    nativeId,
  );
  const cancelled = await settled();
  assert.equal(cancelled.profile, null);
  assert.equal(cancelled.error, "web_login_cancelled");
  assert.equal(tokenCount(), countBeforeCancel);
  await flowSecretsAbsent();
  record("Closing the real Firefox identity window cancels sign-in without a session");

  const countBeforeLate = tokenCount();
  const lateWindows = await windows();
  const held = await start("hold");
  assert.equal((await snapshot()).webLoginPending, true);
  const attemptsBeforeConcurrent = fixture.attempts.length;
  const concurrent = await send({ type: "web_login", disconnectFirst: false });
  assert.equal(concurrent.ok, false);
  assert.equal(concurrent.commandError, "web_login_busy");
  assert.equal(fixture.attempts.length, attemptsBeforeConcurrent);
  record("Concurrent sign-in does not launch a second native authorization flow");
  assert.equal((await send({ type: "logout" })).ok, true);
  fixture.complete(held);
  await waitFor(
    windows,
    (ids) => ids.every((id) => lateWindows.includes(id)),
    "Late native callback window closes",
  );
  const late = await settled();
  assert.equal(late.profile, null);
  assert.equal(tokenCount(), countBeforeLate);
  await flowSecretsAbsent();
  record("Logout invalidates a pending native flow and discards its later valid code");
  await start("success");
  assert.equal((await settled()).profile?.userId, "firefox-audit");
  await flowSecretsAbsent();
  assert.equal((await send({ type: "logout" })).ok, true);
  record("A new native sign-in succeeds after the invalidated flow has settled");
}
