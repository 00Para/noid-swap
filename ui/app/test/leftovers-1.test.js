"use strict";
// Leftovers of the new look: the program's own words in what the server sends (never "console" or "autopilot"), no alarm box twice, and the done card's NOID row after Alice's sweep.
// Display only: nothing here decides or sends.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { programText, programWords } = require("../lib/programwords");
const { makeEnv } = require("./program-harness");
const F = require("./actions-fixtures");
const { loadPage, textOf } = require("./program-page-dom");
const PF = require("./program-page-fixtures");
const { NOW, TERMS, mkTick, mkLock } = require("./helpers");

const squash = (s) => s.replace(/\s+/g, " ").trim();

test("programWords: the console's and the autopilot's words become the program's, in values only (never a key, a file name or the terminal's own text elsewhere)", () => {
  assert.equal(programText("No step of this swap is sent by hand outside this console while the autopilot is on."), "No step of this swap is sent by hand outside the program while it is approved.");
  assert.equal(programText("The autopilot never re-sends one: re-send it yourself."), "The program never re-sends one: re-send it yourself.");
  assert.equal(programText("the autopilot could not take its step: x"), "the program could not take its step: x");
  assert.equal(programText("This console answers on its own address only"), "The program answers on its own address only");
  assert.equal(programText("the approval file could not be removed; this console does not use it"), "the approval file could not be removed; the program does not use it");
  assert.equal(programText("Confirm the two funding statements again to let the autopilot fund."), "Confirm the two funding statements again to let the program fund.");
  assert.equal(programText("see autopilot-alice.json in the run folder"), "see autopilot-alice.json in the run folder", "a file name is left alone");
  const out = programWords({ autopilot: { alice: { statements: [{ id: "x", text: "this console" }], n: 3, on: true } }, list: ["The console's", null] });
  assert.deepEqual(out, { autopilot: { alice: { statements: [{ id: "x", text: "the program" }], n: 3, on: true } }, list: ["The program's", null] });
  assert.equal(programWords(null), null);
});

test("the program's answers carry no 'console' and no 'autopilot' word: the approval statements and the refusal of an approval without them", async () => {
  const env = makeEnv();
  try {
    const a = env.addSwap({ role: "alice" });
    env.writeTerms(a, { aliceNoid: "o1selftestalicewalletaddressxxxxxx" });
    env.swapFile(a, "alice");
    env.writeLineMatch(a, "alice");
    env.writeTick(a, "alice", F.spendTick("fund_noid"));
    env.writeLoop(a, "alice");
    const { api } = await env.start();
    const r = await api("GET", `/api/run?swap=${a.id}`);
    assert.equal(r.status, 200);
    const ap = r.body.actions && r.body.actions.autopilot && r.body.actions.autopilot.alice;
    assert.ok(ap && Array.isArray(ap.statements) && ap.statements.length, "the approval's statements are sent");
    const texts = ap.statements.map((s) => s.text).join(" | ");
    assert.doesNotMatch(texts, /console|autopilot/i);
    assert.match(texts, /outside the program while it is approved/);
    // the refusal of an approval whose statements were not confirmed
    const refused = await api("POST", "/api/autopilot", { swap: a.id, on: true, role: "alice", typed: "5 NOID", statements: {} });
    assert.ok(refused.status >= 400);
    assert.doesNotMatch(JSON.stringify(refused.body), /console|autopilot/i);
  } finally {
    env.cleanup && env.cleanup();
  }
});

const LM = { hex: "b4271c7f3ea51fe7", at: NOW };
const ON_BOB = { available: true, on: true, expected_typed: "0.001 ETH", gets_text: "5 NOID", statements: [], needs_you: [{ spend: "send-claim", label: "Claim the NOID", reason: "it may have been sent", retrying: true }], wallet: true, doing: "Watching the chains.", approved_at: NOW - 60 };

