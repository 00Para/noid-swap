"use strict";
// The practice swap's core (lib/practice.js, lib/practicetext.js): every scenario of both roles reaches its end by the person's moves and the clock alone; a move out of turn is refused; every string
// of every payload fails the real address checks; the texts keep in step with the engine and the real card; and the module's require graph holds nothing real (no step, no RPC, no vault, no file, no network).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const Practice = require("../lib/practice");
const T = require("../lib/practicetext");
const D = require("../lib/demo");
const P = require("../lib/phases");
const V = require("../lib/viewmodel");
const { ethAddressProblem, noidAddressProblem } = require("../lib/walletrun");
const { groups } = require("../lib/launchfacts");

const LIB = path.join(__dirname, "..", "lib");
const NOW = 1_800_000_000;
const SCENARIOS = T.SCENARIOS.map((s) => s.id);
const ROLES = ["alice", "bob"];

/** Plays a session through the routes' functions only: every move the view asks for, every wait skipped. Returns the list of views seen. */
function play(scenario, role, { clock = false } = {}) {
  const host = Practice.createHost();
  let now = NOW;
  let v = Practice.start(host, { scenario, role }, now);
  const seen = [v];
  for (let guard = 0; !v.finished && guard < 60; guard++) {
    const a = v.action;
    if (a) {
      if (a.kind === "button") v = Practice.act(host, { id: v.id, act: a.id }, now);
      else if (a.kind === "check") {
        if (a.save) v = Practice.act(host, { id: v.id, act: a.save.id }, now);
        v = Practice.act(host, { id: v.id, act: a.match.id, matches: true }, now);
      } else if (a.kind === "invitation") {
        v = Practice.act(host, { id: v.id, act: a.save.id }, now);
        v = Practice.act(host, { id: v.id, act: a.choose.id }, now);
      } else if (a.kind === "approval") v = Practice.act(host, { id: v.id, act: a.button.id, typed: a.expected_typed, statements: Object.fromEntries(a.statements.map((s) => [s.id, true])) }, now);
      else if (a.kind === "deposit") v = Practice.act(host, { id: v.id, act: a.button.id }, now);
      else assert.fail(`unknown action kind ${a.kind}`);
    } else if (clock) {
      now += Practice.FAST_WAIT_S;
      v = Practice.get(host, now).session;
    } else v = Practice.skip(host, { id: v.id }, now);
    seen.push(v);
  }
  assert.ok(v.finished, `${scenario}/${role} ends`);
  return { host, views: seen, last: v };
}

test("every scenario of both roles reaches its end by the person's moves and skips alone, and by the clock alone", () => {
  for (const sc of SCENARIOS) {
    for (const role of ROLES) {
      const a = play(sc, role);
      const b = play(sc, role, { clock: true });
      const ids = (r) => r.views.map((x) => x.entry.id).filter((id, i, all) => id !== all[i - 1]);
      assert.deepEqual(ids(a), ids(b), "skipping and the clock walk the same entries");
      assert.equal(a.last.entry.id, b.last.entry.id);
      assert.equal(a.last.position.n, a.last.position.of, "the end is the last entry");
    }
  }
});

test("the end of each scenario says the right thing for each role", () => {
  const end = (sc, role) => play(sc, role).last;
  assert.equal(end("settled", "alice").card.kind, "done");
  assert.equal(end("settled", "bob").card.kind, "done");
  assert.match(end("settled", "alice").card.done.got.text, /ETH/);
  assert.match(end("settled", "bob").card.done.got.text, /NOID/);
  // Bob never locks: Alice's NOID comes back after the deadline, Bob's swap did not start
  assert.equal(end("bob-never-locks", "alice").card.kind, "refund");
  assert.match(end("bob-never-locks", "alice").card.status, /NOID is back/);
  assert.equal(end("bob-never-locks", "bob").card.kind, "abort");
  assert.match(end("bob-never-locks", "bob").card.status, /Nothing was locked/);
  // Alice never reveals: both come back
  assert.equal(end("alice-never-reveals", "alice").card.kind, "refund");
  assert.match(end("alice-never-reveals", "alice").card.status, /NOID is back/);
  assert.equal(end("alice-never-reveals", "bob").card.kind, "refund");
  assert.match(end("alice-never-reveals", "bob").card.status, /ETH is back/);
  for (const sc of SCENARIOS) for (const role of ROLES) assert.ok(end(sc, role).summary.lines.length >= 3, `${sc}/${role} has a summary`);
});

