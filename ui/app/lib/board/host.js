"use strict";
/*
 * The board host (piece 3, step P3.6): the part of the console that carries the offer board's handover for the ONE swap of its run folder. Started only with the server flag `--board`.
 *
 * What it owns: the messaging keys (lib/board/keys.js), the relay clients (lib/board/relay.js), and one handover state machine (lib/board/handover.js, PURE). It feeds the machine with
 * messages and facts and performs the actions the machine asks for, and ONLY these ways:
 *   - helpers: through the console's own action table (lib/actions.js `startAction`, with the host's private token): never a command string, never a path or a flag from a message.
 *     The three tools that need an input read a file the host writes at a fixed place inside the run folder (board/verify.in, board/bundle-in.json); the helpers check it again.
 *   - env.local.sh: through the writer of the settings form (lib/swapform.js writeEnvLocal), after validateForm's own patterns accepted every value (amendment C). A value that does not
 *     match is rejected, never cleaned. Alice's file is written when Bob's signed addresses have been verified (only BOB_NOID and BOB_ETH come from a message); Bob's from the offer and his
 *     own settings.
 *   - the bundle Bob receives: written ONCE to board/bundle-in.json, handed to join.sh as its argument; never into the public copy folder, never over a file the console reads as terms.
 * It has NO send of its own: every coin-moving step is still the console's spend (start, dry run, gate, latch, audit line). What it adds is the gate's FACTS (gateFacts): Bob's signed
 * `checked` answer, the digest the swap file shows and the terms file equals, Bob's balance, and whether the board has stopped.
 *
 * Amendment F: a cancel, a refusal or a missed limit only STOPS THE BOARD for this swap and revokes the approval for the two steps that put coins in and have not started (the funding, the
 * lock). It never stops the watch loop, the autopilot's recovery or the sweeps, never marks a file ended, and the machine's stop result carries keepWatching / keepRecovery true.
 *
 * Persistence: handover-ROLE.json (lib/board/handoverfile.js) after every change; a restart rebuilds the machine from its snapshot and resumes from artifacts and stored results, so no helper
 * step that ran is run again. What a person or a page can read (view()) is enum codes and numbers only: no key, no secret, no free text of a message.
 *
 * NOT RUN AGAINST A REAL RELAY. Tested offline against the in-process fake relay and fake helpers (test/board-host*.test.js).
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { KINDS, getPublicKey, isHex64, BoardError } = require("./note");
const { RelayPool, normalizeRelayUrl } = require("./relay");
const giftwrap = require("./giftwrap");
const O = require("./offer");
const priv = require("./privboard");
const { Handover, parseMessage, signingText, MAX_BUNDLE_CHARS, ACTIONS } = require("./handover");
const { KeyStore } = require("./keys");
const { readHandover, writeHandover } = require("./handoverfile");
const { pathCandidates } = require("../runfolder");
const { validateForm, writeEnvLocal, decimalToInt, PROFILES } = require("../swapform");
const runsettings = require("../runsettings");
const { ethAddressProblem, noidAddressProblem } = require("../walletrun");
const { listFiles } = require("../actions");
const { sweepReady } = require("../gate");
const BV = require("../boardview");

const BACKDATE_S = 6 * 3600; // how far into the past a wrap's time is spread (NIP-59); the subscription looks back this far and a margin
const REFRESH_S = 600; // the maker re-publishes its offer this often while it is open
const POLL_S = 40; // Alice's read-only checks (the swap file's digest, Bob's balance) while the funding waits
const OUTBOX_RETRY_S = 20;
const OUTBOX_MAX_TRIES = 30;
const VERIFY_MAX = 6;
const MAX_DELIVER_TRIES = 3; // a message whose state could not be saved is tried this many times, then dropped
// Bob's own tick phases from the lock's send on (lib/phases.js): a lock was sent by his file, so a stop no longer revokes it
const BOB_LOCK_STARTED = new Set(["lock_submitted", "locked", "secret_seen", "claim_submitted", "claim_included", "done", "refund_submitted", "refund_mined", "refunded"]);
const FUND_K_DEFAULT = 30;
const RESERVE_WEI_DEFAULT = "2000000000000000"; // 0.002 ETH: a screen's reserve (Bob's own tool checks the real one against the live fee)
const MAX_TASK_TRIES = 600;
const BOARD_DIR = "board";

const sha256 = (x) => crypto.createHash("sha256").update(x).digest("hex");
const lc = (s) => String(s === null || s === undefined ? "" : s).toLowerCase();
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

class BoardStop extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

/** Fixed codes for the stop reasons the machine words as text (the text of a message never leaves the machine). */
function reasonCode(text) {
  const t = String(text || "");
  if (/declined/.test(t)) return "declined";
  if (/cancelled here/.test(t)) return "cancelled_here";
  if (/other side cancelled/.test(t)) return "cancelled_by_peer";
  if (/time limit/.test(t)) return "time_limit";
  if (/signature/.test(t)) return "bad_signature";
  if (/refused/.test(t)) return "refused";
  if (/h_create/.test(t)) return "h_create_range";
  if (/digest/.test(t)) return "digest_mismatch";
  if (/bundle/.test(t)) return "bad_bundle";
  if (/helper/.test(t)) return "helper_failed";
  if (/address/.test(t)) return "bad_addresses";
  if (/two different|not expected|wrong state|not valid|too many/.test(t)) return "bad_message";
  return "other";
}

const PHASE_WAIT = { open: "take", taking: "accept", await_addresses: "bob_addresses", bob_setup: "bob_wallet", bob_signing_addresses: "signature", addresses_sent: "bundle", alice_setup: "alice_wallet", preparing: "prepare", bundle_sent: "bob_check", bundle_wait_tip: "tip", joining: "join", await_ready: "deposit_and_approval", bob_signing_checked: "signature", checked_sent: "engine", checked: "engine", funded_sent: "engine", watching: "engine" };

const microToDec = (m) => {
  const v = BigInt(m);
  const f = String(v % 1000000n).padStart(6, "0").replace(/0+$/, "");
  return `${v / 1000000n}${f ? "." + f : ""}`;
};
const weiToDec = (x) => {
  const v = BigInt(x);
  const f = String(v % 10n ** 18n).padStart(18, "0").replace(/0+$/, "");
  return `${v / 10n ** 18n}${f ? "." + f : ""}`;
};

/** The settings the board needs, checked. `role` is the console's own role. Throws an Error naming the setting (never its value). */
function normalizeSettings(role, s) {
  const x = s && typeof s === "object" && !Array.isArray(s) ? s : {};
  const bad = (m) => {
    throw new Error(`board settings: ${m}`);
  };
  if (role !== "alice" && role !== "bob") bad("the board needs a console started with --role alice or --role bob");
  const profile = x.profile === undefined ? "sepolia" : x.profile;
  if (!PROFILES[profile] || profile === "production") bad("profile: a test profile (sepolia or rehearsal)");
  const relays = Array.isArray(x.relays) ? x.relays : [];
  const urls = [];
  for (const r of relays) {
    const n = normalizeRelayUrl(r, { allowLocalTest: x.allow_local_test === true });
    if (!n.ok) bad(`relays: ${n.reason}`);
    if (!urls.includes(n.url)) urls.push(n.url);
  }
  if (urls.length < 2 || urls.length > 5) bad("relays: two to five relay URLs");
  const pinned = x.pinned_htlc && typeof x.pinned_htlc === "object" ? x.pinned_htlc : {};
  const chain = String(PROFILES[profile].chain);
  if (typeof pinned[chain] !== "string" || ethAddressProblem(pinned[chain])) bad(`pinned_htlc: the app's own HTLC deployment for chain ${chain}`);
  if (role === "alice") {
    if (noidAddressProblem(x.noid_payout)) bad("noid_payout: your own Parano1d address");
  } else if (noidAddressProblem(x.bob_noid)) bad("bob_noid: the Parano1d address you receive on");
  if (ethAddressProblem(x.eth_payout)) bad("eth_payout: your own Ethereum address");
  if (x.noid_payout !== undefined && x.noid_payout !== null && noidAddressProblem(x.noid_payout)) bad("noid_payout: an o1... address");
  const lead = x.lead_blocks === undefined ? 60 : x.lead_blocks;
  if (!Number.isInteger(lead) || lead < 10 || lead > 200) bad("lead_blocks: 10 to 200");
  const k = x.fund_k === undefined ? FUND_K_DEFAULT : x.fund_k;
  if (!Number.isInteger(k) || k < 1 || k > 200) bad("fund_k: 1 to 200");
  const reserve = x.reserve_wei === undefined ? RESERVE_WEI_DEFAULT : x.reserve_wei;
  if (typeof reserve !== "string" || !/^[0-9]{1,30}$/.test(reserve)) bad("reserve_wei: whole wei as a decimal string");
  const cv = x.contract_version === undefined ? "1" : String(x.contract_version);
  if (!["1", "2"].includes(cv)) bad("contract_version: 1 or 2");
  if (x.invite_secret !== undefined && x.invite_secret !== null && !isHex64(x.invite_secret)) bad("invite_secret: 64 lower-case hex characters");
  if (x.noid_rpc !== undefined && x.noid_rpc !== null && !/^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d{1,5})?(\/[A-Za-z0-9._~/-]*)?$/.test(String(x.noid_rpc))) bad("noid_rpc: an http:// address on this machine");
  return {
    profile,
    chain,
    relays: urls,
    pinned_htlc: { [chain]: pinned[chain] },
    noid_payout: x.noid_payout || null,
    bob_noid: x.bob_noid || null,
    eth_payout: x.eth_payout,
    lead_blocks: lead,
    fund_k: k,
    reserve_wei: reserve,
    contract_version: cv,
    invite_secret: x.invite_secret || null,
    allow_public: x.allow_public === true,
    allow_local_test: x.allow_local_test === true,
    noid_rpc: x.noid_rpc || null,
    min_pow_bits: Number.isInteger(x.min_pow_bits) && x.min_pow_bits >= 0 && x.min_pow_bits <= 24 ? x.min_pow_bits : 0,
  };
}

