"use strict";
/*
 * The program's own settings (spec 5.A.7): `<data folder>/settings.json`, version 1, no secret in it. They hold what is the same for every swap of this
 * installation: the node addresses per profile, the user's usual payout addresses (they only prefill the new-swap form: the user sees and keeps or changes them
 * for each swap), the board's relays and limits, and the update-check choice. Everything a swap depends on is copied into that swap's run.json when it is made;
 * a change here never changes a swap that exists.
 *
 * Strict like run.json: one JSON object, no BOM, at most 64 KB, no duplicate key at any depth, no unknown key, every value of the right kind. Node address rules are
 * runsettings' own (urlProblem); the Parano1d node is loopback only. The invite secret of the board is NOT here (it is sealed in the vault).
 *
 * The page never sees a node address with a path or a query (an API key may be in it) or the alert URL: `view()` shows `https://host/…` and `"set"`; `merge()` keeps a
 * stored value when the page sends back the shown text or leaves the key out.
 *
 * Board extras beyond the spec's list (the board host needs them): `board.profile`, `board.contract_version`, `board.pinned_htlc` ({ "<chain id>": "0x..." }).
 */

const fs = require("fs");
const path = require("path");
const { urlProblem } = require("./runsettings");
const { noidAddressProblem, ethAddressProblem } = require("./walletrun");
const { PROFILES } = require("./swapform");

const FILE = "settings.json";
const MAX_BYTES = 64 * 1024;
const MAX_DEPTH = 8;
const UPDATE_CHECK = ["ask", "daily", "off"];

class ProgramSettingsError extends Error {
  constructor(message, problems = []) {
    super(message);
    this.name = "ProgramSettingsError";
    this.problems = problems;
  }
}

/** The settings a fresh installation has (no settings.json). */
function defaults() {
  return {
    v: 1,
    noid_rpc: "http://127.0.0.1:9601",
    noid_rpc2: null,
    noid_rpc2_remote: false,
    eth: {
      sepolia: { rpc: "https://ethereum-sepolia-rpc.publicnode.com", rpc2: null },
      rehearsal: { rpc: "http://127.0.0.1:8545", rpc2: null },
    },
    eth_rpc2_remote: false,
    rpc_timeout_s: 60,
    alert_url: null,
    noid_payout: null,
    eth_payout: null,
    bob_noid: null,
    board: { relays: [], lead_blocks: 60, fund_k: null, reserve_wei: null, allow_public: false, allow_local_test: false, min_pow_bits: 0, profile: "sepolia", contract_version: "1", pinned_htlc: {} },
    update_check: "ask",
  };
}

const plain = (o) => o !== null && typeof o === "object" && !Array.isArray(o);
const isInt = (x) => typeof x === "number" && Number.isSafeInteger(x);

/** Throws ProgramSettingsError on the first thing a strict JSON reader refuses, and on a duplicate key at any depth. Returns the parsed value. */
function strictParse(text) {
  if (typeof text !== "string") throw new ProgramSettingsError("settings.json is refused: text expected");
  if (Buffer.byteLength(text, "utf8") > MAX_BYTES) throw new ProgramSettingsError(`settings.json is refused: larger than ${MAX_BYTES} bytes`);
  if (text.charCodeAt(0) === 0xfeff) throw new ProgramSettingsError("settings.json is refused: it starts with a byte order mark");
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new ProgramSettingsError("settings.json is refused: it is not JSON");
  }
  // duplicate keys: JSON.parse keeps the last, so the text is scanned for repeated keys of one object
  let i = 0;
  const fail = (why) => {
    throw new ProgramSettingsError(`settings.json is refused: ${why}`);
  };
  const ws = () => {
    while (i < text.length && " \t\r\n".includes(text[i])) i++;
  };
  const str = () => {
    let out = "";
    i++;
    while (i < text.length && text[i] !== '"') {
      if (text[i] === "\\") {
        out += text.slice(i, i + 2);
        i += text[i + 1] === "u" ? 6 : 2;
      } else out += text[i++];
    }
    i++;
    return out;
  };
  const val = (depth) => {
    if (depth > MAX_DEPTH) fail("nested too deeply");
    ws();
    const c = text[i];
    if (c === "{") {
      i++;
      const keys = new Set();
      ws();
      if (text[i] === "}") return void i++;
      for (;;) {
        ws();
        const k = str();
        if (keys.has(k)) fail("a key appears twice");
        keys.add(k);
        ws();
        i++; // the colon
        val(depth + 1);
        ws();
        if (text[i] === ",") {
          i++;
          continue;
        }
        i++; // the closing brace
        return;
      }
    }
    if (c === "[") {
      i++;
      ws();
      if (text[i] === "]") return void i++;
      for (;;) {
        val(depth + 1);
        ws();
        if (text[i] === ",") {
          i++;
          continue;
        }
        i++;
        return;
      }
    }
    if (c === '"') return void str();
    while (i < text.length && !",}] \t\r\n".includes(text[i])) i++;
  };
  val(0);
  return value;
}

