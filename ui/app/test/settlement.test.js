"use strict";
// The facts of the done card (lib/settlement.js): the fee sums from fixture receipts and report files, "still reading" with one receipt missing, the settled note written once and never with a guessed time.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const S = require("../lib/settlement");
const { AuditLog } = require("../lib/audit");

const H1 = "0x" + "a1".repeat(32);
const H2 = "0x" + "b2".repeat(32);
const H3 = "0x" + "c3".repeat(32);
const TXID = (c) => c.repeat(64);

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "no1d-settle-"));
const until = async (f, what) => {
  for (let i = 0; i < 200; i++) {
    if (f()) return;
    await new Promise((r) => setImmediate(r));
  }
  throw new Error(`timed out: ${what}`);
};

function fakeAudit(recs) {
  return { all: () => recs, append(r) { recs.push({ t: "2026-11-20T12:00:00Z", ...r }); } };
}
const end = (action, tx, t, result = "ok (exit 0)") => ({ t, action, role: null, phase: "end", result, tx });
const start = (action, t) => ({ t, action, phase: "start", result: "started" });

const SETTINGS = { eth_rpc: "https://node.example", gas_price_gwei: "1", amount_micronoid: "5000000", amount_wei: "1000000000000000", role: "alice" };
const runDone = (role = "alice", extra = {}) => ({ roles: { [role]: { tick: { phase_after: "done" }, loop: null, loop_mtime: null, ...extra } } });

function aliceDir() {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, "wallet-fund-120000.json"), JSON.stringify({ step: "fund", outcome: "sent", txid: TXID("1"), fee_micronoid: 9000 }));
  fs.writeFileSync(path.join(dir, "wallet-fund-dry-115900.json"), JSON.stringify({ step: "fund", outcome: "dry_run", txid: TXID("9"), fee_micronoid: 7777 }));
  return dir;
}

const recordsAlice = () => [start("send-fund", "2026-11-20T10:00:00Z"), end("send-reveal", H1, "2026-11-20T10:40:00Z"), end("send-sweep-eth-alice", H2, "2026-11-20T10:50:00Z"), { t: "2026-11-20T10:49:30Z", action: "settlement", phase: "note", result: "settled at 2026-11-20T10:49:00Z" }];
const marker = (names) => (n) => (names.includes(n) ? "2026-11-20T10:50:00Z" : null);

test("Alice: the fee sum is the reveal's receipt fee plus the sweep's own receipt fee (gas used times the price paid), plus the funding's NOID fee; a dry run's report is not counted", async () => {
  const dir = aliceDir();
  const receipts = { [H1]: { fee_wei: (689324n * 350000000n).toString() }, [H2]: { fee_wei: (21000n * 300000000n).toString() } };
  const calls = [];
  const st = S.createSettlement({ readReceipt: async (rpc, h) => (calls.push([rpc, h]), receipts[h] || null) });
  const input = { dir, role: "alice", settings: SETTINGS, audit: fakeAudit(recordsAlice()), run: runDone(), marker: marker(["wallet-swept-eth-alice.marker"]) };
  let v = st.view(input);
  assert.equal(v.state, "reading");
  assert.equal(v.receipts_pending, 2);
  assert.equal(v.fees, null);
  await until(() => [...st.receipts.values()].every((e) => e.state === "ok"), "receipts");
  v = st.view(input);
  assert.equal(v.state, "ready");
  assert.equal(v.complete, true);
  assert.equal(v.fees.eth_wei, (689324n * 350000000n + 21000n * 300000000n).toString(), "the sweep counts at its receipt fee like every other transaction, not at a fixed gas times the cap");
  assert.equal(v.fees.noid_micro, "9000");
  assert.ok(v.fees.share_bp > 0);
  assert.equal(v.time_min, 49);
  assert.equal(v.settled_at, "2026-11-20T10:49:00Z");
  // read once and kept by hash: a second view asks nobody
  st.view(input);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0][0], "https://node.example");
});