/** The first spelling of a directory that exists (a \\wsl.localhost\... share has two). */
function resolveDir(dir) {
  for (const c of pathCandidates(dir)) {
    try {
      if (fs.statSync(c).isDirectory()) return c;
    } catch {
      /* next spelling */
    }
  }
  return dir;
}

/** The values of every stdout line that starts with `prefix` (exactly), the prefix removed. */
const linesWith = (text, prefix) => String(text || "").split(/\r?\n/).filter((l) => l.startsWith(prefix)).map((l) => l.slice(prefix.length));

class BoardHost {
  /**
   * @param {object} o
   * @param {object} o.actions the ActionRunner (it gets `actions.board = this`)
   * @param {object} [o.autopilot] lib/autopilot.js
   * @param {string} o.role "alice" or "bob" (the console's own role)
   * @param {object} o.settings see normalizeSettings
   * @param {object} [o.deps] { now: () => ms, WebSocket, fetchInfo, readTip: async () => height, random }
   */
  constructor(o) {
    if (!o || !o.actions) throw new Error("the board host needs the console's action runner");
    this.actions = o.actions;
    this.autopilot = o.autopilot || null;
    this.role = o.role;
    this.settings = normalizeSettings(o.role, o.settings);
    const d = o.deps || {};
    this.now = d.now || (() => this.actions.now());
    this.WS = d.WebSocket;
    this.fetchInfo = d.fetchInfo;
    this.writeFn = d.writeHandover || writeHandover;
    this.readTipFn = d.readTip || (this.settings.noid_rpc ? () => defaultReadTip(this.settings.noid_rpc) : null);
    this.dir = this.actions.runFolder();
    // PROGRAM MODE (step 4.5): the run has run.json, not env.local.sh; the steps replace the helpers (no install); the messaging keys are sealed by the vault's sealer when one is given
    // (d.boardSealer: lib/board/keys.js takes it as `{ sealer }`); d.runId is the id of the run folder (the slot) and d.runJsonBase(profile) the node and fee settings of the program's own settings.
    this.programMode = this.actions.programMode === true;
    this.runId = d.runId || null;
    this.runJsonBase = typeof d.runJsonBase === "function" ? d.runJsonBase : null;
    if (this.programMode && !d.boardSealer) throw new Error("board settings: in the program the board's keys are sealed by the vault (no sealer was given)");
    this.keys = new KeyStore(this.dir, { sealer: d.boardSealer || null });
    if (this.settings.invite_secret && !this.keys.invite()) this.keys.setInvite(this.settings.invite_secret);
    this.policy = O.makePolicy({ allowedProfiles: [this.settings.profile], pinnedHtlc: this.settings.pinned_htlc, minPowBits: this.settings.min_pow_bits, allowLocalTest: this.settings.allow_local_test });
    this.pool = null;
    this.swapPool = null;
    this.offerEvents = new Map();
    this.hs = null; // the persisted state of the swap (handover-ROLE.json)
    this.m = null; // the state machine
    this.vcache = new Map(); // verified signatures: sha256(text, signature, address) -> true (only a helper's `valid true` over exactly that text puts one here)
    this.verifyCount = 0;
    this.inbox = [];
    this.inboxBusy = false;
    this.seenWraps = new Set();
    this.tasks = [];
    this.cur = null;
    this.digestFact = null; // Alice: { at_ms, digest, run_file, public_file }
    this.cdepFact = null; // Alice: { at_ms, address, balance_wei }
    this.pollMark = 0;
    this.lastPublish = 0;
    this.fundedMemo = { at: 0, v: "unknown" };
    this.started = false;
    this.lastPersisted = null;
    this.sub = null;
    this.offerSub = null;
    this.error = null; // the code of the last error that a callback caught and went on from (never a message's text)
    this.errorCount = 0;
    this.actions.board = this;
  }

  // ------------------------------------------------------------------------------------------------ small things
  nowS() {
    return Math.floor(this.now() / 1000);
  }

  board() {
    const inv = this.keys.invite();
    return inv ? { mode: "private", inviteSecret: inv } : { mode: "public" };
  }

  note(result, detail) {
    try {
      this.actions.audit.append({ action: "board", role: this.role, phase: "note", result: String(result).slice(0, 120), detail: detail ? String(detail).slice(0, 200) : null });
      return true;
    } catch {
      return false;
    }
  }

  persist() {
    if (!this.hs) return;
    if (this.m) this.hs.machine = this.m.snapshot();
    // written only when something changed (the facts are fed every few seconds); the in-flight marks of the outbox are not state
    const text = JSON.stringify({ ...this.hs, updated_at: 0 }, (k, v) => (k === "inflight" ? undefined : v));
    if (text === this.lastPersisted) return;
    this.hs.updated_at = this.nowS();
    this.writeFn(this.dir, this.role, JSON.parse(JSON.stringify(this.hs, (k, v) => (k === "inflight" ? undefined : v))));
    this.lastPersisted = text;
  }

  /** Records an error a callback caught (the code only: a node error code or "error") and lets the caller go on. */
  recordError(e, where) {
    const c = e && typeof e.code === "string" && /^[A-Za-z0-9_]{1,24}$/.test(e.code) ? e.code : "error";
    this.error = c;
    this.errorCount++;
    this.note(`${where} failed`, c);
  }

  /** What a message may change, taken before it is handled: the swap's state, the machine's snapshot, the queue of helper steps. */
  checkpoint() {
    return { hs: JSON.parse(JSON.stringify(this.hs)), m: this.m.snapshot(), tasks: this.tasks.slice() };
  }

  /** Puts the checkpoint back IN PLACE (the helper steps hold the very objects). */
  rollback(c) {
    for (const k of Object.keys(this.hs)) delete this.hs[k];
    Object.assign(this.hs, c.hs);
    this.hs.outbox = (this.hs.outbox || []).map((e) => ({ ...e, inflight: false }));
    this.m.rollbackTo(c.m);
    this.tasks = c.tasks;
  }

  /** Runs fn; when it throws (a state that cannot be saved, a disk error), puts the state back as it was, records the error and returns false. Never throws. */
  guarded(where, fn) {
    let c = null;
    try {
      c = this.hs && this.m ? this.checkpoint() : null;
      fn();
      return true;
    } catch (e) {
      try {
        if (c) this.rollback(c);
      } catch (e2) {
        this.recordError(e2, "rollback");
      }
      this.recordError(e, where);
      return false;
    }
  }

  makePool(urls) {
    const p = new RelayPool({ urls, WebSocket: this.WS, fetchInfo: this.fetchInfo, allowLocalTest: this.settings.allow_local_test });
    p.on("error", () => {});
    return p;
  }

  // ------------------------------------------------------------------------------------------------ start and stop
  /** Opens the relay clients for browsing and, when the run folder already holds a handover (a restart), picks it up where it was. */
  start() {
    if (this.started) return this;
    const br = this.actions.boardRun();
    if (br.ambiguous) throw new Error("env.local.sh mentions HANDOVER in a way this console cannot read");
    const prod = this.actions.productionBlock();
    if (prod) throw new Error("the board does not run on a production run");
    this.started = true;
    this.pool = this.makePool(this.settings.relays);
    this.pool.start();
    if (this.keys.invite() || this.settings.allow_public) this.subscribeOffers();
    const f = readHandover(this.dir, this.role);
    if (f.exists && !f.value) throw new Error("the handover file of this run cannot be read: look at it before the board starts");
    if (f.value) this.restore(f.value);
    return this;
  }

  stop() {
    this.started = false;
    for (const p of [this.pool, this.swapPool]) {
      try {
        if (p) p.stop();
      } catch {
        /* closing */
      }
    }
    this.pool = null;
    this.swapPool = null;
  }

  // ------------------------------------------------------------------------------------------------ browsing offers
  subscribeOffers() {
    if (this.offerSub || !this.pool) return;
    const ctx = { policy: this.policy, now: this.nowS(), board: this.board() };
    this.offerSub = this.pool.subscribe(O.boardFilters(ctx));
    this.pool.on("event", (ev) => {
      try {
        if (ev.kind !== KINDS.OFFER) return;
        if (this.offerEvents.size >= 500) this.offerEvents.delete(this.offerEvents.keys().next().value);
        this.offerEvents.set(ev.id, ev);
      } catch (e) {
        this.recordError(e, "offer note");
      }
    });
  }

  /** The offers to show now (valid, unexpired, in policy, open), smallest first. */
  offers() {
    if (this.settings.allow_public !== true && !this.keys.invite()) return [];
    const hide = this.role === "bob" ? ["buy-noid"] : ["sell-noid"]; // a Bob takes sell-noid offers (an Alice posted them); an Alice takes buy-noid offers
    return O.filterOffers([...this.offerEvents.values()], { policy: this.policy, now: this.nowS(), board: this.board(), hideSides: hide }).shown;
  }

