"use strict";
// Shared harness of the wallet-run tests (not a test file): the autopilot harness's console, switched to a WALLET run (USE_SWAP_WALLET='1' and both payout addresses in
// env.local.sh), with fake wallet helpers in front of the fake classic ones. Every helper is fake: nothing touches WSL, a wallet, a node or a chain. The fake helpers print
// exactly the lines the real scripts/live helpers print (the shapes are pinned by scripts/live/selftest.sh against stub tools).
const fs = require("fs");
const path = require("path");
const { make } = require("./autopilot-harness");
const F = require("./actions-fixtures");
const { mkTick } = require("./helpers");

const WNA = "o1selftestalicewalletaddressxxxxxx"; // the swap wallet's address (the terms' Alice address)
const WNB = "o1selftestbobnoidaddressxxxxxxxxxx";
const WNP = "o1selftestnoidpayoutaddressxxxxxx"; // the user's own NOID payout address
const WEP = "0x" + "3c".repeat(20); // the user's own Ethereum payout address
const WROOT = F.TERMS.contract_root; // the contract root of the terms
const WTX = "ef".repeat(32);
const E = F.TERMS.eth;
// a decoy 64-hex "key" and "secret" that the test files carry and that must never reach a page, the audit log or the approval file
const DECOY_KEY = "0x" + "ab".repeat(32);
const DECOY_SECRET = "0x" + "cd".repeat(32);

/** The text wallet-status.sh prints for a role (all numbers as the helper prints them). */
function statusText(role, o = {}) {
  const lines = [`wallet-status: role ${role}`];
  const amount = F.TERMS.amount_micronoid;
  if (role === "alice" && o.noid !== false) {
    lines.push(`wallet-status-noid: address=${o.noidAddress || WNA} plain_micronoid=${o.plain ?? amount + 100000} amount_micronoid=${amount} fee_reserve_micronoid=6000 need_micronoid=${amount + 6000} covers=${o.covers ?? true} tip=280500`);
  }
  if (o.eth !== false) {
    const addr = o.ethAddress || (role === "alice" ? E.alice_receiver : E.bob_sender);
    const covered = o.covered ?? true;
    const required = role === "alice" ? "1000000000000000" : "2000000000000000";
    const balance = o.balanceWei ?? (covered ? "5000000000000000" : "100");
    lines.push(`wallet-status-eth: address=${addr} required_wei=${required} reserve_wei=1000000000000000 amount_wei=${role === "bob" ? E.amount_wei : "0"} balance_wei=${balance} shortfall_wei=${covered ? "0" : "900000000000000"} covered=${covered} key_checked=${o.keyChecked ?? true}`);
  }
  if (o.done !== false) lines.push("wallet-status: done");
  return lines.join("\n") + "\n";
}

/**
 * One console in a wallet run. o: role, wallet payouts (noidPayout / ethPayout, null to leave one out), envExtra (more env.local.sh lines), classic: true (no USE_SWAP_WALLET line),
 * behaviour: the classic harness's, plus `wallet`: { statusOpts, fundDry, exits: { script: code } ... } options of the fake wallet helpers.
 */
