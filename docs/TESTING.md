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
  restoration, seventy complete translation catalogs and French/RTL popup and assistance.
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
IPv4 service `ipv4.icanhazip.com`. A primary request still unanswered 750 ms after it
is sent no longer holds back the fallback: both run, the first verified IPv4 wins and the other request
is cancelled. Each provider has a three-second limit within an eight-second
observation deadline. IPv6 is rejected. Each request uses the selected
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
final failure or a route change clears it, except for the address remembered for a VPN
location, described below. The IP lookup replies asynchronously and
never changes the VPN state or disables its controls. Neither service bypasses the
VPN. HTTP 429 puts that provider on a minimum thirty-second cooldown and respects a
longer `Retry-After`; another eligible provider can still answer. Manual diagnostics
retain one ipify request with their original eight-second limit.

A new tunnel refuses requests for about a second, so no measurement can be displayed
with the connected state. The extension therefore remembers the IPv4 last measured
through each location and displays it as soon as that location is connected again,
while the measurement of the new route runs on its unchanged schedule. The popup shows
that address as it shows a measured one, marked busy for assistive technologies until
the measurement ends. It is never stored, recorded or exported as a measurement: the
result replaces it, and a final failure forgets it: a credential renewal does not show
it again, nor does a later worker once the removal is written to storage, which is
attempted once. It is
kept per location and not per account, for the VPN route only, for at most thirty days
and sixty-four locations, and only a verified public IPv4 is stored or recalled. A
logout does not remove it, like the other location preferences. The first connection
to a location still waits for its measurement. The native Chromium fixture measures
both cases with a tunnel refused for 1.2 s: about 1.6 s before the address of a first
connection, and a few tens of milliseconds for a location already measured. The native
experience suite checks that no address of the user's own connection and no IPv6 reaches
local or session storage, and that the VPN IPv4 appears in this record only.

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
at most 200 entries from the last ten minutes in browser session storage. Restored
entries have no owner: a new worker discards them when it establishes the account
boundary, so an export covers the current worker lifetime. Logging and storage failures
never delay connection commands.

The ten-minute retention of the journal and of the diagnostic history is enforced by an
alarm, which starts a worker when none is running. A worker started by that alarm alone
records nothing of its own start-up, in either history, until a command or another event
reaches it. An entry would need a purge of its own ten minutes later: an idle browser
would otherwise start a worker, restore the account and query the API every ten minutes
for as long as it stays open. The worker recognises this case by an alarm that was due
before its script started.

The popup asks for the network state every five seconds. An answer which succeeds is not
written to the diagnostic history: it would fill its two hundred entries in a quarter of
an hour and call for a purge of its own. A failed one is recorded, and a success still
ends the count of the failures which preceded it. The purge alarm is set again only when
its deadline changes or after it fired, the drafts are rewritten only when a count ends,
and the diagnostics state is sent to open pages only when it differs from the one last
sent. Unit tests count the storage writes, alarm calls and broadcasts of each case; a
native Chromium check counts the history entries around five polls.

A manual connection retains its explicitly requested location from the catalogue at
the start of that operation. If the refreshed catalogue drops that row, the controller
still makes the normal signed session request for that exact target. The API decides
whether to accept it. Successful sessions retain their location metadata through the
existing session metadata cache without adding the row back to the catalogue.

Regression checks cover this catalogue change, actual API refusals, unknown targets,
automatic selection from the fresh catalogue, cancellation and fresh subscription
checks. A location already absent when the operation starts remains subject to the
normal catalogue check. The journal distinguishes local rejection from an API response.

## Lifecycle regressions

The `latent-*` unit tests reproduce states which only arise across several events: a
worker restart, a storage write which fails, two commands which overlap, or a reply which
never arrives. Where it is cheap, each failing sequence is paired with a control case.

They cover automatic retries after an ambiguous session creation or an overlapping
attempt, a reconnect alarm falling due during a manual connection, and the `blocked`
status once its guard is released. Across a worker restart they cover the cause of a
suspended protection, the guard armed for unreadable stores and an unreadable proxy
cleanup record. They also cover preferences and selections whose write fails, account
refreshes during a pending retry or a live connection, repeated proxy authentication
failures, endpoint history and WebRTC inspection in the adapters, diagnostic commands
which storage refuses, the assistance page's polling, content loading and refusal
messages, and popup replies lost after their effect, failure messages, the first
snapshot, the diagnostics control and the verification delay.

Two further suites cover a renewal alarm delivered after its session expired, which must
leave the session created meanwhile alone, and the time at which the marker of a session
nobody could name ends: kept while that session may live, ended by the next worker or the
next logout once it has expired, moved by a later unknown session only, and given to a
marker which an earlier version stored without it.

These tests use the same fakes as the other unit suites. None of them drives a real
browser: they do not replace the native browser suites.

## Account session renewal

The unit suites drive the session manager against a fake server which applies the
rotation rules of the API: one conversion per classic session, the same tokens for a
repeated request, and the end of the session for a different request made with a
retired refresh token. They cover the request stored before it is sent, lost answers
recovered by the same or the next worker, every answer of the contract (`400`, `401`,
`404`, both `409`, `429`, `5xx`, network), delays kept across workers and unaffected by
a change of the system time, concurrent requests, logout with the refresh token, and
the removal of stored tokens once their account leaves storage. The controller suites
check that an account stays signed in beyond its sign-in expiry, that a renewal failure
is a network error which leaves no proxy creation in doubt and never signs the account
out: only a refusal by the server or the end of the right to renew does.

