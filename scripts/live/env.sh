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
#
# Platform (LIVE_PLATFORM=wsl|native, set in the environment or as a plain assignment line in $L/env.local.sh (read as text, early, not run); default: wsl when `wslpath` exists and /mnt/c is a
# folder, else native). Under wsl every default below is the run-3 one (Windows curl.exe and node.exe through WSL interop). Under native
# (macOS, Linux, Git Bash) CURL=curl, NODE=node, ETH_DIR = this repository's eth/ folder (found from this file's own location; a frozen
# copy under $L/bin does not probe upwards and takes it from $L/repo-dir.txt, which install.sh writes; or set REPO_DIR / ETH_DIR), PUB=$L/pub (plain local
# copies), win_path returns its argument unchanged, node_flags adds --curl-path "$CURL", and BIN / EQ fall back to the repository's
# swap-cli/target/release/swap-cli and equiv/zkvm/target/release/equiv-prove when $HOME/noid-target/release/... does not exist.
# These helpers run under bash 3.2 (the macOS /bin/bash): no mapfile (use read_lines), empty arrays are expanded as ${X[@]+"${X[@]}"}.
#
# Ethereum fees for the spends (lock.sh, reveal.sh, refund-eth.sh), all optional and set in $L/env.local.sh:
#   MAX_FEE_GWEI       mainnet cap (--mainnet --max-fee-gwei); a chain-1 swap file needs it
#   GAS_PRICE_GWEI     test chains only (--gas-price-gwei), used when MAX_FEE_GWEI is empty
#   PRIORITY_FEE_GWEI  the tip (--priority-fee-gwei): a send then pays about base fee + tip instead of the whole cap. Needs one of the
#                      two above (the spend helpers stop with exit 2 otherwise). On mainnet set the cap at 3-4 x the base fee and the tip
#                      small, e.g. 0.01. live.js refuses a tip below a tenth of the base fee, and a lock cannot be replaced: give the lock a
#                      generous tip, e.g. half the base fee
RUN=${RUN:-4}
L="${L:-$HOME/live-run-$RUN}"                      # swap files, passphrase, records, logs (WSL ext4, mode 700)
# --- platform: the environment wins as the starting value; else read the LIVE_PLATFORM assignment line of $L/env.local.sh WITHOUT
# running that file (it is sourced once, last, after the defaults it would change; running it early would repeat its side effects).
# The last matching line counts, quotes and a trailing comment are stripped; GNU and BSD grep/sed alike. A file that sets the variable
# in some other way (a variable, an indented line inside an if) is not read early and is caught by the check after the real source below.
_platform_line() {
  [ -f "$1" ] || return 0
  grep -E '^(export[[:space:]]+)?LIVE_PLATFORM=' "$1" 2>/dev/null | tail -n 1 |
    sed -e 's/^[^=]*=//' -e 's/[[:space:]]*#.*$//' -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' -e "s/^[\"']//" -e "s/[\"']$//"
}
_hint=${LIVE_PLATFORM:-}
if [ -z "$_hint" ]; then _hint=$(_platform_line "$L/env.local.sh"); fi
if [ -n "$_hint" ]; then LIVE_PLATFORM=$_hint
elif command -v wslpath >/dev/null 2>&1 && [ -d /mnt/c ]; then LIVE_PLATFORM=wsl
else LIVE_PLATFORM=native; fi
case "$LIVE_PLATFORM" in wsl|native) ;; *) echo "LIVE_PLATFORM must be wsl or native, not '$LIVE_PLATFORM'" >&2; exit 2 ;; esac
export LIVE_PLATFORM
_platform_for_defaults=$LIVE_PLATFORM
_here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
_bin_default="$HOME/noid-target/release/swap-cli"; _eq_default="$HOME/noid-target/release/equiv-prove"
if [ "$LIVE_PLATFORM" = native ]; then
  case "$L" in /*) ;; *) L="$PWD/$L" ;; esac
  # the repository: two folders above scripts/live. A frozen copy (this file lives in $L/bin) does NOT probe upwards (whatever sits two
  # folders above a run folder is not the repository): it takes REPO_DIR, else $L/repo-dir.txt, which install.sh writes.
  REPO_DIR=${REPO_DIR:-}
  _frozen=0
  if [ -d "$L/bin" ] && [ "$(cd "$_here" && pwd -P)" = "$(cd "$L/bin" && pwd -P)" ]; then _frozen=1; fi
  case "$_here" in */scripts/live) _in_repo=1 ;; *) _in_repo=0 ;; esac   # probe upwards only from a scripts/live folder
  if [ -z "$REPO_DIR" ] && [ "$_frozen" = 0 ] && [ "$_in_repo" = 1 ] && [ -f "$_here/../../eth/scripts/live.js" ]; then REPO_DIR=$(cd "$_here/../.." && pwd)
  elif [ -z "$REPO_DIR" ] && [ -s "$L/repo-dir.txt" ]; then REPO_DIR=$(head -n 1 "$L/repo-dir.txt"); fi
  if [ -n "$REPO_DIR" ]; then
    [ -e "$_bin_default" ] || _bin_default="$REPO_DIR/swap-cli/target/release/swap-cli"
    [ -e "$_eq_default" ] || _eq_default="$REPO_DIR/equiv/zkvm/target/release/equiv-prove"
  fi
  _curl_default=curl; _node_default=node; _eth_dir_default=${REPO_DIR:+$REPO_DIR/eth}; _pub_default="$L/pub"
