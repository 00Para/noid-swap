"use strict";
/*
 * run.json, version 1: the settings of one swap, written only by the program and read through a strict schema. It replaces the bash file
 * env.local.sh (which the helpers source and the console read by regular expressions). Coins depend on these values (payout addresses, node
 * URLs, amounts), so every rule here fails closed: a file that is not exactly what the table below allows is refused, never repaired.
 *
 *  - Every key is required. Unknown keys, duplicate keys (at any depth), a BOM, a root that is not an object, comments, trailing commas and
 *    any number that is not a whole number are refused. `null` only where the table allows it.
 *  - A message names the key and the rule, never the value (a node URL may carry an API key, the alert URL is a secret).
 *  - Networks: the profile is `sepolia`, `rehearsal` or `production` (Ethereum mainnet, chain 1, program mode only), and the chain id is the profile's own. Production adds rules
 *    (`productionRules` below): the caps of the owner's decision D1, a mainnet fee cap, contract version 1, two Ethereum nodes, no board handover. A file that says production or
 *    chain 1 and does not pass them stays refused (productionReason).
 *  - Not in the schema on purpose: the producer waiver (the program passes it only while Bob's approval holds it), the classic-run switch, platform and tool paths, key files.
 *    On production `gas_price_gwei` is the mainnet fee cap (`--mainnet --max-fee-gwei`), never a gas price.
 *
 * This module reads and writes files only. It never sources or runs anything, and it is not wired into the console yet (it still reads
 * env.local.sh); migrateFromEnvLocal reads that file as text.
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { PROGRAM_PROFILES: PROFILES, decimalToInt } = require("./swapform");
const { noidAddressProblem, ethAddressProblem } = require("./walletrun");
const { PRODUCTION_TEXT } = require("./viewmodel");

const FILE = "run.json";
const MAX_BYTES = 64 * 1024;
const MAX_URL = 2048;
const MAX_DEPTH = 16;

// the keys in the order of the table (canonicalBytes writes them in this order)
const ORDER = [
  "v", "run_id", "role", "profile", "chain_id", "contract", "lock_kind", "variant", "contract_version", "amount_micronoid", "amount_wei",
  "alice_noid", "bob_noid", "alice_eth", "bob_eth", "noid_payout", "eth_payout", "noid_rpc", "noid_rpc2", "noid_rpc2_remote",
  "eth_rpc2_remote", "single_node_ok", "eth_rpc", "eth_rpc2", "rpc_timeout_s", "gas_price_gwei", "priority_fee_gwei", "deploy_block",
  "eth_start_margin", "hc_lead", "lock_precheck_timeout_s", "handover", "alert_url",
];

// what env.sh uses when a setting is not assigned (newSettings does not apply them; a caller that wants them takes them from here)
const DEFAULTS = Object.freeze({
  profile: "sepolia",
  chain_id: 11155111,
  variant: "raw",
  contract_version: 1,
  amount_micronoid: "10000000",
  amount_wei: "1000000000000000",
  noid_rpc: "http://127.0.0.1:9601",
  noid_rpc2: null,
  noid_rpc2_remote: false,
  eth_rpc2_remote: false,
  single_node_ok: false,
  eth_rpc: "https://ethereum-sepolia-rpc.publicnode.com",
  eth_rpc2: null,
  rpc_timeout_s: 60,
  gas_price_gwei: null,
  priority_fee_gwei: null,
  deploy_block: null,
  eth_start_margin: 2400,
  hc_lead: 50,
  lock_precheck_timeout_s: null,
  handover: null,
  alert_url: null,
});

const RUN_ID = /^[0-9a-f]{32}$/;
const ETH_ADDR = /^0x[0-9a-fA-F]{40}$/;
const GWEI_DEC = /^(0|[1-9]\d{0,3})(\.\d{1,9})?$/;
const AMOUNT = /^[1-9]\d{0,19}$/;
const URL_CHARS = /^[A-Za-z0-9\-._~:/?@&=+%[\]]+$/;
const HOST = /^(?:\[[0-9A-Fa-f:]{2,45}\]|[A-Za-z0-9][A-Za-z0-9.-]{0,252})$/;
const LOOPBACK = new Set(["127.0.0.1", "[::1]", "localhost"]);

class RunSettingsError extends Error {
  /** @param {string} message @param {string[]} [problems] */
  constructor(message, problems = []) {
    super(message);
    this.name = "RunSettingsError";
    this.problems = problems;
  }
}

const isInt = (x) => typeof x === "number" && Number.isSafeInteger(x);
const plain = (o) => o !== null && typeof o === "object" && !Array.isArray(o) && (Object.getPrototypeOf(o) === Object.prototype || Object.getPrototypeOf(o) === null);
const printable = (s) => String(s).replace(/[^\x20-\x7e]/g, "?").slice(0, 40);

/**
 * A node URL: http:// only to a loopback host, else https://; no user-info part, no whitespace or control character, at most 2048 characters,
 * a plain host (the host is compared as written, so a host that only the URL parser would rewrite is refused), a port from 1 to 65535, no fragment.
 * `anyHttp` (a run.json that is only being loaded, never one being made): http:// is accepted for any host, as before the loopback rule (L8, fix round 2). Returns a problem text (without the value) or null.
 */
