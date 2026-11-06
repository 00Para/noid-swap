#!/usr/bin/env bash
# usage: refund-eth.sh [--dry-run]   Bob's Ethereum refund after T_reveal (abort path), from the intent his swap file recorded.
# live.js refund --swap FILE checks the lock against the file. REAL transaction without --dry-run: owner's go-ahead first.
set -u
. "$(dirname "$0")/env.sh"
cd "$ETH_DIR" || exit 2
N=$(date +%H%M%S); MODE=${1:-}
"$NODE" scripts/live.js refund --swap "$(win_path "$BOB_FILE")" --key-file keys/bob.key --chain-id "$CHAIN" $MODE \
  > "$L/eth-refund-$N.json" 2> "$L/eth-refund-$N.err"; EC=$?
echo "refund ${MODE:-SEND} exit $EC at $(date +%T)"; head -c 800 "$L/eth-refund-$N.err"; echo; head -c 1200 "$L/eth-refund-$N.json"; echo
exit $EC
