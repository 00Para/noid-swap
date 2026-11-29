"use strict";
/*
 * The time-bounded sender for the swap's secret-carrying transaction (`live.js claim`).
 *
 * WHY. A signed claim carries the swap's 32-byte secret in its calldata; the secret is public the moment the bytes reach any node. Alice must not
 * publish after her reveal cutoff, because the counterparty's refund opens at T_reveal and a secret that becomes public too late can cost her both
 * coins. The send through the `ethers` library cannot be bounded in time (its timeout is an inactivity timer, DNS and connect have no limit, its abort
 * does not reach the socket, the body is queued before the connection exists, the send is batched with two reads, keep-alive sockets are reused).
 * So the claim's send is written by hand here, with the standard library only (node:http, node:net, node:tls, node:dns, node:zlib); every read stays on ethers.
 *
 * THE GUARANTEE (one paragraph). The sender connects first (DNS, TCP, and TLS for https) under its own limit and writes no byte of the request until that
 * connection is up; a stall or failure there is a proven "nothing was sent" (not_sent). Then ONE synchronous block runs: the caller's check (the last
 * statement before the write: `now + B_tail + G <= cutoff` and `now < timelock`, "now" being the later of the wall clock and the latest block's time plus
 * the monotonic time elapsed since it was read), the building of one JSON-RPC request (`eth_sendRawTransaction`, never a batch) for the connection made for it
 * (no agent, no keep-alive, `Connection: close`, no retry, no redirect), the arming of a kill timer for B_tail later, and the call `req.end(body)`. Node hands
 * the socket to the request and flushes on the NEXT TICK, so that is where the bytes really leave; the sender re-checks both clocks in the request's
 * `socket` event, which fires synchronously just before that flush, and if either has moved by more than the answer window minus one second since the check
 * it destroys the connection instead (nothing was written: not_sent, stage "late"). At the deadline the socket is reset (RST: the operating system drops
 * data it has not yet sent) and closed; the same happens on SIGINT, SIGTERM, SIGHUP and at process exit. So no byte of the claim leaves this machine after
 * (time of the check) + B_tail, and the endpoint's host can have received the bytes no later than cutoff - G + (timer lateness) + (network transit of a segment
 * written before the kill), both covered by the guard G. Every outcome is classified as not_sent, accepted, delivered_rejected or unknown; only not_sent may
 * ever be reported as "nothing was sent".
 *
 * WHAT IT DOES NOT GUARANTEE. What the endpoint (or a front end, a CDN, a load balancer) does with the bytes after it has them: it may queue the request,
 * forward it later, or keep the transaction to itself. To Alice that looks like a claim that was dropped (the secret is known to a third party and the
 * claim is not mined); the protocol budgets for it elsewhere (she sees no inclusion and re-sends through another endpoint before the late cutoff). It also
 * cannot catch SIGKILL or a power cut (after SIGKILL the operating system may finish retransmitting a segment already written), and a machine that is
 * suspended or stalled between the write and the kill breaks the bound (the monotonic clock may stop while the machine sleeps): the sender compares wall and
 * monotonic time at the end, and at the deadline kill itself, and says so (`clockJump`, `timeBoundBroken`). A node's error strings are matched, not
 * guaranteed (an unrecognised error is delivered_rejected, the safe reading). Two exceptions to "the kill resets the socket": after a COMPLETE ANSWER the socket
 * is closed normally, not reset (the request was one small write and it has been answered; the HTTP client has begun to end the socket and libuv refuses a
 * reset then), and a close started by the PEER under TLS ends as `rst: false` (there is nothing left to reset).
 *
 * INVARIANTS (for the reviewer; each can be checked against the code below).
 *  I1  The body is written at most once, to exactly one socket, and only after that socket's TCP connect (and TLS handshake) completed; the socket was
 *      created for this request (no agent).
 *  I2  Between the caller's synchronous check and the call `req.end(body)` there is no await, no callback boundary and no other I/O; the kill timer is armed
 *      in that same block, B_tail after the check. The flush itself happens one tick later and is guarded by the re-check in the `socket` event (see above):
 *      it either runs within the allowed clock movement or does not happen.
 *  I3  The check requires now + B_tail + G <= cutoff, with now = the later of the wall clock and the block-time estimate, and now < timelock.
 *  I4  After the kill no code writes to the socket; the kill resets the TCP handle (`rst: true`), or the reset was refused (libuv error, or the socket had
 *      begun to shut down) and the result says `rst: false` AND the handle is closed by hand; either way the close is awaited (I7).
 *  I5  not_sent is returned if and only if `writeStarted` is false (nothing was flushed); every other outcome says the secret may be public.
 *  I6  No retry, no redirect, no batch: one request object, one method, `Connection: close`; any status ends the attempt.
 *  I7  The returned promise resolves only after the TCP socket has emitted `close` (or the handle was closed by hand), so no byte can leave any more, or after
 *      the close wait with `closeConfirmed: false` (the caller then keeps its lock).
 *  I8  Every text that came from the endpoint passes the sanitizer and is cut to 200 characters; the URL (host, path, query, user info) is never put in
 *      any message.
 *  I9  A catchable signal during the send window resets the socket before the process exits; so does the process `exit` event.
 *  I10 The sender never uses a proxy: it connects directly (the caller refuses a run whose environment asks for an environment proxy).
 */
