#!/usr/bin/env bash
# Re-fetch the pinned Parano1d source (commit d29b801, 2026-10-30) into vendor/parano1d.
# The shipped vendor/ omits the upstream research/ directory and .git to stay small; this restores everything.
set -euo pipefail
cd "$(dirname "$0")/.."
rm -rf vendor/parano1d
mkdir -p vendor && cd vendor
git clone --filter=blob:none https://github.com/ignotusnemo/parano1d.git
cd parano1d && git checkout d29b8016c3c120312814f52d7f8a8ffef5523b80
echo "vendor/parano1d at $(git rev-parse --short HEAD)"