test("with one receipt missing the fees stay null and the page reads 'still reading'; a failed read is retried later and flagged", async () => {
  const dir = aliceDir();
  let t = 1_000_000;
  const st = S.createSettlement({ now: () => t, readReceipt: async (rpc, h) => (h === H1 ? { fee_wei: "1000" } : null) });
  const input = { dir, role: "alice", settings: SETTINGS, audit: fakeAudit(recordsAlice()), run: runDone(), marker: marker(["wallet-swept-eth-alice.marker"]) };
  st.view(input);
  await until(() => st.receipts.get(H1) && st.receipts.get(H1).state === "ok" && st.receipts.get(H2).state === "unmined", "reads");
  const v = st.view(input);
  assert.equal(v.state, "reading");
  assert.equal(v.fees, null);
  assert.equal(v.receipts_pending, 1);
  t += 61000; // the retry
  const failing = S.createSettlement({ now: () => t, readReceipt: async () => { throw new Error("down"); } });
  // (a fresh folder: the first reader kept the fee of H1 in settlement.json, and a kept fee is not asked for again)
  const input2 = { ...input, dir: aliceDir() };
  failing.view(input2);
  await until(() => [...failing.receipts.values()].every((e) => e.state === "fail"), "failure");
  assert.equal(failing.view(input2).receipts_failed, true);
  assert.equal(failing.view(input2).fees, null);
});

test("L6 (fix round 2): each receipt's fee is kept in settlement.json beside the swap after its first read, and a restart does not ask the node again", async () => {
  const dir = aliceDir();
  const receipts = { [H1]: { fee_wei: "241256400000000" }, [H2]: { fee_wei: "6300000000000" } };
  const calls = [];
  const input = { dir, role: "alice", settings: SETTINGS, audit: fakeAudit(recordsAlice()), run: runDone(), marker: marker(["wallet-swept-eth-alice.marker"]) };
  const first = S.createSettlement({ readReceipt: async (rpc, h) => (calls.push(h), receipts[h] || null) });
  first.view(input);
  await until(() => [...first.receipts.values()].every((e) => e.state === "ok"), "receipts");
  assert.equal(calls.length, 2);
  const file = path.join(dir, "settlement.json");
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { v: 1, fees: { [H1]: "241256400000000", [H2]: "6300000000000" } });
  assert.ok(!fs.readdirSync(dir).some((n) => n.startsWith("settlement.json.tmp")), "the temporary file was renamed over");
  if (process.platform !== "win32") assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  // a new program (a restart): the kept fees answer, the node is not asked
  const again = [];
  const second = S.createSettlement({ readReceipt: async (rpc, h) => (again.push(h), null) });
  const v = second.view(input);
  assert.deepEqual(again, []);
  assert.equal(v.state, "ready");
  assert.equal(v.fees.eth_wei, (241256400000000n + 6300000000000n).toString());
  // a hash that is not kept is asked for, and kept next to the others
  const third = S.createSettlement({ readReceipt: async (rpc, h) => (again.push(h), { fee_wei: "5" }) });
  const recs = [...recordsAlice(), end("send-reveal-replace", H3, "2026-11-20T10:45:00Z")];
  third.view({ ...input, audit: fakeAudit(recs) });
  await until(() => third.receipts.get(H3) && third.receipts.get(H3).state === "ok", "the new hash");
  assert.deepEqual(again, [H3]);
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(file, "utf8")).fees).sort(), [H1, H2, H3].sort());
});

