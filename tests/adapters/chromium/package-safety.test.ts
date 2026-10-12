// SPDX-License-Identifier: MPL-2.0

import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { createHash } from "node:crypto";
import { publishArchive, safeOutput, verifyArchive } from "../../../scripts/package.mjs";
import { createZip, crc32, readZip } from "../../../scripts/zip.mjs";
import { manifestFor, publicKeyId } from "../../../scripts/targets.mjs";

const root = resolve(import.meta.dirname, "../../..");
const fixtures: string[] = [];
const checksum = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
async function fixture() {
  const cache = resolve(root, "node_modules/.cache/package-tests");
  await mkdir(cache, { recursive: true });
  const directory = await mkdtemp(resolve(cache, "case-"));
  fixtures.push(directory);
  return directory;
}
afterEach(async () => {
  for (const directory of fixtures.splice(0)) {
    if (!directory.startsWith(resolve(root, "node_modules/.cache/package-tests") + sep))
      throw new Error("Invalid test cleanup path");
    await rm(directory, { recursive: true, force: true });
  }
});

describe("multi-browser release safety", () => {
  it("keeps the published Chromium IDs and the original Firefox ID", async () => {
    const chrome = await manifestFor("chrome");
    const edge = await manifestFor("edge");
    expect(publicKeyId(chrome.key)).toBe("jpapficcimnolfmdjbcfpdpfjljjaofb");
    expect(publicKeyId(edge.key)).toBe("mghdgfihlgpgnmpnacedchgbkgmbkchn");
    expect((await manifestFor("firefox")).browser_specific_settings?.gecko.id).toBe(
      "fuzevpn-firefox@vpn1euro.com",
    );
    const packageInfo = JSON.parse(await readFile(resolve(root, "package.json"), "utf8")) as {
      version: string;
    };
    expect(chrome.version).toBe(packageInfo.version);
  });

  it("produces a deterministic ZIP and checks its actual contents", () => {
    const entries = [
      ["manifest.json", Buffer.from("manifest")],
      ["assets/entry.js", Buffer.from("script")],
    ] as const;
    const zip = createZip(entries);
    expect(zip.equals(createZip([...entries].reverse()))).toBe(true);
    expect(crc32(Buffer.from("123456789"))).toBe(0xcbf43926);
    expect(readZip(zip).get("assets/entry.js")?.toString()).toBe("script");
    verifyArchive(zip, Object.fromEntries(entries.map(([name, bytes]) => [name, checksum(bytes)])));
    expect(() => verifyArchive(zip, { "manifest.json": "wrong" })).toThrow("ZIP inventory differs");
    expect(() => createZip([["../secret", Buffer.from("x")]])).toThrow("Unsafe ZIP path");
    expect(() =>
      createZip([
        ["a", Buffer.from("1")],
        ["a", Buffer.from("2")],
      ]),
    ).toThrow("Duplicate ZIP entry");
    const corrupt = Buffer.from(zip);
    const corruptOffset = 30 + "assets/entry.js".length;
    corrupt[corruptOffset] = (corrupt[corruptOffset] ?? 0) ^ 0xff;
    expect(() => readZip(corrupt)).toThrow();
  });

  it("preserves an existing version byte for byte and rejects changed or incomplete releases", async () => {
    const directory = await fixture();
    const entries = [["entry.js", Buffer.from("one")]] as const;
    const expected = { "entry.js": checksum(Buffer.from("one")) };
    const options = { directory, name: "fuzevpn-chrome-v0.9.0.zip", entries, expected };
    expect((await publishArchive(options)).preserved).toBe(false);
    const archive = resolve(directory, options.name);
    const before = await readFile(archive);
    expect((await publishArchive(options)).preserved).toBe(true);
    expect((await readFile(archive)).equals(before)).toBe(true);
    await expect(
      publishArchive({ ...options, expected: { "entry.js": checksum(Buffer.from("two")) } }),
    ).rejects.toThrow("ZIP inventory differs");
    await writeFile(resolve(directory, "fuzevpn-chrome-v0.9.0.sha256"), "invalid");
    await expect(publishArchive(options)).rejects.toThrow("checksum differs");
    await rm(resolve(directory, "fuzevpn-chrome-v0.9.0.sha256"));
    await expect(publishArchive(options)).rejects.toThrow("Incomplete existing release");
    expect((await readFile(archive)).equals(before)).toBe(true);
  });

  it("rejects output outside V2 and linked publication directories", async () => {
    await expect(safeOutput(resolve(root, "../outside.zip"))).rejects.toThrow(
      "inside ExtensionsV2",
    );
    const directory = await fixture();
    const actual = resolve(directory, "actual");
    await mkdir(actual);
    const linked = resolve(directory, "linked");
    await symlink(actual, linked, "junction");
    await expect(safeOutput(resolve(linked, "archive.zip"))).rejects.toThrow("path is a link");
  });
});
