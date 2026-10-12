# Building and validating FuzeVPN 0.9.2

These instructions are the English reconstruction guide for the source archive. Run every command from the extracted repository root.

## Dependencies

Use a supported Node.js version: `^20.19.0`, `^22.13.0` or `>=24`. The qualified native Chromium toolchain uses Node.js **24.16.0**. Install dependencies from the single lockfile:

```text
npm ci
```

Install Git for the validation suites, which create synthetic repositories to test
publication safety. Building the extension alone does not require Git.

Normal builds use the checked-in assets unchanged. They do not download graphics, authenticate against production, or regenerate icons.

## Build

```text
npm run build
```

This constructs `dist/chrome`, `dist/edge` and `dist/firefox` successively. Individual builds are available:

```text
npm run build:chrome
npm run build:edge
npm run build:firefox
```

The common manifest and target overlays under `manifests/` are combined with the version in `package.json`. The `@platform` alias resolves at compilation. Browser minimum versions, permissions, background models and identities are target-specific; executable resources are shared between Chrome and Edge.

Icon regeneration is an intentional asset update, separate from reconstruction:

```text
npm run generate:icons
```

## Static and unit validation

```text
npm run validate
node scripts/validate-tests.mjs
node scripts/verify-dist.mjs
```

`validate` runs formatting, TypeScript, ESLint, unit tests, build, distribution audits and Firefox validation through Mozilla's `addons-linter` 10.13.0. This is the validator used by `web-ext` and addons.mozilla.org; the project invokes it directly without the Android tooling dependency. The evidence-producing unit runner additionally rejects out-of-project writes and reports failure if inputs change while tests execute. Tests use synthetic accounts and dependencies.

The distribution verifier reconstructs executable outputs in memory and compares every file with `dist/<target>`. It rejects stale files, unexpected files, changed sources and symbolic links. The audit checks trusted manifest profiles, thirty locale catalogs, remote execution restrictions and Chrome/Edge parity.

## Native browser validation

Native tests require existing browser/tool executables. Chromium runners do not install or download their toolchain. Exact qualified versions are recorded in `scripts/browser-toolchain.json` and `scripts/browser-toolchain-edge.json`; a mismatch stops validation before executing suites.

```text
node scripts/validate-browser.mjs chrome
node scripts/validate-browser.mjs edge
node scripts/validate-browser.mjs firefox
```

Omitting the target runs the browsers successively. Do not run native suites in parallel: local TLS fixtures and proxy ports may overlap. Chrome/Edge support targeted suites, for example:

```text
node scripts/validate-browser.mjs chrome --preflight
node scripts/validate-browser.mjs chrome web-auth-integration
```

`PLAYWRIGHT_MODULE_PATH`, `CHROMIUM_EXECUTABLE`, `EDGE_EXECUTABLE`, `FIREFOX_EXECUTABLE` and `PYTHON_EXECUTABLE` can select existing native tools. Firefox-specific requirements, including `GECKODRIVER_VERSION`, are documented in [docs/TESTING.md](docs/TESTING.md). Temporary profiles and caches are confined to this repository; a personal browser profile must never be supplied.

The native fixtures use synthetic accounts, intercepted API requests and local HTTPS services. They do not qualify production Google login, published store installations, minimum-version compatibility, or the absence of every possible DNS/WebRTC leak. Native results and input hashes are generated under ignored `audit/local/` and must not be committed.

## Packaging

After validation:

```text
npm run package
```

Outputs under ignored `releases/`:

```text
fuzevpn-chrome-v0.9.2.zip
fuzevpn-edge-v0.9.2.zip
fuzevpn-firefox-v0.9.2.zip
fuzevpn-extensions-v0.9.2-sources.zip
```

This command creates all four archives. The source packager can also be invoked independently with `node scripts/package-source.mjs`. Every archive has a matching `.sha256` file. Packaging verifies the complete distribution and ZIP inventories and never overwrites an existing version. An identical release is preserved byte for byte; a different or incomplete release requires a new version. Sources, audits, private files and publication metadata are excluded from installable ZIPs. The source ZIP contains the checked-in assets, lockfile, build tools, tests, notices and reconstruction instructions, without generated distributions or private data.

Run `npm run verify:sources` to extract the source ZIP into a local audit directory, install from its lockfile, rebuild all three targets and compare every file with the distributions. This verifies an independently extracted source archive. Store signing can change the outer store package; compare reconstructed extension contents.

No build, audit or packaging command publishes to a store, a remote Git repository, the FuzeVPN client or its API.
