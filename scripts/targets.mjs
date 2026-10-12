// SPDX-License-Identifier: MPL-2.0

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { assertInsideProject, projectRoot } from "./validation-common.mjs";

export const TARGETS = ["chrome", "edge", "firefox"];
export const EXPECTED_IDENTITIES = {
  chrome: "jpapficcimnolfmdjbcfpdpfjljjaofb",
  edge: "mghdgfihlgpgnmpnacedchgbkgmbkchn",
  firefox: "fuzevpn-firefox@vpn1euro.com",
};

export function assertTarget(target) {
  if (!TARGETS.includes(target)) throw new Error(`Unknown build target: ${target}`);
  return target;
}

export function selectTargets(args = process.argv.slice(2)) {
  if (args.length > 1) throw new Error("Select one browser or omit the argument for all browsers.");
  return args.length ? [assertTarget(args[0])] : [...TARGETS];
}

export function distributionDirectory(target) {
  return assertInsideProject(resolve(projectRoot, "dist", assertTarget(target)));
}

export function publicKeyId(key) {
  if (typeof key !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(key))
    throw new Error("Invalid public manifest key");
  const bytes = Buffer.from(key, "base64");
  if (bytes.toString("base64") !== key) throw new Error("Noncanonical public manifest key");
  const hash = createHash("sha256").update(bytes).digest("hex").slice(0, 32);
  return [...hash].map((character) => "abcdefghijklmnop"[Number.parseInt(character, 16)]).join("");
}

export async function manifestFor(target) {
  assertTarget(target);
  const readJson = async (name) => JSON.parse(await readFile(resolve(projectRoot, name), "utf8"));
  const [common, overlay, packageInfo] = await Promise.all([
    readJson("manifests/common.json"),
    readJson(`manifests/${target}.json`),
    readJson("package.json"),
  ]);
  if (!/^\d+\.\d+\.\d+$/.test(packageInfo.version)) throw new Error("Invalid release version");
  const manifest = { ...common, ...overlay, version: packageInfo.version };
  if (target === "firefox") {
    if (manifest.browser_specific_settings?.gecko?.id !== EXPECTED_IDENTITIES.firefox)
      throw new Error("Firefox identity differs from the existing add-on");
    if (manifest.key || manifest.background.service_worker)
      throw new Error("Chromium capabilities in Firefox manifest");
  } else {
    if (publicKeyId(manifest.key) !== EXPECTED_IDENTITIES[target])
      throw new Error(`${target} manifest key derives an unexpected runtime identity`);
    if (manifest.browser_specific_settings || manifest.background.scripts)
      throw new Error("Firefox capabilities in Chromium manifest");
    manifest.version_name = packageInfo.version;
  }
  return manifest;
}

export function manifestBytes(manifest) {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}
