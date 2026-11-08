'use strict';
/*
 * Minimal Esplora-style REST client for Bitcoin SIGNET, with a fallback host.
 * No local node: everything goes through a public block explorer API.
 *
 *   primary   https://mempool.space/signet/api
 *   fallback  https://blockstream.info/signet/api
 *
 * Endpoints used (both hosts speak the same Esplora dialect for all of them):
 *   GET  /blocks/tip/height            -> "329433"                       (text)
 *   GET  /address/:addr/utxo           -> [{txid, vout, value, status:{confirmed, block_height, ...}}]
 *   GET  /tx/:txid                     -> {txid, vin:[...], vout:[{value, scriptpubkey, scriptpubkey_address, ...}], status, fee, weight}
 *   GET  /tx/:txid/hex                 -> raw transaction hex              (text)
 *   GET  /tx/:txid/status              -> {confirmed, block_height, block_hash, block_time}
 *   GET  /tx/:txid/outspend/:vout      -> {spent:false} | {spent:true, txid, vin, status:{...}}
 *   GET  /block-height/0               -> genesis block hash (text); the chain identity check (verifyChain)
 *   GET  /fee-estimates               -> {"1": 1, "2": 1, "3": 0.5, ...}  sat/vB per confirmation target
 *   POST /tx  (body = raw hex)         -> txid                             (text); 400 + message on rejection
 *
 * CHAIN GUARD: every base URL must contain "/signet/". A mainnet base
 * (https://mempool.space/api, https://blockstream.info/api) or any other
 * network is refused at construction time. This tool is for signet only until
 * milestone M4 (external review) is done; real BTC must never touch it.
 *
 * Fallback policy: a request is retried on the fallback host only for
 * transport errors and 5xx responses. A 4xx (not found, rejected tx) is a real
 * answer and is NOT retried, so a transaction is never broadcast twice.
 */

const DEFAULT_PRIMARY = 'https://mempool.space/signet/api';
const DEFAULT_FALLBACK = 'https://blockstream.info/signet/api';

/** Fee policy for signet: floor 1 sat/vB, cap 50 sat/vB (public explorers sometimes return nonsense). */
const FEE_RATE_FLOOR = 1;
const FEE_RATE_CAP = 50;
const DEFAULT_FEE_TARGET = 2; // confirmation target in blocks

/** Genesis block hash of the default public signet (same on mempool.space and blockstream.info; read from both on 2026-11-05). */
const SIGNET_GENESIS = '00000008819873e925422c1ff0f99f7cc9bbb232af63a077a480a3633bee1ef6';

class ApiError extends Error {
  constructor(message, { status, url, body } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.url = url;
    this.body = body;
  }
}