/** Problems of a settings object, as { "path.to.key": text }. An empty object means valid. Messages name the key and the rule, never a value. */
function validate(o) {
  const errs = {};
  const bad = (k, why) => {
    if (!(k in errs)) errs[k] = why;
  };
  if (!plain(o)) return { "": "the settings are not an object" };
  const allowed = ["v", "noid_rpc", "noid_rpc2", "noid_rpc2_remote", "eth", "eth_rpc2_remote", "rpc_timeout_s", "alert_url", "noid_payout", "eth_payout", "bob_noid", "board", "update_check"];
  for (const k of Object.keys(o)) if (!allowed.includes(k)) bad(k, "not a setting of this version");
  for (const k of allowed) if (!Object.prototype.hasOwnProperty.call(o, k)) bad(k, "missing");
  if (Object.keys(errs).length) return errs;
  if (o.v !== 1) bad("v", "must be 1");
  const url = (k, v, { nullable, httpsOnly = false, loopback = false }) => {
    if (v === null) return nullable ? undefined : bad(k, "required");
    let why = urlProblem(v, { httpsOnly });
    if (!why && loopback && !/^http:\/\//.test(v)) why = "an http:// address on this machine";
    if (!why && loopback && !/^http:\/\/(?:127\.0\.0\.1|\[::1\]|localhost)(?::|\/|$)/i.test(v)) why = "an address on this machine (127.0.0.1, ::1 or localhost)";
    if (why) bad(k, why);
  };
  url("noid_rpc", o.noid_rpc, { nullable: false, loopback: true });
  url("noid_rpc2", o.noid_rpc2, { nullable: true });
  if (typeof o.noid_rpc2_remote !== "boolean") bad("noid_rpc2_remote", "true or false");
  else if (o.noid_rpc2_remote && o.noid_rpc2 === null) bad("noid_rpc2_remote", "true only with a second node");
  if (typeof o.eth_rpc2_remote !== "boolean") bad("eth_rpc2_remote", "true or false");
  if (!plain(o.eth)) bad("eth", "an object with sepolia and rehearsal");
  else {
    for (const k of Object.keys(o.eth)) if (!Object.prototype.hasOwnProperty.call(PROFILES, k)) bad(`eth.${k}`, "not a profile");
    for (const prof of Object.keys(PROFILES)) {
      const e = o.eth[prof];
      if (!plain(e)) {
        bad(`eth.${prof}`, "an object with rpc and rpc2");
        continue;
      }
      for (const k of Object.keys(e)) if (k !== "rpc" && k !== "rpc2") bad(`eth.${prof}.${k}`, "not a setting of this version");
      url(`eth.${prof}.rpc`, e.rpc === undefined ? null : e.rpc, { nullable: false });
      url(`eth.${prof}.rpc2`, e.rpc2 === undefined ? null : e.rpc2, { nullable: true });
      if (typeof e.rpc === "string" && typeof e.rpc2 === "string" && e.rpc.toLowerCase() === e.rpc2.toLowerCase()) bad(`eth.${prof}.rpc2`, "must be a different node from rpc");
    }
    if (o.eth_rpc2_remote === true && !Object.values(o.eth).some((e) => plain(e) && e.rpc2)) bad("eth_rpc2_remote", "true only with a second node");
  }
  if (!isInt(o.rpc_timeout_s) || o.rpc_timeout_s < 1 || o.rpc_timeout_s > 600) bad("rpc_timeout_s", "a whole number from 1 to 600");
  url("alert_url", o.alert_url, { nullable: true, httpsOnly: true });
  const addr = (k, v, kind) => {
    if (v === null) return;
    if (typeof v !== "string") return bad(k, "text or null expected");
    const why = kind === "eth" ? ethAddressProblem(v) : noidAddressProblem(v);
    if (why) bad(k, why);
  };
  addr("noid_payout", o.noid_payout, "noid");
  addr("eth_payout", o.eth_payout, "eth");
  addr("bob_noid", o.bob_noid, "noid");
  if (!UPDATE_CHECK.includes(o.update_check)) bad("update_check", `one of ${UPDATE_CHECK.join(", ")}`);
  const b = o.board;
  if (!plain(b)) bad("board", "an object");
  else {
    const bk = ["relays", "lead_blocks", "fund_k", "reserve_wei", "allow_public", "allow_local_test", "min_pow_bits", "profile", "contract_version", "pinned_htlc"];
    for (const k of Object.keys(b)) if (!bk.includes(k)) bad(`board.${k}`, "not a setting of this version");
    for (const k of bk) if (!Object.prototype.hasOwnProperty.call(b, k)) bad(`board.${k}`, "missing");
    if (!Object.keys(errs).some((k) => k.startsWith("board."))) {
      if (!Array.isArray(b.relays) || b.relays.length > 5 || b.relays.some((r) => typeof r !== "string" || r.length > 300 || /[\s\x00-\x1f]/.test(r))) bad("board.relays", "a list of at most five relay addresses (wss://...)");
      if (!isInt(b.lead_blocks) || b.lead_blocks < 10 || b.lead_blocks > 200) bad("board.lead_blocks", "a whole number from 10 to 200");
      if (b.fund_k !== null && (!isInt(b.fund_k) || b.fund_k < 1 || b.fund_k > 200)) bad("board.fund_k", "a whole number from 1 to 200, or null");
      if (b.reserve_wei !== null && (typeof b.reserve_wei !== "string" || !/^[0-9]{1,30}$/.test(b.reserve_wei))) bad("board.reserve_wei", "whole wei as text, or null");
      if (typeof b.allow_public !== "boolean") bad("board.allow_public", "true or false");
      if (typeof b.allow_local_test !== "boolean") bad("board.allow_local_test", "true or false");
      if (!isInt(b.min_pow_bits) || b.min_pow_bits < 0 || b.min_pow_bits > 24) bad("board.min_pow_bits", "a whole number from 0 to 24");
      if (!Object.prototype.hasOwnProperty.call(PROFILES, b.profile)) bad("board.profile", `one of ${Object.keys(PROFILES).join(", ")}`);
      if (b.contract_version !== "1" && b.contract_version !== "2") bad("board.contract_version", "1 or 2");
      if (!plain(b.pinned_htlc)) bad("board.pinned_htlc", "an object { chain id: address }");
      else for (const [k, v] of Object.entries(b.pinned_htlc)) if (!/^[0-9]{1,12}$/.test(k) || typeof v !== "string" || ethAddressProblem(v)) bad("board.pinned_htlc", "chain ids with an Ethereum address each");
    }
  }
  return errs;
}

/** Text to the validated settings object; throws ProgramSettingsError. */
function parseValid(text) {
  const o = strictParse(text);
  const errs = validate(o);
  const keys = Object.keys(errs);
  if (keys.length) throw new ProgramSettingsError(`settings.json is refused: ${keys.slice(0, 4).map((k) => `${k || "settings"}: ${errs[k]}`).join("; ")}${keys.length > 4 ? `; and ${keys.length - 4} more` : ""}`, keys.map((k) => ({ key: k, why: errs[k] })));
  return o;
}

/**
 * The settings of the data folder: the defaults when there is no settings.json; throws ProgramSettingsError for a file that is a link, not a plain file, too large,
 * not UTF-8 or that fails the schema (the program then refuses to make a swap: a wrong node address must not be guessed around).
 */
function load(dataDir) {
  const file = path.join(dataDir, FILE);
  let st;
  try {
    st = fs.lstatSync(file);
  } catch (e) {
    if (e && e.code === "ENOENT") return defaults();
    throw new ProgramSettingsError("settings.json cannot be read");
  }
  if (st.isSymbolicLink() || !st.isFile()) throw new ProgramSettingsError("settings.json is refused: it is not a plain file");
  if (st.size > MAX_BYTES) throw new ProgramSettingsError(`settings.json is refused: larger than ${MAX_BYTES} bytes`);
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(fs.readFileSync(file));
  } catch {
    throw new ProgramSettingsError("settings.json is refused: it cannot be read as UTF-8 text");
  }
  return parseValid(text);
}

