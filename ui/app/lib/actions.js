"use strict";
/*
 * The actions mode (`--allow-actions`): the operator console performs the steps of a swap, through a FIXED table.
 *
 *   - Every action is an entry below. The browser sends an id (and, for a spend, the typed confirmation); nothing else
 *     from a request reaches a command line. The only values that are ever substituted into an argument vector are the
 *     run number (an integer the server was started with) and, for a --replace, a transaction hash that the SERVER read
 *     from the engine's tick or a helper's own stderr and that matches 0x + 64 hex. There is no free-form command.
 *   - Commands run through `wsl.exe -d DISTRO -e env RUN=N L=RUNDIR bash SCRIPT ARGS` (`-e`: no shell on the way in, so
 *     nothing in an argument is interpreted twice), with a cleared environment, one action at a time.
 *   - Groups: setup (install, setup, prepare, check-object), tick (read-only), dry (the dry runs), watch (start / stop the
 *     watch loop as a detached process), spend (lock, reveal, claim --submit, refund, and --replace of the two ETH sends).
 *   - A spend runs only when lib/gate.js says so (tick, dry run, typed confirmation), and only while this console still holds the
 *     run folder's lock file (lib/runlock.js: it is read again right before a spend starts). Alice's NOID funding is the spend
 *     send-fund (fund.sh); a funding done outside this console is told to it with the "I have funded" acknowledgement, which writes
 *     the same markers fund.sh does.
 *   - Every action writes a line before it starts and a line when it ends to the audit log (lib/audit.js); if the first
 *     line cannot be written the action does not run.
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execFile, spawn } = require("child_process");
const { validateConfig, cleanOutput, runNumberOf, ROLES } = require("./runner");
const { scrubText, readRun, pathCandidates, wslParts } = require("./runfolder");
const { samePath } = require("./paths");
const { redactDeep } = require("./secrets");
const { checkDryRun } = require("./dryrun");
const { ALL_SPENDS: SPEND_TABLE, evaluateSpend, describeSpend, relevantFor, expectedAmount, isNothingToSweep } = require("./gate");
const { envLocalWallet, parseWalletStatus } = require("./walletrun");
const { classifySpendExit, classifyStepExit, NOT_SENT } = require("./exitcodes");
const { productionReason } = require("./production");
const { boardRun: boardRunOf } = require("./board/runmode");
const { STEP_OF, TERMINAL_ONLY } = require("./stepexec");
const firststeps = require("./firststeps");
const { readBobKeyAddress } = require("./invitation");

/** Own-property lookup: an id such as "__proto__" or "constructor" is not a spend. */
const SPENDS = new Proxy(SPEND_TABLE, { get: (t, k) => (typeof k === "string" && Object.prototype.hasOwnProperty.call(t, k) ? t[k] : undefined) });

const MIN = 60 * 1000;
const TX_RE = /^0x[0-9a-f]{64}$/;
const RUN_RE = /^[1-9]\d{0,3}$/;
const MIN_GAP_MS = 2000;
const WATCH_CACHE_MS = 10000;
const WATCH_FRESH_S = 120;
const WALLET_POLL_MS = 40 * 1000; // wallet-status.sh is read-only; the gate wants the newest result younger than 120 s, and a table entry's own minimum gap is 30 s // a loop file updated this recently means some loop is running (the loop ticks every 30 s)

// Fixed scripts for the watch loop. They contain no value from a request; $L comes from the `env L=...` the server sets.
// One fixed script per role the console was started with (--role): a single-role console never ticks the other role's file.
const watchStartFor = (who) => 'echo $$ > "$L/ui-watch.pid"; exec bash "$L/bin/watch.sh" ' + who + " 30";
const WATCH_STARTS = { both: watchStartFor("both"), alice: watchStartFor("alice"), bob: watchStartFor("bob") };
const WATCH_START = WATCH_STARTS.both;
const WATCH_STOP = 'p=$(cat "$L/ui-watch.pid" 2>/dev/null); if [ -n "$p" ] && grep -q "bin/watch.sh" "/proc/$p/cmdline" 2>/dev/null; then kill "$p" && echo "stopped $p"; else echo "not running (no loop started by this console)"; fi';
const WATCH_START_PROGRAM_NOTE = "Records what the engine decides, including a funding or a lock to send next. Use it only if you will send by hand.";
const WATCH_STATUS = 'p=$(cat "$L/ui-watch.pid" 2>/dev/null); if [ -n "$p" ] && grep -q "bin/watch.sh" "/proc/$p/cmdline" 2>/dev/null; then echo "alive $p"; else echo dead; fi';

/*
 * script: { from: "bin" | "repo", name } or inline (one of the three fixed watch scripts).
 * args: literals, plus the two placeholders "{RUN}" and "{TX?}" (dropped when there is no hash).
 * result: how to find the file the helper wrote: a name pattern in the run folder.
 */
const TABLE = [
  { id: "install", group: "setup", label: "Install the helpers for this run", note: "Freezes a copy of scripts/live under the run's bin/ folder (creates the run folder). Run 3 lesson: the loop must call a frozen copy.", script: { from: "repo", name: "install.sh" }, args: ["{RUN}"], timeout: 2 * MIN },
  { id: "setup", group: "setup", label: "Set up the run folder", note: "A fresh passphrase (kept if present), the folders, the Ethereum log start (a recent finalized block read from the node, or DEPLOY_BLOCK). Run it after the settings form and before prepare.", script: { from: "bin", name: "setup.sh" }, args: [], timeout: 2 * MIN },
  { id: "prepare", group: "setup", role: "alice", label: "Prepare both roles' files", note: "Alice's file, the proof (with the proof-free lock kind this takes seconds, otherwise 20 to 36 minutes), Bob's file, the contract definition. Refuses to overwrite an existing file. Nothing is sent.", script: { from: "bin", name: "prepare.sh" }, args: [], timeout: 90 * MIN },
  { id: "check-object", group: "setup", role: "alice", mode: "classic", label: "Check the object file", note: "The wallet's object file must be byte-for-byte the swap file's opening. Reads only.", script: { from: "bin", name: "check-object.sh" }, args: [], timeout: 2 * MIN },
  { id: "join", group: "setup", role: "bob", label: "Check Alice's file against your terms", note: "join.sh: Alice's bundle file (and, for the sha256 lock kind, her receipt) goes through new-bob against YOUR terms in env.local.sh, and your swap file is written. Takes the file from the run folder, or from the public copy folder when the run folder has none. Nothing is sent to any chain and no key is touched.", script: { from: "bin", name: "join.sh" }, args: ["{BUNDLE?}"], timeout: 10 * MIN },
  { id: "tick-alice", group: "tick", role: "alice", label: "Tick (Alice), read-only", note: "One tick without --apply. It overwrites last-tick-alice.json with a version that withholds spend parameters: the next spend needs the watch loop's next tick.", script: { from: "bin", name: "tick.sh" }, args: ["alice"], timeout: 3 * MIN },
  { id: "tick-bob", group: "tick", role: "bob", label: "Tick (Bob), read-only", note: "One tick without --apply. It overwrites last-tick-bob.json with a version that withholds spend parameters: the next spend needs the watch loop's next tick.", script: { from: "bin", name: "tick.sh" }, args: ["bob"], timeout: 3 * MIN },
  { id: "dry-lock", group: "dry", role: "bob", label: "Dry run: Bob's ETH lock", note: "lock.sh --dry-run. Signs nothing, sends nothing.", script: { from: "bin", name: "lock.sh" }, args: ["--dry-run"], timeout: 3 * MIN, result: /^eth-lock-\d+\.json$/, spend: "send-lock" },
  { id: "dry-reveal", group: "dry", role: "alice", label: "Dry run: Alice's reveal", note: "reveal.sh --dry-run. Needs no secret; sends nothing.", script: { from: "bin", name: "reveal.sh" }, args: ["--dry-run"], timeout: 3 * MIN, result: /^eth-claim-dry-\d+\.json$/, spend: "send-reveal" },
  { id: "dry-reveal-replace", group: "dry", role: "alice", label: "Dry run: re-send of the stuck reveal", note: "reveal.sh --dry-run --replace TXHASH, the hash being the pending claim the engine saw. Sends nothing.", script: { from: "bin", name: "reveal.sh" }, args: ["--dry-run", "--replace", "{TX?}"], timeout: 3 * MIN, result: /^eth-claim-dry-\d+\.json$/, spend: "send-reveal-replace" },
  { id: "dry-claim", group: "dry", role: "bob", label: "Dry run: Bob's NOID claim", note: "claim.sh without --submit: proves and prints the close, submits nothing. Takes a few seconds.", script: { from: "bin", name: "claim.sh" }, args: [], timeout: 5 * MIN, result: /^claim-\d+\.out$/, spend: "send-claim" },
  { id: "dry-refund-eth", group: "dry", role: "bob", label: "Dry run: Bob's ETH refund", note: "refund-eth.sh --dry-run. Sends nothing.", script: { from: "bin", name: "refund-eth.sh" }, args: ["--dry-run"], timeout: 3 * MIN, result: /^eth-refund-\d+\.json$/, spend: "send-refund-eth" },
  { id: "dry-refund-eth-replace", group: "dry", role: "bob", label: "Dry run: re-send of the stuck ETH refund", note: "refund-eth.sh --dry-run --replace TXHASH. Sends nothing.", script: { from: "bin", name: "refund-eth.sh" }, args: ["--dry-run", "--replace", "{TX?}"], timeout: 3 * MIN, result: /^eth-refund-\d+\.json$/, spend: "send-refund-eth-replace" },
  { id: "dry-fund", group: "dry", role: "alice", label: "Dry run: Alice's funding", note: "fund.sh --dry-run: runs check-object, refuses when the contract already has an instance or when this run folder was funded before, otherwise prints what it would fund. Funds nothing. Needs the wallet CLI (and the wallet's node).", script: { from: "bin", name: "fund.sh" }, args: ["--dry-run"], timeout: 3 * MIN, text: true, spend: "send-fund" },
  { id: "watch-start", group: "watch", label: "Start the watch loop", note: "tick --apply for this console's role (both roles unless started with --role) every 30 s, as a detached process that keeps running when this page is closed. It records facts and intents; it sends nothing.", inline: WATCH_START },
  { id: "watch-stop", group: "watch", label: "Stop the watch loop", note: "Stops the loop this console started (not one started in a terminal).", inline: WATCH_STOP, timeout: MIN },
  { id: "send-fund", group: "spend", role: "alice", label: "Fund the contract with NOID", note: "fund.sh: REAL NOID leaves Alice's wallet, once per run folder (the helper writes funded.marker before it calls the wallet CLI).", script: { from: "bin", name: "fund.sh" }, args: [], timeout: 15 * MIN },
  { id: "send-lock", group: "spend", role: "bob", label: "Lock the ETH", note: "lock.sh: REAL ETH leaves Bob's wallet.", script: { from: "bin", name: "lock.sh" }, args: [], timeout: 15 * MIN, result: /^eth-lock-\d+\.json$/ },
  { id: "send-reveal", group: "spend", role: "alice", label: "Reveal the secret", note: "reveal.sh: publishes the secret on Ethereum and claims Bob's ETH.", script: { from: "bin", name: "reveal.sh" }, args: [], timeout: 15 * MIN, result: /^eth-claim\.json$/ },
  { id: "send-reveal-replace", group: "spend", role: "alice", label: "Re-send the stuck reveal", note: "reveal.sh --replace TXHASH: the same claim at the same nonce with a higher fee.", script: { from: "bin", name: "reveal.sh" }, args: ["--replace", "{TX?}"], timeout: 15 * MIN, result: /^eth-claim\.json$/ },
  { id: "send-claim", group: "spend", role: "bob", label: "Submit the NOID claim", note: "claim.sh --submit: sends the close to the node.", script: { from: "bin", name: "claim.sh" }, args: ["--submit"], timeout: 10 * MIN, result: /^claim-\d+\.out$/ },
  { id: "send-refund-eth", group: "spend", role: "bob", label: "Refund the ETH", note: "refund-eth.sh: REAL transaction after T_reveal.", script: { from: "bin", name: "refund-eth.sh" }, args: [], timeout: 15 * MIN, result: /^eth-refund-\d+\.json$/ },
  { id: "send-refund-eth-replace", group: "spend", role: "bob", label: "Re-send the stuck ETH refund", note: "refund-eth.sh --replace TXHASH.", script: { from: "bin", name: "refund-eth.sh" }, args: ["--replace", "{TX?}"], timeout: 15 * MIN, result: /^eth-refund-\d+\.json$/ },
];
/*
 * The tool's own wallets (swap wallet, piece 2c): the entries that exist only in a WALLET run (USE_SWAP_WALLET='1' in the run folder's env.local.sh, lib/walletrun.js), in a table
 * of their own so that TABLE above is the classic table, untouched. `mode: "wallet"` entries are refused (409, an audit line) in a classic run, and listed on the page only in a
 * wallet run. Two entries of TABLE (dry-fund, send-fund) run another helper in a wallet run: `walletScript`. Each wallet helper is documented in its own header and in
 * scripts/live/README.md; none of this has been run against a real node or a public network.
 *   wallet-setup-ROLE    the swap's own wallets, made before prepare / join build the swap file (nothing is sent)
 *   wallet-status-ROLE   read-only: the deposit to make and whether it has been seen (never more often than every 30 s)
 *   dry-recover / send-recover        the recovery close after D from the swap wallet (and its recording: wallet-record-close)
 *   dry-sweep-* / send-sweep-*        what is left in the NOID wallet / the Ethereum key goes to the user's own payout addresses, once the swap is over
 */
