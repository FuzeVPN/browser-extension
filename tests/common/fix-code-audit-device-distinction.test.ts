// SPDX-License-Identifier: MPL-2.0

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import type { Device } from "../../src/core/api/types";
import { LANGUAGE_NAMES, localeDirectory, type Language } from "../../src/core/shared/language";
import { EMPTY_SNAPSHOT, type AppSnapshot } from "../../src/core/shared/state";
import { Translator, type Catalog } from "../../src/core/shared/translator";
import {
  deviceAccessibleName,
  deviceDisplayNames,
} from "../../src/ui/popup/device-accessible-name";
import { deviceDisplayName, deviceKindMessageKey } from "../../src/ui/popup/device-display";

const languages = Object.keys(LANGUAGE_NAMES) as Language[];
const translator = new Translator(async (language) => {
  return JSON.parse(
    readFileSync(
      resolve(
        import.meta.dirname,
        "../../assets/_locales",
        localeDirectory(language),
        "messages.json",
      ),
      "utf8",
    ),
  ) as Catalog;
});

function device(deviceId: string, name: string): Device {
  return {
    deviceId,
    name,
    kind: "browser_extension",
    profiles: [],
    createdAt: "2026-10-28T00:00:00Z",
  };
}

function distinct(devices: readonly Device[], locale = "fr", fallback = "Navigateur") {
  return deviceDisplayNames(
    devices,
    (entry) => entry.name,
    locale,
    () => fallback,
  );
}

describe("device names distinguish deletion targets", () => {
  it("leaves unique names intact and never displays a technical identifier", () => {
    const devices = [device("secret-id-a", "Travail"), device("secret-id-b", "Téléphone")];
    expect([...distinct(devices).values()]).toEqual(["Travail", "Téléphone"]);
    for (const name of distinct(devices).values()) expect(name).not.toContain("secret-id");
  });

  it("disambiguates duplicates, whitespace, case, compatibility and canonical equivalents", () => {
    const devices = [
      device("a", "Bureau"),
      device("b", " \tBUREAU\u00a0"),
      device("c", "Ｂｕｒｅａｕ"),
      device("d", "Bu\u200breau"),
      device("e", "Café"),
      device("f", "Cafe\u0301"),
      device("g", "Desk Top"),
      device("h", "Desk\n\tTop"),
    ];
    expect([...distinct(devices).values()]).toEqual([
      "Bureau (1)",
      " \tBUREAU\u00a0 (2)",
      "Ｂｕｒｅａｕ (3)",
      "Bu\u200breau (4)",
      "Café (1)",
      "Cafe\u0301 (2)",
      "Desk Top (1)",
      "Desk\n\tTop (2)",
    ]);
  });

  it("uses a localized kind for empty or invisible names, including a single target", () => {
    expect(distinct([device("alone", "\u200b\u202e \n\t\u2069")]).get("alone")).toBe("Navigateur");
    expect([
      ...distinct([device("a", ""), device("b", " \t"), device("c", "Navigateur")]).values(),
    ]).toEqual(["Navigateur (1)", "Navigateur (2)", "Navigateur (3)"]);
  });

  it("reserves literal suffixes and remains stable when the API reorders devices", () => {
    const devices = [
      device("a", "Laptop"),
      device("b", "Laptop"),
      device("c", "Laptop (1)"),
      device("d", "Laptop (2)"),
      device("e", "Laptop (2)"),
      device("f", "Laptop (2) (1)"),
    ];
    const expected = distinct(devices);
    expect([...expected.values()]).toEqual([
      "Laptop (3)",
      "Laptop (4)",
      "Laptop (1)",
      "Laptop (2) (2)",
      "Laptop (2) (3)",
      "Laptop (2) (1)",
    ]);
    expect([...distinct([...devices].reverse())]).toEqual([...expected]);
    expect(new Set(expected.values()).size).toBe(devices.length);
  });

  it.each(languages)("keeps label-in-name and localized numerals in %s", async (language) => {
    const message = await translator.forLanguage(language);
    const devices = [device("private-a", ""), device("private-b", "\u200b")];
    const names = distinct(devices, language, message("deviceKindBrowser"));
    const numbers = new Intl.NumberFormat(language, { useGrouping: false });
    expect(languages).toHaveLength(30);
    for (const [index, entry] of devices.entries()) {
      const name = names.get(entry.deviceId)!;
      expect(name).toBe(`${message("deviceKindBrowser")} (${numbers.format(index + 1)})`);
      expect(deviceAccessibleName(message("deleteDevice"), name)).toBe(
        `${message("deleteDevice")} — ${name}`,
      );
      expect(name).not.toContain("private-");
    }
    expect(new Set(names.values()).size).toBe(2);
  });
});

