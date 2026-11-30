"use strict";
// Harness of the board host tests (not a test file): one console per role over temporary folders, a shared fake chain, fake helpers that write the files and print the lines the real
// scripts/live helpers print (the shapes are pinned by scripts/live/selftest.sh against stub tools), the in-process fake relays, an injected clock. Nothing here touches WSL, a wallet, a
// node, a relay or a chain.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const A = require("../lib/actions");
const { AuditLog } = require("../lib/audit");
const { Autopilot } = require("../lib/autopilot");
const { readRun } = require("../lib/runfolder");
const { BoardHost } = require("../lib/board/host");
const { signingText } = require("../lib/board/handover");
const priv = require("../lib/board/privboard");
const F = require("./actions-fixtures");
const { mkTick } = require("./helpers");
const { ADDR, noidAddress, ethAddress, fakeSign, fakeVerify, sha } = require("./board-handover-harness");
const { FakeNetwork, until } = require("./board-fake-relay");

const WSL = { skipFolderCheck: true, distro: "Ubuntu-24.04", runDir: "/home/u/live-run-5", binDir: "/home/u/live-run-5/bin", runNumber: 5, repoLiveDir: "/mnt/c/repo/scripts/live" };
const RELAYS = ["wss://a.relays.net", "wss://b.relays.org"];
const HTLC = F.TERMS.eth.contract;
const BOB_ETH_PAYOUT = ethAddress("bob payout");
const INVITE = crypto.createHash("sha256").update("a test invite secret").digest();
const OFFER_NOID = String(F.TERMS.amount_micronoid); // 10 NOID: the engine fixtures' amount
const OFFER_WEI = F.TERMS.eth.amount_wei;
const FIXTURE_TIP = F.D - 302; // the tick fixtures' own tip: the funding height rule sees h_create == tip
const LEAD = 60;
const sha256 = (x) => crypto.createHash("sha256").update(x).digest("hex");

/** The shared fake chain and the knobs of the fake helpers. */
function makeWorld(o = {}) {
  return { tip: FIXTURE_TIP - LEAD, bobBalance: "5000000000000000", joinExit: 0, prepareExit: 0, signBad: false, hcOffset: 0, bundleEdit: null, ...o };
}

function envValues(runDir) {
  const out = {};
  try {
    for (const l of fs.readFileSync(path.join(runDir, "env.local.sh"), "utf8").split(/\r?\n/)) {
      const m = /^([A-Z_]+)='([^']*)'$/.exec(l);
      if (m) out[m[1]] = m[2];
    }
  } catch {
    /* none */
  }
  return out;
}
function addrFile(runDir) {
  const out = {};
  try {
    for (const l of fs.readFileSync(path.join(runDir, "wallet-addresses.txt"), "utf8").split(/\r?\n/)) {
      const m = /^([A-Z_]+)=(\S+)$/.exec(l);
      if (m) out[m[1]] = m[2];
    }
  } catch {
    /* none */
  }
  return out;
}

/**
 * One console: the ActionRunner, the Autopilot and (unless o.noHost) a BoardHost over the temporary folders, the fake helpers, a clock.
 * @param {"alice"|"bob"} role
 * @param {{net:FakeNetwork, world:object}} shared
 * @param {object} [o] { noHost, invite (false: public board), settings (overrides), folders, behaviour: { hooks } }
 */
