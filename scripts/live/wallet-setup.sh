#!/usr/bin/env bash
# usage: wallet-setup.sh alice|bob [--dry-run]      The swap's own wallets, made BEFORE prepare.sh / join.sh build the swap file. Nothing is sent to any chain.
# NOT run against a real node or a public network; selftest.sh covers it against stub tools only.
#
# Alice: a fresh NOID swap wallet (swap-cli wallet new) and a fresh Ethereum key (live.js keygen --stdout | swap-cli ethkey new). Bob: the Ethereum key only.
# In this order, stopping at the first failure:
#   1. (Alice) swap-cli wallet new --out $L/wallet-setup/noid-wallet.json         the wallet's master secret is sealed with the run's passphrase
#   2. node scripts/live.js keygen --stdout | swap-cli ethkey new --out $L/wallet-setup/eth-key.json     the key goes through a pipe only
#   3. swap-cli ethkey emit $L/wallet-setup/eth-key.json | node scripts/live.js address --key-stdin --expect ADDRESS     the address swap-cli was TOLD is the key's own
# Only when all three held, $L/wallet-addresses.txt is written (ROLE=..., ALICE_NOID / ALICE_ETH, or BOB_ETH): env.sh reads those lines as the swap's own
# addresses, so prepare.sh / join.sh (which seal the two standalone files into the swap file and then delete them) build the file with them. A deposit address
# is shown to a user only from a result that checked the key, so no address is shown before step 3 held.
#
# The sealed standalone files are in $L/wallet-setup/ (mode 700). They are the only copy of the keys until prepare.sh / join.sh have sealed them into the swap file,
# so this helper never removes or replaces them, and it refuses (exit 3) to start again when they, or the addresses file, exist.
# No key and no secret is ever on a command line, in a log or in this script's output. The passphrase is given to swap-cli only (never to node).
#
# Exit status (the operator console reads it; nothing is ever sent in any case):
#   0  every step held, $L/wallet-addresses.txt is written (or, with --dry-run, the checks passed and nothing was made)
#   2  usage, a setting or a tool is wrong: not a wallet run (USE_SWAP_WALLET is not 1), no passphrase file, swap-cli / node / python3 / the eth folder missing. Nothing made.
#   3  refused or failed: the swap file already exists, the run is already set up, a half-made setup is there, or a step failed (its own words are shown). After a failed step
#      the files made so far stay (see above); the addresses file is not written.
# bash 3.2 safe (the macOS /bin/bash): no mapfile, no GNU-only options.
set -u
. "$(dirname "$0")/env.sh"
san() { LC_ALL=C tr -d '\000-\010\013-\037\177'; }
usage() { echo "usage: wallet-setup.sh alice|bob [--dry-run]" >&2; exit 2; }
ROLE=""; DRY=0
while [ $# -gt 0 ]; do
  case "$1" in
    alice|bob) [ -z "$ROLE" ] || usage; ROLE=$1 ;;
    --dry-run) DRY=1 ;;
    *) usage ;;
  esac
  shift
done
[ -n "$ROLE" ] || usage
require_wallet_run || exit 2
echo "== start $(date +%T), run $RUN, wallet setup for $ROLE$([ "$DRY" = 1 ] && echo ' (dry run: nothing is made)')"
[ -s "$L/passphrase.txt" ] || { echo "no $L/passphrase.txt (run setup.sh first). Nothing was made" >&2; exit 2; }
[ -x "$BIN" ] || { echo "swap-cli not found or not executable at '$BIN': build it or set BIN in $L/env.local.sh. Nothing was made" >&2; exit 2; }
command -v "$NODE" >/dev/null 2>&1 || [ -x "$NODE" ] || { echo "node not found at '$NODE': set NODE in $L/env.local.sh. Nothing was made" >&2; exit 2; }
[ -d "${ETH_DIR:-}" ] && [ -f "$ETH_DIR/scripts/live.js" ] || { echo "ETH_DIR '${ETH_DIR:-}' has no scripts/live.js: set REPO_DIR or ETH_DIR in $L/env.local.sh. Nothing was made" >&2; exit 2; }
command -v python3 >/dev/null 2>&1 || { echo "python3 not found. Nothing was made" >&2; exit 2; }
F=$(swap_file "$ROLE") || exit 2
SD="$L/wallet-setup"
NW="$SD/noid-wallet.json"; EK="$SD/eth-key.json"
if [ -e "$F" ] || [ -L "$F" ]; then echo "$F exists: the swap file is made, so the wallets are made (or the run was set up another way). Nothing was made"; exit 3; fi
if [ -e "$WALLET_ADDR_FILE" ] || [ -L "$WALLET_ADDR_FILE" ]; then echo "$WALLET_ADDR_FILE exists: this run is already set up. A second wallet would orphan the first one's deposit address. Nothing was made"; exit 3; fi
if [ -e "$EK" ] || [ -L "$EK" ] || [ -e "$NW" ] || [ -L "$NW" ]; then
  echo "an earlier setup stopped half-way: $SD holds $([ -e "$NW" ] && echo "noid-wallet.json ")$([ -e "$EK" ] && echo "eth-key.json"). No address was shown from it (the addresses file is written last), so nothing can have been deposited: remove those file(s) by hand and run this again. Nothing was made now"
  exit 3
fi
if [ "$DRY" = 1 ]; then
  echo "dry run: would make $([ "$ROLE" = alice ] && echo 'a NOID swap wallet, ')an Ethereum key, check the key against its address, and write $WALLET_ADDR_FILE; nothing was made"
  echo "== end $(date +%T)"; exit 0
