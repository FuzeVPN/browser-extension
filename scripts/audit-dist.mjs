// SPDX-License-Identifier: MPL-2.0

import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { CHROME_LOCALE_DIRECTORIES } from "./supported-locales.mjs";
import { distributionDirectory, manifestFor, selectTargets } from "./targets.mjs";
import { canonical, inventory, verifyChromiumParity } from "./verify-dist.mjs";
import { projectRoot } from "./validation-common.mjs";

export async function auditDist(target) {
  const directory = distributionDirectory(target);
  const manifest = JSON.parse(await readFile(resolve(directory, "manifest.json"), "utf8"));
  const expected = await manifestFor(target);
  if (JSON.stringify(manifest) !== JSON.stringify(expected))
    throw new Error(`${target}: manifest differs from trusted profile`);
  if (
    manifest.content_scripts ||
    manifest.externally_connectable ||
    manifest.web_accessible_resources
  )
    throw new Error(`${target}: unexpected external execution or messaging capability`);
  const localeRoot = resolve(directory, "_locales");
  if (
    canonical((await readdir(localeRoot)).sort()) !==
    canonical([...CHROME_LOCALE_DIRECTORIES].sort())
  )
    throw new Error(`${target}: unexpected locale directories`);
  const english = JSON.parse(await readFile(resolve(localeRoot, "en/messages.json"), "utf8"));
  for (const language of CHROME_LOCALE_DIRECTORIES) {
    const catalog = JSON.parse(
      await readFile(resolve(localeRoot, language, "messages.json"), "utf8"),
    );
    if (canonical(Object.keys(catalog).sort()) !== canonical(Object.keys(english).sort()))
      throw new Error(`${target}/${language}: locale keys differ`);
    for (const [key, entry] of Object.entries(catalog)) {
      if (
        typeof entry.message !== "string" ||
        !entry.message.trim() ||
        /chrome/i.test(key + entry.message)
      )
        throw new Error(`${target}/${language}/${key}: invalid or browser-specific locale text`);
      if (
        canonical(entry.message.match(/\$[1-9]/g)?.sort() ?? []) !==
        canonical(english[key].message.match(/\$[1-9]/g)?.sort() ?? [])
      )
        throw new Error(`${target}/${language}/${key}: locale substitutions differ`);
    }
  }
  const suffixLiterals = JSON.parse(
    await readFile(resolve(projectRoot, "src/core/shared/vendor/public-suffix-rules.json"), "utf8"),
  ).filter((domain) => /\b(analytics|telemetry|tracker)\b/i.test(domain));
  const files = await inventory(directory);
  for (const name of Object.keys(files)) {
    if (
      /(?:^|\/)(?:prive|private|audit|reference|publication|node_modules|\.git)(?:\/|$)/i.test(name)
    )
      throw new Error(`Forbidden distribution directory: ${name}`);
    if (/\.(?:map|pem|key|env)$/i.test(name))
      throw new Error(`Forbidden distribution file: ${name}`);
    if (!/\.(?:js|html|css|json|md|txt)$/i.test(name)) continue;
    let text = await readFile(resolve(directory, name), "utf8");
    if (name.endsWith(".js"))
      for (const domain of suffixLiterals)
        text = text.replaceAll(JSON.stringify(domain), '"PSL-domain"');
    const forbidden = [
      /\beval\s*\(/,
      /new\s+Function\s*\(/,
      /<script[^>]+src=["']https?:/i,
      /\b(analytics|telemetry|tracker)\b/i,
      /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
      name === "background/service-worker.js"
        ? /\b(?:chrome|browser)\.(?:tabs\b(?!\.get\()|history\b|cookies\b|scripting\b)/
        : /\b(?:chrome|browser)\.(?:tabs|history|cookies|scripting)\b/,
    ];
    for (const pattern of forbidden)
      if (pattern.test(text)) throw new Error(`${target}/${name}: forbidden ${pattern}`);
  }
  return { target, version: manifest.version, files: Object.keys(files).length, passed: true };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const targets = selectTargets();
  for (const target of targets)
    process.stdout.write(`${JSON.stringify(await auditDist(target))}\n`);
  if (targets.includes("chrome") && targets.includes("edge"))
    process.stdout.write(`Chromium parity: ${JSON.stringify(await verifyChromiumParity())}\n`);
}
