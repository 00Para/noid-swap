#!/usr/bin/env bash
# usage: board-sign.sh addresses|checked      Bob's two signed answers of the offer board's handover (piece 3, amendment D). Signs a personal message with the key that
# will lock Bob's ETH; sends nothing to any chain; prints no key. NOT run against a real node or relay; selftest.sh covers it against stub tools only.
#
# The text is built HERE, from files of the run folder, never from an argument (the only argument is one of the two fixed words above):
#   addresses  no1d-swap-v1 addresses / offer note id / take key / BOB_NOID / BOB_ETH      (offer id and take key from $L/handover-bob.json; BOB_NOID from env.local.sh;
#              BOB_ETH from wallet-addresses.txt: the swap key's own address; the key is the sealed standalone file $L/wallet-setup/eth-key.json, made by wallet-setup.sh bob)
#   checked    no1d-swap-v1 checked / offer note id / take key / digest                    (the digest is read from Bob's own swap file by `swap-cli bundle`, so it is the
#              digest of the bundle Bob's tool joined; the key is the swap key sealed in $L/bob/bob.swap.json)
# The key goes from `swap-cli ethkey emit` into `live.js sign-message --key-stdin` through a pipe: never a file, an argument or the output. The passphrase goes to swap-cli only.
# live.js refuses to sign a text that does not start with `no1d-swap-v1 `, and prints the address of the key: it must be BOB_ETH, else nothing is reported.
#
# stdout (what the console reads; every value is a validated plain token):
#   board-sign: purpose addresses|checked
#   board-sign: text-sha256 <64 hex>        the sha256 of the exact bytes that were signed (the console compares it with the text it asked for)
#   board-sign: address 0x...               the key's address (equals BOB_ETH)
#   board-sign: signature 0x<130 hex>
#   board-sign: done
# Exit status: 0 signed; 2 usage, a setting or a tool is wrong (nothing signed); 3 refused or failed (nothing reported).
set -u
. "$(dirname "$0")/env.sh"
san() { LC_ALL=C tr -d '\000-\010\013-\037\177'; }
usage() { echo "usage: board-sign.sh addresses|checked" >&2; exit 2; }
[ $# -eq 1 ] || usage
PURPOSE=$1
case "$PURPOSE" in addresses|checked) ;; *) usage ;; esac
require_wallet_run || exit 2
[ -s "$L/passphrase.txt" ] || { echo "no $L/passphrase.txt (run setup.sh first)" >&2; exit 2; }
[ -x "$BIN" ] || { echo "swap-cli not found or not executable at '$BIN'" >&2; exit 2; }
command -v "$NODE" >/dev/null 2>&1 || [ -x "$NODE" ] || { echo "node not found at '$NODE'" >&2; exit 2; }
[ -d "${ETH_DIR:-}" ] && [ -f "$ETH_DIR/scripts/live.js" ] || { echo "ETH_DIR '${ETH_DIR:-}' has no scripts/live.js" >&2; exit 2; }
command -v python3 >/dev/null 2>&1 || { echo "python3 not found" >&2; exit 2; }
HF="$L/handover-bob.json"
[ -f "$HF" ] && [ ! -L "$HF" ] || { echo "no $HF: this run was not made by the board" >&2; exit 2; }
HEX64='^[0-9a-f]{64}$'; NOID_RE='^o1[0-9a-z]{20,100}$'; ETH_RE='^0x[0-9a-fA-F]{40}$'
OFFER=$(python3 -I -c 'import json,sys; v=json.load(open(sys.argv[1])); print(v["swap_id"])' "$HF" 2>/dev/null)
TAKE=$(python3 -I -c 'import json,sys; v=json.load(open(sys.argv[1])); print(v["take_key"])' "$HF" 2>/dev/null)
[[ "$OFFER" =~ $HEX64 ]] && [[ "$TAKE" =~ $HEX64 ]] || { echo "the handover file does not hold a valid offer id and take key" >&2; exit 2; }
[[ "${BOB_ETH:-}" =~ $ETH_RE ]] || { echo "BOB_ETH is not set (wallet-setup.sh bob writes it to the addresses file)" >&2; exit 2; }
if [ "$PURPOSE" = addresses ]; then
  [[ "${BOB_NOID:-}" =~ $NOID_RE ]] || { echo "BOB_NOID in env.local.sh is not an o1... address" >&2; exit 2; }
  KEYSRC="$L/wallet-setup/eth-key.json"
  [ -f "$KEYSRC" ] && [ ! -L "$KEYSRC" ] || { echo "the sealed key file $KEYSRC is not there (wallet-setup.sh bob makes it; join.sh deletes it): the addresses are signed before the join" >&2; exit 2; }
  TEXT=$(printf 'no1d-swap-v1 addresses\n%s\n%s\n%s\n%s' "$OFFER" "$TAKE" "$BOB_NOID" "$BOB_ETH")