test("the person's moves are the real flow: prepare, give Bob the file, compare, approve with the typed amount, deposit (Alice); invitation, Alice's file, compare, approve, deposit (Bob)", () => {
  const kinds = (role) => play("settled", role).views.filter((v) => v.entry.kind === "pre").map((v) => v.entry.id).filter((id, i, all) => id !== all[i - 1]);
  assert.deepEqual(kinds("alice"), ["prepare", "check", "approve", "deposit"]);
  assert.deepEqual(kinds("bob"), ["invitation", "check", "approve", "deposit"]);
  // the stages are the real card's: the progress index of each
  const alice = play("settled", "alice").views;
  assert.deepEqual([...new Set(alice.map((v) => v.card.stage))], [0, 1, 2, 3, 4, 5]);
  assert.equal(alice[0].card.headline, "Prepare the swap when Bob is ready");
});

test("a move out of turn, an unknown move, a wrong amount, a missing statement and a skipped step are refused with a reason", () => {
  const host = Practice.createHost();
  const v = Practice.start(host, { scenario: "settled", role: "alice" }, NOW);
  const refuse = (fn, status, re) => assert.throws(fn, (e) => e instanceof Practice.PracticeError && e.status === status && re.test(e.message), `${status} ${re}`);
  refuse(() => Practice.act(host, { id: v.id, act: "nope" }, NOW), 400, /not a move/);
  refuse(() => Practice.act(host, { id: v.id, act: "approve", typed: "10 NOID", statements: {} }, NOW), 409, /not the move of this step/);
  refuse(() => Practice.skip(host, { id: v.id }, NOW), 409, /yours/);
  Practice.act(host, { id: v.id, act: "prepare" }, NOW);
  // the check: the file for Bob first, then the lines
  refuse(() => Practice.act(host, { id: v.id, act: "match", matches: true }, NOW), 409, /Give Bob your swap file first/);
  Practice.act(host, { id: v.id, act: "save_copy" }, NOW);
  refuse(() => Practice.act(host, { id: v.id, act: "match" }, NOW), 422, /all 16 digits/);
  Practice.act(host, { id: v.id, act: "match", matches: true }, NOW);
  const all = Object.fromEntries(T.STATEMENTS.alice.map((s) => [s.id, true]));
  refuse(() => Practice.act(host, { id: v.id, act: "approve", typed: "10 NOID", statements: { ...all, line: false } }, NOW), 422, /Tick every statement/);
  refuse(() => Practice.act(host, { id: v.id, act: "approve", typed: "10", statements: all }, NOW), 422, /Type 10 NOID/);
  refuse(() => Practice.act(host, { id: v.id, act: "approve", typed: "100 NOID", statements: all }, NOW), 422, /Type 10 NOID/);
  assert.equal(Practice.act(host, { id: v.id, act: "approve", typed: " 10  noid ", statements: all }, NOW).entry.id, "deposit", "case and spaces are read as the real form reads them");
  // a wait cannot be acted on; the finished practice takes no move and no skip
  Practice.act(host, { id: v.id, act: "deposited" }, NOW);
  refuse(() => Practice.act(host, { id: v.id, act: "deposited" }, NOW), 409, /not yours to take/);
  const done = play("settled", "alice");
  refuse(() => Practice.skip(done.host, { id: done.last.id }, NOW), 409, /over/);
  refuse(() => Practice.act(done.host, { id: done.last.id, act: "prepare" }, NOW), 409, /over/);
  // Bob: the invitation first
  const hb = Practice.createHost();
  const b = Practice.start(hb, { scenario: "settled", role: "bob" }, NOW);
  refuse(() => Practice.act(hb, { id: b.id, act: "choose_file" }, NOW), 409, /invitation first/);
});