const WALLET_TABLE = [
  { id: "wallet-setup-alice", group: "setup", role: "alice", mode: "wallet", label: "Make this swap's own wallets (Alice)", note: "wallet-setup.sh alice: a fresh NOID swap wallet and a fresh Ethereum key, sealed with the run's passphrase; the key's address is checked against the key before any address is used. Nothing is sent. Run it after Set up and before Prepare.", script: { from: "bin", name: "wallet-setup.sh" }, args: ["alice"], timeout: 5 * MIN },
  { id: "wallet-setup-bob", group: "setup", role: "bob", mode: "wallet", label: "Make this swap's own Ethereum key (Bob)", note: "wallet-setup.sh bob: a fresh Ethereum key, sealed with the run's passphrase; its address is checked against the key before it is used. Nothing is sent. Run it after Set up and before Check Alice's file.", script: { from: "bin", name: "wallet-setup.sh" }, args: ["bob"], timeout: 5 * MIN },
  { id: "wallet-status-alice", group: "wallet", role: "alice", mode: "wallet", label: "Check Alice's deposits (read-only)", note: "wallet-status.sh alice: the NOID in the swap wallet and the Ethereum fee reserve of the swap key, read from the nodes. Sends nothing. Run by the console at most every 30 s.", script: { from: "bin", name: "wallet-status.sh" }, args: ["alice"], timeout: 3 * MIN, minGapMs: 30 * 1000 },
  { id: "wallet-status-bob", group: "wallet", role: "bob", mode: "wallet", label: "Check Bob's deposit (read-only)", note: "wallet-status.sh bob: the ETH in the swap key against the amount and the fee reserve, read from the node. Sends nothing. Run by the console at most every 30 s.", script: { from: "bin", name: "wallet-status.sh" }, args: ["bob"], timeout: 3 * MIN, minGapMs: 30 * 1000 },
  { id: "wallet-record-close", group: "wallet", role: "alice", mode: "wallet", label: "Record the recovery close in the swap file", note: "wallet-recover.sh --record: tick --closed-by TXID --apply with the txid of the recovery close that was sent. The tool records it only when the close is confirmed and the instance is gone; otherwise it refuses and writes nothing. Sends nothing.", script: { from: "bin", name: "wallet-recover.sh" }, args: ["--record"], timeout: 5 * MIN },
  { id: "dry-recover", group: "dry", role: "alice", mode: "wallet", label: "Dry run: Alice's recovery close", note: "wallet-recover.sh --dry-run: proves and verifies the close of the swap's own instance (allowed from D on), writes and sends nothing.", script: { from: "bin", name: "wallet-recover.sh" }, args: ["--dry-run"], timeout: 5 * MIN, text: true, spend: "send-recover" },
  { id: "dry-sweep-noid", group: "dry", role: "alice", mode: "wallet", label: "Dry run: sweep the NOID wallet", note: "wallet-sweep.sh noid --dry-run: builds and verifies the sweep, writes and sends nothing.", script: { from: "bin", name: "wallet-sweep.sh" }, args: ["noid", "--dry-run"], timeout: 5 * MIN, text: true, spend: "send-sweep-noid" },
  { id: "dry-sweep-eth-alice", group: "dry", role: "alice", mode: "wallet", label: "Dry run: sweep Alice's Ethereum key", note: "wallet-sweep.sh eth alice --dry-run. Sends nothing.", script: { from: "bin", name: "wallet-sweep.sh" }, args: ["eth", "alice", "--dry-run"], timeout: 3 * MIN, result: /^eth-sweep-alice-dry-\d+\.json$/, spend: "send-sweep-eth-alice" },
  { id: "dry-sweep-eth-bob", group: "dry", role: "bob", mode: "wallet", label: "Dry run: sweep Bob's Ethereum key", note: "wallet-sweep.sh eth bob --dry-run. Sends nothing.", script: { from: "bin", name: "wallet-sweep.sh" }, args: ["eth", "bob", "--dry-run"], timeout: 3 * MIN, result: /^eth-sweep-bob-dry-\d+\.json$/, spend: "send-sweep-eth-bob" },
  { id: "send-recover", group: "spend", role: "alice", mode: "wallet", label: "Take the NOID back from the contract", note: "wallet-recover.sh: REAL NOID returns to the swap wallet after D. The transaction is written before it is sent; running it again sends the same bytes.", script: { from: "bin", name: "wallet-recover.sh" }, args: [], timeout: 15 * MIN },
  { id: "send-sweep-noid", group: "spend", role: "alice", mode: "wallet", label: "Send what is left in the NOID wallet to your own address", note: "wallet-sweep.sh noid: REAL NOID goes to the payout address sealed in the swap file.", script: { from: "bin", name: "wallet-sweep.sh" }, args: ["noid"], timeout: 15 * MIN },
  { id: "send-sweep-eth-alice", group: "spend", role: "alice", mode: "wallet", label: "Send what is left of Alice's Ethereum key to your own address", note: "wallet-sweep.sh eth alice: REAL ETH goes to the payout address sealed in the swap file.", script: { from: "bin", name: "wallet-sweep.sh" }, args: ["eth", "alice"], timeout: 15 * MIN, result: /^eth-sweep-alice-\d+\.json$/ },
  { id: "send-sweep-eth-bob", group: "spend", role: "bob", mode: "wallet", label: "Send what is left of Bob's Ethereum key to your own address", note: "wallet-sweep.sh eth bob: REAL ETH goes to the payout address sealed in the swap file.", script: { from: "bin", name: "wallet-sweep.sh" }, args: ["eth", "bob"], timeout: 15 * MIN, result: /^eth-sweep-bob-\d+\.json$/ },
];
/*
 * The offer board's entries (piece 3, lib/board/host.js): HOST-ONLY. Each is started by the board host with its own private token (`meta.host`, never a request field: a request that names one of
 * these ids is refused), with fixed arguments; the input of the verify entries is a file the host writes in the run folder (board/verify.in), checked again by the helper. They send
 * nothing to any chain. `mode: "board"` entries run only in a wallet run that is also a board run (HANDOVER='board'); the two verify entries have no mode, because Alice verifies Bob's first
 * signed answer BEFORE her env.local.sh can be written (it needs the values of that very message). None of them is listed on the page.
 *   board-sign-*      Bob signs his two answers with the key that will lock (board-sign.sh)
 *   board-verify-*    Alice verifies a signature of Bob's (board-verify.sh: read-only, offline)
 *   board-balance     Alice reads BOB_ETH's balance (board-balance.sh: read-only)
 *   board-digest-*    the digest of a role's own swap file, and for Alice the file comparison (board-digest.sh: read-only)
 *   board-join        join.sh with the bundle the board saved at its own path (never from a request)
 */
const BOARD_TABLE = [
  { id: "board-sign-addresses", group: "board", role: "bob", mode: "board", hostOnly: true, label: "Sign Bob's addresses", note: "board-sign.sh addresses. Signs one personal message with the key that will lock; sends nothing.", script: { from: "bin", name: "board-sign.sh" }, args: ["addresses"], timeout: 3 * MIN, minGapMs: 200 },
  { id: "board-sign-checked", group: "board", role: "bob", mode: "board", hostOnly: true, label: "Sign Bob's check answer", note: "board-sign.sh checked. Signs one personal message with the key that will lock; sends nothing.", script: { from: "bin", name: "board-sign.sh" }, args: ["checked"], timeout: 3 * MIN, minGapMs: 200 },
  { id: "board-verify-addresses", group: "board", role: "alice", hostOnly: true, label: "Verify Bob's signed addresses", note: "board-verify.sh addresses. Read-only and offline.", script: { from: "bin", name: "board-verify.sh" }, args: ["addresses"], timeout: 3 * MIN, minGapMs: 200 },
  { id: "board-verify-checked", group: "board", role: "alice", hostOnly: true, label: "Verify Bob's signed check answer", note: "board-verify.sh checked. Read-only and offline.", script: { from: "bin", name: "board-verify.sh" }, args: ["checked"], timeout: 3 * MIN, minGapMs: 200 },
  { id: "board-balance", group: "board", role: "alice", mode: "board", hostOnly: true, label: "Read Bob's balance", note: "board-balance.sh. Read-only.", script: { from: "bin", name: "board-balance.sh" }, args: [], timeout: 3 * MIN, minGapMs: 200 },
  { id: "board-digest-alice", group: "board", role: "alice", mode: "board", hostOnly: true, label: "Read the digest of Alice's swap file", note: "board-digest.sh alice. Read-only.", script: { from: "bin", name: "board-digest.sh" }, args: ["alice"], timeout: 3 * MIN, minGapMs: 200 },
  { id: "board-digest-bob", group: "board", role: "bob", mode: "board", hostOnly: true, label: "Read the digest of Bob's swap file", note: "board-digest.sh bob. Read-only.", script: { from: "bin", name: "board-digest.sh" }, args: ["bob"], timeout: 3 * MIN, minGapMs: 200 },
  { id: "board-join", group: "setup", role: "bob", mode: "board", hostOnly: true, label: "Check the bundle the board received against Bob's terms", note: "join.sh with the bundle file the board saved at its own path.", script: { from: "bin", name: "join.sh" }, args: ["{BOARDBUNDLE}"], timeout: 10 * MIN, minGapMs: 200 },
];
// the steps of a board run that only the board host runs (a person's click on these is refused in a board run: the board drives them, in its own order)
const BOARD_DRIVEN = new Set(["prepare", "join", "wallet-setup-alice", "wallet-setup-bob"]);
// the two classic entries that run another helper in a wallet run (the funding is made from the swap wallet; fund.sh itself refuses in a wallet run)
const WALLET_SCRIPT = { "fund.sh": "wallet-fund.sh" };
for (const e of [...TABLE, ...WALLET_TABLE, ...BOARD_TABLE]) {
  if (!e.args) e.args = [];
  Object.freeze(e.args);
  Object.freeze(e);
}
const BY_ID = new Map([...TABLE, ...WALLET_TABLE, ...BOARD_TABLE].map((e) => [e.id, e]));
const SCRIPT_NAMES = new Set([...TABLE, ...WALLET_TABLE, ...BOARD_TABLE].filter((e) => e.script).map((e) => e.script.name).concat(Object.values(WALLET_SCRIPT)));
const INLINE = new Set([...Object.values(WATCH_STARTS), WATCH_STOP, WATCH_STATUS]);

/** null when the run's mode (wallet run or classic run) fits the table entry, else the reason. Entries of both modes (and the role-less ones) always fit. An ambiguous env.local.sh fits nothing that moves or makes keys. */
function modeBlock(entry, wr, br) {
  if (!entry || !entry.mode) return null;
  if (entry.mode === "board") {
    if (wr && wr.ambiguous) return "env.local.sh mentions USE_SWAP_WALLET, NOID_PAYOUT or ETH_PAYOUT in a way this console cannot read: the board steps are refused";
    if (!(wr && wr.use_swap_wallet)) return "this is not a wallet run: the board steps are refused here";
    if (br && br.ambiguous) return "env.local.sh mentions HANDOVER in a way this console cannot read: the board steps are refused";
    if (!(br && br.on)) return "this is not a board run (HANDOVER is not board in env.local.sh): the board steps are refused here";
    return null;
  }
  if (wr && wr.ambiguous) return "env.local.sh mentions USE_SWAP_WALLET, NOID_PAYOUT or ETH_PAYOUT in a way this console cannot read (an indented line, a variable, another value than 0 or 1): fix the file so that each is one plain NAME='value' line";
  if (entry.mode === "wallet" && !(wr && wr.use_swap_wallet)) return "this is a classic run (USE_SWAP_WALLET is not 1 in env.local.sh): the swap wallet steps are refused here";
  if (entry.mode === "classic" && wr && wr.use_swap_wallet) return "this is a wallet run (USE_SWAP_WALLET=1 in env.local.sh): the classic step is refused here";
  return null;
}

/** null when this console (cfg.role) may run the table entry, else the reason. Role-less entries (install, setup, watch-start, watch-stop) are always allowed; check-object and prepare are Alice's. */
function roleBlock(entry, role) {
  if (!entry || !entry.role || !role || role === "both" || entry.role === role) return null;
  return `this console was started with --role ${role}: ${entry.id} belongs to ${entry.role}, which runs on another machine`;
}

/** WSL path of the repository's scripts/live, derived from this file's location (C:\a\b -> /mnt/c/a/b). */
function defaultRepoLiveDir(repoRoot = path.resolve(__dirname, "..", "..", "..")) {
  const p = path.join(repoRoot, "scripts", "live");
  const m = /^([A-Za-z]):[\\/](.*)$/.exec(p);
  if (m) return `/mnt/${m[1].toLowerCase()}/${m[2].replace(/\\/g, "/")}`;
  return p.replace(/\\/g, "/");
}

function validateActionsConfig(cfg, o = {}) {
  // PROGRAM MODE (a step executor is given): no WSL field may be present, and the folders are exactly the run folder and its pub/ (the audit log's folder)
  if (o.program === true) {
    const errs = [];
    for (const k of ["distro", "binDir", "runDir", "runNumber", "repoLiveDir"]) if (cfg[k] !== undefined && cfg[k] !== null) errs.push(`program mode: ${k} must be absent (the steps run in this process, not through WSL helpers)`);
    const d = cfg.runDirs;
    if (!Array.isArray(d) || d.length !== 2 || typeof d[0] !== "string" || !path.isAbsolute(d[0]) || d[1] !== path.join(d[0], "pub")) errs.push("program mode: runDirs must be [run folder, run folder/pub]");
    if (cfg.role !== undefined && cfg.role !== null) errs.push("program mode: the role is run.json's, not a configuration value");
    return errs;
  }
  const errors = validateConfig(cfg);
  if (cfg.role !== undefined && cfg.role !== null && !ROLES.includes(cfg.role)) errors.push("--role: alice, bob or both");
  if (!Number.isInteger(cfg.runNumber) || !RUN_RE.test(String(cfg.runNumber))) errors.push("the run number must be a whole number, 1 to 9999 (--run-number N, or a run folder named live-run-N)");
  else if (cfg.runDir && runNumberOf(cfg.runDir) !== null && runNumberOf(cfg.runDir) !== cfg.runNumber) errors.push(`--run-number ${cfg.runNumber} does not match the run folder ${cfg.runDir}: the helpers derive their public copy folder from the number`);
  if (cfg.repoLiveDir && !/^\/[A-Za-z0-9._/@+-]{1,300}$/.test(cfg.repoLiveDir)) errors.push("the repository path (for install.sh) has characters outside A-Z a-z 0-9 . _ / @ + -; pass --repo-live-dir with a plain path");
  // The folder the console READS (runDirs[0]: the tick files, the gate's evidence, the audit and the funding markers) must be the folder the helpers
  // get as $L: otherwise the gate judges one folder and the helpers act on another. When it cannot be shown to be the same (explicit --wsl-run-dir /
  // --wsl-distro that do not match, or a read path that is not a WSL share, a /mnt/<drive> mapping or the same Linux path), actions mode is not enabled.
  if (!cfg.skipFolderCheck && cfg.runDirs && cfg.runDirs[0] && cfg.runDir && !samePath(cfg.runDirs[0], null, cfg.runDir, cfg.distro || null)) {
    errors.push(`the folder this console reads (${cfg.runDirs[0]}) cannot be shown to be the folder the helpers get as L (${cfg.distro ? cfg.distro + ":" : ""}${cfg.runDir}): refusing to enable the actions mode. Give the WSL run folder (//wsl.localhost/DISTRO/home/USER/live-run-N) as the first --run and leave --wsl-run-dir / --wsl-distro out, or make them name that very folder`);
  }
  return errors;
}

const BUNDLE_NAME = "alice.bundle.json";
const BUNDLE_MAX = 1048576; // join.sh refuses a bundle above this

/**
 * A folder of the console's own configuration (as the console reads it) as a Linux path the helper can open: a \wsl.localhost\DISTRO\... share of the
 * console's own distro, a C:\... drive path under that distro (/mnt/c/...), or a plain absolute path on a console without a distro. Null when it cannot be
 * said with plain characters (the same pattern the runner demands of its own paths). Nothing from a request ever reaches this.
 */