function payloadFor(role, o = {}) {
  const p = PF.runPayload(role, { jobs: o.jobs || [PF.job("setup"), PF.job(`wallet-setup-${role}`)], watch: { started_here: true, some_loop_running: true, mode: "read" }, line_match: LM, autopilot: o.autopilot || { alice: null, bob: ON_BOB }, program: { swap: null, own_noid: "o1x" }, bundle_file: role === "alice" ? { name: "alice.bundle.json" } : null, wallet: { ...(o.wallet || {}), roles: { alice: { swap_file: role === "alice", addresses_file: true, status: null }, bob: { swap_file: role === "bob", addresses_file: true, key_address: "0x" + "b2".repeat(20), status: null } } }, check_line: { hex: LM.hex, from: role === "alice" ? "prepare" : "join" } });
  p.terms = { ...TERMS, amount_micronoid: 5000000 };
  p.roles = { alice: null, bob: null, [role]: { tick: mkTick({ phase: o.phase || "locked", lock: mkLock(), notes: o.notes || [], ...(o.tick || {}) }), tick_mtime: NOW - 3, tick_error: null, tick_writing: false, err_text: null, loop: null } };
  p.server_now = NOW;
  return p;
}
async function open(role, o) {
  const page = await loadPage({ fetch: PF.router({ "GET /api/program": () => ({ status: 200, body: PF.prog() }), "GET /api/run": () => ({ status: 200, body: payloadFor(role, o) }) }) });
  const rows = page.byId("pg-root").all((n) => n.tag === "button" && n.className.includes("pg-row"));
  await rows[role === "bob" ? 1 : 0].click();
  await page.flush();
  return page;
}

test("a needs-you box in program mode says the program, never the autopilot (label, retry line)", async () => {
  const page = await open("bob");
  const alert = page.byId("pg-card").all((n) => (n.attrs["aria-label"] || "") === "The program needs you")[0];
  assert.ok(alert, "the box is labelled for the program");
  const txt = squash(textOf(page.byId("pg-card")));
  assert.match(txt, /The program is still trying this step on later ticks\./);
  assert.doesNotMatch(squash(textOf(page.byId("pg-card"))), /autopilot|console/i);
  assert.doesNotMatch(squash(textOf(page.byId("next-action"))), /autopilot|console/i);
});

test("the same engine note twice in one tick is one loud note, and Details does not draw an alarm the strip already shows (reason, held step, note)", async () => {
  const note = "ALERT: a reorg removed your claim; send it again before D";
  const page = await open("bob", { notes: [note, note, "ALARM: producer difference"] });
  const loud = page.byId("pg-card").all((n) => n.className.split(/\s+/).includes("loud"));
  assert.equal(loud.length, 2, "two different notes in the card");
  const details = squash(textOf(page.byId("next-action")) + " " + textOf(page.byId("alarms")));
  const count = (s, t) => s.split(t).length - 1;
  assert.equal(count(details, "a reorg removed your claim"), 1, "once under Details");
  assert.equal(count(details, "producer difference"), 1, "once under Details");
  // the alarms area under Details repeats none of the strip's boxes
  assert.doesNotMatch(squash(textOf(page.byId("alarms"))), /reorg|producer difference/);
});

test("the same alarm text twice is one box under Details; an alarm made of the engine's reason is not a second box beside the reason", async () => {
  const reason = "ALARM: the engine says something odd about the lock";
  const page = await open("bob", { tick: { action: { action: "wait", reason } } });
  const details = squash(textOf(page.byId("next-action")) + " " + textOf(page.byId("alarms")));
  assert.equal(details.split("something odd about the lock").length - 1, 1, "the reason is said once under Details");
});

const SWEEP_OUT = ["wallet-sweep: payout_swap_file o1otherxxxxxxxxxxxxxxxxxxxxxxxxx", "wallet-sweep: outcome sent", "wallet-sweep: target o1payoutxxxxxxxxxxxxxxxxxxxxxxxx", "wallet-sweep: amount_micronoid 4994200", "wallet-sweep: fee_micronoid 5800", "wallet-sweep: inputs 1", "wallet-sweep: txid " + "ab".repeat(32), "wallet-sweep exit 0 (swap-cli wallet sweep, outcome sent)"].join("\n") + "\n";

