"use strict";
/*
 * The handover state machine (piece 3, section 2.3 with the amendments A to F and H of section 10). PURE: no file, process, clock or network access.
 * It takes messages, facts and results of helper steps IN, and returns messages to send and NAMED helper actions to request. The host (a later step)
 * wraps and sends the messages (lib/board/giftwrap.js, lib/board/relay.js) and runs each named action through the console's own action table.
 *
 * Rules the code keeps (each has a test in test/board-handover.test.js):
 *  - A message is DATA. Nothing in a message selects a helper, a path, a flag, an amount or a term; an action's arguments are only the values below, each
 *    validated first. Where this file is silent, the answer is to refuse.
 *  - Only two values from a message ever reach a shell file: BOB_NOID and BOB_ETH (amendment C), each checked with the terms form's own patterns
 *    (lib/walletrun.js: bech32m with checksum; 0x + 40 hex with the checksum of mixed case) and REJECTED, never cleaned. Refused too: BOB_ETH equal to
 *    ALICE_ETH, the ETH payout or the contract; BOB_NOID equal to ALICE_NOID or the NOID payout.
 *  - Bob's two answers (addresses, checked) carry an Ethereum personal-message signature of the key that will lock (amendment D). This file does not
 *    sign or verify Ethereum signatures: it is given `verify(text, signature, address) -> true` and refuses without a function, or with any answer but `true`.
 *    The texts that are signed are `signingText()` below.
 *  - Amendment B: Bob refuses a bundle whose h_create is outside [tip - hcBehind, tip + hcLeadMax], the tip being a FACT from his own node.
 *  - Amendment E: there is no "prepare again". A second, different bundle is an equivocation.
 *  - Amendment F: a cancel, a refusal, a violation or a missed time limit only STOPS THE BOARD for this swap and revokes approvals for spends that have not
 *    started. The result of stop() says `endsSwap: false, keepWatching: true, keepRecovery: true` and this file has no action that stops the watch loop,
 *    the autopilot's recovery or the sweeps, or marks a file ended. Whether anything was funded is a FACT given in (`nothing_funded`: true, false or "unknown");
 *    only `true` lets a violation end the BOARD side of the swap; with anything else the message is shown and ignored.
 *  - Amendment H: the taker names the exact offer note; the maker accepts a version whose terms equal the current ones. A bundle is handed to the host to
 *    be written ONCE (`write_bundle_file`, once:true), to a path the host chooses.
 *
 * Message envelope (the content of the rumor): { v: 1, swap: <offer note id taken>, taker: <take key>, seq, type, body }, exact keys, exact body keys.
 * `seq` counts the messages of ONE sender, from 1, in the order below; `cancel` may take any later number (it only stops the board, so it is honoured
 * even when earlier messages were withheld).
 *
 *   taker -> maker  take(1)                       maker -> taker  accept | decline (1)
 *   Bob   -> Alice  bob_addresses, then checked | refused
 *   Alice -> Bob    bundle, then funded
 *   either          cancel (any time), done (after the first message)
 *
 * Differences from the design text, on purpose: `accept` carries no body (a time limit sent in a message would be a message setting a term; the limits are
 * constants here); `refused` and `cancel` carry short codes from fixed lists, not free text (a text from the other side would be shown to a person).
 */

const { isHex64 } = require("./note");
const { ethAddressProblem, noidAddressProblem } = require("../walletrun");

const VERSION = 1;
const MAX_CONTENT_CHARS = 60000;
const MAX_BUNDLE_CHARS = 40000;
const MAX_PENDING = 8;
const MAX_HELD_BYTES = 128 * 1024;
const MAX_SEQ = 64;
const MAX_DECLINES = 16;
const SIG_RE = /^0x[0-9a-fA-F]{130}$/;
const TXID_RE = /^(0x)?[0-9a-fA-F]{64}$/;

const DEFAULT_LIMITS = Object.freeze({
  acceptS: 120, // the maker answers a take
  addressesS: 300, // Bob makes his wallet and signs
  bundleS: 600, // Alice makes her wallet and prepares
  helperS: 600, // any one helper step of our own
  depositWindowS: 1800, // after the join: both deposit (amendment A: the board's lead, about 30 minutes)
  checkedSlackS: 300,
});

const CANCEL_CODES = ["user", "time", "helper", "bad_addresses", "digest", "bad_message", "busy", "other"];
const REFUSED_CODES = ["h_create", "bundle", "join", "digest"];
const DECLINE_REASONS = ["busy", "version", "proof", "closed"];
const DONE_PHASES = ["settled", "refunded", "recovered", "aborted"];

const TYPES = {
  take: { req: ["offer"], opt: ["proof"] },
  accept: { req: [], opt: [] },
  decline: { req: ["reason"], opt: [] },
  bob_addresses: { req: ["bob_noid", "bob_sender", "sig"], opt: [] },
  bundle: { req: ["bundle", "digest"], opt: [] },
  checked: { req: ["digest", "sig"], opt: [] },
  refused: { req: ["code", "exit"], opt: [] },
  funded: { req: ["txid"], opt: [] },
  cancel: { req: ["code"], opt: [] },
  done: { req: ["phase"], opt: [] },
};