  // ------------------------------------------------------------------------------------------------ one swap per console
  active() {
    return !!(this.hs && !this.hs.finished);
  }

  assertFreshRun() {
    if (this.hs) throw Object.assign(new Error("this console already carries a swap (one open offer or take per app)"), { status: 409 });
    if (this.actions.swapFilesExist()) throw Object.assign(new Error("this run folder already has swap files: start the board on a fresh run folder"), { status: 409 });
    if (this.programMode) {
      // program mode: a fresh board slot holds no run.json (the host writes it when the handover reaches that point) and no swap file
      if (this.actions.productionBlock()) throw Object.assign(new Error("the board does not run on a production run"), { status: 403 });
      if (this.exists("run.json")) throw Object.assign(new Error("this run folder already has a run.json: the board writes it on a fresh board slot"), { status: 409 });
      return;
    }
    const wr = this.actions.walletRun();
    const br = this.actions.boardRun();
    if (br.ambiguous || wr.ambiguous) throw Object.assign(new Error("env.local.sh cannot be read as a board run"), { status: 409 });
    if (wr.found !== false && (wr.use_swap_wallet || wr.noid_payout || wr.eth_payout || br.declared)) throw Object.assign(new Error("this run folder already has settings: the board writes them itself, on a fresh run folder"), { status: 409 });
    if (this.actions.productionBlock()) throw Object.assign(new Error("the board does not run on a production run"), { status: 403 });
    const hasEnv = (() => {
      for (const c of pathCandidates(this.dir)) if (fs.existsSync(path.join(c, "env.local.sh"))) return true;
      return false;
    })();
    if (hasEnv) throw Object.assign(new Error("this run folder already has an env.local.sh: the board writes it on a fresh run folder"), { status: 409 });
  }

  makeMachine(cfg, state) {
    const s = this.settings;
    const inv = this.keys.invite();
    const extra = {};
    if (inv) {
      extra.requireTakeProof = true;
      extra.verifyTakeProof = (offerId, take, proof) => priv.verifyTakeProof(inv, offerId, take, proof);
    }
    return new Handover(
      {
        verify: (text, sig, address) => this.vcache.get(sha256(`${text}\0${sig}\0${lc(address)}`)) === true,
        own: this.role === "alice" ? { noidPayout: s.noid_payout, ethPayout: s.eth_payout } : { bobNoid: s.bob_noid },
        hcLeadMax: s.lead_blocks + 20,
        ...extra,
        ...cfg,
      },
      state || null,
    );
  }

  openSwapPool(urls) {
    if (this.swapPool) this.swapPool.stop();
    this.swapPool = this.makePool(urls);
    this.swapPool.start();
    const ourPub = this.hs.our_pub;
    this.sub = this.swapPool.subscribe([{ kinds: [KINDS.WRAP], "#p": [ourPub], since: this.nowS() - BACKDATE_S - 3600 }]);
    this.swapPool.on("event", (ev) => this.onWrap(ev));
  }

  // ------------------------------------------------------------------------------------------------ posting and taking
  /**
   * Posts an offer (the maker). `spec`: { noid_micro, wei } as decimal strings; the side follows from the console's role (an Alice sells NOID, a Bob buys it).
   * The offer's terms come from the board's own settings and this call only: the contract is the app's pinned one, the profile a test profile, the lock `poseidon`, the variant `raw`.
   */
  postOffer(spec) {
    this.requireStarted();
    this.assertFreshRun();
    const board = this.board();
    if (board.mode === "public" && !this.settings.allow_public) throw Object.assign(new Error("the board is private until the outside review: an invite secret is needed (board-keys.json), or allow_public in the board settings"), { status: 409 });
    const s = this.settings;
    const terms = { side: this.role === "alice" ? "sell-noid" : "buy-noid", noid: String(spec && spec.noid_micro), wei: String(spec && spec.wei), chain: s.chain, profile: s.profile, htlc: s.pinned_htlc[s.chain], lock: "poseidon", variant: "raw", cv: s.contract_version, relays: s.relays };
    const { pub, secret } = this.keys.newKey();
    let ev;
    try {
      ev = O.buildOffer({ secret, terms, policy: this.policy, now: this.nowS(), board, powBits: s.min_pow_bits });
    } catch (e) {
      if (e instanceof BoardError) throw Object.assign(new Error(`the offer is not acceptable: ${e.message}`), { status: 422 });
      throw e;
    }
    const parsed = O.parseOffer(ev, { policy: this.policy, now: this.nowS() + 1, board });
    if (!parsed.ok) throw Object.assign(new Error("the offer does not read back as valid"), { status: 500 });
    const offer = parsed.offer;
    this.hs = this.newState({ maker: true, offer, ourPub: pub });
    this.m = this.makeMachine({ role: this.role, maker: true, offer: this.offerOf(offer), ourKey: pub });
    this.persist();
    this.note("offer posted", `${offer.terms.side}`);
    this.openSwapPool(offer.terms.relays);
    this.apply(this.m.start(this.nowS()));
    this.lastPublish = this.nowS();
    this.pool.publish(ev).catch(() => {}); // in the background: the relays' answers are not awaited by the request
    return this.view();
  }

  /** Takes an offer that is on the board now (by its note id). */
  takeOffer(offerId) {
    this.requireStarted();
    this.assertFreshRun();
    if (!isHex64(offerId)) throw Object.assign(new Error("the offer id is 64 hex characters"), { status: 400 });
    const offer = this.offers().find((x) => x.id === offerId);
    if (!offer) throw Object.assign(new Error("that offer is not on the board (any more)"), { status: 404 });
    const want = this.role === "bob" ? "sell-noid" : "buy-noid";
    if (offer.terms.side !== want) throw Object.assign(new Error(`a ${this.role} takes ${want} offers`), { status: 409 });
    const { pub } = this.keys.newKey();
    this.hs = this.newState({ maker: false, offer, ourPub: pub });
    const inv = this.keys.invite();
    this.m = this.makeMachine({ role: this.role, maker: false, offer: this.offerOf(offer), ourKey: pub, ...(inv ? { takeProof: priv.takeProof(inv, offer.id, pub) } : {}) });
    this.persist();
    this.note("offer taken", `${offer.terms.side}`);
    this.openSwapPool(offer.terms.relays);
    this.apply(this.m.start(this.nowS()));
    return this.view();
  }

  /** A stop ends the board side only when nothing is funded: the machine is told the newest truth before anything that can stop it (it never takes a "true" back once told "false"). */
  freshFacts() {
    if (!this.m || this.m.phase === "idle") return;
    let nf = "unknown";
    try {
      this.fundedMemo = { at: 0, v: "unknown" };
      nf = this.nothingFunded();
    } catch {
      nf = "unknown";
    }
    this.apply(this.m.fact("nothing_funded", nf, this.nowS()));
  }

  /** The user ends the board's part (never the swap itself: amendment F). */
  cancel(code = "user") {
    if (!this.m || !this.hs) throw Object.assign(new Error("there is nothing to cancel"), { status: 409 });
    this.freshFacts();
    this.apply(this.m.cancel(code, this.nowS()));
    return this.view();
  }

  offerOf(o) {
    return { id: o.id, pubkey: o.pubkey, termsKey: o.termsKey, terms: o.terms };
  }

  newState({ maker, offer, ourPub }) {
    return {
      v: 1,
      role: this.role,
      board: "v1",
      maker,
      offer: this.offerOf(offer),
      offer_created_at: offer.createdAt,
      our_pub: ourPub,
      swap_id: maker ? null : offer.id,
      take_key: maker ? null : ourPub,
      peer_key: maker ? null : offer.pubkey,
      created_at: this.nowS(),
      updated_at: this.nowS(),
      machine: null,
      outbox: [],
      results: {},
      flags: {},
      check: null,
      verified: { addresses: false, checked: false },
      stopped: null,
      finished: false,
    };
  }

  requireStarted() {
    if (!this.started) throw Object.assign(new Error("the board is not running on this console"), { status: 409 });
  }

  // ------------------------------------------------------------------------------------------------ restart
  restore(v) {
    this.hs = v;
    this.hs.outbox = (Array.isArray(v.outbox) ? v.outbox : []).map((e) => ({ ...e, inflight: false }));
    const ourPub = v.our_pub;
    if (!isHex64(ourPub) || !this.keys.has(ourPub)) throw new Error("the handover file names a messaging key this console does not hold");
    this.m = this.makeMachine({ role: this.role, maker: !!v.maker, offer: v.offer, ourKey: ourPub }, v.machine);
    this.openSwapPool(v.offer.terms.relays);
    this.resume();
  }

