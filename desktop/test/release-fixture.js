"use strict";
// A test release world: a throw-away Ed25519 key, signed release notices, and a fetch that serves the releases list and the
// two notice assets by their API addresses. Offline: nothing here opens a socket.
const crypto = require("node:crypto");

const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
const PUB = publicKey.export({ format: "der", type: "spki" }).subarray(12).toString("base64");
const other = crypto.generateKeyPairSync("ed25519");
const OTHER_PUB = other.publicKey.export({ format: "der", type: "spki" }).subarray(12).toString("base64");

const sign = (text, priv = privateKey) => crypto.sign(null, Buffer.from(text, "utf8"), priv).toString("base64");

const noticeText = (version, o = {}) =>
  JSON.stringify({
    product: "No1d Swap",
    version,
    oldest_safe_version: o.oldest || "0.0.1",
    note: o.note || "A short note.",
    sha256: { "setup.exe": "a".repeat(64) },
    ...(o.extra || {}),
  });

const ASSETS = [
  { name: "release.json", id: 1 },
  { name: "release.json.sig", id: 2 },
];
const withAssets = (r) => ({ ...r, assets: ASSETS });

function newestVersion(answer) {
  let list = answer;
  if (typeof list === "string") {
    try {
      list = JSON.parse(list);
    } catch {
      return null;
    }
  }
  if (!Array.isArray(list)) return null;
  let best = null;
  for (const r of list) {
    const m = r && !r.draft && !r.prerelease && typeof r.tag_name === "string" ? /^v(\d+)\.(\d+)\.(\d+)$/.exec(r.tag_name) : null;
    if (!m) continue;
    const v = [Number(m[1]), Number(m[2]), Number(m[3])];
    if (!best || v[0] > best[0] || (v[0] === best[0] && (v[1] > best[1] || (v[1] === best[1] && v[2] > best[2])))) best = v;
  }
  return best ? best.join(".") : null;
}

/**
 * o.notice / o.sig: the served texts (default: a valid signed notice for the newest tag); o.oldest, o.note; o.assetError: thrown
 * for asset requests; o.noAssets: the list's releases carry no assets (the caller's list is used as given otherwise).
 */
function releaseFetch(answer, o = {}) {
  const calls = [];
  const f = async (url, opts) => {
    calls.push({ url, opts });
    if (answer instanceof Error) throw answer;
    if (url.endsWith("/releases?per_page=10")) return typeof answer === "function" ? answer() : answer;
    if (o.assetError) throw o.assetError;
    const version = newestVersion(typeof answer === "function" ? answer() : answer) || "0.0.0";
    const notice = o.notice !== undefined ? o.notice : noticeText(version, o);
    if (url.endsWith("/releases/assets/1")) return notice;
    if (url.endsWith("/releases/assets/2")) return o.sig !== undefined ? o.sig : sign(typeof notice === "string" ? notice : "");
    throw new Error("unexpected url " + url);
  };
  f.calls = calls;
  return f;
}

module.exports = { PUB, OTHER_PUB, sign, noticeText, withAssets, releaseFetch, newestVersion, privateKey };
