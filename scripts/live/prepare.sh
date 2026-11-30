#!/usr/bin/env bash
# Alice's file, the equivalence proof, Bob's file and the contract definition, for a run where the owner plays both
# roles. The secret never reaches a terminal or argv: it goes from the sealed file into the prover over a pipe.
# Nothing is funded or sent. Refuses to overwrite an existing alice.swap.json.
# Differences from run 3: no --eth-code-hash, no --pinned-image-id (compiled in), new-bob needs the receipt.
# LOCK_KIND=poseidon (env.sh / env.local.sh): the Ethereum lock sits on A = Addr(s) itself, so there is NO proof step and NO receipt:
# this script skips both, passes --eth-lock-kind poseidon to new-alice and new-bob, and new-bob runs the client R self-test on this machine.
set -u
. "$(dirname "$0")/env.sh"
. "$HOME/.cargo/env" 2>/dev/null; export PATH="$HOME/.risc0/bin:$HOME/.cargo/bin:$PATH"
unset RISC0_DEV_MODE RISC0_SKIP_BUILD; export EQUIV_SEGMENT_PO2=${EQUIV_SEGMENT_PO2:-18}
HC_LEAD=${HC_LEAD:-50}      # blocks between now and the planned h_create: the proof takes 20-36 min, about 2 blocks a minute
echo "== start $(date +%T), run $RUN, profile $PROFILE, variant $VARIANT, contract version $CONTRACT_VERSION, ethereum lock kind $LOCK_KIND"
case "$LOCK_KIND" in sha256|poseidon) ;; *) echo "LOCK_KIND must be sha256 or poseidon, not '$LOCK_KIND'"; exit 2 ;; esac
[ "$LOCK_KIND" = poseidon ] && [ "$VARIANT" != raw ] && { echo "LOCK_KIND=poseidon needs VARIANT=raw (the stock variant is refused for the poseidon lock)"; exit 2; }
[ -f "$ALICE_FILE" ] && { echo "$ALICE_FILE exists; refusing"; exit 3; }
load_passphrase || exit 2
require_parties || exit 2
# A wallet run (USE_SWAP_WALLET=1, wallet-setup.sh alice already ran): the swap's recovery address IS the NOID swap wallet's, the swap's alice_receiver IS the swap's own Ethereum key,
# both are sealed into the swap file by new-alice (--wallet, --eth-key) together with the user's two payout addresses, and the standalone files are deleted once the file holds them.
# Bob's file is not made here (Bob runs join.sh on his own machine with Alice's bundle), and there is no object file: the wallet opens the contract's funding from the swap file.
SD="$L/wallet-setup"
if [ "$USE_SWAP_WALLET" = 1 ]; then
  [ -f "$WALLET_ADDR_FILE" ] || { echo "no $WALLET_ADDR_FILE: run wallet-setup.sh alice first (a wallet run's addresses are made there). Nothing was written"; exit 2; }
  { [ -f "$SD/noid-wallet.json" ] && [ -f "$SD/eth-key.json" ]; } || { echo "the sealed wallet files are not in $SD: run wallet-setup.sh alice first. Nothing was written"; exit 2; }
  require_payout_settings both || exit 2
  ALICE_ARGS=(--wallet "$SD/noid-wallet.json" --payout "$NOID_PAYOUT" --eth-key "$SD/eth-key.json" --eth-payout "$ETH_PAYOUT")
else
  ALICE_ARGS=(--alice "$ALICE_NOID")
fi
rpc() { echo "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"$1\",\"params\":$2}" | "$CURL" -s -m 10 -X POST "$NOID_RPC" -H 'content-type: application/json' --data-binary @- | python3 -c 'import sys,json;print(json.load(sys.stdin)["result"])'; }
TIP=$(rpc paranoid_blockCount '[]') || { echo "node not answering at $NOID_RPC"; exit 5; }
FEE=$(rpc paranoid_estimateFee '[1,1]'); [ "$FEE" -ge 5800 ] 2>/dev/null || FEE=5800
HC=$((TIP+HC_LEAD))
echo "tip $TIP, fee estimate $FEE, planned h_create $HC"
"$BIN" new-alice --out "$ALICE_FILE" "${ALICE_ARGS[@]}" --bob "$BOB_NOID" --amount "$AMOUNT" --fee-estimate "$FEE" \
  --h-create "$HC" --eth-contract "$CONTRACT" --eth-chain-id "$CHAIN" --eth-amount-wei "$WEI" \
  --eth-receiver "$ALICE_ETH" --eth-sender "$BOB_ETH" --profile "$PROFILE" --variant "$VARIANT" --contract-version "$CONTRACT_VERSION" \
  --eth-lock-kind "$LOCK_KIND" > "$L/alice.bundle.json" 2> "$L/new-alice.err"; NA=$?; echo "new-alice exit $NA"; head -3 "$L/new-alice.err"
