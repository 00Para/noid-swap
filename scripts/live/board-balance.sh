#!/usr/bin/env bash
# usage: board-balance.sh      READ-ONLY: the Ethereum balance of BOB_ETH, the address Alice's swap file names as Bob's sender, read from the node (`live.js balance --address`).
# It is the counterparty screen of the offer board (piece 3, amendment D): a screen, not a guarantee (the balance can be moved away afterwards, and one balance can back
# takes of many makers). Sends nothing, needs no key. NOT run against a real node; selftest.sh covers it against stub tools only.
# BOB_ETH comes from $L/env.local.sh (the board wrote it from Bob's signed message 4, checked with the terms form's own patterns); the console compares the address in the output
# with the swap's terms again.
#
# stdout (every value a validated plain token):
#   board-balance: address=0x... balance_wei=N chain_id=N block=N
#   board-balance: done
# Exit status: 0 read; 2 usage, a setting or a tool is wrong (BOB_ETH not an address, no node tool); 3 the node did not answer or its answer is not in the shape live.js prints.
set -u
. "$(dirname "$0")/env.sh"
san() { LC_ALL=C tr -d '\000-\010\013-\037\177'; }
[ $# -eq 0 ] || { echo "usage: board-balance.sh" >&2; exit 2; }
require_wallet_run || exit 2
ETH_RE='^0x[0-9a-fA-F]{40}$'
[[ "${BOB_ETH:-}" =~ $ETH_RE ]] || { echo "BOB_ETH is not an Ethereum address in $L/env.local.sh" >&2; exit 2; }
command -v "$NODE" >/dev/null 2>&1 || [ -x "$NODE" ] || { echo "node not found at '$NODE'" >&2; exit 2; }
[ -d "${ETH_DIR:-}" ] && [ -f "$ETH_DIR/scripts/live.js" ] || { echo "ETH_DIR '${ETH_DIR:-}' has no scripts/live.js" >&2; exit 2; }
command -v python3 >/dev/null 2>&1 || { echo "python3 not found" >&2; exit 2; }
( umask 077; mkdir -p "$L/board" ) 2>/dev/null
OUT="$L/board/.balance.out"; ERR="$L/board/.balance.err"
trap 'rm -f "$OUT" "$ERR" 2>/dev/null' EXIT
: > "$OUT"; : > "$ERR"
( cd "$ETH_DIR" && "$NODE" scripts/live.js balance --address "$BOB_ETH" > "$OUT" 2> "$ERR" < /dev/null )
RC=$?
if [ "$RC" -ne 0 ]; then echo "board-balance: the balance could not be read (live.js balance exit $RC):"; head -c 400 "$ERR" | san; echo; exit 3; fi
LINE=$(python3 -I - "$OUT" <<'PY' 2>/dev/null
import json, re, sys
v = json.load(open(sys.argv[1]))
a = v["address"]; w = v["balanceWei"]; c = v["chainId"]; b = v["blockNumber"]
assert isinstance(a, str) and re.fullmatch(r"0x[0-9a-fA-F]{40}", a)
assert isinstance(w, str) and re.fullmatch(r"[0-9]{1,40}", w)
assert isinstance(c, str) and re.fullmatch(r"[0-9]{1,12}", c)
assert isinstance(b, int) and not isinstance(b, bool) and 0 <= b < 10**15
print("address=%s balance_wei=%s chain_id=%s block=%d" % (a, w, c, b))
PY
)
[ -n "$LINE" ] || { echo "board-balance: the node tool's answer is not in the shape live.js prints; nothing reported" >&2; exit 3; }
echo "board-balance: $LINE"
echo "board-balance: done"
exit 0
