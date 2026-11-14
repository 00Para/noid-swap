#!/usr/bin/env bash
# usage: fund.sh [--dry-run]      Alice's funding of the contract with the wallet CLI, EXACTLY ONCE. REAL NOID without --dry-run:
# the operator runs it, after prepare.sh and `parano1d-cli contract create` (it runs check-object.sh itself and stops unless that says OK).
#
# Why a helper (run 9): `parano1d-cli contract fund` run twice (a double click is enough) makes TWO instances of the same contract.
# The tools then stop the swap on purpose: Bob does not lock on more than one fitting instance and Alice does not reveal, because
# once the secret is public Bob could close every instance. Each extra instance waits for the deadline D and costs a recovery close.
# Every guard below FAILS CLOSED: a check that cannot be made, or whose output is not exactly what was seen from the real tools, refuses
# (exit 3; a setting that is wrong or a folder that cannot be written: exit 2). It refuses
#   - an AMOUNT, or a swap file amount, that is not a plain decimal number without a leading zero (and not 0): `05000000` would be read
#     as octal by the shell's arithmetic;
#   - an object file that check-object.sh does not vouch for: check-object.sh must exit 0 AND print, on a line of its own, exactly
#     `object file OK: ... fund exactly this address: o1...` (that address, the contract root, names the markers below). A carriage
#     return inside a line of its output refuses (only the one at the end of a line, from a Windows exe, is taken off);
#   - an amount that is not the swap file's: AMOUNT (the settings) is compared with the amount `swap-cli status` reads from the swap file,
#     from the line `  "amount_micronoid": <digits>,` of the top level, which must be there exactly once (check-object.sh compares the
#     OPENING, not the amount);
#   - a wallet CLI that cannot list the contract's instances (a failed command is not "no instance"), any listing that is not either
#     empty or only `Slot N  incarnation M ...` lines, and a contract that already has an instance (`contract instances`);
#   - a second run, with THREE markers written atomically BEFORE the wallet CLI is called, each checked first and rolled back if a later
#     one cannot be made: $HOME/.noid-swap/funded/<contract root> (this user, any run folder), funded-<contract root>.marker next to the
#     ORIGINAL object file (any run folder that uses this object file) and $L/funded.marker (this run folder). A marker path that is
#     not a regular file refuses.
# The object file is copied once per process into a folder of its own, $L/fund-object.XXXXXX/fund-object.json (folder mode 700, file
# mode 600), and everything below works on that COPY: check-object.sh, the hash, the instance listing and the funding. Another process
# (the original file, or another fund.sh in this run folder) cannot swap the copy between the check and the funding; its hash is
# checked again after the markers are made. The folder is removed when the script ends (not after a kill -9). It refuses, before any
# marker, when the wallet CLI's path of the copy cannot be worked out (wslpath failed or printed nothing). The wallet CLI gets no stdin.
# The run folder's marker records what happened: the time (first line), `stage: calling wallet CLI` before the call, then the wallet
# CLI's own output (the real CLI prints `Funding submitted: <txid>`) and `wallet exit <code>`. The markers are not removed when the
# wallet CLI fails or is interrupted: a marker whose stage is "calling wallet CLI" with no "wallet exit" line means the call may or may
# not have gone out. Look at the txid, the mempool and `contract instances` before deleting ALL the markers by hand (a funding that was
# accepted and is still pending is not an instance yet).
#
# The operator console's "I have funded" box (a funding done outside this script) writes $L/funded.marker and the object folder's marker with the
# second line `acknowledged: funded outside fund.sh`; this script then refuses and shows that line.
#
# --dry-run creates no marker and funds nothing and leaves nothing behind (the private copy is removed at the end). It prints, for the
# operator console to check, `object: <absolute path of the ORIGINAL> sha256 <hex of the copy>` and
# `amount: <N> micro-NOID (swap file and AMOUNT agree)`, then `dry run: would fund ...`; a marker is reported as the reason a real
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
# a plain decimal number: digits only, no leading zero (so also not 0), at most 18 digits (fits the shell's arithmetic)
plain_amount() { case "$1" in ''|0*|*[!0-9]*) return 1 ;; esac; [ "${#1}" -le 18 ]; }
plain_amount "$AMOUNT" || { echo "AMOUNT '$AMOUNT' is not a plain whole number of micro-NOID (digits only, no leading zero, not 0): fix it in $L/env.local.sh" >&2; exit 2; }
NOID=$(printf '%d.%06d' $((AMOUNT / 1000000)) $((AMOUNT % 1000000)))

