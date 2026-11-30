#!/usr/bin/env bash
# usage: join.sh [BUNDLE_FILE [RECEIPT_FILE]]
# Bob's first step on his own machine: Alice's public bundle (and, for LOCK_KIND=sha256, her equivalence receipt) go through `swap-cli new-bob`
# against Bob's OWN terms, and Bob's swap file is written. This is the check he cannot repeat later: nothing is locked until he has run it.
# prepare.sh does the same for a run where one owner plays both roles; this script is for Bob alone, who holds only the files Alice sent.
# Without arguments it takes $L/alice.bundle.json (and $L/alice.receipt when the lock kind needs one). A given file is COPIED to those
# names (never moved; a different file already there is refused); an explicit empty argument is refused. Each source is read ONCE, into a
# temporary file in $L (.join-bundle.XXXXXX, .join-receipt.XXXXXX, removed on every exit), and the checks, the printing and the comparison
# all use that copy, which is then moved into place. Paths may start with `-`.
# Bob's terms are his own: each of BOB_NOID, BOB_ETH, CONTRACT, AMOUNT, WEI, CHAIN, PROFILE, CONTRACT_VERSION, LOCK_KIND and VARIANT must be
# ASSIGNED in $L/env.local.sh (a line `NAME=...`, optionally with `export` in front; a comment does not count): the defaults of env.sh are not
# his agreement. They are printed before new-bob runs, and the script copies no term out of the bundle (new-bob refuses on any difference).
# Needs a usable python3 (run with -I: no module is taken from the current folder), which reads the bundle's fields; none of the text the
# bundle or the tool produces is shown with its control characters.
# It sends nothing to any chain, touches no key file and prints no secret (Bob has none at this point). It never prints the whole bundle.
# Prints: Bob's terms, the tool's `bundle check:` line whole and alone, only when new-bob exited 0 (compare it with the one Alice's side
# printed, over a second channel), then the tool's machine line `bundle digest: <64 hex>` (the whole digest the check line starts with) whole and
# alone under the same rules (a tool without that line prints none), the tool's lines about the receipt, the self-test, warnings, errors and refusals (each after "  | " so no
# line of the tool can pass for the check line), new-bob's exit status, the swap file's status, and what comes next.
# LOCK_KIND=poseidon: no receipt (a receipt argument is refused), new-bob gets --eth-lock-kind poseidon and runs the client R self-test here.
# Variant: new-bob takes --variant, and this script passes Bob's own VARIANT, so it is one of his stated terms (poseidon needs raw).
#
# Exit status (the operator console reads it). What is on disk after each exit:
#   0  new-bob exited 0, printed the expected check line, and Bob's swap file exists. On disk: $L/bob/ with the swap file, the bundle
#      copy, the receipt copy (sha256), $L/join-new-bob.out, and the hashlock entries new-bob made (below).
#   2  usage, a setting or a tool is wrong: an empty argument, LOCK_KIND, a term of Bob's not assigned in $L/env.local.sh or not usable,
#      a receipt argument with poseidon, no passphrase file, swap-cli, python3 or (sha256) the proof tool missing or not executable.
#      Nothing written. (A failed mkdir, move or copy after the checks also exits 2 and can leave the $L/bob folder or one copy.)
#   3  Bob's swap file already exists (the same refusal and status as prepare.sh). Nothing written.
#   4  $L/alice.bundle.json or $L/alice.receipt exists with other content than the file given, or is not a plain file. Nothing written.
#   6  no usable bundle: missing, not a regular file, a symbolic link, empty, above 1 MB, not JSON, or without the fields printed
#      below. Nothing written.
#   7  the receipt is required (LOCK_KIND=sha256) and is missing, empty, above 16 MB, a symbolic link or not a regular file. Nothing written.
#   8  new-bob exited non-zero (it refused or failed). Left on disk: $L/bob/ (empty), the bundle and receipt copies, $L/join-new-bob.out (the
#      tool's whole output, unfiltered) and, if the tool got as far, the hashlock entries it appends BEFORE it saves the swap file: the line
#      for this bundle's hashlock in the per-machine registry (~/.noid-swap/hashlocks.txt, or $NOID_SWAP_HOME) and in $L/hashlocks.txt. A
#      retry with the same bundle can then be refused by the tool ("hashlock already used"); remove those lines by hand or pass its
#      --registry, as its refusal says. No swap file.
#   9  new-bob exited 0 but Bob's swap file is not there, or its output has no `bundle check: <16 hex> ok` line, or it has two different `bundle digest: <64 hex>`
#      lines, or one that does not start with the check line's 16 digits. Left on disk: as for 8.
#  10  a wallet run (USE_SWAP_WALLET=1) only: new-bob wrote the file, but `swap-cli ethkey address` does not show the key bound to BOB_ETH (the address wallet-setup.sh
#      made) and to ETH_PAYOUT. The standalone sealed key file in $L/wallet-setup/ is KEPT. Nothing is sent.
# A wallet run (USE_SWAP_WALLET=1 in $L/env.local.sh): BOB_ETH comes from $L/wallet-addresses.txt (wallet-setup.sh bob), the swap key is sealed into the file by new-bob
# (--eth-key, --eth-payout ETH_PAYOUT) and the standalone key file is deleted once the file shows it. Exit 2 when the addresses file, the key file or ETH_PAYOUT is missing.
# Not run against a real node or a public network.
set -u
. "$(dirname "$0")/env.sh"
BUNDLE_MAX=1048576; RECEIPT_MAX=16777216
TB=""; TR=""
cleanup() { [ -z "$TB" ] || rm -f -- "$TB"; [ -z "$TR" ] || rm -f -- "$TR"; }
trap cleanup EXIT
trap 'exit 130' INT TERM HUP
# san: drops control characters (all but tab and newline) from what the bundle or the tool produced
san() { LC_ALL=C tr -d '\000-\010\013-\037\177'; }
say() { printf '%s\n' "$1" | san; }
echo "== start $(date +%T), run $RUN, profile $PROFILE, contract version $CONTRACT_VERSION, ethereum lock kind $LOCK_KIND"
[ $# -le 2 ] || { echo "usage: join.sh [BUNDLE_FILE [RECEIPT_FILE]]" >&2; exit 2; }
if [ $# -ge 1 ] && [ -z "$1" ]; then echo "the bundle argument is empty: give a file, or no argument for $L/alice.bundle.json" >&2; exit 2; fi
if [ $# -ge 2 ] && [ -z "$2" ]; then echo "the receipt argument is empty: give a file, or only the bundle" >&2; exit 2; fi
case "$LOCK_KIND" in sha256|poseidon) ;; *) say "LOCK_KIND must be sha256 or poseidon, not '$LOCK_KIND'"; exit 2 ;; esac
if [ "$LOCK_KIND" = poseidon ] && [ $# -ge 2 ]; then echo "LOCK_KIND=poseidon takes no receipt: give the bundle only (nothing was written)"; exit 2; fi
if [ -f "$BOB_FILE" ] || [ -L "$BOB_FILE" ]; then echo "$BOB_FILE exists; refusing"; exit 3; fi
load_passphrase || exit 2
# Bob's terms must be his own words in $L/env.local.sh, not env.sh's defaults
MISS=""
for v in BOB_NOID BOB_ETH CONTRACT AMOUNT WEI CHAIN PROFILE CONTRACT_VERSION LOCK_KIND VARIANT; do
  if [ "$USE_SWAP_WALLET" = 1 ] && [ "$v" = BOB_ETH ]; then continue; fi   # a wallet run: Bob's Ethereum address is the swap key's (wallet-setup.sh bob wrote it to the addresses file)
  grep -Eq "^(export[[:space:]]+)?$v=" "$L/env.local.sh" 2>/dev/null || MISS="$MISS $v"
done
if [ -n "$MISS" ]; then
  echo "not assigned in $L/env.local.sh:$MISS. The defaults of env.sh are not your agreement: write each of BOB_NOID, BOB_ETH, CONTRACT, AMOUNT, WEI, CHAIN, PROFILE, CONTRACT_VERSION, LOCK_KIND and VARIANT there, as a line NAME=value, from what you and Alice agreed. Nothing was written" >&2
  exit 2
fi
# A wallet run (USE_SWAP_WALLET=1, wallet-setup.sh bob already ran): Bob's swap key is sealed into his swap file by new-bob (--eth-key) together with the user's own
# payout address (ETH_PAYOUT), and the standalone (sealed) key file is deleted once the file holds it. The NOID Bob buys goes straight to BOB_NOID (his own address, an assigned term).
SD="$L/wallet-setup"
if [ "$USE_SWAP_WALLET" = 1 ]; then
  [ -f "$WALLET_ADDR_FILE" ] || { echo "no $WALLET_ADDR_FILE: run wallet-setup.sh bob first (a wallet run's Ethereum address is made there). Nothing was written" >&2; exit 2; }
  [ -f "$SD/eth-key.json" ] || { echo "the sealed key file $SD/eth-key.json is not there: run wallet-setup.sh bob first. Nothing was written" >&2; exit 2; }
  require_payout_settings eth || exit 2
fi
require_bob_terms || exit 2
case "$VARIANT" in raw|stock) ;; *) say "VARIANT must be raw or stock, not '$VARIANT'" >&2; exit 2 ;; esac
[ -x "$BIN" ] || { say "swap-cli not found or not executable at '$BIN': build it or set BIN in $L/env.local.sh" >&2; exit 2; }
if [ "$LOCK_KIND" = sha256 ] && [ ! -x "$EQ" ]; then say "LOCK_KIND=sha256 needs the proof tool, and '$EQ' is not an executable file: build it or set EQ in $L/env.local.sh" >&2; exit 2; fi
if ! python3 -I -c 'import json, re' >/dev/null 2>&1; then echo "python3 is not usable (python3 -I -c 'import json' fails; on Windows the Store alias of python3 is not a python): it reads the bundle's fields. Install python3 or fix PATH" >&2; exit 2; fi

