"use strict";
/*
 * The guided practice swap (program mode). The person presses the real buttons of a swap and a script plays the other side and both chains. Nothing real is used: no node, no coins, no network, no
 * file, no key store. This file is the whole of it on the server's side: one session in memory, a script of entries, and the payload the page draws. It requires `./demo` (the synthetic ticks the
 * terminal console's demo already uses), `./phases`, `./launchfacts` (through `./practicetext`) and `crypto` for its id, and nothing else: test/practice-core.test.js reads the require graph and fails
 * on the step executor, the steps, the RPC layer, the vault or settings modules, the audit log, `fs`, `child_process`, `net`, `http` and `https`.
 *
 * A practice swap has the id `practice-<16 hex>`. A real swap's id is 32 hexadecimal characters, so the two can never be taken for each other: the practice routes refuse a real id, and every real route
 * (and the swap set) refuses a `practice-` id.
 *
 * The script of one scenario and role is a list of entries. An entry is either the person's move (`acts` is not empty: one button or one form) or a wait (no acts: the engine drives; the fast clock ends
 * it after FAST_WAIT_S seconds, or "skip the wait" does). Each entry's world is a step of the demo's tables, so the page builds the ticket and the picture from the same view model as a real swap.
 */

const crypto = require("crypto");
const demo = require("./demo");
const T = require("./practicetext");

const ID_PREFIX = "practice-";
const ID_RE = /^practice-[0-9a-f]{16}$/;
const FAST_WAIT_S = 8; // the fast clock: a wait lasts this long here (the real time is shown beside it)
const BANNER = T.BANNER;
const STAGE_AT = { setup: 0, check: 1, approve: 2, deposit: 3, swap: 4, done: 5, refund: 5, abort: 5 }; // the index in the card's progress line (stagecard.js PROGRESS)
const ADVANCING = new Set(["prepare", "match", "choose_file", "approve", "deposited"]); // the moves that end the step; the two save buttons only note that they were pressed
const ACTS = Object.freeze(["prepare", "save_copy", "match", "save_invitation", "post_offer", "choose_file", "approve", "deposited"]);

class PracticeError extends Error {
  constructor(status, message, extra) {
    super(message);
    this.status = status;
    Object.assign(this, extra || {});
  }
}

const S = demo.STEP_TABLES;
const entry = (kind, id, world, acts, extra) => ({ kind, id, world, acts, phase: world.phase, ...(extra || {}) });

/** The script (the list of entries) of one scenario and role. The last entry is the end of the practice. */
function buildScript(scenario, role) {
  if (!T.SCENARIOS.some((s) => s.id === scenario)) throw new PracticeError(400, "unknown scenario");
  if (role !== "alice" && role !== "bob") throw new PracticeError(400, "role must be alice or bob");
  let pre;
  let steps;
  if (role === "alice") {
    const w = S.ALICE_HAPPY[0];
    pre = [entry("pre", "prepare", w, ["prepare"]), entry("pre", "check", w, ["save_copy", "match"]), entry("pre", "approve", w, ["approve"]), entry("pre", "deposit", w, ["deposited"])];
    if (scenario === "settled") steps = S.ALICE_HAPPY.slice(1);
    else if (scenario === "bob-never-locks") steps = [...S.ALICE_HAPPY.slice(1, 4), ...S.ALICE_ABORT_A.slice(1)];
    else steps = [...S.ALICE_HAPPY.slice(1, 4), ...S.ALICE_ABORT_B];
  } else {
    const w = S.BOB_HAPPY[0];
    const never = scenario === "bob-never-locks";
    pre = [entry("pre", "invitation", w, ["save_invitation", "post_offer", "choose_file"]), entry("pre", "check", w, ["match"]), entry("pre", "approve", w, ["approve"]), entry("pre", "deposit", never ? S.BOB_HAPPY[1] : S.BOB_HAPPY[2], never ? [] : ["deposited"])];
    if (scenario === "settled") steps = S.BOB_HAPPY.slice(3);
    else if (never) steps = [S.BOB_ABORT_A[1]];
    else steps = [S.BOB_HAPPY[3], ...S.BOB_ABORT_B];
  }
  const list = [...pre, ...steps.map((st) => entry("step", st.id, st, []))];
  list[list.length - 1].final = true;
  return list;
}

/** Every phase that some script of this role reaches (the drift test compares it with the phase catalogue). */
function coveredPhases(role) {
  const set = new Set();
  for (const sc of T.SCENARIOS) for (const e of buildScript(sc.id, role)) set.add(e.phase);
  return [...set];
}

/**
 * Phases of the catalogue that no practice script reaches, on purpose: Alice's "aborted" is the early stop before funding (the demo's "Stopped before funding"), and her "lost" is the demo's worst
 * case, a stuck reveal. Neither is a first lesson; the practice says in its summary that more can go wrong than it shows. Bob has every phase of the catalogue in practice.
 */
const NOT_IN_PRACTICE = Object.freeze({ alice: Object.freeze(["aborted", "lost"]), bob: Object.freeze([]) });

