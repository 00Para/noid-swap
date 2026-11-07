"use strict";
/*
 * Seeded, deterministic fuzz + invariant campaign for HTLC (ETH) and HTLCERC20.
 *
 *   cd eth && npx hardhat test test/fuzz.test.js
 *
 * Environment:
 *   FUZZ_N        sequences per campaign (ETH and ERC-20 each), default 200 (full campaign: 2000)
 *   FUZZ_SEED     seed string, default below (printed at start)
 *   FUZZ_STEPS    max random steps per sequence, default 16
 *   FUZZ_START    first sequence index (default 0): FUZZ_START=1000 FUZZ_N=1000 runs sequences 1000..1999
 *   FUZZ_ONLY     run only this sequence index (reproduce a failure)
 *   FUZZ_KIND     with FUZZ_ONLY: "eth" or "tok"
 *   FUZZ_TRACE    "1" prints every step
 *
 * Method: every sequence starts from a fresh chain snapshot. A pure-JS reference model
 * predicts, for every transaction, success or the exact custom error, the exact events and
 * the exact balance of every party. After every transaction the chain is compared with the
 * model. Block timestamps and gas price are fixed per transaction, so runs are bit-for-bit
 * reproducible from the seed.
 */
const assert = require("assert");
const crypto = require("crypto");
const { ethers } = require("hardhat");

const N = Number(process.env.FUZZ_N || 200); // default keeps `npx hardhat test` fast; the full campaign is FUZZ_N=2000
const SEED = process.env.FUZZ_SEED || "noid-swap-fuzz-1";
const MAXSTEPS = Number(process.env.FUZZ_STEPS || 16);
const ONLY = process.env.FUZZ_ONLY !== undefined ? Number(process.env.FUZZ_ONLY) : null;
const ONLY_KIND = process.env.FUZZ_KIND || "eth";
const TRACE = process.env.FUZZ_TRACE === "1";
const CHUNK = 250;
const START = Number(process.env.FUZZ_START || 0); // first sequence index (resume / split a long run into processes)
// Mutation check: FUZZ_MUTANT=n deploys HTLCMutant(n), FUZZ_MUTANT_ERC20=n deploys HTLCERC20Mutant(n)
// (contracts/test/HTLCMutant.sol) instead of the real contracts; the campaign must then FAIL.
const MUT = process.env.FUZZ_MUTANT ? Number(process.env.FUZZ_MUTANT) : null;
const MUT_T = process.env.FUZZ_MUTANT_ERC20 ? Number(process.env.FUZZ_MUTANT_ERC20) : null;

const ZERO = ethers.ZeroAddress;
const MAXU = (1n << 256n) - 1n;
const p = ethers.provider;

