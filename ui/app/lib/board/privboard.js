"use strict";
/*
 * The private test board (amendment G). Members share one invite secret, handed over once, out of band. Everything below is derived from it:
 *
 *   - a group key pair: offers are encrypted (NIP-44) from the offer's own key to the group's public key, so a relay or an outsider sees neither
 *     amounts nor sides; a member reads one with the group's secret key and the offer's public key (the same shared secret both ways);
 *   - a public daily tag HMAC(invite secret, date): the tag members subscribe to; it changes every UTC day, so one day's tag does not follow
 *     the board across days (a member who leaks the secret still leaks everything: the board is a small trusted test group, nothing more);
 *   - the take's proof HMAC(invite secret, offer note id || take key): a take without it is declined, so reading the relays is not enough to take an offer.
 *
 * Every derivation has its own domain string, so a value made for one purpose is never valid for another. The invite secret is passed in and never
 * stored, logged or put in an error text here.
 */

const crypto = require("crypto");
const { fail, isHex64, getPublicKey } = require("./note");

const DOMAIN = "no1d-board-v1";
const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

const hmac = (key, ...parts) => {
  const h = crypto.createHmac("sha256", key);
  for (const p of parts) h.update(p);
  return h.digest();
};

function checkInvite(invite) {
  if (!Buffer.isBuffer(invite) || invite.length !== 32) fail("bad_invite", "the invite secret is 32 bytes");
  return invite;
}

/** A fresh invite secret (the person who starts a private board makes one and hands it to the members). */
const newInviteSecret = () => crypto.randomBytes(32);

/** The group's secret key (a valid scalar): HMAC(invite, domain || counter), the counter raised in the unlikely case the value is out of range. */
function groupSecret(invite) {
  checkInvite(invite);
  for (let counter = 0; counter < 256; counter++) {
    const b = hmac(invite, `${DOMAIN} group key\0`, Buffer.from([counter]));
    const v = BigInt("0x" + b.toString("hex"));
    if (v > 0n && v < N) return b;
  }
  return fail("bad_invite", "no group key"); // unreachable in practice
}

const groupPublicKey = (invite) => getPublicKey(groupSecret(invite));

/** The UTC date of a time, YYYY-MM-DD. */
const dayOf = (nowSec) => new Date(nowSec * 1000).toISOString().slice(0, 10);

const dailyTag = (invite, day) => hmac(checkInvite(invite), `${DOMAIN} tag\0${day}`).toString("hex");

/** The tags valid around a time: yesterday, today, tomorrow (offers live at most 30 minutes and clocks differ, so the day edges overlap). */
function boardTags(invite, nowSec) {
  return [nowSec - 86400, nowSec, nowSec + 86400].map((t) => dailyTag(invite, dayOf(t)));
}

function takeProof(invite, offerId, takePub) {
  if (!isHex64(offerId) || !isHex64(takePub)) fail("bad_proof", "ids are 64 lower-case hex");
  return hmac(checkInvite(invite), `${DOMAIN} take\0`, Buffer.from(offerId, "hex"), Buffer.from(takePub, "hex")).toString("hex");
}

/** True only for the exact proof; a constant-time comparison; false for anything malformed. */
function verifyTakeProof(invite, offerId, takePub, proof) {
  try {
    if (typeof proof !== "string" || !/^[0-9a-f]{64}$/.test(proof)) return false;
    return crypto.timingSafeEqual(Buffer.from(takeProof(invite, offerId, takePub), "hex"), Buffer.from(proof, "hex"));
  } catch {
    return false;
  }
}

module.exports = { newInviteSecret, groupSecret, groupPublicKey, dayOf, dailyTag, boardTags, takeProof, verifyTakeProof };
