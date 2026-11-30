# Vendored libraries

Two MIT-licensed libraries are copied here as files, unmodified, for the offer board (`lib/board/`). They are loaded through `index.js`
(which points the curves files' `@noble/hashes/...` requests at the sibling folder, only while loading). The console has no package manager.

| package | version | copied from | licence |
|---|---|---|---|
| `@noble/curves` (CommonJS build) | 1.2.0 | `eth/node_modules/@noble/curves` (a dependency of the Ethereum tooling already on disk) | MIT, `noble-curves/LICENSE` |
| `@noble/hashes` (CommonJS build) | 1.3.2 | `eth/node_modules/@noble/hashes` (the exact version `@noble/curves` 1.2.0 requires) | MIT, `noble-hashes/LICENSE` |

Only the files the board's signature and key-agreement code needs are copied (the transitive closure of `secp256k1.js`: BIP-340 Schnorr and
secp256k1 point arithmetic; SHA-256 and HMAC come with it). `package.json` of each package is kept for the version record. The `//# sourceMappingURL`
comment at the end of the .js files names a `.map` file that is not copied; it is harmless.

What the board uses from them: `schnorr.sign`, `schnorr.verify`, `schnorr.getPublicKey` (Nostr event signatures, BIP-340) and
`secp256k1.getSharedSecret` (the x coordinate of the shared point for NIP-44). Everything else (SHA-256, HMAC, HKDF steps, ChaCha20, base64)
uses Node's built-in `crypto`. No elliptic-curve or signature code is written in this repository.

Audit state, from the package's own README: `@noble/curves` was audited in February 2023 by Trail of Bits (scope: `abstract/*`, `_shortw_utils`,
`secp256k1`; the report covers version 0.7.3, and the README points to the changes since). Which exact version the audit covered is stated
there as 0.7.3; version 1.2.0 is a later one: that difference is NOT verified here.

## sha256 of every copied file (checked by `test/board-note.test.js`)

| file | sha256 |
|---|---|
| `noble-curves/LICENSE` | `4f221aee6e072336700c408c68ab3b96a3fc09f6aebe6f48f1bd99e5ef13faec` |
| `noble-curves/_shortw_utils.js` | `0d6180b48356b5244e09fcafe0de640b7d8730796826629982eb24086c2ee02f` |
| `noble-curves/abstract/curve.js` | `dd9742efb51072151df3777adc974cee481db106ffd0657683d985a096446a51` |
| `noble-curves/abstract/hash-to-curve.js` | `29ff3ec0d01787efac0d2db7dc2c90cf9e8a92302521c1082ec85eb40908f8a1` |
| `noble-curves/abstract/modular.js` | `025b510f9ef15c7a97e7a8242801801240fc8a523bf0f898f7a15b56340d4542` |
| `noble-curves/abstract/utils.js` | `eb95b7f49abcdb90b68cc24ed967c0cbde82c3c7309a3997106d56628d1f06d8` |
| `noble-curves/abstract/weierstrass.js` | `07143ec651d2e2359f6e93b4e66259a5dc925025c98a7231ea0fba6c273b0c71` |
| `noble-curves/package.json` | `bf61194229da9a7fd331fcf44cc24f746b5cbaefe941a312215376584c269bd5` |
| `noble-curves/secp256k1.js` | `84ab892cb82f761c9357edcb9c1a73810a87d6129f5cf3bd7010fe222d2f8c21` |
| `noble-hashes/LICENSE` | `4f221aee6e072336700c408c68ab3b96a3fc09f6aebe6f48f1bd99e5ef13faec` |
| `noble-hashes/_assert.js` | `0afeca6334bf56255226fae64c7110a7926bcca3d8a8f19830111da33e8f8732` |
| `noble-hashes/_sha2.js` | `837814775b82a6719cbc3009caa7c2874cc7e1ce4ec5d5b15324ccd204178614` |
| `noble-hashes/crypto.js` | `c5ee6d6553e69ba96f9a2a7f70e677bf69a6e2d52849a892e67b2e547dc96b28` |
| `noble-hashes/hmac.js` | `80bb197d112944848cedc6364e70c67bc29b557cfb422996ba9c5d92ae6ceba8` |
| `noble-hashes/package.json` | `8d8203c66e91a9e6ee510facf378a2c7420b27139360132a257010c2e5f091bc` |
| `noble-hashes/sha256.js` | `85cfee5c78d7e0df16981a848bc081f95385c2464c1e45b0818787f324ceeaa3` |
| `noble-hashes/utils.js` | `10699c217e74e7b5fd68ee4f745d9fe41ef674414b52cf860ec7c59a0a924bf4` |
