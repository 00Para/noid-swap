#!/usr/bin/env bash
# usage: reveal.sh [--dry-run]     Alice's reveal = her claim of the ETH. The secret goes from the sealed file (WSL)
# over a pipe into Windows node (live.js claim --secret-stdin); never argv, never a terminal, never a file.
# live.js claim --swap FILE checks receiver, sender, amount, hashlock and the earlier of (T_reveal - margin) and the
# cutoff the intent froze. --dry-run needs no secret and sends nothing. REAL reveal otherwise: owner's go-ahead first.
set -u
. "$(dirname "$0")/env.sh"
cd "$ETH_DIR" || exit 2
N=$(date +%H%M%S)
ARGS=(scripts/live.js claim --swap "$(win_path "$ALICE_FILE")" --key-file keys/alice.key --chain-id "$CHAIN")
if [ "${1:-}" = "--dry-run" ]; then
  "$NODE" "${ARGS[@]}" --dry-run > "$L/eth-claim-dry-$N.json" 2> "$L/eth-claim-dry-$N.err"; EC=$?
  echo "claim dry-run exit $EC"; head -c 600 "$L/eth-claim-dry-$N.err"; echo; head -c 900 "$L/eth-claim-dry-$N.json"; echo
  exit $EC
fi
load_passphrase || exit 2
"$BIN" secret "$ALICE_FILE" 2>/dev/null | "$NODE" "${ARGS[@]}" --secret-stdin > "$L/eth-claim.json" 2> "$L/eth-claim.err"
EC=${PIPESTATUS[1]}
echo "claim exit $EC at $(date +%T)"; head -c 600 "$L/eth-claim.err"; echo
python3 - "$L/eth-claim.json" <<'PY'
import sys, json
try: d = json.load(open(sys.argv[1]))
except Exception as e: print("no json:", e); sys.exit(0)
print(json.dumps({k: d.get(k) for k in ("sent", "txHash", "blockNumber", "blockTimestamp", "lockId", "receiver", "amountWei", "cutoff", "lockBlock", "finalizedBlock")}, indent=1))
PY
cp "$L/eth-claim.json" "$PUB/eth-claim.json" 2>/dev/null
exit $EC
