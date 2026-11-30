"use strict";
/*
 * The new-swap form: strict validation and a FIXED template for $L/env.local.sh.
 *
 * The file is sourced by bash (scripts/live/env.sh), so nothing but values that match a strict pattern may reach it, and
 * every value is written between single quotes. There is no free text field: the role, the profile and the lock kind
 * come from short lists, the amounts are decimals converted here to integers and capped per profile, the four wallet
 * addresses are checked (bech32m checksum for Parano1d, 0x + 40 hex for Ethereum), the contract is 0x + 40 hex.
 * The chain id is not asked: it follows from the profile.
 *
 * The run number must equal the run this server was started for, so the form cannot write into another run's folder.
 * An existing env.local.sh is never overwritten silently: the caller must say `replace`, and the old file is kept
 * under a time-stamped name.
 */

const fs = require("fs");
const path = require("path");
const { decodeBech32m } = require("./bech32");
const { ethAddressProblem, noidAddressProblem } = require("./walletrun");

// TEST PROFILES ONLY. The `production` profile (Ethereum mainnet, chain 1) is not offered and not accepted: the console does not set up or act on a
// production swap until the external review (M4, PROJECT.md); the terminal stays the way for any mainnet run. A run folder that says production is
// shown read-only and every action is refused (lib/production.js). Caps in micro-NOID and wei, the same tiny ones for both test profiles.
const PROFILES = {
  sepolia: { chain: 11155111, max_noid_micro: 20_000_000n, max_eth_wei: 10n ** 16n },
  rehearsal: { chain: 31337, max_noid_micro: 20_000_000n, max_eth_wei: 10n ** 16n },
};
const ROLES = ["alice", "bob", "both"];
const LOCK_KINDS = ["sha256", "poseidon"];
// The two terms the Parano1d side of the agreement also depends on. Absent in a request means the helpers' own default (raw, 1), which the template now WRITES, so that a machine that only checks the other side's file (scripts/live/join.sh) has them as its own stated terms.
const VARIANTS = ["raw"]; // the stock variant has not run live and needs a throwaway wallet per swap: not offered by the form
const CONTRACT_VERSIONS = ["1", "2"];
// Optional fields: absent or empty means "do not write the line" (the helpers' own default applies). Form field -> env.local.sh variable.
// NOID_CLI and OBJ are deliberately NOT here: they name a program (fund.sh and recover-noid.sh execute NOID_CLI) and a file, so a request that could
// set them would make the helpers run any file. They are set by hand in env.local.sh; a file that has them makes "replace" refuse, as for any key
// this form cannot write.
const OPTIONAL = {
  deploy_block: "DEPLOY_BLOCK", // setup.sh: first block eth_getLogs scans (optional: without it setup.sh picks a recent finalized block from the node; never a block after the lock)
  hc_lead: "HC_LEAD", // prepare.sh: blocks between now and the planned h_create (default 50)
  bob_key: "BOB_KEY", // live.js --key-file of lock.sh and refund-eth.sh, relative to eth/ (default keys/bob.key)
  alice_key: "ALICE_KEY", // the same for reveal.sh (default keys/alice.key)
  gas_price_gwei: "GAS_PRICE_GWEI", // test chains only (--gas-price-gwei)
  priority_fee_gwei: "PRIORITY_FEE_GWEI", // the tip (--priority-fee-gwei); needs one of the two caps above and must not exceed it
  live_platform: "LIVE_PLATFORM", // wsl | native
  // The tool's own wallets (swap wallet, piece 2c): the user's OWN addresses the leftovers are swept to. Required in a wallet run (use_swap_wallet), refused in a classic one.
  noid_payout: "NOID_PAYOUT",
  eth_payout: "ETH_PAYOUT",
};
const FIELDS = ["use_swap_wallet", "role", "run", "profile", "lock_kind", "variant", "contract_version", "noid_amount", "eth_amount", "alice_noid", "bob_noid", "alice_eth", "bob_eth", "contract", "single_node_ok", ...Object.keys(OPTIONAL)];

const TEMPLATE_KEYS = ["UI_ROLE", "USE_SWAP_WALLET", "HANDOVER", "PROFILE", "CHAIN", "CONTRACT", "LOCK_KIND", "VARIANT", "CONTRACT_VERSION", "AMOUNT", "WEI", "ALICE_NOID", "BOB_NOID", "ALICE_ETH", "BOB_ETH", "SINGLE_NODE_OK", ...Object.values(OPTIONAL)];
const KEY_FILE = /^keys\/[A-Za-z0-9][A-Za-z0-9._-]{0,60}$/;
const GWEI_DEC = /^(0|[1-9]\d{0,3})(\.\d{1,9})?$/;
const PLATFORMS = ["wsl", "native"];
const ETH_ADDR = /^0x[0-9a-fA-F]{40}$/;
const NOID_DEC = /^(0|[1-9]\d{0,2})(\.\d{1,6})?$/;
const ETH_DEC = /^(0|[1-9]\d{0,1})(\.\d{1,18})?$/;

