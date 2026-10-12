# Contributing

This repository contains one shared extension for Chrome, Edge and Firefox.
Contributions are licensed under MPL-2.0. Preserve the existing SPDX notices and
the licenses and attribution of third-party assets.

## Development

Use Node.js 24 and install from the lockfile with `npm ci`. Read
[BUILDING.md](BUILDING.md) and [the architecture](docs/ARCHITECTURE.md).

- Keep account, session and interface behavior in `src/core` and `src/ui`.
- Place direct `chrome.*` or `browser.*` calls in the platform adapters. Firefox
  must retain its route guard, proxy authentication checks and native consent.
- Keep all thirty locale catalogs complete. Verify French and RTL views for UI
  changes.
- Preserve the public API contracts, stable extension identities and storage keys.
- Use synthetic accounts and isolated profiles for tests. Never commit tokens,
  signing keys, personal diagnostics, browser profiles or production account data.

## Pull requests

Describe the problem, the resulting behavior and the checks you ran. Add focused
regressions for behavioral or security changes. Keep generated distributions and
ZIPs out of the pull request.

Before submitting:

```sh
npm run validate
npm run audit:publication
```

Run the relevant native browser suites for changes to routing, authentication,
permissions or platform adapters. The native runners require the tools described
in BUILDING.md and never use a personal browser profile.

Packaging creates immutable versioned archives. A documentation update does not
replace an existing source ZIP; package a new version when delivering changed
sources.

## Security reports

Follow [SECURITY.md](SECURITY.md). Do not post exploit details or credentials in
public issues.
