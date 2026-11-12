// SPDX-License-Identifier: MPL-2.0

import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import type { NetworkObservation } from "../../src/core/shared/network";
import { EMPTY_SNAPSHOT, type AppSnapshot } from "../../src/core/shared/state";

const source = readFileSync(new URL("../../src/ui/popup/popup.ts", import.meta.url), "utf8");
const ast = ts.createSourceFile("popup.ts", source, ts.ScriptTarget.Latest, true);
const functionNames = new Set(["renderNetwork"]);
const declarations = ast.statements
  .filter(ts.isFunctionDeclaration)
  .filter((node) => functionNames.has(node.name?.text ?? ""))
  .map((node) => node.getText(ast));
if (declarations.length !== functionNames.size) throw new Error("missing_popup_function");
const executable = ts.transpileModule(declarations.join("\n"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;

const PARIS: NetworkObservation = {
  status: "idle",
  mode: "vpn",
  ip: "8.8.4.4",
  checkedAt: null,
  latencyMs: null,
  locationId: "fr-paris",
};

function connected(network: NetworkObservation, changes: Partial<AppSnapshot> = {}): AppSnapshot {
  return {
    ...structuredClone(EMPTY_SNAPSHOT),
    status: "connected",
    protected: true,
    protectionRequested: true,
    activeLocationId: "fr-paris",
    network,
    ...changes,
  };
}

/** The address line of the popup, as the production rendering writes it. */
function addressLine(next: AppSnapshot, communicationFailed = false): string {
  return rendered(next, communicationFailed).line;
}

function rendered(next: AppSnapshot, communicationFailed = false) {
  let line = "";
  const attributes: Record<string, string> = {};
  const context = {
    communicationFailed,
    message: (key: string) => `<${key}>`,
    isolatedText: (value: string) => value,
    elements: {
      publicIp: {
        title: "",
        replaceChildren(...parts: string[]) {
          line = parts.join("");
        },
        setAttribute(name: string, value: string) {
          attributes[name] = value;
        },
      },
    },
  };
  runInNewContext(executable, context);
  (context as unknown as { renderNetwork(next: AppSnapshot): void }).renderNetwork(next);
  return { line, busy: attributes["aria-busy"] };
}

describe("the address line of the popup for a location connected again", () => {
  it.each(["idle", "checking", "ready"] as const)(
    "shows the address of the location while its observation is %s",
    (status) => {
      expect(addressLine(connected({ ...PARIS, status }))).toBe("<vpnIp> · 8.8.4.4");
    },
  );

  it.each([
    ["idle", "true"],
    ["checking", "true"],
    ["ready", "false"],
  ] as const)("marks a displayed address as busy until it is measured: %s", (status, busy) => {
    expect(rendered(connected({ ...PARIS, status })).busy).toBe(busy);
  });

  it("shows that the address is being checked when none is known yet", () => {
    expect(addressLine(connected({ ...PARIS, status: "checking", ip: null }))).toBe(
      "<vpnIp> · <ipChecking>",
    );
  });

  it("shows no address once its measurement failed", () => {
    expect(addressLine(connected({ ...PARIS, status: "unavailable", ip: null }))).toBe(
      "<vpnIp> · <ipUnavailable>",
    );
  });

  it("never shows the address of another location", () => {
    const berlin = connected(PARIS, { activeLocationId: "de-berlin" });
    expect(addressLine(berlin)).toBe("<vpnIp> · <ipUnavailable>");
  });

  it("never shows an address which was not measured on the direct route", () => {
    const direct: AppSnapshot = {
      ...structuredClone(EMPTY_SNAPSHOT),
      status: "disconnected",
      network: { ...PARIS, mode: "direct", locationId: null },
    };
    expect(addressLine(direct)).toBe("<publicIp> · <ipUnavailable>");
    expect(addressLine({ ...direct, network: { ...direct.network, status: "ready" } })).toBe(
      "<publicIp> · 8.8.4.4",
    );
  });

  it("shows no address while the worker cannot be reached", () => {
    expect(addressLine(connected({ ...PARIS, status: "ready" }), true)).toBe(
      "<vpnIp> · <ipUnavailable>",
    );
  });
});
