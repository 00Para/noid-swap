"use strict";
// Batch D of the launch screens, "Record a close made elsewhere" (program mode): the transaction id's shape, the one argument vector that reaches swap-cli (`--apply` and `--closed-by TXID`, each
// once), no gate, typed amount or latch, the audit lines, a refused recording that writes nothing, the route and the page (the action is drawn only in the right states; the dialog).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { makeEnv, allFiles } = require("./program-harness");
const { createStepExecutor, resolve, recordCloseTxid, RECORD_CLOSE_ID } = require("../lib/stepexec");
const { createRunJsonSource } = require("../lib/settingsource");
const { AuditLog } = require("../lib/audit");
const { BY_ID } = require("../lib/actions");
const { tick } = require("../lib/steps/tick");
const { makeHarness } = require("./steps-fixtures/harness");
const { openSwap, cardPayload, AP, ON, has, squash, textOf, F, mkLock } = require("./look-harness");

const TX = "ab".repeat(32);
const TXT = JSON.stringify(TX);
const audited = (audit) => audit.all().filter((r) => r.action === RECORD_CLOSE_ID);

/** An executor over a Bob (or Alice) swap with its swap file, the stub steps and a real audit log. */
function bobExec(env, role = "bob") {
  const sw = env.addSwap({ role });
  env.swapFile(sw, role);
  const source = createRunJsonSource({ dir: sw.dir });
  const audit = new AuditLog(sw.pub, { role });
  const executor = createStepExecutor({ program: env.program, swap: { id: sw.id, dir: sw.dir, settingsSource: source, audit }, steps: env.steps });
  return { sw, executor, audit };
}

/** What swap-cli's tick leaves in last-tick-ROLE.json when it records the close (the part the program reads). */
const recordedTick = (role, tx = TX) => (ctx) => {
  fs.writeFileSync(path.join(ctx.runDir, `last-tick-${role}.json`), JSON.stringify({ closed_by: { txid: tx, height: 280100, recorded: true, branch: "claim" }, phase_after: "claim_included", notes: ["RECORDED the close"] }));
  return { code: 0, stdout: `[${role}] tick exit 0 at 12:00:00\nnoid: tip 1\napplied: True phase_after: claim_included\n`, stderr: "", files: [`last-tick-${role}.json`] };
};

// ---------------------------------------------------------------------------------------------------------------- the shape of the id
test("the id: exactly 64 lower-case hex digits after an optional 0x, given to swap-cli as the 64 digits alone; uppercase, 63 and 65 digits, non-hex, spaces and non-strings are refused", () => {
  assert.equal(recordCloseTxid(TX), TX);
  assert.equal(recordCloseTxid(`0x${TX}`), TX, "0x is dropped");
  assert.equal(recordCloseTxid(TX.toUpperCase()), null, "upper case is refused (the page lower-cases what is pasted)");
  assert.equal(recordCloseTxid(`0X${TX}`), null);
  assert.equal(recordCloseTxid(TX.slice(1)), null, "63 digits");
  assert.equal(recordCloseTxid(`${TX}a`), null, "65 digits");
  assert.equal(recordCloseTxid(`0x${TX}a`), null);
  assert.equal(recordCloseTxid(`${"g".repeat(64)}`), null, "not hex");
  assert.equal(recordCloseTxid(`${TX.slice(0, 63)}z`), null);
  assert.equal(recordCloseTxid(` ${TX}`), null, "no space around it");
  assert.equal(recordCloseTxid(`${TX}\n`), null);
  assert.equal(recordCloseTxid(""), null);
  assert.equal(recordCloseTxid("0x"), null);
  for (const v of [null, undefined, 5, {}, [TX], true]) assert.equal(recordCloseTxid(v), null);
});

test("the executor answers 400 for a bad id: no precheck, no step, no audit line", async () => {
  const env = makeEnv();
  try {
    const { executor, audit } = bobExec(env);
    for (const bad of ["", "0x", TX.slice(1), `${TX}0`, TX.toUpperCase(), "z".repeat(64), null, 7]) {
      const r = await executor.recordClose(bad);
      assert.equal(r.status, 400, String(bad));
      assert.equal(r.recorded, false);
      assert.equal(r.ok, false);
    }
    assert.equal(env.steps.calls.length, 0);
    assert.equal(audited(audit).length, 0);
  } finally {
    await env.cleanup();
  }
});