function decimalToInt(s, decimals) {
  const [w, f = ""] = s.split(".");
  return BigInt(w) * 10n ** BigInt(decimals) + BigInt(f.padEnd(decimals, "0") || "0");
}

/**
 * @param {object} f the posted fields (strings; single_node_ok a boolean)
 * @param {{runNumber:number}} ctx
 * @returns {{ok:boolean, errors:Object<string,string>, values?:object}}
 */
function validateForm(f, ctx) {
  const errors = {};
  const raw = f && typeof f === "object" && !Array.isArray(f) ? f : {};
  // `handover` exists only for the board host (lib/board/host.js passes ctx.board): the page's own settings form never carries it, so a request cannot make a run a board run
  for (const k of Object.keys(raw)) if (!FIELDS.includes(k) && !(k === "handover" && ctx.board === true)) errors[k] = "unknown field";
  const str = (k) => (typeof raw[k] === "string" ? raw[k].trim() : null);
  const need = (k) => {
    const v = str(k);
    if (v === null || v === "") {
      errors[k] = "required";
      return null;
    }
    return v;
  };

  // The tool's own wallets (rule 1 and 2 of the 2c specification): one tick, fixed for the run. A wallet run is one role per machine; the addresses the tool makes for the swap
  // (Alice's NOID wallet and Ethereum key, Bob's Ethereum key) are not asked here, and the user's own payout addresses are required.
  const uw = raw.use_swap_wallet;
  if (uw !== undefined && typeof uw !== "boolean") errors.use_swap_wallet = "true or false";
  const wallet = uw === true;
  // a board run (piece 3): fixed when the run is made, like the wallet mode; always a wallet run
  const handover = ctx.board === true && raw.handover !== undefined && raw.handover !== null ? raw.handover : null;
  if (ctx.board === true && handover !== "board") errors.handover = "a board run says board";
  if (handover === "board" && !wallet) errors.handover = "a board run is a wallet run";

  const role = need("role");
  if (role !== null && !ROLES.includes(role)) errors.role = `one of ${ROLES.join(", ")}`;
  else if (role === "both" && wallet) errors.role = "a wallet run is one role per machine: choose alice or bob (and start the console with --role alice or --role bob)";
  // a console started with --role alice|bob drives that role only: its settings are that role's
  else if (role !== null && ctx.serverRole && ctx.serverRole !== "both" && role !== ctx.serverRole) errors.role = `this console was started with --role ${ctx.serverRole}: the role here is ${ctx.serverRole}`;

  const runS = need("run");
  let run = null;
  if (runS !== null) {
    if (!/^[1-9]\d{0,3}$/.test(runS)) errors.run = "a whole number, 1 to 9999";
    else {
      run = Number(runS);
      if (run !== ctx.runNumber) errors.run = `this console was started for run ${ctx.runNumber}; it writes only into that run's folder`;
    }
  }

  const profile = need("profile");
  if (profile !== null && !PROFILES[profile]) errors.profile = `one of ${Object.keys(PROFILES).join(", ")}`;
  const prof = profile && PROFILES[profile] ? PROFILES[profile] : null;

  const lockKind = need("lock_kind");
  if (lockKind !== null && !LOCK_KINDS.includes(lockKind)) errors.lock_kind = `one of ${LOCK_KINDS.join(", ")}`;

  // variant and contract version: from short lists; absent or empty means the helpers' default (raw, 1) and is written as such
  const pick = (k, list, dflt) => {
    const raw0 = raw[k];
    if (raw0 === undefined || raw0 === null || (typeof raw0 === "string" && raw0.trim() === "")) return dflt;
    if (typeof raw0 !== "string" || !list.includes(raw0.trim())) {
      errors[k] = `one of ${list.join(", ")}`;
      return null;
    }
    return raw0.trim();
  };
  const variant = pick("variant", VARIANTS, "raw");
  const contractVersion = pick("contract_version", CONTRACT_VERSIONS, "1");
  if (variant === "stock" && lockKind === "poseidon") errors.variant = "the poseidon lock kind needs the raw variant";

  let noidMicro = null;
  const na = need("noid_amount");
  if (na !== null) {
    if (!NOID_DEC.test(na)) errors.noid_amount = "a decimal like 10 or 10.5 (at most 6 decimals)";
    else {
      noidMicro = decimalToInt(na, 6);
      if (noidMicro <= 0n) errors.noid_amount = "must be more than zero";
      else if (prof && noidMicro > prof.max_noid_micro) errors.noid_amount = `over the cap of ${Number(prof.max_noid_micro) / 1e6} NOID for the ${profile} profile`;
    }
  }
  let wei = null;
  const ea = need("eth_amount");
  if (ea !== null) {
    if (!ETH_DEC.test(ea)) errors.eth_amount = "a decimal like 0.001 (at most 18 decimals)";
    else {
      wei = decimalToInt(ea, 18);
      if (wei <= 0n) errors.eth_amount = "must be more than zero";
      else if (prof && wei > prof.max_eth_wei) errors.eth_amount = `over the cap of ${Number(prof.max_eth_wei) / 1e18} ETH for the ${profile} profile`;
    }
  }

  // In a wallet run the tool makes these addresses (wallet-setup.sh), so they are not asked and must be left empty; Bob's NOID address (where he receives) and Alice's counterparty
  // addresses stay terms the user states.
  const made = !wallet ? [] : role === "alice" ? ["alice_noid", "alice_eth"] : role === "bob" ? ["bob_eth"] : [];
  const optionalHere = !wallet ? [] : role === "bob" ? ["alice_noid", "alice_eth"] : [];
  const addr = (k) => {
    if (made.includes(k)) {
      if (typeof raw[k] === "string" && raw[k].trim() !== "") errors[k] = "made by the tool for this swap (wallet-setup.sh): leave it empty";
      return null;
    }
    if (optionalHere.includes(k) && (raw[k] === undefined || raw[k] === null || (typeof raw[k] === "string" && raw[k].trim() === ""))) return null;
    return need(k);
  };
  for (const k of ["alice_noid", "bob_noid"]) {
    const v = addr(k);
    if (v === null) continue;
    const d = decodeBech32m(v);
    if (!d.ok) errors[k] = `not a Parano1d address (o1…): ${d.reason}`;
  }
  for (const k of ["alice_eth", "bob_eth", "contract"]) {
    const v = addr(k);
    if (v !== null && !ETH_ADDR.test(v)) errors[k] = "0x followed by 40 hexadecimal characters";
  }
  if (!errors.alice_noid && !errors.bob_noid && str("alice_noid") && str("alice_noid") === str("bob_noid")) errors.bob_noid = "Alice's and Bob's Parano1d addresses must differ";
  if (!errors.alice_eth && !errors.bob_eth && str("alice_eth") && str("bob_eth") && str("alice_eth").toLowerCase() === str("bob_eth").toLowerCase()) errors.bob_eth = "Alice's and Bob's Ethereum addresses must differ";

  const sn = raw.single_node_ok;
  if (sn !== undefined && typeof sn !== "boolean") errors.single_node_ok = "true or false";

  // ---- optional fields: empty = the line is not written
  const opt = {};
  const given = (k) => {
    if (raw[k] === undefined || raw[k] === null) return null;
    if (typeof raw[k] !== "string") {
      errors[k] = "text expected";
      return null;
    }
    const v = raw[k].trim();
    return v === "" ? null : v;
  };
  const gweiWei = (g) => decimalToInt(g, 9);
  for (const k of ["deploy_block", "hc_lead"]) {
    const v = given(k);
    if (v === null) continue;
    if (!/^[1-9]\d{0,9}$/.test(v)) errors[k] = "a whole number, no sign";
    else if (k === "hc_lead" && Number(v) > 1000) errors[k] = "at most 1000 blocks";
    else opt[k] = v;
  }
  for (const k of ["bob_key", "alice_key"]) {
    const v = given(k);
    if (v === null) continue;
    if (!KEY_FILE.test(v) || v.includes("..")) errors[k] = "a key file inside eth/keys/, like keys/bob.key (letters, digits, . _ - only)";
    else opt[k] = v;
  }
  for (const k of ["gas_price_gwei", "priority_fee_gwei"]) {
    const v = given(k);
    if (v === null) continue;
    if (!GWEI_DEC.test(v) || gweiWei(v) <= 0n) errors[k] = "a decimal in gwei like 0.01 or 20 (at most 9 decimals, more than zero)";
    else if (gweiWei(v) > 1000n * 10n ** 9n) errors[k] = "at most 1000 gwei";
    else opt[k] = v;
  }
  if (!errors.gas_price_gwei && !errors.priority_fee_gwei && profile && PROFILES[profile]) {
    if (opt.priority_fee_gwei) {
      const cap = opt.gas_price_gwei;
      if (!cap) errors.priority_fee_gwei = "the tip needs a cap to sit under: give gas_price_gwei";
      else if (gweiWei(opt.priority_fee_gwei) > gweiWei(cap)) errors.priority_fee_gwei = "the tip cannot be above the cap";
    }
  }
  // the user's own payout addresses (wallet runs only): shape and checksum are checked here, the swap file seals them, and the helpers refuse any other address
  const noidPayout = given("noid_payout");
  const ethPayout = given("eth_payout");
  if (!wallet) {
    for (const [k, v] of [["noid_payout", noidPayout], ["eth_payout", ethPayout]]) if (v !== null) errors[k] = "only in a wallet run (tick \"Use the tool's own wallets\")";
  } else {
    if (role === "alice" && noidPayout === null && !errors.noid_payout) errors.noid_payout = "required: your own Parano1d address (o1…) the leftover NOID is sent to";
    if (noidPayout !== null) {
      const why = noidAddressProblem(noidPayout);
      if (why) errors.noid_payout = why;
      else {
        opt.noid_payout = noidPayout;
        if (!errors.bob_noid && str("bob_noid") && noidPayout === str("bob_noid") && role === "alice") errors.noid_payout = "this is Bob's address: use your own";
      }
    }
    if (ethPayout === null && !errors.eth_payout) errors.eth_payout = "required: your own Ethereum address (0x…) the leftover ETH is sent to";
    if (ethPayout !== null) {
      const why = ethAddressProblem(ethPayout);
      if (why) errors.eth_payout = why;
      else if (!errors.contract && str("contract") && ethPayout.toLowerCase() === str("contract").toLowerCase()) errors.eth_payout = "this is the swap's contract address: use your own address";
      else if (role === "alice" && !errors.bob_eth && str("bob_eth") && ethPayout.toLowerCase() === str("bob_eth").toLowerCase()) errors.eth_payout = "this is Bob's address: use your own";
      else opt.eth_payout = ethPayout;
    }
  }
  const plat = given("live_platform");
  if (plat !== null) {
    if (!PLATFORMS.includes(plat)) errors.live_platform = `one of ${PLATFORMS.join(", ")}`;
    else opt.live_platform = plat;
  }
  if (Object.keys(errors).length) return { ok: false, errors };
  return {
    ok: true,
    errors: {},
    values: {
      role,
      run,
      profile,
      chain: prof.chain,
      lock_kind: lockKind,
      variant,
      contract_version: contractVersion,
      amount_micro: noidMicro.toString(),
      wei: wei.toString(),
      alice_noid: str("alice_noid") || null,
      bob_noid: str("bob_noid"),
      alice_eth: str("alice_eth") || null,
      bob_eth: str("bob_eth") || null,
      contract: str("contract"),
      single_node_ok: sn === true,
      wallet,
      handover: handover === "board" ? "board" : null,
      optional: opt,
    },
  };
}

