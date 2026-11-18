# Brand assets

Copies of the Botyard logo, used by the READMEs in this repository and on npm.
Do not edit them by hand.

| File | Use |
| --- | --- |
| `botyard-lockup-on-dark.svg` | The lockup for dark backgrounds (GitHub dark theme). |
| `botyard-lockup-on-light.svg` | The lockup for light backgrounds (GitHub light theme). |
| `botyard-lockup-tile.svg` | The on-dark lockup on a navy tile, for places that show one image on any background, such as npm, which strips `<picture>`. |

The two lockups are byte-for-byte copies of `brand/logos/lockup/` in the Botyard
monorepo at `be253c1ebfcb8cce84f5c83e4e11ae31e10816aa`, which generates them
from one geometry module. The tile wraps the unchanged on-dark lockup with the
brand's 0.5M clear space. To update, copy the new lockups and rebuild the tile
the same way; the brand rules (sizes, clear space, colours) live in the
monorepo's `brand/logos/README.md`.

npm READMEs reference these files by absolute URL pinned to a commit, so
changing a file here never changes an already published README.