function helperPathOf(dir, distro) {
  if (typeof dir !== "string" || !dir) return null;
  let linux;
  const w = wslParts(dir);
  if (w) {
    if (!distro || w.distro.toLowerCase() !== String(distro).toLowerCase()) return null;
    linux = w.linux;
  } else {
    const t = dir.replace(/\\/g, "/").replace(/\/+$/, "");
    const drive = /^([A-Za-z]):\/(.*)$/.exec(t);
    if (drive) {
      if (!distro) return null;
      linux = `/mnt/${drive[1].toLowerCase()}/${drive[2]}`;
    } else if (!distro && t.startsWith("/") && !t.startsWith("//")) linux = t; // with a distro a POSIX path would name another file inside WSL than the one this server read
    else return null;
  }
  linux = linux.replace(/\/{2,}/g, "/").replace(/\/+$/, "");
  if (!/^\/[A-Za-z0-9._/@+-]{1,300}$/.test(linux) || /\.\./.test(linux)) return null;
  return linux;
}

const SAFE_ENV = ["PATH", "SystemRoot", "SYSTEMROOT", "WINDIR", "TEMP", "TMP", "HOME", "USERPROFILE", "LANG"];

/**
 * The exact command for a table id. Throws for an id that is not in the table, a bad run number, or a bad hash.
 * @param {string} id
 * @param {{distro:string|null, runDir:string, binDir:string, runNumber:number, repoLiveDir?:string}} cfg
 * @param {{txHash?:string|null, env?:object}} [x]
 */
function buildActionCommand(id, cfg, x = {}) {
  const e = BY_ID.get(id);
  if (!e) throw Object.assign(new Error(`unknown action id: ${JSON.stringify(String(id).slice(0, 40))}`), { status: 400 });
  const errors = validateActionsConfig(cfg);
  if (errors.length) throw new Error(errors.join("; "));
  if (x.txHash !== undefined && x.txHash !== null && !TX_RE.test(x.txHash)) throw new Error("the transaction hash to replace must be 0x + 64 lower-case hex");
  let scriptArgs;
  let scriptName = null;
  const inlineText = e.inline ? (e.id === "watch-start" ? WATCH_STARTS[cfg.role || "both"] : e.inline) : null;
  if (e.inline) {
    if (!inlineText || !INLINE.has(inlineText)) throw new Error("internal: unknown inline script");
    scriptArgs = ["-c", inlineText];
  } else {
    const dir = e.script.from === "repo" ? cfg.repoLiveDir : cfg.binDir.replace(/\/+$/, "");
    if (!dir) throw Object.assign(new Error("no path for scripts/live is known (pass --repo-live-dir)"), { status: 409 });
    // in a wallet run the funding is made by wallet-fund.sh (the table maps the helper, never the request)
    scriptName = x.wallet === true && Object.prototype.hasOwnProperty.call(WALLET_SCRIPT, e.script.name) ? WALLET_SCRIPT[e.script.name] : e.script.name;
    if (!/^[a-z-]+\.sh$/.test(scriptName) || !SCRIPT_NAMES.has(scriptName)) throw new Error("internal: script name not in the table");
    const args = [];
    for (const a of e.args) {
      if (a === "{RUN}") args.push(String(cfg.runNumber));
      else if (a === "{TX?}") {
        if (x.txHash) args.push(x.txHash);
      } else if (a === "{BUNDLE?}") {
        // join.sh's one optional argument: the bundle file of the console's own public copy folder, built here from the configuration and only when the caller says
        // the run folder has none (never from a request)
        const base = x.bundleFromPublic === true ? helperPathOf((cfg.runDirs || [])[1], cfg.distro || null) : null;
        if (base) args.push(`${base}/${BUNDLE_NAME}`);
      } else if (a === "{BOARDBUNDLE}") {
        // join.sh's argument in a board run: the file the board saved at its own path inside the run folder, built from the configuration (never from a message)
        if (!/^\/[A-Za-z0-9._/@+-]{1,300}$/.test(String(cfg.runDir || "")) || /\.\./.test(cfg.runDir)) throw new Error("the run folder path has characters the board's bundle path cannot carry");
        args.push(`${cfg.runDir.replace(/\/+$/, "")}/board/bundle-in.json`);
      } else args.push(a);
    }
    scriptArgs = ["bash", `${dir.replace(/\/+$/, "")}/${scriptName}`, ...args];
    if (scriptArgs[0] !== "bash") throw new Error("internal");
  }
  const envArgs = ["env", `RUN=${cfg.runNumber}`, `L=${cfg.runDir}`];
  const inner = e.inline ? [...envArgs, "bash", ...scriptArgs] : [...envArgs, ...scriptArgs];
  const safeEnv = {};
  const src = x.env || process.env;
  for (const k of SAFE_ENV) if (src[k]) safeEnv[k] = src[k];
  const file = cfg.distro ? "wsl.exe" : inner[0];
  const args = cfg.distro ? ["-d", cfg.distro, "-e", ...inner] : inner.slice(1);
  const env = cfg.distro ? safeEnv : { ...safeEnv, L: cfg.runDir, RUN: String(cfg.runNumber) };
  const display = e.inline ? `${cfg.distro ? `wsl.exe -d ${cfg.distro} -e ` : ""}${envArgs.join(" ")} bash -c '${inlineText.length > 70 ? inlineText.slice(0, 67) + "..." : inlineText}'` : cfg.distro ? `wsl.exe -d ${cfg.distro} -e ${inner.join(" ")}` : inner.join(" ");
  return { file, args, env, display, entry: e, script: scriptName };
}

function listFiles(dir, re) {
  for (const c of pathCandidates(dir)) {
    try {
      const out = [];
      for (const name of fs.readdirSync(c)) {
        if (!re.test(name)) continue;
        try {
          const st = fs.statSync(path.join(c, name));
          if (st.isFile()) out.push({ name, full: path.join(c, name), mtimeMs: st.mtimeMs, size: st.size });
        } catch {
          /* vanished */
        }
      }
      return out;
    } catch {
      /* try the other spelling */
    }
  }
  return [];
}

class ActionRunner {
  /**
   * @param {{distro:string|null, runDir:string, binDir:string, runNumber:number, repoLiveDir?:string, runDirs:string[]}} cfg
   * @param {{audit:object, exec?:Function, spawnDetached?:Function, now?:()=>number, readRunFn?:Function, env?:object}} deps
   */
  constructor(cfg, deps) {
    // PROGRAM MODE (piece 4, step 4.5): `deps.executor` (lib/stepexec.js) runs a table entry as a step in this process, `deps.settingsSource` (lib/settingsource.js)
    // answers the run's role, mode and production state from run.json. Without them this is the terminal console, byte for byte as before.
    this.executor = deps.executor || null;
    this.settingsSource = deps.settingsSource || null;
    this.programMode = !!this.executor;
    if (this.programMode && !this.settingsSource) throw new Error("program mode needs a settings source (run.json) beside the step executor");
    if (!this.programMode && this.settingsSource) throw new Error("a settings source is for program mode: give the step executor too");
    this.program = deps.program || null; // the program object (version, tools); the autopilot's approval binds it
    this.toolHasher = deps.toolHasher || null;
    this.nodeGate = deps.nodeGate || null; // () => { ok, why }: the program's Parano1d node has answered since the start
    this.refusedNoted = new Map(); // program mode: "id|tag" -> ms of the last audit line of such a refusal (not written again within 60 s)
    const errors = validateActionsConfig(cfg, { program: this.programMode });
    if (errors.length) throw new Error(errors.join("; "));
    this.cfg = this.programMode ? { ...cfg } : { ...cfg, repoLiveDir: cfg.repoLiveDir || defaultRepoLiveDir() };
    this.audit = deps.audit;
    this.runLock = deps.runLock || null; // the RunLock of this console (server.js); null in unit tests
    this.exec = deps.exec || execFile;
    this.spawnDetached = deps.spawnDetached || ((f, a, o) => spawn(f, a, o));
    this.now = deps.now || Date.now;
    this.readRunFn = deps.readRunFn || ((dirs, nowS) => readRun(dirs, nowS));
    this.env = deps.env || process.env;
    this.pollWatch = deps.pollWatch !== false;
    this.busy = null;
    this.jobSeq = 0;
    this.jobs = [];
    this.dry = new Map();
    this.last = new Map();
    this.latch = new Map();
    this.watch = { alive: null, pid: null, checked_ms: 0, checking: false, started_ms: null };
    this.objectCheck = null; // { ok, at_ms }
    this.funded = null; // { at_ms }
    this.hostToken = Object.freeze({ boardHost: true }); // the private value a board-only table entry needs as `meta.host` (lib/board/host.js); no request can carry it
    this.board = null; // lib/board/host.js sets itself here (gateFacts, identity, view); without it a board run has no facts and nothing that puts coins in is offered
    this.autopilot = null; // lib/autopilot.js sets itself here; without it a spend started with meta.auto is refused
    this.firstSteps = null; // program mode: lib/firststeps.js (lib/swapset.js sets it): the setup chain, the check line and the watch under rule W
    this.sentCache = new Map(); // a helper's error file (path, time, size) -> the hash on its "sent:" line, or null
    this.walletStatus = { alice: null, bob: null }; // the newest wallet-status.sh result of each role: { at_ms, ok, noid, eth, problems } (lib/walletrun.js parseWalletStatus); a restart forgets it
    this.walletPollMark = { alice: 0, bob: 0 };
    // A restart must not forget that a spend was started: rebuild the latches (the tick it ran on, the intent it served)
    // from the audit log. A start line without the markers latches by the wall clock of its own time instead.
    const undo = new Map(); // spend id -> the latch before its last start line, for a start whose end line says "refused, nothing sent"
    const started = new Map(); // spend id -> the latch its last start line set, for an end line that says the same bytes may be sent again
    this.restartMay = new Map(); // spend id -> true while its last audit lines say "may have been sent" (a start line with no end line counts); read by mayHaveSentIds()
    for (const r of this.audit.all()) {
      if (SPENDS[r.action] && (r.phase === "start" || r.phase === "end")) this.restartMay.set(r.action, r.phase === "start" || /^SECRET |, the transaction may have been sent/.test(String(r.result || "")));
      // A funding the operator said was done outside this console stays acknowledged for good (the contract may have a pending funding
      // that no instance, no marker here and no tick shows yet).
      if (r.action === "funded-ack" && r.phase === "note") this.funded = { at_ms: Date.parse(r.t) || 0, from_log: true };
      // A spend that the helper refused cleanly (the exit status it documents as "nothing was sent", lib/exitcodes.js) sent nothing: its start line does not latch.
      if (r.phase === "end" && SPENDS[r.action] && /^(?:refused, nothing sent|nothing to sweep)\b/.test(String(r.result || "")) && undo.has(r.action)) {
        const before = undo.get(r.action);
        if (before) this.latch.set(r.action, before);
        else this.latch.delete(r.action);
        undo.delete(r.action);
        continue;
      }
      // A wallet helper that says "the transaction MAY have been sent, and running it again sends the SAME recorded bytes" (lib/exitcodes.js RERUN_SAFE) keeps the latch of its tick
      // (not twice on one tick) and drops the latch of its intent (the next tick may run it again).
      if (r.phase === "end" && SPENDS[r.action] && /^may have been sent, the same bytes may be sent again\b/.test(String(r.result || "")) && undo.has(r.action) && started.has(r.action)) {
        const before = undo.get(r.action);
        this.latch.set(r.action, { tickNow: started.get(r.action).tickNow, intentAt: before ? before.intentAt : null });
        undo.delete(r.action);
        continue;
      }
      if (r.phase !== "start" || !SPENDS[r.action]) continue;
      undo.set(r.action, this.latch.get(r.action) || null);
      const prev = this.latch.get(r.action) || { tickNow: null, intentAt: null };
      const mt = /tick=(\d+)/.exec(r.detail || "");
      const mi = /intent=(\d+)/.exec(r.detail || "");
      const wall = Math.floor(Date.parse(r.t) / 1000);
      this.latch.set(r.action, { tickNow: Math.max(prev.tickNow || 0, mt ? Number(mt[1]) : wall), intentAt: mi ? Number(mi[1]) : prev.intentAt });
      started.set(r.action, this.latch.get(r.action));
    }
  }

  /**
   * Spend ids whose last run may have been sent and has no later clean run: this process's jobs, and for a spend not run since the start the audit log (a restart reads it, so a
   * spend that was started and never ended, or that ended unclean, still counts). A spend the helper said the same bytes may be sent again is not counted.
   */
  mayHaveSentIds() {
    const out = [];
    const seen = new Set();
    const last = new Map();
    for (const j of this.jobs) {
      if (j.group !== "spend") continue;
      seen.add(j.id);
      if (j.state === "done") last.set(j.id, j);
    }
    for (const j of last.values()) if (j.outcome === "may_have_sent" || j.outcome === "secret_public_reverted") out.push(j.id);
    for (const [id, may] of this.restartMay) if (may && !seen.has(id)) out.push(id);
    return out;
  }

  /** A spend of this process started (may: true, as a start line with no end line) or ended (may: its outcome): the record mayHaveSentIds keeps once the job leaves the list. */
  noteSpendRun(id, may) {
    this.restartMay.set(id, may === true);
  }

  nowS() {
    return Math.floor(this.now() / 1000);
  }

  command(id, txHash, extra = {}) {
    if (this.programMode) {
      // No command line exists in program mode: the "command" is the name of the step and the hash it replaces. It is what the dry run is bound to (the gate compares it).
      const e = BY_ID.get(id);
      if (!e) throw Object.assign(new Error(`unknown action id: ${JSON.stringify(String(id).slice(0, 40))}`), { status: 400 });
      if (txHash !== undefined && txHash !== null && !TX_RE.test(txHash)) throw new Error("the transaction hash to replace must be 0x + 64 lower-case hex");
      const scriptName = e.script ? (Object.prototype.hasOwnProperty.call(WALLET_SCRIPT, e.script.name) ? WALLET_SCRIPT[e.script.name] : e.script.name) : null;
      return { file: null, args: [], env: {}, display: `step ${id}${txHash ? ` replacing ${txHash}` : ""}`, entry: e, script: scriptName };
    }
    return buildActionCommand(id, this.cfg, { ...extra, txHash, env: this.env, wallet: this.walletRun().use_swap_wallet === true });
  }

  /** What env.local.sh says about the run's mode and the payout addresses (lib/walletrun.js); read again on every call (a few lines of a small file). In program mode: run.json. */
  walletRun() {
    if (this.settingsSource) return this.settingsSource.walletRun();
    return envLocalWallet(this.runFolder());
  }

