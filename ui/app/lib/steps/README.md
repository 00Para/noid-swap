# steps: the bash helpers of `scripts/live/` as JavaScript (piece 4)

Bottom line: a **step** is a function `(ctx, ...) => Promise<{ code, stdout, stderr, files }>` that does what one bash helper does, calling `swap-cli`
and `node eth/scripts/live.js` as child processes with an argument vector (never a shell) and a clean environment. Same tool commands, same refusals,
same exit codes, same files in the run folder, so the console, the gate and the autopilot read what they read today. This folder holds step 4.1: the
shared part (`common.js`) and the read-only steps. The setup steps (4.3) and the spend steps (4.4) add their own sections here. Nothing is wired into
the console yet (4.5). The bash helpers stay for terminal operators; they are not changed.

Scope (design decision 6): wallet runs and the `poseidon` lock only. A step never passes `--mainnet`, never passes `--accept-producer-concentration`
(run.json has neither), and takes its settings from `ctx.settings`, the validated run.json object, never from `env.local.sh`.

## The context

```js
ctx = {
  runDir,          // absolute path of the run folder
  settings,        // the validated run.json object (spec section 6)
  tools: { swapCli: [argv...], liveJs: [argv...], liveJsEnv: {}, ethDir, curl },   // absolute paths, argv prefixes, nothing looked up in PATH
  getPassphrase,   // () => string; throws when there is none. In the program: the vault's `passphraseFor(runDir, run id)` (4.6, see "Passphrase and recovery" below); `passphraseFromFile(runDir)` (reads runDir/passphrase.txt) is for tests and the terminal only
  home,            // default os.userInfo().homedir (the account database, as live.js reads it)
  now,             // () => ms (default Date.now)
  runNumber,       // the N of messages and file names
}
```

Two fields of the program (step 4.5; `lib/stepexec.js` sets them, a step test may set them too; the header of `common.js` says the same):
- `ctx.signal`: an AbortSignal. `startTool` kills the child it started when the signal aborts (the same kill as the time limit) and the step returns its usual
  "did not finish" result. The program gives it ONLY to entries that send nothing (never to a spend or a signing step): a step that started a sender is never abandoned.
- `ctx.notify`: `(kind) => void`, kind `"alert"` or `"alarm"`. `alertHook` and `alarmHook` call it each time they fire (an ALERT line; an ALARM line that passes its latch),
  BEFORE any POST and whether or not `settings.alert_url` is set. It carries no text of the tick. The ALERT / ALARM latch rules do not change. The watch keeps what the ALERT hook saw on the last tick (`alertHook(ctx, text, state)`), so an ALERT line that stays on the next ticks notifies once; a new line, or one back after a quiet tick, notifies again. The POST is not changed by this.
- `childEnv` sets `ETH_RPC_URL` only when `ctx.settings` is an object with a string `eth_rpc`, so `board-verify` can run in a board slot before run.json exists.

Test-only fields, never set by the program: `ctx.stubEnv` (variables added to every child; the stubs learn their log and scenario paths from it),
`ctx.parentEnv` (replaces `process.env` as the source of the allow-list), `ctx.rpcPost(url, body, timeoutMs)` (the Ethereum JSON-RPC call of the log
start), `ctx.alertPost(url, message)` (the alert POST). `stubEnv` may not carry a passphrase, a proxy or `NODE_OPTIONS`.

## What a step returns, and the rules

- `code` is the helper's documented exit code; `null` means "may have been sent" (for the reveal, "the secret may be public").
- A step returns 2 or 3 ("nothing sent") only before the first child that can sign or send has started (design 12.6). The read-only steps here start no
  such child; the rule is for 4.4.
- A step never throws for an expected refusal (`Refusal` inside `guard` becomes `{ code, stderr }`). A programming error may throw.
- `stdout` / `stderr` carry the helper's lines with the same fixed wording wherever the console matches a line (`wallet-status: done`,
  `board-digest: digest ...`, `[ROLE] tick exit N at HH:MM:SS`, `loop-ROLE.txt` lines). Never a passphrase, key or secret.
- `files` are the files written in the run folder, relative, with `/` separators.
- Writes: files 0600, folders 0700 (Windows ignores modes); `wx` where the helper uses `noclobber`.

**Child environment** (built from scratch): `PATH SystemRoot SYSTEMROOT WINDIR TEMP TMP LANG` from the parent; `HOME` and (Windows) `USERPROFILE` = `ctx.home`;
`NOID_SWAP_HOME` = `home/.noid-swap`; `SWAP_PASSPHRASE` only for the swap-cli commands that had it in bash; `ETH_RPC_URL` = `settings.eth_rpc` and
`tools.liveJsEnv` for live.js only. No proxy variable, no `NODE_OPTIONS`, no inherited passphrase. `liveJsEnv` may not carry those either. The runner
refuses to give live.js a passphrase at all. Windows itself adds `HOMEDRIVE HOMEPATH LOGONSERVER SYSTEMDRIVE USERDOMAIN USERNAME` to every child (seen
with a child started from a one-variable environment): they hold no secret and the program does not pass them on.

**The secret pipe.** `runPipeline` starts live.js with a pipe for its stdin and hands that pipe's write end to each emitter (`swap-cli ethkey emit`,
`swap-cli secret`) as its own **stdout**, one after the other, then ends it. The bytes go from swap-cli into live.js and no JavaScript reads them; the
parent never reads that pipe. This was **proven on Windows** with real child processes (a Node child, a .NET child (PowerShell) and a CRT child
(Python) as emitters: live.js's stdin held exactly the lines, in order, and ended). It was not tried with the Rust `swap-cli` (no native Windows
build exists yet, and no cargo here); Linux and macOS are covered by the same test in CI. The fallback of spec section 2 (read into a Buffer, write,
zero) was **not needed** and is not in the code. The first emitter that fails stops the rest (a secret must never be read as the first line) and
live.js still gets its end of input; live.js's own result is returned for the step to judge. If live.js cannot be started no emitter is started.

## Files

| File | What |
|---|---|
| `common.js` | child runner (`runChild`, `startTool`, kill after `limitMs`), `runPipeline`, `childEnv`, `passphraseFromFile`, `nodeFlags`, `walletNoidFlags`, `feeFlags`, `checkFeeSettings`, `reserveFeeFlags`, `fromBlockFlags`, `revealTxFlags`, `tickBase`, `defaultEthFromBlock`, `loadWalletAddresses`, `parties`, `requireParties`, `requireBobTerms`, `requirePayoutSettings`, `walletParse`, `walletStep`, `walletStepReport`, `walletReserve`, `alertHook`, `alarmHook`, `StepOut`, `guard`, `Refusal` |
| `tick.js` | `tick(ctx, role, { args, limitMs })` |
| `watch.js` | `createWatch(ctx, opts)`: the loop object (`start`, `stop`) |
| `walletstatus.js` | `walletStatus(ctx, role)` |
| `boardread.js` | `boardDigest(ctx, role)`, `boardVerify(ctx, purpose)`, `boardBalance(ctx)` |
| `index.js` | one export per step |

## run.json (lib/runsettings.js, step 4.2)