test("L6: a kept-fees file that is damaged, linked, too large or of another shape is ignored (the node is asked), and never stops the read", async () => {
  for (const bad of ["not json", "{}", JSON.stringify({ v: 2, fees: {} }), JSON.stringify({ v: 1, fees: { [H1]: "-5", [H2]: 7, nothex: "1" } }), JSON.stringify({ v: 1, fees: [] }), "x".repeat(70000)]) {
    const dir = aliceDir();
    fs.writeFileSync(path.join(dir, "settlement.json"), bad);
    const asked = [];
    const st = S.createSettlement({ readReceipt: async (rpc, h) => (asked.push(h), { fee_wei: "9" }) });
    st.view({ dir, role: "alice", settings: SETTINGS, audit: fakeAudit(recordsAlice()), run: runDone(), marker: marker(["wallet-swept-eth-alice.marker"]) });
    await until(() => [...st.receipts.values()].every((e) => e.state === "ok"), "receipts");
    assert.deepEqual(asked.sort(), [H1, H2].sort(), bad.slice(0, 20));
    // and what is kept afterwards is well formed again
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "settlement.json"), "utf8")).v, 1);
  }
  // an unwritable folder: the read still works (kept in memory only)
  const st = S.createSettlement({ readReceipt: async () => ({ fee_wei: "9" }) });
  st.view({ dir: path.join(tmp(), "missing"), role: "alice", settings: SETTINGS, audit: fakeAudit(recordsAlice()), run: runDone(), marker: marker([]) });
  await until(() => [...st.receipts.values()].every((e) => e.state === "ok"), "receipts in memory");
});

test("L6: the default receipt reader refuses a redirect (the hash is not sent on) and an answer above 64 KiB, and reads a normal answer", async () => {
  const http = require("http");
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      seen.push(req.url);
      if (req.url === "/redirect") {
        res.writeHead(307, { location: `http://127.0.0.1:${server.address().port}/elsewhere` });
        return res.end();
      }
      if (req.url === "/elsewhere") return res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: null }));
      if (req.url === "/big") {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { pad: "x".repeat(70000) } }));
      }
      if (req.url === "/stream") {
        res.writeHead(200, { "content-type": "application/json" });
        res.write("{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{\"pad\":\"");
        const chunk = "y".repeat(8192);
        let n = 0;
        const t = setInterval(() => {
          if (res.destroyed || ++n > 20) {
            clearInterval(t);
            return res.destroyed ? null : res.end("\"}}");
          }
          res.write(chunk);
        }, 1);
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { gasUsed: "0x5208", effectiveGasPrice: "0x3b9aca00", status: "0x1" } }));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.deepEqual(await S.fetchReceipt(`${base}/ok`, H1), { fee_wei: String(21000n * 1000000000n) });
    await assert.rejects(S.fetchReceipt(`${base}/redirect`, H1));
    assert.ok(!seen.includes("/elsewhere"), "the redirect was not followed");
    await assert.rejects(S.fetchReceipt(`${base}/big`, H1), /too large/);
    await assert.rejects(S.fetchReceipt(`${base}/stream`, H1), /too large/);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test("Alice is complete only with the ETH sweep marker; before it the sweep is 'sent' once its step has started and nothing is re-sent by this module", () => {
  const dir = aliceDir();
  const recs = [start("send-fund", "2026-11-20T10:00:00Z"), end("send-reveal", H1, "2026-11-20T10:40:00Z"), start("send-sweep-eth-alice", "2026-11-20T10:49:00Z")];
  const st = S.createSettlement({ readReceipt: async () => null });
  const v = st.view({ dir, role: "alice", settings: SETTINGS, audit: fakeAudit(recs), run: runDone(), marker: marker([]) });
  assert.equal(v.complete, false);
  assert.equal(v.sweep_done, false);
  assert.equal(v.sweep_sent, true);
  assert.equal(v.fees, null);
  assert.equal(v.state, "reading");
  // not done: nothing at all
  const notDone = st.view({ dir, role: "alice", settings: SETTINGS, audit: fakeAudit(recs), run: { roles: { alice: { tick: { phase_after: "revealed" } } } }, marker: marker([]) });
  assert.equal(notDone.state, "none");
  assert.equal(notDone.complete, false);
});

