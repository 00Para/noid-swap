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
NOID_RPC2_REMOTE=${NOID_RPC2_REMOTE:-0}              # 1 = the second Parano1d node runs on another machine and is reached through a local port (an SSH tunnel): passes --noid-rpc2-is-remote, text only (the tool cannot verify it); only with NOID_RPC2
ETH_RPC2_REMOTE=${ETH_RPC2_REMOTE:-0}                # the same for the second Ethereum node (--eth-rpc2-is-remote), only with ETH_RPC2
SINGLE_NODE_OK=${SINGLE_NODE_OK:-0}                  # 1 = pass --single-node-ok (waive the F5 second-node rule); opt-in, set it in env.local.sh
ACCEPT_PRODUCER_CONCENTRATION=${ACCEPT_PRODUCER_CONCENTRATION:-0}  # 1 = pass --accept-producer-concentration (waive the production profile's refusal to lock while one address produced too many recent blocks, threat T21); opt-in, set it in env.local.sh, said on every call
ALERT_URL=""                                         # optional: a full URL that watch.sh POSTs a short message to when Bob's mined NOID claim was removed by a reorg. Set ONLY in $L/env.local.sh (the environment is ignored); never printed, never in a tracked file
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
# HTLCPoseidonV2 deployment (node scripts/live.js deploy --contract-kind poseidon). The reveal then costs about 0.5 M gas (517,084 on mainnet, 689,324 on Sepolia): Alice's ETH
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
  producer_concentration_warning
  local f=(--transport curl --noid-rpc "$NOID_RPC" --eth-rpc "$ETH_RPC" --rpc-timeout "$RPC_TIMEOUT")
  if [ -n "$NOID_RPC2" ]; then f+=(--noid-rpc "$NOID_RPC2"); fi
  if [ -n "$NOID_RPC2" ] && [ "$NOID_RPC2_REMOTE" = 1 ]; then f+=(--noid-rpc2-is-remote); fi
  if [ -n "$ETH_RPC2" ]; then f+=(--eth-rpc "$ETH_RPC2"); fi
  if [ -n "$ETH_RPC2" ] && [ "$ETH_RPC2_REMOTE" = 1 ]; then f+=(--eth-rpc2-is-remote); fi
  if [ "$SINGLE_NODE_OK" = 1 ] && { [ -z "$NOID_RPC2" ] || [ -z "$ETH_RPC2" ]; }; then f+=(--single-node-ok); fi
  if [ "$ACCEPT_PRODUCER_CONCENTRATION" = 1 ]; then f+=(--accept-producer-concentration); fi
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
# --eth-from-block from $L/eth-deploy-block.txt when it exists. The flag wins over the value stored in a swap file and is stored again, so a start that is HIGHER
# than the one a swap file in this folder already carries is not passed (a rebuilt folder must not move a good stored start past a lock): the stored one is used.
from_block_flags() {
  [ -s "$L/eth-deploy-block.txt" ] || return 0
  local n s f
  n=$(tr -dc '0-9' < "$L/eth-deploy-block.txt")
  [ -n "$n" ] || return 0
  for f in "$ALICE_FILE" "$BOB_FILE"; do
    s=$(grep -o '"eth_from_block": *[0-9][0-9]*' "$f" 2>/dev/null | head -n 1 | tr -dc '0-9')
    if [ -n "$s" ] && [ "$s" -lt "$n" ]; then
      echo "NOTE: $L/eth-deploy-block.txt ($n) is later than the log start stored in $(basename "$f") ($s): --eth-from-block is NOT passed, the stored start is used" >&2
      return 0
    fi
  done
  echo "--eth-from-block"; echo "$n"
}
# eth_rpc_raw URL METHOD PARAMS_JSON: the node's answer with all white space removed; fails (status 1, nothing printed) when the node cannot be reached, curl
# reports an HTTP error, or the answer holds an "error" member. The URL goes to curl on its standard input (it may carry a key), never in its argument list.
eth_rpc_raw() {
  local out
  out=$(printf 'url = "%s"\n' "$1" | "$CURL" -s -f -m "$RPC_TIMEOUT" -H 'Content-Type: application/json' \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"$2\",\"params\":$3}" -K - 2>/dev/null) || return 1
  out=$(printf '%s' "$out" | tr -d ' \t\r\n')
  case "$out" in *'"error"'*) return 1 ;; esac
  printf '%s\n' "$out"
}
# eth_rpc_block URL TAG: the number (decimal) of the Ethereum block TAG ("finalized" or "latest") as the node at URL reports it; fails (status 1, nothing
# printed) when the node cannot be reached, answers an error or null, or the answer holds no block number. Used by setup.sh only (no key, nothing sent).
eth_rpc_block() {
  local out hex
  out=$(eth_rpc_raw "$1" eth_getBlockByNumber "[\"$2\",false]") || return 1
  hex=$(printf '%s' "$out" | sed -n 's/.*"number":"\(0x[0-9a-fA-F]\{1,16\}\)".*/\1/p')
  [ -n "$hex" ] || return 1
  printf '%d\n' "$hex" 2>/dev/null
}
# eth_rpc_chain URL: the node's chain id (decimal); fails like eth_rpc_block.
eth_rpc_chain() {
  local out hex
  out=$(eth_rpc_raw "$1" eth_chainId "[]") || return 1
  hex=$(printf '%s' "$out" | sed -n 's/.*"result":"\(0x[0-9a-fA-F]\{1,16\}\)".*/\1/p')
  [ -n "$hex" ] || return 1
  printf '%d\n' "$hex" 2>/dev/null
}
# default_eth_from_block: a safe log start for a swap that does not exist yet, read from the configured Ethereum node(s) (ETH_RPC, and ETH_RPC2 when set).
# Each node must be on chain $CHAIN (eth_chainId) or nothing is chosen. The start is the FINALIZED block (no reorg can move it) minus ETH_START_MARGIN
# (default 2400 blocks, about 8 hours on Sepolia: a retry from a folder set up later still starts before an earlier lock, and it is far inside the
# provider's range cap); a node that does not serve "finalized" gives its latest block minus 256 (more than the 64 blocks Ethereum needs to finalize)
# minus the margin. Never below 0. With two nodes the LOWER value wins. Prints the number on stdout and a one-line account on stderr. Fails closed
# (status 1, nothing on stdout) when any configured node cannot be read or is on another chain: a guess here could start AFTER Bob's lock and hide it.
# Why it is safe: a swap's lock is sent after its run folder is set up, so a block that was already final at setup time is before it.
default_eth_from_block() {
  local url k=0 n c best="" how="" w margin=${ETH_START_MARGIN:-2400}
  case "$margin" in ''|*[!0-9]*) echo "ETH_START_MARGIN must be a whole number of blocks, not '$margin'" >&2; return 1 ;; esac
  for url in "$ETH_RPC" ${ETH_RPC2:+"$ETH_RPC2"}; do
    k=$((k + 1))
    if ! c=$(eth_rpc_chain "$url"); then
      echo "cannot read the chain id of Ethereum node $k ($([ "$k" = 1 ] && echo ETH_RPC || echo ETH_RPC2)): the log start is not chosen. Give DEPLOY_BLOCK in $L/env.local.sh (a block before your swap's lock) or fix the endpoint" >&2
      return 1
    fi
    if [ "$c" != "$CHAIN" ]; then
      echo "Ethereum node $k ($([ "$k" = 1 ] && echo ETH_RPC || echo ETH_RPC2)) is on chain $c but this run is chain $CHAIN (CHAIN / ETH_RPC in $L/env.local.sh or the environment): the log start is not chosen" >&2
      return 1
    fi
    if n=$(eth_rpc_block "$url" finalized); then w="finalized block minus $margin"
    elif n=$(eth_rpc_block "$url" latest); then
      if [ "$n" -gt 256 ]; then n=$((n - 256)); else n=0; fi
      w="latest block minus 256 minus $margin"
    else
      echo "cannot read the Ethereum node $k (neither its finalized nor its latest block): the log start is not chosen. Give DEPLOY_BLOCK in $L/env.local.sh (a block before your swap's lock) or fix the endpoint" >&2
      return 1
    fi
    if [ "$n" -gt "$margin" ]; then n=$((n - margin)); else n=0; fi
    if [ -z "$best" ] || [ "$n" -lt "$best" ]; then best=$n; how=$w; fi
  done
  echo "log start $best ($how, read from the configured Ethereum node$([ -n "${ETH_RPC2:-}" ] && echo "s, the lower of the two"))" >&2
  printf '%s\n' "$best"
}
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
# Opt-in only (ACCEPT_PRODUCER_CONCENTRATION=1 in $L/env.local.sh), said on EVERY call that builds the node flags. Nothing when the setting is off.
producer_concentration_warning() {
  [ "$ACCEPT_PRODUCER_CONCENTRATION" = 1 ] || return 0
  echo "WARNING: ACCEPT_PRODUCER_CONCENTRATION=1 (--accept-producer-concentration): the production profile will offer Bob's lock even while one address produced more than 35 % of the recent blocks, or the producer check cannot be completed (threat T21). Amounts must stay trial-sized. The F5 second-node rules are not waived by it" >&2
}
# alert_send MESSAGE: one POST to $ALERT_URL. The URL reaches curl on its standard input (one config line), never in its argument list, so it is not
# in the process list; -f turns an HTTP error into a failure. Returns curl's status.
alert_send() { printf 'url = "%s"\n' "$ALERT_URL" | "$CURL" -s -f -m 20 -d "$1" -K - >/dev/null 2>&1; }
# alert_hook: reads a tick's output on stdin; for every line that starts with `ALERT:` it POSTs a SHORT message to $ALERT_URL (set only in
# $L/env.local.sh; empty = this does nothing). The message is fixed text per kind of alert plus the run number: it never carries the alert line
# itself, so no address, amount or transaction id can leave. The engine prints each alert on ONE tick only (the tick that takes the transition), so
# there is no per-line latch (a second removal of the claim later in the run must alert again); the same message twice in one call is sent once.
# A POST that fails is kept in $L/alert-pending ("TRIES|MESSAGE") and tried again at every later call, up to 20 times, because the line will not
# be printed again. The URL is never printed, and nothing here can stop a loop: the function always returns 0.
alert_hook() {
  [ -n "${ALERT_URL:-}" ] || return 0
  local line msg v tries pend="$L/alert-pending" seen="|"
  if [ -s "$pend" ]; then
    v=$(cat "$pend" 2>/dev/null); tries=${v%%|*}; msg=${v#*|}
    case "$tries" in ''|*[!0-9]*) rm -f "$pend"; msg="" ;; esac
    if [ -n "$msg" ]; then
      if alert_send "$msg"; then rm -f "$pend"
      elif [ "$tries" -ge 20 ]; then rm -f "$pend"
      else printf '%s|%s\n' "$((tries + 1))" "$msg" > "$pend" 2>/dev/null
      fi
    fi
  fi
  while IFS= read -r line; do
    case "$line" in ALERT:*) ;; *) continue ;; esac
    case "$line" in
      *"removed Bob's NOID claim"*) msg="noid-swap run $RUN: claim removed by a reorg; run claim.sh dry run" ;;
      *) msg="noid-swap run $RUN: an alert was raised; look at the loop log" ;;
    esac
    case "$seen" in *"|$msg|"*) continue ;; esac
    seen="$seen$msg|"
    alert_send "$msg" || printf '1|%s\n' "$msg" > "$pend" 2>/dev/null
  done
  return 0
}
# alarm_hook ROLE: reads a tick's output on stdin; for a line that starts with `ALARM: the NOID claim is still pending` (Bob's claim is in the pool but not
# mined and the claim branch is running out or closed, T21-12) it POSTs ONE short fixed message to $ALERT_URL per swap file (ROLE) and kind
# (late = past the D-19 target; closed = at or past D). Unlike an ALERT: line the alarm is printed on EVERY tick while it holds, so a latch file in
# the run folder ($L/alarm-sent-ROLE-KIND) keeps it to one message per episode (a complete tick that no longer shows the kind clears the latch). The latch is created atomically (noclobber, O_EXCL) BEFORE the send, so two loops
# cannot both send; if the send fails the latch is removed and the next tick that prints the alarm tries again (the same failure behaviour as
# alert_hook: nothing here can stop a loop, the function always returns 0). The message is fixed text and the run number; the URL, an address, an amount
# or a transaction id are never in the latch, the message or the output. Empty ALERT_URL = does nothing.
alarm_hook() {
  [ -n "${ALERT_URL:-}" ] || return 0
  local role=${1:-bob} line kind msg latch complete=0 saw_late=0 saw_closed=0
  while IFS= read -r line; do
    case "$line" in "applied:"*) complete=1 ;; esac
    case "$line" in "ALARM: the NOID claim is still pending"*) ;; *) continue ;; esac
    case "$line" in
      *"claim branch is closed"*) kind=closed; saw_closed=1; msg="noid-swap run $RUN: Bob's NOID claim is still pending and the claim branch is closed; look at the loop log" ;;
      *) kind=late; saw_late=1; msg="noid-swap run $RUN: Bob's NOID claim is still pending past its target; look at the loop log" ;;
    esac
    latch="$L/alarm-sent-$role-$kind"
    ( set -C; : > "$latch" ) 2>/dev/null || continue
    alert_send "$msg" || rm -f "$latch" 2>/dev/null
  done
  # Re-arm: a COMPLETE tick (it printed its `applied:` line) that no longer shows a kind ends that episode, so a later one (the claim mined, reorged out,
  # sent again and stuck again) is announced again. A tick that failed or printed nothing re-arms nothing.
  if [ "$complete" = 1 ]; then
    [ "$saw_late" = 1 ] || rm -f "$L/alarm-sent-$role-late" 2>/dev/null
    [ "$saw_closed" = 1 ] || rm -f "$L/alarm-sent-$role-closed" 2>/dev/null
  fi
  return 0
}
# reveal_sent_note ERRFILE: live.js writes "sent: HASH ..." to its stderr the moment the claim is broadcast (before the wait for the receipt), so the
# line is there even when the claim then sticks or is dropped and nothing reaches stdout. The file learns that the secret may be public only from a tick
# that sees the claim; until then a re-send past the first-publication cutoff is judged as a first publication.
reveal_sent_note() {
  grep -q '^sent: ' "$1" 2>/dev/null || return 0
  echo "NOTE: the claim was broadcast. Run tick.sh alice --apply right now (watch.sh does it on its next pass): the swap file learns that the secret may be public only from a tick that sees this claim, and a re-send is judged by what the file knows."
}
single_node_warning() {
  [ -n "$NOID_RPC2" ] && [ -n "$ETH_RPC2" ] && return 0
  if [ "$SINGLE_NODE_OK" = 1 ]; then
    echo "WARNING: one node per chain and SINGLE_NODE_OK=1 (--single-node-ok): the F5 cross-checks are OFF (no second Parano1d node for the lock, no second Ethereum node for the reveal or the secret). Fine against a counterparty you control; a swap with a STRANGER needs BOTH NOID_RPC2 and ETH_RPC2 in $L/env.local.sh and no SINGLE_NODE_OK$([ -z "$NOID_RPC2" ] && echo ". Under the production profile Bob's lock also needs NOID_RPC2 for the producer-concentration check (T21): SINGLE_NODE_OK does not relax that, only ACCEPT_PRODUCER_CONCENTRATION=1 does")" >&2
  else
    echo "NOTE: no second node for $([ -z "$NOID_RPC2" ] && echo "Parano1d (NOID_RPC2)")$([ -z "$NOID_RPC2" ] && [ -z "$ETH_RPC2" ] && echo " and ")$([ -z "$ETH_RPC2" ] && echo "Ethereum (ETH_RPC2)"), and SINGLE_NODE_OK is not 1: --single-node-ok is NOT passed, so the engine will WAIT before Bob's lock and before Alice's reveal (F5) until the second nodes are in $L/env.local.sh (or, for a run against a counterparty you control, SINGLE_NODE_OK=1 there; under the production profile Bob's lock then still needs NOID_RPC2 for the producer-concentration check, or ACCEPT_PRODUCER_CONCENTRATION=1)" >&2
  fi
}