The settings of one swap, written only by the program, replacing the bash file `env.local.sh`. One JSON object, UTF-8, no BOM, at most
64 KB, version 1. Every key of the table in the design notes (33) is required, `null` only where allowed; unknown keys, duplicate keys at
any depth, comments, trailing commas and non-whole numbers are refused. `load(runDir)` returns a frozen object or throws
`RunSettingsError` (a symlink, a non-file, an oversized file or a schema failure); every step then returns 2. Test networks only:
profile `sepolia` or `rehearsal` with a matching `chain_id`; no mainnet fee cap, no producer waiver, no classic-run switch and no tool
path in the schema. Node URLs: `http://` only to 127.0.0.1, ::1 or localhost, otherwise `https://`, no user-info part; the alert URL is
`https` only. Messages name the key, never the value. `canonicalBytes` (keys in the table's order, two-space indent, final newline) is
what the autopilot approval will bind. `write` validates, writes tmp then renames, mode 0600, and with `create` never replaces an
existing run.json. `productionReason(runDir)` reads the raw text and refuses on any `production` value or chain 1 anywhere, and on a
file it cannot read safely or that fails the schema. `migrateFromEnvLocal(runDir, {role})` reads env.local.sh as text (never runs it),
refuses classic runs, `sha256`, `both`, production and any setting run.json does not carry, requires Bob's terms to be assigned
in every case (a default written here would later pass as his agreement), writes the other defaults explicitly, keeps env.local.sh, and never replaces a run.json. The console keeps
reading env.local.sh until step 4.5.

## Table: helper to step (4.1)

| Helper | Step | Exit codes |
|---|---|---|
| `env.sh` | `common.js` | (flag builders return values; refusals are `Refusal(2)`) |
| `tick.sh ROLE [--apply] [--closed-by TXID]` | `tick(ctx, role, { args })` | swap-cli's own (0, 1); 2 nothing was run (a setting, a flag, a tool, no passphrase, another role's step); 124 `limitMs` hit; 127 swap-cli could not be started |
| `watch.sh ROLE [seconds]` | `createWatch(ctx, { intervalMs })` | an object, not a step: `start()` resolves `{ reason: "terminal" \| "stopped" \| "refused", ticks, message }` |
| `wallet-status.sh ROLE` | `walletStatus(ctx, role)` | 0 every part ran and printed `wallet-status: done` (covered or not); 2 a setting or a tool is wrong; 3 a part was refused or failed (`wallet-status: NOT complete`) |
| `board-digest.sh ROLE` | `boardDigest(ctx, role)` | 0; 2; 3 |
| `board-verify.sh PURPOSE` | `boardVerify(ctx, purpose)` | 0 the check ran (`valid true` or `valid false`); 2 usage or input wrong; 3 the tool failed |
| `board-balance.sh` | `boardBalance(ctx)` | 0; 2; 3 |

`common.js` also holds what 4.3 and 4.4 need and the read-only steps use: `walletStep` (`rc` 0, 3, 4, 6, 1 or `null`, see below), `walletReserve`
(`rc` 0 covered, 3 not covered, 1 refused or failed), `defaultEthFromBlock`, `tickBase` (the node flags, log start and reveal tx of a tick or claim).

## Every difference from the bash helpers, and why

Role and settings
- **The role is enforced in the step** (`tick`, the watch loop, `walletStatus`, `boardDigest`): a step for the other role of the run (`settings.role`)
  returns 2 and starts nothing (design 12.4: "the other role's entries are refused"). Bash let any role through.
- Settings are the run.json names (`noid_rpc2`, `single_node_ok`, `alice_noid`, ...), so refusal texts name those, not `NOID_RPC2` and `env.local.sh`.
  `require_parties` / `require_bob_terms` / `require_payout_settings` take the settings object plus the wallet addresses (the file wins for `alice_noid`,
  `alice_eth`, `bob_eth`, as in bash).
- No `--mainnet` fee cap, no producer waiver (the warning about it and the sentence "only ACCEPT_PRODUCER_CONCENTRATION relaxes that" are gone),
  no `LIVE_PLATFORM`, `win_path`, `$PUB`: the public copy is `runDir/pub`.
- `--curl-path` is always passed: `checkTool` refuses (2) a tool, or a `tools.curl`, that is not an absolute path, so swap-cli never looks curl up in `PATH` (bash native mode passed `curl` from `PATH`). The transport stays `curl`.

Flags
- `from_block_flags`: the file `eth-deploy-block.txt` must hold **one whole number** (up to 18 digits); bash took every digit it found (`12abc34` became
  1234). A file that is not a number is a refusal (exit 2) where it would have started the log after a lock; white space only passes nothing.
  Leading zeros are dropped. The stored start in a swap file is read by the same text pattern as bash.
- `reveal_tx_flags`: unchanged (exactly `0x` and 64 hex, white space removed first; else ignored with the same warning).
- `tick` passes on only `--apply` and `--closed-by TXID` (the flags the helpers use), each once; bash passed anything. `--record-noid` and `--record-eth`
  are the helper's; the tick's output files are opened (and emptied) before the tool runs, as bash did.
- `default_eth_from_block` reads the answers as JSON (the node's `result`, an own `error` member fails it) instead of by text patterns, in-process (the URL
  never in an argument vector, `ctx.rpcPost` for tests), no redirect, any non-2xx fails. Same order of calls, same messages (run.json names), fail closed.
  It is for setup (4.3); tested here.

Output
- The summary of `tick` is the helper's, with Python's wording of values (`None`, `True`, `json.dumps` separators and ASCII escapes). Numbers come from
  `JSON.parse`: a float written `5.0` prints `5`, an integer beyond 2^53 loses digits (display only; the console reads the JSON file). A top-level JSON
  that is not an object prints nothing and warns on stderr (python crashed there).
- `tick` ends with exit 124 when `limitMs` is hit (the helper had no limit) and 127 when swap-cli cannot be started (bash: command not found). A signal
  death reports 1.
- The watch loop's merged output is `stderr + stdout` of the tick step; the loop line, its cuts, the terminal rule are watch.sh's. The first tick runs at
  once, then every `intervalMs` after the tick ends. A throwing tick step does not end the loop (it is noted in `lastError`). It never prints
  "all watched files terminal ..." to a terminal: that text is in the result of `start()`.
- ALERT messages: "claim removed by a reorg; do the claim dry run" (bash said `run claim.sh dry run`, a helper the program does not have). The other
  messages are unchanged. The sender is an in-process HTTPS POST (message as the body, 20 s, below 400 is success, no redirect, https only, no user-info,
  the URL never printed and never in an argument vector). A pending message with no `|` is dropped (bash would have sent the digits as the message).
- `board-digest`, `board-verify`, `board-balance` keep the tool's output in memory, not in `.digest-ROLE.out` style files in `board/`. `board-digest`
  needs no passphrase file and passes none: `swap-cli bundle` reads only the public part (the spec says "never bundle"; bash passed it). `board-verify`
  requires every expected line to end with a newline (as bash's `read` did) and refuses any non-blank text after the last expected line (bash checked only
  the first extra line, and not at all when it had no newline); the input must be valid UTF-8. A start failure of live.js is exit 3 with the same text
  shape (`exit 1`).
