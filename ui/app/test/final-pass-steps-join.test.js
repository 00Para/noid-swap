"use strict";
// The final-pass fix of `join` (low point R410-2): a refused copy of Alice's file in Bob's run folder no longer blocks the right file. Fails on the code before the fix.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const steps = require("../lib/steps");
const { makeHarness } = require("./steps-fixtures/harness");
const { BOB_ETH, ETH_PAYOUT } = require("./steps-fixtures/settings");

const H = [];
function harness(o) {
  const h = makeHarness(o);
  H.push(h);
  return h;
}
test.after(() => {
  for (const h of H) h.cleanup();
});
const j = (o) => `${JSON.stringify(o, null, 2)}\n`;
const SETUP_STUB = path.join(__dirname, "steps-fixtures", "stub-swap-cli-setup.js");
const withStub = (ctx) => ({ ...ctx, tools: { ...ctx.tools, swapCli: [process.execPath, SETUP_STUB] } });
const BUNDLE_NEW = `${JSON.stringify({ hashlock: `0x${"a".repeat(64)}`, claim_authority: "o1auth", contract_root: "o1root", bob: "o1bob", amount_micronoid: 5000000, params: { profile: "sepolia", deadline_height: 281100, max_fee_micronoid: 55555, eth: { chain_id: 11155111, contract: "0xabc", amount_wei: "1000000000000000", lock_kind: "poseidon" } } })}\n`;
const BUNDLE_OLD = `${BUNDLE_NEW.trim().replace("o1root", "o1oldroot")}\n`;

function joinHarness() {
  const h = harness({ settings: { role: "bob", bob_eth: null } });
  h.write("wallet-addresses.txt", `ROLE=bob\nBOB_ETH=${BOB_ETH}\n`);
  h.write("wallet-setup/eth-key.json", '{"sealed":"k"}\n');
  h.src = path.join(h.root, "src-bundle.json");
  fs.writeFileSync(h.src, BUNDLE_NEW);
  h.scenario({
    swapCli: {
      "new-bob": { stdout: "bundle check: 0123456789abcdef ok\nbundle checked: opening rebuilt byte-for-byte\n", writeOut: '{"phase":"received"}\n' },
      "ethkey address": { stdout: j({ address: BOB_ETH, payout: ETH_PAYOUT, role: "bob" }) },
      status: { stdout: j({ phase: "awaiting_funding", profile: "sepolia", variant: "raw", deadline_height: 281100, lock_by_height: 280600 }) },
    },
  });
  return h;
}
const nb = (h) => h.calls("swapCli").filter((c) => c.argv[0] === "new-bob");
const asides = (h) => fs.readdirSync(h.runDir).filter((f) => f.startsWith("alice.bundle.json.refused-"));

test("R410-2 join: an earlier copy with other content and no swap file of Bob's: it is moved aside (kept), the file given is used, the step says so by file name, new-bob gets the new copy", async () => {
  const h = joinHarness();
  h.write("alice.bundle.json", BUNDLE_OLD);
  const r = await steps.join(withStub(h.ctx), h.src);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  const kept = asides(h);
  assert.equal(kept.length, 1);
  assert.match(kept[0], /^alice\.bundle\.json\.refused-\d{8}T\d{6}Z$/);
  assert.equal(h.read(kept[0]), BUNDLE_OLD, "the earlier copy is kept whole");
  assert.equal(h.read("alice.bundle.json"), BUNDLE_NEW, "the file given is in place");
  assert.ok(r.files.includes(kept[0]));
  const line = r.stdout.split("\n").find((l) => l.includes("was moved aside"));
  assert.ok(line, r.stdout);
  assert.ok(line.includes(kept[0]) && !line.includes(h.runDir), "a file name, not a full path");
  assert.equal(nb(h).length, 1);
  assert.ok(h.exists("bob/bob.swap.json"));
});

test("R410-2 join: two refusals in the same second keep both earlier copies (a counter after the stamp), none is overwritten", async () => {
  const h = joinHarness();
  h.write("alice.bundle.json", BUNDLE_OLD);
  const stamp = new Date(h.ctx.now()).toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  h.write(`alice.bundle.json.refused-${stamp}`, "an even earlier copy\n");
  const r = await steps.join(withStub(h.ctx), h.src);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.equal(h.read(`alice.bundle.json.refused-${stamp}`), "an even earlier copy\n");
  assert.equal(h.read(`alice.bundle.json.refused-${stamp}-2`), BUNDLE_OLD);
});

test("R410-2 join: with Bob's swap file already there the refusal stays: nothing moved, nothing written, new-bob not called", async () => {
  const h = joinHarness();
  h.write("alice.bundle.json", BUNDLE_OLD);
  h.write("bob/bob.swap.json", '{"phase":"received"}\n');
  const r = await steps.join(withStub(h.ctx), h.src);
  assert.notEqual(r.code, 0);
  assert.equal(asides(h).length, 0);
  assert.equal(h.read("alice.bundle.json"), BUNDLE_OLD);
  assert.equal(nb(h).length, 0);
  assert.ok(!r.stdout.includes("was moved aside"));
});

test("R410-2 join: a copy with the same content is not moved; a destination that is not a plain file is still refused (4)", async () => {
  const same = joinHarness();
  same.write("alice.bundle.json", BUNDLE_NEW);
  assert.equal((await steps.join(withStub(same.ctx), same.src)).code, 0);
  assert.equal(asides(same).length, 0);
  const dir = joinHarness();
  fs.mkdirSync(path.join(dir.runDir, "alice.bundle.json"));
  assert.equal((await steps.join(withStub(dir.ctx), dir.src)).code, 4);
  assert.equal(asides(dir).length, 0);
});
