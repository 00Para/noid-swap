#!/usr/bin/env bash
# usage: refund-eth.sh [--dry-run] [--replace [TXHASH]]   Bob's Ethereum refund after T_reveal (abort path), from the intent his swap file recorded.
# live.js refund --swap FILE checks the lock against the file. REAL transaction without --dry-run: owner's go-ahead first.
# Fee flags and --replace as in reveal.sh (REVIEW-5 R5-8): MAX_FEE_GWEI (mainnet) or GAS_PRICE_GWEI in env.local.sh; --replace re-sends a STUCK
# refund at the same nonce with a fee raised by >= 12.5 % and >= 2 x the base fee. Give the hash live.js printed ("sent: 0x...") as TXHASH:
# without it the node's pending block and pool are searched, and if the node cannot show the old transaction the command refuses (R5-2).
set -u
. "$(dirname "$0")/env.sh"
cd "$ETH_DIR" || exit 2
N=$(date +%H%M%S)
DRY=0; REPLACE=0; TXHASH=""
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY=1 ;;
    --replace) REPLACE=1
      if [ $# -gt 1 ] && [ "${2#--}" = "$2" ]; then TXHASH="$2"; shift; fi ;;
    *) echo "usage: refund-eth.sh [--dry-run] [--replace [TXHASH]]" >&2; exit 2 ;;
  esac
  shift
done
mapfile -t FEES < <(fee_flags)
ARGS=(scripts/live.js refund --swap "$(win_path "$BOB_FILE")" --key-file keys/bob.key --chain-id "$CHAIN" "${FEES[@]}")
if [ "$REPLACE" = 1 ]; then
  ARGS+=(--replace)
  if [ -n "$TXHASH" ]; then ARGS+=(--replace-tx "$TXHASH"); fi
fi
if [ "$DRY" = 1 ]; then ARGS+=(--dry-run); fi
"$NODE" "${ARGS[@]}" > "$L/eth-refund-$N.json" 2> "$L/eth-refund-$N.err"; EC=$?
echo "refund $([ "$DRY" = 1 ] && echo --dry-run || echo SEND)$([ "$REPLACE" = 1 ] && echo " --replace") exit $EC at $(date +%T)"; head -c 800 "$L/eth-refund-$N.err"; echo; head -c 1200 "$L/eth-refund-$N.json"; echo
exit $EC