function makeConsole(role, shared, o = {}) {
  const f = o.folders || F.makeFolders();
  if (!o.folders) for (const d of [f.run, f.pub]) fs.rmSync(path.join(d, "alice.bundle.json"), { force: true });
  const clock = { ms: o.clockMs || Date.now() };
  const log = []; // every helper run: { script, flags }
  const spawned = [];
  const hooks = { ...(o.hooks || {}) };
  const world = shared.world;
  const held = [];
  const holdScripts = new Set();
  const exec = (file, args, opts, cb) => {
    const sh = args.findIndex((a) => /\.sh$/.test(a));
    if (sh >= 0 && holdScripts.has(path.basename(args[sh]))) {
      // a helper that is still running (the console may be stopped before it ends): released by the test
      held.push(() => exec2(file, args, opts, cb));
      return undefined;
    }
    return exec2(file, args, opts, cb);
  };
  const exec2 = (file, args, opts, cb) => {
    const si = args.findIndex((a) => /\.sh$/.test(a));
    const script = si >= 0 ? path.basename(args[si]) : "inline";
    const flags = si >= 0 ? args.slice(si + 1) : [];
    const done = (code, out, err) => (code === 0 ? cb(null, out, err || "") : cb(Object.assign(new Error("exit " + code), { code }), out, err || ""));
    if (script === "inline") {
      if (args.some((a) => /alive/.test(String(a)))) return cb(null, "dead\n", "");
      return cb(null, "", "");
    }
    log.push({ script, flags: flags.slice(), at: clock.ms });
    const env = () => envValues(f.run);
    const w = (name, text) => {
      const p = path.join(f.run, name);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, text);
    };
    const isBoardRun = () => /^USE_SWAP_WALLET='1'$/m.test(fs.readFileSync(path.join(f.run, "env.local.sh"), "utf8")) && /^HANDOVER='board'$/m.test(fs.readFileSync(path.join(f.run, "env.local.sh"), "utf8"));
    if (hooks[script]) {
      const r = hooks[script](flags);
      if (r) return done(r.code, r.out || "", r.err);
    }
    switch (script) {
      case "install.sh":
        w("bin/env.sh", "# fake\n");
        return done(0, "installed 1 scripts\n");
      case "setup.sh":
        w("passphrase.txt", "selftest-passphrase-0123456789");
        return done(0, "setup done\n");
      case "wallet-setup.sh": {
        if (!isBoardRun()) return done(2, "", "not a wallet run");
        const r = flags[0];
        if (fs.existsSync(path.join(f.run, "wallet-addresses.txt"))) return done(3, "the run is already set up\n");
        if (r === "alice") {
          w("wallet-addresses.txt", `ROLE=alice\nALICE_NOID=${ADDR.aliceNoid}\nALICE_ETH=${ADDR.aliceEth}\n`);
          w("wallet-setup/noid-wallet.json", "{}");
          w("wallet-setup/eth-key.json", "{}");
          return done(0, `wallet-setup: noid ${ADDR.aliceNoid}\nwallet-setup: eth ${ADDR.aliceEth}\n`);
        }
        w("wallet-addresses.txt", `ROLE=bob\nBOB_ETH=${ADDR.bobEth}\n`);
        w("wallet-setup/eth-key.json", "{}");
        return done(0, `wallet-setup: eth ${ADDR.bobEth}\n`);
      }
      case "prepare.sh": {
        if (world.prepareExit) return done(world.prepareExit, "refused\n");
        const e = env();
        const a = addrFile(f.run);
        if (fs.existsSync(path.join(f.run, "alice.swap.json"))) return done(3, "alice.swap.json exists; refusing\n");
        const b = JSON.parse(fs.readFileSync(path.join(f.base, "fixture-bundle.json"), "utf8"));
        b.params.alice_noid = a.ALICE_NOID;
        b.params.bob_noid = e.BOB_NOID;
        b.params.amount_micronoid = Number(e.AMOUNT);
        b.params.h_create = world.tip + Number(e.HC_LEAD || 50) + world.hcOffset;
        b.params.eth.alice_receiver = a.ALICE_ETH;
        b.params.eth.bob_sender = e.BOB_ETH;
        b.params.eth.amount_wei = e.WEI;
        b.params.eth.contract = e.CONTRACT;
        if (world.bundleEdit) world.bundleEdit(b);
        const text = JSON.stringify(b, null, 2) + "\n";
        w("alice.swap.json", text);
        w("alice.bundle.json", text);
        fs.writeFileSync(path.join(f.pub, "alice.bundle.json"), text);
        fs.rmSync(path.join(f.run, "wallet-setup"), { recursive: true, force: true });
        return done(0, "new-alice exit 0\n");
      }
      case "board-digest.sh": {
        const r = flags[0];
        const swap = path.join(f.run, r === "alice" ? "alice.swap.json" : "bob/bob.swap.json");
        if (!fs.existsSync(swap)) return done(2, "", "no swap file");
        const text = fs.readFileSync(swap, "utf8");
        const out = [`board-digest: role ${r}`, `board-digest: digest ${sha256(text)}`];
        if (r === "alice") {
          const cmp = (p) => (!fs.existsSync(p) ? "missing" : fs.readFileSync(p, "utf8") === text ? "same" : "differs");
          out.push(`board-digest: run-file ${cmp(path.join(f.run, "alice.bundle.json"))}`, `board-digest: public-file ${cmp(path.join(f.pub, "alice.bundle.json"))}`);
        }
        out.push("board-digest: done");
        return done(0, out.join("\n") + "\n");
      }
      case "board-balance.sh":
        return done(0, `board-balance: address=${env().BOB_ETH} balance_wei=${world.bobBalance} chain_id=11155111 block=123\nboard-balance: done\n`);
      case "join.sh": {
        const file = path.join(f.run, "board", "bundle-in.json");
        if (!/\/board\/bundle-in\.json$/.test(String(flags[0] || ""))) return done(2, "", "wrong bundle path");
        if (world.joinExit) return done(world.joinExit, "new-bob did not succeed\n");
        const e = env();
        const text = fs.readFileSync(file, "utf8");
        let b;
        try {
          b = JSON.parse(text);
        } catch {
          return done(6, "no usable bundle\n");
        }
        const mine = addrFile(f.run);
        const p = b.params || {};
        const eth = p.eth || {};
        // new-bob refuses any difference from Bob's own terms
        if (p.bob_noid !== e.BOB_NOID || eth.bob_sender !== mine.BOB_ETH || String(p.amount_micronoid) !== e.AMOUNT || eth.amount_wei !== e.WEI || eth.contract !== e.CONTRACT) return done(8, "new-bob did not succeed\n");
        w("bob/bob.swap.json", text);
        w("alice.bundle.json", text);
        const dg = sha256(text);
        return done(0, `bundle check: ${dg.slice(0, 16)} ok\nbundle digest: ${dg}\nnew-bob exit 0\n`);
      }
      case "board-sign.sh": {
        const purpose = flags[0];
        const h = JSON.parse(fs.readFileSync(path.join(f.run, "handover-bob.json"), "utf8"));
        const e = env();
        const a = addrFile(f.run);
        const text = purpose === "addresses" ? signingText("addresses", { offer: h.swap_id, take: h.take_key, bob_noid: e.BOB_NOID, bob_sender: a.BOB_ETH }) : signingText("checked", { offer: h.swap_id, take: h.take_key, digest: sha256(fs.readFileSync(path.join(f.run, "bob/bob.swap.json"), "utf8")) });
        const sig = world.signBad ? "0x" + "11".repeat(65) : fakeSign(text, a.BOB_ETH);
        return done(0, `board-sign: purpose ${purpose}\nboard-sign: text-sha256 ${sha256(text)}\nboard-sign: address ${a.BOB_ETH}\nboard-sign: signature ${sig}\nboard-sign: done\n`);
      }
      case "board-verify.sh": {
        const purpose = flags[0];
        const lines = fs.readFileSync(path.join(f.run, "board", "verify.in"), "utf8").split("\n").filter(Boolean);
        const v = Object.fromEntries(lines.map((l) => [l.slice(0, l.indexOf(" ")), l.slice(l.indexOf(" ") + 1)]));
        const text = purpose === "addresses" ? signingText("addresses", { offer: v.offer, take: v.take, bob_noid: v.bob_noid, bob_sender: v.bob_sender }) : signingText("checked", { offer: v.offer, take: v.take, digest: v.digest });
        return done(0, `board-verify: purpose ${purpose}\nboard-verify: text-sha256 ${sha256(text)}\nboard-verify: valid ${fakeVerify(text, v.signature, v.signer)}\nboard-verify: done\n`);
      }
      case "wallet-status.sh": {
        const r = flags[0];
        const a = addrFile(f.run);
        const cov = hooks.statusCovered === undefined ? true : hooks.statusCovered;
        const lines = [`wallet-status: role ${r}`];
        if (r === "alice") lines.push(`wallet-status-noid: address=${a.ALICE_NOID} plain_micronoid=${Number(OFFER_NOID) + 100000} amount_micronoid=${OFFER_NOID} fee_reserve_micronoid=6000 need_micronoid=${Number(OFFER_NOID) + 6000} covers=true tip=${FIXTURE_TIP}`);
        lines.push(`wallet-status-eth: address=${r === "alice" ? a.ALICE_ETH : a.BOB_ETH} required_wei=${r === "alice" ? "1000000000000000" : "2000000000000000"} reserve_wei=1000000000000000 amount_wei=${r === "bob" ? OFFER_WEI : "0"} balance_wei=${cov ? "5000000000000000" : "100"} shortfall_wei=${cov ? "0" : "900000000000000"} covered=${cov} key_checked=true`, "wallet-status: done");
        return done(0, lines.join("\n") + "\n");
      }
      case "wallet-fund.sh": {
        const dry = flags.includes("--dry-run");
        const b = JSON.parse(fs.readFileSync(path.join(f.run, "alice.bundle.json"), "utf8"));
        const head = [`wallet-fund: wallet ${b.params.alice_noid}`, `wallet-fund: contract_root ${b.contract_root}`, `wallet-fund: reserve covered=true required_wei=1000000000000000 balance_wei=5000000000000000 address=${b.params.eth.alice_receiver}`];
        const txid = "ef".repeat(32);
        if (dry) return done(0, [...head, "wallet-fund: outcome dry_run", `wallet-fund: target ${b.contract_root}`, `wallet-fund: amount_micronoid ${b.params.amount_micronoid}`, "wallet-fund: fee_micronoid 6000", "wallet-fund: inputs 1", `wallet-fund: txid ${txid}`, "wallet-fund: summary dry run built", `dry run: would fund ${b.params.amount_micronoid} micro-NOID once from the swap wallet to the contract address; nothing was written or sent`].join("\n") + "\n");
        w("wallet-funded.marker", `2026-11-17T10:00:00Z\ntxid ${txid}\n`);
        w("wallet-fund-100001.json", "{}");
        return done(0, [...head, "wallet-fund: outcome sent", `wallet-fund: target ${b.contract_root}`, `wallet-fund: txid ${txid}`].join("\n") + "\n");
      }
      default:
        return done(0, "", "");
    }
  };
  // the fixture bundle every fake prepare starts from (the engine fixtures' terms), kept beside the run folder
  const fb = {
    hashlock: F.TERMS.hashlock,
    claim_authority: "o1AUTH",
    contract_root: F.TERMS.contract_root,
    params: { profile: "sepolia", variant: "raw", amount_micronoid: F.TERMS.amount_micronoid, h_create: F.TERMS.h_create, deadline_height: F.D, lock_by_height: F.TERMS.lock_by_height, w_a_s: 4200, alice_noid: F.TERMS.alice_noid, bob_noid: F.TERMS.bob_noid, max_fee_micronoid: 50000, eth: { chain_id: F.E.chain_id, contract: F.E.contract, amount_wei: F.E.amount_wei, alice_receiver: F.E.alice_receiver, bob_sender: F.E.bob_sender } },
  };
  fs.writeFileSync(path.join(f.base, "fixture-bundle.json"), JSON.stringify(fb));
  const audit = o.audit || new AuditLog(f.pub, { now: () => clock.ms, role });
  const runner = new A.ActionRunner({ ...WSL, role, runDirs: [f.run, f.pub] }, { audit, exec, spawnDetached: (file, args, opts) => (spawned.push({ file, args }), { unref() {}, on() {} }), now: () => clock.ms, pollWatch: false });
  const ap = new Autopilot(runner);
  const priv_ = o.invite === false ? {} : { invite_secret: INVITE.toString("hex") };
  const settings = {
    profile: "sepolia",
    relays: RELAYS,
    pinned_htlc: { 11155111: HTLC },
    noid_payout: role === "alice" ? ADDR.aliceNoidPayout : null,
    bob_noid: ADDR.bobNoid,
    eth_payout: role === "alice" ? ADDR.aliceEthPayout : BOB_ETH_PAYOUT,
    lead_blocks: LEAD,
    allow_local_test: false,
    ...priv_,
    ...(o.settings || {}),
  };
  let host = null;
  if (!o.noHost) {
    host = new BoardHost({ actions: runner, autopilot: ap, role, settings, deps: { now: () => clock.ms, WebSocket: shared.net.WebSocket, fetchInfo: shared.net.fetchInfo, readTip: async () => world.tip, ...(o.deps || {}) } });
    host.start();
  }
  const c = {
    role,
    f,
    clock,
    log,
    spawned,
    hooks,
    holdScripts,
    held,
    release() {
      holdScripts.clear();
      while (held.length) held.shift()();
    },
    runner,
    ap,
    host,
    audit,
    world,
    settings,
    count: (script, flag) => log.filter((l) => l.script === script && (flag === undefined || l.flags.join(" ") === flag)).length,
    run: () => readRun([f.run, f.pub], Math.floor(clock.ms / 1000)),
    /** one pass of everything the server's timer does */
    pass() {
      clock.ms += 1500;
      if (role === "alice" && fs.existsSync(path.join(f.run, "alice.bundle.json"))) c.tickAlice();
      try {
        runner.walletPoll();
      } catch {
        /* a poll is tried again */
      }
      if (host) host.step();
      ap.step();
    },
    /** the engine's tick for Alice: it offers the funding until the funding marker is there */
    tickAlice() {
      const funded = fs.existsSync(path.join(f.run, "wallet-funded.marker"));
      const tick = funded ? mkTick({ phase: "funded", action: { action: "wait", reason: "waiting for finality" } }) : F.spendTick("fund_noid");
      f.writeTickAt("alice", tick, clock.ms - 3000);
      const p = path.join(f.run, "loop-alice.txt");
      fs.writeFileSync(p, `18:25:14 [alice] tick exit 0 at 18:25:14 noid: tip 1 ACTION: {"action": "wait", "reason": "x"} applied: True phase_after: created\n`);
      const t = new Date(clock.ms - 5000);
      fs.utimesSync(p, t, t);
    },
    cleanup: () => {
      if (host) host.stop();
      f.cleanup();
    },
  };
  return c;
}