- `passphraseFromFile` drops trailing `\r` and `\n` (bash dropped trailing newlines only).

Wallet reports
- `walletParse` is the helper's strict check on the JSON text (1 MiB cap, strict UTF-8). JSON numbers must be safe integers (a 5.0 passes, a value above
  2^53 does not); `$` can no longer match before a trailing newline in an address.
- `walletStep` returns `rc` as bash, and `null` where bash gave 1 for a child that did not run to its end in a **real** run (killed, timed out, could not be
  started: "may have been sent"); in a dry run those are 3. Exit 1 remains for "swap-cli ran and its output is not what the table lists".
- `walletReserve` folds in what the spec adds: the field shapes and `keyChecked: true` are required (else `rc` 1 with `parseError`), the exit status
  and `covered` must agree (0 with `covered: false` or 3 with `covered: true` is `rc` 1), an emitter that fails is `rc` 1 whatever live.js said, the output
  files are named by the caller. `walletStatus` prints `the Ethereum reserve: <reason>` for a parse failure and the helper's "could not be read" text for the rest.

## Tests

`ui/app/test/steps-common.test.js`, `steps-read.test.js`, `steps-rules.test.js`; stubs, settings fixture, harness, registry and rules under
`ui/app/test/steps-fixtures/`. The two stub tools (`stub-swap-cli.js`, `stub-live.js`) log one JSON line per call (argv, whether `SWAP_PASSPHRASE` was set
and whether it matched, the names of the environment variables, cwd, the sha256 / length / lines of stdin; never the bytes) and answer from a scenario
file. Ported cases are named `(sN ...)` for the section of `selftest.sh`: 1 fee flags, 2 node flags, 4 reveal tx, 10 watch, 12 producer waiver (now "never
passed") and the alert hook, 13 log start, 14 alarm hook and `from_block_flags`, 16 Bob's terms, 18 the wallet-status cases, 19 the board helpers. Not ported:
bash-only cases (syntax, arrays, `win_path`, platform, the frozen copy), `setup.sh`'s use of the log start (4.3), `reveal_sent_note` (4.4).

**Adding a step to the cross-step rules is one entry in `ui/app/test/steps-fixtures/registry.js`** (name, role, the swap-cli commands that may carry the
passphrase, the documented exit codes, a scenario for the stubs, and cases that together reach every code; `wx` lists the files the step makes with
noclobber). `steps-rules.test.js` runs: no secret in any argument vector, the passphrase only where listed (never live.js), every documented code reachable
and nothing else returned, no `wx` file overwritten, a hostile parent environment (proxy variables, `NODE_OPTIONS`, a `SWAP_PASSPHRASE` already set, an odd
`HOME`) reaching no child, and a canary key and secret in no result, file or call log. It also runs fake steps that break each rule to show the rules can
fail. 4.4 adds the throw / kill / time-out rule for spend steps.

## Setup steps (4.3)

`setup`, `walletSetup`, `prepare` and `join` replace `setup.sh`, `wallet-setup.sh`, `prepare.sh` and `join.sh` for wallet runs and the `poseidon` lock. They make the
swap's wallet keys and its swap file, so each refuses before it writes anything it cannot explain. The tools are the same (`swap-cli wallet new`, `ethkey new`,
`ethkey emit`, `new-alice`, `new-bob`, `wallet address`, `ethkey address`, `status`; `live.js keygen`, `address`), with the helper's flags.

| Helper | Step | Exit codes |
|---|---|---|
| `setup.sh` | `setup(ctx)` | 0; 2 a setting or the folder is wrong, the other role's swap file is in the folder, an old `passphrase.txt` is in the folder, the vault gives no passphrase, a start file is not a plain file, or no log start could be chosen (the folders made before it stay) |
| `wallet-setup.sh ROLE [--dry-run]` | `walletSetup(ctx, role, { dryRun })` | 0; 2 not this run's role, other role's swap file, no passphrase, a tool missing, the wallet-setup folder cannot be made (nothing made); 3 the swap file, the addresses file or half-made wallet files exist (nothing made), or a step failed (its own words are shown, the files made so far stay, the addresses file is not written) |
| `prepare.sh` (poseidon, wallet run) | `prepare(ctx)` | 0; 2 a setting, a tool or a wallet file is wrong; 3 Alice's swap file exists (nothing written, the sealed files untouched); 5 the node gave no usable tip; 6 no bundle came out, or the new swap file does not show the wallet, key and payouts the setup made (the sealed files are KEPT) |
| `join.sh [BUNDLE]` (poseidon, wallet run) | `join(ctx, bundlePath)` | 0; 2 a setting, a tool or an argument is wrong; 3 Bob's swap file exists; 4 alice.bundle.json is not a plain file (or has other content while Bob's swap file exists; with no swap file an earlier copy with other content is moved aside to `alice.bundle.json.refused-<UTC time>`, kept, and the file given is used); 6 no usable bundle; 8 new-bob failed; 9 new-bob exited 0 but its file, check line or digest line is wrong; 10 the swap file does not show the key and payout the setup made (the sealed key file is KEPT) |

Nothing here ever sends to a chain, so the rule "2 or 3 only before the first child that can sign or send" has no case: the codes 3, 5, 6, 8, 9 and 10 come after
files were made, as in the helpers, and each message says what is on disk. The role of the run is enforced (2, nothing started) and so is design 12.4's "a run
folder that holds the other role's swap file is refused".

**Passphrase (4.6).** No step makes or reads a passphrase file any more. `ctx.getPassphrase()` is the vault's `passphraseFor(runDir, run id)`: a value derived from the
install secret and the run id (next section). `setup` asks for it once to see that the vault is ready (exit 2 when it is not), prints `passphrase: from the key store` (never
the value), and refuses (2, nothing made) a folder that still holds an old `passphrase.txt`: that is a run folder of the bash helpers, and the program's import
(`desktop/lib/migrate.js`) seals its passphrase and deletes the clear file. The passphrase goes to `swap-cli` only, and only to the commands that need it: `wallet new`,
`ethkey new`, `ethkey emit`, `new-alice`, `new-bob` (the helpers exported it into the whole script, so `wallet address`, `ethkey address` and `status` had it in
`prepare.sh` and `join.sh`; they do not now). `live.js` never gets it.

**Keys.** `walletSetup` runs `live.js keygen --stdout | swap-cli ethkey new`: `ethkey new` is started with a pipe for its stdin and keygen gets that pipe as its own
stdout (the other way round from `runPipeline`), then the parent ends it. No JavaScript reads the key. The address check is `runPipeline` (`ethkey emit` into
`live.js address --key-stdin --expect ADDRESS`) and must print `"matchesExpected": true`. `wallet-addresses.txt` is written last, with `wx`, 0600. `prepare` and
`join` delete the standalone sealed files only after `wallet address` / `ethkey address` show the setup's addresses and the payouts; otherwise 6 / 10 and they stay.