const net = require("node:net");
const tls = require("node:tls");
const http = require("node:http");
const dns = require("node:dns");
const zlib = require("node:zlib");
const { performance } = require("node:perf_hooks");

/** Milliseconds. connectMs is outside the bound (nothing is written during it) and addrMs is the share of it one address may take; tailMs + guardMs is the send budget S. */
const DEFAULT_TIMING = Object.freeze({ connectMs: 15000, addrMs: 4000, tailMs: 20000, guardMs: 10000, closeWaitMs: 5000, clockJumpMs: 2000 });
const MAX_ANSWER_BYTES = 64 * 1024;
const TEXT_CUT = 200;
const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"];

let timingOverride = null;
let testHooks = null;
/** Tests only: shorten the timing constants, for example { connectMs: 400, tailMs: 400, guardMs: 100 }. null restores the defaults. */
function setSendTimingForTests(o) {
  timingOverride = o ? { ...o } : null;
}
/** Tests only: default options (`lookup`, `connect`, `ca`, `onSocket`, `wallNow`, `monoNow`) merged into every connection and send. null clears them. */
function setSendHooksForTests(h) {
  testHooks = h ? { ...h } : null;
}
function sendTiming() {
  return { ...DEFAULT_TIMING, ...(timingOverride || {}) };
}
/** The send budget S in milliseconds: the answer window plus the guard. */
function sendBudgetMs() {
  const t = sendTiming();
  return t.tailMs + t.guardMs;
}

/** A failure that proves nothing was written (stage: url, dns, connect, tls, check, closed, sign). */
class BoundedSendError extends Error {
  constructor(stage, message, code) {
    super(message);
    this.name = "BoundedSendError";
    this.outcome = "not_sent";
    this.stage = stage;
    this.code = code || null;
  }
}

// ------------------------------------------------------------------------ the address
function parseEndpoint(urlText) {
  let u;
  try {
    u = new URL(String(urlText));
  } catch {
    throw new BoundedSendError("url", "the endpoint address is not a valid URL", "EBADURL");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new BoundedSendError("url", "the endpoint address is neither http:// nor https://", "EBADURL");
  const secure = u.protocol === "https:";
  const host = u.hostname.startsWith("[") ? u.hostname.slice(1, -1) : u.hostname;
  if (host === "") throw new BoundedSendError("url", "the endpoint address has no host", "EBADURL");
  const port = u.port ? Number(u.port) : secure ? 443 : 80;
  const hostHeader = (net.isIP(host) === 6 ? `[${host}]` : host) + (u.port ? `:${u.port}` : "");
  let authorization = null;
  if (u.username !== "" || u.password !== "") {
    if (!secure) throw new BoundedSendError("url", "the endpoint address carries a user name or password over plain http, which is refused", "EBADURL");
    let user;
    let pass;
    try {
      user = decodeURIComponent(u.username);
      pass = decodeURIComponent(u.password);
    } catch {
      throw new BoundedSendError("url", "the endpoint address has a malformed escape in its user name or password", "EBADURL");
    }
    authorization = "Basic " + Buffer.from(`${user}:${pass}`, "utf8").toString("base64");
  }
  return { secure, host, port, path: (u.pathname || "/") + (u.search || ""), hostHeader, authorization };
}

// ------------------------------------------------------------------------ the clock
/**
 * "now" in milliseconds for the check: the later of the wall clock and the latest block's time plus the monotonic time elapsed since it was read.
 * `blockTsS` (seconds) and `monoAtReadMs` may be null (no block read): then the wall clock alone.
 */
function estimateNowMs({ blockTsS = null, monoAtReadMs = null, wallNow = Date.now, monoNow = () => performance.now() } = {}) {
  const wall = wallNow();
  if (blockTsS === null || blockTsS === undefined || monoAtReadMs === null || monoAtReadMs === undefined) return wall;
  const viaBlock = Number(blockTsS) * 1000 + (monoNow() - monoAtReadMs);
  return viaBlock > wall ? viaBlock : wall;
}

/**
 * The synchronous verdict: may the write start now? ok only if now + S <= cutoff and now < timelock. cutoffS and timelockS are Unix seconds (numbers).
 * Returns { ok: true, nowMs } or { ok: false, why: "cutoff" | "timelock", nowMs, budgetMs }.
 */
function sendWindowVerdict({ cutoffS, timelockS, blockTsS = null, monoAtReadMs = null, wallNow, monoNow, budgetMs = sendBudgetMs() }) {
  const nowMs = estimateNowMs({ blockTsS, monoAtReadMs, wallNow, monoNow });
  if (!(nowMs < timelockS * 1000)) return { ok: false, why: "timelock", nowMs, budgetMs };
  if (!(nowMs + budgetMs <= cutoffS * 1000)) return { ok: false, why: "cutoff", nowMs, budgetMs };
  return { ok: true, nowMs, budgetMs };
}

// ------------------------------------------------------------------------ texts from the endpoint
/** What leaves a node's text before it is printed: URLs, long hex runs (a node may echo the raw transaction, which holds the secret), control characters. Cut to 200. */
function defaultSanitize(text) {
  let t = String(text);
  t = t.replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, "[address removed]");
  t = t.replace(/(?:0x)?[0-9a-fA-F]{64,}/g, "[long hex removed]");
  // eslint-disable-next-line no-control-regex
  t = t.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
  return t;
}
function cleanText(text, sanitize) {
  let t = String(text === undefined || text === null ? "" : text);
  try {
    t = sanitize ? sanitize(t) : t;
  } catch {
    t = "[text removed]";
  }
  t = defaultSanitize(t);
  return t.length > TEXT_CUT ? t.slice(0, TEXT_CUT) + "..." : t;
}