/** The fixed template. Every value is single-quoted and has passed a strict pattern above. */
function renderEnvLocal(v, stamp) {
  const q = (x) => `'${String(x)}'`;
  return [
    `# Written by the operator console (ui/app/lib/swapform.js) at ${stamp}. Sourced last by env.sh. Nothing here is secret.`,
    `# Run ${v.run}. The role below is only the console's default view; the helpers do not read it.`,
    `UI_ROLE=${q(v.role)}`,
    ...(v.wallet ? [`USE_SWAP_WALLET=${q(1)}`] : []),
    ...(v.handover === "board" ? [`HANDOVER=${q("board")}`] : []),
    `PROFILE=${q(v.profile)}`,
    `CHAIN=${q(v.chain)}`,
    `CONTRACT=${q(v.contract)}`,
    `LOCK_KIND=${q(v.lock_kind)}`,
    `VARIANT=${q(v.variant || "raw")}`,
    `CONTRACT_VERSION=${q(v.contract_version || "1")}`,
    `AMOUNT=${q(v.amount_micro)}`,
    `WEI=${q(v.wei)}`,
    // in a wallet run the tool makes the swap's own addresses (they are written to wallet-addresses.txt by wallet-setup.sh, never here)
    ...(v.alice_noid ? [`ALICE_NOID=${q(v.alice_noid)}`] : []),
    `BOB_NOID=${q(v.bob_noid)}`,
    ...(v.alice_eth ? [`ALICE_ETH=${q(v.alice_eth)}`] : []),
    ...(v.bob_eth ? [`BOB_ETH=${q(v.bob_eth)}`] : []),
    `SINGLE_NODE_OK=${q(v.single_node_ok ? 1 : 0)}`,
    // the optional lines, in a fixed order, only the ones given
    ...Object.entries(OPTIONAL)
      .filter(([k]) => v.optional && v.optional[k] !== undefined)
      .map(([k, name]) => `${name}=${q(v.optional[k])}`),
    "",
  ].join("\n");
}

