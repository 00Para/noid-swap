"use strict";
// P3.4: offers: build, validate, filter (caps, pinned contract, profile, lock kind, expiry, proof of work, board tag), refresh, withdraw, and the private test board (amendment G).
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const N = require("../lib/board/note");
const P = require("../lib/board/pow");
const nip44 = require("../lib/board/nip44");
const O = require("../lib/board/offer");
const priv = require("../lib/board/privboard");

const HTLC = "0x" + "ab".repeat(20);
const NOW = 1800000000;
const RELAYS = ["wss://a.relays.net", "wss://b.relays.org"];
const policy = O.makePolicy({ pinnedHtlc: { 11155111: HTLC }, minPowBits: 8 });
const TERMS = { side: "sell-noid", noid: "5000000", wei: "1000000000000000", chain: "11155111", profile: "sepolia", htlc: HTLC, lock: "poseidon", variant: "raw", cv: "1", relays: RELAYS };
const mk = (over = {}, o = {}) => {
  const secret = o.secret || N.generateSecretKey();
  return { secret, ev: O.buildOffer({ secret, policy, now: NOW, terms: { ...TERMS, ...over }, ...o }) };
};
const ctx = (extra = {}) => ({ policy, now: NOW + 10, ...extra });
const why = (ev, c = ctx()) => {
  const r = O.parseOffer(ev, c);
  assert.equal(r.ok, false, "expected a refusal");
  return r.reason;
};
const bad = (code, fn) => assert.throws(fn, (e) => e instanceof N.BoardError && e.code === code);

/** A note with exactly the tags given (for faults the builder would refuse to make). */
function raw(tags, { secret = N.generateSecretKey(), created_at = NOW, content = "", kind = N.KINDS.OFFER, pow = 8 } = {}) {
  let t = { kind, created_at, tags, content };
  if (pow) t = P.mine(t, N.getPublicKey(secret), pow);
  return N.finalizeEvent(t, secret);
}
const baseTags = (over = {}) => {
  const t = { ...TERMS, d: "0123456789abcdef0123456789abcdef", status: "open", app: "1", ...over };
  return [["d", t.d], ["t", O.PUBLIC_TAG], ["expiration", String(NOW + 1800)], ["alt", O.ALT_TEXT], ["side", t.side], ["noid", t.noid], ["wei", t.wei], ["chain", t.chain], ["profile", t.profile], ["htlc", t.htlc], ["lock", t.lock], ["variant", t.variant], ["cv", t.cv], ["relays", ...t.relays], ["status", t.status], ["app", t.app]];
};

test("offer: built, signed, parsed back; the displayed price is computed; the tags are the fixed list and carry no address of a person, no hashlock, no height, no text", () => {
  const { ev } = mk();
  const r = O.parseOffer(ev, ctx());
  assert.equal(r.ok, true);
  assert.equal(r.offer.terms.noid, "5000000");
  assert.equal(r.offer.priceWeiPerNoid, "200000000000000"); // 0.001 ETH for 5 NOID
  assert.equal(r.offer.expiration, NOW + 1800);
  assert.ok(r.offer.powBits >= 8);
  assert.equal(r.offer.pubkey, ev.pubkey, "the note's key is the maker's messaging key for this offer");
  const names = ev.tags.map((t) => t[0]);
  assert.deepEqual([...new Set(names)].sort(), ["alt", "app", "chain", "cv", "d", "expiration", "htlc", "lock", "noid", "nonce", "profile", "relays", "side", "status", "t", "variant", "wei"].sort());
  const text = JSON.stringify(ev);
  assert.ok(!/o1[0-9a-z]{20,}/.test(text), "no Parano1d address");
  assert.ok(!/0x[0-9a-f]{40}/i.test(text.replace(HTLC, "")), "no other Ethereum address");
  assert.ok(!/hashlock|h_create|deadline/i.test(text));
  assert.equal(ev.kind, N.KINDS.OFFER);
  assert.ok(ev.kind >= 30000 && ev.kind < 40000, "addressable");
  assert.equal(ev.content, "");
  // d is 16 random bytes, new each time
  assert.match(r.offer.terms.d, /^[0-9a-f]{32}$/);
  assert.notEqual(mk().ev.tags[0][1], mk().ev.tags[0][1]);
});

