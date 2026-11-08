#!/usr/bin/env bash
# usage: claim.sh [--submit]       Bob's NOID claim (client R: the secret read from the chain, a fresh authorization proof).
# Dry run unless --submit: proves, prints txid / call height / fee / recipient (MUST be Bob's o1...), submits nothing.
# --submit sends the close to the node: owner's go-ahead first. --eth-from-block comes from the file after one tick --apply.
set -u
. "$(dirname "$0")/env.sh"
load_passphrase || exit 2
mapfile -t NODES < <(node_flags); mapfile -t FROM < <(from_block_flags); mapfile -t REVEAL < <(reveal_tx_flags)
N=$(date +%H%M%S); SECONDS=0
"$BIN" claim "$BOB_FILE" "${NODES[@]}" "${FROM[@]}" "${REVEAL[@]}" \
  --record-noid "$L/rec/claim-noid-$N.json" --record-eth "$L/rec/claim-eth-$N.json" --intent-out "$L/claim-intent-$N.hex" "$@" \
  > "$L/claim-$N.out" 2> "$L/claim-$N.err"
EC=$?
echo "claim exit $EC in ${SECONDS}s at $(date +%T) (${1:-dry-run})"; head -c 700 "$L/claim-$N.err"; echo
grep -vE '^\s+"(opening_hex|intent_hex)"' "$L/claim-$N.out" | head -40
exit $EC