// ---------------------------------------------------------------------------------------------------------------- what runs
test("it is not a table entry: no /api/action or /api/spend id reaches it; resolve gives the one tick call and run refuses a role or an id that is not valid", async () => {
  assert.equal(BY_ID.has(RECORD_CLOSE_ID), false);
  assert.ok(resolve(RECORD_CLOSE_ID, {}), "precheck may look it up");
  const env = makeEnv();
  try {
    const { executor } = bobExec(env);
    for (const x of [{}, { role: "bob" }, { txid: TX }, { role: "carol", txid: TX }, { role: "bob", txid: `0x${TX}` }, { role: "bob", txid: TX.toUpperCase() }, { role: "bob", txid: "--apply" }]) {
      const r = await executor.run({ id: RECORD_CLOSE_ID, group: "record", role: "bob" }, x);
      assert.equal(r.refused, true, JSON.stringify(x));
      assert.equal(r.code, null);
    }
    assert.equal(env.steps.calls.length, 0, "no step ran");
  } finally {
    await env.cleanup();
  }
});

test("a recording: one tick of the swap's own role with `--apply --closed-by TXID` and nothing else; no passphrase asked by the executor, no gate, no latch, no spend; a signal (it sends nothing)", async () => {
  const env = makeEnv();
  try {
    const { sw, executor } = bobExec(env, "bob");
    env.steps.results.tick = recordedTick("bob");
    const r = await executor.recordClose(`0x${TX}`);
    assert.equal(r.status, 200);
    assert.equal(r.recorded, true);
    assert.equal(r.txid, TX, "the bare form is what was passed on");
    assert.equal(r.phase_after, "claim_included");
    assert.equal(env.steps.calls.length, 1);
    const c = env.steps.calls[0];
    assert.equal(c.name, "tick");
    assert.deepEqual(c.args, ["bob", { args: ["--apply", "--closed-by", TX] }]);
    assert.equal(c.role, "bob");
    assert.equal(c.runDir, sw.dir);
    assert.equal(c.signal, true, "a step that sends nothing can be stopped");
    assert.equal(env.vault.calls.length, 0, "the stub step did not ask the vault: the executor never does");
    // Alice's file takes it too (the tool accepts it for her recovery)
    const a = bobExec(env, "alice");
    env.steps.results.tick = recordedTick("alice");
    env.steps.calls.length = 0;
    assert.equal((await a.executor.recordClose(TX)).status, 200);
    assert.deepEqual(env.steps.calls[0].args, ["alice", { args: ["--apply", "--closed-by", TX] }]);
  } finally {
    await env.cleanup();
  }
});

test("the argument vector that reaches swap-cli: the step's flag list is exactly --apply and --closed-by once each, and no other flag the tick could take is added (real tick step, stub swap-cli)", async () => {
  const env = makeEnv();
  const h = makeHarness({ settings: { role: "bob" } });
  try {
    const { executor } = bobExec(env, "bob");
    env.steps.results.tick = recordedTick("bob");
    await executor.recordClose(TX);
    const given = env.steps.calls[0].args[1].args;
    h.swapFile("bob");
    h.scenario({ swapCli: { tick: { stdout: "{}\n" } } });
    await tick(h.ctx, "bob", { args: given });
    const argv = h.calls("swapCli")[0].argv;
    assert.equal(argv[0], "tick");
    const tail = argv.slice(argv.indexOf("--record-eth") + 2);
    assert.deepEqual(tail, ["--apply", "--closed-by", TX], "after the standard flags, only the two");
    assert.equal(argv.filter((a) => a === "--apply").length, 1);
    assert.equal(argv.filter((a) => a === "--closed-by").length, 1);
    for (const f of ["--observe-only", "--submit", "--replace", "--cancel", "--accept-producer-concentration", "--single-node-ok"]) assert.equal(argv.includes(f), false, f);
  } finally {
    h.cleanup();
    await env.cleanup();
  }
});

