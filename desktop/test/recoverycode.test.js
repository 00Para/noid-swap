"use strict";
// The recovery code (spec 6.5): the vector of Appendix A, the checksum's promises, the reading rules, the positions of the type-back.
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const rc = require("../lib/recoverycode");

const S = Buffer.from([...Array(32).keys()]);
const CODE = "0400-20G3-0G2G-C1R8-1450-P30D-1R7H-048J-2CA1-A5GQ-30CH-M6RW-3MF1-ZV0X";

test("Appendix A: the CRC-16/CCITT-FALSE check value, the CRC over 01||S, and the code of S", () => {
  assert.equal(rc.crc16(Buffer.from("123456789")).toString(16), "29b1");
  assert.equal(rc.crc16(Buffer.concat([Buffer.from([1]), S])).toString(16), "ec1d");
  assert.equal(rc.encode(S), CODE);
  assert.equal(rc.encodeRaw(S), CODE.replace(/-/g, ""));
  assert.equal(rc.groupsOf(rc.encodeRaw(S)).length, 14);
  assert.ok(rc.groupsOf(rc.encodeRaw(S)).every((g) => g.length === 4));
  assert.ok(rc.decode(CODE).equals(S));
});

test("round trip for 1,000 random secrets: 56 characters, 14 groups, alphabet only, and decode gives the secret back", () => {
  for (let i = 0; i < 1000; i++) {
    const s = crypto.randomBytes(32);
    const code = rc.encode(s);
    assert.match(code, /^(?:[0-9A-HJKMNP-TV-Z]{4}-){13}[0-9A-HJKMNP-TV-Z]{4}$/);
    assert.ok(rc.decode(code).equals(s));
  }
});

test("every single-character change of the vector is refused (56 places, every other character of the alphabet)", () => {
  const raw = CODE.replace(/-/g, "");
  let n = 0;
  for (let i = 0; i < raw.length; i++) {
    for (const c of rc.ALPHABET) {
      if (c === raw[i]) continue;
      const bad = raw.slice(0, i) + c + raw.slice(i + 1);
      assert.throws(() => rc.decode(bad), rc.RecoveryCodeError, `${i} ${c}`);
      n++;
    }
  }
  assert.equal(n, 56 * 31);
});

test("every swap of two neighbouring characters of the vector is refused (when they differ)", () => {
  const raw = CODE.replace(/-/g, "");
  let n = 0;
  for (let i = 0; i + 1 < raw.length; i++) {
    if (raw[i] === raw[i + 1]) continue;
    const bad = raw.slice(0, i) + raw[i + 1] + raw[i] + raw.slice(i + 2);
    assert.throws(() => rc.decode(bad), rc.RecoveryCodeError, `${i}`);
    n++;
  }
  assert.ok(n > 40);
});

test("the same holds for random secrets: one wrong character or one swap of neighbours is always found", () => {
  for (let k = 0; k < 40; k++) {
    const raw = rc.encodeRaw(crypto.randomBytes(32));
    const i = crypto.randomInt(0, 55);
    const other = rc.ALPHABET[(rc.ALPHABET.indexOf(raw[i]) + 1 + crypto.randomInt(0, 31)) % 32];
    assert.throws(() => rc.decode(raw.slice(0, i) + other + raw.slice(i + 1)), rc.RecoveryCodeError);
    if (raw[i] !== raw[i + 1]) assert.throws(() => rc.decode(raw.slice(0, i) + raw[i + 1] + raw[i] + raw.slice(i + 2)), rc.RecoveryCodeError);
  }
});

