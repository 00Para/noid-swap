#!/usr/bin/env bash
# usage: watch.sh [alice|bob|both] [interval_s]
# Tick the role(s) with --apply every interval (default 30 s) and append one summary line per tick to
# $L/loop-ROLE.txt. Stops by itself once every watched file is terminal (phase_after done/refunded/lost/aborted; a `done` that still names a leftover leg to refund does not count).
# Run 3 lesson: never edit a helper in place while a loop calls it; install.sh freezes a copy under $L/bin.
set -u
. "$(dirname "$0")/env.sh"
WHO=${1:-both}; EVERY=${2:-30}
case $WHO in alice) ROLES=(alice);; bob) ROLES=(bob);; both) ROLES=(alice bob);; *) echo "alice|bob|both"; exit 2;; esac
HERE=$(dirname "$0")
# part REGEX MAXCHARS: the lines of the tick output that match, each cut to MAXCHARS, joined with spaces
part() { printf '%s\n' "$OUT" | grep -E "$1" | head -n 8 | cut -c1-"$2" | tr '\n' ' ' | sed -e 's/ $//'; }
while true; do
  TERMINAL=0
  for R in "${ROLES[@]}"; do
    OUT=$(bash "$HERE/tick.sh" "$R" --apply 2>&1)
    # run 13: one cut of the whole line at 1,200 characters lost `phase_after` after a long recorded intent. Now each part is cut on
    # its own (the long ones generously) and `applied: ... phase_after: ...` is appended whole, last, so no cut can remove it.
    LINE="$(date +%T) $(part '^\[' 300) $(part '^noid:' 600) $(part '^eth :' 700) $(part '^ACTION' 800) $(part '^notes:' 1500) $(part '^ALERT:' 400) $(part '^intent' 700) $(part '^applied|^phase_after' 400)"
    echo "$LINE" >> "$L/loop-$R.txt"
    # Optional (ALERT_URL in $L/env.local.sh): every new line that starts with ALERT: is sent once as a short message; a failure never stops the loop.
    printf '%s\n' "$OUT" | alert_hook || true
    # CHAOS F-16 / review M3: `done` is not terminal while a leftover leg can still be refunded: the action then names it
    # (a refund_noid / refund_eth, a "still at the contract" / "ETH lock is still open" wait, a refund already submitted).
    case "$LINE" in
      *"phase_after: done"*) case "$LINE" in *refund_*|*"still at the contract"*|*"ETH lock is still open"*|*"already submitted"*|*"open past T_reveal"*|*"taking it back"*) ;; *) TERMINAL=$((TERMINAL+1));; esac;;
      *"phase_after: refunded"*|*"phase_after: lost"*|*"phase_after: aborted"*) TERMINAL=$((TERMINAL+1));;
    esac
  done
  [ "$TERMINAL" -eq "${#ROLES[@]}" ] && { echo "all watched files terminal at $(date +%T)"; exit 0; }
  sleep "$EVERY"
done