function urlProblem(s, { httpsOnly = false, anyHttp = false } = {}) {
  if (typeof s !== "string") return "text expected";
  if (s.length === 0 || s.length > MAX_URL) return `1 to ${MAX_URL} characters`;
  if (/[\x00-\x20\x7f-￿]/.test(s)) return "no whitespace, control or non-ASCII characters";
  if (!URL_CHARS.test(s)) return "a character that does not belong in a node address";
  const m = /^(https?):\/\/([^/?#]*)([^#]*)$/.exec(s);
  if (!m) return httpsOnly ? "an https:// address" : "an http:// (this machine only) or https:// address";
  const [, scheme, authority] = m;
  if (authority.includes("@")) return "no user name or password part";
  const a = /^(\[[^\]]*\]|[^:]*)(?::(\d{1,5}))?$/.exec(authority);
  if (!a || !HOST.test(a[1])) return "not a plain host name or address";
  if (a[2] !== undefined && (Number(a[2]) < 1 || Number(a[2]) > 65535)) return "port out of range";
  let parsed;
  try {
    parsed = new URL(s);
  } catch {
    return "not a valid address";
  }
  if (parsed.hostname.toLowerCase() !== a[1].toLowerCase()) return "not a plain host name or address";
  if (scheme === "http") {
    if (httpsOnly) return "an https:// address";
    if (!anyHttp && !LOOPBACK.has(a[1].toLowerCase())) return "http:// only to this machine (127.0.0.1, ::1, localhost); any other host needs https://";
  }
  return null;
}

/** True when a node address is on this machine (the host is 127.0.0.1, [::1] or localhost) and is written with http:// (swap-cli counts only that form as its own node). */
function isLoopbackUrl(s) {
  const m = typeof s === "string" ? /^http:\/\/(\[[^\]]*\]|[^:/?#]*)/.exec(s) : null;
  return !!m && LOOPBACK.has(m[1].toLowerCase());
}

/**
 * What a production (Ethereum mainnet) swap needs on top of the schema, each one a fail-closed refusal in the program's own words (`p(key, why)`): a fee cap, contract version 1
 * (version 2 never ran live), two Ethereum nodes and no single-node switch (a swap with a stranger needs the second-node checks), no board handover (the board stays test-only),
 * and, for Bob, a second Parano1d node unless his own node is on this machine (the producer check needs one; D2). The caps are the profile's own (checked with the amounts above).
 */
const MAINNET_TIP_MAX_GWEI = 2n; // the tip is paid on every Ethereum step, so it has a mainnet-sized limit of its own; the cap stays the person's
const MAINNET_CAP_MAX_GWEI = 100n; // a new mainnet swap's fee cap; a re-send may go higher (lib/actions.js), the schema's own limit for a loaded file stays 1000
function productionRules(o, p, create) {
  if (o.gas_price_gwei === null) p("gas_price_gwei", "required on Ethereum mainnet: it is the fee cap (--max-fee-gwei)");
  // L8 (fix round 2): the two tightenings of fix round 1 and the cap limit are checked when a swap is made, never when its run.json is loaded (a tighter load would block its refund and sweep)
  if (create && typeof o.gas_price_gwei === "string" && GWEI_DEC.test(o.gas_price_gwei) && decimalToInt(o.gas_price_gwei, 9) > MAINNET_CAP_MAX_GWEI * 10n ** 9n) p("gas_price_gwei", `at most ${MAINNET_CAP_MAX_GWEI} gwei for a new swap on Ethereum mainnet (it is only the most you allow per gas; a stuck step can be re-sent at a higher cap later)`);
  if (create && typeof o.priority_fee_gwei === "string" && GWEI_DEC.test(o.priority_fee_gwei) && decimalToInt(o.priority_fee_gwei, 9) > MAINNET_TIP_MAX_GWEI * 10n ** 9n) p("priority_fee_gwei", `at most ${MAINNET_TIP_MAX_GWEI} gwei on Ethereum mainnet: the tip is paid on every Ethereum step (0.05 is the usual figure; check the decimal point)`);
  if (o.contract_version !== 1) p("contract_version", "must be 1 on Ethereum mainnet (version 2 has not run live)");
  if (o.eth_rpc2 === null) p("eth_rpc2", "required on Ethereum mainnet: two Ethereum nodes from two operators");
  if (o.single_node_ok !== false) p("single_node_ok", "must be false on Ethereum mainnet");
  if (o.handover !== null) p("handover", "must be null on Ethereum mainnet: the board does not run there");
  if (o.role === "bob" && o.noid_rpc2 === null && !isLoopbackUrl(o.noid_rpc)) p("noid_rpc2", "required for Bob on Ethereum mainnet unless his Parano1d node is on this machine: the producer check needs a second node");
}

/** Problems (an empty list = valid) of a settings object. Messages name the key and the rule, never a value. */
function validate(obj, { create = false } = {}) {
  const probs = [];
  const p = (k, why) => probs.push(`${k}: ${why}`);
  if (!plain(obj)) return ["the settings are not an object"];
  const keys = Object.keys(obj);
  for (const k of keys) if (!ORDER.includes(k)) probs.push(`${printable(k)}: not a setting of this version`);
  for (const k of ORDER) if (!Object.prototype.hasOwnProperty.call(obj, k)) p(k, "missing");
  if (probs.length) return probs;
  const o = obj;
  const addr = (k, { nullable }) => {
    const x = o[k];
    if (x === null) {
      if (!nullable) p(k, "required");
      return;
    }
    if (typeof x !== "string") return p(k, "text or null expected");
    const why = noidAddressProblem(x);
    if (why) p(k, why);
  };
  const eth = (k, { nullable, checksum = false }) => {
    const x = o[k];
    if (x === null) {
      if (!nullable) p(k, "required");
      return;
    }
    if (typeof x !== "string") return p(k, "text or null expected");
    if (checksum) {
      const why = ethAddressProblem(x);
      if (why) p(k, why);
    } else if (!ETH_ADDR.test(x)) p(k, "0x followed by 40 hexadecimal characters");
  };
  const bool = (k) => {
    if (typeof o[k] !== "boolean") p(k, "true or false");
  };
  const whole = (k, min, max, { nullable = false } = {}) => {
    if (o[k] === null && nullable) return;
    if (!isInt(o[k]) || o[k] < min || o[k] > max) p(k, `a whole number from ${min} to ${max}${nullable ? " or null" : ""}`);
  };
  const url = (k, { nullable, httpsOnly = false }) => {
    if (o[k] === null) {
      if (!nullable) p(k, "required");
      return;
    }
    const why = urlProblem(o[k], { httpsOnly, anyHttp: !create });
    if (why) p(k, why);
  };

  if (o.v !== 1) p("v", "must be 1");
  if (typeof o.run_id !== "string" || !RUN_ID.test(o.run_id)) p("run_id", "32 lower-case hexadecimal characters");
  if (o.role !== "alice" && o.role !== "bob") p("role", "alice or bob");
  const prof = typeof o.profile === "string" && Object.prototype.hasOwnProperty.call(PROFILES, o.profile) ? PROFILES[o.profile] : null;
  if (!prof) p("profile", `one of ${Object.keys(PROFILES).join(", ")}`);
  if (!isInt(o.chain_id)) p("chain_id", "must be the chain of the profile (1 for production, 11155111 for sepolia, 31337 for rehearsal)");
  else if (prof && o.chain_id !== prof.chain) p("chain_id", "does not match the profile");
  else if (!prof && o.chain_id === 1) p("chain_id", "chain 1 only with the production profile");
  const production = o.profile === "production";
  eth("contract", { nullable: false });
  if (o.lock_kind !== "poseidon") p("lock_kind", "must be poseidon");
  if (o.variant !== "raw") p("variant", "must be raw");
  if (o.contract_version !== 1 && o.contract_version !== 2) p("contract_version", "1 or 2");
  const amount = (k, cap, label) => {
    if (typeof o[k] !== "string" || !AMOUNT.test(o[k])) return p(k, "a decimal whole number as text, more than zero");
    const n = BigInt(o[k]);
    if (prof && n > cap) p(k, `over the cap of the ${o.profile} profile (${label})`);
    else if (!prof && n > 10n ** 19n) p(k, "too large");
  };
  amount("amount_micronoid", prof ? prof.max_noid_micro : 0n, "micro-NOID");
  amount("amount_wei", prof ? prof.max_eth_wei : 0n, "wei");

  addr("alice_noid", { nullable: true });
  addr("bob_noid", { nullable: true });
  eth("alice_eth", { nullable: true });
  eth("bob_eth", { nullable: true });
  addr("noid_payout", { nullable: true });
  eth("eth_payout", { nullable: false, checksum: true });
  // the tool makes its own addresses in a wallet run (the helpers' wallet-setup step); a stale address of another wallet may not stand in for them
  if (o.role === "alice") {
    if (o.alice_noid !== null) p("alice_noid", "made by the tool for this swap: null");
    if (o.alice_eth !== null) p("alice_eth", "made by the tool for this swap: null");
    if (o.noid_payout === null) p("noid_payout", "required for Alice: her own Parano1d address");
    if (o.bob_noid === null) p("bob_noid", "required for Alice: Bob's Parano1d address");
    if (o.bob_eth === null) p("bob_eth", "required for Alice: Bob's Ethereum address");
  } else if (o.role === "bob") {
    if (o.bob_eth !== null) p("bob_eth", "made by the tool for this swap: null");
    if (o.bob_noid === null) p("bob_noid", "required for Bob: his own Parano1d address");
  }
  const same = (a, b, ci) => typeof a === "string" && typeof b === "string" && (ci ? a.toLowerCase() === b.toLowerCase() : a === b);
  if (same(o.alice_noid, o.bob_noid)) p("bob_noid", "must differ from alice_noid");
  if (same(o.alice_eth, o.bob_eth, true)) p("bob_eth", "must differ from alice_eth");
  if (o.role === "alice" && same(o.noid_payout, o.bob_noid)) p("noid_payout", "is Bob's address: use your own");
  if (same(o.eth_payout, o.contract, true)) p("eth_payout", "is the swap's contract address: use your own");
  if (o.role === "alice" && same(o.eth_payout, o.bob_eth, true)) p("eth_payout", "is Bob's address: use your own");

  url("noid_rpc", { nullable: false });
  url("noid_rpc2", { nullable: true });
  url("eth_rpc", { nullable: false });
  url("eth_rpc2", { nullable: true });
  bool("noid_rpc2_remote");
  bool("eth_rpc2_remote");
  bool("single_node_ok");
  if (o.noid_rpc2_remote === true && o.noid_rpc2 === null) p("noid_rpc2_remote", "true only with a second node (noid_rpc2)");
  if (o.eth_rpc2_remote === true && o.eth_rpc2 === null) p("eth_rpc2_remote", "true only with a second node (eth_rpc2)");
  if (typeof o.noid_rpc2 === "string" && typeof o.noid_rpc === "string" && o.noid_rpc2.toLowerCase() === o.noid_rpc.toLowerCase()) p("noid_rpc2", "must be a different node from noid_rpc");
  if (typeof o.eth_rpc2 === "string" && typeof o.eth_rpc === "string" && o.eth_rpc2.toLowerCase() === o.eth_rpc.toLowerCase()) p("eth_rpc2", "must be a different node from eth_rpc");
  whole("rpc_timeout_s", 1, 600);

  for (const k of ["gas_price_gwei", "priority_fee_gwei"]) {
    const x = o[k];
    if (x === null) continue;
    if (typeof x !== "string" || !GWEI_DEC.test(x)) p(k, "a decimal in gwei like 0.01 or 20 (at most 9 decimals) or null");
    else if (decimalToInt(x, 9) <= 0n) p(k, "more than zero");
    else if (decimalToInt(x, 9) > 1000n * 10n ** 9n) p(k, "at most 1000 gwei");
  }
  if (typeof o.gas_price_gwei === "string" && typeof o.priority_fee_gwei === "string" && GWEI_DEC.test(o.gas_price_gwei) && GWEI_DEC.test(o.priority_fee_gwei)) {
    if (decimalToInt(o.priority_fee_gwei, 9) > decimalToInt(o.gas_price_gwei, 9)) p("priority_fee_gwei", "cannot be above gas_price_gwei");
  }
  whole("deploy_block", 1, 9_999_999_999, { nullable: true });
  whole("eth_start_margin", 0, 1_000_000);
  whole("hc_lead", 1, 1000);
  whole("lock_precheck_timeout_s", 1, 90, { nullable: true });
  if (o.handover !== null && o.handover !== "board") p("handover", "board or null");
  url("alert_url", { nullable: true, httpsOnly: true });
  if (production) productionRules(o, p, create);
  return probs;
}

// ---- strict JSON reading

/** Reads `text` as JSON with no leniency; throws RunSettingsError (a message without any value) on the first thing it refuses. */
function strictJson(text) {
  let i = 0;
  const fail = (why) => {
    throw new RunSettingsError(`run.json is refused: ${why} (at character ${i})`);
  };
  const ws = () => {
    while (i < text.length && (text[i] === " " || text[i] === "\t" || text[i] === "\n" || text[i] === "\r")) i++;
  };
  const str = () => {
    i++; // opening quote
    let out = "";
    for (;;) {
      if (i >= text.length) fail("a string is not closed");
      const c = text[i];
      const code = c.charCodeAt(0);
      if (c === '"') {
        i++;
        return out;
      }
      if (code < 0x20) fail("a control character inside a string");
      if (c === "\\") {
        const e = text[i + 1];
        const simple = { '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };
        if (e !== undefined && Object.prototype.hasOwnProperty.call(simple, e)) {
          out += simple[e];
          i += 2;
        } else if (e === "u" && /^[0-9a-fA-F]{4}$/.test(text.slice(i + 2, i + 6))) {
          out += String.fromCharCode(parseInt(text.slice(i + 2, i + 6), 16));
          i += 6;
        } else fail("a bad escape inside a string");
      } else {
        out += c;
        i++;
      }
    }
  };
  const value = (depth) => {
    if (depth > MAX_DEPTH) fail("nested too deeply");
    ws();
    const c = text[i];
    if (c === "{") {
      i++;
      const o = Object.create(null);
      ws();
      if (text[i] === "}") {
        i++;
        return o;
      }
      for (;;) {
        ws();
        if (text[i] !== '"') fail("a key was expected");
        const k = str();
        if (Object.prototype.hasOwnProperty.call(o, k)) fail("a key appears twice");
        ws();
        if (text[i] !== ":") fail("a colon was expected");
        i++;
        o[k] = value(depth + 1);
        ws();
        if (text[i] === ",") {
          i++;
          continue;
        }
        if (text[i] === "}") {
          i++;
          return o;
        }
        fail("a comma or a closing brace was expected");
      }
    }
    if (c === "[") {
      i++;
      const a = [];
      ws();
      if (text[i] === "]") {
        i++;
        return a;
      }
      for (;;) {
        a.push(value(depth + 1));
        ws();
        if (text[i] === ",") {
          i++;
          continue;
        }
        if (text[i] === "]") {
          i++;
          return a;
        }
        fail("a comma or a closing bracket was expected");
      }
    }
    if (c === '"') return str();
    for (const [w, v] of [["true", true], ["false", false], ["null", null]]) {
      if (text.startsWith(w, i)) {
        i += w.length;
        return v;
      }
    }
    const n = /^-?(?:0|[1-9]\d*)(?![\d.eE+-])/.exec(text.slice(i, i + 40));
    if (n) {
      i += n[0].length;
      const x = Number(n[0]);
      if (!Number.isSafeInteger(x) || Object.is(x, -0)) fail("a number that is not a safe whole number");
      return x;
    }
    return fail("a value was expected, or a number that is not a whole number");
  };
  const root = (() => {
    ws();
    if (text[i] !== "{") fail("the file must hold one JSON object");
    const r = value(0);
    ws();
    if (i < text.length) fail("something follows the object");
    return r;
  })();
  return root;
}

/**
 * Text to the raw settings object. Refuses a BOM, a file over 64 KB, anything that is not one JSON object, a duplicate key at any depth, an unknown
 * key, and any value that is not a string, a whole number, true, false or null. It does not apply the schema (validate / load do).
 */
function parse(text) {
  if (typeof text !== "string") throw new RunSettingsError("run.json is refused: text expected");
  if (Buffer.byteLength(text, "utf8") > MAX_BYTES) throw new RunSettingsError(`run.json is refused: larger than ${MAX_BYTES} bytes`);
  if (text.charCodeAt(0) === 0xfeff) throw new RunSettingsError("run.json is refused: it starts with a byte order mark");
  const raw = strictJson(text);
  const out = {};
  for (const k of Object.keys(raw)) {
    if (!ORDER.includes(k)) throw new RunSettingsError(`run.json is refused: ${printable(k)} is not a setting of this version`);
    const x = raw[k];
    if (x !== null && typeof x !== "string" && typeof x !== "boolean" && !isInt(x)) throw new RunSettingsError(`run.json is refused: ${k} must be a string, a whole number, true, false or null`);
    out[k] = x;
  }
  return out;
}

const ordered = (o) => {
  const r = {};
  for (const k of ORDER) r[k] = o[k];
  return r;
};

function refuseIfInvalid(obj, create = false) {
  const probs = validate(obj, { create });
  if (probs.length) throw new RunSettingsError(`run.json is refused: ${probs.slice(0, 6).join("; ")}${probs.length > 6 ? `; and ${probs.length - 6} more` : ""}`, probs);
}

/** Text to the validated, frozen settings; throws RunSettingsError. */
function parseValid(text) {
  const o = parse(text);
  refuseIfInvalid(o);
  return Object.freeze(ordered(o));
}

/** Reads <runDir>/run.json as bytes: a plain file (not a symbolic link, not another kind), at most 64 KB. Returns the text, or throws RunSettingsError. */
function readText(runDir) {
  const file = path.join(runDir, FILE);
  let st;
  try {
    st = fs.lstatSync(file);
  } catch (e) {
    throw new RunSettingsError(e && e.code === "ENOENT" ? "run.json is not in the run folder" : "run.json cannot be read");
  }
  if (st.isSymbolicLink()) throw new RunSettingsError("run.json is refused: it is a symbolic link");
  if (!st.isFile()) throw new RunSettingsError("run.json is refused: it is not a plain file");
  if (st.size > MAX_BYTES) throw new RunSettingsError(`run.json is refused: larger than ${MAX_BYTES} bytes`);
  let buf;
  try {
    buf = fs.readFileSync(file);
  } catch {
    throw new RunSettingsError("run.json cannot be read");
  }
  if (buf.length > MAX_BYTES) throw new RunSettingsError(`run.json is refused: larger than ${MAX_BYTES} bytes`);
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buf);
  } catch {
    throw new RunSettingsError("run.json is refused: it is not valid UTF-8");
  }
  return text;
}

/** The frozen settings of a run folder, or a thrown RunSettingsError. */
function load(runDir) {
  return parseValid(readText(runDir));
}

/** The bytes the autopilot approval binds: the keys in the table's order, two-space indent, one final newline. Refuses an invalid object. */
function canonicalBytes(obj, create = false) {
  refuseIfInvalid(obj, create);
  return Buffer.from(JSON.stringify(obj, ORDER, 2) + "\n", "utf8");
}

// the keys of a run.json that an update (write without `create`) must leave as they are
const FIXED_AFTER_CREATE = ["run_id", "role", "profile", "noid_payout", "eth_payout"];

/**
 * Writes <runDir>/run.json: validates first, then writes beside and renames over. With `create: true` an existing run.json (or a link of that name)
 * is never replaced; without it the file must already be there and its run_id, role, profile and two payout addresses must stay as they are. Mode 0o600. Returns { path, bytes }.
 */
function write(runDir, obj, { create = false } = {}) {
  refuseIfInvalid(obj, create);
  const bytes = canonicalBytes(obj, create);
  let st;
  try {
    st = fs.statSync(runDir);
  } catch {
    st = null;
  }
  if (!st || !st.isDirectory()) throw new RunSettingsError("the run folder does not exist");
  const target = path.join(runDir, FILE);
  let existing = null;
  try {
    existing = fs.lstatSync(target);
  } catch {
    /* absent */
  }
  if (create && existing) throw new RunSettingsError("run.json already exists: a new swap never replaces it");
  if (!create && !existing) throw new RunSettingsError("run.json is not there to update: only a new swap makes it");
  if (!create && !existing.isFile()) throw new RunSettingsError("run.json is not a plain file");
  if (!create) {
    // what makes this swap this swap (and where its leftovers go) is fixed when it is made: an update may change the rest
    let cur;
    try {
      cur = load(runDir);
    } catch {
      throw new RunSettingsError("run.json cannot be read as it is, so it is not updated");
    }
    for (const k of FIXED_AFTER_CREATE) if (cur[k] !== obj[k]) throw new RunSettingsError(`${k} is fixed when the swap is made: run.json is not updated`);
  }
  const tmp = path.join(runDir, `${FILE}.tmp-${process.pid}-${crypto.randomBytes(4).toString("hex")}`);
  let fd = null;
  try {
    fd = fs.openSync(tmp, "wx", 0o600);
    fs.writeSync(fd, bytes);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    if (create) {
      try {
        fs.linkSync(tmp, target); // fails when the name exists, so a racing create cannot be overwritten
      } catch (e) {
        if (e && e.code === "EEXIST") throw new RunSettingsError("run.json already exists: a new swap never replaces it");
        // no hard links on this file system: fall back to an exclusive create
        const fd2 = fs.openSync(target, "wx", 0o600);
        try {
          fs.writeSync(fd2, bytes);
          fs.fsyncSync(fd2);
        } finally {
          fs.closeSync(fd2);
        }
      }
    } else fs.renameSync(tmp, target);
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        /* ignore */
      }
    }
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* renamed away, or never made */
    }
  }
  return { path: target, bytes: bytes.length };
}

