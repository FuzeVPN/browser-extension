// SPDX-License-Identifier: MPL-2.0

// Other integration suites isolate proxy/account behavior; the dedicated web-auth suite
// independently exercises the real native window and callback without this fixture.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

async function currentWorker(context) {
  return (
    context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker", { timeout: 15000 }))
  );
}

export async function installSyntheticWebAuth(context) {
  const worker = await currentWorker(context);
  await worker.evaluate(() => {
    globalThis.authFixtureGrants ??= new Map();
    chrome.identity.launchWebAuthFlow = async (details) => {
      const authorization = new URL(details.url);
      if (
        authorization.origin !== "https://app.fuzevpn.com" ||
        authorization.pathname !== "/extension/connect" ||
        details.interactive !== true
      )
        throw new Error("Unexpected synthetic authentication entry point");
      if (authorization.searchParams.get("code_challenge_method") !== "S256")
        throw new Error("PKCE S256 required");
      const redirectUri = authorization.searchParams.get("redirect_uri");
      if (redirectUri !== chrome.identity.getRedirectURL("auth"))
        throw new Error("Unexpected synthetic callback");
      const code = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "");
      globalThis.authFixtureGrants.set(code, {
        clientId: authorization.searchParams.get("client_id"),
        redirectUri,
        challenge: authorization.searchParams.get("code_challenge"),
      });
      const callback = new URL(redirectUri);
      callback.searchParams.set("code", code);
      callback.searchParams.set("state", authorization.searchParams.get("state"));
      return callback.href;
    };
  });
}

export async function assertSyntheticTokenRequest(context, request) {
  assert.equal(request.method(), "POST");
  const body = request.postDataJSON();
  assert.deepEqual(Object.keys(body).sort(), [
    "client_id",
    "code",
    "code_verifier",
    "redirect_uri",
  ]);
  const worker = await currentWorker(context);
  const grant = await worker.evaluate((code) => {
    const result = globalThis.authFixtureGrants?.get(code);
    globalThis.authFixtureGrants?.delete(code);
    return result;
  }, body.code);
  assert(grant, "A synthetic token requires a one-use authorization grant");
  assert.equal(body.client_id, grant.clientId);
  assert.equal(body.redirect_uri, grant.redirectUri);
  assert.equal(
    createHash("sha256").update(body.code_verifier).digest("base64url"),
    grant.challenge,
  );
}