**Differences from the helpers, and why**
- Settings are run.json: `deploy_block` is a whole number or null (the helper took digits from `DEPLOY_BLOCK` in the environment or `env.local.sh`); `hc_lead` is
  run.json's; Bob's terms are checked as non-null in the object (a default is not his agreement; run.json has none, so the protection rests on whoever writes Bob's run.json: the migration requires every term assigned, and the writers of step 4.5 must take them only from his form or the offer he approved), `bob_eth` aside: it is the swap key's, from
  `wallet-addresses.txt`. A missing term names the run.json key.
- The role: every step refuses (2) for the other role of the run, and refuses a folder that holds the other role's swap file (bash allowed both).
- `setup`: no `platform` text, no listing of the tool files, no `$PUB` copy folder in the run line; the run folder, `bob/`, `rec/` and `pub/` are all made 0700 and
  must be real folders (the helper changed the mode of the run folder only); `eth-deploy-block.txt` must be a plain file (a folder or link there is 2; an empty file is
  chosen again, as `[ ! -s ]` did). A swap file in the folder still means no guess (exit 0, said). The log start's messages go to stderr as in the helper.
- `walletSetup`: the helper's classic-run refusal is gone (always a wallet run). The tools' output is kept in memory, not in `.out1`/`.err1` files in `wallet-setup/`
  (the helper removed them on exit). An address is read as a JSON field, not by a `sed` pattern. If writing the addresses file fails the step removes only a file
  it made itself (the helper ran `rm -f` on whatever was there). The wallet-setup folder must be a real folder (2). No time limits on the tools, as in the helper.
  The refusals of exit 3 are printed on stdout and those of exit 2 on stderr, as in the helper.
- `prepare`: no `sha256` kind (refused, 2, with a pointer to the bash helper), no proof, no receipt, no classic run (no Bob file, no `alice-params`, no object file).
  The tip and the fee estimate are read in-process from `noid_rpc` (JSON-RPC `paranoid_blockCount`, `paranoid_estimateFee [1,1]`, 10 s each, `ctx.rpcPost` in
  tests) instead of `curl` and `python3`; the tip must be a whole number (a JSON number or a decimal string), else exit 5 (the helper let `None` become 0 in shell
  arithmetic); the fee is at least 5,800 and falls back to 5,800 when it cannot be read, as the helper. A sealed wallet file that is a link is refused (2). The
  bundle is written with the same truncation as `>`. A file that cannot be deleted after the seal check is a warning, not a failure. The addresses and payouts of the
  seal check are JSON fields, compared as the helper did (the Ethereum ones without the case of hex digits). "Bob runs join.sh" reads "Bob joins".
- `join`: no receipt (the `sha256` kind is refused, 2; the helper's 7 does not occur), no `python3 -I` (the bundle is read as JSON in-process: strict UTF-8, a whole
  number is a JSON integer, so `5.0` passes where Python saw a float; every character outside printable ASCII in a printed field becomes `?`, one per character). The
  source is read ONCE (a regular file, not a link, 1..1,048,576 bytes) into a temporary copy `.join-bundle.XXXXXXXX` in the run folder (`wx`, removed on every exit);
  the checks use that copy, which is then renamed to `alice.bundle.json` (a different file there is 4). `bundlePath` is an argument (none = `runDir/alice.bundle.json`,
  an empty string is 2); where the path may come from (the board's saved file, a dialog of the main process) is step 4.5's business. `new-bob`'s stdout and stderr go to
  `join-new-bob.out` through one descriptor (the helper's `> file 2>&1`). A `new-bob` that cannot be started or is killed is exit 8 (127 / 1 in its status line). The
  next-step line ends "(the watch loop)", not "(watch.sh bob)". `ethkey address` is not asked for its `role` (the helper did not either).

**Tests.** `ui/app/test/steps-setup.test.js`: section 13 for the log start through `setup`, 17 for `join` (every term, every code, the check and digest lines, control
characters), 18 for `walletSetup`, `prepare` and the wallet paths of `join`; each name says which. One entry per step in `steps-fixtures/registry-setup.js` puts them
under the cross-step rules. `steps-fixtures/stub-swap-cli-setup.js` is the stub of `stub-lib.js` plus `writeOut` (the file named by `--out`, which `new-bob` makes). Real
child processes on Windows carried the two key pipes (keygen into `ethkey new`, `ethkey emit` into `address`); Linux and macOS run the same tests in CI. Not testable on
the Windows machine: folder and file modes (skipped) and a symbolic-link bundle (this user may not make links). Each registry entry names the step it covers (`exports: ["join"]`), which `steps-rules.test.js` reads to be sure no exported step escapes the rules. Step 4.6 changed the passphrase-file cases of `setup` in `steps-setup.test.js` and the `setup` entry of
`registry-setup.js` (the passphrase comes from `ctx.getPassphrase`; a folder with a `passphrase.txt` is refused) and the two back-up texts of `prepare` and `join`; nothing else of these tests changed.

**After the independent read.** Three points were fixed: `prepare` and `join` say to back up the whole run folder (the swap file cannot be opened without
its passphrase, which 4.6 derives from the recovery code); `walletSetup` shows no address before the addresses file is written, not even inside a tool's error text (a deposit to an address
that a restart's advice would delete is lost); the migration of `env.local.sh` requires every one of Bob's terms to be assigned, his swap file or not
(run.json has no defaults, so a default written there would later pass as his agreement; the writers of step 4.5 must take his terms only from his
form or the offer he approved).

**Low points (left, with the step that should take them).**
- `join` and `walletSetup` ask for the passphrase at the start and hold it across the step. Accepted in 4.5/4.6: the program derives it per call and never stores it.
- When deleting the standalone sealed files fails, there is a warning, but the closing line still says they were deleted.
- A failed rename leaves `pub/.alice.bundle.<pid>.tmp`; a stale `pub/alice.bundle.json` from an earlier attempt stays beside the warning.
- `loadWalletAddresses` ignores the `ROLE=` line; `prepare` and `join` could refuse a file of the other role.
- `defaultRpcPost`'s limit is an idle-socket limit, not a total one as `curl -m` was; a node that drips bytes can hold the step.
- No child has a time limit (as in bash); the console (4.5) owns stopping a hung step.
- `join-new-bob.out` is opened with `w` and follows a link placed there (bash `>` does the same).
- `parties()` falls back to settings for the other role's addresses; safe only because the schema forces the own role's to null.
- Alice's `bundle check:` line is printed without checking its shape (the board uses `boardDigest`).
- For 4.5: the board host skips `prepare`/`join` when the swap file exists; a stop after a refused `prepare` (6) or `join` (9, 10) but before the
  host records it hands over the digest of a refused file on restart. The step should leave a marker, or the host record before it acts.
- The hashlock registry moves from the WSL home to the Windows home: the import of an old run folder (4.6) appends the old `hashlocks.txt` lines when the person gives the old `.noid-swap` folder; when they do not, the new run folder's `import.json` says "the old lock records were not imported".
- When `wallet new` printed no readable address, `noid-wallet.json` exists but is not listed in `files`.
- Bob's own `eth_payout` is not among the terms printed for him to check before `new-bob` (bash prints the same list).
- FIXED (final pass, R410-2): a copy of Alice's file that `new-bob` had refused stayed in Bob's run folder as `alice.bundle.json` and blocked the right file (exit 4). While Bob has no swap
  file, a copy with other content is now moved aside to `alice.bundle.json.refused-<UTC time>` (kept, never deleted; a counter follows if the name is taken), the step says so by file name,
  and the file given is used. With Bob's swap file (exit 3 comes first) and for a destination that is not a plain file (4) nothing changes. The registry no longer has a `wx` rule for that file.
- New (final pass, left): the refused copies stay in the run folder (`alice.bundle.json.refused-*`); nothing lists or removes them, and the step's file list names only the one made by that run.
- New (final pass, left): in a real reveal the exit-1 line says "MAY BE PUBLIC" even when live.js refused before it could send; a `sent:` line is the only proof it was broadcast, and its absence is not proof it was not.

## Passphrase and recovery (4.6)

The swap file keeps its format: `swap-cli` seals the swap's secrets with a passphrase (Argon2id and XChaCha20-Poly1305). What changes is where the passphrase comes from.
There is no `passphrase.txt`. One **install secret** S (32 random bytes, made at the program's first start) is sealed by the system key store (Windows DPAPI, macOS Keychain) behind a port
(`desktop/lib/vault.js`), and every passphrase is derived from it:

```
K(L, R)       = HMAC-SHA256(key = S, message = ASCII("no1d-swap/v1/" + L + "/" + R))     L: swap-passphrase | board | migrated-passphrase     R: the run id
passphrase(R) = lower-case hex of K("swap-passphrase", R)                               64 characters, the SWAP_PASSPHRASE of swap-cli
```

The run id is the `run_id` of `run.json` (32 lower-case hex characters), never the folder's name, so a moved folder still opens. An imported swap (a folder of the bash helpers) keeps its OLD
passphrase: it is sealed into `passphrase.sealed` in the run folder under `K("migrated-passphrase", R)` (AES-256-GCM, the label, the run id and the file name bound as additional data), and
`passphraseFor` returns that instead of the derived one. `vault-check.json` in each run folder (16 hex characters of an HMAC of S) tells which installation made it: another installation's folder
is refused with a sentence, not opened with a wrong passphrase. The board's messaging keys (`board-keys.json`) are sealed the same way (label `board`).

**The recovery code** is S written for a person: 35 bytes (`01`, S, a CRC-16) as 56 characters of Crockford base32 in 14 groups of 4. It is shown once at the first start, in a window of the
program (never on the console page or through its API), and three groups of it must be typed back before any new swap. Restoring on a new machine is: the code, plus the run folders.

**By hand, without the program** (a person who has the code and a run folder, and a `swap-cli`):

```sh
RUN_ID=$(node -e 'console.log(JSON.parse(require("fs").readFileSync("run.json","utf8")).run_id)')
SECRET_HEX=$(node desktop/tools/recovery.js secret)          # reads the recovery code from stdin, prints the 64-hex secret
printf '%s' "no1d-swap/v1/swap-passphrase/$RUN_ID" | openssl dgst -sha256 -mac HMAC -macopt hexkey:$SECRET_HEX
# then: SWAP_PASSPHRASE=<that hex> swap-cli <command> ...
```

`node desktop/tools/recovery.js passphrase <run folder>` does the last part itself, and opens `passphrase.sealed` when the folder has one (an imported swap). The code is read from standard input
only, never from an argument. The test vectors are in `desktop/test/derive.test.js` and `recoverycode.test.js` (the secret `00 01 ... 1f`, which is public: never use it for a real install).

**Restore rules** (fix round 1). The vault decides from what is on disk, not only from memory. With run folders present (`runs/*`, `runs/.ended/*`, `runs/.importing/*`) and no sealed secret, the
first start makes NO new secret: the vault is `locked` with "restore with your recovery code". A restore never replaces a secret that a run folder still uses (also when the vault is locked: the
current key check is read from `vault/key-check.json`), and an old secret file is renamed aside (`install-secret.v1.<ms>.old`), never deleted. The import refuses a `passphrase.txt` that holds a
carriage return, a NUL or non-UTF-8 bytes (bash passed such a file on exactly; a wrong guess would delete the only copy) and strips trailing newlines only.

**Low points (4.6)** (from the independent read; "fixed" = fixed in fix round 1, the rest are left for the final pass with my view).
1. Restore with the vault's own code did not mark the code confirmed: fixed.
2. Restore's reference checks skipped `runs/.ended/*` and `runs/.importing/*`: fixed (they count now).
3. A restore over a fresh unused secret orphans `vault/board-invite.sealed`: left; the invite is entered again, and it controls no coins.
4. `runChecks` and `runCheckOf` used different shape rules: fixed (one shape).
5. `passphraseFor` derives when `passphrase.sealed` is missing even in an imported folder (`import.json` present): left; nothing is lost, the error is only misleading; the console server could read `import.json` for a sharper text.
6. The back-up text names the swap file and run.json, not `passphrase.sealed`: left; the text says "the whole run folder", which holds it; a wording change touches the pinned test regexes.
7. By-hand recipe gaps (working folders, the installed-binary form, openssl's `SHA2-256(stdin)= ` prefix): left for `desktop/README.md` and the help, where the integrator copies it; the prefix is cut with `awk '{print $NF}'`.
8. The openssl line gives the wrong passphrase for an imported folder: left; to be written next to it ("imported folder: use `recovery.js passphrase <folder>`").
9. The recipe puts the secret hex in openssl's argument vector: left; `recovery.js passphrase` avoids it and is the advised form; the hex only shows in the process list of a machine whose owner typed the code.
10. The by-hand section is not yet in `desktop/README.md` or the help: left to the integration of the shell (its README and help).
    Points 7 to 10 were answered at integration (2026-11-18): `desktop/README.md`, section "By hand, without the program", gives the advised form (`recovery.js passphrase`, the code on standard input, both kinds of folder) with absolute folder variables, names the program's own `swap-cli`, keeps the openssl form only as a check (the prefix cut with `awk`, its two limits said), and the help points to it.
11. The secret window has no `askChoice`: left; an import whose role neither a swap file nor `UI_ROLE` tells refuses with a sentence (the shell to add the method).
12. A failed `unlinkSync` removed the new folder without checking the file: fixed (the new folder stays when the file is already gone, with a warning).
13. A crash between the rename and the delete of the original's `passphrase.txt` leaves both, and a re-import makes a second folder: left; the note is written after the delete; a pre-delete marker would close it (small, not needed at rest).
14. The old folder's `board-keys.json` stays plain in the original: left (spec seals the copy only; a messaging key controls no coins).
15. `hashlocks.txt` is appended in place: left (spec says the append flag); a partial last line reads as no match.
16. A registry line `<hash> <x>` with a junk second field is dropped as "not matching": left; `swap-cli` also reads it as matching no role, so it never protected anything.
17. `normalise` folded `ß` to `SS`: fixed (ASCII letters only).
18. Copies of S in `Buffer.from(S)` for the key store and the hex string in `keystore-electron.js` are not zero-filled: left; JavaScript strings cannot be wiped, and the key store call needs the bytes.
19. The CREATOR OWNER flag check splits flags into pairs without checking them: left; harmless, the trustee check still applies.
20. `makeOwnerOnlyDir` runs `icacls /inheritance:r` on the data folder at every start: left; it repairs loosened ACLs silently (a reader of the log would want a note, there is no log).
21. `stepexec.js` falls back to the folder id when `run_id` is missing (the server's code); the set enforces `run_id` equals the folder name, so it is harmless; the rule says refuse.
22. `askNewPassphrase` compares before NFC normalisation: left; the unsafe direction does not exist (two equal-looking entries are refused, never accepted wrongly).
23. `steps-setup.test.js` changed beyond the passphrase-file cases (every setup test passes `withVault`): accepted; the harness makes a `passphrase.txt` the new setup refuses.

What the key store protects and what it does not: it stops another user account, a stolen disk and a copied run folder. It does not stop a program that runs as the same user (it can ask the key
store, or read a child's environment): the same limit the passphrase file had.

## Spend steps (4.4)

Bottom line: eight steps that move real coins, publish Alice's secret or sign for the board, each the JavaScript of one bash helper (wallet runs, the `poseidon` lock, the
tool's own keys). The tool command lines are the helpers'; every refusal, file and line the console reads is kept; the codes follow one rule (below). Nothing is wired into
the console yet (4.5). Shared code: `spendcommon.js` (the guard, the code table, the judgement of a live.js child, small file helpers, `runWalletStep`); the steps:
`lock.js`, `reveal.js`, `claim.js`, `refundeth.js`, `walletfund.js`, `walletrecover.js`, `walletsweep.js`, `boardsign.js`; exports in `spendsteps.js`.

| Helper | Step | Options |
|---|---|---|
| `lock.sh [--dry-run]` | `lock(ctx, { dryRun })` | `replace` is refused (2) |
| `reveal.sh [--dry-run] [--replace [TX]]` | `reveal(ctx, { dryRun, replace })` | `replace`: `true`, or a hash (`0x` and 64 hex) |
| `claim.sh [--submit]` | `claim(ctx, { submit })` | `submit` is the only thing that can send |
| `refund-eth.sh [--dry-run] [--replace [TX]]` | `refundEth(ctx, { dryRun, replace })` | as the reveal |
| `wallet-fund.sh [--dry-run]` | `walletFund(ctx, { dryRun })` | |
| `wallet-recover.sh [--dry-run or --record]` | `walletRecover(ctx, { dryRun, record })` | not both |
| `wallet-sweep.sh noid or eth ROLE [--dry-run]` | `walletSweep(ctx, kind, role, { dryRun })` | `noid` is Alice's (role omitted or `"alice"`) |
| `board-sign.sh addresses or checked` | `boardSign(ctx, kind)` | |

Each step refuses (2, nothing started) when `settings.role` is not its role, when an option is unknown or of the wrong kind, when there is no passphrase, no swap file or no tool, and
when a fee tip has no cap (the Ethereum spends: the fee check runs first, as in section 0 of the self-test).

**The code rule** (spec section 3, design 12.6). A step returns 2 or 3 ("nothing sent") only before the first child that can send has been started. A **sender** is a child started
without `--dry-run`: `live.js` lock / claim / refund / sweep, `swap-cli wallet fund|recover|sweep --submit`, `swap-cli claim --submit`; `live.js sign-message` counts (it signs). The step
sets its sender flag right BEFORE the call. From then on an exception (a refusal too), a kill, a time-out or a start error returns `code: null` ("may have been sent"; for the reveal "the
secret may be public") and one fixed line that never carries the error's text. A child that ran to its end is judged by its own exit code and output, as the helper judged it, and may
then give only the codes of the table; two of them (the Ethereum sweep's 3 and the wallet steps' 3) need the tool's OWN evidence, not a bare exit status:
- Ethereum sweep: 3 after live.js ran only in a DRY run, and only for exit 1 + live.js's own `error:` line + no `sent:` line + no result file (a killed live.js, on Windows exit 1 with no signal, has no `error:` line, so it is 1). A REAL sweep that ended in an error with no `sent:` line is 1, unknown: live.js prints `sent:` only after the send call returned, and the node may have taken the transaction before that call failed (a timed-out answer, a 429 or 503 on a parallel read). The emitter's words go to their own `.emit.err` file, so a swap-cli `error:` line is never read as live.js's. This is stricter than `wallet-sweep.sh`, which gives 3 there.
- Wallet steps: 3 after `--submit` only for the tool's report `not_sent`, or exit 1 with its own `error:` line and no output. Exit 1 with nothing printed and no `error:` line is null
  (`common.walletStep` says 3 there; a killed `swap-cli` on Windows looks like it).
- A dry run starts no sender, so it is never "may have been sent": a dry run that did not finish is 1 (live.js, claim) or 3 (wallet steps, as `walletStep`); a throw there is 2.
- Every 2 or 3 the step returns itself prints `<label> REFUSED, nothing sent: <reason>` on stdout (`lock REFUSED, nothing sent` for the lock's 3, which `exitcodes.js` needs); the wallet steps'
  3 after swap-cli ran prints it only when the tool did not say `sent` or `maybe_sent`.
- live.js is started BEFORE the key emitter (the pipe), so a failed key or secret emit no longer gives 2 as in bash: live.js's result file and `sent:` line are kept and it is judged by
  its own answer; an emit that failed while live.js says 0 is null.

**Every code each step can return** (`spendcommon.js` `CODE_TABLE`; `steps-spend.test.js` pins this table against the code and against this README):

| Step | Code | Meaning |
|---|---|---|
| `lock` | 0 | live.js lock finished: a dry run was built, or the lock was sent and mined (eth-lock-N.json) |
| `lock` | 1 | live.js lock ended on its own error: it may or may not have sent (read eth-lock-N.err for a `sent:` line); NOT 'nothing sent' |
| `lock` | 2 | refused before any child was started: a setting, a tool, the role, the fee settings, no passphrase, no swap file, `replace` |
| `lock` | 3 | REFUSED by the fresh pre-send tick, nothing sent: it failed, did not finish in time, or does not show a lock to send (`lock REFUSED, nothing sent`) |
| `lock` | null | may have been sent: live.js was killed, timed out, could not be started, ended on a code it does not document, or this step failed after it started |
| `reveal` | 0 | live.js claim finished: a dry run was built, or the claim was sent and mined (eth-claim.json) |
| `reveal` | 1 | live.js claim ended on its own error: it may or may not have sent; the secret MAY BE PUBLIC (a `sent:` line in eth-claim.err says it was broadcast) |
| `reveal` | 2 | refused before any child was started: a setting, a tool, the role, the fee settings, `replace`, no passphrase, no swap file |
| `reveal` | 3 | the claim was MINED AND REVERTED: it paid nobody and the secret IS PUBLIC (live.js exit 3; the hash is saved in reveal-reverted-tx.txt) |
| `reveal` | null | may have been sent, THE SECRET MAY BE PUBLIC: live.js was killed, timed out, could not be started, ended on a code it does not document, or this step failed after it started |
| `claim` | 0 | swap-cli claim finished: a dry run proved the close, or the close was submitted |
| `claim` | 1 | swap-cli claim ended on its own error: with --submit the close may or may not have been sent |
| `claim` | 2 | refused before swap-cli was started: a setting, a tool, the role, no passphrase, no swap file, an unknown option |
| `claim` | null | may have been sent: swap-cli was killed, timed out, could not be started, ended on a code it does not document, or this step failed after it started |
| `refundEth` | 0 | live.js refund finished: a dry run was built, or the refund was sent and mined (eth-refund-N.json) |
| `refundEth` | 1 | live.js refund ended on its own error: it may or may not have sent (read eth-refund-N.err for a `sent:` line) |
| `refundEth` | 2 | refused before any child was started: a setting, a tool, the role, the fee settings, `replace`, no passphrase, no swap file |
| `refundEth` | null | may have been sent: live.js was killed, timed out, could not be started, ended on a code it does not document, or this step failed after it started |
| `walletFund` | 0 | a dry run was built and verified, or the funding was sent (at least one node holds it; wallet-funded.marker is written) |
| `walletFund` | 1 | swap-cli ran and its output is not what the table lists (unreadable after a real submit, an exit status it does not document): possibly sent |
| `walletFund` | 2 | refused before any child was started: a setting, a tool, the role, no passphrase, no swap file, an unknown option |
| `walletFund` | 3 | REFUSED, nothing sent: the wallet and the contract root were not named, the reveal's fee reserve is not covered or could not be read, or swap-cli refused before it submitted anything |
| `walletFund` | 4 | nothing was sent by this run: the tool says to wait (outcome hold), or that the funding is already at the contract (outcome done; the marker is written) |
| `walletFund` | 6 | the funding MAY have been sent: run it again, the tool sends the same recorded bytes, never a second funding |
| `walletFund` | null | may have been sent: swap-cli was killed, timed out, could not be started, or this step failed after it started (run it again: the same bytes) |
| `walletRecover` | 0 | stage A: a dry run was built, or the close was sent (stage B's result is a line, not the code); with `record`: the close is recorded in the swap file |
| `walletRecover` | 1 | swap-cli ran and its output is not what the table lists: possibly sent |
| `walletRecover` | 2 | refused before any child was started: a setting, a tool, the role, no passphrase, no swap file, an unknown option |
| `walletRecover` | 3 | REFUSED, nothing sent: the wallet was not named, or swap-cli refused before it submitted anything; with `record`: the tool refused to record the close (nothing written) |
| `walletRecover` | 4 | nothing was sent by this run: the tool says to wait or that there is nothing to recover; with `record`: no recovery close is on file yet |
| `walletRecover` | 6 | the close MAY have been sent: run it again, the tool sends the same recorded bytes, never a second close |
| `walletRecover` | null | may have been sent: swap-cli was killed, timed out, could not be started, or this step failed after it started (run it again: the same bytes) |
| `walletSweep` | 0 | a dry run was built, or the sweep was sent (noid: at least one node holds it; eth: mined); the swept marker is written |
| `walletSweep` | 1 | the tool ran and its answer is not one the table lists (an exit status it does not document): possibly sent |
| `walletSweep` | 2 | refused before any child was started: a setting, a payout setting, a tool, the role, no passphrase, no swap file, an unknown option |
| `walletSweep` | 3 | REFUSED, nothing sent: the payout in the swap file is not the payout in run.json, the key's role is not the asked one, or the tool refused before it sent anything (eth: in a dry run only, live.js printed its own `error:` line, no `sent:` line, no result; a real Ethereum sweep that ended in an error is 1) |
| `walletSweep` | 4 | noid only: nothing was sent by this run (the tool says to wait, or that the sweep is already done; the marker is written for done) |
| `walletSweep` | 6 | noid only: the sweep MAY have been sent: run it again, the tool sends the same recorded bytes (the Ethereum sweep never returns 6: it has no recorded bytes) |
| `walletSweep` | null | may have been sent: the sender was killed, timed out, could not be started, or this step failed after it started (eth: also live.js printed `sent:` and did not finish: look at the key's balance) |
| `boardSign` | 0 | signed: the signer is Bob's Ethereum address; the lines `board-sign: purpose`, `text-sha256`, `address`, `signature` and `done` are printed |
| `boardSign` | 2 | refused before any child was started: a setting, a tool, the role, no passphrase, no handover file, a value that is not what it must be |
| `boardSign` | 3 | nothing reported: swap-cli bundle did not give exactly one digest, live.js sign-message failed or answered in another shape, or the signer is not Bob's address (nothing is sent to any chain by this step) |
| `boardSign` | null | live.js sign-message was killed, timed out or could not be started, or this step failed after it started |

**Files** (run folder; N = HHMMSS of the step's clock, as the helpers): `lock-precheck-N.json/.err`, `eth-lock-N.json/.err/.emit.err`, `pub/eth-lock.json` (lock); `eth-claim.json/.err`
or `eth-claim-dry-N.json/.err/.emit.err`, `reveal-reverted-tx.txt`, `pub/eth-claim.json` (reveal); `claim-N.out/.err`, `rec/claim-noid|eth-N.json`, `claim-intent-N.hex` (claim);
`eth-refund-N.json/.err/.emit.err` (refund); `wallet-fund-[dry-]N.addr.json/.addr.err/.reserve.json/.reserve.err/.json/.err`, `wallet-funded.marker` (`wx`); `wallet-recover-[dry-]N.*`,
`wallet-recovered-txid.txt` (tmp + rename), `wallet-record-N.out`; `wallet-sweep-noid-[dry-]N.*`, `wallet-swept-noid.marker`, `eth-sweep-ROLE-[dry-]N.json/.err/.emit.err`, `wallet-swept-eth-ROLE.marker` (markers `wx`).
`board-sign` writes no file. The passphrase goes only to the swap-cli commands that had it in bash: `tick`, `ethkey emit`, `secret`, `claim`, `wallet fund|recover|sweep`; never to
`wallet address`, `ethkey address`, `bundle`, or live.js. No step passes `--mainnet`, a mainnet fee cap, a producer waiver, a key file or a margin flag (a test scans every call).

### Every difference from the bash helpers, and why

- **Codes after live.js started** (the rule above): lock, reveal, refund and the Ethereum sweep no longer return 2 when the key could not be emitted; the result file is not deleted.
  The pipe starts live.js first, so this is how it has to be. Any live.js exit other than 0 and 1 (3 for the reveal) is null where bash passed the raw code (a raw 2 or 3 could be
  read as "nothing sent"). `live.js` has no exit 2.
- **The pre-send tick of the lock** is the bash one (read-only, no `--apply`, nothing recorded, killed after the limit: `lock_precheck_timeout_s`, else min(3 x `rpc_timeout_s`, 90)).
  `lockPrecheck` is `lock_precheck` line for line with the checks on numbers made exact: the tick is parsed with the text of every number kept (`JSON.parse` reviver, Node 21+; a runtime
  without it refuses), so `decided_at`, `now`, `t_reveal`, `chain_id` and `amount_wei` are whole numbers or a refusal (`1762000000.0` is refused as python refused it; `amount_wei`
  is a BigInt, 1e16 is more than 2^53). `now` and `decided_at` above 2^53-1 are refused. A test compares the approval text and its SHA-256 with `approvalText` / `approvalTermsHash` of live.js
  (the shared vector, random terms, huge amounts) and the 120 s window with `MAX_OBSERVATION_AGE_S`.
- **File names use HHMMSS** (`C.clock`), not `ctx.runNumber` as the spec text says: the helpers use `date +%H%M%S`, the console's patterns match digits, and a run number would let a second real
  lock overwrite the first one's result file. `runNumber` only appears in the `== start` lines.
- **A swap file must exist before any child** (the helpers let the tool fail): 2 with the helper to run first. `claim` also refuses a log start that is not one whole number (`tickBase`).
- **No `reveal-reverted-tx.txt` surprises**: the hash is stripped of anything but printable non-blank characters before it is saved; a failed save is said ("could NOT be saved") and the code
  stays 3. The "run tick.sh alice --apply" notes name a tick of Alice with `--apply` (there is no helper). The summary of the result is the helper's 16 keys, `indent=1`, ASCII escapes.
- **A real reveal discards the emitters' stderr** (bash: `2>/dev/null`); a dry run keeps it in `.emit.err`. The secret is never read by this program.
- **A dry run is 1, not "may have been sent"**, when live.js did not finish or ended on a status the step does not know (see the rule); a wallet dry run whose report says `sent` or `maybe_sent` is 1
  (bash: 3, which the console's `forbids` rule turned into "may have sent").
- **`board-sign`** gives `swap-cli bundle` no passphrase (it reads only the public part, as `boardDigest`) and requires it to exit 0 as well as print exactly one digest line (bash trusted a digest
  line whatever the exit status). Its 3 after live.js ran means "nothing reported" (nothing leaves the machine either way).
- **`wallet-recover`**: stage B runs the `tick` step in-process; a failure or a throw there never changes stage A's code (the close was sent). Its words are written to `wallet-record-N.out` as
  stderr then stdout. **`wallet-fund`**'s marker holds the time, `txid X` and `outcome Y` (the helper's three lines).
- **`wallet-sweep`**: the swap file's payout is read from the tool's own output (`wallet address` / `ethkey address`, parsed as JSON), never from the settings; NOID payouts are compared exactly,
  Ethereum ones without letter case. The temporary `.wallet-sweep-addr-N.json` files are not made (the answer is read from memory). An empty result file left by a refusal is removed, as in bash.
- Texts say `run.json` names (`noid_payout`, `eth_payout`, `bob_eth`) where bash said `NOID_PAYOUT` and `env.local.sh`; the wallet check "not a wallet run" is gone (always a wallet run).

**Tests.** `ui/app/test/steps-spend.test.js` (ports of sections 0, 9, 15, 18 and 19, named `(sN ...)`, plus the code table, the judgement, the approval text against live.js), the registry entries of
`steps-fixtures/registry-spend.js` (12 entries under every cross-step rule: argv, passphrase, codes, `wx` markers, hostile environment, canary key and secret in no result, file or log; the shared
fixtures are in `spend-fixtures.js`) and the **throw / kill rule** of `steps-rules.test.js` + `rules.js` `checkSpendFaults`: for every entry a throw is injected at EVERY point the step reaches through
`ctx.now`, `ctx.getPassphrase` and `ctx.io` (test-only; the file functions of `spendcommon.js`), one run per point; every child of the ordinary run is also killed (a tool wrapper that kills itself).
After the first sender the code must be null (or the ordinary code when the fault only touched what is printed), before it a refusal code. A time-out cannot be injected (no spend step puts a limit on a
sender: a kill after the send could hide it); the lock's pre-send tick has one and has its own test; a start error is a registry case (`ctx: badLive`). Fake spend steps that break the rule show that the
rule can fail. Not tested: a real `swap-cli` (no native Windows build), and a kill that gives a signal on Windows (it looks like exit 1 there, which is what the Windows expectations say).

**Low points.** `eth-claim.json` and `eth-claim.err` are overwritten by a second real reveal (bash too): the `sent:` line of the first is gone from the file. A step has no limit on its senders, so a
hung live.js blocks the step until the caller stops it (4.5 owns that). `ctx.io` and the other test-only fields are never set by the program.

**After the independent read.** One point was fixed: a real Ethereum sweep that ended in an error without a `sent:` line was 3 ("nothing sent"),
but live.js prints `sent:` only after the send call returned, and the node may have taken the transaction before the call failed. It is now 1
(unknown), and the emitter's words have their own file. Tests were added for reveal and refund when the key or the secret could not be emitted
but live.js says it finished (null).

**Low points of the read (left; the final pass decides).**
- FIXED (final pass, 4.4-1): `walletStep` counted an unreadable report size as 0, which could give 3 next to a `maybe_sent` report; it is counted as 1 now.
- `boardSign` returns 3 after the signer started; no chain is touched, but it breaks the letter of design 12.6 (write the exception, or return 1).
- In lock, reveal and refund a failed key emit gives 1 where bash gave 2; the console latch then holds the intent, so 4.5 must show "cancel the
  intent, then retry".
- FIXED (final pass, 4.4-4): `reveal`, when live.js was not started (its result file could not be opened), summarized the `eth-claim.json` of an earlier reveal. The result file is
  read, and copied to `pub/`, only when live.js was started by this run; otherwise the step says so and shows nothing of the old file.
- FIXED (final pass, 4.4-5): `reveal` exit 3 with a result that gave no hash printed no loud "SECRET IS PUBLIC" line. A real reveal that ended on live.js exit 3 (without a
  hash to save), on exit 1, or on exit 0 with a key or secret that did not arrive whole, now prints a `!!!` line (the secret IS public, or MAY BE public).
- FIXED (final pass, 4.4-6): `walletRecover` record mode's 3 prints `wallet-recover REFUSED, nothing sent: closed-by NOT recorded yet ...`, the line the console reads. After a send
  (stage B of the send) the old words stay: the close was sent, so nothing there is "nothing sent".
- A null from a wallet step stops the autopilot; running it again would send the same recorded bytes (a 4.5 design choice).
- FIXED (final pass, 4.4-8): the Ethereum sweep reused 6, whose text means "same bytes" for NOID. A real Ethereum sweep that live.js broadcast and did not finish is null now
  (the console and the autopilot read it as may have been sent and show "needs you"); 6 is the NOID sweep's only.
- No time limit on senders or emitters (bash the same); a stuck emitter leaves live.js waiting on stdin.
- The lock precheck's decoder drops a UTF-8 byte-order mark that Python refused (swap-cli never prints one).
- Test gaps: on Windows the kill sweep accepts 1 as well as null (2 and 3 are still refused); the throw injection does not reach the direct
  `fs` calls inside `common.js`; no test shows the real `readKeyStdin` refusing a partial key or secret (it does, by reading `live.js`).