/** Settings for a new swap: `fields` holds every key but `v` and `run_id`, which are filled here (a fresh random id). Validated; throws RunSettingsError. */
function newSettings(fields, { runId } = {}) {
  if (!plain(fields)) throw new RunSettingsError("the settings are not an object");
  if (Object.prototype.hasOwnProperty.call(fields, "v") || Object.prototype.hasOwnProperty.call(fields, "run_id")) throw new RunSettingsError("v and run_id are filled by the program, not given");
  // `runId` (the program's own option, never a field): the id the run folder was already named by (the offer board makes the folder first). Same shape as a made one.
  if (runId !== undefined && (typeof runId !== "string" || !RUN_ID.test(runId))) throw new RunSettingsError("runId: 32 lower-case hexadecimal characters");
  const o = { v: 1, run_id: runId !== undefined ? runId : crypto.randomBytes(16).toString("hex"), ...fields };
  refuseIfInvalid(o, true);
  return Object.freeze(ordered(o));
}

// ---- production check on the raw text

/** Lenient tokens of a text: strings (decoded), bare words, numeric literals and colons. Never throws. */
function lenientTokens(text) {
  const toks = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '"' || c === "'") {
      let s = "";
      i++;
      while (i < text.length && text[i] !== c) {
        if (text[i] === "\\" && i + 1 < text.length) {
          const e = text[i + 1];
          if (e === "u" && /^[0-9a-fA-F]{4}$/.test(text.slice(i + 2, i + 6))) {
            s += String.fromCharCode(parseInt(text.slice(i + 2, i + 6), 16));
            i += 6;
            continue;
          }
          s += { n: "\n", t: "\t", r: "\r", b: "\b", f: "\f" }[e] || e;
          i += 2;
          continue;
        }
        s += text[i++];
      }
      i++;
      toks.push({ s });
    } else if (c === ":") {
      toks.push({ colon: true });
      i++;
    } else if (/[A-Za-z_]/.test(c)) {
      let w = "";
      while (i < text.length && /[A-Za-z0-9_]/.test(text[i])) w += text[i++];
      toks.push({ w });
    } else if (/[-+.0-9]/.test(c)) {
      let n = "";
      while (i < text.length && /[-+.0-9eExXa-fA-F_]/.test(text[i])) n += text[i++];
      toks.push({ n });
    } else i++;
  }
  return toks;
}