// ---------------------------------------------------------------------------------------------------------------- audit
test("the audit: a start line with the txid before anything runs, an end line with the outcome; a refusal before the tool is one line", async () => {
  const env = makeEnv();
  try {
    const { executor, audit } = bobExec(env);
    // the start line is on disk when the step runs
    let atStep = null;
    env.steps.results.tick = (ctx) => {
      atStep = audited(audit).map((r) => [r.phase, r.tx]);
      return recordedTick("bob")(ctx);
    };
    await executor.recordClose(TX);
    assert.deepEqual(atStep, [["start", TX]]);
    const lines = audited(audit);
    assert.deepEqual(lines.map((r) => [r.phase, r.role, r.tx]), [["start", "bob", TX], ["end", "bob", TX]]);
    assert.match(lines[1].result, /^recorded \(exit 0, phase claim_included\)$/);
    assert.equal(audit.verify().ok, true, "the chain is intact");
    // a refusal before the tool: the vault is closed
    env.vaultState.ready = false;
    env.steps.calls.length = 0;
    const r = await executor.recordClose(TX);
    assert.equal(r.status, 409);
    assert.equal(r.tag, "vault");
    assert.equal(env.steps.calls.length, 0);
    const last = audited(audit).at(-1);
    assert.deepEqual([last.phase, last.result, last.tx], ["refused", "refused: vault", TX]);
  } finally {
    await env.cleanup();
  }
});

test("fail closed: if the start line cannot be written, nothing runs", async () => {
  const env = makeEnv();
  try {
    const { sw, executor } = bobExec(env);
    const broken = { append: () => { throw Object.assign(new Error("disk"), { code: "EIO" }); }, all: () => [] };
    const ex = createStepExecutor({ program: env.program, swap: { id: sw.id, dir: sw.dir, settingsSource: createRunJsonSource({ dir: sw.dir }), audit: broken }, steps: env.steps });
    const r = await ex.recordClose(TX);
    assert.equal(r.status, 500);
    assert.match(r.why, /audit log cannot be written/);
    assert.equal(env.steps.calls.length, 0);
    assert.equal(typeof executor.recordClose, "function");
  } finally {
    await env.cleanup();
  }
});

