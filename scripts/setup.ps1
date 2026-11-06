# noid-swap: install dependencies and run the Node test suites on Windows (PowerShell).
# The Rust parts (parano1d/harness, equiv, pruv) are best run from WSL2 with scripts/setup.sh.
# Touches no network except npm.
$ErrorActionPreference = "Continue"
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$Result = @{}

Write-Host "== noid-swap setup (Node parts): $Root"
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Write-Host "node not found: install Node >= 21"; exit 1 }
Write-Host ("node " + (node --version))

Write-Host "== eth: npm install && npx hardhat test"
Push-Location "$Root\eth"
npm install --no-audit --no-fund
npx hardhat test
$Result["eth"] = if ($LASTEXITCODE -eq 0) { "OK" } else { "FAIL (exit $LASTEXITCODE)" }
Pop-Location

Write-Host "== btc: npm install && npm test"
Push-Location "$Root\btc"
npm install --no-audit --no-fund
npm test
$Result["btc"] = if ($LASTEXITCODE -eq 0) { "OK" } else { "FAIL (exit $LASTEXITCODE)" }
Pop-Location

if (Get-Command cargo -ErrorAction SilentlyContinue) {
    Write-Host "== cargo found; Rust suites can be run natively (needs VS Build Tools, clang, cmake) or from WSL2:"
    Write-Host "   wsl bash scripts/setup.sh"
} else {
    Write-Host "== cargo not found; run the Rust suites from WSL2: wsl bash scripts/setup.sh"
}

Write-Host ""
Write-Host "== Summary (expected: eth 131 passing, btc 66 passing)"
foreach ($k in @("eth", "btc")) { Write-Host ("  {0,-6} {1}" -f $k, $Result[$k]) }
