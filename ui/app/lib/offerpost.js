"use strict";
/*
 * "Post to the offers board" (program mode, Bob's side): one public offer of Bob's invitation on the public offers board (https://no1dswap.github.io/), by the person's own click.
 *
 * What the board reads (the format of its crawler, scripts/update-offers.mjs of the web copy): an addressable Nostr note of kind 32871 with the tags
 *   d (32 hex), t "no1d-swap-web-v1", expiration (NIP-40, at most 24 h after the note), nonce (NIP-13, a committed target of at least 16 bits that the id reaches),
 *   status open | taken | closed, invite "no1dinv1:..." and an optional note. A withdrawal is a newer note with the same author and `d` and the status taken or closed.
 * The crawler drops what it cannot check, so every limit it has is kept here: the note is cleaned by the crawler's own rules and is at most 140 characters, it never holds a
 * `no1dinv1:` code, the amounts are inside the board's caps, the contract is the pinned one.
 *
 * What is sent, and what is not. The note carries the invitation (public fields: the network, the pinned contract, the two amounts, Bob's two receiving addresses) and the optional
 * note. It never carries a secret, the swap key, a hashlock, a swap file, a path or the vault's keys. It is signed by a FRESH posting key made for this offer only (a random 32-byte
 * key from the operating system, nothing else derives it); that key controls nothing but this offer's status, and is kept owner-only beside the run in `offer-post.json` so the
 * same key can later say "taken" or "closed". The relays see the sender's IP address. The relays are a fixed list of three wss:// hosts; no other host is used; nothing is read back.
 *
 * Every send is the person's click (a preview with the exact text, then a confirm that carries the preview's digest); the only automatic send is "taken" when Alice's funding is seen,
 * and only when the person left "mark it taken when the swap starts" ticked. A failure never touches the swap: the offer's own state says what was accepted, and a button retries.
 *
 * This module reads no environment and opens no socket by itself: `publish` is a parameter (tests give a stub; `relayPublisher` is the real one over lib/board/relay.js).
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const note = require("./board/note");
const { mine } = require("./board/pow");
const { RelayPool } = require("./board/relay");
const invitation = require("./invitation");
const { PINNED_CONTRACT } = require("./swapform");

const OFFER_KIND = 32871;
const DELETE_KIND = 5; // NIP-09, sent only when the person withdraws an offer
const MAX_IDS = 20; // the ids of the notes this key published for this offer, kept for the deletion
const BOARD_TAG = "no1d-swap-web-v1";
const RELAYS = Object.freeze(["wss://nos.lol", "wss://relay.primal.net", "wss://relay.snort.social"]);
const MIN_POW_BITS = 16;
const EXPIRY_S = 24 * 60 * 60; // the board's own maximum
const NOTE_MAX = 140;
const NOTE_RAW_MAX = 600; // what the page may send; the cleaned note must still be at most NOTE_MAX
const EVENT_MAX_BYTES = 8192;
const FILE = "offer-post.json";
const STATUSES = Object.freeze(["open", "taken", "closed"]);
const RETRY_AFTER_S = 300; // the automatic "taken" tries again at most every five minutes, six times; the button always can
const AUTO_TRIES = 6;

// the board's own network caps (js/invite-codec.js NETWORK_SPECS of the web copy), checked here again so an offer the board would drop is never made
const SPECS = Object.freeze({
  production: { network: "mainnet", label: "Ethereum mainnet", maxNoidMicro: 20_000_000_000n, maxEthWei: 1_000_000_000_000_000_000n, versions: [1] },
  sepolia: { network: "sepolia", label: "Sepolia (a test network)", maxNoidMicro: 20_000_000n, maxEthWei: 10_000_000_000_000_000n, versions: [1, 2] },
});

class OfferPostError extends Error {
  constructor(status, message) {
    super(message);
    this.name = "OfferPostError";
    this.status = status;
  }
}
const no = (status, message) => {
  throw new OfferPostError(status, message);
};

// ------------------------------------------------------------------------------------------------ the note
// The crawler's sanitizeDisplayText (js/invite-codec.js of the web copy), kept character for character: what the board shows is what this returns.
const UNSAFE_DISPLAY_CHARS_RE = /[­͏؜ᅟᅠ᠎​-‏‪-‮⁦-⁩⠀ㅤ︀-️﻿ﾠ\u{E0100}-\u{E01EF}\p{Cf}\p{Cc}]/gu;
const COMBINING_MARK_RE = /^\p{M}$/u;
const MAX_COMBINING_MARKS = 2;

function sanitizeDisplayText(text, maxLen) {
  if (typeof text !== "string") return "";
  const stripped = text.replace(/[\r\n\t]+/g, " ").replace(UNSAFE_DISPLAY_CHARS_RE, "");
  const kept = [];
  let combiningRun = 0;
  let hasBase = false;
  for (const ch of stripped) {
    if (COMBINING_MARK_RE.test(ch)) {
      if (hasBase && combiningRun < MAX_COMBINING_MARKS) {
        kept.push(ch);
        combiningRun++;
      }
      continue;
    }
    kept.push(ch);
    combiningRun = 0;
    hasBase = !/\s/u.test(ch);
  }
  const collapsed = kept.join("").replace(/\s+/g, " ").trim();
  const chars = [...collapsed];
  return chars.length > maxLen ? chars.slice(0, maxLen).join("").trim() : collapsed;
}

/** The person's note, cleaned the way the board cleans it. Refuses a note that is too long once cleaned, or that holds an invitation code. @returns {string} */
function cleanNote(raw) {
  if (raw === undefined || raw === null || raw === "") return "";
  if (typeof raw !== "string") no(400, "The note must be plain text.");
  // an invitation code in the note is refused by the board: checked first, on the text as typed and on the text with the board's hidden characters kept out, in any letter case
  if (/no1dinv1:/i.test(raw) || /no1dinv1:/i.test(raw.replace(UNSAFE_DISPLAY_CHARS_RE, ""))) no(422, "The note must not hold an invitation code: the offer already carries yours.");
  if (raw.length > NOTE_RAW_MAX) no(422, `The note is too long: ${NOTE_MAX} characters at most.`);
  const clean = sanitizeDisplayText(raw, 100000);
  if ([...clean].length > NOTE_MAX) no(422, `The note is too long: ${NOTE_MAX} characters at most.`);
  if (/no1dinv1:/i.test(clean)) no(422, "The note must not hold an invitation code: the offer already carries yours.");
  return clean;
}

