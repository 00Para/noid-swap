"use strict";
// The board's key file with a sealer (step 4.6, spec 6.4 and I7): sealed on save, a plain file migrated on first load, a sealed file refused without a sealer,
// and today's plain bytes unchanged when there is no sealer. The sealer here is a small local fake (AES-256-GCM, file name as AAD); the program's real one
// (desktop/lib/vault.js boardSealer) is tested in desktop/test.
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { KeyStore, FILE } = require("../lib/board/keys");
const { getPublicKey, generateSecretKey } = require("../lib/board/note");

const dirs = [];
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "board-keys-sealed-"));
  dirs.push(d);
  return d;
};
test.after(() => dirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

/** A fake sealer: envelope JSON with nonce, ct and tag, the file name bound as AAD. `log` records what it was asked. */
function fakeSealer(key = crypto.randomBytes(32), log = []) {
  return {
    log,
    seal(plain, fileName) {
      log.push({ op: "seal", plain, fileName });
      const nonce = crypto.randomBytes(12);
      const c = crypto.createCipheriv("aes-256-gcm", key, nonce);
      c.setAAD(Buffer.from(fileName));
      const ct = Buffer.concat([c.update(plain), c.final()]);
      return Buffer.from(`${JSON.stringify({ v: 1, alg: "AES-256-GCM", nonce: nonce.toString("hex"), ct: ct.toString("hex"), tag: c.getAuthTag().toString("hex") })}\n`);
    },
    open(sealed, fileName) {
      log.push({ op: "open", fileName });
      const o = JSON.parse(sealed.toString("utf8"));
      const d = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(o.nonce, "hex"));
      d.setAAD(Buffer.from(fileName));
      d.setAuthTag(Buffer.from(o.tag, "hex"));
      return Buffer.concat([d.update(Buffer.from(o.ct, "hex")), d.final()]);
    },
  };
}
const read = (dir) => fs.readFileSync(path.join(dir, FILE));
const INVITE = "cd".repeat(32);

test("no sealer: the file is today's plain JSON, byte for byte, and the options object changes nothing", () => {
  for (const opts of [undefined, {}, { sealer: null }, { sealer: undefined }]) {
    const dir = tmp();
    const ks = opts === undefined ? new KeyStore(dir) : new KeyStore(dir, opts);
    const k = ks.newKey();
    ks.setInvite(INVITE);
    const expected = `${JSON.stringify({ v: 1, invite: INVITE, keys: { [k.pub]: k.secret.toString("hex") } })}\n`;
    assert.equal(read(dir).toString("utf8"), expected);
    const again = new KeyStore(dir, opts || {});
    assert.ok(again.secretFor(k.pub).equals(k.secret));
    assert.ok(again.invite().equals(Buffer.from(INVITE, "hex")));
  }
});

test("with a sealer: a new key is saved sealed, the file holds neither the secret, the public key nor the invite, and a reload with the same sealer finds them", () => {
  const dir = tmp();
  const sealer = fakeSealer();
  const ks = new KeyStore(dir, { sealer });
  const k = ks.newKey();
  ks.setInvite(INVITE);
  const text = read(dir).toString("utf8");
  assert.ok(!text.includes(k.secret.toString("hex")));
  assert.ok(!text.includes(k.pub));
  assert.ok(!text.includes(INVITE));
  assert.ok(!text.includes('"keys"'));
  const o = JSON.parse(text);
  assert.ok(o.ct && o.tag && o.nonce);
  const again = new KeyStore(dir, { sealer });
  assert.ok(again.has(k.pub));
  assert.ok(again.secretFor(k.pub).equals(k.secret));
  assert.ok(again.invite().equals(Buffer.from(INVITE, "hex")));
  assert.deepEqual(fs.readdirSync(dir), [FILE], "no temporary file is left");
});

test("the sealer is given the plain text and the file name board-keys.json, and the plain buffer is zero-filled after the call", () => {
  const dir = tmp();
  const sealer = fakeSealer();
  const ks = new KeyStore(dir, { sealer });
  ks.newKey();
  const call = sealer.log.find((l) => l.op === "seal");
  assert.equal(call.fileName, "board-keys.json");
  assert.ok(Buffer.isBuffer(call.plain));
  assert.ok(call.plain.every((b) => b === 0), "the plain text was wiped");
  new KeyStore(dir, { sealer });
  assert.ok(sealer.log.some((l) => l.op === "open" && l.fileName === "board-keys.json"));
});