// ---------------------------------------------------------------------------------------------------------------- refusals write nothing
test("the tool refuses: nothing is recorded, the swap's files are not changed, its own words come back, and the end line says so", async () => {
  const env = makeEnv();
  try {
    const { sw, executor, audit } = bobExec(env);
    const refuse = { code: 1, stdout: "[bob] tick exit 1 at 12:00:00\nerror: the instance is still visible on the node: this is not its close\nnoid: tip 280200\napplied: False phase_after: secret_seen\n", stderr: "", files: ["last-tick-bob.json"] };
    env.steps.results.tick = refuse;
    const before = allFiles(sw.dir).filter((f) => !f.file.endsWith("ui-audit.jsonl")).map((f) => [f.file, f.bytes.toString("hex")]);
    const r = await executor.recordClose(TX);
    assert.equal(r.status, 409);
    assert.equal(r.recorded, false);
    assert.equal(r.tag, "tool");
    assert.deepEqual(r.lines, ["error: the instance is still visible on the node: this is not its close"], "the summary of the tick is not a reason");
    assert.match(r.why, /did not record this close\. The swap was not changed\./);
    const after = allFiles(sw.dir).filter((f) => !f.file.endsWith("ui-audit.jsonl")).map((f) => [f.file, f.bytes.toString("hex")]);
    assert.deepEqual(after, before, "no file of the swap changed (the swap file included)");
    const end = audited(audit).at(-1);
    assert.equal(end.phase, "end");
    assert.match(end.result, /^not recorded \(exit 1\): error: the instance is still visible/);
    // exit 0 but the close not in the tick's JSON: not recorded either
    env.steps.results.tick = (ctx) => {
      fs.writeFileSync(path.join(ctx.runDir, "last-tick-bob.json"), JSON.stringify({ closed_by: null, phase_after: "secret_seen" }));
      return { code: 0, stdout: "[bob] tick exit 0 at 12:00:00\nnoid: tip 1\n", stderr: "", files: [] };
    };
    const r2 = await executor.recordClose(TX);
    assert.equal(r2.recorded, false);
    assert.deepEqual(r2.lines, ["The tool ran but did not record this close."]);
    // a close of ANOTHER txid in the file is not this one
    env.steps.results.tick = recordedTick("bob", "cd".repeat(32));
    assert.equal((await executor.recordClose(TX)).recorded, false);
    // a time limit and a tool that cannot be started have words of the program's own
    env.steps.results.tick = { code: 124, stdout: "[bob] tick exit 124 at 12:00:00\n", stderr: "", files: [] };
    assert.deepEqual((await executor.recordClose(TX)).lines, ["The check took too long and was stopped."]);
    env.steps.results.tick = { code: 127, stdout: "", stderr: "", files: [] };
    assert.deepEqual((await executor.recordClose(TX)).lines, ["The program could not start its swap tool."]);
    env.steps.results.tick = { code: 2, stdout: "", stderr: "this run is bob's (run.json role): the alice step is refused. Nothing was done\n", files: [] };
    assert.match((await executor.recordClose(TX)).lines[0], /^this run is bob's/);
    // a step that throws is never a recording, and the words carry no error text
    env.steps.results.tick = () => {
      throw new Error("C:\\secret\\path boom");
    };
    const r3 = await executor.recordClose(TX);
    assert.equal(r3.status, 500);
    assert.equal(r3.recorded, false);
    assert.doesNotMatch(JSON.stringify(r3), /secret|boom/);
  } finally {
    await env.cleanup();
  }
});

test("the executor's own checks refuse before the tool: production, a closed vault, a folder that is not private, the other role's file", async () => {
  const env = makeEnv();
  try {
    const { sw, executor } = bobExec(env);
    env.steps.results.tick = recordedTick("bob");
    env.guard.ok = false;
    let r = await executor.recordClose(TX);
    assert.deepEqual([r.status, r.tag], [409, "folder_guard"]);
    env.guard.ok = true;
    fs.writeFileSync(path.join(sw.dir, "alice.swap.json"), "{}\n");
    r = await executor.recordClose(TX);
    assert.deepEqual([r.status, r.tag], [409, "other_role_file"]);
    fs.rmSync(path.join(sw.dir, "alice.swap.json"));
    fs.writeFileSync(path.join(sw.dir, "run.json"), JSON.stringify({ v: 1, profile: "production", chain_id: 1 }));
    r = await executor.recordClose(TX);
    assert.deepEqual([r.status, r.tag], [409, "production"]);
    assert.equal(env.steps.calls.length, 0, "no step ran for any of them");
  } finally {
    await env.cleanup();
  }
});

// ---------------------------------------------------------------------------------------------------------------- the route
test("POST /api/record-close: 400 for a bad id or any other key, 404 for no such swap, 409 while another step runs, 200 recorded; the busy flag is released; nothing here is a spend", async () => {
  const env = makeEnv();
  try {
    const sw = env.addSwap({ role: "bob" });
    env.swapFile(sw, "bob");
    const { srv, api } = await env.start();
    const swap = srv.swapSet.get(sw.id);
    const post = (body) => api("POST", "/api/record-close", body);
    // the shape (nothing is asked, nothing is logged)
    for (const txid of ["", "0x", TX.slice(1), TX + "0", TX.toUpperCase(), "z".repeat(64), 5, null, [TX]]) {
      const r = await post({ swap: sw.id, txid });
      assert.equal(r.status, 400, JSON.stringify(txid));
    }
    assert.equal((await post({ swap: sw.id })).status, 400);
    for (const extra of [{ role: "alice" }, { apply: true }, { args: ["--submit"] }, { flags: "--replace" }, { id: "send-claim" }, { typed: "x" }]) {
      const r = await post({ swap: sw.id, txid: TX, ...extra });
      assert.equal(r.status, 400, JSON.stringify(extra));
      assert.match(r.body.error, /swap and the transaction id only/);
    }
    assert.equal((await post({ swap: "00".repeat(16), txid: TX })).status, 404);
    assert.equal(env.steps.calls.filter((c) => c.name === "tick" && c.args[1] && c.args[1].args).length, 0);
    assert.equal(swap.audit.all().filter((r) => r.action === RECORD_CLOSE_ID).length, 0);
    // another step is running
    swap.runner.busy = { id: "send-claim", job: 9, started_ms: Date.now() };
    let r = await post({ swap: sw.id, txid: TX });
    assert.equal(r.status, 409);
    assert.match(r.body.error, /Another step of this swap is running/);
    assert.equal(swap.runner.busy.id, "send-claim", "the other step's flag is not touched");
    swap.runner.busy = null;
    // the recording: the flag is held while it runs and released after
    let heldId = null;
    env.steps.results.tick = (ctx) => {
      heldId = swap.runner.busy && swap.runner.busy.id;
      return recordedTick("bob")(ctx);
    };
    r = await post({ swap: sw.id, txid: `0x${TX}` });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body, { ok: true, recorded: true, txid: TX, phase_after: "claim_included" });
    assert.equal(heldId, RECORD_CLOSE_ID);
    assert.equal(swap.runner.busy, null);
    assert.deepEqual(env.steps.calls.filter((c) => c.name === "tick").at(-1).args, ["bob", { args: ["--apply", "--closed-by", TX] }]);
    // the refusal: a 409 with the tool's words, nothing recorded
    env.steps.results.tick = { code: 1, stdout: "[bob] tick exit 1 at 12:00:00\nthe transaction is only in the pool\nnoid: tip 1\n", stderr: "", files: [] };
    r = await post({ swap: sw.id, txid: TX });
    assert.equal(r.status, 409);
    assert.equal(r.body.recorded, false);
    assert.deepEqual(r.body.lines, ["the transaction is only in the pool"]);
    assert.equal(swap.runner.busy, null);
    // the id is no table id: the actions and spends refuse it
    assert.equal((await api("POST", "/api/action", { swap: sw.id, id: RECORD_CLOSE_ID })).status, 400);
    assert.equal((await api("POST", "/api/spend", { swap: sw.id, id: RECORD_CLOSE_ID, typed: "x" })).status, 400);
    // the audit lines are readable by the page's own run payload
    assert.equal((await api("GET", `/api/run?swap=${sw.id}`)).status, 200);
    assert.deepEqual(swap.audit.all().filter((x) => x.action === RECORD_CLOSE_ID).map((x) => x.phase), ["start", "end", "start", "end"]);
  } finally {
    await env.cleanup();
  }
});