/** The helper actions this machine can request. Nothing else, and none that ends a swap, stops the watch loop or a sweep, or sends a coin. */
const ACTIONS = Object.freeze(["start_run_folder", "republish_offer_taken", "wallet_setup", "sign_message", "prepare_alice", "write_bundle_file", "join_bob", "record_handover_check", "read_tip", "board_stop", "revoke_unstarted_spends", "release_board"]);

const bodyProblem = {
  take: (b) => (!isHex64(b.offer) ? "offer id" : b.proof !== undefined && !isHex64(b.proof) ? "proof" : null),
  accept: () => null,
  decline: (b) => (DECLINE_REASONS.includes(b.reason) ? null : "reason"),
  bob_addresses: (b) => {
    if (noidAddressProblem(b.bob_noid)) return "bob_noid";
    if (ethAddressProblem(b.bob_sender)) return "bob_sender";
    return typeof b.sig === "string" && SIG_RE.test(b.sig) ? null : "sig";
  },
  bundle: (b) => (typeof b.bundle !== "string" || b.bundle.length < 2 || b.bundle.length > MAX_BUNDLE_CHARS ? "bundle size" : !/^[0-9a-f]{64}$/.test(b.digest) ? "digest" : null),
  checked: (b) => (!/^[0-9a-f]{64}$/.test(b.digest) ? "digest" : typeof b.sig !== "string" || !SIG_RE.test(b.sig) ? "sig" : null),
  refused: (b) => (!REFUSED_CODES.includes(b.code) ? "code" : b.exit !== null && !(Number.isInteger(b.exit) && b.exit >= 0 && b.exit <= 255) ? "exit" : null),
  funded: (b) => (typeof b.txid === "string" && TXID_RE.test(b.txid) ? null : "txid"),
  cancel: (b) => (CANCEL_CODES.includes(b.code) ? null : "code"),
  done: (b) => (DONE_PHASES.includes(b.phase) ? null : "phase"),
};

/** The text a personal-message signature covers (amendment D): the domain line, the offer note id, the take key, then the tuple. */
function signingText(purpose, t) {
  if (purpose === "addresses") return ["no1d-swap-v1 addresses", t.offer, t.take, t.bob_noid, t.bob_sender].join("\n");
  if (purpose === "checked") return ["no1d-swap-v1 checked", t.offer, t.take, t.digest].join("\n");
  throw new Error("unknown signing purpose");
}

function canon(v) {
  if (Array.isArray(v)) return "[" + v.map(canon).join(",") + "]";
  if (v && typeof v === "object") return "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + canon(v[k])).join(",") + "}";
  return JSON.stringify(v);
}

/** Parses the content of a rumor into a message, or says why not. Strict: exact keys, exact body keys, values by type. */
function parseMessage(content) {
  const bad = (reason) => ({ ok: false, reason });
  if (typeof content !== "string" || content.length > MAX_CONTENT_CHARS) return bad("size");
  let m;
  try {
    m = JSON.parse(content);
  } catch {
    return bad("not JSON");
  }
  if (!m || typeof m !== "object" || Array.isArray(m)) return bad("not an object");
  const keys = Object.keys(m).sort().join(",");
  if (keys !== "body,seq,swap,taker,type,v") return bad("keys");
  if (m.v !== VERSION) return bad("version");
  if (!isHex64(m.swap) || !isHex64(m.taker)) return bad("ids");
  if (!Number.isInteger(m.seq) || m.seq < 1 || m.seq > MAX_SEQ) return bad("seq");
  const spec = TYPES[m.type];
  if (!spec) return bad("type");
  if (!m.body || typeof m.body !== "object" || Array.isArray(m.body)) return bad("body");
  const bk = Object.keys(m.body);
  if (!spec.req.every((k) => bk.includes(k)) || !bk.every((k) => spec.req.includes(k) || spec.opt.includes(k))) return bad("body keys");
  const why = bodyProblem[m.type](m.body);
  if (why) return bad("body: " + why);
  return { ok: true, msg: m };
}

const lc = (s) => String(s).toLowerCase();

const planFor = (senderMaker, senderRole) => [senderMaker ? ["accept", "decline"] : ["take"], senderRole === "bob" ? ["bob_addresses"] : ["bundle"], senderRole === "bob" ? ["checked", "refused"] : ["funded"]];
const heldBytes = (pending) => Object.values(pending).reduce((n, h) => n + (h && typeof h.canon === "string" ? h.canon.length : 0), 0);
function typeAllowedAt(plan, seq, type) {
  if (type === "cancel") return true;
  if (seq <= plan.length) return plan[seq - 1].includes(type) || (type === "done" && seq >= 2);
  return type === "done";
}

