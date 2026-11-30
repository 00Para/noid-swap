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
check "node_flags native: NOID_RPC2_REMOTE=1 with a second node adds --noid-rpc2-is-remote" "$BASEF --noid-rpc http://n2 --noid-rpc2-is-remote --curl-path curl" "$(run_native "$D" "$NF" NOID_RPC=http://n1 ETH_RPC=http://e1 NOID_RPC2=http://n2 NOID_RPC2_REMOTE=1)"
check "node_flags native: ETH_RPC2_REMOTE=1 with a second node adds --eth-rpc2-is-remote" "$BASEF --eth-rpc http://e2 --eth-rpc2-is-remote --curl-path curl" "$(run_native "$D" "$NF" NOID_RPC=http://n1 ETH_RPC=http://e1 ETH_RPC2=http://e2 ETH_RPC2_REMOTE=1)"
check "node_flags native: both declared remote" "$BASEF --noid-rpc http://n2 --noid-rpc2-is-remote --eth-rpc http://e2 --eth-rpc2-is-remote --curl-path curl" "$(run_native "$D" "$NF" NOID_RPC=http://n1 ETH_RPC=http://e1 NOID_RPC2=http://n2 ETH_RPC2=http://e2 NOID_RPC2_REMOTE=1 ETH_RPC2_REMOTE=1)"
check "node_flags native: NOID_RPC2_REMOTE=1 and ETH_RPC2_REMOTE=1 without second nodes add nothing" "$BASEF --curl-path curl" "$(run_native "$D" "$NF" NOID_RPC=http://n1 ETH_RPC=http://e1 NOID_RPC2_REMOTE=1 ETH_RPC2_REMOTE=1)"
check "node_flags native: the _REMOTE settings off (0) add nothing" "$BASEF --noid-rpc http://n2 --eth-rpc http://e2 --curl-path curl" "$(run_native "$D" "$NF" NOID_RPC=http://n1 ETH_RPC=http://e1 NOID_RPC2=http://n2 ETH_RPC2=http://e2 NOID_RPC2_REMOTE=0 ETH_RPC2_REMOTE=0)"
check "node_flags native: the declaration neither adds nor removes --single-node-ok" "$BASEF --noid-rpc http://n2 --noid-rpc2-is-remote --single-node-ok --curl-path curl" "$(run_native "$D" "$NF" NOID_RPC=http://n1 ETH_RPC=http://e1 NOID_RPC2=http://n2 NOID_RPC2_REMOTE=1 SINGLE_NODE_OK=1)"
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


# ---- (8) fund.sh against STUBS only: a stub wallet CLI, a stub check-object.sh and a stub swap-cli (no network, no wallet, no node, nothing funded)
FB="$TMP/fundbin"; mkdir -p "$FB"
cp "$HERE/env.sh" "$HERE/fund.sh" "$FB/"
cat > "$FB/check-object.sh" <<'STUB'
#!/bin/sh
# STUB_CO: ok (default) | exit1 (the OK text is there, the exit status is 1) | inline (the OK text inside another line) | trailing | twice | none
#          | cr (a carriage return inside a line) | crlf (carriage returns at the ends of the lines, as a Windows exe prints them)
# STUB_SWAP=PATH: after the check, the file at PATH (the ORIGINAL object file) is replaced
R=o1stubcontractroot0000
OKT="object file OK: its opening is byte-for-byte the swap file's; fund exactly this address: $R"
echo "check $1" >> "$STUB_LOG"
echo "mode $(stat -c %a "$1" 2>/dev/null || stat -f %Lp "$1" 2>/dev/null) dir $(stat -c %a "$(dirname "$1")" 2>/dev/null || stat -f %Lp "$(dirname "$1")" 2>/dev/null)" >> "$STUB_LOG"
CRC=$(printf '\r')
[ "${STUB_CO:-ok}" = crlf ] || echo '{"claim_authority": "o1x"}'
case "${STUB_CO:-ok}" in
  ok) echo "$OKT" >&2 ;;
  exit1) echo "$OKT" >&2; exit 1 ;;
  inline) echo "note: $OKT" >&2 ;;
  trailing) echo "$OKT (and more)" >&2 ;;
  twice) echo "$OKT" >&2; echo "$OKT" >&2 ;;
  none) echo "error: MISMATCH" >&2; exit 1 ;;
  cr) printf 'half a line%swith the rest\n' "$CRC" >&2; echo "$OKT" >&2 ;;
  crlf) printf '{"claim_authority": "o1x"}%s\n' "$CRC"; printf '%s%s\n' "$OKT" "$CRC" >&2 ;;