test("Bob: complete at done; his fees are the lock and the sweep receipts and the claim's NOID fee from the claim report", async () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, "claim-120003.out"), JSON.stringify({ mode: "dry_run", submitted: false, plan: { txid: TXID("4"), fee_micronoid: 1111 } }));
  fs.writeFileSync(path.join(dir, "claim-120100.out"), JSON.stringify({ mode: "submit", submitted: true, plan: { txid: TXID("5"), fee_micronoid: 5800 } }));
  fs.writeFileSync(path.join(dir, "claim-120200.out"), JSON.stringify({ mode: "submit", submitted: true, plan: { txid: TXID("5"), fee_micronoid: 5800 } })); // the same close, sent again
  const recs = [start("send-lock", "2026-11-20T10:00:00Z"), end("send-lock", H1, "2026-11-20T10:01:00Z"), end("send-sweep-eth-bob", H3, "2026-11-20T11:00:00Z"), end("send-refund-eth", "0x" + "d4".repeat(32), "x", "refused, nothing sent")];
  const st = S.createSettlement({ readReceipt: async (rpc, h) => ({ fee_wei: h === H1 ? "5000" : "700" }) });
  const bobSettings = { ...SETTINGS, role: "bob" };
  const input = { dir, role: "bob", settings: bobSettings, audit: fakeAudit(recs), run: runDone("bob"), marker: marker(["wallet-swept-eth-bob.marker"]) };
  assert.equal(st.view(input).complete, true, "Bob is complete at done, before any sweep");
  assert.equal(st.view({ ...input, marker: marker([]) }).complete, true);
  await until(() => [...st.receipts.values()].every((e) => e.state === "ok"), "receipts");
  const v = st.view(input);
  assert.equal(v.fees.noid_micro, "5800", "one close, counted once");
  assert.equal(v.fees.eth_wei, (5000n + 700n).toString());
});

test("the NOID fee is unknown (so the fees are null) when no sent report has one yet, or one has none", () => {
  const dir = tmp();
  assert.equal(S.noidFeeOf(dir, "alice").known, false);
  fs.writeFileSync(path.join(dir, "wallet-fund-1.json"), JSON.stringify({ outcome: "sent", txid: TXID("1") }));
  assert.equal(S.noidFeeOf(dir, "alice").known, false);
  fs.writeFileSync(path.join(dir, "wallet-fund-1.json"), JSON.stringify({ outcome: "sent", txid: TXID("1"), fee_micronoid: 9000 }));
  fs.writeFileSync(path.join(dir, "wallet-sweep-noid-2.json"), JSON.stringify({ outcome: "sent", txid: TXID("2"), fee_micronoid: 5800 }));
  assert.deepEqual(S.noidFeeOf(dir, "alice"), { micro: 14800n, known: true });
});

test("only clean end lines of the role's own Ethereum steps count: a refusal, another role's step and a repeated hash do not", () => {
  const recs = [end("send-reveal", H1, "a"), end("send-reveal", H1, "b"), end("send-reveal-replace", H2, "c", "refused, nothing sent"), end("send-lock", H3, "d"), end("send-sweep-eth-alice", H3, "e"), end("send-claim", "0x" + "e5".repeat(32), "f")];
  assert.deepEqual(S.ethTxs(recs, "alice").map((x) => x.hash), [H1, H3]);
  assert.equal(S.ethTxs(recs, "alice").find((x) => x.hash === H3).sweep, true);
  assert.deepEqual(S.ethTxs(recs, "bob").map((x) => x.hash), [H3]);
});

test("what is left in the swap key shows only from a wallet status read after the sweep, and only when it is not zero", () => {
  const dir = aliceDir();
  const st = S.createSettlement({ readReceipt: async () => null });
  const base = { dir, role: "alice", settings: SETTINGS, audit: fakeAudit(recordsAlice()), run: runDone(), marker: marker(["wallet-swept-eth-alice.marker"]) };
  const at = Date.parse("2026-11-20T10:55:00Z");
  assert.equal(st.view({ ...base, walletStatus: { ok: true, at_ms: at, eth: { balance_wei: "1234" } } }).left_wei, "1234");
  assert.equal(st.view({ ...base, walletStatus: { ok: true, at_ms: at, eth: { balance_wei: "0" } } }).left_wei, null);
  assert.equal(st.view({ ...base, walletStatus: { ok: true, at_ms: Date.parse("2026-11-20T10:40:00Z"), eth: { balance_wei: "1234" } } }).left_wei, null, "a status read before the sweep says nothing");
  assert.equal(st.view({ ...base, walletStatus: { ok: false } }).left_wei, null);
});