function assertSignetBase(base, what = 'API base URL') {
  if (typeof base !== 'string' || !/^https?:\/\//.test(base)) throw new Error(`${what} must be an http(s) URL (got ${base})`);
  if (!/\/signet\//.test(base + '/')) {
    throw new Error(
      `${what} "${base}" is not a signet endpoint (its path must contain "/signet/"). ` +
        'This tool is signet-only: a mainnet explorer (e.g. https://mempool.space/api) would let real BTC be spent, ' +
        'which is forbidden before milestone M4 (external review).'
    );
  }
  return base.replace(/\/+$/, '');
}

function isTxid(s) {
  return typeof s === 'string' && /^[0-9a-f]{64}$/i.test(s);
}

/**
 * @param {{base?: string, fallback?: string|null, fetch?: Function, timeoutMs?: number}} opts
 *   fetch: injectable for tests (same signature as global fetch).
 */
function createClient(opts = {}) {
  const base = assertSignetBase(opts.base || process.env.BTC_API_URL || DEFAULT_PRIMARY);
  const fallbackRaw = opts.fallback === undefined ? process.env.BTC_API_FALLBACK_URL || DEFAULT_FALLBACK : opts.fallback;
  const fallback = fallbackRaw ? assertSignetBase(fallbackRaw, 'fallback API base URL') : null;
  const doFetch = opts.fetch || globalThis.fetch;
  if (typeof doFetch !== 'function') throw new Error('no fetch available (Node >= 18 required)');
  const timeoutMs = opts.timeoutMs || 20000;
  const hosts = fallback && fallback !== base ? [base, fallback] : [base];

  async function once(host, path, init) {
    const url = host + path;
    const ctl = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = ctl ? setTimeout(() => ctl.abort(), timeoutMs) : null;
    try {
      const res = await doFetch(url, { ...init, signal: ctl ? ctl.signal : undefined });
      const text = await res.text();
      if (!res.ok) throw new ApiError(`${init && init.method ? init.method : 'GET'} ${url} -> HTTP ${res.status}: ${text.slice(0, 300)}`, { status: res.status, url, body: text });
      client.lastHost = host; // which host actually answered (fallback may differ from base)
      return text;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** GET/POST with fallback on transport errors and 5xx only. */
  async function request(path, init) {
    let lastErr;
    for (const host of hosts) {
      try {
        return await once(host, path, init);
      } catch (e) {
        lastErr = e;
        const retryable = !(e instanceof ApiError) || e.status >= 500;
        if (!retryable) throw e;
      }
    }
    throw lastErr;
  }

  const getText = (path) => request(path, { method: 'GET' });
  const getJson = async (path) => {
    const t = await getText(path);
    try {
      return JSON.parse(t);
    } catch {
      throw new ApiError(`${path}: response is not JSON: ${t.slice(0, 200)}`, { url: path, body: t });
    }
  };

  function checkTxid(txid) {
    if (!isTxid(txid)) throw new Error(`not a txid (64 hex chars): ${txid}`);
    return txid.toLowerCase();
  }

  const client = {
    base,
    fallback,
    hosts: hosts.slice(),
    lastHost: null,
    chainVerified: null,

    async tipHeight() {
      const t = (await getText('/blocks/tip/height')).trim();
      if (!/^\d+$/.test(t)) throw new ApiError(`tip height is not a number: ${t.slice(0, 50)}`);
      return Number(t);
    },

    /** [{txid, vout, value, status:{confirmed, block_height?}}] */
    async addressUtxos(address) {
      if (typeof address !== 'string' || !/^tb1[0-9a-z]+$/.test(address)) throw new Error(`addressUtxos: not a signet bech32 address: ${address}`);
      const list = await getJson(`/address/${address}/utxo`);
      if (!Array.isArray(list)) throw new ApiError('utxo list is not an array');
      return list.map((u) => ({
        txid: checkTxid(u.txid),
        vout: u.vout,
        value: Number(u.value),
        confirmed: !!(u.status && u.status.confirmed),
        blockHeight: u.status && u.status.confirmed ? u.status.block_height : null,
      }));
    },

    /** Decoded tx as the explorer reports it, or null if unknown. */
    async tx(txid) {
      try {
        return await getJson(`/tx/${checkTxid(txid)}`);
      } catch (e) {
        if (e instanceof ApiError && e.status === 404) return null;
        throw e;
      }
    },

    /** Raw hex, or null if unknown. */
    async txHex(txid) {
      try {
        const h = (await getText(`/tx/${checkTxid(txid)}/hex`)).trim();
        if (!/^([0-9a-f]{2})+$/i.test(h)) throw new ApiError(`tx hex is not hex: ${h.slice(0, 50)}`);
        return h;
      } catch (e) {
        if (e instanceof ApiError && e.status === 404) return null;
        throw e;
      }
    },

    /** {confirmed, blockHeight|null, blockHash|null, blockTime|null} or null if unknown. */
    async txStatus(txid) {
      try {
        const s = await getJson(`/tx/${checkTxid(txid)}/status`);
        return {
          confirmed: !!s.confirmed,
          blockHeight: s.confirmed ? s.block_height : null,
          blockHash: s.confirmed ? s.block_hash : null,
          blockTime: s.confirmed ? s.block_time : null,
        };
      } catch (e) {
        if (e instanceof ApiError && e.status === 404) return null;
        throw e;
      }
    },

    /** {spent:false} | {spent:true, txid, vin, confirmed, blockHeight|null}; null if the outpoint is unknown. */
    async outspend(txid, vout) {
      if (!Number.isInteger(vout) || vout < 0) throw new Error('outspend: vout must be a non-negative integer');
      try {
        const o = await getJson(`/tx/${checkTxid(txid)}/outspend/${vout}`);
        if (!o.spent) return { spent: false };
        return {
          spent: true,
          txid: checkTxid(o.txid),
          vin: o.vin,
          confirmed: !!(o.status && o.status.confirmed),
          blockHeight: o.status && o.status.confirmed ? o.status.block_height : null,
        };
      } catch (e) {
        if (e instanceof ApiError && e.status === 404) return null;
        throw e;
      }
    },

    /** Raw /fee-estimates map (target -> sat/vB). */
    async feeEstimates() {
      const m = await getJson('/fee-estimates');
      if (!m || typeof m !== 'object') throw new ApiError('fee-estimates is not an object');
      return m;
    },

    /**
     * Recommended fee rate (sat/vB, integer) for `target` blocks, clamped to
     * [FEE_RATE_FLOOR, FEE_RATE_CAP]. Missing/garbage estimates give the floor.
     */
    async feeRate(target = DEFAULT_FEE_TARGET) {
      const m = await this.feeEstimates();
      return clampFeeRate(pickEstimate(m, target));
    },

    /**
     * Chain identity check: every host must report `expected` (default: the public signet genesis) as block 0.
     * A "/signet/" in the URL is a naming convention, not proof; this reads the chain itself. A host that answers
     * with another genesis is a hard error (a mainnet or testnet explorer behind a signet-looking URL). A host that
     * cannot be verified (transport error, 4xx/5xx, not a block hash) is DROPPED from this client, so the fallback
     * logic can never route a request to an unverified host; no verified host left is an error.
     * Call once before any other request. Returns { genesis, verified: [host], dropped: [{host, reason}] }.
     */
    async verifyChain(expected = SIGNET_GENESIS) {
      const want = String(expected).toLowerCase();
      const verified = [];
      const dropped = [];
      for (const host of hosts.slice()) {
        let t;
        try {
          t = (await once(host, '/block-height/0', { method: 'GET' })).trim().toLowerCase();
        } catch (e) {
          dropped.push({ host, reason: e.message });
          continue;
        }
        if (!/^[0-9a-f]{64}$/.test(t)) {
          dropped.push({ host, reason: `block 0 is not a block hash: ${t.slice(0, 50)}` });
          continue;
        }
        if (t !== want) {
          throw new ApiError(
            `API host ${host} reports genesis ${t}, not the signet genesis ${want}: it is not Bitcoin signet. ` +
              'This tool is signet-only; refusing to use it.',
            { url: host }
          );
        }
        verified.push(host);
      }
      if (!verified.length) {
        throw new ApiError(`no API host could be verified as signet (${dropped.map((d) => `${d.host}: ${d.reason}`).join('; ')})`, {});
      }
      hosts.splice(0, hosts.length, ...verified);
      client.hosts = hosts.slice();
      client.chainVerified = { genesis: want, hosts: verified.slice() };
      return { genesis: want, verified, dropped };
    },

    /** POST raw hex. Returns the txid the explorer reports. Never retried on 4xx. */
    async broadcast(hex) {
      if (typeof hex !== 'string' || !/^([0-9a-f]{2})+$/i.test(hex)) throw new Error('broadcast: not a hex string');
      const t = (await request('/tx', { method: 'POST', body: hex, headers: { 'content-type': 'text/plain' } })).trim();
      if (!isTxid(t)) throw new ApiError(`broadcast: unexpected response: ${t.slice(0, 200)}`, { body: t });
      return t.toLowerCase();
    },
  };
  return client;
}

/** Pick the estimate for `target`, or the nearest lower target, or the lowest-numbered target available. */
function pickEstimate(map, target) {
  const keys = Object.keys(map)
    .map(Number)
    .filter((k) => Number.isFinite(k) && k > 0)
    .sort((a, b) => a - b);
  if (!keys.length) return FEE_RATE_FLOOR;
  let best = keys[0];
  for (const k of keys) if (k <= target) best = k;
  const v = Number(map[best]);
  return Number.isFinite(v) ? v : FEE_RATE_FLOOR;
}

/** Integer sat/vB in [floor, cap]; non-finite or non-positive -> floor. */
function clampFeeRate(rate) {
  if (!Number.isFinite(rate) || rate <= 0) return FEE_RATE_FLOOR;
  const r = Math.ceil(rate);
  return Math.min(FEE_RATE_CAP, Math.max(FEE_RATE_FLOOR, r));
}

module.exports = {
  createClient,
  assertSignetBase,
  clampFeeRate,
  pickEstimate,
  ApiError,
  DEFAULT_PRIMARY,
  DEFAULT_FALLBACK,
  FEE_RATE_FLOOR,
  FEE_RATE_CAP,
  DEFAULT_FEE_TARGET,
  SIGNET_GENESIS,
};