esac
[ -z "${STUB_SWAP:-}" ] || printf '{"object": "EVIL"}\n' > "$STUB_SWAP"
exit 0
STUB
cat > "$TMP/stubcli" <<'STUB'
#!/bin/sh
# the wallet CLI: `contract instances OBJ` and `contract fund OBJ AMOUNT`; every call is logged with the markers it finds
case "$1 $2" in
  "contract instances") echo "inst $3" >> "$STUB_LOG"; [ -z "${STUB_INST_TOUCH:-}" ] || echo "changed" >> "$3"; [ -n "${STUB_INST_OUT-}" ] && printf '%s\n' "$STUB_INST_OUT"; exit "${STUB_INST_EC:-0}" ;;
  "contract fund")
    m1=n; [ -e "$STUB_L/funded.marker" ] && m1=y
    m2=n; for f in "$STUB_OBJDIR"/funded-*.marker; do [ -e "$f" ] && m2=y; done
    m3=n; for f in "$HOME"/.noid-swap/funded/*; do [ -e "$f" ] && m3=y; done
    st=n; grep -q '^stage: calling wallet CLI' "$STUB_L/funded.marker" 2>/dev/null && st=y
    echo "fund $4 mk1=$m1 mk2=$m2 mk3=$m3 st=$st obj=$3 content=$(tr '\n' ' ' < "$3")" >> "$STUB_LOG"
    [ -z "${STUB_FUND_KILL:-}" ] || kill -9 "$PPID"
    # STUB_FUND_TERM: the funding line is printed, then fund.sh is sent TERM while the wallet call is still running
    if [ -n "${STUB_FUND_TERM:-}" ]; then echo "Funding submitted: stubtxid0001"; kill -TERM "$PPID"; sleep 1; exit 0; fi
    echo "Funding submitted: stubtxid0001"
    exit "${STUB_FUND_EC:-0}" ;;
esac
exit 9
STUB
cat > "$TMP/stubbin" <<'STUB'
#!/bin/sh
# swap-cli status: JSON whose top-level amount_micronoid is the swap's amount (STUB_STATUS_MODE: normal | nested | oneline | twice | nestedonly)
[ "$1" = status ] || exit 9
[ "${STUB_STATUS_EC:-0}" = 0 ] || { echo "error: cannot load" >&2; exit "$STUB_STATUS_EC"; }
A=${STUB_SWAP_AMOUNT:-5000000}
case "${STUB_STATUS_MODE:-normal}" in
  normal) echo "{"; echo "  \"amount_micronoid\": $A,"; echo "  \"history\": []"; echo "}" ;;
  nested) echo "{"; echo "  \"history\": [{"; echo "      \"amount_micronoid\": 999,"; echo "  }],"; echo "  \"amount_micronoid\": $A,"; echo "  \"phase\": \"x\""; echo "}" ;;
  oneline) echo "{\"amount_micronoid\": $A, \"history\": []}" ;;
  twice) echo "{"; echo "  \"amount_micronoid\": $A,"; echo "  \"amount_micronoid\": $A"; echo "}" ;;
  nestedonly) echo "{"; echo "  \"history\": [{"; echo "      \"amount_micronoid\": $A,"; echo "  }]"; echo "}" ;;
esac
STUB
mkdir -p "$TMP/wslstub"
cat > "$TMP/wslstub/wslpath" <<'STUB'
#!/bin/sh
# STUB_WSLPATH: ok (default: prints the path as it is) | fail (exit 1, no output) | empty (exit 0, no output)
case "${STUB_WSLPATH:-ok}" in
  fail) exit 1 ;;
  empty) exit 0 ;;
  *) printf '%s\n' "$2" ;;
esac
STUB
chmod +x "$FB/check-object.sh" "$TMP/stubcli" "$TMP/stubbin" "$TMP/wslstub/wslpath"
FN=0
# fund_run NAME 'MODE' [VAR=value ...]: a fresh run folder, object folder and HOME; sets FD (the run folder), FO (the object folder), FH (HOME),
# FOUT, FRC, FLOG. PRE is evaluated first (with FD, FO, FH set up).
fund_run() {
  FN=$((FN + 1)); local name=$1 mode=$2; shift 2
  FD=$(mkl "fund$FN"); FO="$TMP/fund$FN-obj"; FH="$TMP/fund$FN-home"; FLOG="$TMP/fund$FN.log"; mkdir -p "$FO" "$FH"; : > "$FLOG"
  printf '{"object": "stub"}\n' > "$FO/swap.object.json"
  [ -z "${PRE:-}" ] || eval "$PRE"
  FOUT=$(env -i HOME="$FH" PATH="$PATH" L="$FD" LIVE_PLATFORM=native OBJ="$FO/swap.object.json" BIN="$TMP/stubbin" NOID_CLI="$TMP/stubcli" AMOUNT=5000000 \
    STUB_LOG="$FLOG" STUB_L="$FD" STUB_OBJDIR="$FO" STUB_SWAP_ORIG="$FO/swap.object.json" ${1+"$@"} "$BASH" "$FB/fund.sh" $mode 2>&1 < /dev/null); FRC=$?
}
# fund_again LDIR OBJFILE HOMEDIR [VAR=value ...]: one more real run in another place (same FLOG); sets FOUTX, FRCX
fund_again() {
  local d=$1 o=$2 h=$3; shift 3; mkdir -p "$h"
  [ -f "$d/env.local.sh" ] || { mkdir -p "$d"; cp "$FD/env.local.sh" "$d/"; }
  FOUTX=$(env -i HOME="$h" PATH="$PATH" L="$d" LIVE_PLATFORM=native OBJ="$o" BIN="$TMP/stubbin" NOID_CLI="$TMP/stubcli" AMOUNT=5000000 \
    STUB_LOG="$FLOG" STUB_L="$d" STUB_OBJDIR="$(dirname "$o")" STUB_SWAP_ORIG="$o" ${1+"$@"} "$BASH" "$FB/fund.sh" 2>&1 < /dev/null); FRCX=$?
}
# markers: the run folder's, the object folder's and this user's
nmarkers() { local n=0 f; for f in "$FD/funded.marker" "$FO"/funded-*.marker "$FH"/.noid-swap/funded/*; do [ -e "$f" ] && n=$((n + 1)); done; echo "$n"; }
nfunds() { grep -c '^fund ' "$FLOG" || true; }
# the private copy's folder is named per process (fund-object.XXXXXX): shown as XXXXXX; nleft DIR counts what is left of them in DIR
normcopy() { sed -e 's|fund-object\.[A-Za-z0-9]\{6\}/|fund-object.XXXXXX/|g'; }
nleft() { ls -A "$1" | grep -c '^fund-object' || true; }
# ro_works DIR: makes DIR read-only and says whether that holds (not for root, not on a file system without modes)
ro_works() { chmod 555 "$1"; if ( : > "$1/.probe" ) 2>/dev/null; then rm -f "$1/.probe"; chmod 755 "$1"; return 1; fi; return 0; }
shaf() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1"; elif command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1"; else python3 -c 'import hashlib,sys;print(hashlib.sha256(open(sys.argv[1],"rb").read()).hexdigest())' "$1"; fi | sed -e 's/[[:space:]].*$//'; }
OBJSHA=$(printf '{"object": "stub"}\n' | { if command -v sha256sum >/dev/null 2>&1; then sha256sum; elif command -v shasum >/dev/null 2>&1; then shasum -a 256; else python3 -c 'import hashlib,sys;print(hashlib.sha256(sys.stdin.buffer.read()).hexdigest())'; fi; } | sed -e 's/[[:space:]].*$//')

fund_run happy --dry-run
check "fund.sh dry run: the clean run exits 0" "0" "$FRC"
check_has "fund.sh dry run: says it would fund once, with the private copy (in a folder of its own for this process)" "dry run: would fund 5.000000 NOID once with: $TMP/stubcli contract fund $FD/fund-object.XXXXXX/fund-object.json 5.000000" "$(printf '%s\n' "$FOUT" | normcopy)"
check_has "fund.sh dry run: prints the ORIGINAL object path and the copy's sha256" "object: $FO/swap.object.json sha256 $OBJSHA" "$FOUT"
check_has "fund.sh dry run: prints the amount line" "amount: 5000000 micro-NOID (swap file and AMOUNT agree)" "$FOUT"
check_has "fund.sh dry run: prints the anchored object-OK line" "object file OK: its opening is byte-for-byte the swap file's; fund exactly this address: o1stubcontractroot0000" "$FOUT"
check "fund.sh dry run: creates no marker (not even the per-user folder) and funds nothing" "0|0|no" "$(nmarkers)|$(nfunds)|$([ -e "$FH/.noid-swap" ] && echo yes || echo no)"
check "fund.sh dry run: nothing of the private copy is left in the run folder" "0" "$(nleft "$FD")"
case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*) ok "fund.sh: the private copy's mode (skipped: this file system has no modes)" ;;
  *) check "fund.sh: the private copy has mode 600 and its folder 700 (seen by check-object.sh)" "mode 600 dir 700" "$(grep '^mode ' "$FLOG")" ;;
esac

fund_run co1 '' STUB_CO=exit1
check "fund.sh: check-object exit 1 refuses even though the OK text is in its output" "3" "$FRC"
check_has "fund.sh: ... and says why" "check-object.sh exited 1; not funding" "$FOUT"
check "fund.sh: ... and creates no marker, funds nothing" "0|0" "$(nmarkers)|$(nfunds)"
for m in inline trailing twice none; do
  fund_run "co-$m" '' STUB_CO=$m
  check "fund.sh: check-object output [$m] refuses (the OK line must be anchored, whole and single)" "3|0|0" "$FRC|$(nmarkers)|$(nfunds)"
done
fund_run cr1 '' STUB_CO=cr
check "fund.sh: a carriage return INSIDE a line of check-object's output refuses" "3|0|0" "$FRC|$(nmarkers)|$(nfunds)"
check_has "fund.sh: ... said as such" "carriage return inside a line" "$FOUT"
fund_run cr2 --dry-run STUB_CO=crlf
check "fund.sh: carriage returns at the END of the lines (a Windows exe) are taken off" "0" "$FRC"
fund_run cli1 --dry-run STUB_INST_EC=1 'STUB_INST_OUT=Error: the node is not reachable'
check "fund.sh: a failed instance listing (exit 1) is not 'no instance': refused" "3" "$FRC"
check_has "fund.sh: ... said as such" "could not list the contract's instances" "$FOUT"
fund_run cli2 '' STUB_INST_EC=1 'STUB_INST_OUT=Error: boom'
check "fund.sh: the same in real mode funds nothing and writes no marker" "3|0|0" "$FRC|$(nmarkers)|$(nfunds)"
fund_run cli3 --dry-run 'STUB_INST_OUT=something nobody has seen before'
check "fund.sh: unknown listing output (exit 0) is not 'no instance': refused" "3" "$FRC"
check_has "fund.sh: ... said as such" "not an instance line" "$FOUT"
fund_run cli4 --dry-run 'STUB_INST_OUT=Slot 635439  incarnation 757220  5.000000 NOID
and then a line that is not one'
check "fund.sh: an instance line plus unknown output is refused" "3" "$FRC"
fund_run inst1 '' 'STUB_INST_OUT=Slot 635439  incarnation 757220  5.000000 NOID'
check "fund.sh: an instance present refuses, funds nothing, writes no marker" "3|0|0" "$FRC|$(nmarkers)|$(nfunds)"
check_has "fund.sh: ... naming the instance count" "REFUSED: the contract already has 1 instance(s)" "$FOUT"
fund_run amt1 --dry-run STUB_SWAP_AMOUNT=4000000
check "fund.sh: AMOUNT that is not the swap file's amount refuses" "3" "$FRC"
check_has "fund.sh: ... naming both amounts" "AMOUNT is 5000000 micro-NOID but the swap file's amount is 4000000" "$FOUT"
fund_run amt2 '' STUB_STATUS_EC=2
check "fund.sh: an unreadable swap file status refuses" "3|0|0" "$FRC|$(nmarkers)|$(nfunds)"
fund_run amt3 --dry-run AMOUNT=abc
check "fund.sh: a non-numeric AMOUNT exits 2" "2" "$FRC"
# F1: a leading zero would be read as octal by the arithmetic ($((05000000)) is 1310720): refused before any arithmetic
for a in 05000000 08000000 0 00 5000000x ' 5000000' 1234567890123456789; do
  fund_run "amt-lz" '' "AMOUNT=$a"
  check "fund.sh: AMOUNT [$a] is refused (exit 2) before anything is checked, funded or marked" "2|0|0" "$FRC|$(nmarkers)|$(nfunds)"
done
check_has "fund.sh: ... said as such" "not a plain whole number of micro-NOID" "$FOUT"
fund_run amt4 --dry-run STUB_SWAP_AMOUNT=05000000
check "fund.sh: a swap file amount with a leading zero refuses" "3" "$FRC"
check_has "fund.sh: ... said as such" "is not a plain decimal number" "$FOUT"
# F2: the amount is the top-level line, exactly once
fund_run amt5 --dry-run STUB_STATUS_MODE=nested
check "fund.sh: a nested amount_micronoid before the top-level one is not taken (the top-level one counts)" "0" "$FRC"
check_has "fund.sh: ... and the amount is the top-level one" "amount: 5000000 micro-NOID" "$FOUT"
fund_run amt6 --dry-run STUB_STATUS_MODE=oneline
check "fund.sh: one-line JSON (no top-level line of the exact shape) refuses" "3" "$FRC"
check_has "fund.sh: ... said as such" "has 0 top-level amount_micronoid line(s)" "$FOUT"
fund_run amt7 --dry-run STUB_STATUS_MODE=twice
check "fund.sh: two top-level amount lines refuse" "3" "$FRC"
fund_run amt8 --dry-run STUB_STATUS_MODE=nestedonly
check "fund.sh: only a nested amount line refuses" "3" "$FRC"

PRE='printf "2026-11-06T11:46:09Z\n" > "$FD/funded.marker"'
fund_run mk1d --dry-run
check "fund.sh dry run: the run folder's marker is the reason a real run would be refused" "3" "$FRC"
check_has "fund.sh dry run: ... said with its time" "a real run would be REFUSED: fund.sh already ran for this run folder (at 2026-11-06T11:46:09Z)" "$FOUT"
fund_run mk1r ''
check "fund.sh real: the run folder's marker refuses; the wallet CLI is not called" "3|0" "$FRC|$(nfunds)"
PRE='printf "2026-11-06T11:00:00Z\nrun folder /elsewhere\n" > "$FO/funded-o1stubcontractroot0000.marker"'
fund_run mk2d --dry-run
check "fund.sh dry run: the contract's marker (another run folder, same object folder) refuses too" "3" "$FRC"
check_has "fund.sh dry run: ... said with its time" "this contract was already funded through fund.sh (marker $FO/funded-o1stubcontractroot0000.marker, at 2026-11-06T11:00:00Z)" "$FOUT"
fund_run mk2r ''
check "fund.sh real: the contract's marker refuses; the wallet CLI is not called; no marker of ours is left" "3|0|0" "$FRC|$(nfunds)|$([ -e "$FD/funded.marker" ] && echo 1 || echo 0)"
# F3: the refusal names every marker path, shows what the marker recorded and says what to do
PRE='printf "2026-11-06T11:46:09Z\nstage: calling wallet CLI\n" > "$FD/funded.marker"'
fund_run mk1s ''
check_has "fund.sh real: a refusal names the run folder's marker" "$FD/funded.marker" "$FOUT"
check_has "fund.sh real: ... and the object folder's marker" "$FO/funded-o1stubcontractroot0000.marker" "$FOUT"
check_has "fund.sh real: ... and the per-user marker" "$FH/.noid-swap/funded/o1stubcontractroot0000" "$FOUT"
check_has "fund.sh real: ... shows the recorded stage" "recorded (run folder): stage: calling wallet CLI" "$FOUT"
check_has "fund.sh real: ... and the recovery rule" "may or may not have gone out" "$FOUT"
check_has "fund.sh real: ... with the txid / instances advice" "before deleting ALL the markers above by hand" "$FOUT"
PRE='printf "2026-11-06T11:46:09Z\nstage: calling wallet CLI\nFunding submitted: abc123\nwallet exit 0\n" > "$FD/funded.marker"'
fund_run mk1t --dry-run
check_has "fund.sh dry run: a marker with a txid shows it" "recorded (run folder): Funding submitted: abc123" "$FOUT"
PRE='printf "2026-11-06T11:46:09Z\nacknowledged: funded outside fund.sh\n" > "$FD/funded.marker"'
fund_run mk1a --dry-run
check_has "fund.sh dry run: a marker made by the console's acknowledgement shows its line" "recorded (run folder): acknowledged: funded outside fund.sh" "$FOUT"
# F6: a marker path that is not a regular file refuses (real and dry run), whichever marker it is
PRE='mkdir "$FD/funded.marker"'
fund_run mkdir1 ''
check "fund.sh real: a directory at the run folder's marker path refuses" "3|0" "$FRC|$(nfunds)"
check_has "fund.sh real: ... said as such" "exists and is not a regular file" "$FOUT"
PRE='mkdir "$FO/funded-o1stubcontractroot0000.marker"'
fund_run mkdir2 --dry-run
check "fund.sh dry run: a directory at the object folder's marker path refuses" "3" "$FRC"
PRE='mkdir -p "$FH/.noid-swap/funded/o1stubcontractroot0000"'
fund_run mkdir3 ''
check "fund.sh real: a directory at the per-user marker path refuses, nothing funded, no other marker made" "3|0|0" "$FRC|$(nfunds)|$([ -e "$FD/funded.marker" ] && echo 1 || echo 0)"
PRE=''
# F4: the private copy is made per process; an old file of that name in the run folder is neither used nor touched, and nothing of ours is left
PRE='printf "{\"object\": \"stale\"}\n" > "$FD/fund-object.json"'
fund_run stale1 --dry-run
check "fund.sh dry run: an old fund-object.json in the run folder is not used (the sha256 is the object file's) and not touched" "0|$OBJSHA|{\"object\": \"stale\"}" "$FRC|$(printf '%s\n' "$FOUT" | sed -n 's/^object: .* sha256 //p')|$(cat "$FD/fund-object.json")"
PRE='printf "2026-11-06T11:46:09Z\n" > "$FD/funded.marker"'
fund_run stale2 --dry-run
check "fund.sh dry run: a refusal (a marker) leaves no private copy behind either" "3|0" "$FRC|$(nleft "$FD")"
fund_run stale3 '' STUB_INST_OUT='Slot 635439  incarnation 757220  5.000000 NOID'
check "fund.sh real: a refusal (an instance) leaves no private copy behind" "3|0" "$FRC|$(nleft "$FD")"
PRE=''
# F5: the object file's hash changes after the markers were made (the copy is altered by the wallet CLI's instance listing here): the
# markers are rolled back, nothing is sent
fund_run chg1 '' STUB_INST_TOUCH=1
check "fund.sh real: a private copy that changes after it was hashed refuses (3), calls no wallet fund, leaves no marker" "3|0|0" "$FRC|$(nfunds)|$(nmarkers)"
check_has "fund.sh real: ... said as such" "changed after it was checked; not funding (nothing was sent)" "$FOUT"
check "fund.sh real: ... and no private copy is left" "0" "$(nleft "$FD")"
# F6: the wallet CLI's path of the copy comes from wslpath (a stub that fails, or prints nothing): refused before any marker
fund_run wsl0 --dry-run LIVE_PLATFORM=wsl "PATH=$TMP/wslstub:$PATH"
check "fund.sh (wsl platform, a working wslpath): the dry run goes through" "0" "$FRC"
for m in fail empty; do
  fund_run "wsl-$m" '' LIVE_PLATFORM=wsl "PATH=$TMP/wslstub:$PATH" STUB_WSLPATH=$m
  check "fund.sh real: wslpath [$m] refuses (3) before any marker, funds nothing, leaves no private copy" "3|0|0|0" "$FRC|$(nmarkers)|$(nfunds)|$(nleft "$FD")"
  check_has "fund.sh real: ... said as such [$m]" "(wslpath failed or printed nothing); not funding" "$FOUT"
done

fund_run real ''
check "fund.sh real: the clean run exits 0" "0" "$FRC"
check "fund.sh real: the wallet CLI's fund was called exactly once" "1" "$(nfunds)"
check "fund.sh real: ... with ALL THREE markers already there, the stage written, and the PRIVATE COPY as the object" "fund 5.000000 mk1=y mk2=y mk3=y st=y obj=$FD/fund-object.XXXXXX/fund-object.json content={\"object\": \"stub\"} " "$(grep '^fund ' "$FLOG" | normcopy)"
check "fund.sh real: the copy is what check-object.sh and the instance listing got too" "check $FD/fund-object.XXXXXX/fund-object.json|inst $FD/fund-object.XXXXXX/fund-object.json|same" "$(grep '^check ' "$FLOG" | normcopy)|$(grep '^inst ' "$FLOG" | normcopy)|$([ "$(grep '^check ' "$FLOG" | sed 's/^check //')" = "$(grep '^inst ' "$FLOG" | sed 's/^inst //')" ] && echo same || echo different)"
check "fund.sh real: ... and the private copy is removed afterwards" "0" "$(nleft "$FD")"
check "fund.sh real: all three markers exist afterwards" "3" "$(nmarkers)"
check_has "fund.sh real: the wallet CLI's output is shown on the terminal" "Funding submitted: stubtxid0001" "$FOUT"
M1C=$(cat "$FD/funded.marker")
check_has "fund.sh real: the marker records the stage" "stage: calling wallet CLI" "$M1C"
check_has "fund.sh real: ... the wallet CLI's output (the txid line)" "Funding submitted: stubtxid0001" "$M1C"
check_has "fund.sh real: ... and the exit code" "wallet exit 0" "$M1C"
check "fund.sh real: the marker's first line is a time" "yes" "$(head -n 1 "$FD/funded.marker" | grep -Eq '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:]{8}Z$' && echo yes || echo no)"
case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*) ok "fund.sh: the per-user folder's mode (skipped: this file system has no modes)" ;;
  *) check "fund.sh real: the per-user marker folder has mode 700" "700" "$(stat -c %a "$FH/.noid-swap/funded" 2>/dev/null || stat -f %Lp "$FH/.noid-swap/funded" 2>/dev/null)" ;;
esac
FD1=$FD; FO1=$FO; FH1=$FH
fund_again "$FD1" "$FO1/swap.object.json" "$FH1"
check "fund.sh real: a second run is refused, and the wallet CLI is not called again" "3|1" "$FRCX|$(nfunds)"
# a copy of the run folder (another L) with the same object folder cannot fund the same contract again (the object folder's marker)
fund_again "$TMP/fundcopy" "$FO1/swap.object.json" "$TMP/fundcopy-home"
check "fund.sh real: another run folder with the same object folder (another user) is refused too" "3|1" "$FRCX|$(nfunds)"
check_has "fund.sh real: ... by the object folder's marker" "this contract was already funded through fund.sh (marker $FO1/funded-o1stubcontractroot0000.marker" "$FOUTX"
# the per-user marker: another run folder with a COPIED object file in another folder is refused too
mkdir -p "$TMP/fundcopy2-obj"; cp "$FO1/swap.object.json" "$TMP/fundcopy2-obj/"
fund_again "$TMP/fundcopy2" "$TMP/fundcopy2-obj/swap.object.json" "$FH1"
check "fund.sh real: another run folder with a COPIED object file in another folder is refused by the per-user marker" "3|1" "$FRCX|$(nfunds)"
check_has "fund.sh real: ... said as such" "this contract was already funded by this user through fund.sh (marker $FH1/.noid-swap/funded/o1stubcontractroot0000" "$FOUTX"
check "fund.sh real: ... and it made no marker of its own" "no|no" "$([ -e "$TMP/fundcopy2/funded.marker" ] && echo yes || echo no)|$([ -e "$TMP/fundcopy2-obj/funded-o1stubcontractroot0000.marker" ] && echo yes || echo no)"
fund_run realfail '' STUB_FUND_EC=1
check "fund.sh real: a failing wallet CLI exits non-zero and the markers STAY (the funding may be pending)" "1|3" "$FRC|$(nmarkers)"
check_has "fund.sh real: ... and the marker records the exit code" "wallet exit 1" "$(cat "$FD/funded.marker")"
# F3: an interrupted call (the wallet CLI's parent is killed): the marker says "calling wallet CLI" and has no exit line
fund_run kill1 '' STUB_FUND_KILL=1
check "fund.sh real: an interrupted call ends non-zero, and the funding was attempted once" "yes|1" "$([ "$FRC" -ne 0 ] && echo yes || echo no)|$(nfunds)"
M1C=$(cat "$FD/funded.marker")
check "fund.sh real: ... the marker has the stage and NO exit line" "yes|no" "$(case "$M1C" in (*"stage: calling wallet CLI"*) echo yes;; (*) echo no;; esac)|$(case "$M1C" in (*"wallet exit"*) echo yes;; (*) echo no;; esac)"
fund_again "$FD" "$FO/swap.object.json" "$FH"
check "fund.sh real: ... a rerun is refused (3)" "3" "$FRCX"
check_has "fund.sh real: ... naming the run folder's marker path" "$FD/funded.marker" "$FOUTX"
check_has "fund.sh real: ... naming the object folder's marker path" "$FO/funded-o1stubcontractroot0000.marker" "$FOUTX"
check_has "fund.sh real: ... naming the per-user marker path" "$FH/.noid-swap/funded/o1stubcontractroot0000" "$FOUTX"
check_has "fund.sh real: ... showing the recorded stage" "recorded (run folder): stage: calling wallet CLI" "$FOUTX"
check_has "fund.sh real: ... and the recovery rule" "may or may not have gone out" "$FOUTX"
check "fund.sh real: ... and the wallet CLI was not called again" "1" "$(nfunds)"
check "fund.sh real: two runs in one run folder worked on two different private copies" "2|2" "$(grep -c '^check ' "$FLOG")|$(grep '^check ' "$FLOG" | sort -u | wc -l | tr -d ' ')"
# TERM during the wallet call (the line `Funding submitted` already printed): the trap runs once the call ends; the markers stay, with the
# stage and the txid and NO exit line, the private copy goes, a rerun is refused. tee -i keeps the line in the marker on an interrupt.
check "fund.sh: the wallet call is piped through tee -i (an interrupt must not kill tee)" "1" "$(grep -c 'contract fund.*| tee -i -a ' "$FB/fund.sh" || true)"
fund_run term1 '' STUB_FUND_TERM=1
M1C=$(cat "$FD/funded.marker")
TERM_SKIP=''
case "$(uname -s)" in MINGW*|MSYS*|CYGWIN*) [ "$FRC" -ne 0 ] || TERM_SKIP="signals sent to a parent shell are not delivered reliably under $(uname -s)" ;; esac
if [ -n "$TERM_SKIP" ]; then ok "fund.sh: TERM during the wallet call (skipped: $TERM_SKIP)"
else
  check "fund.sh real: TERM during the wallet call ends non-zero (the wallet was called once)" "yes|1" "$([ "$FRC" -ne 0 ] && echo yes || echo no)|$(nfunds)"
  check "fund.sh real: ... all three markers stay" "3" "$(nmarkers)"
  check "fund.sh real: ... the run folder's marker has the stage and the txid line and NO exit line" "yes|yes|no" "$(case "$M1C" in (*"stage: calling wallet CLI"*) echo yes;; (*) echo no;; esac)|$(case "$M1C" in (*"Funding submitted: stubtxid0001"*) echo yes;; (*) echo no;; esac)|$(case "$M1C" in (*"wallet exit"*) echo yes;; (*) echo no;; esac)"
  check "fund.sh real: ... the private copy is removed" "0" "$(nleft "$FD")"
  fund_again "$FD" "$FO/swap.object.json" "$FH"
  check "fund.sh real: ... a rerun is refused (3) and the wallet is not called again" "3|1" "$FRCX|$(nfunds)"
fi
# F4: the object file swapped between the check and the funding is NOT what gets funded (the copy is)
fund_run swap1 '' "STUB_SWAP=$TMP/fund$((FN + 1))-obj/swap.object.json"
check "fund.sh real: the object file replaced after the check: the funding still uses the checked copy" "0|1|fund 5.000000 mk1=y mk2=y mk3=y st=y obj=$FD/fund-object.XXXXXX/fund-object.json content={\"object\": \"stub\"} " "$FRC|$(nfunds)|$(grep '^fund ' "$FLOG" | normcopy)"
check "fund.sh real: ... (the original really was replaced)" "{\"object\": \"EVIL\"}" "$(cat "$FO/swap.object.json")"
# F6 / F5: a folder that cannot be written is said so (and is not "already ran")
PRE='ro_works "$FD" || RO_SKIP=1'
RO_SKIP=0
fund_run ro1 ''
if [ "$RO_SKIP" = 1 ]; then ok "fund.sh: a non-writable run folder (skipped: this file system or user ignores modes)"
else
  check "fund.sh real: a run folder that cannot be written exits 2 and funds nothing" "2|0" "$FRC|$(nfunds)"
  check_has "fund.sh real: ... says the folder, not 'already ran'" "is the run folder $FD writable?" "$FOUT"
  case "$FOUT" in *"already ran"*) bad "fund.sh real: ... does not say 'already ran'" ;; *) ok "fund.sh real: ... does not say 'already ran'" ;; esac
  chmod 755 "$FD"
fi
# the object folder cannot be written: the per-user marker made first is rolled back, nothing is funded
PRE='ro_works "$FO" || RO_SKIP=1'
RO_SKIP=0
fund_run ro2 ''
if [ "$RO_SKIP" = 1 ]; then ok "fund.sh: a non-writable object folder (skipped: this file system or user ignores modes)"
else
  check "fund.sh real: an object folder that cannot be written refuses, funds nothing, and the markers made before are rolled back" "3|0|0" "$FRC|$(nfunds)|$(nmarkers)"
  check_has "fund.sh real: ... says which marker" "could not create the marker $FO/funded-o1stubcontractroot0000.marker" "$FOUT"
  chmod 755 "$FO"
fi
PRE=''

# concurrency: 8 fund.sh started together. Exactly ONE wallet `contract fund` call, in each case.
# conc_start N: starts N runs, waits, and leaves the outputs in $CONCDIR/out.I and the exit codes in $CONCDIR/rc.I. Per run I the variables
# CONC_L_I, CONC_OBJ_I and CONC_HOME_I (set by the caller as functions of I via conc_place) say where it runs.
conc_run() {   # conc_run NAME N 'same-folder|same-object|same-home'
  local name=$1 n=$2 mode=$3 i d o h
  CONCDIR="$TMP/conc-$name"; mkdir -p "$CONCDIR"; CONCLOG="$CONCDIR/log"; : > "$CONCLOG"
  mkdir -p "$CONCDIR/obj"; printf '{"object": "stub"}\n' > "$CONCDIR/obj/swap.object.json"
  i=1
  while [ "$i" -le "$n" ]; do
    case "$mode" in
      same-folder) d="$CONCDIR/run"; o="$CONCDIR/obj/swap.object.json"; h="$CONCDIR/home" ;;
      same-object) d="$CONCDIR/run$i"; o="$CONCDIR/obj/swap.object.json"; h="$CONCDIR/home$i" ;;
      same-home) d="$CONCDIR/run$i"; mkdir -p "$CONCDIR/obj$i"; cp "$CONCDIR/obj/swap.object.json" "$CONCDIR/obj$i/"; o="$CONCDIR/obj$i/swap.object.json"; h="$CONCDIR/home" ;;
    esac
    mkdir -p "$d" "$h"; [ -f "$d/env.local.sh" ] || cp "$TMP/fund1/env.local.sh" "$d/"
    ( env -i HOME="$h" PATH="$PATH" L="$d" LIVE_PLATFORM=native OBJ="$o" BIN="$TMP/stubbin" NOID_CLI="$TMP/stubcli" AMOUNT=5000000 \
        STUB_LOG="$CONCLOG" STUB_L="$d" STUB_OBJDIR="$(dirname "$o")" "$BASH" "$FB/fund.sh" > "$CONCDIR/out.$i" 2>&1 < /dev/null; echo $? > "$CONCDIR/rc.$i" ) &
    i=$((i + 1))
  done
  wait
  CONCOK=0; i=1; while [ "$i" -le "$n" ]; do [ "$(cat "$CONCDIR/rc.$i")" = 0 ] && CONCOK=$((CONCOK + 1)); i=$((i + 1)); done
  CONCFUNDS=$(grep -c '^fund ' "$CONCLOG" || true)
}
conc_run same 8 same-folder
check "fund.sh: 8 runs started together in one run folder: exactly ONE wallet fund call, ONE run succeeded" "1|1" "$CONCFUNDS|$CONCOK"
conc_run obj 8 same-object
check "fund.sh: 8 runs in 8 run folders sharing one object file: exactly ONE wallet fund call, ONE run succeeded" "1|1" "$CONCFUNDS|$CONCOK"
conc_run home 8 same-home
check "fund.sh: 8 runs in 8 run folders with copies of the object file and one user: exactly ONE wallet fund call, ONE run succeeded" "1|1" "$CONCFUNDS|$CONCOK"

# ---- (9) claim.sh against a STUB swap-cli (records its argv; sends nothing): --submit-rpc and the whole output
CB="$TMP/claimbin"; mkdir -p "$CB"
cp "$HERE/env.sh" "$HERE/claim.sh" "$CB/"
cat > "$TMP/claimstub" <<'STUB'
#!/bin/sh
# records its argv, one argument per line, then prints STUB_LINES lines of JSON-like text (every 7th one an opening_hex line)
printf '%s\n' "$@" > "$STUB_ARGV"
echo "{"
i=1; while [ "$i" -le "${STUB_LINES:-5}" ]; do
  if [ $((i % 7)) -eq 0 ]; then echo "    \"opening_hex\": \"00ff\","; else echo "  \"line$i\": $i,"; fi
  i=$((i + 1))
done
echo "}"
STUB
chmod +x "$TMP/claimstub"
CLAIM_LOCAL=''   # one extra line for the next claim_run's env.local.sh (the path real runs use for NOID_RPC2)
# claim_run NAME [VAR=value ...] -- [claim.sh args]: sets COUT (stdout), CRC, CARGV (the stub's argv, one per line)
claim_run() {
  local name=$1; shift
  local d; d=$(mkl "claim-$name" ${CLAIM_LOCAL:+"$CLAIM_LOCAL"}); mkdir -p "$d/rec" "$d/bob"; echo "selftest-passphrase" > "$d/passphrase.txt"
  local vars=(); while [ $# -gt 0 ] && [ "$1" != "--" ]; do vars+=("$1"); shift; done
  [ $# -gt 0 ] && shift
  CARGV="$d/argv"
  COUT=$(env -i HOME="$TMP/home" PATH="$PATH" L="$d" LIVE_PLATFORM=native BIN="$TMP/claimstub" STUB_ARGV="$CARGV" ${vars[@]+"${vars[@]}"} \
    "$BASH" "$CB/claim.sh" ${1+"$@"} 2>/dev/null)
  CRC=$?
  CARGV=$(cat "$d/argv" 2>/dev/null)
}
count_arg() { printf '%s\n' "$2" | grep -cx -- "$1" || true; }
claim_run sub NOID_RPC2=http://127.0.0.1:19602 -- --submit
check "claim.sh --submit with NOID_RPC2: --submit-rpc once, --submit once" "1|1" "$(count_arg --submit-rpc "$CARGV")|$(count_arg --submit "$CARGV")"
check "claim.sh --submit with NOID_RPC2: the value follows the flag" "--submit-rpc http://127.0.0.1:19602" "$(printf '%s\n' "$CARGV" | grep -A1 -x -- --submit-rpc | tr '\n' ' ' | sed -e 's/ $//')"
CLAIM_LOCAL='NOID_RPC2=http://127.0.0.1:19603'
claim_run local -- --submit
CLAIM_LOCAL=''
check "claim.sh --submit with NOID_RPC2 set in env.local.sh: --submit-rpc once, --submit once" "1|1" "$(count_arg --submit-rpc "$CARGV")|$(count_arg --submit "$CARGV")"
check "claim.sh --submit with NOID_RPC2 set in env.local.sh: the value follows the flag" "--submit-rpc http://127.0.0.1:19603" "$(printf '%s\n' "$CARGV" | grep -A1 -x -- --submit-rpc | tr '\n' ' ' | sed -e 's/ $//')"
claim_run nosub -- --submit
check "claim.sh --submit without NOID_RPC2: no --submit-rpc" "0|1" "$(count_arg --submit-rpc "$CARGV")|$(count_arg --submit "$CARGV")"
claim_run dry NOID_RPC2=http://127.0.0.1:19602 --
check "claim.sh dry run with NOID_RPC2: no --submit-rpc, no --submit" "0|0" "$(count_arg --submit-rpc "$CARGV")|$(count_arg --submit "$CARGV")"
claim_run dryno --
check "claim.sh dry run without NOID_RPC2: no --submit-rpc" "0" "$(count_arg --submit-rpc "$CARGV")"
claim_run long STUB_LINES=100 --
check "claim.sh: output longer than 40 lines is printed whole (line 100 is there)" "1" "$(printf '%s\n' "$COUT" | grep -c '"line100": 100')"
check "claim.sh: ... and the opening_hex lines are still left out" "0" "$(printf '%s\n' "$COUT" | grep -c opening_hex)"

# ---- (10) watch.sh against a STUB tick.sh: the loop line keeps the ACTION, `applied` and `phase_after` after long parts (run 13: a long
# recorded intent pushed `phase_after` past the 1,200-character cut), and a terminal phase still ends the loop
WB="$TMP/watchbin"; mkdir -p "$WB"
cp "$HERE/env.sh" "$HERE/watch.sh" "$WB/"
cat > "$WB/tick.sh" <<'STUB'
#!/bin/sh
# STUB_MODE: long (tick 1 lock_final, tick 2 refunded) | done (done at once) | leftover (tick 1 done with a refund_noid action, tick 2 done)
n=$(cat "$STUB_CNT" 2>/dev/null || echo 0); n=$((n + 1)); echo "$n" > "$STUB_CNT"
Z=$(printf '%03000d' 0 | tr 0 Z); M=$(printf '%01500d' 0)
PH=lock_final; ACT='{"action": "wait", "reason": "the lock is not final yet"}'
case "$STUB_MODE" in
  long) [ "$n" -lt 2 ] || PH=refunded ;;
  done) PH=done ;;
  leftover) PH=done; [ "$n" -ge 2 ] || ACT='{"action": "refund_noid", "reason": "the contract is still funded"}' ;;
esac
echo "[$1] tick exit 0 at 12:00:0$n"
echo "noid: tip 281108 instance {$M}"
echo "eth : latest 1416 lock {$M}"
echo "sources: {}"; echo "events: []"
echo "ACTION: $ACT"
echo "notes: [\"$M\"]"
echo "intent: {\"status\": \"held\", \"blob\": \"$Z\"}"
echo "applied: True phase_after: $PH"
STUB
chmod +x "$WB/tick.sh"
# watch_run NAME MODE: sets WRC, WOUT, WLOOP (the loop file's text), WN (its number of lines)
watch_run() {
  local d; d=$(mkl "watch-$1")
  WOUT=$(env -i HOME="$TMP/home" PATH="$PATH" L="$d" LIVE_PLATFORM=native STUB_MODE="$2" STUB_CNT="$d/cnt" "$BASH" "$WB/watch.sh" alice 0 2>&1 < /dev/null); WRC=$?
  WLOOP=$(cat "$d/loop-alice.txt" 2>/dev/null); WN=$(printf '%s\n' "$WLOOP" | grep -c . || true)
}
watch_run long long
WL1=$(printf '%s\n' "$WLOOP" | sed -n 1p)
check "watch.sh: a 3,000-character intent does not push phase_after out of the line" "yes" "$(case "$WL1" in (*"applied: True phase_after: lock_final") echo yes;; (*) echo no;; esac)"
check_has "watch.sh: ... the ACTION is in the line" 'ACTION: {"action": "wait", "reason": "the lock is not final yet"}' "$WL1"
check_has "watch.sh: ... and the line starts with the time and the tick header" "[alice] tick exit 0 at 12:00:01" "$WL1"
check "watch.sh: ... the long intent itself is cut" "no" "$(case "$WL1" in (*"$(printf '%01000d' 0 | tr 0 Z)"*) echo yes;; (*) echo no;; esac)"
check "watch.sh: a non-terminal phase keeps the loop going; a terminal one (refunded) stops it with exit 0 after 2 lines" "0|2" "$WRC|$WN"
check_has "watch.sh: ... and says so" "all watched files terminal" "$WOUT"
watch_run done done
check "watch.sh: phase_after done stops the loop at once (1 line, exit 0)" "0|1" "$WRC|$WN"
check_has "watch.sh: ... the line has the phase" "phase_after: done" "$WLOOP"
watch_run left leftover
check "watch.sh: done with a leftover refund in the action is not terminal (2 lines), the plain done after it is" "0|2" "$WRC|$WN"

# ---- (11) install.sh: refuses a run folder that is under way (nothing copied), installs into a fresh one, --force skips the check
# inst_run DIR [ARGS...]: runs the real install.sh with L=DIR; sets IOUT, IRC, and INB (number of files under DIR/bin, 0 when absent)
inst_run() {
  local d=$1; shift
  IOUT=$(env -i HOME="$TMP/home" PATH="$PATH" L="$d" LIVE_PLATFORM=native "$BASH" "$HERE/install.sh" ${1+"$@"} 2>&1 < /dev/null); IRC=$?
  INB=$(ls "$d/bin" 2>/dev/null | wc -l | tr -d ' ')
}
NSCRIPTS=$(ls "$HERE"/*.sh | wc -l | tr -d ' ')
D=$(mkl inst1)
inst_run "$D" 4
check "install.sh: a fresh folder (only env.local.sh) installs" "0|$NSCRIPTS" "$IRC|$INB"
check "install.sh: ... the copied helper has no carriage return and is executable" "yes" "$([ -x "$D/bin/env.sh" ] && ! grep -q "$(printf '\r')" "$D/bin/env.sh" && echo yes || echo no)"
inst_run "$D" 4
check "install.sh: installing again into a folder that holds only bin/, env.local.sh and repo-dir.txt works" "0|$NSCRIPTS" "$IRC|$INB"
inst_run "$TMP/inst-new" 4
check "install.sh: a folder that does not exist yet installs" "0|$NSCRIPTS" "$IRC|$INB"
D=$(mkl inst2); printf '{}\n' > "$D/alice.swap.json"
inst_run "$D" 4
check "install.sh: a folder with alice.swap.json is refused (exit 3) and nothing is copied" "3|0" "$IRC|$INB"
check_has "install.sh: ... said as such, naming the file and --force" "alice.swap.json" "$IOUT"
check_has "install.sh: ... and the way out" "--force" "$IOUT"
D=$(mkl inst3); mkdir -p "$D/bob"; printf '{}\n' > "$D/bob/bob.swap.json"
inst_run "$D" 4
check "install.sh: a folder with bob/bob.swap.json is refused" "3|0" "$IRC|$INB"
D=$(mkl inst4); : > "$D/ui-console.lock"
inst_run "$D" 4
check "install.sh: a folder with the console's lock file is refused and nothing is copied" "3|0" "$IRC|$INB"
D=$(mkl inst5); : > "$D/last-tick-bob.json"
inst_run "$D" 4
check "install.sh: a folder with a last-tick file is refused" "3|0" "$IRC|$INB"
D=$(mkl inst6); : > "$D/loop-alice.txt"
inst_run "$D" 4
check "install.sh: a folder with a loop file is refused" "3|0" "$IRC|$INB"
D=$(mkl inst7); : > "$D/funded.marker"
inst_run "$D" 4
check "install.sh: a folder with funded.marker is refused" "3|0" "$IRC|$INB"
D=$(mkl inst8); : > "$D/ui-console.lock"
inst_run "$D" --force 4
check "install.sh: --force installs into a folder with the console's lock file" "0|$NSCRIPTS" "$IRC|$INB"
D=$(mkl inst9); printf '{}\n' > "$D/alice.swap.json"
inst_run "$D" --force
check "install.sh: --force alone (RUN from the default) installs into a folder with a swap file" "0|$NSCRIPTS" "$IRC|$INB"

# ---- (12) ACCEPT_PRODUCER_CONCENTRATION becomes --accept-producer-concentration (opt-in, said on every call); the ALERT_URL hook
D=$(mkl accept)
check "node_flags native: ACCEPT_PRODUCER_CONCENTRATION=1 adds --accept-producer-concentration" "$BASEF --accept-producer-concentration --curl-path curl" "$(run_native "$D" "$NF" NOID_RPC=http://n1 ETH_RPC=http://e1 ACCEPT_PRODUCER_CONCENTRATION=1)"
check "node_flags native: ... it is not set by default" "$BASEF --curl-path curl" "$(run_native "$D" "$NF" NOID_RPC=http://n1 ETH_RPC=http://e1)"
check "node_flags native: ACCEPT_PRODUCER_CONCENTRATION=0 adds nothing" "$BASEF --curl-path curl" "$(run_native "$D" "$NF" NOID_RPC=http://n1 ETH_RPC=http://e1 ACCEPT_PRODUCER_CONCENTRATION=0)"
check "node_flags native: only the value 1 counts (yes adds nothing)" "$BASEF --curl-path curl" "$(run_native "$D" "$NF" NOID_RPC=http://n1 ETH_RPC=http://e1 ACCEPT_PRODUCER_CONCENTRATION=yes)"
check "node_flags native: SINGLE_NODE_OK=1 does not imply it" "$BASEF --single-node-ok --curl-path curl" "$(run_native "$D" "$NF" NOID_RPC=http://n1 ETH_RPC=http://e1 SINGLE_NODE_OK=1)"
check "node_flags native: it does not imply --single-node-ok either, and both together are both" "$BASEF --single-node-ok --accept-producer-concentration --curl-path curl" "$(run_native "$D" "$NF" NOID_RPC=http://n1 ETH_RPC=http://e1 SINGLE_NODE_OK=1 ACCEPT_PRODUCER_CONCENTRATION=1)"
check "node_flags native: second nodes and the setting" "$BASEF --noid-rpc http://n2 --eth-rpc http://e2 --accept-producer-concentration --curl-path curl" "$(run_native "$D" "$NF" NOID_RPC=http://n1 ETH_RPC=http://e1 NOID_RPC2=http://n2 ETH_RPC2=http://e2 ACCEPT_PRODUCER_CONCENTRATION=1)"
D=$(mkl accept2 'ACCEPT_PRODUCER_CONCENTRATION=1')
check "node_flags native: the setting in env.local.sh works" "$BASEF --accept-producer-concentration --curl-path curl" "$(run_native "$D" "$NF" NOID_RPC=http://n1 ETH_RPC=http://e1)"
W1=$(run_native "$D" 'node_flags >/dev/null' NOID_RPC=http://n1 ETH_RPC=http://e1 NOID_RPC2=http://n2 ETH_RPC2=http://e2 2>&1)
case "$W1" in *"ACCEPT_PRODUCER_CONCENTRATION=1"*"Amounts must stay trial-sized"*) ok "node_flags: the setting is said on stderr" ;; *) bad "node_flags: the setting is said on stderr" "[$W1]" ;; esac
W2=$(run_native "$D" 'node_flags >/dev/null 2>&1; node_flags 2>&1 >/dev/null; node_flags 2>&1 >/dev/null' NOID_RPC=http://n1 ETH_RPC=http://e1 NOID_RPC2=http://n2 ETH_RPC2=http://e2)
check "node_flags: ... on EVERY call (three calls, two of them counted here)" "2" "$(printf '%s\n' "$W2" | grep -c 'ACCEPT_PRODUCER_CONCENTRATION=1')"
D=$(mkl accept3)
W3=$(run_native "$D" 'node_flags 2>&1 >/dev/null' NOID_RPC=http://n1 ETH_RPC=http://e1 NOID_RPC2=http://n2 ETH_RPC2=http://e2)
check "node_flags: ... and not at all when the setting is off" "0" "$(printf '%s\n' "$W3" | grep -c 'ACCEPT_PRODUCER_CONCENTRATION' || true)"

# The alert hook, against a stub curl that records its arguments and its standard input. A tick line that starts with ALERT: is sent as a fixed short
# message; the URL travels on curl's standard input, never in its arguments; a failed send is kept and tried again; there is no per-line latch.
CURLSTUB="$TMP/curlstub"
cat > "$CURLSTUB" <<'STUB'
#!/bin/sh
printf '%s\n' "$*" >> "$CURL_LOG"
cat >> "$CURL_LOG.stdin"
exit "${CURL_EXIT:-0}"
STUB
chmod +x "$CURLSTUB"
SECRET_URL='http://alert.example/hook-SECRET-9f3a'
ADDR="o1$(printf 'q%.0s' $(seq 1 58))"; TXID=$(printf 'ab%.0s' $(seq 1 32))
ALERT_LINE="ALERT: a reorg removed Bob's NOID claim $TXID for 5.0 NOID to $ADDR. Send it again"
TICK_OUT=$(printf '%s\n' "[bob] tick exit 0 at 12:00:01" "notes: [\"x\"]" "$ALERT_LINE" "intent: {}")
# alert_run NAME CURL_EXIT 'TICK TEXT' [extra env.local.sh line]: sets AOUT (everything the hook printed), ARC, ALOG (the stub's log), and AD (the folder)
alert_run() {
  local name=$1 cx=$2 text=$3; shift 3
  AD=$(mkl "alert-$name" ${1+"$@"})
  AOUT=$(printf '%s\n' "$text" | env -i HOME="$TMP/home" PATH="$PATH" L="$AD" HERE="$HERE" LIVE_PLATFORM=native CURL="$CURLSTUB" CURL_LOG="$AD/curl.log" CURL_EXIT="$cx" RUN=7 \
    "$BASH" -c 'set -u; . "$HERE/env.sh"; alert_hook' 2>&1); ARC=$?
  ALOG=$(cat "$AD/curl.log" 2>/dev/null)
}
alert_again() {   # the same folder, another input
  local cx=$1 text=$2
  AOUT=$(printf '%s\n' "$text" | env -i HOME="$TMP/home" PATH="$PATH" L="$AD" HERE="$HERE" LIVE_PLATFORM=native CURL="$CURLSTUB" CURL_LOG="$AD/curl.log" CURL_EXIT="$cx" RUN=7 \
    "$BASH" -c 'set -u; . "$HERE/env.sh"; alert_hook' 2>&1); ARC=$?
  ALOG=$(cat "$AD/curl.log" 2>/dev/null)
}
MSG1="noid-swap run 7: claim removed by a reorg; run claim.sh dry run"
alert_run sent 0 "$TICK_OUT" "ALERT_URL=$SECRET_URL"
check "alert_hook: a new ALERT: line is sent once, as the fixed short message, the URL not among the arguments" "-s -f -m 20 -d $MSG1 -K -" "$ALOG"
check "alert_hook: ... the URL went to curl on its standard input" "url = \"$SECRET_URL\"" "$(cat "$AD/curl.log.stdin")"
check "alert_hook: ... the hook itself prints nothing (the URL is never echoed) and returns 0" "0|" "$ARC|$AOUT"
case "$ALOG" in *"$TXID"*|*"$ADDR"*|*"5.0 NOID"*) bad "alert_hook: the message holds no transaction id, address or amount" "$ALOG" ;; *) ok "alert_hook: the message holds no transaction id, address or amount" ;; esac
check "alert_hook: ... no latch and nothing pending is left" "0|none" "$(ls "$AD"/alert-sent-* 2>/dev/null | wc -l | tr -d ' ')|$([ -e "$AD/alert-pending" ] && echo some || echo none)"
alert_again 0 "$TICK_OUT"
check "alert_hook: the same line on a LATER tick is sent again (a second removal of the claim must alert)" "2" "$(printf '%s\n' "$ALOG" | grep -c .)"
alert_again 0 "$(printf '%s\n' "$TICK_OUT" "$TICK_OUT")"
check "alert_hook: ... but not twice in one tick output" "3" "$(printf '%s\n' "$ALOG" | grep -c .)"
alert_again 0 "ALERT: something else happened"
check "alert_hook: another ALERT: line is sent as the generic message (never the line)" "4|noid-swap run 7: an alert was raised; look at the loop log -K -" "$(printf '%s\n' "$ALOG" | grep -c .)|$(printf '%s\n' "$ALOG" | sed -n 4p | sed -e 's/^-s -f -m 20 -d //')"
alert_again 0 'notes: ["ALERT: not at the start of a line"] and ALERT: nor here'
check "alert_hook: only lines that START with ALERT: count" "4" "$(printf '%s\n' "$ALOG" | grep -c .)"
alert_run nourl 0 "$TICK_OUT"
check "alert_hook: without ALERT_URL nothing is sent and nothing is made" "none|none" "$([ -e "$AD/curl.log" ] && echo some || echo none)|$([ -e "$AD/alert-pending" ] && echo some || echo none)"
AD=$(mkl alert-env)
AOUT=$(printf '%s\n' "$TICK_OUT" | env -i HOME="$TMP/home" PATH="$PATH" L="$AD" HERE="$HERE" LIVE_PLATFORM=native CURL="$CURLSTUB" CURL_LOG="$AD/curl.log" ALERT_URL="$SECRET_URL" RUN=7 \
  "$BASH" -c 'set -u; . "$HERE/env.sh"; alert_hook' 2>&1)
check "alert_hook: ALERT_URL in the environment is ignored (only env.local.sh sets it)" "none" "$([ -e "$AD/curl.log" ] && echo some || echo none)"
alert_run failing 1 "$TICK_OUT" "ALERT_URL=$SECRET_URL"
check "alert_hook: a failing curl returns 0, prints nothing and keeps the message pending (the line will not be printed again)" "0||1|$MSG1" "$ARC|$AOUT|$(cat "$AD/alert-pending")"
alert_again 1 ""
check "alert_hook: ... a later call with no ALERT line tries it again and counts the try" "2|2|$MSG1" "$(printf '%s\n' "$ALOG" | grep -c .)|$(cut -d'|' -f1 "$AD/alert-pending")|$(cut -d'|' -f2- "$AD/alert-pending")"
alert_again 0 ""
check "alert_hook: ... and once curl works the pending message is sent and removed" "3|none" "$(printf '%s\n' "$ALOG" | grep -c .)|$([ -e "$AD/alert-pending" ] && echo some || echo none)"
printf '20|%s\n' "$MSG1" > "$AD/alert-pending"
alert_again 1 ""
check "alert_hook: ... a message that failed 20 times is given up" "none" "$([ -e "$AD/alert-pending" ] && echo some || echo none)"
printf 'junk\n' > "$AD/alert-pending"
alert_again 0 ""
check "alert_hook: ... a damaged pending file is dropped, nothing is sent from it" "none|0" "$([ -e "$AD/alert-pending" ] && echo some || echo none)|$ARC"

# reveal_sent_note: printed only when live.js's stderr has the "sent: HASH" line (the claim was broadcast), also when the claim is then stuck
RS=$(mkl revealnote)
printf 'sent: 0x%s nonce 3 maxFeePerGas 20 gwei maxPriorityFeePerGas 1 gwei (waiting for the receipt; if it stays pending: claim --replace)\n' "$(printf 'ab%.0s' $(seq 1 32))" > "$RS/sent.err"
printf 'refusing: past the reveal cutoff\n' > "$RS/refused.err"
RN1=$(env -i HOME="$TMP/home" PATH="$PATH" L="$RS" HERE="$HERE" LIVE_PLATFORM=native RUN=7 "$BASH" -c 'set -u; . "$HERE/env.sh"; reveal_sent_note "$L/sent.err"' 2>&1)
RN2=$(env -i HOME="$TMP/home" PATH="$PATH" L="$RS" HERE="$HERE" LIVE_PLATFORM=native RUN=7 "$BASH" -c 'set -u; . "$HERE/env.sh"; reveal_sent_note "$L/refused.err"; reveal_sent_note "$L/missing.err"' 2>&1)
check_has "reveal_sent_note: a sent claim gets the reminder to run tick.sh alice --apply" "tick.sh alice --apply right now" "$RN1"
check "reveal_sent_note: ... and a refused or missing claim does not" "" "$RN2"

# watch.sh with the hook: a stub tick.sh prints the ALERT: line on the first tick only, as the real tool does; the message goes out once, the URL is not printed, the loop line has the alert
AB="$TMP/watchalert"; mkdir -p "$AB"
cp "$HERE/env.sh" "$HERE/watch.sh" "$AB/"
cat > "$AB/tick.sh" <<'STUB'
#!/bin/sh
n=$(cat "$STUB_CNT" 2>/dev/null || echo 0); n=$((n + 1)); echo "$n" > "$STUB_CNT"
PH=secret_seen; [ "$n" -lt 3 ] || PH=refunded
echo "[$1] tick exit 0 at 12:00:0$n"
echo "noid: tip 281108"; echo "eth : latest 1416"; echo "sources: {}"; echo "events: []"
echo 'ACTION: {"action": "claim_noid"}'
echo 'notes: ["REORG", "ALERT: a reorg removed Bob'"'"'s NOID claim from the chain and it is not pending."]'
[ "$n" -eq 1 ] && echo "ALERT: a reorg removed Bob's NOID claim from the chain and it is not pending."
echo "applied: True phase_after: $PH"
STUB
chmod +x "$AB/tick.sh"
AD=$(mkl watch-alert "ALERT_URL=$SECRET_URL")
WAOUT=$(env -i HOME="$TMP/home" PATH="$PATH" L="$AD" LIVE_PLATFORM=native CURL="$CURLSTUB" CURL_LOG="$AD/curl.log" RUN=7 STUB_CNT="$AD/cnt" "$BASH" "$AB/watch.sh" bob 0 2>&1 < /dev/null); WARC=$?
check "watch.sh with ALERT_URL: the alert on the first tick is sent once (the later ticks show none)" "0|1|-s -f -m 20 -d $MSG1 -K -" "$WARC|$(grep -c . "$AD/curl.log")|$(cat "$AD/curl.log")"
case "$WAOUT" in *hook-SECRET*) bad "watch.sh: the URL is never printed" "$WAOUT" ;; *) ok "watch.sh: the URL is never printed" ;; esac
check_has "watch.sh: the loop line carries the alert" "ALERT: a reorg removed Bob's NOID claim" "$(cat "$AD/loop-bob.txt")"
AD=$(mkl watch-noalert)
env -i HOME="$TMP/home" PATH="$PATH" L="$AD" LIVE_PLATFORM=native CURL="$CURLSTUB" CURL_LOG="$AD/curl.log" RUN=7 STUB_CNT="$AD/cnt" "$BASH" "$AB/watch.sh" bob 0 >/dev/null 2>&1 < /dev/null
check "watch.sh without ALERT_URL: nothing is sent" "none" "$([ -e "$AD/curl.log" ] && echo some || echo none)"
# a failing curl does not stop the loop
AD=$(mkl watch-failing "ALERT_URL=$SECRET_URL")
env -i HOME="$TMP/home" PATH="$PATH" L="$AD" LIVE_PLATFORM=native CURL="$CURLSTUB" CURL_LOG="$AD/curl.log" CURL_EXIT=7 RUN=7 STUB_CNT="$AD/cnt" "$BASH" "$AB/watch.sh" bob 0 >/dev/null 2>&1 < /dev/null; WFRC=$?
check "watch.sh: a failing curl does not stop the loop (it ends by the terminal phase, exit 0, three ticks)" "0|3" "$WFRC|$(grep -c . "$AD/loop-bob.txt")"
check "watch.sh: ... the failed alert is retried on each later tick (one try for the line, two retries) and stays pending" "3|3" "$(grep -c . "$AD/curl.log")|$(cut -d'|' -f1 "$AD/alert-pending")"

# tick.sh puts each ALERT: note on a line of its own (it summarises the tick's JSON with python3)
: > "$TMP/pyprobe"
if command -v python3 >/dev/null 2>&1 && python3 -c 'import sys; open(sys.argv[1]).close()' "$TMP/pyprobe" 2>/dev/null; then
  TB="$TMP/tickbin"; mkdir -p "$TB"; cp "$HERE/env.sh" "$HERE/tick.sh" "$TB/"
  cat > "$TMP/tickstub" <<'STUB'
#!/bin/sh
cat <<'JSON'
{"noid": {"tip": 5}, "eth": {}, "sources": {}, "events": [], "action": {"kind": "wait"}, "notes": ["one", "ALERT: line one of the notes", "two", "ALERT: line two"], "intent": {}, "events_applied_to_file": true, "phase_after": "secret_seen"}
JSON
STUB
  chmod +x "$TMP/tickstub"
  D=$(mkl tickalert); mkdir -p "$D/rec" "$D/bob"; echo "selftest-passphrase" > "$D/passphrase.txt"
  TOUT=$(env -i HOME="$TMP/home" PATH="$PATH" L="$D" LIVE_PLATFORM=native BIN="$TMP/tickstub" "$BASH" "$TB/tick.sh" bob 2>/dev/null)
  check "tick.sh: each ALERT: note is a line of its own" "2" "$(printf '%s\n' "$TOUT" | grep -c '^ALERT:')"
else
  echo "skip tick.sh ALERT lines (no python3 on this machine that reads this shell's paths)"
fi


# ---- (13) setup.sh picks a recent log start (run 14 finding 1), against a stub curl that answers eth_getBlockByNumber from a map file (no network)
RPCSTUB="$TMP/rpcstub"
cat > "$RPCSTUB" <<'STUB'
#!/bin/sh
url=$(sed -n 's/^url = "\(.*\)"$/\1/p')
body=""; while [ $# -gt 0 ]; do if [ "$1" = -d ]; then body=$2; fi; shift; done
case "$body" in *eth_chainId*) tag=chainId ;; *) tag=$(printf '%s' "$body" | sed -n 's/.*"params":\["\([a-z]*\)".*/\1/p') ;; esac
printf '%s %s\n' "$url" "$tag" >> "$RPC_LOG"
line=$(grep -F "$url $tag " "$RPC_MAP" | head -n 1)
if [ -z "$line" ]; then
  # no map entry: the chain id defaults to Sepolia (0xaa36a7 = 11155111), everything else is an HTTP error
  if [ "$tag" = chainId ]; then echo '{"jsonrpc":"2.0","id":1,"result":"0xaa36a7"}'; exit 0; fi
  exit 22