class TextElement {
  className = "";
  dir = "";
  type = "";
  disabled = false;
  dataset: Record<string, string> = {};
  children: TextElement[] = [];
  attributes = new Map<string, string>();
  classList = { toggle: vi.fn() };
  private text = "";

  constructor(readonly tagName: string) {}

  set textContent(value: string) {
    this.text = value;
    this.children = [];
  }

  get textContent(): string {
    return this.text + this.children.map((child) => child.textContent).join("");
  }

  set innerHTML(_value: string) {
    throw new Error("Device names must never be parsed as HTML");
  }

  append(...children: TextElement[]) {
    this.children.push(...children);
  }

  setAttribute(name: string, value: string) {
    this.attributes.set(name, value);
  }

  addEventListener(_type: string, _listener: () => void) {}
}

const source = readFileSync(new URL("../../src/ui/popup/popup.ts", import.meta.url), "utf8");
const ast = ts.createSourceFile("popup.ts", source, ts.ScriptTarget.Latest, true);
const declarations = ast.statements
  .filter(ts.isFunctionDeclaration)
  .filter((node) =>
    [
      "renderDevices",
      "displayDeviceName",
      "deviceElement",
      "isolatedText",
      "isBusy",
      "deleteDevice",
    ].includes(node.name?.text ?? ""),
  )
  .map((node) => node.getText(ast))
  .join("\n");
