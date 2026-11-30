"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { secretPathReason, redactDeep, hasSecretField, REDACTED } = require("../lib/secrets");
const { loadConfig } = require("../lib/config");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { mkTick, mkLock, FAKE_PREIMAGE } = require("./helpers");

test("secretPathReason refuses swap files, keys, passphrases in either path style", () => {
  const bad = [
    "C:\\runs\\alice.swap.json",
    "/home/u/live-run-4/bob/bob.swap.json",
    "\\\\wsl.localhost\\Ubuntu-24.04\\home\\u\\live-run-4\\alice.swap.json",
    "/home/u/alice.swap.json.lock",
    "/home/u/.alice.swap.json.123.abc.tmp",
    "C:\\repo\\eth\\keys\\bob.key",
    "/home/u/keys/anything.json",
    "/home/u/bob.key",
    "/home/u/server.pem",
    "/home/u/live-run-4/passphrase.txt",
    "C:\\x\\PASSPHRASE.TXT",
  ];
  for (const p of bad) assert.ok(secretPathReason(p), `should refuse ${p}`);
  const good = ["/home/u/live-run-4/last-tick-alice.json", "C:\\runs\\alice.bundle.json", "swap.object.json", "loop-bob.txt", "eth-claim-dry-1.json"];
  for (const p of good) assert.equal(secretPathReason(p), null, `should allow ${p}`);
  assert.equal(secretPathReason(undefined), null);
  assert.match(secretPathReason("x.swap.json"), /sealed secret/);
  assert.match(secretPathReason("a/keys/b.json"), /key material/);
});

test("the old swaps.json loader shares the same refusals (sealed secret, key material, passphrase)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "noid-ui-"));
  const good = { label: "x", role: "alice", eth: { contract: "0x" + "48".repeat(20), lock_id: "0x" + "84".repeat(32) } };
  const write = (n, o) => {
    const p = path.join(dir, n);
    fs.writeFileSync(p, JSON.stringify(o));
    return p;
  };
  assert.throws(() => loadConfig(write("a.json", { swaps: [{ ...good, object_file: "/x/passphrase.txt" }] })), /passphrase/);
  assert.throws(() => loadConfig(write("b.json", { swaps: [{ ...good, bundle_file: "/x/alice.swap.json.lock" }] })), /sealed secret/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("redactDeep strips every place a tick can carry the preimage, and keeps the rest", () => {
  const lock = mkLock({ claimed: true });
  const tick = mkTick({
    phase: "secret_seen",
    lock,
    eth: {
      claimed: { lock_id: lock.lock_id, preimage: FAKE_PREIMAGE, block_number: 9, tx_hash: "0x" + "d3".repeat(32) },
      pending_preimage: { lock_id: lock.lock_id, preimage: FAKE_PREIMAGE, tx_hash: "0x" + "d4".repeat(32) },
    },
    events: [{ event: "eth_preimage_seen", preimage: FAKE_PREIMAGE, tip: 1, time: 2 }, { event: "noid_tx_reorged", txid: "ab", preimage: FAKE_PREIMAGE }],
    action: { action: "claim_noid", call_height: 5, fee_micronoid: 5800, preimage: FAKE_PREIMAGE },
    intent: { status: "held", intent: { action: "claim_noid", params: { preimage: FAKE_PREIMAGE, lock_id: "0x1" }, decided_at: 1 } },
  });
  tick.noid.opening_hex = "4e4f49444f424a33";
  tick.noid.second = { tip: 1, contract_opening_hex: "00" };
  assert.ok(hasSecretField(tick));
  const clean = redactDeep(tick);
  assert.ok(!hasSecretField(clean));
  assert.ok(!JSON.stringify(clean).includes("5e5e5e"));
  assert.ok(!JSON.stringify(clean).includes("4e4f49444f424a33"));
  assert.equal(clean.eth.claimed.preimage, REDACTED);
  assert.equal(clean.eth.claimed.tx_hash, tick.eth.claimed.tx_hash, "public fields stay");
  assert.equal(clean.action.call_height, 5);
  assert.equal(clean.events[0].event, "eth_preimage_seen");
  assert.equal(clean.intent.intent.params.lock_id, "0x1");
  // the original is not mutated
  assert.equal(tick.eth.claimed.preimage, FAKE_PREIMAGE);
  // null stays null (no "withheld" where there was nothing)
  assert.equal(redactDeep({ preimage: null }).preimage, null);
});