[ -s "$L/alice.bundle.json" ] || { echo "no bundle; stop"; exit 6; }
if [ "$USE_SWAP_WALLET" = 1 ]; then
  # The swap file must now hold the wallet and the key, bound to the addresses wallet-setup.sh checked and to the two payout addresses; only then are the standalone
  # (sealed) copies deleted. The sealed secrets are in the swap file: back it up. Nothing here prints a key.
  NOID_RE='^o1[0-9a-z]{20,100}$'; ETH_RE='^0x[0-9a-fA-F]{40}$'
  "$BIN" wallet address "$ALICE_FILE" > "$L/.wallet-seal-check.json" 2>/dev/null < /dev/null; WAC=$?
  "$BIN" ethkey address "$ALICE_FILE" > "$L/.eth-seal-check.json" 2>/dev/null < /dev/null; EAC=$?
  SW_A=$(wallet_json_value "$L/.wallet-seal-check.json" address); SW_P=$(wallet_json_value "$L/.wallet-seal-check.json" payout)
  SE_A=$(wallet_json_value "$L/.eth-seal-check.json" address); SE_P=$(wallet_json_value "$L/.eth-seal-check.json" payout)
  rm -f "$L/.wallet-seal-check.json" "$L/.eth-seal-check.json"
  lc() { printf '%s' "$1" | tr 'A-F' 'a-f'; }
  if [ "$NA" -eq 0 ] && [ "$WAC" -eq 0 ] && [ "$EAC" -eq 0 ] && [ "$SW_A" = "$ALICE_NOID" ] && [ "$SW_P" = "$NOID_PAYOUT" ] && [ "$(lc "$SE_A")" = "$(lc "$ALICE_ETH")" ] && [ "$(lc "$SE_P")" = "$(lc "$ETH_PAYOUT")" ]; then
    rm -f "$SD/noid-wallet.json" "$SD/eth-key.json"; rmdir "$SD" 2>/dev/null
    echo "== the swap file holds the NOID swap wallet ($ALICE_NOID) and the Ethereum key ($ALICE_ETH), sealed, with the payout addresses; the standalone key files were deleted. BACK UP $ALICE_FILE (the keys exist nowhere else)"
  else
    echo "== the swap file does NOT show the wallet, the key and the payout addresses wallet-setup.sh made (new-alice exit $NA); the standalone files in $SD are KEPT and not used again: stop and look"
    exit 6
  fi
fi
BCL=$(grep -m1 "^bundle check:" "$L/new-alice.err")   # the line comes from the tool; the other machine compares it with the one its new-bob prints
ensure_pub; cp "$L/alice.bundle.json" "$PUB/alice.bundle.json" 2>/dev/null && echo "bundle copied to $PUB (send it as a file, not as pasted text) -- ${BCL:-no bundle check line in new-alice.err}"
python3 - "$L/alice.bundle.json" <<'PY'
import sys, json; b = json.load(open(sys.argv[1]))
print("hashlock:", b["hashlock"]); print("claim_authority:", b["claim_authority"]); print("contract_root:", b["contract_root"])
p = b["params"]; print("profile:", p.get("profile"), " deadline D:", p["deadline_height"], " max_fee:", p["max_fee_micronoid"], " eth chain:", p["eth"].get("chain_id"), " eth lock kind:", p["eth"].get("lock_kind", "sha256"))
PY
H=$(python3 -c "import json;print(json.load(open('$L/alice.bundle.json'))['hashlock'][2:])")
A=$(python3 -c "import json;print(json.load(open('$L/alice.bundle.json'))['claim_authority'])")
"$BIN" status "$ALICE_FILE" | grep -E '"(phase|profile|lock_by_height|deadline_height|h_create)"'
if [ "$LOCK_KIND" = poseidon ]; then
  echo "== no equivalence proof for the poseidon lock: both locks carry the same A = Addr(s) ($A); the proof step and the receipt are skipped"
  PROOF_ARGS=(--eth-lock-kind poseidon)
  BOB_NOTE="new-bob (his own terms; the lock word is compared with the claim authority of the opening he rebuilds; the client R self-test runs here)"
