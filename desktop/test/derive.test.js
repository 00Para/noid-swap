"use strict";
// The derivation of every key and passphrase from the install secret (spec 6.3) against the binding vectors of Appendix A.
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const childProcess = require("child_process");
const derive = require("../lib/derive");

const S = Buffer.from([...Array(32).keys()]); // the public test vector: never a real install
const R = "0123456789abcdef0123456789abcdef";

test("Appendix A: passphrase, boardKey, migratedKey, inviteKey and keyCheck reproduce exactly", () => {
  assert.equal(derive.passphrase(S, R), "1390979abfa070d153819225d0f04fe3dba89cd5c662d7bdb845ed2b534fe8b1");
  assert.equal(derive.boardKey(S, R).toString("hex"), "c975bc412f50ddc463ae4e42c210a5f66afff65b2868d49adfbbfa771d1d5b67");
  assert.equal(derive.migratedKey(S, R).toString("hex"), "8843ab4c55972fb21ffc867db6c614748bde21413c4f0d88cd290f30f3610bd3");
  assert.equal(derive.inviteKey(S).toString("hex"), "b7dfde707306fb24ee84c6d804fc5233ad191112dd1a21080dd955b01b475aec");
  assert.equal(derive.keyCheck(S), "3b25908f21bea838");
});

test("the passphrase is 64 lower-case hex characters and each label gives a different key", () => {
  const p = derive.passphrase(S, R);
  assert.match(p, /^[0-9a-f]{64}$/);
  const keys = new Set([derive.K(S, "swap-passphrase", R), derive.K(S, "board", R), derive.K(S, "migrated-passphrase", R), derive.inviteKey(S)].map((b) => b.toString("hex")));
  assert.equal(keys.size, 4);
});

test("another run id or another secret gives another value; the same input gives the same value", () => {
  const R2 = "fedcba9876543210fedcba9876543210";
  assert.notEqual(derive.passphrase(S, R), derive.passphrase(S, R2));
  assert.equal(derive.passphrase(S, R), derive.passphrase(Buffer.from(S), R));
  const S2 = Buffer.from(S);
  S2[31] ^= 1;
  assert.notEqual(derive.passphrase(S, R), derive.passphrase(S2, R));
  assert.notEqual(derive.keyCheck(S), derive.keyCheck(S2));
});

test("bad input is refused: a run id that is not 32 lower-case hex, an unknown label, a secret that is not 32 bytes", () => {
  for (const bad of ["", "0123", R.toUpperCase(), `${R}0`, R.slice(0, 31) + "g", null, undefined, 5, "../" + R.slice(3)]) {
    assert.throws(() => derive.passphrase(S, bad), derive.DeriveError, String(bad));
    assert.equal(derive.isRunId(bad), false);
  }
  assert.equal(derive.isRunId(R), true);
  assert.throws(() => derive.K(S, "other", R), derive.DeriveError);
  assert.throws(() => derive.K(S, "board-invite", R), derive.DeriveError);
  assert.throws(() => derive.passphrase(Buffer.alloc(31), R), derive.DeriveError);
  assert.throws(() => derive.passphrase("x".repeat(32), R), derive.DeriveError);
  assert.throws(() => derive.keyCheck(Buffer.alloc(0)), derive.DeriveError);
});

test("the derivation is the plain HMAC of the spec (an independent computation with the named message)", () => {
  const mac = (m) => crypto.createHmac("sha256", S).update(m).digest("hex");
  assert.equal(derive.passphrase(S, R), mac(`no1d-swap/v1/swap-passphrase/${R}`));
  assert.equal(derive.boardKey(S, R).toString("hex"), mac(`no1d-swap/v1/board/${R}`));
  assert.equal(derive.migratedKey(S, R).toString("hex"), mac(`no1d-swap/v1/migrated-passphrase/${R}`));
  assert.equal(derive.inviteKey(S).toString("hex"), mac("no1d-swap/v1/board-invite/install"));
  assert.equal(derive.keyCheck(S), mac("no1d-swap/v1/key-check").slice(0, 16));
});

test("the openssl recipe of the spec gives the same passphrase (skipped when openssl is not installed)", (t) => {
  let out;
  try {
    out = childProcess.execFileSync("openssl", ["dgst", "-sha256", "-mac", "HMAC", "-macopt", `hexkey:${S.toString("hex")}`], { input: `no1d-swap/v1/swap-passphrase/${R}`, encoding: "utf8", stdio: ["pipe", "pipe", "ignore"] });
  } catch {
    t.skip("openssl is not available");
    return;
  }
  assert.equal(out.trim().split(/\s+/).pop(), derive.passphrase(S, R));
});
