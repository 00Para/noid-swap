"use strict";
// The by-hand tool (spec 6.3): the code on stdin only, the secret or a run folder's passphrase on stdout, the vectors of Appendix A.
const test = require("node:test");
const assert = require("node:assert/strict");
const childProcess = require("child_process");
const fs = require("fs");
const path = require("path");
const { main } = require("../tools/recovery");
const derive = require("../lib/derive");
const rc = require("../lib/recoverycode");
const sealed = require("../lib/sealed");
const { tmpDir, cleanupAll } = require("./vault-helpers");

test.after(cleanupAll);

const S = Buffer.from([...Array(32).keys()]);
const R = "0123456789abcdef0123456789abcdef";
const CODE = rc.encode(S);
const TOOL = path.join(__dirname, "..", "tools", "recovery.js");

function run(argv, stdin) {
  const out = [];
  const err = [];
  const code = main(argv, { stdin: () => stdin, stdout: (t) => out.push(t), stderr: (t) => err.push(t) });
  return { code, out, err };
}
function runDir(files = {}) {
  const d = tmpDir("no1d-recovery-");
  fs.writeFileSync(path.join(d, "run.json"), `${JSON.stringify({ v: 1, run_id: R })}\n`);
  fs.writeFileSync(path.join(d, "vault-check.json"), `${JSON.stringify({ v: 1, check: derive.keyCheck(S) })}\n`);
  for (const [n, t] of Object.entries(files)) fs.writeFileSync(path.join(d, n), t);
  return d;
}

test("secret: the code on stdin gives the 64-hex secret of Appendix A", () => {
  const r = run(["secret"], `${CODE}\n`);
  assert.deepEqual([r.code, r.out, r.err], [0, [S.toString("hex")], []]);
  assert.equal(run(["secret"], CODE.toLowerCase().replace(/-/g, " ")).out[0], S.toString("hex"));
});

test("passphrase: a run folder's derived passphrase is the vector's; the run id comes from run.json", () => {
  const r = run(["passphrase", runDir()], CODE);
  assert.deepEqual([r.code, r.out], [0, ["1390979abfa070d153819225d0f04fe3dba89cd5c662d7bdb845ed2b534fe8b1"]]);
});

test("passphrase: a folder with passphrase.sealed gives the old (migrated) passphrase", () => {
  const key = derive.migratedKey(S, R);
  const d = runDir();
  sealed.writeSealedFile(path.join(d, "passphrase.sealed"), { key, label: "migrated-passphrase", runId: R, plain: Buffer.from("the-old-one") });
  assert.deepEqual(run(["passphrase", d], CODE).out, ["the-old-one"]);
  // a tampered one is refused and prints nothing
  const f = path.join(d, "passphrase.sealed");
  const o = JSON.parse(fs.readFileSync(f, "utf8"));
  fs.writeFileSync(f, JSON.stringify({ ...o, tag: (o.tag[0] === "0" ? "1" : "0") + o.tag.slice(1) }));
  const bad = run(["passphrase", d], CODE);
  assert.deepEqual([bad.code, bad.out], [1, []]);
});

test("passphrase: the code of another installation is refused (vault-check.json), nothing is printed; a folder without one is allowed with a note", () => {
  const other = Buffer.from(S);
  other[0] ^= 1;
  const r = run(["passphrase", runDir()], rc.encode(other));
  assert.deepEqual([r.code, r.out], [1, []]);
  assert.match(r.err.join(" "), /not the one of that run folder/);
  const d = runDir();
  fs.rmSync(path.join(d, "vault-check.json"));
  const ok = run(["passphrase", d], CODE);
  assert.equal(ok.code, 0);
  assert.equal(ok.out.length, 1);
  assert.match(ok.err.join(" "), /no vault-check\.json/);
});

test("errors: a wrong code, a missing run.json, a bad run id, no argument, an unknown command, a code given as an argument; none prints a secret", () => {
  const bad = run(["secret"], CODE.replace("20G3", "20G4"));
  assert.deepEqual([bad.code, bad.out], [1, []]);
  for (const [argv, stdin] of [[[], CODE], [["other"], CODE], [["secret", CODE], ""], [["passphrase"], CODE], [["passphrase", "a", "b"], CODE]]) {
    const r = run(argv, stdin);
    assert.equal(r.code, 2, JSON.stringify(argv));
    assert.deepEqual(r.out, []);
  }
  const empty = tmpDir("no1d-recovery-");
  assert.equal(run(["passphrase", empty], CODE).code, 1);
  fs.writeFileSync(path.join(empty, "run.json"), JSON.stringify({ run_id: "../x" }));
  assert.equal(run(["passphrase", empty], CODE).code, 1);
  for (const r of [bad, run(["secret"], "")]) assert.ok(!r.err.join(" ").includes(S.toString("hex")) && !r.err.join(" ").includes(CODE));
});

test("a real process: reads the code on stdin only, prints the vectors; the code is never in its own argument vector", () => {
  const sec = childProcess.spawnSync(process.execPath, [TOOL, "secret"], { input: `${CODE}\n`, encoding: "utf8" });
  assert.equal(sec.status, 0, sec.stderr);
  assert.equal(sec.stdout.trim(), S.toString("hex"));
  const d = runDir();
  const pp = childProcess.spawnSync(process.execPath, [TOOL, "passphrase", d], { input: CODE, encoding: "utf8" });
  assert.equal(pp.status, 0, pp.stderr);
  assert.equal(pp.stdout.trim(), "1390979abfa070d153819225d0f04fe3dba89cd5c662d7bdb845ed2b534fe8b1");
  // the by-hand recipe of the spec: the secret from the tool into openssl gives the same passphrase
  let ssl = null;
  try {
    ssl = childProcess.execFileSync("openssl", ["dgst", "-sha256", "-mac", "HMAC", "-macopt", `hexkey:${sec.stdout.trim()}`], { input: `no1d-swap/v1/swap-passphrase/${R}`, encoding: "utf8", stdio: ["pipe", "pipe", "ignore"] });
  } catch {
    ssl = null;
  }
  if (ssl !== null) assert.equal(ssl.trim().split(/\s+/).pop(), pp.stdout.trim());
  const bad = childProcess.spawnSync(process.execPath, [TOOL, "secret"], { input: "nonsense", encoding: "utf8" });
  assert.equal(bad.status, 1);
  assert.equal(bad.stdout, "");
});