const newOut = () => ({ send: [], actions: [], notes: [], stopped: null });

class Handover {
  /**
   * @param {object} cfg
   * @param {"alice"|"bob"} cfg.role
   * @param {boolean} cfg.maker true when this app posted the offer
   * @param {{id:string, pubkey:string, termsKey:string, terms:object}} cfg.offer the offer note this app knows (the maker: its newest version; the taker: the one picked)
   * @param {string} cfg.ourKey the messaging key: the offer key (maker) or the take key (taker)
   * @param {(text:string, signature:string, address:string)=>boolean} cfg.verify Ethereum personal-message verification (amendment D); required
   * @param {{bobNoid?:string, noidPayout?:string, ethPayout?:string}} cfg.own this app's own addresses (Bob: the NOID address he receives on; Alice: her payouts)
   * @param {number} [cfg.hcLeadMax] Bob: the largest h_create lead accepted (the board's lead plus a margin); required for Bob
   * @param {number} [cfg.hcBehind] default 5
   * @param {object} [cfg.limits]
   * @param {boolean} [cfg.requireTakeProof] maker on a private board
   * @param {(offerId:string, takeKey:string, proof:string)=>boolean} [cfg.verifyTakeProof]
   * @param {string} [cfg.takeProof] taker on a private board: the proof to put in the take
   * @param {object} [state] a snapshot() to continue from
   */
  constructor(cfg, state = null) {
    if (!cfg || (cfg.role !== "alice" && cfg.role !== "bob")) throw new Error("role");
    if (typeof cfg.verify !== "function") throw new Error("a signature verifier is required: nothing is accepted without one");
    if (!cfg.offer || !isHex64(cfg.offer.id) || !isHex64(cfg.offer.pubkey) || typeof cfg.offer.termsKey !== "string") throw new Error("offer");
    if (!isHex64(cfg.ourKey)) throw new Error("ourKey");
    if (cfg.maker && cfg.ourKey !== cfg.offer.pubkey) throw new Error("the maker's key is the offer's key");
    if (!cfg.maker && cfg.ourKey === cfg.offer.pubkey) throw new Error("a taker uses a key of its own");
    if (cfg.role === "bob") {
      if (noidAddressProblem(cfg.own && cfg.own.bobNoid)) throw new Error("Bob's own NOID address is missing or invalid");
      if (!Number.isSafeInteger(cfg.hcLeadMax) || cfg.hcLeadMax < 0) throw new Error("hcLeadMax");
    } else {
      if (noidAddressProblem(cfg.own && cfg.own.noidPayout) || ethAddressProblem(cfg.own && cfg.own.ethPayout)) throw new Error("Alice's own payout addresses are missing or invalid");
    }
    if (cfg.maker && cfg.requireTakeProof && typeof cfg.verifyTakeProof !== "function") throw new Error("a private board needs verifyTakeProof");
    this.cfg = { hcBehind: 5, ...cfg, limits: { ...DEFAULT_LIMITS, ...(cfg.limits || {}) } };
    for (const [k, v] of Object.entries(this.cfg.limits)) if (!(Number.isInteger(v) && v > 0 && v <= 86400)) throw new Error("limit " + k);
    this.s = state
      ? JSON.parse(JSON.stringify(state))
      : {
          phase: "idle",
          since: 0,
          swapId: cfg.maker ? null : cfg.offer.id,
          takeKey: cfg.maker ? null : cfg.ourKey,
          peerKey: cfg.maker ? null : cfg.offer.pubkey,
          versions: { [cfg.offer.id]: cfg.offer.termsKey },
          currentTermsKey: cfg.offer.termsKey,
          offerOpen: true,
          seqOut: 0,
          expected: 1,
          accepted: {},
          pending: {},
          declined: [],
          sent: [],
          bob: null, // { noid, eth } as Alice learned them, or Bob's own
          aliceWallet: null,
          bundle: null, // { text, digest, hCreate } as Bob received it, or Alice's own
          written: false,
          signed: null,
          facts: { tip: null, nothingFunded: "unknown", bobDepositCovered: false, bobApprovalInForce: false },
          stopped: null,
          finished: false,
          peerDone: false,
        };
  }

  snapshot() {
    return JSON.parse(JSON.stringify(this.s));
  }

  /** Puts a snapshot() back (the host does it when the state of a message could not be saved: the message is then not acted on). */
  rollbackTo(state) {
    this.s = JSON.parse(JSON.stringify(state));
  }

  get phase() {
    return this.s.phase;
  }

  get stopped() {
    return this.s.stopped;
  }

  // ------------------------------------------------------------------------------------------------ plumbing
  go(phase, at) {
    this.s.phase = phase;
    this.s.since = at;
  }

  act(out, action, args = {}) {
    if (!ACTIONS.includes(action)) throw new Error("unknown action " + action);
    out.actions.push({ action, args });
  }

