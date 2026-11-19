# Brand assets

Copies of the Botyard logo, used by the READMEs in this repository and on npm.
Do not edit them by hand.

| File | Use |
| --- | --- |
| `botyard-lockup-on-dark.svg` | The lockup for dark backgrounds (GitHub dark theme). |
| `botyard-lockup-on-light.svg` | The lockup for light backgrounds (GitHub light theme). |
| `botyard-app-icon-navy.svg` | The navy app icon with rounded corners, for places that show one image on any background, such as npm, which strips `<picture>`. |

Each file is a byte-for-byte copy from the Botyard monorepo at
`be253c1ebfcb8cce84f5c83e4e11ae31e10816aa`, which generates them from one
geometry module:

| File here | Monorepo source |
| --- | --- |
| `botyard-lockup-on-dark.svg` | `brand/logos/lockup/botyard-lockup-on-dark.svg` |
| `botyard-lockup-on-light.svg` | `brand/logos/lockup/botyard-lockup-on-light.svg` |
| `botyard-app-icon-navy.svg` | `brand/logos/app-icon/botyard-app-icon-navy-full-rounded.svg` |

To update, copy the new files from the monorepo. Do not compose new variants
here; the brand rules (sizes, clear space, colours) live in the monorepo's
`brand/logos/README.md`.

npm READMEs reference these files by absolute URL pinned to a commit, so
changing a file here never changes an already published README.
