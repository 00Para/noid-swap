#!/usr/bin/env bash
# No-network self-test of the live helpers' shell layer (env.sh): usage `bash scripts/live/selftest.sh`. Run it first on a new machine; on a
# Mac it is the check under the system bash 3.2. It makes a temporary folder as $L with a stub env.local.sh (fake contract and party
# addresses), sources env.sh in clean subshells under `set -u`, prints ok / FAIL per case and exits non-zero when any case failed.
# It starts no node, reads no key, sends nothing, and removes its temporary folder when it ends.
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
TMP=$(mktemp -d 2>/dev/null || mktemp -d -t noidselftest) || { echo "cannot make a temporary folder" >&2; exit 2; }
trap 'rm -rf "$TMP"' EXIT
trap 'exit 130' INT TERM
mkdir -p "$TMP/home"
PASS=0; FAILS=0

ok() { echo "ok   $1"; PASS=$((PASS + 1)); }
bad() { echo "FAIL $1"; if [ $# -gt 1 ]; then echo "       $2"; fi; FAILS=$((FAILS + 1)); }
# check NAME EXPECTED ACTUAL
check() { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1" "expected [$2] got [$3]"; fi; }
# check_has NAME NEEDLE HAYSTACK
check_has() { case "$3" in *"$2"*) ok "$1" ;; *) bad "$1" "[$3] does not contain [$2]" ;; esac; }

# mkl NAME [LINE...]: a new run folder $TMP/NAME with a stub env.local.sh (the fake addresses, then the given lines); prints its path
mkl() {
  local d="$TMP/$1"; shift
  mkdir -p "$d"
  {
    echo 'CONTRACT=0x0000000000000000000000000000000000000001'
    echo 'ALICE_NOID=o1selftestalice; BOB_NOID=o1selftestbob'
    echo 'ALICE_ETH=0x00000000000000000000000000000000000000a1; BOB_ETH=0x00000000000000000000000000000000000000b1'
    local x; for x in "$@"; do printf '%s\n' "$x"; done
  } > "$d/env.local.sh"
  printf '%s\n' "$d"
}
# run_env LDIR 'SNIPPET' [VAR=value ...]: a clean environment (only HOME, PATH, L, HERE and the given variables), env.sh sourced under
# set -u, then the snippet. LIVE_PLATFORM is NOT set unless given. Prints the snippet's stdout (stderr too when ERR=1 is in the caller's scope).
run_env() {
  local d=$1 snip=$2; shift 2
  env -i HOME="$TMP/home" PATH="$PATH" L="$d" HERE="$HERE" ${1+"$@"} "$BASH" -c 'set -u; . "$HERE/env.sh"; '"$snip"
}
run_native() { local d=$1 snip=$2; shift 2; run_env "$d" "$snip" LIVE_PLATFORM=native ${1+"$@"}; }

echo "bash $BASH_VERSION ($BASH)"
echo "uname $(uname -s) $(uname -m); wslpath: $(command -v wslpath >/dev/null 2>&1 && echo yes || echo no)"
echo

# ---- (0) every helper parses under this bash
for f in "$HERE"/*.sh; do
  if "$BASH" -n "$f" 2>/dev/null; then ok "syntax $(basename "$f")"; else bad "syntax $(basename "$f")"; fi
done
for f in lock.sh reveal.sh refund-eth.sh; do
  if grep -q 'check_fee_settings' "$HERE/$f"; then ok "$f calls check_fee_settings"; else bad "$f calls check_fee_settings"; fi
done

# ---- (1) fee_flags and check_fee_settings
D=$(mkl fees)
check "fee_flags: nothing set prints nothing" "" "$(run_native "$D" 'echo $(fee_flags)')"
check "fee_flags: MAX_FEE_GWEI only" "--mainnet --max-fee-gwei 0.2" "$(run_native "$D" 'echo $(fee_flags)' MAX_FEE_GWEI=0.2)"
check "fee_flags: MAX_FEE_GWEI + PRIORITY_FEE_GWEI" "--mainnet --max-fee-gwei 0.2 --priority-fee-gwei 0.01" "$(run_native "$D" 'echo $(fee_flags)' MAX_FEE_GWEI=0.2 PRIORITY_FEE_GWEI=0.01)"
check "fee_flags: GAS_PRICE_GWEI + PRIORITY_FEE_GWEI" "--gas-price-gwei 2 --priority-fee-gwei 0.01" "$(run_native "$D" 'echo $(fee_flags)' GAS_PRICE_GWEI=2 PRIORITY_FEE_GWEI=0.01)"
check "fee_flags: MAX_FEE_GWEI wins over GAS_PRICE_GWEI" "--mainnet --max-fee-gwei 0.2" "$(run_native "$D" 'echo $(fee_flags)' MAX_FEE_GWEI=0.2 GAS_PRICE_GWEI=2)"
OUT=$(run_native "$D" 'fee_flags 2>&1; echo "end"' PRIORITY_FEE_GWEI=0.01)
check "fee_flags: a tip alone prints nothing (stdout and stderr)" "end" "$OUT"
OUT=$(run_native "$D" 'check_fee_settings 2>&1; echo "rc=$?"' PRIORITY_FEE_GWEI=0.01)
check_has "check_fee_settings: a tip alone returns 2" "rc=2" "$OUT"
check_has "check_fee_settings: a tip alone says why" "needs a cap" "$OUT"
for v in "MAX_FEE_GWEI=0.2 PRIORITY_FEE_GWEI=0.01" "GAS_PRICE_GWEI=2 PRIORITY_FEE_GWEI=0.01" "MAX_FEE_GWEI=0.2" "NOTHING=1"; do
  # shellcheck disable=SC2086
  OUT=$(run_native "$D" 'check_fee_settings 2>&1; echo "rc=$?"' $v)
  check "check_fee_settings: ok with [$v]" "rc=0" "$OUT"
done

# ---- (2) node_flags
D=$(mkl nodes)
NF='echo $(node_flags 2>/dev/null)'
BASEF="--transport curl --noid-rpc http://n1 --eth-rpc http://e1 --rpc-timeout 60"
check "node_flags native: one node per chain" "$BASEF --curl-path curl" "$(run_native "$D" "$NF" NOID_RPC=http://n1 ETH_RPC=http://e1)"
check "node_flags native: second nodes added" "$BASEF --noid-rpc http://n2 --eth-rpc http://e2 --curl-path curl" "$(run_native "$D" "$NF" NOID_RPC=http://n1 ETH_RPC=http://e1 NOID_RPC2=http://n2 ETH_RPC2=http://e2)"
check "node_flags native: SINGLE_NODE_OK=1 adds --single-node-ok" "$BASEF --single-node-ok --curl-path curl" "$(run_native "$D" "$NF" NOID_RPC=http://n1 ETH_RPC=http://e1 SINGLE_NODE_OK=1)"
check "node_flags native: SINGLE_NODE_OK=1 with both second nodes does not" "$BASEF --noid-rpc http://n2 --eth-rpc http://e2 --curl-path curl" "$(run_native "$D" "$NF" NOID_RPC=http://n1 ETH_RPC=http://e1 NOID_RPC2=http://n2 ETH_RPC2=http://e2 SINGLE_NODE_OK=1)"
check "node_flags native: only one second node and SINGLE_NODE_OK=1 passes the flag" "$BASEF --noid-rpc http://n2 --single-node-ok --curl-path curl" "$(run_native "$D" "$NF" NOID_RPC=http://n1 ETH_RPC=http://e1 NOID_RPC2=http://n2 SINGLE_NODE_OK=1)"
check "node_flags native: CURL is passed through" "$BASEF --curl-path /opt/curl" "$(run_native "$D" "$NF" NOID_RPC=http://n1 ETH_RPC=http://e1 CURL=/opt/curl)"
if command -v wslpath >/dev/null 2>&1; then
  check "node_flags wsl: no --curl-path" "$BASEF" "$(run_env "$D" "$NF" LIVE_PLATFORM=wsl NOID_RPC=http://n1 ETH_RPC=http://e1)"
else
  echo "skip node_flags wsl (no wslpath on this machine)"
fi

# ---- (3) read_lines and the guarded expansion of an empty array
D=$(mkl lines)
check "read_lines: zero lines gives an empty array" "0" "$(run_native "$D" 'read_lines A true; echo "${#A[@]}"')"
check "read_lines: the guarded expansion of that empty array works under set -u" "[]" "$(run_native "$D" 'read_lines A true; echo "[${A[@]+"${A[@]}"}]"')"
check "read_lines: one line" "1|one" "$(run_native "$D" 'read_lines A printf "%s\n" one; echo "${#A[@]}|${A[0]}"')"
check "read_lines: lines with spaces stay whole" "2|a b|c  d" "$(run_native "$D" 'read_lines A printf "%s\n" "a b" "c  d"; echo "${#A[@]}|${A[0]}|${A[1]}"')"
check "empty array, guarded expansion under set -u" "n=0 []" "$(run_native "$D" 'E=(); echo "n=${#E[@]} [${E[@]+"${E[@]}"}]"')"
check "read_lines of fee_flags: each flag is one array element" "4|--gas-price-gwei|2|0.01" "$(run_native "$D" 'read_lines F fee_flags; echo "${#F[@]}|${F[0]}|${F[1]}|${F[3]}"' GAS_PRICE_GWEI=2 PRIORITY_FEE_GWEI=0.01)"

# ---- (4) reveal_tx_flags
H="0x$(printf 'ab%.0s' $(seq 1 32))"
D=$(mkl rtx1); printf '%s\n' "$H" > "$D/reveal-reverted-tx.txt"
check "reveal_tx_flags: a valid hash file" "--reveal-tx $H" "$(run_native "$D" 'echo $(reveal_tx_flags 2>/dev/null)')"
D=$(mkl rtx2); printf '%s\n' "0x12 not a hash" > "$D/reveal-reverted-tx.txt"
check "reveal_tx_flags: a malformed file passes no flag" "" "$(run_native "$D" 'echo $(reveal_tx_flags 2>/dev/null)')"
check_has "reveal_tx_flags: a malformed file is said on stderr" "IGNORED" "$(run_native "$D" 'reveal_tx_flags 2>&1 >/dev/null')"
D=$(mkl rtx3); printf '%s\n%s\n' "$H" "$H" > "$D/reveal-reverted-tx.txt"
check "reveal_tx_flags: two lines are malformed too" "" "$(run_native "$D" 'echo $(reveal_tx_flags 2>/dev/null)')"
D=$(mkl rtx4)
check "reveal_tx_flags: no file passes no flag" "" "$(run_native "$D" 'echo $(reveal_tx_flags 2>&1)')"

# ---- (5) win_path
D=$(mkl winpath)
check "win_path: identity in native mode" "/some/path with space/x.json" "$(run_native "$D" 'win_path "/some/path with space/x.json"')"

# ---- (6) the platform: read from env.local.sh without running it; a conflict stops
D=$(mkl plat1 'echo x >> "$L/sourced.count"' 'LIVE_PLATFORM=native')
check "platform: read from env.local.sh" "native" "$(run_env "$D" 'echo "$LIVE_PLATFORM"')"
check "platform: env.local.sh is run exactly once" "1" "$(wc -l < "$D/sourced.count" | tr -d ' ')"
D=$(mkl plat2 'LIVE_PLATFORM=wsl' 'export LIVE_PLATFORM="native"   # last line wins, quotes and comment stripped')
check "platform: the last assignment wins (export, quotes, comment)" "native" "$(run_env "$D" 'echo "$LIVE_PLATFORM"')"
# an indented assignment (inside an if) is NOT read early; when it runs and differs from the computed platform, env.sh refuses
D=$(mkl plat2b 'LIVE_PLATFORM=wsl' 'if true; then' '  LIVE_PLATFORM=native' 'fi')
( run_env "$D" 'echo "$LIVE_PLATFORM"' ) >/dev/null 2>&1; check "platform: an indented assignment that changes the platform exits 2" "2" "$?"
D=$(mkl plat3 "LIVE_PLATFORM='wsl'")
check "platform: single quotes stripped (wsl)" "wsl" "$(run_env "$D" 'echo "$LIVE_PLATFORM"')"
D=$(mkl plat4 'LIVE_PLATFORM=wsl')
OUT=$(run_env "$D" 'echo "ran"' LIVE_PLATFORM=native 2>&1); RC=$?
check "platform: environment native vs file wsl exits 2" "2" "$RC"
check_has "platform: the conflict is said on stderr" "LIVE_PLATFORM changed" "$OUT"
case "$OUT" in *ran*) bad "platform: nothing runs after the conflict" ;; *) ok "platform: nothing runs after the conflict" ;; esac
D=$(mkl plat5 'LIVE_PLATFORM=native')
OUT=$(run_env "$D" 'echo "ran $LIVE_PLATFORM"' LIVE_PLATFORM=native 2>&1); RC=$?
check "platform: environment and file agreeing is fine" "0|ran native" "$RC|$OUT"
D=$(mkl plat6 'LIVE_PLATFORM=bogus')
OUT=$(run_env "$D" 'echo "ran"' 2>&1); RC=$?
check "platform: an invalid value exits 2" "2" "$RC"
D=$(mkl plat7 'LIVE_PLATFORM=${SELFTEST_UNSET_PLATFORM:-native}')
OUT=$(run_env "$D" 'echo "ran"' LIVE_PLATFORM=wsl 2>&1); RC=$?
check "platform: a value the early read cannot see still gets caught" "2" "$RC"

# ---- (7) a frozen copy takes the repository from repo-dir.txt and does not probe two folders above
mkdir -p "$TMP/decoy/eth/scripts" "$TMP/realrepo/eth/scripts" "$TMP/decoy/run/bin"
: > "$TMP/decoy/eth/scripts/live.js"; : > "$TMP/realrepo/eth/scripts/live.js"
D="$TMP/decoy/run"
mkl_in() { { echo 'CONTRACT=0x0000000000000000000000000000000000000001'; } > "$1/env.local.sh"; }
mkl_in "$D"
cp "$HERE/env.sh" "$D/bin/env.sh"
printf '%s\n' "$TMP/realrepo" > "$D/repo-dir.txt"
phys() { (cd "$1" 2>/dev/null && pwd -P); }
FROZEN='. "$L/bin/env.sh"; (cd "$ETH_DIR" 2>/dev/null && pwd -P)'
check "frozen copy: ETH_DIR comes from repo-dir.txt, not from two folders above" "$(phys "$TMP/realrepo/eth")" "$(env -i HOME="$TMP/home" PATH="$PATH" L="$D" LIVE_PLATFORM=native "$BASH" -c "set -u; $FROZEN")"
rm -f "$D/repo-dir.txt"
check "frozen copy: without repo-dir.txt ETH_DIR stays empty (no upward probe)" "" "$(env -i HOME="$TMP/home" PATH="$PATH" L="$D" LIVE_PLATFORM=native "$BASH" -c 'set -u; . "$L/bin/env.sh"; echo "$ETH_DIR"')"
check "frozen copy: REPO_DIR in the environment wins" "$(phys "$TMP/realrepo/eth")" "$(env -i HOME="$TMP/home" PATH="$PATH" L="$D" LIVE_PLATFORM=native REPO_DIR="$TMP/realrepo" "$BASH" -c "set -u; $FROZEN")"
# control: the same file in a repository layout (scripts/live/env.sh with eth/scripts/live.js two folders above) finds its repository
mkdir -p "$TMP/fake/scripts/live" "$TMP/fake/eth/scripts"
: > "$TMP/fake/eth/scripts/live.js"; cp "$HERE/env.sh" "$TMP/fake/scripts/live/env.sh"
D2=$(mkl notfrozen)
check "not frozen: the repository is found two folders above scripts/live" "$(phys "$TMP/fake/eth")" "$(env -i HOME="$TMP/home" PATH="$PATH" L="$D2" LIVE_PLATFORM=native "$BASH" -c 'set -u; . "$1/scripts/live/env.sh"; cd "$ETH_DIR" && pwd -P' _ "$TMP/fake")"

echo
echo "$PASS ok, $FAILS failed (bash $BASH_VERSION)"
[ "$FAILS" -eq 0 ]
