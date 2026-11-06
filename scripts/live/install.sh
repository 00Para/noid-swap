#!/usr/bin/env bash
# Freeze a copy of these helpers under $L/bin (LF endings, executable) and use THAT copy for the run: editing a script
# in place while watch.sh calls it left run 3 with empty ticks for 90 s. usage: bash scripts/live/install.sh [RUN]
set -eu
RUN=${1:-${RUN:-4}}; export RUN
SRC=$(cd "$(dirname "$0")" && pwd)
. "$SRC/env.sh"
mkdir -p "$L/bin"
for f in "$SRC"/*.sh; do tr -d '\r' < "$f" > "$L/bin/$(basename "$f")"; chmod +x "$L/bin/$(basename "$f")"; done
echo "installed $(ls "$L/bin" | wc -l) scripts into $L/bin for run $RUN; next: bash $L/bin/setup.sh"
