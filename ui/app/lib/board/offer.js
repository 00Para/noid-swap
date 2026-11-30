"use strict";
/*
 * Offers on the board (piece 3, section 2.2 and amendments G, H): build, validate, filter, refresh, withdraw.
 *
 * An offer is a signed note of the addressable kind KINDS.OFFER, authored by a fresh key per offer (that key is also the maker's messaging key for the swap).
 * Its tags are EXACT values: no free text, no address of a person (the only address is the pinned HTLC contract), no hashlock, no height, no name or contact.
 * Anything outside the fixed tag list makes the note invalid. What an offer may state is decided by a policy the CALLER passes in (the app's own pinned
 * contract per chain, the profiles allowed, the caps); an offer can never widen it.
 *
 * Two modes:
 *   public  : tag t = "no1d-swap-v1", the terms are plain tags.
 *   private : (amendment G) the terms are one NIP-44 payload encrypted to the group key derived from an invite secret; the plain tags are only d,
 *             the daily tag HMAC(invite secret, date), expiration, nonce, alt and `enc`. The take must prove the invite secret (lib/board/privboard.js).
 *
 * Relay URLs inside an offer are attacker-chosen: each one goes through normalizeRelayUrl (wss:// with a public host name only).
 */

const crypto = require("crypto");
const { KINDS, fail, getPublicKey, finalizeEvent, verifyEvent, tagsNamed, BoardError } = require("./note");
const nip44 = require("./nip44");
const { checkPow, mine, difficultyOf } = require("./pow");
const { normalizeRelayUrl } = require("./relay");
const priv = require("./privboard");
const { PROFILES } = require("../swapform");
const { ethAddressProblem } = require("../walletrun");

const PUBLIC_TAG = "no1d-swap-v1";
const ALT_TEXT = "An offer on the No1d Swap test board (an atomic swap of NOID and test-network ether). Not a message for people.";
const APP_VERSION = "1";
const SIDES = ["sell-noid", "buy-noid"];
const STATUSES = ["open", "taken", "closed"];
const LOCK_KINDS = ["poseidon"]; // board v1: the proof-free lock only
const VARIANTS = ["raw"];
const CONTRACT_VERSIONS = ["1", "2"];
const TERM_TAGS = ["side", "noid", "wei", "chain", "profile", "htlc", "lock", "variant", "cv", "relays", "status", "app"];
const PLAIN_TAGS_PUBLIC = ["d", "t", "expiration", "nonce", "alt", ...TERM_TAGS];
const PLAIN_TAGS_PRIVATE = ["d", "t", "expiration", "nonce", "alt", "enc"];
const MIN_RELAYS = 2;
const MAX_RELAYS = 5;

/** What the app accepts. The caller must give `pinnedHtlc` (chain id -> the app's own deployment); without it every offer is refused. */
function makePolicy(p = {}) {
  return {
    allowedProfiles: p.allowedProfiles || ["sepolia"], // never production on the board
    minNoidMicro: p.minNoidMicro ?? 5_000_000n, // the practical minimum from the fee rule (5 NOID)
    pinnedHtlc: p.pinnedHtlc || {},
    contractVersions: p.contractVersions || CONTRACT_VERSIONS,
    minPowBits: p.minPowBits ?? 0,
    maxExpirySeconds: p.maxExpirySeconds ?? 1800,
    clockSkewS: p.clockSkewS ?? 120,
    allowLocalTest: p.allowLocalTest === true,
  };
}

const NOID_RE = /^[1-9]\d{0,19}$/;
const WEI_RE = /^[1-9]\d{0,29}$/;
const CHAIN_RE = /^[1-9]\d{0,9}$/;