  /** What the run folder says about the board (lib/board/runmode.js): `{ on, declared, file, ambiguous }`; read again on every call. In program mode: run.json's handover. */
  boardRun() {
    if (this.settingsSource) return this.settingsSource.boardRun();
    return boardRunOf(this.runFolder());
  }

  /** The role this runner drives: terminal mode: the console's `--role` (alice, bob, both or null); program mode: run.json's role (alice, bob, or null when it cannot be read). */
  curRole() {
    return this.settingsSource ? this.settingsSource.role() : this.cfg.role;
  }

  /**
   * null when this runner may run the table entry for its role, else the reason. Terminal mode: roleBlock (null and "both" let everything through). Program mode: the role
   * must be alice or bob and the entry's own role must be it (design 12.4); the only entries a swap without run.json may run are the board's two offline checks in a slot.
   */
  roleBlockFor(entry) {
    if (this.settingsSource) return this.settingsSource.roleBlock(entry);
    return roleBlock(entry, this.cfg.role);
  }

  /**
   * Program mode: a refusal of the step executor's checks (run.json, production, role, folder guard, vault, recovery code) is 409 with an audit line (not written again for the
   * same reason and entry within 60 s: the timer's own attempts would fill the log). Nothing has started.
   */
  assertProgram(e, o = {}) {
    if (!this.programMode) return;
    const c = this.executor.precheck(e, { sender: o.sender === true });
    if (c.ok) return;
    if (!o.quiet) this.noteProgramRefusal(e, c.tag);
    throw Object.assign(new Error(c.why), { status: c.status || 409 });
  }

  noteProgramRefusal(e, tag) {
    const key = `${e.id}|${tag}`;
    const at = this.now();
    if (at - (this.refusedNoted.get(key) || 0) < 60 * 1000) return;
    if (this.refusedNoted.size > 200) this.refusedNoted.clear();
    this.refusedNoted.set(key, at);
    try {
      this.audit.append({ action: e.id, role: e.role || null, phase: "refused", result: `refused: ${tag}` });
    } catch {
      /* the refusal stands without its line */
    }
  }

  /** Program mode: may the timer and the autopilot act on this swap now? `{ ok, why }` (the executor's checks for the swap's own tick, and the program's node has answered). */
  programReady() {
    if (!this.programMode) return { ok: true, why: null };
    const role = this.curRole();
    const c = this.executor.precheck({ id: `tick-${role || "alice"}`, group: "tick", role: role || undefined }, { sender: false });
    if (!c.ok) return { ok: false, why: c.why };
    if (this.nodeGate) {
      const g = this.nodeGate();
      if (!g || g.ok !== true) return { ok: false, why: (g && g.why) || "waiting for the Parano1d node to answer" };
    }
    return { ok: true, why: null };
  }

  /** The board part of the gate's context: undefined for a run that is not a board run, else `{ on, ambiguous, facts }` (the host's facts, or null when no host runs here). */
  boardCtx(spend) {
    const br = this.boardRun();
    if (!br.on && !br.ambiguous) return undefined;
    let facts = null;
    try {
      facts = this.board && typeof this.board.gateFacts === "function" ? this.board.gateFacts(spend.role) : null;
    } catch {
      facts = null;
    }
    return { on: true, ambiguous: br.ambiguous, facts };
  }

  /**
   * The gate's facts of program mode outside a board run (lib/gate.js): the funding and the lock wait for the line match (a record of the run folder, for the CURRENT check line),
   * and Bob's lock also asks for the statement that Alice's check line matches his. A terminal console and a board run give nothing here, so the gate is as before for them.
   */
  programGateCtx(spend) {
    if (!this.programMode || this.boardRun().on) return {};
    return { lineMatchRequired: true, lineMatch: !!firststeps.lineMatchFor(this.runFolder(), spend.role), aliceCheckRequired: spend.kind === "lock_eth" };
  }

  /** The reason a table entry (or spend) is refused by the run's mode, or null. */
  modeBlockFor(entry) {
    return modeBlock(entry, this.walletRun(), this.boardRun());
  }

  /**
   * The wallet part of the gate's context for a spend: undefined for a classic run, else the run's wallet facts and the newest status of the spend's role. An ambiguous
   * env.local.sh counts as a wallet run for the gate (the careful reading: the deposit rules apply and nothing is offered anyway).
   */
  walletCtx(spend) {
    const wr = this.walletRun();
    if (!(wr.use_swap_wallet || wr.ambiguous)) return undefined;
    return { on: true, status: this.walletStatus[spend.role] || null };
  }

  /** True when the spend may be offered in this run's mode: a wallet-only spend needs a clean wallet run. */
  spendModeOk(spend) {
    if (!spend.walletOnly) return true;
    const wr = this.walletRun();
    return wr.use_swap_wallet === true && !wr.ambiguous;
  }

  /** Throws 409 (with an audit line) when the run's mode does not fit the table entry. */
  assertMode(e) {
    const why = this.modeBlockFor(e);
    if (!why) return;
    try {
      this.audit.append({ action: e.id, role: e.role || null, phase: "refused", result: "refused: run mode" });
    } catch {
      /* the refusal stands without its line */
    }
    throw Object.assign(new Error(why), { status: 409 });
  }

  /**
   * One bundle file by its exact name in a folder, as join.sh will see it: a plain file (not a link), not empty, within the limit, parsing as a JSON
   * object. `{ok, size, mtime, problem}`; null when there is no such name (or no folder). Only these facts leave; the content never does.
   */
  bundleFact(dir) {
    if (!dir) return null;
    for (const c of pathCandidates(dir)) {
      const full = path.join(c, BUNDLE_NAME);
      let st;
      try {
        st = fs.lstatSync(full);
      } catch {
        continue; // missing, or this spelling of the folder does not open: the other one is tried
      }
      const base = { size: st.size, mtime: Math.floor(st.mtimeMs / 1000) };
      if (st.isSymbolicLink()) return { ok: false, ...base, problem: "a symbolic link" };
      if (!st.isFile()) return { ok: false, ...base, problem: "not a regular file" };
      if (st.size === 0) return { ok: false, ...base, problem: "empty" };
      if (st.size > BUNDLE_MAX) return { ok: false, ...base, problem: "above 1 MB" };
      try {
        const j = JSON.parse(fs.readFileSync(full, "utf8"));
        return j && typeof j === "object" && !Array.isArray(j) ? { ok: true, ...base, problem: null } : { ok: false, ...base, problem: "not a JSON object" };
      } catch {
        return { ok: false, ...base, problem: "not JSON" };
      }
    }
    return null;
  }

  /** What the "Join a swap" screen reads about the files of Bob's first step (nothing but facts: names, sizes, times, whether a path can be given to the helper). */
  joinView() {
    const dir = this.runFolder();
    const pubDir = (this.cfg.runDirs || [])[1] || null;
    const run = this.bundleFact(dir);
    const pub = pubDir && pubDir !== dir ? this.bundleFact(pubDir) : null;
    return {
      run_bundle: run,
      public_bundle: pub,
      public_arg: !!(pub && helperPathOf(pubDir, this.cfg.distro || null)),
      receipt_in_run: !!dir && listFiles(dir, /^alice\.receipt$/).length > 0,
      bob_file: !!dir && listFiles(path.join(dir, "bob"), /^bob\.swap\.json$/).length > 0,
      alice_file: !!dir && listFiles(dir, /^alice\.swap\.json$/).length > 0,
    };
  }

  /** The reason text when this run folder is a production run (the console only shows it), else null. `run` is a readRun result, read when not given. */
  productionBlock(run) {
    if (this.settingsSource) {
      // program mode fails closed: run.json says production, cannot be read safely or fails its schema (every action refused), or the run's terms or a tick say production
      try {
        const why = this.settingsSource.productionReason();
        if (why) return why;
        return productionReason(run || this.readRunFn(this.cfg.runDirs, this.nowS()), null);
      } catch {
        return "the production check could not be made: every action is refused.";
      }
    }
    try {
      return productionReason(run || this.readRunFn(this.cfg.runDirs, this.nowS()), this.runFolder());
    } catch {
      return null;
    }
  }

  /** Throws 403 (with an audit line) for every action on a production run. */
  assertNotProduction(id, run) {
    const why = this.productionBlock(run);
    if (!why) return;
    try {
      this.audit.append({ action: id, role: null, phase: "refused", result: "refused: production swap" });
    } catch {
      /* the refusal stands without its line */
    }
    throw Object.assign(new Error(why), { status: 403 });
  }

  describe(prodReason) {
    const wr = this.walletRun();
    return [...TABLE.filter((e) => !(this.programMode && (TERMINAL_ONLY.has(e.id) || e.mode === "classic"))), ...(wr.use_swap_wallet || wr.ambiguous ? WALLET_TABLE : [])].map((e) => {
      let display = null;
      try {
        display = this.command(e.id, e.args.includes("{TX?}") ? "0x" + "0".repeat(64) : null).display;
        if (e.args.includes("{TX?}")) display = display.replace("0x" + "0".repeat(64), "<pending tx hash>");
      } catch {
        display = null;
      }
      const modeWhy = modeBlock(e, wr);
      // in program mode the button records what the engine decides (it starts, or switches a reading loop to recording): the note says so
      const note = this.programMode && e.id === "watch-start" ? WATCH_START_PROGRAM_NOTE : e.note;
      return { id: e.id, group: e.group, role: e.role || null, label: e.label, note, command: display, blocked: prodReason || (modeWhy ? null : this.roleBlockFor(e)) || null, ...(e.mode ? { mode: e.mode, mode_blocked: modeWhy } : {}) };
    });
  }

  /** Do the swap files of this run exist? (Then the settings and the frozen helpers must not change any more.) */
  swapFilesExist() {
    const dir = this.runFolder();
    if (!dir) return false;
    return listFiles(dir, /^(?:alice\.swap\.json|last-tick-(?:alice|bob)\.json)$/).length > 0 || listFiles(path.join(dir, "bob"), /^bob\.swap\.json$/).length > 0;
  }

  runFolder() {
    return (this.cfg.runDirs || [])[0] || null;
  }

  // ------------------------------------------------------------------ replace hash (read by the server, never typed)
  replaceTxFor(spend, run) {
    if (!spend.replace) return null;
    if (spend.kind === "reveal_eth") {
      const t = run && run.roles && run.roles.alice && run.roles.alice.tick;
      const h = t && t.eth && t.eth.pending_preimage && t.eth.pending_preimage.tx_hash;
      return typeof h === "string" && TX_RE.test(h.toLowerCase()) ? h.toLowerCase() : null;
    }
    return this.sentHashFor(spend);
  }

  /** The content (a UTC time stamp) of `funded.marker` in the run folder, or null. fund.sh writes it, atomically, before it calls the wallet CLI; it stays when the CLI fails. */
  fundedMarker() {
    const i = this.fundedMarkerInfo();
    return i ? i.at : null;
  }

  /** `{ at, acknowledged, lines }` of `funded.marker`: the time on its first line, whether it is an acknowledgement (made by this console, not by fund.sh), the recorded lines. */
  fundedMarkerInfo() {
    const dir = this.runFolder();
    if (!dir) return null;
    const f = listFiles(dir, /^funded\.marker$/)[0];
    if (!f) return null;
    try {
      const text = fs.readFileSync(f.full, "utf8").replace(/\r/g, "");
      const m = /^[0-9TZ:+-]{4,40}/.exec(text.trim());
      return { at: m ? m[0] : "present", acknowledged: /^acknowledged: funded outside fund\.sh$/m.test(text), lines: text.split("\n").filter(Boolean).slice(0, 12) };
    } catch {
      return { at: "present", acknowledged: false, lines: [] };
    }
  }

  /**
   * The object file the console's terms were read from (swap.object.json in a run folder, normally the public copy): its path, its folder and its
   * sha256, or null. The funding dry run must have read the same file (same path after mapping, same bytes).
   */
  objectInfo(run) {
    // The file readRun took the terms from (the newest swap.object.json of the folders): the same file, so that the terms and the binding agree.
    // A run without that field (a stub in a test) falls back to the first folder that has one.
    const of = run && run.object_file !== undefined ? run.object_file : undefined;
    if (of === null) return null;
    if (of && of.path) {
      try {
        return { path: of.path, dir: of.dir || path.dirname(of.path), sha: crypto.createHash("sha256").update(fs.readFileSync(of.path)).digest("hex") };
      } catch {
        return null;
      }
    }
    for (const d of this.cfg.runDirs || []) {
      const f = listFiles(d, /^swap\.object\.json$/)[0];
      if (!f) continue;
      try {
        return { path: f.full, dir: path.dirname(f.full), sha: crypto.createHash("sha256").update(fs.readFileSync(f.full)).digest("hex") };
      } catch {
        /* next folder */
      }
    }
    return null;
  }

  objectSha(run) {
    const o = this.objectInfo(run);
    return o ? o.sha : null;
  }

  /** The program the funding dry run must name: the platform default of the helpers (a console that runs them through wsl.exe is on the wsl platform). */
  walletDefault() {
    return this.cfg.distro ? "/mnt/c/Parano1d/bin/parano1d-cli.exe" : "parano1d-cli";
  }

  /** fund.sh's second marker, funded-<contract root>.marker next to the object file: its time, or null. Another run folder or a copy of this one that used the same object folder leaves it. */
  contractMarker(root, run) {
    if (typeof root !== "string" || !/^o1[0-9a-z]+$/.test(root)) return null;
    const o = this.objectInfo(run);
    if (!o) return null;
    const name = `funded-${root}.marker`;
    const f = listFiles(o.dir, new RegExp("^" + name.replace(/[.]/g, "[.]") + "$"))[0];
    if (!f) return null;
    try {
      const m = /^[0-9TZ:+-]{4,40}/.exec(fs.readFileSync(f.full, "utf8").trim());
      return { name, at: m ? m[0] : "present" };
    } catch {
      return { name, at: "present" };
    }
  }

  /**
   * Why funding must not be offered or sent from here again, as words, or null: either marker (an acknowledgement writes them too), or an
   * acknowledgement rebuilt from the audit log (an older one, from before the markers). `run` carries the terms (the contract root names the
   * second marker).
   */
  fundedEvidence(run) {
    const wm = this.walletMarker("wallet-funded.marker");
    if (wm) return `wallet-funded.marker in this run folder (${wm}): the swap wallet's funding was sent, or found at the contract`;
    const mi = this.fundedMarkerInfo();
    if (mi && mi.acknowledged) return `the operator acknowledged at ${mi.at} that a funding was done outside this console (it may still be pending); funded.marker in this run folder records it`;
    if (mi) return `funded.marker in this run folder (${mi.at})`;
    const cm = this.contractMarker(run && run.terms && run.terms.contract_root, run);
    if (cm) return `the contract's marker ${cm.name} next to the object file (${cm.at}): another run folder or a copy funded this contract through fund.sh`;
    if (this.funded) return `the operator acknowledged at ${new Date(this.funded.at_ms).toISOString().replace(/[.]\d{3}Z$/, "Z")} that a funding was done outside this console (it may still be pending)`;
    return null;
  }

