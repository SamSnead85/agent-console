# Third-party notices

Agent Console is © LockedIn Labs and released under the [MIT licence](LICENSE).
It has no runtime or development dependencies and contains no third-party code.
The package does ship a few third-party assets; each is listed here with its
licence and where it lives.

## Fonts

| Asset | Files | Copyright | Licence |
| --- | --- | --- | --- |
| IBM Plex Sans, Latin subset, weights 300, 400, 500, 600 | `public/fonts/ibm-plex-sans-latin-*-normal.woff2` | © 2019 IBM Corp. | SIL Open Font License 1.1 |
| IBM Plex Mono, Latin subset, weights 400, 500 | `public/fonts/ibm-plex-mono-latin-*-normal.woff2` | © 2017 IBM Corp. | SIL Open Font License 1.1 |

The files are byte-for-byte those published by [Fontsource](https://fontsource.org)
in `@fontsource/ibm-plex-sans` 5.3.0 and `@fontsource/ibm-plex-mono` 5.3.0. The
full licence text, with both copyright notices, ships beside them in
[`public/fonts/LICENSE-OFL.txt`](public/fonts/LICENSE-OFL.txt). Under the OFL the
fonts may be used, redistributed and embedded freely, but may not be sold on
their own.

## Vendor marks

| Mark | Where | Source of the drawing | Owner |
| --- | --- | --- | --- |
| Anthropic | `public/index.html` (`#mk-anthropic`) | [Simple Icons](https://simpleicons.org), CC0 1.0 | Anthropic |
| OpenAI | `public/index.html` (`#mk-openai`) | [Simple Icons](https://simpleicons.org) 13.x, CC0 1.0 | OpenAI |

These marks are trademarks of their owners. Agent Console draws them only to
identify which company made a model in the usage it shows. Using them implies no
affiliation with or endorsement by either company. Simple Icons releases its SVG
path data under CC0 1.0; that dedication covers the drawing, not the trademark.

## Data

`lib/collector/prices.json` and `lib/prices.js` hold the vendors' published
per-token list prices. Each row in `prices.json` names the pricing page it was
read from and the date it was checked. They are reproduced so the console can
estimate cost offline, and they are not a quote or an invoice.

## LockedIn Labs' own assets

The LockedIn Labs mark (`public/brand/mark.svg`, `public/favicon.svg`, the
`public/icon-*.png` app icons, the symbol in `public/index.html`, and the
README's light and dark versions in `docs/brand/`) and the screenshots in
`docs/` are LockedIn Labs' own. The screenshots show demo mode,
so every figure in them is generated. The MIT licence covers them along with
the code. The LockedIn Labs name and mark still identify LockedIn Labs, so if
you publish a modified version, please give it its own name and mark.
