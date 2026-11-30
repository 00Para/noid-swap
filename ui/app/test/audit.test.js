"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { AuditLog, FILE } = require("../lib/audit");

function tmp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "noid-audit-"));
  return { dir, done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test("append-only: UTC time, action, role, result, dry-run hash, a chain of line hashes", () => {
  const t = tmp();
  try {
    let ms = Date.UTC(2026, 10, 5, 12, 0, 0);
    const log = new AuditLog(t.dir, { now: () => (ms += 1000) });
    assert.equal(path.basename(log.file), FILE);
    const a = log.append({ action: "send-lock", role: "bob", phase: "start", result: "started", dry_hash: "ab".repeat(32) });
    const b = log.append({ action: "send-lock", role: "bob", phase: "end", result: "ok (exit 0)", dry_hash: "ab".repeat(32), tx: "0x" + "cd".repeat(32) });
    assert.match(a.t, /^2026-11-05T12:00:01Z$/);
    assert.equal(a.seq, 1);
    assert.equal(b.seq, 2);
    assert.equal(a.prev, null);
    assert.ok(b.prev && b.prev.length === 64);
    assert.deepEqual(Object.keys(a).sort(), ["action", "dry_hash", "detail", "phase", "prev", "result", "role", "seq", "t", "tx"].sort());
    const lines = fs.readFileSync(log.file, "utf8").trim().split("\n");
    assert.equal(lines.length, 2);
    assert.deepEqual(JSON.parse(lines[1]), b);
    assert.deepEqual(log.verify(), { ok: true, lines: 2 });
    // a new object on the same file continues the chain
    const again = new AuditLog(t.dir, { now: () => ms + 5000 });
    const c = again.append({ action: "tick-bob", role: "bob", phase: "start", result: "started" });
    assert.equal(c.seq, 3);
    assert.deepEqual(again.verify(), { ok: true, lines: 3 });
    assert.equal(again.tail(2).length, 2);
  } finally {
    t.done();
  }
});

test("an edit or a cut in the middle is visible", () => {
  const t = tmp();
  try {
    const log = new AuditLog(t.dir);
    for (let i = 0; i < 4; i++) log.append({ action: "a" + i, phase: "note", result: "x" });
    const lines = fs.readFileSync(log.file, "utf8").trim().split("\n");
    fs.writeFileSync(log.file, [lines[0], lines[1].replace('"a1"', '"zz"'), lines[2], lines[3]].join("\n") + "\n");
    assert.equal(log.verify().ok, false, "edited line");
    fs.writeFileSync(log.file, [lines[0], lines[2], lines[3]].join("\n") + "\n");
    assert.equal(log.verify().ok, false, "removed line");
    fs.writeFileSync(log.file, lines.join("\n") + "\n");
    assert.equal(log.verify().ok, true);
  } finally {
    t.done();
  }
});

test("the module has no way to truncate, rewrite or delete the file (source check) and fails closed when it cannot write", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "lib", "audit.js"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  assert.ok(!/writeFileSync|truncate|unlink|rmSync|renameSync|appendFileSync\(.*,.*\{\s*flag:\s*"w"/.test(src), "no rewriting primitive");
  assert.ok(!/openSync\([^)]*"(w|w\+|r\+)"/.test(src), "never opened for writing other than append");
  const t = tmp();
  try {
    const log = new AuditLog(t.dir);
    log.append({ action: "x", phase: "note", result: "ok" });
    fs.rmSync(t.dir, { recursive: true, force: true }); // the directory vanishes (a drive removed)
    assert.throws(() => log.append({ action: "y", phase: "note", result: "ok" }));
  } finally {
    t.done();
  }
  assert.throws(() => new AuditLog(path.join(os.tmpdir(), "noid-audit-does-not-exist-" + Date.now())));
  assert.throws(() => new AuditLog(""));
});