fi
printf '%s\n' "${line#"$url $tag "}"
STUB
chmod +x "$RPCSTUB"
blk() { printf '{"jsonrpc":"2.0","id":1,"result":{"number":"%s","hash":"0xab","transactions":[]}}' "$1"; }
# setup_run NAME 'MAP TEXT' [VAR=value ...]: runs setup.sh in a new run folder with the stub; sets SD (folder), SOUT (stdout+stderr), SRC (status), SLOG (nodes asked)
setup_run() {
  local name=$1 map=$2; shift 2
  SD=$(mkl "setup-$name"); printf '%s\n' "$map" > "$SD/rpc.map"; rm -f "$SD/rpc.log"
  SOUT=$(env -i HOME="$TMP/home" PATH="$PATH" L="$SD" LIVE_PLATFORM=native CURL="$RPCSTUB" RPC_MAP="$SD/rpc.map" RPC_LOG="$SD/rpc.log" RUN=7 ETH_RPC=http://e1 ${1+"$@"} \
    "$BASH" "$HERE/setup.sh" 2>&1); SRC=$?
  SLOG=$(cat "$SD/rpc.log" 2>/dev/null)
}
sb() { cat "$SD/eth-deploy-block.txt" 2>/dev/null || echo none; }
setup_run fin "http://e1 finalized $(blk 0x1d4c0)"
check "setup.sh: the log start is the finalized block (0x1d4c0 = 120000) minus the margin 2400 = 117600; the chain id was checked first" "0|117600|http://e1 chainId,http://e1 finalized" "$SRC|$(sb)|$(printf '%s\n' "$SLOG" | paste -sd, -)"
check_has "setup.sh: ... said on the screen" "log start 117600 (finalized block minus 2400" "$SOUT"
check "setup.sh: ... the passphrase is made and the run line shows the start" "1|1" "$([ -s "$SD/passphrase.txt" ] && echo 1 || echo 0)|$(printf '%s\n' "$SOUT" | grep -c 'eth from block 117600')"
check "setup.sh: from_block_flags passes it on" "--eth-from-block 117600" "$(run_native "$SD" 'echo $(from_block_flags)' ETH_RPC=http://e1)"
setup_run margin0 "http://e1 finalized $(blk 0x1d4c0)" ETH_START_MARGIN=0
check "setup.sh: ETH_START_MARGIN=0 gives the finalized block itself" "0|120000" "$SRC|$(sb)"
setup_run bigmargin "http://e1 finalized $(blk 0x1d4c0)" ETH_START_MARGIN=999999
check "setup.sh: a margin larger than the block number gives 0" "0|0" "$SRC|$(sb)"
setup_run wrongchain "http://e1 chainId {\"jsonrpc\":\"2.0\",\"id\":1,\"result\":\"0x1\"}
http://e1 finalized $(blk 0x1d4c0)"
check "setup.sh: a node on another chain (mainnet 0x1 against CHAIN 11155111): exit 2, no start file" "2|none" "$SRC|$(sb)"
check_has "setup.sh: ... the message says both chains and does not print the URL" "is on chain 1 but this run is chain 11155111" "$SOUT"
setup_run chainmatch "http://e1 chainId {\"jsonrpc\":\"2.0\",\"id\":1,\"result\":\"0x1\"}
http://e1 finalized $(blk 0x1d4c0)" CHAIN=1
check "setup.sh: ... and the same node is fine when the run is chain 1" "0|117600" "$SRC|$(sb)"
setup_run nochain "http://e1 chainId {\"jsonrpc\":\"2.0\",\"id\":1,\"result\":null}
http://e1 finalized $(blk 0x1d4c0)"
check "setup.sh: a node whose chain id cannot be read: exit 2, no start file" "2|none" "$SRC|$(sb)"
setup_run nofin "http://e1 finalized {\"jsonrpc\":\"2.0\",\"id\":1,\"error\":{\"code\":-32602,\"message\":\"unsupported\"}}
http://e1 latest $(blk 0x1d4c0)"
check "setup.sh: no finalized block served -> the latest block minus 256 minus the margin 2400 (120000 - 256 - 2400 = 117344)" "0|117344" "$SRC|$(sb)"
setup_run nullfin "http://e1 finalized {\"jsonrpc\":\"2.0\",\"id\":1,\"result\":null}
http://e1 latest $(blk 0x1d4c0)" ETH_START_MARGIN=1000
check "setup.sh: a null finalized answer falls back too, and ETH_START_MARGIN is honoured (120000 - 256 - 1000 = 118744)" "0|118744" "$SRC|$(sb)"
setup_run small "http://e1 finalized {\"result\":null}
http://e1 latest $(blk 0x64)"
check "setup.sh: a latest block below the margin gives 0, not a negative number" "0|0" "$SRC|$(sb)"
setup_run two "http://e1 finalized $(blk 0x1d4c0)
http://e2 finalized $(blk 0x1d000)" ETH_RPC2=http://e2
check "setup.sh: with two nodes the LOWER start wins (0x1d000 - 2400 = 116384); both nodes were asked, chain id and block each" "0|116384|4" "$SRC|$(sb)|$(printf '%s\n' "$SLOG" | grep -c .)"
setup_run two2 "http://e1 finalized $(blk 0x1d000)
http://e2 finalized $(blk 0x1d4c0)" ETH_RPC2=http://e2
check "setup.sh: ... whichever node it is" "0|116384" "$SRC|$(sb)"
setup_run twobad "http://e1 finalized $(blk 0x1d4c0)" ETH_RPC2=http://e2
check "setup.sh: a second node that cannot be read stops the choice (fail closed, no file, exit 2)" "2|none" "$SRC|$(sb)"
setup_run down ""
check "setup.sh: an unreadable node: exit 2, no start file" "2|none" "$SRC|$(sb)"
check_has "setup.sh: ... with a message that names DEPLOY_BLOCK" "DEPLOY_BLOCK" "$SOUT"
setup_run garbage "http://e1 finalized <html>bad gateway</html>
http://e1 latest <html>bad gateway</html>"
check "setup.sh: a non-JSON answer is not a block: exit 2, no start file" "2|none" "$SRC|$(sb)"
setup_run errlatest "http://e1 finalized {\"error\":{\"code\":4444,\"message\":\"pruned history unavailable\"}}
http://e1 latest {\"error\":{\"code\":-1,\"message\":\"x\",\"number\":\"0x5\"}}"
check "setup.sh: an error object is never read for a number" "2|none" "$SRC|$(sb)"
setup_run badmargin "http://e1 finalized $(blk 0x1d4c0)" ETH_START_MARGIN=ten
check "setup.sh: a bad ETH_START_MARGIN is refused, no start file" "2|none" "$SRC|$(sb)"
setup_run explicit "http://e1 finalized $(blk 0x1d4c0)" DEPLOY_BLOCK=12095751
check "setup.sh: an explicit DEPLOY_BLOCK wins and the node is not asked" "0|12095751|" "$SRC|$(sb)|$SLOG"
D=$(mkl setup-envlocal 'DEPLOY_BLOCK=5000')
SOUT=$(env -i HOME="$TMP/home" PATH="$PATH" L="$D" LIVE_PLATFORM=native CURL="$RPCSTUB" RPC_MAP="$D/none" RPC_LOG="$D/rpc.log" RUN=7 "$BASH" "$HERE/setup.sh" 2>&1); SRC=$?
check "setup.sh: DEPLOY_BLOCK in env.local.sh counts too" "0|5000|none" "$SRC|$(cat "$D/eth-deploy-block.txt")|$([ -e "$D/rpc.log" ] && echo some || echo none)"
setup_run badexplicit "" DEPLOY_BLOCK=12abc
check "setup.sh: a DEPLOY_BLOCK that is not a number is refused" "2|none" "$SRC|$(sb)"
# an existing start file is kept, the node is not asked
SD=$(mkl setup-kept); echo 424242 > "$SD/eth-deploy-block.txt"; : > "$SD/rpc.map"
SOUT=$(env -i HOME="$TMP/home" PATH="$PATH" L="$SD" LIVE_PLATFORM=native CURL="$RPCSTUB" RPC_MAP="$SD/rpc.map" RPC_LOG="$SD/rpc.log" RUN=7 ETH_RPC=http://e1 "$BASH" "$HERE/setup.sh" 2>&1); SRC=$?
check "setup.sh: an existing eth-deploy-block.txt is kept and the node is not asked" "0|424242|none" "$SRC|$(sb)|$([ -e "$SD/rpc.log" ] && echo some || echo none)"
# a run folder that already holds a swap file gets no fresh guess (its lock may be on chain already)
SD=$(mkl setup-swapfile); mkdir -p "$SD/bob"; echo '{}' > "$SD/bob/bob.swap.json"; printf '%s\n' "http://e1 finalized $(blk 0x1d4c0)" > "$SD/rpc.map"
SOUT=$(env -i HOME="$TMP/home" PATH="$PATH" L="$SD" LIVE_PLATFORM=native CURL="$RPCSTUB" RPC_MAP="$SD/rpc.map" RPC_LOG="$SD/rpc.log" RUN=7 ETH_RPC=http://e1 "$BASH" "$HERE/setup.sh" 2>&1); SRC=$?
check "setup.sh: a folder with a swap file and no start file: no guess, no file, no node call, exit 0" "0|none|none" "$SRC|$(sb)|$([ -e "$SD/rpc.log" ] && echo some || echo none)"
check_has "setup.sh: ... and it says why" "carries its own stored start" "$SOUT"
check "setup.sh: ... and from_block_flags then prints nothing (the swap file's stored start is used)" "" "$(run_native "$SD" 'echo $(from_block_flags)')"
# the URL travels on curl's standard input, not in its arguments (an endpoint may carry a key)
KURL='http://node.example/v2/KEY-SECRET-77'
ARGSTUB="$TMP/argstub"
cat > "$ARGSTUB" <<'STUB'
#!/bin/sh
printf '%s\n' "$*" >> "$ARG_LOG"; cat >> "$ARG_LOG.stdin"
case "$*" in *eth_chainId*) echo '{"result":"0xaa36a7"}' ;; *) echo '{"result":{"number":"0x10"}}' ;; esac
STUB
chmod +x "$ARGSTUB"
SD=$(mkl setup-urlarg); SOUT=$(env -i HOME="$TMP/home" PATH="$PATH" L="$SD" LIVE_PLATFORM=native CURL="$ARGSTUB" ARG_LOG="$SD/args.log" RUN=7 ETH_START_MARGIN=0 ETH_RPC="$KURL" "$BASH" "$HERE/setup.sh" 2>&1)
case "$(cat "$SD/args.log")" in *KEY-SECRET*) bad "setup.sh: the node URL is not among curl's arguments" ;; *) ok "setup.sh: the node URL is not among curl's arguments" ;; esac
check "setup.sh: ... it went to curl's standard input, and the start is 16 (margin 0) after two calls" "2|16" "$(grep -c 'KEY-SECRET-77' "$SD/args.log.stdin")|$(sb)"

# ---- (14) the once-per-stuck-claim phone message (T21-12): alarm_hook and watch.sh
ALARM_LATE="ALARM: the NOID claim is still pending (not seen mined) and the next call height 99 is past the D-19 target (D 100): if it is mined now it is not final before Alice's refund opens at D"
ALARM_CLOSED="ALARM: the NOID claim is still pending but the claim branch is closed (next call height 100 >= D 100): it can no longer be mined validly"
AMSG_LATE="noid-swap run 7: Bob's NOID claim is still pending past its target; look at the loop log"
AMSG_CLOSED="noid-swap run 7: Bob's NOID claim is still pending and the claim branch is closed; look at the loop log"
alarm_run() {   # alarm_run CURL_EXIT 'TEXT' [ROLE]: in the folder AD; sets AOUT, ARC, ALOG
  local cx=$1 text=$2 role=${3:-bob}
  AOUT=$(printf '%s\n' "$text" | env -i HOME="$TMP/home" PATH="$PATH" L="$AD" HERE="$HERE" LIVE_PLATFORM=native CURL="$CURLSTUB" CURL_LOG="$AD/curl.log" CURL_EXIT="$cx" RUN=7 \
    "$BASH" -c 'set -u; . "$HERE/env.sh"; alarm_hook '"$role" 2>&1); ARC=$?
  ALOG=$(cat "$AD/curl.log" 2>/dev/null)
}
nlatch() { ls "$AD" | grep -c '^alarm-sent' || true; }
AD=$(mkl alarm "ALERT_URL=$SECRET_URL")
alarm_run 0 "$(printf '%s\n' 'notes: ["x"]' "$ALARM_LATE")"
check "alarm_hook: the late alarm is sent once, as the fixed message, the URL not among the arguments" "0||-s -f -m 20 -d $AMSG_LATE -K -" "$ARC|$AOUT|$ALOG"
check "alarm_hook: ... the URL went to curl on its standard input" "url = \"$SECRET_URL\"" "$(cat "$AD/curl.log.stdin")"
check "alarm_hook: ... an empty latch file was made" "1|0" "$(nlatch)|$(wc -c < "$AD/alarm-sent-bob-late" | tr -d ' ')"
alarm_run 0 "$ALARM_LATE"; alarm_run 0 "$ALARM_LATE"
check "alarm_hook: the same alarm on later ticks is not sent again" "1" "$(printf '%s\n' "$ALOG" | grep -c .)"
alarm_run 0 "$(printf '%s\n' "$ALARM_LATE" "$ALARM_LATE")"
check "alarm_hook: ... nor twice in one tick output" "1" "$(printf '%s\n' "$ALOG" | grep -c .)"
alarm_run 0 "$ALARM_CLOSED"
check "alarm_hook: the other kind (claim branch closed) is a new message, once" "2|$AMSG_CLOSED -K -" "$(printf '%s\n' "$ALOG" | grep -c .)|$(printf '%s\n' "$ALOG" | sed -n 2p | sed -e 's/^-s -f -m 20 -d //')"
alarm_run 0 "$ALARM_CLOSED"
check "alarm_hook: ... and not again" "2" "$(printf '%s\n' "$ALOG" | grep -c .)"
case "$ALOG" in *"D 100"*|*"99"*|*"Alice"*) bad "alarm_hook: nothing of the alarm text leaves in the message" "$ALOG" ;; *) ok "alarm_hook: nothing of the alarm text leaves in the message" ;; esac
AD=$(mkl alarm-filter "ALERT_URL=$SECRET_URL")
alarm_run 0 "ALARM: this lock's T_reveal is beyond the engine's own bound"
alarm_run 0 'notes: ["ALARM: the NOID claim is still pending (not at the start of a line)"]'
alarm_run 0 "ALERT: a reorg removed Bob's NOID claim"
check "alarm_hook: other ALARM notes, a note inside the notes line and ALERT lines are not forwarded by it (fresh folder, no latch)" "none|0" "$([ -e "$AD/curl.log" ] && echo some || echo none)|$(nlatch)"
AD="$TMP/alarm"   # back to the first folder (both kinds already latched there)
alarm_run 0 "$ALARM_LATE" alice
check "alarm_hook: the latch is per swap file (role): Alice's file has its own" "3" "$(printf '%s\n' "$ALOG" | grep -c .)"
AD=$(mkl alarm-nourl)
alarm_run 0 "$ALARM_LATE"
check "alarm_hook: without ALERT_URL nothing is sent and no latch is made" "none|0" "$([ -e "$AD/curl.log" ] && echo some || echo none)|$(nlatch)"
AD=$(mkl alarm-fail "ALERT_URL=$SECRET_URL")
alarm_run 1 "$ALARM_LATE"
check "alarm_hook: a failing curl returns 0, prints nothing and leaves no latch (so the next tick tries again)" "0||1|0" "$ARC|$AOUT|$(printf '%s\n' "$ALOG" | grep -c .)|$(nlatch)"
alarm_run 1 "$ALARM_LATE"
check "alarm_hook: ... and it does try again on the next tick" "2" "$(printf '%s\n' "$ALOG" | grep -c .)"
alarm_run 0 "$ALARM_LATE"; alarm_run 0 "$ALARM_LATE"
check "alarm_hook: ... once curl works it is sent and latched (three tries in all)" "3|1" "$(printf '%s\n' "$ALOG" | grep -c .)|$(nlatch)"
AD=$(mkl alarm-held "ALERT_URL=$SECRET_URL"); : > "$AD/alarm-sent-bob-late"
alarm_run 0 "$ALARM_LATE"
check "alarm_hook: an existing latch (another loop, or an earlier pass of this one) blocks the send" "none" "$([ -e "$AD/curl.log" ] && echo some || echo none)"
AD=$(mkl alarm-nofolder "ALERT_URL=$SECRET_URL")
AOUT=$(printf '%s\n' "$ALARM_LATE" | env -i HOME="$TMP/home" PATH="$PATH" L="$AD" HERE="$HERE" LIVE_PLATFORM=native CURL="$CURLSTUB" CURL_LOG="$AD/curl2.log" RUN=7 "$BASH" -c 'set -u; . "$HERE/env.sh"; L="$L/gone"; alarm_hook bob' 2>&1); ARC=$?
check "alarm_hook: a latch that cannot be made means no send (never a message on every tick) and still exit 0" "0|none" "$ARC|$([ -e "$AD/curl2.log" ] && echo some || echo none)"

# watch.sh: the alarm printed on every tick is forwarded once; a failing curl does not stop the loop and is tried on each tick
AW="$TMP/watchalarm"; mkdir -p "$AW"
cp "$HERE/env.sh" "$HERE/watch.sh" "$AW/"
cat > "$AW/tick.sh" <<'STUB'
#!/bin/sh
n=$(cat "$STUB_CNT" 2>/dev/null || echo 0); n=$((n + 1)); echo "$n" > "$STUB_CNT"
PH=claim_submitted; [ "$n" -lt 4 ] || PH=done
echo "[$1] tick exit 0 at 12:00:0$n"
echo "noid: tip 281108"; echo "eth : latest 1416"; echo "sources: {}"; echo "events: []"
echo 'ACTION: {"action": "wait"}'
echo 'notes: ["ALARM: the NOID claim is still pending (not seen mined) and the next call height 99 is past the D-19 target (D 100)"]'
echo "ALARM: the NOID claim is still pending (not seen mined) and the next call height 99 is past the D-19 target (D 100): if it is mined now it is not final before Alice's refund opens at D"
echo "applied: True phase_after: $PH"
STUB
chmod +x "$AW/tick.sh"
AD=$(mkl watch-alarm "ALERT_URL=$SECRET_URL")
WAOUT=$(env -i HOME="$TMP/home" PATH="$PATH" L="$AD" LIVE_PLATFORM=native CURL="$CURLSTUB" CURL_LOG="$AD/curl.log" RUN=7 STUB_CNT="$AD/cnt" "$BASH" "$AW/watch.sh" bob 0 2>&1 < /dev/null); WARC=$?
check "watch.sh: the pending-claim alarm printed on four ticks is sent once" "0|1|-s -f -m 20 -d $AMSG_LATE -K -" "$WARC|$(grep -c . "$AD/curl.log")|$(cat "$AD/curl.log")"
case "$WAOUT" in *hook-SECRET*) bad "watch.sh: the URL is never printed (alarm)" "$WAOUT" ;; *) ok "watch.sh: the URL is never printed (alarm)" ;; esac
AD=$(mkl watch-alarm-fail "ALERT_URL=$SECRET_URL")
env -i HOME="$TMP/home" PATH="$PATH" L="$AD" LIVE_PLATFORM=native CURL="$CURLSTUB" CURL_LOG="$AD/curl.log" CURL_EXIT=7 RUN=7 STUB_CNT="$AD/cnt" "$BASH" "$AW/watch.sh" bob 0 >/dev/null 2>&1 < /dev/null; WFRC=$?
check "watch.sh: a failing curl does not stop the loop (four ticks, exit 0), the alarm is tried on each tick, no latch kept" "0|4|4|0" "$WFRC|$(grep -c . "$AD/loop-bob.txt")|$(grep -c . "$AD/curl.log")|$(nlatch)"
AD=$(mkl watch-alarm-nourl)
env -i HOME="$TMP/home" PATH="$PATH" L="$AD" LIVE_PLATFORM=native CURL="$CURLSTUB" CURL_LOG="$AD/curl.log" RUN=7 STUB_CNT="$AD/cnt" "$BASH" "$AW/watch.sh" bob 0 >/dev/null 2>&1 < /dev/null
check "watch.sh without ALERT_URL: the alarm sends nothing" "none" "$([ -e "$AD/curl.log" ] && echo some || echo none)"
if command -v python3 >/dev/null 2>&1 && python3 -c 'import sys; open(sys.argv[1]).close()' "$TMP/pyprobe" 2>/dev/null; then
  cat > "$TMP/tickstub2" <<'STUB'
#!/bin/sh
cat <<'JSON'
{"noid": {"tip": 5}, "eth": {}, "sources": {}, "events": [], "action": {"kind": "wait"}, "notes": ["one", "ALARM: the NOID claim is still pending (not seen mined) and the next call height 99", "ALARM: another thing", "two"], "intent": {}, "events_applied_to_file": true, "phase_after": "claim_submitted"}
JSON
STUB
  chmod +x "$TMP/tickstub2"
  D=$(mkl tickalarm); mkdir -p "$D/rec" "$D/bob"; echo "selftest-passphrase" > "$D/passphrase.txt"
  TOUT=$(env -i HOME="$TMP/home" PATH="$PATH" L="$D" LIVE_PLATFORM=native BIN="$TMP/tickstub2" "$BASH" "$TB/tick.sh" bob 2>/dev/null)
  check "tick.sh: the pending-claim ALARM note is a line of its own, other ALARM notes are not" "1|0" "$(printf '%s\n' "$TOUT" | grep -c '^ALARM: the NOID claim is still pending')|$(printf '%s\n' "$TOUT" | grep -c '^ALARM: another' || true)"
else
  echo "skip tick.sh ALARM lines (no python3 on this machine that reads this shell's paths)"
fi

# alarm re-arm: a COMPLETE tick (its `applied:` line) that no longer shows a kind ends the episode, so the next one is announced again
AD=$(mkl alarm-rearm "ALERT_URL=$SECRET_URL")
alarm_run 0 "$ALARM_LATE"
alarm_run 0 "$(printf '%s\n' 'noid: tip 1' 'applied: True phase_after: claim_submitted')"
check "alarm_hook: a tick that fails or prints no applied: line re-arms nothing; a complete tick without the alarm does" "1|0" "$(printf '%s\n' "$ALOG" | grep -c .)|$(nlatch)"
alarm_run 0 "$ALARM_LATE"
check "alarm_hook: ... and the next episode of the same kind is sent again" "2|1" "$(printf '%s\n' "$ALOG" | grep -c .)|$(nlatch)"
alarm_run 0 "$(printf '%s\n' "$ALARM_LATE" 'applied: True phase_after: claim_submitted')"
check "alarm_hook: ... a complete tick that still shows the alarm keeps the latch (no repeat)" "2|1" "$(printf '%s\n' "$ALOG" | grep -c .)|$(nlatch)"
alarm_run 0 "tick exit 1 and no output at all"
check "alarm_hook: ... an unreadable tick keeps the latch" "1" "$(nlatch)"