test("POST /api/record-close without the key is refused like every request; a swap with no runner is a 409", async () => {
  const env = makeEnv();
  try {
    const sw = env.addSwap({ role: "bob" });
    env.swapFile(sw, "bob");
    const { api } = await env.start();
    const noKey = await api("POST", "/api/record-close", { swap: sw.id, txid: TX }, { "x-swap-token": "wrong" });
    assert.ok(noKey.status === 401 || noKey.status === 403);
    assert.equal(env.steps.calls.length, 0);
  } finally {
    await env.cleanup();
  }
});

// ---------------------------------------------------------------------------------------------------------------- the page
const SB = F.SWAP_B;
const SA = F.SWAP_A;
const lateOf = (phase) => ({ phase, blocks: 11, first_tip: 280000 });
const lateBob = (phase = "secret_seen", extra = {}) => (r) =>
  cardPayload(r, { phase, tick: { lock: mkLock({ claimed: true }), eth: { claimed: { lock_id: "0x1", preimage: "0x" + "5e".repeat(32) } } }, autopilot: { alice: null, bob: ON("bob", { late_claim: lateOf(phase) }) }, ...extra });
const RC_LABEL = "Record a close made elsewhere";
const rcButtons = (page) => page.byId("pg-card").all((n) => n.tag === "button" && squash(textOf(n)) === RC_LABEL);
const dialogOf = (page) => page.document.body.all((n) => n.tag === "dialog")[0] || null;
const btnIn = (root, text) => root.all((n) => n.tag === "button" && squash(textOf(n)) === text)[0] || null;