  /**
   * The hash on the newest "sent: 0x..." line a helper of this kind left in the run folder, or null: evidence that a send went out.
   * EVERY matching error file is looked at, newest first: a dry run leaves one too and the autopilot makes many, so a window of the newest few would let
   * a real `sent:` line fall out of it. A file is read once: its answer is kept by path, time and size.
   */
  sentHashFor(spend, run) {
    if (spend.kind === "sweep_noid") {
      const m = this.walletMarker("wallet-swept-noid.marker");
      return m ? `wallet-swept-noid.marker in this run folder (${m})` : null;
    }
    if (spend.kind === "sweep_eth") {
      const m = this.walletMarker(`wallet-swept-eth-${spend.role}.marker`);
      return m ? `wallet-swept-eth-${spend.role}.marker in this run folder (${m})` : null;
    }
    if (spend.kind === "refund_noid") return null; // the engine's own tick shows a close that is pending or confirmed (gate.js tickEvidence)
    if (spend.kind === "fund_noid") return this.fundedEvidence(run); // the funding leaves markers, not a transaction hash
    const dir = this.runFolder();
    if (!dir) return null;
    const re = spend.kind === "lock_eth" ? /^eth-lock(?:-\d+)?\.err$/ : spend.kind === "reveal_eth" ? /^eth-claim\.err$/ : spend.kind === "refund_eth" ? /^eth-refund(?:-\d+)?\.err$/ : null;
    if (!re) return null;
    const files = listFiles(dir, re).sort((a, b) => b.mtimeMs - a.mtimeMs);
    if (this.sentCache.size > 4000) this.sentCache.clear();
    for (const f of files) {
      const key = `${f.full}|${f.mtimeMs}|${f.size}`;
      let h = this.sentCache.get(key);
      if (h === undefined) {
        try {
          const m = /\bsent: (0x[0-9a-fA-F]{64})\b/.exec(fs.readFileSync(f.full, "utf8"));
          h = m ? m[1].toLowerCase() : null;
          this.sentCache.set(key, h);
        } catch {
          continue; // unreadable now: next file, and not remembered
        }
      }
      if (h) return h;
    }
    return null;
  }

  /**
   * What the autopilot needs to know about one spend, from the run it has just read: the tick, whether the engine offers the step now (the page's own
   * `relevant`), and the gate's context (the stored dry run, the latch, the evidence). The same pieces `view()` builds for the page. Nothing starts here.
   */
  spendContext(spend, run, nowMs) {
    const r = run && run.roles && run.roles[spend.role];
    const tick = r && r.tick ? r.tick : null;
    const replaceTx = this.replaceTxFor(spend, run);
    const sentHash = this.sentHashFor(spend, run);
    const relevant = this.spendModeOk(spend) && relevantFor(spend, tick, spend.replace ? replaceTx : sentHash);
    let expectedDry = null;
    try {
      expectedDry = this.command(spend.dry, replaceTx).display;
    } catch {
      expectedDry = null;
    }
    return { tick, relevant, replaceTx, gate: { run, nowMs, dry: this.dryFor(spend, run, replaceTx, nowMs), expectedDryCommand: expectedDry, latch: this.latchOf(spend.id), sentHash, wallet: this.walletCtx(spend), board: this.boardCtx(spend), ...this.programGateCtx(spend) } };
  }

  /** What the gate needs to know about the latch of a spend id. */
  latchOf(id) {
    return this.latch.get(id) || null;
  }

  // ------------------------------------------------------------------ the page's view
  view(run) {
    const nowMs = this.now();
    const spends = {};
    const production = this.productionBlock(run);
    for (const s of Object.values(SPENDS)) {
      // the statements the page must ask beside the typed amount (program mode, outside a board run: Bob's lock needs "Alice's check line matches mine")
      const statements_needed = s.kind === "lock_eth" && this.programMode && !this.boardRun().on ? ["alice_check_matches"] : [];
      if (this.roleBlockFor(s)) {
        spends[s.id] = { id: s.id, kind: s.kind, role: s.role, label: s.label, replace: s.replace, relevant: false, other_machine: true, statements_needed };
        continue;
      }
      if (production) {
        spends[s.id] = { id: s.id, kind: s.kind, role: s.role, label: s.label, replace: s.replace, relevant: false, production: true, statements_needed };
        continue;
      }
      const r = run && run.roles && run.roles[s.role];
      const tick = r && r.tick;
      const sentHash = this.sentHashFor(s, run);
      const relevant = this.spendModeOk(s) && relevantFor(s, tick, s.replace ? this.replaceTxFor(s, run) : sentHash);
      if (!relevant) {
        spends[s.id] = { id: s.id, kind: s.kind, role: s.role, label: s.label, replace: s.replace, relevant: false, statements_needed };
        continue;
      }
      const replaceTx = this.replaceTxFor(s, run);
      const dryRec = this.dryFor(s, run, replaceTx, nowMs);
      let expectedDry = null;
      try {
        expectedDry = this.command(s.dry, replaceTx).display;
      } catch {
        expectedDry = null;
      }
      const g = evaluateSpend(s, { run, nowMs, dry: dryRec, expectedDryCommand: expectedDry, requireTyped: false, latch: this.latchOf(s.id), sentHash, wallet: this.walletCtx(s), board: this.boardCtx(s), ...this.programGateCtx(s) });
      // The typed text is the only reason that may be open in the preview: everything else is already decided.
      const plain = describeSpend(s, run && run.terms, run && run.roles && run.roles[s.role] && run.roles[s.role].tick, { wallet: !!this.walletCtx(s) });
      let cmd = null;
      try {
        cmd = this.command(s.id, replaceTx).display;
      } catch {
        cmd = null;
      }
      spends[s.id] = {
        id: s.id,
        kind: s.kind,
        role: s.role,
        label: s.label,
        replace: s.replace,
        relevant: true,
        statements_needed,
        eligible: g.ok,
        reasons: g.reasons,
        // an engine ALARM beside a step that only returns coins to their owner (the ETH refund): not a refusal, shown next to the send box
        notices: g.notices || [],
        expected_typed: g.expected_typed,
        plain,
        command: cmd,
        dry_id: s.dry,
        dry_command: expectedDry,
        replace_tx: replaceTx,
        dry: dryRec
          ? { age_s: Math.floor((nowMs - dryRec.finished_ms) / 1000), at: Math.floor(dryRec.finished_ms / 1000), hash: dryRec.check ? dryRec.check.hash : null, ok: dryRec.ok, result: dryRec.result, rows: dryRec.check ? dryRec.check.rows : [], all_ok: dryRec.check ? dryRec.check.all_ok : false, shown: dryRec.check ? dryRec.check.shown : null, stderr: dryRec.stderr }
          : null,
      };
    }
    const cfg = this.cfg;
    return {
      enabled: true,
      run_number: this.programMode ? null : cfg.runNumber,
      role: this.programMode ? this.curRole() : cfg.role || "both",
      program_mode: this.programMode,
      table: this.describe(production),
      production: production ? { text: production } : null,
      busy: this.busy ? { id: this.busy.id, job: this.busy.job, started_at: Math.floor(this.busy.started_ms / 1000), ...this.busyWarning() } : null,
      jobs: this.jobs.slice(-8).map((j) => ({ ...j })),
      watch: { ...this.watchView(run) },
      // set only for a console that was started before its run folder existed: the page says so and offers nothing but the install step
      lock: this.runLock && this.runLock.isLazy ? this.runLock.status() : null,
      join: this.joinView(),
      wallet: this.walletView(run),
      first_steps: this.programMode && this.firstSteps ? this.firstSteps.view() : null,
      ...this.checkLineView(),
      spends,
      autopilot: this.autopilot ? this.autopilot.view(run) : null,
      funding: {
        object_check_ok: !!(this.objectCheck && this.objectCheck.ok),
        object_check_at: this.objectCheck ? Math.floor(this.objectCheck.at_ms / 1000) : null,
        acknowledged_at: this.funded ? Math.floor(this.funded.at_ms / 1000) : null,
        marker_at: this.fundedMarker(),
        marker_acknowledged: !!(this.fundedMarkerInfo() || {}).acknowledged,
        blocked_by: this.fundedEvidence(run),
      },
      audit: { file: this.audit.file ? path.basename(this.audit.file) : null, tail: this.safeAuditTail(), chain: this.audit.verify() },
      now: Math.floor(nowMs / 1000),
    };
  }

  /**
   * What the page needs of a wallet run: the mode, the payout addresses of the settings (public addresses of the user's own), and per role the newest wallet status (the deposit
   * address and the exact amounts to send, from a clean status only), whether the swap file and the addresses exist, and the markers (funded, swept). No key, no secret.
   */
  walletView(run) {
    const wr = this.walletRun();
    if (!wr.use_swap_wallet && !wr.ambiguous) return { on: false, ambiguous: false };
    const nowMs = this.now();
    const dir = this.runFolder();
    const files = (re, sub) => (dir ? listFiles(sub ? path.join(dir, sub) : dir, re).length > 0 : false);
    const terms = run && run.terms;
    const roles = {};
    for (const role of ["alice", "bob"]) {
      const st = this.walletStatus[role];
      const own = role === "alice" ? terms && terms.eth && terms.eth.alice_receiver : terms && terms.eth && terms.eth.bob_sender;
      const matches = !!(st && st.ok && st.eth && own && String(st.eth.address).toLowerCase() === String(own).toLowerCase() && (role === "bob" || (st.noid && terms && st.noid.address === terms.alice_noid)));
      roles[role] = {
        swap_file: role === "alice" ? files(/^alice\.swap\.json$/) : files(/^bob\.swap\.json$/, "bob"),
        addresses_file: files(/^wallet-addresses\.txt$/),
        ...(role === "bob" ? { key_address: this.bobKeyAddress() } : {}),
        status: st
          ? {
              at: Math.floor(st.at_ms / 1000),
              age_s: Math.floor((nowMs - st.at_ms) / 1000),
              ok: !!st.ok,
              problems: st.ok ? [] : (st.problems || []).slice(0, 3),
              // an address and its amounts are shown only from a clean status that is about this swap's own addresses
              show: matches,
              noid: matches && role === "alice" ? st.noid : null,
              eth: matches ? st.eth : null,
            }
          : null,
      };
    }
    return {
      on: true,
      ambiguous: !!wr.ambiguous,
      noid_payout: wr.noid_payout,
      eth_payout: wr.eth_payout,
      funded_marker: this.walletMarker("wallet-funded.marker"),
      swept: { noid: this.walletMarker("wallet-swept-noid.marker"), eth_alice: this.walletMarker("wallet-swept-eth-alice.marker"), eth_bob: this.walletMarker("wallet-swept-eth-bob.marker") },
      recovered_txid: !!this.recoveredTxid(),
      roles,
    };
  }

  /** The first line (a UTC time) of a wallet helper's marker file in the run folder, or null. */
  walletMarker(name) {
    const dir = this.runFolder();
    if (!dir) return null;
    const f = listFiles(dir, new RegExp("^" + name.replace(/[.]/g, "[.]") + "$"))[0];
    if (!f) return null;
    try {
      const m = /^[0-9TZ:+-]{4,40}/.exec(fs.readFileSync(f.full, "utf8").trim());
      return m ? m[0] : "present";
    } catch {
      return "present";
    }
  }

  /** Bob's swap key address: BOB_ETH of wallet-addresses.txt, read by lib/invitation.js (the one reader of that file), else null. */
  bobKeyAddress() {
    const dir = this.runFolder();
    return dir ? readBobKeyAddress(dir) : null;
  }

  /** The check line and the line match of the run folder for the page: { check_line, line_match } (program mode; null in a terminal console). The match shows only for the current line. */
  checkLineView() {
    if (!this.programMode) return { check_line: null, line_match: null };
    const dir = this.runFolder();
    const cl = firststeps.readCheckLine(dir);
    const role = this.curRole();
    const lm = cl && (role === "alice" || role === "bob") ? firststeps.lineMatchFor(dir, role) : null;
    return { check_line: cl ? { hex: cl.hex, from: cl.from } : null, line_match: lm };
  }

  /**
   * POST /api/checkline/confirm (program mode only): the person says the other side read out its check line and all 16 digits match. Written once to line-match.json after its audit
   * line; the same hex again answers the same without a second line. `body`: { matches: true, hex }.
   */
  confirmCheckLine(body) {
    if (!body || body.matches !== true) throw Object.assign(new Error("matches must be true"), { status: 400 });
    if (!this.programMode) throw Object.assign(new Error("not found"), { status: 404 });
    this.assertLock("check-line");
    this.assertNotProduction("check-line");
    if (this.boardRun().on) throw Object.assign(new Error("A board run compares the full digest by itself."), { status: 409 });
    const dir = this.runFolder();
    const role = this.curRole();
    const cl = firststeps.readCheckLine(dir);
    if (!cl || (role !== "alice" && role !== "bob")) throw Object.assign(new Error("There is no check line yet."), { status: 409 });
    if (typeof body.hex !== "string" || body.hex !== cl.hex) throw Object.assign(new Error("The check line on the page is not this swap's line any more. Read it again."), { status: 409 });
    const have = firststeps.readLineMatch(dir);
    if (have && have.hex === cl.hex && have.role === role) return { status: 200, body: { ok: true, line_match: { hex: have.hex, at: have.at } } };
    // the audit line first: when it cannot be written nothing is recorded
    try {
      this.audit.append({ action: "check-line", role, phase: "note", result: "the other side's line matches", detail: cl.hex });
    } catch (err) {
      throw Object.assign(new Error(`the audit log cannot be written (${err.code || err.message}); nothing was recorded`), { status: 500 });
    }
    try {
      if (have) fs.unlinkSync(path.join(dir, firststeps.MATCH_FILE)); // a record of another line or role: it counted as none, and the new one replaces it
      const rec = firststeps.confirmLineMatch(dir, role, cl.hex, this.now());
      return { status: 200, body: { ok: true, line_match: { hex: rec.hex, at: rec.at } } };
    } catch (err) {
      throw Object.assign(new Error(`the confirmation could not be written (${(err && (err.code || err.message)) || "error"}); nothing was recorded`), { status: 500 });
    }
  }

  /** The txid of the recovery close that wallet-recover.sh sent, or null. */
  recoveredTxid() {
    const dir = this.runFolder();
    if (!dir) return null;
    const f = listFiles(dir, /^wallet-recovered-txid\.txt$/)[0];
    if (!f) return null;
    try {
      const t = fs.readFileSync(f.full, "utf8").split("\n")[0].trim();
      return /^[0-9a-f]{64}$/.test(t) ? t : null;
    } catch {
      return null;
    }
  }