test("a plain file found with a sealer is read and saved again sealed (the migration), keys and invite intact", () => {
  const dir = tmp();
  const plain = new KeyStore(dir);
  const a = plain.newKey();
  const b = plain.newKey();
  plain.setInvite(INVITE);
  assert.ok(read(dir).toString("utf8").includes(a.secret.toString("hex")));
  const sealer = fakeSealer();
  const ks = new KeyStore(dir, { sealer });
  assert.ok(ks.has(a.pub) && ks.has(b.pub));
  const text = read(dir).toString("utf8");
  assert.ok(!text.includes(a.secret.toString("hex")) && !text.includes(b.secret.toString("hex")) && !text.includes(INVITE));
  assert.ok(JSON.parse(text).ct);
  const again = new KeyStore(dir, { sealer });
  assert.ok(again.secretFor(b.pub).equals(b.secret));
  assert.equal(again.invite().toString("hex"), INVITE);
});

test("a sealed file with no sealer is refused with the fixed sentence and is left untouched", () => {
  const dir = tmp();
  const ks = new KeyStore(dir, { sealer: fakeSealer() });
  const k = ks.newKey();
  const before = read(dir);
  assert.throws(() => new KeyStore(dir), (e) => /sealed by the program: open it in the program/.test(e.message) && !e.message.includes(k.secret.toString("hex")));
  assert.throws(() => new KeyStore(dir, { sealer: null }), /sealed by the program/);
  assert.ok(read(dir).equals(before));
});

test("a sealed file that the sealer cannot open (another installation, a damaged file) is refused without the sealer's words and is left untouched", () => {
  const dir = tmp();
  const k = new KeyStore(dir, { sealer: fakeSealer() }).newKey();
  const before = read(dir);
  const secretLeak = `${k.secret.toString("hex")} is in the error`;
  const other = fakeSealer();
  const lying = { seal: other.seal, open: () => { throw new Error(secretLeak); } };
  for (const s of [other, lying]) {
    assert.throws(() => new KeyStore(dir, { sealer: s }), (e) => /cannot be opened/.test(e.message) && !e.message.includes(k.secret.toString("hex")));
  }
  assert.ok(read(dir).equals(before));
  // an envelope-shaped file whose plain text is not JSON
  const odd = fakeSealer();
  const d2 = tmp();
  fs.writeFileSync(path.join(d2, FILE), odd.seal(Buffer.from("not json"), FILE));
  assert.throws(() => new KeyStore(d2, { sealer: odd }), /not JSON/);
  // an envelope whose plain text is a key file with a key that does not match its public key
  const d3 = tmp();
  const pub = getPublicKey(generateSecretKey());
  fs.writeFileSync(path.join(d3, FILE), odd.seal(Buffer.from(JSON.stringify({ v: 1, invite: null, keys: { [pub]: "ab".repeat(32) } })), FILE));
  assert.throws(() => new KeyStore(d3, { sealer: odd }), /does not match its public key/);
});

test("a sealer that fails to seal makes the save fail with a fixed sentence, leaves the old file as it was and no temporary file", () => {
  const dir = tmp();
  const good = fakeSealer();
  const ks = new KeyStore(dir, { sealer: good });
  ks.newKey();
  const before = read(dir);
  ks.sealer = { seal: () => { throw new Error("key store gone"); }, open: good.open };
  assert.throws(() => ks.newKey(), (e) => /cannot be sealed/.test(e.message) && !/key store gone/.test(e.message));
  assert.ok(read(dir).equals(before));
  assert.deepEqual(fs.readdirSync(dir), [FILE]);
});

test("a plain file found with a sealer that fails to seal makes the load fail (the migration is not skipped silently)", () => {
  const dir = tmp();
  new KeyStore(dir).newKey();
  const before = read(dir);
  assert.throws(() => new KeyStore(dir, { sealer: { seal: () => { throw new Error("x"); }, open: () => Buffer.alloc(0) } }), /cannot be sealed/);
  assert.ok(read(dir).equals(before), "the plain file is still there, unchanged");
});

test("an empty folder with a sealer starts empty and the first save is sealed; a file that is not JSON or not a key file is still refused", () => {
  const dir = tmp();
  const ks = new KeyStore(dir, { sealer: fakeSealer() });
  assert.deepEqual(ks.data, { v: 1, invite: null, keys: {} });
  assert.ok(!fs.existsSync(path.join(dir, FILE)));
  const d2 = tmp();
  fs.writeFileSync(path.join(d2, FILE), "{nope");
  assert.throws(() => new KeyStore(d2, { sealer: fakeSealer() }), /not JSON/);
  fs.writeFileSync(path.join(d2, FILE), JSON.stringify({ v: 2 }));
  assert.throws(() => new KeyStore(d2, { sealer: fakeSealer() }), /not one this console wrote/);
});