const stampName = (ms) => new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");

/**
 * Writes <dir>/env.local.sh. The directory must already exist (install.sh creates it).
 * @returns {{path:string, backup:string|null, bytes:number}}
 */
function writeEnvLocal(dir, values, { replace = false, now = Date.now } = {}) {
  let st = null;
  try {
    st = fs.statSync(dir);
  } catch {
    /* handled below */
  }
  if (!st || !st.isDirectory()) throw Object.assign(new Error("the run folder does not exist yet: run the install step first"), { status: 409 });
  const target = path.join(dir, "env.local.sh");
  const exists = fs.existsSync(target);
  if (exists && !replace) throw Object.assign(new Error("env.local.sh already exists: tick \"replace the existing file\" to overwrite it (the old one is kept under a dated name)"), { status: 409 });
  let backup = null;
  if (exists) {
    // A hand-written line the template cannot carry (a second node, a fee cap, another RPC) would be lost: refuse instead.
    const names = new Set();
    for (const line of fs.readFileSync(target, "utf8").split(/\r?\n/)) {
      const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=/.exec(line);
      if (m) names.add(m[1]);
    }
    const extra = [...names].filter((n) => !TEMPLATE_KEYS.includes(n));
    if (extra.length) throw Object.assign(new Error(`the existing env.local.sh sets ${extra.slice(0, 8).join(", ")}, which this form cannot write: edit the file by hand instead of replacing it`), { status: 409 });
    // An optional setting the old file has and this submission leaves empty would vanish from the new file without a word: refuse and name it.
    const dropped = Object.entries(OPTIONAL).filter(([k, name]) => names.has(name) && !(values.optional && values.optional[k] !== undefined)).map(([, name]) => name);
    if (dropped.length) throw Object.assign(new Error(`the existing env.local.sh sets ${dropped.join(", ")}, and this form leaves it empty: fill it in (the file is replaced, not merged) or edit the file by hand`), { status: 409 });
    // The two terms the template always writes: an old file that states another value than this submission would have it changed without a word.
    const oldText = fs.readFileSync(target, "utf8");
    const changed = [["VARIANT", values.variant || "raw"], ["CONTRACT_VERSION", values.contract_version || "1"], ["USE_SWAP_WALLET", values.wallet ? "1" : "0"], ["HANDOVER", values.handover === "board" ? "board" : ""]].filter(([name, now_]) => {
      const m = new RegExp("^\\s*(?:export\\s+)?" + name + "=['\"]?([^'\"\\s#]*)", "m").exec(oldText);
      return m && m[1] !== String(now_);
    }).map(([name]) => name);
    if (changed.length) throw Object.assign(new Error(`the existing env.local.sh sets ${changed.join(", ")} to another value than this form would write: edit the file by hand instead of replacing it`), { status: 409 });
    backup = path.join(dir, `env.local.sh.old-${stampName(now())}`);
    fs.copyFileSync(target, backup, fs.constants.COPYFILE_EXCL);
  }
  const text = renderEnvLocal(values, new Date(now()).toISOString().replace(/\.\d{3}Z$/, "Z"));
  // written beside and renamed over, so the watch loop (which sources the file every tick) never reads a half-written one
  const tmp = path.join(dir, `env.local.sh.tmp-${process.pid}`);
  fs.writeFileSync(tmp, text, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(tmp, target);
  return { path: target, backup, bytes: Buffer.byteLength(text) };
}

function envLocalState(dir) {
  try {
    const st = fs.statSync(path.join(dir, "env.local.sh"));
    return { exists: true, mtime: Math.floor(st.mtimeMs / 1000), bytes: st.size };
  } catch {
    return { exists: false };
  }
}

module.exports = { OPTIONAL, TEMPLATE_KEYS, validateForm, renderEnvLocal, writeEnvLocal, envLocalState, PROFILES, ROLES, LOCK_KINDS, VARIANTS, CONTRACT_VERSIONS, FIELDS, decimalToInt };