else
  echo "== equivalence proof $(date +%T) (no process listing with arguments while it runs)"
  SECONDS=0
  "$BIN" secret "$ALICE_FILE" | "$EQ" prove "$VARIANT" --secret-stdin "$L/alice.receipt" 2>&1 | grep -vE '^(variant|H |A |secret)' | tail -6
  echo "prove exit ${PIPESTATUS[1]}  wall ${SECONDS}s  $(date +%T)"
  ls -l "$L/alice.receipt" || { echo "no receipt; stop"; exit 7; }
  "$EQ" verify "$VARIANT" "$H" "$A" "$L/alice.receipt" 2>&1 | tee "$L/verify.out" | tail -2; echo "verify exit ${PIPESTATUS[0]}  $(date +%T)"
  PROOF_ARGS=(--receipt "$L/alice.receipt" --equiv-prove "$EQ")
  BOB_NOTE="new-bob (his own terms; the receipt is verified by his tool; image id and code hash are compiled in)"
fi
if [ "$USE_SWAP_WALLET" = 1 ]; then
  # a wallet run: Bob makes his own file with join.sh (his own terms, his own machine) from Alice's bundle (and, for the sha256 lock kind, her receipt); there is no object file
  # and no wallet CLI definition: the funding is made by wallet-fund.sh from the swap file. Nothing was sent.
  echo "tip now $(rpc paranoid_blockCount '[]') (planned h_create $HC)"
  if [ "$LOCK_KIND" = sha256 ]; then BOB_FILES="the bundle ($PUB/alice.bundle.json) and the receipt ($L/alice.receipt)"; else BOB_FILES="the bundle ($PUB/alice.bundle.json), no receipt for this lock kind"; fi
  echo "== next: Bob runs join.sh with $BOB_FILES and compares the bundle check line with the one above; then wallet-status.sh alice shows the deposits to make. Nothing was sent"
  echo "== end $(date +%T)"
  exit 0
fi
echo "== $BOB_NOTE"
"$BIN" new-bob --bundle "$L/alice.bundle.json" --out "$BOB_FILE" --bob "$BOB_NOID" --amount "$AMOUNT" \
  --eth-chain-id "$CHAIN" --eth-contract "$CONTRACT" --eth-amount-wei "$WEI" --eth-sender "$BOB_ETH" \
  --profile "$PROFILE" --contract-version "$CONTRACT_VERSION" ${PROOF_ARGS[@]+"${PROOF_ARGS[@]}"} \
  2>&1 | grep -E 'bundle check|receipt|self-test|swap file written|error|refus|^warning:|^error:' | head -8
echo "new-bob exit ${PIPESTATUS[0]}"
"$BIN" status "$BOB_FILE" | grep -E '"(phase|profile|deadline_height|lock_by_height)"'
echo "== definition"
"$BIN" alice-params "$ALICE_FILE" --definition-out "$L/swap.def.json" --params-out "$L/swap.params.json" 2>&1 | grep -E 'written|^Fund|^Before' | head -4
cp "$L/swap.def.json" "$PUB/swap.def.json" 2>/dev/null && echo "def copied to $PUB"
echo "tip now $(rpc paranoid_blockCount '[]') (planned h_create $HC)"
if [ "$LIVE_PLATFORM" = native ]; then
  echo "== next (by hand, on the machine that holds the wallet): with the Parano1d wallet CLI run 'parano1d-cli contract create swap.def.json --out swap.object.json' on $PUB/swap.def.json, put swap.object.json in $PUB, then check-object.sh; the funding needs the owner's go-ahead"
else
  echo "== next (Windows): parano1d-cli contract create swap.def.json --out swap.object.json; then check-object.sh; the funding needs the owner's go-ahead"
fi
echo "== end $(date +%T)"
