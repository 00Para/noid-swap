#!/usr/bin/env bash
# usage: wallet-sweep.sh noid [--dry-run]            Alice's NOID swap wallet: everything spendable minus the fee goes to the payout address sealed in her swap file.
#        wallet-sweep.sh eth alice|bob [--dry-run]   The party's Ethereum swap key: its whole balance minus the fee goes to the payout address sealed in the party's swap file.
# REAL coins move without --dry-run. NOT run against a real node or a public network; selftest.sh covers it against stub tools only.
#
# Only after the swap is over: the tools themselves refuse while the swap's instance is still at the contract, a lock of the swap is open, an intent is held, the key has a
# pending transaction or a lock record is unresolved (their words are shown). The payout address is a setting of the run (NOID_PAYOUT / ETH_PAYOUT in $L/env.local.sh) AND
# sealed in the swap file when the file was made; this helper refuses unless the two are the same address, and the tools refuse a sweep to any other address.
# The key goes from `swap-cli ethkey emit` into live.js through a pipe (never a key file, an argument or a temporary file); the passphrase goes to swap-cli only.
# A sweep is never time-critical: the console's autopilot runs each sweep once and tries a refused one again about every 5 minutes.
#
# stdout (the operator console reads it; values are validated plain tokens):
#   wallet-sweep: payout_swap_file ADDR   and   wallet-sweep: payout_settings ADDR        (the two must be the same address; a refusal if not)
#   noid:  wallet-sweep: outcome ... target amount_micronoid fee_micronoid inputs txid summary     (as wallet-fund.sh)
#   eth:   the ETH result is the JSON live.js printed, in $L/eth-sweep-ROLE-dry-N.json (dry run) or $L/eth-sweep-ROLE-N.json (a real send)
# A real sweep that went through writes $L/wallet-swept-noid.marker or $L/wallet-swept-eth-ROLE.marker (the time, then the txid), which the console reads as "swept".
#
# Exit status (the console reads it):
#   0  a dry run was built and verified, or the sweep was sent (noid: at least one node holds it; eth: mined)
#   2  usage, a setting or a tool is wrong: not a wallet run, a payout setting that is not an address, no swap file, no passphrase file, swap-cli / node / python3 missing. Nothing sent.
#   3  refused, nothing sent: the payout settings and the swap file name different addresses, or the tool refused (its words are shown: for example "lock still open",
#      "instance not closed"). eth: live.js refused before it broadcast anything (no `sent:` line, no result)
#   4  noid only: nothing was sent by this run (the tool says to wait, or that the sweep is already done)
#   6  the sweep MAY HAVE BEEN SENT (noid: the tool could not tell, run again, it sends the same bytes; eth: live.js broadcast it and did not finish: look at the key's balance)
#   1  anything else (an unknown exit status, a signal): treat it as possibly sent
set -u
. "$(dirname "$0")/env.sh"
san() { LC_ALL=C tr -d '\000-\010\013-\037\177'; }
usage() { echo "usage: wallet-sweep.sh noid [--dry-run] | wallet-sweep.sh eth alice|bob [--dry-run]" >&2; exit 2; }
KIND=${1:-}; shift || true
ROLE=""
case "$KIND" in
  noid) ROLE=alice ;;
  eth) ROLE=${1:-}; [ $# -ge 1 ] && shift; case "$ROLE" in alice|bob) ;; *) usage ;; esac ;;
  *) usage ;;
