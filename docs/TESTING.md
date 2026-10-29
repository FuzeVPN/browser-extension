# Validation scope

`npm run validate` checks formatting, TypeScript, ESLint, unit tests, all three builds,
distribution manifest and resource audits, Chrome/Edge byte parity and Mozilla `addons-linter`
validation. Build reads the supplied graphics; it does not regenerate icons.

Run `node scripts/verify-dist.mjs` separately for an independent reconstruction in memory
and a complete source-to-distribution comparison. Packaging also performs this comparison.

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

The popup measures public IPv4 through `api.ipify.org` in both direct and VPN modes.
If that request fails, hangs or returns an invalid address, it tries the plain-text
IPv4 service `ipv4.icanhazip.com`. Each provider has a three-second limit within an
eight-second observation deadline. IPv6 is rejected. Each request uses the selected
route; a refused route stops the observation without contacting another provider.

On a new VPN route, the first display probe waits 500 ms after the connected state.
If a provider fails at the transport layer (including a rejected proxy CONNECT),
that provider can be tried again in up to three rounds, with 500 ms between rounds.
The original eight-second deadline includes these waits. HTTP errors, invalid
addresses and rate limits do not trigger this loop; diagnostics and direct probes
keep their existing behavior. Connection and disconnect commands never wait for it.

The visible popup asks for an observation every five seconds. Successful measurements
remain cached for thirty seconds, so normal IP-service traffic does not increase.
A failed measurement is cached for five seconds and then measured again without
reconnecting. The last IPv4 remains visible while the same route is being checked;
final failure or a route change clears it. The IP lookup replies asynchronously and
never changes the VPN state or disables its controls. Neither service bypasses the
VPN. HTTP 429 puts that provider on a minimum thirty-second cooldown and respects a
longer `Retry-After`; another eligible provider can still answer. Manual diagnostics
retain one ipify request with their original eight-second limit.

Unit regressions cover fallback, timeouts, deduplication, route changes, IPv6 rejection,
verification refusal and bounded responses. Native Chromium and Firefox fixtures check
IPv4 fallback through authenticated CONNECT after HTTP failure, a hanging primary or
an IPv6 response. Both-provider failure leaves VPN protection and controls usable;
the popup recovers automatically when an IP service returns. The native services and
addresses are synthetic; these checks do not establish public provider availability.

## Connection progress and local failure journal

While a connection or credential refresh is in progress, the temporary traffic guard
must not replace the busy state with the recovery panel. The popup keeps progress
visible and location changes disabled while retaining the disconnect command. Actual
failures and unverified protection still show the recovery panel.

Assistance can export `fuzevpn-connection-journal.json` without running or sending a
diagnostic report. The journal records bounded state transitions, command outcomes,
catalogue membership and local/API failure classifications. It contains no account or
location identifiers, credentials, public IPs, URLs or free-form error text. It retains
at most 200 entries from the last ten minutes in browser session storage. Logging and
storage failures never delay connection commands.

A manual connection retains its explicitly requested location from the catalogue at
the start of that operation. If the refreshed catalogue drops that row, the controller
still makes the normal signed session request for that exact target. The API decides
whether to accept it. Successful sessions retain their location metadata through the
existing session metadata cache without adding the row back to the catalogue.

Regression checks cover this catalogue change, actual API refusals, unknown targets,
automatic selection from the fresh catalogue, cancellation and fresh subscription
checks. A location already absent when the operation starts remains subject to the
normal catalogue check. The journal distinguishes local rejection from an API response.

## Development dependency audit

The project invokes Mozilla's `addons-linter` directly for Firefox validation.
Run `npm audit` to check the current lockfile, including development dependencies.
Dependency audit results apply to the versions checked at the time of execution.
