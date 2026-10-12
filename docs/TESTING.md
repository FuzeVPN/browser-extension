# Validation scope

`npm run validate` checks formatting, TypeScript, ESLint, unit tests, all three builds,
source-to-distribution integrity, Chrome/Edge byte parity and Mozilla `addons-linter` validation.
Build reads the supplied graphics; it does not regenerate icons.

`npm run validate:browser` runs Chrome/Chromium, Edge and Firefox **successively**.
Use `npm run validate:browser -- firefox` for the Firefox native authentication,
diagnostic consent and full network/UI suites. Browser profiles, synthetic certificates,
captures and raw reports remain under ignored `audit/local`. They are not release files.
These tests must not use an existing personal browser profile or a production account.

Firefox uses Selenium, geckodriver and an installed desktop Firefox. Chromium uses the
existing Playwright toolchain and an installed or supplied browser executable. Synthetic
TLS services require Python with `cryptography`; see `BUILDING.md` for executable
overrides. The tests intentionally map service hosts to loopback inside isolated profiles.
They do not deploy or modify the Web/API service.

## Firefox native prerequisites

Install desktop Firefox and a Python environment with `cryptography`. Set
`FIREFOX_EXECUTABLE` and `PYTHON_EXECUTABLE` when they are not found at the harness's
Windows/runtime defaults. For example, in PowerShell:

```powershell
$env:FIREFOX_EXECUTABLE = 'C:\Program Files\Mozilla Firefox\firefox.exe'
$env:PYTHON_EXECUTABLE = 'C:\path\to\python.exe'
$env:GECKODRIVER_VERSION = '0.37.1'
npm run validate:browser -- firefox
```

The `geckodriver` development dependency downloads the requested driver into the local
project cache when missing. Select version 0.37.1 for the documented toolchain. The wrapper runs
PKCE authentication, native consent, then the full network/UI suite; it stops on a
failure. The full suite also captures French and RTL views. It loads the unchanged
`dist/firefox` in a fresh profile and creates loopback TLS fixtures. Do not pass a
personal profile or disable the local write guard to run it.

## What the suites establish

- Native extension identity and PKCE callbacks; malformed, denied, cancelled, concurrent
  and late returns; state restoration without copying profile tokens.
- Proxy challenge provenance, temporary credentials, expiry and renewal; controller
  concurrency, storage recovery, account cleanup and unavailable favorite removal.
- Firefox's selected-route guard, invalid PAC, unavailable proxy, retained exclusions,
  permission revocation, WebRTC settings and release of settings on disconnect.
- Device deletion and recovery, capacity errors, catalogue loading and cached catalogue
  restoration, thirty complete translation catalogs and French/RTL popup and assistance.
- Package inventory, source correspondence, no private publication inputs, stable
  Chrome/Edge files outside the manifest and no archive replacement.

## Limits of the evidence

Synthetic proxy and DNS observations are scoped to the test browser/profile. They do not
establish exhaustive absence of OS DNS, public IPv6, STUN/TURN or every browser networking
path. The Firefox minimum version 140 is a manifest target; the actual test runtime is
recorded in the local report. Screenshots show the actual popup document at
popup width and the assistance page; toolbar anchoring is not covered.

`addons-linter` reports an Android minimum-version warning for `data_collection_permissions`
introduced on Android 142. This project targets desktop Firefox 140; the warning does
not change that desktop target.

## IP observation recovery

The IP observer retries one transient transport failure or HTTP 408/5xx response after
750 ms, through the same endpoint and within the original eight-second deadline.
Proxy ownership and protection are verified again before that request. Invalid
addresses, HTTP 429, redirects and a refused route do not authorize a retry.

The visible popup asks for an observation every five seconds. Successful measurements
remain cached for thirty seconds, so normal IP-service traffic does not increase.
A failed measurement is cached for five seconds and then measured again without
reconnecting. The observer never changes the connection state, never exempts ipify
from the VPN and never substitutes an earlier IP after a failure or route change.
HTTP 429 keeps a minimum thirty-second cooldown and respects a longer `Retry-After`.
Manual diagnostics retain their single bounded probe.

Unit regressions cover retry deduplication, route changes, verification refusal,
bounded responses and the unchanged deadline. The Chromium experience suite checks
transient recovery and automatic recovery after the IP service returns. The Firefox
network suite checks retry through its authenticated TLS proxy.

## Development dependency audit

The project invokes Mozilla's `addons-linter` directly for Firefox validation.
Run `npm audit` to check the current lockfile, including development dependencies.
Dependency audit results apply to the versions checked at the time of execution.