  emit(out, type, body) {
    if (!this.s.peerKey) throw new Error("no peer yet");
    const seq = ++this.s.seqOut;
    const content = JSON.stringify({ v: VERSION, swap: this.s.swapId, taker: this.s.takeKey, seq, type, body });
    if (content.length > MAX_CONTENT_CHARS) throw new Error("message too large");
    this.s.sent.push(type);
    out.send.push({ to: this.s.peerKey, type, seq, content });
  }

  /** Stops the BOARD for this swap (amendment F). Never ends the swap, never stops the watch loop, recovery or sweeps. */
  stop(out, reason, at, { cancel = null } = {}) {
    if (this.s.stopped) return;
    if (cancel && this.s.peerKey && !this.s.sent.includes("cancel")) this.emit(out, "cancel", { code: cancel });
    const nf = this.s.facts.nothingFunded;
    this.s.stopped = { reason, at, nothingFunded: nf };
    this.s.phase = "stopped";
    this.act(out, "board_stop", { reason });
    this.act(out, "revoke_unstarted_spends", {});
    out.stopped = { reason, nothingFunded: nf, endsSwap: false, keepWatching: true, keepRecovery: true };
    out.notes.push(nf === true ? `board stopped before any funding: ${reason}` : `board stopped (${reason}); something may be funded: the chains decide, refunds and recovery run as usual`);
  }

  /**
   * A message that breaks the rules. With nothing funded the board stops; otherwise it is shown and ignored (section 2.3).
   */
  violation(out, why, at, cancel = "bad_message") {
    if (this.s.facts.nothingFunded === true) return this.stop(out, why, at, { cancel });
    out.notes.push(`ignored: ${why}`);
    return undefined;
  }

  // ------------------------------------------------------------------------------------------------ inputs
  /** Starts the machine. A taker sends its take; a maker waits. */
  start(at) {
    const out = newOut();
    if (this.s.phase !== "idle") return out;
    if (this.cfg.maker) this.go("open", at);
    else {
      this.go("taking", at);
      this.emit(out, "take", { offer: this.s.swapId, ...(this.cfg.takeProof ? { proof: this.cfg.takeProof } : {}) });
    }
    return out;
  }

  /** The maker tells the machine that its offer changed (a new note id with equal terms, or a withdrawal). */
  offerVersion(id, termsKey, at) {
    void at;
    if (!this.cfg.maker || !isHex64(id)) return newOut();
    this.s.versions[id] = termsKey;
    this.s.currentTermsKey = termsKey;
    return newOut();
  }

  offerClosed() {
    this.s.offerOpen = false;
    return newOut();
  }

  /** Facts about the world, from the host: tip, nothing_funded, bob_deposit_covered, bob_approval_in_force, funding_sent. */
  fact(name, value, at) {
    const out = newOut();
    const f = this.s.facts;
    if (name === "tip") {
      if (!Number.isSafeInteger(value) || value < 0) return out;
      f.tip = value;
      if (this.s.phase === "bundle_wait_tip" && !this.s.stopped) this.bundleCheck(out, at);
    } else if (name === "nothing_funded") {
      // monotonic: once something is known to be funded, no later report can say otherwise (a host that mislays that must not make a violation end the board)
      if (f.nothingFunded !== false && (value === true || value === false || value === "unknown")) f.nothingFunded = value;
    } else if (name === "bob_deposit_covered") {
      f.bobDepositCovered = value === true;
      this.maybeSignChecked(out, at);
    } else if (name === "bob_approval_in_force") {
      f.bobApprovalInForce = value === true;
      this.maybeSignChecked(out, at);
    } else if (name === "funding_sent") {
      // Alice's funding was started by the engine: something is funded now, and Bob is told (informational)
      f.nothingFunded = false;
      if (!this.s.stopped && this.cfg.role === "alice" && !this.s.sent.includes("funded") && this.s.peerKey && value && typeof value.txid === "string" && TXID_RE.test(value.txid)) {
        this.emit(out, "funded", { txid: value.txid });
        if (this.s.phase === "checked") this.go("funded_sent", at);
      }
    }
    return out;
  }

  /** This side reports the end (shown only on the other side). Releases the board; never ends the swap. */
  finish(phase, at) {
    const out = newOut();
    if (this.s.finished || !DONE_PHASES.includes(phase)) return out;
    if (this.s.peerKey && !this.s.sent.includes("done")) this.emit(out, "done", { phase });
    this.s.finished = true;
    this.go("finished", at);
    this.act(out, "release_board", {});
    return out;
  }

  /** The user (or the host) cancels this swap on the board side. Never ends the swap. */
  cancel(code, at) {
    const out = newOut();
    this.stop(out, `cancelled here (${code})`, at, { cancel: CANCEL_CODES.includes(code) ? code : "other" });
    return out;
  }

