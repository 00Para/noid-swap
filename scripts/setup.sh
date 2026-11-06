#!/usr/bin/env bash
# noid-swap: install dependencies and run every offline test suite (Linux / WSL2).
# Does not touch any network except npm and crates.io. Does not run the zkVM (see equiv/README.md §5).
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$ROOT/target}"
declare -A RESULT
status() { if [ "$2" -eq 0 ]; then RESULT[$1]="OK"; else RESULT[$1]="FAIL (exit $2)"; fi; }

echo "== noid-swap setup: $ROOT"
command -v node >/dev/null || { echo "node not found: install Node >= 21"; exit 1; }
command -v cargo >/dev/null || echo "cargo not found: Rust parts will be skipped (install rustup; vendor pins 1.96.0)"

echo "== eth: npm install && npx hardhat test"
( cd "$ROOT/eth" && npm install --no-audit --no-fund && npx hardhat test ); status eth $?

echo "== btc: npm install && npm test"
( cd "$ROOT/btc" && npm install --no-audit --no-fund && npm test ); status btc $?

if command -v cargo >/dev/null; then
  echo "== parano1d/harness: cargo test (first build ~2 min)"
  ( cd "$ROOT/parano1d/harness" && cargo test ); status harness $?

  echo "== equiv: cargo test --release"
  ( cd "$ROOT/equiv" && cargo test --release ); status equiv $?

  echo "== equiv/zkvm core: cargo test -p equiv-guest-core"
  ( cd "$ROOT/equiv/zkvm" && RISC0_SKIP_BUILD=1 cargo test -p equiv-guest-core ); status zkvm_core $?

  echo "== pruv check (vendor workspace)"
  ( cd "$ROOT" && cargo run -q -p noid_pruv --manifest-path vendor/parano1d/Cargo.toml -- \
      check parano1d/contracts/htlc.pruv --params parano1d/contracts/htlc.params.example.json ); status pruv_check $?
  if command -v z3 >/dev/null; then
    echo "== pruv verify (z3 found)"
    ( cd "$ROOT" && cargo run -q -p noid_pruv --manifest-path vendor/parano1d/Cargo.toml -- \
        verify parano1d/contracts/htlc.pruv --params parano1d/contracts/htlc.params.example.json --z3 "$(command -v z3)" ); status pruv_verify $?
  else
    RESULT[pruv_verify]="SKIPPED (no z3 on PATH; pip install z3-solver or apt install z3)"
  fi
fi

echo
echo "== Summary (expected: eth 33, btc 32, harness 12, equiv 22, zkvm_core 3 passing)"
for k in eth btc harness equiv zkvm_core pruv_check pruv_verify; do
  [ -n "${RESULT[$k]:-}" ] && printf "  %-12s %s\n" "$k" "${RESULT[$k]}"
done