/** True when the raw text says production anywhere: a string or bare word `production`, or a chain key whose value is 1, duplicates and nesting included. */
function textSaysProduction(text) {
  const t = String(text).replace(/^﻿/, "");
  const toks = lenientTokens(t);
  const isProd = (x) => String(x).trim().toLowerCase() === "production";
  const isOne = (v) => {
    const x = v.s !== undefined ? v.s.trim() : v.n !== undefined ? v.n : v.w;
    if (x === undefined || x === "") return false;
    const n = Number(String(x).replace(/_/g, ""));
    return n === 1;
  };
  for (let k = 0; k < toks.length; k++) {
    const tk = toks[k];
    if ((tk.s !== undefined && isProd(tk.s)) || (tk.w !== undefined && isProd(tk.w))) return true;
    const key = tk.s !== undefined ? tk.s : tk.w;
    if (key !== undefined && /^chain(?:_?id)?$/i.test(key.trim()) && toks[k + 1] && toks[k + 1].colon && toks[k + 2] && isOne(toks[k + 2])) return true;
  }
  return false;
}

/**
 * Why <runDir>/run.json must not be acted on, or null (a file that passes the schema, mainnet included, gives null). A string: PRODUCTION_TEXT when a file that does NOT pass
 * the schema says production anywhere (a `production` value, or chain 1, in any place, duplicates and odd spacing included), another text when the file cannot be read safely or
 * does not pass the schema. No run.json: null (load refuses it separately).
 */