// ------------------------------------------------------------------------------------------------ the offer
/**
 * What is published, from Bob's invitation code. Checks every rule the board checks on the invitation: the code parses, the contract is the pinned one for its network, the
 * amounts are inside the board's caps, the contract version is allowed, Bob's ETH address is not the contract or the zero address.
 * @returns {{fields:object, spec:object}}
 */
function termsOf(code) {
  const r = invitation.parseCode(code);
  if (!r.ok) no(409, r.why);
  const f = r.fields;
  const spec = SPECS[f.profile];
  if (!spec) no(409, "Offers are posted for Sepolia and Ethereum mainnet swaps only.");
  const pin = PINNED_CONTRACT[f.profile];
  if (typeof pin !== "string" || pin.toLowerCase() !== f.contract.toLowerCase()) no(409, "This swap does not use the program's pinned contract: the board would not show it.");
  if (!spec.versions.includes(Number(f.contract_version))) no(409, "This contract version is not used on the board.");
  if (f.bob_eth.toLowerCase() === f.contract.toLowerCase() || /^0x0{40}$/i.test(f.bob_eth)) no(409, "The ETH address of this invitation cannot be offered.");
  // the caps in whole units, from the exact decimals (no float): micro-NOID and wei
  const micro = decimalToInt(f.noid_amount, 6);
  const wei = decimalToInt(f.eth_amount, 18);
  if (micro <= 0n || micro > spec.maxNoidMicro) no(409, "The NOID amount is over the board's limit for this network.");
  if (wei <= 0n || wei > spec.maxEthWei) no(409, "The ETH amount is over the board's limit for this network.");
  return { fields: f, spec };
}

function decimalToInt(text, places) {
  const [w, fr = ""] = String(text).split(".");
  return BigInt(w) * 10n ** BigInt(places) + BigInt((fr + "0".repeat(places)).slice(0, places) || "0");
}

const newId = () => crypto.randomBytes(16).toString("hex");

/** The preview: exactly what will be published, as lines the page shows, and the digest that the confirm must carry. */
function previewOf({ code, note: rawNote, markTaken }) {
  const clean = cleanNote(rawNote);
  const { fields: f, spec } = termsOf(code);
  const digest = digestOf(code, clean, markTaken === true);
  const lines = [
    { k: "Network", v: spec.label },
    { k: "You give", v: `${f.eth_amount} ETH` },
    { k: "You get", v: `${f.noid_amount} NOID` },
    { k: "Contract", v: f.contract },
    { k: "Your ETH address", v: f.bob_eth },
    { k: "Your Parano1d address", v: f.bob_noid },
    { k: "Note", v: clean || "(none)" },
    { k: "Stays up", v: "24 hours, then it disappears by itself" },
    { k: "Marked taken", v: markTaken === true ? "by the program, when Alice's funding is seen" : "not automatically (you can withdraw it yourself)" },
  ];
  return { lines, note: clean, network: spec.network, label: spec.label, relays: [...RELAYS], expiry_hours: 24, mark_taken: markTaken === true, digest };
}

