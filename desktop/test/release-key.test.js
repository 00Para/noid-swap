"use strict";
// The offline release signing tool (scripts/release-key.js) and the strict release.json parser (lib/releasefile.js).
// The passphrase comes through the io hook the tool takes; the real command reads it from the terminal only.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const tool = require("../scripts/release-key.js");
const R = require("../lib/releasefile.js");
const F = require("./release-fixture.js");

const PASS = "correct horse battery staple";
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "relkey-"));

function io(passphrases) {
  const lines = [];
  const errs = [];
  const asked = [];
  const queue = [...passphrases];
  return {
    lines,
    errs,
    asked,
    desktopVersion: null, // the sign step's version check against desktop/package.json is tested on its own (release-mainnet-fixes.test.js)
    compiledKey: "", // these tests sign with a throwaway key; the check against the compiled-in key is tested on its own (release-mainnet-fixes.test.js)
    readPassphrase: async (prompt) => {
      asked.push(prompt);
      if (queue.length === 0) throw new Error("asked for more passphrases than the test gave");
      return queue.shift();
    },
    out: (l) => lines.push(l),
    err: (l) => errs.push(l),
  };
}

async function keygen(dir, pass = PASS) {
  const h = io([pass, pass]);
  const code = await tool.main(["keygen", "--out", dir], h);
  return { code, h, file: path.join(dir, "release-key.enc.json"), pub: h.lines[h.lines.length - 1] };
}