# from_block_flags never passes a start higher than the one a swap file in the folder already carries (a rebuilt folder must not move it past a lock)
FB=$(mkl fromblock); echo 5000000 > "$FB/eth-deploy-block.txt"
check "from_block_flags: no swap file: the file's value is passed" "--eth-from-block 5000000" "$(run_native "$FB" 'echo $(from_block_flags)')"
mkdir -p "$FB/bob"; printf '{\n  "phase": "x",\n  "eth_from_block": 1000000\n}\n' > "$FB/bob/bob.swap.json"
check "from_block_flags: a swap file with a LOWER stored start: nothing is passed, the stored start is used" "" "$(run_native "$FB" 'echo $(from_block_flags)' 2>/dev/null)"
check_has "from_block_flags: ... and it says so on stderr" "is NOT passed, the stored start is used" "$(run_native "$FB" 'from_block_flags 2>&1 >/dev/null')"
printf '{\n  "eth_from_block": 9000000\n}\n' > "$FB/bob/bob.swap.json"
check "from_block_flags: a swap file with a HIGHER stored start: the file's (lower) value is passed" "--eth-from-block 5000000" "$(run_native "$FB" 'echo $(from_block_flags)')"
printf '{\n  "eth_from_block": null\n}\n' > "$FB/bob/bob.swap.json"
check "from_block_flags: a swap file with no stored start: the file's value is passed" "--eth-from-block 5000000" "$(run_native "$FB" 'echo $(from_block_flags)')"
FA=$(mkl fromblock-alice); echo 5000000 > "$FA/eth-deploy-block.txt"; printf '{"eth_from_block": 42}\n' > "$FA/alice.swap.json"
check "from_block_flags: Alice's swap file counts too" "" "$(run_native "$FA" 'echo $(from_block_flags)' 2>/dev/null)"
# setup.sh with Alice's swap file present and no start file: no guess
SD=$(mkl setup-aliceswap); printf '{}\n' > "$SD/alice.swap.json"; printf '%s\n' "http://e1 finalized $(blk 0x1d4c0)" > "$SD/rpc.map"
SOUT=$(env -i HOME="$TMP/home" PATH="$PATH" L="$SD" LIVE_PLATFORM=native CURL="$RPCSTUB" RPC_MAP="$SD/rpc.map" RPC_LOG="$SD/rpc.log" RUN=7 ETH_RPC=http://e1 "$BASH" "$HERE/setup.sh" 2>&1); SRC=$?
check "setup.sh: Alice's swap file blocks the guess too" "0|none|none" "$SRC|$(sb)|$([ -e "$SD/rpc.log" ] && echo some || echo none)"
SD=$(mkl setup-swapexplicit2); printf '{}\n' > "$SD/alice.swap.json"
SOUT=$(env -i HOME="$TMP/home" PATH="$PATH" L="$SD" LIVE_PLATFORM=native CURL="$RPCSTUB" RPC_MAP="$SD/none" RPC_LOG="$SD/rpc.log" RUN=7 DEPLOY_BLOCK=777 "$BASH" "$HERE/setup.sh" 2>&1); SRC=$?
check "setup.sh: an explicit DEPLOY_BLOCK is honoured even with a swap file present (the operator's word)" "0|777" "$SRC|$(sb)"

# ---- (15) lock.sh asks a fresh read-only tick right before it sends (T21 design B): lock_precheck on fixture ticks, then lock.sh against STUBS
# (a stub swap-cli that prints a tick file and records its argv, a stub node that records its argv; nothing is read from a chain, nothing is sent)
if command -v python3 >/dev/null 2>&1 && python3 -c 'import json' >/dev/null 2>&1; then
  PC="$TMP/precheck"; mkdir -p "$PC"
  # The shared test vector of the lock approval (eth/test/live.test.js has the same terms and the same hash): chain 11155111, contract 0x11.., sha256, code hash 0x22..,
  # sender 0x33.., receiver 0x44.., 1000000000000000 wei, lock word 0x55.., T_reveal 1762007200, decided_at 1762000000.
  hexn() { local n=$1 d=$2 i; printf '0x'; for i in $(seq 1 "$n"); do printf '%s%s' "$d" "$d"; done; }
  V_CONTRACT=$(hexn 20 1); V_CODE=$(hexn 32 2); V_SENDER=$(hexn 20 3); V_RECV=$(hexn 20 4); V_WORD=$(hexn 32 5)
  V_ETH='"chain_id":11155111,"contract":"'$V_CONTRACT'","code_hash":"'$V_CODE'","lock_kind":"sha256","bob_sender":"'$V_SENDER'"'
  V_TERMS='"swap_terms":{"eth":{'$V_ETH'},"hashlock":"'$V_WORD'"}'
  V_PARAMS='"params":{"action":"lock_eth","hashlock":"'$V_WORD'","t_reveal":1762007200,"receiver":"'$V_RECV'","amount_wei":"1000000000000000"}'
  V_HASH=c49c5c1f57ed1e347403ffa1e4ea25167b0132aa7b6f705d5996acaf8cb09761
  V_GO="go 1762000000 $V_HASH 1762000010"
  # changed_go OUT: 1 when OUT is a "go" line for the same intent and tick time but another hash, else 0
  changed_go() { case "$1" in "go 1762000000 "*" 1762000010") if [ "$1" != "$V_GO" ]; then echo 1; else echo 0; fi ;; *) echo 0 ;; esac; }
  # mk_tick NOW_FRAGMENT TERMS_FRAGMENT PARAMS_FRAGMENT: a held lock_eth tick whose fresh decision is the lock, with the given pieces ("" = leave the piece out)
  mk_tick() {
    printf '%s' '{"action":{"action":"wait","reason":"r"},'"$1"'"notes":["held: fresh decision was lock_eth"],'"$2"'"intent":{"status":"held","intent":{"action":"lock_eth",'"$3"'"decided_at":1762000000}}}'
  }
  TICK_GO='{"action":{"action":"wait","reason":"intent lock_eth pending since 1 (unix): the chain does not show it yet; reuse the printed parameters"},"now":1762000010,"notes":["producer concentration ok","held: fresh decision was lock_eth","frozen parameters of the pending lock_eth: {}"],'"$V_TERMS"',"intent":{"status":"held","intent":{"action":"lock_eth",'"$V_PARAMS"',"decided_at":1762000000}}}'
  TICK_ALERT='{"action":{"action":"wait","reason":"intent lock_eth pending since 1 (unix) but the producer screen refuses to lock now (x): do NOT send it"},"notes":["ALARM: producer concentration too high, not locking (T21)","ALERT: the producer screen refuses to lock now (T21: producer concentration too high), but a lock_eth intent decided at 1 (Unix time) is still pending.","held: fresh decision was wait"],"intent":{"status":"held","intent":{"action":"lock_eth","decided_at":1762000000}}}'
  pc() { printf '%s' "$2" > "$PC/$1.json"; lock_pre_out=$(env -i HOME="$TMP/home" PATH="$PATH" HERE="$HERE" L="$PC" "$BASH" -c 'set -u; . "$HERE/env.sh" 2>/dev/null; lock_precheck "$1"' _ "$PC/$1.json" 2>&1); lock_pre_rc=$?; }
  pc go "$TICK_GO"
  check "lock_precheck: a held lock_eth intent whose fresh decision is still the lock goes, and names the decided_at of the intent it held" "0|$V_GO" "$lock_pre_rc|$lock_pre_out"
  # the terms are the tick's own report: a changed parameter changes the hash; a missing or inconsistent part refuses
  pc tchg "$(mk_tick '"now":1762000010,' "$V_TERMS," "$(printf '%s' "$V_PARAMS" | sed 's/1762007200/1762007201/'),")"
  check "lock_precheck: one changed parameter (T_reveal) gives another hash, and the same tick time" "0|1" "$lock_pre_rc|$(changed_go "$lock_pre_out")"
  pc pchg "$(mk_tick '"now":1762000010,' '"swap_terms":{"eth":{'"$(printf '%s' "$V_ETH" | sed 's/"sha256"/"poseidon"/')"'},"hashlock":"'$V_WORD'"},' "$V_PARAMS,")"
  check "lock_precheck: the lock kind is part of the terms (poseidon gives another hash)" "0|1" "$lock_pre_rc|$(changed_go "$lock_pre_out")"
  pc noterms "$(mk_tick '"now":1762000010,' "" "$V_PARAMS,")"
  check "lock_precheck: a tick with no swap_terms refuses (no terms to approve)" "1" "$lock_pre_rc"
  pc nonow "$(mk_tick "" "$V_TERMS," "$V_PARAMS,")"
  check "lock_precheck: a tick with no 'now' refuses (no time to hand over)" "1" "$lock_pre_rc"
  pc badword "$(mk_tick '"now":1762000010,' "$V_TERMS," "$(printf '%s' "$V_PARAMS" | sed "s/$V_WORD/$(hexn 32 6)/"),")"
  check "lock_precheck: an intent whose hashlock is not the swap's hashlock refuses" "1" "$lock_pre_rc"
  pc noparams "$(mk_tick '"now":1762000010,' "$V_TERMS," "")"
  check "lock_precheck: an intent with no parameters refuses" "1" "$lock_pre_rc"
  GOBASE='{"action":{"action":"wait","reason":"r"},"notes":["held: fresh decision was lock_eth"],"intent":{"status":"held","intent":{"action":"lock_eth"'
  pc noat "$GOBASE"'}}}'
  check "lock_precheck: a held intent with no decided_at refuses (no approval to hand to live.js)" "1" "$lock_pre_rc"
  pc strat "$GOBASE"',"decided_at":"1762000000"}}}'
  check "lock_precheck: a decided_at that is text refuses" "1" "$lock_pre_rc"
  pc negat "$GOBASE"',"decided_at":-5}}}'
  check "lock_precheck: a negative decided_at refuses" "1" "$lock_pre_rc"
  pc fltat "$GOBASE"',"decided_at":1762000000.5}}}'
  check "lock_precheck: a decided_at that is not a whole number refuses" "1" "$lock_pre_rc"
  pc boolat "$GOBASE"',"decided_at":true}}}'
  check "lock_precheck: a decided_at that is a boolean refuses" "1" "$lock_pre_rc"
  pc bigat "$GOBASE"',"decided_at":18446744073709551615}}}'
  check "lock_precheck: a decided_at a JavaScript number cannot hold exactly refuses" "1" "$lock_pre_rc"
  # Every refusal below is TICK_GO (which goes) with exactly ONE thing changed, so that deleting the rule a case names would let the case through (they are
  # not refused for a missing part instead); each also checks the reason it gives.
  chg() { printf '%s' "$TICK_GO" | sed "$1"; }
  pc alert "$(chg 's/"producer concentration ok"/"ALERT: the producer screen refuses to lock now (x)"/')"
  check "lock_precheck: an ALERT: note refuses" "1" "$lock_pre_rc"
  check_has "lock_precheck: ... and says what the tick said" "ALERT: the producer screen refuses" "$lock_pre_out"
  # no ALERT, but the fresh decision is not the lock (the engine holds it back for another reason)
  pc other "$(chg 's/held: fresh decision was lock_eth/held: fresh decision was wait/')"
  check "lock_precheck: a fresh decision that is not the lock refuses" "1" "$lock_pre_rc"
  check_has "lock_precheck: ... and says the lock is held back" "the fresh decision is no longer the lock" "$lock_pre_out"
  pc donotsend "$(chg 's/the chain does not show it yet; reuse the printed parameters/do NOT send it/')"
  check "lock_precheck: a wait that says do NOT send it refuses even beside the lock note" "1" "$lock_pre_rc"
  check_has "lock_precheck: ... and says not to send" "says not to send the pending lock" "$lock_pre_out"
  pc nonote "$(chg 's/"held: fresh decision was lock_eth",//')"
  check "lock_precheck: no 'held: fresh decision' note refuses" "1" "$lock_pre_rc"
  check_has "lock_precheck: ... and says there is no decision note" "no 'held: fresh decision' note" "$lock_pre_out"
  pc twonotes "$(chg 's/"held: fresh decision was lock_eth",/"held: fresh decision was lock_eth","held: fresh decision was wait",/')"
  check "lock_precheck: two decision notes refuse" "1" "$lock_pre_rc"
  check_has "lock_precheck: ... and says the decision is not the lock" "the fresh decision is no longer the lock" "$lock_pre_out"
  pc nointent "$(chg 's/"intent":{"status":"held".*$/"intent":{"status":"none","intent":null}}/')"
  check "lock_precheck: no pending intent refuses (a read-only tick never offers the lock itself)" "1" "$lock_pre_rc"
  check_has "lock_precheck: ... and says to run tick --apply" "run tick --apply first" "$lock_pre_out"
  pc recorded "$(chg 's/"status":"held"/"status":"recorded"/')"
  check "lock_precheck: an intent only just recorded (status recorded) refuses" "1" "$lock_pre_rc"
  check_has "lock_precheck: ... and says the tick did not keep it" "intent status: recorded" "$lock_pre_out"
  pc resolved "$(chg 's/"status":"held"/"status":"resolved"/')"
  check "lock_precheck: an intent the chain resolved (the lock is on chain) refuses" "1" "$lock_pre_rc"
  check_has "lock_precheck: ... and says so" "intent status: resolved" "$lock_pre_out"
  pc refund "$(chg 's/"intent":{"action":"lock_eth"/"intent":{"action":"refund_eth"/')"
  check "lock_precheck: another action's intent refuses" "1" "$lock_pre_rc"
  check_has "lock_precheck: ... and names the action" "the pending intent is not a lock_eth (it is: refund_eth)" "$lock_pre_out"
  pc garbage 'not json at all'
  check "lock_precheck: a tick output that is not JSON refuses" "1" "$lock_pre_rc"
  pc empty ''
  check "lock_precheck: an empty tick output refuses" "1" "$lock_pre_rc"
  pc array '[]'
  check "lock_precheck: JSON that is not an object refuses" "1" "$lock_pre_rc"
  pc badnotes "$(chg 's/"notes":\[[^]]*\]/"notes":[1,2]/')"
  check "lock_precheck: notes that are not text refuse" "1" "$lock_pre_rc"
  check_has "lock_precheck: ... and says the notes cannot be read" "no readable notes" "$lock_pre_out"
  lock_pre_out=$(env -i HOME="$TMP/home" PATH="$PATH" HERE="$HERE" L="$PC" "$BASH" -c 'set -u; . "$HERE/env.sh" 2>/dev/null; lock_precheck "$1"' _ "$PC/nonexistent.json" 2>&1); lock_pre_rc=$?
  check "lock_precheck: a missing file refuses" "1" "$lock_pre_rc"

  # lock.sh against stubs
  LB="$TMP/lockbin"; mkdir -p "$LB" "$TMP/ethdir/scripts"
  cp "$HERE/env.sh" "$HERE/lock.sh" "$LB/"
  cat > "$TMP/lockbinstub" <<'STUB'
#!/bin/sh
# a stub swap-cli: records its argv (one per line, appended) and prints the tick file STUB_TICK (or garbage), exits with STUB_TICK_EXIT
printf '%s\n' "$@" >> "$STUB_BIN_ARGV"
if [ -n "${STUB_TICK:-}" ] && [ -f "$STUB_TICK" ]; then cat "$STUB_TICK"; fi
exit "${STUB_TICK_EXIT:-0}"
STUB
  cat > "$TMP/locknodestub" <<'STUB'
#!/bin/sh
# a stub node: records its argv (one per line, appended) and prints an empty object
printf '%s\n' "$@" >> "$STUB_NODE_ARGV"
echo "{}"
STUB
  chmod +x "$TMP/lockbinstub" "$TMP/locknodestub"
  # lock_run NAME TICKFILE TICKEXIT [lock.sh args]: sets LOUT, LRC, LBIN (the swap-cli argv), LNODE (the node argv)
  lock_run() {
    local name=$1 tick=$2 tex=$3; shift 3
    local d; d=$(mkl "lock-$name"); mkdir -p "$d/bob" "$d/rec"; echo "selftest-passphrase" > "$d/passphrase.txt"
    : > "$d/bin.argv"; : > "$d/node.argv"
    if [ -n "${LOCK_SWAPFILE_CONTENT:-}" ]; then printf '%s' "$LOCK_SWAPFILE_CONTENT" > "$d/bob/bob.swap.json"; fi
    LOUT=$(env -i HOME="$TMP/home" PATH="$PATH" L="$d" LIVE_PLATFORM=native BIN="$TMP/lockbinstub" NODE="$TMP/locknodestub" ETH_DIR="$TMP/ethdir" \
      STUB_BIN_ARGV="$d/bin.argv" STUB_NODE_ARGV="$d/node.argv" STUB_TICK="$tick" STUB_TICK_EXIT="$tex" "$BASH" "$LB/lock.sh" ${1+"$@"} 2>/dev/null)
    LRC=$?
    LBIN=$(cat "$d/bin.argv"); LNODE=$(cat "$d/node.argv")
  }
  printf '%s' "$TICK_GO" > "$PC/stub-go.json"; printf '%s' "$TICK_ALERT" > "$PC/stub-alert.json"; printf 'garbage' > "$PC/stub-garbage.json"
  lock_run go "$PC/stub-go.json" 0
  check "lock.sh (send): the fresh tick shows the lock: live.js lock runs once, exit 0" "0|1" "$LRC|$(printf '%s\n' "$LNODE" | grep -cx lock)"
  check_has "lock.sh (send): ... and it says the engine still offers the lock" "fresh read-only tick: the engine still offers Bob's lock" "$LOUT"
  check_has "lock.sh (send): ... and the default limit of the tick is 3 x RPC_TIMEOUT (180 s) cut to 90 s, below the 120 s the approval is good for" "tick limit 90 s of the 120 s the approval is good for" "$LOUT"
  check "lock.sh: the approval window in the helper is the one live.js uses (MAX_OBSERVATION_AGE_S)" "120|120" "$(sed -n 's/^APPROVAL_WINDOW_S=\([0-9]*\).*/\1/p' "$HERE/lock.sh")|$(sed -n 's/^const MAX_OBSERVATION_AGE_S = \([0-9]*\);.*/\1/p' "$HERE/../../eth/scripts/live.js")"
  check "lock.sh (send): live.js lock is handed --approved-intent with the decided_at of the intent the TICK held" "1|1" "$(printf '%s\n' "$LNODE" | grep -cx -- --approved-intent)|$(printf '%s\n' "$LNODE" | grep -cx 1762000000)"
  check "lock.sh (send): ... and --approved-terms with the hash the tick's report gives, and --approved-at with the tick's own time" "1|1|1|1" "$(printf '%s\n' "$LNODE" | grep -cx -- --approved-terms)|$(printf '%s\n' "$LNODE" | grep -cx "$V_HASH")|$(printf '%s\n' "$LNODE" | grep -cx -- --approved-at)|$(printf '%s\n' "$LNODE" | grep -cx 1762000010)"
  # the swap file holds ANOTHER intent (another decided_at): the value handed on still comes from the tick's output, never from the file (live.js then refuses the mismatch)
  LOCK_SWAPFILE_CONTENT='{"pending_intent":{"action":"lock_eth","decided_at":1762999999}}'
  lock_run otherintent "$PC/stub-go.json" 0
  check "lock.sh (send): a tick that approved another intent than the one in the swap file: the value handed on is the tick's, not the file's" "1|0" "$(printf '%s\n' "$LNODE" | grep -cx 1762000000)|$(printf '%s\n' "$LNODE" | grep -c 1762999999)"
  LOCK_SWAPFILE_CONTENT=""
  printf '%s' '{"action":{"action":"wait","reason":"r"},"notes":["held: fresh decision was lock_eth"],"intent":{"status":"held","intent":{"action":"lock_eth","decided_at":"soon"}}}' > "$PC/stub-badat.json"
  lock_run badat "$PC/stub-badat.json" 0
  check "lock.sh (send): a tick that names no readable decided_at refuses: exit 3, live.js is never run" "3|0" "$LRC|$(printf '%s' "$LNODE" | grep -c .)"
  check_has "lock.sh (send): ... and the operator reads why" "lock REFUSED, nothing sent" "$LOUT"
  check "lock.sh (send): the tick it asked for is a plain read-only tick (no --apply), of Bob's file" "1|0|1" "$(printf '%s\n' "$LBIN" | grep -cx tick)|$(printf '%s\n' "$LBIN" | grep -cx -- --apply)|$(printf '%s\n' "$LBIN" | grep -c '/bob/bob.swap.json$')"
  lock_run alert "$PC/stub-alert.json" 0
  check "lock.sh (send): the fresh tick shows the screen refusing: exit 3, live.js is never run" "3|0" "$LRC|$(printf '%s' "$LNODE" | grep -c .)"
  check_has "lock.sh (send): ... and the operator reads why" "lock REFUSED, nothing sent" "$LOUT"
  check_has "lock.sh (send): ... with the tick's own words" "ALERT: the producer screen refuses" "$LOUT"
  lock_run failed "$PC/stub-go.json" 1
  check "lock.sh (send): a tick that fails (even one that printed a good tick) refuses: exit 3, live.js is never run" "3|0" "$LRC|$(printf '%s' "$LNODE" | grep -c .)"
  check_has "lock.sh (send): ... and says the tick failed" "the fresh read-only tick right before the send failed" "$LOUT"
  lock_run garbage "$PC/stub-garbage.json" 0
  check "lock.sh (send): a tick whose output cannot be read refuses: exit 3, live.js is never run" "3|0" "$LRC|$(printf '%s' "$LNODE" | grep -c .)"
  lock_run nothing "$PC/none.json" 0
  check "lock.sh (send): a tick that prints nothing refuses" "3|0" "$LRC|$(printf '%s' "$LNODE" | grep -c .)"
  lock_run dry "$PC/stub-alert.json" 0 --dry-run
  check "lock.sh --dry-run: no tick at all (the dry run stays offline-style and shows live.js's own checks), live.js runs with --dry-run" "0|0|1" "$LRC|$(printf '%s' "$LBIN" | grep -c .)|$(printf '%s\n' "$LNODE" | grep -cx -- --dry-run)"
  check "lock.sh --dry-run: live.js is not handed --approved-intent (a dry run needs none)" "0" "$(printf '%s\n' "$LNODE" | grep -cx -- --approved-intent)"
  lock_run flags "$PC/stub-go.json" 0
  check "lock.sh (send): the tick gets the same node flags as tick.sh" "1" "$(printf '%s\n' "$LBIN" | grep -cx -- --noid-rpc)"
  # the time limit of the fresh tick: a tick that does not finish is stopped, the lock is refused (exit 3), live.js is never run
  cat > "$TMP/lockbinslow" <<'STUB'
#!/bin/sh
printf '%s\n' "$@" >> "$STUB_BIN_ARGV"
sleep 30
exit 0
STUB
  chmod +x "$TMP/lockbinslow"
  TD=$(mkl lock-timeout); mkdir -p "$TD/bob" "$TD/rec"; echo "selftest-passphrase" > "$TD/passphrase.txt"; : > "$TD/bin.argv"; : > "$TD/node.argv"
  T0=$(date +%s)
  LOUT=$(env -i HOME="$TMP/home" PATH="$PATH" L="$TD" LIVE_PLATFORM=native BIN="$TMP/lockbinslow" NODE="$TMP/locknodestub" ETH_DIR="$TMP/ethdir" LOCK_PRECHECK_TIMEOUT=2     STUB_BIN_ARGV="$TD/bin.argv" STUB_NODE_ARGV="$TD/node.argv" "$BASH" "$LB/lock.sh" 2>/dev/null); LRC=$?
  T1=$(date +%s)
  check "lock.sh (send): a tick that does not finish within LOCK_PRECHECK_TIMEOUT is stopped: exit 3, live.js is never run, well before the tick's own end" "3|0|1" "$LRC|$(grep -c . "$TD/node.argv")|$([ $((T1 - T0)) -lt 20 ] && echo 1 || echo 0)"
  check_has "lock.sh (send): ... and says so, and not to call live.js directly" "did not finish within 2 s" "$LOUT"
  check_has "lock.sh (send): ... naming the direct call" "do not call live.js lock directly" "$LOUT"
  check_has "lock.sh (send): ... and saying how long the approval of a tick is good for (a slower tick is of no use)" "good for only 120 s" "$LOUT"
  # a limit above the window is refused before anything runs; one at the cut is taken; a default below the cut stays as it is
  TD=$(mkl lock-timeout-high); mkdir -p "$TD/bob"; echo "selftest-passphrase" > "$TD/passphrase.txt"; : > "$TD/node.argv"; : > "$TD/bin.argv"
  HOUT=$(env -i HOME="$TMP/home" PATH="$PATH" L="$TD" LIVE_PLATFORM=native BIN="$TMP/lockbinstub" NODE="$TMP/locknodestub" ETH_DIR="$TMP/ethdir" LOCK_PRECHECK_TIMEOUT=91 STUB_BIN_ARGV="$TD/bin.argv" STUB_NODE_ARGV="$TD/node.argv" STUB_TICK="$PC/stub-go.json" "$BASH" "$LB/lock.sh" 2>&1); HRC=$?
  check "lock.sh (send): a LOCK_PRECHECK_TIMEOUT above 90 refuses with exit 2, and neither swap-cli nor live.js is run" "2|0|0" "$HRC|$(grep -c . "$TD/node.argv")|$(grep -c . "$TD/bin.argv")"
  check_has "lock.sh (send): ... and says why (the approval is good for 120 s only)" "the approval of the tick is good for 120 s only" "$HOUT"
  TD=$(mkl lock-timeout-cut); mkdir -p "$TD/bob" "$TD/rec"; echo "selftest-passphrase" > "$TD/passphrase.txt"; : > "$TD/node.argv"; : > "$TD/bin.argv"
  HOUT=$(env -i HOME="$TMP/home" PATH="$PATH" L="$TD" LIVE_PLATFORM=native BIN="$TMP/lockbinstub" NODE="$TMP/locknodestub" ETH_DIR="$TMP/ethdir" LOCK_PRECHECK_TIMEOUT=90 STUB_BIN_ARGV="$TD/bin.argv" STUB_NODE_ARGV="$TD/node.argv" STUB_TICK="$PC/stub-go.json" "$BASH" "$LB/lock.sh" 2>/dev/null); HRC=$?
  check "lock.sh (send): a LOCK_PRECHECK_TIMEOUT of exactly 90 is taken" "0|1" "$HRC|$(grep -cx lock "$TD/node.argv")"
  check_has "lock.sh (send): ... and is the limit shown" "tick limit 90 s" "$HOUT"
  TD=$(mkl lock-timeout-low); mkdir -p "$TD/bob" "$TD/rec"; echo "selftest-passphrase" > "$TD/passphrase.txt"; : > "$TD/node.argv"; : > "$TD/bin.argv"
  HOUT=$(env -i HOME="$TMP/home" PATH="$PATH" L="$TD" LIVE_PLATFORM=native BIN="$TMP/lockbinstub" NODE="$TMP/locknodestub" ETH_DIR="$TMP/ethdir" RPC_TIMEOUT=10 STUB_BIN_ARGV="$TD/bin.argv" STUB_NODE_ARGV="$TD/node.argv" STUB_TICK="$PC/stub-go.json" "$BASH" "$LB/lock.sh" 2>/dev/null); HRC=$?
  check_has "lock.sh (send): a short RPC_TIMEOUT keeps its own default (3 x 10 s = 30 s), below the cut" "tick limit 30 s" "$HOUT"
  TD=$(mkl lock-timeout-bad); mkdir -p "$TD/bob"; echo "selftest-passphrase" > "$TD/passphrase.txt"
  env -i HOME="$TMP/home" PATH="$PATH" L="$TD" LIVE_PLATFORM=native BIN="$TMP/lockbinstub" NODE="$TMP/locknodestub" ETH_DIR="$TMP/ethdir" LOCK_PRECHECK_TIMEOUT=abc STUB_BIN_ARGV="$TD/bin.argv" STUB_NODE_ARGV="$TD/node.argv" "$BASH" "$LB/lock.sh" >/dev/null 2>&1
  check "lock.sh (send): a LOCK_PRECHECK_TIMEOUT that is not a whole number refuses with exit 2" "2" "$?"
  # the passphrase is for the tick only: the node that sends the lock does not inherit it
  cat > "$TMP/locknodeenv" <<'STUB'
#!/bin/sh
if [ -n "${SWAP_PASSPHRASE:-}" ]; then echo "passphrase-inherited" >> "$STUB_NODE_ARGV"; else echo "passphrase-not-inherited" >> "$STUB_NODE_ARGV"; fi
echo "{}"
STUB
  chmod +x "$TMP/locknodeenv"
  PD=$(mkl lock-pass); mkdir -p "$PD/bob"; echo "selftest-passphrase" > "$PD/passphrase.txt"; : > "$PD/node.argv"
  env -i HOME="$TMP/home" PATH="$PATH" L="$PD" LIVE_PLATFORM=native BIN="$TMP/lockbinstub" NODE="$TMP/locknodeenv" ETH_DIR="$TMP/ethdir" STUB_BIN_ARGV="$PD/bin.argv" STUB_NODE_ARGV="$PD/node.argv" STUB_TICK="$PC/stub-go.json" "$BASH" "$LB/lock.sh" >/dev/null 2>&1
  check "lock.sh (send): the node that sends the lock does not inherit SWAP_PASSPHRASE" "passphrase-not-inherited" "$(cat "$PD/node.argv")"
else
  echo "skip lock_precheck and lock.sh against stubs (no python3 on this machine)"
fi

# ---- (16) require_bob_terms (env.sh): what new-bob needs from Bob's own settings, and nothing of Alice's; require_parties is unchanged
RB="$TMP/rbt"; mkdir -p "$RB"
{ echo 'CONTRACT=0x0000000000000000000000000000000000000001'; echo 'BOB_ETH=0x00000000000000000000000000000000000000b1'; } > "$RB/env.local.sh"   # BOB_NOID comes from the environment
check "require_bob_terms: Bob's terms only, no ALICE_NOID and no ALICE_ETH: ok" "rc=0" "$(run_native "$RB" 'require_bob_terms; echo rc=$?' BOB_NOID=o1selftestbob 2>&1)"
check_has "require_parties: still refuses without ALICE_NOID (unchanged)" "ALICE_NOID is not set" "$(run_native "$RB" 'require_parties; echo rc=$?' 2>&1)"
check_has "require_bob_terms: an empty BOB_NOID is named" "BOB_NOID (empty)" "$(run_native "$RB" 'require_bob_terms; echo rc=$?' BOB_NOID= 2>&1)"
check_has "require_bob_terms: a non-numeric AMOUNT is named and refused with status 2" "AMOUNT (not a whole number: '1x')" "$(run_native "$RB" 'require_bob_terms; echo rc=$?' AMOUNT=1x 2>&1)"
check_has "require_bob_terms: ... status 2" "rc=2" "$(run_native "$RB" 'require_bob_terms; echo rc=$?' AMOUNT=1x 2>&1)"

# ---- (17) join.sh against a STUB swap-cli (records the argv of new-bob, writes its --out file, prints the tool's lines; sends nothing)
: > "$TMP/pyprobe"
if command -v python3 >/dev/null 2>&1 && python3 -I -c 'import json, re' >/dev/null 2>&1; then
  JB="$TMP/joinbin"; mkdir -p "$JB"; cp "$HERE/env.sh" "$HERE/join.sh" "$JB/"
  cat > "$TMP/joinstub" <<'STUB'