// Only what means "the node has THIS transaction". A broader text ("already exists in ...", "ALREADY_EXISTS") can name a DIFFERENT transaction with this nonce.
const ALREADY_KNOWN_RE = /already known|known transaction|alreadyknown|already imported|tx already in mempool/i;
const NONCE_USED_RE = /nonce too low|oldnonce|nonce has already been used|nonce is too low|nonce_too_low/i;

/**
 * Pure. Classify a complete answer. `answer` = { status, headers, bodyText, tooBig }. Returns
 * { outcome: "accepted" | "delivered_rejected" | "unknown", reason, alreadyKnown?, nonceTooLow?, alarm?, nodeText?, status, retryAfter? }.
 * Never returns not_sent (an answer exists, so the bytes were written).
 */
function classifySendAnswer(answer, expectedHash, id, sanitize) {
  const status = answer.status;
  const base = { status };
  if (status >= 300 && status <= 399) return { ...base, outcome: "unknown", reason: `HTTP ${status} (a redirect, never followed)`, redirect: true };
  if (status === 429) {
    const ra = answer.headers && answer.headers["retry-after"] ? cleanText(Array.isArray(answer.headers["retry-after"]) ? answer.headers["retry-after"][0] : answer.headers["retry-after"], null).slice(0, 40) : null;
    return { ...base, outcome: "unknown", reason: "HTTP 429 (throttled)", throttled: true, ...(ra ? { retryAfter: ra } : {}) };
  }
  if (status !== 200) return { ...base, outcome: "unknown", reason: `HTTP ${status}` };
  if (answer.tooBig) return { ...base, outcome: "unknown", reason: `the answer is larger than ${MAX_ANSWER_BYTES / 1024} KiB` };
  let j;
  try {
    j = JSON.parse(answer.bodyText);
  } catch {
    return { ...base, outcome: "unknown", reason: "HTTP 200 with an answer that is not JSON" };
  }
  if (j === null || typeof j !== "object" || Array.isArray(j)) return { ...base, outcome: "unknown", reason: "HTTP 200 with an answer that is not a single JSON-RPC object" };
  if (j.id !== id) return { ...base, outcome: "unknown", reason: "HTTP 200 with an answer whose id is not the request's" };
  if (j.error !== undefined && j.error !== null) {
    const msg = typeof j.error === "object" ? j.error.message : j.error;
    const code = typeof j.error === "object" && j.error.code !== undefined ? ` (node error code ${cleanText(j.error.code, null)})` : "";
    const text = cleanText(msg, sanitize);
    if (ALREADY_KNOWN_RE.test(String(msg))) return { ...base, outcome: "accepted", alreadyKnown: true, reason: "the node already had this transaction", nodeText: text };
    if (NONCE_USED_RE.test(String(msg))) return { ...base, outcome: "delivered_rejected", nonceTooLow: true, reason: `${text}${code}`, nodeText: text };
    return { ...base, outcome: "delivered_rejected", reason: `${text}${code}`, nodeText: text };
  }
  if (typeof j.result === "string") {
    if (j.result.toLowerCase() === String(expectedHash).toLowerCase()) return { ...base, outcome: "accepted", reason: "accepted" };
    return { ...base, outcome: "unknown", alarm: "the endpoint answered with a DIFFERENT transaction hash: do not trust this endpoint", reason: "HTTP 200 with a result that is not this transaction's hash" };
  }
  return { ...base, outcome: "unknown", reason: "HTTP 200 with neither a result nor an error" };
}

