// SPDX-License-Identifier: MPL-2.0

import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import type { ExtensionRequest, ExtensionResponse } from "../../src/core/shared/messages";
import { EMPTY_SNAPSHOT, type AppSnapshot } from "../../src/core/shared/state";
import { networkRouteKey } from "../../src/core/shared/network";
import { PopupSnapshotOrder, popupSnapshot } from "../../src/ui/popup/snapshot";
import { PROFILE } from "./helpers";

interface PopupResponse extends ExtensionResponse {
  stale?: boolean;
  superseded?: boolean;
  transportFailed?: boolean;
}

interface Harness {
  snapshot: AppSnapshot | null;
  communicationFailed: boolean;
  accountEpoch: number;
  failures: number;
  request(message: ExtensionRequest): Promise<PopupResponse>;
  render(value: unknown, confirmed?: boolean): boolean;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  return { promise, resolve, reject };
}

const source = readFileSync(new URL("../../src/ui/popup/popup.ts", import.meta.url), "utf8");
const ast = ts.createSourceFile("popup.ts", source, ts.ScriptTarget.Latest, true);
const declarations = ast.statements
  .filter(ts.isFunctionDeclaration)
  .filter((node) =>
    ["request", "render", "isBusy", "connectionRequestState"].includes(node.name?.text ?? ""),
  )
  .map((node) => node.getText(ast))
  .join("\n");