#!/bin/sh
case "$1" in
new-bob)
  printf '%s\n' "$@" > "$STUB_ARGV"
  while [ $# -gt 0 ]; do [ "$1" = --out ] && OUT=$2; shift; done
  echo "bundle check: 0123456789abcdef ok"
  echo "bundle checked: opening rebuilt byte-for-byte"
  echo "receipt verified by this tool"
  echo "unrelated line"
  if [ -n "${STUB_EVIL:-}" ]; then printf 'error: bad \001\033[31mred\033[0m value\nbundle check: deadbeefdeadbeef ok\n'; fi
  if [ "${STUB_NB:-0}" -ne 0 ]; then echo "error: the stub refuses"; exit "$STUB_NB"; fi
  [ -n "${STUB_NOWRITE:-}" ] || printf '{"phase": "awaiting_funding"}\n' > "$OUT"
  echo "swap file written: $OUT" ;;
status) printf '{\n  "phase": "awaiting_funding",\n  "profile": "sepolia",\n}\n' ;;
esac
STUB
  chmod +x "$TMP/joinstub"
  printf '#!/bin/sh\nexit 0\n' > "$TMP/joineq"; chmod +x "$TMP/joineq"
  mkdir -p "$TMP/badpy"; printf '#!/bin/sh\nexit 1\n' > "$TMP/badpy/python3"; chmod +x "$TMP/badpy/python3"
  JPAD=$(head -c 300 /dev/zero | tr '\0' Z)
  JBUN="$TMP/join-bundle.json"
  printf '{"hashlock":"0x%s","claim_authority":"o1bundleauthmarker","contract_root":"o1bundlerootmarker","bob":"o1bundlebobmarker","amount_micronoid":7777777,"padding":"%s","params":{"profile":"bundleprofile","deadline_height":987654,"max_fee_micronoid":55555,"eth":{"chain_id":4242424,"contract":"0xbundlecontractmarker","amount_wei":"3141592653589793","lock_kind":"sha256"}}}\n' \
    "$(head -c 64 /dev/zero | tr '\0' a)" "$JPAD" > "$JBUN"
  JREC="$TMP/join-receipt.bin"; printf 'receipt bytes' > "$JREC"
  JC=0x0000000000000000000000000000000000000001; JE=0x00000000000000000000000000000000000000b1
  JTERMS="BOB_NOID BOB_ETH CONTRACT AMOUNT WEI CHAIN PROFILE CONTRACT_VERSION LOCK_KIND VARIANT"
  jdefault() {
    case "$1" in BOB_NOID) echo o1selftestbob ;; BOB_ETH) echo "$JE" ;; CONTRACT) echo "$JC" ;; AMOUNT) echo 10000000 ;; WEI) echo 1000000000000000 ;;
      CHAIN) echo 11155111 ;; PROFILE) echo sepolia ;; CONTRACT_VERSION) echo 1 ;; LOCK_KIND) echo sha256 ;; VARIANT) echo raw ;; esac
  }
  # join_run NAME [ARG ...] -- [join.sh args]. Bob's ten terms are written into $L/env.local.sh (his own words); an ARG NAME=value for one of them
  # replaces it there, -NAME leaves it out, #NAME writes it as a comment; any other ARG NAME=value goes into the environment. One-shot switches
  # set before the call: JPRE (a snippet run first; JD is the run folder), JPASS=0 (no passphrase file), JCWD (a sub-folder of JD to run from; "/"
  # is JD itself), JEXPORT=1 (every term as `export NAME=value`). Sets JOUT (stdout and stderr), JRC, JD, JARGV (the stub's argv, one `|` after each
  # argument, empty when new-bob was not called).
  JPRE=''; JPASS=1; JCWD=''; JEXPORT=0
  join_run() {
    local name=$1; shift
    JD="$TMP/join-$name"; mkdir -p "$JD"
    local vars=() ov=() a n t line cw
    while [ $# -gt 0 ] && [ "$1" != "--" ]; do
      a=$1; n=${a%%=*}
      case " $JTERMS " in *" ${a#[-#]} "*|*" $n "*) ov+=("$a") ;; *) vars+=("$a") ;; esac
      shift
    done
    [ $# -gt 0 ] && shift
    : > "$JD/env.local.sh"
    for t in $JTERMS; do
      line="$t=$(jdefault "$t")"
      for a in ${ov[@]+"${ov[@]}"}; do
        case "$a" in "$t="*) line=$a ;; "-$t") line="" ;; "#$t") line="# $t=$(jdefault "$t")" ;; esac
      done
      [ -n "$line" ] || continue
      if [ "$JEXPORT" = 1 ]; then case "$line" in '#'*) ;; *) line="export $line" ;; esac; fi
      printf '%s\n' "$line" >> "$JD/env.local.sh"
    done
    [ "$JPASS" = 1 ] && echo "selftest-passphrase" > "$JD/passphrase.txt"
    eval "$JPRE"
    cw="$JD${JCWD:-}"; mkdir -p "$cw"
    JOUT=$(cd "$cw" && env -i HOME="$TMP/home" PATH="$PATH" L="$JD" LIVE_PLATFORM=native BIN="$TMP/joinstub" EQ="$TMP/joineq" STUB_ARGV="$JD/argv" \
      ${vars[@]+"${vars[@]}"} "$BASH" "$JB/join.sh" ${1+"$@"} 2>&1)
    JRC=$?
    JARGV=$(tr '\n' '|' 2>/dev/null < "$JD/argv")
    JPRE=''; JPASS=1; JCWD=''; JEXPORT=0
  }
  jbase() { printf 'new-bob|--bundle|%s/alice.bundle.json|--out|%s/bob/bob.swap.json|--bob|o1selftestbob|--amount|10000000|--eth-chain-id|11155111|--eth-contract|%s|--eth-amount-wei|1000000000000000|--eth-sender|%s|--profile|sepolia|--contract-version|1|--variant|raw|' "$1" "$1" "$JC" "$JE"; }
  jhas() { printf '%s\n' "$JOUT" | grep -cF -- "$1" || true; }
  jnone() { if [ -e "$JD/bob" ] || [ -e "$JD/alice.bundle.json" ] || [ -e "$JD/alice.receipt" ] || [ -e "$JD/join-new-bob.out" ]; then echo some; else echo none; fi; }
  jtemp() { ls -A "$JD" | grep -c '^\.join-' || true; }
  # the happy path (sha256): both files given from elsewhere, Bob's terms in env.local.sh, no Alice-only setting on this "machine"
  join_run happy -- "$JBUN" "$JREC"
  check "join.sh sha256: exit 0" "0" "$JRC"
  check "join.sh sha256: new-bob gets exactly Bob's terms (variant included), the bundle copy and the receipt arguments" "$(jbase "$JD")--receipt|$JD/alice.receipt|--equiv-prove|$TMP/joineq|" "$JARGV"
  check "join.sh: the tool's bundle check line is printed whole, on a line of its own" "1" "$(printf '%s\n' "$JOUT" | grep -cx 'bundle check: 0123456789abcdef ok')"
  check_has "join.sh: ... with the compare hint" "compare these digits with the bundle check line" "$JOUT"
  check_has "join.sh: the tool's receipt line is shown" "receipt verified by this tool" "$JOUT"
  check_has "join.sh: new-bob's exit status is printed" "new-bob exit 0" "$JOUT"
  check_has "join.sh: the status of Bob's file is printed" '"phase": "awaiting_funding"' "$JOUT"
  check_has "join.sh: says what comes next" "nothing is locked yet; start the watch loop for bob; the lock is offered by the tool only after Alice's funding is final" "$JOUT"
  check "join.sh: a line the tool printed that is not about the receipt, the check or a refusal is left out" "0" "$(jhas 'unrelated line')"
  check_has "join.sh: the bundle's fields are printed" "contract_root: o1bundlerootmarker" "$JOUT"
  check "join.sh: the whole bundle is never printed (300 padding characters)" "0" "$(jhas ZZZZZZZZZZ)"
  check "join.sh: the given files were copied, not moved" "yes" "$(cmp -s "$JBUN" "$JD/alice.bundle.json" && cmp -s "$JREC" "$JD/alice.receipt" && [ -f "$JBUN" ] && [ -f "$JREC" ] && echo yes || echo no)"
  check "join.sh: no temporary file is left after a success" "0" "$(jtemp)"
  check_has "join.sh: Bob's terms are printed under their heading" "Your terms, as this machine will state them (check them against what you agreed):" "$JOUT"
  check_has "join.sh: ... his Parano1d address" "your Parano1d address:  o1selftestbob" "$JOUT"
  check_has "join.sh: ... his Ethereum address" "your Ethereum address:  $JE" "$JOUT"
  check_has "join.sh: ... the contract" "the contract:           $JC" "$JOUT"
  check_has "join.sh: ... the NOID amount" "the NOID amount:        10000000 micro-NOID" "$JOUT"
  check_has "join.sh: ... the ETH amount" "the ETH amount:         1000000000000000 wei" "$JOUT"
  check_has "join.sh: ... the chain, the profile, the version, the lock kind and the variant" "the variant:            raw" "$JOUT"
  JBT=0; for t in o1bundleauthmarker o1bundlerootmarker o1bundlebobmarker 7777777 bundleprofile 987654 55555 4242424 0xbundlecontractmarker 3141592653589793 0xaaaaaaaa; do
    case "$JARGV" in *"$t"*) JBT=$((JBT + 1)) ;; esac
  done
  check "join.sh: no term of the bundle is on new-bob's command line" "0" "$JBT"
  # the variant is Bob's own term
  join_run stock VARIANT=stock -- "$JBUN" "$JREC"
  check "join.sh: Bob's VARIANT is passed to new-bob" "1" "$(printf '%s\n' "$JARGV" | grep -c -- '--variant|stock|')"
  join_run badvar VARIANT=foo -- "$JBUN" "$JREC"
  check "join.sh: a VARIANT that is neither raw nor stock: exit 2, new-bob not called" "2|" "$JRC|$JARGV"
  # every term must be in Bob's own env.local.sh: env.sh's defaults are not his agreement
  for t in $JTERMS; do
    join_run "miss-$t" "-$t" -- "$JBUN" "$JREC"
    check "join.sh: $t not assigned in env.local.sh: exit 2, named, new-bob not called, nothing written" "2|1||none" "$JRC|$(jhas "$t")|$JARGV|$(jnone)"
  done
  check_has "join.sh: ... and says why" "The defaults of env.sh are not your agreement" "$JOUT"
  join_run comment "#AMOUNT" -- "$JBUN" "$JREC"
  check "join.sh: a term that is only in a comment line does not count: exit 2, named" "2|1" "$JRC|$(jhas 'AMOUNT')"
  JEXPORT=1 join_run export LOCK_KIND=poseidon -- "$JBUN"
  check "join.sh: terms written as 'export NAME=value' count" "0" "$JRC"
  # poseidon: no receipt, the bundle at its default place, no arguments
  JPRE='cp "$JBUN" "$JD/alice.bundle.json"'
  join_run pos LOCK_KIND=poseidon --
  check "join.sh poseidon, no arguments: exit 0" "0" "$JRC"
  check "join.sh poseidon: new-bob gets --eth-lock-kind poseidon and no receipt" "$(jbase "$JD")--eth-lock-kind|poseidon|" "$JARGV"
  # the destination already holds the same content: left alone, passes
  JPRE='cp "$JBUN" "$JD/alice.bundle.json"'
  join_run same LOCK_KIND=poseidon -- "$JBUN"
  check "join.sh: a destination with the same content passes" "0" "$JRC"
  # sha256 with the receipt already at its default place
  JPRE='cp "$JREC" "$JD/alice.receipt"'
  join_run recdef -- "$JBUN"
  check "join.sh sha256: the receipt at its default place is used" "$(jbase "$JD")--receipt|$JD/alice.receipt|--equiv-prove|$TMP/joineq|" "$JARGV"
  # refusals: nothing written, new-bob never called
  JPRE='mkdir -p "$JD/bob"; echo mine > "$JD/bob/bob.swap.json"'
  join_run bobfile LOCK_KIND=poseidon -- "$JBUN"
  check "join.sh: Bob's swap file exists: exit 3 (prepare.sh's status), new-bob not called, the file untouched" "3||mine" "$JRC|$JARGV|$(cat "$JD/bob/bob.swap.json")"
  check_has "join.sh: ... with prepare.sh's wording" "bob.swap.json exists; refusing" "$JOUT"
  join_run nobundle LOCK_KIND=poseidon --
  check "join.sh: no bundle at the default place: exit 6, nothing written, new-bob not called" "6|none||0" "$JRC|$(jnone)|$JARGV|$(jtemp)"
  JPRE='ln -s "$JBUN" "$JD/link.json" 2>/dev/null'
  join_run symlink LOCK_KIND=poseidon -- "$TMP/join-symlink/link.json"
  if [ -L "$JD/link.json" ]; then
    check "join.sh: a bundle that is a symbolic link: exit 6, nothing written" "6|none|0" "$JRC|$(jnone)|$(jtemp)"
    check_has "join.sh: ... and says so" "symbolic link" "$JOUT"
  else
    echo "skip join.sh symbolic-link bundle (this platform makes no symbolic links with ln -s)"
  fi
  JPRE='head -c 1048577 /dev/zero > "$JD/big.json"'
  join_run big LOCK_KIND=poseidon -- "$TMP/join-big/big.json"
  check "join.sh: a bundle above 1 MB: exit 6, nothing written, no temporary file left" "6|none|0" "$JRC|$(jnone)|$(jtemp)"
  check_has "join.sh: ... and names the limit" "above the limit of 1048576" "$JOUT"
  JPRE='echo hello > "$JD/text.json"'
  join_run notjson LOCK_KIND=poseidon -- "$TMP/join-notjson/text.json"
  check "join.sh: a bundle that is not JSON: exit 6, no temporary file left" "6||0" "$JRC|$JARGV|$(jtemp)"
  JPRE='echo "{\"hashlock\":\"x\"}" > "$JD/thin.json"'
  join_run thin LOCK_KIND=poseidon -- "$TMP/join-thin/thin.json"
  check "join.sh: a bundle without the fields it prints: exit 6, no temporary file left" "6||0" "$JRC|$JARGV|$(jtemp)"
  JPRE='cp "$JBUN" "$JD/alice.bundle.json"; echo different >> "$JD/alice.bundle.json"'
  join_run differs LOCK_KIND=poseidon -- "$JBUN"
  check "join.sh: a destination with other content: exit 4, new-bob not called, the destination untouched, no temporary file" "4||1|0" "$JRC|$JARGV|$(grep -c '^different$' "$JD/alice.bundle.json")|$(jtemp)"
  join_run norec -- "$JBUN"
  check "join.sh sha256 without a receipt: exit 7, nothing written (not even the bundle copy), no temporary file, new-bob not called" "7|none||0" "$JRC|$(jnone)|$JARGV|$(jtemp)"
  join_run badkind LOCK_KIND=foo -- "$JBUN"
  check "join.sh: LOCK_KIND neither sha256 nor poseidon: exit 2, new-bob not called" "2|" "$JRC|$JARGV"
  join_run posrec LOCK_KIND=poseidon -- "$JBUN" "$JREC"
  check "join.sh poseidon with a receipt argument: exit 2, nothing copied" "2|none" "$JRC|$(jnone)"
  join_run three LOCK_KIND=poseidon -- "$JBUN" "$JREC" extra
  check "join.sh with three arguments: exit 2" "2" "$JRC"
  join_run emptyval LOCK_KIND=poseidon BOB_NOID= -- "$JBUN"
  check "join.sh: a BOB_NOID assigned empty: exit 2, named, nothing written" "2|none|1" "$JRC|$(jnone)|$(jhas 'BOB_NOID (empty)')"
  JPASS=0 join_run nopass LOCK_KIND=poseidon -- "$JBUN"
  check "join.sh: no passphrase file: exit 2, new-bob not called" "2|" "$JRC|$JARGV"
  # an empty argument is refused, never read as "no argument"
  join_run empty1 LOCK_KIND=poseidon -- ""
  check "join.sh: an empty first argument: exit 2, nothing written" "2|none" "$JRC|$(jnone)"
  join_run empty2 -- "$JBUN" ""
  check "join.sh: an empty second argument: exit 2, nothing written" "2|none" "$JRC|$(jnone)"
  # the proof tool must be executable for sha256 (and is not needed for poseidon)
  join_run noeq EQ="$TMP/no-such-proof-tool" -- "$JBUN" "$JREC"
  check "join.sh sha256: a proof tool that is not executable: exit 2, nothing written, new-bob not called" "2|none|" "$JRC|$(jnone)|$JARGV"
  join_run noeqpos EQ="$TMP/no-such-proof-tool" LOCK_KIND=poseidon -- "$JBUN"
  check "join.sh poseidon: the proof tool is not needed" "0" "$JRC"
  # python3 must work (the Windows Store alias passes `command -v` and fails): exit 2, not "no usable bundle"
  join_run nopy "PATH=$TMP/badpy:$PATH" LOCK_KIND=poseidon -- "$JBUN"
  check "join.sh: a python3 that does not run: exit 2, nothing written" "2|none|0" "$JRC|$(jnone)|$(jhas 'no usable bundle')"
  check_has "join.sh: ... and says python3 is not usable" "python3 is not usable" "$JOUT"
  # python runs isolated: a json.py and a re.py in the folder Bob runs the script from are not loaded
  JPRE='mkdir -p "$JD/cwd"; for m in json re; do printf "open(\"pwned-marker\", \"w\").close()\n" > "$JD/cwd/$m.py"; done'
  JCWD=/cwd join_run planted LOCK_KIND=poseidon -- "$JBUN"
  check "join.sh: a json.py and a re.py in the current folder are not loaded (no marker file), exit 0" "0|absent" "$JRC|$([ -e "$JD/cwd/pwned-marker" ] && echo present || echo absent)"
  # paths that start with a dash
  JPRE='cp "$JBUN" "$JD/-b.json"; cp "$JREC" "$JD/-r.bin"'
  JCWD=/ join_run dash -- -b.json -r.bin
  check "join.sh: a bundle and a receipt whose names start with '-': exit 0, both copied" "0|yes" "$JRC|$(cmp -s "$JBUN" "$JD/alice.bundle.json" && cmp -s "$JREC" "$JD/alice.receipt" && echo yes || echo no)"
  # control characters and an injected check line in the tool's output
  join_run evilfail LOCK_KIND=poseidon STUB_NB=3 STUB_EVIL=1 -- "$JBUN"
  check "join.sh: new-bob exits non-zero: exit 8, status printed, no what-comes-next line, no swap file" "8|1|0|none" "$JRC|$(jhas 'new-bob exit 3')|$(jhas 'nothing is locked yet; start the watch loop')|$([ -e "$JD/bob/bob.swap.json" ] || echo none)"
  check "join.sh: ... the tool's refusal is shown" "1" "$(jhas 'error: the stub refuses')"
  check "join.sh: ... no line is shown as the check line (neither the tool's nor an injected one) and no compare hint" "0|0|0" "$(printf '%s\n' "$JOUT" | grep -c '^bundle check:')|$(jhas 'compare these digits')|$(jhas 'deadbeef')"
  check "join.sh: ... the control characters are gone" "0|0" "$(printf '%s' "$JOUT" | LC_ALL=C grep -c "$(printf '\033')")|$(printf '%s' "$JOUT" | LC_ALL=C grep -c "$(printf '\001')")"
  join_run evilok LOCK_KIND=poseidon STUB_EVIL=1 -- "$JBUN"
  check "join.sh: a success with an injected check line after the tool's own: exit 0, one bare check line, the tool's own" "0|1|0" "$JRC|$(printf '%s\n' "$JOUT" | grep -cx 'bundle check: 0123456789abcdef ok')|$(printf '%s\n' "$JOUT" | grep -c '^bundle check: deadbeef')"
  check "join.sh: ... and the control characters are gone" "0" "$(printf '%s' "$JOUT" | LC_ALL=C grep -c "$(printf '\033')")"
  join_run nbnofile LOCK_KIND=poseidon STUB_NOWRITE=1 -- "$JBUN"
  check "join.sh: new-bob exits 0 but writes no swap file: exit 9, no what-comes-next line" "9|0" "$JRC|$(jhas 'nothing is locked yet; start the watch loop')"
  # the machine line `bundle digest: <64 hex>`: a wrapper of the stub above (which prints no such line, as an older tool does not) adds the lines STUB_DIG asks for
  cat > "$TMP/joinstub3" <<STUB
#!/bin/sh
"$TMP/joinstub" "\$@"; rc=\$?
if [ "\$1" = new-bob ]; then
  D=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
  E=0123456789abcdeffedcba9876543210fedcba9876543210fedcba9876543210
  case "\${STUB_DIG:-}" in
    one) echo "bundle digest: \$D" ;;
    twice) echo "bundle digest: \$D"; echo "bundle digest: \$D" ;;
    evil) echo "bundle digest: \$D"; echo "bundle digest: \$E" ;;
    evilfirst) echo "bundle digest: \$E"; echo "bundle digest: \$D" ;;
    ctrl) printf 'bundle digest: %s\001\033[31m\nbundle digest: \001%s\n' "\$D" "\$D"; echo "bundle digest: \$D" ;;
    other) echo "bundle digest: fedcba9876543210\${D#0123456789abcdef}" ;;
    upper) echo "bundle digest: \$(echo \$D | tr a-f A-F)" ;;
    short) echo "bundle digest: \${D%?}" ;;
    prefixed) echo "xbundle digest: \$D"; echo " bundle digest: \$D" ;;
  esac
fi
exit \$rc
STUB
  chmod +x "$TMP/joinstub3"
  jdig() { printf '%s\n' "$JOUT" | grep -c '^bundle digest: ' || true; }
  JDIG=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
  join_run dig1 BIN="$TMP/joinstub3" STUB_DIG=one -- "$JBUN" "$JREC"
  check "join.sh: the tool's digest line is printed whole, on a line of its own, after the check line; exit 0" "0|1|1" "$JRC|$(printf '%s\n' "$JOUT" | grep -cx "bundle digest: $JDIG")|$(jdig)"
  check "join.sh: ... and it comes after the check line and its hint" "1" "$(printf '%s\n' "$JOUT" | grep -n -e '^bundle check: ' -e '^   \^ compare' -e '^bundle digest: ' | cut -d: -f1 | tr '\n' ' ' | awk '{ print ($1 < $2 && $2 < $3) ? 1 : 0 }')"
  join_run digpos LOCK_KIND=poseidon BIN="$TMP/joinstub3" STUB_DIG=one -- "$JBUN"
  check "join.sh poseidon: the digest line is printed once as well" "0|1" "$JRC|$(jdig)"
  join_run digtwice BIN="$TMP/joinstub3" STUB_DIG=twice -- "$JBUN" "$JREC"
  check "join.sh: the same digest line twice is printed once, exit 0" "0|1" "$JRC|$(jdig)"
  join_run dignone -- "$JBUN" "$JREC"
  check "join.sh: a tool that prints no digest line (an older one): none is printed, exit 0, the check line as before" "0|0|1" "$JRC|$(jdig)|$(printf '%s\n' "$JOUT" | grep -cx 'bundle check: 0123456789abcdef ok')"
  join_run digfail BIN="$TMP/joinstub3" STUB_DIG=one STUB_NB=3 -- "$JBUN" "$JREC"
  check "join.sh: new-bob exits non-zero: exit 8, no digest line is passed on (neither the tool's nor an injected one)" "8|0|0" "$JRC|$(jdig)|$(jhas "$JDIG")"
  for mode in evil evilfirst; do
    join_run "dig$mode" BIN="$TMP/joinstub3" STUB_DIG=$mode -- "$JBUN" "$JREC"
    check "join.sh: two different digest lines ($mode): exit 9, none is passed on, and it says why" "9|0|1" "$JRC|$(jdig)|$(jhas 'more than one different')"
  done
  join_run digother BIN="$TMP/joinstub3" STUB_DIG=other -- "$JBUN" "$JREC"
  check "join.sh: a digest line that does not start with the check line's 16 digits: exit 9, not passed on, and it says why" "9|0|1" "$JRC|$(jdig)|$(jhas 'does not start with the digits of its check line')"
  join_run digctrl BIN="$TMP/joinstub3" STUB_DIG=ctrl -- "$JBUN" "$JREC"
  check "join.sh: digest lines with control characters are not the tool's form: only the clean one is printed, exit 0" "0|1|0|0" "$JRC|$(jdig)|$(printf '%s' "$JOUT" | LC_ALL=C grep -c "$(printf '\033')")|$(printf '%s' "$JOUT" | LC_ALL=C grep -c "$(printf '\001')")"
  for mode in upper short prefixed; do
    join_run "dig$mode" BIN="$TMP/joinstub3" STUB_DIG=$mode -- "$JBUN" "$JREC"
    check "join.sh: a digest line in another form ($mode) is not passed on and does not stop the run" "0|0" "$JRC|$(jdig)"
  done
else
  echo "skip join.sh against a stub swap-cli (no python3 on this machine that runs with -I)"
fi

# ---- (18) the tool's own wallets (swap wallet, piece 2c): wallet-setup.sh, wallet-status.sh, wallet-fund.sh, wallet-recover.sh, wallet-sweep.sh and the wallet path of
# prepare.sh, join.sh, lock.sh, reveal.sh, refund-eth.sh, against STUB swap-cli, node and tick.sh only: no real node, no wallet, no key, nothing is sent.
# The stubs record every argv (one line per call, with whether the passphrase was in the environment) and what the node read from stdin (never the key itself).
echo
echo "---- (18) the tool's own wallets: helpers against stubs"
if command -v python3 >/dev/null 2>&1 && python3 -I -c 'import json, re' >/dev/null 2>&1; then
  WB="$TMP/walletbin"; mkdir -p "$WB" "$TMP/wethdir/scripts"; : > "$TMP/wethdir/scripts/live.js"
  for f in env.sh wallet-setup.sh wallet-status.sh wallet-fund.sh wallet-recover.sh wallet-sweep.sh prepare.sh join.sh lock.sh reveal.sh refund-eth.sh fund.sh recover-noid.sh check-object.sh; do cp "$HERE/$f" "$WB/"; done
  cat > "$WB/tick.sh" <<'STUB'
#!/bin/sh
# a stub tick.sh: records its argv; STUB_TICK_RC is its exit status; a good one prints the line the real one prints at its end
echo "tick.sh $*" >> "$STUB_DIR/tick.log"
if [ "${STUB_TICK_RC:-0}" -ne 0 ]; then echo "error: the stub tick refuses: the transaction is only in the mempool, not confirmed"; exit "$STUB_TICK_RC"; fi
echo "applied: True phase_after: refunded"
STUB
  cat > "$TMP/wbstub" <<'STUB'
#!/bin/sh
# a stub swap-cli for the wallet helpers. It records `ARGV|pass=0/1` per call in $STUB_DIR/bin.log, and prints what the real tool prints.
echo "$*|pass=$([ -n "${SWAP_PASSPHRASE:-}" ] && echo 1 || echo 0)" >> "$STUB_DIR/bin.log"
cmd=$1; sub=${2:-}
prev=""; for a in "$@"; do if [ "$prev" = --out ]; then out=$a; fi; prev=$a; done
case "$cmd $sub" in
"wallet new")
  [ "${STUB_WALLET_NEW_RC:-0}" -eq 0 ] || { echo "error: stub wallet new refuses" >&2; exit "$STUB_WALLET_NEW_RC"; }
  echo '{"sealed":"w"}' > "$out"
  printf '{\n  "address": "%s",\n  "wallet_file": "%s"\n}\n' "$STUB_NOIDADDR" "$out" ;;
"ethkey new")
  read -r a; read -r k
  [ "${STUB_ETHKEY_NEW_RC:-0}" -eq 0 ] || { echo "error: stub ethkey new refuses" >&2; exit "$STUB_ETHKEY_NEW_RC"; }
  if [ "$a" != "$STUB_ETHADDR" ] || [ "$k" != "$STUB_KEY" ]; then echo "error: stub ethkey new: wrong framing" >&2; exit 1; fi
  echo '{"sealed":"k"}' > "$out"
  printf '{\n  "address": "%s",\n  "eth_key_file": "%s"\n}\n' "$a" "$out" ;;
"ethkey emit")
  [ "${STUB_EMIT_RC:-0}" -eq 0 ] || { echo "error: stub ethkey emit refuses" >&2; exit "$STUB_EMIT_RC"; }
  echo "$STUB_KEY" ;;
"ethkey address")
  printf '{\n  "address": "%s",\n  "payout": "%s",\n  "role": "%s"\n}\n' "${STUB_SEAL_ETHADDR:-$STUB_ETHADDR}" "${STUB_SEAL_ETHPAYOUT:-$STUB_PAYOUT_ETH}" "${STUB_ROLE:-alice}" ;;
"wallet address")
  [ "${STUB_ADDR_RC:-0}" -eq 0 ] || { echo "error: stub wallet address refuses" >&2; exit "$STUB_ADDR_RC"; }
  printf '{\n  "address": "%s",\n  "payout": "%s",\n  "contract_root": "%s"\n}\n' "${STUB_SEAL_NOIDADDR:-$STUB_NOIDADDR}" "${STUB_SEAL_NOIDPAYOUT:-$STUB_PAYOUT_NOID}" "$STUB_ROOT" ;;
"wallet balance")
  [ "${STUB_BAL_RC:-0}" -eq 0 ] || { echo "error: stub wallet balance: the node did not answer" >&2; exit "$STUB_BAL_RC"; }
  printf '{\n  "address": "%s",\n  "tip": 280500,\n  "plain_micronoid": %s,\n  "plain_coins": 1,\n  "native_asset_carriers_not_counted": 0,\n  "swap_amount_micronoid": 5000000,\n  "funding_fee_reserve_micronoid": 6000,\n  "needed_micronoid": 5006000,\n  "deposit_covers": %s\n}\n' "$STUB_NOIDADDR" "${STUB_HAVE:-5100000}" "${STUB_COVERS:-true}" ;;
"wallet fund"|"wallet recover"|"wallet sweep")
  [ "${STUB_STEP_RC:-}" != "" ] && [ "${STUB_OUTCOME:-}" = "" ] && { echo "error: stub wallet step refuses" >&2; exit "$STUB_STEP_RC"; }
  oc=${STUB_OUTCOME:-dry_run}
  if [ "$oc" = garbage ]; then echo "not json"; exit "${STUB_STEP_RC:-0}"; fi
  target=${STUB_TARGET:-$STUB_ROOT}; txid=null; [ "$oc" = dry_run ] || [ "$oc" = hold ] || txid="\"$STUB_TXID\""
  [ "$oc" = dry_run ] && txid="\"$STUB_TXID\""
  printf '{\n  "step": "%s",\n  "outcome": "%s",\n  "summary": "stub summary for %s",\n  "txid": %s,\n  "built_now": true,\n  "amount_micronoid": %s,\n  "fee_micronoid": 6000,\n  "change_micronoid": 0,\n  "target": "%s",\n  "inputs": 1,\n  "child_height": %s,\n  "submit": null,\n  "notes": []\n}\n' "$sub" "$oc" "$oc" "$txid" "${STUB_STEP_AMOUNT:-5000000}" "$target" "${STUB_CHILD_HEIGHT:-280600}"
  exit "${STUB_STEP_RC:-0}" ;;
"secret "*|"secret")
  echo "$STUB_SECRET" ;;
tick*) if [ -n "${STUB_TICK:-}" ] && [ -f "$STUB_TICK" ]; then cat "$STUB_TICK"; fi; exit "${STUB_TICK_EXIT:-0}" ;;
status*) printf '{\n  "phase": "created",\n  "profile": "sepolia",\n  "h_create": 1,\n  "lock_by_height": 2,\n  "deadline_height": 3\n}\n' ;;
new-alice*)
  while [ $# -gt 0 ]; do [ "$1" = --out ] && o=$2; shift; done
  echo '{"phase":"created"}' > "$o"
  echo "bundle check: 0123456789abcdef ok" >&2
  cat "$STUB_BUNDLE" ;;
new-bob*)
  while [ $# -gt 0 ]; do [ "$1" = --out ] && o=$2; shift; done
  echo '{"phase":"received"}' > "$o"; echo "bundle check: 0123456789abcdef ok"; echo "swap file written: $o" ;;
alice-params*) echo "written: definition" ;;
esac
STUB
  cat > "$TMP/wnstub" <<'STUB'
#!/bin/sh
# a stub node for the wallet helpers: $1 is scripts/live.js, $2 the command. It records `ARGV|pass=0/1` and, per stdin read, only the SHAPE of what it read (never the text).
echo "$*|pass=$([ -n "${SWAP_PASSPHRASE:-}" ] && echo 1 || echo 0)" >> "$STUB_DIR/node.log"
cmd=$2
want_secret=0; dry=0; exp=""; prev=""
for a in "$@"; do
  [ "$a" = --secret-stdin ] && want_secret=1
  [ "$a" = --dry-run ] && dry=1
  [ "$prev" = --expect ] && exp=$a
  prev=$a
done
readkey() {
  read -r k || k=""
  if [ "$k" = "$STUB_KEY" ]; then echo "stdin: key ok" >> "$STUB_DIR/node.log"; else echo "stdin: key MISSING OR WRONG" >> "$STUB_DIR/node.log"; return 1; fi
  if [ "$want_secret" = 1 ]; then
    read -r s || s=""
    if [ "$s" = "$STUB_SECRET" ]; then echo "stdin: secret ok (second line)" >> "$STUB_DIR/node.log"; else echo "stdin: secret MISSING OR WRONG" >> "$STUB_DIR/node.log"; return 1; fi
  fi
  return 0
}
case "$cmd" in
keygen)
  [ "${STUB_KEYGEN_RC:-0}" -eq 0 ] || { echo "error: stub keygen refuses" >&2; exit "$STUB_KEYGEN_RC"; }
  printf '%s\n%s\n' "$STUB_ETHADDR" "$STUB_KEY" ;;
address)
  readkey || { echo "error: no key" >&2; exit 1; }
  if [ "${STUB_ADDR_MISMATCH:-0}" = 1 ]; then echo "error: the key's address is another one than the expected; refusing" >&2; exit 1; fi
  printf '{\n  "address": "%s",\n  "matchesExpected": true\n}\n' "$exp" ;;