/** @returns {string|null} a reason the terms are not acceptable, or null */
function termsProblem(t, policy) {
  if (!t || typeof t !== "object") return "no terms";
  if (!/^[0-9a-f]{32}$/.test(String(t.d))) return "d is not 16 random bytes in hex";
  if (!SIDES.includes(t.side)) return "side";
  if (!STATUSES.includes(t.status)) return "status";
  if (t.app !== APP_VERSION) return "unknown handover version";
  if (!PROFILES[t.profile] || !policy.allowedProfiles.includes(t.profile)) return "profile not allowed on the board";
  if (!CHAIN_RE.test(String(t.chain)) || String(t.chain) !== String(PROFILES[t.profile].chain)) return "chain does not match the profile";
  if (!NOID_RE.test(String(t.noid))) return "NOID amount";
  const noid = BigInt(t.noid);
  if (noid < policy.minNoidMicro) return "below the minimum NOID amount";
  if (noid > PROFILES[t.profile].max_noid_micro) return "over the profile's NOID cap";
  if (!WEI_RE.test(String(t.wei))) return "ETH amount";
  if (BigInt(t.wei) > PROFILES[t.profile].max_eth_wei) return "over the profile's ETH cap";
  if (typeof t.htlc !== "string" || ethAddressProblem(t.htlc)) return "contract address";
  const pinned = policy.pinnedHtlc[String(t.chain)];
  if (typeof pinned !== "string" || pinned.toLowerCase() !== t.htlc.toLowerCase()) return "not this app's pinned contract for the chain";
  if (!LOCK_KINDS.includes(t.lock)) return "lock kind (the board takes poseidon only)";
  if (!VARIANTS.includes(t.variant)) return "variant (the board takes raw only)";
  if (!policy.contractVersions.includes(t.cv)) return "contract version";
  if (!Array.isArray(t.relays) || t.relays.length < MIN_RELAYS || t.relays.length > MAX_RELAYS) return `${MIN_RELAYS} to ${MAX_RELAYS} relays`;
  const seen = new Set();
  for (const r of t.relays) {
    const n = normalizeRelayUrl(r, { allowLocalTest: policy.allowLocalTest });
    if (!n.ok || n.url !== r) return `relay URL: ${n.ok ? "not in normal form" : n.reason}`;
    if (seen.has(r)) return "a relay listed twice";
    seen.add(r);
  }
  return null;
}

const toTags = (t) => [
  ["side", t.side],
  ["noid", String(t.noid)],
  ["wei", String(t.wei)],
  ["chain", String(t.chain)],
  ["profile", t.profile],
  ["htlc", t.htlc],
  ["lock", t.lock],
  ["variant", t.variant],
  ["cv", t.cv],
  ["relays", ...t.relays],
  ["status", t.status],
  ["app", t.app],
];

/** Reads term tags (public tags, or the decrypted list) into a terms object; a repeated, missing or unknown tag is a problem. */
function readTerms(tags, d) {
  const out = { d };
  const seen = new Set();
  for (const tag of tags) {
    const name = tag[0];
    if (!TERM_TAGS.includes(name) || seen.has(name)) return { problem: `tag ${String(name).slice(0, 12)}` };
    seen.add(name);
    if (name === "relays") out.relays = tag.slice(1);
    else if (tag.length !== 2) return { problem: `tag ${name} has the wrong number of values` };
    else out[name] = tag[1];
  }
  if (seen.size !== TERM_TAGS.length) return { problem: "a term is missing" };
  return { terms: out };
}

/** What identifies the deal (not the status, the relays or the note): a take of ANY version of the offer with equal terms is acceptable (amendment H). */
const termsKey = (t) => JSON.stringify([t.d, t.side, String(t.noid), String(t.wei), String(t.chain), t.profile, t.htlc.toLowerCase(), t.lock, t.variant, t.cv, t.app]);

const priceWeiPerNoid = (t) => ((BigInt(t.wei) * 1_000_000n) / BigInt(t.noid)).toString();

function newOfferId() {
  return crypto.randomBytes(16).toString("hex");
}

/**
 * Builds and signs an offer.
 * @param {object} o
 * @param {Buffer|string} o.secret the offer's own key
 * @param {object} o.terms the terms (strings as in the tags; `d` is made when absent; `status` defaults to open, `app` to 1)
 * @param {object} o.policy from makePolicy
 * @param {number} o.now seconds
 * @param {{mode:"public"}|{mode:"private", inviteSecret:Buffer}} [o.board]
 * @param {number} [o.expirySeconds] at most the policy maximum
 * @param {number} [o.powBits]
 * @throws {BoardError} bad_offer when the terms are not acceptable: an offer outside the policy is never made
 */
