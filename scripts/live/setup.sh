#!/usr/bin/env bash
# Create $L for a new run: passphrase (fresh, mode 600), bob/ and rec/ folders, the HTLC deployment block for
# --eth-from-block, the Windows-side copy folder ($L/pub in native mode). Idempotent: an existing passphrase is kept. Nothing is sent.
set -eu
. "$(dirname "$0")/env.sh"
mkdir -p "$L/bob" "$L/rec"; chmod 700 "$L"
# 48 random bytes: 32 give about 43 base64 characters, which can fall under 40 once "/+=" are removed; 48 give 64
if [ ! -s "$L/passphrase.txt" ]; then (umask 077; head -c 48 /dev/urandom | base64 | tr -d '/+=\n' | head -c 40 > "$L/passphrase.txt"); echo "passphrase: new"; else echo "passphrase: kept"; fi
if [ ! -s "$L/eth-deploy-block.txt" ]; then echo "${DEPLOY_BLOCK:-12066295}" > "$L/eth-deploy-block.txt"; fi   # run 3's deployment of $CONTRACT
mkdir -p "$PUB" 2>/dev/null || true
echo "run $RUN in $L (platform $LIVE_PLATFORM, profile $PROFILE, chain $CHAIN, contract ${CONTRACT:-<unset: put it in env.local.sh>}, eth from block $(cat "$L/eth-deploy-block.txt"))"
# size, modification time, path (python3 instead of `ls --time-style`, which BSD ls does not have; plain `ls -l` when python3 is missing)
if command -v python3 >/dev/null 2>&1; then
python3 - "$BIN" "$EQ" <<'PY'
import os, sys, time
for p in sys.argv[1:]:
    try: st = os.stat(p)
    except OSError: print("missing", p); continue
    print(st.st_size, time.strftime("%Y-%m-%d_%H:%M:%S", time.localtime(st.st_mtime)), p)
PY
else
  # no python3: plain ls -l (size, date, path), same information
  for p in "$BIN" "$EQ"; do if [ -e "$p" ]; then ls -l "$p"; else echo "missing $p"; fi; done
fi
single_node_warning