esac
DRY=0
case "${1:-}" in --dry-run) DRY=1; shift ;; "") ;; *) usage ;; esac
[ $# -eq 0 ] || usage
require_wallet_run || exit 2
require_payout_settings "$KIND" || exit 2
[ -s "$L/passphrase.txt" ] || { echo "no $L/passphrase.txt (run setup.sh first)" >&2; exit 2; }
[ -x "$BIN" ] || { echo "swap-cli not found or not executable at '$BIN'" >&2; exit 2; }
command -v python3 >/dev/null 2>&1 || { echo "python3 not found" >&2; exit 2; }
F=$(swap_file "$ROLE") || exit 2
[ -f "$F" ] || { echo "no swap file at $F" >&2; exit 2; }
N=$(date +%H%M%S)
echo "== start $(date +%T), run $RUN, $KIND sweep of $ROLE$([ "$DRY" = 1 ] && echo ' (dry run: nothing is sent)')"
NOID_RE='^o1[0-9a-z]{20,100}$'; ETH_RE='^0x[0-9a-fA-F]{40}$'
lower() { printf '%s' "$1" | tr 'A-F' 'a-f'; }
marker() { ( set -o noclobber; { date -u +%Y-%m-%dT%H:%M:%SZ; echo "txid $2"; } > "$1" ) 2>/dev/null || true; }

if [ "$KIND" = noid ]; then
  BASE="$L/wallet-sweep-noid-$([ "$DRY" = 1 ] && echo dry-)$N"
  "$BIN" wallet address "$F" > "$BASE.addr.json" 2> "$BASE.addr.err" < /dev/null; AEC=$?
  PAYOUT=$(wallet_json_value "$BASE.addr.json" payout)
  if [ "$AEC" -ne 0 ] || ! [[ "$PAYOUT" =~ $NOID_RE ]]; then
    echo "REFUSED: swap-cli wallet address did not name a payout address in the swap file (exit $AEC); nothing was built or sent:"; head -c 400 "$BASE.addr.err" | san; echo; exit 3
  fi
  echo "wallet-sweep: payout_swap_file $PAYOUT"
  echo "wallet-sweep: payout_settings $NOID_PAYOUT"
  if [ "$PAYOUT" != "$NOID_PAYOUT" ]; then echo "REFUSED: NOID_PAYOUT in $L/env.local.sh is not the payout address sealed in the swap file; nothing was built or sent"; exit 3; fi
  wallet_step sweep "$BASE" "$DRY"
  wallet_step_report wallet-sweep
  echo "wallet-sweep exit $WSTEP_RC (swap-cli wallet sweep, outcome $(wallet_kv "$WSTEP_PARSED" outcome))"
  if [ -z "$WSTEP_PARSED" ]; then echo "swap-cli's words:"; head -c 600 "$BASE.err" | san; echo; fi
  OUTCOME=$(wallet_kv "$WSTEP_PARSED" outcome)
  if [ "$DRY" = 1 ] && [ "$WSTEP_RC" -eq 0 ]; then echo "dry run: would sweep $(wallet_kv "$WSTEP_PARSED" amount_micronoid) micro-NOID once to the payout address; nothing was written or sent"; fi
  if [ "$DRY" = 0 ] && { { [ "$OUTCOME" = sent ] && [ "$WSTEP_RC" -eq 0 ]; } || { [ "$OUTCOME" = done ] && [ "$WSTEP_RC" -eq 4 ]; }; }; then marker "$L/wallet-swept-noid.marker" "$(wallet_kv "$WSTEP_PARSED" txid)"; fi
  if [ "$WSTEP_RC" -eq 6 ]; then echo "THE SWEEP MAY HAVE BEEN SENT: run this again; it sends the same recorded bytes (never a second sweep)"; fi
  echo "== end $(date +%T)"
  exit "$WSTEP_RC"
fi

# ---- eth
command -v "$NODE" >/dev/null 2>&1 || [ -x "$NODE" ] || { echo "node not found at '$NODE'" >&2; exit 2; }
[ -d "${ETH_DIR:-}" ] && [ -f "$ETH_DIR/scripts/live.js" ] || { echo "ETH_DIR '${ETH_DIR:-}' has no scripts/live.js" >&2; exit 2; }
check_fee_settings || exit 2
"$BIN" ethkey address "$F" > "$L/.wallet-sweep-addr-$N.json" 2> "$L/.wallet-sweep-addr-$N.err" < /dev/null; AEC=$?
PAYOUT=$(wallet_json_value "$L/.wallet-sweep-addr-$N.json" payout)
EROLE=$(wallet_json_value "$L/.wallet-sweep-addr-$N.json" role)
rm -f "$L/.wallet-sweep-addr-$N.json"
if [ "$AEC" -ne 0 ] || ! [[ "$PAYOUT" =~ $ETH_RE ]] || [ "$EROLE" != "$ROLE" ]; then
  echo "REFUSED: swap-cli ethkey address did not name a payout address for the $ROLE in the swap file (exit $AEC); nothing was sent:"; head -c 400 "$L/.wallet-sweep-addr-$N.err" | san; echo; rm -f "$L/.wallet-sweep-addr-$N.err"; exit 3
fi
rm -f "$L/.wallet-sweep-addr-$N.err"
echo "wallet-sweep: payout_swap_file $PAYOUT"
echo "wallet-sweep: payout_settings $ETH_PAYOUT"
if [ "$(lower "$PAYOUT")" != "$(lower "$ETH_PAYOUT")" ]; then echo "REFUSED: ETH_PAYOUT in $L/env.local.sh is not the payout address sealed in the swap file; nothing was sent"; exit 3; fi
read_lines FEES fee_flags
OUT="$L/eth-sweep-$ROLE-$([ "$DRY" = 1 ] && echo dry-)$N.json"; ERRF="$L/eth-sweep-$ROLE-$([ "$DRY" = 1 ] && echo dry-)$N.err"
ARGS=(scripts/live.js sweep --swap "$(win_path "$F")" --to "$ETH_PAYOUT" --key-stdin --chain-id "$CHAIN" ${FEES[@]+"${FEES[@]}"})
if [ "$DRY" = 1 ]; then ARGS+=(--dry-run); fi
( cd "$ETH_DIR" || exit 1
  ( load_passphrase && "$BIN" ethkey emit "$F" ) 2> "$ERRF" | ( unset SWAP_PASSPHRASE; "$NODE" "${ARGS[@]}" > "$OUT" 2>> "$ERRF" )
  rcs=("${PIPESTATUS[@]}")
  [ "${rcs[0]}" -eq 0 ] || exit 125     # no key was emitted: live.js got nothing to sign with
  exit "${rcs[1]}" )
EC=$?
echo "sweep $([ "$DRY" = 1 ] && echo --dry-run || echo SEND) exit $EC at $(date +%T)"
head -c 800 "$ERRF" | san; echo
if [ "$EC" -eq 125 ]; then [ -s "$OUT" ] || rm -f "$OUT"; echo "REFUSED: the key could not be emitted from the swap file; nothing was sent"; echo "== end $(date +%T)"; exit 3; fi
head -c 1200 "$OUT" | san; echo
SENT=0; grep -q '^sent: 0x' "$ERRF" 2>/dev/null && SENT=1
if [ "$EC" -eq 0 ]; then
  if [ "$DRY" = 0 ]; then
    TXH=$(sed -n 's/^[[:space:]]*"txHash"[[:space:]]*:[[:space:]]*"\(0x[0-9a-fA-F]\{64\}\)".*$/\1/p' "$OUT" | head -n 1)
    marker "$L/wallet-swept-eth-$ROLE.marker" "${TXH:-unknown}"
  fi
  echo "== end $(date +%T)"; exit 0
fi
# a result file left empty by a refusal is not a result
[ -s "$OUT" ] || rm -f "$OUT"
echo "== end $(date +%T)"
if [ "$EC" -eq 1 ] && [ "$SENT" -eq 0 ] && [ ! -e "$OUT" ]; then echo "REFUSED by live.js before it broadcast anything (no 'sent:' line); nothing was sent"; exit 3; fi
if [ "$SENT" -eq 1 ]; then echo "live.js broadcast the sweep and did not finish (exit $EC): it MAY have been sent; look at the key's balance before doing anything"; exit 6; fi
exit 1