/** Runs the passes of every console until `pred()` is true (or fails after `max` passes). Each pass lets the fake relays answer. */
async function drive(cs, pred, { max = 400, what = "the condition" } = {}) {
  for (let i = 0; i < max; i++) {
    for (const c of cs) c.pass();
    await new Promise((r) => setTimeout(r, 3));
    if (pred()) return i;
  }
  throw new Error(`timed out waiting for ${what}: ${cs.map((c) => `${c.role}:${c.host && c.host.m ? c.host.m.phase : "-"}`).join(" ")}`);
}

function makeShared(o = {}) {
  const net = new FakeNetwork();
  for (const u of RELAYS) net.add(u);
  return { net, world: makeWorld(o.world) };
}

/** The offer (maker) and the take, both sides through the real offer and message code on the fake relays. Alice posts a sell-noid offer; Bob takes it. */
async function postAndTake(alice, bob) {
  alice.host.postOffer({ noid_micro: OFFER_NOID, wei: OFFER_WEI });
  await until(() => bob.host.offers().length === 1, 3000, "the offer on the board");
  bob.host.takeOffer(bob.host.offers()[0].id);
}

module.exports = { makeConsole, makeShared, makeWorld, drive, postAndTake, ADDR, RELAYS, HTLC, INVITE, OFFER_NOID, OFFER_WEI, BOB_ETH_PAYOUT, FIXTURE_TIP, LEAD, sha256, envValues, addrFile, WSL };
