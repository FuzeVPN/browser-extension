# Public Suffix List

Source: <https://publicsuffix.org/list/public_suffix_list.dat>

The unmodified source snapshot is `public_suffix_list.dat`, version
`2026-09-07_20-57-11_UTC`, commit `9fc6745c5d3f678a59af9c24de72e5eb3c300e2c`.
It includes both ICANN and private suffix rules. Retrieved 2026-09-08.
License: Mozilla Public License 2.0; see `LICENSE.txt` and the source header.

The extension embeds a derived JSON array at
`src/core/shared/vendor/public-suffix-rules.json`: non-comment, non-empty rules in
original order, converted to ASCII using the URL standard while preserving
the `!` exception and `*.` wildcard prefixes. No rule is added or removed.
There are 10,323 rules. This derived data remains under MPL 2.0.

SHA-256 of the unmodified source:
`1D7817800E1C52D5BA0A49EF379E3998BA48591EAA71E2A28CA31F363B5D3BB1`.
SHA-256 of the derived JSON:
`9514B12D27DC22F8CA1307342C89777A67EC5989E9E463B7AF170145D7ED6518`.

Domain validation is entirely local. There is no runtime request to the list
publisher, and this feature does not send excluded sites to any server.