/** `{ ok, settings, why }`: load() without the throw (the defaults stand in when the file is bad, with ok false). */
function loadSafe(dataDir) {
  try {
    return { ok: true, settings: load(dataDir), why: null };
  } catch (e) {
    return { ok: false, settings: defaults(), why: e instanceof ProgramSettingsError ? e.message : "settings.json cannot be read" };
  }
}

/** Writes settings.json (validated first) through a temporary file and a rename, mode 0600. */
function save(dataDir, settings) {
  const errs = validate(settings);
  if (Object.keys(errs).length) throw new ProgramSettingsError("the settings are not valid", Object.keys(errs).map((k) => ({ key: k, why: errs[k] })));
  const target = path.join(dataDir, FILE);
  const tmp = `${target}.tmp-${process.pid}-${Date.now().toString(36)}`;
  const text = `${JSON.stringify(settings, null, 2)}\n`;
  try {
    fs.writeFileSync(tmp, text, { flag: "wx", mode: 0o600 });
    fs.renameSync(tmp, target);
  } catch (e) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* not made */
    }
    throw new ProgramSettingsError(`settings.json cannot be written (${(e && e.code) || "error"})`);
  }
}

// ---- what the page sees

/** `https://host[:port]/…` for a node address that has a path, a query or a fragment (an API key may be in it); the address itself when it has none; null for null. */
function redactUrl(u) {
  if (u === null || u === undefined) return null;
  const m = /^(https?:\/\/[^/?#]*)([/?#].*)?$/.exec(String(u));
  if (!m) return "…";
  const rest = m[2] || "";
  return rest === "" || rest === "/" ? m[1] : `${m[1]}/…`;
}

/** The settings as the page may see them: node addresses redacted, the alert URL as "set" or null. */
function view(s) {
  const eth = {};
  for (const p of Object.keys(s.eth)) eth[p] = { rpc: redactUrl(s.eth[p].rpc), rpc2: redactUrl(s.eth[p].rpc2) };
  return { ...JSON.parse(JSON.stringify(s)), noid_rpc: redactUrl(s.noid_rpc), noid_rpc2: redactUrl(s.noid_rpc2), eth, alert_url: s.alert_url ? "set" : null };
}

/**
 * The stored settings with the page's changes applied. A node address (or the alert URL) that the page sends back as the text `view` showed (or leaves out) keeps the stored
 * value; any other value replaces it (null clears). Returns the merged object (not validated: the caller validates and saves). Keys the page cannot know are the caller's problem.
 */
const RESERVED = new Set(["__proto__", "constructor", "prototype"]);
/** True when any key, at any depth, names an object's prototype. */
function hasReservedKey(o, depth = 0) {
  if (!o || typeof o !== "object" || depth > 8) return false;
  for (const k of Object.keys(o)) if (RESERVED.has(k) || hasReservedKey(o[k], depth + 1)) return true;
  return false;
}

function merge(stored, patch) {
  // second barrier behind the request parser: a reserved key would let the loops below write into Object.prototype
  if (hasReservedKey(patch)) throw new ProgramSettingsError("the settings name a reserved key (__proto__, constructor or prototype); nothing was changed");
  const out = JSON.parse(JSON.stringify(stored));
  const keepUrl = (old, v) => v === undefined || (typeof v === "string" && v === redactUrl(old) && old !== null && v !== old) || (old === null && v === null) ? old : v;
  const p = plain(patch) ? patch : {};
  for (const k of Object.keys(p)) {
    if (k === "eth" && plain(p.eth)) {
      for (const prof of Object.keys(p.eth)) {
        if (!plain(out.eth[prof]) || !plain(p.eth[prof])) {
          out.eth[prof] = p.eth[prof];
          continue;
        }
        for (const f of Object.keys(p.eth[prof])) out.eth[prof][f] = f === "rpc" || f === "rpc2" ? keepUrl(out.eth[prof][f], p.eth[prof][f]) : p.eth[prof][f];
      }
    } else if (k === "board" && plain(p.board)) out.board = { ...out.board, ...p.board };
    else if (k === "noid_rpc" || k === "noid_rpc2") out[k] = keepUrl(out[k], p[k]);
    else if (k === "alert_url") out.alert_url = p.alert_url === "set" ? out.alert_url : p.alert_url;
    else out[k] = p[k];
  }
  return out;
}

module.exports = { FILE, ProgramSettingsError, defaults, validate, parseValid, strictParse, load, loadSafe, save, view, merge, redactUrl };