reserve)
  readkey || { echo "error: no key" >&2; exit 1; }
  if [ "${STUB_RESERVE_RC:-0}" = 1 ]; then echo "error: this key does not belong to the swap file's alice_receiver; nothing must be deposited" >&2; exit 1; fi
  if [ "${STUB_RESERVE_GARBAGE:-0}" = 1 ]; then echo "garbage"; exit 0; fi
  cov=${STUB_COVERED:-true}; bal=${STUB_BALWEI:-2000000000000000}; short=0; [ "$cov" = true ] || short=900000000000000
  printf '{\n  "role": "%s",\n  "address": "%s",\n  "chainId": "11155111",\n  "lockKind": "poseidon",\n  "reserveWei": "1000000000000000",\n  "requiredWei": "%s",\n  "balanceWei": "%s",\n  "shortfallWei": "%s",\n  "covered": %s,\n  "keyChecked": %s\n}\n' "${STUB_ROLE:-alice}" "$STUB_ETHADDR" "${STUB_REQWEI:-1000000000000000}" "$bal" "$short" "$cov" "${STUB_KEYCHECKED:-true}"
  [ "$cov" = true ] && exit 0; exit 3 ;;
lock|refund|claim|sweep)
  readkey || { echo "error: the key (and the secret) did not arrive complete; refusing" >&2; exit 1; }
  if [ "$cmd" = sweep ] && [ "${STUB_SWEEP_RC:-0}" -ne 0 ]; then
    [ "${STUB_SWEEP_SENT:-0}" = 1 ] && echo "sent: 0x$STUB_TXID nonce 1 (waiting for the receipt)" >&2
    echo "error: stub sweep: refusing: lock still open" >&2; exit "$STUB_SWEEP_RC"
  fi
  if [ "$dry" = 1 ]; then printf '{\n  "dryRun": true,\n  "sent": false,\n  "chainId": "11155111",\n  "from": "%s",\n  "to": "%s"\n}\n' "$STUB_ETHADDR" "$STUB_PAYOUT_ETH"; exit 0; fi
  echo "sent: 0x$STUB_TXID nonce 1 (waiting for the receipt)" >&2
  printf '{\n  "txHash": "0x%s",\n  "blockNumber": 123\n}\n' "$STUB_TXID" ;;
esac
STUB
  printf '#!/bin/sh\necho %s\n' "'{\"result\": 100}'" > "$TMP/wcurl"
  chmod +x "$TMP/wbstub" "$TMP/wnstub" "$TMP/wcurl" "$WB/tick.sh"
  WK="0x$(printf 'ab%.0s' $(seq 1 32))"; WS="0x$(printf 'cd%.0s' $(seq 1 32))"; WTX="$(printf 'ef%.0s' $(seq 1 32))"
  WEA="0x$(printf '1f%.0s' $(seq 1 20))"; WEB="0x$(printf '2e%.0s' $(seq 1 20))"; WEP="0x$(printf '3c%.0s' $(seq 1 20))"
  WNA="o1selftestalicewalletaddressxxxxxx"; WNB="o1selftestbobnoidaddressxxxxxxxxxx"; WNP="o1selftestnoidpayoutaddressxxxxxx"; WROOT="o1selftestcontractrootxxxxxxxxxxx"
  W_BUNDLE="$TMP/wbundle.json"
  printf '{"hashlock":"0x%s","claim_authority":"o1selftestauthority","contract_root":"%s","params":{"profile":"sepolia","deadline_height":3,"max_fee_micronoid":50000,"eth":{"chain_id":11155111}}}\n' "$(printf 'de%.0s' $(seq 1 32))" "$WROOT" > "$W_BUNDLE"
  # wenv NAME [LINE ...]: a fresh run folder $TMP/w-NAME (WD) with a passphrase file and an env.local.sh of a WALLET run (USE_SWAP_WALLET=1, both payouts, the contract, Bob's addresses);
  # a LINE replaces the default of the same name, `-NAME` leaves that line out, and any other LINE is appended. Alice's and Bob's swap files are created empty (the stubs do not read them).
  wenv() {
    local name=$1 line k extra=() skip=" "; shift
    WD="$TMP/w-$name"; rm -rf "$WD"; mkdir -p "$WD/bob" "$WD/rec"; echo "selftest-passphrase" > "$WD/passphrase.txt"
    for line in "$@"; do case "$line" in -*) skip="$skip${line#-} " ;; *=*) skip="$skip${line%%=*} "; extra+=("$line") ;; *) extra+=("$line") ;; esac; done
    {
      for k in USE_SWAP_WALLET CONTRACT BOB_NOID BOB_ETH NOID_PAYOUT ETH_PAYOUT; do
        case "$skip" in *" $k "*) continue ;; esac
        case "$k" in
          USE_SWAP_WALLET) echo "USE_SWAP_WALLET='1'" ;; CONTRACT) echo "CONTRACT=0x0000000000000000000000000000000000000001" ;;
          BOB_NOID) echo "BOB_NOID=$WNB" ;; BOB_ETH) echo "BOB_ETH=$WEB" ;; NOID_PAYOUT) echo "NOID_PAYOUT='$WNP'" ;; ETH_PAYOUT) echo "ETH_PAYOUT='$WEP'" ;;
        esac
      done
      for line in ${extra[@]+"${extra[@]}"}; do printf '%s\n' "$line"; done
    } > "$WD/env.local.sh"
  }
  W_ENV=()
  # wrun SCRIPT [ARG ...]: runs a helper of $WB in $WD under the stubs (STUB_* from the caller's W_ENV array); sets WOUT (stdout and stderr), WRC
  wrun() {
    local s=$1; shift
    : > "$WD/bin.log"; : > "$WD/node.log"; : > "$WD/tick.log"
    WOUT=$(env -i HOME="$TMP/home" PATH="$PATH" L="$WD" LIVE_PLATFORM=native BIN="$TMP/wbstub" NODE="$TMP/wnstub" CURL="$TMP/wcurl" ETH_DIR="$TMP/wethdir" EQ="$TMP/joineq" \
      STUB_DIR="$WD" STUB_KEY="$WK" STUB_SECRET="$WS" STUB_TXID="$WTX" STUB_ETHADDR="$WEA" STUB_NOIDADDR="$WNA" STUB_ROOT="$WROOT" STUB_PAYOUT_NOID="$WNP" STUB_PAYOUT_ETH="$WEP" STUB_BUNDLE="$W_BUNDLE" \
      ${W_ENV[@]+"${W_ENV[@]}"} "$BASH" "$WB/$s" ${1+"$@"} 2>&1 < /dev/null)
    WRC=$?
  }
  wl() { grep -c -- "$1" "$WD/$2" 2>/dev/null || true; }          # wl PATTERN FILE: how many lines of the stub log match (fixed string)
  wnone() { if [ -s "$WD/bin.log" ] || [ -s "$WD/node.log" ]; then echo some; else echo none; fi; }   # no tool was run at all
  # the key and the secret appear nowhere: not in the output, not in any file of the run folder, not in any argv the stubs recorded
  wleak() { local n=0; case "$WOUT" in *"$WK"*|*"$WS"*) n=$((n + 1)) ;; esac; n=$((n + $(grep -rlF -e "$WK" -e "$WS" "$WD" 2>/dev/null | grep -c . || true))); echo "$n"; }

  # --- env.sh: the mode, the addresses file, the helpers' refusals
  wenv envs; printf 'ROLE=alice\nALICE_NOID=%s\nALICE_ETH=%s\nBOB_ETH=%s\nBOGUS=1\n' "$WNA" "$WEA" "$WEB" > "$WD/wallet-addresses.txt"
  check "env.sh: a wallet run takes ALICE_NOID and ALICE_ETH from the addresses file" "$WNA|$WEA" "$(run_native "$WD" 'echo "$ALICE_NOID|$ALICE_ETH"')"
  check "env.sh: ... and the addresses file wins over a BOB_ETH of env.local.sh" "$WEB" "$(run_native "$WD" 'echo "$BOB_ETH"')"
  wenv envc -USE_SWAP_WALLET; printf 'ALICE_NOID=%s\n' "$WNA" > "$WD/wallet-addresses.txt"
  check "env.sh: a classic run ignores the addresses file" "" "$(run_native "$WD" 'echo "$ALICE_NOID"')"
  wenv envenv -USE_SWAP_WALLET -NOID_PAYOUT -ETH_PAYOUT
  check "env.sh: USE_SWAP_WALLET in the ENVIRONMENT is ignored (the mode is env.local.sh's alone)" "0" "$(run_native "$WD" 'echo "$USE_SWAP_WALLET"' USE_SWAP_WALLET=1)"
  check "env.sh: NOID_PAYOUT and ETH_PAYOUT in the environment are ignored too" "[][]" "$(run_native "$WD" 'echo "[$NOID_PAYOUT][$ETH_PAYOUT]"' NOID_PAYOUT=o1x ETH_PAYOUT=0x1)"
  wenv envbad "USE_SWAP_WALLET=2"
  OUT=$(run_native "$WD" 'echo ran' 2>&1); RC=$?
  check "env.sh: USE_SWAP_WALLET that is neither 0 nor 1 exits 2" "2" "$RC"
  wenv envwr; printf 'ALICE_NOID=not-an-address\nALICE_ETH=0x12\n' > "$WD/wallet-addresses.txt"
  check_has "env.sh: a line of the addresses file that is not an address is refused with a warning" "the ALICE_NOID line is not an o1... address; ignored" "$(run_native "$WD" 'echo done' 2>&1)"
  check "env.sh: ... and not taken" "" "$(run_native "$WD" 'echo "$ALICE_NOID"' 2>/dev/null)"
  wenv fees -USE_SWAP_WALLET
  check "reserve_fee_flags: GAS_PRICE_GWEI and a tip print the cap only" "--gas-price-gwei 2" "$(run_native "$WD" 'echo $(reserve_fee_flags)' GAS_PRICE_GWEI=2 PRIORITY_FEE_GWEI=0.01)"
  check "reserve_fee_flags: MAX_FEE_GWEI is the mainnet cap" "--mainnet --max-fee-gwei 0.2" "$(run_native "$WD" 'echo $(reserve_fee_flags)' MAX_FEE_GWEI=0.2)"
  check "reserve_fee_flags: nothing set prints nothing" "" "$(run_native "$WD" 'echo $(reserve_fee_flags)')"
  check_has "require_wallet_run: a classic run says so and returns 2" "rc=2" "$(run_native "$WD" 'require_wallet_run; echo rc=$?' 2>&1)"
  check "require_payout_settings: both set is ok" "rc=0" "$(run_native "$WD" 'NOID_PAYOUT=o1abcdefghijklmnopqrstuvwxyz; ETH_PAYOUT=0x'"$(printf '3c%.0s' $(seq 1 20))"'; require_payout_settings both; echo rc=$?' 2>&1)"
  check_has "require_payout_settings: an empty ETH_PAYOUT is named and returns 2" "ETH_PAYOUT" "$(run_native "$WD" 'NOID_PAYOUT=o1abcdefghijklmnopqrstuvwxyz; ETH_PAYOUT=; require_payout_settings both; echo rc=$?' 2>&1)"
  check "require_payout_settings: noid only does not look at ETH_PAYOUT" "rc=0" "$(run_native "$WD" 'NOID_PAYOUT=o1abcdefghijklmnopqrstuvwxyz; ETH_PAYOUT=; require_payout_settings noid; echo rc=$?' 2>&1)"

  # --- wallet_parse: only exactly what the tools print
  PJ="$TMP/wparse.json"
  printf '{"address":"%s","tip":5,"plain_micronoid":10,"plain_coins":1,"native_asset_carriers_not_counted":0,"swap_amount_micronoid":5,"funding_fee_reserve_micronoid":2,"needed_micronoid":7,"deposit_covers":true}' "$WNA" > "$PJ"
  wp() { env -i HOME="$TMP/home" PATH="$PATH" L="$WD" HERE="$HERE" LIVE_PLATFORM=native "$BASH" -c 'set -u; . "$HERE/env.sh"; wallet_parse "$1" "$2" 2>&1; echo "rc=$?"' _ "$1" "$2"; }
  check_has "wallet_parse noid_balance: a good report is accepted" "rc=0" "$(wp noid_balance "$PJ")"
  check_has "wallet_parse noid_balance: ... and its address is printed" "address=$WNA" "$(wp noid_balance "$PJ")"
  printf '{"address":"%s","tip":"5","plain_micronoid":10,"swap_amount_micronoid":5,"funding_fee_reserve_micronoid":2,"needed_micronoid":7,"deposit_covers":true}' "$WNA" > "$PJ"
  check_has "wallet_parse noid_balance: a number given as text is refused" "rc=1" "$(wp noid_balance "$PJ")"
  printf '{"address":"%s","tip":5,"plain_micronoid":10,"swap_amount_micronoid":5,"funding_fee_reserve_micronoid":2,"needed_micronoid":7,"deposit_covers":1}' "$WNA" > "$PJ"
  check_has "wallet_parse noid_balance: a covers that is a number is refused" "rc=1" "$(wp noid_balance "$PJ")"
  printf 'not json' > "$PJ"
  check_has "wallet_parse: text that is not JSON is refused" "rc=1" "$(wp noid_balance "$PJ")"
  printf '{"address":"%s","tip":5,"plain_micronoid":-1,"swap_amount_micronoid":5,"funding_fee_reserve_micronoid":2,"needed_micronoid":7,"deposit_covers":true}' "$WNA" > "$PJ"
  check_has "wallet_parse noid_balance: a negative amount is refused" "rc=1" "$(wp noid_balance "$PJ")"
  printf '{"address":"%s","requiredWei":"5","reserveWei":"3","balanceWei":"9","shortfallWei":"0","covered":true,"keyChecked":true}' "$WEA" > "$PJ"
  check_has "wallet_parse eth_reserve: a good result is accepted (no amountWei for Alice)" "rc=0" "$(wp eth_reserve "$PJ")"
  check_has "wallet_parse eth_reserve: ... key_checked is printed" "key_checked=true" "$(wp eth_reserve "$PJ")"
  printf '{"address":"%s","requiredWei":"5","reserveWei":"3","balanceWei":"9","shortfallWei":"0","covered":true,"keyChecked":false}' "$WEA" > "$PJ"
  check_has "wallet_parse eth_reserve: keyChecked false is refused (an address the key was not proved to own is never shown)" "rc=1" "$(wp eth_reserve "$PJ")"
  printf '{"address":"%s","requiredWei":"5","reserveWei":"3","balanceWei":"9","shortfallWei":"0","covered":true}' "$WEA" > "$PJ"
  check_has "wallet_parse eth_reserve: no keyChecked at all is refused" "rc=1" "$(wp eth_reserve "$PJ")"
  printf '{"address":"0xzz","requiredWei":"5","reserveWei":"3","balanceWei":"9","shortfallWei":"0","covered":true,"keyChecked":true}' > "$PJ"
  check_has "wallet_parse eth_reserve: an address that is not 0x and 40 hex is refused" "rc=1" "$(wp eth_reserve "$PJ")"
  printf '{"step":"fund","outcome":"sent","summary":"ok\\u001b[31m red","txid":"%s","target":"%s","amount_micronoid":5,"fee_micronoid":1,"change_micronoid":0,"inputs":1,"child_height":9}' "$WTX" "$WROOT" > "$PJ"
  check_has "wallet_parse step: a report is accepted" "rc=0" "$(wp step "$PJ")"
  check "wallet_parse step: ... and the control characters of the summary are gone" "0" "$(wp step "$PJ" | LC_ALL=C grep -c "$(printf '\033')")"
  printf '{"step":"fund","outcome":"exploded","summary":"x","txid":null,"target":null}' > "$PJ"
  check_has "wallet_parse step: an outcome the tool does not have is refused" "rc=1" "$(wp step "$PJ")"
  printf '{"step":"fund","outcome":"sent","summary":"x","txid":"abc","target":null}' > "$PJ"
  check_has "wallet_parse step: a txid that is not 64 hex digits is refused" "rc=1" "$(wp step "$PJ")"
  check_has "wallet_parse: an unknown kind is refused" "rc=1" "$(wp bogus "$PJ")"
fi

if [ -n "${WB:-}" ]; then
  # --- wallet-setup.sh
  wenv su1; W_ENV=()
  wrun wallet-setup.sh alice
  check "wallet-setup.sh alice: exit 0" "0" "$WRC"
  check "wallet-setup.sh alice: the addresses file has the role and the two addresses, last" "ROLE=alice|ALICE_NOID=$WNA|ALICE_ETH=$WEA|" "$(tr '\n' '|' < "$WD/wallet-addresses.txt")"
  check "wallet-setup.sh alice: the order is wallet new, ethkey new, ethkey emit (the wallet first, the key checked last)" "wallet new|ethkey new|ethkey emit" "$(awk '{print $1" "$2}' "$WD/bin.log" | tr '
' '|' | sed 's/|$//')"
  check "wallet-setup.sh alice: the wallet and the key are sealed in the setup folder" "yes" "$([ -f "$WD/wallet-setup/noid-wallet.json" ] && [ -f "$WD/wallet-setup/eth-key.json" ] && echo yes || echo no)"
  check "wallet-setup.sh alice: swap-cli had the passphrase in all three calls" "3" "$(grep -c '|pass=1$' "$WD/bin.log")"
  check "wallet-setup.sh alice: node (keygen, address) never had the passphrase" "2|0" "$(grep -c '|pass=0$' "$WD/node.log")|$(grep -c '|pass=1$' "$WD/node.log")"
  check "wallet-setup.sh alice: node ran keygen --stdout, then address --key-stdin --expect with the address swap-cli was told" "scripts/live.js keygen --stdout|pass=0;scripts/live.js address --key-stdin --expect $WEA|pass=0" "$(grep -v '^stdin:' "$WD/node.log" | tr '\n' ';' | sed 's/;$//')"
  check "wallet-setup.sh alice: the address check read the key from stdin" "1" "$(grep -c '^stdin: key ok' "$WD/node.log")"
  check "wallet-setup.sh alice: the key is nowhere: not in the output, a file or an argv" "0" "$(wleak)"
  check_has "wallet-setup.sh alice: says the key owns the address (checked by live.js)" "the key owns $WEA (checked by live.js)" "$WOUT"
  check_has "wallet-setup.sh alice: prints the two addresses for the console" "wallet-setup: noid $WNA" "$WOUT"
  check_has "wallet-setup.sh alice: ... and the Ethereum one" "wallet-setup: eth $WEA" "$WOUT"
  wrun wallet-setup.sh alice
  check "wallet-setup.sh: a second run is refused (exit 3): a second wallet would orphan the first one's deposit address, and no tool runs" "3|none" "$WRC|$(wnone)"
  check_has "wallet-setup.sh: ... and says why" "already set up" "$WOUT"
  wenv su2; wrun wallet-setup.sh bob
  check "wallet-setup.sh bob: exit 0, no NOID wallet is made" "0|0" "$WRC|$(grep -c '^wallet new' "$WD/bin.log")"
  check "wallet-setup.sh bob: the addresses file has the role and Bob's Ethereum address only" "ROLE=bob|BOB_ETH=$WEA|" "$(tr '\n' '|' < "$WD/wallet-addresses.txt")"
  check "wallet-setup.sh bob: no standalone NOID wallet file" "no" "$([ -e "$WD/wallet-setup/noid-wallet.json" ] && echo yes || echo no)"
  wenv su3 -USE_SWAP_WALLET; wrun wallet-setup.sh alice
  check "wallet-setup.sh: a classic run is refused with exit 2, no tool runs" "2|none" "$WRC|$(wnone)"
  check_has "wallet-setup.sh: ... and says it is a classic run" "this is a classic run" "$WOUT"
  wenv su4; : > "$WD/alice.swap.json"; wrun wallet-setup.sh alice
  check "wallet-setup.sh: the swap file already exists: exit 3, no tool runs" "3|none" "$WRC|$(wnone)"
  wenv su5; mkdir -p "$WD/wallet-setup"; : > "$WD/wallet-setup/eth-key.json"; wrun wallet-setup.sh alice
  check "wallet-setup.sh: a half-made setup (a key file without the addresses file): exit 3, no tool runs, nothing replaced" "3|none|yes" "$WRC|$(wnone)|$([ -f "$WD/wallet-setup/eth-key.json" ] && echo yes || echo no)"
  check_has "wallet-setup.sh: ... and says no address was shown from it" "No address was shown from it" "$WOUT"
  wenv su6; W_ENV=(STUB_WALLET_NEW_RC=3); wrun wallet-setup.sh alice
  check "wallet-setup.sh: swap-cli wallet new fails: exit 3, stopped at the first failure (no key is made), no addresses file" "3|0|no" "$WRC|$(grep -c '^ethkey' "$WD/bin.log")|$([ -e "$WD/wallet-addresses.txt" ] && echo yes || echo no)"
  wenv su7; W_ENV=(STUB_KEYGEN_RC=1); wrun wallet-setup.sh alice
  check "wallet-setup.sh: keygen fails: exit 3, no addresses file, no address check" "3|no|0" "$WRC|$([ -e "$WD/wallet-addresses.txt" ] && echo yes || echo no)|$(grep -c 'address' "$WD/node.log")"
  wenv su8; W_ENV=(STUB_ETHKEY_NEW_RC=2); wrun wallet-setup.sh bob
  check "wallet-setup.sh: ethkey new fails: exit 3, no addresses file" "3|no" "$WRC|$([ -e "$WD/wallet-addresses.txt" ] && echo yes || echo no)"
  wenv su9; W_ENV=(STUB_ADDR_MISMATCH=1); wrun wallet-setup.sh bob
  check "wallet-setup.sh: the key does not own the address swap-cli was told: exit 3, no addresses file" "3|no" "$WRC|$([ -e "$WD/wallet-addresses.txt" ] && echo yes || echo no)"
  check_has "wallet-setup.sh: ... and says nothing must be deposited" "NOTHING must be deposited" "$WOUT"
  wenv su10 -USE_SWAP_WALLET; wenv su10; rm "$WD/passphrase.txt"; W_ENV=(); wrun wallet-setup.sh alice
  check "wallet-setup.sh: no passphrase file: exit 2, no tool runs" "2|none" "$WRC|$(wnone)"
  wenv su11; wrun wallet-setup.sh alice --dry-run
  check "wallet-setup.sh --dry-run: exit 0, no tool runs, nothing is made" "0|none|no|no" "$WRC|$(wnone)|$([ -e "$WD/wallet-addresses.txt" ] && echo yes || echo no)|$([ -e "$WD/wallet-setup" ] && echo yes || echo no)"
  wrun wallet-setup.sh; check "wallet-setup.sh: no role: exit 2" "2" "$WRC"
  wrun wallet-setup.sh carol; check "wallet-setup.sh: another role: exit 2" "2" "$WRC"
  wrun wallet-setup.sh alice bob; check "wallet-setup.sh: two roles: exit 2" "2" "$WRC"

  # --- wallet-status.sh
  wenv st1; : > "$WD/alice.swap.json"; W_ENV=(); wrun wallet-status.sh alice
  check "wallet-status.sh alice: exit 0" "0" "$WRC"
  check_has "wallet-status.sh alice: the NOID line with the address, the plain coins and the need" "wallet-status-noid: address=$WNA plain_micronoid=5100000 amount_micronoid=5000000 fee_reserve_micronoid=6000 need_micronoid=5006000 covers=true tip=280500" "$WOUT"
  check_has "wallet-status.sh alice: the ETH line carries the key's address and key_checked=true" "wallet-status-eth: address=$WEA required_wei=1000000000000000 reserve_wei=1000000000000000 amount_wei=0 balance_wei=2000000000000000 shortfall_wei=0 covered=true key_checked=true" "$WOUT"
  check_has "wallet-status.sh alice: ends with done" "wallet-status: done" "$WOUT"
  check "wallet-status.sh alice: live.js reserve got the role, the swap file and --key-stdin, and the key arrived on stdin" "1|1" "$(grep -c '^scripts/live.js reserve --role alice --swap .*alice.swap.json --key-stdin|pass=0$' "$WD/node.log")|$(grep -c '^stdin: key ok' "$WD/node.log")"
  check "wallet-status.sh alice: no key file is named anywhere" "0" "$(grep -c -- '--key-file' "$WD/node.log")"
  check "wallet-status.sh alice: swap-cli emitted the key from the swap file (with the passphrase); node never had it" "1|0" "$(grep -c '^ethkey emit .*alice.swap.json|pass=1$' "$WD/bin.log")|$(grep -c '|pass=1$' "$WD/node.log")"
  check "wallet-status.sh alice: swap-cli wallet balance ran against the NOID node with the curl transport" "1" "$(grep -c '^wallet balance .*alice.swap.json --transport curl --noid-rpc http://127.0.0.1:9601 --rpc-timeout 60 --curl-path' "$WD/bin.log")"
  check "wallet-status.sh: no key, no secret anywhere" "0" "$(wleak)"
  W_ENV=(STUB_COVERED=false STUB_COVERS=false); wrun wallet-status.sh alice
  check "wallet-status.sh alice: not covered is data, not a failure: exit 0, covered=false and covers=false" "0|1|1" "$WRC|$(printf '%s\n' "$WOUT" | grep -c 'covered=false')|$(printf '%s\n' "$WOUT" | grep -c 'covers=false')"
  W_ENV=(STUB_RESERVE_RC=1); wrun wallet-status.sh alice
  check "wallet-status.sh alice: the key does not own the stated address (reserve exit 1): exit 3, no ETH line, no done" "3|0|0" "$WRC|$(printf '%s\n' "$WOUT" | grep -c '^wallet-status-eth:')|$(printf '%s\n' "$WOUT" | grep -c '^wallet-status: done')"
  check_has "wallet-status.sh alice: ... and says nothing must be deposited to an address the check did not prove" "nothing must be deposited" "$WOUT"
  W_ENV=(STUB_BAL_RC=1); wrun wallet-status.sh alice
  check "wallet-status.sh alice: the balance cannot be read: exit 3, no NOID line, no done" "3|0|0" "$WRC|$(printf '%s\n' "$WOUT" | grep -c '^wallet-status-noid:')|$(printf '%s\n' "$WOUT" | grep -c '^wallet-status: done')"
  W_ENV=(STUB_RESERVE_GARBAGE=1); wrun wallet-status.sh alice
  check "wallet-status.sh alice: a reserve output that is not JSON: exit 3, no done" "3|0" "$WRC|$(printf '%s\n' "$WOUT" | grep -c '^wallet-status: done')"
  W_ENV=(STUB_KEYCHECKED=false); wrun wallet-status.sh alice
  check "wallet-status.sh alice: keyChecked false: exit 3 and no ETH line (an address is shown only from a result that proved the key owns it)" "3|0" "$WRC|$(printf '%s\n' "$WOUT" | grep -c '^wallet-status-eth:')"
  wenv st2 'GAS_PRICE_GWEI=2' 'PRIORITY_FEE_GWEI=0.01'; : > "$WD/alice.swap.json"; W_ENV=(); wrun wallet-status.sh alice
  check "wallet-status.sh: reserve gets the cap (--gas-price-gwei 2) and never the tip" "1|0" "$(grep -c -- '--gas-price-gwei 2|pass=0$' "$WD/node.log")|$(grep -c -- '--priority-fee-gwei' "$WD/node.log")"
  wenv st3 'MAX_FEE_GWEI=0.2'; : > "$WD/alice.swap.json"; wrun wallet-status.sh alice
  check "wallet-status.sh: MAX_FEE_GWEI becomes --mainnet --max-fee-gwei" "1" "$(grep -c -- '--mainnet --max-fee-gwei 0.2|pass=0$' "$WD/node.log")"
  wenv st4; : > "$WD/bob/bob.swap.json"; W_ENV=(STUB_ROLE=bob STUB_ETHADDR="$WEB"); wrun wallet-status.sh bob
  check "wallet-status.sh bob: exit 0, only the Ethereum part (no balance call, no NOID line)" "0|0|1" "$WRC|$(grep -c '^wallet balance' "$WD/bin.log")|$(printf '%s\n' "$WOUT" | grep -c '^wallet-status-eth: address='"$WEB")"
  check "wallet-status.sh bob: reserve --role bob on Bob's swap file" "1" "$(grep -c '^scripts/live.js reserve --role bob --swap .*bob.swap.json --key-stdin' "$WD/node.log")"
  W_ENV=(); wenv st5 -USE_SWAP_WALLET; : > "$WD/alice.swap.json"; wrun wallet-status.sh alice
  check "wallet-status.sh: a classic run: exit 2, no tool runs" "2|none" "$WRC|$(wnone)"
  wenv st6; wrun wallet-status.sh alice
  check "wallet-status.sh: no swap file: exit 2, no tool runs" "2|none" "$WRC|$(wnone)"
  wrun wallet-status.sh; check "wallet-status.sh: no role: exit 2" "2" "$WRC"
  wrun wallet-status.sh carol; check "wallet-status.sh: another role: exit 2" "2" "$WRC"
fi