/**
 * A "nonce too low" answer is delivered_rejected unless THIS transaction was mined (a re-send of the same signed bytes: the signature is deterministic, so
 * the hash is the same). `getReceipt(hash)` is an ordinary read (it carries no secret). Returns the result, possibly upgraded to accepted with `mined: true`.
 */
async function settleNonceTooLow(result, getReceipt, hash) {
  if (!result || result.outcome !== "delivered_rejected" || result.nonceTooLow !== true) return result;
  let receipt = null;
  let unreadable = false;
  try {
    receipt = await getReceipt(hash);
  } catch {
    unreadable = true;
  }
  if (receipt) return { ...result, outcome: "accepted", mined: true, reason: "this transaction is already mined" };
  if (unreadable) return { ...result, alarm: "the receipt of this transaction could not be read, so it could not be confirmed whether it was mined or another transaction used this nonce" };
  return { ...result, alarm: "another transaction has used this nonce: this claim was not mined by this node" };
}

// ------------------------------------------------------------------------ the connection
/**
 * Phase A. Connect to the endpoint (DNS, TCP, TLS) within `connectMs`, writing nothing. Resolves to a connection object
 * { sendOnce(args), isOpen(), destroy(), timings, secure }; rejects with a BoundedSendError (outcome "not_sent": no byte of any request exists on
 * any socket during this phase). Options (tests inject): connectMs, lookup(host) -> Promise<[{address,family}]>, connect(options) -> socket,
 * ca (TLS), onSocket(tcp, stream), monoNow.
 */
