#!/usr/bin/env bash
# Create $L for a new run: passphrase (fresh, mode 600), bob/ and rec/ folders, the HTLC deployment block for
# --eth-from-block (a recent finalized block read from the node, or DEPLOY_BLOCK), the Windows-side copy folder ($L/pub in native mode). Idempotent: an existing passphrase is kept. Nothing is sent.
set -eu
. "$(dirname "$0")/env.sh"
mkdir -p "$L/bob" "$L/rec"; chmod 700 "$L"
# 48 random bytes: 32 give about 43 base64 characters, which can fall under 40 once "/+=" are removed; 48 give 64
if [ ! -s "$L/passphrase.txt" ]; then (umask 077; head -c 48 /dev/urandom | base64 | tr -d '/+=\n' | head -c 40 > "$L/passphrase.txt"); echo "passphrase: new"; else echo "passphrase: kept"; fi
# The log start (--eth-from-block) for this machine: an existing eth-deploy-block.txt is kept; else DEPLOY_BLOCK (from the environment or env.local.sh)
# if given; else a recent safe block read from the Ethereum node now (default_eth_from_block in env.sh: the finalized block). The swap does not exist
# yet, so its lock is later than any block that is final now. Each machine picks its own at its own setup; both are before the lock. A run folder that
# already holds a swap file keeps the start stored in that file and gets no new guess (the lock may already be on chain). Fails closed.
if [ ! -s "$L/eth-deploy-block.txt" ]; then
  if [ -n "${DEPLOY_BLOCK:-}" ]; then
    case "$DEPLOY_BLOCK" in *[!0-9]*) echo "DEPLOY_BLOCK must be a whole block number, not '$DEPLOY_BLOCK'. Nothing was written; refusing" >&2; exit 2 ;; esac
    echo "$DEPLOY_BLOCK" > "$L/eth-deploy-block.txt"; echo "eth log start: $DEPLOY_BLOCK (DEPLOY_BLOCK, as given)"
  elif [ -e "$ALICE_FILE" ] || [ -e "$BOB_FILE" ]; then
    echo "eth log start: not chosen, a swap file is already in $L and carries its own stored start (a fresh guess could lie AFTER a lock that is already on chain). To set one, give DEPLOY_BLOCK (a block before the lock)"
  else
    EBLK=$(default_eth_from_block) || { echo "setup stopped: no log start (see above). Nothing else was done for the log start" >&2; exit 2; }
    echo "$EBLK" > "$L/eth-deploy-block.txt"; echo "eth log start: $EBLK (chosen now from the node; before any lock of a swap that does not exist yet)"
  fi
fi
mkdir -p "$PUB" 2>/dev/null || true
echo "run $RUN in $L (platform $LIVE_PLATFORM, profile $PROFILE, chain $CHAIN, contract ${CONTRACT:-<unset: put it in env.local.sh>}, eth from block $(cat "$L/eth-deploy-block.txt" 2>/dev/null || echo "-, taken from the swap file"))"
# size, modification time, path (python3 instead of `ls --time-style`, which BSD ls does not have; plain `ls -l` when python3 is missing)
if command -v python3 >/dev/null 2>&1; then
python3 - "$BIN" "$EQ" <<'PY' || echo "(the file listing could not run: python3 failed)"
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