CR=$(printf '\r')
refuse() { echo "$1"; shift; if [ $# -gt 0 ]; then printf '%s\n' "$1" | tail -n 5; fi; exit 3; }
# tool output: the carriage return at the end of a line (a Windows exe) is taken off; one inside a line refuses
clean_output() {
  local t
  t=$(printf '%s\n' "$1" | sed -e "s/$CR\$//")
  case "$t" in *"$CR"*) return 1 ;; esac
  printf '%s\n' "$t"
}
sha_of() {
  local h=''
  if command -v sha256sum >/dev/null 2>&1; then h=$(sha256sum "$1" | sed -e 's/[[:space:]].*$//')
  elif command -v shasum >/dev/null 2>&1; then h=$(shasum -a 256 "$1" | sed -e 's/[[:space:]].*$//')
  elif command -v python3 >/dev/null 2>&1; then h=$(python3 -c 'import hashlib,sys;print(hashlib.sha256(open(sys.argv[1],"rb").read()).hexdigest())' "$1")
  else echo "no sha256sum, shasum or python3 to hash the object file with; not funding" >&2; return 1; fi
  case "$h" in ''|*[!0-9a-f]*) echo "the object file's sha256 could not be computed; not funding" >&2; return 1 ;; esac
  printf '%s\n' "$h"
}
mk_exists() { [ -e "$1" ] || [ -L "$1" ]; }
mk_regular() { [ -f "$1" ] && [ ! -L "$1" ]; }
marker_at() { head -n 1 "$1" 2>/dev/null | tr -d '\r'; }

# 0. the private copy of the object file: a folder of its own for this process ($L/fund-object.XXXXXX, mode 700) with the copy in it (mode 600),
#    so that no other fund.sh or dry run in this run folder can replace it. The folder is removed when the script ends, whatever the exit.
MK1="$L/funded.marker"
CDIR=''
trap '[ -z "$CDIR" ] || rm -rf "$CDIR" 2>/dev/null' EXIT
trap 'exit 130' INT TERM HUP
CDIR=$(mktemp -d "$L/fund-object.XXXXXX" 2>/dev/null) || CDIR=''
if [ -z "$CDIR" ] || [ ! -d "$CDIR" ] || [ -L "$CDIR" ] || ! chmod 700 "$CDIR" 2>/dev/null; then
  echo "cannot make the private copy's folder under $L: is the run folder $L writable? Not funding" >&2; exit 2
fi
COPY="$CDIR/fund-object.json"
if ! { ( umask 077; cp "$OBJ" "$COPY" ) 2>/dev/null && chmod 600 "$COPY" 2>/dev/null; }; then
  echo "cannot write the private copy $COPY: is the run folder $L writable? Not funding" >&2; exit 2
fi
[ -f "$COPY" ] && [ ! -L "$COPY" ] || { echo "the private copy $COPY is not a regular file; not funding" >&2; exit 2; }
OBJ_CLI=$(win_path "$COPY" 2>/dev/null) && [ -n "$OBJ_CLI" ] || refuse "cannot work out the wallet CLI's path of the private copy $COPY (wslpath failed or printed nothing); not funding"

# 1. the object must be byte-for-byte the swap file's opening: check-object.sh exits 0 AND prints the OK line, whole and on its own line
OUT=$(bash "$(dirname "$0")/check-object.sh" "$COPY" 2>&1 < /dev/null); EC=$?
OUT=$(clean_output "$OUT") || refuse "check-object.sh printed a carriage return inside a line; not funding:" "$(printf '%s\n' "$OUT" | tr '\r' '?')"
OKRE='^object file OK: .* fund exactly this address: o1[0-9a-z]+$'
OKLINES=$(printf '%s\n' "$OUT" | grep -E "$OKRE" || true)
NOK=$(printf '%s\n' "$OKLINES" | grep -c . || true)
[ "$EC" -eq 0 ] || refuse "check-object.sh exited $EC; not funding:" "$OUT"
[ "$NOK" -eq 1 ] || refuse "check-object.sh did not say OK exactly once on a line of its own; not funding:" "$OUT"
ROOT=$(printf '%s\n' "$OKLINES" | sed -e 's/^.* fund exactly this address: //')
case "$ROOT" in o1*) ;; *) refuse "check-object.sh named no contract address; not funding:" "$OUT" ;; esac
printf '%s\n' "$OKLINES"
SHA=$(sha_of "$COPY") || exit 3

