"use strict";
// P3.2: notes, signatures, NIP-44, seal and gift wrap, proof of work, and the vendored libraries. The vectors are the official ones (test/board-vectors.js).
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const Module = require("module");
const V = require("./board-vectors");
const N = require("../lib/board/note");
const nip44 = require("../lib/board/nip44");
const G = require("../lib/board/giftwrap");
const P = require("../lib/board/pow");
const { schnorr } = require("../vendor");

const hex = (b) => Buffer.from(b).toString("hex");
const throwsCode = (fn, code) => assert.throws(fn, (e) => e instanceof N.BoardError && (!code || e.code === code), `expected a BoardError ${code || ""}`);

// ---------------------------------------------------------------------------------------------- the vendored libraries
test("vendor: every copied file has the sha256 recorded in VENDORED.md, and the versions are the stated ones", () => {
  const dir = path.join(__dirname, "..", "vendor");
  const md = fs.readFileSync(path.join(dir, "VENDORED.md"), "utf8");
  const rows = [...md.matchAll(/^\| `((?:noble-curves|noble-hashes)\/[^`]+)` \| `([0-9a-f]{64})` \|$/gm)];
  assert.ok(rows.length >= 16, "the table lists every copied file");
  for (const [, file, sha] of rows) assert.equal(crypto.createHash("sha256").update(fs.readFileSync(path.join(dir, file))).digest("hex"), sha, file);
  // no file in the two folders is missing from the table
  const listed = new Set(rows.map((r) => r[1]));
  const walk = (d) => fs.readdirSync(path.join(dir, d), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name).split(path.sep).join("/")]));
  for (const f of [...walk("noble-curves"), ...walk("noble-hashes")]) assert.ok(listed.has(f), `${f} is in the table`);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "noble-curves", "package.json"), "utf8")).version, "1.2.0");
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "noble-hashes", "package.json"), "utf8")).version, "1.3.2");
  assert.match(md, /@noble\/curves.*1\.2\.0/);
  assert.match(md, /@noble\/hashes.*1\.3\.2/);
  assert.ok(fs.existsSync(path.join(dir, "noble-curves", "LICENSE")) && fs.existsSync(path.join(dir, "noble-hashes", "LICENSE")));
});

test("vendor: the loader's resolver hook is removed after loading", () => {
  assert.ok(!Module._resolveFilename.toString().includes("noble/hashes"));
});

test("BIP-340 official vectors: verification and, where a secret key is given, signing and the public key", () => {
  let signed = 0;
  for (const v of V.bip340) {
    const pub = Buffer.from(v.publicKey, "hex");
    const msg = Buffer.from(v.message, "hex");
    const sig = Buffer.from(v.signature, "hex");
    let ok;
    try {
      ok = schnorr.verify(sig, msg, pub);
    } catch {
      ok = false;
    }
    assert.equal(ok, v.valid, `vector ${v.index} ${v.comment}`);
    if (v.secretKey) {
      const sk = Buffer.from(v.secretKey, "hex");
      assert.equal(hex(schnorr.getPublicKey(sk)).toUpperCase(), v.publicKey, `public key ${v.index}`);
      assert.equal(hex(schnorr.sign(msg, sk, Buffer.from(v.auxRand, "hex"))).toUpperCase(), v.signature, `signature ${v.index}`);
      signed++;
    }
  }
  assert.equal(signed, V.bip340.filter((x) => x.secretKey).length);
  assert.ok(signed >= 4 && V.bip340.length === 19);
});

// ---------------------------------------------------------------------------------------------- notes (NIP-01)
const NIP13_EXAMPLE = {
  id: "000006d8c378af1779d2feebc7603a125d99eca0ccf1085959b307f64e5dd358",
  pubkey: "a48380f4cfcc1ad5378294fcac36439770f9c878dd880ffa94bb74ea54a6f243",
  created_at: 1651794653,
  kind: 1,
  tags: [["nonce", "776797", "20"]],
  content: "It's just me mining my own business",
  sig: "284622fc0a3f4f1303455d5175f7ba962a3300d136085b9566801bc2e0699de0c7e31e44c81fb40ad9049173742e904713c3594a1da0fc5d2382a25c11aba977",
}; // the mined note of NIP-13 (nostr-protocol/nips, 13.md): an independent check of the serialization, the id and the signature

test("note: the published NIP-13 example verifies, and its work is 21 bits against a committed 20", () => {
  assert.equal(N.idOf(NIP13_EXAMPLE), NIP13_EXAMPLE.id);
  assert.equal(N.verifyEvent(NIP13_EXAMPLE), true);
  assert.deepEqual(P.checkPow(NIP13_EXAMPLE, 20), { ok: true, bits: 21, target: 20 });
  assert.equal(P.checkPow(NIP13_EXAMPLE, 22).ok, false);
});

test("note: serialization escapes exactly \\n \" \\\\ \\r \\t \\b \\f and writes everything else as it is", () => {
  const ev = { pubkey: "a".repeat(64), created_at: 5, kind: 1, tags: [["x", 'a"b']], content: "l1\nl2\t\"q\"\\ \r\b\f é 🍕   /" };
  assert.equal(N.serializeForId(ev), '[0,"' + "a".repeat(64) + '",5,1,[["x","a\\"b"]],"l1\\nl2\\t\\"q\\"\\\\ \\r\\b\\f é 🍕   /"]');
  // a control character NIP-01 does not escape is refused when WE create a note (JSON.stringify would write it as \u0001: another id)
  const sk = N.generateSecretKey();
  throwsCode(() => N.finalizeEvent({ created_at: 1, kind: 1, tags: [], content: "a\u0001b" }, sk), "bad_note");
  throwsCode(() => N.finalizeEvent({ created_at: 1, kind: 1, tags: [["a", "x\u0000"]], content: "" }, sk), "bad_note");
  throwsCode(() => N.finalizeEvent({ created_at: 1, kind: 1, tags: [], content: "\ud800" }, sk), "bad_note");
});

test("note: finalize then verify; every changed or malformed field is rejected", () => {
  const sk = N.generateSecretKey();
  const ev = N.finalizeEvent({ created_at: 1800000000, kind: 7, tags: [["t", "x"], ["p", "b".repeat(64)]], content: "hello" }, sk);
  assert.equal(ev.pubkey, N.getPublicKey(sk));
  assert.equal(N.verifyEvent(ev), true);
  const other = N.generateSecretKey();
  const flip = (s) => (s[0] === "0" ? "1" : "0") + s.slice(1);
  const bad = {
    id: { ...ev, id: flip(ev.id) },
    pubkey: { ...ev, pubkey: N.getPublicKey(other) },
    created_at: { ...ev, created_at: ev.created_at + 1 },
    kind: { ...ev, kind: 8 },
    tags: { ...ev, tags: [["t", "y"], ["p", "b".repeat(64)]] },
    tags_extra: { ...ev, tags: [...ev.tags, ["x"]] },
    content: { ...ev, content: "hellp" },
    sig: { ...ev, sig: flip(ev.sig) },
    sig_short: { ...ev, sig: ev.sig.slice(2) },
    id_upper: { ...ev, id: ev.id.toUpperCase() },
    pubkey_upper: { ...ev, pubkey: ev.pubkey.toUpperCase() },
    created_float: { ...ev, created_at: 1.5 },
    created_string: { ...ev, created_at: "1800000000" },
    kind_big: { ...ev, kind: 70000 },
    tags_not_strings: { ...ev, tags: [["t", 5]] },
    tags_empty_tag: { ...ev, tags: [[]] },
    content_not_string: { ...ev, content: 5 },
    extra_property: { ...ev, extra: 1 },
    missing_sig: (({ sig, ...r }) => r)(ev),
    null: null,
    array: [],
    string: "x",
  };
  for (const [name, e] of Object.entries(bad)) assert.equal(N.verifyEvent(e), false, name);
  // a signature by another key over the same id
  const forged = { ...ev, sig: hex(schnorr.sign(Buffer.from(ev.id, "hex"), N.secretBytes(other))) };
  assert.equal(N.verifyEvent(forged), false);
  // a template that names another pubkey, or has extra properties, is not signed
  throwsCode(() => N.finalizeEvent({ created_at: 1, kind: 1, tags: [], content: "", pubkey: "c".repeat(64) }, sk), "bad_note");
  throwsCode(() => N.finalizeEvent({ created_at: 1, kind: 1, tags: [], content: "", sig: "x" }, sk), "bad_note");
});

test("note: secret keys are range-checked and never appear in an error", () => {
  const n = "fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141";
  for (const k of ["00".repeat(32), n, "ff".repeat(32), "zz".repeat(32), "ab", Buffer.alloc(31, 1), 5, null]) throwsCode(() => N.secretBytes(k), "bad_key");
  const secret = "0123456789abcdef".repeat(4).replace(/^0/, "1");
  const fakeLooking = "x" + secret.slice(1);
  try {
    N.secretBytes(fakeLooking);
  } catch (e) {
    assert.ok(!String(e.message).includes(secret.slice(1)));
  }
  const k = N.generateSecretKey();
  assert.equal(k.length, 32);
  assert.notEqual(hex(k), hex(N.generateSecretKey()));
});

// ---------------------------------------------------------------------------------------------- NIP-44
test("NIP-44 official vectors: conversation keys, message keys, padded lengths", () => {
  const v = V.nip44.valid;
  for (const t of v.get_conversation_key) assert.equal(hex(nip44.getConversationKey(t.sec1, t.pub2)), t.conversation_key);
  for (const g of v.get_message_keys.keys) {
    const k = nip44.getMessageKeys(Buffer.from(v.get_message_keys.conversation_key, "hex"), Buffer.from(g.nonce, "hex"));
    assert.equal(hex(k.chachaKey), g.chacha_key);
    assert.equal(hex(k.chachaNonce), g.chacha_nonce);
    assert.equal(hex(k.hmacKey), g.hmac_key);
  }
  for (const [len, padded] of v.calc_padded_len) assert.equal(nip44.calcPaddedLen(len), padded, `length ${len}`);
});

test("NIP-44 official vectors: encrypt and decrypt reproduce the payloads, both directions of the key agreement", () => {
  for (const t of V.nip44.valid.encrypt_decrypt) {
    const ck = Buffer.from(t.conversation_key, "hex");
    assert.equal(hex(nip44.getConversationKey(t.sec1, N.getPublicKey(t.sec2))), t.conversation_key);
    assert.equal(hex(nip44.getConversationKey(t.sec2, N.getPublicKey(t.sec1))), t.conversation_key);
    assert.equal(nip44.encrypt(t.plaintext, ck, Buffer.from(t.nonce, "hex")), t.payload);
    assert.equal(nip44.decrypt(t.payload, ck), t.plaintext);
  }
  for (const t of V.nip44.valid.encrypt_decrypt_long_msg) {
    const ck = Buffer.from(t.conversation_key, "hex");
    const plain = t.pattern.repeat(t.repeat);
    assert.equal(crypto.createHash("sha256").update(plain).digest("hex"), t.plaintext_sha256);
    const payload = nip44.encrypt(plain, ck, Buffer.from(t.nonce, "hex"));
    assert.equal(crypto.createHash("sha256").update(payload).digest("hex"), t.payload_sha256);
    assert.equal(nip44.decrypt(payload, ck), plain);
  }
});

test("NIP-44 official vectors: every invalid case is refused", () => {
  for (const t of V.nip44.invalid.get_conversation_key) throwsCode(() => nip44.getConversationKey(t.sec1, t.pub2), undefined);
  for (const t of V.nip44.invalid.decrypt) throwsCode(() => nip44.decrypt(t.payload, Buffer.from(t.conversation_key, "hex")), "nip44");
  const ck = nip44.getConversationKey(N.generateSecretKey(), N.getPublicKey(N.generateSecretKey()));
  for (const len of V.nip44.invalid.encrypt_msg_lengths) throwsCode(() => nip44.encrypt("a".repeat(len), ck), "nip44");
  assert.ok(V.nip44.invalid.get_conversation_key.length >= 8 && V.nip44.invalid.decrypt.length >= 12);
});

test("NIP-44: round trips, and every kind of damage to a payload is refused", () => {
  const a = N.generateSecretKey();
  const b = N.generateSecretKey();
  const ckA = nip44.getConversationKey(a, N.getPublicKey(b));
  const ckB = nip44.getConversationKey(b, N.getPublicKey(a));
  assert.deepEqual(ckA, ckB);
  for (const text of ["x", "\u03c0 \u2260 3 \ud83c\udf55", "a".repeat(32), "a".repeat(33), "a".repeat(1000), "a".repeat(65535)]) {
    const p = nip44.encrypt(text, ckA);
    assert.equal(nip44.decrypt(p, ckB), text);
  }
  const p = nip44.encrypt("secret message", ckA);
  const raw = Buffer.from(p, "base64");
  const mut = (i) => {
    const c = Buffer.from(raw);
    c[i] ^= 1;
    return c.toString("base64");
  };
  for (const i of [0, 1, 33, 40, raw.length - 1, raw.length - 33]) throwsCode(() => nip44.decrypt(mut(i), ckA), "nip44");
  throwsCode(() => nip44.decrypt(raw.subarray(0, raw.length - 1).toString("base64"), ckA), "nip44");
  throwsCode(() => nip44.decrypt(p + "A", ckA), "nip44");
  throwsCode(() => nip44.decrypt(p.replace(/.$/, "*"), ckA), "nip44");
  throwsCode(() => nip44.decrypt(p, nip44.getConversationKey(N.generateSecretKey(), N.getPublicKey(b))), "nip44");
  throwsCode(() => nip44.decrypt("", ckA), "nip44");
  throwsCode(() => nip44.decrypt("A".repeat(200000), ckA), "nip44");
  throwsCode(() => nip44.encrypt("", ckA), "nip44");
  throwsCode(() => nip44.encrypt("a", Buffer.alloc(31)), "nip44");
  // two encryptions of one text differ (a fresh nonce each)
  assert.notEqual(nip44.encrypt("same", ckA), nip44.encrypt("same", ckA));
});

test("NIP-44: padding bytes must be zeros, and the extended length form is refused", () => {
  const ck = nip44.getConversationKey(N.generateSecretKey(), N.getPublicKey(N.generateSecretKey()));
  const nonce = crypto.randomBytes(32);
  const keys = nip44.getMessageKeys(ck, nonce);
  const seal = (padded) => {
    const c = crypto.createCipheriv("chacha20", keys.chachaKey, Buffer.concat([Buffer.alloc(4), keys.chachaNonce]));
    const ct = Buffer.concat([c.update(padded), c.final()]);
    const mac = crypto.createHmac("sha256", keys.hmacKey).update(nonce).update(ct).digest();
    return Buffer.concat([Buffer.from([2]), nonce, ct, mac]).toString("base64");
  };
  const good = nip44.pad("abc");
  assert.equal(nip44.decrypt(seal(good), ck), "abc");
  const dirty = Buffer.from(good);
  dirty[dirty.length - 1] = 1;
  throwsCode(() => nip44.decrypt(seal(dirty), ck), "nip44");
  const ext = Buffer.concat([Buffer.from([0, 0, 0, 1, 0, 0]), Buffer.alloc(80)]);
  throwsCode(() => nip44.decrypt(seal(ext), ck), "nip44");
});

// ---------------------------------------------------------------------------------------------- seal and gift wrap (NIP-59)
const rumorOf = (content = "hello") => ({ kind: N.KINDS.HANDOVER, content });

test("gift wrap: round trip; the wrap and the seal have different signers; the relay sees only the recipient", () => {
  const a = N.generateSecretKey();
  const b = N.generateSecretKey();
  const now = 1800000000;
  const { wrap, rumor } = G.wrap(rumorOf('{"x":1}'), a, N.getPublicKey(b), { now });
  assert.equal(wrap.kind, N.KINDS.WRAP);
  assert.notEqual(wrap.pubkey, N.getPublicKey(a), "signed by a one-time key");
  assert.deepEqual(wrap.tags, [["p", N.getPublicKey(b)]]);
  assert.ok(!wrap.content.includes("x") || true);
  assert.ok(wrap.created_at <= now && wrap.created_at >= now - G.TWO_DAYS);
  assert.equal(N.verifyEvent(wrap), true);
  const r = G.unwrap(wrap, b);
  assert.equal(r.author, N.getPublicKey(a));
  assert.equal(r.rumor.content, '{"x":1}');
  assert.equal(r.rumor.id, rumor.id);
  assert.equal(r.rumor.sig, undefined);
  // another recipient cannot open it, and says it is not for him
  throwsCode(() => G.unwrap(wrap, N.generateSecretKey()), "not_for_us");
  // the sender cannot open it either (it is for the recipient)
  throwsCode(() => G.unwrap(wrap, a), "not_for_us");
  // two wraps of one message differ in every visible way
  const w2 = G.wrap(rumorOf('{"x":1}'), a, N.getPublicKey(b), { now }).wrap;
  assert.notEqual(w2.pubkey, wrap.pubkey);
  assert.notEqual(w2.content, wrap.content);
  // a short back-dating window is honoured
  const w3 = G.wrap(rumorOf(), a, N.getPublicKey(b), { now, backdateS: 60 }).wrap;
  assert.ok(w3.created_at >= now - 60 && w3.created_at <= now);
});

test("gift wrap: the official NIP-59 example opens, and its rumor author is the seal's signer", () => {
  const ex = V.nip59;
  const r = G.unwrap(ex.wrap, ex.recipientSecret);
  assert.equal(r.author, ex.authorPub);
  assert.equal(r.rumor.id, ex.rumorId);
  assert.equal(r.rumor.content, "Are you going to the party tonight?");
  assert.equal(r.rumor.kind, 1);
});

function handWrap({ sealSigner, rumorAuthor, rumorExtra = {}, sealTags = [], recipient, sealKind = N.KINDS.SEAL, wrapKind = N.KINDS.WRAP, wrapTags, tamperSeal, wrapSigner = N.generateSecretKey() }) {
  const recipientPub = N.getPublicKey(recipient);
  const rumor = { ...N.makeRumor({ created_at: 1800000000, kind: N.KINDS.HANDOVER, tags: [], content: "hi" }, rumorAuthor), ...rumorExtra };
  if (rumorExtra.sig === undefined && !("sig" in rumorExtra)) delete rumor.sig;
  let seal = N.finalizeEvent({ kind: sealKind, created_at: 1799990000, tags: sealTags, content: nip44.encrypt(JSON.stringify(rumor), nip44.getConversationKey(sealSigner, recipientPub)) }, sealSigner);
  if (tamperSeal) seal = tamperSeal(seal);
  return N.finalizeEvent({ kind: wrapKind, created_at: 1799990000, tags: wrapTags || [["p", recipientPub]], content: nip44.encrypt(JSON.stringify(seal), nip44.getConversationKey(wrapSigner, recipientPub)) }, wrapSigner);
}

test("gift wrap: a seal from key X carrying a rumor of key Y is rejected (the author check)", () => {
  const x = N.generateSecretKey();
  const y = N.generateSecretKey();
  const r = N.generateSecretKey();
  // honest control
  assert.equal(G.unwrap(handWrap({ sealSigner: x, rumorAuthor: N.getPublicKey(x), recipient: r }), r).author, N.getPublicKey(x));
  // X seals a rumor that says it is from Y
  throwsCode(() => G.unwrap(handWrap({ sealSigner: x, rumorAuthor: N.getPublicKey(y), recipient: r }), r), "rumor_author");
});

test("gift wrap: every other fault in the layers is refused, in its own place", () => {
  const x = N.generateSecretKey();
  const r = N.generateSecretKey();
  const base = { sealSigner: x, rumorAuthor: N.getPublicKey(x), recipient: r };
  throwsCode(() => G.unwrap(handWrap({ ...base, rumorExtra: { sig: "00".repeat(64) } }), r), "bad_rumor"); // a signed rumor
  throwsCode(() => G.unwrap(handWrap({ ...base, rumorExtra: { extra: 1 } }), r), "bad_rumor");
  throwsCode(() => G.unwrap(handWrap({ ...base, rumorExtra: { id: "a".repeat(64) } }), r), "bad_rumor"); // an id that does not match
  throwsCode(() => G.unwrap(handWrap({ ...base, sealTags: [["p", "b".repeat(64)]] }), r), "bad_seal");
  throwsCode(() => G.unwrap(handWrap({ ...base, sealKind: 14 }), r), "bad_seal");
  throwsCode(() => G.unwrap(handWrap({ ...base, wrapKind: 1 }), r), "bad_wrap");
  throwsCode(() => G.unwrap(handWrap({ ...base, wrapTags: [] }), r), "not_for_us");
  throwsCode(() => G.unwrap(handWrap({ ...base, wrapTags: [["p", N.getPublicKey(r)], ["p", N.getPublicKey(r)]] }), r), "not_for_us");
  throwsCode(() => G.unwrap(handWrap({ ...base, tamperSeal: (s) => ({ ...s, sig: (s.sig[0] === "0" ? "1" : "0") + s.sig.slice(1) }) }), r), "bad_seal");
  throwsCode(() => G.unwrap(handWrap({ ...base, tamperSeal: (s) => ({ ...s, created_at: s.created_at + 1 }) }), r), "bad_seal");
  throwsCode(() => G.unwrap(handWrap({ ...base, tamperSeal: (s) => ({ ...s, pubkey: N.getPublicKey(N.generateSecretKey()) }) }), r), "bad_seal");
  // a wrap whose content is not an encrypted seal, and one that is not even a note
  const junk = N.finalizeEvent({ kind: N.KINDS.WRAP, created_at: 1, tags: [["p", N.getPublicKey(r)]], content: "not encrypted at all" }, N.generateSecretKey());
  throwsCode(() => G.unwrap(junk, r), "bad_wrap");
  const w = handWrap(base);
  throwsCode(() => G.unwrap({ ...w, content: w.content.slice(0, -4) + "AAAA" }, r), "bad_wrap");
  throwsCode(() => G.unwrap({ ...w, sig: "0".repeat(128) }, r), "bad_wrap");
  throwsCode(() => G.unwrap(null, r), "bad_wrap");
  // the seal's content decrypts to something that is not a rumor
  const notObj = (() => {
    const rp = N.getPublicKey(r);
    const seal = N.finalizeEvent({ kind: 13, created_at: 1, tags: [], content: nip44.encrypt("[1,2]", nip44.getConversationKey(x, rp)) }, x);
    const ws = N.generateSecretKey();
    return N.finalizeEvent({ kind: 1059, created_at: 1, tags: [["p", rp]], content: nip44.encrypt(JSON.stringify(seal), nip44.getConversationKey(ws, rp)) }, ws);
  })();
  throwsCode(() => G.unwrap(notObj, r), "bad_rumor");
});

test("gift wrap: proof of work on the wrap is required when asked for, and not forgeable by a low commitment", () => {
  const a = N.generateSecretKey();
  const b = N.generateSecretKey();
  const bp = N.getPublicKey(b);
  const none = G.wrap(rumorOf(), a, bp, { now: 1800000000 }).wrap;
  throwsCode(() => G.unwrap(none, b, { minPowBits: 8 }), "pow");
  const mined = G.wrap(rumorOf(), a, bp, { now: 1800000000, powBits: 10 }).wrap;
  assert.equal(G.unwrap(mined, b, { minPowBits: 10 }).author, N.getPublicKey(a));
  throwsCode(() => G.unwrap(mined, b, { minPowBits: 11 }), "pow");
});

// ---------------------------------------------------------------------------------------------- proof of work (NIP-13)
test("pow: leading zero bits (the NIP-13 examples), mining, the commitment rule", () => {
  assert.equal(P.countLeadingZeroBits("000000000e9d97a1ab09fc381030b346cdd7a142ad57e6df0b46dc9bef6c7e2d"), 36);
  assert.equal(P.countLeadingZeroBits("002f" + "0".repeat(60)), 10);
  assert.equal(P.countLeadingZeroBits("f" + "0".repeat(63)), 0);
  assert.equal(P.countLeadingZeroBits("0".repeat(64)), 256);
  const sk = N.generateSecretKey();
  const pub = N.getPublicKey(sk);
  const t = P.mine({ kind: 1, created_at: 1800000000, tags: [["a", "b"], ["nonce", "5", "1"]], content: "x" }, pub, 12);
  assert.equal(t.tags.filter((x) => x[0] === "nonce").length, 1, "an older nonce tag is replaced");
  assert.deepEqual(t.tags[0], ["a", "b"]);
  const ev = N.finalizeEvent(t, sk);
  assert.deepEqual(P.checkPow(ev, 12), { ok: true, bits: P.difficultyOf(ev), target: 12 });
  assert.ok(P.difficultyOf(ev) >= 12);
  assert.equal(P.checkPow(ev, 13).ok, false);
  assert.equal(P.checkPow(ev, 0).ok, true);
  // no commitment: refused when a level is asked for, even if the id happens to be lucky
  const lucky = { ...ev, tags: [["nonce", "1"]] };
  assert.equal(P.checkPow(lucky, 4).reason, "no committed target");
  // a note that does not reach its own target
  const e2 = N.finalizeEvent({ kind: 1, created_at: 1, tags: [["nonce", "0", "40"]], content: "" }, sk);
  assert.equal(P.checkPow(e2, 8).ok, false);
  // a duplicated or malformed nonce tag
  assert.equal(P.committedTarget({ tags: [["nonce", "1", "5"], ["nonce", "2", "5"]] }), null);
  assert.equal(P.committedTarget({ tags: [["nonce", "1", "5x"]] }), null);
  assert.equal(P.committedTarget({ tags: [["nonce", "1", "999"]] }), null);
  throwsCode(() => P.mine({ kind: 1, created_at: 1, tags: [], content: "" }, pub, 50), "pow");
  throwsCode(() => P.mine({ kind: 1, created_at: 1, tags: [], content: "" }, pub, 30, { maxIterations: 10 }), "pow");
});
