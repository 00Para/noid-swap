"use strict";
// T-B1 & T-B2: backupset inclusion/exclusion table, S2 read order (records first, swap file last),
// S4 pub/ui-audit.jsonl included, and T-B2 step-file coverage check.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const BS = require("../lib/backupset");

const RUN_ID = "0123456789abcdef0123456789abcdef";
const HASHLOCK = "a".repeat(64);
const BOB_ETH = "11223344556677889900aabbccddeeff11223344";
const cleanup = [];
test.after(() => cleanup.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

function mkRun(role = "alice") {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "no1d-bset-"));
  cleanup.push(d);
  fs.mkdirSync(path.join(d, "pub"), { recursive: true });
  fs.mkdirSync(path.join(d, "bob"), { recursive: true });
  fs.writeFileSync(path.join(d, "run.json"), JSON.stringify({ run_id: RUN_ID, role, profile: "sepolia", chain_id: 11155111 }) + "\n");
  const swapPath = role === "alice" ? "alice.swap.json" : "bob/bob.swap.json";
  fs.writeFileSync(
    path.join(d, ...swapPath.split("/")),
    JSON.stringify({
      role,
      phase: { phase: role === "alice" ? "lock_final" : "locked" },
      public: { hashlock: "0x" + HASHLOCK, params: { profile: "sepolia", eth: { chain_id: 11155111, bob_sender: "0x" + BOB_ETH } } },
      history: [{ event: "init" }],
    }) + "\n",
  );
  // Included records & markers + S4 audit log
  fs.writeFileSync(path.join(d, "pub", "ui-audit.jsonl"), '{"action":"test"}\n');
  fs.writeFileSync(path.join(d, "pub", "eth-lock.json"), '{"display":true}\n'); // excluded
  fs.writeFileSync(path.join(d, "alice.bundle.json"), '{"bundle":true}\n');
  fs.writeFileSync(path.join(d, "check-line.json"), '{"v":1}\n');
  fs.writeFileSync(path.join(d, "line-match.json"), '{"v":1}\n');
  if (role === "alice") {
    fs.writeFileSync(path.join(d, "alice.swap.json.reveal-sent"), '{"tx":"0x1"}\n');
    fs.writeFileSync(path.join(d, "alice.swap.json.wallet-fund.json"), '{"txid":"1"}\n');
  } else {
    fs.writeFileSync(path.join(d, "bob", "bob.swap.json.lock-sent"), '{"tx":"0x2"}\n');
    fs.writeFileSync(path.join(d, "bob", "bob.swap.json.producer-differs"), '{"diff":true}\n');
  }
  // Left-out files that must NEVER appear in the backup
  fs.writeFileSync(path.join(d, "autopilot-alice.json"), '{"on":true}\n');
  fs.writeFileSync(path.join(d, "autopilot-bob.json"), '{"on":true}\n');
  fs.writeFileSync(path.join(d, "ui-console.lock"), "123\n");
  fs.writeFileSync(path.join(d, "written-by.json"), '{"v":"0.2.0"}\n');
  fs.writeFileSync(path.join(d, "vault-check.json"), '{"v":1,"check":"0123456789abcdef"}\n');
  fs.writeFileSync(path.join(d, "backup-state.json"), '{"v":1}\n');
  fs.writeFileSync(path.join(d, "restored.json"), '{"v":1}\n');
  fs.writeFileSync(path.join(d, "last-tick-alice.json"), "{}\n");
  fs.writeFileSync(path.join(d, "passphrase.txt"), "never\n");
  return d;
}

test("T-B1 + S4: Alice and Bob snapshots include all required files and pub/ui-audit.jsonl, and omit every excluded file", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "no1d-home-"));
  cleanup.push(home);
  const lockDir = path.join(home, ".noid-swap", "lock-sent");
  fs.mkdirSync(lockDir, { recursive: true });
  const lockFile = `11155111-${BOB_ETH}-${HASHLOCK}.json`;
  fs.writeFileSync(path.join(lockDir, lockFile), '{"sent":true}\n');

  for (const role of ["alice", "bob"]) {
    const dir = mkRun(role);
    const snap = BS.readSnapshot(dir, role, { homeDir: home });
    assert.ok(snap);
    const paths = snap.files.map((f) => f.path);
    assert.ok(paths.includes("run.json"));
    assert.ok(paths.includes(role === "alice" ? "alice.swap.json" : "bob/bob.swap.json"));
    assert.ok(paths.includes("pub/ui-audit.jsonl"), "S4: audit log must be included");
    assert.ok(!paths.includes("pub/eth-lock.json"), "other pub/ files must be excluded");
    for (const forbidden of ["autopilot-alice.json", "autopilot-bob.json", "ui-console.lock", "written-by.json", "vault-check.json", "backup-state.json", "restored.json", "last-tick-alice.json", "passphrase.txt"]) {
      assert.ok(!paths.includes(forbidden), `${forbidden} must not be backed up`);
    }
    assert.equal(snap.home.length, 1);
    assert.equal(snap.home[0].path, `lock-sent/${lockFile}`);
    // S2: swap file must be the LAST file read
    assert.equal(paths[paths.length - 1], role === "alice" ? "alice.swap.json" : "bob/bob.swap.json");
  }
});

test("S2: readSnapshot reads record files BEFORE the swap file", () => {
  const dir = mkRun("alice");
  const readOrder = [];
  const spyFs = {
    ...fs,
    readFileSync(p, ...rest) {
      readOrder.push(path.relative(dir, p).replace(/\\/g, "/"));
      return fs.readFileSync(p, ...rest);
    },
  };
  BS.readSnapshot(dir, "alice", { fs: spyFs, homeDir: dir });
  const idxRecord = readOrder.indexOf("alice.swap.json.reveal-sent");
  const idxFund = readOrder.indexOf("alice.swap.json.wallet-fund.json");
  const idxSwap = readOrder.indexOf("alice.swap.json");
  assert.ok(idxRecord >= 0 && idxFund >= 0 && idxSwap >= 0);
  assert.ok(idxRecord < idxSwap && idxFund < idxSwap, `records must be read before swap file: ${readOrder.join(", ")}`);
});

test("T-B2: every file written by ui/app/lib/steps/*.js is classified by backupset.classifyPath", () => {
  const stepsDir = path.join(__dirname, "..", "lib", "steps");
  const files = fs.readdirSync(stepsDir).filter((n) => n.endsWith(".js"));
  const writtenLiterals = new Set();
  for (const name of files) {
    const src = fs.readFileSync(path.join(stepsDir, name), "utf8");
    // Collect literal filenames referenced in join(ctx.runDir, "...") or out.file("...")
    for (const m of src.matchAll(/(?:join\(\s*ctx\.runDir\s*,\s*|out\.file\(\s*)"([A-Za-z0-9._/-]+)"/g)) {
      const lit = m[1];
      if (!lit.includes(".") && !lit.includes("/")) continue; // directory name like "bob" or "pub"
      writtenLiterals.add(lit);
    }
  }
  assert.ok(writtenLiterals.size >= 5, "expected to find step-written filenames");
  for (const rel of writtenLiterals) {
    const cls = BS.classifyPath(rel);
    assert.notEqual(cls, "unknown", `step-written file "${rel}" is not classified in backupset.js`);
  }
});