if [ -n "${WB:-}" ]; then
  # --- wallet-fund.sh
  wf() { local n=$1 a envl=() stubs=(); shift; for a in ${@+"$@"}; do case "$a" in STUB_*) stubs+=("$a") ;; *) envl+=("$a") ;; esac; done; wenv "$n" ${envl[@]+"${envl[@]}"}; : > "$WD/alice.swap.json"; W_ENV=(${stubs[@]+"${stubs[@]}"}); }
  wf f1
  wrun wallet-fund.sh --dry-run
  check "wallet-fund.sh --dry-run: exit 0" "0" "$WRC"
  check_has "wallet-fund.sh --dry-run: names the wallet and the contract root" "wallet-fund: wallet $WNA" "$WOUT"
  check_has "wallet-fund.sh --dry-run: ... the contract root" "wallet-fund: contract_root $WROOT" "$WOUT"
  check_has "wallet-fund.sh --dry-run: ... the reveal's fee reserve, covered" "wallet-fund: reserve covered=true" "$WOUT"
  check_has "wallet-fund.sh --dry-run: the outcome is dry_run" "wallet-fund: outcome dry_run" "$WOUT"
  check_has "wallet-fund.sh --dry-run: the target is the contract root" "wallet-fund: target $WROOT" "$WOUT"
  check_has "wallet-fund.sh --dry-run: the amount is the swap's" "wallet-fund: amount_micronoid 5000000" "$WOUT"
  check_has "wallet-fund.sh --dry-run: says what it would do and that nothing was written or sent" "dry run: would fund 5000000 micro-NOID once from the swap wallet to the contract address; nothing was written or sent" "$WOUT"
  check "wallet-fund.sh --dry-run: swap-cli wallet fund got --dry-run and no --submit" "1|0" "$(grep -c '^wallet fund .*alice.swap.json .* --dry-run|pass=1$' "$WD/bin.log")|$(grep -c -- '--submit' "$WD/bin.log")"
  check "wallet-fund.sh --dry-run: the reserve was read first, with the key piped from swap-cli ethkey emit" "1|1" "$(grep -c '^scripts/live.js reserve --role alice' "$WD/node.log")|$(grep -c '^ethkey emit' "$WD/bin.log")"
  check "wallet-fund.sh --dry-run: no marker, no key, no secret" "no|0" "$([ -e "$WD/wallet-funded.marker" ] && echo yes || echo no)|$(wleak)"
  wf f2 STUB_OUTCOME=sent; wrun wallet-fund.sh
  check "wallet-fund.sh (real): sent: exit 0" "0" "$WRC"
  check "wallet-fund.sh (real): swap-cli wallet fund got --submit" "1" "$(grep -c '^wallet fund .*alice.swap.json .* --submit|pass=1$' "$WD/bin.log")"
  check_has "wallet-fund.sh (real): the outcome and the txid are printed" "wallet-fund: txid $WTX" "$WOUT"
  check "wallet-fund.sh (real): the marker is written (the time, then the txid)" "yes|txid $WTX" "$([ -f "$WD/wallet-funded.marker" ] && echo yes || echo no)|$(sed -n 2p "$WD/wallet-funded.marker")"
  wf f2b 'NOID_RPC2=http://second-node' STUB_OUTCOME=sent; wrun wallet-fund.sh
  check "wallet-fund.sh (real): a second NOID node is also a --submit-rpc" "1" "$(grep -c -- '--submit --submit-rpc http://second-node|pass=1$' "$WD/bin.log")"
  wf f3 STUB_COVERED=false; wrun wallet-fund.sh
  check "wallet-fund.sh: the reveal's fee reserve is not covered: exit 3, swap-cli wallet fund never runs" "3|0" "$WRC|$(grep -c '^wallet fund' "$WD/bin.log")"
  check_has "wallet-fund.sh: ... and says why" "REFUSED: Alice's Ethereum key holds less than the reveal's fee reserve" "$WOUT"
  wrun wallet-fund.sh --dry-run
  check "wallet-fund.sh --dry-run: the same refusal in a dry run (exit 3, no funding built)" "3|0" "$WRC|$(grep -c '^wallet fund' "$WD/bin.log")"
  wf f4 STUB_RESERVE_RC=1; wrun wallet-fund.sh
  check "wallet-fund.sh: the reserve cannot be checked (the key does not own the address): exit 3, no funding" "3|0" "$WRC|$(grep -c '^wallet fund' "$WD/bin.log")"
  wf f5 STUB_RESERVE_GARBAGE=1; wrun wallet-fund.sh
  check "wallet-fund.sh: a reserve output that is not JSON: exit 3, no funding" "3|0" "$WRC|$(grep -c '^wallet fund' "$WD/bin.log")"
  # how swap-cli's outcomes end: 0 sent, 3 refused/not sent, 4 hold/done, 6 maybe sent, 1 anything else
  wf f6 STUB_OUTCOME=maybe_sent STUB_STEP_RC=1; wrun wallet-fund.sh
  check "wallet-fund.sh (real): the tool says maybe_sent: exit 6, no marker, tells to run it again" "6|no" "$WRC|$([ -e "$WD/wallet-funded.marker" ] && echo yes || echo no)"
  check_has "wallet-fund.sh: ... and says it sends the same bytes, never a second funding" "THE FUNDING MAY HAVE BEEN SENT: run this again; it sends the same recorded bytes" "$WOUT"
  wrun wallet-fund.sh
  check "wallet-fund.sh: ... and again: it runs the tool again (the same command), exit 6" "6|1" "$WRC|$(grep -c '^wallet fund' "$WD/bin.log")"
  wf f7 STUB_OUTCOME=not_sent STUB_STEP_RC=1; wrun wallet-fund.sh
  check "wallet-fund.sh (real): not_sent: exit 3, no marker" "3|no" "$WRC|$([ -e "$WD/wallet-funded.marker" ] && echo yes || echo no)"
  wf f8 STUB_OUTCOME=hold; wrun wallet-fund.sh
  check "wallet-fund.sh (real): hold (the deposit is too young, the window ...): exit 4, no marker" "4|no" "$WRC|$([ -e "$WD/wallet-funded.marker" ] && echo yes || echo no)"
  wf f9 STUB_OUTCOME=done; wrun wallet-fund.sh
  check "wallet-fund.sh (real): done (the funding is at the contract): exit 4, the marker is written" "4|yes" "$WRC|$([ -f "$WD/wallet-funded.marker" ] && echo yes || echo no)"
  wf f10 STUB_STEP_RC=1; wrun wallet-fund.sh
  check "wallet-fund.sh (real): swap-cli errors before it sends (exit 1, no JSON): exit 3" "3" "$WRC"
  wf f11 STUB_OUTCOME=garbage STUB_STEP_RC=0; wrun wallet-fund.sh
  check "wallet-fund.sh (real): an output that cannot be read after a clean exit: exit 1 (treated as possibly sent)" "1|no" "$WRC|$([ -e "$WD/wallet-funded.marker" ] && echo yes || echo no)"
  wf f12 STUB_OUTCOME=sent STUB_STEP_RC=101; wrun wallet-fund.sh
  check "wallet-fund.sh (real): sent reported with a failing exit status (a panic): exit 1, no marker" "1|no" "$WRC|$([ -e "$WD/wallet-funded.marker" ] && echo yes || echo no)"
  wf f13 STUB_OUTCOME=hold; wrun wallet-fund.sh --dry-run
  check "wallet-fund.sh --dry-run: hold: exit 4" "4" "$WRC"
  wf f14 STUB_OUTCOME=sent; wrun wallet-fund.sh --dry-run
  check "wallet-fund.sh --dry-run: an outcome that is not dry_run (the tool should never say sent): exit 3" "3" "$WRC"
  wf f15 STUB_ADDR_RC=1; wrun wallet-fund.sh
  check "wallet-fund.sh: swap-cli wallet address fails: exit 3, no reserve read, no funding" "3|0|0" "$WRC|$(grep -c '^scripts' "$WD/node.log")|$(grep -c '^wallet fund' "$WD/bin.log")"
  wf f16 -USE_SWAP_WALLET; wrun wallet-fund.sh
  check "wallet-fund.sh: a classic run: exit 2, no tool runs" "2|none" "$WRC|$(wnone)"
  wf f17; rm "$WD/alice.swap.json"; wrun wallet-fund.sh
  check "wallet-fund.sh: no swap file: exit 2" "2" "$WRC"
  wf f18; wrun wallet-fund.sh --submit
  check "wallet-fund.sh: an unknown flag: exit 2, no tool runs" "2|none" "$WRC|$(wnone)"
  wf f19; wrun wallet-fund.sh --dry-run --dry-run
  check "wallet-fund.sh: two flags: exit 2" "2" "$WRC"
  # a funding by the classic helper in a wallet run, and the reverse
  wf f20; wrun fund.sh --dry-run
  check "fund.sh in a wallet run: exit 2, no tool runs (the classic helper refuses)" "2|none" "$WRC|$(wnone)"
  check_has "fund.sh in a wallet run: ... and names the wallet helper" "wallet-fund.sh" "$WOUT"
  wrun recover-noid.sh --dry-run
  check "recover-noid.sh in a wallet run: exit 2, no tool runs" "2|none" "$WRC|$(wnone)"
  wrun check-object.sh
  check "check-object.sh in a wallet run: exit 2, no tool runs" "2|none" "$WRC|$(wnone)"
  wf f21; wrun wallet-fund.sh --dry-run
  check "wallet-fund.sh: the key never leaves the pipe (no key, no secret anywhere after a dry run and the refusals above)" "0" "$(wleak)"

  # --- wallet-recover.sh
  wf r1
  wrun wallet-recover.sh --dry-run
  check "wallet-recover.sh --dry-run: exit 0, says what it would do" "0|1" "$WRC|$(printf '%s\n' "$WOUT" | grep -c 'dry run: would recover 5000000 micro-NOID once to the swap wallet')"
  check "wallet-recover.sh --dry-run: swap-cli wallet recover got --dry-run, no tick ran, no txid file" "1|0|no" "$(grep -c '^wallet recover .* --dry-run' "$WD/bin.log")|$(grep -c . "$WD/tick.log")|$([ -e "$WD/wallet-recovered-txid.txt" ] && echo yes || echo no)"
  check_has "wallet-recover.sh --dry-run: the wallet and the target are printed" "wallet-recover: wallet $WNA" "$WOUT"
  wf r2 STUB_OUTCOME=sent STUB_TARGET="$WNA"; wrun wallet-recover.sh
  check "wallet-recover.sh (real): sent: exit 0, the txid is kept for the recording" "0|$WTX" "$WRC|$(cat "$WD/wallet-recovered-txid.txt" 2>/dev/null)"
  check "wallet-recover.sh (real): swap-cli wallet recover got --submit" "1" "$(grep -c '^wallet recover .* --submit' "$WD/bin.log")"
  check "wallet-recover.sh (real): the recording is tried at once: tick.sh alice --closed-by TXID --apply" "tick.sh alice --closed-by $WTX --apply" "$(cat "$WD/tick.log")"
  check_has "wallet-recover.sh (real): ... and reported" "wallet-recover: closed-by recorded txid $WTX" "$WOUT"
  wf r3 STUB_OUTCOME=sent STUB_TICK_RC=1; wrun wallet-recover.sh
  check "wallet-recover.sh (real): a close just sent is not confirmed: the recording is refused, the send still ends with exit 0" "0|1" "$WRC|$(printf '%s\n' "$WOUT" | grep -c 'closed-by NOT recorded yet')"
  check_has "wallet-recover.sh (real): ... with the tool's words" "the stub tick refuses" "$WOUT"
  W_ENV=(STUB_TICK_RC=1); wrun wallet-recover.sh --record
  check "wallet-recover.sh --record: the tool still refuses (not confirmed): exit 3, nothing written by this helper" "3|0" "$WRC|$(grep -c '^wallet' "$WD/bin.log")"
  W_ENV=(); wrun wallet-recover.sh --record
  check "wallet-recover.sh --record: confirmed: exit 0, recorded; no wallet command ran" "0|0" "$WRC|$(grep -c '^wallet' "$WD/bin.log")"
  check_has "wallet-recover.sh --record: ... reports the recording" "wallet-recover: closed-by recorded txid $WTX" "$WOUT"
  wf r4; wrun wallet-recover.sh --record
  check "wallet-recover.sh --record: no close was sent from this run folder: exit 4, no tick" "4|0" "$WRC|$(grep -c . "$WD/tick.log")"
  wf r5; printf 'not a txid\n' > "$WD/wallet-recovered-txid.txt"; wrun wallet-recover.sh --record
  check "wallet-recover.sh --record: a txid file that is not a txid: exit 4, no tick" "4|0" "$WRC|$(grep -c . "$WD/tick.log")"
  wf r6 STUB_OUTCOME=maybe_sent STUB_STEP_RC=1; wrun wallet-recover.sh
  check "wallet-recover.sh (real): maybe_sent: exit 6, the txid is kept, no recording is tried" "6|$WTX|0" "$WRC|$(cat "$WD/wallet-recovered-txid.txt" 2>/dev/null)|$(grep -c . "$WD/tick.log")"
  wf r7 STUB_OUTCOME=hold; wrun wallet-recover.sh
  check "wallet-recover.sh (real): hold (before D, instance not at the contract): exit 4, no txid file, no recording" "4|no|0" "$WRC|$([ -e "$WD/wallet-recovered-txid.txt" ] && echo yes || echo no)|$(grep -c . "$WD/tick.log")"
  wf r8 STUB_OUTCOME=not_sent STUB_STEP_RC=1; wrun wallet-recover.sh
  check "wallet-recover.sh (real): not_sent: exit 3" "3" "$WRC"
  wf r9 -USE_SWAP_WALLET; wrun wallet-recover.sh
  check "wallet-recover.sh: a classic run: exit 2, no tool runs" "2|none" "$WRC|$(wnone)"
  wf r10; wrun wallet-recover.sh --force
  check "wallet-recover.sh: an unknown flag: exit 2" "2" "$WRC"
  wf r11 STUB_OUTCOME=sent STUB_TARGET="$WNA"; wrun wallet-recover.sh
  wrun wallet-recover.sh
  check "wallet-recover.sh: a second real run with the same txid keeps it" "$WTX" "$(cat "$WD/wallet-recovered-txid.txt")"
  WTX2="$(printf '12%.0s' $(seq 1 32))"; W_ENV+=("STUB_TXID=$WTX2"); wrun wallet-recover.sh
  check "wallet-recover.sh: a rebuilt close (another txid) replaces the kept txid, and no temporary file is left" "$WTX2|0" "$(cat "$WD/wallet-recovered-txid.txt")|$(ls "$WD" | grep -c 'wallet-recovered-txid.txt.tmp')"

  # --- wallet-sweep.sh
  wf s1
  wrun wallet-sweep.sh noid --dry-run
  check "wallet-sweep.sh noid --dry-run: exit 0" "0" "$WRC"
  check_has "wallet-sweep.sh noid: the payout of the swap file and of the settings are both printed" "wallet-sweep: payout_swap_file $WNP" "$WOUT"
  check_has "wallet-sweep.sh noid: ... the settings' one" "wallet-sweep: payout_settings $WNP" "$WOUT"
  check_has "wallet-sweep.sh noid --dry-run: the target is printed" "wallet-sweep: target $WROOT" "$WOUT"
  check_has "wallet-sweep.sh noid --dry-run: says it would sweep once to the payout address" "dry run: would sweep 5000000 micro-NOID once to the payout address; nothing was written or sent" "$WOUT"
  check "wallet-sweep.sh noid --dry-run: swap-cli wallet sweep got --dry-run" "1|0" "$(grep -c '^wallet sweep .* --dry-run' "$WD/bin.log")|$(grep -c -- '--submit' "$WD/bin.log")"
  wf s2 STUB_OUTCOME=sent; wrun wallet-sweep.sh noid
  check "wallet-sweep.sh noid (real): sent: exit 0, --submit, the marker is written" "0|1|yes" "$WRC|$(grep -c '^wallet sweep .* --submit' "$WD/bin.log")|$([ -f "$WD/wallet-swept-noid.marker" ] && echo yes || echo no)"
  wf s3 NOID_PAYOUT=o1selftestsomeotherpayoutxxxxxx; wrun wallet-sweep.sh noid
  check "wallet-sweep.sh noid: NOID_PAYOUT is not the address sealed in the swap file: exit 3, swap-cli wallet sweep never runs" "3|0" "$WRC|$(grep -c '^wallet sweep' "$WD/bin.log")"
  check_has "wallet-sweep.sh noid: ... and says so" "NOID_PAYOUT in $WD/env.local.sh is not the payout address sealed in the swap file" "$WOUT"
  wf s4 STUB_OUTCOME=hold; wrun wallet-sweep.sh noid
  check "wallet-sweep.sh noid (real): hold (the instance is still at the contract ...): exit 4, no marker" "4|no" "$WRC|$([ -e "$WD/wallet-swept-noid.marker" ] && echo yes || echo no)"
  wf s5 STUB_OUTCOME=maybe_sent STUB_STEP_RC=1; wrun wallet-sweep.sh noid
  check "wallet-sweep.sh noid (real): maybe_sent: exit 6, no marker" "6|no" "$WRC|$([ -e "$WD/wallet-swept-noid.marker" ] && echo yes || echo no)"
  wf s6 -NOID_PAYOUT; wrun wallet-sweep.sh noid
  check "wallet-sweep.sh noid: no NOID_PAYOUT setting: exit 2, no tool runs" "2|none" "$WRC|$(wnone)"
  wf s7 -ETH_PAYOUT; wrun wallet-sweep.sh noid --dry-run
  check "wallet-sweep.sh noid: ETH_PAYOUT does not matter for the NOID sweep" "0" "$WRC"
  wf s8 -USE_SWAP_WALLET; wrun wallet-sweep.sh noid
  check "wallet-sweep.sh: a classic run: exit 2, no tool runs" "2|none" "$WRC|$(wnone)"
  wf s9 STUB_ADDR_RC=1; wrun wallet-sweep.sh noid
  check "wallet-sweep.sh noid: the swap file names no payout (swap-cli wallet address fails): exit 3, no sweep" "3|0" "$WRC|$(grep -c '^wallet sweep' "$WD/bin.log")"
  wrun wallet-sweep.sh; check "wallet-sweep.sh: no kind: exit 2" "2" "$WRC"
  wrun wallet-sweep.sh sell; check "wallet-sweep.sh: an unknown kind: exit 2" "2" "$WRC"
  wrun wallet-sweep.sh eth; check "wallet-sweep.sh eth: no role: exit 2" "2" "$WRC"
  wrun wallet-sweep.sh eth carol; check "wallet-sweep.sh eth: an unknown role: exit 2" "2" "$WRC"
  wrun wallet-sweep.sh noid --force; check "wallet-sweep.sh noid: an unknown flag: exit 2" "2" "$WRC"
  # the Ethereum sweep: the key piped from swap-cli ethkey emit into live.js sweep --key-stdin
  wf e1 STUB_ROLE=alice; wrun wallet-sweep.sh eth alice --dry-run
  check "wallet-sweep.sh eth alice --dry-run: exit 0" "0" "$WRC"
  check "wallet-sweep.sh eth alice --dry-run: live.js sweep got the swap file, --to the settings' payout, --key-stdin, --chain-id and --dry-run, and the key on stdin" "1|1" "$(grep -c "^scripts/live.js sweep --swap .*alice.swap.json --to $WEP --key-stdin --chain-id 11155111 --dry-run|pass=0\$" "$WD/node.log")|$(grep -c '^stdin: key ok' "$WD/node.log")"
  check "wallet-sweep.sh eth: swap-cli emitted the key from Alice's swap file with the passphrase; node never had it" "1|0" "$(grep -c '^ethkey emit .*alice.swap.json|pass=1$' "$WD/bin.log")|$(grep -c '|pass=1$' "$WD/node.log")"
  check "wallet-sweep.sh eth --dry-run: the result file is eth-sweep-alice-dry-N.json and holds the dry run" "1|1" "$(ls "$WD" | grep -c '^eth-sweep-alice-dry-[0-9]*\.json$')|$(cat "$WD"/eth-sweep-alice-dry-*.json | grep -c '"dryRun": true')"
  check_has "wallet-sweep.sh eth: the two payout addresses are printed" "wallet-sweep: payout_swap_file $WEP" "$WOUT"
  check "wallet-sweep.sh eth: no key, no secret anywhere" "0" "$(wleak)"
  wf e2 STUB_ROLE=alice; wrun wallet-sweep.sh eth alice
  check "wallet-sweep.sh eth alice (real): exit 0, live.js sweep without --dry-run, the marker with the txid" "0|0|yes" "$WRC|$(grep -c -- '--dry-run' "$WD/node.log")|$([ -f "$WD/wallet-swept-eth-alice.marker" ] && echo yes || echo no)"
  check "wallet-sweep.sh eth (real): the result file is eth-sweep-alice-N.json" "1" "$(ls "$WD" | grep -c '^eth-sweep-alice-[0-9]*\.json$')"
  wf e3 STUB_ROLE=alice STUB_SWEEP_RC=1; wrun wallet-sweep.sh eth alice
  check "wallet-sweep.sh eth (real): live.js refuses before it broadcasts (exit 1, no 'sent:' line): exit 3, no marker, no result file" "3|no|0" "$WRC|$([ -e "$WD/wallet-swept-eth-alice.marker" ] && echo yes || echo no)|$(ls "$WD" | grep -c '^eth-sweep-alice-[0-9]*\.json$')"
  check_has "wallet-sweep.sh eth: ... and says nothing was sent" "REFUSED by live.js before it broadcast anything" "$WOUT"
  wf e4 STUB_ROLE=alice STUB_SWEEP_RC=1 STUB_SWEEP_SENT=1; wrun wallet-sweep.sh eth alice
  check "wallet-sweep.sh eth (real): live.js broadcast and did not finish (a 'sent:' line, exit 1): exit 6, no marker" "6|no" "$WRC|$([ -e "$WD/wallet-swept-eth-alice.marker" ] && echo yes || echo no)"
  wf e5 STUB_ROLE=alice STUB_SWEEP_RC=3; wrun wallet-sweep.sh eth alice
  check "wallet-sweep.sh eth (real): an exit status of live.js other than 0 and 1 is not a refusal: exit 1" "1" "$WRC"
  wf e6 STUB_ROLE=alice STUB_EMIT_RC=4; wrun wallet-sweep.sh eth alice
  check "wallet-sweep.sh eth: the key cannot be emitted: exit 3 (nothing was sent), no result file, no marker" "3|0|no" "$WRC|$(ls "$WD" | grep -c '^eth-sweep-alice-[0-9]*\.json$')|$([ -e "$WD/wallet-swept-eth-alice.marker" ] && echo yes || echo no)"
  wf e7 ETH_PAYOUT="0x$(printf '4d%.0s' $(seq 1 20))" STUB_ROLE=alice; wrun wallet-sweep.sh eth alice
  check "wallet-sweep.sh eth: ETH_PAYOUT is not the payout sealed in the swap file: exit 3, live.js never runs" "3|0" "$WRC|$(grep -c '^scripts' "$WD/node.log")"
  wf e8 ETH_PAYOUT="0x$(printf '3C%.0s' $(seq 1 20))" STUB_ROLE=alice STUB_PAYOUT_ETH="$WEP"; wrun wallet-sweep.sh eth alice --dry-run
  check "wallet-sweep.sh eth: the comparison of the two payout addresses ignores letter case" "0" "$WRC"
  wf e9 STUB_ROLE=alice -ETH_PAYOUT; wrun wallet-sweep.sh eth alice
  check "wallet-sweep.sh eth: no ETH_PAYOUT setting: exit 2, no tool runs" "2|none" "$WRC|$(wnone)"
  wf e10; : > "$WD/bob/bob.swap.json"; W_ENV=(STUB_ROLE=bob STUB_ETHADDR="$WEB"); wrun wallet-sweep.sh eth bob --dry-run
  check "wallet-sweep.sh eth bob --dry-run: exit 0, Bob's swap file and Bob's key" "0|1" "$WRC|$(grep -c '^scripts/live.js sweep --swap .*bob.swap.json' "$WD/node.log")"
  wf e11; W_ENV=(STUB_ROLE=bob); wrun wallet-sweep.sh eth alice --dry-run
  check "wallet-sweep.sh eth: the swap file says another role than the one asked (the sealed record is Bob's): exit 3, live.js never runs" "3|0" "$WRC|$(grep -c '^scripts' "$WD/node.log")"
fi

if [ -n "${WB:-}" ]; then
  # --- prepare.sh (Alice, wallet run): the swap wallet and the key are sealed into her swap file; Bob's file and the object file are not made here
  wp() {   # wp NAME [wenv args]: a wallet run set up for Alice: the addresses file, the two sealed standalone files, LOCK_KIND=poseidon (no proof), Bob's two addresses
    local n=$1; shift
    wenv "$n" 'LOCK_KIND=poseidon' ${@+"$@"}
    printf 'ROLE=alice\nALICE_NOID=%s\nALICE_ETH=%s\n' "$WNA" "$WEA" > "$WD/wallet-addresses.txt"
    mkdir -p "$WD/wallet-setup"; echo '{"sealed":"w"}' > "$WD/wallet-setup/noid-wallet.json"; echo '{"sealed":"k"}' > "$WD/wallet-setup/eth-key.json"
    W_ENV=()
  }
  wp p1; wrun prepare.sh
  check "prepare.sh (wallet run): exit 0" "0" "$WRC"
  check "prepare.sh (wallet run): new-alice gets the wallet, the payout, the key and the Ethereum payout, and no --alice" "1|0" "$(grep -c "^new-alice --out .*alice.swap.json --wallet $WD/wallet-setup/noid-wallet.json --payout $WNP --eth-key $WD/wallet-setup/eth-key.json --eth-payout $WEP --bob $WNB " "$WD/bin.log")|$(grep -c -- ' --alice ' "$WD/bin.log")"
  check "prepare.sh (wallet run): new-alice gets Alice's own Ethereum key address as the receiver and Bob's address as the sender" "1" "$(grep -c -- "--eth-receiver $WEA --eth-sender $WEB " "$WD/bin.log")"
  check "prepare.sh (wallet run): Bob's file is not made here and no definition for a wallet CLI is made" "0|0" "$(grep -c '^new-bob' "$WD/bin.log")|$(grep -c '^alice-params' "$WD/bin.log")"
  check "prepare.sh (wallet run): once the swap file shows the wallet, the key and the payouts, the standalone sealed files are deleted" "no|no" "$([ -e "$WD/wallet-setup/noid-wallet.json" ] && echo yes || echo no)|$([ -e "$WD/wallet-setup/eth-key.json" ] && echo yes || echo no)"
  check_has "prepare.sh (wallet run): says the keys are sealed in the swap file and to back it up" "BACK UP $WD/alice.swap.json" "$WOUT"
  check_has "prepare.sh (wallet run): says what comes next (Bob's join, then the deposits)" "Bob runs join.sh with the bundle" "$WOUT"
  check "prepare.sh (wallet run): the bundle is written and no key is anywhere" "yes|0" "$([ -s "$WD/alice.bundle.json" ] && echo yes || echo no)|$(wleak)"
  wp p2; W_ENV=(STUB_SEAL_NOIDPAYOUT=o1selftestsomeotherpayoutxxxxxx); wrun prepare.sh
  check "prepare.sh (wallet run): the swap file shows another NOID payout than the settings: exit 6, the standalone files are KEPT" "6|yes|yes" "$WRC|$([ -e "$WD/wallet-setup/noid-wallet.json" ] && echo yes || echo no)|$([ -e "$WD/wallet-setup/eth-key.json" ] && echo yes || echo no)"
  wp p3; W_ENV=(STUB_SEAL_ETHADDR="0x$(printf '5a%.0s' $(seq 1 20))"); wrun prepare.sh
  check "prepare.sh (wallet run): the swap file shows another Ethereum key address than wallet-setup.sh made: exit 6, files kept" "6|yes" "$WRC|$([ -e "$WD/wallet-setup/eth-key.json" ] && echo yes || echo no)"
  wp p4; W_ENV=(STUB_SEAL_ETHPAYOUT="0x$(printf '5a%.0s' $(seq 1 20))"); wrun prepare.sh
  check "prepare.sh (wallet run): ... or another Ethereum payout: exit 6, files kept" "6|yes" "$WRC|$([ -e "$WD/wallet-setup/eth-key.json" ] && echo yes || echo no)"
  wp p5; rm "$WD/wallet-addresses.txt"; wrun prepare.sh
  check "prepare.sh (wallet run): no addresses file (wallet-setup.sh did not run): exit 2, new-alice never runs" "2|0" "$WRC|$(grep -c '^new-alice' "$WD/bin.log")"
  wp p6; rm "$WD/wallet-setup/eth-key.json"; wrun prepare.sh
  check "prepare.sh (wallet run): a sealed standalone file is missing: exit 2, new-alice never runs" "2|0" "$WRC|$(grep -c '^new-alice' "$WD/bin.log")"
  wp p7 -ETH_PAYOUT; wrun prepare.sh
  check "prepare.sh (wallet run): no ETH_PAYOUT: exit 2, new-alice never runs" "2|0" "$WRC|$(grep -c '^new-alice' "$WD/bin.log")"
  wp p8 -NOID_PAYOUT; wrun prepare.sh
  check "prepare.sh (wallet run): no NOID_PAYOUT: exit 2, new-alice never runs" "2|0" "$WRC|$(grep -c '^new-alice' "$WD/bin.log")"
  wp p9; : > "$WD/alice.swap.json"; wrun prepare.sh
  check "prepare.sh: a swap file already exists: exit 3, new-alice never runs, the standalone files are untouched" "3|0|yes" "$WRC|$(grep -c '^new-alice' "$WD/bin.log")|$([ -e "$WD/wallet-setup/eth-key.json" ] && echo yes || echo no)"
  # the classic run is unchanged: --alice, Bob's file, the definition
  wenv pc 'LOCK_KIND=poseidon' "ALICE_NOID=$WNA" "ALICE_ETH=$WEA" -USE_SWAP_WALLET; W_ENV=(); wrun prepare.sh
  check "prepare.sh (classic run): exit 0, new-alice gets --alice and no wallet flag, Bob's file and the definition are made" "0|1|0|1|1" "$WRC|$(grep -c -- "^new-alice --out .*alice.swap.json --alice $WNA --bob " "$WD/bin.log")|$(grep -c -- '--wallet\|--eth-key' "$WD/bin.log")|$(grep -c '^new-bob' "$WD/bin.log")|$(grep -c '^alice-params' "$WD/bin.log")"

  # --- lock.sh, reveal.sh, refund-eth.sh (wallet run): the key is piped from swap-cli ethkey emit into live.js --key-stdin
  wl2() { local n=$1; shift; wf "$n" ${@+"$@"}; : > "$WD/bob/bob.swap.json"; }
  wl2 k1 STUB_ROLE=bob; wrun lock.sh --dry-run
  check "lock.sh --dry-run (wallet run): exit 0, live.js lock gets --key-stdin and --dry-run, no --key-file" "0|1|0" "$WRC|$(grep -c -- '^scripts/live.js lock --swap .*bob.swap.json --key-stdin --chain-id 11155111 --dry-run|pass=0$' "$WD/node.log")|$(grep -c -- '--key-file' "$WD/node.log")"
  check "lock.sh --dry-run (wallet run): the key arrived on stdin, from swap-cli ethkey emit of Bob's swap file with the passphrase; node never had the passphrase" "1|1|0" "$(grep -c '^stdin: key ok' "$WD/node.log")|$(grep -c '^ethkey emit .*bob.swap.json|pass=1$' "$WD/bin.log")|$(grep -c '|pass=1$' "$WD/node.log")"
  check "lock.sh --dry-run (wallet run): no key anywhere" "0" "$(wleak)"
  wl2 k2 STUB_EMIT_RC=1; wrun lock.sh --dry-run
  check "lock.sh --dry-run (wallet run): the key cannot be emitted: exit 2, nothing was sent, no result file" "2|0" "$WRC|$(ls "$WD" | grep -c '^eth-lock-[0-9]*\.json$')"
  check_has "lock.sh (wallet run): ... and says so in the words the console reads" "lock REFUSED, nothing sent" "$WOUT"
  wl2 k3 -USE_SWAP_WALLET; wrun lock.sh --dry-run
  check "lock.sh --dry-run (classic run): the key file is BOB_KEY, no --key-stdin and no swap-cli call (unchanged)" "1|0|0" "$(grep -c -- '--key-file keys/bob.key' "$WD/node.log")|$(grep -c -- '--key-stdin' "$WD/node.log")|$(grep -c . "$WD/bin.log")"
  if [ -f "$PC/stub-go.json" ]; then
    wl2 k4 STUB_ROLE=bob STUB_TICK="$PC/stub-go.json"; wrun lock.sh
    check "lock.sh (wallet run, send): the fresh tick offers the lock: live.js lock runs once with --key-stdin and the approval of that tick; exit 0" "0|1|1|1" "$WRC|$(grep -c -- '--key-stdin' "$WD/node.log")|$(grep -c -- '--approved-intent 1762000000' "$WD/node.log")|$(grep -c '^stdin: key ok' "$WD/node.log")"
    check "lock.sh (wallet run, send): the passphrase went to swap-cli (the tick, the key) and never to node" "0" "$(grep -c '|pass=1$' "$WD/node.log")"
  fi
  wl2 k5 STUB_ROLE=alice; : > "$WD/alice.swap.json"; wrun reveal.sh --dry-run
  check "reveal.sh --dry-run (wallet run): exit 0, claim gets --key-stdin and --dry-run, no --secret-stdin, one line on stdin (the key)" "0|1|0|1" "$WRC|$(grep -c -- '^scripts/live.js claim --swap .*alice.swap.json --key-stdin --chain-id 11155111 --dry-run|pass=0$' "$WD/node.log")|$(grep -c -- '--secret-stdin' "$WD/node.log")|$(grep -c '^stdin: key ok' "$WD/node.log")"
  check "reveal.sh --dry-run (wallet run): swap-cli emitted the key from Alice's swap file, and gave no secret" "1|0" "$(grep -c '^ethkey emit .*alice.swap.json|pass=1$' "$WD/bin.log")|$(grep -c '^secret' "$WD/bin.log")"
  wrun reveal.sh
  check "reveal.sh (wallet run, real): exit 0, claim gets --key-stdin --secret-stdin" "0|1" "$WRC|$(grep -c -- '--key-stdin --secret-stdin\|--chain-id 11155111 --secret-stdin' "$WD/node.log")"
  check "reveal.sh (wallet run, real): stdin is exactly the key and then the secret (the stub node read both, in that order)" "1|1" "$(grep -c '^stdin: key ok' "$WD/node.log")|$(grep -c '^stdin: secret ok (second line)' "$WD/node.log")"
  check "reveal.sh (wallet run, real): swap-cli emitted the key and the secret from Alice's swap file with the passphrase; node never had it" "1|1|0" "$(grep -c '^ethkey emit' "$WD/bin.log")|$(grep -c '^secret .*alice.swap.json|pass=1$' "$WD/bin.log")|$(grep -c '|pass=1$' "$WD/node.log")"
  check "reveal.sh (wallet run, real): neither the key nor the secret is in any file, the output or an argv" "0" "$(wleak)"
  wl2 k6 STUB_EMIT_RC=1; : > "$WD/alice.swap.json"; wrun reveal.sh
  check "reveal.sh (wallet run, real): the key cannot be emitted: exit 2, the secret is never emitted, nothing was sent" "2|0" "$WRC|$(grep -c '^secret' "$WD/bin.log")"
  wrun reveal.sh --dry-run
  check "reveal.sh --dry-run (wallet run): the key cannot be emitted: exit 2" "2" "$WRC"
  wl2 k7 -USE_SWAP_WALLET; : > "$WD/alice.swap.json"; wrun reveal.sh --dry-run
  check "reveal.sh --dry-run (classic run): the key file is ALICE_KEY and no --key-stdin (unchanged)" "1|0|0" "$(grep -c -- '--key-file keys/alice.key' "$WD/node.log")|$(grep -c -- '--key-stdin' "$WD/node.log")|$(grep -c . "$WD/bin.log")"
  wl2 k8 STUB_ROLE=bob; wrun refund-eth.sh --dry-run
  check "refund-eth.sh --dry-run (wallet run): exit 0, refund gets --key-stdin --dry-run and the key on stdin" "0|1|1" "$WRC|$(grep -c -- '^scripts/live.js refund --swap .*bob.swap.json --key-stdin --chain-id 11155111 --dry-run|pass=0$' "$WD/node.log")|$(grep -c '^stdin: key ok' "$WD/node.log")"
  wrun refund-eth.sh
  check "refund-eth.sh (wallet run, real): exit 0, no --dry-run, the key piped, node never had the passphrase" "0|0|1|0" "$WRC|$(grep -c -- '--dry-run' "$WD/node.log")|$(grep -c '^stdin: key ok' "$WD/node.log")|$(grep -c '|pass=1$' "$WD/node.log")"
  check "refund-eth.sh (wallet run): no key anywhere" "0" "$(wleak)"
  wl2 k9 STUB_EMIT_RC=1; wrun refund-eth.sh
  check "refund-eth.sh (wallet run): the key cannot be emitted: exit 2, nothing was sent" "2|0" "$WRC|$(ls "$WD" | grep -c '^eth-refund-[0-9]*\.json$')"
  wl2 k10 -USE_SWAP_WALLET; wrun refund-eth.sh --dry-run
  check "refund-eth.sh --dry-run (classic run): the key file is BOB_KEY (unchanged)" "1|0" "$(grep -c -- '--key-file keys/bob.key' "$WD/node.log")|$(grep -c -- '--key-stdin' "$WD/node.log")"