function makeWallet(o = {}) {
  const role = o.role || "alice";
  const h = make({ role, ...(o.base || {}) });
  const f = h.f;
  // the terms of a wallet run: the bundle names the swap wallet's own address; there is no object file (no wallet CLI object is made)
  for (const d of [f.run, f.pub]) {
    const p = path.join(d, "alice.bundle.json");
    const b = JSON.parse(fs.readFileSync(p, "utf8"));
    b.params.alice_noid = WNA;
    fs.writeFileSync(p, JSON.stringify(b));
  }
  fs.rmSync(path.join(f.pub, "swap.object.json"), { force: true });
  const lines = [];
  if (!o.classic) lines.push("USE_SWAP_WALLET='1'");
  if (o.noidPayout !== null) lines.push(`NOID_PAYOUT='${o.noidPayout || WNP}'`);
  if (o.ethPayout !== null) lines.push(`ETH_PAYOUT='${o.ethPayout || WEP}'`);
  for (const l of o.envExtra || []) lines.push(l);
  fs.writeFileSync(path.join(f.run, "env.local.sh"), lines.join("\n") + "\n");
  // the files of a wallet run the console must never open (decoy secrets), and the swap files that make the status poll start
  fs.mkdirSync(path.join(f.run, "bob"), { recursive: true });
  fs.mkdirSync(path.join(f.run, "wallet-setup"), { recursive: true });
  if (!o.noSwapFile) {
    fs.writeFileSync(path.join(f.run, "alice.swap.json"), JSON.stringify({ sealed: DECOY_KEY, secret: DECOY_SECRET }));
    fs.writeFileSync(path.join(f.run, "bob", "bob.swap.json"), JSON.stringify({ sealed: DECOY_KEY }));
  }
  fs.writeFileSync(path.join(f.run, "wallet-setup", "eth-key.json"), JSON.stringify({ key: DECOY_KEY }));
  fs.writeFileSync(path.join(f.run, "wallet-addresses.txt"), `ROLE=${role}\n`);
  fs.writeFileSync(path.join(f.run, "passphrase.txt"), DECOY_SECRET);

  const wb = { statusOpts: {}, fundDry: {}, exits: {}, stdout: {}, ...((o.behaviour || {}).wallet || {}) };
  h.wallet = wb;
  const orig = h.runner.exec;
  const stamp = (p) => {
    const t = new Date(h.clock.ms);
    fs.utimesSync(p, t, t);
  };
  let n = 0;
  h.runner.exec = (file, args, opts, cb) => {
    const si = args.findIndex((a) => /\.sh$/.test(a));
    const script = si >= 0 ? path.basename(args[si]) : "inline";
    if (!/^wallet-/.test(script) && !(script === "fund.sh") && !/^fund\.sh$/.test(script)) return orig(file, args, opts, cb);
    const flags = si >= 0 ? args.slice(si + 1) : [];
    const dry = flags.includes("--dry-run");
    h.log.push({ script, flags, dry });
    const done = (code, out) => (code === 0 ? cb(null, out, "") : cb(Object.assign(new Error("exit " + code), { code }), out, ""));
    const write = (name, text) => {
      const p = path.join(f.run, name);
      fs.writeFileSync(p, text);
      stamp(p);
    };
    const code = !dry && wb.exits[script + ":" + flags.join(" ")] !== undefined ? wb.exits[script + ":" + flags.join(" ")] : !dry && wb.exits[script] !== undefined ? wb.exits[script] : 0;
    const outOf = (text) => (!dry && wb.stdout[script] !== undefined ? wb.stdout[script] : text);
    if (script === "wallet-status.sh") return done(wb.statusExit || 0, outOf(wb.statusText !== undefined ? wb.statusText : statusText(flags[0], wb.statusOpts)));
    if (script === "wallet-setup.sh") return done(code, outOf(`wallet-setup: eth ${E.alice_receiver}\n`));
    if (script === "wallet-fund.sh" || script === "fund.sh") {
      if (script === "fund.sh") return done(code, "classic fund.sh must not run in a wallet run\n");
      const d = { target: WROOT, amount: F.TERMS.amount_micronoid, wallet: WNA, root: WROOT, covered: true, ...wb.fundDry };
      const head = [`wallet-fund: wallet ${d.wallet}`, `wallet-fund: contract_root ${d.root}`, `wallet-fund: reserve covered=${d.covered} required_wei=1000000000000000 balance_wei=5000000000000000 address=${E.alice_receiver}`];
      if (dry) return done(0, [...head, "wallet-fund: outcome dry_run", `wallet-fund: target ${d.target}`, `wallet-fund: amount_micronoid ${d.amount}`, "wallet-fund: fee_micronoid 6000", "wallet-fund: inputs 1", `wallet-fund: txid ${WTX}`, "wallet-fund: summary dry run built", `dry run: would fund ${d.amount} micro-NOID once from the swap wallet to the contract address; nothing was written or sent`].join("\n") + "\n");
      if (code === 0) write("wallet-funded.marker", `2026-11-17T10:00:00Z\ntxid ${WTX}\n`);
      const outcome = code === 0 ? "sent" : code === 6 ? "maybe_sent" : code === 4 ? "hold" : null;
      return done(code, outOf([...head, ...(outcome ? [`wallet-fund: outcome ${outcome}`, `wallet-fund: target ${WROOT}`, `wallet-fund: txid ${WTX}`] : [])].join("\n") + "\n"));
    }
    if (script === "wallet-recover.sh") {
      if (flags.includes("--record")) return done(code, "wallet-recover: closed-by recorded txid " + WTX + "\n");
      const d = { target: WNA, wallet: WNA, amount: F.TERMS.amount_micronoid - 5800, fee: 5800, height: F.D + 2, ...wb.recoverDry };
      const head = [`wallet-recover: wallet ${d.wallet}`];
      if (dry) return done(0, [...head, "wallet-recover: outcome dry_run", `wallet-recover: target ${d.target}`, `wallet-recover: amount_micronoid ${d.amount}`, `wallet-recover: fee_micronoid ${d.fee}`, "wallet-recover: inputs 1", `wallet-recover: child_height ${d.height}`, `wallet-recover: txid ${WTX}`, "wallet-recover: summary x", `dry run: would recover ${d.amount} micro-NOID once to the swap wallet (the committed recovery recipient); nothing was written or sent`].join("\n") + "\n");
      if (code === 0 || code === 6) write("wallet-recovered-txid.txt", WTX + "\n");
      const outcome = code === 0 ? "sent" : code === 6 ? "maybe_sent" : code === 4 ? "hold" : null;
      return done(code, outOf([...head, ...(outcome ? [`wallet-recover: outcome ${outcome}`, `wallet-recover: target ${WNA}`, `wallet-recover: txid ${WTX}`] : []), ...(code === 0 ? ["wallet-recover: closed-by NOT recorded yet (tick exit 1); the swap file was not changed. The tool's words:"] : [])].join("\n") + "\n"));
    }
    if (script === "wallet-sweep.sh") {
      const kind = flags[0];
      if (kind === "noid") {
        const d = { target: WNP, payout: WNP, settings: WNP, amount: 100000, ...wb.sweepDry };
        const head = [`wallet-sweep: payout_swap_file ${d.payout}`, `wallet-sweep: payout_settings ${d.settings}`];
        // an empty swap wallet: the tool refuses the dry run itself (swap-cli wallet sweep, exit 3), as in rehearsal 4.10
        if (dry && wb.sweepNoidDryExit) return done(wb.sweepNoidDryExit, "error: refused: the wallet holds no plain coin worth more than the fee of spending it\n");
        if (dry) return done(0, [...head, "wallet-sweep: outcome dry_run", `wallet-sweep: target ${d.target}`, `wallet-sweep: amount_micronoid ${d.amount}`, "wallet-sweep: fee_micronoid 6000", "wallet-sweep: inputs 1", `wallet-sweep: txid ${WTX}`, "wallet-sweep: summary x", `dry run: would sweep ${d.amount} micro-NOID once to the payout address; nothing was written or sent`].join("\n") + "\n");
        if (code === 0) write("wallet-swept-noid.marker", `2026-11-17T10:00:00Z\ntxid ${WTX}\n`);
        const outcome = code === 0 ? "sent" : code === 6 ? "maybe_sent" : code === 4 ? "hold" : null;
        return done(code, outOf([...head, ...(outcome ? [`wallet-sweep: outcome ${outcome}`, `wallet-sweep: target ${WNP}`, `wallet-sweep: txid ${WTX}`] : [])].join("\n") + "\n"));
      }
      // eth: live.js's JSON in a result file
      const who = flags[1];
      const own = who === "bob" ? E.bob_sender : E.alice_receiver;
      const d = { to: WEP, from: own, value: "4000000000000000", ...wb.sweepEthDry };
      n += 1;
      if (dry) {
        write(`eth-sweep-${who}-dry-${100100 + n}.json`, JSON.stringify({ dryRun: true, sent: false, chainId: String(E.chain_id), from: d.from, to: d.to, valueWei: d.value, sweep: { role: who, key: d.from, payout: d.to, balanceWei: "4021000000000000", feeWei: "21000000000000", valueWei: d.value, locksSeen: [], recordsResolved: 0, phase: "refunded" } }));
        return done(0, `sweep --dry-run exit 0\n`);
      }
      if (code === 0) {
        write(`eth-sweep-${who}-${100100 + n}.json`, JSON.stringify({ txHash: "0x" + WTX, blockNumber: 130, from: d.from, to: d.to, valueWei: d.value }));
        write(`wallet-swept-eth-${who}.marker`, `2026-11-17T10:00:00Z\ntxid 0x${WTX}\n`);
      }
      return done(code, outOf("sweep SEND exit " + code + "\n"));
    }
    return orig(file, args, opts, cb);
  };
  return h;
}