function productionReason(runDir) {
  const file = path.join(runDir || "", FILE);
  let st = null;
  try {
    st = fs.lstatSync(file);
  } catch (e) {
    if (e && e.code === "ENOENT") return null;
    return "run.json cannot be read safely: every action is refused.";
  }
  if (st.isSymbolicLink() || !st.isFile() || st.size > MAX_BYTES) return "run.json cannot be read safely (a link, not a plain file, or too large): every action is refused.";
  let buf;
  try {
    buf = fs.readFileSync(file);
  } catch {
    return "run.json cannot be read safely: every action is refused.";
  }
  if (buf.length > MAX_BYTES) return "run.json cannot be read safely (too large): every action is refused.";
  // A file that passes the schema is acted on, production included: the schema itself holds the production rules (the caps, the fee cap, chain 1). Any other file that says
  // production (or chain 1) anywhere stays refused with PRODUCTION_TEXT: read as UTF-8 and again as UTF-16 little-endian, so a file that is not UTF-8 cannot hide a production value
  // and be taken for a test run.
  let schemaProblem = null;
  try {
    parseValid(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buf));
    return null;
  } catch (e) {
    schemaProblem = e instanceof RunSettingsError ? e.message : "";
  }
  const texts = [buf.toString("utf8")];
  if (buf.length >= 2 && (buf[0] === 0xff || buf[1] === 0xff || buf.includes(0))) texts.push(buf.toString("utf16le"), Buffer.from(buf.subarray(1)).toString("utf16le"));
  if (texts.some(textSaysProduction)) return PRODUCTION_TEXT;
  return `run.json does not pass its schema: every action is refused. ${schemaProblem}`.trim();
}