// ----------------------------------------------------------------------------- PRNG
function xmur3(str) {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return () => {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return (h ^= h >>> 16) >>> 0;
  };
}
function mulberry32(a) {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
class Rng {
  constructor(seedStr) {
    this.next = mulberry32(xmur3(seedStr)());
  }
  int(n) { return Math.floor(this.next() * n); }
  range(lo, hi) { return lo + this.int(hi - lo + 1); }
  bool(pr = 0.5) { return this.next() < pr; }
  pick(a) { return a[this.int(a.length)]; }
  u32() { return Math.floor(this.next() * 4294967296); }
  bytes32() {
    let s = "0x";
    for (let i = 0; i < 8; i++) s += this.u32().toString(16).padStart(8, "0");
    return s;
  }
  big(max) { return (BigInt(this.u32()) * 4294967296n + BigInt(this.u32())) % max; }
  weighted(pairs) {
    let tot = 0;
    for (const [w] of pairs) tot += w;
    let r = this.next() * tot;
    for (const [w, v] of pairs) {
      if ((r -= w) < 0) return v;
    }
    return pairs[pairs.length - 1][1];
  }
}

// ----------------------------------------------------------------------------- misc helpers
const sha256Raw = (hex) => "0x" + crypto.createHash("sha256").update(Buffer.from(hex.slice(2), "hex")).digest("hex");
const lc = (a) => a.toLowerCase();
const hexcat = (...xs) => "0x" + xs.map((x) => x.slice(2)).join("");
const toHex = (n, bytes) => "0x" + n.toString(16).padStart(bytes * 2, "0");

const ERR_IFACE = new ethers.Interface([
  "error ZeroAmount()", "error ZeroReceiver()", "error InvalidReceiver()", "error ZeroToken()", "error TimelockNotInFuture()",
  "error LockAlreadyExists()", "error LockNotFound()", "error InvalidPreimage()", "error TimelockExpired()",
  "error TimelockNotExpired()", "error AlreadyClaimed()", "error AlreadyRefunded()", "error NotSender()",
  "error TransferFailed()", "error Reentrancy()", "error UnsupportedToken()",
  "error ERC20InsufficientBalance(address,uint256,uint256)", "error ERC20InsufficientAllowance(address,uint256,uint256)",
  "error SafeERC20FailedOperation(address)", "error AddressEmptyCode(address)",
]);
const SEL2NAME = { "0x08c379a0": "Error", "0x4e487b71": "Panic" };
ERR_IFACE.forEachError((f) => { SEL2NAME[f.selector] = f.name; });
const errName = (data) => (!data || data === "0x" ? "EMPTY" : SEL2NAME[data.slice(0, 10)] || "UNKNOWN:" + data.slice(0, 10));

const ACTOR_IFACE = new ethers.Interface([
  "function exec(address target, uint256 value, bytes data) returns (bytes)",
  "function setMode(uint8)", "function setBombSize(uint256)", "function addTarget(bytes32,bytes32)",
  "function arm(address,bool)", "function fund() payable",
]);
const TOKEN_IFACE = new ethers.Interface([
  "function approve(address,uint256) returns (bool)", "function mint(address,uint256)", "function burnFrom(address,uint256)",
  "function setMode(uint8)", "function setBlocked(address,bool)", "function addTarget(bytes32,bytes32)",
  "function transfer(address,uint256) returns (bool)",
]);

// ----------------------------------------------------------------------------- global stats
const STATS = {
  seqEth: 0, seqTok: 0, txEth: 0, txTok: 0, outcomes: {}, gas: {}, cover: {}, taint: {}, insolventSeq: {}, stuck: {},
  reentryAttempts: 0, reentrySuccess: 0, hooksRun: 0, startedAt: Date.now(),
};
const bump = (obj, k, n = 1) => { obj[k] = (obj[k] || 0) + n; };
function recGas(cat, g) {
  const s = (STATS.gas[cat] ||= { max: 0n, n: 0, sum: 0n });
  if (g > s.max) s.max = g;
  s.n++;
  s.sum += g;
}

// ----------------------------------------------------------------------------- environment
const env = {};

// The in-process Hardhat node keeps memory per mined block; a fresh chain every chunk keeps a long run flat.
async function freshChain() {
  await p.send("hardhat_reset", []);
  for (const k of Object.keys(env)) delete env[k];
  await setupEnv();
}

async function setupEnv() {
  if (env.eth) return;
  const signers = await ethers.getSigners();
  env.signers = signers;
  env.op = signers[9];
  const eoas = signers.slice(0, 4).map((s, i) => ({ name: ["alice", "bob", "carol", "dave"][i], addr: lc(s.address), kind: "eoa", signer: s }));

  const Actor = await ethers.getContractFactory("FuzzActor");
  const HTLC = await ethers.getContractFactory(MUT !== null ? "HTLCMutant" : "HTLC");
  const HTLCERC20 = await ethers.getContractFactory(MUT_T !== null ? "HTLCERC20Mutant" : "HTLCERC20");

  const mkActors = async (tag, htlcAddr, erc20) => {
    const out = [];
    for (let i = 0; i < 4; i++) {
      const a = await Actor.deploy();
      await a.waitForDeployment();
      if (!erc20) await (await a.fund({ value: ethers.parseEther("1000") })).wait();
      await (await a.arm(htlcAddr, erc20)).wait();
      out.push({ name: `${tag}${i}`, addr: lc(await a.getAddress()), kind: "actor", contract: a });
    }
    return out;
  };

  // ETH side
  const htlc = await HTLC.deploy(...(MUT !== null ? [MUT] : []));
  await htlc.waitForDeployment();
  const hAddr = lc(await htlc.getAddress());
  const actors = await mkActors("actor", hAddr, false);
  const outsiders = [lc("0x00000000000000000000000000000000000d0d0d"), lc("0x0000000000000000000000000000000000000002")];
  env.eth = {
    htlc, hAddr, iface: htlc.interface, parties: [...eoas, ...actors], actors, outsiders,
    recvPool: [...eoas, ...actors].map((x) => x.addr).concat(outsiders),
  };

  // ERC-20 side
  const htlcT = await HTLCERC20.deploy(...(MUT_T !== null ? [MUT_T] : []));
  await htlcT.waitForDeployment();
  const tAddr = lc(await htlcT.getAddress());
  const actorsT = await mkActors("tactor", tAddr, true);
  const partiesT = [...eoas, ...actorsT];
  const FuzzToken = await ethers.getContractFactory("FuzzToken");
  const NoRet = await ethers.getContractFactory("NoReturnToken");
  const tokens = [];
  for (const [name, F, kind] of [["fuzzA", FuzzToken, "fuzz"], ["fuzzB", FuzzToken, "fuzz"], ["noret", NoRet, "noret"]]) {
    const c = await F.deploy();
    await c.waitForDeployment();
    if (kind === "fuzz") await (await c.arm(tAddr)).wait();
    for (const q of partiesT) await (await c.mint(q.addr, 10n ** 30n)).wait();
    tokens.push({ name, kind, contract: c, addr: lc(await c.getAddress()) });
  }
  env.tok = {
    htlc: htlcT, hAddr: tAddr, iface: htlcT.interface, parties: partiesT, actors: actorsT, tokens, outsiders,
    recvPool: partiesT.map((x) => x.addr).concat(outsiders),
  };
}

// ----------------------------------------------------------------------------- engine
async function submit(signer, to, data, value, deploy) {
  try {
    const req = { data, value, gasLimit: 6_000_000, gasPrice: 0 };
    if (!deploy) req.to = to;
    const tx = await signer.sendTransaction(req);
    const receipt = await tx.wait();
    return { ok: true, receipt };
  } catch (e) {
    if (e && e.data !== undefined) return { ok: false, data: e.data };
    if (e && /out of gas/i.test(String(e.message))) return { ok: false, data: "0x", oog: true };
    throw e;
  }
}

function normArgs(args) {
  return Array.from(args).map((x) => (typeof x === "string" ? lc(x) : x.toString()));
}

class Seq {
  constructor(kind, idx, rng, M, E) {
    this.kind = kind; this.idx = idx; this.rng = rng; this.M = M; this.E = E; this.trace = [];
  }
  log(s) { this.trace.push(s); if (TRACE) console.log(`    [${this.kind}#${this.idx}] ${s}`); }

  /** plan: {label, caller|null, to, data, value, exp(M, ts) -> {ok, err, events, apply}, cat, touched:[ids], deploy} */
  async tx(plan, dt) {
    const { M, E } = this;
    const ts = M.t + dt;
    const e = plan.exp(M, BigInt(ts));
    let signer, to, data, value;
    if (plan.deploy) { signer = env.op; data = plan.data; value = plan.value || 0n; }
    else if (plan.caller && plan.caller.kind === "actor") {
      signer = env.op; to = plan.caller.addr; value = 0n;
      data = ACTOR_IFACE.encodeFunctionData("exec", [plan.to, plan.value || 0n, plan.data]);
    } else { signer = plan.caller ? plan.caller.signer : env.op; to = plan.to; data = plan.data; value = plan.value || 0n; }

    await p.send("evm_setNextBlockTimestamp", [ts]);
    await p.send("hardhat_setNextBlockBaseFeePerGas", ["0x0"]);
    const r = await submit(signer, to, data, value, plan.deploy);
    const blk = await p.getBlock("latest");
    assert.strictEqual(blk.number, M.blockNo + 1, "exactly one block must be mined per transaction");
    assert.strictEqual(blk.timestamp, ts, "block timestamp must be the planned one");
    M.blockNo++; M.t = ts;
    this.kind === "eth" ? STATS.txEth++ : STATS.txTok++;

    const outcome = r.ok ? "ok" : errName(r.data);
    bump(STATS.outcomes, `${this.kind}:${plan.label}:${outcome}`);
    this.log(`${plan.label} dt=${dt} ts=${ts} expect=${e.ok ? "ok" : [].concat(e.err).join("|")} got=${outcome}${plan.note ? " (" + plan.note + ")" : ""}`);

    if (e.ok) {
      assert.ok(r.ok, `expected success, tx reverted with ${outcome}`);
      this.checkLogs(r.receipt, e.events || []);
      if (plan.cat) recGas(plan.cat, r.receipt.gasUsed);
      e.apply && e.apply();
    } else {
      assert.ok(!r.ok, `expected revert ${[].concat(e.err).join("|")}, tx succeeded`);
      assert.ok([].concat(e.err).includes(outcome), `expected revert ${[].concat(e.err).join("|")}, got ${outcome}`);
    }
    if (plan.cover) plan.cover(e.ok, outcome);
    await E.invariants(this, plan, e);
  }

  checkLogs(receipt, expected) {
    const got = [];
    for (const lg of receipt.logs) {
      if (lc(lg.address) !== this.E.hAddr) continue;
      const parsed = this.E.iface.parseLog(lg);
      got.push({ name: parsed.name, args: normArgs(parsed.args) });
    }
    const want = expected.map((x) => ({ name: x.name, args: normArgs(x.args) }));
    assert.deepStrictEqual(got, want, "emitted events differ from the model");
  }
}

function pickDt(rng, M) {
  const r = rng.next();
  if (r < 0.3) return 1 + rng.int(2);
  const open = [...M.locks.values()];
  if (r < 0.65 && open.length) {
    const l = rng.pick(open);
    const cands = [l.timelock - 1n, l.timelock, l.timelock + 1n].filter((x) => x > BigInt(M.t));
    if (cands.length) return Number(rng.pick(cands) - BigInt(M.t));
  }
  if (r < 0.85) return 1 + rng.int(600);
  if (r < 0.95) return 1 + rng.int(7200);
  return 1 + rng.int(7 * 86400);
}

// ============================================================================= ETH campaign
const ETH_ACTOR_REJECTS = (M, addr) => M.mode[addr] === 1 || M.mode[addr] === 3;
const ethLockId = (s, r, a, h, t) => ethers.solidityPackedKeccak256(["address", "address", "uint256", "bytes32", "uint256"], [s, r, a, h, t]);

function ethClaimCalldata(iface, id, variant, lockSecret, hashlock, rng) {
  const sel = iface.getFunction("claim").selector;
  const right = lockSecret || rng.bytes32();
  const rb = () => toHex(rng.int(256), 1);
  switch (variant) {
    case "right": return { data: hexcat(sel, id, right), eff: right };
    case "wrong": { const w = rng.bytes32(); return { data: hexcat(sel, id, w), eff: w }; }
    case "zero": { const z = "0x" + "00".repeat(32); return { data: hexcat(sel, id, z), eff: z }; }
    case "hashAsPre": { const h = hashlock || rng.bytes32(); return { data: hexcat(sel, id, h), eff: h }; }
    case "trunc31": return { data: hexcat(sel, id, "0x" + right.slice(2, 2 + 62)), eff: null };
    case "empty": return { data: hexcat(sel, id), eff: null };
    case "long33": return { data: hexcat(sel, id, right, rb()), eff: right };
    case "shifted33": { const b = rb(); return { data: hexcat(sel, id, b, right), eff: "0x" + b.slice(2) + right.slice(2, 2 + 62) }; }
    default: throw new Error(variant);
  }
}

function ethExpNewLock(E, sender, receiver, amount, hashlock, timelock, meta) {
  return (M, ts) => {
    const fail = (err) => ({ ok: false, err });
    if (amount === 0n) return fail("ZeroAmount");
    if (receiver === ZERO) return fail("ZeroReceiver");
    if (timelock <= ts) return fail("TimelockNotInFuture");
    const id = ethLockId(sender, receiver, amount, hashlock, timelock);
    if (M.locks.has(id)) return fail("LockAlreadyExists");
    return {
      ok: true,
      events: [{ name: "Locked", args: [id, sender, receiver, amount, hashlock, timelock] }],
      apply: () => {
        // an id may only ever belong to one parameter tuple
        const prev = M.idParams.get(id);
        const key = [sender, receiver, amount, hashlock, timelock].join("|");
        assert.ok(!prev || prev === key, "lock id collision between different parameter tuples");
        M.idParams.set(id, key);
        M.locks.set(id, { id, sender, receiver, amount, hashlock, timelock, claimed: false, refunded: false, pre: ethers.ZeroHash, secret: meta.secret || null });
        M.bal[sender] -= amount; M.bal[E.hAddr] += amount;
        M.events.push({ name: "Locked", args: [id, sender, receiver, amount, hashlock, timelock] });
      },
    };
  };
}

function ethExpClaim(E, id, eff, label) {
  return (M, ts) => {
    const fail = (err) => ({ ok: false, err });
    if (eff === null) return fail("EMPTY"); // ABI decoder: calldata too short
    const l = M.locks.get(id);
    if (!l) return fail("LockNotFound");
    if (l.claimed) return fail("AlreadyClaimed");
    if (l.refunded) return fail("AlreadyRefunded");
    if (sha256Raw(eff) !== l.hashlock) return fail("InvalidPreimage");
    if (ts >= l.timelock) return fail("TimelockExpired");
    if (l.receiver === E.hAddr || ETH_ACTOR_REJECTS(M, l.receiver)) return fail("TransferFailed");
    return {
      ok: true,
      events: [{ name: "Claimed", args: [id, eff] }],
      apply: () => {
        l.claimed = true; l.pre = eff;
        M.bal[E.hAddr] -= l.amount; M.bal[l.receiver] += l.amount;
        M.events.push({ name: "Claimed", args: [id, eff] });
      },
    };
  };
}

function ethExpRefund(E, id, caller) {
  return (M, ts) => {
    const fail = (err) => ({ ok: false, err });
    const l = M.locks.get(id);
    if (!l) return fail("LockNotFound");
    if (caller.addr !== l.sender) return fail("NotSender");
    if (l.claimed) return fail("AlreadyClaimed");
    if (l.refunded) return fail("AlreadyRefunded");
    if (ts < l.timelock) return fail("TimelockNotExpired");
    if (ETH_ACTOR_REJECTS(M, l.sender)) return fail("TransferFailed");
    return {
      ok: true,
      events: [{ name: "Refunded", args: [id] }],
      apply: () => {
        l.refunded = true;
        M.bal[E.hAddr] -= l.amount; M.bal[l.sender] += l.amount;
        M.events.push({ name: "Refunded", args: [id] });
      },
    };
  };
}

const okExp = (apply) => () => ({ ok: true, events: [], apply });

async function ethInvariants(seq, plan, e) {
  const { M } = seq;
  const E = env.eth;
  // 1. exact balances of every party and of the contract
  for (const q of E.parties) assert.strictEqual(await p.getBalance(q.addr), M.bal[q.addr], `balance of ${q.name} differs from the model`);
  for (const o of E.outsiders) assert.strictEqual(await p.getBalance(o), M.bal[o], `balance of outsider ${o}`);
  const hb = await p.getBalance(E.hAddr);
  assert.strictEqual(hb, M.bal[E.hAddr], "contract balance differs from the model");
  // 2. ETH conservation: contract balance == sum of open locks (+ force-sent surplus)
  let open = 0n;
  for (const l of M.locks.values()) if (!l.claimed && !l.refunded) open += l.amount;
  assert.strictEqual(hb, open + M.forced, "ETH conservation: balance != sum(open locks) + forced surplus");
  // 3. every touched lock matches the model; never both claimed and refunded
  for (const id of plan.touched || []) await checkEthLock(E, M, id);
}

async function checkEthLock(E, M, id) {
  const l = M.locks.get(id);
  if (!l) {
    await assert.rejects(E.htlc.getLock(id), (err) => errName(err.data) === "LockNotFound");
    return;
  }
  const c = await E.htlc.getLock(id);
  assert.strictEqual(lc(c.sender), l.sender); assert.strictEqual(lc(c.receiver), l.receiver);
  assert.strictEqual(c.amount, l.amount); assert.strictEqual(c.hashlock, l.hashlock); assert.strictEqual(c.timelock, l.timelock);
  assert.strictEqual(c.claimed, l.claimed); assert.strictEqual(c.refunded, l.refunded); assert.strictEqual(c.preimage, l.pre);
  assert.ok(!(c.claimed && c.refunded), "lock both claimed and refunded");
  if (c.claimed) assert.strictEqual(sha256Raw(c.preimage), c.hashlock, "stored preimage does not hash to the hashlock");
}

async function ethSequence(idx) {
  const E = env.eth;
  const rng = new Rng(`${SEED}:eth:${idx}`);
  const snap = await p.send("evm_snapshot", []);
  let seq;
  try {
    const latest = await p.getBlock("latest");
    const M = {
      t: latest.timestamp, blockNo: latest.number, locks: new Map(), idParams: new Map(), bal: {}, mode: {},
      forced: 0n, events: [], secrets: [],
    };
    for (const q of E.parties) M.bal[q.addr] = await p.getBalance(q.addr);
    for (const o of E.outsiders) M.bal[o] = await p.getBalance(o);
    M.bal[E.hAddr] = await p.getBalance(E.hAddr);
    assert.strictEqual(M.bal[E.hAddr], 0n);
    for (const a of E.actors) M.mode[a.addr] = 0;
    for (let i = 0; i < rng.range(2, 4); i++) { const s = rng.bytes32(); M.secrets.push({ s, h: sha256Raw(s) }); }
    seq = new Seq("eth", idx, rng, M, { ...E, invariants: ethInvariants });
    const startBlock = M.blockNo;
    for (const a of E.actors) {
      if (!rng.bool(0.5)) continue;
      const m = rng.weighted([[10, 0], [30, 1], [40, 2], [10, 3], [10, 4]]);
      if (m === 4) await seq.tx({ label: "setBombSize", caller: null, to: a.addr, data: ACTOR_IFACE.encodeFunctionData("setBombSize", [rng.range(0, 60000)]), exp: okExp(), touched: [] }, 1);
      await seq.tx({ label: "setMode", caller: null, to: a.addr, data: ACTOR_IFACE.encodeFunctionData("setMode", [m]), exp: okExp(() => { M.mode[a.addr] = m; }), touched: [], note: `${a.name}=${m} (setup)` }, 1);
    }
    const nSteps = rng.range(4, MAXSTEPS);
    for (let step = 0; step < nSteps; step++) {
      const kinds = [[M.locks.size ? 26 : 90, "newLock"], [M.locks.size ? 24 : 0, "claim"], [M.locks.size ? 14 : 0, "refund"], [9, "setMode"], [2, "force"], [1, "direct"], [1, "dirty"], [3, "view"]];
      const kind = rng.weighted(kinds);
      const dt = pickDt(rng, M);
      const ts = BigInt(M.t + dt);
      await ethStep(seq, kind, dt, ts);
    }
    await ethDrain(seq);
    await ethAudit(seq, startBlock);
  } catch (err) {
    if (seq) {
      console.error(`\n--- eth sequence ${idx} FAILED (seed "${SEED}"). Reproduce: FUZZ_SEED=${SEED} FUZZ_ONLY=${idx} FUZZ_KIND=eth FUZZ_TRACE=1`);
      console.error(seq.trace.slice(-40).join("\n"));
    }
    throw err;
  } finally {
    await p.send("evm_revert", [snap]);
  }
  STATS.seqEth++;
}

async function ethStep(seq, kind, dt, ts) {
  const { M, rng } = seq;
  const E = env.eth;
  const party = () => rng.pick(E.parties);
  const cover = (name) => (ok, outcome) => bump(STATS.cover, `${name}:${ok ? "ok" : outcome}`);

  if (kind === "newLock") {
    // optionally reuse an existing lock's exact parameters (collision / duplicate test)
    let sender, receiver, amount, hashlock, timelock, secret = null;
    const existing = [...M.locks.values()];
    if (existing.length && rng.bool(0.15)) {
      const l = rng.pick(existing);
      ({ sender, receiver, amount, hashlock, timelock, secret } = l);
      if (rng.bool(0.3)) timelock += 1n; // near-duplicate: must be a distinct lock
      else if (rng.bool(0.3)) amount += 1n;
      else if (rng.bool(0.3)) receiver = rng.pick(E.recvPool.filter((x) => x !== receiver));
    } else {
      sender = party().addr;
      receiver = rng.weighted([[45, rng.pick(E.actors).addr], [30, rng.pick(E.recvPool)], [8, sender], [3, ZERO], [3, E.hAddr], [11, rng.pick(E.outsiders)]]);
      amount = rng.weighted([[5, 0n], [20, 1n], [30, BigInt(rng.range(2, 1_000_000))], [45, rng.big(5n * 10n ** 18n) + 1n]]);
      const hp = rng.weighted([[70, "pool"], [10, "zero"], [10, "random"], [10, "reuse"]]);
      if (hp === "pool") { const s = rng.pick(M.secrets); hashlock = s.h; secret = s.s; }
      else if (hp === "zero") hashlock = ethers.ZeroHash;
      else if (hp === "reuse" && existing.length) { const l = rng.pick(existing); hashlock = l.hashlock; secret = l.secret; }
      else { const s = rng.bytes32(); hashlock = sha256Raw(s); secret = s; }
      const off = rng.weighted([[12, -BigInt(rng.int(10))], [3, 0n], [10, BigInt(rng.range(1, 5))], [75, BigInt(rng.range(6, 3 * 3600))]]);
      timelock = ts + off;
    }
    if (rng.bool(0.1) && receiver !== ZERO) timelock = ts + 1n; // tightest legal timelock
    const sp = E.parties.find((x) => x.addr === sender);
    const id = ethLockId(sender, receiver, amount, hashlock, timelock);
    await seq.tx({
      label: "newLock", caller: sp, to: E.hAddr, value: amount,
      data: E.iface.encodeFunctionData("newLock", [hashlock, timelock, receiver]),
      exp: ethExpNewLock(E, sender, receiver, amount, hashlock, timelock, { secret }), touched: [id],
      cat: `eth.newLock${sp.kind === "actor" ? ".viaActor" : ""}`,
      note: M.locks.has(id) ? "duplicate id" : "",
    }, dt);
    if (M.locks.has(id) && !M.locks.get(id).armed) {
      M.locks.get(id).armed = true;
      if (rng.bool(0.6)) {
        // let the actors know the lock so a re-entering receiver can try to attack it
        for (const a of E.actors) await seq.tx({ label: "addTarget", caller: null, to: a.addr, data: ACTOR_IFACE.encodeFunctionData("addTarget", [id, M.locks.get(id).secret || rng.bytes32()]), exp: okExp(), touched: [] }, 1);
      }
    }
    return;
  }

  if (kind === "claim") {
    const ids = [...M.locks.keys()];
    const target = rng.weighted([[75, "existing"], [15, "random"], [10, "nonexist"]]);
    const id = target === "existing" ? rng.pick(ids) : target === "random" ? rng.bytes32() : ethers.ZeroHash;
    const l = M.locks.get(id);
    const variant = rng.weighted([[42, "right"], [14, "wrong"], [3, "zero"], [3, "hashAsPre"], [7, "trunc31"], [4, "empty"], [8, "long33"], [5, "shifted33"]]);
    const cd = ethClaimCalldata(E.iface, id, variant, l && l.secret, l && l.hashlock, rng);
    const caller = party();
    await seq.tx({
      label: `claim.${variant}`, caller, to: E.hAddr, data: cd.data,
      exp: ethExpClaim(E, id, cd.eff), touched: [id],
      cat: l ? `eth.claim.to_${rcvClass(M, E, l.receiver)}` : undefined,
      note: l ? `receiver=${rcvClass(M, E, l.receiver)}` : "",
      cover: l ? (ok, o) => { const dtl = BigInt(M.t) - l.timelock; if (dtl >= -1n && dtl <= 0n) bump(STATS.cover, `claim@tl${dtl === -1n ? "-1" : "=0"}(${variant === "right" ? "right" : "other"}):${ok ? "ok" : o}`); } : undefined,
    }, dt);
    return;
  }

  if (kind === "refund") {
    const ids = [...M.locks.keys()];
    const id = rng.pick(ids);
    const l = M.locks.get(id);
    const caller = rng.bool(0.7) ? E.parties.find((x) => x.addr === l.sender) : party();
    await seq.tx({
      label: "refund", caller, to: E.hAddr, data: E.iface.encodeFunctionData("refund", [id]),
      exp: ethExpRefund(E, id, caller), touched: [id],
      cat: `eth.refund${caller.kind === "actor" ? ".viaActor" : ""}`,
      cover: (ok, o) => { const dtl = BigInt(M.t) - l.timelock; if (dtl >= -1n && dtl <= 0n && caller.addr === l.sender) bump(STATS.cover, `refund@tl${dtl === -1n ? "-1" : "=0"}:${ok ? "ok" : o}`); },
    }, dt);
    return;
  }

  if (kind === "setMode") {
    const a = rng.pick(E.actors);
    const m = rng.weighted([[25, 0], [30, 1], [25, 2], [10, 3], [10, 4]]);
    if (m === 4) await seq.tx({ label: "setBombSize", caller: null, to: a.addr, data: ACTOR_IFACE.encodeFunctionData("setBombSize", [rng.range(0, 60000)]), exp: okExp(), touched: [] }, 1);
    await seq.tx({ label: "setMode", caller: null, to: a.addr, data: ACTOR_IFACE.encodeFunctionData("setMode", [m]), exp: okExp(() => { M.mode[a.addr] = m; }), touched: [], note: `${a.name}=${m}` }, dt);
    return;
  }

  if (kind === "force") {
    const amt = BigInt(rng.range(1, 1000));
    const Force = await ethers.getContractFactory("ForceSend");
    const dep = await Force.getDeployTransaction(E.hAddr);
    await seq.tx({ label: "forceSend", deploy: true, caller: null, data: dep.data, value: amt, exp: okExp(() => { M.forced += amt; M.bal[E.hAddr] += amt; }), touched: [] }, dt);
    return;
  }

  if (kind === "direct") {
    // plain ETH transfer to the contract: no receive()/fallback() -> must revert
    await seq.tx({ label: "plainSend", caller: party(), to: E.hAddr, data: "0x", value: BigInt(rng.range(1, 100)), exp: () => ({ ok: false, err: "EMPTY" }), touched: [] }, dt);
    return;
  }

  if (kind === "dirty") {
    // address argument with dirty upper bits must be rejected by the ABI decoder
    const sel = E.iface.getFunction("newLock").selector;
    const dirty = "0x" + "ff".repeat(12) + "11".repeat(20);
    await seq.tx({ label: "newLock.dirtyReceiver", caller: party(), to: E.hAddr, value: 5n, data: hexcat(sel, rng.bytes32(), toHex(ts + 100n, 32), dirty), exp: () => ({ ok: false, err: "EMPTY" }), touched: [] }, dt);
    return;
  }

  if (kind === "view") {
    const id = rng.weighted([[70, [...M.locks.keys()][0] || ethers.ZeroHash], [30, rng.bytes32()]]);
    await checkEthLock(env.eth, M, id);
    return;
  }
  throw new Error("unknown step " + kind);
}

function rcvClass(M, E, addr) {
  if (addr === E.hAddr) return "htlc";
  const a = E.actors.find((x) => x.addr === addr);
  if (a) return ["actor.accept", "actor.reject", "actor.reenter", "actor.burn", "actor.bomb"][M.mode[addr]];
  return "eoa";
}

/** Liveness: everyone becomes cooperative, time passes, every sender refunds what is still open. */
async function ethDrain(seq) {
  const { M, rng } = seq;
  const E = env.eth;
  for (const a of E.actors) if (M.mode[a.addr] !== 0) await seq.tx({ label: "drain.setMode", caller: null, to: a.addr, data: ACTOR_IFACE.encodeFunctionData("setMode", [0]), exp: okExp(() => { M.mode[a.addr] = 0; }), touched: [] }, 1);
  let maxTl = 0n;
  for (const l of M.locks.values()) if (!l.claimed && !l.refunded && l.timelock > maxTl) maxTl = l.timelock;
  let dt = maxTl > BigInt(M.t) ? Number(maxTl - BigInt(M.t)) : 1; // lands exactly on the latest timelock: refund must be allowed at ==
  for (const l of [...M.locks.values()]) {
    if (l.claimed || l.refunded) continue;
    const caller = E.parties.find((x) => x.addr === l.sender);
    await seq.tx({ label: "drain.refund", caller, to: E.hAddr, data: E.iface.encodeFunctionData("refund", [l.id]), exp: ethExpRefund(E, l.id, caller), touched: [l.id], cat: "eth.refund.drain" }, dt);
    dt = 1;
    assert.ok(M.locks.get(l.id).refunded, "drain refund must succeed once everyone accepts ETH");
  }
  const hb = await p.getBalance(E.hAddr);
  assert.strictEqual(hb, M.forced, "after draining, only force-sent surplus may remain in the contract");
}

async function ethAudit(seq, startBlock) {
  const { M } = seq;
  const E = env.eth;
  for (const id of M.locks.keys()) await checkEthLock(E, M, id);
  // events vs state: replay the logs independently of the model
  const logs = await p.getLogs({ address: E.hAddr, fromBlock: startBlock + 1, toBlock: "latest" });
  const parsed = logs.map((lg) => { const x = E.iface.parseLog(lg); return { name: x.name, args: normArgs(x.args) }; });
  assert.deepStrictEqual(parsed, M.events.map((x) => ({ name: x.name, args: normArgs(x.args) })), "event log differs from the model");
  const locked = new Set(), claimed = new Set(), refunded = new Set();
  for (const ev of parsed) {
    const id = ev.args[0];
    if (ev.name === "Locked") { assert.ok(!locked.has(id), "Locked twice for one id"); locked.add(id); }
    if (ev.name === "Claimed") { assert.ok(locked.has(id) && !claimed.has(id) && !refunded.has(id), "bad Claimed"); claimed.add(id); }
    if (ev.name === "Refunded") { assert.ok(locked.has(id) && !claimed.has(id) && !refunded.has(id), "bad Refunded"); refunded.add(id); }
  }
  assert.strictEqual(locked.size, M.locks.size);
  for (const l of M.locks.values()) {
    assert.strictEqual(claimed.has(l.id), l.claimed); assert.strictEqual(refunded.has(l.id), l.refunded);
    assert.ok(l.claimed || l.refunded, "every lock must be settled after the drain");
  }
  // re-entrancy: no attempt from a hostile receiver may ever have succeeded
  for (const a of E.actors) {
    const att = await a.contract.attempts(), suc = await a.contract.successes(), runs = await a.contract.hookRuns();
    STATS.reentryAttempts += Number(att); STATS.reentrySuccess += Number(suc); STATS.hooksRun += Number(runs);
    assert.strictEqual(suc, 0n, `re-entrant call succeeded from ${a.name}`);
  }
}

// ============================================================================= ERC-20 campaign
const tokId = (s, r, t, a, h, tl) => ethers.solidityPackedKeccak256(["address", "address", "address", "uint256", "bytes32", "uint256"], [s, r, t, a, h, tl]);
const ERC20_SETTLE_ERR = ["Error", "ERC20InsufficientBalance", "ERC20InsufficientAllowance", "SafeERC20FailedOperation", "Panic"];

/** model of HTLCERC20 pulling `amount` from `from` (transferFrom by the contract) */
function tokPull(M, tok, from, amount, E) {
  const tb = M.tb[tok.addr];
  const fail = (err) => ({ ok: false, err });
  if (tok.kind === "noret") {
    if (M.allow[tok.addr][from] < amount || tb[from] < amount) return fail("Panic");
    return { ok: true, effect: () => { M.allow[tok.addr][from] -= amount; tb[from] -= amount; tb[E.hAddr] += amount; } };
  }
  const mode = M.tmode[tok.addr];
  if (mode === 5 || mode === 11 || M.blocked[tok.addr][E.hAddr]) return fail("Error");
  if (mode === 7) return fail("SafeERC20FailedOperation");
  if (mode === 8) return fail("UnsupportedToken");
  const al = M.allow[tok.addr][from];
  if (al !== MAXU && al < amount) return fail("ERC20InsufficientAllowance");
  if (tb[from] < amount) return fail("ERC20InsufficientBalance");
  if (mode === 1 && amount / 100n > 0n) return fail("UnsupportedToken");
  return { ok: true, effect: () => { if (al !== MAXU) M.allow[tok.addr][from] -= amount; tb[from] -= amount; tb[E.hAddr] += amount; } };
}

/** model of HTLCERC20 paying `amount` to `to` (transfer by the contract) */
function tokPay(M, tok, to, amount, E) {
  const tb = M.tb[tok.addr];
  const fail = (err) => ({ ok: false, err });
  const H = E.hAddr;
  if (tok.kind === "noret") {
    if (tb[H] < amount) return fail("Panic");
    return { ok: true, effect: () => { tb[H] -= amount; tb[to] += amount; } };
  }
  const mode = M.tmode[tok.addr];
  if (mode === 4 || mode === 11 || M.blocked[tok.addr][to]) return fail("Error");
  if (mode === 6) return fail("SafeERC20FailedOperation");
  if (mode === 9) return { ok: true, effect: () => { M.taint[tok.addr].add("payout-lie"); } };
  const fee = amount / 100n;
  if (mode === 2) {
    if (tb[H] < amount - fee) return fail("ERC20InsufficientBalance");
    if (fee > 0n && (to === H ? tb[H] : tb[H] - (amount - fee)) < fee) return fail("ERC20InsufficientBalance");
    return { ok: true, effect: () => { tb[H] -= amount; tb[to] += amount - fee; if (fee > 0n) M.taint[tok.addr].add("fee-on-payout"); } };
  }
  if (mode === 3) {
    if (tb[H] < amount) return fail("ERC20InsufficientBalance");
    if (fee > 0n && (to === H ? tb[H] : tb[H] - amount) < fee) return fail("ERC20InsufficientBalance");
    return { ok: true, effect: () => { tb[H] -= amount; tb[to] += amount; tb[H] -= fee; if (fee > 0n) M.taint[tok.addr].add("fee-on-top-of-payout"); } };
  }
  if (tb[H] < amount) return fail("ERC20InsufficientBalance");
  return { ok: true, effect: () => { tb[H] -= amount; tb[to] += amount; } };
}

function tokExpNewLock(E, tok, sender, receiver, amount, hashlock, timelock, meta) {
  return (M, ts) => {
    const fail = (err) => ({ ok: false, err });
    if (amount === 0n) return fail("ZeroAmount");
    if (receiver === ZERO) return fail("ZeroReceiver");
    if (receiver === E.hAddr) return fail("InvalidReceiver");
    if (timelock <= ts) return fail("TimelockNotInFuture");
    const id = tokId(sender, receiver, tok.addr, amount, hashlock, timelock);
    if (M.locks.has(id)) return fail("LockAlreadyExists");
    const pl = tokPull(M, tok, sender, amount, E);
    if (!pl.ok) return fail(pl.err);
    return {
      ok: true,
      events: [{ name: "Locked", args: [id, sender, receiver, tok.addr, amount, hashlock, timelock] }],
      apply: () => {
        const prev = M.idParams.get(id);
        const key = [sender, receiver, tok.addr, amount, hashlock, timelock].join("|");
        assert.ok(!prev || prev === key, "lock id collision between different parameter tuples");
        M.idParams.set(id, key);
        pl.effect();
        M.locks.set(id, { id, sender, receiver, tok, amount, hashlock, timelock, claimed: false, refunded: false, pre: ethers.ZeroHash, secret: meta.secret || null });
        M.events.push({ name: "Locked", args: [id, sender, receiver, tok.addr, amount, hashlock, timelock] });
      },
    };
  };
}

function tokExpClaim(E, id, eff) {
  return (M, ts) => {
    const fail = (err) => ({ ok: false, err });
    if (eff === null) return fail("EMPTY");
    const l = M.locks.get(id);
    if (!l) return fail("LockNotFound");
    if (l.claimed) return fail("AlreadyClaimed");
    if (l.refunded) return fail("AlreadyRefunded");
    if (sha256Raw(eff) !== l.hashlock) return fail("InvalidPreimage");
    if (ts >= l.timelock) return fail("TimelockExpired");
    const py = tokPay(M, l.tok, l.receiver, l.amount, E);
    if (!py.ok) return fail(py.err);
    return { ok: true, events: [{ name: "Claimed", args: [id, eff] }], apply: () => {
      l.claimed = true; l.pre = eff; py.effect();
      M.events.push({ name: "Claimed", args: [id, eff] });
    } };
  };
}

function tokExpRefund(E, id, caller) {
  return (M, ts) => {
    const fail = (err) => ({ ok: false, err });
    const l = M.locks.get(id);
    if (!l) return fail("LockNotFound");
    if (caller.addr !== l.sender) return fail("NotSender");
    if (l.claimed) return fail("AlreadyClaimed");
    if (l.refunded) return fail("AlreadyRefunded");
    if (ts < l.timelock) return fail("TimelockNotExpired");
    const py = tokPay(M, l.tok, l.sender, l.amount, E);
    if (!py.ok) return fail(py.err);
    return { ok: true, events: [{ name: "Refunded", args: [id] }], apply: () => { l.refunded = true; py.effect(); M.events.push({ name: "Refunded", args: [id] }); } };
  };
}

async function tokInvariants(seq, plan, e, full) {
  const { M } = seq;
  const E = env.tok;
  for (const tok of full ? E.tokens : plan.tokens || []) {
    const tb = M.tb[tok.addr];
    for (const q of [...E.parties, { addr: E.hAddr, name: "htlc" }]) {
      assert.strictEqual(await tok.contract.balanceOf(q.addr), tb[q.addr], `${tok.name} balance of ${q.name} differs from the model`);
    }
    for (const o of E.outsiders) assert.strictEqual(await tok.contract.balanceOf(o), tb[o], `${tok.name} balance of outsider`);
    let open = 0n;
    for (const l of M.locks.values()) if (l.tok.addr === tok.addr && !l.claimed && !l.refunded) open += l.amount;
    const hb = tb[E.hAddr];
    if (M.taint[tok.addr].size === 0) {
      // token conservation: untainted token => balance == sum(open locks) + donated surplus
      assert.strictEqual(hb, open + M.donated[tok.addr], `${tok.name}: token conservation (balance != sum(open) + donated)`);
    } else if (hb < open) {
      M.insolvent.add(`${tok.kind}:${[...M.taint[tok.addr]].sort().join("+")}`);
    }
  }
  for (const id of plan.touched || []) await checkTokLock(E, M, id);
}

async function checkTokLock(E, M, id) {
  const l = M.locks.get(id);
  if (!l) {
    await assert.rejects(E.htlc.getLock(id), (err) => errName(err.data) === "LockNotFound");
    return;
  }
  const c = await E.htlc.getLock(id);
  assert.strictEqual(lc(c.sender), l.sender); assert.strictEqual(lc(c.receiver), l.receiver); assert.strictEqual(lc(c.token), l.tok.addr);
  assert.strictEqual(c.amount, l.amount); assert.strictEqual(c.hashlock, l.hashlock); assert.strictEqual(c.timelock, l.timelock);
  assert.strictEqual(c.claimed, l.claimed); assert.strictEqual(c.refunded, l.refunded); assert.strictEqual(c.preimage, l.pre);
  assert.ok(!(c.claimed && c.refunded));
}

async function tokSequence(idx) {
  const E = env.tok;
  const rng = new Rng(`${SEED}:tok:${idx}`);
  const snap = await p.send("evm_snapshot", []);
  let seq;
  try {
    const latest = await p.getBlock("latest");
    const M = {
      t: latest.timestamp, blockNo: latest.number, locks: new Map(), idParams: new Map(), tb: {}, allow: {}, tmode: {}, blocked: {},
      taint: {}, donated: {}, events: [], secrets: [], insolvent: new Set(),
    };
    for (const tok of E.tokens) {
      M.tb[tok.addr] = {}; M.allow[tok.addr] = {}; M.blocked[tok.addr] = {}; M.tmode[tok.addr] = 0; M.taint[tok.addr] = new Set(); M.donated[tok.addr] = 0n;
      for (const q of E.parties) { M.tb[tok.addr][q.addr] = await tok.contract.balanceOf(q.addr); M.allow[tok.addr][q.addr] = 0n; }
      for (const o of E.outsiders) M.tb[tok.addr][o] = 0n;
      M.tb[tok.addr][E.hAddr] = 0n;
      for (const o of E.tokens) M.tb[tok.addr][o.addr] = 0n; // receivers can also be token contracts
      M.tb[tok.addr][ZERO] = 0n;
      for (const q of E.parties.concat(E.outsiders.map((a) => ({ addr: a })))) M.blocked[tok.addr][q.addr] = false;
      M.blocked[tok.addr][E.hAddr] = false;
    }
    for (let i = 0; i < rng.range(2, 4); i++) { const s = rng.bytes32(); M.secrets.push({ s, h: sha256Raw(s) }); }
    seq = new Seq("tok", idx, rng, M, { ...E, invariants: tokInvariants });
    const startBlock = M.blockNo;
    for (const tok of E.tokens.filter((x) => x.kind === "fuzz")) {
      if (!rng.bool(0.5)) continue;
      const m = rng.weighted([[0, 0], [8, 1], [8, 2], [8, 3], [6, 4], [5, 5], [5, 6], [5, 7], [5, 8], [5, 9], [20, 10], [3, 11]]);
      await seq.tx({ label: "tokMode", caller: null, ...tokCall(tok, "setMode", [m]), exp: okExp(() => { M.tmode[tok.addr] = m; }), touched: [], tokens: [tok], note: `${tok.name}=${m} (setup)` }, 1);
    }
    const nSteps = rng.range(4, MAXSTEPS);
    for (let step = 0; step < nSteps; step++) {
      const kind = rng.weighted([[M.locks.size ? 26 : 90, "newLock"], [M.locks.size ? 22 : 0, "claim"], [M.locks.size ? 14 : 0, "refund"], [14, "tokMode"], [5, "block"], [2, "rebase"], [2, "donate"], [2, "view"]]);
      const dt = pickDt(rng, M);
      await tokStep(seq, kind, dt, BigInt(M.t + dt));
    }
    await tokDrain(seq);
    await tokInvariants(seq, { touched: [] }, null, true);
    await tokAudit(seq, startBlock);
    for (const k of M.insolvent) bump(STATS.insolventSeq, k);
    for (const t of E.tokens) for (const r of M.taint[t.addr]) bump(STATS.taint, `${t.kind}:${r}`);
  } catch (err) {
    if (seq) {
      console.error(`\n--- tok sequence ${idx} FAILED (seed "${SEED}"). Reproduce: FUZZ_SEED=${SEED} FUZZ_ONLY=${idx} FUZZ_KIND=tok FUZZ_TRACE=1`);
      console.error(seq.trace.slice(-40).join("\n"));
    }
    throw err;
  } finally {
    await p.send("evm_revert", [snap]);
  }
  STATS.seqTok++;
}

const tokCall = (tok, fn, args) => ({ to: tok.addr, data: TOKEN_IFACE.encodeFunctionData(fn, args) });

async function tokStep(seq, kind, dt, ts) {
  const { M, rng } = seq;
  const E = env.tok;
  const party = () => rng.pick(E.parties);

  if (kind === "newLock") {
    let sender, receiver, tok, amount, hashlock, timelock, secret = null;
    const existing = [...M.locks.values()];
    if (existing.length && rng.bool(0.15)) {
      const l = rng.pick(existing);
      ({ sender, receiver, tok, amount, hashlock, timelock, secret } = l);
      if (rng.bool(0.3)) timelock += 1n;
      else if (rng.bool(0.3)) tok = rng.pick(E.tokens);
    } else {
      sender = party().addr;
      tok = rng.weighted([[40, E.tokens[0]], [30, E.tokens[1]], [30, E.tokens[2]]]);
      receiver = rng.weighted([[75, rng.pick(E.recvPool)], [10, sender], [4, ZERO], [4, E.hAddr], [7, rng.pick(E.tokens).addr]]);
      amount = rng.weighted([[4, 0n], [20, 1n], [20, BigInt(rng.range(2, 99))], [25, BigInt(rng.range(100, 1_000_000))], [31, rng.big(10n ** 12n) + 100n]]);
      const hp = rng.weighted([[75, "pool"], [10, "zero"], [15, "random"]]);
      if (hp === "pool") { const s = rng.pick(M.secrets); hashlock = s.h; secret = s.s; }
      else if (hp === "zero") hashlock = ethers.ZeroHash;
      else { const s = rng.bytes32(); hashlock = sha256Raw(s); secret = s; }
      timelock = ts + rng.weighted([[12, -BigInt(rng.int(10))], [3, 0n], [10, BigInt(rng.range(1, 5))], [75, BigInt(rng.range(6, 3 * 3600))]]);
    }
    const sp = E.parties.find((x) => x.addr === sender);
    // approval: exact, max, zero, or nothing (leftover allowance may be too small)
    const ap = rng.weighted([[70, "exact"], [10, "max"], [5, "zero"], [15, "skip"]]);
    if (ap !== "skip") {
      const v = ap === "exact" ? amount : ap === "max" ? MAXU : 0n;
      await seq.tx({ label: "approve", caller: sp, ...tokCall(tok, "approve", [E.hAddr, v]), exp: okExp(() => { M.allow[tok.addr][sender] = v; }), touched: [], tokens: [tok] }, 1);
    }
    const id = tokId(sender, receiver, tok.addr, amount, hashlock, timelock);
    await seq.tx({
      label: `newLock.${tok.kind === "noret" ? "noret" : "fuzz"}`, caller: sp, to: E.hAddr,
      data: E.iface.encodeFunctionData("newLock", [hashlock, timelock, receiver, tok.addr, amount]),
      exp: tokExpNewLock(E, tok, sender, receiver, amount, hashlock, timelock, { secret }), touched: [id], tokens: [tok],
      cat: `erc20.newLock.${tok.kind}`, note: `mode=${M.tmode[tok.addr]} amt=${amount}`,
    }, dt);
    if (M.locks.has(id) && !M.locks.get(id).armed) {
      M.locks.get(id).armed = true;
      if (rng.bool(0.5)) for (const t of E.tokens.filter((x) => x.kind === "fuzz")) await seq.tx({ label: "addTarget", caller: null, ...tokCall(t, "addTarget", [id, M.locks.get(id).secret || rng.bytes32()]), exp: okExp(), touched: [] }, 1);
    }
    return;
  }

  if (kind === "claim") {
    const ids = [...M.locks.keys()];
    const id = rng.weighted([[85, rng.pick(ids)], [15, rng.bytes32()]]);
    const l = M.locks.get(id);
    const variant = rng.weighted([[50, "right"], [14, "wrong"], [3, "zero"], [7, "trunc31"], [3, "empty"], [8, "long33"], [5, "shifted33"]]);
    const cd = ethClaimCalldata(E.iface, id, variant, l && l.secret, l && l.hashlock, rng);
    await seq.tx({ label: `claim.${variant}`, caller: party(), to: E.hAddr, data: cd.data, exp: tokExpClaim(E, id, cd.eff), touched: [id], tokens: l ? [l.tok] : [], cat: l ? `erc20.claim.${l.tok.kind}.mode${M.tmode[l.tok.addr]}` : undefined }, dt);
    return;
  }

  if (kind === "refund") {
    const id = rng.pick([...M.locks.keys()]);
    const l = M.locks.get(id);
    const caller = rng.bool(0.75) ? E.parties.find((x) => x.addr === l.sender) : party();
    await seq.tx({ label: "refund", caller, to: E.hAddr, data: E.iface.encodeFunctionData("refund", [id]), exp: tokExpRefund(E, id, caller), touched: [id], tokens: [l.tok], cat: `erc20.refund.${l.tok.kind}.mode${M.tmode[l.tok.addr]}` }, dt);
    return;
  }

  if (kind === "tokMode") {
    const tok = rng.pick(E.tokens.filter((x) => x.kind === "fuzz"));
    const m = rng.weighted([[30, 0], [8, 1], [8, 2], [8, 3], [6, 4], [5, 5], [5, 6], [5, 7], [5, 8], [5, 9], [12, 10], [3, 11]]);
    await seq.tx({ label: "tokMode", caller: null, ...tokCall(tok, "setMode", [m]), exp: okExp(() => { M.tmode[tok.addr] = m; }), touched: [], tokens: [tok], note: `${tok.name}=${m}` }, dt);
    return;
  }

  if (kind === "block") {
    const tok = rng.pick(E.tokens.filter((x) => x.kind === "fuzz"));
    const who = rng.pick([...E.parties.map((x) => x.addr), E.hAddr]);
    const v = rng.bool(0.6);
    await seq.tx({ label: "setBlocked", caller: null, ...tokCall(tok, "setBlocked", [who, v]), exp: okExp(() => { M.blocked[tok.addr][who] = v; }), touched: [], tokens: [tok] }, dt);
    return;
  }

  if (kind === "rebase") {
    // negative rebase / confiscation of tokens held by the contract
    const tok = rng.pick(E.tokens.filter((x) => x.kind === "fuzz"));
    const hb = M.tb[tok.addr][E.hAddr];
    if (hb === 0n) return;
    const x = 1n + rng.big(hb);
    await seq.tx({ label: "rebaseDown", caller: null, ...tokCall(tok, "burnFrom", [E.hAddr, x]), exp: okExp(() => { M.tb[tok.addr][E.hAddr] -= x; M.taint[tok.addr].add("negative-rebase"); }), touched: [], tokens: [tok] }, dt);
    return;
  }

  if (kind === "donate") {
    const tok = rng.pick(E.tokens);
    const x = BigInt(rng.range(1, 1000));
    await seq.tx({ label: "donate", caller: null, ...tokCall(tok, "mint", [E.hAddr, x]), exp: okExp(() => { M.tb[tok.addr][E.hAddr] += x; M.donated[tok.addr] += x; }), touched: [], tokens: [tok] }, dt);
    return;
  }

  if (kind === "view") {
    await checkTokLock(E, M, rng.weighted([[70, [...M.locks.keys()][0] || ethers.ZeroHash], [30, rng.bytes32()]]));
    return;
  }
  throw new Error("unknown step " + kind);
}

async function tokDrain(seq) {
  const { M } = seq;
  const E = env.tok;
  for (const tok of E.tokens.filter((x) => x.kind === "fuzz")) {
    if (M.tmode[tok.addr] !== 0) await seq.tx({ label: "drain.tokMode", caller: null, ...tokCall(tok, "setMode", [0]), exp: okExp(() => { M.tmode[tok.addr] = 0; }), touched: [] }, 1);
    for (const who of Object.keys(M.blocked[tok.addr])) if (M.blocked[tok.addr][who]) await seq.tx({ label: "drain.unblock", caller: null, ...tokCall(tok, "setBlocked", [who, false]), exp: okExp(() => { M.blocked[tok.addr][who] = false; }), touched: [] }, 1);
  }
  let maxTl = 0n;
  for (const l of M.locks.values()) if (!l.claimed && !l.refunded && l.timelock > maxTl) maxTl = l.timelock;
  let dt = maxTl > BigInt(M.t) ? Number(maxTl - BigInt(M.t)) : 1;
  for (const l of [...M.locks.values()]) {
    if (l.claimed || l.refunded) continue;
    const caller = E.parties.find((x) => x.addr === l.sender);
    // the model decides whether this refund can succeed (it cannot if the token left the contract insolvent)
    const probe = tokExpRefund(E, l.id, caller)(M, BigInt(M.t + dt));
    await seq.tx({ label: "drain.refund", caller, to: E.hAddr, data: E.iface.encodeFunctionData("refund", [l.id]), exp: tokExpRefund(E, l.id, caller), touched: [l.id], tokens: [l.tok], cat: "erc20.refund.drain" }, dt);
    dt = 1;
    if (!probe.ok) bump(STATS.stuck, `erc20:${[...M.taint[l.tok.addr]].sort().join("+") || "none"}:${[].concat(probe.err).join("|")}`);
    else assert.ok(M.locks.get(l.id).refunded);
  }
  for (const tok of E.tokens) {
    const hb = M.tb[tok.addr][E.hAddr];
    if (M.taint[tok.addr].size === 0) assert.strictEqual(hb, M.donated[tok.addr], `${tok.name}: after draining only donated tokens may remain`);
  }
}

async function tokAudit(seq, startBlock) {
  const { M } = seq;
  const E = env.tok;
  for (const id of M.locks.keys()) await checkTokLock(E, M, id);
  const logs = await p.getLogs({ address: E.hAddr, fromBlock: startBlock + 1, toBlock: "latest" });
  const parsed = logs.map((lg) => { const x = E.iface.parseLog(lg); return { name: x.name, args: normArgs(x.args) }; });
  assert.deepStrictEqual(parsed, M.events.map((x) => ({ name: x.name, args: normArgs(x.args) })), "event log differs from the model");
  for (const tok of E.tokens.filter((x) => x.kind === "fuzz")) {
    const suc = await tok.contract.successes();
    STATS.reentryAttempts += Number(await tok.contract.attempts()); STATS.reentrySuccess += Number(suc);
    assert.strictEqual(suc, 0n, `re-entrant call succeeded from ${tok.name}`);
  }
}

// ============================================================================= deterministic reproductions
// One minimal test per finding / documented behaviour. Each runs on a fresh chain snapshot.
async function sendAs(party, to, data, value = 0n, ts) {
  const t = ts || (await p.getBlock("latest")).timestamp + 1;
  await p.send("evm_setNextBlockTimestamp", [t]);
  await p.send("hardhat_setNextBlockBaseFeePerGas", ["0x0"]);
  let signer, dest, d, v;
  if (party && party.kind === "actor") {
    signer = env.op; dest = party.addr; v = 0n;
    d = ACTOR_IFACE.encodeFunctionData("exec", [to, value, data]);
  } else { signer = party ? party.signer : env.op; dest = to; d = data; v = value; }
  const r = await submit(signer, dest, d, v, false);
  r.name = r.ok ? "ok" : errName(r.data);
  r.ts = t;
  return r;
}
const nowTs = async () => (await p.getBlock("latest")).timestamp;
const setMode = (a, m) => sendAs(null, a.addr, ACTOR_IFACE.encodeFunctionData("setMode", [m]));
const secretPair = (tag) => { const s = "0x" + crypto.createHash("sha256").update("det:" + SEED + ":" + tag).digest("hex"); return { s, h: sha256Raw(s) }; };
const ethNew = (E, party, receiver, amount, h, tl) => sendAs(party, E.hAddr, E.iface.encodeFunctionData("newLock", [h, tl, receiver]), amount);
const ethClaim = (E, party, id, s) => sendAs(party, E.hAddr, E.iface.encodeFunctionData("claim", [id, s]));
const ethRefund = (E, party, id) => sendAs(party, E.hAddr, E.iface.encodeFunctionData("refund", [id]));
const bal = (a) => p.getBalance(a);

describe("fuzz: deterministic reproductions (ETH HTLC)", function () {
  this.timeout(0);
  let snap, E, al, bo, ca, A0, A1, A2;
  before(async () => { await setupEnv(); });
  beforeEach(async () => {
    snap = await p.send("evm_snapshot", []);
    E = env.eth; [al, bo, ca] = E.parties; [A0, A1, A2] = E.actors;
  });
  afterEach(async () => { await p.send("evm_revert", [snap]); });

  it("INFO I-ETH-1 lock id: deterministic, injective over its fields; an identical lock is REFUSED (LockAlreadyExists), even after it was claimed", async () => {
    const t0 = await nowTs();
    const { s, h } = secretPair("id");
    const tl = BigInt(t0 + 100000);
    const id = ethLockId(al.addr, bo.addr, 5n, h, tl);
    assert.strictEqual(await E.htlc.computeLockId(al.addr, bo.addr, 5n, h, tl), id, "JS id == on-chain computeLockId");
    assert.strictEqual((ethers.getBytes(ethers.solidityPacked(["address", "address", "uint256", "bytes32", "uint256"], [al.addr, bo.addr, 5n, h, tl]))).length, 136, "packed encoding is fixed width (20+20+32+32+32): injective");
    assert.strictEqual((await ethNew(E, al, bo.addr, 5n, h, tl)).name, "ok");
    assert.strictEqual((await ethNew(E, al, bo.addr, 5n, h, tl)).name, "LockAlreadyExists");
    assert.strictEqual((await ethClaim(E, ca, id, s)).name, "ok");
    assert.strictEqual((await ethNew(E, al, bo.addr, 5n, h, tl)).name, "LockAlreadyExists", "still refused after the lock was claimed");
    // changing any single field gives a different, creatable lock
    const variants = [
      [al, bo.addr, 6n, h, tl], [al, bo.addr, 5n, h, tl + 1n], [al, ca.addr, 5n, h, tl], [bo, bo.addr, 5n, h, tl], [al, bo.addr, 5n, sha256Raw(s.slice(0, -2) + "00"), tl],
    ];
    const ids = new Set([id]);
    for (const [snd, rcv, amt, hl, t] of variants) {
      assert.strictEqual((await ethNew(E, snd, rcv, amt, hl, t)).name, "ok");
      ids.add(ethLockId(snd.addr, rcv, amt, hl, t));
    }
    assert.strictEqual(ids.size, 1 + variants.length);
    // nobody can create a lock in somebody else's name: the sender is msg.sender (no squatting of ids)
    const g = await E.htlc.getLock(ethLockId(bo.addr, bo.addr, 5n, h, tl));
    assert.strictEqual(lc(g.sender), bo.addr);
  });

  it("boundary: claim allowed at timelock-1, refused at ==timelock; refund refused at timelock-1, allowed at ==timelock", async () => {
    const { s, h } = secretPair("boundary");
    const t0 = await nowTs();
    const tl1 = t0 + 1000;
    const id1 = ethLockId(al.addr, bo.addr, 7n, h, BigInt(tl1));
    await ethNew(E, al, bo.addr, 7n, h, BigInt(tl1));
    assert.strictEqual((await ethRefund(E, al, id1)).name, "TimelockNotExpired");
    const c0 = await sendAs(ca, E.hAddr, E.iface.encodeFunctionData("claim", [id1, s]), 0n, tl1 - 1);
    assert.strictEqual(c0.name, "ok", "claim at ts == timelock-1 must work");
    // lock 2: claim exactly at the timelock fails, refund right after works
    const tl2 = (await nowTs()) + 500;
    const id2 = ethLockId(al.addr, bo.addr, 8n, h, BigInt(tl2));
    await ethNew(E, al, bo.addr, 8n, h, BigInt(tl2));
    assert.strictEqual((await sendAs(ca, E.hAddr, E.iface.encodeFunctionData("claim", [id2, s]), 0n, tl2)).name, "TimelockExpired", "claim at ts == timelock must fail");
    assert.strictEqual((await sendAs(al, E.hAddr, E.iface.encodeFunctionData("refund", [id2]), 0n, tl2 + 1)).name, "ok");
    // lock 3: refund at timelock-1 fails, at ==timelock works
    const tl3 = (await nowTs()) + 500;
    const id3 = ethLockId(al.addr, bo.addr, 9n, h, BigInt(tl3));
    await ethNew(E, al, bo.addr, 9n, h, BigInt(tl3));
    assert.strictEqual((await sendAs(al, E.hAddr, E.iface.encodeFunctionData("refund", [id3]), 0n, tl3 - 1)).name, "TimelockNotExpired");
    assert.strictEqual((await sendAs(al, E.hAddr, E.iface.encodeFunctionData("refund", [id3]), 0n, tl3)).name, "ok", "refund at ts == timelock must work");
  });

  it("INFO I-ETH-3 preimage forms: only exactly the right 32 bytes pays; 31 bytes / empty revert in the ABI decoder; trailing extra bytes are ignored (info)", async () => {
    const { s, h } = secretPair("forms");
    const t0 = await nowTs();
    const tl = BigInt(t0 + 100000);
    const id = ethLockId(al.addr, bo.addr, 3n, h, tl);
    await ethNew(E, al, bo.addr, 3n, h, tl);
    const sel = E.iface.getFunction("claim").selector;
    const send = (data) => sendAs(ca, E.hAddr, data);
    assert.strictEqual((await send(hexcat(sel, id, "0x" + s.slice(2, 64)))).name, "EMPTY", "31 bytes");
    assert.strictEqual((await send(hexcat(sel, id))).name, "EMPTY", "empty");
    assert.strictEqual((await send(hexcat(sel, id, "0x" + "00".repeat(32)))).name, "InvalidPreimage", "zero");
    assert.strictEqual((await send(hexcat(sel, id, "0xab", s))).name, "InvalidPreimage", "33 bytes, secret shifted by one");
    assert.strictEqual((await send(hexcat(sel, id, h))).name, "InvalidPreimage", "the hashlock itself");
    assert.strictEqual((await send(hexcat(sel, id, ethers.keccak256(s)))).name, "InvalidPreimage", "keccak256 of the secret");
    const ok = await send(hexcat(sel, id, s, "0xab"));
    assert.strictEqual(ok.name, "ok", "33 bytes with the right 32 first: accepted (ABI decoding ignores trailing calldata)");
    assert.strictEqual((await E.htlc.getLock(id)).preimage, s);
  });

  it("INFO I-ETH-4 zero preimage: a lock whose secret is 0x00..00 is claimed with getLock().preimage still == 0 (use .claimed, not preimage != 0)", async () => {
    const z = "0x" + "00".repeat(32);
    const h = sha256Raw(z);
    const tl = BigInt((await nowTs()) + 1000);
    const id = ethLockId(al.addr, bo.addr, 3n, h, tl);
    await ethNew(E, al, bo.addr, 3n, h, tl);
    assert.strictEqual((await ethClaim(E, ca, id, z)).name, "ok");
    const l = await E.htlc.getLock(id);
    assert.strictEqual(l.claimed, true);
    assert.strictEqual(l.preimage, ethers.ZeroHash, "indistinguishable from 'unclaimed' by the preimage field alone");
  });

  it("DOCUMENTED F-ETH-2 (eth/README.md): receiver that rejects ETH: claim reverts TransferFailed, lock stays claimable if the receiver recovers, else refundable; the FAILED claim still publishes the preimage in calldata", async () => {
    const { s, h } = secretPair("reject");
    const t0 = await nowTs();
    const tl = BigInt(t0 + 1000);
    await setMode(A0, 1);
    const id = ethLockId(al.addr, A0.addr, 11n, h, tl);
    assert.strictEqual((await ethNew(E, al, A0.addr, 11n, h, tl)).name, "ok");
    const held = await bal(E.hAddr);
    const r = await ethClaim(E, ca, id, s);
    assert.strictEqual(r.name, "TransferFailed");
    const blk = await p.getBlock("latest", true);
    const failed = blk.prefetchedTransactions[0];
    assert.ok(failed.data.toLowerCase().includes(s.slice(2).toLowerCase()), "the reverted claim's calldata contains the preimage: it is public on-chain although the lock is NOT claimed");
    const l = await E.htlc.getLock(id);
    assert.strictEqual(l.claimed, false); assert.strictEqual(l.preimage, ethers.ZeroHash);
    assert.strictEqual(await bal(E.hAddr), held);
    assert.strictEqual((await E.htlc.queryFilter(E.htlc.filters.Claimed(id))).length, 0, "no Claimed event: an event-only watcher does NOT see the preimage");
    // receiver recovers before the timelock: the same lock can still be claimed
    await setMode(A0, 0);
    assert.strictEqual((await ethClaim(E, ca, id, s)).name, "ok");
    assert.strictEqual(await bal(A0.addr), (1000n * 10n ** 18n) + 11n);
    // receiver never recovers: after the timelock the sender refunds
    const { s: s2, h: h2 } = secretPair("reject2");
    const tl2 = BigInt((await nowTs()) + 1000);
    await setMode(A0, 1);
    const id2 = ethLockId(al.addr, A0.addr, 12n, h2, tl2);
    await ethNew(E, al, A0.addr, 12n, h2, tl2);
    assert.strictEqual((await sendAs(ca, E.hAddr, E.iface.encodeFunctionData("claim", [id2, s2]), 0n, Number(tl2) + 1)).name, "TimelockExpired");
    const before = await bal(al.addr);
    assert.strictEqual((await ethRefund(E, al, id2)).name, "ok");
    assert.strictEqual((await bal(al.addr)) - before, 12n);
  });

  it("DOCUMENTED F-ETH-1 (eth/README.md): if the SENDER cannot accept ETH, refund() reverts forever; with a rejecting receiver too the funds are permanently locked", async () => {
    const { s, h } = secretPair("stuck");
    const tl = BigInt((await nowTs()) + 1000);
    await setMode(A0, 1); // receiver rejects
    await setMode(A1, 1); // sender rejects
    const id = ethLockId(A1.addr, A0.addr, 13n, h, tl);
    assert.strictEqual((await ethNew(E, A1, A0.addr, 13n, h, tl)).name, "ok");
    assert.strictEqual((await ethClaim(E, ca, id, s)).name, "TransferFailed");
    const tenYears = Number(tl) + 10 * 365 * 86400;
    assert.strictEqual((await sendAs(A1, E.hAddr, E.iface.encodeFunctionData("refund", [id]), 0n, tenYears)).name, "TransferFailed");
    assert.strictEqual((await sendAs(ca, E.hAddr, E.iface.encodeFunctionData("claim", [id, s]), 0n, tenYears + 1)).name, "TimelockExpired");
    assert.strictEqual(await bal(E.hAddr), 13n, "funds still in the contract after ten years");
    // only recoverable if the sender contract can accept ETH again
    await setMode(A1, 0);
    assert.strictEqual((await ethRefund(E, A1, id)).name, "ok");
    // a rejecting sender alone is enough: the receiver is an ordinary EOA that simply did not claim in time
    const w = secretPair("stuck-2");
    const tl2 = BigInt((await nowTs()) + 1000);
    const id2 = ethLockId(A1.addr, bo.addr, 14n, w.h, tl2);
    assert.strictEqual((await ethNew(E, A1, bo.addr, 14n, w.h, tl2)).name, "ok");
    await setMode(A1, 1);
    assert.strictEqual((await sendAs(A1, E.hAddr, E.iface.encodeFunctionData("refund", [id2]), 0n, Number(tl2) + 5)).name, "TransferFailed");
    assert.strictEqual((await sendAs(bo, E.hAddr, E.iface.encodeFunctionData("claim", [id2, w.s]), 0n, Number(tl2) + 6)).name, "TimelockExpired");
  });

  it("re-entrancy: a receiver / sender that re-enters claim, refund or newLock (same or other lock) changes nothing beyond one payment; effects precede the payment", async () => {
    const x = secretPair("reent-x"), y = secretPair("reent-y");
    const t0 = await nowTs();
    const tlx = BigInt(t0 + 1000), tly = BigInt(t0 + 100000);
    const idx = ethLockId(al.addr, A2.addr, 21n, x.h, tlx);
    const idy = ethLockId(al.addr, bo.addr, 22n, y.h, tly);
    await ethNew(E, al, A2.addr, 21n, x.h, tlx);
    await ethNew(E, al, bo.addr, 22n, y.h, tly);
    await sendAs(null, A2.addr, ACTOR_IFACE.encodeFunctionData("addTarget", [idy, y.s]));
    await sendAs(null, A2.addr, ACTOR_IFACE.encodeFunctionData("addTarget", [idx, x.s]));
    await setMode(A2, 2);
    const a0 = await bal(A2.addr), h0 = await bal(E.hAddr);
    assert.strictEqual((await ethClaim(E, ca, idx, x.s)).name, "ok");
    assert.strictEqual((await bal(A2.addr)) - a0, 21n, "paid exactly once");
    assert.strictEqual(h0 - (await bal(E.hAddr)), 21n);
    assert.strictEqual(await A2.contract.hookRuns(), 1n);
    assert.ok((await A2.contract.attempts()) >= 6n);
    assert.strictEqual(await A2.contract.successes(), 0n, "no re-entrant call succeeded");
    assert.strictEqual((await E.htlc.getLock(idy)).claimed, false, "the other lock is untouched");
    assert.strictEqual(await A2.contract.hookSawClaimed(), true, "while the payment is being made the lock already reads claimed (checks-effects-interactions)");
    assert.strictEqual(await A2.contract.hookSawRefunded(), false);
    // sender-side: re-entering refund
    const z = secretPair("reent-z");
    const tlz = BigInt((await nowTs()) + 50);
    const idz = ethLockId(A2.addr, bo.addr, 23n, z.h, tlz);
    assert.strictEqual((await ethNew(E, A2, bo.addr, 23n, z.h, tlz)).name, "ok");
    await sendAs(null, A2.addr, ACTOR_IFACE.encodeFunctionData("arm", [E.hAddr, false])); // clears targets
    await sendAs(null, A2.addr, ACTOR_IFACE.encodeFunctionData("addTarget", [idz, z.s]));
    const before = await bal(A2.addr);
    assert.strictEqual((await sendAs(A2, E.hAddr, E.iface.encodeFunctionData("refund", [idz]), 0n, Number(tlz) + 1)).name, "ok");
    assert.strictEqual((await bal(A2.addr)) - before, 23n);
    assert.strictEqual(await A2.contract.hookSawRefunded(), true, "refunded flag is already set while the refund is being paid");
    assert.strictEqual(await A2.contract.hookSawClaimed(), false);
    assert.strictEqual(await A2.contract.successes(), 0n);
  });

  it("INFO I-ETH-5 surplus: ETH force-sent into the contract (selfdestruct) is unrecoverable; plain sends revert", async () => {
    const Force = await ethers.getContractFactory("ForceSend");
    const dep = await Force.getDeployTransaction(E.hAddr);
    await p.send("evm_setNextBlockTimestamp", [(await nowTs()) + 1]);
    await p.send("hardhat_setNextBlockBaseFeePerGas", ["0x0"]);
    const r = await submit(env.op, undefined, dep.data, 1000n, true);
    assert.ok(r.ok, "force-send deployment");
    assert.strictEqual(await bal(E.hAddr), 1000n);
    assert.strictEqual((await sendAs(ca, E.hAddr, "0x", 1n)).name, "EMPTY");
    // no function can move it out: a settled lock leaves the surplus where it was
    const { s, h } = secretPair("surplus");
    const tl = BigInt((await nowTs()) + 100);
    const id = ethLockId(al.addr, bo.addr, 5n, h, tl);
    await ethNew(E, al, bo.addr, 5n, h, tl);
    await ethClaim(E, ca, id, s);
    assert.strictEqual(await bal(E.hAddr), 1000n);
  });

  it("extremes: 1 wei, huge amount, timelock = 2^256-1 and now+1", async () => {
    const { s, h } = secretPair("extreme");
    const t0 = await nowTs();
    const big = 5000n * 10n ** 18n;
    assert.strictEqual((await ethNew(E, al, bo.addr, 1n, h, MAXU)).name, "ok");
    assert.strictEqual((await ethNew(E, al, bo.addr, big, h, MAXU)).name, "ok");
    assert.strictEqual((await ethClaim(E, ca, ethLockId(al.addr, bo.addr, big, h, MAXU), s)).name, "ok");
    assert.strictEqual((await ethRefund(E, al, ethLockId(al.addr, bo.addr, 1n, h, MAXU))).name, "TimelockNotExpired");
    const now1 = await nowTs();
    const tight = await sendAs(al, E.hAddr, E.iface.encodeFunctionData("newLock", [h, now1 + 1, bo.addr]), 2n, now1 + 1);
    assert.strictEqual(tight.name, "TimelockNotInFuture", "timelock == the block's own timestamp is refused");
    void t0;
  });

  it("INFO I-ETH-6 gas: bounded for honest receivers; hostile receivers only burn the gas the caller supplies (reported)", async () => {
    const t0 = await nowTs();
    const results = {};
    const claimGas = async (tag, receiver, n) => {
      const { s, h } = secretPair("gas:" + tag + n);
      const tl = BigInt((await nowTs()) + 100000);
      const id = ethLockId(al.addr, receiver, 31n, h, tl);
      await ethNew(E, al, receiver, 31n, h, tl);
      const r = await ethClaim(E, ca, id, s);
      const gas = r.ok ? r.receipt.gasUsed : (await p.getBlock("latest")).gasUsed;
      results[`${tag}`] = { outcome: r.name, gas };
      return { r, gas };
    };
    // honest
    const eoa = await claimGas("eoa", bo.addr);
    assert.strictEqual(eoa.r.name, "ok");
    const acc = await claimGas("contract-accept", A0.addr);
    assert.strictEqual(acc.r.name, "ok");
    assert.ok(eoa.gas < 125_000n && acc.gas < 125_000n, "honest claim gas must stay below 125k");
    // refund
    const { s: s2, h: h2 } = secretPair("gas-refund");
    const tl2 = BigInt((await nowTs()) + 100);
    const id2 = ethLockId(al.addr, bo.addr, 32n, h2, tl2);
    await ethNew(E, al, bo.addr, 32n, h2, tl2);
    const rf = await sendAs(al, E.hAddr, E.iface.encodeFunctionData("refund", [id2]), 0n, Number(tl2) + 1);
    assert.strictEqual(rf.name, "ok");
    assert.ok(rf.receipt.gasUsed < 80_000n, "refund gas must stay below 80k");
    void s2;
    recGas("det.refund.eoa", rf.receipt.gasUsed);
    // hostile: re-entering receiver with 20 stored targets
    for (let i = 0; i < 20; i++) await sendAs(null, A2.addr, ACTOR_IFACE.encodeFunctionData("addTarget", [rng32(i), rng32(i + 100)]));
    await setMode(A2, 2);
    const re = await claimGas("contract-reenter(20 targets)", A2.addr);
    assert.strictEqual(re.r.name, "ok");
    // burn gas
    await setMode(A1, 3);
    const burn = await claimGas("contract-burns-all-gas", A1.addr);
    assert.strictEqual(burn.r.name, "TransferFailed");
    // return bombs
    for (const n of [0, 10_000, 100_000, 500_000]) {
      await setMode(A0, 4);
      await sendAs(null, A0.addr, ACTOR_IFACE.encodeFunctionData("setBombSize", [n]));
      const b = await claimGas(`contract-returns-${n}-bytes`, A0.addr);
      assert.strictEqual(b.r.name, "ok");
      recGas(`det.claim.bomb${n}`, b.gas);
    }
    recGas("det.claim.eoa", eoa.gas); recGas("det.claim.contract-accept", acc.gas); recGas("det.claim.reenter20", re.gas); recGas("det.claim.burn(failed)", burn.gas);
    console.log("    [det gas] " + JSON.stringify(results, (k, v) => (typeof v === "bigint" ? v.toString() : v)));
    void t0;
  });
});

const rng32 = (i) => "0x" + crypto.createHash("sha256").update("r" + i).digest("hex");

describe("fuzz: deterministic reproductions (HTLCERC20)", function () {
  this.timeout(0);
  let snap, E, al, bo, ca, T0, T1, NR, A0;
  before(async () => { await setupEnv(); });
  beforeEach(async () => {
    snap = await p.send("evm_snapshot", []);
    E = env.tok; [al, bo, ca] = E.parties; [T0, T1, NR] = E.tokens; A0 = E.actors[0];
  });
  afterEach(async () => { await p.send("evm_revert", [snap]); });

  const tb = (tok, a) => tok.contract.balanceOf(a);
  const tcall = (party, tok, fn, args) => sendAs(party, tok.addr, TOKEN_IFACE.encodeFunctionData(fn, args));
  const lockT = async (sender, receiver, tok, amount, h, tl, approve = amount) => {
    if (approve !== null) await tcall(sender, tok, "approve", [E.hAddr, approve]);
    const r = await sendAs(sender, E.hAddr, E.iface.encodeFunctionData("newLock", [h, tl, receiver, tok.addr, amount]));
    return { r, id: tokId(sender.addr, receiver, tok.addr, amount, h, BigInt(tl)) };
  };
  const claimT = (party, id, s) => sendAs(party, E.hAddr, E.iface.encodeFunctionData("claim", [id, s]));
  const refundT = (party, id, ts) => sendAs(party, E.hAddr, E.iface.encodeFunctionData("refund", [id]), 0n, ts);
  const mode = (tok, m) => tcall(null, tok, "setMode", [m]);

  it("fee-on-transfer token: rejected at newLock when the fee is non-zero (UnsupportedToken, nothing moves); accepted only when the fee rounds to 0", async () => {
    const { h } = secretPair("fee-in");
    const tl = (await nowTs()) + 1000;
    await mode(T0, 1);
    const b0 = await tb(T0, al.addr);
    const r = await lockT(al, bo.addr, T0, 1000n, h, tl);
    assert.strictEqual(r.r.name, "UnsupportedToken");
    assert.strictEqual(await tb(T0, al.addr), b0, "sender's tokens untouched (whole tx reverted)");
    assert.strictEqual(await tb(T0, E.hAddr), 0n);
    await assert.rejects(E.htlc.getLock(r.id), (e) => errName(e.data) === "LockNotFound");
    const small = await lockT(al, bo.addr, T0, 99n, h, tl + 1);
    assert.strictEqual(small.r.name, "ok", "1% fee on 99 units rounds to 0 -> the contract really received the full amount");
  });

  it("DOCUMENTED F-ERC20-1: a fee charged on the PAYOUT is not detected: the receiver gets less than the lock says, the lock is claimed, no revert", async () => {
    const x = secretPair("fee-out-x"), y = secretPair("fee-out-y");
    const tl = (await nowTs()) + 100000;
    const lx = await lockT(al, bo.addr, T0, 10_000n, x.h, tl);
    const ly = await lockT(al, ca.addr, T0, 10_000n, y.h, tl + 1);
    assert.strictEqual(lx.r.name, "ok"); assert.strictEqual(ly.r.name, "ok");
    await mode(T0, 2); // fee taken out of the amount sent
    const bobBefore = await tb(T0, bo.addr);
    assert.strictEqual((await claimT(ca, lx.id, x.s)).name, "ok");
    assert.strictEqual((await tb(T0, bo.addr)) - bobBefore, 9_900n, "receiver got 99% although the lock says 10_000");
    assert.strictEqual((await E.htlc.getLock(lx.id)).claimed, true);
    assert.strictEqual(await tb(T0, E.hAddr), 10_000n, "the other lock is still fully backed (the fee was taken from the payment itself)");
  });

  it("DOCUMENTED F-ERC20-1 (b): fee-on-top token leaves the contract insolvent for the last lock -> claim AND refund revert", async () => {
    const x = secretPair("top-x"), y = secretPair("top-y");
    const tl = (await nowTs()) + 100000;
    const lx = await lockT(al, bo.addr, T0, 10_000n, x.h, tl);
    const ly = await lockT(al, ca.addr, T0, 10_000n, y.h, tl + 1);
    await mode(T0, 3);
    assert.strictEqual((await claimT(bo, lx.id, x.s)).name, "ok");
    assert.strictEqual(await tb(T0, E.hAddr), 9_900n, "contract paid 10_000 and lost another 100 to the fee");
    assert.strictEqual((await claimT(bo, ly.id, y.s)).name, "ERC20InsufficientBalance", "second lock is no longer fully backed");
    assert.strictEqual((await refundT(al, ly.id, tl + 5)).name, "ERC20InsufficientBalance", "...and the refund fails too");
  });

  it("token whose transfer reverts (pause / contract blacklisted): claim and refund both revert while it lasts; funds are not lost once it ends", async () => {
    const { s, h } = secretPair("revert-out");
    const tl = (await nowTs()) + 1000;
    const l = await lockT(al, bo.addr, T0, 500n, h, tl);
    await mode(T0, 4);
    assert.strictEqual((await claimT(ca, l.id, s)).name, "Error");
    assert.strictEqual((await refundT(al, l.id, tl + 1)).name, "Error");
    assert.strictEqual(await tb(T0, E.hAddr), 500n);
    await mode(T0, 0);
    assert.strictEqual((await refundT(al, l.id)).name, "ok");
  });

  it("DOCUMENTED F-ERC20-3 (header now covers receiver and sender): blacklists: blocked receiver -> claim reverts and the sender refunds; blocked sender -> refund reverts but claim works; both blocked -> stuck until one is unblocked", async () => {
    const a = secretPair("bl-a"), b = secretPair("bl-b"), c = secretPair("bl-c");
    const tl = (await nowTs()) + 1000;
    const block = (who, v) => tcall(null, T0, "setBlocked", [who, v]);
    // (1) receiver blocked
    const la = await lockT(al, bo.addr, T0, 10n, a.h, tl);
    await block(bo.addr, true);
    assert.strictEqual((await claimT(ca, la.id, a.s)).name, "Error");
    assert.strictEqual((await refundT(al, la.id, tl + 10)).name, "ok");
    await block(bo.addr, false);
    // (2) sender blocked: claim still works
    const lb = await lockT(al, bo.addr, T0, 11n, b.h, tl + 5000);
    await block(al.addr, true);
    assert.strictEqual((await claimT(ca, lb.id, b.s)).name, "ok");
    await block(al.addr, false);
    // (3) both blocked
    const lc3 = await lockT(al, bo.addr, T0, 12n, c.h, tl + 6000);
    await block(al.addr, true); await block(bo.addr, true);
    assert.strictEqual((await claimT(ca, lc3.id, c.s)).name, "Error");
    assert.strictEqual((await refundT(al, lc3.id, tl + 7000)).name, "Error");
    await block(al.addr, false);
    assert.strictEqual((await refundT(al, lc3.id)).name, "ok");
  });

  it("token that returns false / lies on transferFrom / reverts: precise error, no state change", async () => {
    const { h } = secretPair("tok-misc");
    const tl = (await nowTs()) + 1000;
    await mode(T0, 7);
    assert.strictEqual((await lockT(al, bo.addr, T0, 5n, h, tl)).r.name, "SafeERC20FailedOperation");
    await mode(T0, 8);
    assert.strictEqual((await lockT(al, bo.addr, T0, 5n, h, tl)).r.name, "UnsupportedToken", "returns true but moved nothing");
    await mode(T0, 5);
    assert.strictEqual((await lockT(al, bo.addr, T0, 5n, h, tl)).r.name, "Error");
    await mode(T0, 0);
    const l = await lockT(al, bo.addr, T0, 5n, h, tl);
    assert.strictEqual(l.r.name, "ok");
    const { s } = secretPair("tok-misc");
    await mode(T0, 6);
    assert.strictEqual((await claimT(ca, l.id, s)).name, "SafeERC20FailedOperation", "transfer returned false");
    await mode(T0, 9);
    assert.strictEqual((await claimT(ca, l.id, s)).name, "ok", "transfer returned true without moving anything");
    assert.strictEqual((await E.htlc.getLock(l.id)).claimed, true);
    assert.strictEqual(await tb(T0, E.hAddr), 5n, "FINDING F-ERC20-1 (c): lock is claimed but the tokens never left the contract");
  });

  it("USDT-style token without return values works end to end; insufficient allowance / balance revert with the token's error", async () => {
    const { s, h } = secretPair("noret");
    const tl = (await nowTs()) + 1000;
    const l = await lockT(al, bo.addr, NR, 77n, h, tl);
    assert.strictEqual(l.r.name, "ok");
    const b0 = await tb(NR, bo.addr);
    assert.strictEqual((await claimT(ca, l.id, s)).name, "ok");
    assert.strictEqual((await tb(NR, bo.addr)) - b0, 77n);
    const l2 = await lockT(al, bo.addr, T1, 5n, h, tl, 4n);
    assert.strictEqual(l2.r.name, "ERC20InsufficientAllowance");
  });

  it("negative rebase / confiscation of the contract's tokens: the last claimer or refunder is left short (documented trust in the token)", async () => {
    const x = secretPair("rb-x"), y = secretPair("rb-y");
    const tl = (await nowTs()) + 1000;
    const lx = await lockT(al, bo.addr, T0, 1000n, x.h, tl);
    const ly = await lockT(al, bo.addr, T0, 1000n, y.h, tl + 1);
    await tcall(null, T0, "burnFrom", [E.hAddr, 500n]);
    assert.strictEqual((await claimT(ca, lx.id, x.s)).name, "ok");
    assert.strictEqual((await claimT(ca, ly.id, y.s)).name, "ERC20InsufficientBalance");
    assert.strictEqual((await refundT(al, ly.id, tl + 5)).name, "ERC20InsufficientBalance");
  });

  it("re-entrant token (hooks in transfer and transferFrom) cannot re-enter claim / refund / newLock", async () => {
    const x = secretPair("rt-x");
    const tl = (await nowTs()) + 1000;
    await mode(T0, 10);
    const l = await lockT(al, bo.addr, T0, 100n, x.h, tl);
    assert.strictEqual(l.r.name, "ok");
    await tcall(null, T0, "addTarget", [l.id, x.s]);
    const b0 = await tb(T0, bo.addr);
    assert.strictEqual((await claimT(ca, l.id, x.s)).name, "ok");
    assert.strictEqual((await tb(T0, bo.addr)) - b0, 100n, "paid once");
    assert.strictEqual(await T0.contract.successes(), 0n);
    assert.ok((await T0.contract.attempts()) >= 3n);
  });

  it("REGRESSION F-ERC20-2 (fixed): receiver == the HTLC contract itself is refused (InvalidReceiver) and nothing moves; the ETH variant is harmless (claim reverts, sender refunds)", async () => {
    const { s, h } = secretPair("self-receiver");
    const tl = (await nowTs()) + 1000;
    const b0 = await tb(T0, al.addr);
    const l = await lockT(al, E.hAddr, T0, 250n, h, tl);
    assert.strictEqual(l.r.name, "InvalidReceiver", "newLock must refuse receiver == address(this)");
    assert.strictEqual(await tb(T0, al.addr), b0, "sender's tokens untouched");
    assert.strictEqual(await tb(T0, E.hAddr), 0n);
    await assert.rejects(E.htlc.getLock(l.id), (e) => errName(e.data) === "LockNotFound");
    // the order of the argument checks: zero receiver first, then this contract
    assert.strictEqual((await lockT(al, ZERO, T0, 250n, h, tl)).r.name, "ZeroReceiver");
    // a normal lock is unaffected
    const ok = await lockT(al, bo.addr, T0, 250n, h, tl);
    assert.strictEqual(ok.r.name, "ok");
    assert.strictEqual((await claimT(ca, ok.id, s)).name, "ok");
    // the ETH contract: receiver == itself reverts at claim (no receive function), the sender refunds
    const EE = env.eth;
    const e = secretPair("self-receiver-eth");
    const tle = BigInt((await nowTs()) + 1000);
    const ide = ethLockId(al.addr, EE.hAddr, 9n, e.h, tle);
    assert.strictEqual((await ethNew(EE, al, EE.hAddr, 9n, e.h, tle)).name, "ok");
    assert.strictEqual((await ethClaim(EE, ca, ide, e.s)).name, "TransferFailed");
    assert.strictEqual((await sendAs(al, EE.hAddr, EE.iface.encodeFunctionData("refund", [ide]), 0n, Number(tle) + 1)).name, "ok");
  });

  it("token address that is an EOA, the HTLC itself, or has no balanceOf: newLock reverts, nothing is stored", async () => {
    const { h } = secretPair("badtok");
    const tl = (await nowTs()) + 1000;
    for (const bad of [bo.addr, E.hAddr, E.actors[1].addr]) {
      const r = await sendAs(al, E.hAddr, E.iface.encodeFunctionData("newLock", [h, tl, ca.addr, bad, 5n]));
      assert.ok(!r.ok, `newLock with token ${bad} must revert`);
    }
  });
});

// ============================================================================= mocha
function report() {
  const secs = ((Date.now() - STATS.startedAt) / 1000).toFixed(1);
  console.log(`\n=== FUZZ SUMMARY seed="${SEED}" N=${N}`);
  console.log(`sequences: eth=${STATS.seqEth} erc20=${STATS.seqTok}; transactions: eth=${STATS.txEth} erc20=${STATS.txTok}; elapsed ${secs}s`);
  console.log(`re-entry attempts by hostile receivers/tokens: ${STATS.reentryAttempts}, successful: ${STATS.reentrySuccess}; receive() hook runs: ${STATS.hooksRun}`);
  console.log("gas (max / avg / n) by category:");
  for (const k of Object.keys(STATS.gas).sort()) { const g = STATS.gas[k]; console.log(`  ${k.padEnd(44)} ${String(g.max).padStart(8)} ${String(g.sum / BigInt(g.n)).padStart(8)} ${g.n}`); }
  console.log("outcomes:");
  for (const k of Object.keys(STATS.outcomes).sort()) console.log(`  ${k.padEnd(60)} ${STATS.outcomes[k]}`);
  console.log("boundary coverage:", JSON.stringify(STATS.cover));
  console.log("erc20 taint reasons (sequences):", JSON.stringify(STATS.taint));
  console.log("erc20 sequences ending below sum(open) (insolvent):", JSON.stringify(STATS.insolventSeq));
  console.log("erc20 locks the drain could not refund:", JSON.stringify(STATS.stuck));
}

describe("fuzz campaign", function () {
  this.timeout(0);

  before(async () => {
    console.log(`\n[fuzz] seed="${SEED}" N=${N} maxSteps=${MAXSTEPS}${ONLY !== null ? ` only=${ONLY}/${ONLY_KIND}` : ""}`);
    await setupEnv();
  });

  after(report);

  if (ONLY !== null) {
    it(`reproduce ${ONLY_KIND} sequence ${ONLY}`, async () => { await (ONLY_KIND === "tok" ? tokSequence(ONLY) : ethSequence(ONLY)); });
    return;
  }

  for (let c = 0; c < N && MUT_T === null; c += CHUNK) {
    const hi = Math.min(N, c + CHUNK);
    it(`HTLC (ETH): random sequences ${c}..${hi - 1}`, async () => {
      if (c > 0) await freshChain();
      for (let i = c; i < hi; i++) await ethSequence(START + i);
      if (process.env.FUZZ_MEM) console.log(`      rss=${(process.memoryUsage().rss / 1048576) | 0} MB`);
    });
  }
  for (let c = 0; c < N && MUT === null; c += CHUNK) {
    const hi = Math.min(N, c + CHUNK);
    it(`HTLCERC20: random sequences ${c}..${hi - 1}`, async () => {
      await freshChain();
      for (let i = c; i < hi; i++) await tokSequence(START + i);
      if (process.env.FUZZ_MEM) console.log(`      rss=${(process.memoryUsage().rss / 1048576) | 0} MB`);
    });
  }
});

module.exports = { Rng };