test("offer: the builder refuses everything outside the policy (an offer outside it is never made)", () => {
  const cases = {
    below_minimum: { noid: "4999999" },
    above_cap: { noid: "20000001" },
    wei_cap: { wei: "10000000000000001" },
    wei_zero: { wei: "0" },
    leading_zero: { noid: "05000000" },
    not_number: { noid: "5e6" },
    negative: { noid: "-5000000" },
    side: { side: "swap" },
    production: { profile: "production", chain: "1" },
    rehearsal_not_allowed: { profile: "rehearsal", chain: "31337" },
    chain_mismatch: { chain: "1" },
    unpinned_contract: { htlc: "0x" + "cd".repeat(20) },
    bad_contract: { htlc: "0x123" },
    bad_checksum: { htlc: "0x" + "aB".repeat(20) },
    sha256_lock: { lock: "sha256" },
    stock_variant: { variant: "stock" },
    cv: { cv: "3" },
    one_relay: { relays: ["wss://a.relays.net"] },
    six_relays: { relays: ["wss://a.relays.net", "wss://b.relays.org", "wss://c.relays.io", "wss://d.relays.dev", "wss://e.relays.app", "wss://f.relays.xyz"] },
    plain_ws: { relays: ["ws://a.relays.net", "wss://b.relays.org"] },
    localhost_relay: { relays: ["wss://localhost", "wss://b.relays.org"] },
    ip_relay: { relays: ["wss://10.0.0.1", "wss://b.relays.org"] },
    duplicate_relay: { relays: ["wss://a.relays.net", "wss://a.relays.net"] },
    unnormal_relay: { relays: ["wss://A.relays.net/", "wss://b.relays.org"] },
    status: { status: "pending" },
    app: { app: "2" },
  };
  for (const [name, over] of Object.entries(cases)) assert.throws(() => mk(over), (e) => e instanceof N.BoardError && e.code === "bad_offer", name);
  bad("bad_offer", () => mk({}, { expirySeconds: 1801 }));
  bad("bad_offer", () => mk({}, { expirySeconds: 0 }));
  bad("bad_offer", () => O.buildOffer({ secret: N.generateSecretKey(), policy: O.makePolicy({}), now: NOW, terms: TERMS })); // no pinned contract: nothing is accepted
  // exact edges that ARE allowed
  mk({ noid: "5000000" });
  mk({ noid: "20000000", wei: "10000000000000000" });
});