  /**
   * The timer's read-only wallet check (rule 3 of the 2c specification): in a wallet run, for each role this console drives whose swap file exists and whose deposit is still
   * wanted, start wallet-status-ROLE, never more often than every 30 s per role and never while another action runs. It sends nothing. Returns the id it started, or null.
   */
  walletPoll() {
    const wr = this.walletRun();
    if (!wr.use_swap_wallet || wr.ambiguous) return null;
    if (this.busy) return null;
    if (this.programMode && !this.programReady().ok) return null;
    const nowMs = this.now();
    let run = null;
    for (const role of ["alice", "bob"]) {
      if (this.roleBlockFor({ id: "wallet-status", role })) continue;
      if (nowMs - (this.walletPollMark[role] || 0) < WALLET_POLL_MS) continue;
      const id = `wallet-status-${role}`;
      const dir = this.runFolder();
      const have = dir && (role === "alice" ? listFiles(dir, /^alice\.swap\.json$/).length : listFiles(path.join(dir, "bob"), /^bob\.swap\.json$/).length);
      if (!have) continue;
      if (!run) run = this.readRunFn(this.cfg.runDirs, Math.floor(nowMs / 1000));
      if (this.productionBlock(run)) return null;
      const tick = run && run.roles && run.roles[role] && run.roles[role].tick;
      // the deposit matters until the funding (Alice) or the lock (Bob) is on its way
      if (role === "alice" && this.walletMarker("wallet-funded.marker")) continue;
      if (role === "bob" && tick && !["received", "funded", "funding_final"].includes(tick.phase_after)) continue;
      this.walletPollMark[role] = nowMs;
      try {
        this.startAction(id, { poll: true });
        return id;
      } catch {
        return null;
      }
    }
    return null;
  }

  safeAuditTail() {
    try {
      // the read-only deposit status runs about every 40 s in a wallet run and writes two lines each time: they stay in the log, but do not push the sends out of the page's tail
      return this.audit.tail(300).filter((r) => !/^wallet-status-(alice|bob)$/.test(String(r.action))).slice(-40);
    } catch {
      return [];
    }
  }

  watchView(run) {
    if (this.programMode) {
      // the loop is a timer of this program (lib/stepexec.js): there is no process to ask WSL about
      const ws = this.executor.watchStatus();
      const role = this.curRole();
      const mtime = role && run && run.roles && run.roles[role] ? run.roles[role].loop_mtime : null;
      const age = typeof mtime === "number" ? this.nowS() - mtime : null;
      return { started_here: ws.running === true, pid: null, checked_at: this.nowS(), loop_file_age_s: age, some_loop_running: age !== null && age <= WATCH_FRESH_S, in_process: true, ticks: ws.ticks, last_end: ws.last_end || null, mode: ws.running === true && (ws.mode === "read" || ws.mode === "apply") ? ws.mode : null };
    }
    this.refreshWatch();
    // only the roles this console drives count: a loop file of the other role (another machine's, or an old copy) says nothing about this machine
    const mine = this.cfg.role === "alice" || this.cfg.role === "bob" ? [this.cfg.role] : ["alice", "bob"];
    const loops = mine.map((r) => run && run.roles && run.roles[r] && run.roles[r].loop_mtime).filter((x) => typeof x === "number");
    const newest = loops.length ? Math.max(...loops) : null;
    const age = newest === null ? null : this.nowS() - newest;
    return {
      started_here: this.watch.alive === true,
      pid: this.watch.pid,
      checked_at: this.watch.checked_ms ? Math.floor(this.watch.checked_ms / 1000) : null,
      loop_file_age_s: age,
      some_loop_running: age !== null && age <= WATCH_FRESH_S,
      mode: null, // the two watch modes exist in program mode only
    };
  }

  /** Asks WSL whether the loop this console started is alive; cached, one at a time, never while an action runs. */
  refreshWatch(force = false) {
    if (this.programMode) return;
    if (!this.pollWatch && !force) return;
    if (this.watch.checking || (!force && this.now() - this.watch.checked_ms < WATCH_CACHE_MS)) return;
    if (this.busy && !force) return;
    let cmd;
    try {
      cmd = this.watchStatusCommand();
    } catch {
      return;
    }
    this.watch.checking = true;
    try {
      this.exec(cmd.file, cmd.args, { env: cmd.env, timeout: 20000, maxBuffer: 64 * 1024, windowsHide: true, shell: false }, (err, stdout) => {
        this.watch.checking = false;
        this.watch.checked_ms = this.now();
        const m = !err && /^alive (\d+)/m.exec(String(stdout || ""));
        this.watch.alive = !!m;
        this.watch.pid = m ? Number(m[1]) : null;
      });
    } catch {
      this.watch.checking = false;
    }
  }

  watchStatusCommand() {
    const c = buildActionCommand("watch-start", this.cfg, { env: this.env });
    // the same envelope as the start command, with the fixed status script as the last argument
    if (c.args[c.args.length - 1] !== WATCH_STARTS[this.cfg.role || "both"]) throw new Error("internal: watch envelope");
    const args = c.args.slice();
    args[args.length - 1] = WATCH_STATUS;
    return { ...c, args };
  }

  // ------------------------------------------------------------------ dry-run records
  dryFor(spend, run, replaceTx, nowMs) {
    const rec = this.dry.get(spend.id);
    if (!rec) return null;
    const check = rec.bytes
      ? checkDryRun(spend.kind, rec.bytes, { terms: run && run.terms, tick: run && run.roles && run.roles[spend.role] && run.roles[spend.role].tick, now: Math.floor(nowMs / 1000), replace: spend.replace, replaceTx, objectSha: this.objectSha(run), objectPath: (this.objectInfo(run) || {}).path || null, walletDefault: this.walletDefault(), distro: this.cfg.distro || null, role: spend.role, walletRun: this.walletRun().use_swap_wallet === true, noidPayout: this.walletRun().noid_payout, ethPayout: this.walletRun().eth_payout })
      : null;
    return { ...rec, check };
  }

  // ------------------------------------------------------------------ starting things
  /** A non-spending action by id (setup, tick, dry run, watch). Returns the running job record. */
  startAction(id, meta = {}) {
    const e = BY_ID.get(id);
    if (!e) throw Object.assign(new Error(`unknown action id: ${JSON.stringify(String(id).slice(0, 40))}`), { status: 400 });
    if (e.group === "spend") throw Object.assign(new Error("a spending action needs the confirmation flow (POST /api/spend)"), { status: 400 });
    if (this.programMode && TERMINAL_ONLY.has(id)) {
      this.noteProgramRefusal(e, "terminal_only");
      throw Object.assign(new Error("this step belongs to the terminal console: the program does not run it"), { status: 409 });
    }
    if (this.programMode && !meta.poll) this.assertNotProduction(id); // a production run.json is said to be one (403) before its role is asked
    const blocked = this.roleBlockFor(e);
    if (blocked) {
      if (this.programMode) {
        if (!meta.poll) this.noteProgramRefusal(e, "role");
        throw Object.assign(new Error(blocked), { status: 409 });
      }
      throw Object.assign(new Error(blocked), { status: 403 });
    }
    // a board-only entry is started by the board host alone (its private token), never by a request
    if (e.hostOnly && meta.host !== this.hostToken) throw Object.assign(new Error(`${id} is a step of the offer board: only the board starts it`), { status: 403 });
    // in a board run the board drives the steps that make the swap files, in its own order: a click on one of them is refused
    if (BOARD_DRIVEN.has(id) && meta.host !== this.hostToken && this.boardRun().on) {
      try {
        this.audit.append({ action: id, role: e.role || null, phase: "refused", result: "refused: board run" });
      } catch {
        /* the refusal stands without its line */
      }
      throw Object.assign(new Error(`this is a board run: the board runs ${id} itself, in its own order`), { status: 409 });
    }
    this.assertPendingLock(id);
    this.assertNotProduction(id);
    this.assertMode(e);
    if (this.walletRun().ambiguous && (e.group === "dry" || e.id === "prepare" || e.id === "join")) this.assertMode({ id, role: e.role, mode: "wallet" });
    this.assertProgram(e, { sender: false, quiet: !!meta.poll });
    this.preflight(id);
    let run = null;
    let txHash = null;
    let spend = null;
    if (e.spend) {
      spend = SPENDS[e.spend];
      run = this.readRunFn(this.cfg.runDirs, this.nowS());
      if (spend.replace) {
        txHash = this.replaceTxFor(spend, run);
        if (!txHash) {
          // the helper would search the pool itself; the console wants the hash so that the dry run is bound to ONE transaction
          throw Object.assign(new Error("no pending transaction hash is known to compare against (the engine's tick or the helper's stderr names none)"), { status: 409 });
        }
      }
    }
    if (id === "install" && !this.programMode) {
      const w = this.watchView(this.readRunFn(this.cfg.runDirs, this.nowS()));
      if (w.started_here || w.some_loop_running) throw Object.assign(new Error("a watch loop is running: install.sh rewrites the helpers it calls. Stop the loop first"), { status: 409 });
      if (this.swapFilesExist()) throw Object.assign(new Error("this run already has swap files: do not replace the frozen helpers mid-swap"), { status: 409 });
    }
    if (id === "watch-start" && !this.programMode) {
      const w = this.watchView(this.readRunFn(this.cfg.runDirs, this.nowS()));
      if (w.started_here || w.some_loop_running) throw Object.assign(new Error("a watch loop seems to be running already (its loop file was updated recently); a second one doubles the ticks"), { status: 409 });
    }
    // join.sh takes the bundle from the run folder; only when the run folder has no file of that name and the public copy folder has a good one is that file's path
    // (built from this console's own configuration) its one argument
    let bundleFromPublic = false;
    if (id === "join" && !this.programMode) {
      const jf = this.joinView();
      bundleFromPublic = !jf.run_bundle && !!(jf.public_bundle && jf.public_bundle.ok && jf.public_arg);
    }
    const cmd = this.command(id, txHash, { bundleFromPublic });
    return this.launch(e, cmd, { ...meta, role: e.role || null, spend, run, replaceTx: txHash, bundleFromPublic });
  }

  /** The confirmed spend. `typed` is what the operator typed; the gate re-checks everything. */
  startSpend(id, typed, meta = {}) {
    const spend = SPENDS[id];
    const e = BY_ID.get(id);
    if (!spend || !e) throw Object.assign(new Error(`unknown spend id: ${JSON.stringify(String(id).slice(0, 40))}`), { status: 400 });
    if (this.programMode) this.assertNotProduction(id);
    const blocked = this.roleBlockFor(e);
    if (blocked) {
      if (this.programMode) {
        this.noteProgramRefusal(e, "role");
        throw Object.assign(new Error(blocked), { status: 409 });
      }
      throw Object.assign(new Error(blocked), { status: 403 });
    }
    this.assertLock(id);
    const nowMs = this.now();
    const run = this.readRunFn(this.cfg.runDirs, Math.floor(nowMs / 1000));
    this.assertNotProduction(id, run);
    if (spend.walletOnly) this.assertMode(e); // a wallet-only spend is refused in a classic run; the funding (both modes) runs the helper of the run's mode
    else if (this.walletRun().ambiguous) this.assertMode({ id, role: spend.role, mode: "wallet" });
    this.assertProgram(e, { sender: true });
    this.preflight(id);
    const replaceTx = this.replaceTxFor(spend, run);
    if (spend.replace && !replaceTx) {
      this.audit.append({ action: id, role: spend.role, phase: "refused", result: "refused: no_pending_tx" });
      throw Object.assign(new Error("no pending transaction hash is known to replace"), { status: 422, reasons: [{ code: "no_pending_tx", text: "The engine's tick and the helper's stderr name no pending transaction to replace." }] });
    }
    const dry = this.dryFor(spend, run, replaceTx, nowMs);
    let expectedDry;
    try {
      expectedDry = this.command(spend.dry, replaceTx).display;
    } catch (err) {
      throw Object.assign(err, { status: err.status || 409 });
    }
    // An automatic start (meta.auto) can come only from lib/autopilot.js: the value is that module's own private object, never anything a request carries
    // (lib/actionroutes.js does not pass it). With an approval in force for this spend's role the typed text and the funding statements are the
    // approval's; every other check below runs unchanged. Without one the spend is refused outright.
    let typedText = typed;
    let statement = meta.noPendingFunding === true;
    let bobCheck = meta.bobCheckMatches === true;
    let aliceCheck = meta.aliceCheckMatches === true;
    let auto = null;
    if (meta.auto !== undefined && meta.auto !== null) {
      auto = !spend.replace && this.autopilot && typeof this.autopilot.authorize === "function" ? this.autopilot.authorize(meta.auto, spend, run, nowMs) : null;
      if (!auto) {
        this.audit.append({ action: id, role: spend.role, phase: "refused", result: "refused: autopilot_off" });
        throw Object.assign(new Error("the autopilot is not approved for this step"), { status: 422, reasons: [{ code: "autopilot_off", text: "No autopilot approval is in force for this step (none was given, the terms changed since, or the step is a re-send, which is never automatic)." }] });
      }
      const exp = expectedAmount(spend, run && run.terms);
      typedText = exp ? exp.text : null;
      statement = auto.statements;
      bobCheck = auto.statements;
      aliceCheck = auto.aliceCheck === true;
    }
    const programGate = this.programGateCtx(spend);
    const g = evaluateSpend(spend, { run, nowMs, dry, expectedDryCommand: expectedDry, typed: typedText, requireTyped: true, latch: this.latchOf(id), sentHash: this.sentHashFor(spend, run), statement, bobCheck, aliceCheck, wallet: this.walletCtx(spend), board: this.boardCtx(spend), ...programGate });
    if (!g.ok) {
      this.audit.append({ action: id, role: spend.role, phase: "refused", result: "refused: " + g.reasons.map((r) => r.code).join(","), dry_hash: dry && dry.check ? dry.check.hash : null, detail: auto ? `auto=1; approval=${auto.approval}` : null });
      throw Object.assign(new Error("the gate refused this spend"), { status: 422, reasons: g.reasons });
    }
    if (auto && spend.kind === "fund_noid") this.autopilot.consumeFunding(); // the statements are good for ONE automatic start
    const cmd = this.command(id, replaceTx);
    const tick = run.roles[spend.role].tick;
    const latch = { tickNow: typeof tick.now === "number" ? tick.now : null, intentAt: tick.intent && tick.intent.intent && typeof tick.intent.intent.decided_at === "number" ? tick.intent.intent.decided_at : null };
    this.dry.delete(id); // a dry run authorizes one start
    return this.launch(e, cmd, { ...meta, auto: undefined, autoApproval: auto ? auto.approval : null, aliceCheckRequired: programGate.aliceCheckRequired === true, role: spend.role, spend, run, replaceTx, dryHash: dry.check.hash, latch });
  }