function buildOffer(o) {
  const policy = o.policy;
  const terms = { status: "open", app: APP_VERSION, ...o.terms, d: o.terms.d || newOfferId() };
  const why = termsProblem(terms, policy);
  if (why) fail("bad_offer", why);
  const expiry = o.expirySeconds ?? policy.maxExpirySeconds;
  if (!(expiry > 0 && expiry <= policy.maxExpirySeconds)) fail("bad_offer", "expiry over the maximum");
  const board = o.board || { mode: "public" };
  const pub = getPublicKey(o.secret);
  let tags;
  let content = "";
  if (board.mode === "private") {
    const first = priv.boardTags(board.inviteSecret, o.now)[1];
    tags = [["d", terms.d], ["t", first], ["expiration", String(o.now + expiry)], ["alt", ALT_TEXT], ["enc", "1"]];
    content = nip44.encrypt(JSON.stringify(toTags(terms)), nip44.getConversationKey(o.secret, priv.groupPublicKey(board.inviteSecret)));
  } else if (board.mode === "public") {
    tags = [["d", terms.d], ["t", PUBLIC_TAG], ["expiration", String(o.now + expiry)], ["alt", ALT_TEXT], ...toTags(terms)];
  } else fail("bad_offer", "unknown board mode");
  let template = { kind: KINDS.OFFER, created_at: o.now, tags, content };
  const powBits = o.powBits ?? policy.minPowBits;
  if (powBits > 0) template = mine(template, pub, powBits);
  else template = { ...template, tags: [...tags, ["nonce", "0", "0"]] };
  return finalizeEvent(template, o.secret);
}

/**
 * Checks a note from a relay (untrusted) as an offer.
 * @param {object} ev
 * @param {{policy:object, now:number, board?:{mode:"public"}|{mode:"private", inviteSecret:Buffer}}} ctx
 * @returns {{ok:true, offer:object}|{ok:false, reason:string}}
 */
function parseOffer(ev, ctx) {
  const policy = ctx.policy;
  const bad = (reason) => ({ ok: false, reason });
  if (!verifyEvent(ev)) return bad("not a valid signed note");
  if (ev.kind !== KINDS.OFFER) return bad("not an offer");
  const board = ctx.board || { mode: "public" };
  const allowed = board.mode === "private" ? PLAIN_TAGS_PRIVATE : PLAIN_TAGS_PUBLIC;
  const names = new Set();
  for (const t of ev.tags) {
    if (!allowed.includes(t[0]) || names.has(t[0])) return bad(`tag ${String(t[0]).slice(0, 12)} is not allowed or repeated`);
    names.add(t[0]);
  }
  const one = (name) => {
    const v = tagsNamed(ev, name);
    return v.length === 1 && v[0].length === 1 ? v[0][0] : null;
  };
  const d = one("d");
  if (d === null || !/^[0-9a-f]{32}$/.test(d)) return bad("d");
  if (one("alt") !== ALT_TEXT) return bad("alt");
  // time: the offer lives at most maxExpirySeconds, is not from the future, and has not expired
  const expS = one("expiration");
  if (expS === null || !/^\d{1,12}$/.test(expS)) return bad("expiration");
  const exp = Number(expS);
  if (exp <= ctx.now) return bad("expired");
  if (ev.created_at > ctx.now + policy.clockSkewS) return bad("from the future");
  if (exp > ev.created_at + policy.maxExpirySeconds + policy.clockSkewS) return bad("expires too late");
  const pow = checkPow(ev, policy.minPowBits);
  if (!pow.ok) return bad("proof of work: " + pow.reason);
  // the board tag, and the terms
  let termTags;
  if (board.mode === "private") {
    if (one("enc") !== "1") return bad("enc");
    const t = one("t");
    if (t === null || !priv.boardTags(board.inviteSecret, ctx.now).includes(t)) return bad("not this board");
    let plain;
    try {
      plain = JSON.parse(nip44.decrypt(ev.content, nip44.getConversationKey(priv.groupSecret(board.inviteSecret), ev.pubkey)));
    } catch {
      return bad("terms do not decrypt");
    }
    if (!Array.isArray(plain) || plain.length > TERM_TAGS.length || !plain.every((x) => Array.isArray(x) && x.length >= 2 && x.length <= 1 + MAX_RELAYS && x.every((s) => typeof s === "string" && s.length <= 300))) return bad("terms are not a tag list");
    termTags = plain;
  } else {
    if (one("t") !== PUBLIC_TAG) return bad("not this board");
    if (ev.content !== "") return bad("an offer has no content");
    termTags = ev.tags.filter((t) => TERM_TAGS.includes(t[0]));
  }
  const r = readTerms(termTags, d);
  if (r.problem) return bad(r.problem);
  const why = termsProblem(r.terms, policy);
  if (why) return bad(why);
  return {
    ok: true,
    offer: { id: ev.id, pubkey: ev.pubkey, createdAt: ev.created_at, expiration: exp, powBits: difficultyOf(ev), terms: r.terms, termsKey: termsKey(r.terms), priceWeiPerNoid: priceWeiPerNoid(r.terms) },
  };
}