test("start refuses an unknown scenario or role; ids are practice ids and never a real swap id; no session is no practice", () => {
  const host = Practice.createHost();
  assert.throws(() => Practice.start(host, { scenario: "happy", role: "alice" }, NOW), /unknown scenario/);
  assert.throws(() => Practice.start(host, { scenario: "settled", role: "carol" }, NOW), /alice or bob/);
  assert.throws(() => Practice.start(host, null, NOW), /unknown scenario/);
  assert.equal(Practice.get(host, NOW).session, null);
  const v = Practice.start(host, { scenario: "settled", role: "bob" }, NOW);
  assert.match(v.id, Practice.ID_RE);
  assert.ok(Practice.isPracticeId(v.id));
  assert.ok(!/^[0-9a-f]{32}$/.test(v.id), "never the shape of a real swap id");
  assert.ok(!Practice.isPracticeId("a".repeat(32)));
  // another id, a real id, a missing id and an id of a session that was ended are refused
  const real = "ab".repeat(16);
  for (const bad of [real, "practice-0000000000000000", undefined, 7]) assert.throws(() => Practice.skip(host, { id: bad }, NOW), (e) => e.status === 400 || e.status === 409);
  Practice.end(host, { id: v.id });
  assert.throws(() => Practice.skip(host, { id: v.id }, NOW), /no practice is running/);
  // a second start replaces the first: one session only
  const a = Practice.start(host, { scenario: "settled", role: "alice" }, NOW);
  const b = Practice.start(host, { scenario: "settled", role: "alice" }, NOW);
  assert.notEqual(a.id, b.id);
  assert.throws(() => Practice.skip(host, { id: a.id }, NOW), /not running/);
});

test("the fast clock: a wait ends after FAST_WAIT_S seconds, one step per read; the person's own step never ends by itself", () => {
  const host = Practice.createHost();
  let v = Practice.start(host, { scenario: "settled", role: "alice" }, NOW);
  // the person's step: no clock at all
  assert.equal(Practice.get(host, NOW + 3600).session.entry.id, "prepare");
  assert.equal(v.wait, null);
  for (const [a, extra] of [["prepare"], ["save_copy"], ["match", { matches: true }], ["approve", { typed: "10 NOID", statements: Object.fromEntries(T.STATEMENTS.alice.map((s) => [s.id, true])) }], ["deposited"]]) v = Practice.act(host, { id: v.id, act: a, ...(extra || {}) }, NOW);
  assert.equal(v.entry.id, "funding_submitted");
  assert.deepEqual({ fast: v.wait.fast_s, left: v.wait.left_s }, { fast: Practice.FAST_WAIT_S, left: Practice.FAST_WAIT_S });
  assert.match(v.wait.real_text, /block/i, "the real time is next to the wait");
  assert.equal(Practice.get(host, NOW + Practice.FAST_WAIT_S - 1).session.entry.id, "funding_submitted");
  assert.equal(Practice.get(host, NOW + Practice.FAST_WAIT_S - 1).session.wait.left_s, 1);
  assert.equal(Practice.get(host, NOW + Practice.FAST_WAIT_S).session.entry.id, "funded");
  // a long absence moves one step, not to the end
  assert.equal(Practice.get(host, NOW + 100000).session.entry.id, "funding_final");
});

test("the person never sees a real time of their own machine in the payload's words, and the card carries the band's words", () => {
  const v = play("settled", "alice").views[3];
  assert.equal(v.banner, "Practice. Nothing here is real. No coins move.");
  assert.equal(Practice.BANNER, v.banner);
  assert.equal(Practice.get(Practice.createHost(), NOW).banner, v.banner);
  assert.equal(T.BANNER, v.banner);
});

// ------------------------------------------------------------------ step 2: nothing in practice looks like an address
function strings(x, out = []) {
  if (typeof x === "string") out.push(x);
  else if (Array.isArray(x)) for (const y of x) strings(y, out);
  else if (x && typeof x === "object") for (const y of Object.values(x)) strings(y, out);
  return out;
}

test("every string of every payload of every scenario, role and step fails the real address checks (bech32m, hex and EIP-55)", () => {
  let n = 0;
  for (const sc of SCENARIOS) {
    for (const role of ROLES) {
      for (const v of play(sc, role).views) {
        for (const s of strings(v)) {
          n++;
          assert.notEqual(ethAddressProblem(s), null, `an Ethereum address in a practice payload: ${s.slice(0, 60)}`);
          assert.notEqual(noidAddressProblem(s), null, `a Parano1d address in a practice payload: ${s.slice(0, 60)}`);
          assert.equal(groups(s), null, `the page would group it as an address: ${s.slice(0, 60)}`);
          assert.ok(!/0x[0-9a-fA-F]{40}(?![0-9a-fA-F])/.test(s), `a 20-byte hexadecimal value inside: ${s.slice(0, 60)}`);
          assert.ok(!/\bo1[02-9ac-hj-np-z]{20,}/.test(s), `a bech32-looking value inside: ${s.slice(0, 60)}`);
        }
      }
    }
  }
  assert.ok(n > 5000, "a real number of strings was checked");
  // the placeholders themselves
  for (const v of [D.TERMS.eth.alice_receiver, D.TERMS.eth.bob_sender, D.TERMS.eth.contract, D.TERMS.alice_noid, D.TERMS.bob_noid, D.TERMS.contract_root]) assert.match(v, /placeholder|not an address/i);
});