const digestOf = (code, clean, markTaken) => crypto.createHash("sha256").update(["no1d-offer-post-v1", code, clean, markTaken ? "1" : "0"].join("\n")).digest("hex").slice(0, 32);

/** Builds and signs one offer note. `status` open carries the invitation and the note; taken and closed carry neither (the board needs neither to replace the open one). */
function buildEvent({ secret, d, status, code, note: cleanNoteText, now, expiresAt, powBits = MIN_POW_BITS }) {
  if (!STATUSES.includes(status)) no(400, "unknown offer status");
  if (!/^[0-9a-f]{32}$/.test(d)) no(500, "the offer's id is not 32 hex characters");
  if (!(Number.isInteger(expiresAt) && expiresAt > now && expiresAt <= now + EXPIRY_S)) no(500, "the offer's expiry is outside the board's window");
  const tags = [["d", d], ["t", BOARD_TAG], ["expiration", String(expiresAt)], ["status", status]];
  if (status === "open") {
    tags.push(["invite", code]);
    if (cleanNoteText) tags.push(["note", cleanNoteText]);
  }
  const pub = note.getPublicKey(secret);
  const template = mine({ kind: OFFER_KIND, created_at: now, tags, content: "" }, pub, powBits, { maxIterations: 2 ** 26 });
  const ev = note.finalizeEvent(template, secret);
  if (Buffer.byteLength(JSON.stringify(ev), "utf8") > EVENT_MAX_BYTES) no(500, "the offer is larger than expected");
  return ev;
}

/** The NIP-09 deletion of this offer: kind 5, an "e" tag for every note id recorded and the "a" tag of the addressable offer, signed with the same posting key. Asks; a relay may keep copies. */
function buildDeleteEvent({ secret, pub, d, ids, now }) {
  if (!/^[0-9a-f]{32}$/.test(d)) no(500, "the offer's id is not 32 hex characters");
  const tags = [...ids.filter((x) => /^[0-9a-f]{64}$/.test(x)).map((x) => ["e", x]), ["a", `${OFFER_KIND}:${pub}:${d}`]];
  const ev = note.finalizeEvent({ kind: DELETE_KIND, created_at: now, tags, content: "withdrawn" }, secret);
  if (Buffer.byteLength(JSON.stringify(ev), "utf8") > EVENT_MAX_BYTES) no(500, "the deletion is larger than expected");
  return ev;
}

// ------------------------------------------------------------------------------------------------ the sidecar
function fileOf(dir) {
  return path.join(dir, FILE);
}

/** The stored posting state of a swap, or null. Never throws; a damaged file reads as null (nothing is posted from it). */
function readState(dir) {
  try {
    const st = fs.lstatSync(fileOf(dir));
    if (!st.isFile() || st.isSymbolicLink() || st.size > 8192) return null;
    const j = JSON.parse(fs.readFileSync(fileOf(dir), "utf8"));
    if (!j || j.v !== 1 || !/^[0-9a-f]{32}$/.test(j.d) || !note.isHex64(j.secret) || !STATUSES.includes(j.status) || !STATUSES.includes(j.published_status || "open")) return null;
    if (note.getPublicKey(j.secret) !== j.pub) return null;
    return j;
  } catch {
    return null;
  }
}

function writeState(dir, st) {
  const tmp = path.join(dir, `.${FILE}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`);
  try {
    fs.writeFileSync(tmp, JSON.stringify(st) + "\n", { flag: "wx", mode: 0o600 });
    fs.renameSync(tmp, fileOf(dir));
  } catch {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* not there */
    }
    no(500, "The offer's state could not be saved. Nothing was posted.");
  }
}

/** The short line about the deletion request of a withdrawn offer, or null while none was made. */
function deleteLine(st) {
  if (st.delete_accepted > 0) return `The relays were asked to delete the offer (${st.delete_accepted} of ${RELAYS.length} took the request). They may keep copies.`;
  if (st.delete_error) return "The request to delete the offer was not accepted by any relay. The offer is still marked withdrawn.";
  return null;
}

