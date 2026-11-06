#!/usr/bin/env bash
# Create $L for a new run: passphrase (fresh, mode 600), bob/ and rec/ folders, the HTLC deployment block for
# --eth-from-block, the Windows-side copy folder. Idempotent: an existing passphrase is kept. Nothing is sent.
set -eu
. "$(dirname "$0")/env.sh"
mkdir -p "$L/bob" "$L/rec"; chmod 700 "$L"
if [ ! -s "$L/passphrase.txt" ]; then (umask 077; head -c 32 /dev/urandom | base64 | tr -d '/+=\n' | head -c 40 > "$L/passphrase.txt"); echo "passphrase: new"; else echo "passphrase: kept"; fi
if [ ! -s "$L/eth-deploy-block.txt" ]; then echo "${DEPLOY_BLOCK:-12066295}" > "$L/eth-deploy-block.txt"; fi   # run 3's deployment of $CONTRACT
mkdir -p "$PUB" 2>/dev/null || true
echo "run $RUN in $L (profile $PROFILE, chain $CHAIN, contract ${CONTRACT:-<unset: put it in env.local.sh>}, eth from block $(cat "$L/eth-deploy-block.txt"))"
ls -la --time-style=+%F_%T "$BIN" "$EQ" | awk '{print $5, $6, $7}'
single_node_warning