  /** After a restart: what the machine was waiting for is asked again, from artifacts and stored results (a step that ran is not run again). */
  resume() {
    const at = this.nowS();
    if (this.hs.finished || this.hs.stopped || !this.m || this.m.phase === "idle") return;
    const ph = this.m.phase;
    const past = ["bob_setup", "bob_signing_addresses", "addresses_sent", "alice_setup", "preparing", "bundle_sent", "bundle_wait_tip", "joining", "await_ready", "bob_signing_checked", "checked_sent", "checked", "funded_sent", "watching"];
    if (past.includes(ph) || (ph === "await_addresses")) this.queueRunFolder();
    switch (ph) {
      case "bob_setup":
        this.taskWalletSetup("bob");
        break;
      case "bob_signing_addresses": {
        const s = this.m.snapshot();
        this.taskSign({ purpose: "addresses", text: signingText("addresses", { offer: s.swapId, take: s.takeKey, bob_noid: s.bob.noid, bob_sender: s.bob.eth }) });
        break;
      }
      case "alice_setup":
        this.taskWalletSetup("alice");
        break;
      case "preparing": {
        const s = this.m.snapshot();
        this.taskPrepare({ bob_noid: s.bob.noid, bob_eth: s.bob.eth });
        break;
      }
      case "bundle_wait_tip":
        this.taskTip();
        break;
      case "joining": {
        const s = this.m.snapshot();
        this.queueBundleFile(s.bundle.text);
        this.taskJoin();
        break;
      }
      case "bob_signing_checked": {
        const s = this.m.snapshot();
        this.taskSign({ purpose: "checked", text: signingText("checked", { offer: s.swapId, take: s.takeKey, digest: s.bundle.digest }) });
        break;
      }
      default:
        break;
    }
    void at;
  }

  // ------------------------------------------------------------------------------------------------ the machine's output
  /** Takes what a machine call returned: messages to send, actions to perform, a stop. Persists. */
  apply(out) {
    if (!out) return;
    for (const s of out.send || []) {
      this.hs.outbox.push({ seq: s.seq, type: s.type, to: s.to, content: s.content, published: false, tries: 0, at: this.nowS() });
      if (s.type === "decline") continue;
    }
    if (out.stopped) {
      const code = reasonCode(out.stopped.reason);
      this.hs.stopped = { code, at: this.nowS(), revoked: !!(this.hs.stopped && this.hs.stopped.revoked), ends_swap: false };
      this.tasks = []; // what is queued is dropped; a running helper step finishes by itself (nothing here undoes anything that ran)
      this.note(`board stopped: ${code}`, out.stopped.nothingFunded === true ? "nothing funded" : "something may be funded: the chains decide");
    }
    for (const a of out.actions || []) {
      if (!ACTIONS.includes(a.action)) continue;
      try {
        this.perform(a);
      } catch (e) {
        this.note("action failed", `${a.action}: ${(e && e.code) || "error"}`);
        if (!(this.m && this.m.stopped)) this.apply(this.m.cancel("helper", this.nowS()));
      }
    }
    this.persist();
    this.flushOutbox();
  }

  perform(a) {
    const g = a.args || {};
    switch (a.action) {
      case "start_run_folder":
        this.hs.swap_id = g.offer_id;
        this.hs.take_key = g.take_key;
        this.hs.peer_key = this.m.snapshot().peerKey;
        this.persist();
        this.queueRunFolder();
        break;
      case "republish_offer_taken":
        this.republish("taken").catch((e) => this.recordError(e, "republish"));
        break;
      case "wallet_setup":
        this.taskWalletSetup(g.role);
        break;
      case "sign_message":
        this.taskSign({ purpose: g.purpose, text: g.text });
        break;
      case "prepare_alice":
        this.taskPrepare({ bob_noid: g.bob_noid, bob_eth: g.bob_eth });
        break;
      case "write_bundle_file":
        this.queueBundleFile(g.text);
        break;
      case "join_bob":
        this.taskJoin();
        break;
      case "record_handover_check":
        this.hs.check = { digest: g.digest, peer_key: g.peer_key, bob_sender: g.bob_sender, sig_verified: this.hs.verified.checked === true, at: this.nowS() };
        this.note("handover check recorded", `digest ${String(g.digest).slice(0, 16)}`);
        break;
      case "read_tip":
        this.taskTip();
        break;
      case "board_stop":
        break; // the stop marker is set from the machine's stopped result in apply()
      case "revoke_unstarted_spends":
        if (this.hs.stopped) this.hs.stopped.revoked = true;
        this.note("approval revoked for spends not started", "funding and lock only");
        break;
      case "release_board":
        this.hs.finished = true;
        this.tasks = [];
        break;
      default:
        break;
    }
  }

  // ------------------------------------------------------------------------------------------------ messages in and out
  flushOutbox() {
    if (!this.hs || !this.swapPool) return;
    const ourSecret = this.keys.secretFor(this.hs.our_pub);
    if (!ourSecret) return;
    for (const e of this.hs.outbox) {
      if (e.published || e.inflight || e.tries >= OUTBOX_MAX_TRIES) continue;
      if (e.last && this.nowS() - e.last < OUTBOX_RETRY_S) continue;
      e.inflight = true;
      e.tries++;
      e.last = this.nowS();
      let ev;
      try {
        ev = giftwrap.wrap({ kind: KINDS.HANDOVER, content: e.content }, ourSecret, e.to, { now: this.nowS(), backdateS: BACKDATE_S }).wrap;
      } catch {
        e.inflight = false;
        continue;
      }
      this.swapPool.publish(ev).then(
        (r) => {
          e.inflight = false;
          if (r.accepted > 0) {
            e.published = true;
            try {
              this.persist();
            } catch {
              /* the next change writes it */
            }
          }
        },
        () => {
          e.inflight = false;
        },
      ).catch((err) => this.recordError(err, "outbox"));
    }
  }

  async republish(status) {
    if (!this.hs || !this.hs.maker || !this.pool) return;
    const secret = this.keys.secretFor(this.hs.offer.pubkey);
    if (!secret) return;
    const prev = { pubkey: this.hs.offer.pubkey, terms: this.hs.offer.terms };
    const ev = O.refreshOffer(prev, { secret, policy: this.policy, now: this.nowS(), board: this.board(), status, powBits: this.settings.min_pow_bits });
    const parsed = O.parseOffer(ev, { policy: this.policy, now: this.nowS() + 1, board: this.board() });
    if (!parsed.ok) return;
    this.hs.offer = this.offerOf(parsed.offer);
    if (status === "open") this.m.offerVersion(parsed.offer.id, parsed.offer.termsKey, this.nowS());
    this.persist();
    this.lastPublish = this.nowS();
    await this.pool.publish(ev).catch(() => {});
  }

  /** Entered from the relay client's listener: nothing it raises may leave it (an uncaught error in a listener ends the process, and the relays serve the same wraps again). */
  onWrap(ev) {
    try {
      this.onWrapNow(ev);
    } catch (e) {
      this.recordError(e, "wrap");
    }
  }

  onWrapNow(ev) {
    if (!this.hs || !this.m || this.seenWraps.has(ev.id)) return;
    this.seenWraps.add(ev.id);
    if (this.seenWraps.size > 5000) this.seenWraps.delete(this.seenWraps.values().next().value);
    const secret = this.keys.secretFor(this.hs.our_pub);
    if (!secret) return;
    let r;
    try {
      r = giftwrap.unwrap(ev, secret);
    } catch {
      return; // not for us, forged, or broken: dropped
    }
    if (r.rumor.kind !== KINDS.HANDOVER || r.author === this.hs.our_pub) return;
    if (this.inbox.length >= 64) return;
    this.inbox.push({ from: r.author, content: r.rumor.content, at: this.nowS() });
    this.processInbox();
  }

  /** What a received message needs before the machine may see it: null (nothing), "blocked" (not yet), or the signature to verify first. */
  needsVerify(msg) {
    if (this.role !== "alice") return null;
    const p = parseMessage(msg.content);
    if (!p.ok) return null;
    const s = this.m.snapshot();
    if (!s.peerKey || msg.from !== s.peerKey || !s.swapId || p.msg.swap !== s.swapId || p.msg.taker !== s.takeKey) return null;
    const b = p.msg.body;
    if (p.msg.type === "bob_addresses") {
      const text = signingText("addresses", { offer: s.swapId, take: s.takeKey, bob_noid: b.bob_noid, bob_sender: b.bob_sender });
      return this.vcache.has(sha256(`${text}\0${b.sig}\0${lc(b.bob_sender)}`)) ? null : { purpose: "addresses", text, sig: b.sig, signer: b.bob_sender, lines: [b.bob_noid, b.bob_sender] };
    }
    if (p.msg.type === "checked") {
      if (!s.bob) return "blocked"; // Bob's address is not known yet: his answer waits behind his addresses
      const text = signingText("checked", { offer: s.swapId, take: s.takeKey, digest: b.digest });
      return this.vcache.has(sha256(`${text}\0${b.sig}\0${lc(s.bob.eth)}`)) ? null : { purpose: "checked", text, sig: b.sig, signer: s.bob.eth, lines: [b.digest] };
    }
    return null;
  }

  /** Delivers waiting messages to the machine, one at a time; a signature is verified by the helper first (the machine's verify() only reads the answers). */
  /** Hands one message to the machine. A message whose state cannot be saved is not acted on: the state is put back, the error is recorded and the message is tried again later (three times, then dropped). */
  deliverMessage(msg) {
    const ok = this.guarded("message", () => {
      this.freshFacts();
      this.apply(this.m.receive({ from: msg.from, content: msg.content, at: this.nowS() }));
    });
    if (ok) return true;
    msg.tries = (msg.tries || 0) + 1;
    if (msg.tries < MAX_DELIVER_TRIES && this.inbox.length < 64) this.inbox.push(msg);
    else this.note("message dropped", "its state could not be saved");
    return false;
  }

  processInbox() {
    try {
      this.processInboxNow();
    } catch (e) {
      this.recordError(e, "inbox");
    }
  }

