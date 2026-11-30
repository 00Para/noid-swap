#!/usr/bin/env bash
# usage: wallet-recover.sh [--dry-run | --record]      Alice's recovery close after the deadline D, from her swap wallet (swap-cli wallet recover), and the recording of that
# close in her swap file (tick --closed-by TXID --apply). REAL NOID moves without --dry-run and --record. NOT run against a real node or a public network; selftest.sh covers it
# against stub tools only. This is the wallet run's `recover-noid.sh`: recover-noid.sh refuses in a wallet run.
#
# Two stages, each reported on its own:
#   A (the default, and --dry-run):  swap-cli wallet recover builds, proves and verifies the close of the swap's own instance (it pays the committed recovery recipient, the swap
#      wallet; allowed only at or after D) and, without --dry-run, sends it. The transaction's bytes are written beside the swap file BEFORE the send, so a second run sends the
#      SAME bytes, never a second close. After a send the txid is kept in $L/wallet-recovered-txid.txt, and stage B is tried at once: a close that has only just been sent is not
#      confirmed yet, so the tool refuses to record it (it says why) and that is reported, not an error of the send.
#   B (--record):  `tick.sh alice --closed-by TXID --apply` with the txid of stage A. The tool records the close only when the transaction is confirmed (and final where it
#      says so) and the instance is gone; otherwise it refuses and writes nothing. Run it again later (the console's autopilot does, about once a minute, until it holds).
# After B holds, the swap file is `refunded` and the leftovers can be swept (wallet-sweep.sh).
#
# stdout (the operator console reads it; values are validated plain tokens):
#   wallet-recover: wallet o1...  /  wallet-recover: outcome ...  target amount_micronoid fee_micronoid inputs child_height txid summary     (stage A, as wallet-fund.sh)
#   dry run: would recover N micro-NOID ...; nothing was written or sent                                                                   (--dry-run, stage A built)
#   wallet-recover: closed-by recorded txid T                          stage B held (the swap file records the close)
#   wallet-recover: closed-by NOT recorded yet: <the tool's words>      stage B was refused, nothing was written
#
# Exit status:
#   0  stage A: a dry run was built, or the close was sent (stage B's result is a line, not the status).  --record: the close is recorded in the swap file.
#   2  usage, a setting or a tool is wrong: not a wallet run, no swap file, no passphrase file, swap-cli / python3 missing. Nothing was built or sent.
#   3  refused, nothing sent: swap-cli refused (its words are shown) or its submit failed everywhere.  --record: swap-cli refused to record (nothing was written).
#   4  nothing was sent by this run: the tool says to wait (before D, the instance is not at the contract, a state it does not judge) or that there is nothing to recover.
#      --record: no recovery close was sent yet (no txid on file).
#   6  the close MAY HAVE BEEN SENT (the tool could not tell): run this again; it sends the same recorded bytes, never a second close
#   1  anything else (an unknown exit status, an unreadable output after a real submit, a signal): treat it as possibly sent
set -u
. "$(dirname "$0")/env.sh"
san() { LC_ALL=C tr -d '\000-\010\013-\037\177'; }
MODE=send
case "${1:-}" in --dry-run) MODE=dry ;; --record) MODE=record ;; "") ;; *) echo "usage: wallet-recover.sh [--dry-run | --record]" >&2; exit 2 ;; esac
[ $# -le 1 ] || { echo "usage: wallet-recover.sh [--dry-run | --record]" >&2; exit 2; }
require_wallet_run || exit 2
[ -s "$L/passphrase.txt" ] || { echo "no $L/passphrase.txt (run setup.sh first)" >&2; exit 2; }
[ -x "$BIN" ] || { echo "swap-cli not found or not executable at '$BIN'" >&2; exit 2; }
command -v python3 >/dev/null 2>&1 || { echo "python3 not found" >&2; exit 2; }
[ -f "$ALICE_FILE" ] || { echo "no swap file at $ALICE_FILE" >&2; exit 2; }
HERE=$(dirname "$0")
TXFILE="$L/wallet-recovered-txid.txt"
N=$(date +%H%M%S)
echo "== start $(date +%T), run $RUN, wallet recovery ($MODE)"

# record_close: stage B. Sets RECORD_RC: 0 recorded, 3 refused (nothing written), 4 no txid on file.
record_close() {
  local tx out ec
  tx=$(head -n 1 "$TXFILE" 2>/dev/null | tr -d ' \t\r\n')
  if [ -z "$tx" ] || ! [[ "$tx" =~ ^[0-9a-f]{64}$ ]]; then echo "wallet-recover: no recovery close was sent from this run folder (no txid on file); nothing to record"; RECORD_RC=4; return 0; fi
  out="$L/wallet-record-$N.out"
  bash "$HERE/tick.sh" alice --closed-by "$tx" --apply > "$out" 2>&1 < /dev/null; ec=$?
  if [ "$ec" -eq 0 ] && grep -q '^applied: True' "$out"; then
    echo "wallet-recover: closed-by recorded txid $tx"; RECORD_RC=0
  else
    echo "wallet-recover: closed-by NOT recorded yet (tick exit $ec); the swap file was not changed. The tool's words:"
    grep -v '^$' "$out" | head -n 6 | cut -c1-300 | san | sed -e 's/^/  | /'
    RECORD_RC=3
  fi
  return 0
}
if [ "$MODE" = record ]; then
  record_close
  echo "== end $(date +%T)"
  exit "$RECORD_RC"
fi

DRY=0; [ "$MODE" = dry ] && DRY=1
BASE="$L/wallet-recover-$([ "$DRY" = 1 ] && echo dry-)$N"
"$BIN" wallet address "$ALICE_FILE" > "$BASE.addr.json" 2> "$BASE.addr.err" < /dev/null; AEC=$?
WADDR=$(wallet_json_value "$BASE.addr.json" address)
NOID_RE='^o1[0-9a-z]{20,100}$'
if [ "$AEC" -ne 0 ] || ! [[ "$WADDR" =~ $NOID_RE ]]; then
  echo "REFUSED: swap-cli wallet address did not name the wallet (exit $AEC); nothing was built or sent:"; head -c 400 "$BASE.addr.err" | san; echo; exit 3
fi
echo "wallet-recover: wallet $WADDR"
wallet_step recover "$BASE" "$DRY"
wallet_step_report wallet-recover
echo "wallet-recover exit $WSTEP_RC (swap-cli wallet recover, outcome $(wallet_kv "$WSTEP_PARSED" outcome))"
if [ -z "$WSTEP_PARSED" ]; then echo "swap-cli's words:"; head -c 600 "$BASE.err" | san; echo; fi
OUTCOME=$(wallet_kv "$WSTEP_PARSED" outcome)
TX=$(wallet_kv "$WSTEP_PARSED" txid)
if [ "$DRY" = 1 ] && [ "$WSTEP_RC" -eq 0 ]; then
  echo "dry run: would recover $(wallet_kv "$WSTEP_PARSED" amount_micronoid) micro-NOID once to the swap wallet (the committed recovery recipient); nothing was written or sent"
fi
if [ "$DRY" = 0 ] && { { [ "$OUTCOME" = sent ] && [ "$WSTEP_RC" -eq 0 ]; } || { [ "$OUTCOME" = maybe_sent ] && [ "$WSTEP_RC" -eq 6 ]; }; } && [[ "$TX" =~ ^[0-9a-f]{64}$ ]]; then
  # the txid is kept for stage B. The NEWEST one replaces an older one (temporary file, then rename): the tool builds a new close only after the
  # old one's window has passed with the instance still unspent, so the older txid can never land, and stage B would wait for it for ever.
  # Recording is still safe with any txid: tick --closed-by takes it only when the node shows it confirmed and the instance gone.
  if echo "$TX" > "$TXFILE.tmp.$$" 2>/dev/null; then mv -f "$TXFILE.tmp.$$" "$TXFILE" 2>/dev/null || rm -f "$TXFILE.tmp.$$"; fi
fi
if [ "$WSTEP_RC" -eq 6 ]; then echo "THE CLOSE MAY HAVE BEEN SENT: run this again; it sends the same recorded bytes (never a second close)"; fi
if [ "$DRY" = 0 ] && [ "$WSTEP_RC" -eq 0 ]; then record_close; fi
echo "== end $(date +%T)"
exit "$WSTEP_RC"
