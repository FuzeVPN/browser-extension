// SPDX-License-Identifier: MPL-2.0

import type { ProxySession } from "../../src/core/api/types";
import { AppController } from "../../src/core/background/state-machine";
import { ALARM_REFRESH } from "../../src/core/shared/config";
import { authenticatedState, createHarness, NOW, proxySession } from "./helpers";

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function tlsFailure(h: ReturnType<typeof createHarness>, session: ProxySession) {
  // No observed departure: the failure cannot be proven historical.
  return h.controller.handleProxyError("proxy_tls_error", false, {
    host: session.host,
    port: session.port,
  });
}

async function settle() {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

/** Pauses after the proxy route of the next applied session is installed. */
function pauseAfterApply(h: ReturnType<typeof createHarness>) {
  const installed = deferred();
  const release = deferred();
  const apply = h.proxy.apply.bind(h.proxy);
  vi.spyOn(h.proxy, "apply").mockImplementationOnce(async (session) => {
    await apply(session);
    installed.resolve();
    await release.promise;
  });
  return { installed: installed.promise, release: release.resolve };
}

/** Holds the route verification of the next proxy error until released. */
function pauseNextRouteRead(h: ReturnType<typeof createHarness>) {
  const read = deferred();
  const release = deferred();
  const configured = h.proxy.isActiveConfiguration.bind(h.proxy);
  vi.spyOn(h.proxy, "isActiveConfiguration").mockImplementationOnce(async (session) => {
    read.resolve();
    await release.promise;
    return configured(session);
  });
  return { read: read.promise, release: release.resolve };
}

/** Holds the first transient read after a new allowance: authorization has returned. */
function pauseAfterAuthorization(h: ReturnType<typeof createHarness>) {
  const reached = deferred();
  const release = deferred();
  const events = h.safety.events.length;
  const read = h.storage.readTransient.bind(h.storage);
  let armed = true;
  vi.spyOn(h.storage, "readTransient").mockImplementation(async () => {
    if (armed && h.safety.events.slice(events).includes("allow")) {
      armed = false;
      reached.resolve();
      await release.promise;
    }
    return read();
  });
  return { reached: reached.promise, release: release.resolve };
}

/** Firefox PAC routes carry only the endpoint, so a predecessor there also matches. */
function matchEndpointOnly(h: ReturnType<typeof createHarness>) {
  vi.spyOn(h.proxy, "isActiveConfiguration").mockImplementation(
    async (session) =>
      h.proxy.level === "controlled_by_this_extension" &&
      h.proxy.active?.host === session.host &&
      h.proxy.active.port === session.port,
  );
}

describe("reaudit ultra: a current TLS refusal during session installation", () => {
  afterEach(() => vi.restoreAllMocks());

  it("withdraws credentials synchronously and never authorizes a connecting session", async () => {
    const h = createHarness({ persisted: authenticatedState() });
    await h.controller.initialize();
    const session = proxySession("tls-during-connect");
    h.api.sessions = [session];
    const pause = pauseAfterApply(h);
    const connecting = h.controller.connect(session.locationId);
    await pause.installed;
    expect(h.controller.isSessionCurrentForProxyAuth(session)).toBe(true);
    const snapshots = h.snapshots.length;
    const events = h.safety.events.length;

    const handling = tlsFailure(h, session);
    expect(h.controller.isSessionCurrentForProxyAuth(session)).toBe(false);
    pause.release();

    expect(await connecting).toEqual({ ok: false, commandError: "proxy_unavailable" });
    await handling;
    expect(h.safety.events.slice(events)).not.toContain("allow");
    expect(h.snapshots.slice(snapshots).some((snapshot) => snapshot.protected)).toBe(false);
    expect(h.controller.getSnapshot()).toMatchObject({
      protected: false,
      error: "proxy_unavailable",
    });
  });

  it.each([
    ["session", true],
    ["endpoint", true],
    ["endpoint", false],
  ] as const)(
    "never authorizes a refreshed session or its predecessor (match by %s, route read %s)",
    async (route, errorRouteRead) => {
      const h = createHarness({ persisted: authenticatedState() });
      await h.controller.connect("frankfurt-01");
      const predecessor = h.proxy.active!;
      if (route === "endpoint") matchEndpointOnly(h);
      const session = proxySession("tls-during-refresh");
      expect(session).toMatchObject({ host: predecessor.host, port: predecessor.port });
      h.api.sessions = [session];
      const pause = pauseAfterApply(h);
      const refreshing = h.controller.retryConnection();
      await pause.installed;
      const snapshots = h.snapshots.length;
      const events = h.safety.events.length;

      const handling = tlsFailure(h, session);
      expect(h.controller.isSessionCurrentForProxyAuth(session)).toBe(false);
      // An unreadable route leaves the refused session to the refresh fallback.
      if (!errorRouteRead) vi.mocked(h.proxy.isActiveConfiguration).mockResolvedValueOnce(false);
      pause.release();

      expect(await refreshing).toEqual({ ok: false, commandError: "proxy_unavailable" });
      await handling;
      expect(h.safety.events.slice(events)).not.toContain("allow");
      expect(h.snapshots.slice(snapshots).some((snapshot) => snapshot.protected)).toBe(false);
      expect(h.controller.getSnapshot()).toMatchObject({
        protected: false,
        error: "proxy_unavailable",
      });
    },
  );

  it("does not carry a refusal over to a new session at the same endpoint", async () => {
    const h = createHarness({ persisted: authenticatedState() });
    await h.controller.connect("frankfurt-01");
    await tlsFailure(h, h.proxy.active!);
    expect(h.controller.getSnapshot()).toMatchObject({ protected: false });

    const next = proxySession("after-tls-refusal");
    h.api.sessions = [next];
    expect(await h.controller.connect(next.locationId)).toEqual({ ok: true });
    expect(h.controller.getSnapshot()).toMatchObject({ protected: true, error: null });
    expect(h.controller.isSessionCurrentForProxyAuth(next)).toBe(true);
  });
});

describe("reaudit ultra: a current TLS refusal across an operation keeping its session", () => {
  afterEach(() => vi.restoreAllMocks());

  it.each([false, true])(
    "reselecting the same location keeps the refusal (automatic resolver %s)",
    async (automatic) => {
      const h = createHarness({ persisted: authenticatedState() });
      if (automatic)
        // Production always supplies this resolver, even when automatic mode is off.
        h.controller = new AppController({
          api: h.api,
          storage: h.storage,
          identity: h.identity,
          proxy: h.proxy,
          alarms: h.alarms,
          safety: h.safety,
          securityStorage: h.securityStorage,
          now: () => NOW,
          onStateChanged: (snapshot) => h.snapshots.push(snapshot),
          resolveAutomaticLocation: async () => undefined,
        });
      await h.controller.connect("frankfurt-01");
      await h.controller.refreshAccount();
      const session = h.proxy.active!;
      const route = pauseNextRouteRead(h);
      const snapshots = h.snapshots.length;
      const handling = tlsFailure(h, session);
      await route.read;

      // The new operation supersedes the pending route verification of the error.
      const selecting = h.controller.changeLocation(session.locationId);
      await settle();
      route.release();

      expect(await selecting).toEqual({ ok: false, commandError: "proxy_unavailable" });
      await handling;
      expect(h.snapshots.slice(snapshots).some((snapshot) => snapshot.protected)).toBe(false);
      expect(h.controller.isSessionCurrentForProxyAuth(session)).toBe(false);
      expect(h.controller.getSnapshot()).toMatchObject({
        protected: false,
        error: "proxy_unavailable",
      });
    },
  );

  it("a renewal replaces a refused session without first publishing it as protected", async () => {
    const h = createHarness({ persisted: authenticatedState() });
    await h.controller.connect("frankfurt-01");
    await h.controller.refreshAccount();
    const refused = h.proxy.active!;
    const route = pauseNextRouteRead(h);
    const snapshots = h.snapshots.length;
    const handling = tlsFailure(h, refused);
    await route.read;
    const renewed = proxySession("renewed-after-tls-refusal");
    h.api.sessions = [renewed];

    const refreshing = h.controller.handleAlarm(ALARM_REFRESH);
    await settle();
    expect(h.snapshots.slice(snapshots)).toContainEqual(
      expect.objectContaining({ status: "refreshing", protected: false }),
    );
    route.release();
    await refreshing;
    await handling;

    // Credentials obtained after the refusal are a new session, not a repair of the old one.
    expect(h.controller.isSessionCurrentForProxyAuth(refused)).toBe(false);
    expect(h.controller.isSessionCurrentForProxyAuth(renewed)).toBe(true);
    expect(h.controller.getSnapshot()).toMatchObject({ protected: true, error: null });
  });
});

describe("reaudit ultra: a current TLS refusal after a retained session is reauthorized", () => {
  afterEach(() => vi.restoreAllMocks());

  it.each([
    [
      "a proxy permission change",
      (h: ReturnType<typeof createHarness>) => h.controller.handleProxyPermissionsChanged(),
      undefined,
    ],
    [
      "a security preference update",
      (h: ReturnType<typeof createHarness>) => h.controller.updateSecurityPreferences(true, true),
      { ok: false, commandError: "proxy_unavailable" },
    ],
    [
      "a proxy control restoration",
      (h: ReturnType<typeof createHarness>) => {
        // Another extension replaced the route: restoration reinstalls the same session.
        h.proxy.active = null;
        return h.controller.handleProxyControlLost("controllable_by_this_extension");
      },
      undefined,
    ],
  ] as const)(
    "%s publishes neither protection nor success after the refusal",
    async (_command, retain, expected) => {
      const h = createHarness({ persisted: authenticatedState() });
      await h.controller.connect("frankfurt-01");
      const session = h.proxy.active!;
      const pause = pauseAfterAuthorization(h);
      const retaining = retain(h);
      await pause.reached;
      const snapshots = h.snapshots.length;

      const handling = tlsFailure(h, session);
      expect(h.controller.isSessionCurrentForProxyAuth(session)).toBe(false);
      pause.release();

      expect(await retaining).toEqual(expected);
      await handling;
      expect(h.snapshots.slice(snapshots).some((snapshot) => snapshot.protected)).toBe(false);
      expect(h.controller.isSessionCurrentForProxyAuth(session)).toBe(false);
      expect(h.controller.getSnapshot()).toMatchObject({
        protected: false,
        error: "proxy_unavailable",
      });
    },
  );

  it("stops displaying the refused session as protected when its route cannot be read", async () => {
    const h = createHarness({ persisted: authenticatedState() });
    await h.controller.connect("frankfurt-01");
    await h.controller.refreshAccount();
    const session = h.proxy.active!;
    vi.spyOn(h.proxy, "isActiveConfiguration").mockRejectedValueOnce(
      new Error("settings unavailable"),
    );

    const handling = tlsFailure(h, session);
    // Published with the refusal, before any route verification.
    expect(h.controller.getSnapshot().protected).toBe(false);
    await handling;
    expect(h.controller.isSessionCurrentForProxyAuth(session)).toBe(false);
    expect(h.controller.getSnapshot().protected).toBe(false);

    // A later republication of the current state cannot restore the claim.
    await h.controller.refreshAccount();
    expect(h.controller.getSnapshot().protected).toBe(false);
  });
});