  processInboxNow() {
    if (this.inboxBusy || !this.m || !this.hs) return;
    for (let i = 0; i < this.inbox.length; i++) {
      const msg = this.inbox[i];
      let need;
      try {
        need = this.needsVerify(msg);
      } catch {
        need = null;
      }
      if (need === "blocked") continue;
      this.inbox.splice(i, 1);
      if (need === null) {
        if (!this.deliverMessage(msg)) return; // a state that could not be saved: tried again on the next pass
        i = -1;
        continue;
      }
      if (this.verifyCount >= VERIFY_MAX) continue; // too many to check: dropped
      this.verifyCount++;
      this.inboxBusy = true;
      this.taskVerify(need, msg);
      return;
    }
  }

  // ------------------------------------------------------------------------------------------------ the task engine (helper steps, one at a time, through the action table)
  addTask(t) {
    this.tasks.push({ ...t, tries: 0 });
  }

  pumpTasks() {
    for (let guard = 0; guard < 16; guard++) {
      if (!this.cur) {
        const t = this.tasks.shift();
        if (!t) return;
        this.cur = { t, i: 0, job: null, outs: [], tries: t.tries || 0 };
      }
      const c = this.cur;
      const t = c.t;
      const fail = (info) => {
        this.cur = null;
        this.safe(() => t.done(c.outs, info || { failed: true }));
      };
      if (c.job !== null) {
        const rec = this.actions.jobs.find((j) => j.job === c.job) || null;
        if (rec && rec.state !== "done") return;
        c.outs.push(rec);
        c.job = null;
        c.i++;
        const step = t.steps[c.i - 1];
        if (!rec || (rec.ok !== true && !step.tolerate)) return fail({ failed: true, rec });
      }
      if (c.i >= t.steps.length) {
        this.cur = null;
        this.safe(() => t.done(c.outs, null));
        continue;
      }
      const step = t.steps[c.i];
      if (step.skip && step.skip()) {
        c.outs.push(null);
        c.i++;
        continue;
      }
      if (step.fn) {
        try {
          step.fn(c.outs);
        } catch (e) {
          return fail(e instanceof BoardStop ? { stop: e.code } : { failed: true, error: true });
        }
        c.outs.push(null);
        c.i++;
        continue;
      }
      try {
        const job = this.actions.startAction(step.action, { host: this.actions.hostToken });
        c.job = job.job;
      } catch (e) {
        if ((e && e.status === 429) || /^busy:/.test(String(e && e.message))) {
          c.tries++;
          if (c.tries > MAX_TASK_TRIES) return fail({ failed: true, error: true });
          return;
        }
        return fail({ failed: true, error: true });
      }
      if (this.actions.jobs.find((j) => j.job === c.job && j.state === "done")) continue;
      return;
    }
  }

  safe(fn) {
    try {
      fn();
    } catch (e) {
      this.recordError(e, "handler");
    }
  }

  // ------------------------------------------------------------------------------------------------ the helper steps
  binReady() {
    return listFiles(this.dir, /^bin$/).length > 0 || (() => {
      for (const c of pathCandidates(this.dir)) {
        try {
          if (fs.statSync(path.join(c, "bin", "env.sh")).isFile()) return true;
        } catch {
          /* next */
        }
      }
      return false;
    })();
  }

  exists(...parts) {
    for (const c of pathCandidates(this.dir)) {
      try {
        fs.lstatSync(path.join(c, ...parts));
        return true;
      } catch {
        /* next */
      }
    }
    return false;
  }

  /** install (when the helpers are not there), the settings (Bob's, from the offer and his own), set up. Each step is skipped when its artifact or flag says it ran. */
  queueRunFolder() {
    const h = this.hs;
    if (h.flags.run_ready) return;
    const fl = h.flags;
    // program mode (spec 5.A.8): no install step. Bob: run.json from the offer and his own settings, then setup. Alice: her run.json needs Bob's verified addresses, so her run
    // folder work (run.json, then setup) is queued by taskWalletSetup("alice") when they are in; here there is nothing for her to do yet.
    if (this.programMode) {
      const steps = this.role === "bob" ? [{ fn: () => this.writeEnv({}), skip: () => fl.env_written }, { action: "setup", skip: () => fl.setup_done || this.exists("eth-deploy-block.txt") }] : [];
      this.addTask({
        name: "run_folder",
        steps,
        done: (outs, fail) => {
          if (fail) return void this.failToBoard(fail, "helper");
          if (this.role === "bob") fl.setup_done = true;
          fl.run_ready = true;
          this.persist();
        },
      });
      return;
    }
    const steps = [
      { action: "install", skip: () => fl.installed || this.binReady() },
      { fn: () => {
        if (this.role === "bob") this.writeEnv({});
      }, skip: () => this.role !== "bob" || fl.env_written },
      { action: "setup", skip: () => fl.setup_done || this.exists("passphrase.txt") },
    ];
    this.addTask({
      name: "run_folder",
      steps,
      done: (outs, fail) => {
        if (fail) return void this.failToBoard(fail, "helper");
        fl.installed = true;
        fl.setup_done = true;
        fl.run_ready = true;
        this.persist();
      },
    });
  }

  failToBoard(info, code) {
    this.freshFacts();
    if (info && info.stop) return void this.apply(this.m.cancel(info.stop === "counterparty_short" ? "other" : code, this.nowS()));
    this.apply(this.m.cancel(code || "helper", this.nowS()));
  }

