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
check "fund.sh real: ... the marker has the stage and NO exit line" "yes|no" "$(case "$M1C" in *"stage: calling wallet CLI"*) echo yes;; *) echo no;; esac)|$(case "$M1C" in *"wallet exit"*) echo yes;; *) echo no;; esac)"
fund_again "$FD" "$FO/swap.object.json" "$FH"
check "fund.sh real: ... a rerun is refused (3)" "3" "$FRCX"
check_has "fund.sh real: ... naming the run folder's marker path" "$FD/funded.marker" "$FOUTX"
check_has "fund.sh real: ... naming the object folder's marker path" "$FO/funded-o1stubcontractroot0000.marker" "$FOUTX"
check_has "fund.sh real: ... naming the per-user marker path" "$FH/.noid-swap/funded/o1stubcontractroot0000" "$FOUTX"
check_has "fund.sh real: ... showing the recorded stage" "recorded (run folder): stage: calling wallet CLI" "$FOUTX"
check_has "fund.sh real: ... and the recovery rule" "may or may not have gone out" "$FOUTX"
check "fund.sh real: ... and the wallet CLI was not called again" "1" "$(nfunds)"
check "fund.sh real: two runs in one run folder worked on two different private copies" "2|2" "$(grep -c '^check ' "$FLOG")|$(grep '^check ' "$FLOG" | sort -u | wc -l | tr -d ' ')"
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
# claim_run NAME [VAR=value ...] -- [claim.sh args]: sets COUT (stdout), CRC, CARGV (the stub's argv, one per line)
claim_run() {
  local name=$1; shift
  local d; d=$(mkl "claim-$name"); mkdir -p "$d/rec" "$d/bob"; echo "selftest-passphrase" > "$d/passphrase.txt"
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
claim_run nosub -- --submit
check "claim.sh --submit without NOID_RPC2: no --submit-rpc" "0|1" "$(count_arg --submit-rpc "$CARGV")|$(count_arg --submit "$CARGV")"
claim_run dry NOID_RPC2=http://127.0.0.1:19602 --
check "claim.sh dry run with NOID_RPC2: no --submit-rpc, no --submit" "0|0" "$(count_arg --submit-rpc "$CARGV")|$(count_arg --submit "$CARGV")"
claim_run dryno --
check "claim.sh dry run without NOID_RPC2: no --submit-rpc" "0" "$(count_arg --submit-rpc "$CARGV")"
claim_run long STUB_LINES=100 --
check "claim.sh: output longer than 40 lines is printed whole (line 100 is there)" "1" "$(printf '%s\n' "$COUT" | grep -c '"line100": 100')"
check "claim.sh: ... and the opening_hex lines are still left out" "0" "$(printf '%s\n' "$COUT" | grep -c opening_hex)"

echo
echo "$PASS ok, $FAILS failed (bash $BASH_VERSION)"
[ "$FAILS" -eq 0 ]
