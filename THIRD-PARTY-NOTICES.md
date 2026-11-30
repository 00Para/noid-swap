# Third-party notices

The code and documents written for this repository are under the MIT License (`LICENSE`).
The following parts are not, or derive from code that is not.

## `vendor/parano1d` — Apache License 2.0

`vendor/parano1d/` is an unmodified copy of the Parano1d source tree, upstream
`ignotusnemo/parano1d` at commit `d29b8016c3c120312814f52d7f8a8ffef5523b80` (2026-10-30). The copy
leaves out the upstream `research/` directory and the `.git` metadata to stay small;
`scripts/fetch-vendor.sh` restores the complete tree at the same commit.

Parano1d is licensed under the Apache License, Version 2.0: `vendor/parano1d/LICENSE`, with
`license = "Apache-2.0"` in its workspace manifest (the crates `noid_ivc_core` and `noid_ivc_prover`
declare `MIT OR Apache-2.0`). That license allows copying, redistribution and derivative works
on three conditions that this repository meets: the license text travels with the copy
(`vendor/parano1d/LICENSE`), the upstream `NOTICE` file travels with it and is reproduced below
(`vendor/parano1d/NOTICE`), and modified files carry a prominent notice of the change (nothing under
`vendor/` is modified; the one test-only patch is kept as a patch file, see below).

Upstream `NOTICE`, reproduced verbatim:

```
Parano1d
Copyright 2026 Paranoid Zero
Designed and developed by Ignotus Nemo

Portions of the binary-field implementation are derived from hekate-math:
https://github.com/oumuamua-labs/hekate-math

hekate-math
Copyright 2026 Andrei Kochergin and Oumuamua Labs.

Portions of the field, multilinear-extension, sumcheck, and tensor-algebra
implementation are adapted from binius64:
https://github.com/binius-zk/binius64

Copyright (c) 2025 The Binius Developers
Copyright (c) 2025 Irreducible, Inc.

Portions of the Ligerito polynomial-commitment implementation are ported from
bolt-rs:
https://github.com/bcc-research/bolt-rs

Copyright (c) 2026 Bain Capital Crypto, LP and Ron Rothblum
Modifications copyright 2026 Succinct Labs, Benedikt Bunz, William Wang
```

### Files in this repository that derive from the vendored code

| Path | Relation to `vendor/parano1d` | License |
|---|---|---|
| `equiv/portable/` | Zero-dependency reimplementation of the Poseidon2b permutation, the `Addr` sponge and `Derive`. Its round constants, MDS factors, domain IV, padding and basis tables are copied from `noid_poseidon2b` and `noid_node/src/wallet/keystore.rs`; the file headers cite the exact source lines. | Apache-2.0 (its `Cargo.toml`) |
| `eth/contracts/Poseidon2b.sol`, `eth/contracts/HTLCPoseidon.sol` | Generated from `equiv/portable` by `eth/scripts/poseidon/gen.js`; the same constants on the EVM. | MIT header; the constants remain subject to the Apache-2.0 notice above |
| `parano1d/patches/q2-n2-tests.patch` | A test-only patch against two vendored files (the Q2 negative test). Never applied in tree; the patch file is the modification notice Apache-2.0 asks for. | Apache-2.0 for the patched hunks |
| `parano1d/harness/`, `swap-cli/` | Link against the vendored crates by path. No vendored code is copied. | MIT |
| `equiv/reference/`, `equiv/zkvm/` (`core`, `guest`, `host`) | Link against the vendored crates by path (`reference`) or reimplement the permutation (`zkvm`). No vendored code is copied. | Apache-2.0 (their own `Cargo.toml`) |

## Typefaces in `ui/app/fonts/` (SIL Open Font License 1.1)

Two variable-weight typefaces, unmodified (only the file names were changed), served by the operator console from its own
folder. The licence texts sit beside the files and travel with them; sources, commits and checksums are in
`ui/app/fonts/README.md`.

| Typeface | File | Copyright | Source (commit) | Licence text |
|---|---|---|---|---|
| Space Grotesk (variable weight) | `ui/app/fonts/SpaceGrotesk-wght.woff2` | Copyright 2020 The Space Grotesk Project Authors | `https://github.com/floriankarsten/space-grotesk` (`03507d024a01282884232081fc6011c09ff4e849`) | `ui/app/fonts/SpaceGrotesk-OFL.txt` |
| JetBrains Mono (variable weight) | `ui/app/fonts/JetBrainsMono-wght.woff2` | Copyright 2020 The JetBrains Mono Project Authors | `https://github.com/JetBrains/JetBrainsMono` (`19371302b95d218af43299bce79ddbddd0bc364d`) | `ui/app/fonts/JetBrainsMono-OFL.txt` |

## Libraries in `ui/app/vendor/` (MIT License)

Two libraries, copied as files without change for the offer board (the files used, their checksums and what the board uses
from them are in `ui/app/vendor/VENDORED.md`). Each folder keeps its `LICENSE`, which travels with the copy.

| Package | Version | Copyright | Source | Licence text |
|---|---|---|---|---|
| `@noble/curves` (CommonJS build) | 1.2.0 | Copyright (c) 2022 Paul Miller | `https://github.com/paulmillr/noble-curves` | `ui/app/vendor/noble-curves/LICENSE` |
| `@noble/hashes` (CommonJS build) | 1.3.2 | Copyright (c) 2022 Paul Miller | `https://github.com/paulmillr/noble-hashes` | `ui/app/vendor/noble-hashes/LICENSE` |

## Other dependencies

Node packages (`eth/`, `btc/`) and Rust crates (the `Cargo.lock` files) are fetched at
build time under their own licenses and are not redistributed here. The RISC Zero zkVM used by
`equiv/zkvm` is Apache-2.0. Hardhat, ethers and the Solidity compiler are MIT.