  /** The values of env.local.sh, through validateForm's patterns and the settings form's own writer (amendment C). `extra` carries the two values of Bob's message for Alice. */
  writeEnv(extra) {
    const h = this.hs;
    if (h.flags.env_written) return;
    if (this.programMode) return this.writeRunJson(extra);
    const t = h.offer.terms;
    const s = this.settings;
    const fields = {
      use_swap_wallet: true,
      handover: "board",
      role: this.role,
      run: String(this.actions.cfg.runNumber),
      profile: t.profile,
      lock_kind: t.lock,
      variant: t.variant,
      contract_version: t.cv,
      noid_amount: microToDec(t.noid),
      eth_amount: weiToDec(t.wei),
      contract: t.htlc,
      eth_payout: s.eth_payout,
      hc_lead: String(s.lead_blocks),
    };
    if (this.role === "alice") {
      fields.noid_payout = s.noid_payout;
      fields.bob_noid = extra.bob_noid;
      fields.bob_eth = extra.bob_eth;
    } else {
      fields.bob_noid = s.bob_noid;
      if (s.noid_payout) fields.noid_payout = s.noid_payout;
    }
    // a value is rejected, never cleaned: no padding, no whitespace, no quote, no newline reaches the (trimming) form validator
    for (const [k, v] of Object.entries(fields)) if (typeof v === "string" && (v !== v.trim() || /[\s'"`$\\;|&<>(){}\u0000-\u001f]/.test(v))) throw new BoardStop("bad_value");
    if (decimalToInt(fields.noid_amount, 6).toString() !== String(t.noid) || decimalToInt(fields.eth_amount, 18).toString() !== String(t.wei)) throw new BoardStop("bad_amount");
    const v = validateForm(fields, { runNumber: this.actions.cfg.runNumber, serverRole: this.actions.cfg.role, board: true });
    if (!v.ok) {
      this.note("env.local.sh refused", Object.keys(v.errors).join(",").slice(0, 100));
      throw new BoardStop("bad_value");
    }
    if (this.role === "alice") {
      // the two values of the message, once more against everything else this file says (amendment C)
      const a = v.values;
      if (lc(a.bob_eth) === lc(a.contract) || lc(a.bob_eth) === lc(fields.eth_payout) || a.bob_noid === fields.noid_payout) throw new BoardStop("bad_value");
    }
    // the line first: when it cannot be written, the file is not written either
    this.actions.audit.append({ action: "board", role: this.role, phase: "start", result: "writing env.local.sh", detail: `run ${v.values.run}, profile ${v.values.profile}` });
    writeEnvLocal(resolveDir(this.dir), v.values, { replace: false });
    this.actions.audit.append({ action: "board", role: this.role, phase: "end", result: "env.local.sh written", detail: null });
    h.flags.env_written = true;
    this.persist();
  }

  /**
   * PROGRAM MODE's `writeEnv`: this swap's run.json, made from the offer's terms, the user's own settings and the program's node settings (spec 5.A.8). It goes through
   * runsettings.newSettings(fields, { runId }) and write(dir, obj, { create: true }): the schema refuses anything that is not a test-network wallet run, and a run.json is never
   * replaced. Bob's terms are the offer he took (never the bundle); Alice's own two values from Bob's message are checked once more against everything else the file says.
   * `extra` carries them. A value that does not pass is a stop of the board (nothing is cleaned), the reason a code only.
   */
  writeRunJson(extra) {
    const h = this.hs;
    if (h.flags.env_written) return;
    if (!this.runId || !this.runJsonBase) throw new BoardStop("bad_value");
    const t = h.offer.terms;
    const s = this.settings;
    const chain = PROFILES[t.profile] ? PROFILES[t.profile].chain : null;
    const own = this.role === "alice" ? { noid_payout: s.noid_payout, bob_noid: extra.bob_noid, bob_eth: extra.bob_eth } : { noid_payout: s.noid_payout || null, bob_noid: s.bob_noid, bob_eth: null };
    const strings = [t.profile, t.lock, t.variant, t.htlc, s.eth_payout, own.noid_payout, own.bob_noid, own.bob_eth, String(t.noid), String(t.wei)];
    // a value is rejected, never cleaned: no padding, no whitespace, no quote, no newline reaches the schema
    for (const v of strings) if (typeof v === "string" && (v !== v.trim() || /[\s'"`$\\;|&<>(){}\u0000-\u001f]/.test(v))) throw new BoardStop("bad_value");
    if (!/^[1-9]\d{0,19}$/.test(String(t.noid)) || !/^[1-9]\d{0,19}$/.test(String(t.wei))) throw new BoardStop("bad_amount");
    if (this.role === "alice") {
      // the two values of the message, once more against everything else this file says (amendment C)
      if (lc(own.bob_eth) === lc(t.htlc) || lc(own.bob_eth) === lc(s.eth_payout) || own.bob_noid === own.noid_payout) throw new BoardStop("bad_value");
    }
    let base;
    try {
      base = this.runJsonBase(t.profile);
    } catch {
      throw new BoardStop("bad_value");
    }
    const fields = {
      ...base,
      role: this.role,
      profile: t.profile,
      chain_id: chain,
      contract: t.htlc,
      lock_kind: t.lock,
      variant: t.variant,
      contract_version: Number(t.cv),
      amount_micronoid: String(t.noid),
      amount_wei: String(t.wei),
      alice_noid: null,
      bob_noid: own.bob_noid,
      alice_eth: null,
      bob_eth: own.bob_eth,
      noid_payout: own.noid_payout,
      eth_payout: s.eth_payout,
      hc_lead: s.lead_blocks,
      handover: "board",
    };
    let settings;
    try {
      settings = runsettings.newSettings(fields, { runId: this.runId });
    } catch (e) {
      this.note("run.json refused", ((e && e.problems) || []).map((p) => String(p).split(":")[0]).join(",").slice(0, 100));
      throw new BoardStop("bad_value");
    }
    // the line first: when it cannot be written, the file is not written either
    this.actions.audit.append({ action: "board", role: this.role, phase: "start", result: "writing run.json", detail: `profile ${t.profile}` });
    runsettings.write(resolveDir(this.dir), settings, { create: true });
    this.actions.audit.append({ action: "board", role: this.role, phase: "end", result: "run.json written", detail: null });
    h.flags.env_written = true;
    this.persist();
  }

  readWalletAddresses() {
    for (const c of pathCandidates(this.dir)) {
      let text;
      try {
        text = fs.readFileSync(path.join(c, "wallet-addresses.txt"), "utf8");
      } catch {
        continue;
      }
      const o = {};
      for (const l of text.split(/\r?\n/)) {
        const m = /^(ROLE|ALICE_NOID|ALICE_ETH|BOB_ETH)=(\S+)$/.exec(l);
        if (m) o[m[1]] = m[2];
      }
      return o;
    }
    return null;
  }

  taskWalletSetup(role) {
    const h = this.hs;
    const key = `wallet_setup_${role}`;
    const feed = (res) => this.apply(this.m.helperResult(key, res, this.nowS()));
    const fromFile = () => {
      const o = this.readWalletAddresses();
      if (!o || o.ROLE !== role) return null;
      if (role === "bob") return o.BOB_ETH ? { bob_eth: o.BOB_ETH } : null;
      return o.ALICE_NOID && o.ALICE_ETH ? { alice_noid: o.ALICE_NOID, alice_eth: o.ALICE_ETH } : null;
    };
    if (h.results[key]) return void feed(h.results[key]); // restarted after it was done
    const steps = [];
    if (role === "alice") {
      const b = this.m.snapshot().bob;
      steps.push({ fn: () => this.writeEnv({ bob_noid: b.noid, bob_eth: b.eth }), skip: () => h.flags.env_written });
      // program mode: Alice's setup needs her run.json, which needs Bob's verified addresses: so it comes right after it (spec 5.A.8; the terminal order ran setup first)
      if (this.programMode) steps.push({ action: "setup", skip: () => h.flags.setup_done || this.exists("eth-deploy-block.txt") });
      // a screen before Alice makes anything: Bob's address must hold the amount and a reserve (amendment D: a screen, not a guarantee)
      steps.push({ action: "board-balance", tolerate: true, skip: () => !!fromFile() });
      steps.push({ fn: (outs) => this.checkCounterparty(outs[outs.length - 1]), skip: () => !!fromFile() });
    }
    steps.push({ action: `wallet-setup-${role}`, skip: () => !!fromFile() });
    this.addTask({
      name: key,
      steps,
      done: (outs, fail) => {
        if (fail) {
          const rec = fail.rec;
          if (fail.stop || !rec || rec.ok !== true) return void this.failToBoard(fail, "helper");
        }
        const res = fromFile();
        if (!res) return void this.failToBoard({ failed: true }, "helper");
        if (this.programMode) h.flags.setup_done = true;
        h.results[key] = res;
        this.persist();
        feed(res);
      },
    });
  }

  /** Alice: reads the balance output of board-balance and refuses the swap when Bob's address does not hold the amount and the reserve. */
  checkCounterparty(rec) {
    const f = this.parseBalance(rec);
    if (!f) throw new BoardStop("counterparty_short");
    this.cdepFact = f;
    if (!this.counterpartyCovered(f)) throw new BoardStop("counterparty_short");
  }

  parseBalance(rec) {
    if (!rec || rec.ok !== true) return null;
    const lines = linesWith(rec.stdout, "board-balance: address=");
    if (lines.length !== 1 || !linesWith(rec.stdout, "board-balance: done").length) return null;
    const m = /^(0x[0-9a-fA-F]{40}) balance_wei=([0-9]{1,40}) chain_id=([0-9]{1,12}) block=([0-9]{1,15})$/.exec(lines[0]);
    return m ? { at_ms: this.now(), address: m[1], balance_wei: m[2] } : null;
  }

  counterpartyCovered(f) {
    const bob = this.m.snapshot().bob;
    if (!bob || lc(f.address) !== lc(bob.eth)) return false;
    try {
      return BigInt(f.balance_wei) >= BigInt(this.hs.offer.terms.wei) + BigInt(this.settings.reserve_wei);
    } catch {
      return false;
    }
  }

  taskSign({ purpose, text }) {
    const h = this.hs;
    const rkey = `sign_${purpose}`;
    const feed = (res) => this.apply(this.m.helperResult("sign_message", { purpose, signature: res.signature }, this.nowS()));
    if (h.results[rkey] && h.results[rkey].text_sha256 === sha256(text)) return void feed(h.results[rkey]);
    this.addTask({
      name: rkey,
      steps: [{ action: `board-sign-${purpose}` }],
      done: (outs, fail) => {
        const rec = outs[0] || (fail && fail.rec) || null;
        const out = rec && rec.ok === true ? rec.stdout : "";
        const one = (p) => {
          const v = linesWith(out, p);
          return v.length === 1 ? v[0] : null;
        };
        const sig = one("board-sign: signature ");
        const ok = !fail && one("board-sign: purpose ") === purpose && one("board-sign: text-sha256 ") === sha256(text) && sig && /^0x[0-9a-fA-F]{130}$/.test(sig) && linesWith(out, "board-sign: done").length === 1;
        if (!ok) return void this.apply(this.m.helperResult("sign_message", { failed: true }, this.nowS()));
        h.results[rkey] = { signature: sig, text_sha256: sha256(text) };
        this.persist();
        feed(h.results[rkey]);
      },
    });
  }

  taskVerify(need, msg) {
    const done = () => {
      this.inboxBusy = false;
    };
    const lines = need.purpose === "addresses" ? `signer ${need.signer}\nsignature ${need.sig}\noffer ${this.m.snapshot().swapId}\ntake ${this.m.snapshot().takeKey}\nbob_noid ${need.lines[0]}\nbob_sender ${need.lines[1]}\n` : `signer ${need.signer}\nsignature ${need.sig}\noffer ${this.m.snapshot().swapId}\ntake ${this.m.snapshot().takeKey}\ndigest ${need.lines[0]}\n`;
    this.addTask({
      name: `verify_${need.purpose}`,
      steps: [
        { fn: () => {
          const dir = path.join(resolveDir(this.dir), BOARD_DIR);
          fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
          fs.writeFileSync(path.join(dir, "verify.in"), lines, { mode: 0o600 });
        } },
        { action: `board-verify-${need.purpose}` },
      ],
      done: (outs, fail) => {
        try {
          const rec = outs[1] || (fail && fail.rec) || null;
          const out = rec && rec.ok === true ? rec.stdout : "";
          const one = (p) => {
            const v = linesWith(out, p);
            return v.length === 1 ? v[0] : null;
          };
          const valid = !fail && one("board-verify: purpose ") === need.purpose && one("board-verify: text-sha256 ") === sha256(need.text) && linesWith(out, "board-verify: done").length === 1 ? one("board-verify: valid ") : null;
          if (valid === "true") {
            this.vcache.set(sha256(`${need.text}\0${need.sig}\0${lc(need.signer)}`), true);
            this.hs.verified[need.purpose] = true;
          } else this.note(`signature check: ${valid === "false" ? "not valid" : "no answer"}`, need.purpose);
        } finally {
          done();
        }
        // the machine decides what an unverified answer means (it refuses): the message is delivered either way
        this.deliverMessage(msg);
        this.processInbox();
      },
    });
  }

  taskPrepare({ bob_noid, bob_eth }) {
    const h = this.hs;
    const feed = (res) => this.apply(this.m.helperResult("prepare_alice", res, this.nowS()));
    if (h.results.prepare) return void feed(h.results.prepare);
    // the two values that were written to env.local.sh are the ones the machine hands over: anything else is a refusal
    const written = this.m.snapshot().bob;
    if (!written || written.noid !== bob_noid || lc(written.eth) !== lc(bob_eth)) return void this.failToBoard({ failed: true }, "bad_addresses");
    const steps = [
      { action: "prepare", skip: () => this.exists("alice.swap.json") },
      { action: "board-digest-alice" },
    ];
    this.addTask({
      name: "prepare",
      steps,
      done: (outs, fail) => {
        if (fail) return void this.apply(this.m.helperResult("prepare_alice", { failed: true }, this.nowS()));
        const rec = outs[1];
        const d = this.parseDigest(rec, true);
        if (!d || d.run_file !== "same" || d.public_file === "differs") return void this.apply(this.m.helperResult("prepare_alice", { failed: true }, this.nowS()));
        let text = null;
        for (const c of pathCandidates(this.dir)) {
          try {
            text = fs.readFileSync(path.join(c, "alice.bundle.json"), "utf8");
            break;
          } catch {
            /* next */
          }
        }
        if (typeof text !== "string" || text.length < 2 || text.length > MAX_BUNDLE_CHARS) return void this.apply(this.m.helperResult("prepare_alice", { failed: true }, this.nowS()));
        this.digestFact = { at_ms: this.now(), digest: d.digest, run_file: d.run_file, public_file: d.public_file, sig: this.termsFilesSig() };
        h.results.prepare = { bundle_text: text, digest: d.digest };
        this.persist();
        feed(h.results.prepare);
      },
    });
  }

  /** What board-digest.sh printed: exactly one digest, and for Alice the two file comparisons. */
  parseDigest(rec, alice) {
    if (!rec || rec.ok !== true) return null;
    const out = rec.stdout;
    const dg = linesWith(out, "board-digest: digest ");
    if (dg.length !== 1 || !/^[0-9a-f]{64}$/.test(dg[0]) || linesWith(out, "board-digest: done").length !== 1) return null;
    if (!alice) return { digest: dg[0] };
    const pick = (p) => {
      const v = linesWith(out, p);
      return v.length === 1 && ["same", "differs", "missing"].includes(v[0]) ? v[0] : null;
    };
    const run_file = pick("board-digest: run-file ");
    const public_file = pick("board-digest: public-file ");
    return run_file && public_file ? { digest: dg[0], run_file, public_file } : null;
  }

  queueBundleFile(text) {
    this.addTask({
      name: "bundle_file",
      steps: [{ fn: () => this.writeBundleFile(text) }],
      done: (outs, fail) => {
        if (fail) return void this.failToBoard(fail, "bad_message");
      },
    });
  }

  /** The bundle Bob received, written ONCE to the board's own path (never the public copy folder, never a file the console reads as terms). */
  writeBundleFile(text) {
    if (typeof text !== "string" || text.length < 2 || text.length > MAX_BUNDLE_CHARS) throw new BoardStop("bad_bundle");
    const dir = path.join(resolveDir(this.dir), BOARD_DIR);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const f = path.join(dir, "bundle-in.json");
    try {
      fs.writeFileSync(f, text, { flag: "wx", mode: 0o600 });
    } catch (e) {
      if (!e || e.code !== "EEXIST") throw e;
      if (fs.readFileSync(f, "utf8") !== text) throw new BoardStop("bundle_file_exists"); // a different file is already there: never overwritten
    }
    this.hs.flags.bundle_written = true;
    this.persist();
  }

  taskJoin() {
    const h = this.hs;
    const feed = (res) => this.apply(this.m.helperResult("join_bob", res, this.nowS()));
    if (h.results.join) return void feed(h.results.join);
    const joined = this.exists("bob", "bob.swap.json");
    this.addTask({
      name: "join",
      steps: [joined ? { action: "board-digest-bob" } : { action: "board-join", tolerate: true }],
      done: (outs, fail) => {
        const rec = outs[0] || (fail && fail.rec) || null;
        if (joined) {
          const d = this.parseDigest(rec, false);
          if (!d) return void feed({ failed: true, exit_code: null });
          h.results.join = { exit_code: 0, digest: d.digest };
        } else {
          const code = rec && Number.isInteger(rec.exit_code) ? rec.exit_code : null;
          const dl = rec ? linesWith(rec.stdout, "bundle digest: ").filter((x) => /^[0-9a-f]{64}$/.test(x)) : [];
          if (!rec || rec.ok !== true || code !== 0 || dl.length !== 1) return void feed({ failed: true, exit_code: code });
          h.results.join = { exit_code: 0, digest: dl[0] };
        }
        this.persist();
        feed(h.results.join);
      },
    });
  }

  taskTip() {
    if (!this.readTipFn) return void this.apply(this.m.helperResult("read_tip", { failed: true }, this.nowS()));
    Promise.resolve()
      .then(() => this.readTipFn())
      .then(
        (tip) => void this.guarded("tip", () => this.apply(this.m.fact("tip", tip, this.nowS()))),
        () => void this.guarded("tip", () => this.apply(this.m.cancel("helper", this.nowS()))),
      )
      .catch((e) => this.recordError(e, "tip"));
  }

  // ------------------------------------------------------------------------------------------------ facts
  /** True / false / "unknown": was anything funded (Alice) or locked (Bob)? Amendment F: the audit log's start lines, the wallet's recorded transaction, the tick. Monotonic in use. */
  nothingFunded() {
    if (this.fundedMemo.at && this.now() - this.fundedMemo.at < 2000 && this.fundedMemo.v === false) return false;
    let v = true;
    try {
      const recs = this.actions.audit.all();
      const kind = this.role === "alice" ? "send-fund" : "send-lock";
      if (recs.some((r) => r.action === kind && r.phase === "start")) v = false;
    } catch {
      v = "unknown";
    }
    if (v !== false && this.role === "alice") {
      try {
        if (this.actions.walletMarker("wallet-funded.marker") || this.actions.fundedMarkerInfo() || listFiles(this.dir, /^wallet-fund-\d+\.(?:json|err)$/).length) v = false;
      } catch {
        v = v === true ? "unknown" : v;
      }
    }
    if (v !== false) {
      try {
        const run = this.actions.readRunFn(this.actions.cfg.runDirs, this.nowS());
        const tick = run && run.roles && run.roles[this.role] ? run.roles[this.role].tick : null;
        const phase = tick && typeof tick.phase_after === "string" ? tick.phase_after : null;
        if (phase && !(this.role === "alice" ? ["created"] : ["received"]).includes(phase)) v = false;
      } catch {
        /* the markers above decide */
      }
    }
    this.fundedMemo = { at: this.now(), v };
    return v;
  }

  feedFacts(at) {
    const m = this.m;
    this.apply(m.fact("nothing_funded", this.nothingFunded(), at));
    if (this.role === "bob") {
      let run = null;
      try {
        run = this.actions.readRunFn(this.actions.cfg.runDirs, at);
      } catch {
        run = null;
      }
      const st = this.actions.walletStatus.bob;
      const bobSender = run && run.terms && run.terms.eth ? run.terms.eth.bob_sender : null;
      const covered = !!(st && st.ok && st.eth && st.eth.covered === true && bobSender && lc(st.eth.address) === lc(bobSender) && st.eth.key_checked === true && this.now() - st.at_ms <= 120 * 1000);
      this.apply(m.fact("bob_deposit_covered", covered, at));
      let inForce = false;
      try {
        inForce = !!(this.autopilot && run && this.autopilot.approvalState("bob", run).in_force);
      } catch {
        inForce = false;
      }
      this.apply(m.fact("bob_approval_in_force", inForce, at));
    } else if (!this.hs.flags.funded_told) {
      const txid = this.fundingTxid();
      if (txid) {
        this.hs.flags.funded_told = true;
        this.apply(m.fact("funding_sent", { txid }, at));
      }
    }
  }

  fundingTxid() {
    for (const c of pathCandidates(this.dir)) {
      try {
        const t = fs.readFileSync(path.join(c, "wallet-funded.marker"), "utf8");
        const m = /^txid ([0-9a-f]{64})$/m.exec(t);
        if (m) return m[1];
      } catch {
        /* next */
      }
    }
    return null;
  }

  /** A signature of the files the console reads as terms (the bundle files of both folders): when one changes after the digest was read, that read says nothing about it. */
  termsFilesSig() {
    const parts = [];
    const dirs = [this.dir, (this.actions.cfg.runDirs || [])[1]].filter(Boolean);
    for (const d of dirs) {
      for (const name of ["alice.bundle.json", "bundle.json"]) {
        let sig = "none";
        for (const c of pathCandidates(d)) {
          try {
            const st = fs.lstatSync(path.join(c, name));
            sig = `${st.mtimeMs}:${st.size}:${st.ino}`;
            break;
          } catch {
            /* next */
          }
        }
        parts.push(sig);
      }
    }
    return parts.join("|");
  }

  /** Alice, once Bob's check is in: the read-only reads the gate wants fresh (the swap file's digest and the terms files, Bob's balance), every POLL_S seconds while the funding has not started. */
  pollAliceChecks(at) {
    if (this.role !== "alice" || !this.hs.check || this.m.stopped) return;
    if (this.nothingFunded() !== true) return;
    if (at - this.pollMark < POLL_S || this.cur || this.tasks.length) return;
    this.pollMark = at;
    const sig = this.termsFilesSig();
    this.addTask({
      name: "poll",
      steps: [{ action: "board-digest-alice", tolerate: true }, { action: "board-balance", tolerate: true }],
      done: (outs) => {
        const d = this.parseDigest(outs[0], true);
        if (d) this.digestFact = { at_ms: this.now(), digest: d.digest, run_file: d.run_file, public_file: d.public_file, sig };
        const b = this.parseBalance(outs[1]);
        if (b) this.cdepFact = b;
      },
    });
  }

  finishIfOver(at) {
    if (this.hs.finished || this.m.stopped) return;
    let phase = null;
    try {
      const run = this.actions.readRunFn(this.actions.cfg.runDirs, at);
      const tick = run && run.roles && run.roles[this.role] ? run.roles[this.role].tick : null;
      if (tick && sweepReady(this.role, tick)) phase = tick.phase_after;
    } catch {
      return;
    }
    if (!phase) return;
    const word = phase === "done" ? "settled" : phase === "refunded" ? (this.role === "alice" ? "recovered" : "refunded") : "aborted";
    this.apply(this.m.finish(word, at));
  }

  // ------------------------------------------------------------------------------------------------ the timer
  /** One pass: tasks, facts, time limits, the outbox, the offer's refresh. Called by the server's timer (and by tests). Never throws. */
  step() {
    try {
      if (!this.started) return;
      this.pumpTasks();
      if (!this.hs || !this.m || this.hs.finished) return;
      const at = this.nowS();
      if (this.m.phase !== "idle") this.feedFacts(at);
      this.apply(this.m.tick(at));
      this.pollAliceChecks(at);
      this.finishIfOver(at);
      this.processInbox();
      this.flushOutbox();
      if (this.hs.maker && this.m.phase === "open" && at - this.lastPublish >= REFRESH_S) this.republish("open").catch((e) => this.recordError(e, "republish"));
      this.pumpTasks();
    } catch (e) {
      this.recordError(e, "step");
    }
  }

  // ------------------------------------------------------------------------------------------------ what the gate, the approval and the page read
  /**
   * Which of the two spends this role has STARTED, from this role's own send evidence only; "unknown" is not started (a stopped board then refuses the spend).
   * lock_eth (Bob): a `send-lock` start line in this console's audit log, or Bob's own tick phase is `lock_submitted` or later. Alice's funding being seen is not evidence of Bob's lock.
   * fund_noid (Alice): a `send-fund` start line in the audit log, or the wallet's own funding record. Not the facts `nothing_funded` is made of: that one keeps its meaning for the state machine.
   */
  startedSpends() {
    const attempt = (fn) => {
      try {
        return fn() === true;
      } catch {
        return false;
      }
    };
    const kind = this.role === "alice" ? "send-fund" : "send-lock";
    const line = attempt(() => this.actions.audit.all().some((r) => r.action === kind && r.phase === "start"));
    if (this.role === "alice") {
      const record = line || attempt(() => !!(this.actions.walletMarker("wallet-funded.marker") || this.actions.fundedMarkerInfo() || listFiles(this.dir, /^wallet-fund-\d+\.(?:json|err)$/).length));
      return { fund_noid: record, lock_eth: false };
    }
    const lockPhase = line || attempt(() => {
      const run = this.actions.readRunFn(this.actions.cfg.runDirs, this.nowS());
      const tick = run && run.roles && run.roles.bob ? run.roles.bob.tick : null;
      return !!(tick && typeof tick.phase_after === "string" && BOB_LOCK_STARTED.has(tick.phase_after));
    });
    return { fund_noid: false, lock_eth: lockPhase };
  }

  /** The facts the gate judges for a spend of `role` (lib/gate.js boardReasons). Plain data; no key. Null when this console carries no swap of that role. */
  gateFacts(role) {
    if (!this.hs || this.hs.role !== role) return null;
    const started = this.startedSpends();
    return {
      stopped: !!this.hs.stopped,
      revoked: !!(this.hs.stopped && this.hs.stopped.revoked),
      started,
      peer_key: this.hs.peer_key || null,
      offer_id: this.hs.swap_id || null,
      check: this.hs.check || null,
      swap_digest: this.digestFact ? { at_ms: this.digestFact.at_ms, digest: this.digestFact.digest, run_file: this.digestFact.run_file, public_file: this.digestFact.public_file, files_changed: this.digestFact.sig !== this.termsFilesSig() } : null,
      counterparty: this.cdepFact,
      reserve_wei: this.settings.reserve_wei,
      fund_k: this.settings.fund_k,
    };
  }

  /** What the approval is bound to besides the terms (lib/autopilot.js termsHash): the offer note this swap is for and the counterparty's messaging key. */
  identity() {
    if (!this.hs || !isHex64(this.hs.swap_id) || !isHex64(this.hs.peer_key)) return null;
    return { offer_id: this.hs.swap_id, peer_key: this.hs.peer_key };
  }

  /**
   * One offer of the board as the page may see it: ONLY fields the offer validator passed (a digits-only amount in its smallest unit, a fixed word, the app's own pinned contract,
   * the expiry in seconds), never the poster's key, the relays or anything else a note carries. No free text.
   */
  listed(o) {
    const t = o.terms;
    return { id: o.id, side: t.side, noid_micro: String(t.noid), wei: String(t.wei), chain_id: Number(t.chain), profile: t.profile, htlc: t.htlc, contract_version: t.cv, lock: t.lock, variant: t.variant, price_wei_per_noid: O.priceWeiPerNoid(t), expires_at: o.expiration };
  }

  safeOffers() {
    try {
      return this.offers().slice(0, 50).map((o) => this.listed(o));
    } catch (e) {
      this.recordError(e, "offer list");
      return [];
    }
  }

  /** Why a new offer or take cannot start on this console now (a code), or null. One swap per console and run folder; the board is closed while it is public without a go-ahead. */
  startBlocked() {
    if (!this.started) return "not_running";
    if (this.hs) return "has_swap";
    if (!this.keys.invite() && !this.settings.allow_public) return "board_closed";
    try {
      this.assertFreshRun();
    } catch {
      return "run_not_fresh";
    }
    return null;
  }

  /** What a person may type in the "Post an offer" form: the limits of the profile and the policy, as whole numbers in the smallest unit (text). */
  limits() {
    const pr = PROFILES[this.settings.profile];
    return { noid_min_micro: String(this.policy.minNoidMicro), noid_max_micro: String(pr.max_noid_micro), wei_max: String(pr.max_eth_wei) };
  }

  /** The run payload's `board` object: enum codes and numbers only. No key, no secret, no free text from a message. */
  view() {
    const h = this.hs;
    const t = h ? h.offer.terms : null;
    let nf = null;
    try {
      nf = h ? this.nothingFunded() : null;
    } catch {
      nf = "unknown";
    }
    const phase = h && this.m ? this.m.phase : "no_offer";
    const blocked = this.startBlocked();
    const offers = this.started && !h ? this.safeOffers() : [];
    return {
      enabled: true,
      role: this.role,
      mode: this.keys.invite() ? "private" : "public",
      state: phase,
      maker: h ? !!h.maker : null,
      offer: t ? { side: t.side, noid_micro: String(t.noid), wei: String(t.wei), chain_id: Number(t.chain), profile: t.profile, htlc: t.htlc, lock: t.lock, variant: t.variant, contract_version: t.cv, price_wei_per_noid: O.priceWeiPerNoid(t) } : null,
      waiting_for: h && !h.stopped && !h.finished ? PHASE_WAIT[phase] || null : null,
      stopped: h && h.stopped ? h.stopped.code : null,
      revoked: !!(h && h.stopped && h.stopped.revoked),
      nothing_funded: nf,
      peer: !!(h && h.peer_key),
      check: h && h.check && h.check.sig_verified === true ? "verified" : null,
      finished: !!(h && h.finished),
      shown_offers: offers.length,
      // the screens (P3.7): the offers the board accepts now (validated fields only), the person's own addresses from the settings, the limits, whether a new swap can start
      // here, the board's step as an enum, the deposit window in blocks, the id of the offer note this swap is for
      offers,
      offer_id: h && isHex64(h.offer.id) ? h.offer.id : null,
      payouts: { noid: this.role === "alice" ? this.settings.noid_payout : this.settings.bob_noid, eth: this.settings.eth_payout },
      limits: this.limits(),
      can_start: blocked === null,
      start_blocked: blocked,
      step: BV.handoverStep(phase, this.role),
      deposit_window_blocks: this.settings.lead_blocks,
      fund_k: this.settings.fund_k,
      relays: this.pool ? this.pool.status().map((r) => ({ state: r.state })) : [],
      outbox_pending: h ? h.outbox.filter((e) => !e.published).length : 0,
      error: this.error, // the code of the last error the board caught and went on from (or null)
      updated_at: h ? h.updated_at : null,
    };
  }
}

/** The console's own node's tip, over JSON-RPC (loopback only; checked in normalizeSettings). */
async function defaultReadTip(url) {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "paranoid_blockCount", params: [] }), signal: AbortSignal.timeout(10000), redirect: "error" });
  const j = JSON.parse(await res.text());
  if (!Number.isSafeInteger(j.result) || j.result < 0) throw new Error("no tip");
  return j.result;
}

module.exports = { BoardHost, BoardStop, normalizeSettings, reasonCode, microToDec, weiToDec, PHASE_WAIT };
