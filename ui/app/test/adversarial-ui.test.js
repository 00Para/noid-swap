"use strict";
// Adversarial and property tests for UI decimal formatting, strict invitation JSON parsing, and bounded-send clock guards.
const test = require("node:test");
const assert = require("node:assert/strict");
const { Duplex } = require("node:stream");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const inv = require("../lib/invitation");
const bs = require("../../../eth/scripts/bounded-send");
const { makeSettings, BOB_ETH } = require("./steps-fixtures/settings");

const CONTRACT = "0x48Ce4D6cf3c175737532017e82B9261b51F8E5eF";
const BOB = makeSettings({ role: "bob", contract: CONTRACT, alice_noid: null, alice_eth: null, bob_eth: null });

function loadActionsHelpers() {
  const src = fs.readFileSync(path.join(__dirname, "..", "actions.js"), "utf8");
  const ctx = {
    window: {},
    document: { querySelectorAll: () => [] },
    navigator: {},
    URLSearchParams,
    console,
    Date,
    Math,
    BigInt,
    Number,
    String,
    Object,
    Array,
    RegExp,
    Error,
    JSON,
    Promise,
    setTimeout: () => 0,
    clearTimeout: () => {},
  };
  ctx.self = ctx.window;
  vm.createContext(ctx);
  vm.runInContext(src, ctx, { filename: "actions.js" });
  return ctx.window.NoidActions.card;
}

function parseExactDecimalToAtoms(str, places) {
  const clean = str.replace(/,/g, "");
  assert.match(clean, /^(0|[1-9][0-9]*)(\.[0-9]+)?$/, `bad decimal format: ${str}`);
  const [w, f = ""] = clean.split(".");
  assert.ok(f.length <= places, `too many decimal digits in ${str}`);
  if (f.length > 0) assert.ok(!f.endsWith("0"), `trailing zero left in ${str}`);
  return BigInt(w) * 10n ** BigInt(places) + BigInt(f.padEnd(places, "0"));
}

test("property: noidFigure and ethFigure preserve precision across 200+ edge values without digit truncation", () => {
  const C = loadActionsHelpers();
  const noidSamples = [
    0n, 1n, 9n, 10n, 50n, 99n, 100n, 101n, 500_000n, 500_001n, 999_999n,
    1_000_000n, 1_000_001n, 1_000_010n, 1_000_100n, 1_001_000n, 1_010_000n, 1_100_000n,
    5_009_000n, 5_009_001n, 9_994_200n, 10_000_000n, 20_000_000n, 2_500_000_000n,
  ];
  let seed = 0x12345678n;
  for (let i = 0; i < 120; i++) {
    seed = (seed * 6364136223846793005n + 1442695040888963407n) & ((1n << 64n) - 1n);
    noidSamples.push(seed % 5_000_000_000n);
  }
  for (const atoms of noidSamples) {
    const formatted = C.noidFigure(String(atoms));
    const roundtrip = parseExactDecimalToAtoms(formatted, 6);
    assert.equal(roundtrip, atoms, `noidFigure(${atoms}) -> ${formatted} != ${atoms}`);
  }

  const ethSamples = [
    0n, 1n, 10n, 1_000_000_000n, 10_000_000_000_000n, 500_000_000_000_000n,
    1_000_000_000_000_000n, 1_234_567_890_123_456n, 500_000_000_000_000_000n,
    1_000_000_000_000_000_000n, 1_000_000_000_000_000_001n, 1_500_000_000_000_000_000n,
  ];
  for (let i = 0; i < 100; i++) {
    seed = (seed * 6364136223846793005n + 1442695040888963407n) & ((1n << 64n) - 1n);
    ethSamples.push(seed % 2_000_000_000_000_000_000n);
  }
  for (const wei of ethSamples) {
    const formatted = C.ethFigure(String(wei));
    const roundtrip = parseExactDecimalToAtoms(formatted, 6);
    const expectedMicroEth = (wei + 10n ** 12n - 1n) / 10n ** 12n;
    assert.equal(roundtrip, expectedMicroEth, `ethFigure(${wei}) -> ${formatted} != ceil6(${wei})`);
  }
});