# 2. the amount funded is the swap file's amount (swap-cli status needs no passphrase)
STATUS=$("$BIN" status "$ALICE_FILE" 2>&1 < /dev/null); SEC=$?
[ "$SEC" -eq 0 ] || refuse "could not read the swap file's status (swap-cli status exited $SEC); not funding:" "$STATUS"
STATUS=$(printf '%s\n' "$STATUS" | sed -e "s/$CR\$//")
AMT_RE='^  "amount_micronoid": [0-9]+,?$'
NAMT=$(printf '%s\n' "$STATUS" | grep -E -c "$AMT_RE" || true)
[ "$NAMT" -eq 1 ] || refuse "the swap file's status has $NAMT top-level amount_micronoid line(s) (exactly one is needed); not funding:" "$STATUS"
SWAP_AMOUNT=$(printf '%s\n' "$STATUS" | grep -E "$AMT_RE" | sed -e 's/[^0-9]//g')
plain_amount "$SWAP_AMOUNT" || refuse "the swap file's amount '$SWAP_AMOUNT' is not a plain decimal number; not funding:" "$STATUS"
[ "$SWAP_AMOUNT" = "$AMOUNT" ] || refuse "REFUSED: AMOUNT is $AMOUNT micro-NOID but the swap file's amount is $SWAP_AMOUNT: fix AMOUNT in $L/env.local.sh; not funding"

# 3. no instance yet. Output and exit status are kept apart: a failed command is not "no instance", and neither is a listing of unknown shape.
INST=$("$NOID_CLI" contract instances "$OBJ_CLI" < /dev/null 2>&1); IEC=$?
INST=$(clean_output "$INST") || refuse "the instance listing has a carriage return inside a line; not funding:" "$(printf '%s\n' "$INST" | tr '\r' '?')"
[ "$IEC" -eq 0 ] || refuse "could not list the contract's instances (the wallet CLI exited $IEC); not funding:" "$INST"
INSTRE='^[[:space:]]*Slot[[:space:]]+[0-9]+[[:space:]]+incarnation[[:space:]]+[0-9]+'
N=$(printf '%s\n' "$INST" | grep -E -c "$INSTRE" || true)
OTHER=$(printf '%s\n' "$INST" | grep -v -E '^[[:space:]]*$' | grep -v -E "$INSTRE" | head -n 1 || true)
[ -z "$OTHER" ] || refuse "REFUSED: the wallet CLI's instance listing has a line that is not an instance line (unknown output is not \"no instance\"); not funding:" "$INST"
if [ "$N" -ge 1 ]; then echo "REFUSED: the contract already has $N instance(s); funding again would add another one (see the header of this script)"; exit 3; fi

# 4. the three markers: this user (any run folder), the object file's folder (any run folder), this run folder
MK3D="$HOME/.noid-swap/funded"
MK3="$MK3D/$ROOT"
MK2="$(dirname "$OBJ")/funded-$ROOT.marker"
RECOVERY='A marker whose stage is "calling wallet CLI" with no "wallet exit" line means the call may or may not have gone out: check the txid and `contract instances` before deleting ALL the markers above by hand.'
describe_markers() {
  local m label l
  echo "markers: $MK3 (this user) | $MK2 (object folder) | $MK1 (run folder)"
  for m in "$MK3" "$MK2" "$MK1"; do
    mk_regular "$m" || continue
    case "$m" in "$MK3") label="this user" ;; "$MK2") label="object folder" ;; *) label="run folder" ;; esac
    grep -E '^(stage:|acknowledged:|wallet exit|.*[Ff]unding submitted|.*[Tt]x ?id)' "$m" 2>/dev/null | head -n 6 | tr -d '\r' | while IFS= read -r l; do echo "recorded ($label): $l"; done
  done
  echo "$RECOVERY"
}
for m in "$MK3" "$MK2" "$MK1"; do
  if mk_exists "$m" && ! mk_regular "$m"; then refuse "REFUSED: the marker path $m exists and is not a regular file; look at it and remove it by hand only when no funding went out"; fi
