"use strict";
// Harness for the handover tests. Not a test file (the glob is *.test.js).
//
//  - addresses: valid Parano1d (bech32m, made here by a tiny encoder) and Ethereum addresses.
//  - signatures: a FAKE personal-message scheme (a hash of the text and the address), only so the state machine's use of verify() can be tested. The real
//    Ethereum signing and verification are `live.js sign-message` and `verify-message` (another step); nothing in lib/board signs for Ethereum.
//  - Pair: two Handover machines joined by a synchronous wire with fake helpers, a clock, and hooks to tamper with, drop, hold or duplicate any message.
//  - Net: the same two machines through the real giftwrap and relay client on the fake relays (see board-handover.test.js).

const crypto = require("crypto");
const N = require("../lib/board/note");
const O = require("../lib/board/offer");
const { Handover, ACTIONS } = require("../lib/board/handover");
const priv = require("../lib/board/privboard");

// ---------------------------------------------------------------------------------------------- addresses
const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
function polymod(values) {
  const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const v of values) {
    const top = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((top >>> i) & 1) chk ^= GEN[i];
  }
  return chk >>> 0;
}
function noidAddress(seed) {
  const bytes = crypto.createHash("sha256").update("addr:" + seed).digest();
  const data = [];
  let acc = 0;
  let bits = 0;
  for (const b of bytes) {
    acc = (acc << 8) | b;
    bits += 8;
    while (bits >= 5) {
      data.push((acc >> (bits - 5)) & 31);
      bits -= 5;
    }
    acc &= (1 << bits) - 1;
  }
  if (bits > 0) data.push((acc << (5 - bits)) & 31);
  const hrp = [..."o"].map((c) => c.charCodeAt(0) >> 5).concat([0], [..."o"].map((c) => c.charCodeAt(0) & 31));
  const mod = polymod(hrp.concat(data, [0, 0, 0, 0, 0, 0])) ^ 0x2bc830a3;
  const check = [0, 1, 2, 3, 4, 5].map((i) => (mod >>> (5 * (5 - i))) & 31);
  return "o1" + data.concat(check).map((v) => CHARSET[v]).join("");
}
const ethAddress = (seed) => "0x" + crypto.createHash("sha256").update("eth:" + seed).digest("hex").slice(0, 40);

const ADDR = {
  aliceNoidPayout: noidAddress("alice payout"),
  aliceEthPayout: ethAddress("alice payout"),
  aliceNoid: noidAddress("alice wallet"),
  aliceEth: ethAddress("alice wallet"),
  bobNoid: noidAddress("bob receive"),
  bobEth: ethAddress("bob wallet"),
};

// ---------------------------------------------------------------------------------------------- a fake personal-message scheme
const fakeSign = (text, address) => "0x" + crypto.createHash("sha256").update("a|" + text + "|" + address.toLowerCase()).digest("hex") + crypto.createHash("sha256").update("b|" + text + "|" + address.toLowerCase()).digest("hex") + "1b";
const fakeVerify = (text, sig, address) => typeof sig === "string" && sig === fakeSign(text, address);

// ---------------------------------------------------------------------------------------------- the pair
const HTLC = "0x" + "ab".repeat(20);
const NOW = 1800000000;
const policy = O.makePolicy({ pinnedHtlc: { 11155111: HTLC }, minPowBits: 0 });
const TERMS = { side: "sell-noid", noid: "5000000", wei: "1000000000000000", chain: "11155111", profile: "sepolia", htlc: HTLC, lock: "poseidon", variant: "raw", cv: "1", relays: ["wss://a.relays.net", "wss://b.relays.org"] };

const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");

/** The offer as the board shows it (made and parsed with the real offer code). */
function makeOffer(side, { board } = {}) {
  const secret = N.generateSecretKey();
  const terms = { ...TERMS, side };
  const ev = O.buildOffer({ secret, policy, now: NOW, terms, board });
  const offer = O.parseOffer(ev, { policy, now: NOW + 1, board }).offer;
  return { secret, ev, offer };
}

