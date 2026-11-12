// SPDX-License-Identifier: MPL-2.0

import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { ApiError } from "../../src/core/api/client";
import type { AppSnapshot } from "../../src/core/shared/state";
import { NOW, authenticatedState, createHarness } from "./helpers";

interface Subject {
  renderVerification(next: AppSnapshot): void;
}

const source = readFileSync(new URL("../../src/ui/popup/popup.ts", import.meta.url), "utf8");
const ast = ts.createSourceFile("popup.ts", source, ts.ScriptTarget.Latest, true);
const functionNames = new Set(["renderVerification", "resetVerificationFeedback"]);
const declarations = ast.statements
  .filter(ts.isFunctionDeclaration)
  .filter((node) => functionNames.has(node.name?.text ?? ""))
  .map((node) => node.getText(ast));
if (declarations.length !== functionNames.size) throw new Error("missing_popup_function");
const executable = ts.transpileModule(declarations.join("\n"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;

const COOLDOWN_SECONDS = 60;
const ELAPSED_SECONDS = 40;

/** A worker whose account was just refused another verification email. */
async function workerInCooldown() {
  const h = createHarness({ persisted: authenticatedState() });
  await h.controller.initialize();
  vi.spyOn(h.api, "resendVerification").mockRejectedValue(
    new ApiError("verification_email_cooldown", 429, COOLDOWN_SECONDS),
  );
  expect(await h.controller.resendVerification()).toEqual({
    ok: false,
    commandError: "verification_email_cooldown",
    commandRetryAfterSeconds: COOLDOWN_SECONDS,
  });
  return h;
}

/** The verification panel of a popup opened at the given time. */
function openPopup(clock: { now: number }) {
  const elements = {
    verificationPanel: { classList: { toggle: vi.fn() } },
    verificationStatus: { textContent: "" },
    resendButton: { disabled: false, setAttribute: vi.fn() },
  };
  const context = {
    snapshot: null,
    verificationPending: false,
    verificationRequest: 0,
    verificationSent: false,
    verificationAvailable: false,
    verificationCooldownUntil: 0,
    verificationObservedCooldown: null,
    verificationFailure: null,
    verificationTimer: undefined,
    Date: { now: () => clock.now },
    setTimeout: vi.fn(),
    clearTimeout: vi.fn(),
    message: (key: string, substitutions: string[] = []) => [key, ...substitutions].join(":"),
    errorMessage: (code: string) => code,
    elements,
  };
  // Execute the production rendering, with only the clock and the DOM replaced.
  runInNewContext(executable, context);
  const subject = context as unknown as Subject;
  return {
    render: (snapshot: AppSnapshot) => subject.renderVerification(snapshot),
    remainingSeconds() {
      const [key, seconds] = elements.verificationStatus.textContent.split(":");
      return key === "errorVerificationCooldown" ? Number(seconds) : 0;
    },
    resendDisabled: () => elements.resendButton.disabled,
  };
}

describe("the verification email cooldown across popup openings", () => {
  it("is published by the worker as what remains of the delay it received", async () => {
    const h = await workerInCooldown();
    expect(h.controller.getSnapshot()).toMatchObject({
      error: "verification_email_cooldown",
      retryAfterSeconds: COOLDOWN_SECONDS,
    });
    h.setNow(NOW + ELAPSED_SECONDS * 1000);
    expect(h.controller.getSnapshot().retryAfterSeconds).toBe(COOLDOWN_SECONDS - ELAPSED_SECONDS);
    h.setNow(NOW + (COOLDOWN_SECONDS + 5) * 1000);
    expect(h.controller.getSnapshot().retryAfterSeconds).toBe(0);
  });

  it("counts down in a popup that stays open", async () => {
    const h = await workerInCooldown();
    const clock = { now: NOW };
    const popup = openPopup(clock);
    popup.render(h.controller.getSnapshot());
    expect(popup.remainingSeconds()).toBe(COOLDOWN_SECONDS);
    expect(popup.resendDisabled()).toBe(true);

    clock.now += ELAPSED_SECONDS * 1000;
    h.setNow(clock.now);
    popup.render(h.controller.getSnapshot());
    expect(popup.remainingSeconds()).toBe(COOLDOWN_SECONDS - ELAPSED_SECONDS);

    clock.now = NOW + COOLDOWN_SECONDS * 1000;
    h.setNow(clock.now);
    popup.render(h.controller.getSnapshot());
    expect(popup.resendDisabled()).toBe(false);
  });

  it("resumes where it stood in a popup reopened before its end", async () => {
    const h = await workerInCooldown();
    const clock = { now: NOW };
    const first = openPopup(clock);
    first.render(h.controller.getSnapshot());
    expect(first.remainingSeconds()).toBe(COOLDOWN_SECONDS);

    // The popup is closed, then opened again against the same running worker.
    clock.now += ELAPSED_SECONDS * 1000;
    h.setNow(clock.now);
    const reopened = openPopup(clock);
    reopened.render(h.controller.getSnapshot());
    expect(reopened.resendDisabled()).toBe(true);
    expect(reopened.remainingSeconds()).toBeLessThanOrEqual(COOLDOWN_SECONDS - ELAPSED_SECONDS);
  });
});