  /** Time passes. A missed limit stops the board for this swap (and says so to the other side). */
  tick(at) {
    const out = newOut();
    const s = this.s;
    if (s.stopped || s.finished) return out;
    const L = this.cfg.limits;
    const limit = {
      taking: L.acceptS,
      await_addresses: L.addressesS, // Bob makes a wallet, signs, and sends
      bob_setup: L.helperS,
      bob_signing_addresses: L.helperS,
      addresses_sent: L.bundleS, // Alice makes her wallet and prepares
      alice_setup: L.helperS,
      preparing: L.helperS,
      bundle_wait_tip: L.helperS,
      joining: L.helperS,
      bundle_sent: L.depositWindowS + L.checkedSlackS, // Bob joins, both deposit, Bob signs
      await_ready: L.depositWindowS,
      bob_signing_checked: L.helperS,
    }[s.phase];
    if (limit !== undefined && at - s.since > limit) this.stop(out, `time limit in ${s.phase}`, at, { cancel: "time" });
    return out;
  }

  /** The result of a helper action the host ran. A failure is reported with `fail`: { name, code }. */
  helperResult(name, result, at) {
    const out = newOut();
    const s = this.s;
    if (s.stopped || s.finished) return out;
    const r = result && typeof result === "object" ? result : {};
    if (r.failed) {
      if (name === "join_bob") {
        this.emit(out, "refused", { code: "join", exit: Number.isInteger(r.exit_code) && r.exit_code >= 0 && r.exit_code <= 255 ? r.exit_code : null });
        this.stop(out, "join refused", at);
      } else this.stop(out, `helper failed: ${name}`, at, { cancel: "helper" });
      return out;
    }
    switch (name) {
      case "wallet_setup_bob":
        return this.onBobWallet(out, r, at);
      case "wallet_setup_alice":
        return this.onAliceWallet(out, r, at);
      case "sign_message":
        return this.onSigned(out, r, at);
      case "prepare_alice":
        return this.onPrepared(out, r, at);
      case "join_bob":
        return this.onJoined(out, r, at);
      default:
        out.notes.push(`ignored: result of ${String(name).slice(0, 30)}`);
        return out;
    }
  }

  // ------------------------------------------------------------------------------------------------ messages
  /**
   * @param {{from:string, content:string, at:number}} inp `from` is the SEAL'S verified signer (giftwrap.unwrap checked it equals the rumor's author)
   */
  receive(inp) {
    const out = newOut();
    const s = this.s;
    const { from, content, at } = inp;
    if (s.stopped || s.finished || !isHex64(from) || !Number.isFinite(at)) return out;
    const p = parseMessage(content);
    if (s.phase === "idle") return out; // not started
    // a maker that has no taker yet, or that is asked by somebody else
    if (this.cfg.maker && (s.peerKey === null || from !== s.peerKey)) {
      if (!p.ok || p.msg.type !== "take" || p.msg.taker !== from || p.msg.seq !== 1) return out; // not a take: not for us
      return s.peerKey === null ? this.onTake(out, from, p.msg, canon(p.msg), at) : this.declineOther(out, from, p.msg, "busy");
    }
    if (from !== s.peerKey) return out; // a key that is not this swap's counterparty
    if (!p.ok) {
      if (/^(ids|keys)$/.test(p.reason)) return out; // not even a message of ours: ignore
      this.violation(out, `a message that is not valid (${p.reason})`, at);
      return out;
    }
    const m = p.msg;
    if (m.swap !== s.swapId || m.taker !== s.takeKey) return out; // another swap
    const c = canon(m);
    if (m.type === "cancel" && m.seq >= s.expected) {
      // honoured whatever came before: it can only stop the board (amendment F)
      s.accepted[m.seq] = c;
      this.stop(out, `the other side cancelled (${m.body.code})`, at);
      return out;
    }
    if (m.seq < s.expected) {
      if (s.accepted[m.seq] !== c) this.violation(out, `two different messages for step ${m.seq}`, at);
      return out; // a duplicate: nothing to do
    }
    if (m.seq > s.expected) {
      // held only when its type is allowed at that step, in its canonical form only, and never past the cap on the held total (a message that does not fit is dropped with a note)
      const senderRole = this.cfg.role === "alice" ? "bob" : "alice";
      if (!typeAllowedAt(planFor(!this.cfg.maker, senderRole), m.seq, m.type)) {
        out.notes.push(`dropped: ${m.type} is not expected as step ${m.seq}`); // not held, and not a reason to stop: it is checked again if its turn ever comes
        return out;
      }
      const held = s.pending[m.seq];
      if (held !== undefined) {
        if (held.canon !== c) this.violation(out, `two different messages for step ${m.seq}`, at);
      } else if (Object.keys(s.pending).length >= MAX_PENDING) this.violation(out, "too many messages out of order", at);
      else if (heldBytes(s.pending) + c.length > MAX_HELD_BYTES) out.notes.push(`dropped: a message out of order (step ${m.seq}) would take the held messages over the cap`);
      else s.pending[m.seq] = { canon: c };
      return out;
    }
    this.accept(out, m, c, at);
    // a message that was waiting for the one just handled (held in its canonical form: read back the same way)
    while (!s.stopped && s.pending[s.expected]) {
      const held = s.pending[s.expected];
      delete s.pending[s.expected];
      const hp = parseMessage(held.canon);
      if (!hp.ok) continue;
      this.accept(out, hp.msg, held.canon, at);
    }
    return out;
  }

