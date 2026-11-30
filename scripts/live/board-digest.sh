#!/usr/bin/env bash
# usage: board-digest.sh alice|bob      READ-ONLY: the digest of the bundle a role's own SWAP FILE holds (`swap-cli bundle FILE`), the whole 64-digit sha256 the `bundle check:` line
# starts with; for Alice also whether the bundle FILES the console reads as terms are byte for byte what the swap file produces (piece 3, amendment H). Sends nothing, prints no secret.
# NOT run against a real node; selftest.sh covers it against stub tools only. The console never re-implements the canonical JSON: it reads this digest, and the file comparison is `cmp`.
# `swap-cli bundle` prints the same bytes `new-alice` printed on stdout (both use the tool's one pretty-printer), which prepare.sh saved as $L/alice.bundle.json and copied to the public folder.
#
# stdout (every value a validated plain token):
#   board-digest: role alice|bob
#   board-digest: digest <64 hex>
#   board-digest: run-file same|differs|missing      (alice) $L/alice.bundle.json against the tool's output
#   board-digest: public-file same|differs|missing   (alice) $PUB/alice.bundle.json against the tool's output
#   board-digest: done
# Exit status: 0 read; 2 usage, a setting or a tool is wrong (no swap file, no passphrase, no swap-cli); 3 the tool refused or its output is not what it prints (no or two different digest lines).
set -u
. "$(dirname "$0")/env.sh"
san() { LC_ALL=C tr -d '\000-\010\013-\037\177'; }
usage() { echo "usage: board-digest.sh alice|bob" >&2; exit 2; }
[ $# -eq 1 ] || usage
ROLE=$1
case "$ROLE" in alice|bob) ;; *) usage ;; esac
[ -s "$L/passphrase.txt" ] || { echo "no $L/passphrase.txt (run setup.sh first)" >&2; exit 2; }
[ -x "$BIN" ] || { echo "swap-cli not found or not executable at '$BIN'" >&2; exit 2; }
F=$(swap_file "$ROLE") || exit 2
[ -f "$F" ] && [ ! -L "$F" ] || { echo "no swap file at $F" >&2; exit 2; }
( umask 077; mkdir -p "$L/board" ) 2>/dev/null; chmod 700 "$L/board" 2>/dev/null
[ -d "$L/board" ] && [ ! -L "$L/board" ] || { echo "cannot make the folder $L/board" >&2; exit 2; }
OUT="$L/board/.digest-$ROLE.out"; ERR="$L/board/.digest-$ROLE.err"
trap 'rm -f "$OUT" "$ERR" 2>/dev/null' EXIT
( load_passphrase && "$BIN" bundle "$F" ) > "$OUT" 2> "$ERR" < /dev/null; RC=$?
unset SWAP_PASSPHRASE
if [ "$RC" -ne 0 ]; then echo "board-digest: swap-cli bundle failed (exit $RC):"; head -c 400 "$ERR" | san; echo; exit 3; fi
N=$(LC_ALL=C grep -E '^bundle digest: [0-9a-f]{64}$' "$ERR" | LC_ALL=C sort -u | grep -c .)
[ "$N" = 1 ] || { echo "board-digest: swap-cli bundle printed $N different 'bundle digest:' lines (one is expected); nothing reported" >&2; exit 3; }
DG=$(LC_ALL=C grep -E '^bundle digest: [0-9a-f]{64}$' "$ERR" | head -n 1)
DG=${DG#bundle digest: }
CK=$(LC_ALL=C grep -E '^bundle check: [0-9a-f]{16} ' "$ERR" | head -n 1 | cut -c15-30)
[ -n "$CK" ] && [ "$CK" = "$(printf '%s' "$DG" | cut -c1-16)" ] || { echo "board-digest: the digest does not start with the digits of the check line; nothing reported" >&2; exit 3; }
echo "board-digest: role $ROLE"
echo "board-digest: digest $DG"
if [ "$ROLE" = alice ]; then
  cmp_file() { if [ -L "$1" ]; then echo differs; elif [ ! -f "$1" ]; then echo missing; elif cmp -s -- "$1" "$OUT"; then echo same; else echo differs; fi; }
  echo "board-digest: run-file $(cmp_file "$L/alice.bundle.json")"
  echo "board-digest: public-file $(cmp_file "$PUB/alice.bundle.json")"
fi
echo "board-digest: done"
exit 0