else
  KEYSRC="$BOB_FILE"
  [ -f "$KEYSRC" ] && [ ! -L "$KEYSRC" ] || { echo "no swap file at $KEYSRC: run join.sh first" >&2; exit 2; }
  DL=$( ( load_passphrase && "$BIN" bundle "$KEYSRC" ) 2>&1 >/dev/null < /dev/null | LC_ALL=C grep -E '^bundle digest: [0-9a-f]{64}$' | LC_ALL=C sort -u )
  [ "$(printf '%s\n' "$DL" | grep -c .)" = 1 ] || { echo "swap-cli bundle did not print exactly one 'bundle digest:' line for Bob's swap file; nothing signed" >&2; unset SWAP_PASSPHRASE; exit 3; }
  unset SWAP_PASSPHRASE
  DIGEST=${DL#bundle digest: }
  TEXT=$(printf 'no1d-swap-v1 checked\n%s\n%s\n%s' "$OFFER" "$TAKE" "$DIGEST")
fi
HEX="0x$(printf '%s' "$TEXT" | od -An -tx1 | tr -d ' \n')"
if command -v sha256sum >/dev/null 2>&1; then SHA=$(printf '%s' "$TEXT" | sha256sum | cut -d' ' -f1); else SHA=$(printf '%s' "$TEXT" | shasum -a 256 | cut -d' ' -f1); fi
OUT="$L/board/.sign.out"; ERR="$L/board/.sign.err"; EERR="$L/board/.sign.emit.err"
( umask 077; mkdir -p "$L/board" ) 2>/dev/null; chmod 700 "$L/board" 2>/dev/null
[ -d "$L/board" ] && [ ! -L "$L/board" ] || { echo "cannot make the folder $L/board" >&2; exit 2; }
cleanup() { rm -f "$OUT" "$ERR" "$EERR" 2>/dev/null; }
trap cleanup EXIT
: > "$OUT"; : > "$ERR"; : > "$EERR"
( cd "$ETH_DIR" || exit 1
  ( load_passphrase && "$BIN" ethkey emit "$KEYSRC" ) 2> "$EERR" | ( unset SWAP_PASSPHRASE; "$NODE" scripts/live.js sign-message --key-stdin --message-hex "$HEX" > "$OUT" 2> "$ERR" )
  rcs=("${PIPESTATUS[@]}")
  [ "${rcs[0]}" -eq 0 ] || exit 11
  exit "${rcs[1]}" )
RC=$?
unset SWAP_PASSPHRASE
if [ "$RC" -ne 0 ]; then
  echo "board-sign: nothing signed ($([ "$RC" -eq 11 ] && echo "the swap key could not be emitted" || echo "live.js sign-message exit $RC")):"
  head -c 400 "$EERR" | san; head -c 400 "$ERR" | san; echo
  exit 3
fi
ADDR=$(python3 -I -c 'import json,sys; v=json.load(open(sys.argv[1])); print(v["address"])' "$OUT" 2>/dev/null)
SIG=$(python3 -I -c 'import json,sys; v=json.load(open(sys.argv[1])); print(v["signature"])' "$OUT" 2>/dev/null)
SIG_RE='^0x[0-9a-fA-F]{130}$'
[[ "$ADDR" =~ $ETH_RE ]] && [[ "$SIG" =~ $SIG_RE ]] || { echo "board-sign: the signer's answer is not in the shape live.js prints; nothing reported" >&2; exit 3; }
lc() { printf '%s' "$1" | tr 'A-F' 'a-f'; }
[ "$(lc "$ADDR")" = "$(lc "$BOB_ETH")" ] || { echo "board-sign: the key that signed is not BOB_ETH; nothing reported" >&2; exit 3; }
echo "board-sign: purpose $PURPOSE"
echo "board-sign: text-sha256 $SHA"
echo "board-sign: address $ADDR"
echo "board-sign: signature $SIG"
echo "board-sign: done"
exit 0