done
M3_MSG="this contract was already funded by this user through fund.sh (marker $MK3, at $(marker_at "$MK3"))"
M2_MSG="this contract was already funded through fund.sh (marker $MK2, at $(marker_at "$MK2"))"
M1_MSG="fund.sh already ran for this run folder (at $(marker_at "$MK1"))"

if [ "$DRY" = 1 ]; then
  echo "object: $OBJ sha256 $SHA"
  echo "amount: $AMOUNT micro-NOID (swap file and AMOUNT agree)"
  REF=0
  if mk_exists "$MK3"; then echo "dry run: a real run would be REFUSED: $M3_MSG"; REF=1; fi
  if mk_exists "$MK2"; then echo "dry run: a real run would be REFUSED: $M2_MSG"; REF=1; fi
  if mk_exists "$MK1"; then echo "dry run: a real run would be REFUSED: $M1_MSG"; REF=1; fi
  if [ "$REF" -ne 0 ]; then describe_markers; exit 3; fi
  echo "dry run: would fund $NOID NOID once with: $NOID_CLI contract fund $OBJ_CLI $NOID"; exit 0
fi

# 5. exactly once per user, per object file and per run folder: all three markers are created atomically, before the wallet CLI runs
if mk_exists "$MK3"; then echo "REFUSED: $M3_MSG. The contract is funded once; do not fund again."; describe_markers; exit 3; fi
if mk_exists "$MK2"; then echo "REFUSED: $M2_MSG. The contract is funded once; do not fund again."; describe_markers; exit 3; fi
if mk_exists "$MK1"; then echo "REFUSED: $M1_MSG. The contract is funded once; do not fund again."; describe_markers; exit 3; fi
C1=0; C2=0; C3=0
rollback() { if [ "$C3" = 1 ]; then rm -f "$MK3"; fi; if [ "$C2" = 1 ]; then rm -f "$MK2"; fi; if [ "$C1" = 1 ]; then rm -f "$MK1"; fi; }
# new_marker PATH LINE...: created exclusively (noclobber); the first line is the time
new_marker() { local p=$1 l; shift; ( set -o noclobber; { date -u +%Y-%m-%dT%H:%M:%SZ; for l in ${1+"$@"}; do echo "$l"; done; } > "$p" ) 2>/dev/null; }
# why a marker could not be made: it is there (another process was first) or its folder cannot be written
marker_failed() {
  rollback
  if mk_exists "$1"; then echo "REFUSED: another fund.sh was first: the marker $1 exists now (at $(marker_at "$1")). Nothing was sent by this run; do not fund again."; describe_markers
  else echo "REFUSED: could not create the marker $1 (its folder is not writable?); not funding" >&2; fi
  exit 3
}
( umask 077; mkdir -p "$MK3D" ) 2>/dev/null
chmod 700 "$HOME/.noid-swap" "$MK3D" 2>/dev/null
new_marker "$MK3" "run folder $L" "object $OBJ" || marker_failed "$MK3"; C3=1
new_marker "$MK2" "run folder $L" || marker_failed "$MK2"; C2=1
new_marker "$MK1" || marker_failed "$MK1"; C1=1
# the copy is still the one that was checked (nothing was sent yet: undo the markers if not)
NOW=$(sha_of "$COPY") || NOW=''
[ -f "$COPY" ] && [ ! -L "$COPY" ] && [ "$NOW" = "$SHA" ] || { rollback; echo "REFUSED: the private copy $COPY changed after it was checked; not funding (nothing was sent)"; exit 3; }
note_all() { local m; for m in "$MK3" "$MK2" "$MK1"; do echo "$1" >> "$m"; done; }
echo "funding $NOID NOID (once) at $(date -u +%T) UTC"
note_all "stage: calling wallet CLI"
"$NOID_CLI" contract fund "$OBJ_CLI" "$NOID" < /dev/null 2>&1 | tee -a "$MK1"
WEC=${PIPESTATUS[0]}
note_all "wallet exit $WEC"
grep -i 'funding submitted' "$MK1" 2>/dev/null | head -n 3 | tr -d '\r' | while IFS= read -r l; do echo "$l" >> "$MK2"; echo "$l" >> "$MK3"; done
exit "$WEC"
