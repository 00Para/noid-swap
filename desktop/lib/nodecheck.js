"use strict";
/*
 * Node check (build spec 7.10, I4). Read-only calls only; no URL, host or error text goes into the status.
 *
 * Parano1d: `paranoid_blockCount` (the tip height) and `paranoid_getBlockHeader [height]` (the same two methods swap-cli's watcher
 * calls; the header carries `hash` and `timestamp`). `noid_rpc` must be loopback.
 * Ethereum: `eth_chainId` and `eth_getBlockByNumber ["latest", false]` on every configured endpoint of the profiles in use.
 *
 * `post(url, body, {timeoutMs}) -> Promise<object>` returns the parsed JSON-RPC answer (`{result}` or `{error}`) and throws on a
 * transport failure; an error with `kind === "refused"` means the connection was refused. `httpPost` below is the real one.
 */

const CHAIN_IDS = Object.freeze({ sepolia: 11155111, rehearsal: 31337 });
const NOID_BEHIND_S = 600;
const ETH_BEHIND_S = 120;
const REQUEST_TIMEOUT_MS = 8000;

/**
 * The pinned Parano1d chain checkpoint { height, hash }: the block at height 279,370 (the v2.1 activation height), as
 * `paranoid_getBlockHeader` returns it. Read read-only from a mainnet node long after the block was final, where the header
 * at 279,371 names it as its previous block. A second node's read is still to be done (at the first two-machine run).
 * With it a node on another chain reports `wrong_chain`; with a null checkpoint a reachable, synced node reports `ok` and
 * `chain_checked: false`.
 */
const CHECKPOINT = Object.freeze({ height: 279370, hash: "a7768d60f66e1d62cab08351a0ec38b7bf6df5554129e59574d566b727a7c654" });

/** The node's address must be written as one of this machine's own addresses; a name such as localhost is resolved through the hosts file and is not accepted. */
function isLoopback(url) {
  try {
    const h = new URL(url).hostname.toLowerCase();
    return h === "127.0.0.1" || h === "[::1]" || h === "::1";
  } catch {
    return false;
  }
}

function num(v) {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && /^\d+$/.test(v)) return Number(v);
  if (typeof v === "string" && /^0x[0-9a-fA-F]+$/.test(v)) return Number(BigInt(v));
  return null;
}

function unwrapSettings(x) {
  if (x && typeof x === "object" && x.settings && typeof x.settings === "object") return x.settings;
  return x && typeof x === "object" ? x : {};
}

async function rpc(post, url, method, params) {
  const answer = await post(url, { jsonrpc: "2.0", id: 1, method, params }, { timeoutMs: REQUEST_TIMEOUT_MS });
  if (!answer || typeof answer !== "object" || answer.error || !("result" in answer)) {
    const e = new Error("rpc answer");
    e.kind = "remote";
    throw e;
  }
  return answer.result;
}

async function checkNoid({ post, now, noidRpc, checkpoint }) {
  const out = { state: "error", tip: null, chain_checked: false, checked_at: null };
  if (typeof noidRpc !== "string" || !isLoopback(noidRpc)) return out;
  try {
    const tip = num(await rpc(post, noidRpc, "paranoid_blockCount", []));
    if (tip === null) return out;
    out.tip = tip;
    const header = await rpc(post, noidRpc, "paranoid_getBlockHeader", [tip]);
    const ts = header && typeof header === "object" ? num(header.timestamp) : null;
    if (ts === null) return out;
    if (checkpoint && Number.isSafeInteger(checkpoint.height) && typeof checkpoint.hash === "string") {
      if (tip < checkpoint.height) {
        out.state = "behind";
        return out;
      }
      const h = await rpc(post, noidRpc, "paranoid_getBlockHeader", [checkpoint.height]);
      const got = h && typeof h === "object" && typeof h.hash === "string" ? h.hash.toLowerCase().replace(/^0x/, "") : null;
      if (got === null) return out;
      if (got !== checkpoint.hash.toLowerCase().replace(/^0x/, "")) {
        out.state = "wrong_chain";
        return out;
      }
      out.chain_checked = true;
    }
    out.state = Math.floor(now() / 1000) - ts > NOID_BEHIND_S ? "behind" : "ok";
    return out;
  } catch (e) {
    out.state = e && e.kind === "refused" ? "not_running" : "error";
    return out;
  }
}

