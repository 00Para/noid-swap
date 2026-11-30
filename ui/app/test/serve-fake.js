"use strict";
/*
 * Dev tool, NOT part of the server: the operator console in actions mode over a TEMPORARY run folder with synthetic files and a fake
 * `wsl.exe` that only writes the dry-run / result files the real helpers would. Nothing here touches WSL, a wallet or a chain.
 *
 *   node ui/app/test/serve-fake.js [lock|reveal|reveal-late|claim|refund|fund|wait-created|held|held-cutoff|near|aborted|refund-alarm|missing|unreadable|start-prepare-running|start-install|start-terms|start-setup|start-prepare|start-check|start-send] [port]
 *
 *   lock, reveal, claim, refund   the engine names that spend (a ledger spend is "recorded")
 *   fund           Alice, file at "created", the engine has recorded the funding step (the button exists, and the terminal-first order is shown)
 *   wait-created   Alice, file at "created", the engine only says wait (the funding order is shown before the engine offers anything)
 *   reveal-late    Alice, the engine still offers the reveal but the helper's last moment to start it has passed (the clock at zero)
 *   held           Alice, the reveal is already decided and held (the held-intent warning below the buttons)
 *   held-cutoff    Alice, the reveal is held and the engine says its cutoff has passed (no box: the engine's reason leads)
 *   near           Bob, the lock is the step and the engine's note says the lock margin is short (its warning style)
 *   autopilot      Bob, the lock is the step; the autopilot is approved and has a "Needs you" entry (the box "Run this swap for me" in its on state; the console's own
 *                  timer is on, but the stopped step is not touched)
 *   aborted        Alice, aborted with a 4 NOID instance at the contract (the run-16 shape: coins at the contract, the recovery helper)
 *   refund-alarm   Bob, the ETH refund is the step and an ALARM note is in the tick (the refund is still offered, the alarm beside its box)
 *   missing        the run folder does not exist yet (only "1. Install helpers" works; the fake install creates the folder)
 *   unreadable     the run folder becomes unreadable after the console started, the public folder holds the bundle and the object file (the old page, with the error)
 *   start-prepare-running  step 4 while Prepare is still running and the bundle file is already there
 *   start-install  the start screen (no tick of Alice's): the run folder exists, nothing else (step 1, not known whether it ran)
 *   start-terms    ... the install step has run (a clean job): step 2, the settings form open
 *   start-setup    ... and env.local.sh is saved: step 3
 *   start-prepare  ... and the setup step has run: step 4
 *   start-check    ... and the bundle file exists, no object file: step 5, with the wallet's step
 *   start-send     ... and the object file exists and the check has run clean: step 6, the file for Bob
 *   join-install   Bob's screen "Join a swap" (the console is started with --role bob, no tick): the run folder exists, nothing else (step 1)
 *   join-terms     ... the install step has run: step 2, the settings form open
 *   join-setup     ... and env.local.sh is saved: step 3
 *   join-file      ... and the setup step has run: step 4, no bundle file anywhere
 *   join-public    ... the bundle file is only in the public copy folder (the check will take it from there)
 *   join-check     ... the bundle file is in the run folder: step 5
 *   join-failed    ... the check ran and the helper refused (new-bob exit 1): the strip stays on step 5 with its job box
 *   join-done      ... the check ran clean, Bob's swap file is written: step 6, the terms and the line to compare
 *   board-offers      the offer board's first screen (a console started with --board --role alice): four open offers, "Take" and "Post an offer" (a take or a post moves on)
 *   board-empty       ... the board with no offers
 *   board-take        ... a swap exists: its terms, the deposit rows (the NOID deposit not seen yet, the ETH one seen) and the approval (off, with its reason)
 *   board-approve     ... both deposits seen: the approval can be given (type 5, mark the boxes); the button answers as if accepted and moves to the progress screen
 *   board-progress    ... the approval holds: "Your swap is running", the steps, the two locks, the swap's own end time
 *   board-needs-you   ... the same with a stopped step: the "Needs you" box (the tool's own words folded)
 *   board-done        ... the swap is done: "Done" and what was received
 *   board-refunded    ... the swap ended on its refund path: "Refunded"
 *   (the board scenarios replace the board host's answers and the wallet and approval facts with made-up ones: test/board-scenarios.js; nothing reaches a relay or a helper)
 *   (the start scenarios run their earlier steps through the console's own POST /api/action with the fake launcher, once, at start)
 *
 * Prints the URL with the token. Used to look at the page; the folder is deleted when the process ends. Open the URL WITHOUT its #token=… part
 * (or reload the page) to see the banner for a lost key.
 */
