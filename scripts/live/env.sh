#!/usr/bin/env bash
# Per-run settings for the live helpers (sourced by every script in this folder). Nothing here is secret.
# Change RUN for a new run; everything else is derived or has a sane default. A file $L/env.local.sh, if
# present, is sourced last and may override any variable (second nodes, another RPC, a Mac's paths).
#
# What the next live run must do differently from run 3 (REVIEW-3 fixes of 2026-11-05):
#   - a read-only `tick` (no --apply) no longer prints a spend's parameters: the watch loop runs with --apply
#   - `live.js lock/claim/refund` take --swap FILE: they fill and check every term and the recorded intent
#   - --eth-code-hash and --pinned-image-id are not needed any more (compiled into the binary)
#   - under the `sepolia` profile Bob's lock and Alice's reveal need a SECOND node for each chain
#     (NOID_RPC2 / ETH_RPC2 below) or --single-node-ok. REVIEW-5 (R4-8 remainder): the helpers pass --single-node-ok ONLY when
#     SINGLE_NODE_OK=1 is set in $L/env.local.sh (you accept one node per chain; said loudly on every call). Without it and
#     without the second nodes nothing is passed, and the engine WAITS before Bob's lock and Alice's reveal. A run with a
#     stranger needs BOTH second nodes and no SINGLE_NODE_OK
#   - --eth-from-block is given once; `tick --apply` stores it in the swap file
RUN=${RUN:-4}
L="${L:-$HOME/live-run-$RUN}"                      # swap files, passphrase, records, logs (WSL ext4, mode 700)
BIN="${BIN:-$HOME/noid-target/release/swap-cli}"
EQ="${EQ:-$HOME/noid-target/release/equiv-prove}"
CURL=${CURL:-/mnt/c/Windows/System32/curl.exe}       # WSL reaches Windows services only through curl.exe
NODE="${NODE:-/mnt/c/Program Files/nodejs/node.exe}" # Windows node runs eth/scripts/live.js
ETH_DIR=${ETH_DIR:-/mnt/c/Users/00/Documents/noid-swap/eth}
PUB=${PUB:-/mnt/c/Users/00/Documents/live-run-$RUN}  # Windows-side copies for the owner (bundle, object, receipts)
NOID_RPC=${NOID_RPC:-http://127.0.0.1:9601}          # the wallet app's node
NOID_RPC2=${NOID_RPC2:-}                             # a second, distinct Parano1d node (F5); empty = Bob's lock waits (unless SINGLE_NODE_OK=1)
ETH_RPC=${ETH_RPC:-https://ethereum-sepolia-rpc.publicnode.com}
ETH_RPC2=${ETH_RPC2:-}                               # a second, distinct Ethereum node (F5); empty = Alice's reveal waits (unless SINGLE_NODE_OK=1)
SINGLE_NODE_OK=${SINGLE_NODE_OK:-0}                  # 1 = pass --single-node-ok (waive the F5 second-node rule); opt-in, set it in env.local.sh
PROFILE=${PROFILE:-sepolia}
CHAIN=${CHAIN:-11155111}
CONTRACT=${CONTRACT:-}                               # the HTLC address on $CHAIN: set it in $L/env.local.sh (no default on purpose)
RPC_TIMEOUT=${RPC_TIMEOUT:-60}
# Parties: no defaults on purpose (the repository names no wallet). Set the four in $L/env.local.sh:
#   ALICE_NOID=o1...  BOB_NOID=o1...  ALICE_ETH=0x...  BOB_ETH=0x...
ALICE_NOID=${ALICE_NOID:-}
BOB_NOID=${BOB_NOID:-}
ALICE_ETH=${ALICE_ETH:-}
BOB_ETH=${BOB_ETH:-}
AMOUNT=${AMOUNT:-10000000}                           # micro-NOID (10 NOID)
WEI=${WEI:-1000000000000000}                         # 0.001 ETH
VARIANT=${VARIANT:-raw}
CONTRACT_VERSION=${CONTRACT_VERSION:-1}
# The Ethereum lock (swap-cli --eth-lock-kind): sha256 = HTLC.sol keyed on SHA-256(s), Bob needs the equivalence receipt; poseidon =
# HTLCPoseidonV2.sol keyed on A = Addr(s), raw variant only, NO proof and NO receipt (prepare.sh skips both), CONTRACT must be a
# HTLCPoseidonV2 deployment (node scripts/live.js deploy --contract-kind poseidon). The reveal then costs about 0.5 M gas: Alice's ETH
# address must hold 1,000,000 x the fee cap (docs/poseidon-leg.md section 5).
LOCK_KIND=${LOCK_KIND:-sha256}
ALICE_FILE="$L/alice.swap.json"; BOB_FILE="$L/bob/bob.swap.json"
[ -f "$L/env.local.sh" ] && . "$L/env.local.sh"
export WSLENV="ETH_RPC_URL${WSLENV:+:$WSLENV}"     # live.js reads ETH_RPC_URL; WSLENV carries it into Windows node
export ETH_RPC_URL="$ETH_RPC"

# --- helpers shared by the scripts
swap_file() { case "$1" in alice) echo "$ALICE_FILE";; bob) echo "$BOB_FILE";; *) echo "role must be alice or bob" >&2; return 2;; esac; }
load_passphrase() { [ -s "$L/passphrase.txt" ] || { echo "no $L/passphrase.txt (run setup.sh)" >&2; return 2; }; export SWAP_PASSPHRASE="$(cat "$L/passphrase.txt")"; }
# Node flags for swap-cli: one or two endpoints per chain; --single-node-ok ONLY when SINGLE_NODE_OK=1 (REVIEW-5, opt-in).
node_flags() {
  single_node_warning   # said on EVERY call (every tick, every claim), not once in setup
  local f=(--transport curl --noid-rpc "$NOID_RPC" --eth-rpc "$ETH_RPC" --rpc-timeout "$RPC_TIMEOUT")
  if [ -n "$NOID_RPC2" ]; then f+=(--noid-rpc "$NOID_RPC2"); fi
  if [ -n "$ETH_RPC2" ]; then f+=(--eth-rpc "$ETH_RPC2"); fi
  if [ "$SINGLE_NODE_OK" = 1 ] && { [ -z "$NOID_RPC2" ] || [ -z "$ETH_RPC2" ]; }; then f+=(--single-node-ok); fi
  printf '%s\n' "${f[@]}"
}
# live.js fee flags for the Ethereum spends (REVIEW-5 R5-8): MAX_FEE_GWEI = mainnet cap (--mainnet --max-fee-gwei), else GAS_PRICE_GWEI on a test chain.
fee_flags() {
  if [ -n "${MAX_FEE_GWEI:-}" ]; then printf '%s\n' --mainnet --max-fee-gwei "$MAX_FEE_GWEI"
  elif [ -n "${GAS_PRICE_GWEI:-}" ]; then printf '%s\n' --gas-price-gwei "$GAS_PRICE_GWEI"; fi
}
# --eth-from-block from $L/eth-deploy-block.txt when it exists (the flag wins over the stored value and is stored again).
from_block_flags() { if [ -s "$L/eth-deploy-block.txt" ]; then echo "--eth-from-block"; tr -dc '0-9' < "$L/eth-deploy-block.txt"; echo; fi; }
# REVIEW-6 R6-3: --reveal-tx HASH for swap-cli tick / claim when reveal.sh saw its claim MINED AND REVERTED (the secret is public although no
# Claimed event exists): the hash is in $L/reveal-reverted-tx.txt. swap-cli reads the transaction and its receipt from the node, checks it is
# a claim of THIS lock from alice_receiver whose preimage opens the lock word, and only then records "the secret is public" (Alice's late
# re-send cutoff) and offers the secret to Bob. A typed hash is never trusted by itself.
#
# REVIEW-7 R7-6: the file's content is validated EXACTLY (`0x` + 64 hex digits, nothing else but surrounding whitespace). Anything else (an
# `x` among the digits, two lines, a word) is IGNORED with a warning on stderr and no --reveal-tx is passed, so a malformed file can never
# stop a tick or a claim (swap-cli rejects a malformed --reveal-tx before it polls anything, Bob's NOID claim included). Fix or delete the file.
reveal_tx_flags() {
  [ -s "$L/reveal-reverted-tx.txt" ] || return 0
  local h; h=$(tr -d ' \t\r\n' < "$L/reveal-reverted-tx.txt" 2>/dev/null)
  if [[ "$h" =~ ^0x[0-9a-fA-F]{64}$ ]]; then
    echo "--reveal-tx"; echo "$h"
  else
    echo "WARNING: $L/reveal-reverted-tx.txt does not hold one transaction hash (0x + 64 hex digits): it is IGNORED and no --reveal-tx is passed. Fix or delete it (the reverted claim it should name is not being checked)" >&2
  fi
}
# A WSL path as Windows node sees it (\\wsl.localhost\...): live.js --swap FILE needs it.
win_path() { wslpath -w "$1"; }
require_parties() { for v in ALICE_NOID BOB_NOID ALICE_ETH BOB_ETH CONTRACT; do [ -n "${!v}" ] || { echo "$v is not set: put the four party addresses and CONTRACT in $L/env.local.sh" >&2; return 2; }; done; }
single_node_warning() {
  [ -n "$NOID_RPC2" ] && [ -n "$ETH_RPC2" ] && return 0
  if [ "$SINGLE_NODE_OK" = 1 ]; then
    echo "WARNING: one node per chain and SINGLE_NODE_OK=1 (--single-node-ok): the F5 cross-checks are OFF (no second Parano1d node for the lock, no second Ethereum node for the reveal or the secret). Fine against a counterparty you control; a swap with a STRANGER needs BOTH NOID_RPC2 and ETH_RPC2 in $L/env.local.sh and no SINGLE_NODE_OK" >&2
  else
    echo "NOTE: no second node for $([ -z "$NOID_RPC2" ] && echo "Parano1d (NOID_RPC2)")$([ -z "$NOID_RPC2" ] && [ -z "$ETH_RPC2" ] && echo " and ")$([ -z "$ETH_RPC2" ] && echo "Ethereum (ETH_RPC2)"), and SINGLE_NODE_OK is not 1: --single-node-ok is NOT passed, so the engine will WAIT before Bob's lock and before Alice's reveal (F5) until the second nodes are in $L/env.local.sh (or, for a run against a counterparty you control, SINGLE_NODE_OK=1 there)" >&2
  fi
}