async function checkEthEndpoint({ post, now, url, chainId, checkAge }) {
  try {
    const id = num(await rpc(post, url, "eth_chainId", []));
    if (id === null) return { state: "error", chain_id: null };
    if (id !== chainId) return { state: "wrong_chain", chain_id: id };
    if (checkAge) {
      const block = await rpc(post, url, "eth_getBlockByNumber", ["latest", false]);
      const ts = block && typeof block === "object" ? num(block.timestamp) : null;
      if (ts === null) return { state: "error", chain_id: id };
      if (Math.floor(now() / 1000) - ts > ETH_BEHIND_S) return { state: "behind", chain_id: id };
    }
    return { state: "ok", chain_id: id };
  } catch (e) {
    return { state: e && (e.kind === "refused" || e.kind === "transport") ? "unreachable" : "error", chain_id: null };
  }
}

const ETH_RANK = ["ok", "behind", "wrong_chain", "error", "unreachable"];

async function checkEth({ post, now, settings, profiles }) {
  const eth = settings && typeof settings.eth === "object" && settings.eth ? settings.eth : {};
  const results = [];
  let endpoints = 0;
  for (const profile of profiles) {
    const chainId = CHAIN_IDS[profile];
    const p = eth[profile];
    if (!chainId || !p || typeof p !== "object") continue;
    for (const url of [p.rpc, p.rpc2]) {
      if (typeof url !== "string" || !url) continue;
      endpoints += 1;
      // A local rehearsal chain only makes a block when something is sent, so its block age says nothing.
      results.push(await checkEthEndpoint({ post, now, url, chainId, checkAge: profile !== "rehearsal" }));
    }
  }
  if (!results.length) return { state: "unreachable", chain_id: null, endpoints };
  let worst = "ok";
  for (const r of results) if (ETH_RANK.indexOf(r.state) > ETH_RANK.indexOf(worst)) worst = r.state;
  const withId = results.find((r) => r.chain_id !== null);
  return { state: worst, chain_id: withId ? withId.chain_id : null, endpoints };
}

/**
 * @param {object} o
 * @param {Function} o.post
 * @param {() => number} [o.now]            milliseconds
 * @param {() => object} o.settings         the program settings (or { settings })
 * @param {() => string[]} [o.profiles]     the profiles whose Ethereum endpoints to check (default: sepolia)
 * @param {number} [o.intervalMs]
 * @param {{height:number, hash:string}|null} [o.checkpoint]
 * @param {boolean} [o.autoStart]           default true; the self-test turns it off and calls checkOnce()
 */
function createNodeCheck({
  post,
  now = Date.now,
  settings,
  profiles = () => ["sepolia"],
  intervalMs = 15000,
  checkpoint = CHECKPOINT,
  autoStart = true,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
}) {
  let status = {
    noid: { state: "error", tip: null, chain_checked: false, ok_since_start: false, checked_at: null },
    eth: { state: "unreachable", chain_id: null, endpoints: 0, checked_at: null },
  };
  let okSinceStart = false;
  let timer = null;
  let running = null;

  async function runOnce() {
    let s;
    try {
      s = unwrapSettings(settings());
    } catch {
      s = {};
    }
    const t = now();
    const [noid, eth] = await Promise.all([
      checkNoid({ post, now, noidRpc: s.noid_rpc, checkpoint }),
      checkEth({ post, now, settings: s, profiles: profiles() }),
    ]);
    if (noid.state === "ok") okSinceStart = true;
    status = {
      noid: { state: noid.state, tip: noid.tip, chain_checked: noid.chain_checked, ok_since_start: okSinceStart, checked_at: t },
      eth: { state: eth.state, chain_id: eth.chain_id, endpoints: eth.endpoints, checked_at: t },
    };
    return status;
  }

  function checkOnce() {
    if (!running) running = runOnce().finally(() => { running = null; });
    return running;
  }

  if (autoStart) {
    checkOnce().catch(() => {});
    timer = setIntervalFn(() => checkOnce().catch(() => {}), intervalMs);
    if (timer && typeof timer.unref === "function") timer.unref();
  }

  return {
    status: () => JSON.parse(JSON.stringify(status)),
    checkOnce,
    stop() {
      if (timer) clearIntervalFn(timer);
      timer = null;
    },
  };
}

/** The real transport: one POST with fetch, a time limit, a size limit; the error kinds nodecheck reads. */
async function httpPost(url, body, { timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: ctl.signal, redirect: "error" });
    const text = await res.text();
    if (text.length > 1_000_000) throw Object.assign(new Error("answer too large"), { kind: "remote" });
    return JSON.parse(text);
  } catch (e) {
    const code = e && e.cause && e.cause.code;
    if (code === "ECONNREFUSED") throw Object.assign(new Error("refused"), { kind: "refused" });
    if (e && e.kind) throw e;
    throw Object.assign(new Error("transport"), { kind: "transport" });
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { createNodeCheck, httpPost, isLoopback, CHECKPOINT, CHAIN_IDS, NOID_BEHIND_S, ETH_BEHIND_S };