// ---- migration from env.local.sh

const REPLACED = [
  "UI_ROLE", "PROFILE", "CHAIN", "CONTRACT", "LOCK_KIND", "VARIANT", "CONTRACT_VERSION", "AMOUNT", "WEI", "ALICE_NOID", "BOB_NOID", "ALICE_ETH", "BOB_ETH",
  "NOID_PAYOUT", "ETH_PAYOUT", "NOID_RPC", "NOID_RPC2", "NOID_RPC2_REMOTE", "ETH_RPC2_REMOTE", "SINGLE_NODE_OK", "ETH_RPC", "ETH_RPC2", "RPC_TIMEOUT",
  "GAS_PRICE_GWEI", "PRIORITY_FEE_GWEI", "DEPLOY_BLOCK", "ETH_START_MARGIN", "HC_LEAD", "LOCK_PRECHECK_TIMEOUT", "HANDOVER", "ALERT_URL",
];
const MIGRATABLE = [...REPLACED, "USE_SWAP_WALLET"]; // USE_SWAP_WALLET must be 1 (a wallet run); it becomes the fact that every run.json is one
const BOB_TERMS = ["BOB_NOID", "BOB_ETH", "CONTRACT", "AMOUNT", "WEI", "CHAIN", "PROFILE", "CONTRACT_VERSION", "LOCK_KIND", "VARIANT"];
const ASSIGN = /^(?:export[ \t]+)?([A-Z][A-Z0-9_]*)=(?:'([^']*)'|"([^"$`\\]*)"|([A-Za-z0-9._:/@+-]*))[ \t]*(?:[ \t]#.*)?$/;