class Node {
  constructor(pair, role, maker, key, cfgExtra) {
    this.pair = pair;
    this.role = role;
    this.maker = maker;
    this.secret = key;
    this.pub = N.getPublicKey(key);
    this.log = []; // [{ action, args }]
    this.sent = []; // [{ type, seq, content }]
    this.notes = [];
    this.stops = [];
    this.manual = new Set();
    this.bundleWritten = [];
    this.prepared = [];
    this.checks = [];
    this.m = new Handover(
      {
        role,
        maker,
        offer: pair.offer,
        ourKey: this.pub,
        verify: pair.verify,
        own: role === "alice" ? { noidPayout: ADDR.aliceNoidPayout, ethPayout: ADDR.aliceEthPayout } : { bobNoid: ADDR.bobNoid },
        hcLeadMax: 60,
        ...cfgExtra,
      },
    );
  }

  /** Takes the output of a machine call: queues its messages, records and answers its actions. */
  take(out) {
    const q = this.pair.queue;
    for (const s of out.send) {
      this.sent.push(s);
      q.push(() => this.pair.deliverSend(this, s));
    }
    for (const n of out.notes) this.notes.push(n);
    if (out.stopped) this.stops.push(out.stopped);
    for (const a of out.actions) {
      this.log.push(a);
      if (!ACTIONS.includes(a.action)) throw new Error("unknown action " + a.action);
      if (!this.manual.has(a.action)) q.push(() => this.help(a));
    }
    return out;
  }

  /** The fake helpers. */
  help(a) {
    const p = this.pair;
    const at = p.clock;
    switch (a.action) {
      case "wallet_setup":
        return this.take(this.m.helperResult(`wallet_setup_${a.args.role}`, a.args.role === "bob" ? { bob_eth: ADDR.bobEth } : { alice_noid: ADDR.aliceNoid, alice_eth: ADDR.aliceEth }, at));
      case "sign_message":
        return this.take(this.m.helperResult("sign_message", { purpose: a.args.purpose, signature: p.sign(a.args.text, this.role === "bob" ? ADDR.bobEth : ADDR.aliceEth) }, at));
      case "prepare_alice": {
        this.prepared.push(a.args);
        const text = JSON.stringify({ params: { h_create: p.tip + p.lead, bob_noid: a.args.bob_noid, eth: { bob_sender: a.args.bob_eth } } });
        return this.take(this.m.helperResult("prepare_alice", { bundle_text: p.bundleText ? p.bundleText(text) : text, digest: sha(p.bundleText ? p.bundleText(text) : text) }, at));
      }
      case "write_bundle_file":
        this.bundleWritten.push(a.args.text);
        return undefined;
      case "join_bob":
        return this.take(this.m.helperResult("join_bob", p.joinResult ? p.joinResult(this.bundleWritten[this.bundleWritten.length - 1]) : { exit_code: 0, digest: sha(this.bundleWritten[this.bundleWritten.length - 1]) }, at));
      case "read_tip":
        return this.take(this.m.fact("tip", p.tip, at));
      case "record_handover_check":
        this.checks.push(a.args);
        return undefined;
      default:
        return undefined;
    }
  }
}