async function openBoundedConnection(urlText, o = {}) {
  const hooks = { ...(testHooks || {}), ...o };
  const T = { ...sendTiming(), ...(o.connectMs !== undefined ? { connectMs: o.connectMs } : {}) };
  const ep = parseEndpoint(urlText);
  const monoNow = hooks.monoNow || (() => performance.now());
  const timings = {};
  const tStart = monoNow();
  const created = [];
  const destroyAll = () => {
    for (const x of created) hardClose(x);
  };
  const EXPIRED = Symbol("expired");
  let expired = false;
  let timer;
  const expiredP = new Promise((res) => {
    timer = setTimeout(() => {
      expired = true;
      res(EXPIRED);
    }, T.connectMs);
  });
  const within = async (p, stage, what) => {
    const v = await Promise.race([p, expiredP]);
    if (v === EXPIRED || expired) throw new BoundedSendError(stage, `${what} did not complete within ${(T.connectMs / 1000).toString()} s`, "ETIMEDOUT");
    return v;
  };
  let tcp = null;
  let stream = null;
  try {
    // DNS (an IP literal skips it). A lookup cannot be cancelled: after the deadline it is simply never used.
    let addrs;
    const ipv = net.isIP(ep.host);
    if (ipv) addrs = [{ address: ep.host, family: ipv }];
    else {
      const t = monoNow();
      const lp = Promise.resolve().then(() => (hooks.lookup || defaultLookup)(ep.host));
      lp.catch(() => {});
      try {
        addrs = await within(lp, "dns", "resolving the endpoint's name");
      } catch (e) {
        if (e instanceof BoundedSendError) throw e;
        throw new BoundedSendError("dns", `the endpoint's name could not be resolved (${(e && e.code) || "error"})`, e && e.code);
      }
      addrs = Array.isArray(addrs) ? addrs : addrs ? [addrs] : [];
      if (addrs.length === 0) throw new BoundedSendError("dns", "the endpoint's name has no address", "ENODATA");
      timings.lookupMs = monoNow() - t;
    }
    // TCP, one address at a time inside the overall limit, each address with its own share of it (min(what is left, addrMs)): a silently dropped address
    // (an IPv6 one, say) must not eat the whole limit and keep a working one from ever being tried. Nothing is written during any of this.
    const tTcp = monoNow();
    let lastErr = null;
    for (const addr of addrs) {
      const left = T.connectMs - (monoNow() - tStart);
      if (left <= 0 || expired) throw new BoundedSendError("connect", `the TCP connection did not complete within ${(T.connectMs / 1000).toString()} s`, "ETIMEDOUT");
      let attemptSock = null;
      const attempt = new Promise((resolve, reject) => {
        let sock;
        try {
          sock = (hooks.connect || ((opts) => net.connect(opts)))({ host: addr.address, port: ep.port, noDelay: true });
        } catch (e) {
          reject(e);
          return;
        }
        attemptSock = sock;
        created.push(sock);
        sock.on("error", () => {}); // an error is read through the promise or the state below; this keeps it from being thrown
        if (typeof hooks.onSocket === "function") {
          try {
            hooks.onSocket(sock, "tcp");
          } catch {
            /* a test hook */
          }
        }
        sock.once("connect", () => resolve(sock));
        sock.once("error", (e) => reject(e));
        sock.once("close", () => reject(Object.assign(new Error("closed"), { code: "ECLOSED" })));
      });
      attempt.catch(() => {});
      let addrTimer;
      const addrExpiredP = new Promise((res) => {
        addrTimer = setTimeout(() => res(EXPIRED), Math.min(left, T.addrMs));
      });
      try {
        const v = await Promise.race([attempt, expiredP, addrExpiredP]);
        clearTimeout(addrTimer);
        if (v === EXPIRED) throw Object.assign(new Error("timed out"), { code: "ETIMEDOUT" });
        tcp = v;
        break;
      } catch (e) {
        clearTimeout(addrTimer);
        lastErr = e;
        if (attemptSock) hardClose(attemptSock);
        // (when what was left was less than an address's share, the address's limit WAS the overall one)
        if (expired || (e && e.code === "ETIMEDOUT" && left <= T.addrMs)) throw new BoundedSendError("connect", `the TCP connection did not complete within ${(T.connectMs / 1000).toString()} s`, "ETIMEDOUT");
        // this address failed or used up its share: the next one gets what is left
      }
    }
    if (tcp === null) {
      if (lastErr && lastErr.code === "ETIMEDOUT") throw new BoundedSendError("connect", `the TCP connection did not complete within ${(T.connectMs / 1000).toString()} s (each address within ${(T.addrMs / 1000).toString()} s)`, "ETIMEDOUT");
      throw new BoundedSendError("connect", `the TCP connection failed (${(lastErr && lastErr.code) || "error"})`, lastErr && lastErr.code);
    }
    timings.tcpMs = monoNow() - tTcp;
    stream = tcp;
    if (ep.secure) {
      const tTls = monoNow();
      const tlsOpts = {
        socket: tcp,
        ALPNProtocols: ["http/1.1"],
        ...(ipv ? { host: ep.host } : { servername: ep.host }),
        ...(hooks.ca ? { ca: hooks.ca } : {}),
      };
      stream = (hooks.tlsConnect || tls.connect)(tlsOpts);
      created.push(stream);
      stream.on("error", () => {});
      if (typeof hooks.onSocket === "function") {
        try {
          hooks.onSocket(tcp, "tls", stream);
        } catch {
          /* a test hook */
        }
      }
      try {
        await within(
          new Promise((resolve, reject) => {
            stream.once("secureConnect", () => resolve());
            stream.once("error", (e) => reject(e));
            stream.once("close", () => reject(Object.assign(new Error("closed"), { code: "ECLOSED" })));
          }),
          "tls",
          "the TLS handshake"
        );
      } catch (e) {
        if (e instanceof BoundedSendError) throw e;
        throw new BoundedSendError("tls", `the TLS handshake failed (${(e && e.code) || "error"})`, e && e.code);
      }
      timings.tlsMs = monoNow() - tTls;
    }
  } catch (e) {
    clearTimeout(timer);
    destroyAll();
    throw e;
  }
  clearTimeout(timer);
  return makeConnection({ ep, tcp, stream, timings, hooks, T });
}

function defaultLookup(host) {
  return dns.promises.lookup(host, { all: true, verbatim: true });
}

/**
 * Close one socket (best effort, never throws). Returns { rst, handleClosed }.
 * With `reset` (the default) the TCP handle is reset first (RST: the operating system drops data it has not yet sent) and then the socket is destroyed.
 * `rst` is true only when libuv ACCEPTED the reset: the handle's `reset` is observed through a wrapper for the one call, because in Node 24 a reset that libuv
 * refuses (EINVAL, say) does not throw: the socket emits an 'error', drops its handle without closing it, and never emits 'close'. In that case `rst` is false
 * and the handle is closed by hand (`handleClosed` resolves when it has been), so the connection cannot live on until process exit (when a graceful FIN could
 * still deliver unsent data). A socket that already began its own shutdown is never reset: not the http client's (it ends the socket after a complete answer)
 * and not a TLS layer on top of the TCP socket (`alsoLayers`: under TLS the shutdown flag sits on the TLS socket, not on the TCP one); it is just destroyed.
 */
