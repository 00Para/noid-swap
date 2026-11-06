#!/usr/bin/env bash
# usage: check-object.sh [path/to/swap.object.json]   (default: $PUB/swap.object.json, written by parano1d-cli on Windows)
# "object file OK" means the object's opening is byte-for-byte the swap file's: fund exactly that address, nothing else.
set -u
. "$(dirname "$0")/env.sh"
OBJ=${1:-$PUB/swap.object.json}
[ -s "$OBJ" ] || { echo "no object file at $OBJ"; exit 2; }
load_passphrase || exit 2
"$BIN" alice-params "$ALICE_FILE" --check-object "$OBJ"
