"use strict";
/*
 * Seal and gift wrap (NIP-59), as NIP-17 uses them. Read against the published texts 2026-11-17.
 *
 *   rumor : an unsigned note (any kind; ours is KINDS.HANDOVER), carrying the message
 *   seal  : kind 13, signed by the SENDER's real (per-swap) key, content = the rumor encrypted to the recipient (NIP-44), tags EMPTY
 *   wrap  : kind 1059, signed by a ONE-TIME key, content = the seal encrypted to the recipient, tags = one `p` (recipient) and optionally a proof of work
 *
 * Unwrapping checks, in this order, and throws a BoardError at the first fault:
 *   1. the wrap is a well-formed kind 1059 note with a valid id and signature (NIP-44 says the outer signature MUST be checked before decrypting), carries
 *      exactly one `p` tag naming us, and the proof of work asked for;
 *   2. the seal is a well-formed kind 13 note with a valid signature and EMPTY tags;
 *   3. the rumor is unsigned (a `sig` property is refused), has a correct id, and its author (pubkey) EQUALS the seal's signer. Without that last check anybody
 *      could put a note "from" somebody else inside his own seal. NOTE: NIP-59's own text does not state this check; NIP-17 does ("Clients MUST verify ...").
 *
 * created_at of the seal and of the wrap are randomised into the past (NIP-59: "SHOULD be in the past"; NIP-17: up to two days); the window is a parameter,
 * because relays may refuse notes older than their own limit (NIP-11 created_at_lower_limit) and a reader has to look back as far as the window.
 */

const crypto = require("crypto");
const { KINDS, fail, isHex64, secretBytes, generateSecretKey, getPublicKey, finalizeEvent, makeRumor, verifyEvent, tagsNamed, idOf, shapeProblem, BoardError } = require("./note");
const nip44 = require("./nip44");
const { checkPow, mine } = require("./pow");

const TWO_DAYS = 2 * 24 * 60 * 60;
const MAX_WRAP_CONTENT = 120000;

const randomPast = (now, window) => now - (window > 0 ? crypto.randomInt(0, window + 1) : 0);

/**
 * @param {{kind:number, content:string, tags?:string[][], created_at?:number}} rumorTemplate
 * @param {Buffer|string} senderSecret the sender's per-swap key
 * @param {string} recipientPub x-only hex
 * @param {{now?:number, backdateS?:number, powBits?:number, wrapSecret?:Buffer, auxRand?:Buffer}} [opts]
 * @returns {{wrap:object, rumor:object}} the note to publish, and the rumor (for the sender's own record)
 */
function wrap(rumorTemplate, senderSecret, recipientPub, opts = {}) {
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const window = opts.backdateS ?? TWO_DAYS;
  if (!isHex64(recipientPub)) fail("bad_note", "recipient key is not 64 lower-case hex");
  const senderPub = getPublicKey(senderSecret);
  const rumor = makeRumor({ created_at: rumorTemplate.created_at ?? now, kind: rumorTemplate.kind, tags: rumorTemplate.tags ?? [], content: rumorTemplate.content }, senderPub);
  const seal = finalizeEvent(
    { kind: KINDS.SEAL, created_at: randomPast(now, window), tags: [], content: nip44.encrypt(JSON.stringify(rumor), nip44.getConversationKey(senderSecret, recipientPub)) },
    senderSecret,
    { auxRand: opts.auxRand },
  );
  const wrapSecret = opts.wrapSecret ?? generateSecretKey();
  const wrapPub = getPublicKey(wrapSecret);
  let template = { kind: KINDS.WRAP, created_at: randomPast(now, window), tags: [["p", recipientPub]], content: nip44.encrypt(JSON.stringify(seal), nip44.getConversationKey(wrapSecret, recipientPub)) };
  if (opts.powBits > 0) template = mine(template, wrapPub, opts.powBits);
  return { wrap: finalizeEvent(template, wrapSecret, { auxRand: opts.auxRand }), rumor };
}

function parseJson(text, what) {
  try {
    return JSON.parse(text);
  } catch {
    return fail("bad_note", `the ${what} is not JSON`);
  }
}

/**
 * @param {object} wrapEvent a note from a relay (untrusted)
 * @param {Buffer|string} recipientSecret our key for this swap
 * @param {{minPowBits?:number}} [opts]
 * @returns {{rumor:object, author:string, wrapId:string, wrapCreatedAt:number, sealCreatedAt:number}}
 * @throws {BoardError}
 */
function unwrap(wrapEvent, recipientSecret, opts = {}) {
  const sk = secretBytes(recipientSecret);
  const me = getPublicKey(sk);
  // 1. the wrap
  if (!verifyEvent(wrapEvent)) fail("bad_wrap", "the wrap's id or signature is not valid");
  if (wrapEvent.kind !== KINDS.WRAP) fail("bad_wrap", "not a kind 1059 note");
  const ps = tagsNamed(wrapEvent, "p");
  if (ps.length !== 1 || ps[0][0] !== me) fail("not_for_us", "the wrap is not addressed to this key");
  const pow = checkPow(wrapEvent, opts.minPowBits ?? 0);
  if (!pow.ok) fail("pow", `proof of work: ${pow.reason}`);
  if (wrapEvent.content.length > MAX_WRAP_CONTENT) fail("bad_wrap", "the wrap is too large");
  // 2. the seal
  let sealText;
  try {
    sealText = nip44.decrypt(wrapEvent.content, nip44.getConversationKey(sk, wrapEvent.pubkey));
  } catch (e) {
    if (e instanceof BoardError) fail("bad_wrap", "the wrap does not decrypt");
    throw e;
  }
  const seal = parseJson(sealText, "seal");
  if (!verifyEvent(seal)) fail("bad_seal", "the seal's id or signature is not valid");
  if (seal.kind !== KINDS.SEAL) fail("bad_seal", "not a kind 13 note");
  if (seal.tags.length !== 0) fail("bad_seal", "a seal must have no tags");
  // 3. the rumor
  let rumorText;
  try {
    rumorText = nip44.decrypt(seal.content, nip44.getConversationKey(sk, seal.pubkey));
  } catch (e) {
    if (e instanceof BoardError) fail("bad_seal", "the seal does not decrypt");
    throw e;
  }
  const rumor = parseJson(rumorText, "rumor");
  if (!rumor || typeof rumor !== "object" || Array.isArray(rumor)) fail("bad_rumor", "the rumor is not an object");
  if (Object.keys(rumor).some((k) => !["id", "pubkey", "created_at", "kind", "tags", "content"].includes(k))) fail("bad_rumor", "the rumor has an unexpected property (a signed rumor is refused)");
  const why = shapeProblem(rumor);
  if (why) fail("bad_rumor", why);
  if (!isHex64(rumor.id) || idOf(rumor) !== rumor.id) fail("bad_rumor", "the rumor's id does not match its content");
  if (rumor.pubkey !== seal.pubkey) fail("rumor_author", "the rumor's author is not the seal's signer");
  return { rumor, author: seal.pubkey, wrapId: wrapEvent.id, wrapCreatedAt: wrapEvent.created_at, sealCreatedAt: seal.created_at };
}

module.exports = { wrap, unwrap, TWO_DAYS };
