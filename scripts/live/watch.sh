#!/usr/bin/env bash
# usage: watch.sh [alice|bob|both] [interval_s]
# Tick the role(s) with --apply every interval (default 30 s) and append one summary line per tick to
# $L/loop-ROLE.txt. Stops by itself once every watched file is terminal (phase_after done/refunded/lost/aborted).
# Run 3 lesson: never edit a helper in place while a loop calls it; install.sh freezes a copy under $L/bin.
set -u
. "$(dirname "$0")/env.sh"
WHO=${1:-both}; EVERY=${2:-30}
case $WHO in alice) ROLES=(alice);; bob) ROLES=(bob);; both) ROLES=(alice bob);; *) echo "alice|bob|both"; exit 2;; esac
HERE=$(dirname "$0")
while true; do
  TERMINAL=0
  for R in "${ROLES[@]}"; do
    OUT=$(bash "$HERE/tick.sh" "$R" --apply 2>&1)
    LINE="$(date +%T) $(echo "$OUT" | grep -E '^\[|^ACTION|^noid:|^eth :|^notes:|^phase_after|^applied|^intent' | tr '\n' ' ' | cut -c1-1200)"
    echo "$LINE" >> "$L/loop-$R.txt"
    case "$LINE" in *"phase_after: done"*|*"phase_after: refunded"*|*"phase_after: lost"*|*"phase_after: aborted"*) TERMINAL=$((TERMINAL+1));; esac
  done
  [ "$TERMINAL" -eq "${#ROLES[@]}" ] && { echo "all watched files terminal at $(date +%T)"; exit 0; }
  sleep "$EVERY"
done
