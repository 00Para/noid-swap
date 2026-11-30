#!/usr/bin/env bash
# usage: board-verify.sh addresses|checked      READ-ONLY and OFFLINE: checks one personal-message signature of Bob (the offer board's handover, piece 3, amendment D)
# with `live.js verify-message`. Sends nothing, touches no key, needs no swap file. NOT run against a real node or relay; selftest.sh covers it against stub tools only.
#
# Input: the file $L/board/verify.in, written by the console from the message it received. Exactly these lines, in this order, each `name value` and nothing else:
#   addresses  signer 0x<40 hex> / signature 0x<130 hex> / offer <64 hex> / take <64 hex> / bob_noid o1... / bob_sender 0x<40 hex>
#   checked    signer 0x<40 hex> / signature 0x<130 hex> / offer <64 hex> / take <64 hex> / digest <64 hex>
# Every value is checked against its pattern HERE, then the text is built HERE (never taken from the file as text):
#   addresses  no1d-swap-v1 addresses / offer / take / bob_noid / bob_sender          checked   no1d-swap-v1 checked / offer / take / digest
# A value that is not in its shape, a missing or extra line, or a file that is not a plain file is refused (exit 2, nothing checked).
#
# stdout (what the console reads):
#   board-verify: purpose addresses|checked
#   board-verify: text-sha256 <64 hex>      the sha256 of the exact bytes that were checked (the console compares it with the text it expects)
#   board-verify: valid true|false          whether the signature is a canonical signature of that text by `signer`
#   board-verify: done
# Exit status: 0 the check ran (valid or not: the line says which); 2 usage, input or a tool is wrong (nothing checked); 3 the tool failed (nothing reported).
set -u
. "$(dirname "$0")/env.sh"
san() { LC_ALL=C tr -d '\000-\010\013-\037\177'; }
usage() { echo "usage: board-verify.sh addresses|checked" >&2; exit 2; }
[ $# -eq 1 ] || usage
PURPOSE=$1
case "$PURPOSE" in addresses|checked) ;; *) usage ;; esac
command -v "$NODE" >/dev/null 2>&1 || [ -x "$NODE" ] || { echo "node not found at '$NODE'" >&2; exit 2; }
[ -d "${ETH_DIR:-}" ] && [ -f "$ETH_DIR/scripts/live.js" ] || { echo "ETH_DIR '${ETH_DIR:-}' has no scripts/live.js" >&2; exit 2; }
command -v python3 >/dev/null 2>&1 || { echo "python3 not found" >&2; exit 2; }
IN="$L/board/verify.in"
[ -f "$IN" ] && [ ! -L "$IN" ] || { echo "no plain file $IN" >&2; exit 2; }
[ "$(wc -c < "$IN" | tr -d ' ')" -le 2048 ] || { echo "$IN is too large" >&2; exit 2; }
if [ "$PURPOSE" = addresses ]; then NAMES="signer signature offer take bob_noid bob_sender"; else NAMES="signer signature offer take digest"; fi
HEX64='^[0-9a-f]{64}$'; NOID_RE='^o1[0-9a-z]{20,100}$'; ETH_RE='^0x[0-9a-fA-F]{40}$'; SIG_RE='^0x[0-9a-fA-F]{130}$'
n=0; V_signer=""; V_signature=""; V_offer=""; V_take=""; V_bob_noid=""; V_bob_sender=""; V_digest=""
for name in $NAMES; do
  IFS= read -r line || { echo "the input ends before the line '$name'" >&2; exit 2; }
  case "$line" in "$name "*) ;; *) echo "the input does not have the line '$name' where it belongs" >&2; exit 2 ;; esac
  val=${line#"$name "}
  case "$name" in
    signer|bob_sender) [[ "$val" =~ $ETH_RE ]] || { echo "the value of '$name' is not 0x and 40 hex" >&2; exit 2; } ;;
    signature) [[ "$val" =~ $SIG_RE ]] || { echo "the value of 'signature' is not 0x and 130 hex" >&2; exit 2; } ;;
    offer|take|digest) [[ "$val" =~ $HEX64 ]] || { echo "the value of '$name' is not 64 lower-case hex" >&2; exit 2; } ;;
    bob_noid) [[ "$val" =~ $NOID_RE ]] || { echo "the value of 'bob_noid' is not an o1... address" >&2; exit 2; } ;;
  esac
  eval "V_$name=\$val"
  n=$((n + 1))
done < "$IN"
if IFS= read -r extra < <(tail -n +$((n + 1)) "$IN") && [ -n "$extra" ]; then echo "the input has more lines than the purpose uses" >&2; exit 2; fi
if [ "$PURPOSE" = addresses ]; then
  TEXT=$(printf 'no1d-swap-v1 addresses\n%s\n%s\n%s\n%s' "$V_offer" "$V_take" "$V_bob_noid" "$V_bob_sender")
else
  TEXT=$(printf 'no1d-swap-v1 checked\n%s\n%s\n%s' "$V_offer" "$V_take" "$V_digest")
fi
HEX="0x$(printf '%s' "$TEXT" | od -An -tx1 | tr -d ' \n')"
if command -v sha256sum >/dev/null 2>&1; then SHA=$(printf '%s' "$TEXT" | sha256sum | cut -d' ' -f1); else SHA=$(printf '%s' "$TEXT" | shasum -a 256 | cut -d' ' -f1); fi
OUT="$L/board/.verify.out"; ERR="$L/board/.verify.err"
trap 'rm -f "$OUT" "$ERR" 2>/dev/null' EXIT
: > "$OUT"; : > "$ERR"
( cd "$ETH_DIR" && "$NODE" scripts/live.js verify-message --address "$V_signer" --message-hex "$HEX" --signature "$V_signature" > "$OUT" 2> "$ERR" < /dev/null )
RC=$?
# live.js exits 0 for a valid signature and 3 for one that is not (with its JSON on stdout); anything else is a failure of the tool
if [ "$RC" -ne 0 ] && [ "$RC" -ne 3 ]; then echo "board-verify: live.js verify-message failed (exit $RC); nothing reported:"; head -c 400 "$ERR" | san; echo; exit 3; fi
VALID=$(python3 -I -c 'import json,sys; v=json.load(open(sys.argv[1])); print("true" if v["valid"] is True else "false" if v["valid"] is False else "x")' "$OUT" 2>/dev/null)
case "$VALID" in true|false) ;; *) echo "board-verify: the tool's answer is not in the shape live.js prints; nothing reported" >&2; exit 3 ;; esac
[ "$RC" -eq 0 ] && [ "$VALID" = false ] && { echo "board-verify: live.js says exit 0 but valid false; nothing reported" >&2; exit 3; }
[ "$RC" -eq 3 ] && [ "$VALID" = true ] && { echo "board-verify: live.js says exit 3 but valid true; nothing reported" >&2; exit 3; }
echo "board-verify: purpose $PURPOSE"
echo "board-verify: text-sha256 $SHA"
echo "board-verify: valid $VALID"
echo "board-verify: done"
exit 0