const fs = require("fs");
const path = require("path");
const { createServer } = require("../server");
const F = require("./actions-fixtures");
const { mkTick } = require("./helpers");
const BS = require("./board-scenarios");
const { makeShared } = require("./board-host-harness");

const scenario = process.argv[2] || "lock";
const port = Number(process.argv[3] || 8791);
const APP = path.join(__dirname, "..");
const kind = { lock: "lock_eth", reveal: "reveal_eth", "reveal-late": "reveal_eth", held: "reveal_eth", "held-cutoff": "reveal_eth", aborted: "fund_noid", "refund-alarm": "refund_eth", claim: "claim_noid", refund: "refund_eth", fund: "fund_noid", "wait-created": "fund_noid", near: "lock_eth", autopilot: "lock_eth", missing: "reveal_eth" }[scenario] || "lock_eth";
const START_ORDER = ["start-install", "start-terms", "start-setup", "start-prepare", "start-check", "start-send"];
// start-prepare-running: step 4 with the bundle file written and Prepare still running (the fake helper never ends)
const JOIN_ORDER = ["join-install", "join-terms", "join-setup", "join-file", "join-public", "join-check", "join-failed", "join-done"];
const joinAt = JOIN_ORDER.indexOf(scenario); // -1: not a join scenario
const startAt = scenario === "start-prepare-running" ? 4 : START_ORDER.indexOf(scenario); // -1: not a start scenario
const isBoard = BS.SCENARIOS.includes(scenario);
const role = isBoard || ((kind === "reveal_eth" || kind === "fund_noid") && scenario !== "refund-alarm") ? "alice" : "bob";
const f = F.makeFolders();
if (scenario === "missing") {
  fs.rmSync(f.run, { recursive: true, force: true });
  fs.rmSync(path.join(f.pub, "alice.bundle.json"), { force: true });
}
if (joinAt >= 0) {
  // Bob's screen: no tick, and only the files an earlier step would have made; Alice's bundle is where the scenario says
  const bundle = fs.readFileSync(path.join(f.pub, "alice.bundle.json"), "utf8");
  for (const d of [f.run, f.pub]) fs.rmSync(path.join(d, "alice.bundle.json"), { force: true });
  if (joinAt >= 2) fs.writeFileSync(path.join(f.run, "env.local.sh"), "PROFILE='sepolia'\n");
  if (scenario === "join-public") fs.writeFileSync(path.join(f.pub, "alice.bundle.json"), bundle);
  if (joinAt >= 5) fs.writeFileSync(path.join(f.run, "alice.bundle.json"), bundle);
} else if (startAt >= 0) {
  // the start screen: no tick, and only the files an earlier step would have made
  const bundle = fs.readFileSync(path.join(f.pub, "alice.bundle.json"), "utf8");
  for (const d of [f.run, f.pub]) fs.rmSync(path.join(d, "alice.bundle.json"), { force: true });
  if (startAt >= 2) fs.writeFileSync(path.join(f.run, "env.local.sh"), "PROFILE='sepolia'\n");
  if (startAt >= 4) for (const d of [f.run, f.pub]) fs.writeFileSync(path.join(d, "alice.bundle.json"), bundle);
  if (startAt >= 5) fs.writeFileSync(path.join(f.pub, "swap.object.json"), JSON.stringify({ address: "o1rootplaceholder" }));
} else fs.writeFileSync(path.join(f.pub, "swap.object.json"), JSON.stringify({ address: "o1rootplaceholder" }));
const TX = "0x" + "ab".repeat(32);
let seq = 0;