test("adversarial: invitation parser rejects prototype pollution, BOM, duplicate keys, and cap overflows", () => {
  const raw = inv.build(BOB, BOB_ETH);
  assert.equal(inv.parse(raw).ok, true);
  assert.equal(inv.parse(raw.replace("{", '{"__proto__":{},')).ok, false);
  assert.equal(inv.parse(raw.replace("{", '{"constructor":{},')).ok, false);
  assert.equal(inv.parse(raw.replace('"v": 1,', '"v": 1, "v": 1,')).ok, false);
  assert.equal(inv.parse(raw + " trailing").ok, false);
  assert.equal(inv.parse("\ufeff" + raw).ok, false);
  assert.equal(inv.parse(raw.replace('"5000000"', '"20000001"')).ok, false);
  assert.equal(inv.parse(raw.replace('"5000000"', '"-1"')).ok, false);
  assert.equal(inv.parse(raw.replace('"5000000"', '5000000')).ok, false);
  assert.equal(inv.parse(raw.replace('"sepolia"', '"rehearsal"')).ok, false);
});

test("adversarial: bounded-send flush guard rejects 12 s clock jump and cutoff check throws before any byte writes", async () => {
  const makeFakeStream = () => {
    const written = [];
    const s = new Duplex({
      read() {},
      write(chunk, _enc, cb) {
        written.push(chunk);
        cb();
      },
    });
    s.written = written;
    s.setNoDelay = () => {};
    s.setKeepAlive = () => {};
    s.resetAndDestroy = () => s.destroy();
    return s;
  };

  const baseCutoff = 1_700_000_100;
  const baseTimelock = baseCutoff + 1800;
  assert.equal(bs.sendWindowVerdict({ cutoffS: baseCutoff, timelockS: baseTimelock, wallNow: () => baseCutoff * 1000, monoNow: () => 0 }).ok, false);
  assert.equal(bs.sendWindowVerdict({ cutoffS: baseCutoff, timelockS: baseTimelock, wallNow: () => (baseCutoff - 5) * 1000, monoNow: () => 0 }).ok, false);
  assert.equal(bs.sendWindowVerdict({ cutoffS: baseCutoff, timelockS: baseTimelock, wallNow: () => (baseCutoff - 600) * 1000, monoNow: () => 0 }).ok, true);

  let mono = 1000;
  let wall = 1_700_000_000_000;
  let wallReads = 0;
  const streamA = makeFakeStream();
  bs.setSendTimingForTests({ connectMs: 1000, tailMs: 2_000, guardMs: 100, closeWaitMs: 200, clockJumpMs: 5_000 });
  bs.setSendHooksForTests({
    monoNow: () => mono,
    wallNow: () => {
      wallReads++;
      // Read 1 captures tWriteWall; read 2 runs inside the pre-flush socket guard (simulate 12 s suspend)
      return wallReads >= 2 ? wall + 12_000 : wall;
    },
    connect: () => {
      process.nextTick(() => streamA.emit("connect"));
      return streamA;
    },
  });
  try {
    const conn = await bs.openBoundedConnection("http://127.0.0.1:8545");
    const res = await conn.sendOnce({
      rawTx: "0x02f800",
      expectedHash: "0x" + "11".repeat(32),
      check: () => {},
    });
    assert.equal(res.outcome, "not_sent");
    assert.equal(res.stage, "late");
    assert.equal(streamA.written.length, 0, "no bytes may flush after a 12 s clock jump");

    const streamB = makeFakeStream();
    bs.setSendHooksForTests({
      monoNow: () => 1000,
      wallNow: () => 1_700_000_000_000,
      connect: () => {
        process.nextTick(() => streamB.emit("connect"));
        return streamB;
      },
    });
    const connB = await bs.openBoundedConnection("http://127.0.0.1:8545");
    let checksB = 0;
    const resB = await connB.sendOnce({
      rawTx: "0x02f800",
      expectedHash: "0x" + "22".repeat(32),
      check: () => {
        checksB++;
        if (checksB >= 2) throw new Error("past reveal cutoff");
      },
    });
    assert.equal(resB.outcome, "not_sent");
    assert.equal(resB.stage, "late");
    assert.equal(streamB.written.length, 0);
  } finally {
    bs.setSendHooksForTests(null);
    bs.setSendTimingForTests(null);
  }
});
