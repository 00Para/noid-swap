#!/usr/bin/env bash
# usage: lock.sh [--dry-run]       Bob's Ethereum lock, from the intent his last `tick --apply` recorded in his swap file.
# live.js lock --swap FILE fills and checks every term (amount, hashlock, receiver, T_reveal, contract, chain, code hash)
# against the file and refuses a duplicate hashlock, and (also with --dry-run) a file whose producer screen remembers a detection under
# production (marker FILE.producer-differs or history entry producer_differs_seen; T21), unless the file records the override. Without --dry-run REAL ETH is locked: owner's go-ahead first.
# A send (no --dry-run) ALSO runs a fresh read-only `swap-cli tick` of Bob's file right before live.js and refuses (exit 3, nothing sent) unless that tick still shows the pending lock_eth intent and the engine still decides the lock with the producer screen and its other gates (lock_precheck in env.sh); a tick that fails, cannot be read or does not finish within LOCK_PRECHECK_TIMEOUT seconds (default 3 x RPC_TIMEOUT) refuses.
# The lock is sent through THIS script only: it hands live.js lock the APPROVAL of that tick, three values taken from the tick's own output and never from the swap file (--approved-intent: the decided_at of the intent it held; --approved-terms: the SHA-256 of the lock's terms; --approved-at: the tick's own time), and live.js lock refuses a real send without them, with other terms, or when the tick is older than 120 s. Do not call live.js lock directly.
# Fee flags as in reveal.sh (REVIEW-5 R5-8): MAX_FEE_GWEI (mainnet: --mainnet --max-fee-gwei) or GAS_PRICE_GWEI in env.local.sh; a chain-1 file
# needs MAX_FEE_GWEI. live.js refuses a cap below 1 x the latest base fee for a lock (R4-1).
# Key file: BOB_KEY (default keys/bob.key, relative to eth/); for mainnet set BOB_KEY in env.local.sh to the mainnet key file.
# There is no --replace for a lock, on purpose: live.js has none (a replaced lock is a second look at one the node may already have
# mined, and `swap-cli intent --cancel` is the tool's way out of a lock that never lands). --replace here is refused with that explanation.
set -u
. "$(dirname "$0")/env.sh"
enter_eth_dir || exit 2
N=$(date +%H%M%S); MODE=""; APPROVE=()
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) MODE="--dry-run" ;;
    --replace) echo "lock.sh has no --replace: live.js lock cannot replace a stuck lock (only claim and refund can). Wait for it, look at the contract, or cancel the intent with swap-cli (REVIEW-5 R5-8)" >&2; exit 2 ;;
    *) echo "usage: lock.sh [--dry-run]" >&2; exit 2 ;;
  esac
  shift
done
check_fee_settings || exit 2   # a tip with no cap stops here (env.sh)
LOCK_PRECHECK_TIMEOUT=${LOCK_PRECHECK_TIMEOUT:-$((RPC_TIMEOUT * 3))}
case "$LOCK_PRECHECK_TIMEOUT" in ''|*[!0-9]*|0) echo "LOCK_PRECHECK_TIMEOUT must be a whole number of seconds above 0 (got '$LOCK_PRECHECK_TIMEOUT')" >&2; exit 2 ;; esac
read_lines FEES fee_flags
# A SEND (no --dry-run) first asks a fresh read-only `swap-cli tick` of Bob's file (T21 design B): the lock goes out only if that tick still shows the
# pending lock_eth intent AND the engine, with the producer screen and every other gate, still decides the lock. Three rounds of outside reads found a
# way for live.js's own checks and the engine's screen to disagree; this asks the engine itself at the moment of sending. A tick that fails or whose
# output cannot be read refuses. The tick is read-only (no --apply): it writes no swap file, and records no node answers. A dry run does not tick.
if [ -z "$MODE" ]; then
  F=$(swap_file bob) || exit 2
  load_passphrase || exit 2
  read_lines NODES node_flags; read_lines FROM from_block_flags; read_lines REVEAL reveal_tx_flags
  run_with_limit "$LOCK_PRECHECK_TIMEOUT" "$L/lock-precheck-$N.json" "$L/lock-precheck-$N.err" \
    "$BIN" tick "$F" ${NODES[@]+"${NODES[@]}"} ${FROM[@]+"${FROM[@]}"} ${REVEAL[@]+"${REVEAL[@]}"}; TEC=$?
  unset SWAP_PASSPHRASE   # the tick needed it; live.js (below) and every other child of this script must not inherit it
  if [ "$RUN_LIMIT_HIT" = 1 ]; then
    echo "lock REFUSED, nothing sent: the fresh read-only tick right before the send did not finish within $LOCK_PRECHECK_TIMEOUT s (it was stopped), so the engine could not be asked whether the lock is still wanted. Look at the nodes, then run lock.sh again; do not call live.js lock directly (it cannot make this check itself)."
    exit 3
  fi
  if [ "$TEC" -ne 0 ]; then
    echo "lock REFUSED, nothing sent: the fresh read-only tick right before the send failed (exit $TEC), so the engine could not be asked whether the lock is still wanted:"; head -c 600 "$L/lock-precheck-$N.err"; echo
    exit 3
  fi
  WHY=$(lock_precheck "$L/lock-precheck-$N.json"); PEC=$?
  if [ "$PEC" -ne 0 ]; then
    echo "lock REFUSED, nothing sent: the fresh read-only tick right before the send does not show a lock to send."
    echo "$WHY"
    echo "If a lock_eth intent is still pending and you are sure it was not sent: swap-cli intent FILE --cancel (same chain flags as tick); then tick --apply records a new one when the engine offers the lock again."
    exit 3
  fi
  # WHY is "go DECIDED_AT TERMS_SHA256 TICK_NOW": the approval of THIS tick (the intent it held, the SHA-256 of the lock's terms as it reports them, its own
  # Unix time). live.js lock is handed exactly these three; none of them is read from the swap file here.
  set -- $WHY
  if [ $# -ne 4 ] || [ "$1" != go ] || ! printf '%s' "$2" | grep -Eq '^[0-9]+$' || ! printf '%s' "$3" | grep -Eq '^[0-9a-f]{64}$' || ! printf '%s' "$4" | grep -Eq '^[0-9]+$'; then
    echo "lock REFUSED, nothing sent: the fresh read-only tick did not give the approval of the lock (the intent's decided_at, the hash of its terms, the tick's own time)."
    exit 3
  fi
  APPROVE=(--approved-intent "$2" --approved-terms "$3" --approved-at "$4")
  echo "fresh read-only tick: the engine still offers Bob's lock ($L/lock-precheck-$N.json), intent decided_at $2, tick time $4"
fi
"$NODE" scripts/live.js lock --swap "$(win_path "$BOB_FILE")" --key-file "$BOB_KEY" --chain-id "$CHAIN" ${FEES[@]+"${FEES[@]}"} ${APPROVE[@]+"${APPROVE[@]}"} $MODE \
  > "$L/eth-lock-$N.json" 2> "$L/eth-lock-$N.err"; EC=$?
echo "lock ${MODE:-SEND} exit $EC at $(date +%T)"; head -c 800 "$L/eth-lock-$N.err"; echo; head -c 1200 "$L/eth-lock-$N.json"; echo
if [ -z "$MODE" ]; then ensure_pub; cp "$L/eth-lock-$N.json" "$PUB/eth-lock.json" 2>/dev/null; fi
exit $EC
