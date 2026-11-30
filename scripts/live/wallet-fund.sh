#!/usr/bin/env bash
# usage: wallet-fund.sh [--dry-run]      Alice's funding of the contract from her swap wallet (swap-cli wallet fund). REAL NOID without --dry-run.
# NOT run against a real node or a public network; selftest.sh covers it against stub tools only. This is the wallet run's `fund.sh`: fund.sh refuses in a wallet run.
#
# What it does: (1) the fee reserve of the reveal must be covered: live.js reserve with Alice's swap key (piped from swap-cli ethkey emit) is read-only and
# must exit 0, or the helper refuses before it builds anything (a funding while the reveal cannot be paid would lock the NOID until D for nothing); (2) swap-cli wallet
# fund builds, proves and verifies a plain payment of EXACTLY the swap's amount to the contract's address from the wallet (a dry run prints it and writes nothing; a real run
# writes the transaction's bytes beside the swap file BEFORE it sends, and a second run sends the SAME bytes again, never a second funding: the tool's own rule).
# The funding is not a classic one: no object file, no wallet CLI, no `funded.marker`; the tool refuses a funding that another path submitted.
#
# stdout (the operator console reads it; every value is a validated plain token):
#   wallet-fund: wallet o1...            the swap wallet's address (what the dry run's row compares with the terms' Alice address)
#   wallet-fund: contract_root o1...     the contract's address in the swap file
#   wallet-fund: reserve covered=true required_wei=N balance_wei=N     the reveal's fee reserve (a refusal if not covered)
#   wallet-fund: outcome dry_run|sent|maybe_sent|not_sent|hold|done  then target, amount_micronoid, fee_micronoid, inputs, child_height, txid, summary
#   dry run: would fund N micro-NOID once from the swap wallet to the contract address; nothing was written or sent      (a dry run that built the transaction)
# A real run that sent (or already found its funding landed) writes $L/wallet-funded.marker (the time, then `txid ...`), which the console reads as "funded"; a run that
# MAY have sent writes none, so the next run is not refused by the console and sends the same bytes again.
#
# Exit status (the operator console reads it; the same table is in its README):
#   0  a dry run was built and verified, or the funding was sent (at least one node holds it)
#   2  usage, a setting or a tool is wrong: not a wallet run, no swap file, no passphrase file, swap-cli / node / python3 missing. Nothing was built or sent.
#   3  refused, nothing sent: the reveal's fee reserve is not covered (or could not be read), swap-cli refused (its words are shown), or its submit failed everywhere
#   4  nothing was sent by this run: the tool says to wait (the deposit is too young, the funding window, a state it does not judge) or that the funding is already at the contract
#   6  the funding MAY HAVE BEEN SENT (the tool could not tell): run this again; it sends the same recorded bytes, never a second funding
#   1  anything else (an unknown exit status, an unreadable output after a real submit, a signal): treat it as possibly sent
set -u
. "$(dirname "$0")/env.sh"
san() { LC_ALL=C tr -d '\000-\010\013-\037\177'; }
DRY=0
case "${1:-}" in --dry-run) DRY=1 ;; "") ;; *) echo "usage: wallet-fund.sh [--dry-run]" >&2; exit 2 ;; esac
[ $# -le 1 ] || { echo "usage: wallet-fund.sh [--dry-run]" >&2; exit 2; }
require_wallet_run || exit 2
[ -s "$L/passphrase.txt" ] || { echo "no $L/passphrase.txt (run setup.sh first)" >&2; exit 2; }
[ -x "$BIN" ] || { echo "swap-cli not found or not executable at '$BIN'" >&2; exit 2; }
command -v "$NODE" >/dev/null 2>&1 || [ -x "$NODE" ] || { echo "node not found at '$NODE'" >&2; exit 2; }
[ -d "${ETH_DIR:-}" ] && [ -f "$ETH_DIR/scripts/live.js" ] || { echo "ETH_DIR '${ETH_DIR:-}' has no scripts/live.js" >&2; exit 2; }
command -v python3 >/dev/null 2>&1 || { echo "python3 not found" >&2; exit 2; }
[ -f "$ALICE_FILE" ] || { echo "no swap file at $ALICE_FILE (prepare.sh first)" >&2; exit 2; }
echo "== start $(date +%T), run $RUN, wallet funding$([ "$DRY" = 1 ] && echo ' (dry run: nothing is sent)')"
N=$(date +%H%M%S)
BASE="$L/wallet-fund-$([ "$DRY" = 1 ] && echo dry-)$N"
# the swap wallet's address and the contract root, as the swap file states them (swap-cli wallet address needs no passphrase)
"$BIN" wallet address "$ALICE_FILE" > "$BASE.addr.json" 2> "$BASE.addr.err" < /dev/null; AEC=$?
WADDR=$(wallet_json_value "$BASE.addr.json" address); WROOT=$(wallet_json_value "$BASE.addr.json" contract_root)
NOID_RE='^o1[0-9a-z]{20,100}$'
if [ "$AEC" -ne 0 ] || ! [[ "$WADDR" =~ $NOID_RE ]] || ! [[ "$WROOT" =~ $NOID_RE ]]; then
  echo "REFUSED: swap-cli wallet address did not name the wallet and the contract (exit $AEC); nothing was built or sent:"; head -c 400 "$BASE.addr.err" | san; echo; exit 3
fi
echo "wallet-fund: wallet $WADDR"
echo "wallet-fund: contract_root $WROOT"
# 1. the reveal's fee reserve (live.js reserve with the swap key, read-only): exit 0 covered, 3 not covered, 1 refused or failed
wallet_reserve alice "$BASE.reserve.json" "$BASE.reserve.err"; REC=$?
if [ "$REC" -eq 0 ] || [ "$REC" -eq 3 ]; then
  RP=$(wallet_parse eth_reserve "$BASE.reserve.json") || { echo "REFUSED: the reserve check's output could not be read (${RP#ERR }); nothing was built or sent"; exit 3; }
  echo "wallet-fund: reserve covered=$(wallet_kv "$RP" covered) required_wei=$(wallet_kv "$RP" required_wei) balance_wei=$(wallet_kv "$RP" balance_wei) address=$(wallet_kv "$RP" address)"
fi
if [ "$REC" -ne 0 ]; then
  if [ "$REC" -eq 3 ]; then
    echo "REFUSED: Alice's Ethereum key holds less than the reveal's fee reserve; $([ "$DRY" = 1 ] && echo 'a real run would not fund' || echo 'not funding'): without it the NOID would be locked until D for nothing. Nothing was built or sent"
  else
    echo "REFUSED: the reveal's fee reserve could not be checked (live.js reserve / ethkey emit exit $REC); not funding. Nothing was built or sent:"; head -c 400 "$BASE.reserve.err" | san; echo
  fi
  exit 3
fi
# 2. the funding itself
wallet_step fund "$BASE" "$DRY"
wallet_step_report wallet-fund
echo "wallet-fund exit $WSTEP_RC (swap-cli wallet fund, outcome $(wallet_kv "$WSTEP_PARSED" outcome))"
if [ -z "$WSTEP_PARSED" ]; then echo "swap-cli's words:"; head -c 600 "$BASE.err" | san; echo; fi
OUTCOME=$(wallet_kv "$WSTEP_PARSED" outcome)
if [ "$DRY" = 1 ] && [ "$WSTEP_RC" -eq 0 ]; then
  echo "dry run: would fund $(wallet_kv "$WSTEP_PARSED" amount_micronoid) micro-NOID once from the swap wallet to the contract address; nothing was written or sent"
fi
if [ "$DRY" = 0 ] && { { [ "$OUTCOME" = sent ] && [ "$WSTEP_RC" -eq 0 ]; } || { [ "$OUTCOME" = done ] && [ "$WSTEP_RC" -eq 4 ]; }; }; then
  ( set -o noclobber; { date -u +%Y-%m-%dT%H:%M:%SZ; echo "txid $(wallet_kv "$WSTEP_PARSED" txid)"; echo "outcome $OUTCOME"; } > "$L/wallet-funded.marker" ) 2>/dev/null || true
fi
if [ "$WSTEP_RC" -eq 6 ]; then echo "THE FUNDING MAY HAVE BEEN SENT: run this again; it sends the same recorded bytes (never a second funding)"; fi
echo "== end $(date +%T)"
exit "$WSTEP_RC"