test("the settled note: written once, from the loop history's change to done; with no such change in the tail it says the time is not known and never guesses", () => {
  const st = S.createSettlement({ readReceipt: async () => null });
  const loop = { entries: [{ time: "2026-11-20T10:30:00Z", phase_after: "revealed" }, { time: "2026-11-20T10:48:30Z", phase_after: "done" }], total: 2 };
  const run = runDone("alice", { loop, loop_mtime: Date.parse("2026-11-20T10:50:00Z") / 1000 });
  const audit = fakeAudit([]);
  const note = st.settledNote({ role: "alice", run, audit });
  assert.equal(note, "settled at 2026-11-20T10:48:30Z");
  audit.append({ action: "settlement", phase: "note", result: note });
  assert.equal(st.settledNote({ role: "alice", run, audit }), null, "written once");
  // no change in the tail
  const tail = { entries: [{ time: "2026-11-20T10:48:30Z", phase_after: "done" }, { time: "2026-11-20T10:49:00Z", phase_after: "done" }], total: 2 };
  const a2 = fakeAudit([]);
  assert.equal(st.settledNote({ role: "alice", run: runDone("alice", { loop: tail, loop_mtime: 1 }), audit: a2 }), S.SETTLED_UNKNOWN);
  a2.append({ action: "settlement", phase: "note", result: S.SETTLED_UNKNOWN });
  assert.equal(st.settledNote({ role: "alice", run: runDone("alice", { loop: tail, loop_mtime: 1 }), audit: a2 }), null);
  // not done: no note
  assert.equal(st.settledNote({ role: "alice", run: { roles: { alice: { tick: { phase_after: "revealed" } } } }, audit: fakeAudit([]) }), null);
  // an unknown-time note leaves the time row out
  const v = st.view({ dir: tmp(), role: "alice", settings: SETTINGS, audit: fakeAudit([start("send-fund", "2026-11-20T10:00:00Z"), { t: "x", action: "settlement", phase: "note", result: S.SETTLED_UNKNOWN }]), run: runDone(), marker: marker([]) });
  assert.equal(v.time_min, null);
  assert.equal(v.settled_at, null);
});

test("the loop's clock-only times (HH:MM:SS) are read against the loop file's date", () => {
  const mt = new Date(2026, 10, 20, 10, 50, 0).getTime() / 1000;
  const loop = { entries: [{ time: "10:30:00", phase_after: "revealed" }, { time: "10:48:30", phase_after: "done" }], total: 2 };
  const t = S.doneTimeFromLoop({ roles: { alice: { loop, loop_mtime: mt } } }, "alice");
  assert.equal(new Date(t).getHours() * 60 + new Date(t).getMinutes(), 10 * 60 + 48);
  const midnight = { entries: [{ time: "23:58:00", phase_after: "revealed" }, { time: "23:59:30", phase_after: "done" }], total: 2 };
  const m2 = new Date(2026, 10, 21, 0, 1, 0).getTime() / 1000;
  assert.ok(S.doneTimeFromLoop({ roles: { alice: { loop: midnight, loop_mtime: m2 } } }, "alice") < m2 * 1000, "a time just before midnight belongs to the day before the file's");
});

test("works over the real audit log file (the module reads nothing else of it than all())", () => {
  const dir = tmp();
  const audit = new AuditLog(dir);
  audit.append({ action: "send-fund", role: "alice", phase: "start", result: "started" });
  audit.append({ action: "send-reveal", role: "alice", phase: "end", result: "ok (exit 0)", tx: H1 });
  assert.deepEqual(S.ethTxs(audit.all(), "alice").map((x) => x.hash), [H1]);
});