/** A tick of the engine that offers the recovery close after D (a ledger intent, RECORDED on its first tick, HELD after). */
function recoverTick(o = {}) {
  const params = { call_height: F.D + 2, fee_micronoid: 5800 };
  const intent = { status: o.held ? "held" : "recorded", intent: { action: "refund_noid", params: { action: "refund_noid", ...params }, decided_at: F.INTENT_AT } };
  const heldNotes = o.held ? ["held: fresh decision was refund_noid"] : [];
  const action = o.held ? { action: "wait", reason: `intent refund_noid pending since ${F.INTENT_AT} (unix): the chain does not show it yet; reuse the printed parameters` } : { action: "refund_noid", ...params };
  return mkTick({ now: o.now, phase: "lock_final", action, intent, notes: heldNotes, instance: { slot_index: 7, creation_id: 3, amount_micronoid: F.TERMS.amount_micronoid } });
}

/** A tick of a file that is over (phase refunded, done ...), the engine offering nothing. */
function endedTick(phase, o = {}) {
  return mkTick({ now: o.now, phase, action: { action: "wait", reason: "the swap is over" }, instance: null });
}

module.exports = { makeWallet, statusText, recoverTick, endedTick, WNA, WNB, WNP, WEP, WROOT, WTX, E, DECOY_KEY, DECOY_SECRET };