The native `session-renewal` suite runs the built Chrome and Edge extension against a
synthetic API with the same rules: conversion at sign-in, the access token on every
account route, the tokens stored in their own record only, renewal when the popup
opens, a lost answer recovered after a real worker restart, logout with the refresh
token, and a refused renewal. It shifts the clocks of the worker instead of waiting an
hour. The other native suites answer `404` to the conversion and keep exercising classic
sessions. Firefox shares this code and its native suites run on classic sessions: no
native Firefox check converts a session. None of these checks contacts the production
API, so they do not establish that the deployed server applies the contract.

## Popup opening

The popup shows neither view until the background has said whether an account is signed
in: the sign-in view used to be painted first, then replaced. If no state arrives within
a second and a half, the popup shows that it is waiting; after ten seconds, or when the
first read fails, it shows the failure and a button which reads the state again, without
the welcome and the sign-in form. The two language catalogs are requested together, while
the background answers. The lists of locations and of devices are built when their
dialogs open.

Unit tests cover the catalog loading: both requests at once, a preload reused, another
language than the preloaded one, a preload which failed, and a failure reported to who
asked. The native `popup-regressions` suite samples the views frame by frame while a
signed-in popup opens and requires that the sign-in view is never painted, then that the
list is empty until its dialog opens. No unit test renders the popup document.

## Popup page

The native `popup-audit-fixes` suite observes the page with a mutation observer and
requires that a reply or a publication which changes nothing writes nothing, in the main
view and with each dialog open. It scripts a first read which fails, one which is slow and
one which never comes. It activates from the keyboard each control which is disabled while
its own action is pending, and requires that the control has the focus again afterwards.
The `site-exclusions-ui` suite removes sites from the keyboard and follows the focus to
the neighbour, to the previous site and to the field, and requires in Arabic, Persian, Urdu
and Pashto that no text in Arabic script is letter-spaced; the `diagnostics` suite requires
the same of the assistance page. The `web-login-ui` suite opens the home view in a window
shorter than the page needs and requires the tighter layout, then the full one again.

The Firefox suite repeats, against the real background: no text rewritten at a poll, the
focus kept by the subscription refresh, the focus given to the neighbour of a site removed
from the keyboard, and the letter spacing in the four languages. These pages are opened in
a tab: the height which a real popup window is given, zoomed or on a small screen, is not
observed by any suite.

Worker-level unit tests wait for the worker to come to rest, that is, to stop calling the
browser it was given (`tests/common/worker-settle.ts`). A wait counted in turns of the
event loop is too short on a busy machine: a worker's start hashes and reads responses,
which take time, not turns.

## Diagnostic reports refused for their session

A report which the server refuses with `401` waits for another session of its account,
and holds back the later reports of that account. The delivery state keeps a digest of
each refused token, never the token: a worker which starts recognizes a refused token and
keeps waiting, and sends with any other one, which the refusal did not concern. A state
stored by an earlier version says a session is required without saying which token was
refused: one attempt with the current token settles it. The unit suite starts successive
workers over the same stored state, with the refused token, another one, two refused
tokens, such an earlier state, and unusable digests. No native suite covers this path.

## Worker start over a protected connection

On Chromium, a worker which starts over a connection found exactly in place no longer
closes the traffic guard. The unit suites start a second controller over what the first
one left, with a guard which can attest its rules: they cover the guard kept open, with
no intermediate state published, and every case which closes it first as before: a
platform which attests nothing, altered rules, no allowance, an expired session or
account, a proxy another extension took, unreadable exclusions, protection not requested.
They also cover what closes it during the restoration: a device recovery, a failure
midway, a guard which no longer reads as open, an explicit disconnection, and a later
restoration of the same worker. The Chromium adapter tests cover the attestation itself,
which reads only and refuses any rule which differs.

The native `capacity-integration` suite stops the worker over a live connection, lets
an ordinary page send a request every ten milliseconds for a second and a half, and
requires that none fails. Firefox attests in the same way; its native suite stops the
event page under an open page which keeps sending requests, and requires that every one
passes. Both platforms also start the worker with a request which meets a proxy challenge
(`proxy-auth` on Chromium), and require that it is answered. The synthetic proxy does not
exist: these checks establish that requests are not blocked by the extension, not that
they reach a tunnel.

The suites which stop the worker note its stop when the browser reports it. Reading the
latest state of the worker afterwards misses a stop which a page undid a moment later.

## Account refresh at worker start

A worker which starts no longer reads the profile, the subscription and the catalogue
from the API when an earlier worker of the same browser session did so less than an hour
before. The unit suites start successive controllers and workers over the same session
storage. They cover the absence of any account request within the hour, at the purge
alarm included, and the kept catalogue shown from the first publication. They also cover
the refresh once it is due, its failure and its refusal by the server, the popup's
refresh and a connection, which read the API whatever the age, a restored protected
connection, and the record itself: named by a digest, never returned to another account,
removed at logout, ignored when unreadable or invalid.

These tests use fakes of the browser and of the API. No native suite measures the
requests a real worker makes when the browser restarts it.

## Development dependency audit

The project invokes Mozilla's `addons-linter` directly for Firefox validation.
Run `npm audit` to check the current lockfile, including development dependencies.
Dependency audit results apply to the versions checked at the time of execution.

The workflow runs `npm run audit:dependencies`. It fails on any advisory of high or
critical severity, as `npm audit --audit-level=high` does, except those listed in
`scripts/dependency-audit-exceptions.json`. An exception names one advisory and its
package, gives its reason and ends on a date: it is for an advisory which no released
version fixes, which would otherwise fail every commit whatever it changes. Past its
date the workflow fails again. Unit tests cover the decision; they do not query the
advisory database.