test("the action is drawn on Bob's card when it needs a look or the late-claim box is up (quiet, outside the late box), and in no other state", async () => {
  // a late claim: the button is on the card, not in the late box (that box has no button)
  const late = await openSwap(SB, lateBob());
  assert.equal(rcButtons(late).length, 1);
  assert.ok(has(rcButtons(late)[0], "ghost") && !has(rcButtons(late)[0], "primary"), "a quiet button");
  assert.equal(late.byId("pg-card").all((n) => has(n, "late-claim"))[0].all((n) => n.tag === "button").length, 0);
  assert.equal(rcButtons(await openSwap(SB, lateBob("claim_submitted"))).length, 1);
  // a card that needs a look (a state the program does not know)
  const look = await openSwap(SB, (r) => cardPayload(r, { phase: "zzz_unknown" }));
  assert.match(squash(look.text("pg-headline")), /Something needs a look/);
  assert.equal(rcButtons(look).length, 1);
  // a look in a state the tool cannot record a close in (a stale reading of "locked"): not offered
  const stale = await openSwap(SB, (r) => {
    const p = cardPayload(r, { phase: "locked", tick: { lock: mkLock({}) } });
    p.roles.bob.tick_mtime -= 5000;
    return p;
  });
  assert.match(squash(stale.text("pg-headline")), /Something needs a look/);
  assert.equal(rcButtons(stale).length, 0);
  // a calm card of Bob, and Alice's cards (a look and a calm one)
  assert.equal(rcButtons(await openSwap(SB, (r) => cardPayload(r, { phase: "locked", tick: { lock: mkLock({}) } }))).length, 0);
  assert.equal(rcButtons(await openSwap(SA, (r) => cardPayload(r, { phase: "zzz_unknown" }))).length, 0);
  assert.equal(rcButtons(await openSwap(SA, (r) => cardPayload(r, { phase: "created" }))).length, 0);
  // no swap file yet: nothing to record in
  const bare = await openSwap(SB, (r) => {
    const p = cardPayload(r, { phase: "zzz_unknown" });
    p.actions.wallet.roles.bob.swap_file = false;
    p.roles = { alice: null, bob: null }; // no tick either: the swap file does not exist
    return p;
  });
  assert.equal(rcButtons(bare).length, 0);
  // another step is running: shown, disabled, with the reason
  const busy = await openSwap(SB, lateBob("secret_seen", { run: { busy: { id: "send-claim", job: 3, started_at: 1 } } }));
  const b = rcButtons(busy)[0];
  assert.equal(b.disabled, true);
  assert.match(busy.byId("pg-card").all((n) => n.attrs.id === "rc-why")[0].textContent, /Another step of this swap is running/);
});

test("the dialog: the plain line, one field, nothing is asked before the button; Cancel closes it; an id that is not 64 digits is said so in the dialog and sends nothing", async () => {
  const page = await openSwap(SB, lateBob());
  await rcButtons(page)[0].click();
  const dlg = dialogOf(page);
  assert.ok(dlg && dlg.open, "a modal dialog");
  assert.equal(dlg.getAttribute("aria-labelledby"), "rc-title");
  const t = squash(textOf(dlg));
  assert.match(t, /^Record a close made elsewhere The program asks the Parano1d node about this transaction and records it only if it is the close of this swap, paid to your address, and final \(about 18 blocks, 9 minutes, after it is mined\)\. Nothing is sent\. Close transaction id/);
  const input = dlg.all((n) => n.tag === "input")[0];
  assert.equal(dlg.all((n) => n.tag === "input").length, 1, "one field");
  assert.equal(dlg.all((n) => n.tag === "label")[0].getAttribute("for"), input.getAttribute("id"));
  assert.equal(page.calls.filter((c) => c.method === "POST").length, 0, "nothing was asked on opening");
  const go = btnIn(dlg, "Record the close");
  // empty, short, non-hex: said in words, no request
  for (const v of ["", "abc", "z".repeat(64), TX + "0"]) {
    input.value = v;
    await go.click();
    await page.flush();
    assert.match(squash(textOf(dlg.all((n) => n.attrs.id === "rc-out")[0])), /A transaction id is 64 characters, 0 to 9 and a to f/, JSON.stringify(v));
  }
  assert.equal(page.calls.filter((c) => c.url.includes("record-close")).length, 0);
  await btnIn(dlg, "Cancel").click();
  assert.equal(dialogOf(page), null, "closed and removed");
});