  /** The message at the expected number: check its place in the plan, then act on it. */
  accept(out, m, c, at) {
    const s = this.s;
    const senderMaker = !this.cfg.maker;
    const senderRole = this.cfg.role === "alice" ? "bob" : "alice";
    if (!typeAllowedAt(planFor(senderMaker, senderRole), m.seq, m.type)) return void this.violation(out, `${m.type} is not expected as step ${m.seq}`, at);
    const handled = this.apply(out, m, at);
    if (handled) {
      s.accepted[m.seq] = c;
      s.expected = m.seq + 1;
    }
    return undefined;
  }

  /** @returns {boolean} true when the message was taken in (the step is filled) */
  apply(out, m, at) {
    const s = this.s;
    const b = m.body;
    const wrongPhase = () => {
      this.violation(out, `${m.type} arrived in the wrong state (${s.phase})`, at);
      return false;
    };
    switch (m.type) {
      case "accept":
        if (s.phase !== "taking") return wrongPhase();
        this.act(out, "start_run_folder", { role: this.cfg.role, offer_id: s.swapId, take_key: s.takeKey });
        this.afterAccept(out, at);
        return true;
      case "decline":
        if (s.phase !== "taking") return wrongPhase();
        this.stop(out, `the maker declined (${b.reason})`, at);
        return true;
      case "take":
        return wrongPhase(); // handled before the peer is known; a second one is a duplicate or a violation
      case "bob_addresses":
        if (this.cfg.role !== "alice" || s.phase !== "await_addresses") return wrongPhase();
        return this.onBobAddresses(out, b, at);
      case "bundle":
        if (this.cfg.role !== "bob" || s.phase !== "addresses_sent") return wrongPhase();
        return this.onBundle(out, b, at);
      case "checked":
        if (this.cfg.role !== "alice" || s.phase !== "bundle_sent") return wrongPhase();
        return this.onChecked(out, b, at);
      case "refused":
        if (this.cfg.role !== "alice" || s.phase !== "bundle_sent") return wrongPhase();
        this.stop(out, `Bob's tool refused (${b.code}${b.exit === null ? "" : ", exit " + b.exit})`, at);
        return true;
      case "funded":
        if (this.cfg.role !== "bob" || !["await_ready", "bob_signing_checked", "checked_sent", "watching"].includes(s.phase)) return wrongPhase();
        out.notes.push("Alice reports her funding (shown only; the engine reads the chain)");
        if (s.phase === "checked_sent") this.go("watching", at);
        return true;
      case "done":
        s.peerDone = true;
        out.notes.push(`the other side reports: ${b.phase} (shown only)`);
        s.finished = true;
        this.act(out, "release_board", {});
        return true;
      default:
        return wrongPhase();
    }
  }

  // ------------------------------------------------------------------------------------------------ maker: takes
  declineOther(out, from, m, reason) {
    const s = this.s;
    if (s.declined.includes(from) || s.declined.length >= MAX_DECLINES) return out;
    s.declined.push(from);
    out.send.push({ to: from, type: "decline", seq: 1, content: JSON.stringify({ v: VERSION, swap: m.swap, taker: from, seq: 1, type: "decline", body: { reason } }) });
    return out;
  }

  onTake(out, from, m, c, at) {
    const s = this.s;
    const refuse = (reason) => this.declineOther(out, from, m, reason);
    if (m.swap !== m.body.offer) return out; // the envelope and the take must name the same note
    if (!s.offerOpen) return refuse("closed");
    if (s.versions[m.body.offer] === undefined || s.versions[m.body.offer] !== s.currentTermsKey) return refuse("version");
    if (this.cfg.requireTakeProof) {
      let ok = false;
      try {
        ok = m.body.proof !== undefined && this.cfg.verifyTakeProof(m.body.offer, from, m.body.proof) === true;
      } catch {
        ok = false;
      }
      if (!ok) return refuse("proof");
    }
    s.swapId = m.body.offer;
    s.takeKey = from;
    s.peerKey = from;
    s.accepted[1] = c;
    s.expected = 2;
    s.offerOpen = false;
    this.emit(out, "accept", {});
    this.act(out, "start_run_folder", { role: this.cfg.role, offer_id: s.swapId, take_key: s.takeKey });
    this.act(out, "republish_offer_taken", {});
    this.afterAccept(out, at);
    return out;
  }

