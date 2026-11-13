#!/usr/bin/env bash
# usage: fund.sh [--dry-run]      Alice's funding of the contract with the wallet CLI, EXACTLY ONCE. REAL NOID without --dry-run:
# the operator runs it, after prepare.sh and `parano1d-cli contract create` (it runs check-object.sh itself and stops unless that says OK).
#
# Why a helper (run 9): `parano1d-cli contract fund` run twice (a double click is enough) makes TWO instances of the same contract.
# The tools then stop the swap on purpose: Bob does not lock on more than one fitting instance and Alice does not reveal, because
# once the secret is public Bob could close every instance. Each extra instance waits for the deadline D and costs a recovery close.
# Every guard below FAILS CLOSED: a check that cannot be made, or whose output is not exactly what was seen from the real tools, refuses
# (exit 3). It refuses
#   - an object file that check-object.sh does not vouch for: check-object.sh must exit 0 AND print, on a line of its own, exactly
#     `object file OK: ... fund exactly this address: o1...` (that address, the contract root, names the contract-keyed marker below);
#   - an amount that is not the swap file's: AMOUNT (the settings) is compared with the amount `swap-cli status` reads from the swap file
#     (check-object.sh compares the OPENING, not the amount);
#   - a wallet CLI that cannot list the contract's instances (a failed command is not "no instance"), any listing that is not either
#     empty or only `Slot N  incarnation M ...` lines, and a contract that already has an instance (`contract instances`);
#   - a second run, with TWO markers written atomically BEFORE the wallet CLI is called: $L/funded.marker (this run folder) and
#     funded-<contract root>.marker next to the object file (so another run folder, or a copy of this one, that uses the same object
#     file cannot fund the same contract again).
# The markers are not removed when the wallet CLI fails: look at the mempool and at `contract instances` before deleting them by hand
# (a funding that was accepted and is still pending is not an instance yet).
#
# --dry-run changes nothing and creates no marker. It prints, for the operator console to check, `object: <absolute path> sha256 <hex>`
# and `amount: <N> micro-NOID (swap file and AMOUNT agree)`, then `dry run: would fund ...`; a marker is reported as the reason a real
# run would be refused.
#
# Real shapes of the wallet CLI that this relies on: `contract instances` prints NOTHING and exits 0 for a contract without instance, prints
# `Error: ...` and exits 1 on a failure, and one line `Slot 635439  incarnation 757220  5.000000 NOID` per instance.
#
# Settings (in $L/env.local.sh when the defaults do not fit):
#   NOID_CLI   the wallet CLI: default /mnt/c/Parano1d/bin/parano1d-cli.exe under wsl, parano1d-cli (from PATH) in native mode
#   OBJ        the object file: default $PUB/swap.object.json
#   AMOUNT     micro-NOID, as everywhere in these helpers; it must equal the swap file's amount (checked here)
# bash 3.2 safe (the macOS /bin/bash): no mapfile, no GNU-only options.
set -u
. "$(dirname "$0")/env.sh"
DRY=0
case "${1:-}" in --dry-run) DRY=1 ;; "") ;; *) echo "usage: fund.sh [--dry-run]" >&2; exit 2 ;; esac
if [ "$LIVE_PLATFORM" = native ]; then _cli_default=parano1d-cli; else _cli_default=/mnt/c/Parano1d/bin/parano1d-cli.exe; fi
NOID_CLI=${NOID_CLI:-$_cli_default}
OBJ=${OBJ:-$PUB/swap.object.json}
command -v "$NOID_CLI" >/dev/null 2>&1 || [ -x "$NOID_CLI" ] || { echo "wallet CLI '$NOID_CLI' not found: set NOID_CLI in $L/env.local.sh" >&2; exit 2; }
[ -s "$OBJ" ] || { echo "no object file at $OBJ: run the wallet CLI's \`contract create swap.def.json --out swap.object.json\` first" >&2; exit 2; }
case "$OBJ" in /*) ;; *) OBJ="$PWD/$OBJ" ;; esac
case "$AMOUNT" in ''|*[!0-9]*) echo "AMOUNT '$AMOUNT' is not a whole number of micro-NOID" >&2; exit 2 ;; esac
NOID=$(printf '%d.%06d' $((AMOUNT / 1000000)) $((AMOUNT % 1000000)))
OBJ_CLI=$(win_path "$OBJ")          # the path as the wallet CLI sees it (a Windows path under wsl)

refuse() { echo "$1"; shift; if [ $# -gt 0 ]; then printf '%s\n' "$1" | tail -n 5; fi; exit 3; }

# 1. the object must be byte-for-byte the swap file's opening: check-object.sh exits 0 AND prints the OK line, whole and on its own line
OUT=$(bash "$(dirname "$0")/check-object.sh" "$OBJ" 2>&1 < /dev/null); EC=$?
OUT=$(printf '%s\n' "$OUT" | tr -d '\r')
OKRE='^object file OK: .* fund exactly this address: o1[0-9a-z]+$'
OKLINES=$(printf '%s\n' "$OUT" | grep -E "$OKRE" || true)
NOK=$(printf '%s\n' "$OKLINES" | grep -c . || true)
[ "$EC" -eq 0 ] || refuse "check-object.sh exited $EC; not funding:" "$OUT"
[ "$NOK" -eq 1 ] || refuse "check-object.sh did not say OK exactly once on a line of its own; not funding:" "$OUT"
ROOT=$(printf '%s\n' "$OKLINES" | sed -e 's/^.* fund exactly this address: //')
case "$ROOT" in o1*) ;; *) refuse "check-object.sh named no contract address; not funding:" "$OUT" ;; esac
printf '%s\n' "$OKLINES"

# 2. the amount funded is the swap file's amount (swap-cli status needs no passphrase)
STATUS=$("$BIN" status "$ALICE_FILE" 2>&1 < /dev/null); SEC=$?
[ "$SEC" -eq 0 ] || refuse "could not read the swap file's status (swap-cli status exited $SEC); not funding:" "$STATUS"
SWAP_AMOUNT=$(printf '%s\n' "$STATUS" | grep '"amount_micronoid"' | head -n 1 | sed -e 's/[^0-9]//g')
case "$SWAP_AMOUNT" in ''|*[!0-9]*) refuse "the swap file's amount could not be read; not funding:" "$STATUS" ;; esac
[ "$SWAP_AMOUNT" -eq "$AMOUNT" ] || refuse "REFUSED: AMOUNT is $AMOUNT micro-NOID but the swap file's amount is $SWAP_AMOUNT: fix AMOUNT in $L/env.local.sh; not funding"

# 3. no instance yet. Output and exit status are kept apart: a failed command is not "no instance", and neither is a listing of unknown shape.
INST=$("$NOID_CLI" contract instances "$OBJ_CLI" < /dev/null 2>&1); IEC=$?
INST=$(printf '%s\n' "$INST" | tr -d '\r')
[ "$IEC" -eq 0 ] || refuse "could not list the contract's instances (the wallet CLI exited $IEC); not funding:" "$INST"
INSTRE='^[[:space:]]*Slot[[:space:]]+[0-9]+[[:space:]]+incarnation[[:space:]]+[0-9]+'
N=$(printf '%s\n' "$INST" | grep -E -c "$INSTRE" || true)
OTHER=$(printf '%s\n' "$INST" | grep -v -E '^[[:space:]]*$' | grep -v -E "$INSTRE" | head -n 1 || true)
[ -z "$OTHER" ] || refuse "REFUSED: the wallet CLI's instance listing has a line that is not an instance line (unknown output is not \"no instance\"); not funding:" "$INST"
if [ "$N" -ge 1 ]; then echo "REFUSED: the contract already has $N instance(s); funding again would add another one (see the header of this script)"; exit 3; fi

# 4. the two markers
MK1="$L/funded.marker"
MK2="$(dirname "$OBJ")/funded-$ROOT.marker"
marker_at() { head -n 1 "$1" 2>/dev/null | tr -d '\r'; }

if [ "$DRY" = 1 ]; then
  if command -v sha256sum >/dev/null 2>&1; then SHA=$(sha256sum "$OBJ" | sed -e 's/[[:space:]].*$//')
  elif command -v shasum >/dev/null 2>&1; then SHA=$(shasum -a 256 "$OBJ" | sed -e 's/[[:space:]].*$//')
  elif command -v python3 >/dev/null 2>&1; then SHA=$(python3 -c 'import hashlib,sys;print(hashlib.sha256(open(sys.argv[1],"rb").read()).hexdigest())' "$OBJ")
  else refuse "no sha256sum, shasum or python3 to hash the object file with; not funding"; fi
  case "$SHA" in ''|*[!0-9a-f]*) refuse "the object file's sha256 could not be computed; not funding" ;; esac
  echo "object: $OBJ sha256 $SHA"
  echo "amount: $AMOUNT micro-NOID (swap file and AMOUNT agree)"
  REF=0
  if [ -e "$MK1" ]; then echo "dry run: a real run would be REFUSED: fund.sh already ran for this run folder (at $(marker_at "$MK1"))"; REF=1; fi
  if [ -e "$MK2" ]; then echo "dry run: a real run would be REFUSED: this contract was already funded through fund.sh (marker $MK2, at $(marker_at "$MK2"))"; REF=1; fi
  [ "$REF" -eq 0 ] || exit 3
  echo "dry run: would fund $NOID NOID once with: $NOID_CLI contract fund $OBJ_CLI $NOID"; exit 0
fi

# 5. exactly once per run folder AND per contract: both markers are created atomically, before the wallet CLI runs
[ ! -e "$MK2" ] || { echo "REFUSED: this contract was already funded through fund.sh (marker $MK2, at $(marker_at "$MK2")). The contract is funded once; do not fund again."; exit 3; }
if ! ( set -o noclobber; date -u +%Y-%m-%dT%H:%M:%SZ > "$MK1" ) 2>/dev/null; then
  echo "REFUSED: fund.sh already ran for this run folder (at $(marker_at "$MK1")). The contract is funded once; do not fund again."; exit 3
fi
if ! ( set -o noclobber; { date -u +%Y-%m-%dT%H:%M:%SZ; echo "run folder $L"; } > "$MK2" ) 2>/dev/null; then
  rm -f "$MK1"   # nothing was sent yet: free the first marker again
  echo "REFUSED: could not create the contract's marker $MK2 (it exists, or its folder is not writable); not funding"; exit 3
fi
echo "funding $NOID NOID (once) at $(date -u +%T) UTC"
"$NOID_CLI" contract fund "$OBJ_CLI" "$NOID"