test("no text of the practice tells the person to send coins anywhere, and none carries a link, an address or a path", () => {
  const send = /\b(send|transfer|pay|deposit)\b[^.!?]{0,60}\b(to|at)\b[^.!?]{0,40}\b(address|account|wallet|0x|o1)\b/i;
  for (const sc of SCENARIOS) {
    for (const role of ROLES) {
      for (const v of play(sc, role).views) {
        const own = { ...v, payload: undefined };
        for (const s of strings(own)) {
          assert.ok(!send.test(s), `an instruction to send: ${s}`);
          assert.ok(!/https?:\/\/|[A-Za-z]:\\|~\//.test(s), `a link or a path: ${s}`);
        }
      }
    }
  }
  for (const s of strings(T)) assert.ok(!/https?:\/\//.test(s));
  // the deposit step has no address and no copy: only a pretend button
  const dep = play("settled", "alice").views.find((v) => v.entry.id === "deposit");
  assert.deepEqual(Object.keys(dep.action).sort(), ["amount", "button", "kind", "note"]);
  assert.match(dep.card.status, /you only pretend/i);
});

// ------------------------------------------------------------------ step 6: drift guards
test("every phase of the catalogue is reached by a practice script, except the two of Alice's that are documented", () => {
  for (const role of ROLES) {
    const covered = Practice.coveredPhases(role).sort();
    const rest = P.phaseIds(role).filter((id) => !covered.includes(id));
    assert.deepEqual(rest.sort(), [...Practice.NOT_IN_PRACTICE[role]].sort(), `${role}: the phases practice leaves out are the documented ones`);
    for (const id of covered) assert.ok(P.phaseIds(role).includes(id), `${role}: ${id} is a phase of the catalogue`);
  }
});

test("every practice payload goes through the real tick reader and view model without an error, and every phase is a known one", () => {
  for (const sc of SCENARIOS) {
    for (const role of ROLES) {
      for (const v of play(sc, role).views) {
        const p = v.payload;
        const r = p.roles[role];
        const view = V.buildView({ role, now: p.server_now, tick: r.tick, tick_mtime: r.tick_mtime, loop: r.loop, terms: p.terms, helpers: [], verify: p.verify, commands: p.commands, demo: true, program: true });
        assert.equal(view.phase.known, true, `${sc}/${role}/${v.entry.id}: ${view.phase.id}`);
        assert.equal(view.phase.id, v.entry.phase);
        assert.ok(V.legsFor(view, role, { about: () => null }), "the ticket's legs");
      }
    }
  }
});

test("every wait and note of the practice ticks is a text the engine prints today (swap-cli/src), so a reworded engine text fails here", () => {
  const src = ["engine.rs", "params.rs"].map((f) => fs.readFileSync(path.join(__dirname, "..", "..", "..", "swap-cli", "src", f), "utf8")).join("\n");
  const seen = new Set();
  for (const sc of SCENARIOS) {
    for (const role of ROLES) {
      for (const e of Practice.buildScript(sc, role)) {
        const t = D.buildTick(role, e.world, NOW, {}).tick;
        for (const s of [t.action.reason, ...t.notes]) {
          if (!s || seen.has(s)) continue;
          seen.add(s);
          const frag = s.split(/\{[A-Z_]+\}|\d+/).map((x) => x.trim()).filter((x) => x.length >= 10).sort((a, b) => b.length - a.length)[0];
          assert.ok(frag && src.includes(frag), `the engine no longer prints "${frag}"`);
        }
      }
    }
  }
  assert.ok(seen.size >= 20);
});

test("the card's words are the real card's: every text of practicetext has the fields the page draws, and a text exists for every entry of every script", () => {
  for (const sc of SCENARIOS) {
    for (const role of ROLES) {
      for (const e of Practice.buildScript(sc, role)) {
        const t = T.entryText({ kind: e.kind, id: e.id, role, scenario: sc });
        assert.ok(t, `${sc}/${role}/${e.kind}/${e.id} has a text`);
        for (const k of ["kind", "headline", "status", "happened", "real", "time"]) assert.ok(typeof t[k] === "string" && t[k].length >= 4, `${e.id}.${k}`);
        assert.ok(["setup", "check", "approve", "deposit", "swap", "done", "refund", "abort"].includes(t.kind));
        assert.ok(T.hasText(e.kind, role, e.id));
      }
    }
  }
  // the sentence under the check line is the real one (actions.js CHECK_LINE_SAY)
  const real = fs.readFileSync(path.join(__dirname, "..", "actions.js"), "utf8");
  for (const role of ROLES) assert.ok(real.includes(T.CHECK_SAY[role]), `${role}: the check line's sentence is the real card's`);
  // the headlines the real card says are in stagecard.js, so a reworded real headline fails here
  const card = fs.readFileSync(path.join(__dirname, "..", "stagecard.js"), "utf8");
  for (const h of ["Prepare the swap when Bob is ready", "Send Alice your invitation", "Compare check lines with Alice", "Send Bob your file, then compare check lines", "Waiting for Bob to lock his ETH", "Your ETH is locked", "Collecting your NOID", "Swap complete", "The swap did not go through", "This swap did not start", "Alice's funding is final", "Your lock is being sent"]) assert.ok(card.includes(`"${h}`), `the real card no longer says "${h}"`);
});

test("the real times shown are the program's own profile figures, not typed twice", () => {
  const LF = require("../lib/launchfacts");
  assert.match(T.T.USUAL, new RegExp(`${LF.PROFILES.production.usual_min} minutes`));
  assert.match(T.T.ETH_FINAL, new RegExp(`${Math.round(LF.PROFILES.production.eth_finality_s / 60)} minutes`));
  assert.match(T.T.NOID_FINAL, new RegExp(`${LF.PROFILES.production.b_final - 1} blocks`));
});

test("the worst case and the stay-online time are the program's own figures: never an \"at most\", and the same sentences as the real card", () => {
  const LF = require("../lib/launchfacts");
  const alice = LF.fmtBack(LF.backAfter("production", "alice"));
  const bob = LF.fmtBack(LF.backAfter("production", "bob"));
  assert.equal(alice, "about 6 h 45 min");
  assert.equal(bob, "about 2 h 20 min");
  assert.deepEqual(T.BACK, { alice, bob });
  // the two refunded steps (the stopped paths): the program's figure, "at the usual block speed", and no "at most"
  const aliceBack = T.STEP.alice.refunded.time;
  const bobBack = T.STEP.bob.refunded.time;
  assert.ok(aliceBack.includes(`${alice} at the usual block speed`), aliceBack);
  assert.ok(bobBack.includes(`${bob} at the usual block speed`), bobBack);
  // nothing of the practice says "at most" about a time
  const all = JSON.stringify([T.STEP, T.PRE, T.SUMMARY, T.HOW_TEXT, T.STATEMENTS]);
  assert.ok(!/at most about|takes (about [^"]*)? at most|at most (about )?\d/.test(all), "no \"at most\" before a time");
  assert.ok(!/at most/i.test(`${aliceBack} ${bobBack}`));
  // the settled summaries give the worst case as well
  assert.ok(T.SUMMARY.settled.alice.some((l) => l.includes(`${alice} at the usual block speed`)));
  assert.ok(T.SUMMARY.settled.bob.some((l) => l.includes(`${bob} at the usual block speed`)));
  // Bob: the stay-online time is the budget's (75 minutes in production) and is the real card's own sentence (actions.js `bobStakeText`)
  assert.equal(T.BOB_ONLINE_MIN, LF.bobOnlineMin("production"));
  assert.equal(T.BOB_ONLINE_MIN, 75);
  const src = fs.readFileSync(path.join(__dirname, "..", "actions.js"), "utf8");
  const sentence = (/const bobStakeText = \(n\) => `([^`]*)`/.exec(src) || [])[1];
  assert.ok(sentence, "the real card's sentence is still in actions.js");
  assert.equal(T.BOB_STAY, sentence.replace("${n}", String(T.BOB_ONLINE_MIN)), "the practice says what the real card says");
  assert.ok(T.STEP.bob.locked.real.includes(T.BOB_STAY));
  assert.ok(T.PRE.bob.approve.real.includes(T.BOB_STAY));
  assert.match(T.STEP.bob.secret_seen.time, /at least about 75 minutes after Alice reveals/);
  assert.ok(T.SUMMARY.settled.bob.some((l) => /at least about 75 minutes/.test(l)));
});

test("the practice's producer statement carries the real card's warning for a share above half", () => {
  const card = fs.readFileSync(path.join(__dirname, "..", "stagecard.js"), "utf8");
  const tail = "someone who controls most of the mining can take both sides of a swap, and no time window protects you from that. Swap only with someone you have a reason to trust.";
  assert.ok(card.includes(tail), "the real card's warning is still in stagecard.js");
  const producer = T.STATEMENTS.bob.find((s) => s.id === "producer");
  assert.ok(producer.text.includes(tail), producer.text);
  assert.match(producer.text, /above 50 %/);
  assert.match(producer.text, /does not refuse/);
});

// ------------------------------------------------------------------ the seal: the require graph
const REQUIRE_RE = /require\(\s*["'`]([^"'`]+)["'`]\s*\)/g;
function graph(entry) {
  const seen = new Map();
  const visit = (file) => {
    if (seen.has(file)) return;
    const text = fs.readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    const deps = [...text.matchAll(REQUIRE_RE)].map((m) => m[1]);
    seen.set(file, deps);
    for (const d of deps) if (d.startsWith(".")) visit(path.resolve(path.dirname(file), d.endsWith(".js") ? d : d + ".js"));
  };
  visit(entry);
  return seen;
}

test("the require graph of practice.js and practicetext.js holds nothing real: no step, executor, RPC, vault, settings, audit, runs, file, process, socket or network", () => {
  const g = graph(path.join(LIB, "practice.js"));
  const files = [...g.keys()].map((f) => path.basename(f)).sort();
  assert.deepEqual(files, ["demo.js", "launchfacts.js", "phases.js", "practice.js", "practicetext.js", "secrets.js"].sort(), "the whole graph, by file name");
  const externals = new Set([...g.values()].flat().filter((d) => !d.startsWith(".")));
  assert.deepEqual([...externals].sort(), ["crypto", "path"], "the node modules the graph names (crypto for the id; path for the secret-field names of demo's strip)");
  for (const bad of ["fs", "child_process", "net", "http", "https", "tls", "dns", "dgram", "worker_threads", "os", "electron"]) assert.ok(!externals.has(bad) && !externals.has("node:" + bad), bad);
  for (const [file, deps] of g) {
    const text = fs.readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    assert.ok(!/\b(fetch|XMLHttpRequest|WebSocket|process\.env|process\.exit|writeFile|appendFile|mkdir|spawn|exec)\b\s*\(/.test(text.replace(/crypto\.randomBytes/g, "")), `${path.basename(file)} makes a call that reaches outside`);
    for (const d of deps) assert.ok(!/stepexec|steps|rpc|vault|programsettings|settingsource|audit|runfolder|runlock|swapset|autopilot|actions|walletrun|secrets-vault|eth\.js|noid\.js|gate|dryrun/.test(d) || d === "./secrets", `${path.basename(file)} requires ${d}`);
  }
});

test("the practice's server routes are the only place the module is used, and the page script makes no request but the practice routes", () => {
  const app = path.join(__dirname, "..");
  const users = [];
  for (const f of fs.readdirSync(app)) {
    if (!f.endsWith(".js")) continue;
    if (/require\(\s*["'][^"']*practice["']\s*\)/.test(fs.readFileSync(path.join(app, f), "utf8"))) users.push(f);
  }
  assert.deepEqual(users, ["server.js"]);
  const page = fs.readFileSync(path.join(app, "practice.js"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const paths = [...page.matchAll(/["'`](\/api\/[a-z/-]*)["'`]/g)].map((m) => m[1]).sort();
  assert.deepEqual(paths, ["/api/practice/act", "/api/practice/end", "/api/practice/skip", "/api/practice/start"]);
  assert.ok(!/localStorage|sessionStorage|indexedDB|document\.cookie|\.href\s*=|window\.open|copyButton|addrWhole|navigator\.clipboard|innerHTML|insertAdjacentHTML|eval\(|new Function/.test(page), "no storage, link, copy or HTML sink");
  assert.ok(!/\bstyle\b\s*[:=]/.test(page) || !/setAttribute\("style"/.test(page), "no inline style");
});
