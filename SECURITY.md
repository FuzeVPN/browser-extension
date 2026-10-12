# Security reporting

Report vulnerabilities privately. If this repository has private vulnerability
reporting enabled, use **Security → Report a vulnerability**. Otherwise contact
[FuzeVPN support](https://fuzevpn.com/en/contact.html) and identify the report as a
browser-extension security issue.

Include the extension version, browser and operating system, reproduction steps,
expected behavior and the affected protection or component. Use a synthetic
account and redact any captures or diagnostics.

Do not send account passwords, live access tokens, proxy credentials, signing
keys or a personal browser profile. Do not post those details in a public issue.

The extension protects browser traffic according to the configured proxy and site
exclusions. It does not provide an operating-system VPN. Native network tests use
isolated local fixtures; they do not establish exhaustive absence of every possible
DNS, IPv6 or WebRTC leak.

Security fixes are prepared on the current shared codebase. Reports about earlier
versions should include whether the issue also occurs on the current version.