/** Reads env.local.sh as text. Returns { name: value } of the plain assignments; throws RunSettingsError on anything it cannot read for sure. Never runs the file. */
function readEnvLocal(runDir) {
  const file = path.join(runDir, "env.local.sh");
  let st;
  try {
    st = fs.lstatSync(file);
  } catch {
    throw new RunSettingsError("env.local.sh is not in the run folder: nothing to migrate");
  }
  if (st.isSymbolicLink() || !st.isFile()) throw new RunSettingsError("env.local.sh is refused: it is not a plain file");
  if (st.size > MAX_BYTES) throw new RunSettingsError(`env.local.sh is refused: larger than ${MAX_BYTES} bytes`);
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(fs.readFileSync(file));
  } catch {
    throw new RunSettingsError("env.local.sh is refused: it cannot be read as UTF-8 text");
  }
  if (text.charCodeAt(0) === 0xfeff) throw new RunSettingsError("env.local.sh is refused: it starts with a byte order mark");
  if (text.includes("\0")) throw new RunSettingsError("env.local.sh is refused: it holds a NUL character");
  const vals = Object.create(null);
  const lines = text.split(/\r?\n/);
  for (let n = 0; n < lines.length; n++) {
    const line = lines[n];
    if (/\r/.test(line)) throw new RunSettingsError(`env.local.sh is refused: line ${n + 1} has a stray carriage return`);
    if (/^[ \t]*$/.test(line) || /^[ \t]*#/.test(line)) continue;
    const m = ASSIGN.exec(line);
    if (!m) throw new RunSettingsError(`env.local.sh is refused: line ${n + 1} is not a plain NAME=value line (a quoted or simple value only), so it cannot be read for sure`);
    const name = m[1];
    if (!MIGRATABLE.includes(name)) throw new RunSettingsError(`env.local.sh is refused: it sets ${name}, which run.json does not carry (edit the setting out by hand, or keep using the terminal helpers)`);
    if (Object.prototype.hasOwnProperty.call(vals, name)) throw new RunSettingsError(`env.local.sh is refused: ${name} is assigned twice`);
    vals[name] = m[2] !== undefined ? m[2] : m[3] !== undefined ? m[3] : m[4] !== undefined ? m[4] : "";
  }
  return vals;
}

/**
 * Converts <runDir>/env.local.sh into run.json (read as text, never sourced; env.local.sh stays). `role` is alice or bob; it must agree with UI_ROLE when
 * the file has one. Refuses a classic run, a sha256 or missing lock kind, role both, any production value, any setting run.json does not carry, a line it
 * cannot read for sure, and an existing run.json. Bob's terms must be assigned in the old file in every case (a default is not his
 * agreement, and run.json keeps no record of which values were defaulted). Values env.sh would have defaulted are written explicitly. Returns { settings, defaulted: [env names], path }.
 */
