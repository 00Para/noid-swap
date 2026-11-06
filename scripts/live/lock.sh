#!/usr/bin/env bash
# usage: lock.sh [--dry-run]       Bob's Ethereum lock, from the intent his last `tick --apply` recorded in his swap file.
# live.js lock --swap FILE fills and checks every term (amount, hashlock, receiver, T_reveal, contract, chain, code hash)
# against the file and refuses a duplicate hashlock. Without --dry-run REAL ETH is locked: owner's go-ahead first.
set -u
. "$(dirname "$0")/env.sh"
cd "$ETH_DIR" || exit 2
N=$(date +%H%M%S); MODE=${1:-}
"$NODE" scripts/live.js lock --swap "$(win_path "$BOB_FILE")" --key-file keys/bob.key --chain-id "$CHAIN" $MODE \
  > "$L/eth-lock-$N.json" 2> "$L/eth-lock-$N.err"; EC=$?
echo "lock ${MODE:-SEND} exit $EC at $(date +%T)"; head -c 800 "$L/eth-lock-$N.err"; echo; head -c 1200 "$L/eth-lock-$N.json"; echo
[ -z "$MODE" ] && cp "$L/eth-lock-$N.json" "$PUB/eth-lock.json" 2>/dev/null
exit $EC
