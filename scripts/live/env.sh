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
#     (NOID_RPC2 / ETH_RPC2 below) or --single-node-ok, which the helpers pass when a second node is missing and
#     WARN about on every call (REVIEW-4 R4-8): a run with a stranger needs BOTH second nodes
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
NOID_RPC2=${NOID_RPC2:-}                             # a second, distinct Parano1d node (F5); empty = --single-node-ok
ETH_RPC=${ETH_RPC:-https://ethereum-sepolia-rpc.publicnode.com}
ETH_RPC2=${ETH_RPC2:-}                               # a second, distinct Ethereum node (F5); empty = --single-node-ok
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
ALICE_FILE="$L/alice.swap.json"; BOB_FILE="$L/bob/bob.swap.json"
[ -f "$L/env.local.sh" ] && . "$L/env.local.sh"
export WSLENV="ETH_RPC_URL${WSLENV:+:$WSLENV}"     # live.js reads ETH_RPC_URL; WSLENV carries it into Windows node
export ETH_RPC_URL="$ETH_RPC"

# --- helpers shared by the scripts
swap_file() { case "$1" in alice) echo "$ALICE_FILE";; bob) echo "$BOB_FILE";; *) echo "role must be alice or bob" >&2; return 2;; esac; }
load_passphrase() { [ -s "$L/passphrase.txt" ] || { echo "no $L/passphrase.txt (run setup.sh)" >&2; return 2; }; export SWAP_PASSPHRASE="$(cat "$L/passphrase.txt")"; }
# Node flags for swap-cli: one or two endpoints per chain; --single-node-ok only when no second node is configured.
node_flags() {
  single_node_warning   # REVIEW-4 R4-8: said on EVERY call (every tick, every claim), not once in setup
  local f=(--transport curl --noid-rpc "$NOID_RPC" --eth-rpc "$ETH_RPC" --rpc-timeout "$RPC_TIMEOUT")
  if [ -n "$NOID_RPC2" ]; then f+=(--noid-rpc "$NOID_RPC2"); fi
  if [ -n "$ETH_RPC2" ]; then f+=(--eth-rpc "$ETH_RPC2"); fi
  if [ -z "$NOID_RPC2" ] || [ -z "$ETH_RPC2" ]; then f+=(--single-node-ok); fi
  printf '%s\n' "${f[@]}"
}
# --eth-from-block from $L/eth-deploy-block.txt when it exists (the flag wins over the stored value and is stored again).
from_block_flags() { if [ -s "$L/eth-deploy-block.txt" ]; then echo "--eth-from-block"; tr -dc '0-9' < "$L/eth-deploy-block.txt"; echo; fi; }
# A WSL path as Windows node sees it (\\wsl.localhost\...): live.js --swap FILE needs it.
win_path() { wslpath -w "$1"; }
require_parties() { for v in ALICE_NOID BOB_NOID ALICE_ETH BOB_ETH CONTRACT; do [ -n "${!v}" ] || { echo "$v is not set: put the four party addresses and CONTRACT in $L/env.local.sh" >&2; return 2; }; done; }
single_node_warning() { if [ -z "$NOID_RPC2" ] || [ -z "$ETH_RPC2" ]; then echo "WARNING: one node per chain (--single-node-ok): the F5 cross-checks are OFF (no second Parano1d node for the lock, no second Ethereum node for the reveal or the secret). Fine against a counterparty you control; a swap with a STRANGER needs BOTH NOID_RPC2 and ETH_RPC2 in $L/env.local.sh" >&2; fi; }
