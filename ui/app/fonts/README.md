# Typefaces of the operator page

Two font files, unmodified, each under the SIL Open Font License 1.1 (the licence texts are beside them). They are served by
`ui/app/server.js` at `/fonts/…` because the page's content policy allows no other origin; nothing else in this folder is served.

| File | Typeface | Upstream | Commit | Upstream path | SHA-256 |
|---|---|---|---|---|---|
| `SpaceGrotesk-wght.woff2` | Space Grotesk (variable weight) | `https://github.com/floriankarsten/space-grotesk` | `03507d024a01282884232081fc6011c09ff4e849` | `fonts/woff2/SpaceGrotesk[wght].woff2` | `8e085aa438094f11487a836652edd5c054fa6a96f63fc7c282105ee3a4b08c07` |
| `JetBrainsMono-wght.woff2` | JetBrains Mono (variable weight) | `https://github.com/JetBrains/JetBrainsMono` | `19371302b95d218af43299bce79ddbddd0bc364d` | `fonts/webfonts/JetBrainsMono[wght].woff2` | `31ec365b93e4bad6f202ce23352a56d01ca4462b2afc782ed2cf6fa42ca9ac0e` |

Licence texts: `SpaceGrotesk-OFL.txt` (Copyright 2020 The Space Grotesk Project Authors) and `JetBrainsMono-OFL.txt`
(Copyright 2020 The JetBrains Mono Project Authors), both copied from the same commits. Only the file names were changed
(the brackets removed); the font data is byte for byte the upstream file.

Both are listed in `THIRD-PARTY-NOTICES.md` at the repository root.
