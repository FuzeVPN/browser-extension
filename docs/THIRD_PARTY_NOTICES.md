# Licenses and attribution

FuzeVPN project code is licensed under the Mozilla Public License 2.0. Owned source
files carry `SPDX-License-Identifier: MPL-2.0`. The complete license is in `LICENSE`.
The license does not replace the following third-party notices.

| Component                   | Bundled location                                  | License and origin                                                                                                                                       |
| --------------------------- | ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Archivo variable font       | `assets/brand/fonts/archivo-latin-vf.woff2`       | SIL Open Font License 1.1; `assets/brand/fonts/OFL.txt`. Copyright 2020 The Archivo Project Authors; [Archivo](https://github.com/Omnibus-Type/Archivo). |
| flag-icons 7.3.2            | `assets/flags`                                    | MIT; original notice in `assets/flags/LICENSE.txt`, attribution in its README. [Upstream](https://github.com/lipis/flag-icons/tree/v7.3.2).              |
| Public Suffix List snapshot | `assets/vendor/public-suffix-list`                | MPL-2.0; original snapshot, notice and license retained. [Source](https://publicsuffix.org/list/public_suffix_list.dat).                                 |
| Derived public suffix rules | `src/core/shared/vendor/public-suffix-rules.json` | MPL-2.0; derivation and snapshot hashes documented in the bundled PSL README.                                                                            |

Build uses the bundled assets without fetching, redrawing or regenerating them.
`npm run generate:icons` is a separate optional authoring command.
Build dependencies and their license files are installed by `npm ci`; they are not
included in extension ZIPs or the source archive. The lockfile records their versions.