test("offer: every filter on a note from a relay (a note made by hand, as an attacker would)", () => {
  const ok = O.parseOffer(raw(baseTags()), ctx());
  assert.equal(ok.ok, true, ok.reason);
  const sk = N.generateSecretKey();
  const t = (over) => raw(baseTags(over));
  // the terms
  for (const over of [{ noid: "4999999" }, { noid: "20000001" }, { profile: "production", chain: "1" }, { htlc: "0x" + "cd".repeat(20) }, { lock: "sha256" }, { variant: "stock" }, { cv: "9" }, { relays: ["wss://localhost", "wss://b.relays.org"] }, { app: "2" }, { status: "x" }]) assert.ok(why(t(over)));
  // expiry
  assert.equal(why(raw(baseTags()), ctx({ now: NOW + 1801 })), "expired");
  assert.equal(why(raw(baseTags(), { created_at: NOW + 1000 }), ctx()), "from the future");
  const tooLong = baseTags().map((x) => (x[0] === "expiration" ? ["expiration", String(NOW + 5000)] : x));
  assert.equal(why(raw(tooLong)), "expires too late");
  assert.equal(why(raw(baseTags().filter((x) => x[0] !== "expiration"))), "expiration");
  assert.equal(why(raw(baseTags().map((x) => (x[0] === "expiration" ? ["expiration", "soon"] : x)))), "expiration");
  // tags
  assert.match(why(raw([...baseTags(), ["contact", "someone"]])), /not allowed/);
  assert.match(why(raw([...baseTags(), ["noid", "5000000"]])), /not allowed or repeated/);
  assert.match(why(raw([...baseTags(), ["l", "free text here"]])), /not allowed/);
  assert.match(why(raw([...baseTags(), ["bob_noid", "o1xx"]])), /not allowed/);
  assert.equal(why(raw(baseTags().filter((x) => x[0] !== "cv"))), "a term is missing");
  assert.equal(why(raw(baseTags().map((x) => (x[0] === "d" ? ["d", "short"] : x)))), "d");
  assert.equal(why(raw(baseTags().map((x) => (x[0] === "alt" ? ["alt", "buy now"] : x)))), "alt");
  assert.equal(why(raw(baseTags().map((x) => (x[0] === "t" ? ["t", "other-board"] : x)))), "not this board");
  assert.equal(why(raw(baseTags(), { content: "hello" })), "an offer has no content");
  assert.equal(why(raw(baseTags(), { kind: 1 })), "not an offer");
  assert.equal(why(raw(baseTags().map((x) => (x[0] === "noid" ? ["noid", "5000000", "extra"] : x)))), "tag noid has the wrong number of values");
  // proof of work
  assert.match(why(raw(baseTags(), { pow: 0 })), /proof of work/);
  assert.match(why(raw(baseTags(), { pow: 4 })), /proof of work/);
  const noCommit = raw(baseTags().concat([]), { pow: 0 });
  assert.match(why(noCommit), /proof of work/);
  assert.equal(O.parseOffer(raw(baseTags(), { pow: 8 }), ctx()).ok, true);
  // a tampered or unsigned note
  const good = raw(baseTags());
  assert.equal(why({ ...good, content: "x" }), "not a valid signed note");
  assert.equal(why({ ...good, sig: "0".repeat(128) }), "not a valid signed note");
  assert.equal(why(null), "not a valid signed note");
  void sk;
});

test("offers: the newest version of each (author, d) wins; closed and taken offers are not shown; smallest first; sides can be hidden", () => {
  const s1 = N.generateSecretKey();
  const s2 = N.generateSecretKey();
  const s3 = N.generateSecretKey();
  const a1 = O.buildOffer({ secret: s1, policy, now: NOW, terms: { ...TERMS, noid: "9000000", wei: "2000000000000000" } });
  const a1p = O.parseOffer(a1, ctx()).offer;
  const a2 = O.refreshOffer(a1p, { secret: s1, policy, now: NOW + 600 }); // a later version of the same offer
  const b = O.buildOffer({ secret: s2, policy, now: NOW, terms: { ...TERMS, noid: "5000000" } });
  const c = O.buildOffer({ secret: s3, policy, now: NOW, terms: { ...TERMS, noid: "5000000", wei: "500000000000000", side: "buy-noid" } });
  const junk = { ...b, content: "tampered" };
  const closedSecret = N.generateSecretKey();
  const closedOffer = O.buildOffer({ secret: closedSecret, policy, now: NOW, terms: { ...TERMS, noid: "6000000" } });
  const closedParsed = O.parseOffer(closedOffer, ctx()).offer;
  const closedNew = O.refreshOffer(closedParsed, { secret: closedSecret, policy, now: NOW + 5, status: "closed" });
  const takenSecret = N.generateSecretKey();
  const takenOffer = O.buildOffer({ secret: takenSecret, policy, now: NOW, terms: { ...TERMS, noid: "8000000" } });
  const takenNew = O.refreshOffer(O.parseOffer(takenOffer, ctx()).offer, { secret: takenSecret, policy, now: NOW + 5, status: "taken" });
  const r = O.filterOffers([a1, a2, b, c, junk, closedOffer, closedNew, takenOffer, takenNew], ctx({ now: NOW + 700 }));
  assert.deepEqual(r.shown.map((o) => o.terms.noid), ["5000000", "5000000", "9000000"]);
  // equal NOID amounts: the cheaper (fewer wei per NOID) first
  assert.deepEqual(r.shown.slice(0, 2).map((o) => o.terms.side), ["buy-noid", "sell-noid"]);
  assert.equal(r.shown.filter((o) => o.id === a1.id).length, 0, "the old version is gone");
  assert.equal(r.shown.some((o) => o.id === a2.id), true);
  assert.deepEqual(r.rejected.map((x) => x.id), [junk.id]);
  assert.equal(r.all.length, 5);
  assert.equal(r.all.filter((o) => o.terms.status === "taken").length, 1);
  assert.equal(r.shown.some((o) => o.terms.noid === "6000000" || o.terms.noid === "8000000"), false);
  // sides the app does not show now
  assert.deepEqual(O.filterOffers([a1, b, c], ctx({ hideSides: ["sell-noid"] })).shown.map((o) => o.terms.side), ["buy-noid"]);
  // at the expiry an offer disappears by itself
  assert.equal(O.filterOffers([b], ctx({ now: NOW + 1801 })).shown.length, 0);
});

