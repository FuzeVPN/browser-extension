# FuzeVPN browser extensions

Shared sources for desktop **Chrome, Microsoft Edge and Firefox**, licensed under **MPL-2.0**. Current extension version: **0.9.8**.

Repository: [FuzeVPN/browser-extension](https://github.com/FuzeVPN/browser-extension).

The extension configures an authenticated HTTPS proxy for browser traffic. It includes connection recovery, site exclusions, WebRTC protection, account and device management, and diagnostics with explicit consent. It does not protect other applications on the operating system.

Authentication opens the FuzeVPN client at **https://app.fuzevpn.com/extension/connect**. Google and email authentication remain on that client. The extension receives a one-use authorization code and exchanges it using PKCE; Google credentials do not enter the extension.

| Target  | Minimum desktop version                                                   | Stable identity                    |
| ------- | ------------------------------------------------------------------------- | ---------------------------------- |
| Chrome  | 116                                                                       | `jpapficcimnolfmdjbcfpdpfjljjaofb` |
| Edge    | Chromium API baseline 116; validate the installed Edge version separately | `mghdgfihlgpgnmpnacedchgbkgmbkchn` |
| Firefox | 140                                                                       | `fuzevpn-firefox@vpn1euro.com`     |

Chrome and Edge use the same compiled files except `manifest.json`. Their public manifest keys are distinct. Firefox retains its native background, proxy, authentication and Mozilla consent integration.

See the [French installation guide](docs/INSTALLATION.fr.md) for browser setup, [BUILDING.md](BUILDING.md) for reconstruction and validation, and [architecture](docs/ARCHITECTURE.md) for the shared sources and browser adapters.

## Build from source

Use Node.js 24, then run from the repository root:

```sh
npm ci
npm run validate
```

Validation builds all three distributions under `dist/chrome`, `dist/edge` and
`dist/firefox`. To build without running checks, use `npm run build`; individual
targets are available as `build:chrome`, `build:edge` and `build:firefox`.

Normal builds use the included graphics and a single lockfile. They do not need
production credentials or a personal browser profile.
Native browser tests use isolated profiles and synthetic services; their additional
requirements are described in [BUILDING.md](BUILDING.md).

## Contribute and report issues

Read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request. Report
reproducible bugs through this repository's issue form. Account and billing support
are available through [FuzeVPN support](https://fuzevpn.com/en/contact.html).

Report security vulnerabilities privately as described in [SECURITY.md](SECURITY.md).
Do not include account credentials, proxy credentials, unredacted diagnostics or
browser profiles in an issue or pull request.

The GitHub Actions workflow validates the shared project and produces all three
packages and a source archive. It does not publish a release or deploy any service.

## Repository layout

| Directory               | Purpose                                                     |
| ----------------------- | ----------------------------------------------------------- |
| `src/core/`, `src/ui/`  | Shared domain logic and interface                           |
| `src/platform/`         | Platform contracts and native adapters                      |
| `assets/`, `manifests/` | Checked-in resources and target manifests                   |
| `scripts/`, `tests/`    | Build tools, regression tests and isolated native fixtures  |
| `docs/`                 | Architecture, installation, testing and third-party notices |
| `.github/`              | Validation workflow and contribution templates              |

Generated dependencies, distributions, packages and local test outputs are excluded
from Git. The source archive contains only the files needed to build and develop
the extension. Internal store documents and confidential material are kept outside
the repository.

## License

Project sources are covered by [MPL-2.0](LICENSE). Third-party assets retain their own licenses and notices, including Archivo, country flags and public suffix data. Public extension identity keys are not private signing keys.