/** The page's view of a stored state: no key, no code. */
function viewOf(st, now) {
  if (!st) return null;
  return {
    status: st.status,
    published_status: st.published_status || null,
    accepted: st.accepted || 0,
    total: RELAYS.length,
    posted_at: st.created_at,
    expires_at: st.expires_at,
    expired: st.expires_at <= now,
    mark_taken: st.mark_taken === true,
    error: st.error || null,
    note: st.note || "",
    pending: st.status !== (st.published_status || null),
    delete_line: st.status === "closed" ? deleteLine(st) : null,
  };
}

// ------------------------------------------------------------------------------------------------ the poster
/**
 * @param {object} o
 * @param {(ev:object)=>Promise<{accepted:number,total?:number}>} o.publish sends one note to the fixed relays (the real one: relayPublisher)
 * @param {()=>number} [o.now] seconds
 */
function createPoster(o) {
  const nowS = o.now || (() => Math.floor(Date.now() / 1000));
  const publish = o.publish;
  const busy = new Set();
  const auto = new Map(); // dir -> { tries, next }

  async function send(dir, st, ev) {
    let res = null;
    let err = null;
    try {
      res = await publish(ev);
    } catch (e) {
      err = (e && e.message ? String(e.message) : "the relays could not be reached").slice(0, 120);
    }
    const accepted = res && Number.isInteger(res.accepted) ? res.accepted : 0;
    const ids = [...(Array.isArray(st.ids) ? st.ids : []).filter((x) => typeof x === "string"), ...(typeof ev.id === "string" ? [ev.id] : [])].filter((x, i, a) => a.indexOf(x) === i).slice(-MAX_IDS);
    const next = { ...st, ids, last_created_at: ev.created_at, accepted, error: accepted > 0 ? null : err || "No relay accepted the offer.", attempted_at: nowS() };
    if (accepted > 0) next.published_status = st.status;
    writeState(dir, next);
    return next;
  }

  function guard(dir, fn) {
    if (busy.has(dir)) no(409, "An offer step is already running for this swap.");
    busy.add(dir);
    return Promise.resolve()
      .then(fn)
      .finally(() => busy.delete(dir));
  }

  /** Posts the open offer. `confirm` must be the preview's digest for exactly this code, note and choice. */
  function post({ dir, code, note: rawNote, markTaken, confirm }) {
    return guard(dir, async () => {
      const prev = previewOf({ code, note: rawNote, markTaken });
      if (typeof confirm !== "string" || confirm !== prev.digest) no(409, "Nothing was posted: look at the preview again and confirm it.");
      const now = nowS();
      const old = readState(dir);
      if (old && old.status === "open" && old.expires_at > now) no(409, "This swap's offer is already up. Withdraw it first if you want to post it again.");
      if (old && old.status !== "open" && old.expires_at > now) no(409, "This swap's offer was withdrawn or taken. It is not posted again.");
      const secret = note.generateSecretKey(); // a fresh key for this offer: nothing of the swap or the vault is used
      const st = { v: 1, d: newId(), secret: secret.toString("hex"), pub: note.getPublicKey(secret), status: "open", published_status: null, created_at: now, expires_at: now + EXPIRY_S, last_created_at: 0, mark_taken: prev.mark_taken, note: prev.note, accepted: 0, error: null };
      writeState(dir, st); // the key is kept before anything is sent
      const ev = buildEvent({ secret, d: st.d, status: "open", code, note: prev.note, now, expiresAt: st.expires_at });
      const out = await send(dir, st, ev);
      return viewOf(out, nowS());
    });
  }

  /** A newer note with the same key and `d`: taken or closed (also the retry of one that no relay accepted). */
  function setStatus({ dir, status, withdraw }) {
    return guard(dir, async () => {
      if (status !== "taken" && status !== "closed") no(400, "status must be taken or closed");
      const old = readState(dir);
      if (!old) no(409, "There is no offer of this swap to change.");
      if (old.status === "closed" && status === "taken") no(409, "This offer is withdrawn already.");
      const now = nowS();
      const createdAt = Math.max(now, (old.last_created_at || old.created_at) + 1); // newer than the one before, or the board keeps the old one
      const expiresAt = Math.min(Math.max(old.expires_at, createdAt + 600), createdAt + EXPIRY_S);
      const st = { ...old, status }; // the shown life stays the open note's: a status note never extends it
      const secret = Buffer.from(old.secret, "hex");
      const ev = buildEvent({ secret, d: old.d, status, now: createdAt, expiresAt });
      let out = await send(dir, st, ev);
      // an explicit withdrawal (the person's click, never "taken", never automatic) also asks the relays to delete the offer; a failure here touches nothing else
      if (status === "closed" && withdraw === true) {
        try {
          const del = buildDeleteEvent({ secret, pub: old.pub, d: old.d, ids: out.ids || [], now: Math.max(nowS(), createdAt) });
          let res = null;
          let derr = null;
          try {
            res = await publish(del);
          } catch (e) {
            derr = (e && e.message ? String(e.message) : "the relays could not be reached").slice(0, 120);
          }
          const dacc = res && Number.isInteger(res.accepted) ? res.accepted : 0;
          const next = { ...out, delete_accepted: dacc, delete_error: dacc > 0 ? null : derr || "No relay accepted the deletion." };
          writeState(dir, next);
          out = next;
        } catch {
          /* the deletion is a courtesy: the closed note stands */
        }
      }
      return viewOf(out, nowS());
    });
  }

  /** Sends the open offer again (same key, same `d`, a newer note) when no relay took it: the retry of a post that failed, or a refresh of one that is still open. */
  function republish({ dir, code }) {
    return guard(dir, async () => {
      const old = readState(dir);
      if (!old || old.status !== "open") no(409, "There is no open offer of this swap to send again.");
      const now = nowS();
      if (old.expires_at <= now) no(409, "This offer has expired by itself. Post a new one.");
      termsOf(code);
      const createdAt = Math.max(now, (old.last_created_at || old.created_at) + 1);
      const ev = buildEvent({ secret: Buffer.from(old.secret, "hex"), d: old.d, status: "open", code, note: old.note || "", now: createdAt, expiresAt: Math.min(old.expires_at, createdAt + EXPIRY_S) });
      return viewOf(await send(dir, old, ev), nowS());
    });
  }

  /**
   * The automatic "taken": once Alice's funding is seen, for an open offer that was posted with the choice ticked. Never throws, never blocks the caller; tries again every five minutes,
   * six times at most (the button always can). Returns true when it started a send.
   */
  function autoTaken({ dir, fundingSeen }) {
    try {
      if (fundingSeen !== true) return false;
      const st = readState(dir);
      // an offer still open, or one whose "taken" no relay has accepted yet
      const wants = st && (st.status === "open" || (st.status === "taken" && st.published_status !== "taken"));
      if (!st || st.mark_taken !== true || !wants || st.expires_at <= nowS() || busy.has(dir)) return false;
      const a = auto.get(dir) || { tries: 0, next: 0 };
      if (a.tries >= AUTO_TRIES || nowS() < a.next) return false;
      auto.set(dir, { tries: a.tries + 1, next: nowS() + RETRY_AFTER_S });
      setStatus({ dir, status: "taken" }).catch(() => {});
      return true;
    } catch {
      return false;
    }
  }

  /** The automatic "closed": for an offer listed as open on the board while its swap has ended (aborted). Never throws; same retry rule as autoTaken. Returns true when it started a send. */
  function autoClose({ dir }) {
    try {
      const st = readState(dir);
      if (!st || st.status !== "open" || st.published_status !== "open" || st.expires_at <= nowS() || busy.has(dir)) return false;
      const a = auto.get("close:" + dir) || { tries: 0, next: 0 };
      if (a.tries >= AUTO_TRIES || nowS() < a.next) return false;
      auto.set("close:" + dir, { tries: a.tries + 1, next: nowS() + RETRY_AFTER_S });
      setStatus({ dir, status: "closed" }).catch(() => {});
      return true;
    } catch {
      return false;
    }
  }

  return { post, setStatus, republish, autoTaken, autoClose, view: (dir) => viewOf(readState(dir), nowS()), state: readState };
}

// ------------------------------------------------------------------------------------------------ the real publisher
/** The three fixed relays over lib/board/relay.js: one short connection per send, wss only (the pool refuses anything else), no NIP-11 read, closed afterwards. */
function relayPublisher(deps = {}) {
  return async (ev) => {
    const pool = new RelayPool({ urls: [...RELAYS], fetchInfo: null, WebSocket: deps.WebSocket, connectTimeoutMs: 8000, publishTimeoutMs: 10000, maxViolations: 3 });
    pool.start();
    try {
      const r = await pool.publish(ev, { timeoutMs: 10000 });
      return { accepted: r.accepted, total: RELAYS.length };
    } finally {
      pool.stop();
    }
  };
}

module.exports = { OFFER_KIND, BOARD_TAG, RELAYS, MIN_POW_BITS, EXPIRY_S, NOTE_MAX, FILE, SPECS, OfferPostError, sanitizeDisplayText, cleanNote, termsOf, previewOf, digestOf, buildEvent, buildDeleteEvent, DELETE_KIND, readState, viewOf, createPoster, relayPublisher };