test("keygen: writes one encrypted key file outside the repository and prints the public key in one line", async () => {
  const dir = tmp();
  try {
    const { code, h, file, pub } = await keygen(dir);
    assert.equal(code, 0);
    assert.equal(h.asked.length, 2, "the passphrase is asked twice");
    assert.match(pub, /^[A-Za-z0-9+/]{43}=$/);
    assert.equal(R.publicKeyObject(pub) !== null, true);
    const text = fs.readFileSync(file, "utf8");
    const f = JSON.parse(text);
    assert.equal(f.public_key, pub);
    assert.equal(f.kdf.name, "scrypt");
    assert.equal(f.cipher.name, "aes-256-gcm");
    // nothing printed or stored in clear: no seed, no PKCS8 block, not the passphrase
    const { priv } = tool.decryptKeyFile(text, PASS);
    const seed = priv.export({ format: "der", type: "pkcs8" }).subarray(R.PKCS8_PREFIX.length);
    for (const blob of [text, h.lines.join("\n"), h.errs.join("\n")]) {
      assert.ok(!blob.includes(seed.toString("base64")) && !blob.includes(seed.toString("hex")), "the seed is not in clear");
      assert.ok(!blob.includes(PASS));
    }
    if (process.platform !== "win32") assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("keygen: refuses a short passphrase, two different ones, an existing key file and a place inside the repository", async () => {
  const dir = tmp();
  try {
    const short = io(["short", "short"]);
    assert.equal(await tool.main(["keygen", "--out", dir], short), 2);
    assert.match(short.errs[0], /shorter than 12/);
    const differ = io([PASS, PASS + "x"]);
    assert.equal(await tool.main(["keygen", "--out", dir], differ), 2);
    assert.match(differ.errs[0], /differ/);
    assert.equal(fs.existsSync(path.join(dir, "release-key.enc.json")), false);
    assert.equal((await keygen(dir)).code, 0);
    const again = io([PASS, PASS]);
    assert.equal(await tool.main(["keygen", "--out", dir], again), 2);
    assert.match(again.errs[0], /already exists/);
    // inside the repository: refused before any passphrase is asked
    const root = tool.repoRoot();
    assert.ok(root, "the tests run inside the repository");
    const inRepo = io([]);
    assert.equal(await tool.main(["keygen", "--out", path.join(root, "desktop", "keys-should-not-exist")], inRepo), 2);
    assert.match(inRepo.errs[0], /inside a repository/);
    assert.equal(inRepo.asked.length, 0);
    assert.equal(fs.existsSync(path.join(root, "desktop", "keys-should-not-exist")), false);
    assert.equal(tool.insideRepo(path.join(root, "x")), true);
    assert.equal(tool.insideRepo(path.join(root, "desktop", "..", "y")), true);
    assert.equal(tool.insideRepo(dir), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("sign and verify: a signed release.json verifies with the public key, and the file shows its sha256 and content first", async () => {
  const dir = tmp();
  try {
    const { file, pub } = await keygen(dir);
    const rj = path.join(dir, "release.json");
    const body = F.noticeText("0.2.0", { oldest: "0.1.0" });
    fs.writeFileSync(rj, body);
    const s = io([PASS]);
    assert.equal(await tool.main(["sign", "--key", file, "--in", rj], s), 0);
    const shown = s.lines.join("\n");
    assert.ok(shown.includes(crypto.createHash("sha256").update(body).digest("hex")), "the sha256 is shown");
    assert.ok(shown.includes("version: 0.2.0") && shown.includes("sha256 " + "a".repeat(64) + "  setup.exe") && shown.includes("note: "), "the parsed fields and every hash line are shown");
    assert.ok(!shown.includes('"product"'), "not the raw text");
    assert.equal(s.asked.length, 1);
    const sigText = fs.readFileSync(rj + ".sig", "utf8");
    assert.equal(Buffer.from(sigText.trim(), "base64").length, 64);
    const v = io([]);
    assert.equal(await tool.main(["verify", "--pub", pub, "--in", rj, "--sig", rj + ".sig"], v), 0);
    assert.match(v.lines[0], /^OK/);
    assert.equal(R.verifyDetached(pub, fs.readFileSync(rj), sigText), true);
    assert.equal(v.asked.length, 0, "verify never asks for a passphrase");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("verify: a wrong key, a changed byte, a swapped signature and a bad base64 all fail with exit 1", async () => {
  const dir = tmp();
  try {
    const { file, pub } = await keygen(dir);
    const rj = path.join(dir, "release.json");
    fs.writeFileSync(rj, F.noticeText("0.2.0"));
    assert.equal(await tool.main(["sign", "--key", file, "--in", rj], io([PASS])), 0);
    const run = (args) => tool.main(["verify", ...args], io([]));
    assert.equal(await run(["--pub", F.OTHER_PUB, "--in", rj, "--sig", rj + ".sig"]), 1);
    const changed = path.join(dir, "changed.json");
    const bytes = fs.readFileSync(rj);
    bytes[10] ^= 1;
    fs.writeFileSync(changed, bytes);
    assert.equal(await run(["--pub", pub, "--in", changed, "--sig", rj + ".sig"]), 1);
    const junk = path.join(dir, "junk.sig");
    fs.writeFileSync(junk, "not base64 at all !!");
    assert.equal(await run(["--pub", pub, "--in", rj, "--sig", junk]), 1);
    assert.equal(await run(["--pub", "short", "--in", rj, "--sig", rj + ".sig"]), 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("sign: a wrong passphrase, a bad key file and a badly formed release.json write nothing", async () => {
  const dir = tmp();
  try {
    const { file } = await keygen(dir);
    const rj = path.join(dir, "release.json");
    fs.writeFileSync(rj, F.noticeText("0.2.0"));
    const wrong = io(["not the passphrase!"]);
    assert.equal(await tool.main(["sign", "--key", file, "--in", rj], wrong), 2);
    assert.match(wrong.errs[0], /could not be opened/);
    assert.equal(fs.existsSync(rj + ".sig"), false);
    const notKey = path.join(dir, "other.json");
    fs.writeFileSync(notKey, "{}");
    assert.equal(await tool.main(["sign", "--key", notKey, "--in", rj], io([PASS])), 2);
    // a tampered key file (a ciphertext byte, then the public key) does not open
    const f = JSON.parse(fs.readFileSync(file, "utf8"));
    const ct = Buffer.from(f.cipher.ciphertext, "base64");
    ct[0] ^= 1;
    const t1 = path.join(dir, "t1.json");
    fs.writeFileSync(t1, JSON.stringify({ ...f, cipher: { ...f.cipher, ciphertext: ct.toString("base64") } }));
    assert.equal(await tool.main(["sign", "--key", t1, "--in", rj], io([PASS])), 2);
    const t2 = path.join(dir, "t2.json");
    fs.writeFileSync(t2, JSON.stringify({ ...f, public_key: F.OTHER_PUB }));
    assert.equal(await tool.main(["sign", "--key", t2, "--in", rj], io([PASS])), 2);
    // a key file that asks for cheaper work factors is refused
    const t3 = path.join(dir, "t3.json");
    fs.writeFileSync(t3, JSON.stringify({ ...f, kdf: { ...f.kdf, N: 2 } }));
    assert.equal(await tool.main(["sign", "--key", t3, "--in", rj], io([PASS])), 2);
    // bad release.json: refused before any passphrase is asked
    fs.writeFileSync(rj, JSON.stringify({ ...JSON.parse(F.noticeText("0.2.0")), extra: true }));
    const bad = io([]);
    assert.equal(await tool.main(["sign", "--key", file, "--in", rj], bad), 2);
    assert.equal(bad.asked.length, 0);
    assert.equal(fs.existsSync(rj + ".sig"), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("usage: an unknown command or option and a missing value are errors; the tool never reads the passphrase from argv or the environment", async () => {
  for (const argv of [[], ["nope"], ["keygen"], ["keygen", "--out"], ["keygen", "--out", "x", "--passphrase", "p"], ["sign", "--key", "k"], ["verify", "--pub", "p"]]) {
    const h = io([]);
    assert.equal(await tool.main(argv, h), 2, JSON.stringify(argv));
    assert.equal(h.asked.length, 0);
  }
  const src = fs.readFileSync(path.join(__dirname, "..", "scripts", "release-key.js"), "utf8");
  assert.ok(!/process\.env/.test(src), "no environment variable is read");
  assert.ok(!/process\.argv/.test(src.replace(/process\.argv\.slice\(2\)/, "")), "argv carries the options only");
  assert.ok(/isTTY/.test(src) && /setRawMode/.test(src), "the passphrase is read from the terminal in raw mode (no echo)");
});

// ---- the strict release.json ----

const good = () => JSON.parse(F.noticeText("1.2.3", { oldest: "1.0.0" }));
const parse = (o) => R.parseReleaseJson(typeof o === "string" ? o : JSON.stringify(o));

test("release.json: a good file parses; every deviation is refused", () => {
  assert.equal(parse(good()).version, "1.2.3");
  const refused = [
    ["unknown key", { ...good(), extra: 1 }],
    ["missing key", (() => { const o = good(); delete o.note; return o; })()],
    ["wrong product", { ...good(), product: "Other" }],
    ["version with a prefix", { ...good(), version: "v1.2.3" }],
    ["version with two parts", { ...good(), version: "1.2" }],
    ["version with a suffix", { ...good(), version: "1.2.3-rc1" }],
    ["version not text", { ...good(), version: 123 }],
    ["oldest above version", { ...good(), oldest_safe_version: "1.2.4" }],
    ["bad oldest", { ...good(), oldest_safe_version: "x" }],
    ["note over 280", { ...good(), note: "x".repeat(281) }],
    ["empty note", { ...good(), note: "" }],
    ["note with a newline", { ...good(), note: "a\nb" }],
    ["note not text", { ...good(), note: 5 }],
    ["no files", { ...good(), sha256: {} }],
    ["a path as a file name", { ...good(), sha256: { "../x.exe": "a".repeat(64) } }],
    ["upper-case hex", { ...good(), sha256: { "a.exe": "A".repeat(64) } }],
    ["short hex", { ...good(), sha256: { "a.exe": "a".repeat(63) } }],
    ["sha256 as a list", { ...good(), sha256: [] }],
    ["17 files", { ...good(), sha256: Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`f${i}.exe`, "a".repeat(64)])) }],
    ["a list", []],
    ["null", null],
    ["not json", "{"],
    ["empty", ""],
  ];
  for (const [name, input] of refused) assert.throws(() => parse(input), R.ReleaseFileError, name);
  assert.equal(parse({ ...good(), note: "x".repeat(280) }).note.length, 280, "280 characters are allowed");
  assert.throws(() => R.parseReleaseJson(Buffer.alloc(8 * 1024 + 1, 32)), /over 8 KB/);
  assert.throws(() => R.parseReleaseJson(Buffer.from([0xff, 0xfe])), /UTF-8/);
});

test("verifyDetached never throws and accepts only a 64-byte signature by a 32-byte key", () => {
  const text = F.noticeText("1.0.0");
  const sig = F.sign(text);
  assert.equal(R.verifyDetached(F.PUB, text, sig), true);
  assert.equal(R.verifyDetached(F.PUB, text, sig + "\n"), true, "a trailing newline is the file's own");
  for (const bad of [undefined, null, 5, "", "AAAA", sig.slice(1), sig + "A", "=" + sig]) assert.equal(R.verifyDetached(F.PUB, text, bad), false, String(bad));
  for (const pub of [undefined, null, "", "AAAA", F.PUB.slice(1), F.OTHER_PUB]) assert.equal(R.verifyDetached(pub, text, sig), false, String(pub));
});