else
  _curl_default=/mnt/c/Windows/System32/curl.exe       # WSL reaches Windows services only through curl.exe
  _node_default="/mnt/c/Program Files/nodejs/node.exe" # Windows node runs eth/scripts/live.js
  _eth_dir_default=/mnt/c/Users/00/Documents/noid-swap/eth
  _pub_default=/mnt/c/Users/00/Documents/live-run-$RUN # Windows-side copies for the owner (bundle, object, receipts)
fi
BIN="${BIN:-$_bin_default}"
EQ="${EQ:-$_eq_default}"
CURL=${CURL:-$_curl_default}
NODE="${NODE:-$_node_default}"
ETH_DIR=${ETH_DIR:-$_eth_dir_default}
PUB=${PUB:-$_pub_default}
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
# Ethereum key files for live.js --key-file (lock.sh and refund-eth.sh: Bob; reveal.sh: Alice), paths relative to eth/.
# For mainnet set BOB_KEY / ALICE_KEY in env.local.sh to the mainnet key files.
BOB_KEY=${BOB_KEY:-keys/bob.key}
ALICE_KEY=${ALICE_KEY:-keys/alice.key}
ALICE_FILE="$L/alice.swap.json"; BOB_FILE="$L/bob/bob.swap.json"
[ -f "$L/env.local.sh" ] && . "$L/env.local.sh"
# The defaults above were computed for one platform. If the file changed LIVE_PLATFORM after all (a value the early read could not see,
# or a different one than the environment gave), they would be the wrong set: stop instead of running with a mix.
if [ "${LIVE_PLATFORM:-}" != "$_platform_for_defaults" ]; then
  echo "LIVE_PLATFORM changed from '$_platform_for_defaults' to '${LIVE_PLATFORM:-}' while $L/env.local.sh was read: the defaults were computed for '$_platform_for_defaults'. If both values look the same, the file has Windows line endings (convert it to LF). Set it as a plain, unindented LIVE_PLATFORM=wsl|native line in that file (or only in the environment, not both with different values); refusing" >&2
  exit 2
fi
export WSLENV="ETH_RPC_URL${WSLENV:+:$WSLENV}"     # live.js reads ETH_RPC_URL; WSLENV carries it into Windows node
export ETH_RPC_URL="$ETH_RPC"