  /**
   * A spend starts only while the run folder's lock file still holds this console's pid and start time (a second console that took a stale lock
   * at the same moment, or a deleted file, would otherwise let two consoles spend). Without a lock object (unit tests) there is nothing to read.
   */
  assertLock(id, o = {}) {
    const l = this.runLock;
    if (!l) return;
    const v = l.verify();
    if (v.ok) return;
    if (o.allowMissingFolder && v.folder_missing) return;
    try {
      this.audit.append({ action: id, role: null, phase: "refused", result: v.folder_missing ? "refused: run folder does not exist yet" : "refused: run lock not ours" });
    } catch {
      /* the refusal stands without its line */
    }
    if (v.folder_missing) throw Object.assign(new Error(`${v.why}. Nothing is spent from here until the folder exists and this console holds its lock`), { status: 409 });
    if (l.isLazy && !l.held) throw Object.assign(new Error(`this console does not hold the run folder's lock (${l.file}): ${v.why}. Nothing is spent from here`), { status: 409 });
    throw Object.assign(new Error(`this console no longer holds the run folder's lock (${l.file}): ${v.why}. Another console may be running on this run folder, so nothing is spent from here. Stop this console; if no console is running, delete ${l.file} and start the console again`), { status: 409 });
  }

  /**
   * The look at the lock file for everything that changes state but spends nothing (setup, prepare, ticks, dry runs, watch start/stop, the settings
   * form): the same check and the same refusal (409, audit line) as a spend. A console started before its run folder existed (lib/runlock.js
   * LazyRunLock) tries to take the lock now; until it holds it, only the install step (which creates the folder) runs.
   */
  assertPendingLock(id) {
    this.assertLock(id, { allowMissingFolder: id === "install" });
  }

  preflight(id) {
    if (this.busy) throw Object.assign(new Error(`busy: ${this.busy.id} is still running (one action at a time)`), { status: 409 });
    const last = this.last.get(id) || 0;
    const entry = BY_ID.get(id);
    if (this.now() - last < (entry && entry.minGapMs ? entry.minGapMs : MIN_GAP_MS)) throw Object.assign(new Error("too fast: wait a moment between runs"), { status: 429 });
  }

  /** Logs the start (fail closed), marks busy, runs. Never throws after the start line is written. */
  launch(e, cmd, meta) {
    const started = this.now();
    if (e.group === "spend") this.assertLock(e.id); // the last look at the lock file before anything is written or run
    const job = ++this.jobSeq;
    // the line before: if it cannot be written, nothing runs
    try {
      this.audit.append({ action: e.id, role: meta.role || null, phase: "start", result: "started", dry_hash: meta.dryHash || null, detail: [meta.replaceTx ? `replaces ${meta.replaceTx}` : null, e.group === "spend" && meta.spend && meta.spend.kind === "fund_noid" ? (this.boardCtx(meta.spend) ? "board run: the handover check by the board, no human statement" : this.walletCtx(meta.spend) ? "statement=bob_check_line_matches; wallet run: no funding statement asked" : "statement=no_pending_funding; statement=bob_check_line_matches") : null, meta.bundleFromPublic ? "bundle from the public copy folder" : null, meta.firstSteps === true ? "started by the program" : null, e.group === "spend" && meta.aliceCheckRequired === true ? "statement=alice_check_line_matches" : null, meta.autoApproval ? `auto=1; approval=${meta.autoApproval}` : null, meta.latch ? `tick=${meta.latch.tickNow === null ? "-" : meta.latch.tickNow};intent=${meta.latch.intentAt === null ? "-" : meta.latch.intentAt}` : null].filter(Boolean).join("; ") || null });
    } catch (err) {
      throw Object.assign(new Error(`the audit log cannot be written (${err.code || err.message}); nothing was run`), { status: 500 });
    }
    this.last.set(e.id, started);
    const latchBefore = this.latch.get(e.id) || null;
    if (e.group === "spend" && meta.latch) this.latch.set(e.id, { tickNow: meta.latch.tickNow, intentAt: meta.latch.intentAt === null ? (this.latch.get(e.id) || {}).intentAt || null : meta.latch.intentAt });
    this.busy = { id: e.id, job, started_ms: started };
    const rec = { job, id: e.id, label: e.label, group: e.group, role: meta.role || null, script: cmd.script || null, command: cmd.display, state: "running", warning: null, started_at: Math.floor(started / 1000), finished_at: null, ok: null, exit_code: null, timed_out: false, stdout: "", stderr: "", error: null, files: [], tx: null, dry_hash: meta.dryHash || null, next: null };
    this.jobs.push(rec);
    if (e.group === "spend") this.noteSpendRun(e.id, true);
    if (this.jobs.length > 30) this.jobs.shift();
    const before = e.result ? new Map(listFiles(this.runFolder() || "", e.result).map((f) => [f.name, f.mtimeMs])) : new Map();

    const finish = (err, stdout, stderr, extra = {}) => {
      try {
        const ended = this.now();
        rec.state = "done";
        rec.finished_at = Math.floor(ended / 1000);
        rec.ok = !err;
        rec.exit_code = err ? (typeof err.code === "number" ? err.code : null) : 0;
        rec.timed_out = !!(err && err.killed);
        rec.signal = err && err.signal ? String(err.signal) : null;
        rec.error = err && typeof err.code !== "number" ? String(err.message).slice(0, 300) : null;
        rec.stdout = cleanOutput(stdout);
        rec.stderr = cleanOutput(stderr);
        Object.assign(rec, extra);
        this.collect(e, rec, before, started, meta, stdout, stderr);
        // A spend the helper refused cleanly sent nothing (lib/exitcodes.js): its latch is released, and the audit end line says so (the latch rebuild reads it).
        if (e.group === "spend" && rec.nothing_sent) {
          if (latchBefore) this.latch.set(e.id, latchBefore);
          else this.latch.delete(e.id);
        }
        // (the audit log keeps the first 120 characters of a result: the verdict comes first)
        // A wallet helper whose answer is "may have been sent, and the same command sends the same recorded bytes" keeps the latch of its tick and drops the latch of its intent.
        if (e.group === "spend" && rec.rerun_safe) this.latch.set(e.id, { tickNow: meta.latch ? meta.latch.tickNow : null, intentAt: latchBefore ? latchBefore.intentAt : null });
        const secretWord = rec.warning ? (rec.secret_certain ? "SECRET PUBLIC: " : "SECRET MAY BE PUBLIC: ") : "";
        const mayHave = e.group === "spend" ? ", the transaction may have been sent" : "";
        const result = rec.nothing_left
          ? `nothing to sweep (exit ${rec.exit_code})`
          : rec.nothing_sent
          ? `refused, nothing sent (${rec.script || (e.script && e.script.name)} exit ${rec.exit_code})`
          : rec.rerun_safe
          ? `may have been sent, the same bytes may be sent again (${rec.script} exit ${rec.exit_code})`
          : secretWord + (rec.ok ? "ok (exit 0)" : rec.timed_out ? `timeout${mayHave || " (the helper may still have run)"}` : rec.exit_code !== null ? `failed (exit ${rec.exit_code}${mayHave})` : `launch error${mayHave} (${rec.error})`);
        // check-object.sh: swap-cli prints "object file OK: ..." on STDERR (stdout carries the object's JSON); a mismatch exits 1.
        if (e.id === "check-object") this.objectCheck = { ok: rec.ok && /^object file OK\b/m.test(`${stderr || ""}\n${stdout || ""}`), at_ms: ended };
        if (e.id === "watch-stop") this.watch.alive = false;
        if (e.group === "spend") rec.next = describeSpend(meta.spend, meta.run && meta.run.terms, null).next;
        try {
          this.audit.append({ action: e.id, role: meta.role || null, phase: "end", result, dry_hash: meta.dryHash || (rec.dry_hash || null), tx: rec.tx, detail: rec.files.length ? rec.files.map((f) => f.name).join(",") : rec.funded_marker ? `funded.marker ${rec.funded_marker}` : null });
        } catch (aerr) {
          rec.error = `${rec.error || ""} (audit end line failed: ${aerr.code || aerr.message})`.trim();
        }
      } finally {
        this.busy = null;
      }
    };

    if (this.programMode) {
      this.runStep(e, rec, meta, finish);
      return { ...rec };
    }

    if (e.id === "watch-start") {
      try {
        const child = this.spawnDetached(cmd.file, cmd.args, { env: cmd.env, detached: true, stdio: "ignore", windowsHide: true, shell: false });
        if (child && typeof child.unref === "function") child.unref();
        if (child && typeof child.on === "function") child.on("error", () => {});
        this.watch.alive = true;
        this.watch.started_ms = this.now();
        this.watch.checked_ms = this.now();
        finish(null, "started detached; the loop keeps running when this page is closed", "");
        // learn the pid a moment later
        setTimeout(() => this.refreshWatch(true), 1500).unref();
      } catch (err) {
        finish(Object.assign(err, { code: err.code || "SPAWN" }), "", "");
      }
      return { ...rec };
    }

    try {
      this.exec(cmd.file, cmd.args, { env: cmd.env, timeout: e.timeout || 3 * MIN, maxBuffer: 2 * 1024 * 1024, windowsHide: true, shell: false }, (err, stdout, stderr) => finish(err, stdout, stderr));
    } catch (err) {
      finish(Object.assign(err, { code: err.code || "SPAWN" }), "", "");
    }
    return { ...rec };
  }

  /**
   * Program mode: runs the entry as a step through the executor and settles the job from its result. The step's code is its own (null = may have been sent); a rejected promise
   * is a null too. A running step is never abandoned: `busy` stays until it settles (`busyWarning` tells the page when it is past its time).
   */
  runStep(e, rec, meta, finish) {
    const x = {};
    if (meta.replaceTx) x.tx = meta.replaceTx;
    if (typeof meta.bundlePath === "string") x.bundlePath = meta.bundlePath;
    let p;
    try {
      p = Promise.resolve(this.executor.run(e, x));
    } catch (err) {
      p = Promise.reject(err);
    }
    const settle = (res, threw) => {
      const r = res && typeof res === "object" ? res : {};
      const code = Number.isInteger(r.code) ? r.code : null;
      Object.defineProperty(rec, "_files", { value: Array.isArray(r.files) ? r.files.slice() : [], enumerable: false, writable: true, configurable: true });
      Object.defineProperty(rec, "_refused", { value: r.refused === true, enumerable: false, writable: true, configurable: true });
      const err = code === 0 ? null : Object.assign(new Error(code === null ? (r.refused ? String(r.why || "refused before the step started").slice(0, 200) : threw ? "the step stopped on an internal error: it may have been sent" : "the step ended without a code: it may have been sent") : `exit ${code}`), { code });
      finish(err, r.stdout || "", r.stderr || "");
    };
    p.then(
      (res) => settle(res, false),
      () => settle(null, true),
    ).catch((err) => {
      rec.error = `${rec.error || ""} (the job could not be settled: ${(err && err.code) || "error"})`.trim();
      if (this.busy && this.busy.job === rec.job) this.busy = null;
    });
  }

  /** The page's warning for a running action past its time (program mode): never a kill of a spend, only the words. `{}` before that. */
  busyWarning() {
    if (!this.programMode || !this.busy) return {};
    const e = BY_ID.get(this.busy.id);
    const limit = e && e.timeout ? e.timeout : 3 * MIN;
    const elapsed = this.now() - this.busy.started_ms;
    if (elapsed <= limit) return {};
    const minutes = Math.floor(elapsed / MIN);
    const sender = e && (e.group === "spend" || /^board-sign-/.test(e.id));
    return { overdue: true, overdue_minutes: minutes, warning: `still running after ${minutes} minutes: do not start another action; ${sender ? "quitting now counts as may have been sent" : "it is stopped by the program after its time limit"}` };
  }