function hardClose(s, reset = true, alsoLayers = []) {
  const out = { rst: false, handleClosed: null };
  if (!s) return out;
  const ended = (x) => !!x && (x.writableEnded === true || x.writableFinished === true);
  try {
    const shuttingDown = ended(s) || alsoLayers.some(ended);
    if (reset && !shuttingDown && !s.destroyed && typeof s.resetAndDestroy === "function") {
      const h = s._handle;
      let rc = null;
      let orig = null;
      let own = false;
      if (h && typeof h.reset === "function") {
        orig = h.reset;
        own = Object.prototype.hasOwnProperty.call(h, "reset");
        h.reset = function (...a) {
          rc = orig.apply(this, a);
          return rc;
        };
      }
      try {
        s.resetAndDestroy();
        out.rst = rc === 0;
      } catch {
        out.rst = false;
      } finally {
        if (h && orig) {
          try {
            if (own) h.reset = orig;
            else delete h.reset;
          } catch {
            /* nothing to restore */
          }
        }
      }
      if (!out.rst && h && typeof h.close === "function") {
        out.handleClosed = new Promise((res) => {
          try {
            h.close(() => res());
          } catch {
            res(); // already closed
          }
        });
      }
    }
  } catch {
    out.rst = false;
  }
  try {
    s.destroy();
  } catch {
    /* already gone */
  }
  return out;
}

