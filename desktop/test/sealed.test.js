"use strict";
// Sealed files (spec 6.4): AES-256-GCM with the AAD of label, run id and file name; every tamper is refused.
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const sealed = require("../lib/sealed");

const KEY = crypto.randomBytes(32);
const R = "0123456789abcdef0123456789abcdef";
const R2 = "fedcba9876543210fedcba9876543210";
const PLAIN = Buffer.from("canary-plain-text-0123456789");
const args = (o = {}) => ({ key: KEY, label: "board", runId: R, fileName: "board-keys.json", plain: PLAIN, ...o });
const openArgs = (env, o = {}) => ({ key: KEY, label: "board", runId: R, fileName: "board-keys.json", envelope: env, ...o });

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "no1d-sealed-"));
const cleanup = [];
test.after(() => cleanup.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

test("an envelope has exactly the fields of the spec, hex of the right sizes, and opens back to the plain text", () => {
  const e = sealed.seal(args());
  assert.deepEqual(Object.keys(e), ["v", "alg", "label", "run_id", "nonce", "ct", "tag"]);
  assert.equal(e.v, 1);
  assert.equal(e.alg, "AES-256-GCM");
  assert.equal(e.label, "board");
  assert.equal(e.run_id, R);
  assert.match(e.nonce, /^[0-9a-f]{24}$/);
  assert.match(e.tag, /^[0-9a-f]{32}$/);
  assert.equal(e.ct.length, PLAIN.length * 2);
  assert.ok(!JSON.stringify(e).includes(PLAIN.toString()));
  assert.ok(sealed.open(openArgs(e)).equals(PLAIN));
  assert.ok(sealed.open(openArgs(JSON.stringify(e))).equals(PLAIN));
  assert.ok(sealed.open(openArgs(Buffer.from(sealed.sealToText(args())))).equals(PLAIN));
});

test("the nonce is new on every write", () => {
  const seen = new Set();
  for (let i = 0; i < 200; i++) seen.add(sealed.seal(args()).nonce);
  assert.equal(seen.size, 200);
});

test("the AAD is the specified bytes: label, run id and file name joined by NUL after the fixed prefix (checked with an independent decrypt)", () => {
  const e = sealed.seal(args());
  const d = crypto.createDecipheriv("aes-256-gcm", KEY, Buffer.from(e.nonce, "hex"));
  d.setAAD(Buffer.from("no1d-swap sealed v1\u0000board\u0000" + R + "\u0000board-keys.json", "utf8"));
  d.setAuthTag(Buffer.from(e.tag, "hex"));
  assert.ok(Buffer.concat([d.update(Buffer.from(e.ct, "hex")), d.final()]).equals(PLAIN));
});

test("tampering with any field is refused: v, alg, label, run_id, nonce, ct, tag, an extra field, a missing field", () => {
  const e = sealed.seal(args());
  const flip = (hex) => (hex[0] === "0" ? "1" : "0") + hex.slice(1);
  const cases = {
    v: { ...e, v: 2 },
    alg: { ...e, alg: "AES-128-GCM" },
    label: { ...e, label: "migrated-passphrase" },
    run_id: { ...e, run_id: R2 },
    nonce: { ...e, nonce: flip(e.nonce) },
    ct: { ...e, ct: flip(e.ct) },
    tag: { ...e, tag: flip(e.tag) },
    extra: { ...e, extra: 1 },
    short_nonce: { ...e, nonce: e.nonce.slice(2) },
    odd_ct: { ...e, ct: e.ct.slice(1) },
    upper_tag: { ...e, tag: e.tag.toUpperCase().replace(/[0-9]/g, "A") },
  };
  for (const [name, bad] of Object.entries(cases)) assert.throws(() => sealed.open(openArgs(bad)), sealed.SealedError, name);
  const { tag, ...missing } = e;
  assert.ok(tag);
  assert.throws(() => sealed.open(openArgs(missing)), sealed.SealedError);
  for (const x of [null, [], "not json", "[]", 5, "{"]) assert.throws(() => sealed.open(openArgs(x)), sealed.SealedError, String(x));
});

test("the AAD parts are bound: the same bytes under another label, run id or file name, and another key, are refused", () => {
  const e = sealed.seal(args());
  assert.throws(() => sealed.open(openArgs(e, { fileName: "other.json" })), sealed.SealedError, "file name");
  assert.throws(() => sealed.open(openArgs(e, { runId: R2 })), sealed.SealedError, "run id");
  assert.throws(() => sealed.open(openArgs(e, { label: "migrated-passphrase" })), sealed.SealedError, "label");
  assert.throws(() => sealed.open(openArgs(e, { key: crypto.randomBytes(32) })), sealed.SealedError, "key");
  // a file whose fields were rewritten to say another label or run id fails the tag, because the AAD is built from what the opener expects
  const relabelled = { ...e, label: "migrated-passphrase" };
  assert.throws(() => sealed.open(openArgs(relabelled, { label: "migrated-passphrase" })), sealed.SealedError, "relabelled");
  const moved = { ...e, run_id: R2 };
  assert.throws(() => sealed.open(openArgs(moved, { runId: R2 })), sealed.SealedError, "moved to another run");
});

test("arguments are checked: key size, label, run id for the label, file name as a base name, plain text type", () => {
  assert.throws(() => sealed.seal(args({ key: Buffer.alloc(16) })), sealed.SealedError);
  assert.throws(() => sealed.seal(args({ label: "nope" })), sealed.SealedError);
  assert.throws(() => sealed.seal(args({ runId: "install" })), sealed.SealedError);
  assert.throws(() => sealed.seal(args({ label: "board-invite", runId: R })), sealed.SealedError);
  assert.doesNotThrow(() => sealed.seal(args({ label: "board-invite", runId: "install", fileName: "board-invite.sealed" })));
  assert.doesNotThrow(() => sealed.seal(args({ label: "payout-history", runId: "install", fileName: "payout-history.sealed" })));
  assert.throws(() => sealed.seal(args({ label: "payout-history", runId: R, fileName: "payout-history.sealed" })), sealed.SealedError, "the history's run id is the word install");
  assert.throws(() => sealed.seal(args({ fileName: "../x" })), sealed.SealedError);
  assert.throws(() => sealed.seal(args({ fileName: "a/b" })), sealed.SealedError);
  assert.throws(() => sealed.seal(args({ fileName: "" })), sealed.SealedError);
  assert.throws(() => sealed.seal(args({ plain: "text" })), sealed.SealedError);
});

test("a file written and read back; its name is bound into the AAD, so a renamed copy does not open", () => {
  const d = tmp();
  cleanup.push(d);
  const f = path.join(d, "passphrase.sealed");
  sealed.writeSealedFile(f, { key: KEY, label: "migrated-passphrase", runId: R, plain: PLAIN });
  assert.ok(sealed.readSealedFile(f, { key: KEY, label: "migrated-passphrase", runId: R }).equals(PLAIN));
  assert.ok(!fs.readFileSync(f, "utf8").includes(PLAIN.toString()));
  const copy = path.join(d, "renamed.sealed");
  fs.copyFileSync(f, copy);
  assert.throws(() => sealed.readSealedFile(copy, { key: KEY, label: "migrated-passphrase", runId: R }), sealed.SealedError);
  // a second write replaces the file with a new nonce
  const before = JSON.parse(fs.readFileSync(f, "utf8")).nonce;
  sealed.writeSealedFile(f, { key: KEY, label: "migrated-passphrase", runId: R, plain: PLAIN });
  assert.notEqual(JSON.parse(fs.readFileSync(f, "utf8")).nonce, before);
  assert.deepEqual(fs.readdirSync(d).filter((n) => n.endsWith(".tmp")), [], "no temporary file is left");
  if (process.platform !== "win32") assert.equal(fs.statSync(f).mode & 0o777, 0o600);
});

test("reading refuses a missing file, a folder and an oversized file with a fixed text", () => {
  const d = tmp();
  cleanup.push(d);
  assert.throws(() => sealed.readSealedFile(path.join(d, "none"), { key: KEY, label: "board", runId: R }), sealed.SealedError);
  fs.mkdirSync(path.join(d, "dir"));
  assert.throws(() => sealed.readSealedFile(path.join(d, "dir"), { key: KEY, label: "board", runId: R }), /not a plain file/);
  fs.writeFileSync(path.join(d, "big"), Buffer.alloc(5 * 1024 * 1024));
  assert.throws(() => sealed.readSealedFile(path.join(d, "big"), { key: KEY, label: "board", runId: R }), /too large/);
});

test("a failed write leaves no temporary file and the old file untouched", () => {
  const d = tmp();
  cleanup.push(d);
  const f = path.join(d, "x.sealed");
  fs.writeFileSync(f, "old");
  const io = { ...fs, renameSync: () => { throw new Error("boom"); } };
  assert.throws(() => sealed.writeAtomic(f, Buffer.from("new"), io), /boom/);
  assert.equal(fs.readFileSync(f, "utf8"), "old");
  assert.deepEqual(fs.readdirSync(d), ["x.sealed"]);
});

test("isEnvelope tells a sealed file from the board's plain key file", () => {
  assert.equal(sealed.isEnvelope(sealed.seal(args())), true);
  assert.equal(sealed.isEnvelope({ v: 1, invite: null, keys: {} }), false);
  assert.equal(sealed.isEnvelope(null), false);
  assert.equal(sealed.isEnvelope([]), false);
});
