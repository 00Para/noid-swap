#!/usr/bin/env bash
# usage: tick.sh alice|bob [--apply] [extra swap-cli tick flags]
# One tick of one role. Read-only unless --apply (a read-only tick withholds a spend's parameters since REVIEW-3 F3,
# so the watch loop always applies). Every node answer is recorded under $L/rec; the tick's JSON goes to
# $L/last-tick-ROLE.json and a one-screen summary is printed.
set -u
. "$(dirname "$0")/env.sh"
ROLE=${1:?alice|bob}; shift
F=$(swap_file "$ROLE") || exit 2
load_passphrase || exit 2
mkdir -p "$L/rec"
read_lines NODES node_flags; read_lines FROM from_block_flags; read_lines REVEAL reveal_tx_flags
N=$(date +%H%M%S)
"$BIN" tick "$F" ${NODES[@]+"${NODES[@]}"} ${FROM[@]+"${FROM[@]}"} ${REVEAL[@]+"${REVEAL[@]}"} \
  --record-noid "$L/rec/$ROLE-noid-$N.json" --record-eth "$L/rec/$ROLE-eth-$N.json" "$@" \
  > "$L/last-tick-$ROLE.json" 2> "$L/last-tick-$ROLE.err"
EC=$?
echo "[$ROLE] tick exit $EC at $(date +%T)"; head -5 "$L/last-tick-$ROLE.err"
python3 - "$L/last-tick-$ROLE.json" <<'PY'
import sys, json
try: v = json.load(open(sys.argv[1]))
except Exception as e: print("no json:", e); sys.exit(0)
n = v.get("noid", {}) or {}; e = v.get("eth", {}) or {}
print("noid: tip", n.get("tip"), "instance", json.dumps(n.get("instance"))[:160], "matches", n.get("instance_matches_opening"),
      "pending", len(n.get("pending_calls") or []), "confirmed", json.dumps(n.get("confirmed_tx"))[:100], "tracked_pending", n.get("tracked_tx_pending"))
print("eth : latest", e.get("latest_block"), "finalized", e.get("finalized_block"), "ts", e.get("latest_timestamp"),
      "lock", json.dumps(e.get("lock"))[:200], "claimed", json.dumps(e.get("claimed"))[:80], "pending_preimage", e.get("pending_preimage"),
      "refunded", json.dumps(e.get("refunded"))[:80])
print("sources:", json.dumps(v.get("sources"))[:300])
print("events:", json.dumps(v.get("events"))[:300]); print("ACTION:", json.dumps(v.get("action"))[:600]); print("notes:", json.dumps(v.get("notes"))[:500])
print("intent:", json.dumps(v.get("intent"))[:300]); print("applied:", v.get("events_applied_to_file"), "phase_after:", v.get("phase_after"))
PY
exit $EC