fi
# --- join.sh (Bob, wallet run), through the harness of section (17)
if [ -n "${JBUN:-}" ] && [ -n "${WB:-}" ]; then
  cat > "$TMP/joinstub2" <<STUB
#!/bin/sh
# the join stub of section (17) with the one command a wallet run adds: swap-cli ethkey address FILE (the address and payout sealed in the swap file)
if [ "\$1" = ethkey ] && [ "\$2" = address ]; then printf '{\n  "address": "%s",\n  "payout": "%s",\n  "role": "bob"\n}\n' "\$STUB_EA" "\$STUB_EP"; exit 0; fi
exec "$TMP/joinstub" "\$@"
STUB
  chmod +x "$TMP/joinstub2"
  JW_SKIP=""
  jw_pre() {
    { echo "USE_SWAP_WALLET='1'"; case "$JW_SKIP" in *payout*) ;; *) echo "ETH_PAYOUT='$WEP'" ;; esac; } >> "$JD/env.local.sh"
    case "$JW_SKIP" in *addresses*) ;; *) printf 'ROLE=bob\nBOB_ETH=%s\n' "$WEB" > "$JD/wallet-addresses.txt" ;; esac
    case "$JW_SKIP" in *keyfile*) ;; *) mkdir -p "$JD/wallet-setup"; echo '{"sealed":"k"}' > "$JD/wallet-setup/eth-key.json" ;; esac
  }
  JPRE='jw_pre'
  join_run wallet BIN="$TMP/joinstub2" STUB_EA="$WEB" STUB_EP="$WEP" -BOB_ETH -- "$JBUN" "$JREC"
  check "join.sh (wallet run): exit 0 although BOB_ETH is not assigned in env.local.sh (it is the swap key's, from the addresses file)" "0" "$JRC"
  check "join.sh (wallet run): new-bob gets the sealed key file and the payout, and the address of the addresses file as the sender" "1|1|1" "$(printf '%s\n' "$JARGV" | grep -c -- "--eth-key|$JD/wallet-setup/eth-key.json|--eth-payout|$WEP|")|$(printf '%s\n' "$JARGV" | grep -c -- "--eth-sender|$WEB|")|$(printf '%s\n' "$JARGV" | grep -c -- '--eth-key|' )"
  check "join.sh (wallet run): once the swap file shows the key and the payout, the standalone key file is deleted" "no" "$([ -e "$JD/wallet-setup/eth-key.json" ] && echo yes || echo no)"
  check_has "join.sh (wallet run): ... and Bob is told to back the file up" "BACK UP $JD/bob/bob.swap.json" "$JOUT"
  check_has "join.sh (wallet run): his Ethereum address in the terms block is the swap key's" "your Ethereum address:  $WEB" "$JOUT"
  JPRE='jw_pre'; join_run walletmis BIN="$TMP/joinstub2" STUB_EA="$WEB" STUB_EP="0x$(printf '5a%.0s' $(seq 1 20))" -BOB_ETH -- "$JBUN" "$JREC"
  check "join.sh (wallet run): the swap file shows another payout than ETH_PAYOUT: exit 10, the standalone key file is KEPT" "10|yes" "$JRC|$([ -e "$JD/wallet-setup/eth-key.json" ] && echo yes || echo no)"
  JPRE='jw_pre'; join_run walletmis2 BIN="$TMP/joinstub2" STUB_EA="0x$(printf '5a%.0s' $(seq 1 20))" STUB_EP="$WEP" -BOB_ETH -- "$JBUN" "$JREC"
  check "join.sh (wallet run): the swap file shows another key address than the addresses file: exit 10, key file kept" "10|yes" "$JRC|$([ -e "$JD/wallet-setup/eth-key.json" ] && echo yes || echo no)"
  JW_SKIP=addresses; JPRE='jw_pre'; join_run walletnoaddr BIN="$TMP/joinstub2" STUB_EA="$WEB" STUB_EP="$WEP" -BOB_ETH -- "$JBUN" "$JREC"; JW_SKIP=""
  check "join.sh (wallet run): no addresses file: exit 2, new-bob never runs, nothing is written" "2||none" "$JRC|$JARGV|$(jnone)"
  JW_SKIP=keyfile; JPRE='jw_pre'; join_run walletnokey BIN="$TMP/joinstub2" STUB_EA="$WEB" STUB_EP="$WEP" -BOB_ETH -- "$JBUN" "$JREC"; JW_SKIP=""
  check "join.sh (wallet run): no sealed key file: exit 2, new-bob never runs" "2|" "$JRC|$JARGV"
  JW_SKIP=payout; JPRE='jw_pre'; join_run walletnopayout BIN="$TMP/joinstub2" STUB_EA="$WEB" STUB_EP="$WEP" -BOB_ETH -- "$JBUN" "$JREC"; JW_SKIP=""
  check "join.sh (wallet run): no ETH_PAYOUT: exit 2, new-bob never runs" "2|" "$JRC|$JARGV"
  join_run classicbobeth BIN="$TMP/joinstub2" -BOB_ETH -- "$JBUN" "$JREC"
  check "join.sh (classic run): a BOB_ETH that is not assigned is still refused (unchanged), exit 2" "2|" "$JRC|$JARGV"
  join_run classicargs BIN="$TMP/joinstub2" -- "$JBUN" "$JREC"
  check "join.sh (classic run): new-bob gets no key flag (unchanged)" "0|0" "$JRC|$(printf '%s\n' "$JARGV" | grep -c -- '--eth-key')"
fi

# ---- (19) the offer board's helpers (piece 3): board-sign.sh, board-verify.sh, board-balance.sh, board-digest.sh, against STUB swap-cli and node only: no real node, no key, nothing is sent.
# The pinned text hashes below are the SAME ones ui/app/test/board-host.test.js pins for signingText() in lib/board/handover.js: the two sides build one text.
echo
echo "---- (19) the offer board's helpers against stubs"
if [ -n "${WB:-}" ]; then
  for f in board-sign.sh board-verify.sh board-balance.sh board-digest.sh; do cp "$HERE/$f" "$WB/"; done
  for f in board-sign.sh board-verify.sh board-balance.sh board-digest.sh; do if "$BASH" -n "$HERE/$f" 2>/dev/null; then ok "syntax $f (board)"; else bad "syntax $f (board)"; fi; done
  cat > "$TMP/bbstub" <<'STUB'
#!/bin/sh
# a stub swap-cli for the board helpers: records `ARGV|pass=0/1`, prints the key for `ethkey emit` and a bundle with its check and digest lines for `bundle`
echo "$*|pass=$([ -n "${SWAP_PASSPHRASE:-}" ] && echo 1 || echo 0)" >> "$STUB_DIR/bin.log"
case "$1 ${2:-}" in
"ethkey emit") echo "$STUB_KEY" ;;
"bundle "*)
  [ "${STUB_BUNDLE_RC:-0}" -eq 0 ] || { echo "error: stub bundle refuses" >&2; exit "$STUB_BUNDLE_RC"; }
  echo "bundle check: $(printf '%s' "${STUB_CHECK:-$STUB_DIGEST}" | cut -c1-16) (opening_hex 1398 characters)" >&2
  echo "bundle digest: $STUB_DIGEST" >&2
  [ -z "${STUB_DIGEST2:-}" ] || echo "bundle digest: $STUB_DIGEST2" >&2
  cat "$STUB_BUNDLE" ;;
esac
STUB
  cat > "$TMP/bnstub" <<'STUB'
#!/bin/sh
# a stub node for the board helpers: $1 is scripts/live.js, $2 the command
echo "$*|pass=$([ -n "${SWAP_PASSPHRASE:-}" ] && echo 1 || echo 0)" >> "$STUB_DIR/node.log"
cmd=$2
hex=""; prev=""
for a in "$@"; do [ "$prev" = --message-hex ] && hex=$a; prev=$a; done
case "$cmd" in
sign-message)
  read -r k || k=""
  if [ "$k" = "$STUB_KEY" ]; then echo "stdin: key ok" >> "$STUB_DIR/node.log"; else echo "stdin: key MISSING OR WRONG" >> "$STUB_DIR/node.log"; exit 1; fi
  [ "${STUB_SIGN_RC:-0}" -eq 0 ] || { echo "error: stub sign refuses" >&2; exit "$STUB_SIGN_RC"; }
  case "$hex" in 0x6e6f31642d737761702d763120*) ;; *) echo "error: refusing to sign: the message must start with no1d-swap-v1" >&2; exit 1 ;; esac
  printf '{\n  "address": "%s",\n  "signature": "%s"\n}\n' "$STUB_SIGNER" "$STUB_SIG" ;;
verify-message)
  [ "${STUB_VERIFY_RC:-0}" -eq 0 ] || { echo "error: stub verify fails" >&2; exit "$STUB_VERIFY_RC"; }
  case "$hex" in 0x6e6f31642d737761702d763120*) ;; *) echo "error: the stub got a text that is not ours" >&2; exit 1 ;; esac
  if [ "${STUB_VALID:-true}" = true ]; then printf '{\n  "valid": true,\n  "recovered": "%s"\n}\n' "$STUB_SIGNER"; exit 0; fi
  printf '{\n  "valid": false,\n  "recovered": null\n}\n'; exit 3 ;;
balance)
  [ "${STUB_BAL_RC:-0}" -eq 0 ] || { echo "error: stub balance: the node did not answer" >&2; exit "$STUB_BAL_RC"; }
  [ "${STUB_BAL_GARBAGE:-0}" = 1 ] && { echo "garbage"; exit 0; }
  printf '{\n  "address": "%s",\n  "balanceWei": "%s",\n  "balanceEth": "0.0",\n  "chainId": "11155111",\n  "blockNumber": 123,\n  "nonceLatest": 0,\n  "noncePending": 0\n}\n' "$4" "${STUB_BAL:-5000000000000000}" ;;
esac
STUB
  chmod +x "$TMP/bbstub" "$TMP/bnstub"
  BOF="$(printf 'a1%.0s' $(seq 1 32))"; BTK="$(printf 'b2%.0s' $(seq 1 32))"
  BDG="$(printf 'de%.0s' $(seq 1 32))"; BSIG="0x$(printf '77%.0s' $(seq 1 65))"
  SHA_ADDR="5f5ce8c4bf4fc8f78de9f20f34206a587ccc92a4c67a0b031822746aa20151eb"; SHA_CHK="2ba29de31a3f8850fac7381941805853ea6814b21df80c1f65e8f8411cec4ecb"
  B_BUNDLE="$TMP/bbundle.json"; printf '{"hashlock":"0xaa","params":{"profile":"sepolia"}}\n' > "$B_BUNDLE"
  B_ENV=()
  # bbenv NAME [LINE..]: like bwenv but Alice's addresses file (no BOB_ETH in it: her BOB_ETH is the env.local.sh one, as in a real run)
  # bwenv NAME: a wallet-run folder of Bob (his addresses file, the sealed key file, the handover file), WD
  bwenv() {
    wenv "$@"; printf 'ROLE=bob\nBOB_ETH=%s\n' "$WEB" > "$WD/wallet-addresses.txt"
    mkdir -p "$WD/wallet-setup" "$WD/board" "$WD/pub"; echo '{"sealed":"k"}' > "$WD/wallet-setup/eth-key.json"; echo '{"sealed":"f"}' > "$WD/bob/bob.swap.json"
    printf '{"v":1,"swap_id":"%s","take_key":"%s"}\n' "$BOF" "$BTK" > "$WD/handover-bob.json"
  }
  brun() {
    local s=$1; shift
    : > "$WD/bin.log"; : > "$WD/node.log"
    WOUT=$(env -i HOME="$TMP/home" PATH="$PATH" L="$WD" LIVE_PLATFORM=native BIN="$TMP/bbstub" NODE="$TMP/bnstub" ETH_DIR="$TMP/wethdir" CURL="$TMP/wcurl" \
      STUB_DIR="$WD" STUB_KEY="$WK" STUB_SIGNER="$WEB" STUB_SIG="$BSIG" STUB_DIGEST="$BDG" STUB_BUNDLE="$B_BUNDLE" \
      ${B_ENV[@]+"${B_ENV[@]}"} "$BASH" "$WB/$s" ${1+"$@"} 2>&1 < /dev/null)
    WRC=$?
  }
  bleak() { local n=0; case "$WOUT" in *"$WK"*) n=$((n + 1)) ;; esac; n=$((n + $(grep -rlF -e "$WK" "$WD" 2>/dev/null | grep -c . || true))); echo "$n"; }

  # --- board-sign.sh
  bwenv bs1; B_ENV=(); brun board-sign.sh addresses
  check "board-sign.sh addresses: exit 0" "0" "$WRC"
  check_has "board-sign.sh addresses: the sha256 of the signed text is the pinned one (the console builds the same text)" "board-sign: text-sha256 $SHA_ADDR" "$WOUT"
  check_has "board-sign.sh addresses: the signature and the key's address are printed, then done" "board-sign: signature $BSIG" "$WOUT"
  check_has "board-sign.sh addresses: ... address" "board-sign: address $WEB" "$WOUT"
  check "board-sign.sh addresses: ends with done" "board-sign: done" "$(printf '%s\n' "$WOUT" | tail -n 1)"
  check "board-sign.sh addresses: the key came from the sealed standalone file through the pipe (swap-cli had the passphrase, node did not)" "1|0|1" "$(grep -c "^ethkey emit $WD/wallet-setup/eth-key.json|pass=1\$" "$WD/bin.log")|$(grep -c '|pass=1$' "$WD/node.log")|$(grep -c '^stdin: key ok' "$WD/node.log")"
  check "board-sign.sh addresses: live.js got --key-stdin and a message in hex, never a key file or the text" "1|0" "$(grep -c -- '^scripts/live.js sign-message --key-stdin --message-hex 0x6e6f31642d737761702d763120' "$WD/node.log")|$(grep -c -- '--key-file' "$WD/node.log")"
  check "board-sign.sh addresses: no key anywhere (output, files, argv)" "0" "$(bleak)"
  bwenv bs2; brun board-sign.sh checked
  check "board-sign.sh checked: exit 0 and the pinned text hash (the digest came from swap-cli bundle of Bob's own swap file)" "0|1" "$WRC|$(printf '%s\n' "$WOUT" | grep -c "^board-sign: text-sha256 $SHA_CHK\$")"
  check "board-sign.sh checked: swap-cli bundle ran on Bob's file, and the key was emitted from it" "1|1" "$(grep -c "^bundle $WD/bob/bob.swap.json|pass=1\$" "$WD/bin.log")|$(grep -c "^ethkey emit $WD/bob/bob.swap.json|pass=1\$" "$WD/bin.log")"
  bwenv bs3; rm -f "$WD/handover-bob.json"; brun board-sign.sh addresses
  check "board-sign.sh: no handover file: exit 2, no tool ran" "2|none" "$WRC|$(wnone)"
  bwenv bs4; printf '{"v":1,"swap_id":"nothex","take_key":"%s"}\n' "$BTK" > "$WD/handover-bob.json"; brun board-sign.sh addresses
  check "board-sign.sh: an offer id that is not 64 hex: exit 2, no tool ran" "2|none" "$WRC|$(wnone)"
  bwenv bs5; B_ENV=(STUB_SIGNER="0x$(printf '5a%.0s' $(seq 1 20))"); brun board-sign.sh addresses
  check "board-sign.sh: the key that signed is not BOB_ETH: exit 3, no signature line" "3|0" "$WRC|$(printf '%s\n' "$WOUT" | grep -c '^board-sign: signature')"
  bwenv bs6; B_ENV=(STUB_SIGN_RC=1); brun board-sign.sh addresses
  check "board-sign.sh: live.js refuses: exit 3, nothing reported" "3|0" "$WRC|$(printf '%s\n' "$WOUT" | grep -c '^board-sign: signature')"
  bwenv bs7; B_ENV=(STUB_SIG=0x1234); brun board-sign.sh addresses
  check "board-sign.sh: a signature that is not 65 bytes: exit 3, nothing reported" "3|0" "$WRC|$(printf '%s\n' "$WOUT" | grep -c '^board-sign: signature')"
  bwenv bs8; B_ENV=(STUB_DIGEST2="$(printf 'ee%.0s' $(seq 1 32))"); brun board-sign.sh checked
  check "board-sign.sh checked: two different digest lines: exit 3, nothing signed (node never ran)" "3|0" "$WRC|$(grep -c 'sign-message' "$WD/node.log")"
  bwenv bs9; B_ENV=(); brun board-sign.sh refuse; check "board-sign.sh: another word: exit 2" "2" "$WRC"
  brun board-sign.sh addresses extra; check "board-sign.sh: an extra argument: exit 2" "2" "$WRC"
  bwenv bs10; rm -f "$WD/wallet-setup/eth-key.json"; brun board-sign.sh addresses
  check "board-sign.sh addresses: the sealed key file is gone (after the join): exit 2" "2|none" "$WRC|$(wnone)"
  bwenv bs11 -USE_SWAP_WALLET; brun board-sign.sh addresses
  check "board-sign.sh: a classic run: exit 2, no tool ran" "2|none" "$WRC|$(wnone)"
  bwenv bs12 "BOB_NOID='o1bad;rm'"; brun board-sign.sh addresses
  check "board-sign.sh addresses: a BOB_NOID that is not an address: exit 2, no tool ran" "2|none" "$WRC|$(wnone)"

  # --- board-verify.sh
  bbaddr() { echo "ROLE=alice" > "$WD/wallet-addresses.txt"; }
  bvin() { { printf 'signer %s\nsignature %s\noffer %s\ntake %s\n' "$WEB" "$BSIG" "$BOF" "$BTK"; if [ "$1" = addresses ]; then printf 'bob_noid %s\nbob_sender %s\n' "$WNB" "$WEB"; else printf 'digest %s\n' "$BDG"; fi; } > "$WD/board/verify.in"; }
  bwenv bv1; B_ENV=(); bvin addresses; brun board-verify.sh addresses
  check "board-verify.sh addresses: a valid signature: exit 0, valid true, the pinned text hash, done" "0|1|1|1" "$WRC|$(printf '%s\n' "$WOUT" | grep -c '^board-verify: valid true$')|$(printf '%s\n' "$WOUT" | grep -c "^board-verify: text-sha256 $SHA_ADDR\$")|$(printf '%s\n' "$WOUT" | grep -c '^board-verify: done$')"
  check "board-verify.sh: live.js got the address, the message in hex and the signature; no key, no passphrase" "1|0" "$(grep -c "^scripts/live.js verify-message --address $WEB --message-hex 0x6e6f31642d737761702d763120.* --signature $BSIG|pass=0\$" "$WD/node.log")|$(grep -c '|pass=1$' "$WD/node.log")"
  bwenv bv2; bvin checked; brun board-verify.sh checked
  check "board-verify.sh checked: a valid signature: the pinned text hash" "0|1" "$WRC|$(printf '%s\n' "$WOUT" | grep -c "^board-verify: text-sha256 $SHA_CHK\$")"
  bwenv bv3; bvin checked; B_ENV=(STUB_VALID=false); brun board-verify.sh checked
  check "board-verify.sh: a signature that is not valid is data: exit 0, valid false" "0|1|0" "$WRC|$(printf '%s\n' "$WOUT" | grep -c '^board-verify: valid false$')|$(printf '%s\n' "$WOUT" | grep -c '^board-verify: valid true$')"
  bwenv bv4; bvin checked; B_ENV=(STUB_VERIFY_RC=1); brun board-verify.sh checked
  check "board-verify.sh: live.js fails (exit 1): exit 3, no valid line" "3|0" "$WRC|$(printf '%s\n' "$WOUT" | grep -c '^board-verify: valid')"
  bwenv bv5; B_ENV=(); bvin addresses; sed -i "s|^bob_noid .*|bob_noid o1x'; touch $WD/pwned #|" "$WD/board/verify.in"; brun board-verify.sh addresses
  check "board-verify.sh: a quote and a command in bob_noid: exit 2, the node never ran, nothing was made" "2|0|no" "$WRC|$(grep -c 'verify-message' "$WD/node.log")|$([ -e "$WD/pwned" ] && echo yes || echo no)"
  bwenv bv6; bvin addresses; sed -i 's/^bob_noid .*/bob_noid o1$(touch pwned)aaaaaaaaaaaaaaaaaaaa/' "$WD/board/verify.in"; brun board-verify.sh addresses
  check "board-verify.sh: a command substitution in bob_noid: exit 2, nothing was made" "2|no" "$WRC|$([ -e "$WD/pwned" ] || [ -e "$TMP/wethdir/pwned" ] && echo yes || echo no)"
  bwenv bv7; bvin addresses; { cat "$WD/board/verify.in"; echo "digest $BDG"; } > "$WD/board/v2" && mv "$WD/board/v2" "$WD/board/verify.in"; brun board-verify.sh addresses
  check "board-verify.sh: an extra line: exit 2, the node never ran" "2|0" "$WRC|$(grep -c 'verify-message' "$WD/node.log")"
  bwenv bv8; bvin addresses; printf 'signature %s\nsigner %s\noffer %s\ntake %s\nbob_noid %s\nbob_sender %s\n' "$BSIG" "$WEB" "$BOF" "$BTK" "$WNB" "$WEB" > "$WD/board/verify.in"; brun board-verify.sh addresses
  check "board-verify.sh: lines in another order: exit 2" "2|0" "$WRC|$(grep -c 'verify-message' "$WD/node.log")"
  bwenv bv9; brun board-verify.sh addresses
  check "board-verify.sh: no input file: exit 2" "2" "$WRC"
  bwenv bv10; bvin addresses; mv "$WD/board/verify.in" "$WD/board/real.in"; ln -s "$WD/board/real.in" "$WD/board/verify.in"; brun board-verify.sh addresses
  check "board-verify.sh: the input is a symbolic link: exit 2, the node never ran" "2|0" "$WRC|$(grep -c 'verify-message' "$WD/node.log")"
  bwenv bv11; bvin addresses; sed -i "s/^signature .*/signature 0x12/" "$WD/board/verify.in"; brun board-verify.sh addresses
  check "board-verify.sh: a short signature: exit 2" "2" "$WRC"

  # --- board-balance.sh
  bwenv bb1 "BOB_ETH=$WEB"; bbaddr; B_ENV=(); brun board-balance.sh
  check "board-balance.sh: exit 0 and one validated line, then done" "0|1|1" "$WRC|$(printf '%s\n' "$WOUT" | grep -c "^board-balance: address=$WEB balance_wei=5000000000000000 chain_id=11155111 block=123\$")|$(printf '%s\n' "$WOUT" | grep -c '^board-balance: done$')"
  check "board-balance.sh: live.js balance got the address and nothing else (no key)" "1|0" "$(grep -c "^scripts/live.js balance --address $WEB|pass=0\$" "$WD/node.log")|$(grep -c 'key' "$WD/node.log")"
  bwenv bb2 "BOB_ETH=0xnothex"; bbaddr; brun board-balance.sh; check "board-balance.sh: BOB_ETH that is not an address: exit 2, node never ran" "2|0" "$WRC|$(wl . node.log)"
  bwenv bb3; bbaddr; B_ENV=(STUB_BAL_RC=1); brun board-balance.sh; check "board-balance.sh: the node does not answer: exit 3, no line" "3|0" "$WRC|$(printf '%s\n' "$WOUT" | grep -c '^board-balance: address=')"
  bwenv bb4; bbaddr; B_ENV=(STUB_BAL_GARBAGE=1); brun board-balance.sh; check "board-balance.sh: an answer that is not JSON: exit 3" "3" "$WRC"
  bwenv bb5; bbaddr; B_ENV=(STUB_BAL="12ab"); brun board-balance.sh; check "board-balance.sh: a balance that is not whole decimal digits: exit 3" "3" "$WRC"
  bwenv bb6 -USE_SWAP_WALLET; bbaddr; B_ENV=(); brun board-balance.sh; check "board-balance.sh: a classic run: exit 2" "2" "$WRC"

  # --- board-digest.sh
  bdenv() { bwenv "$1"; cp "$B_BUNDLE" "$WD/alice.bundle.json"; cp "$B_BUNDLE" "$WD/pub/alice.bundle.json"; echo '{"sealed":"a"}' > "$WD/alice.swap.json"; }
  bdenv bd1; B_ENV=(); brun board-digest.sh alice
  check "board-digest.sh alice: exit 0, the whole digest, both files the same as the swap file's bundle, done" "0|1|1|1|1" "$WRC|$(printf '%s\n' "$WOUT" | grep -c "^board-digest: digest $BDG\$")|$(printf '%s\n' "$WOUT" | grep -c '^board-digest: run-file same$')|$(printf '%s\n' "$WOUT" | grep -c '^board-digest: public-file same$')|$(printf '%s\n' "$WOUT" | grep -c '^board-digest: done$')"
  check "board-digest.sh alice: swap-cli bundle ran on Alice's swap file with the passphrase; nothing else" "1|1" "$(grep -c "^bundle $WD/alice.swap.json|pass=1\$" "$WD/bin.log")|$(grep -c . "$WD/bin.log")"
  bdenv bd2; echo '{"hashlock":"0xbb"}' > "$WD/alice.bundle.json"; brun board-digest.sh alice
  check "board-digest.sh alice: another bundle file in the run folder: run-file differs, public-file same" "0|1|1" "$WRC|$(printf '%s\n' "$WOUT" | grep -c '^board-digest: run-file differs$')|$(printf '%s\n' "$WOUT" | grep -c '^board-digest: public-file same$')"
  bdenv bd3; rm -f "$WD/pub/alice.bundle.json"; brun board-digest.sh alice
  check "board-digest.sh alice: no public copy: public-file missing" "0|1" "$WRC|$(printf '%s\n' "$WOUT" | grep -c '^board-digest: public-file missing$')"
  bdenv bd4; B_ENV=(STUB_DIGEST2="$(printf 'ee%.0s' $(seq 1 32))"); brun board-digest.sh alice
  check "board-digest.sh: two different digest lines: exit 3, no digest line" "3|0" "$WRC|$(printf '%s\n' "$WOUT" | grep -c '^board-digest: digest')"
  bdenv bd5; B_ENV=(STUB_CHECK="$(printf 'ee%.0s' $(seq 1 32))"); brun board-digest.sh alice
  check "board-digest.sh: a digest that does not start with the check line's digits: exit 3" "3|0" "$WRC|$(printf '%s\n' "$WOUT" | grep -c '^board-digest: digest')"
  bdenv bd6; B_ENV=(STUB_BUNDLE_RC=1); brun board-digest.sh alice
  check "board-digest.sh: swap-cli bundle fails: exit 3" "3" "$WRC"
  bdenv bd7; rm -f "$WD/alice.swap.json"; B_ENV=(); brun board-digest.sh alice
  check "board-digest.sh: no swap file: exit 2, swap-cli never ran" "2|0" "$WRC|$(wl . bin.log)"
  bdenv bd8; brun board-digest.sh bob
  check "board-digest.sh bob: the digest of Bob's own file, and no file comparison" "0|1|0" "$WRC|$(printf '%s\n' "$WOUT" | grep -c "^board-digest: digest $BDG\$")|$(printf '%s\n' "$WOUT" | grep -c 'run-file')"
  brun board-digest.sh carol; check "board-digest.sh: another role: exit 2" "2" "$WRC"
fi
echo
echo "$PASS ok, $FAILS failed (bash $BASH_VERSION)"
[ "$FAILS" -eq 0 ]
