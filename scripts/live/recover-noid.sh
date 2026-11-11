#!/usr/bin/env bash
# usage: recover-noid.sh [--dry-run]      Alice's recovery close of EVERY instance of the run's contract, after the deadline D.
# REAL NOID moves without --dry-run: the operator runs it, once D has passed (a preview before D says "not a recovery" and is refused).
#
# What it does, for each instance listed by the wallet CLI's `contract instances`: preview the recovery close, check the preview
# (a recovery, terminal, no successor, nothing retained, authority and payout address = ALICE_NOID, fee between 5,800 and 50,000 micro-NOID,
# payout = AMOUNT - fee), then send it with --expected-txid chained to that very preview (run 2 lesson: a separate preview and send lose
# a block in between). A marker per instance ($L/recovered-SLOT.marker, written atomically BEFORE the send) refuses a second send of the
# same close; the marker is removed again when the wallet CLI fails, so the script can be run again.
#
# The wallet's ACTIVE address must be Alice's address (ALICE_NOID): the node refuses a recovery from another one. Check it first
# with `parano1d-cli address` (switch with `parano1d-cli address --use INDEX`).
#
# After it: the txids of the closes that were sent are in $L/recovered-txids.txt. For each one the operator runs
#   tick.sh alice --closed-by TXID --apply
# so that the swap file records the close (an instance is closed outside the tool; the tool never sees it by itself).
# The receipts are written next to the object file, as refund-SLOT.json.
#
# Why a helper (runs 9 and 10): Alice's recovery was a hand-made script of the wallet CLI; the tool offers `refund_noid` only for the one
# instance it accepted as the lock. After a double funding (run 9) nothing was accepted, and the NOID of every instance sat at the
# contract root until D. This helper closes all of them.
# Bug that shaped it: the wallet CLI reads standard input and swallowed the loop's list of instances, so the list is read on file
# descriptor 3 and every wallet CLI call has `< /dev/null`.
#
# Settings (in $L/env.local.sh when the defaults do not fit):
#   NOID_CLI     the wallet CLI: default /mnt/c/Parano1d/bin/parano1d-cli.exe under wsl, parano1d-cli (from PATH) in native mode
#   OBJ          the object file: default $PUB/swap.object.json
#   ALICE_NOID   Alice's address (o1...), as everywhere in these helpers: the one that must receive the payout
#   AMOUNT       micro-NOID, as everywhere in these helpers (the amount of the swap file)
set -u
. "$(dirname "$0")/env.sh"
DRY=0
case "${1:-}" in --dry-run) DRY=1 ;; "") ;; *) echo "usage: recover-noid.sh [--dry-run]" >&2; exit 2 ;; esac
if [ "$LIVE_PLATFORM" = native ]; then _cli_default=parano1d-cli; else _cli_default=/mnt/c/Parano1d/bin/parano1d-cli.exe; fi
NOID_CLI=${NOID_CLI:-$_cli_default}
OBJ=${OBJ:-$PUB/swap.object.json}
command -v "$NOID_CLI" >/dev/null 2>&1 || [ -x "$NOID_CLI" ] || { echo "wallet CLI '$NOID_CLI' not found: set NOID_CLI in $L/env.local.sh" >&2; exit 2; }
[ -s "$OBJ" ] || { echo "no object file at $OBJ: it is the file the wallet CLI's \`contract create\` wrote (set OBJ in $L/env.local.sh)" >&2; exit 2; }
[ -n "$ALICE_NOID" ] || { echo "ALICE_NOID is not set: put it in $L/env.local.sh" >&2; exit 2; }
case "$AMOUNT" in ''|*[!0-9]*) echo "AMOUNT '$AMOUNT' is not a whole number of micro-NOID" >&2; exit 2 ;; esac
command -v python3 >/dev/null 2>&1 || { echo "python3 not found (the preview check needs it)" >&2; exit 2; }
case "$OBJ" in /*) ;; *) OBJ="$PWD/$OBJ" ;; esac
OBJ_CLI=$(win_path "$OBJ")          # the path as the wallet CLI sees it (a Windows path under wsl)
cd "$(dirname "$OBJ")" || exit 2     # the receipts (refund-SLOT.json) are written to the current folder, next to the object file

# the preview check, as python text in a variable: a heredoc inside $( ) is not parsed by bash 3.2 when the text has quotes or parentheses
IFS= read -r -d '' CHECK_PY <<'PY'
import sys, json
try:
    p = json.load(open(sys.argv[1]))
except Exception as e:
    print("ERR preview is not JSON: %s" % e); sys.exit(0)
alice, amount = sys.argv[2], int(sys.argv[3])
bad = []
if p.get("recovery") is not True: bad.append("not a recovery (before D?)")
if p.get("terminal") is not True: bad.append("not terminal")
if p.get("successor") is not None: bad.append("has a successor")
if p.get("retained_micronoid") != 0: bad.append("retains funds")
if p.get("authority") != alice: bad.append("authority is not Alice's address (wrong active wallet address?)")
pay = p.get("payout") or {}
if pay.get("address") != alice: bad.append("payout address is not Alice's")
fee = p.get("fee_micronoid")
if not isinstance(fee, int) or fee < 5800 or fee > 50000: bad.append("fee %r outside 5,800..50,000" % (fee,))
elif pay.get("amount_micronoid") != amount - fee: bad.append("payout %r is not amount - fee" % (pay.get("amount_micronoid"),))
if bad: print("ERR " + "; ".join(bad))
else: print(p["txid"])
PY

date -u +"%T UTC, run $RUN, amount $AMOUNT"
"$NOID_CLI" contract instances "$OBJ_CLI" < /dev/null 2>&1 | tr -d '\r' | grep -i '^[[:space:]]*slot' > "$L/instances-now.txt"
N=$(wc -l < "$L/instances-now.txt" | tr -d ' ')
echo "instances at the contract: $N"
[ "$N" -ge 1 ] || { echo "nothing to recover"; exit 0; }
FAIL=0
while read -r _ SLOT _ INC REST <&3; do
  echo "--- slot $SLOT incarnation $INC ($REST)"
  "$NOID_CLI" contract call "$OBJ_CLI" "$SLOT" "$INC" --close --preview < /dev/null 2>&1 | tr -d '\r' > "$L/recover-preview-$SLOT.json"
  python3 -c "$CHECK_PY" "$L/recover-preview-$SLOT.json" "$ALICE_NOID" "$AMOUNT" > "$L/recover-check-$SLOT.txt" < /dev/null
  TXID=$(cat "$L/recover-check-$SLOT.txt")
  case "$TXID" in
    ERR*|"") echo "preview REFUSED: $TXID"; head -c 300 "$L/recover-preview-$SLOT.json"; echo; FAIL=1; continue ;;
  esac
  echo "preview ok: recovery close, terminal, payout to Alice's own address (amount minus the close fee), txid $TXID"
  if [ "$DRY" = 1 ]; then
    [ -e "$L/recovered-$SLOT.marker" ] && echo "(a real run would be refused: this close was already sent at $(cat "$L/recovered-$SLOT.marker"))"
    continue
  fi
  if ! ( set -o noclobber; date -u +%Y-%m-%dT%H:%M:%SZ > "$L/recovered-$SLOT.marker" ) 2>/dev/null; then
    echo "REFUSED: the close of slot $SLOT was already sent (at $(cat "$L/recovered-$SLOT.marker"))"; continue
  fi
  "$NOID_CLI" contract call "$OBJ_CLI" "$SLOT" "$INC" --close --expected-txid "$TXID" --out "refund-$SLOT.json" --wait-seconds 300 < /dev/null > "$L/recover-send-$SLOT.out" 2>&1
  EC=$?
  tr -d '\r' < "$L/recover-send-$SLOT.out" | tail -n 6 | cut -c1-200
  if [ "$EC" = 0 ]; then
    echo "$TXID" >> "$L/recovered-txids.txt"; echo "sent: slot $SLOT closed by $TXID"
  else
    # refused or failed (for example a new block between the preview and the send changes the txid): free the marker so the
    # script can be run again. If the close did go out, a second one is rejected by the node (the instance is spent or pending).
    rm -f "$L/recovered-$SLOT.marker"; echo "wallet CLI exit $EC for slot $SLOT: NOT recorded as sent; run the script again"; FAIL=1
  fi
done 3< "$L/instances-now.txt"
if [ "$DRY" = 0 ]; then echo "txids of the closes sent so far: $L/recovered-txids.txt; next, for each: tick.sh alice --closed-by TXID --apply"; fi
exit $FAIL