// ------------------------------------------------------------------ the host: one session, in memory only
function createHost() {
  return { session: null };
}

const newId = () => ID_PREFIX + crypto.randomBytes(8).toString("hex");
const isPracticeId = (v) => typeof v === "string" && v.startsWith(ID_PREFIX);

function start(host, body, now) {
  const sc = body && typeof body.scenario === "string" ? body.scenario : "";
  const role = body && typeof body.role === "string" ? body.role : "";
  const script = buildScript(sc, role); // refuses an unknown scenario or role
  host.session = { id: newId(), scenario: sc, role, script, pos: 0, since: now, flags: { save_copy: false, save_invitation: false, post_offer: false, matched: false } };
  return view(host, now);
}

function end(host, body) {
  const s = host.session;
  if (body && typeof body.id === "string" && !ID_RE.test(body.id)) throw new PracticeError(400, "that is not a practice id");
  if (s && body && typeof body.id === "string" && body.id !== s.id) throw new PracticeError(409, "that practice is not running");
  host.session = null;
  return { ok: true, practice: true, session: null };
}

/** The fast clock: a wait that has lasted FAST_WAIT_S seconds ends (one step per read, so a page that was closed does not jump to the end). */
function tickClock(s, now) {
  const e = s.script[s.pos];
  if (e.acts.length === 0 && !e.final && now - s.since >= FAST_WAIT_S) {
    s.pos += 1;
    s.since = now;
  }
}

function need(host, body) {
  const s = host.session;
  if (!s) throw new PracticeError(409, "no practice is running");
  if (!body || typeof body.id !== "string" || !ID_RE.test(body.id)) throw new PracticeError(400, "that is not a practice id");
  if (body.id !== s.id) throw new PracticeError(409, "that practice is not running");
  return s;
}

const norm = (v) => String(v === undefined || v === null ? "" : v).trim().replace(/\s+/g, " ").toUpperCase();

function act(host, body, now) {
  const s = need(host, body);
  tickClock(s, now);
  const move = body.act;
  if (typeof move !== "string" || !ACTS.includes(move)) throw new PracticeError(400, "that is not a move of the practice");
  const e = s.script[s.pos];
  if (e.final) throw new PracticeError(409, "The practice is over. Start again or leave.");
  if (!e.acts.includes(move)) throw new PracticeError(409, e.acts.length ? "That is not the move of this step." : "This step is not yours to take: the program does it. Wait, or skip the wait.");
  if (move === "match") {
    if (s.role === "alice" && !s.flags.save_copy) throw new PracticeError(409, "Give Bob your swap file first: save a copy for him. He needs it to make his check line.");
    if (body.matches !== true) throw new PracticeError(422, "Say that the lines match only when all 16 digits are the same.");
  }
  if (move === "choose_file" && !s.flags.save_invitation) throw new PracticeError(409, "Send Alice your invitation first: save it. She needs it to make her swap file.");
  if (move === "approve") {
    const need = T.STATEMENTS[s.role];
    const given = body.statements && typeof body.statements === "object" && !Array.isArray(body.statements) ? body.statements : {};
    if (!need.every((st) => given[st.id] === true)) throw new PracticeError(422, "Tick every statement first: the approval asks you to stand behind each one.");
    if (norm(body.typed) !== norm(T.FIG.typed[s.role])) throw new PracticeError(422, `That is not the amount of your step. Type ${T.FIG.typed[s.role]}.`);
  }
  if (move === "save_copy") s.flags.save_copy = true;
  else if (move === "save_invitation") s.flags.save_invitation = true;
  else if (move === "post_offer") s.flags.post_offer = true; // simulated: a note in memory, no key, no relay, no request
  if (ADVANCING.has(move)) {
    s.pos += 1;
    s.since = now;
  }
  return view(host, now);
}

function skip(host, body, now) {
  const s = need(host, body);
  tickClock(s, now);
  const e = s.script[s.pos];
  if (e.final) throw new PracticeError(409, "The practice is over. Start again or leave.");
  if (e.acts.length) throw new PracticeError(409, "This step is yours: take it yourself. Only a wait can be skipped.");
  s.pos += 1;
  s.since = now;
  return view(host, now);
}

