// SPDX-License-Identifier: MPL-2.0

import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import type { Device } from "../../src/core/api/types";
import type { ExtensionRequest, ExtensionResponse } from "../../src/core/shared/messages";
import { EMPTY_SNAPSHOT, type AppSnapshot } from "../../src/core/shared/state";
import { PopupSnapshotOrder, popupSnapshot } from "../../src/ui/popup/snapshot";
import { PROFILE } from "./helpers";

const DEVICE: Device = {
  deviceId: "remote-device",
  name: "Remote browser",
  kind: "browser_extension",
  profiles: [],
  createdAt: "2026-10-27T00:00:00Z",
};

interface PopupResponse extends ExtensionResponse {
  stale?: boolean;
  transportFailed?: boolean;
}

interface Harness {
  snapshot: AppSnapshot;
  communicationFailed: boolean;
  accountRefreshPending: false | { epoch: number };
  failures: number;
  request(command: ExtensionRequest): Promise<PopupResponse>;
  refreshAccount(): Promise<void>;
  render(value: AppSnapshot, confirmed?: boolean): boolean;
}

function deferred() {
  let resolve!: (value: unknown) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<unknown>((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  return { promise, resolve, reject };
}

const source = readFileSync(new URL("../../src/ui/popup/popup.ts", import.meta.url), "utf8");
const ast = ts.createSourceFile("popup.ts", source, ts.ScriptTarget.Latest, true);
const names = new Set(["request", "render", "isBusy", "connectionRequestState", "refreshAccount"]);
const executable = ts.transpileModule(
  ast.statements
    .filter(ts.isFunctionDeclaration)
    .filter((node) => names.has(node.name?.text ?? ""))
    .map((node) => node.getText(ast))
    .join("\n"),
  { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
).outputText;

function state(revision = 1, patch: Partial<AppSnapshot> = {}): AppSnapshot {
  return {
    ...structuredClone(EMPTY_SNAPSHOT),
    profile: PROFILE,
    status: "connected",
    protected: true,
    protectionRequested: true,
    activeLocationId: "fr",
    selectedLocationId: "fr",
    effectiveLanguage: "fr",
    languagePreference: "fr",
    snapshotVersion: { workerId: "worker-a", revision },
    ...patch,
  };
}

function setup(initial = state()) {
  const pending: ReturnType<typeof deferred>[] = [];
  const order = new PopupSnapshotOrder();
  order.accept(initial);
  const context = {
    snapshot: initial,
    accountEpoch: 1,
    communicationFailed: false,
    failures: 0,
    renderSequence: 0,
    confirmedSnapshotSequence: 0,
    connectionRequestIntent: 0,
    accountRefreshPending: false,
    devicesAction: 0,
    locationSelectionRequest: 0,
    loadedLocale: "fr",
    snapshotOrder: order,
    popupSnapshot,
    EMPTY_SNAPSHOT,
    expandedLocationCountries: new Set(),
    expandedLocationCities: new Set(),
    elements: { confirmationDialog: { close: vi.fn() } },
    extensionApi: {
      runtime: {
        sendMessage: vi.fn(() => {
          const response = deferred();
          pending.push(response);
          return response.promise;
        }),
      },
    },
    resetVerificationFeedback: vi.fn(),
    renderCurrent: vi.fn(),
    renderCommunicationFailure() {
      context.communicationFailed = true;
      ++context.failures;
    },
  };
  runInNewContext(executable, context);
  return { subject: context as unknown as Harness, pending };
}

const connectionCommands = [
  { type: "logout" },
  { type: "disconnect" },
  { type: "change_location", locationId: "de" },
] as const;

describe("CODE10: only the requested effect confirms a lost command reply", () => {
  it("accepts the account change caused by the current web login response", async () => {
    const { subject, pending } = setup(
      state(1, {
        profile: null,
        status: "logged_out",
        protected: false,
        protectionRequested: false,
        activeLocationId: null,
      }),
    );
    const login = subject.request({ type: "web_login", disconnectFirst: false });
    pending[0]!.resolve({ ok: true, snapshot: state(2) });
    expect(await login).toMatchObject({ ok: true });
    expect(subject.snapshot.profile?.userId).toBe(PROFILE.userId);
    expect(subject.failures).toBe(0);
  });

  it.each(connectionCommands)(
    "reports $type after an unrelated successful device refresh",
    async (command) => {
      const { subject, pending } = setup();
      const commandResult = subject.request(command);
      const devices = subject.request({ type: "refresh_devices" });
      pending[1]!.resolve({ ok: true, snapshot: state(2, { devices: [DEVICE] }) });
      await devices;
      pending[0]!.reject(new Error("command was not delivered"));
      expect(await commandResult).toMatchObject({ ok: false, transportFailed: true });
      expect(subject.snapshot.profile?.userId).toBe(PROFILE.userId);
      expect(subject.snapshot.activeLocationId).toBe("fr");
      expect(subject.failures).toBe(1);
    },
  );

  it.each([
    { securityPreferences: { killSwitchEnabled: false, webRtcProtectionEnabled: false } },
    { selectedLocationId: "es" },
    { error: "network_error" as const },
    { status: "disconnected" as const },
    { network: { ...EMPTY_SNAPSHOT.network, status: "ready" as const, ip: "203.0.113.9" } },
    { status: "disconnecting" as const, devices: [DEVICE] },
  ])("does not confuse a different state change with disconnect completion: %j", async (patch) => {
    const { subject, pending } = setup();
    const result = subject.request({ type: "disconnect" });
    subject.render(state(2, patch), true);
    pending[0]!.reject(new Error("current disconnect failed"));
    await result;
    expect(subject.failures).toBe(1);
  });

  it("requires the requested location, even if another connection change completed", async () => {
    const { subject, pending } = setup();
    const result = subject.request({ type: "change_location", locationId: "de" });
    subject.render(state(2, { activeLocationId: "es", selectedLocationId: "es" }), true);
    pending[0]!.reject(new Error("current location request failed"));
    await result;
    expect(subject.failures).toBe(1);
  });

  it.each([
    {
      command: { type: "disconnect" } as const,
      patch: {
        protected: false,
        protectionRequested: false,
        activeLocationId: null,
        status: "disconnected" as const,
      },
    },
    {
      command: { type: "change_location", locationId: "de" } as const,
      patch: { activeLocationId: "de", selectedLocationId: "de" },
    },
  ])("accepts the actual completed effect of $command.type", async ({ command, patch }) => {
    const { subject, pending } = setup();
    const result = subject.request(command);
    subject.render(state(2, patch), true);
    pending[0]!.reject(new Error("only the reply was lost"));
    await result;
    expect(subject.failures).toBe(0);
    expect(subject.communicationFailed).toBe(false);
  });

  it.each(["account", "worker", "intent"] as const)(
    "ignores an old failure after a newer %s",
    async (kind) => {
      const { subject, pending } = setup();
      const old = subject.request({ type: "connect", locationId: "de" });
      let newer: Promise<PopupResponse> | undefined;
      if (kind === "account")
        subject.render(state(2, { profile: { ...PROFILE, userId: "b" } }), true);
      if (kind === "worker")
        subject.render(state(1, { snapshotVersion: { workerId: "worker-b", revision: 1 } }), true);
      if (kind === "intent") newer = subject.request({ type: "disconnect" });
      pending[0]!.reject(new Error("old request failed"));
      expect(await old).toMatchObject({ stale: true, superseded: true, transportFailed: true });
      expect(subject.failures).toBe(0);
      if (newer) {
        pending[1]!.reject(new Error("current request failed"));
        await newer;
        expect(subject.failures).toBe(1);
      }
    },
  );
});

describe("EXTRA03: account refresh loading belongs to its account and request", () => {
  it.each(["reject", "resolve"] as const)(
    "lets B refresh before A finishes and retains B's pending after A %s",
    async (completion) => {
      const { subject, pending } = setup();
      const a = subject.refreshAccount();
      subject.render(state(2, { profile: { ...PROFILE, userId: "b" } }), true);
      expect(subject.accountRefreshPending).toBe(false);
      const b = subject.refreshAccount();
      expect(pending).toHaveLength(2);
      const bPending = subject.accountRefreshPending;
      if (completion === "reject") pending[0]!.reject(new Error("A's old transport"));
      else pending[0]!.resolve({ ok: true, snapshot: state(1) });
      await a;
      expect(subject.accountRefreshPending).toBe(bPending);
      expect(subject.snapshot.profile?.userId).toBe("b");
      expect(subject.communicationFailed).toBe(false);
      pending[1]!.resolve({
        ok: true,
        snapshot: state(3, { profile: { ...PROFILE, userId: "b" } }),
      });
      await b;
      expect(subject.accountRefreshPending).toBe(false);
    },
  );

  it("does not reuse pending from an older login of the same account", async () => {
    const { subject, pending } = setup();
    const old = subject.refreshAccount();
    subject.render(state(2, { profile: null }), true);
    subject.render(state(3), true);
    const current = subject.refreshAccount();
    const currentPending = subject.accountRefreshPending;
    expect(pending).toHaveLength(2);
    pending[0]!.reject(new Error("previous login"));
    await old;
    expect(subject.accountRefreshPending).toBe(currentPending);
    pending[1]!.reject(new Error("current login"));
    await current;
    expect(subject.accountRefreshPending).toBe(false);
    expect(subject.failures).toBe(1);
  });

  it("deduplicates refreshes of the current account and releases loading on failure", async () => {
    const { subject, pending } = setup();
    const current = subject.refreshAccount();
    await subject.refreshAccount();
    expect(pending).toHaveLength(1);
    pending[0]!.reject(new Error("current transport"));
    await current;
    expect(subject.accountRefreshPending).toBe(false);
    expect(subject.communicationFailed).toBe(true);
  });
});
