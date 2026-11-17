#!/usr/bin/env bash
# Freeze a copy of these helpers under $L/bin (LF endings, executable) and use THAT copy for the run: editing a script
# in place while watch.sh called it left run 3 with empty ticks for 90 s. usage: bash scripts/live/install.sh [--force] [RUN]
# Refuses (exit 3, nothing copied) when $L already holds a swap file, a tick or loop file, a funding marker or the operator console's lock file: a run
# that is under way must keep the helpers it started with. --force skips that check; use it only for a run folder you know is not in use.
# Native mode (macOS, Linux): the frozen env.sh cannot find the repository from its own place, so the repository folder is
# written to $L/repo-dir.txt (env.sh reads it).
set -eu
FORCE=0
if [ "${1:-}" = "--force" ]; then FORCE=1; shift; fi
RUN=${1:-${RUN:-4}}; export RUN
SRC=$(cd "$(dirname "$0")" && pwd)
. "$SRC/env.sh"
if [ "$FORCE" = 0 ]; then
  BUSY=""
  for f in "$L/alice.swap.json" "$L/bob/bob.swap.json" "$L"/last-tick-*.json "$L"/loop-*.txt "$L/funded.marker" "$L/ui-console.lock"; do
    if [ -e "$f" ]; then BUSY="$BUSY $f"; fi
  done
  if [ -n "$BUSY" ]; then
    echo "REFUSED: $L already holds files of a run:$BUSY" >&2
    echo "Installing now would replace the helpers a loop or the console may be calling. Nothing was copied. If you know this run folder is not in use, run again with --force: bash scripts/live/install.sh --force $RUN" >&2
    exit 3
  fi
fi
mkdir -p "$L/bin"
for f in "$SRC"/*.sh; do tr -d '\r' < "$f" > "$L/bin/$(basename "$f")"; chmod +x "$L/bin/$(basename "$f")"; done
if [ "$LIVE_PLATFORM" = native ] && [ -n "${REPO_DIR:-}" ]; then printf '%s\n' "$REPO_DIR" > "$L/repo-dir.txt"; fi
echo "installed $(ls "$L/bin" | wc -l | tr -d ' ') scripts into $L/bin for run $RUN (platform $LIVE_PLATFORM); next: bash $L/bin/setup.sh"