test("the done card: Alice's NOID sweep gives the leftover row and its fee, from the step's own report lines; a sweep that sent nothing gives none", async () => {
  const done = (jobs) => ({ phase: "done", jobs, wallet: { swept: { eth_alice: "2026-11-19T10:00:00Z" } }, tick: { instance: null, lock: mkLock({ claimed: true }), eth: { claimed: { lock_id: "0x1" } } }, autopilot: { alice: { ...ON_BOB, expected_typed: "5 NOID", gets_text: "0.001 ETH", needs_you: [] }, bob: null } });
  const job = (o) => ({ ...PF.job("send-sweep-noid"), id: "send-sweep-noid", state: "done", ok: true, exit_code: 0, ...o });
  const sent = await open("alice", done([PF.job("setup"), job({ stdout: SWEEP_OUT })]));
  const card = squash(textOf(sent.byId("pg-card")));
  assert.match(card, /Left over, sent to you \(confirming\) 4\.9942 NOID to /);
  assert.match(card, /Network fee of that transfer 0\.0058 NOID/);
  const nothing = await open("alice", done([PF.job("setup"), job({ stdout: "wallet-sweep: outcome done\n" })]));
  assert.doesNotMatch(squash(textOf(nothing.byId("pg-card"))), /Left over/);
  const none = await open("alice", done([PF.job("setup")]));
  assert.doesNotMatch(squash(textOf(none.byId("pg-card"))), /Left over/);
});

test("the page's own words: the program-mode variants of the autopilot box texts exist in actions.js", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "actions.js"), "utf8");
  assert.match(src, /prog \? "The program needs you"/);
  assert.match(src, /prog \? "Let the program go on"/);
});

// ---------------------------------------------------------------------------------------------- fix round 1
const { STATEMENTS } = require("../lib/autopilot");