  /** After a job: the result file(s) it wrote, the transaction hash, and (for a dry run) the stored record. */
  collect(e, rec, before, startedMs, meta, stdout, stderr) {
    const dir = this.runFolder();
    let main = null;
    if (e.result && dir) {
      const fresh = listFiles(dir, e.result).filter((f) => f.mtimeMs >= startedMs - 5000 && (!before.has(f.name) || before.get(f.name) !== f.mtimeMs)).sort((a, b) => b.mtimeMs - a.mtimeMs);
      if (fresh.length) {
        const f = fresh[0];
        try {
          const bytes = fs.readFileSync(f.full);
          main = { name: f.name, bytes };
          let j = null;
          try {
            j = JSON.parse(bytes.toString("utf8"));
          } catch {
            j = null;
          }
          const s = j ? redactDeep(j) : null;
          rec.files.push({ name: f.name, size: f.size, summary: s ? shrink(s) : null });
          // reveal.sh exit 3: the claim was mined and REVERTED. It paid nobody and the secret is public (REVIEW-6 R6-3).
          if (j && (j.reverted === true || j.secretPublic === true)) rec.secret_certain = true;
          if (j && (j.reverted === true || j.secretPublic === true)) rec.warning = "The claim was mined and reverted: it paid nobody, but the SECRET IS PUBLIC now. Run a tick with --apply at once (the watch loop does) and decide on a re-send with the engine; do not wait.";
          const tx = j && (j.txHash || (j.plan && j.mode === "submit" && j.plan.txid));
          if (typeof tx === "string") rec.tx = tx;
        } catch {
          /* unreadable: said below */
        }
      }
    }
    // fund.sh and the wallet helpers write no result file: what they printed IS the dry run (the wallet CLI's own output is merged into stdout by fund.sh)
    if (e.text) {
      const text = String(stdout || "").slice(0, 65536);
      if (text.trim()) main = { name: null, bytes: Buffer.from(text, "utf8") };
    }
    // How a spend ended, read exactly (lib/exitcodes.js): only an exit status the helper documents as "nothing was sent", with output that agrees, is a clean
    // refusal; everything else (unknown status, signal, timeout, no readable result) stays "the transaction may have been sent".
    let cls = null;
    // the wallet helpers whose evidence is their stdout (a validated `wallet-X: outcome ...` line), not a result file
    const walletText = /^wallet-(fund|recover)\.sh$/.test(rec.script || "") || (rec.script === "wallet-sweep.sh" && e.id === "send-sweep-noid");
    if (walletText) {
      const tx = /^wallet-(?:fund|recover|sweep): txid ([0-9a-f]{64})$/m.exec(String(stdout || ""));
      if (tx) rec.tx = tx[1];
      rec.sent_line = /^wallet-(?:fund|recover|sweep): outcome sent$/m.test(String(stdout || ""));
    }
    if (e.group === "spend") {
      if (this.programMode) {
        // a step is judged by its own code and fixed lines (exitcodes.js classifyStepExit, Appendix B), never by classifySpendExit; the executor's own refusal happened before the step
        const so = STEP_OF[e.id];
        cls = rec._refused
          ? { outcome: NOT_SENT, nothing_sent: true, secret_may_be_public: false, why: "the program refused it before the step started", source: null }
          : classifyStepExit(so ? so.step : "", { code: rec.exit_code, stdout: String(stdout || ""), files: rec._files || [], kind: so ? so.kind : undefined });
        // a lock, a reveal or a refund that ended in code 1 (live.js's own error, or its key could not be emitted): the page says what to do (spec 5.A.10)
        if (rec.exit_code === 1 && /^send-(?:lock|reveal|refund-eth)/.test(e.id)) rec.advice = "Look at the result. A missing `sent:` line does not prove that nothing was sent: wait for the next status update, and look at the swap's phase and the contract, before you try again.";
      } else cls = classifySpendExit(rec.script || e.script.name, { exitCode: rec.exit_code, timedOut: rec.timed_out, signal: rec.signal, stdout: String(stdout || ""), stderr: String(stderr || ""), hasResult: walletText ? false : !!main });
      rec.outcome = cls.outcome;
      if (e.group === "spend") this.noteSpendRun(e.id, cls.outcome === "may_have_sent" || cls.outcome === "secret_public_reverted");
      rec.nothing_sent = cls.nothing_sent;
      rec.waiting = cls.waiting === true;
      rec.rerun_safe = cls.rerun_safe === true;
      rec.secret_may_be_public = cls.secret_may_be_public === true;
      if (cls.outcome === "secret_public_reverted") {
        rec.secret_certain = true;
        if (!rec.warning) rec.warning = "The claim was mined and reverted (the helper exited 3): it paid nobody, but the SECRET IS PUBLIC now. Run a tick with --apply at once (the watch loop does) and decide on a re-send with the engine; do not wait.";
      }
      if (cls.nothing_sent) rec.error = `${cls.waiting ? "Nothing to send now" : "Refused"} by ${rec.script || e.script.name}, nothing was sent: ${cls.why}. The step can be tried again after a fresh dry run (this console released its latch for it).`;
      else if (cls.rerun_safe) rec.error = `${rec.script} says the transaction MAY have been sent: ${cls.why}. This console lets the step run again on a later tick.`;
    }
    if (e.id === "send-fund" && rec.script === "wallet-fund.sh") {
      // a wallet run's funding: the evidence is the helper's marker (written when it sent, or found the funding at the contract) and its stdout, not funded.marker
      rec.funded_marker = this.walletMarker("wallet-funded.marker");
      if (cls && !cls.nothing_sent && !cls.rerun_safe && !rec.ok) rec.error = `${rec.error || ""} (wallet-fund.sh did not end as a documented outcome: look at the swap wallet and at the contract before doing anything; running it again sends only the recorded bytes)`.trim();
    } else if (e.id === "send-fund" && cls && cls.nothing_sent) {
      rec.funded_marker = this.fundedMarker();
    } else if (e.id === "send-fund") {
      // The marker, not a transaction hash, is the evidence: fund.sh writes it BEFORE the wallet CLI runs and leaves it when the CLI fails.
      const at = this.fundedMarker();
      rec.funded_marker = at;
      if (rec.ok && !at) rec.error = `${rec.error || ""} (the helper exited 0 but left no funded.marker: look at the wallet and at "contract instances" before doing anything)`.trim();
      else if (!rec.ok) rec.error = `${rec.error || ""} (fund.sh failed. If it got as far as the wallet CLI, funded.marker is still there on purpose: the funding may be pending. Look at the mempool and at "contract instances" before deleting the marker by hand. Do not run it again)`.trim();
    } else if (e.group === "spend" && cls && cls.nothing_sent) {
      // nothing more to say: the refusal text above stands, and no transaction hash can exist
    } else if (e.group === "spend" && walletText) {
      // nothing more to say: the helper's own lines are in the output, and a refusal or a wait is described above
      if (!cls.nothing_sent && !cls.rerun_safe && !rec.ok) rec.error = `${rec.error || ""} (${rec.script} did not end as a documented outcome: do not assume nothing was sent; look at the wallet and at the chain)`.trim();
    } else if (e.group === "spend") {
      if (!rec.tx) {
        const m = /\bsent: (0x[0-9a-fA-F]{64})\b/.exec(String(stderr || "") + "\n" + String(stdout || ""));
        if (m) rec.tx = m[1];
      }
      if (!rec.tx && dir) {
        // eth-claim.err / eth-lock-N.err / eth-refund-N.err hold the "sent:" line the helper prints before it waits
        const errs = listFiles(dir, /^(?:eth-claim|eth-lock-\d+|eth-refund-\d+)\.err$/).filter((f) => f.mtimeMs >= startedMs - 5000).sort((a, b) => b.mtimeMs - a.mtimeMs);
        for (const f of errs.slice(0, 3)) {
          try {
            const m = /\bsent: (0x[0-9a-fA-F]{64})\b/.exec(fs.readFileSync(f.full, "utf8"));
            if (m) {
              rec.tx = m[1];
              break;
            }
          } catch {
            /* next */
          }
        }
      }
      if (!main) rec.error = `${rec.error || ""} (no result file found: do not assume the transaction was not sent; wait for the next tick)`.trim();
      else if (!rec.ok) rec.error = `${rec.error || ""} (the helper failed, but it may have sent the transaction before it did: do not assume it was not; wait for the next ticks and use the terminal if you must retry)`.trim();
      // A reveal that did not end in a clean success or a documented clean refusal (an unknown or a delivered-and-rejected outcome of the claim's
      // bounded send, a timeout, a signal, no readable result) may have published the secret: the careful reading, whatever the helper's text says.
      // The console never re-sends it by itself: a re-send is its own button (the engine's held intent, a pending claim, a fresh dry run, your typed amount).
      if ((e.id === "send-reveal" || e.id === "send-reveal-replace") && !rec.warning && cls && !(rec.ok && main && rec.files.length && rec.files[0].summary)) {
        rec.secret_may_be_public = true;
        rec.warning = "The reveal did not end as a clean success, and this console cannot tell that nothing was sent: treat the SECRET as PUBLIC (the helper's text above may say more, but only its refusal before it started counts as nothing sent). Run a tick with --apply now (the watch loop does) and let the engine judge; it decides whether a re-send is still allowed. This console never re-sends a reveal by itself.";
      }
    }
    // an empty swap wallet: the tool's own refusal of the NOID sweep (exit 3 with its words). Nothing is left to send; the autopilot ends that sweep and the audit line says so.
    // a real sweep also needs the step's own "nothing was sent" reading, so a may-have-been-sent ending can never be called "nothing to sweep"
    if ((e.id === "dry-sweep-noid" || (e.id === "send-sweep-noid" && rec.nothing_sent === true)) && rec.ok === false && rec.exit_code === 3 && isNothingToSweep(`${stdout || ""}\n${stderr || ""}`)) rec.nothing_left = true;
    if (/^wallet-status-(alice|bob)$/.test(e.id)) {
      // the deposit status: kept only as a fact of this process (a restart forgets it, and the gate then refuses until a new one is read)
      const role = e.id.slice("wallet-status-".length);
      const parsed = parseWalletStatus(String(stdout || ""), role);
      this.walletStatus[role] = rec.ok && parsed.ok ? { at_ms: this.now(), ok: true, noid: parsed.noid, eth: parsed.eth, problems: [] } : { at_ms: this.now(), ok: false, noid: null, eth: null, problems: rec.ok ? parsed.problems : [rec.timed_out ? "the status helper timed out" : `the status helper failed (exit ${rec.exit_code})`].concat(parsed.problems.slice(0, 1)) };
    }
    if (e.group === "dry") {
      const spend = SPENDS[e.spend];
      this.dry.set(spend.id, {
        spend: spend.id,
        command: rec.command,
        finished_ms: this.now(),
        ok: rec.ok && !!main,
        result: rec.ok ? (main ? "ok" : "no result file") : rec.timed_out ? "timeout" : `exit ${rec.exit_code}`,
        bytes: main ? main.bytes : null,
        // fund.sh prints its refusals on stdout ("REFUSED: ...", "dry run: a real run would be REFUSED ...")
        stderr: (e.text ? rec.stdout || rec.stderr : rec.stderr) ? (e.text ? rec.stdout || rec.stderr : rec.stderr).slice(0, e.text ? 1800 : 600) : null,
        replaceTx: meta.replaceTx || null,
      });
      // A failed helper leaves an empty result file: the sha256 of nothing is not a dry run's hash and must not go into the audit log as one.
      if (main && main.bytes.length > 0) rec.dry_hash = crypto.createHash("sha256").update(main.bytes).digest("hex");
    }
  }

  // ------------------------------------------------------------------ the funding acknowledgement
  /**
   * "I have funded" (a funding done outside fund.sh: the wallet's own command, or fund.sh under another console). The marker is the persistent
   * truth, the same one fund.sh leaves: `funded.marker` in the run folder, created exclusively, first line the time, second line
   * `acknowledged: funded outside fund.sh`; and `funded-<contract root>.marker` next to the object file. Refused (409, with an audit
   * `refused` line) when the terms carry no contract root or no object file is visible: the second marker could not be named. fund.sh in a
   * terminal, another console or a console with another audit folder then refuses too, as long as it uses this run folder or this object
   * folder (the per-user marker is fund.sh's alone). The audit line stays. Refused (409) once a marker exists (the funding is known already, or fund.sh is running). A send-fund
   * that fund.sh refused before it wrote a marker does not close the acknowledgement.
   */
  acknowledgeFunding() {
    const blocked = this.roleBlockFor({ id: "funded", role: "alice" });
    if (blocked) throw Object.assign(new Error(blocked), { status: 403 });
    this.assertNotProduction("funded-ack");
    const wrun = this.walletRun();
    if (wrun.use_swap_wallet || wrun.ambiguous) {
      try {
        this.audit.append({ action: "funded-ack", role: "alice", phase: "refused", result: "refused: wallet run" });
      } catch {
        /* the refusal stands without its line */
      }
      throw Object.assign(new Error(wrun.ambiguous ? "env.local.sh is ambiguous about USE_SWAP_WALLET: the funding acknowledgement is refused" : "this is a wallet run: the funding is made from the swap wallet by this console, there is no outside funding to acknowledge, and the classic funding markers are not used"), { status: 409 });
    }
    if (!this.objectCheck || !this.objectCheck.ok) throw Object.assign(new Error('run "Check the object file" first: it must print "object file OK" before you fund'), { status: 409 });
    this.assertLock("funded-ack");
    const run = this.readRunFn(this.cfg.runDirs, this.nowS());
    const marker = this.fundedMarker();
    const cm = this.contractMarker(run && run.terms && run.terms.contract_root, run);
    if (marker || cm) {
      if (this.funded) return { ok: true, at: Math.floor(this.funded.at_ms / 1000), already: true };
      throw Object.assign(new Error(`a funding marker exists (${marker ? "funded.marker " + marker : cm.name + " " + cm.at}): fund.sh already funded this contract, or it was acknowledged elsewhere, so there is nothing to acknowledge`), { status: 409 });
    }
    const dir = this.runFolder();
    if (!dir) throw Object.assign(new Error("no run folder is known: the marker cannot be written"), { status: 409 });
    const root = run && run.terms && run.terms.contract_root;
    const obj = typeof root === "string" && /^o1[0-9a-z]+$/.test(root) ? this.objectInfo(run) : null;
    if (!obj) {
      const why = typeof root === "string" && /^o1[0-9a-z]+$/.test(root) ? "no object file is visible to this console" : "the terms carry no contract root";
      this.audit.append({ action: "funded-ack", role: "alice", phase: "refused", result: `refused: ${why}` });
      throw Object.assign(new Error(`the acknowledgement is refused: ${why}, so the contract's marker next to the object file cannot be written and the acknowledgement would not stop fund.sh in another run folder; nothing was recorded`), { status: 409 });
    }
    const at = new Date(this.now()).toISOString().replace(/[.]\d{3}Z$/, "Z");
    const text = `${at}\nacknowledged: funded outside fund.sh\n`;
    const made = [];
    const undo = () => {
      for (const f of made) {
        try {
          fs.unlinkSync(f);
        } catch {
          /* gone */
        }
      }
    };
    try {
      made.push(writeExclusive(obj.dir, `funded-${root}.marker`, text));
      made.push(writeExclusive(dir, "funded.marker", text));
    } catch (err) {
      undo();
      if (err && err.code === "EEXIST") throw Object.assign(new Error("a funding marker appeared while the acknowledgement was written (fund.sh is running, or another console acknowledged): there is nothing to acknowledge; look at `contract instances` and at the marker"), { status: 409 });
      throw Object.assign(new Error(`the acknowledgement marker could not be written (${(err && (err.code || err.message)) || "error"}): nothing was recorded`), { status: 500 });
    }
    this.funded = { at_ms: this.now() };
    try {
      this.audit.append({ action: "funded-ack", role: "alice", phase: "note", result: "operator says the wallet funding was done", detail: "marker=none; wrote funded.marker and the contract's marker" });
    } catch (err) {
      throw Object.assign(new Error(`the markers are written (the acknowledgement stands) but the audit log cannot be written (${err.code || err.message})`), { status: 500 });
    }
    return { ok: true, at: Math.floor(this.funded.at_ms / 1000), note: "This blocks this run folder and this object folder only. fund.sh started under ANOTHER run folder with a COPY of the object file in another folder is not blocked by it until an instance of the contract is visible." };
  }
}

/** Creates `dir/name` with the exclusive flag (it throws EEXIST when the file is there). Either spelling of a WSL share path is tried. Returns the path written. */
function writeExclusive(dir, name, text) {
  let last = null;
  for (const c of pathCandidates(dir)) {
    const full = path.join(c, name);
    try {
      fs.writeFileSync(full, text, { flag: "wx", mode: 0o600 });
      return full;
    } catch (e) {
      if (e && e.code === "EEXIST") throw e;
      last = e;
    }
  }
  throw last || new Error("cannot write");
}

function shrink(v, depth = 0) {
  if (depth > 6) return null;
  if (Array.isArray(v)) return v.slice(0, 20).map((x) => shrink(x, depth + 1));
  if (v && typeof v === "object") {
    const o = {};
    for (const [k, x] of Object.entries(v)) if (!["data", "intent_hex", "intent_bytes_hex", "opening_hex"].includes(k)) o[k] = shrink(x, depth + 1);
    return o;
  }
  return typeof v === "string" && v.length > 300 ? v.slice(0, 300) + "…" : v;
}

module.exports = { helperPathOf, listFiles, TABLE, WALLET_TABLE, BOARD_TABLE, BOARD_DRIVEN, BY_ID, modeBlock, WALLET_POLL_MS, ActionRunner, buildActionCommand, validateActionsConfig, defaultRepoLiveDir, runNumberOf, WATCH_START, WATCH_STOP, WATCH_STATUS, TX_RE, scrubText };