function writeTick() {
  if (scenario === "missing" || scenario === "unreadable" || startAt >= 0 || joinAt >= 0) return;
  let tick;
  if (isBoard) {
    // Alice's file as the board scenario says (no file at all on the offers screens)
    const phase = BS.phaseFor(scenario);
    if (!phase) return;
    if (phase === "lock_final") tick = F.spendTick("reveal_eth");
    else tick = mkTick({ phase, action: { action: "wait", reason: phase === "created" ? "waiting for the other side's check" : "the swap is over" }, instance: null });
    return f.writeTickAt(role, tick, Date.now());
  }
  if (scenario === "wait-created") tick = mkTick({ phase: "created", action: { action: "wait", reason: "too early to fund: the funding opens at height 299698 (tip 299600); a funding before it would lock the NOID for more than twice the swap's planned length (D 300302 is 302 blocks after H_create 300000)" } });
  else if (scenario === "near") tick = F.spendTick(kind, { noid: { tip: F.TERMS.lock_by_height - 8 }, notes: ["lock margin is short: 8 blocks to the last lock height " + F.TERMS.lock_by_height + " (nominal lock-by " + F.TERMS.lock_by_height + ", tip " + (F.TERMS.lock_by_height - 8) + "); see the action"] });
  else if (scenario === "held-cutoff") tick = F.spendTick(kind, { held: true, fresh: "wait", cutoffPassed: true, notes: ["not revealing: (I2) reveal cutoff passed: now 1800001300 > T_reveal - M_A = 1800001200; the reveal must not be broadcast"] });
  else if (scenario === "refund-alarm") tick = F.spendTick(kind, { notes: ["ALARM: this lock's T_reveal 1800000000 is 120 s beyond the engine's own bound 1799999880 (D 281514): if Alice reveals late, the NOID claim may not be final before D; claim the moment the secret is seen; do not make another lock (lock d1d1d1d1)"] });
  else if (scenario === "aborted") tick = mkTick({ phase: "aborted", tip: F.D - 100, instance: { slot_index: 7, creation_id: 3, amount_micronoid: 4000000 }, action: { action: "wait", reason: "aborted: too late to fund: tip 281400 + 24 > lock-by 281262" }, notes: ["1 instance hold NOID at the contract root: slot 7 (creation 3, 4,000,000 micro-NOID). None fits the agreement, so none is this swap's funding; scripts/live/recover-noid.sh closes the instances of the agreed amount; an instance not larger than the close fee (at least 5,800 micro-NOID, more under load) cannot be recovered. This tool will not close it."] });
  else if (scenario === "reveal-late") tick = F.spendTick(kind, { eth: { latest_timestamp: F.NOW + 1180 } });
  else tick = F.spendTick(kind, { held: scenario === "held" });
  f.writeTickAt(role, tick, Date.now());
}
writeTick();
setInterval(writeTick, 30000).unref();

const exec = (file, args, opts, cb) => {
  const si = args.findIndex((a) => /\.sh$/.test(a));
  const script = si >= 0 ? path.basename(args[si]) : "inline";
  const flags = si >= 0 ? args.slice(si + 1) : [];
  const n = String(100000 + ++seq);
  setTimeout(() => {
    if (script === "lock.sh" && flags.includes("--dry-run")) f.write(`eth-lock-${n}.json`, F.lockDry());
    else if (script === "lock.sh") {
      f.write(`eth-lock-${n}.json`, { lockId: F.LOCK_ID, txHash: TX, blockNumber: 1 });
      f.write(`eth-lock-${n}.err`, `sent: ${TX} nonce 1\n`);
    } else if (script === "reveal.sh" && flags.includes("--dry-run")) f.write(`eth-claim-dry-${n}.json`, F.revealDry());
    else if (script === "refund-eth.sh" && flags.includes("--dry-run")) f.write(`eth-refund-${n}.json`, F.refundDry());
    else if (script === "claim.sh" && !flags.includes("--submit")) f.write(`claim-${n}.out`, F.claimDry());
    else if (script === "claim.sh") f.write(`claim-${n}.out`, { mode: "submit", plan: { txid: "ef".repeat(32) } });
    else if (script === "check-object.sh") return cb(null, "{}\n", "object file OK: fund exactly this address\n");
    else if (script === "join.sh") {
      // what scripts/live/join.sh prints (its own wording): the terms block, the tool's lines after a prefix, the check line alone
      const head = ["== start 10:00:00, run 5, profile sepolia, contract version 1, ethereum lock kind poseidon", "bundle: /home/u/live-run-5/alice.bundle.json (3120 bytes)", "hashlock: 0x1111", "Your terms, as this machine will state them (check them against what you agreed):", "  your Parano1d address:  o1bobplaceholder", "  your Ethereum address:  0x2222222222222222222222222222222222222222", "  the contract:           0x3333333333333333333333333333333333333333", "  the NOID amount:        5000000 micro-NOID", "  the ETH amount:         1000000000000000 wei", "  the chain:              11155111", "  the profile:            sepolia", "  the contract version:   1", "  the lock kind:          poseidon", "  the variant:            raw", "== no receipt for the poseidon lock: both locks carry the same A"];
      if (scenario === "join-failed") return cb(Object.assign(new Error("exit 8"), { code: 8 }), head.join("\n") + "\n  | error: refusing: the bundle's NOID amount 4000000 is not the 5000000 you stated\nnew-bob exit 1\nnew-bob did not succeed: nothing is locked and no step follows; the tool's whole output is in /home/u/live-run-5/join-new-bob.out\n", "");
      fs.mkdirSync(path.join(f.run, "bob"), { recursive: true });
      fs.writeFileSync(path.join(f.run, "bob", "bob.swap.json"), "{}");
      const mine = path.join(f.run, "alice.bundle.json");
      if (!fs.existsSync(mine)) fs.writeFileSync(mine, fs.readFileSync(path.join(f.pub, "alice.bundle.json"), "utf8"));
      return cb(null, head.join("\n") + "\nbundle check: 4f3a9c01d27be855 ok\n   ^ compare these digits with the bundle check line Alice's side printed, over a second channel, before anything else\n  | self-test ok\nnew-bob exit 0\n== next: nothing is locked yet; start the watch loop for bob\n", "");
    } else if (script === "install.sh") fs.mkdirSync(f.run, { recursive: true });
    else if (script === "prepare.sh" && scenario === "start-prepare-running") return;
    else if (script === "prepare.sh") return cb(null, "bundle copied to the public folder (send it as a file, not as pasted text) -- bundle check: fake one two three four\n", "");
    else if (script === "fund.sh" && flags.includes("--dry-run")) {
      const objFile = path.join(f.pub, "swap.object.json");
      const asLinux = objFile.replace(/\\/g, "/").replace(/^([A-Za-z]):/, (m, l) => "/mnt/" + l.toLowerCase());
      const sha = require("crypto").createHash("sha256").update(fs.readFileSync(objFile)).digest("hex");
      return cb(null, F.fundDry({ objPath: asLinux, sha }), "");
    }
    cb(null, `fake ${script} ${flags.join(" ")}\n`, "");
  }, 600);
};

