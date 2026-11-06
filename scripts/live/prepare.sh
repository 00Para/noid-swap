#!/usr/bin/env bash
# Alice's file, the equivalence proof, Bob's file and the contract definition, for a run where the owner plays both
# roles. The secret never reaches a terminal or argv: it goes from the sealed file into the prover over a pipe.
# Nothing is funded or sent. Refuses to overwrite an existing alice.swap.json.
# Differences from run 3: no --eth-code-hash, no --pinned-image-id (compiled in), new-bob needs the receipt.
set -u
. "$(dirname "$0")/env.sh"
. "$HOME/.cargo/env" 2>/dev/null; export PATH="$HOME/.risc0/bin:$HOME/.cargo/bin:$PATH"
unset RISC0_DEV_MODE RISC0_SKIP_BUILD; export EQUIV_SEGMENT_PO2=${EQUIV_SEGMENT_PO2:-18}
HC_LEAD=${HC_LEAD:-50}      # blocks between now and the planned h_create: the proof takes 20-36 min, about 2 blocks a minute
echo "== start $(date +%T), run $RUN, profile $PROFILE, variant $VARIANT, contract version $CONTRACT_VERSION"
[ -f "$ALICE_FILE" ] && { echo "$ALICE_FILE exists; refusing"; exit 3; }
load_passphrase || exit 2
require_parties || exit 2
rpc() { echo "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"$1\",\"params\":$2}" | $CURL -s -m 10 -X POST "$NOID_RPC" -H 'content-type: application/json' --data-binary @- | python3 -c 'import sys,json;print(json.load(sys.stdin)["result"])'; }
TIP=$(rpc paranoid_blockCount '[]') || { echo "node not answering at $NOID_RPC"; exit 5; }
FEE=$(rpc paranoid_estimateFee '[1,1]'); [ "$FEE" -ge 5800 ] 2>/dev/null || FEE=5800
HC=$((TIP+HC_LEAD))
echo "tip $TIP, fee estimate $FEE, planned h_create $HC"
"$BIN" new-alice --out "$ALICE_FILE" --alice "$ALICE_NOID" --bob "$BOB_NOID" --amount "$AMOUNT" --fee-estimate "$FEE" \
  --h-create "$HC" --eth-contract "$CONTRACT" --eth-chain-id "$CHAIN" --eth-amount-wei "$WEI" \
  --eth-receiver "$ALICE_ETH" --eth-sender "$BOB_ETH" --profile "$PROFILE" --variant "$VARIANT" --contract-version "$CONTRACT_VERSION" \
  > "$L/alice.bundle.json" 2> "$L/new-alice.err"; echo "new-alice exit $?"; head -3 "$L/new-alice.err"
[ -s "$L/alice.bundle.json" ] || { echo "no bundle; stop"; exit 6; }
cp "$L/alice.bundle.json" "$PUB/alice.bundle.json" 2>/dev/null && echo "bundle copied to $PUB (send it to the owner)"
python3 - "$L/alice.bundle.json" <<'PY'
import sys, json; b = json.load(open(sys.argv[1]))
print("hashlock:", b["hashlock"]); print("claim_authority:", b["claim_authority"]); print("contract_root:", b["contract_root"])
p = b["params"]; print("profile:", p.get("profile"), " deadline D:", p["deadline_height"], " max_fee:", p["max_fee_micronoid"], " eth chain:", p["eth"].get("chain_id"))
PY
H=$(python3 -c "import json;print(json.load(open('$L/alice.bundle.json'))['hashlock'][2:])")
A=$(python3 -c "import json;print(json.load(open('$L/alice.bundle.json'))['claim_authority'])")
"$BIN" status "$ALICE_FILE" | grep -E '"(phase|profile|lock_by_height|deadline_height|h_create)"'
echo "== equivalence proof $(date +%T) (no process listing with arguments while it runs)"
SECONDS=0
"$BIN" secret "$ALICE_FILE" | "$EQ" prove "$VARIANT" --secret-stdin "$L/alice.receipt" 2>&1 | grep -vE '^(variant|H |A |secret)' | tail -6
echo "prove exit ${PIPESTATUS[1]}  wall ${SECONDS}s  $(date +%T)"
ls -l "$L/alice.receipt" || { echo "no receipt; stop"; exit 7; }
"$EQ" verify "$VARIANT" "$H" "$A" "$L/alice.receipt" 2>&1 | tee "$L/verify.out" | tail -2; echo "verify exit ${PIPESTATUS[0]}  $(date +%T)"
echo "== new-bob (his own terms; the receipt is verified by his tool; image id and code hash are compiled in)"
"$BIN" new-bob --bundle "$L/alice.bundle.json" --out "$BOB_FILE" --bob "$BOB_NOID" --amount "$AMOUNT" \
  --eth-chain-id "$CHAIN" --eth-contract "$CONTRACT" --eth-amount-wei "$WEI" --eth-sender "$BOB_ETH" \
  --profile "$PROFILE" --contract-version "$CONTRACT_VERSION" --receipt "$L/alice.receipt" --equiv-prove "$EQ" \
  2>&1 | grep -E 'bundle checked|receipt|swap file written|error|refus' | head -6
echo "new-bob exit ${PIPESTATUS[0]}"
"$BIN" status "$BOB_FILE" | grep -E '"(phase|profile|deadline_height|lock_by_height)"'
echo "== definition"
"$BIN" alice-params "$ALICE_FILE" --definition-out "$L/swap.def.json" --params-out "$L/swap.params.json" 2>&1 | grep -E 'written|^Fund|^Before' | head -4
cp "$L/swap.def.json" "$PUB/swap.def.json" 2>/dev/null && echo "def copied to $PUB"
echo "tip now $(rpc paranoid_blockCount '[]') (planned h_create $HC)"
echo "== next (Windows): parano1d-cli contract create swap.def.json --out swap.object.json; then check-object.sh; the funding needs the owner's go-ahead"
echo "== end $(date +%T)"
