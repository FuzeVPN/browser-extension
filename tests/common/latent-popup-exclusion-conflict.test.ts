// SPDX-License-Identifier: MPL-2.0

import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import type { ExtensionRequest } from "../../src/core/shared/messages";
import type { SiteExclusion, SiteExclusionsState } from "../../src/core/shared/site-exclusions";
import { EMPTY_SITE_EXCLUSIONS } from "../../src/core/shared/site-exclusions";
import { EMPTY_SNAPSHOT } from "../../src/core/shared/state";
import {
  emptySiteExclusionRecord,
  type SiteExclusionRecord,
  type SiteExclusionStorage,
} from "../../src/core/storage/site-exclusion-storage";
import { exclusionRetry } from "../../src/ui/popup/exclusion-retry";
import { authenticatedState, createHarness } from "./helpers";

type ExclusionUpdate = Extract<
  ExtensionRequest,
  { type: "update_site_exclusions" | "retry_site_exclusions" }
>;

interface Subject {
  snapshot: { siteExclusions: SiteExclusionsState };
  exclusionConflict: boolean;
  exclusionRequestFailed: boolean;
  updateSiteExclusions(enabled: boolean, entries: SiteExclusion[]): Promise<boolean>;
  sendExclusionsUpdate(update: ExclusionUpdate, recheck?: boolean): Promise<boolean>;
}

const source = readFileSync(new URL("../../src/ui/popup/popup.ts", import.meta.url), "utf8");
const ast = ts.createSourceFile("popup.ts", source, ts.ScriptTarget.Latest, true);
const functionNames = new Set([
  "updateSiteExclusions",
  "sendExclusionsUpdate",
  "completeExclusionIntent",
]);
const declarations = ast.statements
  .filter(ts.isFunctionDeclaration)
  .filter((node) => functionNames.has(node.name?.text ?? ""))
  .map((node) => node.getText(ast));
if (declarations.length !== functionNames.size) throw new Error("missing_popup_function");
const executable = ts.transpileModule(declarations.join("\n"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;

const ENTRY: SiteExclusion = { domain: "example.com", includeSubdomains: true };
const CLEAN: SiteExclusionsState = structuredClone(EMPTY_SITE_EXCLUSIONS);
// A worker restarted on an unreadable policy store reports no policy, pending and failed.
const UNREADABLE: SiteExclusionsState = { ...structuredClone(CLEAN), pending: true, error: true };

function snapshot(siteExclusions: SiteExclusionsState) {
  return {
    ...structuredClone(EMPTY_SNAPSHOT),
    status: "disconnected" as const,
    siteExclusionsAvailable: true,
    siteExclusions: structuredClone(siteExclusions),
  };
}

/** The production exclusion commands of the popup, against a scripted worker. */
function setup(initial: SiteExclusionsState) {
  const worker = { exclusions: structuredClone(initial), messages: [] as string[] };
  const context = {
    snapshot: snapshot(initial),
    exclusionRequestPending: false,
    exclusionRequestFailed: false,
    exclusionConflict: false,
    failedExclusionIntent: null,
    submittedExclusionDraft: null,
    elements: {
      exclusionInput: { value: "", disabled: false, focus: vi.fn() },
      exclusionSubdomains: { checked: true },
      exclusionsDialog: { open: false },
    },
    exclusionRetry,
    structuredClone,
    queueMicrotask,
    renderSiteExclusions: vi.fn(),
    render(value: ReturnType<typeof snapshot>) {
      context.snapshot = value;
    },
    async request(message: ExtensionRequest) {
      worker.messages.push(message.type);
      if (message.type === "update_site_exclusions") {
        // The command wakes a worker whose policy store cannot be read: it is refused.
        worker.exclusions = structuredClone(UNREADABLE);
        return { ok: false, snapshot: snapshot(worker.exclusions) };
      }
      // The store is readable again: resuming the durable journal recovers.
      if (message.type === "retry_site_exclusions") worker.exclusions = structuredClone(CLEAN);
      return { ok: true, snapshot: snapshot(worker.exclusions) };
    },
  };
  runInNewContext(executable, context);
  return { subject: context as unknown as Subject, worker };
}

const retryButton = (subject: Subject) =>
  subject.sendExclusionsUpdate({ type: "retry_site_exclusions" }, true);

class Policies implements SiteExclusionStorage {
  record: SiteExclusionRecord = emptySiteExclusionRecord();
  unreadable = true;

  async read() {
    if (this.unreadable) throw new Error("policy store unavailable");
    return structuredClone(this.record);
  }

  async write(record: SiteExclusionRecord) {
    this.record = structuredClone(record);
  }
}

describe("the popup Retry button after an exclusion conflict", () => {
  it("scripts the worker as the controller behaves on an unreadable policy store", async () => {
    const policies = new Policies();
    const h = createHarness({ persisted: authenticatedState(), siteExclusionStorage: policies });
    await h.controller.initialize();
    expect(h.controller.getSnapshot()).toMatchObject({
      trafficBlocked: true,
      siteExclusions: UNREADABLE,
    });
    await expect(h.controller.updateSiteExclusions(0, true, [ENTRY])).rejects.toThrow(
      "storage_unavailable",
    );
    expect(h.controller.getSnapshot().siteExclusions).toEqual(UNREADABLE);

    policies.unreadable = false;
    await h.controller.retrySiteExclusions();
    expect(h.controller.getSnapshot()).toMatchObject({
      trafficBlocked: false,
      siteExclusions: CLEAN,
    });
  });

  it("resumes the interrupted worker policy in a popup opened afterwards", async () => {
    const { subject, worker } = setup(UNREADABLE);
    expect(await retryButton(subject)).toBe(true);
    expect(worker.messages).toEqual(["get_snapshot", "retry_site_exclusions"]);
    expect(subject.snapshot.siteExclusions).toMatchObject({ pending: false, error: false });
  });

  it("is not a dead end in the popup whose own change was refused", async () => {
    const { subject, worker } = setup(CLEAN);
    expect(await subject.updateSiteExclusions(true, [ENTRY])).toBe(false);
    expect(subject.snapshot.siteExclusions).toMatchObject({ pending: true, error: true });

    // The refused change differs from the worker's unreadable policy: a conflict.
    expect(await retryButton(subject)).toBe(false);
    expect(subject.exclusionConflict).toBe(true);
    expect(worker.messages).toEqual(["update_site_exclusions", "get_snapshot"]);

    // The pending policy forbids any new change: Retry is the only control left.
    expect(await subject.updateSiteExclusions(true, [ENTRY])).toBe(false);
    expect(worker.messages).toEqual(["update_site_exclusions", "get_snapshot"]);

    // Pressing it again must recover what reopening the popup recovers.
    await retryButton(subject);
    expect(worker.messages).toContain("retry_site_exclusions");
    expect(subject.snapshot.siteExclusions).toMatchObject({ pending: false, error: false });
  });
});