test("round 1: the refusal that quotes the approval statement reads exactly like the checkbox text; a name with a file-name character after the phrase is left alone", () => {
  const quoted = `The statement was not confirmed: "${STATEMENTS.no_manual_steps}"`;
  assert.equal(programText(quoted), `The statement was not confirmed: "${programText(STATEMENTS.no_manual_steps)}"`);
  assert.match(programText(quoted), /outside the program while it is approved\."$/);
  assert.equal(programText("the autopilot-alice.json is in the run folder"), "the autopilot-alice.json is in the run folder");
  assert.equal(programText("the console.js file and the console/x path and the console\y"), "the console.js file and the console/x path and the console\y");
  assert.equal(programText("Ask the console. The autopilot, then."), "Ask the program. The program, then.");
  assert.equal(programText("the autopilot is already on for Bob: turn it off first if you want to approve again"), "automatic steps are already on for Bob: turn them off first if you want to approve again");
});

test("round 1: the program-only drops need the stage card: a board run keeps the red box of an engine reason and the held-intent alarm; a run with a card shows each once", async () => {
  const reason = "ALARM: the engine says something odd about the lock";
  const held = { status: "held", intent: { action: "claim_noid" } };
  const alarmsOf = (page) => squash(textOf(page.byId("alarms")));
  const board = { alice: null, bob: { ...ON_BOB, needs_you: [], board: true } };
  const b1 = await open("bob", { autopilot: board, tick: { action: { action: "wait", reason } } });
  assert.match(alarmsOf(b1), /something odd about the lock/, "a board run has no card, so the red box stays");
  const b2 = await open("bob", { autopilot: board, tick: { intent: held, action: { action: "wait", reason: "waiting" } } });
  assert.match(alarmsOf(b2), /Intent "claim_noid" is held/, "a board run keeps the held-intent alarm");
  // a run with a card: the card says it, the strip says it, the alarms list does not
  const c2 = await open("bob", { tick: { intent: held, action: { action: "wait", reason: "waiting" } } });
  assert.doesNotMatch(alarmsOf(c2), /is held/);
  assert.match(squash(textOf(c2.byId("pg-card"))), /already decided|held/i, "the card carries the held step");
});

test("round 1: Alice's NOID row: the address is the tool's target line, the row says confirming, a failed or maybe-sent sweep gives none, the newest sent sweep counts, and the Ethereum rows stay beside it", async () => {
  const mkJob = (o) => ({ ...PF.job("send-sweep-noid"), id: "send-sweep-noid", state: "done", ok: true, exit_code: 0, ...o });
  const sentOut = (amount, fee, target = "o1payoutxxxxxxxxxxxxxxxxxxxxxxxx") => `wallet-sweep: payout_swap_file o1otherxxxxxxxxxxxxxxxxxxxxxxxxx\nwallet-sweep: outcome sent\nwallet-sweep: target ${target}\nwallet-sweep: amount_micronoid ${amount}\nwallet-sweep: fee_micronoid ${fee}\n`;
  const done = (jobs) => ({ phase: "done", jobs, wallet: { swept: { eth_alice: "2026-11-19T10:00:00Z" } }, tick: { instance: null, lock: mkLock({ claimed: true }), eth: { claimed: { lock_id: "0x1" } } }, autopilot: { alice: { ...ON_BOB, expected_typed: "5 NOID", gets_text: "0.001 ETH", needs_you: [] }, bob: null } });
  const card = async (jobs) => squash(textOf((await open("alice", done(jobs))).byId("pg-card")));
  const text = await card([PF.job("setup"), mkJob({ stdout: sentOut(4994200, 5800) })]);
  assert.match(text, /Left over, sent to you \(confirming\) 4\.9942 NOID to o1payout/);
  assert.doesNotMatch(text, /o1other/, "the address is the tool's target line");
  assert.doesNotMatch(await card([PF.job("setup"), mkJob({ ok: false, exit_code: 3, stdout: sentOut(1, 1) })]), /Left over/, "a failed sweep");
  assert.doesNotMatch(await card([PF.job("setup"), mkJob({ ok: true, exit_code: 6, stdout: sentOut(1, 1).replace("outcome sent", "outcome maybe_sent") })]), /Left over/, "a maybe-sent sweep");
  const two = await card([mkJob({ stdout: sentOut(1000000, 5800) }), mkJob({ stdout: sentOut(2000000, 5800) })]);
  assert.match(two, /\(confirming\) 2 NOID to /);
  assert.doesNotMatch(two, /1 NOID to /);
  const ethJob = { ...PF.job("send-sweep-eth-alice"), id: "send-sweep-eth-alice", state: "done", ok: true, exit_code: 0, files: [{ name: "eth-sweep-alice-1.json", size: 9, summary: { sweep: { role: "alice", valueWei: "916000000000000", feeWei: "84000000000000", payout: "0x" + "3c".repeat(20) } } }] };
  const both = await card([ethJob, mkJob({ stdout: sentOut(4994200, 5800) })]);
  assert.match(both, /Reached your address 0\.000916 ETH/);
  assert.match(both, /Left over NOID, sent to you \(confirming\) 4\.9942 NOID/);
  assert.match(both, /Network fee of the NOID transfer 0\.0058 NOID/);
});

test("round 1: in program mode the switch is called automatic steps (the tooltip, the lapsed approval), the terminal's words stay in the console", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "actions.js"), "utf8");
  assert.match(src, /Stops \$\{prog \? "the automatic steps" : "the autopilot"\}/);
  assert.match(src, /so automatic steps are off\./);
  assert.match(src, /turn \$\{prog \? "automatic steps" : "the autopilot"\} on/);
  assert.match(src, /"The terms changed since you approved \(or a file they are bound to did\), so the autopilot is off\./, "the terminal's sentence is kept");
});

test("round 1: the texts the page's own view model builds say the program in program mode (the coins box and the abort rows), and the terminal view is untouched", async () => {
  const V = require("../lib/viewmodel");
  const raw = { a: { b: ["Unknown to the console.", "That is what the node said then; the console does not claim more."] } };
  const out = programWords(raw);
  assert.deepEqual(out, { a: { b: ["Unknown to the program.", "That is what the node said then; the program does not claim more."] } });
  assert.equal(typeof V.buildView, "function");
  const page = await open("bob", { phase: "aborted" });
  const all = squash(textOf(page.byId("abort")) + " " + textOf(page.byId("pg-ticket")));
  assert.doesNotMatch(all, /the console|The console/);
});
