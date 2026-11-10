#!/usr/bin/env bash
# usage: lock.sh [--dry-run]       Bob's Ethereum lock, from the intent his last `tick --apply` recorded in his swap file.
# live.js lock --swap FILE fills and checks every term (amount, hashlock, receiver, T_reveal, contract, chain, code hash)
# against the file and refuses a duplicate hashlock. Without --dry-run REAL ETH is locked: owner's go-ahead first.
# Fee flags as in reveal.sh (REVIEW-5 R5-8): MAX_FEE_GWEI (mainnet: --mainnet --max-fee-gwei) or GAS_PRICE_GWEI in env.local.sh; a chain-1 file
# needs MAX_FEE_GWEI. live.js refuses a cap below 1 x the latest base fee for a lock (R4-1).
# Key file: BOB_KEY (default keys/bob.key, relative to eth/); for mainnet set BOB_KEY in env.local.sh to the mainnet key file.
# There is no --replace for a lock, on purpose: live.js has none (a replaced lock is a second look at one the node may already have
# mined, and `swap-cli intent --cancel` is the tool's way out of a lock that never lands). --replace here is refused with that explanation.
set -u
. "$(dirname "$0")/env.sh"
enter_eth_dir || exit 2
N=$(date +%H%M%S); MODE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) MODE="--dry-run" ;;
    --replace) echo "lock.sh has no --replace: live.js lock cannot replace a stuck lock (only claim and refund can). Wait for it, look at the contract, or cancel the intent with swap-cli (REVIEW-5 R5-8)" >&2; exit 2 ;;
    *) echo "usage: lock.sh [--dry-run]" >&2; exit 2 ;;
  esac
  shift
done
check_fee_settings || exit 2   # a tip with no cap stops here (env.sh)
read_lines FEES fee_flags
"$NODE" scripts/live.js lock --swap "$(win_path "$BOB_FILE")" --key-file "$BOB_KEY" --chain-id "$CHAIN" ${FEES[@]+"${FEES[@]}"} $MODE \
  > "$L/eth-lock-$N.json" 2> "$L/eth-lock-$N.err"; EC=$?
echo "lock ${MODE:-SEND} exit $EC at $(date +%T)"; head -c 800 "$L/eth-lock-$N.err"; echo; head -c 1200 "$L/eth-lock-$N.json"; echo
if [ -z "$MODE" ]; then ensure_pub; cp "$L/eth-lock-$N.json" "$PUB/eth-lock.json" 2>/dev/null; fi
exit $EC