fi
( umask 077; mkdir -p "$SD" ) 2>/dev/null; chmod 700 "$SD" 2>/dev/null
[ -d "$SD" ] && [ ! -L "$SD" ] || { echo "cannot make the folder $SD" >&2; exit 2; }
O1="$SD/.out1"; E1="$SD/.err1"; O2="$SD/.out2"; E2="$SD/.err2"; E2K="$SD/.err2k"; O3="$SD/.out3"; E3="$SD/.err3"; E3E="$SD/.err3e"
cleanup() { rm -f "$O1" "$E1" "$O2" "$E2" "$E2K" "$O3" "$E3" "$E3E" 2>/dev/null; }
trap cleanup EXIT
trap 'exit 130' INT TERM HUP
show() { LC_ALL=C head -c 600 "$1" 2>/dev/null | san | sed -e 's/^/  | /'; echo; }
NOID_RE='^o1[0-9a-z]{20,100}$'; ETH_RE='^0x[0-9a-fA-F]{40}$'
# json_address FILE: the "address" of the one-object JSON a swap-cli command prints (a plain match; the value is checked against the address pattern by the caller)
json_address() { sed -n 's/^[[:space:]]*"address"[[:space:]]*:[[:space:]]*"\([^"]*\)".*$/\1/p' "$1" | head -n 1; }

NOIDADDR=""
if [ "$ROLE" = alice ]; then
  echo "== 1. the NOID swap wallet (swap-cli wallet new)"
  ( load_passphrase && "$BIN" wallet new --out "$NW" ) > "$O1" 2> "$E1" < /dev/null; RC=$?
  if [ "$RC" -ne 0 ]; then echo "swap-cli wallet new failed (exit $RC); stopped, no later step ran, no address was written:"; show "$E1"; exit 3; fi
  NOIDADDR=$(json_address "$O1")
  [[ "$NOIDADDR" =~ $NOID_RE ]] || { echo "swap-cli wallet new printed no address I can read; stopped (the wallet file $NW is there, sealed; it is not used until the addresses file exists)"; exit 3; }
  echo "NOID swap wallet made (sealed in $NW); address $NOIDADDR"
fi
echo "== 2. the Ethereum key (live.js keygen --stdout | swap-cli ethkey new)"
cd "$ETH_DIR" || exit 2
( unset SWAP_PASSPHRASE; "$NODE" scripts/live.js keygen --stdout 2> "$E2K" ) | ( load_passphrase && "$BIN" ethkey new --out "$EK" > "$O2" 2> "$E2" )
RCS=("${PIPESTATUS[@]}")
if [ "${RCS[0]}" -ne 0 ] || [ "${RCS[1]}" -ne 0 ]; then
  echo "the key could not be made (keygen exit ${RCS[0]}, ethkey new exit ${RCS[1]}); stopped, no address was written:"; show "$E2K"; show "$E2"; exit 3
fi
ETHADDR=$(json_address "$O2")
[[ "$ETHADDR" =~ $ETH_RE ]] || { echo "swap-cli ethkey new printed no address I can read; stopped (the key file $EK is there, sealed; it is not used until the addresses file exists)"; exit 3; }
echo "Ethereum key made (sealed in $EK); address (as swap-cli was told it)  $ETHADDR"
echo "== 3. the address is checked against the key (swap-cli ethkey emit | live.js address --key-stdin --expect)"
( load_passphrase && "$BIN" ethkey emit "$EK" ) 2> "$E3E" | ( unset SWAP_PASSPHRASE; "$NODE" scripts/live.js address --key-stdin --expect "$ETHADDR" > "$O3" 2> "$E3" )
RCS=("${PIPESTATUS[@]}")
if [ "${RCS[0]}" -ne 0 ] || [ "${RCS[1]}" -ne 0 ] || ! grep -Eq '"matchesExpected"[[:space:]]*:[[:space:]]*true' "$O3"; then
  echo "the key does NOT own the address swap-cli was told (emit exit ${RCS[0]}, address exit ${RCS[1]}); NOTHING must be deposited to $ETHADDR; stopped, no address was written:"; show "$E3E"; show "$E3"; exit 3
fi
echo "the key owns $ETHADDR (checked by live.js)"
if ! ( set -o noclobber
       { echo "ROLE=$ROLE"
         [ "$ROLE" = alice ] && { echo "ALICE_NOID=$NOIDADDR"; echo "ALICE_ETH=$ETHADDR"; }
         [ "$ROLE" = bob ] && echo "BOB_ETH=$ETHADDR"
         true; } > "$WALLET_ADDR_FILE" ) 2>/dev/null; then
  echo "cannot write $WALLET_ADDR_FILE (it already exists, or the folder is not writable); stopped. The sealed files in $SD are kept"; exit 3
fi
chmod 600 "$WALLET_ADDR_FILE" 2>/dev/null
echo "wallet addresses written: $WALLET_ADDR_FILE"
if [ "$ROLE" = alice ]; then echo "wallet-setup: noid $NOIDADDR"; echo "wallet-setup: eth $ETHADDR"; else echo "wallet-setup: eth $ETHADDR"; fi
echo "== next: $([ "$ROLE" = alice ] && echo "prepare.sh builds Alice's swap file from them (it seals both into it and deletes the standalone files)" || echo "join.sh builds Bob's swap file from it (it seals the key into it and deletes the standalone file)"); then wallet-status.sh $ROLE shows the deposit to make. Nothing was sent"
echo "== end $(date +%T)"
exit 0
