#!/usr/bin/env bash
# usage: fund.sh [--dry-run]      Alice's funding of the contract with the wallet CLI, EXACTLY ONCE. REAL NOID without --dry-run:
# the operator runs it, after prepare.sh and `parano1d-cli contract create` (it runs check-object.sh itself and stops unless that says OK).
#
# Why a helper (run 9): `parano1d-cli contract fund` run twice (a double click is enough) makes TWO instances of the same contract.
# The tools then stop the swap on purpose: Bob does not lock on more than one fitting instance and Alice does not reveal, because
# once the secret is public Bob could close every instance. Each extra instance waits for the deadline D and costs a recovery close.
# So this helper refuses
#   - a second run for the same run folder (a marker file, written atomically BEFORE the wallet CLI is called), and
#   - a contract that already has an instance (`contract instances`).
# The marker is not removed when the wallet CLI fails: look at the mempool and at `contract instances` before deleting
# $L/funded.marker by hand (a funding that was accepted and is still pending is not an instance yet).
#
# Settings (in $L/env.local.sh when the defaults do not fit):
#   NOID_CLI   the wallet CLI: default /mnt/c/Parano1d/bin/parano1d-cli.exe under wsl, parano1d-cli (from PATH) in native mode
#   OBJ        the object file: default $PUB/swap.object.json
#   AMOUNT     micro-NOID, as everywhere in these helpers (the amount of the swap file; check-object.sh has compared the opening)
set -u
. "$(dirname "$0")/env.sh"
DRY=0
case "${1:-}" in --dry-run) DRY=1 ;; "") ;; *) echo "usage: fund.sh [--dry-run]" >&2; exit 2 ;; esac
if [ "$LIVE_PLATFORM" = native ]; then _cli_default=parano1d-cli; else _cli_default=/mnt/c/Parano1d/bin/parano1d-cli.exe; fi
NOID_CLI=${NOID_CLI:-$_cli_default}
OBJ=${OBJ:-$PUB/swap.object.json}
command -v "$NOID_CLI" >/dev/null 2>&1 || [ -x "$NOID_CLI" ] || { echo "wallet CLI '$NOID_CLI' not found: set NOID_CLI in $L/env.local.sh" >&2; exit 2; }
[ -s "$OBJ" ] || { echo "no object file at $OBJ: run the wallet CLI's \`contract create swap.def.json --out swap.object.json\` first" >&2; exit 2; }
case "$AMOUNT" in ''|*[!0-9]*) echo "AMOUNT '$AMOUNT' is not a whole number of micro-NOID" >&2; exit 2 ;; esac
NOID=$(printf '%d.%06d' $((AMOUNT / 1000000)) $((AMOUNT % 1000000)))
OBJ_CLI=$(win_path "$OBJ")          # the path as the wallet CLI sees it (a Windows path under wsl)

# 1. the object must be byte-for-byte the swap file's opening
OUT=$(bash "$(dirname "$0")/check-object.sh" "$OBJ" 2>&1)
echo "$OUT" | grep -q "object file OK" || { echo "check-object.sh did not say OK; not funding:"; echo "$OUT" | tail -n 5; exit 3; }
echo "$OUT" | grep "object file OK"

# 2. no instance yet
N=$("$NOID_CLI" contract instances "$OBJ_CLI" 2>&1 | grep -c -i '^[[:space:]]*slot')
if [ "$N" -ge 1 ]; then echo "REFUSED: the contract already has $N instance(s); funding again would add another one (see the header of this script)"; exit 3; fi

if [ "$DRY" = 1 ]; then
  if [ -e "$L/funded.marker" ]; then echo "dry run: a real run would be REFUSED: fund.sh already ran for this run folder (at $(cat "$L/funded.marker"))"; exit 3; fi
  echo "dry run: would fund $NOID NOID once with: $NOID_CLI contract fund $OBJ_CLI $NOID"; exit 0
fi

# 3. exactly once per run folder: the marker is created atomically, before the wallet CLI runs
if ! ( set -o noclobber; date -u +%Y-%m-%dT%H:%M:%SZ > "$L/funded.marker" ) 2>/dev/null; then
  echo "REFUSED: fund.sh already ran for this run folder (at $(cat "$L/funded.marker")). The contract is funded once; do not fund again."; exit 3
fi
echo "funding $NOID NOID (once) at $(date -u +%T) UTC"
"$NOID_CLI" contract fund "$OBJ_CLI" "$NOID"
