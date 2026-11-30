#!/usr/bin/env bash
# A wallet run (USE_SWAP_WALLET=1 in $L/env.local.sh): the key is the swap's own Ethereum key, piped from `swap-cli ethkey emit` into live.js (--key-stdin; for the reveal the secret follows on a second line); no key file, no argument, no temporary file. Exit 2 also when that key cannot be emitted (nothing was sent). Not run against a real node or a public network.
# usage: refund-eth.sh [--dry-run] [--replace [TXHASH]]   Bob's Ethereum refund after T_reveal (abort path), from the intent his swap file recorded.
# live.js refund --swap FILE checks the lock against the file. REAL transaction without --dry-run: owner's go-ahead first.
# Key file: BOB_KEY (default keys/bob.key, relative to eth/); for mainnet set BOB_KEY in env.local.sh to the mainnet key file.
# Fee flags and --replace as in reveal.sh (REVIEW-5 R5-8): MAX_FEE_GWEI (mainnet) or GAS_PRICE_GWEI in env.local.sh; --replace re-sends a STUCK
# refund at the same nonce with a fee raised by >= 12.5 % and >= 2 x the base fee. Give the hash live.js printed ("sent: 0x...") as TXHASH:
# without it the node's pending block and pool are searched, and if the node cannot show the old transaction the command refuses (R5-2).
set -u
. "$(dirname "$0")/env.sh"
enter_eth_dir || exit 2
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
check_fee_settings || exit 2   # a tip with no cap stops here (env.sh)
read_lines FEES fee_flags
# A wallet run (USE_SWAP_WALLET=1): the key is Bob's swap key (bob_sender), sealed in his swap file; `swap-cli ethkey emit` pipes it to live.js (--key-stdin), never a key file.
if [ "$USE_SWAP_WALLET" = 1 ]; then KEYARG=(--key-stdin); else KEYARG=(--key-file "$BOB_KEY"); fi
ARGS=(scripts/live.js refund --swap "$(win_path "$BOB_FILE")" "${KEYARG[@]}" --chain-id "$CHAIN" ${FEES[@]+"${FEES[@]}"})
if [ "$REPLACE" = 1 ]; then
  ARGS+=(--replace)
  if [ -n "$TXHASH" ]; then ARGS+=(--replace-tx "$TXHASH"); fi
fi
if [ "$DRY" = 1 ]; then ARGS+=(--dry-run); fi
if [ "$USE_SWAP_WALLET" = 1 ]; then
  # the key goes from `swap-cli ethkey emit` into live.js through a pipe; the passphrase goes to swap-cli only. No key emitted: live.js had nothing to sign with, exit 2.
  [ -s "$L/passphrase.txt" ] || { echo "no $L/passphrase.txt (run setup.sh)" >&2; exit 2; }
  ( load_passphrase && "$BIN" ethkey emit "$BOB_FILE" ) 2> "$L/eth-refund-$N.emit.err" | ( unset SWAP_PASSPHRASE; "$NODE" "${ARGS[@]}" > "$L/eth-refund-$N.json" 2> "$L/eth-refund-$N.err" )
  RCS=("${PIPESTATUS[@]}")
  if [ "${RCS[0]}" -ne 0 ]; then rm -f "$L/eth-refund-$N.json"; echo "refund REFUSED: the swap key could not be emitted from Bob's swap file (exit ${RCS[0]}); nothing was sent:"; head -c 400 "$L/eth-refund-$N.emit.err"; echo; exit 2; fi
  EC=${RCS[1]}
else
"$NODE" "${ARGS[@]}" > "$L/eth-refund-$N.json" 2> "$L/eth-refund-$N.err"; EC=$?
fi
echo "refund $([ "$DRY" = 1 ] && echo --dry-run || echo SEND)$([ "$REPLACE" = 1 ] && echo " --replace") exit $EC at $(date +%T)"; head -c 800 "$L/eth-refund-$N.err"; echo; head -c 1200 "$L/eth-refund-$N.json"; echo
exit $EC