const executable = ts.transpileModule(declarations, {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;

function state(revision = 1, patch: Partial<AppSnapshot> = {}): AppSnapshot {
  return {
    ...structuredClone(EMPTY_SNAPSHOT),
    profile: PROFILE,
    status: "connected",
    protected: true,
    protectionRequested: true,
    activeLocationId: "fr",
    effectiveLanguage: "fr",
    languagePreference: "fr",
    snapshotVersion: { workerId: "worker-a", revision },
    ...patch,
  };
}

function setup(initial = state()) {
  const pending: ReturnType<typeof deferred<unknown>>[] = [];
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
    devicesAction: 0,
    locationSelectionRequest: 0,
    loadedLocale: "fr",
    snapshotOrder: order,
    popupSnapshot,
    networkRouteKey,
    EMPTY_SNAPSHOT,
    expandedLocationCountries: new Set(),
    expandedLocationCities: new Set(),
    elements: { confirmationDialog: { close: vi.fn() } },
    extensionApi: {
      runtime: {
        sendMessage: vi.fn(() => {
          const response = deferred<unknown>();
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
  // Run the actual request/ordering functions without popup startup or a browser.
  runInNewContext(executable, context);
  return { subject: context as unknown as Harness, pending };
}

describe("popup transport failures retain their originating context", () => {
  it("reports a current transport failure and recovers on a later confirmed snapshot", async () => {
    const { subject, pending } = setup();
    const request = subject.request({ type: "refresh_devices" });
    pending[0]!.reject(new Error("transport_closed"));
    expect(await request).toMatchObject({ ok: false, transportFailed: true });
    expect(subject.failures).toBe(1);
    expect(subject.communicationFailed).toBe(true);
    expect(subject.render(state(2), true)).toBe(true);
    expect(subject.communicationFailed).toBe(false);
  });

  it("ignores a late failure after another account has been confirmed", async () => {
    const { subject, pending } = setup();
    const request = subject.request({ type: "refresh_devices" });
    expect(subject.render(state(2, { profile: { ...PROFILE, userId: "account-b" } }), true)).toBe(
      true,
    );
    pending[0]!.reject(new Error("old_account_transport_closed"));
    expect(await request).toMatchObject({ transportFailed: true, stale: true, superseded: true });
    expect(subject.accountEpoch).toBe(2);
    expect(subject.snapshot?.profile?.userId).toBe("account-b");
    expect(subject.communicationFailed).toBe(false);
    expect(subject.failures).toBe(0);
    const current = subject.request({ type: "refresh_devices" });
    pending[1]!.reject(new Error("new_account_transport_closed"));
    await current;
    expect(subject.communicationFailed).toBe(true);
    expect(subject.failures).toBe(1);
  });

  it("ignores an old worker failure while a replacement worker is still progressing", async () => {
    const { subject, pending } = setup();
    const request = subject.request({ type: "retry_connection" });
    subject.render(
      state(1, {
        snapshotVersion: { workerId: "worker-b", revision: 1 },
        status: "connecting",
        protected: false,
      }),
      true,
    );
    pending[0]!.reject(new Error("retired_worker_closed"));
    expect(await request).toMatchObject({ superseded: true });
    expect(subject.communicationFailed).toBe(false);
    const current = subject.request({ type: "retry_connection" });
    pending[1]!.reject(new Error("replacement_worker_transport_closed"));
    await current;
    expect(subject.communicationFailed).toBe(true);
  });

  it("reports an initial get_snapshot failure before any worker or account is known", async () => {
    const { subject, pending } = setup();
    subject.snapshot = null;
    const request = subject.request({ type: "get_snapshot" });
    pending[0]!.reject(new Error("initial_transport_closed"));
    expect(await request).toMatchObject({ transportFailed: true });
    expect(subject.communicationFailed).toBe(true);
    expect(subject.failures).toBe(1);
  });

  it("preserves a later final state from the same account and worker", async () => {
    const { subject, pending } = setup();
    const request = subject.request({ type: "change_location", locationId: "de" });
    subject.render(state(2, { activeLocationId: "de", selectedLocationId: "de" }), true);
    pending[0]!.reject(new Error("completion_reply_lost"));
    const response = await request;
    expect(response).toMatchObject({ transportFailed: true });
    expect(response.superseded).toBeUndefined();
    expect(subject.snapshot).toMatchObject({ activeLocationId: "de", protected: true });
    expect(subject.communicationFailed).toBe(false);
  });

  it("retains a current read failure for its dialog after a newer connection confirmation", async () => {
    const { subject, pending } = setup();
    const request = subject.request({ type: "refresh_devices" });
    subject.render(state(2), true);
    pending[0]!.reject(new Error("device_refresh_transport_closed"));
    const response = await request;
    expect(response).toMatchObject({ ok: false, transportFailed: true });
    expect(response.superseded).toBeUndefined();
    expect(subject.communicationFailed).toBe(false);
  });

  it("does not hide a current connection failure behind an unrelated IP-only publication", async () => {
    const { subject, pending } = setup();
    const request = subject.request({ type: "change_location", locationId: "de" });
    subject.render(
      state(2, {
        network: {
          ...EMPTY_SNAPSHOT.network,
          status: "ready",
          mode: "vpn",
          locationId: "fr",
          ip: "203.0.113.42",
        },
      }),
      true,
    );
    pending[0]!.reject(new Error("current_change_transport_closed"));
    expect(await request).toMatchObject({ transportFailed: true });
    expect(subject.communicationFailed).toBe(true);
    expect(subject.failures).toBe(1);
  });

  it.each(["connecting", "refreshing", "disconnecting"] as const)(
    "still reports the current failure after a %s progress publication",
    async (status) => {
      const { subject, pending } = setup();
      const request = subject.request({ type: "retry_connection" });
      subject.render(state(2, { status }), true);
      pending[0]!.reject(new Error("current_command_transport_closed"));
      expect(await request).toMatchObject({ transportFailed: true });
      expect(subject.communicationFailed).toBe(true);
      expect(subject.failures).toBe(1);
    },
  );

  it.each(["disconnect", "logout"] as const)(
    "keeps the newer %s command authoritative and reports its own failure",
    async (type) => {
      const { subject, pending } = setup();
      const old = subject.request({ type: "connect", locationId: "fr" });
      const current = subject.request({ type });
      pending[0]!.reject(new Error("superseded_connect_failed"));
      expect(await old).toMatchObject({ superseded: true });
      expect(subject.communicationFailed).toBe(false);
      pending[1]!.reject(new Error("current_stop_failed"));
      expect(await current).toMatchObject({ transportFailed: true });
      expect(subject.communicationFailed).toBe(true);
      expect(subject.failures).toBe(1);
    },
  );

  it.each(["disconnect", "logout"] as const)(
    "accepts the successful %s result before an older connect rejection",
    async (type) => {
      const { subject, pending } = setup();
      const old = subject.request({ type: "connect", locationId: "fr" });
      const current = subject.request({ type });
      pending[1]!.resolve({
        ok: true,
        snapshot: state(2, {
          status: type === "logout" ? "logged_out" : "disconnected",
          profile: type === "logout" ? null : PROFILE,
          protected: false,
          protectionRequested: false,
          activeLocationId: null,
        }),
      });
      expect(await current).toMatchObject({ ok: true });
      pending[0]!.reject(new Error("superseded_connect_failed"));
      expect(await old).toMatchObject({ superseded: true });
      expect(subject.communicationFailed).toBe(false);
      expect(subject.snapshot?.protected).toBe(false);
    },
  );

  it("does not treat a local rerender or a rejected old snapshot as fresh confirmation", async () => {
    const { subject, pending } = setup(state(5));
    const request = subject.request({ type: "refresh_devices" });
    expect(subject.render(state(5))).toBe(true);
    expect(subject.render(state(4), true)).toBe(false);
    pending[0]!.reject(new Error("current_transport_closed"));
    await request;
    expect(subject.communicationFailed).toBe(true);
  });

  it("keeps optional public-IP transport failures out of connection recovery", async () => {
    const { subject, pending } = setup();
    const request = subject.request({ type: "refresh_network" });
    pending[0]!.reject(new Error("ip_observation_failed"));
    await request;
    expect(subject.communicationFailed).toBe(false);
    expect(subject.failures).toBe(0);
  });

  it("reports malformed current responses but ignores them after a newer final publication", async () => {
    const { subject, pending } = setup();
    const first = subject.request({ type: "refresh_devices" });
    pending[0]!.resolve({ ok: true, snapshot: null });
    await first;
    expect(subject.failures).toBe(1);
    subject.render(state(2), true);
    const old = subject.request({ type: "refresh_devices" });
    subject.render(state(3), true);
    pending[1]!.resolve({ invalid: true });
    expect(await old).toMatchObject({ transportFailed: true });
    expect(subject.failures).toBe(1);
    expect(subject.communicationFailed).toBe(false);
  });
});