# stage SRC MAX KIND: copies SRC ONCE into a new temporary file in $L (bundle: TB, receipt: TR; both removed by the exit trap) and checks the
# copy; SRC must be a regular file and not a symbolic link. Sets STAGED to the copy; on a failure sets WHY and returns 1.
STAGED=""; WHY=""
stage() {
  local src=$1 max=$2 kind=$3 n
  STAGED=""; WHY=""
  [ -e "$src" ] || [ -L "$src" ] || { WHY="$src does not exist"; return 1; }
  [ ! -L "$src" ] || { WHY="$src is a symbolic link; give the file itself"; return 1; }
  [ -f "$src" ] || { WHY="$src is not a regular file"; return 1; }
  STAGED=$(mktemp "$L/.join-$kind.XXXXXX") || { STAGED=""; WHY="cannot make a temporary file in $L"; return 1; }
  case "$kind" in bundle) TB=$STAGED ;; *) TR=$STAGED ;; esac
  head -c "$((max + 1))" 2>/dev/null < "$src" > "$STAGED" || { WHY="cannot read $src"; return 1; }
  n=$(wc -c 2>/dev/null < "$STAGED" | tr -d ' ')
  case "$n" in ''|*[!0-9]*) WHY="cannot read the size of $src"; return 1 ;; esac
  [ "$n" -gt 0 ] || { WHY="$src is empty"; return 1; }
  [ "$n" -le "$max" ] || { WHY="$src is above the limit of $max bytes"; return 1; }
}
# dest_ok COPY DEST: DEST is free, or a plain file with the same content as COPY; else says why (status 1)
dest_ok() {
  [ -e "$2" ] || [ -L "$2" ] || return 0
  { [ ! -L "$2" ] && [ -f "$2" ]; } || { echo "$2 exists and is not a plain file; nothing was written"; return 1; }
  cmp -s -- "$1" "$2" || { echo "$2 already exists with other content than the file given: move one of them away; nothing was written"; return 1; }
}