/**
 * The offers to show: every valid, unexpired, in-policy offer, the newest version of each (author, d) pair, status open only, smallest first.
 * @param {object[]} events
 * @param {object} ctx as parseOffer, plus `hideSides?: string[]` (sides the app does not show now)
 * @returns {{shown:object[], rejected:{id:string, reason:string}[], all:object[]}}
 */
function filterOffers(events, ctx) {
  const rejected = [];
  const latest = new Map();
  for (const ev of events) {
    const r = parseOffer(ev, ctx);
    if (!r.ok) {
      rejected.push({ id: ev && typeof ev.id === "string" ? ev.id : "?", reason: r.reason });
      continue;
    }
    const key = r.offer.pubkey + ":" + r.offer.terms.d;
    const old = latest.get(key);
    if (!old || r.offer.createdAt > old.createdAt || (r.offer.createdAt === old.createdAt && r.offer.id < old.id)) latest.set(key, r.offer);
  }
  const all = [...latest.values()];
  const hide = ctx.hideSides || [];
  const shown = all
    .filter((o) => o.terms.status === "open" && !hide.includes(o.terms.side))
    .sort((a, b) => (BigInt(a.terms.noid) < BigInt(b.terms.noid) ? -1 : BigInt(a.terms.noid) > BigInt(b.terms.noid) ? 1 : BigInt(a.priceWeiPerNoid) < BigInt(b.priceWeiPerNoid) ? -1 : BigInt(a.priceWeiPerNoid) > BigInt(b.priceWeiPerNoid) ? 1 : a.id < b.id ? -1 : 1));
  return { shown, rejected, all };
}

/** A new version of an offer (same author key, same `d`): the maker's app does this every 10 minutes, and with status "taken" once a take is accepted. */
function refreshOffer(prev, o) {
  if (getPublicKey(o.secret) !== prev.pubkey) fail("bad_offer", "another key than the offer's author");
  return buildOffer({ ...o, terms: { ...prev.terms, status: o.status || "open" } });
}

/**
 * Withdrawing: a replacement note with status "closed" (relays that keep addressable notes serve it instead of the open one) and a deletion request
 * (NIP-09, which relays MAY honour). The closed note expires soon.
 */
function withdrawOffer(prev, o) {
  const closed = refreshOffer(prev, { ...o, status: "closed", expirySeconds: Math.min(300, o.policy.maxExpirySeconds) });
  const deletion = finalizeEvent(
    { kind: KINDS.DELETION, created_at: o.now, tags: [["a", `${KINDS.OFFER}:${prev.pubkey}:${prev.terms.d}`], ["e", prev.id], ["k", String(KINDS.OFFER)]], content: "" },
    o.secret,
  );
  return { closed, deletion };
}

/** Subscription filters for reading the board. */
function boardFilters(ctx) {
  const board = ctx.board || { mode: "public" };
  const tags = board.mode === "private" ? priv.boardTags(board.inviteSecret, ctx.now) : [PUBLIC_TAG];
  return [{ kinds: [KINDS.OFFER], "#t": tags, since: ctx.now - ctx.policy.maxExpirySeconds - ctx.policy.clockSkewS - 600 }];
}

module.exports = { PUBLIC_TAG, ALT_TEXT, APP_VERSION, SIDES, STATUSES, makePolicy, termsProblem, termsKey, priceWeiPerNoid, newOfferId, buildOffer, parseOffer, filterOffers, refreshOffer, withdrawOffer, boardFilters, BoardError };
