"use strict";
/*
 * Proof of work for notes (NIP-13, read 2026-11-17): the difficulty of a note is the number of leading zero BITS of its id; the sender commits to a
 * target in the third item of a `nonce` tag and varies the second item until the id reaches it.
 *
 * This code requires the commitment (the text says a client MAY): a note must carry a target at least as high as the level asked for and must reach
 * its own target. That blocks a bulk sender who aimed low and got lucky from passing as a careful one.
 */

const { fail, tagsNamed, idOf } = require("./note");

/** Leading zero bits of a hex string. */
function countLeadingZeroBits(hex) {
  let count = 0;
  for (let i = 0; i < hex.length; i++) {
    const nibble = parseInt(hex[i], 16);
    if (Number.isNaN(nibble)) return 0;
    if (nibble === 0) {
      count += 4;
      continue;
    }
    count += Math.clz32(nibble) - 28;
    break;
  }
  return count;
}

const difficultyOf = (ev) => countLeadingZeroBits(ev.id);

/** The committed target of a note's single nonce tag, or null (absent, repeated, or not a whole number 0 to 256). */
function committedTarget(ev) {
  const all = tagsNamed(ev, "nonce");
  if (all.length !== 1 || all[0].length !== 2 || !/^\d{1,18}$/.test(all[0][0]) || !/^(0|[1-9]\d{0,2})$/.test(all[0][1])) return null;
  const t = Number(all[0][1]);
  return t <= 256 ? t : null;
}

/**
 * @param {object} ev a note whose id has been checked (verifyEvent)
 * @param {number} minBits the level asked for (0 = nothing asked)
 * @returns {{ok:boolean, bits:number, target:number|null, reason?:string}}
 */
function checkPow(ev, minBits) {
  const bits = difficultyOf(ev);
  const target = committedTarget(ev);
  if (!(minBits > 0)) return { ok: true, bits, target };
  if (target === null) return { ok: false, bits, target, reason: "no committed target" };
  if (target < minBits) return { ok: false, bits, target, reason: `committed target ${target} is below ${minBits}` };
  if (bits < target) return { ok: false, bits, target, reason: `difficulty ${bits} is below its own target ${target}` };
  return { ok: true, bits, target };
}

/**
 * Finds a nonce for a template. Returns the template with its `nonce` tag (any older one is replaced; it is placed last), ready for finalizeEvent.
 * The id depends on the author's key, so it is given here.
 */
function mine(template, pubkey, bits, { maxIterations = 2 ** 32 } = {}) {
  if (!Number.isInteger(bits) || bits < 0 || bits > 40) fail("pow", "difficulty must be 0 to 40 bits");
  const base = template.tags.filter((t) => t[0] !== "nonce");
  const make = (n) => ({ ...template, tags: [...base, ["nonce", String(n), String(bits)]] });
  if (bits === 0) return make(0);
  for (let n = 0; n < maxIterations; n++) {
    const cand = make(n);
    const id = idOf({ pubkey, created_at: cand.created_at, kind: cand.kind, tags: cand.tags, content: cand.content });
    if (countLeadingZeroBits(id) >= bits) return cand;
  }
  return fail("pow", "no nonce found within the iteration limit");
}

module.exports = { countLeadingZeroBits, difficultyOf, committedTarget, checkPow, mine };