function makeConnection({ ep, tcp, stream, timings, hooks, T }) {
  const state = { closed: false, why: null, used: false };
  const markClosed = (why) => {
    if (!state.closed) {
      state.closed = true;
      state.why = why;
    }
  };
  stream.on("end", () => markClosed("the endpoint closed the connection"));
  stream.on("close", () => markClosed("the connection closed"));
  stream.on("error", (e) => markClosed(`the connection failed (${(e && e.code) || "error"})`));
  tcp.on("error", () => {});
  let tcpClosed = tcp.destroyed === true && state.closed;
  const tcpCloseP = new Promise((res) => {
    if (tcp.destroyed && tcp.closed) res();
    else tcp.once("close", () => {
      tcpClosed = true;
      res();
    });
  });
  const isOpen = () => !state.closed && !stream.destroyed && stream.writable === true && !tcp.destroyed;

  /**
   * Reset the TCP handle and destroy both layers. Idempotent: the FIRST call decides (killState.rst = whether libuv accepted the reset on the TCP handle),
   * because destroying a TLS layer can emit its `close` synchronously and re-enter this function. Returns killState.rst.
   */
  const killState = { done: false, rst: null, handleClosed: null };
  const kill = (reset = true) => {
    if (killState.done) return killState.rst;
    killState.done = true;
    killState.rst = false;
    const r = hardClose(tcp, reset, stream !== tcp ? [stream] : []);
    killState.rst = r.rst;
    killState.handleClosed = r.handleClosed;
    if (stream !== tcp) hardClose(stream, false);
    markClosed("closed by this tool");
    return killState.rst;
  };
  const waitClosed = async (ms) => {
    if (tcpClosed) return true;
    let t;
    const cut = new Promise((res) => {
      t = setTimeout(() => res("cut"), ms);
    });
    const closed = [tcpCloseP, ...(killState.handleClosed ? [killState.handleClosed] : [])];
    const v = await Promise.race([Promise.race(closed).then(() => "closed"), cut]);
    clearTimeout(t);
    return v === "closed";
  };

  function sendOnce(a) {
    if (state.used) throw new Error("bounded-send: a connection carries one request only");
    state.used = true;
    const timing = { ...T, ...(a.tailMs !== undefined ? { tailMs: a.tailMs } : {}), ...(a.closeWaitMs !== undefined ? { closeWaitMs: a.closeWaitMs } : {}) };
    const wallNow = a.wallNow || hooks.wallNow || Date.now;
    const monoNow = a.monoNow || hooks.monoNow || (() => performance.now());
    const proc = a.proc || hooks.proc || process;
    const exitFn = a.exit || hooks.exit || ((code) => process.exit(code));
    const sanitize = a.sanitize || null;
    if (typeof a.rawTx !== "string" || !/^0x[0-9a-fA-F]+$/.test(a.rawTx)) throw new Error("bounded-send: rawTx must be 0x hex");
    const id = a.id !== undefined ? a.id : Math.floor(Math.random() * Number.MAX_SAFE_INTEGER);
    const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id, method: "eth_sendRawTransaction", params: [a.rawTx] }), "utf8");
    const expectedHash = a.expectedHash;

    return new Promise((resolve) => {
      let settled = false;
      let killTimer = null;
      let writeStarted = false;
      let killedByDeadline = false;
      let timeBoundBroken = false;
      let tWriteMono = 0;
      let tWriteWall = 0;
      let tFirstByte = null;
      let status = null;
      let headers = null;
      let size = 0;
      let tooBig = false;
      const chunks = [];
      const sigHandlers = {};
      let exitHandler = null;
      let req = null;

      const removeGuards = () => {
        for (const s of Object.keys(sigHandlers)) proc.removeListener(s, sigHandlers[s]);
        if (exitHandler) proc.removeListener("exit", exitHandler);
      };
      const killNow = (reset = true) => kill(reset);
      // mode "reset": the send ended without a complete answer (deadline, signal, error): the TCP handle is reset. mode "close": the answer is complete, the
      // request has been delivered and answered; the socket is just closed (the http client has already begun to end it).
      const finish = async (core, mode = "reset") => {
        if (settled) return;
        settled = true;
        if (killTimer) clearTimeout(killTimer);
        removeGuards();
        // The wall and the monotonic clock must have advanced alike since the write; if not, the machine slept or the clock was stepped.
        let clockJump = false;
        if (writeStarted) {
          const mono = monoNow() - tWriteMono;
          const wall = wallNow() - tWriteWall;
          clockJump = Math.abs(wall - mono) > timing.clockJumpMs;
        }
        let out = { ...core };
        if (clockJump) {
          out.clockJump = true;
          timeBoundBroken = true;
          if (out.outcome !== "accepted" && out.outcome !== "delivered_rejected") {
            out = { ...out, outcome: "unknown", reason: "the machine was suspended or its clock was stepped during the send: the time bound was not kept" };
          }
        }
        killNow(mode === "reset");
        const closeConfirmed = await waitClosed(timing.closeWaitMs);
        resolve({
          ...out,
          writeStarted,
          rst: killState.rst === true,
          killedByDeadline,
          clockJump,
          timeBoundBroken,
          closeConfirmed,
          timings: { ...timings, ...(writeStarted ? { writeToFirstByteMs: tFirstByte === null ? null : tFirstByte - tWriteMono, writeToEndMs: monoNow() - tWriteMono } : {}) },
        });
      };

      // ---- the synchronous block: check, request object, kill timer, guards, req.end(body). No await, no callback boundary, no other I/O in between (I2).
      // Node attaches the socket to the request and flushes on the NEXT tick: the 'socket' listener below runs synchronously just before that flush.
      try {
        a.check();
      } catch (e) {
        finish({ outcome: "not_sent", stage: "check", error: e, reason: "the check before the write refused" });
        return;
      }
      if (!isOpen()) {
        finish({ outcome: "not_sent", stage: "closed", reason: state.why || "the connection was closed before the request was written" });
        return;
      }
      try {
        req = http.request({
          createConnection: () => stream,
          method: "POST",
          host: ep.host,
          port: ep.port,
          path: ep.path,
          headers: {
            Host: ep.hostHeader,
            "Content-Type": "application/json",
            "Content-Length": String(body.length),
            Accept: "application/json",
            "Accept-Encoding": "identity",
            Connection: "close",
            "User-Agent": "noid-swap",
            ...(ep.authorization ? { Authorization: ep.authorization } : {}),
          },
        });
      } catch (e) {
        finish({ outcome: "not_sent", stage: "check", error: e, reason: "the request could not be built" });
        return;
      }
      // The error listener goes on at once: a connection that is destroyed while the set-up below is still running (or by it) must never surface as an uncaught error.
      req.on("error", (e) => {
        if (settled) return;
        finish({ outcome: "unknown", reason: `the connection failed after the request was written (${(e && e.code) || "error"})` });
      });
      // Everything between here and `req.end(body)` is set-up that must not be able to leave a timer or a guard behind: if anything throws, the timer is
      // cleared, the guards are removed (finish does both), the connection is closed and the outcome is not_sent (writeStarted is still false, nothing flushed).
      try {
        tWriteMono = monoNow();
        tWriteWall = wallNow();
        killTimer = setTimeout(() => {
          killedByDeadline = true;
          // The deadline kill itself can fire late (the machine was suspended or stalled): then the bound was not kept, and the outcome says so.
          const elapsed = Math.max(monoNow() - tWriteMono, wallNow() - tWriteWall);
          const late = elapsed > timing.tailMs + timing.clockJumpMs;
          if (late) timeBoundBroken = true;
          // finish() resets the socket synchronously, before its first await.
          finish({
            outcome: "unknown",
            reason: late
              ? `the deadline kill fired ${((elapsed - timing.tailMs) / 1000).toFixed(1)} s late (the machine was suspended or stalled during the send): the time bound was not kept`
              : `no complete answer within ${(timing.tailMs / 1000).toString()} s; the connection was reset`,
          });
        }, timing.tailMs);
        for (const sg of SIGNALS) {
          sigHandlers[sg] = () => {
            // finish() resets the socket synchronously, before its first await: the exit below can follow at once.
            finish({ outcome: "unknown", reason: `interrupted by ${sg}; the connection was reset`, signal: sg });
            try {
              if (typeof a.onSignal === "function") a.onSignal(sg);
            } catch {
              /* the caller's notice must not stop the exit */
            }
            exitFn(130);
          };
          proc.on(sg, sigHandlers[sg]);
        }
        exitHandler = () => {
          try {
            kill();
          } catch {
            /* at exit nothing more can be done */
          }
        };
        proc.on("exit", exitHandler);
        // The guard of the flush: if either clock has moved by more than the answer window minus one second since the check, nothing is written.
        req.once("socket", () => {
          if (settled) return;
          const moved = Math.max(monoNow() - tWriteMono, wallNow() - tWriteWall);
          if (moved > Math.max(timing.tailMs - 1000, timing.tailMs / 2)) {
            writeStarted = false; // nothing was flushed: finish() destroys the connection before Node writes the request
            finish({ outcome: "not_sent", stage: "late", reason: `the clock moved ${(moved / 1000).toFixed(1)} s between the check and the flush, so the connection was destroyed before anything was written` });
          }
        });
      } catch (e) {
        finish({ outcome: "not_sent", stage: "check", error: e, reason: "the sender could not be set up" });
        return;
      }
      writeStarted = true;

      req.on("response", (res) => {
        status = res.statusCode;
        headers = res.headers;
        tFirstByte = monoNow();
        res.on("data", (c) => {
          if (settled) return;
          size += c.length;
          if (size > MAX_ANSWER_BYTES) {
            tooBig = true;
            finish({ ...classifySendAnswer({ status, headers, bodyText: "", tooBig: true }, expectedHash, id, sanitize) });
            return;
          }
          chunks.push(c);
        });
        res.on("error", (e) => {
          if (!settled) finish({ outcome: "unknown", reason: `the answer could not be read (${(e && e.code) || "error"})` });
        });
        res.on("end", () => {
          if (settled) return;
          let buf = Buffer.concat(chunks);
          const enc = String(headers["content-encoding"] || "identity").toLowerCase();
          if (enc === "gzip") {
            try {
              buf = zlib.gunzipSync(buf, { maxOutputLength: MAX_ANSWER_BYTES });
            } catch {
              finish({ outcome: "unknown", status, reason: `HTTP ${status} with an answer that could not be decoded` }, "close");
              return;
            }
          } else if (enc !== "identity" && enc !== "") {
            finish({ outcome: "unknown", status, reason: `HTTP ${status} with an unsupported content-encoding` }, "close");
            return;
          }
          finish(classifySendAnswer({ status, headers, bodyText: buf.toString("utf8"), tooBig }, expectedHash, id, sanitize), "close");
        });
      });
      stream.once("close", () => {
        if (!settled) finish({ outcome: "unknown", reason: state.why && state.why !== "closed by this tool" ? `${state.why} before an answer arrived` : "the connection closed before an answer arrived" });
      });
      try {
        req.end(body); // the flush happens on the next tick, after the 'socket' guard above
      } catch (e) {
        finish({ outcome: "unknown", reason: `the request could not be written (${(e && e.code) || "error"})` });
      }
    });
  }

  return {
    secure: ep.secure,
    timings,
    isOpen,
    sendOnce,
    /** Close a connection that will not be used (nothing was written on it). */
    destroy: () => {
      kill();
    },
  };
}

module.exports = {
  openBoundedConnection,
  classifySendAnswer,
  settleNonceTooLow,
  sendWindowVerdict,
  estimateNowMs,
  parseEndpoint,
  defaultSanitize,
  cleanText,
  sendTiming,
  sendBudgetMs,
  setSendTimingForTests,
  setSendHooksForTests,
  BoundedSendError,
  DEFAULT_TIMING,
  MAX_ANSWER_BYTES,
};