BUNDLE="$L/alice.bundle.json"; RECEIPT="$L/alice.receipt"
BSRC=${1-$BUNDLE}; RSRC=${2-$RECEIPT}
stage "$BSRC" "$BUNDLE_MAX" bundle || { say "no usable bundle: $WHY (nothing was written)"; exit 6; }
# the copy must parse and hold the fields printed here; it is read from standard input and only those fields are shown, cut short
FIELDS=$(python3 -I -c '
import sys, json, re
def clean(v): return re.sub(r"[^\x20-\x7e]", "?", str(v))[:100]
try:
    b = json.loads(sys.stdin.buffer.read(1048577).decode("utf-8"))
except Exception:
    print("it is not JSON"); sys.exit(1)
def whole(v): return isinstance(v, int) and not isinstance(v, bool)
try:
    p = b["params"]; e = p["eth"]
    ok = all(isinstance(b[k], str) for k in ("hashlock", "claim_authority", "contract_root")) and whole(p["deadline_height"]) and whole(p["max_fee_micronoid"]) and isinstance(e, dict) and "chain_id" in e
except Exception:
    ok = False
if not ok:
    print("it lacks one of hashlock, claim_authority, contract_root, params.deadline_height, params.max_fee_micronoid, params.eth.chain_id"); sys.exit(1)
print("hashlock:", clean(b["hashlock"])); print("claim_authority:", clean(b["claim_authority"])); print("contract_root:", clean(b["contract_root"]))
print("profile:", clean(p.get("profile")), " deadline D:", clean(p["deadline_height"]), " max_fee:", clean(p["max_fee_micronoid"]), " eth chain:", clean(e.get("chain_id")), " eth lock kind:", clean(e.get("lock_kind", "sha256")))
' < "$TB") || { say "no usable bundle: $BSRC: $FIELDS (nothing was written)"; exit 6; }
if [ "$LOCK_KIND" = sha256 ]; then
  stage "$RSRC" "$RECEIPT_MAX" receipt || { say "LOCK_KIND=sha256 needs Alice's receipt and there is none: $WHY (nothing was written)"; exit 7; }
fi
WHY=$(dest_ok "$TB" "$BUNDLE") || { say "$WHY"; exit 4; }
if [ "$LOCK_KIND" = sha256 ]; then WHY=$(dest_ok "$TR" "$RECEIPT") || { say "$WHY"; exit 4; }; fi

# nothing above left anything but the temporary files (removed on exit); from here the copies are put in place (a file already at its
# destination with the same content is left alone)
mkdir -p -- "$(dirname "$BOB_FILE")" || { echo "cannot make the folder of $BOB_FILE" >&2; exit 2; }
if [ ! -e "$BUNDLE" ]; then mv -- "$TB" "$BUNDLE" || { echo "cannot move the bundle to $BUNDLE" >&2; exit 2; }; TB=""; fi
if [ "$LOCK_KIND" = sha256 ] && [ ! -e "$RECEIPT" ]; then mv -- "$TR" "$RECEIPT" || { echo "cannot move the receipt to $RECEIPT" >&2; exit 2; }; TR=""; fi
echo "bundle: $BUNDLE ($(wc -c < "$BUNDLE" | tr -d ' ') bytes)"
printf '%s\n' "$FIELDS" | san
{
  echo "Your terms, as this machine will state them (check them against what you agreed):"
  echo "  your Parano1d address:  $BOB_NOID"
  echo "  your Ethereum address:  $BOB_ETH"
  echo "  the contract:           $CONTRACT"
  echo "  the NOID amount:        $AMOUNT micro-NOID"
  echo "  the ETH amount:         $WEI wei"
  echo "  the chain:              $CHAIN"
  echo "  the profile:            $PROFILE"
  echo "  the contract version:   $CONTRACT_VERSION"
  echo "  the lock kind:          $LOCK_KIND"
  echo "  the variant:            $VARIANT"
} | san
if [ "$LOCK_KIND" = poseidon ]; then
  PROOF_ARGS=(--eth-lock-kind poseidon)
  echo "== no receipt for the poseidon lock: both locks carry the same A = Addr(s); new-bob compares the lock word with the claim authority of the opening it rebuilds and runs the client R self-test here"
else
  PROOF_ARGS=(--receipt "$RECEIPT" --equiv-prove "$EQ")
  echo "== new-bob (his own terms; the receipt is verified by his tool; image id and code hash are compiled in)"
fi
WALLET_ARGS=()
if [ "$USE_SWAP_WALLET" = 1 ]; then WALLET_ARGS=(--eth-key "$SD/eth-key.json" --eth-payout "$ETH_PAYOUT"); fi
"$BIN" new-bob --bundle "$BUNDLE" --out "$BOB_FILE" --bob "$BOB_NOID" --amount "$AMOUNT" \
  --eth-chain-id "$CHAIN" --eth-contract "$CONTRACT" --eth-amount-wei "$WEI" --eth-sender "$BOB_ETH" \
  --profile "$PROFILE" --contract-version "$CONTRACT_VERSION" --variant "$VARIANT" ${PROOF_ARGS[@]+"${PROOF_ARGS[@]}"} ${WALLET_ARGS[@]+"${WALLET_ARGS[@]}"} \
  > "$L/join-new-bob.out" 2>&1
NB=$?
# the check line is taken only from a run that exited 0, and only in the tool's own form; the lines shown after it carry a prefix
BCL=""
if [ "$NB" -eq 0 ]; then BCL=$(LC_ALL=C grep -E '^bundle check: [0-9a-fA-F]{16} ok$' "$L/join-new-bob.out" | head -n 1 | san); fi
if [ -n "$BCL" ]; then
  echo "$BCL"
  echo "   ^ compare these digits with the bundle check line Alice's side printed, over a second channel, before anything else"
fi
# The machine line `bundle digest: <64 hex>` (the whole digest the check line starts with), passed on a line of its own under the same rules: only after a clean
# exit, only the tool's own form, control characters stripped. Two different digest lines, or one whose first 16 digits are not the check line's, are refused (below).
BDL=""; BDN=0
if [ "$NB" -eq 0 ] && [ -n "$BCL" ]; then
  BDN=$(LC_ALL=C grep -E '^bundle digest: [0-9a-f]{64}$' "$L/join-new-bob.out" | LC_ALL=C sort -u | wc -l | tr -d ' ')
  BDL=$(LC_ALL=C grep -E '^bundle digest: [0-9a-f]{64}$' "$L/join-new-bob.out" | head -n 1 | san)
  BCS=$(printf '%s' "$BCL" | cut -c15-30 | tr 'A-F' 'a-f')
  if [ "$BDN" = 1 ] && [ -n "$BDL" ] && [ "$(printf '%s' "$BDL" | cut -c16-31)" = "$BCS" ]; then echo "$BDL"; fi
fi
LC_ALL=C grep -v '^bundle check: ' "$L/join-new-bob.out" | LC_ALL=C grep -E 'bundle check|receipt|self-test|swap file written|error|refus|^warning:|^error:' | cut -c1-400 | head -12 | san | sed -e 's/^/  | /'
echo "new-bob exit $NB"
[ "$NB" -eq 0 ] || { echo "new-bob did not succeed: nothing is locked and no step follows; the tool's whole output is in $L/join-new-bob.out"; exit 8; }
[ -f "$BOB_FILE" ] || { echo "new-bob exited 0 but $BOB_FILE is not there; do not go on"; exit 9; }
[ -n "$BCL" ] || { echo "new-bob exited 0 but printed no 'bundle check: <16 hex> ok' line; do not go on (the tool's whole output is in $L/join-new-bob.out)"; exit 9; }
if [ "$BDN" != 0 ]; then
  [ "$BDN" = 1 ] || { echo "new-bob printed more than one different 'bundle digest:' line, so none is passed on; do not go on (the tool's whole output is in $L/join-new-bob.out)"; exit 9; }
  [ "$(printf '%s' "$BDL" | cut -c16-31)" = "$BCS" ] || { echo "new-bob's 'bundle digest:' line does not start with the digits of its check line, so it is not passed on; do not go on (the tool's whole output is in $L/join-new-bob.out)"; exit 9; }
fi
if [ "$USE_SWAP_WALLET" = 1 ]; then
  # The swap file must now hold the key, bound to the address wallet-setup.sh checked and to the payout address; only then is the standalone (sealed) key file deleted.
  # The sealed key is in the swap file: back it up. Nothing here prints a key.
  "$BIN" ethkey address "$BOB_FILE" > "$L/.eth-seal-check.json" 2>/dev/null < /dev/null; EAC=$?
  SE_A=$(wallet_json_value "$L/.eth-seal-check.json" address); SE_P=$(wallet_json_value "$L/.eth-seal-check.json" payout)
  rm -f "$L/.eth-seal-check.json"
  lc() { printf '%s' "$1" | tr 'A-F' 'a-f'; }
  if [ "$EAC" -eq 0 ] && [ "$(lc "$SE_A")" = "$(lc "$BOB_ETH")" ] && [ "$(lc "$SE_P")" = "$(lc "$ETH_PAYOUT")" ]; then
    rm -f "$SD/eth-key.json"; rmdir "$SD" 2>/dev/null
    echo "the swap file holds the Ethereum key ($BOB_ETH), sealed, with the payout address; the standalone key file was deleted. BACK UP $BOB_FILE (the key exists nowhere else)"
  else
    echo "the swap file does NOT show the key and the payout address wallet-setup.sh made; the standalone key file in $SD is KEPT and not used again: stop and look"
    exit 10
  fi
fi
"$BIN" status "$BOB_FILE" | grep -E '"(phase|profile|variant|deadline_height|lock_by_height)"' | san
echo "== next: nothing is locked yet; start the watch loop for bob; the lock is offered by the tool only after Alice's funding is final (watch.sh bob)"
echo "== end $(date +%T)"
exit 0