# --- helpers shared by the scripts
swap_file() { case "$1" in alice) echo "$ALICE_FILE";; bob) echo "$BOB_FILE";; *) echo "role must be alice or bob" >&2; return 2;; esac; }
# bash 3.2 has no mapfile: read_lines NAME cmd args... fills the array NAME with the lines cmd prints. Expand an array that can be
# empty as ${NAME[@]+"${NAME[@]}"} (a plain "${NAME[@]}" is an unbound variable under set -u before bash 4.4).
read_lines() { local _rl_n=$1 _rl_l; shift; eval "$_rl_n=()"; while IFS= read -r _rl_l; do eval "$_rl_n+=(\"\$_rl_l\")"; done < <("$@"); }
load_passphrase() { [ -s "$L/passphrase.txt" ] || { echo "no $L/passphrase.txt (run setup.sh)" >&2; return 2; }; export SWAP_PASSPHRASE="$(cat "$L/passphrase.txt")"; }
# Node flags for swap-cli: one or two endpoints per chain; --single-node-ok ONLY when SINGLE_NODE_OK=1 (REVIEW-5, opt-in).
node_flags() {
  single_node_warning   # said on EVERY call (every tick, every claim), not once in setup
  local f=(--transport curl --noid-rpc "$NOID_RPC" --eth-rpc "$ETH_RPC" --rpc-timeout "$RPC_TIMEOUT")
  if [ -n "$NOID_RPC2" ]; then f+=(--noid-rpc "$NOID_RPC2"); fi
  if [ -n "$ETH_RPC2" ]; then f+=(--eth-rpc "$ETH_RPC2"); fi
  if [ "$SINGLE_NODE_OK" = 1 ] && { [ -z "$NOID_RPC2" ] || [ -z "$ETH_RPC2" ]; }; then f+=(--single-node-ok); fi
  # native: say which curl to spawn (swap-cli's own default is the WSL curl.exe when that file exists, else `curl` from PATH)
  if [ "$LIVE_PLATFORM" = native ]; then f+=(--curl-path "$CURL"); fi
  printf '%s\n' "${f[@]}"
}
# live.js fee flags for the Ethereum spends (REVIEW-5 R5-8): MAX_FEE_GWEI = mainnet cap (--mainnet --max-fee-gwei), else GAS_PRICE_GWEI on a test chain.
# PRIORITY_FEE_GWEI (optional) adds --priority-fee-gwei (the tip) after either cap. A tip with no cap prints nothing here: the spend helpers
# call check_fee_settings first and stop on it.
fee_flags() {
  if [ -n "${MAX_FEE_GWEI:-}" ]; then printf '%s\n' --mainnet --max-fee-gwei "$MAX_FEE_GWEI"
  elif [ -n "${GAS_PRICE_GWEI:-}" ]; then printf '%s\n' --gas-price-gwei "$GAS_PRICE_GWEI"
  else return 0
  fi
  if [ -n "${PRIORITY_FEE_GWEI:-}" ]; then printf '%s\n' --priority-fee-gwei "$PRIORITY_FEE_GWEI"; fi
  return 0
}
# The spend helpers (lock.sh, reveal.sh, refund-eth.sh) call this before live.js: a tip with no cap to sit under is a mistake in env.local.sh,
# not something to drop silently (the transaction would go out with the tool's own tip rule instead of the one the operator typed).
check_fee_settings() {
  if [ -n "${PRIORITY_FEE_GWEI:-}" ] && [ -z "${MAX_FEE_GWEI:-}" ] && [ -z "${GAS_PRICE_GWEI:-}" ]; then
    echo "PRIORITY_FEE_GWEI is set but neither MAX_FEE_GWEI nor GAS_PRICE_GWEI is: the tip needs a cap to sit under. Set one of them in $L/env.local.sh, or unset PRIORITY_FEE_GWEI. Nothing was sent; refusing" >&2
    return 2
  fi
  return 0
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
  local re='^0x[0-9a-fA-F]{64}$'
  if [[ "$h" =~ $re ]]; then
    echo "--reveal-tx"; echo "$h"
  else
    echo "WARNING: $L/reveal-reverted-tx.txt does not hold one transaction hash (0x + 64 hex digits): it is IGNORED and no --reveal-tx is passed. Fix or delete it (the reverted claim it should name is not being checked)" >&2
  fi
}
# A path as the node that runs live.js sees it: under wsl a \\wsl.localhost\... path (live.js --swap FILE needs it), natively the path itself.
win_path() { if [ "$LIVE_PLATFORM" = native ]; then printf '%s\n' "$1"; else wslpath -w "$1"; fi; }
# cd into eth/ (live.js lives there); fails with a clear line when the folder is unknown.
enter_eth_dir() {
  if [ -z "$ETH_DIR" ] || [ ! -d "$ETH_DIR" ]; then echo "ETH_DIR '${ETH_DIR:-}' is not a folder: set REPO_DIR (the repository) or ETH_DIR in $L/env.local.sh" >&2; return 2; fi
  cd "$ETH_DIR"
}
# Native mode: the "Windows-side copies" are plain local copies in $PUB; make the folder before a script copies into it. Under wsl nothing is made here.
ensure_pub() { if [ "$LIVE_PLATFORM" = native ]; then mkdir -p "$PUB" 2>/dev/null; fi; return 0; }
require_parties() { for v in ALICE_NOID BOB_NOID ALICE_ETH BOB_ETH CONTRACT; do [ -n "${!v}" ] || { echo "$v is not set: put the four party addresses and CONTRACT in $L/env.local.sh" >&2; return 2; }; done; }
single_node_warning() {
  [ -n "$NOID_RPC2" ] && [ -n "$ETH_RPC2" ] && return 0
  if [ "$SINGLE_NODE_OK" = 1 ]; then
    echo "WARNING: one node per chain and SINGLE_NODE_OK=1 (--single-node-ok): the F5 cross-checks are OFF (no second Parano1d node for the lock, no second Ethereum node for the reveal or the secret). Fine against a counterparty you control; a swap with a STRANGER needs BOTH NOID_RPC2 and ETH_RPC2 in $L/env.local.sh and no SINGLE_NODE_OK" >&2
  else
    echo "NOTE: no second node for $([ -z "$NOID_RPC2" ] && echo "Parano1d (NOID_RPC2)")$([ -z "$NOID_RPC2" ] && [ -z "$ETH_RPC2" ] && echo " and ")$([ -z "$ETH_RPC2" ] && echo "Ethereum (ETH_RPC2)"), and SINGLE_NODE_OK is not 1: --single-node-ok is NOT passed, so the engine will WAIT before Bob's lock and before Alice's reveal (F5) until the second nodes are in $L/env.local.sh (or, for a run against a counterparty you control, SINGLE_NODE_OK=1 there)" >&2
  fi
}