// ------------------------------------------------------------------ what the page draws
function actionOf(s, e, txt) {
  if (!e.acts.length) return null;
  const role = s.role;
  if (e.id === "prepare") return { kind: "button", id: "prepare", label: "Prepare the swap file", primary: true };
  if (e.id === "check") {
    const other = role === "alice" ? "Bob" : "Alice";
    const a = { kind: "check", other, line: T.FIG.line, say: T.CHECK_SAY[role], match: { id: "match", label: `${role === "alice" ? "Bob read me his" : "Alice read me her"} line and all 16 digits match` } };
    if (role === "alice") a.save = { id: "save_copy", label: "Save a copy for Bob…", done: s.flags.save_copy, note: "Practice: nothing is saved. A real swap saves a file that you send to Bob." };
    return a;
  }
  if (e.id === "invitation") {
    return { kind: "invitation", save: { id: "save_invitation", label: "Save an invitation for Alice…", done: s.flags.save_invitation, note: "Practice: nothing is saved. A real swap saves a file that you send to Alice." }, offer: { id: "post_offer", label: "Post to the offers board…", done: s.flags.post_offer, note: "Practice: nothing is posted. A real offer goes to three public relays only when you confirm it, and the relays see your IP address." }, choose: { id: "choose_file", label: "Choose Alice's file…", note: "Practice: no file is opened. Alice's file is played for you." } };
  }
  if (e.id === "approve") {
    const gives = role === "alice" ? T.FIG.noid : T.FIG.eth;
    const gets = role === "alice" ? T.FIG.eth : T.FIG.noid;
    return { kind: "approval", statements: T.STATEMENTS[role].map((st) => ({ id: st.id, text: st.text })), expected_typed: T.FIG.typed[role], gives, gets, button: { id: "approve", label: "Approve this swap" } };
  }
  if (e.id === "deposit") {
    const gives = role === "alice" ? T.FIG.noid : T.FIG.eth;
    return { kind: "deposit", amount: `${gives} and a little for fees`, button: { id: "deposited", label: "Pretend the deposit arrived" }, note: "Practice: there is no address and nothing to send. The program sees a real deposit by itself." };
  }
  void txt;
  return null;
}

function doneBlock(s) {
  const alice = s.role === "alice";
  const g = alice ? { text: "10 NOID", num: "10", tic: "NOID", on: "for Bob, on Parano1d" } : { text: "0.001 ETH", num: "0.001", tic: "ETH", on: "paid to Alice on Ethereum" };
  const r = alice ? { text: "0.001 ETH", num: "0.001", tic: "ETH", on: "sent to your own Ethereum address" } : { text: "10 NOID", num: "10", tic: "NOID", on: "sent to your own Parano1d address" };
  return { gave: g, got: r, rows: [], note: "Practice: the amounts are made up. A real swap also lists the rate, the fees and the time here." };
}

/** The payload of the running practice (and `null` for none): the card, the action, the explanation and the synthetic run the page builds its ticket from. */
function view(host, now) {
  const s = host.session;
  if (!s) return null;
  tickClock(s, now);
  const e = s.script[s.pos];
  const txt = T.entryText({ kind: e.kind, id: e.id, role: s.role, scenario: s.scenario });
  const sc = T.SCENARIOS.find((x) => x.id === s.scenario);
  const act = e.acts.length > 0;
  const foot = { doing: act ? "Practice: your move." : "Practice: the program drives this step.", stopped: null, alert: false, read_age_s: null };
  const card = { kind: txt.kind, tone: txt.kind === "done" ? "done" : act ? "act" : null, stage: STAGE_AT[txt.kind], headline: txt.headline, status: txt.status, foot };
  if (txt.kind === "done") card.done = doneBlock(s);
  const payload = demo.payloadFromSteps({ role: s.role, steps: s.script.map((x) => x.world), idx: s.pos, now });
  // the synthetic run carries no clock the page could mistake for a real one: the practice's own wait is below
  const left = !act && !e.final ? Math.max(0, FAST_WAIT_S - (now - s.since)) : null;
  return {
    ok: true,
    practice: true,
    banner: BANNER,
    id: s.id,
    scenario: { id: sc.id, title: sc.title, text: sc[s.role] },
    role: s.role,
    role_words: T.ROLES[s.role],
    position: { n: s.pos + 1, of: s.script.length },
    entry: { kind: e.kind, id: e.id, phase: e.phase },
    card,
    action: actionOf(s, e, txt),
    wait: left === null ? null : { fast_s: FAST_WAIT_S, left_s: Math.ceil(left), real_text: txt.time },
    explain: { happened: txt.happened, real: txt.real, time: txt.time },
    finished: e.final === true,
    summary: e.final ? { title: sc.title, lines: T.SUMMARY[s.scenario][s.role], more: "More can go wrong than this practice shows: a node that is not in sync, a short deposit, a reveal that is stuck. The Limits and risks card says which." } : null,
    payload,
  };
}

/** What `GET /api/practice` answers: the fixed words, the scenarios, and the running session (or null). Nothing is read from the machine. */
function get(host, now) {
  return {
    ok: true,
    practice: true,
    banner: BANNER,
    banner_long: T.BANNER_LONG,
    how: T.HOW_TEXT,
    scenarios: T.SCENARIOS.map((x) => ({ id: x.id, title: x.title, alice: x.alice, bob: x.bob })),
    roles: [
      { id: "alice", label: T.ROLES.alice },
      { id: "bob", label: T.ROLES.bob },
    ],
    session: view(host, now),
  };
}

module.exports = { createHost, start, get, act, skip, end, view, buildScript, coveredPhases, isPracticeId, ID_PREFIX, ID_RE, BANNER, FAST_WAIT_S, ACTS, NOT_IN_PRACTICE, STAGE_AT, PracticeError };
