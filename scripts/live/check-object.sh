#!/usr/bin/env bash
# usage: check-object.sh [path/to/swap.object.json]   (default: $PUB/swap.object.json, written by the Parano1d wallet CLI: on Windows under WSL, on a Mac or Linux a file you copy there)
# "object file OK" means the object's opening is byte-for-byte the swap file's: fund exactly that address, nothing else.
set -u
. "$(dirname "$0")/env.sh"
OBJ=${1:-$PUB/swap.object.json}
[ -s "$OBJ" ] || { echo "no object file at $OBJ$([ "$LIVE_PLATFORM" = native ] && echo " (native mode: copy the wallet CLI's swap.object.json there or give its path)")"; exit 2; }
load_passphrase || exit 2
"$BIN" alice-params "$ALICE_FILE" --check-object "$OBJ"