const executable = ts.transpileModule(declarations, {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;

async function popup(language: Language, devices: Device[], status: AppSnapshot["status"]) {
  const message = await translator.forLanguage(language);
  const snapshot: AppSnapshot = {
    ...structuredClone(EMPTY_SNAPSHOT),
    profile: {
      userId: "synthetic-device-label-user",
      email: "device-label@example.invalid",
      firstName: "Test",
      lastName: "User",
      countryCode: "FR",
    },
    devices,
    currentDeviceId: devices[0]?.deviceId ?? null,
    status,
  };
  const elements = {
    devicesError: new TextElement("p"),
    deviceCount: new TextElement("p"),
    refreshDevicesButton: new TextElement("button"),
    closeDevicesButton: new TextElement("button"),
    deviceList: new TextElement("section"),
  };
  const context = {
    elements,
    snapshot,
    locale: language,
    accountEpoch: 4,
    currentBrowserName: "Firefox",
    devicesAction: 0,
    devicesFailure: null,
    devicesRefreshPending: false,
    renderedDevices: "",
    deviceDeletions: new Set<string>(),
    dateFormat: new Intl.DateTimeFormat(language, { dateStyle: "medium" }),
    deviceAccessibleName,
    deviceDisplayNames,
    deviceDisplayName,
    deviceKindMessageKey,
    message,
    confirmAction: vi.fn(async () => false),
    request: vi.fn(async (_message: unknown) => ({ superseded: true })),
    document: { createElement: (tag: string) => new TextElement(tag) },
    replaceListChildren: (list: TextElement, children: TextElement[]) => {
      list.children = children;
    },
  };
  runInNewContext(executable, context);
  const subject = context as typeof context & {
    renderDevices(next: AppSnapshot): void;
    deleteDevice(deviceId: string, deletionKey: string, remove: TextElement): Promise<void>;
  };
  return { subject, snapshot, message };
}

describe("actual popup device rendering preserves the accessible target", () => {
  it.each(["ar", "fa", "ur", "fr"] as const)(
    "renders literal HTML, substitution and RTL names with matching visible/action targets in %s",
    async (language) => {
      const hostile = '\u202e<img src=x onerror="globalThis.executed=true"> $1 $$ \u2067جهاز\u2069';
      const devices = [device("private-a", hostile), device("private-b", hostile)];
      const { subject, snapshot, message } = await popup(language, devices, "connected");
      subject.renderDevices(snapshot);
      const names = distinct(devices, language);
      for (const [index, row] of subject.elements.deviceList.children.entries()) {
        const title = row.children[0]!.children[0]!;
        const isolatedName = title.children[0]!;
        const remove = row.children[3]!;
        const name = names.get(devices[index]!.deviceId)!;
        expect(isolatedName.tagName).toBe("bdi");
        expect(isolatedName.dir).toBe("auto");
        expect(isolatedName.textContent).toBe(name);
        expect(isolatedName.children).toHaveLength(0);
        expect(remove.textContent).toBe(message("deleteDevice"));
        expect(remove.attributes.get("aria-label")).toBe(`${remove.textContent} — ${name}`);
        expect(remove.attributes.get("aria-busy")).toBe("false");
        expect(remove.disabled).toBe(false);
        expect(remove.attributes.get("aria-label")).not.toContain("private-");
        expect(title.children).toHaveLength(index === 0 ? 2 : 1);
      }
      expect(subject.elements.deviceList.children).toHaveLength(2);
    },
  );

  it.each(["connected", "connecting", "refreshing", "disconnecting"] as const)(
    "keeps action state independent of duplicate-name suffixes while %s",
    async (status) => {
      const devices = [device("a", "Same"), device("b", "Same")];
      const { subject, snapshot } = await popup("fr", devices, status);
      subject.deviceDeletions.add(JSON.stringify([4, "a"]));
      subject.renderDevices(snapshot);
      const [first, second] = subject.elements.deviceList.children.map((row) => row.children[3]!);
      expect(first!.disabled).toBe(true);
      expect(first!.attributes.get("aria-busy")).toBe("true");
      expect(second!.disabled).toBe(status !== "connected");
      expect(second!.attributes.get("aria-busy")).toBe("false");
      expect(first!.attributes.get("aria-label")).toContain("Same (1)");
      expect(second!.attributes.get("aria-label")).toContain("Same (2)");
      expect(first!.dataset.focusKey).toBe("a");
      expect(second!.dataset.focusKey).toBe("b");
    },
  );

  it("uses the same distinct target in deletion confirmation and after reordering", async () => {
    const devices = [device("a", ""), device("b", "\u200b"), device("c", "\u2067\u2069")];
    const { subject, snapshot, message } = await popup("ar", devices, "connected");
    subject.renderDevices(snapshot);
    const names = subject.elements.deviceList.children.map(
      (row) => row.children[0]!.children[0]!.children[0]!.textContent,
    );
    const remove = subject.elements.deviceList.children[1]!.children[3]!;
    expect(names[1]).toBe(
      `${message("deviceKindBrowser")} (${new Intl.NumberFormat("ar").format(1)})`,
    );
    await subject.deleteDevice("b", JSON.stringify([4, "b"]), remove);
    expect(subject.confirmAction).toHaveBeenCalledExactlyOnceWith(
      message("deleteDevice"),
      message("confirmDeleteDevice", [names[1]!]),
    );
    subject.renderDevices({ ...snapshot, devices: [...devices].reverse() });
    const reordered = subject.elements.deviceList.children.map(
      (row) => row.children[0]!.children[0]!.children[0]!.textContent,
    );
    expect(reordered).toEqual([...names].reverse());
  });

  it.each(["add", "remove", "rename", "locale", "locale-same-name"] as const)(
    "abandons an open confirmation if %s invalidates the target or its language",
    async (change) => {
      const name = change === "locale" ? "Browser" : "Laptop";
      const devices = [device("b", name), device("c", name), device("d", name)];
      const { subject, snapshot, message } = await popup("ar", devices, "connected");
      subject.renderDevices(snapshot);
      const targetRow = subject.elements.deviceList.children[1]!;
      const originalName = targetRow.children[0]!.children[0]!.children[0]!.textContent;
      subject.confirmAction.mockImplementation(async () => {
        if (change === "add") {
          subject.snapshot = { ...snapshot, devices: [device("a", "Laptop"), ...devices] };
        } else if (change === "remove") {
          subject.snapshot = { ...snapshot, devices: devices.slice(1) };
        } else if (change === "rename") {
          subject.snapshot = {
            ...snapshot,
            devices: devices.map((entry) =>
              entry.deviceId === "c" ? { ...entry, name: "Work" } : entry,
            ),
          };
        } else {
          subject.locale = "fr";
          subject.message = await translator.forLanguage("fr");
        }
        subject.renderDevices(subject.snapshot);
        return true;
      });

      await subject.deleteDevice("c", JSON.stringify([4, "c"]), targetRow.children[3]!);

      expect(subject.confirmAction).toHaveBeenCalledExactlyOnceWith(
        message("deleteDevice"),
        message("confirmDeleteDevice", [originalName]),
      );
      expect(subject.request).not.toHaveBeenCalled();
      expect(subject.deviceDeletions.size).toBe(0);
    },
  );

  it("accepts an open confirmation after API reordering without changing the target", async () => {
    const devices = [device("b", "Laptop"), device("c", "Laptop")];
    const { subject, snapshot } = await popup("fr", devices, "connected");
    subject.renderDevices(snapshot);
    const targetRow = subject.elements.deviceList.children[1]!;
    subject.confirmAction.mockImplementation(async () => {
      subject.snapshot = { ...snapshot, devices: [...devices].reverse() };
      subject.renderDevices(subject.snapshot);
      return true;
    });

    await subject.deleteDevice("c", JSON.stringify([4, "c"]), targetRow.children[3]!);

    expect(subject.request).toHaveBeenCalledExactlyOnceWith({
      type: "delete_device",
      deviceId: "c",
    });
    expect(subject.deviceDeletions.size).toBe(0);
  });
});
