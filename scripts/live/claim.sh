#!/usr/bin/env bash
# usage: claim.sh [--submit]       Bob's NOID claim (client R: the secret read from the chain, a fresh authorization proof).
# Dry run unless --submit: proves, prints txid / call height / fee / recipient (MUST be Bob's o1...), submits nothing.
# --submit sends the close to the node: owner's go-ahead first. --eth-from-block comes from the file after one tick --apply.
# With --submit and a second Parano1d node (NOID_RPC2) the intent is sent to both nodes (--submit-rpc); a dry run never sends.
# The whole output is printed (the full file is $L/claim-*.out); only the long opening_hex / intent_hex lines are left out.
set -u
. "$(dirname "$0")/env.sh"
load_passphrase || exit 2
read_lines NODES node_flags; read_lines FROM from_block_flags; read_lines REVEAL reveal_tx_flags
SUBMIT_RPC=()
for a in "$@"; do
  if [ "$a" = "--submit" ] && [ -n "$NOID_RPC2" ]; then SUBMIT_RPC=(--submit-rpc "$NOID_RPC2"); fi
done
N=$(date +%H%M%S); SECONDS=0
"$BIN" claim "$BOB_FILE" ${NODES[@]+"${NODES[@]}"} ${FROM[@]+"${FROM[@]}"} ${REVEAL[@]+"${REVEAL[@]}"} ${SUBMIT_RPC[@]+"${SUBMIT_RPC[@]}"} \
  --record-noid "$L/rec/claim-noid-$N.json" --record-eth "$L/rec/claim-eth-$N.json" --intent-out "$L/claim-intent-$N.hex" "$@" \
  > "$L/claim-$N.out" 2> "$L/claim-$N.err"
EC=$?
echo "claim exit $EC in ${SECONDS}s at $(date +%T) (${1:-dry-run})"; head -c 700 "$L/claim-$N.err"; echo
grep -vE '^[[:space:]]+"(opening_hex|intent_hex)"' "$L/claim-$N.out"
exit $EC
