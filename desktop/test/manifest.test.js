"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const manifest = require("../lib/manifest");

const COMMIT = "a".repeat(40);

function tree() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "no1d-manifest-"));
  const put = (rel, text) => {
    const f = path.join(root, ...rel.split("/"));
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, text);
    return f;
  };
  put("app.asar.unpacked/eth/scripts/live.js", "live");
  put("app.asar.unpacked/eth/node_modules/ethers/index.js", "ethers");
  put("bin/swap-cli.exe", "swap-cli bytes");
  put("app.asar", "archive (not covered: it has its own integrity check)");
  return { root, put, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test("write then verify", () => {
  const t = tree();
  try {
    const text = manifest.write(t.root, { version: "0.1.0", commit: COMMIT, outFile: path.join(t.root, "app.asar-manifest.json") });
    const m = JSON.parse(text);
    assert.equal(m.v, 1);
    assert.equal(m.program_version, "0.1.0");
    assert.equal(m.commit, COMMIT);
    assert.deepEqual(Object.keys(m.files), [
      "app.asar.unpacked/eth/node_modules/ethers/index.js",
      "app.asar.unpacked/eth/scripts/live.js",
      "bin/swap-cli.exe",
    ]);
    assert.ok(text.endsWith("\n"));
    assert.deepEqual(manifest.verify(t.root, text), { ok: true, why: null });
    assert.equal(manifest.build(t.root, { version: "0.1.0", commit: COMMIT }), text, "building twice gives the same bytes");
  } finally {
    t.cleanup();
  }
});

test("a changed byte fails", () => {
  const t = tree();
  try {
    const text = manifest.build(t.root, { version: "0.1.0", commit: COMMIT });
    t.put("bin/swap-cli.exe", "swap-cli byteS");
    const r = manifest.verify(t.root, text);
    assert.equal(r.ok, false);
    assert.match(r.why, /changed: bin\/swap-cli\.exe/);
  } finally {
    t.cleanup();
  }
});

test("a missing file fails", () => {
  const t = tree();
  try {
    const text = manifest.build(t.root, { version: "0.1.0", commit: COMMIT });
    fs.rmSync(path.join(t.root, "app.asar.unpacked", "eth", "scripts", "live.js"));
    const r = manifest.verify(t.root, text);
    assert.equal(r.ok, false);
    assert.match(r.why, /missing: app\.asar\.unpacked\/eth\/scripts\/live\.js/);
  } finally {
    t.cleanup();
  }
});

test("an extra file fails", () => {
  const t = tree();
  try {
    const text = manifest.build(t.root, { version: "0.1.0", commit: COMMIT });
    t.put("app.asar.unpacked/eth/scripts/evil.js", "x");
    const r = manifest.verify(t.root, text);
    assert.equal(r.ok, false);
    assert.match(r.why, /not in the manifest: app\.asar\.unpacked\/eth\/scripts\/evil\.js/);
  } finally {
    t.cleanup();
  }
});

test("files outside the two folders are not covered", () => {
  const t = tree();
  try {
    const text = manifest.build(t.root, { version: "0.1.0", commit: COMMIT });
    t.put("elevate.exe", "x");
    t.put("app.asar", "changed archive");
    assert.equal(manifest.verify(t.root, text).ok, true);
  } finally {
    t.cleanup();
  }
});

test("a manifest that is not readable, has the wrong shape, or lists a bad path or hash fails", () => {
  const t = tree();
  try {
    const good = JSON.parse(manifest.build(t.root, { version: "0.1.0", commit: COMMIT }));
    const fails = (m) => manifest.verify(t.root, typeof m === "string" ? m : JSON.stringify(m)).ok === false;
    assert.ok(fails("not json"));
    assert.ok(fails({ ...good, v: 2 }));
    assert.ok(fails({ ...good, commit: "xyz" }));
    assert.ok(fails({ ...good, files: [] }));
    assert.ok(fails({ ...good, files: { ...good.files, "../outside": "0".repeat(64) } }));
    assert.ok(fails({ ...good, files: { ...good.files, "other/x": "0".repeat(64) } }));
    assert.ok(fails({ ...good, files: { ...good.files, "bin\\evil": "0".repeat(64) } }));
    assert.ok(fails({ ...good, files: { ...good.files, "bin/swap-cli.exe": "nothex" } }));
    assert.ok(fails({ ...good, files: { ...good.files, "bin/ghost": "0".repeat(64) } }));
  } finally {
    t.cleanup();
  }
});

test("build refuses a bad version or commit", () => {
  const t = tree();
  try {
    assert.throws(() => manifest.build(t.root, { version: "", commit: COMMIT }), /version/);
    assert.throws(() => manifest.build(t.root, { version: "0.1.0", commit: "short" }), /commit/);
  } finally {
    t.cleanup();
  }
});

test("a folder with nothing to cover verifies against an empty list", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "no1d-manifest-empty-"));
  try {
    const text = manifest.build(root, { version: "0.1.0", commit: COMMIT });
    assert.deepEqual(JSON.parse(text).files, {});
    assert.equal(manifest.verify(root, text).ok, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