  /** Both sides, once the swap is accepted: Bob makes his wallet; Alice waits for Bob's addresses. */
  afterAccept(out, at) {
    if (this.cfg.role === "bob") {
      this.go("bob_setup", at);
      this.act(out, "wallet_setup", { role: "bob" });
    } else this.go("await_addresses", at);
  }

  // ------------------------------------------------------------------------------------------------ Bob
  onBobWallet(out, r, at) {
    const s = this.s;
    if (this.cfg.role !== "bob" || s.phase !== "bob_setup") return this.ignoreResult(out, "wallet_setup_bob");
    if (ethAddressProblem(r.bob_eth)) {
      this.stop(out, "Bob's wallet address is not valid", at, { cancel: "helper" });
      return out;
    }
    s.bob = { noid: this.cfg.own.bobNoid, eth: r.bob_eth };
    this.go("bob_signing_addresses", at);
    this.act(out, "sign_message", { purpose: "addresses", text: signingText("addresses", { offer: s.swapId, take: s.takeKey, bob_noid: s.bob.noid, bob_sender: s.bob.eth }) });
    return out;
  }

  ignoreResult(out, name) {
    out.notes.push(`ignored: result of ${name} in state ${this.s.phase}`);
    return out;
  }

  onSigned(out, r, at) {
    const s = this.s;
    if (typeof r.signature !== "string" || !SIG_RE.test(r.signature)) {
      if (["bob_signing_addresses", "bob_signing_checked"].includes(s.phase)) this.stop(out, "the signature from the helper is not valid", at, { cancel: "helper" });
      return out;
    }
    if (s.phase === "bob_signing_addresses" && r.purpose === "addresses") {
      this.emit(out, "bob_addresses", { bob_noid: s.bob.noid, bob_sender: s.bob.eth, sig: r.signature });
      this.go("addresses_sent", at);
      return out;
    }
    if (s.phase === "bob_signing_checked" && r.purpose === "checked") {
      const f = s.facts;
      if (!(f.bobDepositCovered && f.bobApprovalInForce)) {
        this.go("await_ready", at); // the deposit or the approval went away while signing: do not answer
        return out;
      }
      this.emit(out, "checked", { digest: s.bundle.digest, sig: r.signature });
      this.go("checked_sent", at);
      return out;
    }
    return this.ignoreResult(out, "sign_message");
  }

  onBundle(out, b, at) {
    const s = this.s;
    let bundle;
    try {
      bundle = JSON.parse(b.bundle);
    } catch {
      this.emit(out, "refused", { code: "bundle", exit: null });
      this.stop(out, "the bundle is not JSON", at);
      return true;
    }
    const hc = bundle && bundle.params && bundle.params.h_create;
    const sender = bundle && bundle.params && bundle.params.eth && bundle.params.eth.bob_sender;
    const okShape = bundle && typeof bundle === "object" && Number.isSafeInteger(hc) && bundle.params.bob_noid === s.bob.noid && typeof sender === "string" && lc(sender) === lc(s.bob.eth);
    if (!okShape) {
      this.emit(out, "refused", { code: "bundle", exit: null });
      this.stop(out, "the bundle is not built for Bob's addresses", at);
      return true;
    }
    s.bundle = { text: b.bundle, digest: b.digest, hCreate: hc };
    this.go("bundle_wait_tip", at);
    if (s.facts.tip === null) this.act(out, "read_tip", {});
    else this.bundleCheck(out, at);
    return true;
  }

  /** Amendment B: h_create must lie near Bob's own node's tip. */
  bundleCheck(out, at) {
    const s = this.s;
    const tip = s.facts.tip;
    const hc = s.bundle.hCreate;
    if (hc < tip - this.cfg.hcBehind || hc > tip + this.cfg.hcLeadMax) {
      this.emit(out, "refused", { code: "h_create", exit: null });
      this.stop(out, `h_create ${hc} is outside the accepted range around the tip`, at);
      return;
    }
    // the bundle is written ONCE, to a path the host chooses, then Bob's own tool checks it against Bob's own terms
    if (!s.written) {
      s.written = true;
      this.act(out, "write_bundle_file", { text: s.bundle.text, once: true });
    }
    this.go("joining", at);
    this.act(out, "join_bob", {});
  }

  onJoined(out, r, at) {
    const s = this.s;
    if (this.cfg.role !== "bob" || s.phase !== "joining") return this.ignoreResult(out, "join_bob");
    if (r.exit_code !== 0 || typeof r.digest !== "string" || !/^[0-9a-f]{64}$/.test(r.digest)) {
      this.emit(out, "refused", { code: "join", exit: Number.isInteger(r.exit_code) && r.exit_code >= 0 && r.exit_code <= 255 ? r.exit_code : null });
      this.stop(out, "join refused", at);
      return out;
    }
    if (r.digest !== s.bundle.digest) {
      this.emit(out, "refused", { code: "digest", exit: null });
      this.stop(out, "the digest Bob's tool printed differs from the one in the message", at);
      return out;
    }
    this.go("await_ready", at);
    this.maybeSignChecked(out, at);
    return out;
  }

