"use strict";
/*
 * Bech32m check for Parano1d addresses (HRP "o", 32-byte payload: "o1" + 52 data characters + 6 checksum characters).
 * The form refuses an address whose checksum is wrong, so a mistyped character cannot reach env.local.sh.
 */

const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
const BECH32M_CONST = 0x2bc830a3;

function polymod(values) {
  let chk = 1;
  for (const v of values) {
    const top = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((top >>> i) & 1) chk ^= GEN[i];
  }
  return chk >>> 0;
}

const hrpExpand = (hrp) => [...hrp].map((c) => c.charCodeAt(0) >> 5).concat([0], [...hrp].map((c) => c.charCodeAt(0) & 31));

/** @returns {{ok:boolean, reason?:string, bytes?:Buffer}} */
function decodeBech32m(s, hrp = "o", payloadBytes = 32) {
  if (typeof s !== "string" || s !== s.toLowerCase() || s.length > 90) return { ok: false, reason: "lower-case bech32m expected" };
  const pos = s.lastIndexOf("1");
  if (pos < 1 || s.slice(0, pos) !== hrp) return { ok: false, reason: `the address must start with ${hrp}1` };
  const data = [];
  for (const c of s.slice(pos + 1)) {
    const v = CHARSET.indexOf(c);
    if (v < 0) return { ok: false, reason: `character "${c}" is not in the bech32 alphabet` };
    data.push(v);
  }
  if (data.length < 7) return { ok: false, reason: "too short" };
  if (polymod(hrpExpand(hrp).concat(data)) !== BECH32M_CONST) return { ok: false, reason: "checksum does not match (a typo?)" };
  // 5-bit groups to bytes, no padding bits allowed to be set
  let acc = 0;
  let bits = 0;
  const out = [];
  for (const v of data.slice(0, -6)) {
    acc = (acc << 5) | v;
    bits += 5;
    while (bits >= 8) {
      bits -= 8;
      out.push((acc >> bits) & 0xff);
    }
    acc &= (1 << bits) - 1;
  }
  if (bits >= 5 || acc !== 0) return { ok: false, reason: "bad padding" };
  if (out.length !== payloadBytes) return { ok: false, reason: `the payload is ${out.length} bytes, ${payloadBytes} expected` };
  return { ok: true, bytes: Buffer.from(out) };
}

module.exports = { decodeBech32m };