test("refresh and withdraw: same key and same d, a new note; another key cannot refresh; a withdrawal is a closed note plus a deletion request", () => {
  const { secret, ev } = mk();
  const prev = O.parseOffer(ev, ctx()).offer;
  const re = O.refreshOffer(prev, { secret, policy, now: NOW + 600 });
  const rp = O.parseOffer(re, ctx({ now: NOW + 610 })).offer;
  assert.equal(rp.pubkey, prev.pubkey);
  assert.equal(rp.terms.d, prev.terms.d);
  assert.notEqual(rp.id, prev.id);
  assert.equal(rp.termsKey, prev.termsKey, "a take of any version with equal terms is acceptable");
  assert.equal(rp.expiration, NOW + 600 + 1800);
  assert.equal(O.parseOffer(O.refreshOffer(prev, { secret, policy, now: NOW + 600, status: "taken" }), ctx({ now: NOW + 610 })).offer.terms.status, "taken");
  bad("bad_offer", () => O.refreshOffer(prev, { secret: N.generateSecretKey(), policy, now: NOW + 600 }));
  const w = O.withdrawOffer(rp, { secret, policy, now: NOW + 700 });
  const closed = O.parseOffer(w.closed, ctx({ now: NOW + 710 })).offer;
  assert.equal(closed.terms.status, "closed");
  assert.equal(closed.terms.d, prev.terms.d);
  assert.ok(closed.expiration <= NOW + 700 + 300);
  assert.equal(w.deletion.kind, N.KINDS.DELETION);
  assert.equal(N.verifyEvent(w.deletion), true);
  assert.deepEqual(w.deletion.tags, [["a", `${N.KINDS.OFFER}:${prev.pubkey}:${prev.terms.d}`], ["e", rp.id], ["k", String(N.KINDS.OFFER)]]);
  assert.equal(O.filterOffers([ev, re, w.closed], ctx({ now: NOW + 710 })).shown.length, 0);
  // an old open note re-served by a relay after the withdrawal does not bring the offer back
  assert.equal(O.filterOffers([w.closed, ev], ctx({ now: NOW + 710 })).shown.length, 0);
});

test("offer: the subscription filters follow the board", () => {
  const f = O.boardFilters(ctx());
  assert.deepEqual(f[0].kinds, [N.KINDS.OFFER]);
  assert.deepEqual(f[0]["#t"], [O.PUBLIC_TAG]);
  assert.ok(f[0].since < NOW && f[0].since > NOW - 3600);
  const inv = priv.newInviteSecret();
  const g = O.boardFilters(ctx({ board: { mode: "private", inviteSecret: inv } }));
  assert.equal(g[0]["#t"].length, 3);
  assert.ok(!g[0]["#t"].includes(O.PUBLIC_TAG));
});