test("reading rules: case does not matter, spaces and hyphens are dropped, O is 0, I and L are 1; U and other characters are refused", () => {
  assert.ok(rc.decode(CODE.toLowerCase()).equals(S));
  assert.ok(rc.decode(CODE.replace(/-/g, " ")).equals(S));
  assert.ok(rc.decode(` ${CODE.replace(/-/g, "")} `).equals(S));
  assert.ok(rc.decode(CODE.replace(/-/g, "--")).equals(S));
  // 0 -> O, 1 -> I and L
  assert.ok(rc.decode(CODE.replace(/0/g, "O")).equals(S));
  assert.ok(rc.decode(CODE.replace(/1/g, "I")).equals(S));
  assert.ok(rc.decode(CODE.replace(/1/g, "l")).equals(S));
  assert.ok(rc.decode(CODE.replace(/0/g, "o").replace(/1/g, "L")).equals(S));
  assert.throws(() => rc.decode(CODE.replace("20G3", "20U3")), /not allowed/);
  assert.throws(() => rc.decode(`${CODE}!`), /not allowed/);
  assert.throws(() => rc.decode(CODE.replace("-", "_")), /not allowed/);
  assert.throws(() => rc.decode(CODE.replace("-", "\t")), /not allowed/);
  assert.throws(() => rc.decode(null), rc.RecoveryCodeError);
  assert.throws(() => rc.decode(5), rc.RecoveryCodeError);
});

test("the length must be 56: shorter, longer and empty are refused", () => {
  const raw = CODE.replace(/-/g, "");
  assert.throws(() => rc.decode(raw.slice(0, 55)), /wrong length/);
  assert.throws(() => rc.decode(`${raw}0`), /wrong length/);
  assert.throws(() => rc.decode(""), /wrong length/);
});

test("a version byte other than 1 is refused even with a correct checksum", () => {
  for (const v of [0, 2, 0xff]) {
    const body = Buffer.concat([Buffer.from([v]), S]);
    const crc = rc.crc16(body);
    const raw = rc.base32(Buffer.concat([body, Buffer.from([crc >> 8, crc & 255])]));
    assert.throws(() => rc.decode(raw), /version/, String(v));
  }
});

test("the error texts carry no part of the input", () => {
  for (const bad of [CODE.replace("20G3", "20U3"), CODE.slice(5), CODE.replace("20G3", "20G4")]) {
    try {
      rc.decode(bad);
      assert.fail("should refuse");
    } catch (e) {
      for (const g of CODE.split("-")) assert.ok(!e.message.includes(g), e.message);
    }
  }
});

test("a typed group is read by the same rules and must be exactly four characters", () => {
  assert.equal(rc.normaliseGroup("20g3"), "20G3");
  assert.equal(rc.normaliseGroup("2-0 G3"), "20G3");
  assert.equal(rc.normaliseGroup("2OG3"), "20G3");
  assert.equal(rc.normaliseGroup("0lO1"), "0101");
  assert.equal(rc.normaliseGroup("20G"), null);
  assert.equal(rc.normaliseGroup("20G33"), null);
  assert.equal(rc.normaliseGroup("20U3"), null);
  assert.equal(rc.normaliseGroup(null), null);
});

test("positions: three, ascending, all different, between 1 and 14, never three in a row; the distribution reaches every group", () => {
  const seen = new Set();
  for (let i = 0; i < 3000; i++) {
    const p = rc.pickPositions();
    assert.equal(p.length, 3);
    assert.equal(new Set(p).size, 3);
    assert.deepEqual([...p].sort((a, b) => a - b), p);
    assert.ok(p.every((x) => Number.isInteger(x) && x >= 1 && x <= 14));
    assert.ok(!(p[1] === p[0] + 1 && p[2] === p[1] + 1), `three in a row: ${p}`);
    p.forEach((x) => seen.add(x));
  }
  assert.equal(seen.size, 14);
});

test("positions: a random source that first gives three in a row is asked again; two in a row are fine", () => {
  const seq = [4, 5, 6, 1, 7, 12];
  let k = 0;
  const p = rc.pickPositions(() => seq[k++]);
  assert.deepEqual(p, [1, 7, 12]);
  const seq2 = [4, 5, 9];
  k = 0;
  assert.deepEqual(rc.pickPositions(() => seq2[k++]), [4, 5, 9]);
});

test("LOW 17: only ASCII letters are folded to upper case: characters that a locale mapping would turn into letters are refused", () => {
  for (const odd of ["ß", "ﬀ", "ı", "ſ", "K"]) {
    assert.throws(() => rc.decode(CODE.replace("20G3", `20${odd}3`)), /not allowed/, odd);
    assert.equal(rc.normaliseGroup(`20${odd}3`), null, odd);
  }
});
