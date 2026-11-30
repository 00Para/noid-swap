#!/usr/bin/env bash
# usage: wallet-status.sh alice|bob      What the party must deposit for this swap, and whether it has been seen. READ-ONLY: nothing is sent, nothing is written but
# $L/wallet-status-ROLE.* (the tools' raw output, overwritten on every run). NOT run against a real node or a public network; selftest.sh covers it against stubs only.
#
# Alice: NOID    swap-cli wallet balance FILE --noid-rpc ...       the plain coins of the swap wallet, the swap's amount, the funding's fee, whether they cover both
#        ETH     swap-cli ethkey emit FILE | live.js reserve --role alice --swap FILE --key-stdin     the fee reserve of the reveal (Alice's swap key IS alice_receiver)
# Bob:   ETH     the same reserve with --role bob: the swap's amount plus the lock's and the refund's fee reserve (Bob's swap key IS bob_sender)
# `reserve` takes the KEY (never a stated address alone): it recomputes the address from the key and refuses, before it prints any amount or address, unless the key
# owns the address the swap file names. So a deposit address is shown only from a result that proved the key owns it (`key_checked=true`).
# The key goes from `swap-cli ethkey emit` into live.js through a pipe: never a key file, never an argument, never a temporary file. The passphrase goes to swap-cli only.
#
# stdout (what the operator console reads; every value is a validated plain token):
#   wallet-status: role alice|bob
#   wallet-status-noid: address=o1... plain_micronoid=N amount_micronoid=N fee_reserve_micronoid=N need_micronoid=N covers=true|false tip=N      (Alice only)
#   wallet-status-eth: address=0x... required_wei=N reserve_wei=N amount_wei=N balance_wei=N shortfall_wei=N covered=true|false key_checked=true
#   wallet-status: done                                                                                  (only when every part above was printed)
# A deposit that an exchange withdrawal has not delivered yet shows as "not seen": the page says it may arrive later than the swap's window.
#
# Exit status (read-only: nothing is sent in any case):
#   0  every part ran and its output is exactly what the tool prints (covered or not: the numbers say which)
#   2  usage, a setting or a tool is wrong: not a wallet run, no passphrase file, no swap file, swap-cli / node / python3 / the eth folder missing
#   3  a part was refused or failed (the key does not own the stated address, a node did not answer, an output could not be read): its words are shown, no line `done`
set -u
. "$(dirname "$0")/env.sh"
san() { LC_ALL=C tr -d '\000-\010\013-\037\177'; }
usage() { echo "usage: wallet-status.sh alice|bob" >&2; exit 2; }
[ $# -eq 1 ] || usage
ROLE=$1
case "$ROLE" in alice|bob) ;; *) usage ;; esac
require_wallet_run || exit 2
[ -s "$L/passphrase.txt" ] || { echo "no $L/passphrase.txt (run setup.sh first)" >&2; exit 2; }
[ -x "$BIN" ] || { echo "swap-cli not found or not executable at '$BIN'" >&2; exit 2; }
command -v "$NODE" >/dev/null 2>&1 || [ -x "$NODE" ] || { echo "node not found at '$NODE'" >&2; exit 2; }
[ -d "${ETH_DIR:-}" ] && [ -f "$ETH_DIR/scripts/live.js" ] || { echo "ETH_DIR '${ETH_DIR:-}' has no scripts/live.js" >&2; exit 2; }
command -v python3 >/dev/null 2>&1 || { echo "python3 not found" >&2; exit 2; }
F=$(swap_file "$ROLE") || exit 2
[ -f "$F" ] || { echo "no swap file at $F: run $([ "$ROLE" = alice ] && echo prepare.sh || echo join.sh) first" >&2; exit 2; }
OUTBASE="$L/wallet-status-$ROLE"
echo "wallet-status: role $ROLE"
FAILED=0
if [ "$ROLE" = alice ]; then
  read_lines NF wallet_noid_flags
  ( load_passphrase && "$BIN" wallet balance "$F" ${NF[@]+"${NF[@]}"} ) > "$OUTBASE.noid.json" 2> "$OUTBASE.noid.err" < /dev/null; RC=$?
  unset SWAP_PASSPHRASE
  if [ "$RC" -ne 0 ]; then echo "the NOID balance could not be read (swap-cli wallet balance exit $RC):"; head -c 500 "$OUTBASE.noid.err" | san; echo; FAILED=1
  else
    P=$(wallet_parse noid_balance "$OUTBASE.noid.json") || { echo "the NOID balance: ${P#ERR }"; FAILED=1; P=""; }
    if [ -n "$P" ]; then
      echo "wallet-status-noid: address=$(wallet_kv "$P" address) plain_micronoid=$(wallet_kv "$P" plain_micronoid) amount_micronoid=$(wallet_kv "$P" amount_micronoid) fee_reserve_micronoid=$(wallet_kv "$P" fee_reserve_micronoid) need_micronoid=$(wallet_kv "$P" need_micronoid) covers=$(wallet_kv "$P" covers) tip=$(wallet_kv "$P" tip)"
    fi
  fi
fi
wallet_reserve "$ROLE" "$OUTBASE.eth.json" "$OUTBASE.eth.err"; RC=$?
if [ "$RC" -ne 0 ] && [ "$RC" -ne 3 ]; then
  echo "the Ethereum reserve could not be read (live.js reserve / ethkey emit exit $RC); nothing must be deposited to an address this check did not prove the key owns:"; head -c 500 "$OUTBASE.eth.err" | san; echo; FAILED=1
else
  P=$(wallet_parse eth_reserve "$OUTBASE.eth.json") || { echo "the Ethereum reserve: ${P#ERR }"; FAILED=1; P=""; }
  if [ -n "$P" ]; then
    echo "wallet-status-eth: address=$(wallet_kv "$P" address) required_wei=$(wallet_kv "$P" required_wei) reserve_wei=$(wallet_kv "$P" reserve_wei) amount_wei=$(wallet_kv "$P" amount_wei) balance_wei=$(wallet_kv "$P" balance_wei) shortfall_wei=$(wallet_kv "$P" shortfall_wei) covered=$(wallet_kv "$P" covered) key_checked=$(wallet_kv "$P" key_checked)"
  fi
fi
if [ "$FAILED" -ne 0 ]; then echo "wallet-status: NOT complete"; exit 3; fi
echo "wallet-status: done"
exit 0
