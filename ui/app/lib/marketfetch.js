"use strict";
/**
 * The one network read of the market reference rate (display only): the project's own site snapshot, read on the server side, never by the page.
 *
 *   createMarketFetcher({ https?, now?, url? }) -> { get(), peek(), trigger() }
 *
 * The address is a constant (https only, a fixed host and path). One GET with no cookie and no header of ours (node's own defaults), no redirect followed, 10 seconds in all, 64 KB at most, a strict
 * parse and the checks of lib/marketref.js. The answer, good or bad, is kept in memory and no second request goes out within ten minutes (a failure is not retried sooner). It sends nothing about the
 * person or a swap: no query, no body. A failure is "unavailable", silent: no error reaches the page except that word.
 * Nothing is written to disk. The network is injected (`https`); nothing here opens a socket at load time.
 */
const marketref = require("./marketref");

const MARKET_URL = "https://no1dswap.github.io/data/market.json";
const TIMEOUT_MS = 10000;
const MIN_GAP_MS = 10 * 60 * 1000;

/** One GET of an https address; resolves with the body text or rejects. No redirect is followed (any status but 200 fails). */
function httpGet(https, url, maxBytes, timeoutMs) {
  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(url);
    } catch {
      reject(new Error("bad url"));
      return;
    }
    if (u.protocol !== "https:" || u.username !== "" || u.password !== "" || u.port !== "") {
      reject(new Error("bad url"));
      return;
    }
    let done = false;
    let req = null;
    let timer = null;
    const finish = (err, body) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (err && req) req.destroy();
      if (err) reject(err);
      else resolve(body);
    };
    timer = setTimeout(() => finish(new Error("timeout")), timeoutMs);
    if (typeof timer.unref === "function") timer.unref();
    try {
      req = https.get({ protocol: "https:", host: u.hostname, path: u.pathname, headers: {}, agent: false, timeout: timeoutMs }, (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          finish(new Error("status"));
          return;
        }
        const declared = Number(res.headers && res.headers["content-length"]);
        if (Number.isFinite(declared) && declared > maxBytes) {
          res.resume();
          finish(new Error("too large"));
          return;
        }
        const chunks = [];
        let total = 0;
        res.on("data", (c) => {
          total += c.length;
          if (total > maxBytes) finish(new Error("too large"));
          else chunks.push(c);
        });
        res.on("end", () => {
          try {
            finish(null, new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
          } catch {
            finish(new Error("not text"));
          }
        });
        res.on("error", (e) => finish(e));
      });
      req.on("timeout", () => finish(new Error("timeout")));
      req.on("error", (e) => finish(e));
    } catch (e) {
      finish(e);
    }
  });
}

function createMarketFetcher(o = {}) {
  const https = o.https || require("https");
  const now = o.now || Date.now;
  const url = typeof o.url === "string" ? o.url : MARKET_URL;
  let last = null; // { at, answer }
  let running = null;

  const unavailable = () => ({ state: "unavailable", ref: null });

  async function read() {
    let answer;
    try {
      const text = await httpGet(https, url, marketref.MAX_BYTES, TIMEOUT_MS);
      const p = marketref.parse(text, now());
      answer = p.ok ? { state: "ok", ref: p.ref } : unavailable();
    } catch {
      answer = unavailable();
    }
    last = { at: now(), answer };
    return answer;
  }

  /** The answer, reading first only when none was read in the last ten minutes (a failed read counts: it is not retried sooner). */
  async function get() {
    if (last && now() < last.at) last.at = now(); // a clock that went back must not turn into a read at every call
    if (last && now() - last.at < MIN_GAP_MS) return last.answer;
    if (!running) running = read().finally(() => (running = null));
    return running;
  }
  /** What is known now, with no read: "pending" before the first read. */
  function peek() {
    return last ? last.answer : { state: "pending", ref: null };
  }
  /** A read in the background when one is due (fire and forget). */
  function trigger() {
    get().catch(() => {});
  }
  return { get, peek, trigger };
}

module.exports = { createMarketFetcher, MARKET_URL, TIMEOUT_MS, MIN_GAP_MS, httpGet };
