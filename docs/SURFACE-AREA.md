# Repository Surface Area: Live Mainnet vs. Experimental

This document draws a hard boundary between the code shipped for live NOID <-> ETH swaps and prototype/legacy components kept in the repository.

## 1. Live Mainnet Swap Surface

| Path | Role |
|---|---|
| `eth/contracts/HTLCPoseidonV2.sol`, `eth/contracts/Poseidon2b.sol` | Mainnet Ethereum HTLC verifying `Addr(s)` via stack-only Yul Poseidon2b (no admin keys, no `addrOf` view, pinned runtime code hash). |
| `parano1d/contracts/htlc.pruv`, `parano1d/harness/` | Parano1d contract definition, opening builder, and prover/verifier harness. |
| `swap-cli/` | Core swap state machine, watchers, wallet/key sealing and claims. |
| `eth/scripts/live.js`, `eth/scripts/bounded-send.js`, `eth/scripts/poseidon/poseidon2b.js` | Ethereum transaction helper packaged alongside `swap-cli` in desktop builds. |
| `ui/app/`, `desktop/` | Hardened Electron desktop shell and local operator UI. |
| `vendor/parano1d/` | Unmodified upstream Parano1d crates pinned by diff check. |

## 2. Experimental / Quarantined (Not Shipped for Mainnet)

| Path | Status |
|---|---|
| `btc/` | Signet-only Bitcoin P2WSH prototype. Not packaged in desktop builds; not cleared for Bitcoin mainnet. |
| `equiv/` | RISC-Zero equivalence prover for the legacy SHA-256 `HTLC.sol` / BTC path. Not used by live `HTLCPoseidonV2` swaps. |
| `eth/contracts/HTLCPoseidon.sol` | Earlier prototype containing an `addrOf(bytes32)` view function; kept for reference/test compatibility only — never deploy for live swaps (use `HTLCPoseidonV2.sol`). |
| `eth/contracts/HTLC.sol`, `eth/contracts/HTLCERC20.sol` | Legacy SHA-256 / ERC-20 contracts; mainnet NOID <-> ETH uses `HTLCPoseidonV2.sol`. |
| `scripts/live/` | Legacy shell wrapper scripts for terminal-only runs; desktop program mode is primary. |
