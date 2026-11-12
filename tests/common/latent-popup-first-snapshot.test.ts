// SPDX-License-Identifier: MPL-2.0

import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import type { ExtensionRequest } from "../../src/core/shared/messages";
import { EMPTY_SNAPSHOT, type AppSnapshot } from "../../src/core/shared/state";
import { PopupSnapshotOrder, popupSnapshot } from "../../src/ui/popup/snapshot";
import { PROFILE } from "./helpers";

interface Subject {
  snapshot: AppSnapshot | null;
  accountEpoch: number;
  communicationFailed: boolean;
  initializePopup(): Promise<void>;
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
const functionNames = new Set([
  "initializePopup",
  "refreshAccount",
  "request",
  "render",
  "isBusy",
  "connectionRequestState",
]);
const declarations = ast.statements
  .filter(ts.isFunctionDeclaration)
  .filter((node) => functionNames.has(node.name?.text ?? ""))
  .map((node) => node.getText(ast));
if (declarations.length !== functionNames.size) throw new Error("missing_popup_function");
const executable = ts.transpileModule(declarations.join("\n"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;

function state(revision: number, patch: Partial<AppSnapshot> = {}): AppSnapshot {
  return {
    ...structuredClone(EMPTY_SNAPSHOT),
    profile: PROFILE,
    status: "connected",
    protected: true,
    protectionRequested: true,
    autoConnect: true,
    activeLocationId: "fr",
    selectedLocationId: "fr",
    effectiveLanguage: "fr",
    languagePreference: "fr",
    snapshotVersion: { workerId: "worker-a", revision },
    ...patch,
  };
}

/** A popup that has just been opened: no snapshot, no account, no worker known yet. */
function setup() {
  const pending: (ReturnType<typeof deferred<unknown>> & { message: ExtensionRequest })[] = [];
  const context = {
    snapshot: null,
    accountEpoch: 0,
    accountRefreshPending: false,
    devicesRefreshPending: false,
    locationsRefreshPending: false,
    connectionRetryPending: false,
    securityPreferencesPending: false,
    automaticSelectionPending: false,
    verificationPending: false,
    communicationFailed: false,
    renderSequence: 0,
    confirmedSnapshotSequence: 0,
    connectionRequestIntent: 0,
    devicesAction: 0,
    locationSelectionRequest: 0,
    loadedLocale: "fr",
    languageCatalogFailed: false,
    devicesFailure: null,
    locationPreferenceFailure: null,
    locationsRefreshFailed: false,
    locationSelectionPending: false,
    snapshotOrder: new PopupSnapshotOrder(),
    popupSnapshot,
    EMPTY_SNAPSHOT,
    expandedLocationCountries: new Set<string>(),
    expandedLocationCities: new Set<string>(),
    elements: { confirmationDialog: { close: vi.fn() } },
    extensionApi: {
      runtime: {
        sendMessage: vi.fn((message: ExtensionRequest) => {
          const response = { ...deferred<unknown>(), message };
          pending.push(response);
          return response.promise;
        }),
      },
    },
    resetVerificationFeedback: vi.fn(),
    renderCurrent: vi.fn(),
    renderCommunicationFailure() {
      context.communicationFailed = true;
      ++context.renderSequence;
    },
  };
  // Execute the production functions, with only messaging and final rendering replaced.
  runInNewContext(executable, context);
  return {
    subject: context as unknown as Subject,
    pending,
    sent: () => pending.map(({ message }) => message.type),
  };
}

function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("the account refresh of a popup that has just been opened", () => {
  it("follows the reply to its first snapshot request", async () => {
    const { subject, pending, sent } = setup();
    void subject.initializePopup();
    expect(sent()).toEqual(["get_snapshot"]);
    pending[0]!.resolve({ ok: true, snapshot: state(1) });
    await settle();
    expect(subject.snapshot?.profile?.userId).toBe(PROFILE.userId);
    expect(sent()).toEqual(["get_snapshot", "refresh_account"]);
  });

  it.each(["connecting", "refreshing", "disconnecting"] as const)(
    "is left to the worker while the first snapshot is %s",
    async (status) => {
      const { subject, pending, sent } = setup();
      void subject.initializePopup();
      pending[0]!.resolve({ ok: true, snapshot: state(1, { status, protected: false }) });
      await settle();
      expect(subject.snapshot?.status).toBe(status);
      expect(sent()).toEqual(["get_snapshot"]);
    },
  );

  it("is still sent when a publication of the same state arrives before that reply", async () => {
    const { subject, pending, sent } = setup();
    void subject.initializePopup();
    expect(sent()).toEqual(["get_snapshot"]);
    // The worker publishes while it is still preparing the reply, as the message listener
    // registered at popup startup receives it.
    expect(subject.render(state(1), true)).toBe(true);
    expect(subject.snapshot).toMatchObject({
      profile: { userId: PROFILE.userId },
      status: "connected",
      protected: true,
    });
    pending[0]!.resolve({ ok: true, snapshot: state(2) });
    await settle();
    expect(subject.communicationFailed).toBe(false);
    expect(sent()).toEqual(["get_snapshot", "refresh_account"]);
  });
});
