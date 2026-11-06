# Mainnet retirement proof

`mainnet-retirement.origin` contains the actual legacy HistoryStep terminal at block 210536 and its matrix retirement proof. Matrix-free mainnet executables include these bytes and verify the complete proof under the independently pinned legacy keys at startup. The verified proof is retained locally for ordinary P2P serving. State, headers and subsequent terminals pass their existing verification paths.

The proof was generated from the frozen canonical legacy matrices and verified without loading either matrix. Its SHA-256 is `845dd84a21f47ddc85e2125ddb93203447d1f5278e0bc8e32bd6056c81cdeabf`.

Isolated testnet builds use their own fork origins and omit this mainnet artifact.