  /** Message 6 is signed and sent only when Bob's deposit is covered and his approval is in force (amendment A and the review's low points). */
  maybeSignChecked(out, at) {
    const s = this.s;
    if (s.stopped || s.phase !== "await_ready") return;
    if (!(s.facts.bobDepositCovered && s.facts.bobApprovalInForce)) return;
    this.go("bob_signing_checked", at);
    this.act(out, "sign_message", { purpose: "checked", text: signingText("checked", { offer: s.swapId, take: s.takeKey, digest: s.bundle.digest }) });
  }

  // ------------------------------------------------------------------------------------------------ Alice
  verifySig(text, sig, address) {
    try {
      return this.cfg.verify(text, sig, address) === true;
    } catch {
      return false;
    }
  }

  onBobAddresses(out, b, at) {
    const s = this.s;
    const own = this.cfg.own;
    const refuse = (why) => {
      this.stop(out, why, at, { cancel: "bad_addresses" });
      return true;
    };
    // the patterns were checked when the message was read; the equality refusals and the signature now (amendment C, D)
    if (lc(b.bob_sender) === lc(own.ethPayout) || lc(b.bob_sender) === lc(contractOf(this.cfg))) return refuse("Bob's Ethereum address equals one of Alice's or the contract");
    if (b.bob_noid === own.noidPayout) return refuse("Bob's NOID address equals Alice's payout address");
    if (!this.verifySig(signingText("addresses", { offer: s.swapId, take: s.takeKey, bob_noid: b.bob_noid, bob_sender: b.bob_sender }), b.sig, b.bob_sender)) return refuse("the signature on Bob's addresses is not valid");
    s.bob = { noid: b.bob_noid, eth: b.bob_sender };
    this.go("alice_setup", at);
    this.act(out, "wallet_setup", { role: "alice" });
    return true;
  }

  onAliceWallet(out, r, at) {
    const s = this.s;
    if (this.cfg.role !== "alice" || s.phase !== "alice_setup") return this.ignoreResult(out, "wallet_setup_alice");
    if (noidAddressProblem(r.alice_noid) || ethAddressProblem(r.alice_eth)) {
      this.stop(out, "Alice's wallet addresses are not valid", at, { cancel: "helper" });
      return out;
    }
    if (s.bob.noid === r.alice_noid || lc(s.bob.eth) === lc(r.alice_eth)) {
      this.stop(out, "Bob's address equals Alice's own address", at, { cancel: "bad_addresses" });
      return out;
    }
    s.aliceWallet = { noid: r.alice_noid, eth: r.alice_eth };
    this.go("preparing", at);
    // the ONLY two values of a message that reach a shell file
    this.act(out, "prepare_alice", { bob_noid: s.bob.noid, bob_eth: s.bob.eth });
    return out;
  }

  onPrepared(out, r, at) {
    const s = this.s;
    if (this.cfg.role !== "alice" || s.phase !== "preparing") return this.ignoreResult(out, "prepare_alice");
    if (typeof r.bundle_text !== "string" || r.bundle_text.length < 2 || r.bundle_text.length > MAX_BUNDLE_CHARS || typeof r.digest !== "string" || !/^[0-9a-f]{64}$/.test(r.digest)) {
      this.stop(out, "the prepared bundle is not usable", at, { cancel: "helper" });
      return out;
    }
    if (s.sent.includes("bundle")) {
      this.stop(out, "a second bundle is never sent (no prepare again)", at, { cancel: "other" });
      return out;
    }
    s.bundle = { text: r.bundle_text, digest: r.digest, hCreate: null };
    this.emit(out, "bundle", { bundle: r.bundle_text, digest: r.digest });
    this.go("bundle_sent", at);
    return out;
  }

  onChecked(out, b, at) {
    const s = this.s;
    const refuse = (why, code) => {
      this.stop(out, why, at, { cancel: code });
      return true;
    };
    if (!this.verifySig(signingText("checked", { offer: s.swapId, take: s.takeKey, digest: b.digest }), b.sig, s.bob.eth)) return refuse("the signature on Bob's answer is not valid", "bad_message");
    if (b.digest !== s.bundle.digest) return refuse("Bob's digest differs from the bundle that was sent", "digest");
    this.go("checked", at);
    this.act(out, "record_handover_check", { digest: b.digest, peer_key: s.peerKey, bob_sender: s.bob.eth });
    return true;
  }
}

function contractOf(cfg) {
  return cfg.offer && cfg.offer.terms && cfg.offer.terms.htlc ? cfg.offer.terms.htlc : "0x";
}

module.exports = { Handover, parseMessage, signingText, canon, ACTIONS, DEFAULT_LIMITS, CANCEL_CODES, REFUSED_CODES, DECLINE_REASONS, DONE_PHASES, VERSION, MAX_BUNDLE_CHARS };