// ---------------------------------------------------------------------------------------------- the private test board (amendment G)
test("private board: relays and outsiders see neither amounts nor sides; members read the offer; others cannot", () => {
  const inv = priv.newInviteSecret();
  const board = { mode: "private", inviteSecret: inv };
  const secret = N.generateSecretKey();
  const ev = O.buildOffer({ secret, policy, now: NOW, terms: TERMS, board });
  const text = JSON.stringify(ev);
  for (const secretish of ["sell-noid", "5000000", "1000000000000000", "poseidon", HTLC.slice(2), "relays.net", "sepolia"]) assert.ok(!text.includes(secretish), `${secretish} is not visible`);
  assert.deepEqual(ev.tags.map((t) => t[0]).sort(), ["alt", "d", "enc", "expiration", "nonce", "t"]);
  assert.ok(priv.boardTags(inv, NOW).includes(ev.tags.find((t) => t[0] === "t")[1]));
  assert.notEqual(ev.tags.find((t) => t[0] === "t")[1], O.PUBLIC_TAG);
  const r = O.parseOffer(ev, ctx({ board }));
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.offer.terms.side, "sell-noid");
  assert.equal(r.offer.terms.noid, "5000000");
  // the same bytes as a public board: refused (a private note is not a public offer)
  assert.ok(O.parseOffer(ev, ctx()).reason);
  // another group's invite: not this board
  assert.equal(why(ev, ctx({ board: { mode: "private", inviteSecret: priv.newInviteSecret() } })), "not this board");
  // a member lists it; a stranger's list is empty
  assert.equal(O.filterOffers([ev], ctx({ board })).shown.length, 1);
  assert.equal(O.filterOffers([ev], ctx({ board: { mode: "private", inviteSecret: priv.newInviteSecret() } })).shown.length, 0);
});

