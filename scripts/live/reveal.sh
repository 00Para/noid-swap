#!/usr/bin/env bash
# usage: reveal.sh [--dry-run] [--replace [TXHASH]]     Alice's reveal = her claim of the ETH. The secret goes from the sealed file (WSL)
# over a pipe into Windows node (live.js claim --secret-stdin); never argv, never a terminal, never a file.
# live.js claim --swap FILE checks receiver, sender, amount, hashlock, the signing key (alice_receiver) and the cutoff: the earlier of
# (T_reveal - margin) and the cutoff the intent froze, except that once the file shows the secret may already be public (a mined or
# reorged claim) the intent's own cutoff rules (REVIEW-4 R4-3) -- so no margin flag is passed here, ever. It also refuses a fee cap
# below 2 x the latest base fee (R4-1); set MAX_FEE_GWEI (mainnet) or GAS_PRICE_GWEI (test chains) in env.local.sh if you use one.
# --replace re-sends a STUCK claim at the same nonce with a fee raised by >= 12.5 % and >= 2 x the base fee (never a second nonce);
# give the hash live.js printed ("sent: 0x...") as TXHASH, or leave it out and the node's pending block is searched.
# Key file: ALICE_KEY (default keys/alice.key, relative to eth/); for mainnet set ALICE_KEY in env.local.sh to the mainnet key file.
# --dry-run needs no secret and sends nothing. A REAL reveal otherwise: owner's go-ahead first.
# A claim that is MINED AND REVERTED (live.js exits 3 and prints reverted/secretPublic) has paid nobody but published the secret: this script
# saves its hash in $L/reveal-reverted-tx.txt and tick.sh / claim.sh pass it on as `--reveal-tx HASH` from then on (REVIEW-6 R6-3).
set -u
. "$(dirname "$0")/env.sh"
cd "$ETH_DIR" || exit 2
N=$(date +%H%M%S)
DRY=0; REPLACE=0; TXHASH=""
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY=1 ;;
    --replace) REPLACE=1
      if [ $# -gt 1 ] && [ "${2#--}" = "$2" ]; then TXHASH="$2"; shift; fi ;;
    *) echo "usage: reveal.sh [--dry-run] [--replace [TXHASH]]" >&2; exit 2 ;;
  esac
  shift
done
ARGS=(scripts/live.js claim --swap "$(win_path "$ALICE_FILE")" --key-file "$ALICE_KEY" --chain-id "$CHAIN")
if [ -n "${MAX_FEE_GWEI:-}" ]; then ARGS+=(--mainnet --max-fee-gwei "$MAX_FEE_GWEI"); fi
if [ -z "${MAX_FEE_GWEI:-}" ] && [ -n "${GAS_PRICE_GWEI:-}" ]; then ARGS+=(--gas-price-gwei "$GAS_PRICE_GWEI"); fi
if [ "$REPLACE" = 1 ]; then
  ARGS+=(--replace)
  if [ -n "$TXHASH" ]; then ARGS+=(--replace-tx "$TXHASH"); fi
fi
if [ "$DRY" = 1 ]; then
  "$NODE" "${ARGS[@]}" --dry-run > "$L/eth-claim-dry-$N.json" 2> "$L/eth-claim-dry-$N.err"; EC=$?
  echo "claim dry-run exit $EC"; head -c 600 "$L/eth-claim-dry-$N.err"; echo; head -c 1400 "$L/eth-claim-dry-$N.json"; echo
  exit $EC
fi
load_passphrase || exit 2
"$BIN" secret "$ALICE_FILE" 2>/dev/null | "$NODE" "${ARGS[@]}" --secret-stdin > "$L/eth-claim.json" 2> "$L/eth-claim.err"
EC=${PIPESTATUS[1]}
echo "claim exit $EC at $(date +%T)"; head -c 600 "$L/eth-claim.err"; echo
python3 - "$L/eth-claim.json" "$L/reveal-reverted-tx.txt" <<'PY'
import sys, json
try: d = json.load(open(sys.argv[1]))
except Exception as e: print("no json:", e); sys.exit(0)
print(json.dumps({k: d.get(k) for k in ("sent", "txHash", "blockNumber", "blockTimestamp", "lockId", "receiver", "amountWei", "cutoff", "revealCutoff", "revealCutoffRule", "feeCheck", "replace", "lockBlock", "finalizedBlock", "reverted", "secretPublic")}, indent=1))
# REVIEW-6 R6-3: a claim that was mined and REVERTED has published the secret and paid nobody. Keep its hash where tick.sh / claim.sh
# find it (they pass --reveal-tx HASH to swap-cli, which re-checks the transaction against the node before it records anything).
if d.get("reverted") is True and isinstance(d.get("txHash"), str):
    open(sys.argv[2], "w").write(d["txHash"] + "\n")
    print("!!! THE CLAIM", d["txHash"], "WAS MINED AND REVERTED: THE SECRET IS PUBLIC. Saved to", sys.argv[2], "; the next tick.sh / claim.sh pass --reveal-tx for it.")
    print("!!! Run tick.sh alice --apply now (it records that the secret is public, so a re-send is judged by the late cutoff), then decide on a re-send.")
PY
cp "$L/eth-claim.json" "$PUB/eth-claim.json" 2>/dev/null
exit $EC
