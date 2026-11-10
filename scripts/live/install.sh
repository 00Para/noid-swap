#!/usr/bin/env bash
# Freeze a copy of these helpers under $L/bin (LF endings, executable) and use THAT copy for the run: editing a script
# in place while watch.sh called it left run 3 with empty ticks for 90 s. usage: bash scripts/live/install.sh [RUN]
# Native mode (macOS, Linux): the frozen env.sh cannot find the repository from its own place, so the repository folder is
# written to $L/repo-dir.txt (env.sh reads it).
set -eu
RUN=${1:-${RUN:-4}}; export RUN
SRC=$(cd "$(dirname "$0")" && pwd)
. "$SRC/env.sh"
mkdir -p "$L/bin"
for f in "$SRC"/*.sh; do tr -d '\r' < "$f" > "$L/bin/$(basename "$f")"; chmod +x "$L/bin/$(basename "$f")"; done
if [ "$LIVE_PLATFORM" = native ] && [ -n "${REPO_DIR:-}" ]; then printf '%s\n' "$REPO_DIR" > "$L/repo-dir.txt"; fi
echo "installed $(ls "$L/bin" | wc -l | tr -d ' ') scripts into $L/bin for run $RUN (platform $LIVE_PLATFORM); next: bash $L/bin/setup.sh"