test("the dialog: a good id (pasted with spaces, in capitals, with 0x) is sent once as { swap, txid } and nothing else; the answer 'recorded' is said in the dialog", async () => {
  const sent = [];
  const page = await openSwap(SB, lateBob(), {
    "POST /api/record-close": (u, body) => {
      sent.push(body);
      return { status: 200, body: { ok: true, recorded: true, txid: TX, phase_after: "claim_included" } };
    },
  });
  await rcButtons(page)[0].click();
  const dlg = dialogOf(page);
  const input = dlg.all((n) => n.tag === "input")[0];
  input.value = `  0X${TX.toUpperCase().slice(0, 30)} ${TX.toUpperCase().slice(30)}\n`;
  const reads = () => page.calls.filter((c) => c.method === "GET" && c.url.includes("/api/run")).length;
  const readsBefore = reads();
  await btnIn(dlg, "Record the close").click();
  await page.flush();
  assert.ok(reads() > readsBefore, "after Recorded the page loads the swap again at once (it does not wait for the next poll)");
  assert.deepEqual(sent, [{ swap: SB, txid: `0x${TX}` }]);
  const call = page.calls.filter((c) => c.url.includes("record-close"))[0];
  assert.equal(call.method, "POST");
  assert.equal(call.headers["content-type"], "application/json");
  assert.ok(call.headers["x-swap-token"]);
  assert.match(squash(textOf(dlg)), /Recorded\. The swap file now holds this close; this page shows the swap's new state now\./);
  assert.equal(btnIn(dlg, "Close").tag, "button");
  await btnIn(dlg, "Close").click();
  assert.equal(dialogOf(page), null);
});

test("the dialog: when the tool refuses, its own words are shown (through the plain-engine helper), the swap is said to be unchanged, and the dialog stays for another try; a lost connection is said too", async () => {
  let answer = { status: 409, body: { error: "The program did not record this close. The swap was not changed.", recorded: false, lines: ["ALERT: the close is not final yet: 7 of 18 blocks (before D)"] } };
  const page = await openSwap(SB, lateBob(), { "POST /api/record-close": () => answer });
  await rcButtons(page)[0].click();
  const dlg = dialogOf(page);
  const input = dlg.all((n) => n.tag === "input")[0];
  input.value = TX;
  await btnIn(dlg, "Record the close").click();
  await page.flush();
  const out = squash(textOf(dlg.all((n) => n.attrs.id === "rc-out")[0]));
  assert.match(out, /The program did not record this close\. The swap was not changed\./);
  assert.match(out, /The close is not final yet: 7 of 18 blocks \(before the deadline\)/, "ALERT: is dropped and 'before D' says 'before the deadline'");
  assert.doesNotMatch(out, /ALERT/);
  assert.match(out, /Try again once it is final./, "the not-final refusal has a next step");
  assert.equal(dlg.open, true, "still open");
  assert.equal(input.disabled, false);
  assert.equal(btnIn(dlg, "Record the close").disabled, false, "the person can press it again");
  // a 400 and a lost connection
  answer = { status: 400, body: { error: "A transaction id is 64 characters, 0 to 9 and a to f, in lower case (it may start with 0x)." } };
  await btnIn(dlg, "Record the close").click();
  await page.flush();
  assert.match(squash(textOf(dlg.all((n) => n.attrs.id === "rc-out")[0])), /A transaction id is 64 characters/);
  assert.doesNotMatch(squash(textOf(dlg.all((n) => n.attrs.id === "rc-out")[0])), /Try again once it is final/, "only the not-final refusal says it");
  answer = null;
  page.window.fetch = async () => {
    throw new Error("offline");
  };
  await btnIn(dlg, "Record the close").click();
  await page.flush();
  assert.match(squash(textOf(dlg.all((n) => n.attrs.id === "rc-out")[0])), /The program could not be reached\. Nothing was recorded\./);
});

test("the page code: the one request is the record-close route with the swap and the id; no other flag or field can be added by the page", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "stagecard.js"), "utf8");
  const i = src.indexOf("async function rcPost");
  const body = src.slice(i, src.indexOf("}\n\n", i) + 1);
  assert.match(body, /fetch\("\/api\/record-close", \{ method: "POST"/);
  assert.match(body, /JSON\.stringify\(\{ swap: swapId, txid \}\)/);
  assert.equal(TXT.length, 66);
});