test("private board: the daily tag changes every day and is accepted a day either side; plain terms or a broken payload are refused", () => {
  const inv = priv.newInviteSecret();
  const board = { mode: "private", inviteSecret: inv };
  const day = 86400;
  const t0 = priv.dailyTag(inv, priv.dayOf(NOW));
  assert.notEqual(t0, priv.dailyTag(inv, priv.dayOf(NOW + day)));
  assert.notEqual(t0, priv.dailyTag(priv.newInviteSecret(), priv.dayOf(NOW)));
  assert.match(t0, /^[0-9a-f]{64}$/);
  const ev = O.buildOffer({ secret: N.generateSecretKey(), policy, now: NOW, terms: TERMS, board });
  assert.equal(priv.boardTags(inv, NOW).length, 3);
  assert.deepEqual(priv.boardTags(inv, NOW)[1], t0);
  assert.deepEqual(priv.boardTags(inv, NOW + day)[0], t0, "yesterday's tag is still valid today");
  assert.ok(!priv.boardTags(inv, NOW + 3 * day).includes(t0), "three days on, it is not");
  // a note carrying the tag of 3 days ago, otherwise fine, is not this board's today
  const stale = raw([["d", "0123456789abcdef0123456789abcdef"], ["t", priv.dailyTag(inv, priv.dayOf(NOW - 3 * day))], ["expiration", String(NOW + 1800)], ["alt", O.ALT_TEXT], ["enc", "1"]]);
  assert.equal(why(stale, ctx({ board })), "not this board");
  // plain terms in a private note are refused (they would leak amounts); so is a changed payload
  const sk = N.generateSecretKey();
  const leaky = raw([["d", "0123456789abcdef0123456789abcdef"], ["t", t0], ["expiration", String(NOW + 1800)], ["alt", O.ALT_TEXT], ["enc", "1"], ["noid", "5000000"]], { secret: sk });
  assert.match(why(leaky, ctx({ board })), /not allowed/);
  const enc = (payload, s = sk) => raw([["d", "0123456789abcdef0123456789abcdef"], ["t", t0], ["expiration", String(NOW + 1800)], ["alt", O.ALT_TEXT], ["enc", "1"]], { secret: s, content: nip44.encrypt(payload, nip44.getConversationKey(s, priv.groupPublicKey(inv))) });
  const terms = [["side", "sell-noid"], ["noid", "5000000"], ["wei", "1000000000000000"], ["chain", "11155111"], ["profile", "sepolia"], ["htlc", HTLC], ["lock", "poseidon"], ["variant", "raw"], ["cv", "1"], ["relays", ...RELAYS], ["status", "open"], ["app", "1"]];
  assert.equal(O.parseOffer(enc(JSON.stringify(terms)), ctx({ board })).ok, true);
  assert.equal(why(enc("not json"), ctx({ board })), "terms do not decrypt");
  assert.equal(why(enc(JSON.stringify({ a: 1 })), ctx({ board })), "terms are not a tag list");
  assert.ok(why(enc(JSON.stringify(terms.map((x) => (x[0] === "noid" ? ["noid", "1"] : x)))), ctx({ board })).includes("below"));
  assert.ok(why(enc(JSON.stringify(terms.map((x) => (x[0] === "lock" ? ["lock", "sha256"] : x)))), ctx({ board })).includes("lock"));
  assert.match(why(enc(JSON.stringify([...terms, ["note", "free"]])), ctx({ board })), /terms are not a tag list|tag note/);
  // content encrypted to a key that is not the group's does not decrypt
  const other = raw([["d", "0123456789abcdef0123456789abcdef"], ["t", t0], ["expiration", String(NOW + 1800)], ["alt", O.ALT_TEXT], ["enc", "1"]], { secret: sk, content: nip44.encrypt(JSON.stringify(terms), nip44.getConversationKey(sk, N.getPublicKey(N.generateSecretKey()))) });
  assert.equal(why(other, ctx({ board })), "terms do not decrypt");
});

test("private board: the take's proof is bound to the invite secret, the offer note and the take key", () => {
  const inv = priv.newInviteSecret();
  const offerId = crypto.randomBytes(32).toString("hex");
  const take = N.getPublicKey(N.generateSecretKey());
  const proof = priv.takeProof(inv, offerId, take);
  assert.match(proof, /^[0-9a-f]{64}$/);
  assert.equal(priv.verifyTakeProof(inv, offerId, take, proof), true);
  assert.equal(priv.verifyTakeProof(priv.newInviteSecret(), offerId, take, proof), false, "another secret");
  assert.equal(priv.verifyTakeProof(inv, crypto.randomBytes(32).toString("hex"), take, proof), false, "another offer");
  assert.equal(priv.verifyTakeProof(inv, offerId, N.getPublicKey(N.generateSecretKey()), proof), false, "another taker");
  for (const p of [undefined, null, "", "00", proof.toUpperCase(), proof.slice(2), proof + "0", 5, {}]) assert.equal(priv.verifyTakeProof(inv, offerId, take, p), false);
  assert.equal(priv.verifyTakeProof(inv, "zz", take, proof), false);
  bad("bad_invite", () => priv.takeProof(Buffer.alloc(31), offerId, take));
  bad("bad_invite", () => priv.dailyTag("x".repeat(32), "2026-01-01"));
  // domain separation: the take proof is not a daily tag nor a group key
  assert.notEqual(proof, priv.dailyTag(inv, priv.dayOf(NOW)));
  assert.notEqual(priv.groupSecret(inv).toString("hex"), proof);
  // the group key is a valid key pair
  assert.match(priv.groupPublicKey(inv), /^[0-9a-f]{64}$/);
  assert.notEqual(priv.groupPublicKey(inv), priv.groupPublicKey(priv.newInviteSecret()));
});
