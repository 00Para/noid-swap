"use strict";
/*
 * JSON-RPC client for the read-only console.
 *
 * Two hard rules live here and nowhere else:
 *  1. ALLOWLIST: a method that is not in the list below is refused before any
 *     network call. There is no override flag. The lists hold only methods
 *     that read chain state; nothing that funds, submits, creates or touches
 *     a wallet.
 *  2. CACHE: a successful answer is reused for CACHE_MS (10 s) so a page
 *     polling every 15 s and several swaps sharing one node never hammer it.
 *     Failures are cached for a shorter time so a recovering node is seen soon.
 */

const CACHE_MS = 10_000;
const ERROR_CACHE_MS = 3_000;
const TIMEOUT_MS = 10_000;

const ALLOWED = {
  noid: new Set([
    "paranoid_blockCount",
    "paranoid_getEpochAnchor",
    "paranoid_estimateFeeDetailed",
    "paranoid_getMempoolInfo",
    "paranoid_getObjectInstances",
    "paranoid_getObjectStatus",
    "paranoid_getTx",
  ]),
  eth: new Set(["eth_chainId", "eth_blockNumber", "eth_getBlockByNumber", "eth_getLogs", "eth_call"]),
};

class RpcError extends Error {
  constructor(kind, message, extra = {}) {
    super(message);
    this.kind = kind; // "refused" | "transport" | "remote" | "decode" | "fixture"
    Object.assign(this, extra);
  }
}

function assertAllowed(chain, method) {
  const set = ALLOWED[chain];
  if (!set) throw new RpcError("refused", `unknown chain kind "${chain}"`);
  if (typeof method !== "string" || !set.has(method)) {
    throw new RpcError("refused", `refused: "${method}" is not a read-only method this console may call on ${chain}`);
  }
}

/** `http://host:port` only: never print a path (an API key may live there). */
function redactUrl(url) {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}`;
  } catch {
    return "<invalid url>";
  }
}

/**
 * Live transport: POST one JSON-RPC 2.0 request with fetch.
 * `chain` is "noid" or "eth" and selects the allowlist.
 */
class HttpJsonRpc {
  constructor(url, chain, opts = {}) {
    this.url = url;
    this.chain = chain;
    this.fetchImpl = opts.fetch || globalThis.fetch;
    this.timeoutMs = opts.timeoutMs || TIMEOUT_MS;
    this.cacheMs = opts.cacheMs === undefined ? CACHE_MS : opts.cacheMs;
    this.errorCacheMs = opts.errorCacheMs === undefined ? ERROR_CACHE_MS : opts.errorCacheMs;
    this.clock = opts.clock || Date.now;
    this.cache = new Map(); // key -> { at, value?, error?, promise? }
    this.nextId = 1;
    this.stats = { requests: 0, cacheHits: 0, refused: 0 };
  }

  get label() {
    return redactUrl(this.url);
  }

  async call(method, params = []) {
    try {
      assertAllowed(this.chain, method);
    } catch (e) {
      this.stats.refused++;
      throw e;
    }
    const key = method + " " + JSON.stringify(params);
    const now = this.clock();
    const hit = this.cache.get(key);
    if (hit) {
      if (hit.promise) {
        this.stats.cacheHits++;
        return hit.promise;
      }
      const ttl = hit.error ? this.errorCacheMs : this.cacheMs;
      if (now - hit.at < ttl) {
        this.stats.cacheHits++;
        if (hit.error) throw hit.error;
        return hit.value;
      }
    }
    const promise = this.send(method, params).then(
      (value) => {
        this.cache.set(key, { at: this.clock(), value });
        return value;
      },
      (error) => {
        this.cache.set(key, { at: this.clock(), error });
        throw error;
      }
    );
    this.cache.set(key, { at: now, promise });
    return promise;
  }

  async send(method, params) {
    this.stats.requests++;
    const id = this.nextId++;
    const body = JSON.stringify({ jsonrpc: "2.0", id, method, params });
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.timeoutMs);
    let res;
    try {
      res = await this.fetchImpl(this.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
        signal: ac.signal,
      });
    } catch (e) {
      const why = e && e.name === "AbortError" ? `timeout after ${this.timeoutMs} ms` : (e && e.message) || String(e);
      throw new RpcError("transport", `${this.label}: ${method}: ${why}`);
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) throw new RpcError("transport", `${this.label}: ${method}: HTTP ${res.status}`);
    let json;
    try {
      json = await res.json();
    } catch (e) {
      throw new RpcError("decode", `${this.label}: ${method}: reply is not JSON`);
    }
    if (json && json.error) {
      const err = json.error;
      throw new RpcError("remote", `${this.label}: ${method}: ${err.code} ${err.message}`, { code: err.code, data: err.data });
    }
    if (!json || !("result" in json)) throw new RpcError("decode", `${this.label}: ${method}: reply has no result`);
    return json.result;
  }
}

/**
 * Replays a fixture `{ "calls": [ { method, params?, result | error } ] }`
 * (the swap-cli recording format). An entry with `params` answers only a call
 * with deep-equal params; an entry without answers any call of that method.
 * The allowlist applies here too, so a test proves the code never asks for
 * a forbidden method even against a fixture that would answer it.
 */
class FixtureRpc {
  constructor(fixture, chain, opts = {}) {
    this.calls = Array.isArray(fixture) ? fixture : (fixture && fixture.calls) || [];
    this.description = (fixture && fixture.description) || "";
    this.chain = chain;
    this.transform = opts.transform || null; // (method, params, result) => result
    this.log = [];
    this.stats = { requests: 0, cacheHits: 0, refused: 0 };
  }

  get label() {
    return "fixture";
  }

  async call(method, params = []) {
    try {
      assertAllowed(this.chain, method);
    } catch (e) {
      this.stats.refused++;
      throw e;
    }
    this.stats.requests++;
    this.log.push({ method, params });
    const same = this.calls.filter((c) => c.method === method);
    const want = JSON.stringify(params);
    let entry = same.find((c) => c.params !== undefined && c.params !== null && JSON.stringify(c.params) === want);
    if (!entry) entry = same.find((c) => c.params === undefined || c.params === null);
    if (!entry) throw new RpcError("fixture", `fixture has no answer for ${method} ${want.slice(0, 120)}`);
    if (entry.error) {
      const err = entry.error;
      throw new RpcError("remote", `fixture: ${method}: ${err.code} ${err.message}`, { code: err.code, data: err.data });
    }
    let result = entry.result === undefined ? null : entry.result;
    if (this.transform) result = this.transform(method, params, result);
    return result;
  }
}

module.exports = { ALLOWED, CACHE_MS, RpcError, HttpJsonRpc, FixtureRpc, assertAllowed, redactUrl };