const boardShared = isBoard ? makeShared() : null;
const server = createServer({
  mock: false,
  host: "127.0.0.1",
  port,
  config: path.join(APP, "swaps.json"),
  mockDir: path.join(APP, "mock"),
  runDirs: [f.run, f.pub],
  allowActions: true,
  role: joinAt >= 0 || scenario === "autopilot" ? "bob" : isBoard ? "alice" : undefined,
  ...(isBoard ? { board: true, boardSettings: { relays: ["wss://a.relays.net", "wss://b.relays.org"], pinned_htlc: { 11155111: BS.HTLC }, noid_payout: BS.A.noidPayout, eth_payout: BS.A.ethPayout, invite_secret: "ab".repeat(32) }, boardDeps: { WebSocket: boardShared.net.WebSocket, fetchInfo: boardShared.net.fetchInfo, readTip: async () => 315084 } } : {}),
  skipFolderCheck: true,
  wslDistro: "Ubuntu-24.04",
  wslRunDir: "/home/u/live-run-5",
  helpersDir: "/home/u/live-run-5/bin",
  repoLiveDir: "/mnt/c/repo/scripts/live",
  actionsDeps: { exec, spawnDetached: () => ({ unref() {}, on() {} }), pollWatch: false },
});
/** One of the console's own actions, through its own POST (the fake launcher answers), so that the console has a record of it: used to set the start scenarios up. */
function runAction(id) {
  return new Promise((resolve) => {
    const body = JSON.stringify({ id });
    const req = require("http").request({ host: "127.0.0.1", port, path: "/api/action", method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body), origin: `http://127.0.0.1:${port}`, "x-swap-token": server.runToken } }, (res) => {
      res.resume();
      res.on("end", resolve);
    });
    req.on("error", resolve);
    req.end(body);
  });
}
const settle = () => new Promise((r) => setTimeout(r, 1500));
server.listen(port, "127.0.0.1", async () => {
  process.stdout.write(`fake actions console (${scenario}) on http://127.0.0.1:${port}/#token=${server.runToken}\n`);
  // the earlier steps of a start scenario, run once through the console's own action route: the install step (step 1), setup (3), prepare (4), the object check (5)
  const ran = joinAt >= 0 ? [[], ["install"], ["install"], ["install", "setup"], ["install", "setup"], ["install", "setup"], ["install", "setup", "join"], ["install", "setup", "join"]][joinAt] || [] : [[], ["install"], ["install"], ["install", "setup"], ["install", "setup", "prepare"], ["install", "setup", "prepare", "check-object"]][startAt] || [];
  if (isBoard) BS.attach(server, scenario);
  // autopilot: approved for Bob, with one stopped step (what the page shows after an outcome that may have been a send)
  if (scenario === "autopilot") {
    server.autopilot.turnOn("bob", "0.001 ETH", { stay_on: true, no_manual_steps: true });
    server.autopilot.raise("bob", "send-lock", "outcome", "Lock the ETH: it did not end as a clean success (exit 1), so it may have been sent. The autopilot does not touch this step again: look at the contract and the audit log first.");
  }
  // unreadable: the share to the run folder drops after the console took its lock (the public folder still holds the bundle and the object file)
  if (scenario === "unreadable") setTimeout(() => fs.rmSync(f.run, { recursive: true, force: true }), 1000);
  for (const id of ran) {
    await runAction(id);
    await settle();
  }
});
const stop = () => {
  server.close();
  f.cleanup();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