class Pair {
  /**
   * @param {object} o
   * @param {"alice"|"bob"} [o.makerRole] who posted the offer (default alice: a sell-noid offer)
   * @param {object} [o.limits] @param {object} [o.board] private board @param {boolean} [o.noTip]
   */
  constructor(o = {}) {
    this.clock = NOW + 100;
    this.tip = 5000;
    this.lead = 30;
    this.queue = [];
    this.verify = o.verify || fakeVerify;
    this.sign = fakeSign;
    this.tamper = null; // (from, send) => content string | null (drop) | undefined (unchanged)
    this.duplicate = 0;
    this.makerRole = o.makerRole || "alice";
    const side = this.makerRole === "alice" ? "sell-noid" : "buy-noid";
    const made = makeOffer(side, { board: o.board });
    this.offer = made.offer;
    this.offerEv = made.ev;
    const takerKey = N.generateSecretKey();
    const makerExtra = o.board ? { requireTakeProof: true, verifyTakeProof: (id, take, proof) => priv.verifyTakeProof(o.board.inviteSecret, id, take, proof) } : {};
    const takerExtra = o.board ? { takeProof: undefined } : {};
    const limits = o.limits;
    const makerNode = new Node(this, this.makerRole, true, made.secret, { limits, ...makerExtra });
    const takerPub = N.getPublicKey(takerKey);
    if (o.board) takerExtra.takeProof = priv.takeProof(o.board.inviteSecret, this.offer.id, takerPub);
    const takerNode = new Node(this, this.makerRole === "alice" ? "bob" : "alice", false, takerKey, { limits, ...takerExtra });
    this.maker = makerNode;
    this.taker = takerNode;
    this.alice = this.makerRole === "alice" ? makerNode : takerNode;
    this.bob = this.makerRole === "alice" ? takerNode : makerNode;
    this.nodes = [makerNode, takerNode];
    this.pending = []; // held messages
    this.hold = false;
  }

  other(n) {
    return n === this.maker ? this.taker : this.maker;
  }

  deliverSend(from, s) {
    let content = s.content;
    if (this.tamper) {
      const r = this.tamper(from, s);
      if (r === null) return;
      if (typeof r === "string") content = r;
    }
    const to = this.nodes.find((n) => n.pub === s.to);
    if (!to) return;
    const go = () => {
      for (let i = 0; i <= this.duplicate; i++) to.take(to.m.receive({ from: from.pub, content, at: this.clock }));
    };
    if (this.hold) this.pending.push(go);
    else go();
  }

  /** Delivers held messages (optionally newest first) and runs what follows. */
  release({ reverse = false } = {}) {
    const list = reverse ? [...this.pending].reverse() : this.pending;
    this.pending = [];
    this.hold = false;
    for (const f of list) f();
    this.pump();
  }

  pump(max = 500) {
    let n = 0;
    while (this.queue.length) {
      if (++n > max) throw new Error("the pump did not settle");
      this.queue.shift()();
    }
  }

  /** Sets nothing_funded on both, starts both, runs to rest. */
  begin({ nothingFunded = true } = {}) {
    for (const n of this.nodes) n.take(n.m.fact("nothing_funded", nothingFunded, this.clock));
    for (const n of [this.maker, this.taker]) n.take(n.m.start(this.clock));
    this.pump();
    return this;
  }

  /** Bob's deposit is covered and his approval in force. */
  bobReady() {
    this.bob.take(this.bob.m.fact("bob_deposit_covered", true, this.clock));
    this.bob.take(this.bob.m.fact("bob_approval_in_force", true, this.clock));
    this.pump();
  }

  advance(s) {
    this.clock += s;
  }

  /** A message as `from` would send it, built by hand (for faults a real machine would not produce). */
  forge(from, type, body, seq, over = {}) {
    return JSON.stringify({ v: 1, swap: this.swapId(), taker: this.taker.pub, seq, type, body, ...over });
  }

  swapId() {
    return this.offer.id;
  }

  /** Delivers a hand-made content to a node as if from `from`. */
  inject(from, to, content) {
    const out = to.take(to.m.receive({ from: from.pub, content, at: this.clock }));
    this.pump();
    return out;
  }
}

const allActions = (pair) => pair.nodes.flatMap((n) => n.log.map((a) => a.action));

module.exports = { ADDR, noidAddress, ethAddress, fakeSign, fakeVerify, Pair, Node, makeOffer, policy, HTLC, NOW, TERMS, sha, allActions };