function migrateFromEnvLocal(runDir, { role } = {}) {
  if (role !== "alice" && role !== "bob") throw new RunSettingsError("migration needs the role: alice or bob");
  let existing = null;
  try {
    existing = fs.lstatSync(path.join(runDir, FILE));
  } catch {
    /* absent */
  }
  if (existing) throw new RunSettingsError("run.json already exists: a migration never replaces it");
  // the program refuses a folder that holds the other role's swap file (design 12.4): a run.json made for it would never open
  const otherFile = role === "alice" ? path.join(runDir, "bob", "bob.swap.json") : path.join(runDir, "alice.swap.json");
  let otherThere = false;
  try {
    fs.lstatSync(otherFile);
    otherThere = true;
  } catch {
    /* absent */
  }
  if (otherThere) throw new RunSettingsError(`this folder holds ${role === "alice" ? "Bob" : "Alice"}'s swap file, so it cannot be ${role === "alice" ? "Alice" : "Bob"}'s run: a run folder holds one role's files`);
  const v = readEnvLocal(runDir);
  const has = (k) => Object.prototype.hasOwnProperty.call(v, k);
  for (const [k, x] of Object.entries(v)) {
    if (/^production$/i.test(x.trim())) throw new RunSettingsError(`env.local.sh is refused: ${k} says production (test networks only)`);
  }
  if (has("CHAIN") && v.CHAIN.trim() === "1") throw new RunSettingsError("env.local.sh is refused: CHAIN is 1 (Ethereum mainnet; test networks only)");
  if (!has("USE_SWAP_WALLET") || v.USE_SWAP_WALLET !== "1") throw new RunSettingsError("env.local.sh is refused: it is not a wallet run (USE_SWAP_WALLET=1); a classic run is not migrated");
  if (has("UI_ROLE")) {
    if (v.UI_ROLE === "both") throw new RunSettingsError("env.local.sh is refused: UI_ROLE is both; run.json holds one role");
    if (v.UI_ROLE !== "alice" && v.UI_ROLE !== "bob") throw new RunSettingsError("env.local.sh is refused: UI_ROLE is not alice or bob");
    if (v.UI_ROLE !== role) throw new RunSettingsError("env.local.sh is refused: UI_ROLE does not agree with the role asked for");
  }
  if (!has("LOCK_KIND")) throw new RunSettingsError("env.local.sh is refused: LOCK_KIND is not assigned (the helpers default to sha256; run.json is poseidon only)");
  if (v.LOCK_KIND !== "poseidon") throw new RunSettingsError("env.local.sh is refused: LOCK_KIND is not poseidon");
  if (role === "bob") {
    // In every case, his swap file or not: run.json has no defaults, so a default written here would later pass as his agreement (a join after the
    // swap file was removed would use it). BOB_ETH is not asked: in a wallet run Bob's Ethereum address is the swap key's (join.sh skips it too).
    const miss = BOB_TERMS.filter((k) => !has(k) && k !== "BOB_ETH");
    if (miss.length) throw new RunSettingsError(`env.local.sh is refused: Bob's terms are not assigned: ${miss.join(", ")} (a default is not his agreement)`);
  }
  const defaulted = [];
  const pick = (name, dflt) => {
    if (has(name)) return v[name];
    defaulted.push(name);
    return dflt;
  };
  const nul = (x) => (x === "" ? null : x);
  const bool = (name) => {
    if (!has(name)) return false; // env.sh's own default is 0 (not listed as defaulted: false is the setting's off state)
    if (v[name] === "0") return false;
    if (v[name] === "1") return true;
    throw new RunSettingsError(`env.local.sh is refused: ${name} must be 0 or 1`);
  };
  const whole = (name, dflt, nullable) => {
    const x = nullable ? (has(name) ? v[name] : null) : pick(name, dflt === undefined ? "" : String(dflt));
    if (x === null || (nullable && x === "")) return null;
    if (!/^(?:0|[1-9]\d{0,15})$/.test(x)) throw new RunSettingsError(`env.local.sh is refused: ${name} must be a whole number`);
    return Number(x);
  };
  const chainText = pick("CHAIN", String(DEFAULTS.chain_id));
  if (!/^(?:0|[1-9]\d{0,15})$/.test(chainText)) throw new RunSettingsError("env.local.sh is refused: CHAIN must be a whole number");
  const handover = nul(has("HANDOVER") ? v.HANDOVER : "");
  const fields = {
    role,
    profile: pick("PROFILE", DEFAULTS.profile),
    chain_id: Number(chainText),
    contract: has("CONTRACT") ? v.CONTRACT : "",
    lock_kind: "poseidon",
    variant: pick("VARIANT", DEFAULTS.variant),
    contract_version: (() => {
      const x = pick("CONTRACT_VERSION", String(DEFAULTS.contract_version));
      return x === "1" ? 1 : x === "2" ? 2 : x;
    })(),
    amount_micronoid: pick("AMOUNT", DEFAULTS.amount_micronoid),
    amount_wei: pick("WEI", DEFAULTS.amount_wei),
    alice_noid: nul(has("ALICE_NOID") ? v.ALICE_NOID : ""),
    bob_noid: nul(has("BOB_NOID") ? v.BOB_NOID : ""),
    alice_eth: nul(has("ALICE_ETH") ? v.ALICE_ETH : ""),
    bob_eth: nul(has("BOB_ETH") ? v.BOB_ETH : ""),
    noid_payout: nul(has("NOID_PAYOUT") ? v.NOID_PAYOUT : ""),
    eth_payout: nul(has("ETH_PAYOUT") ? v.ETH_PAYOUT : ""),
    noid_rpc: pick("NOID_RPC", DEFAULTS.noid_rpc),
    noid_rpc2: nul(has("NOID_RPC2") ? v.NOID_RPC2 : ""),
    noid_rpc2_remote: bool("NOID_RPC2_REMOTE"),
    eth_rpc2_remote: bool("ETH_RPC2_REMOTE"),
    single_node_ok: bool("SINGLE_NODE_OK"),
    eth_rpc: pick("ETH_RPC", DEFAULTS.eth_rpc),
    eth_rpc2: nul(has("ETH_RPC2") ? v.ETH_RPC2 : ""),
    rpc_timeout_s: whole("RPC_TIMEOUT", DEFAULTS.rpc_timeout_s, false),
    gas_price_gwei: nul(has("GAS_PRICE_GWEI") ? v.GAS_PRICE_GWEI : ""),
    priority_fee_gwei: nul(has("PRIORITY_FEE_GWEI") ? v.PRIORITY_FEE_GWEI : ""),
    deploy_block: whole("DEPLOY_BLOCK", null, true),
    eth_start_margin: whole("ETH_START_MARGIN", DEFAULTS.eth_start_margin, false),
    hc_lead: whole("HC_LEAD", DEFAULTS.hc_lead, false),
    lock_precheck_timeout_s: whole("LOCK_PRECHECK_TIMEOUT", null, true),
    handover,
    alert_url: nul(has("ALERT_URL") ? v.ALERT_URL : ""),
  };
  // a value that was assigned but fails the schema is refused (validate names the key, never the value)
  const settings = newSettings(fields);
  const written = write(runDir, settings, { create: true });
  return { settings, defaulted, path: written.path };
}

module.exports = {
  ORDER,
  DEFAULTS,
  FILE,
  MAX_BYTES,
  RunSettingsError,
  validate,
  parse,
  load,
  canonicalBytes,
  write,
  newSettings,
  productionReason,
  migrateFromEnvLocal,
  urlProblem,
  isLoopbackUrl,
  MAINNET_TIP_MAX_GWEI,
  MAINNET_CAP_MAX_GWEI,
  PRODUCTION_TEXT,
};
