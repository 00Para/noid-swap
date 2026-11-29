/*
 * Tests of eth/scripts/bounded-send.js on its own: local stub servers on 127.0.0.1 only, no Hardhat, no real network. The timing constants are shortened
 * through setSendTimingForTests. A logging TCP relay (the "tap") sits in front of a stub where the test needs to see which bytes crossed the wire, in
 * which direction, when, and how the client ended its side (FIN or RST). For TLS a throwaway certificate is made at test time with the `openssl`
 * command into the operating system's temporary folder (and removed afterwards); without `openssl` the TLS tests that need a certificate are pending.
 */
const { expect } = require("chai");
const net = require("node:net");
const http = require("node:http");
const https = require("node:https");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");
const { EventEmitter } = require("node:events");
const { execFileSync } = require("node:child_process");
const { performance } = require("node:perf_hooks");

const bs = require("../scripts/bounded-send.js");

const SHORT = { connectMs: 400, tailMs: 400, guardMs: 100, closeWaitMs: 1000 };
// A request too large for the kernel's buffers on both ends of a loopback connection whose reader has stopped: unsent data really exists at the deadline.
const BIG_RAW = "0x" + "ab".repeat(4 * 1024 * 1024); // 8 MB of hex, a 8 MB body
const live = require("../scripts/live.js");
const HASH = "0x" + "ab".repeat(32);
const RAW = "0x02" + "cd".repeat(100);
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

/** A logging TCP relay in front of `port`. rec.c2s / rec.s2c: chunks with time, size and first byte; rec.clientEnd: "FIN" | an error code (ECONNRESET = RST) | null. */
async function startTap(port, { forward = true } = {}) {
  const conns = [];
  const server = net.createServer((c) => {
    const rec = { id: conns.length, c2s: [], s2c: [], c2sBytes: 0, clientEnd: null, serverEnd: null, up: null, pauseClient: () => c.pause(), resumeClient: () => c.resume() };
    conns.push(rec);
    const up = net.connect(port, "127.0.0.1");
    rec.up = up;
    up.on("error", (e) => (rec.serverEnd = e.code));
    c.on("data", (d) => {
      rec.c2sBytes += d.length;
      rec.c2s.push({ t: performance.now(), n: d.length, first: d[0], text: d.toString("latin1"), buf: d });
      if (forward) up.write(d);
    });
    up.on("data", (d) => {
      rec.s2c.push({ t: performance.now(), n: d.length, first: d[0] });
      c.write(d);
    });
    c.on("end", () => {
      rec.clientEnd = rec.clientEnd || "FIN";
      up.end();
    });
    c.on("error", (e) => {
      rec.clientEnd = e.code || "error";
      up.destroy();
    });
    up.on("end", () => c.end());
    c.on("close", () => up.destroy());
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return {
    port: server.address().port,
    conns,
    close: () =>
      new Promise((r) => {
        server.close(() => r());
        for (const c of conns) if (c.up) c.up.destroy();
        server.closeAllConnections && server.closeAllConnections();
      }),
  };
}

/** A raw TCP stub that tracks its sockets so that it can be closed. */
async function startNet(onConn) {
  const socks = new Set();
  const server = net.createServer((c) => {
    socks.add(c);
    c.on("close", () => socks.delete(c));
    c.on("error", () => {});
    onConn(c);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return {
    port: server.address().port,
    close: () =>
      new Promise((r) => {
        server.close(() => r());
        for (const c of socks) c.destroy();
      }),
  };
}

/** The TLS records of what the client sent through a tap connection, in order: [{ type, t }] (t = arrival time of the chunk the record started in). */
function tlsRecords(rec) {
  const out = [];
  let carry = Buffer.alloc(0);
  let carryT = 0;
  for (const c of rec.c2s) {
    if (carry.length === 0) carryT = c.t;
    let buf = Buffer.concat([carry, c.buf]);
    let o = 0;
    while (buf.length - o >= 5) {
      const len = buf.readUInt16BE(o + 3);
      if (buf.length - o < 5 + len) break;
      out.push({ type: buf[o], t: carryT });
      o += 5 + len;
      carryT = c.t;
    }
    carry = buf.subarray(o);
    if (carry.length > 0 && o > 0) carryT = c.t;
  }
  return out;
}

/** An http stub. onReq(req, res, body, state) answers. state.requests / state.connections count what arrived. */
async function startHttp(onReq, { secure = null } = {}) {
  const state = { requests: [], connections: 0 };
  const handler = (req, res) => {
    const ch = [];
    req.on("data", (c) => ch.push(c));
    req.on("end", () => {
      const body = Buffer.concat(ch).toString("utf8");
      const rec = { method: req.method, url: req.url, headers: req.headers, body, at: performance.now() };
      state.requests.push(rec);
      onReq(req, res, body, rec, state);
    });
  };
  const server = secure ? https.createServer(secure, handler) : http.createServer(handler);
  server.on(secure ? "secureConnection" : "connection", () => (state.connections += 1));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  state.port = server.address().port;
  state.close = () =>
    new Promise((r) => {
      server.close(() => r());
      server.closeAllConnections();
    });
  return state;
}

const reply = (res, status, obj, headers = {}) => {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(typeof obj === "string" ? obj : JSON.stringify(obj));
};
const answerOk = (req, res, body) => {
  const b = JSON.parse(body);
  reply(res, 200, { jsonrpc: "2.0", id: b.id, result: HASH });
};
const answerError = (message) => (req, res, body) => {
  const b = JSON.parse(body);
  reply(res, 200, { jsonrpc: "2.0", id: b.id, error: { code: -32000, message } });
};

async function sendTo(url, extra = {}, openExtra = {}) {
  const conn = await bs.openBoundedConnection(url, openExtra);
  const res = await conn.sendOnce({ rawTx: RAW, expectedHash: HASH, check: () => {}, ...extra });
  return { conn, res };
}

describe("bounded-send.js", function () {
  this.timeout(30000);
  const toClose = [];
  const track = (s) => (toClose.push(s), s);

  beforeEach(() => {
    bs.setSendTimingForTests(SHORT);
  });
  afterEach(async () => {
    bs.setSendTimingForTests(null);
    bs.setSendHooksForTests(null);
    while (toClose.length) await toClose.pop().close();
  });

  describe("the address and the pure parts", () => {
    it("parseEndpoint: path and query kept, default ports, Basic auth only over https, nothing else accepted", () => {
      const a = bs.parseEndpoint("https://user:pa%20ss@rpc.example.org/v2/KEY?x=1");
      expect(a).to.include({ secure: true, host: "rpc.example.org", port: 443, path: "/v2/KEY?x=1", hostHeader: "rpc.example.org" });
      expect(a.authorization).to.equal("Basic " + Buffer.from("user:pa ss").toString("base64"));
      expect(bs.parseEndpoint("http://127.0.0.1:8545")).to.include({ secure: false, host: "127.0.0.1", port: 8545, path: "/", hostHeader: "127.0.0.1:8545" });
      expect(bs.parseEndpoint("http://[::1]:8545/x")).to.include({ host: "::1", hostHeader: "[::1]:8545" });
      for (const bad of ["ftp://x", "ws://x", "nonsense", "http://u:p@host/x", "http://", "https://us%E0%A4%A:pw@host/x", "https://user:p%zz@host/x"]) {
        let err = null;
        try {
          bs.parseEndpoint(bad);
        } catch (e) {
          err = e;
        }
        expect(err, bad).to.be.instanceOf(bs.BoundedSendError);
        expect(err.outcome).to.equal("not_sent");
        expect(err.message, "the address is never in the message").to.not.include("host");
      }
    });

    it("sendWindowVerdict: the write may start only if now + S <= cutoff and now < timelock; now is the later of the wall clock and the block clock", () => {
      const wall = (t) => () => t;
      const mono = (t) => () => t;
      const C = 10_000;
      const ok = bs.sendWindowVerdict({ cutoffS: C, timelockS: C + 1800, wallNow: wall(C * 1000 - 30_000), monoNow: mono(0), budgetMs: 30_000 });
      expect(ok.ok).to.equal(true);
      const late = bs.sendWindowVerdict({ cutoffS: C, timelockS: C + 1800, wallNow: wall(C * 1000 - 29_999), monoNow: mono(0), budgetMs: 30_000 });
      expect(late).to.include({ ok: false, why: "cutoff" });
      const gone = bs.sendWindowVerdict({ cutoffS: C, timelockS: C + 5, wallNow: wall((C + 5) * 1000), monoNow: mono(0), budgetMs: 1 });
      expect(gone).to.include({ ok: false, why: "timelock" });
      // the block clock wins when the wall clock is behind it: block time 10 s before the cutoff, read 5 s ago (monotonic) = 5 s before the cutoff
      const viaBlock = bs.sendWindowVerdict({ cutoffS: C, timelockS: C + 1800, blockTsS: C - 10, monoAtReadMs: 1000, wallNow: wall(0), monoNow: mono(6000), budgetMs: 6000 });
      expect(viaBlock.ok, "block time C-10 + 5 s elapsed = C-5; plus 6 s budget passes the cutoff").to.equal(false);
      expect(viaBlock.nowMs).to.equal((C - 5) * 1000);
      // nothing known about a block: the wall clock alone
      expect(bs.estimateNowMs({ wallNow: wall(123), monoNow: mono(5) })).to.equal(123);
    });

    it("classifySendAnswer: the table of the design", () => {
      const c = (status, obj, headers = {}) => bs.classifySendAnswer({ status, headers, bodyText: typeof obj === "string" ? obj : JSON.stringify(obj) }, HASH, 7);
      expect(c(200, { jsonrpc: "2.0", id: 7, result: HASH })).to.include({ outcome: "accepted" });
      expect(c(200, { jsonrpc: "2.0", id: 7, result: HASH.toUpperCase().replace("0X", "0x") })).to.include({ outcome: "accepted" });
      for (const m of ["already known", "Known transaction: 0xabc", "AlreadyKnown", "transaction already imported", "tx already in mempool"]) {
        expect(c(200, { id: 7, error: { code: -32000, message: m } }), m).to.include({ outcome: "accepted", alreadyKnown: true });
      }
      // a broader text can name a DIFFERENT transaction with this nonce: not "the node has this one"
      for (const m of ["ALREADY_EXISTS", "already exists in the pool with another hash", "nonce already exists in txpool"]) {
        expect(c(200, { id: 7, error: { code: -32000, message: m } }), m).to.include({ outcome: "delivered_rejected" });
      }
      for (const m of ["nonce too low", "OldNonce", "nonce has already been used"]) {
        expect(c(200, { id: 7, error: { code: -32000, message: m } }), m).to.include({ outcome: "delivered_rejected", nonceTooLow: true });
      }
      for (const m of ["replacement transaction underpriced", "insufficient funds for gas * price + value", "max fee per gas less than block base fee", "intrinsic gas too low", "something new"]) {
        const r = c(200, { id: 7, error: { code: -32000, message: m } });
        expect(r, m).to.include({ outcome: "delivered_rejected" });
        expect(r.nonceTooLow).to.equal(undefined);
      }
      expect(c(200, { id: 7, result: "0x" + "11".repeat(32) })).to.include({ outcome: "unknown" }).and.to.have.property("alarm");
      expect(c(200, { id: 8, result: HASH })).to.include({ outcome: "unknown" });
      expect(c(200, [{ id: 7, result: HASH }])).to.include({ outcome: "unknown" });
      expect(c(200, "garbage")).to.include({ outcome: "unknown" });
      expect(c(200, { id: 7 })).to.include({ outcome: "unknown" });
      expect(bs.classifySendAnswer({ status: 200, headers: {}, bodyText: "", tooBig: true }, HASH, 7)).to.include({ outcome: "unknown" });
      expect(c(307, "", { location: "http://x" })).to.include({ outcome: "unknown", redirect: true });
      expect(c(429, "", { "retry-after": "1" })).to.include({ outcome: "unknown", throttled: true, retryAfter: "1" });
      expect(c(503, "")).to.include({ outcome: "unknown", status: 503 });
      expect(c(404, "")).to.include({ outcome: "unknown" });
    });

    it("a node's text is sanitized and cut: URLs and long hex (an echoed raw transaction) never reach the reason", () => {
      const long = "0x" + "ef".repeat(300);
      const r = bs.classifySendAnswer(
        { status: 200, headers: {}, bodyText: JSON.stringify({ id: 7, error: { code: -32000, message: `bad tx ${long} from https://rpc.example.org/v2/KEY ${"x".repeat(500)}` } }) },
        HASH,
        7,
        (t) => t.replace(/SECRETWORD/g, "[secret redacted]")
      );
      expect(r.outcome).to.equal("delivered_rejected");
      expect(r.reason).to.not.include("efefef");
      expect(r.reason).to.not.include("rpc.example.org");
      expect(r.nodeText.length).to.be.at.most(203);
      expect(r.reason).to.include("[long hex removed]");
      const s = bs.classifySendAnswer({ status: 200, headers: {}, bodyText: JSON.stringify({ id: 7, error: { code: 1, message: "echo SECRETWORD here" } }) }, HASH, 7, (t) => t.replace(/SECRETWORD/g, "[secret redacted]"));
      expect(s.reason).to.include("[secret redacted]");
    });

    it("settleNonceTooLow: mined means accepted (a re-send of the same bytes), not mined means delivered_rejected with an alarm", async () => {
      const rejected = { outcome: "delivered_rejected", nonceTooLow: true, reason: "nonce too low" };
      const mined = await bs.settleNonceTooLow(rejected, async () => ({ status: 1 }), HASH);
      expect(mined).to.include({ outcome: "accepted", mined: true });
      const notMined = await bs.settleNonceTooLow(rejected, async () => null, HASH);
      expect(notMined).to.include({ outcome: "delivered_rejected" });
      expect(notMined.alarm).to.match(/another transaction has used this nonce/);
      const failed = await bs.settleNonceTooLow(rejected, async () => {
        throw new Error("read failed");
      }, HASH);
      expect(failed.outcome, "an unreadable receipt is not a proof: the safe reading").to.equal("delivered_rejected");
      expect(failed.alarm, "and it does not claim that another transaction used the nonce").to.match(/could not be read, so it could not be confirmed/);
      expect(failed.alarm).to.not.match(/another transaction has used this nonce/);
      expect(notMined.alarm, "a receipt that is absent says it").to.match(/another transaction has used this nonce/);
      const other = await bs.settleNonceTooLow({ outcome: "unknown" }, async () => ({}), HASH);
      expect(other.outcome).to.equal("unknown");
    });
  });

  describe("phase A: the connection (nothing is written during it)", () => {
    it("1. a lookup that never resolves: not_sent at connectMs (stage dns); the connect function is never called, not even when the lookup resolves late", async () => {
      let connects = 0;
      let resolveLate;
      const lookup = () => new Promise((res) => (resolveLate = res));
      const t0 = performance.now();
      let err = null;
      try {
        await bs.openBoundedConnection("http://slow.example.test:8545/", { lookup, connect: () => (connects += 1, new net.Socket()) });
      } catch (e) {
        err = e;
      }
      const dt = performance.now() - t0;
      expect(err).to.be.instanceOf(bs.BoundedSendError);
      expect(err).to.include({ outcome: "not_sent", stage: "dns" });
      expect(dt).to.be.within(SHORT.connectMs - 20, SHORT.connectMs + 1000);
      resolveLate([{ address: "127.0.0.1", family: 4 }]); // 200 ms after the deadline in the design; any time after it is the same
      await pause(200);
      expect(connects, "the late answer of the lookup is never used").to.equal(0);
    });

    it("1b. a lookup that fails: not_sent, stage dns, with its code and no host in the message", async () => {
      const lookup = () => Promise.reject(Object.assign(new Error("getaddrinfo ENOTFOUND secret-host.example"), { code: "ENOTFOUND" }));
      const err = await bs.openBoundedConnection("http://secret-host.example/KEY", { lookup }).then(() => null, (e) => e);
      expect(err).to.include({ outcome: "not_sent", stage: "dns", code: "ENOTFOUND" });
      expect(err.message).to.not.include("secret-host");
      expect(err.message).to.not.include("KEY");
    });

    it("2. a name that cannot exist (x.invalid): not_sent, stage dns", async () => {
      const err = await bs.openBoundedConnection("http://x.invalid:8545/").then(() => null, (e) => e);
      expect(err).to.be.instanceOf(bs.BoundedSendError);
      expect(err).to.include({ outcome: "not_sent", stage: "dns" });
    });

    it("3. a connect that never completes: not_sent at connectMs (stage connect); the socket is destroyed", async () => {
      const fake = new net.Socket(); // never connected: emits nothing
      const t0 = performance.now();
      const err = await bs.openBoundedConnection("http://127.0.0.1:9/", { connect: () => fake }).then(() => null, (e) => e);
      const dt = performance.now() - t0;
      expect(err).to.include({ outcome: "not_sent", stage: "connect" });
      expect(dt).to.be.within(SHORT.connectMs - 20, SHORT.connectMs + 1000);
      expect(fake.destroyed).to.equal(true);
    });

    it("3b. a refused connection: not_sent, stage connect", async () => {
      const closed = net.createServer();
      await new Promise((r) => closed.listen(0, "127.0.0.1", r));
      const port = closed.address().port;
      await new Promise((r) => closed.close(r));
      const err = await bs.openBoundedConnection(`http://127.0.0.1:${port}/`).then(() => null, (e) => e);
      expect(err).to.include({ outcome: "not_sent", stage: "connect" });
      expect(err.code).to.equal("ECONNREFUSED");
    });

    it("3c. the addresses of a name are tried in order inside one deadline: a dead one first, a live one second", async () => {
      const srv = track(await startHttp(answerOk));
      const closed = net.createServer();
      await new Promise((r) => closed.listen(0, "127.0.0.1", r));
      const deadPort = closed.address().port;
      await new Promise((r) => closed.close(r));
      const seen = [];
      const conn = await bs.openBoundedConnection(`http://multi.example.test:${srv.port}/`, {
        lookup: async () => [{ address: "127.0.0.1", family: 4 }, { address: "127.0.0.1", family: 4 }],
        connect: (o) => {
          seen.push(o.port);
          return net.connect({ ...o, port: seen.length === 1 ? deadPort : o.port });
        },
      });
      expect(seen.length).to.equal(2);
      const res = await conn.sendOnce({ rawTx: RAW, expectedHash: HASH, check: () => {} });
      expect(res.outcome).to.equal("accepted");
    });

    it("4. a server that accepts and never answers the TLS ClientHello: not_sent (stage tls); the wire carried a handshake record and never application data", async () => {
      const black = track(await startNet(() => {})); // accepts, reads nothing, says nothing
      const tap = track(await startTap(black.port));
      const t0 = performance.now();
      const err = await bs.openBoundedConnection(`https://127.0.0.1:${tap.port}/`).then(() => null, (e) => e);
      const dt = performance.now() - t0;
      expect(err).to.include({ outcome: "not_sent", stage: "tls" });
      expect(dt).to.be.within(SHORT.connectMs - 20, SHORT.connectMs + 1000);
      await pause(100);
      expect(tap.conns.length).to.equal(1);
      const types = tlsRecords(tap.conns[0]).map((r) => r.type);
      expect(types.length, "the ClientHello went out").to.be.greaterThan(0);
      expect(types.every((b) => b === 0x16), "only handshake records, never an application-data record (0x17)").to.equal(true);
      expect(tap.conns[0].clientEnd, "the stalled connection was torn down").to.not.equal(null);
    });

    it("18. the peer closes the idle connection before the write: not_sent (stage closed), no byte written", async () => {
      const srv = track(await startNet((c) => c.end()));
      const tap = track(await startTap(srv.port));
      const conn = await bs.openBoundedConnection(`http://127.0.0.1:${tap.port}/`);
      await pause(150);
      let checked = 0;
      const res = await conn.sendOnce({ rawTx: RAW, expectedHash: HASH, check: () => (checked += 1) });
      expect(res).to.include({ outcome: "not_sent", stage: "closed", writeStarted: false });
      expect(checked, "the synchronous check ran first").to.equal(1);
      expect(tap.conns[0].c2s.length, "no byte of the request").to.equal(0);
    });
  });

  describe("phase C: the write and the answer", () => {
    it("11. 200 with the right hash: accepted; Connection: close was sent, one request, one method; the socket is closed when the promise resolves", async () => {
      const srv = track(await startHttp(answerOk));
      const sockets = [];
      const { res } = await sendTo(`http://127.0.0.1:${srv.port}/v2/KEY?x=1`, {}, { onSocket: (s) => sockets.push(s) });
      expect(res).to.include({ outcome: "accepted", writeStarted: true, closeConfirmed: true });
      expect(srv.requests.length).to.equal(1);
      const r = srv.requests[0];
      expect(r.url).to.equal("/v2/KEY?x=1");
      expect(r.headers.connection).to.equal("close");
      expect(r.headers["accept-encoding"]).to.equal("identity");
      expect(r.headers["content-type"]).to.equal("application/json");
      expect(r.headers.host).to.equal(`127.0.0.1:${srv.port}`);
      const b = JSON.parse(r.body);
      expect(Array.isArray(b), "a single object, never a batch").to.equal(false);
      expect(b).to.have.keys(["jsonrpc", "id", "method", "params"]);
      expect(b.method).to.equal("eth_sendRawTransaction");
      expect(b.params).to.deep.equal([RAW]);
      expect(Number.isSafeInteger(b.id)).to.equal(true);
      expect(srv.connections).to.equal(1);
      expect(sockets[0].destroyed).to.equal(true);
      expect(res.timings).to.have.property("tcpMs");
    });

    it("Authorization comes from URL user info over https only (here: http with user info is refused before any connection)", async () => {
      const srv = track(await startHttp(answerOk));
      const err = await bs.openBoundedConnection(`http://u:p@127.0.0.1:${srv.port}/`).then(() => null, (e) => e);
      expect(err).to.include({ outcome: "not_sent", stage: "url" });
      expect(srv.connections).to.equal(0);
    });

    it("a socket whose close is never reported: the promise resolves after the close wait with closeConfirmed false (the caller then keeps its lock)", async () => {
      const srv = track(await startHttp(answerOk));
      const real = [];
      const t0 = performance.now();
      const { res } = await sendTo(
        `http://127.0.0.1:${srv.port}/`,
        { closeWaitMs: 250 },
        {
          onSocket: (s) => {
            real.push(s.destroy.bind(s));
            s.destroy = () => s; // the operating system never reports the close
            s.resetAndDestroy = () => s;
          },
        }
      );
      expect(res).to.include({ outcome: "accepted", closeConfirmed: false });
      expect(performance.now() - t0).to.be.within(250, 1500);
      for (const d of real) d();
    });

    it("a connection carries one request: a second sendOnce is a programming error and writes nothing", async () => {
      const srv = track(await startHttp(answerOk));
      const { conn } = await sendTo(`http://127.0.0.1:${srv.port}/`);
      expect(() => conn.sendOnce({ rawTx: RAW, expectedHash: HASH, check: () => {} })).to.throw(/one request only/);
      expect(srv.requests.length).to.equal(1);
    });

    it("5. a server that accepts and never reads, and a request too large for the buffers: unsent data really exists at the deadline; unknown, the socket reset, the relay received less than the whole body and nothing more after the kill", async () => {
      const mute = track(await startNet((c) => c.pause()));
      const tap = track(await startTap(mute.port, { forward: false }));
      const socks = [];
      const conn = await bs.openBoundedConnection(`http://127.0.0.1:${tap.port}/`, { onSocket: (s) => socks.push(s) });
      await pause(50);
      tap.conns[0].pauseClient(); // the reader stops: the kernel buffers fill and the rest of the request stays unsent
      const t0 = performance.now();
      const res = await conn.sendOnce({ rawTx: BIG_RAW, expectedHash: HASH, check: () => {}, tailMs: 600 });
      const dt = performance.now() - t0;
      expect(res).to.include({ outcome: "unknown", writeStarted: true, rst: true, killedByDeadline: true, closeConfirmed: true });
      expect(dt).to.be.within(600 - 20, 600 + 1000);
      const bodyLen = Buffer.byteLength(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_sendRawTransaction", params: [BIG_RAW] }));
      expect(socks[0].destroyed).to.equal(true);
      const written = socks[0].bytesWritten;
      tap.conns[0].resumeClient(); // let the relay read whatever the kernel really delivered
      await pause(400);
      const received = tap.conns[0].c2sBytes;
      expect(socks[0].bytesWritten, "after the kill nothing more is written").to.equal(written);
      expect(tap.conns[0].clientEnd, "the relay saw a reset, not a graceful end").to.equal("ECONNRESET");
      expect(received, `the relay received less than the whole body (${received} of ${bodyLen}): the unsent rest was dropped by the reset`).to.be.below(bodyLen);
      await pause(300);
      expect(tap.conns[0].c2sBytes, "and not one byte more later").to.equal(received);
    });

    // (Here the whole request IS delivered before the deadline, so only the reset and the single body are asserted; case 5 and 21c prove that unsent data is dropped.)
    it("6. a server that reads the whole request and never answers: unknown, reset seen, the body arrived once", async () => {
      const srv = track(await startHttp(() => {})); // never answers
      const tap = track(await startTap(srv.port));
      const t0 = performance.now();
      const { res } = await sendTo(`http://127.0.0.1:${tap.port}/`);
      expect(res).to.include({ outcome: "unknown", writeStarted: true, rst: true, killedByDeadline: true });
      expect(res.reason).to.match(/no complete answer within/);
      await pause(150);
      expect(srv.requests.length, "the body arrived once").to.equal(1);
      expect(tap.conns.length).to.equal(1);
      expect(tap.conns[0].clientEnd).to.equal("ECONNRESET");
      const bodies = tap.conns[0].c2s.filter((c) => c.text.includes("eth_sendRawTransaction"));
      expect(bodies.length).to.equal(1);
      expect(tap.conns[0].c2s.every((c) => c.t - t0 < SHORT.tailMs + 100)).to.equal(true);
    });

    it("7. an answer after the deadline: unknown; the late answer changes nothing and nothing more is written", async () => {
      const srv = track(
        await startHttp((req, res, body) => {
          const b = JSON.parse(body);
          setTimeout(() => {
            try {
              reply(res, 200, { jsonrpc: "2.0", id: b.id, result: HASH });
            } catch {
              /* the connection was reset */
            }
          }, SHORT.tailMs + 300);
        })
      );
      const { res } = await sendTo(`http://127.0.0.1:${srv.port}/`);
      expect(res).to.include({ outcome: "unknown", killedByDeadline: true });
      const snapshot = JSON.stringify(res);
      await pause(600);
      expect(JSON.stringify(res)).to.equal(snapshot);
      expect(srv.requests.length).to.equal(1);
    });

    it("8. a redirect (307) is never followed: unknown; one connection and one request to the first stub, none to the second", async () => {
      const other = track(await startHttp(answerOk));
      const srv = track(await startHttp((req, res) => reply(res, 307, "", { location: `http://127.0.0.1:${other.port}/final?apikey=LOCATIONKEY` })));
      const { res } = await sendTo(`http://127.0.0.1:${srv.port}/`);
      expect(res).to.include({ outcome: "unknown", status: 307, redirect: true, writeStarted: true });
      await pause(150);
      expect(srv.connections).to.equal(1);
      expect(srv.requests.length).to.equal(1);
      expect(other.connections).to.equal(0);
      expect(JSON.stringify(res)).to.not.include("LOCATIONKEY");
    });

    it("9. HTTP 429 with Retry-After: unknown; exactly one request ever, no retry later", async () => {
      const srv = track(await startHttp((req, res) => reply(res, 429, "slow down", { "retry-after": "1" })));
      const { res } = await sendTo(`http://127.0.0.1:${srv.port}/`);
      expect(res).to.include({ outcome: "unknown", status: 429, throttled: true, retryAfter: "1" });
      await pause(1500); // well past the Retry-After
      expect(srv.requests.length).to.equal(1);
      expect(srv.connections).to.equal(1);
    });

    it("10. HTTP 503 (and 404): unknown, one request each", async () => {
      for (const status of [503, 404]) {
        const srv = track(await startHttp((req, res) => reply(res, status, "no")));
        const { res } = await sendTo(`http://127.0.0.1:${srv.port}/`);
        expect(res, String(status)).to.include({ outcome: "unknown", status });
        expect(srv.requests.length).to.equal(1);
      }
    });

    it("12. 'already known' answers are accepted (alreadyKnown)", async () => {
      for (const m of ["already known", "Known transaction: 0x1234", "ALREADY_EXISTS: tx already in mempool"]) {
        const srv = track(await startHttp(answerError(m)));
        const { res } = await sendTo(`http://127.0.0.1:${srv.port}/`);
        expect(res, m).to.include({ outcome: "accepted", alreadyKnown: true });
      }
    });

    it("13. 'nonce too low' is delivered_rejected until the receipt shows this transaction mined", async () => {
      const srv = track(await startHttp(answerError("nonce too low: next nonce 5, tx nonce 4")));
      const { res } = await sendTo(`http://127.0.0.1:${srv.port}/`);
      expect(res).to.include({ outcome: "delivered_rejected", nonceTooLow: true });
      expect((await bs.settleNonceTooLow(res, async () => ({}), HASH)).outcome).to.equal("accepted");
      const unmined = await bs.settleNonceTooLow(res, async () => null, HASH);
      expect(unmined.outcome).to.equal("delivered_rejected");
      expect(unmined.alarm).to.be.a("string");
    });

    it("14. other JSON-RPC errors are delivered_rejected: the endpoint parsed the body, so it holds the secret; the reason is redacted and cut", async () => {
      for (const m of ["replacement transaction underpriced", "insufficient funds for gas * price + value"]) {
        const srv = track(await startHttp(answerError(`${m} ${"0x" + "ee".repeat(200)} https://rpc.example.org/KEY ${"z".repeat(400)}`)));
        const { res } = await sendTo(`http://127.0.0.1:${srv.port}/`);
        expect(res, m).to.include({ outcome: "delivered_rejected", writeStarted: true });
        expect(res.reason).to.not.include("eeee");
        expect(res.reason).to.not.include("rpc.example.org");
        expect(res.reason.length).to.be.below(260);
      }
    });

    it("15. another hash, an array, garbage, a 70 KiB body: unknown; a gzip body is decoded and classified", async () => {
      const cases = [
        ["another hash", (b) => ({ jsonrpc: "2.0", id: b.id, result: "0x" + "11".repeat(32) }), (r) => expect(r.alarm).to.match(/DIFFERENT transaction hash/)],
        ["an array", (b) => [{ jsonrpc: "2.0", id: b.id, result: HASH }], () => {}],
        ["garbage", () => "not json at all", () => {}],
        ["70 KiB", () => "x".repeat(70 * 1024), (r) => expect(r.reason).to.match(/larger than 64 KiB/)],
      ];
      for (const [name, make, extra] of cases) {
        const srv = track(await startHttp((req, res, body) => reply(res, 200, make(JSON.parse(body)))));
        const { res } = await sendTo(`http://127.0.0.1:${srv.port}/`);
        expect(res, name).to.include({ outcome: "unknown", writeStarted: true });
        extra(res);
      }
      const gz = track(
        await startHttp((req, res, body) => {
          const b = JSON.parse(body);
          res.writeHead(200, { "content-type": "application/json", "content-encoding": "gzip" });
          res.end(zlib.gzipSync(JSON.stringify({ jsonrpc: "2.0", id: b.id, result: HASH })));
        })
      );
      expect((await sendTo(`http://127.0.0.1:${gz.port}/`)).res.outcome).to.equal("accepted");
      const odd = track(
        await startHttp((req, res) => {
          res.writeHead(200, { "content-encoding": "br" });
          res.end("x");
        })
      );
      expect((await sendTo(`http://127.0.0.1:${odd.port}/`)).res.outcome).to.equal("unknown");
    });

    it("16. a server that offers keep-alive: the socket is closed anyway, and a second sender call opens a new connection", async () => {
      const srv = track(await startHttp((req, res, body) => {
        const b = JSON.parse(body);
        res.writeHead(200, { "content-type": "application/json", connection: "keep-alive", "keep-alive": "timeout=5" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: b.id, result: HASH }));
      }));
      const tap = track(await startTap(srv.port));
      const socks = [];
      const a = await sendTo(`http://127.0.0.1:${tap.port}/`, {}, { onSocket: (s) => socks.push(s) });
      expect(a.res.outcome).to.equal("accepted");
      expect(socks[0].destroyed).to.equal(true);
      const b = await sendTo(`http://127.0.0.1:${tap.port}/`, {}, { onSocket: (s) => socks.push(s) });
      expect(b.res.outcome).to.equal("accepted");
      expect(tap.conns.length, "two connection ids at the tap").to.equal(2);
      expect(tap.conns.every((c) => c.c2s.filter((x) => x.text.startsWith("POST")).length === 1), "one request per connection").to.equal(true);
    });

    it("17. a check that throws: not_sent (stage check), zero bytes at the tap, the connection torn down; the error is handed back unchanged", async () => {
      const srv = track(await startHttp(answerOk));
      const tap = track(await startTap(srv.port));
      const boom = new Error("past the cutoff");
      const conn = await bs.openBoundedConnection(`http://127.0.0.1:${tap.port}/`);
      const res = await conn.sendOnce({ rawTx: RAW, expectedHash: HASH, check: () => { throw boom; } });
      expect(res).to.include({ outcome: "not_sent", stage: "check", writeStarted: false, closeConfirmed: true });
      expect(res.error).to.equal(boom);
      await pause(150);
      expect(tap.conns[0].c2s.length, "not one byte").to.equal(0);
      expect(srv.requests.length).to.equal(0);
      expect(tap.conns[0].clientEnd, "closed").to.not.equal(null);
    });

    it("the flush is guarded: a clock that has moved between req.end and the socket event (one tick later) destroys the connection with nothing written: not_sent, stage late, zero bytes at the relay", async () => {
      const srv = track(await startHttp(answerOk));
      const tap = track(await startTap(srv.port));
      const conn = await bs.openBoundedConnection(`http://127.0.0.1:${tap.port}/`);
      let off = 0;
      const monoNow = () => performance.now() + off;
      let checked = 0;
      const p = conn.sendOnce({ rawTx: RAW, expectedHash: HASH, check: () => (checked += 1), monoNow });
      expect(checked, "the check ran inside the call").to.equal(1);
      off = 10000; // the machine stalls right after req.end: the flush is still one tick away
      const res = await p;
      expect(res).to.include({ outcome: "not_sent", stage: "late", writeStarted: false, closeConfirmed: true });
      expect(res.reason).to.match(/clock moved 10\.0 s between the check and the flush/);
      await pause(150);
      expect(tap.conns[0].c2sBytes, "not one byte reached the relay").to.equal(0);
      expect(srv.requests.length).to.equal(0);
    });

    it("the flush guard lets a normal send through (a clock that moved a little is fine)", async () => {
      const srv = track(await startHttp(answerOk));
      const conn = await bs.openBoundedConnection(`http://127.0.0.1:${srv.port}/`);
      let off = 0;
      const p = conn.sendOnce({ rawTx: RAW, expectedHash: HASH, check: () => {}, monoNow: () => performance.now() + off });
      off = 50; // well under tailMs/2
      expect((await p).outcome).to.equal("accepted");
    });

    it("set-up that throws between the timer and req.end: the timer and the guards are gone, nothing was written, not_sent", async () => {
      const srv = track(await startHttp(answerOk));
      const conn = await bs.openBoundedConnection(`http://127.0.0.1:${srv.port}/`);
      const proc = new EventEmitter();
      const real = proc.on.bind(proc);
      let calls = 0;
      proc.on = (name, fn) => {
        calls += 1;
        if (calls === 2) throw new Error("set-up failed (test)"); // after the first signal guard is in, the second throws
        return real(name, fn);
      };
      const res = await conn.sendOnce({ rawTx: RAW, expectedHash: HASH, check: () => {}, proc });
      expect(res).to.include({ outcome: "not_sent", stage: "check", writeStarted: false });
      for (const e of ["SIGINT", "SIGTERM", "SIGHUP", "exit"]) expect(proc.listenerCount(e), e).to.equal(0);
      await pause(150);
      expect(srv.requests.length).to.equal(0);
    });

    it("19. a wall clock that jumps 5 s between the write and the kill: unknown with clockJump", async () => {
      const srv = track(await startHttp(() => {}));
      let jump = 0;
      const wallNow = () => Date.now() + jump;
      const conn = await bs.openBoundedConnection(`http://127.0.0.1:${srv.port}/`);
      const p = conn.sendOnce({
        rawTx: RAW,
        expectedHash: HASH,
        check: () => setTimeout(() => (jump = 5000), 50),
        wallNow,
      });
      const res = await p;
      expect(res).to.include({ outcome: "unknown", clockJump: true, timeBoundBroken: true });
      expect(res.reason).to.match(/suspended or its clock was stepped/);
    });

    it("a deadline kill that fires late (both clocks jump: the machine was stalled, so no clock jump is seen): unknown, timeBoundBroken, the reason says how late", async () => {
      const srv = track(await startHttp(() => {}));
      let jump = 0;
      const conn = await bs.openBoundedConnection(`http://127.0.0.1:${srv.port}/`);
      const res = await conn.sendOnce({
        rawTx: RAW,
        expectedHash: HASH,
        check: () => setTimeout(() => (jump = 5000), 50),
        wallNow: () => Date.now() + jump,
        monoNow: () => performance.now() + jump,
      });
      expect(res).to.include({ outcome: "unknown", killedByDeadline: true, clockJump: false, timeBoundBroken: true });
      expect(res.reason).to.match(/the deadline kill fired \d+\.\d s late .*the time bound was not kept/);
      const text = live.sendOutcomeText(new live.SendOutcomeError({ ...res, hash: HASH }), { hasSwap: false });
      expect(text).to.match(/TIME BOUND NOT KEPT/);
    });

    it("a reset that libuv refuses (EINVAL, as after a half-close): rst false, the handle is closed by hand (closeConfirmed), the text says it could not be reset; the connection does not live on", async () => {
      const srv = track(await startHttp(() => {})); // never answers
      const tap = track(await startTap(srv.port));
      const socks = [];
      const conn = await bs.openBoundedConnection(`http://127.0.0.1:${tap.port}/`, { onSocket: (s) => socks.push(s) });
      socks[0]._handle.reset = () => -22; // libuv refuses the reset
      const res = await conn.sendOnce({ rawTx: RAW, expectedHash: HASH, check: () => {} });
      expect(res).to.include({ outcome: "unknown", killedByDeadline: true, rst: false, closeConfirmed: true });
      const text = live.sendOutcomeText(new live.SendOutcomeError({ ...res, hash: HASH }), { hasSwap: false });
      expect(text).to.match(/The connection could not be reset: the operating system may still retransmit/);
      await pause(300);
      expect(tap.conns[0].clientEnd, "the connection really ended (not left open until process exit)").to.not.equal(null);
    });

    it("R4. a silently dropped address first, a working one second: each address gets its own share of the limit, the second connects", async () => {
      bs.setSendTimingForTests({ ...SHORT, connectMs: 1500, addrMs: 150 });
      const srv = track(await startHttp(answerOk));
      let calls = 0;
      const t0 = performance.now();
      const conn = await bs.openBoundedConnection(`http://multi.example.test:${srv.port}/`, {
        lookup: async () => [{ address: "10.255.255.1", family: 4 }, { address: "127.0.0.1", family: 4 }],
        connect: (o) => (calls++ === 0 ? new net.Socket() /* never connects: a dropped address */ : net.connect({ ...o, host: "127.0.0.1" })),
      });
      const dt = performance.now() - t0;
      expect(calls).to.equal(2);
      expect(dt).to.be.within(140, 1000);
      expect((await conn.sendOnce({ rawTx: RAW, expectedHash: HASH, check: () => {} })).outcome).to.equal("accepted");
    });

    it("R4b. every address silent: not_sent at the overall limit (stage connect), never later", async () => {
      bs.setSendTimingForTests({ ...SHORT, connectMs: 500, addrMs: 150 });
      const t0 = performance.now();
      const err = await bs
        .openBoundedConnection("http://multi.example.test:9/", { lookup: async () => [{ address: "10.255.255.1", family: 4 }, { address: "10.255.255.2", family: 4 }, { address: "10.255.255.3", family: 4 }, { address: "10.255.255.4", family: 4 }], connect: () => new net.Socket() })
        .then(() => null, (e) => e);
      expect(err).to.include({ outcome: "not_sent", stage: "connect", code: "ETIMEDOUT" });
      expect(performance.now() - t0).to.be.within(480, 1300);
    });

    it("20. SIGINT (a fake process object) during the answer window: the socket is reset, the caller is told, exit 130 is requested; the guards are removed afterwards", async () => {
      const srv = track(await startHttp(() => {}));
      const tap = track(await startTap(srv.port));
      const proc = new EventEmitter();
      const told = [];
      let exited = null;
      const conn = await bs.openBoundedConnection(`http://127.0.0.1:${tap.port}/`);
      const p = conn.sendOnce({
        rawTx: RAW,
        expectedHash: HASH,
        check: () => {},
        proc,
        onSignal: (s) => told.push(s),
        exit: (code) => (exited = code),
      });
      expect(proc.listenerCount("SIGINT")).to.equal(1);
      expect(proc.listenerCount("SIGTERM")).to.equal(1);
      expect(proc.listenerCount("SIGHUP")).to.equal(1);
      expect(proc.listenerCount("exit")).to.equal(1);
      await pause(100);
      proc.emit("SIGINT");
      expect(told).to.deep.equal(["SIGINT"]);
      expect(exited).to.equal(130);
      const res = await p;
      expect(res).to.include({ outcome: "unknown", writeStarted: true, rst: true });
      await pause(100);
      expect(tap.conns[0].clientEnd).to.equal("ECONNRESET");
      for (const s of ["SIGINT", "SIGTERM", "SIGHUP", "exit"]) expect(proc.listenerCount(s), s).to.equal(0);
    });

    it("20b. the exit hook resets the socket by itself", async () => {
      const srv = track(await startHttp(() => {}));
      const tap = track(await startTap(srv.port));
      const proc = new EventEmitter();
      const conn = await bs.openBoundedConnection(`http://127.0.0.1:${tap.port}/`);
      const p = conn.sendOnce({ rawTx: RAW, expectedHash: HASH, check: () => {}, proc });
      await pause(100);
      proc.emit("exit", 1);
      await pause(100);
      expect(tap.conns[0].clientEnd).to.equal("ECONNRESET");
      expect((await p).outcome).to.equal("unknown");
    });

    it("a server that resets the connection after the request: unknown (the secret may be out), never not_sent", async () => {
      const srv = track(await startNet((c) => c.once("data", () => c.resetAndDestroy())));
      const { res } = await sendTo(`http://127.0.0.1:${srv.port}/`);
      expect(res).to.include({ outcome: "unknown", writeStarted: true });
      expect(res.reason).to.match(/connection failed after the request was written|connection closed before an answer/);
    });
  });

  // ------------------------------------------------------------ TLS (a throwaway certificate made at test time; never kept)
  describe("TLS (certificate made at test time with openssl)", function () {
    let dir = null;
    let cert = null;
    let key = null;
    let why = null;

    function findOpenssl() {
      const candidates = [process.env.OPENSSL, "openssl", "C:\\Program Files\\Git\\mingw64\\bin\\openssl.exe", "C:\\Program Files\\Git\\usr\\bin\\openssl.exe"].filter(Boolean);
      for (const c of candidates) {
        try {
          execFileSync(c, ["version"], { stdio: "ignore" });
          return c;
        } catch {
          /* next */
        }
      }
      return null;
    }

    before(() => {
      const exe = findOpenssl();
      if (!exe) {
        why = "the openssl command is not available";
        return;
      }
      try {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), "noid-swap-tls-"));
        execFileSync(
          exe,
          ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-keyout", path.join(dir, "k.pem"), "-out", path.join(dir, "c.pem"), "-days", "1", "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1"],
          { stdio: "ignore" }
        );
        cert = fs.readFileSync(path.join(dir, "c.pem"));
        key = fs.readFileSync(path.join(dir, "k.pem"));
      } catch (e) {
        why = `openssl could not make a certificate (${e.code || e.message})`;
      }
    });
    after(() => {
      if (dir) fs.rmSync(dir, { recursive: true, force: true });
    });

    it("21. the positive path over TLS: accepted, one request, the socket closed", async function () {
      if (why) return this.skip();
      const srv = track(await startHttp(answerOk, { secure: { key, cert } }));
      const { res, conn } = await sendTo(`https://127.0.0.1:${srv.port}/v2/KEY`, {}, { ca: cert });
      expect(conn.secure).to.equal(true);
      expect(res).to.include({ outcome: "accepted", writeStarted: true, closeConfirmed: true });
      expect(res.timings).to.have.property("tlsMs");
      expect(srv.requests[0].headers.connection).to.equal("close");
      expect(srv.requests[0].url).to.equal("/v2/KEY");
    });

    it("21b. a server certificate that is not trusted: not_sent (stage tls); no application-data record was written", async function () {
      if (why) return this.skip();
      const srv = track(await startHttp(answerOk, { secure: { key, cert } }));
      const tap = track(await startTap(srv.port));
      const err = await bs.openBoundedConnection(`https://127.0.0.1:${tap.port}/`).then(() => null, (e) => e); // no `ca`: the throwaway certificate is unknown
      expect(err).to.include({ outcome: "not_sent", stage: "tls" });
      await pause(100);
      expect(srv.requests.length).to.equal(0);
      expect(tlsRecords(tap.conns[0]).every((r) => r.type === 0x16 || r.type === 0x15 || r.type === 0x14), "handshake/alert records only: the client never wrote the request").to.equal(true);
    });

    it("21c. the deadline under TLS, with a request too large for the buffers: the TCP handle is reset (RST at the wire), the relay received less than the whole request and nothing more after the kill, `rst: true`", async function () {
      if (why) return this.skip();
      const srv = track(await startHttp(() => {}, { secure: { key, cert } })); // reads, never answers
      const tap = track(await startTap(srv.port));
      const socks = [];
      const conn = await bs.openBoundedConnection(`https://127.0.0.1:${tap.port}/`, { ca: cert, onSocket: (tcp, layer, stream) => socks.push({ tcp, layer, stream }) });
      await pause(50);
      tap.conns[0].pauseClient(); // the handshake is done: now the reader stops
      const t0 = performance.now();
      const res = await conn.sendOnce({ rawTx: BIG_RAW, expectedHash: HASH, check: () => {}, tailMs: 600 });
      const dt = performance.now() - t0;
      expect(res).to.include({ outcome: "unknown", writeStarted: true, rst: true, killedByDeadline: true, closeConfirmed: true });
      expect(dt).to.be.within(600 - 20, 600 + 1000);
      tap.conns[0].resumeClient();
      await pause(400);
      expect(tap.conns[0].clientEnd, "the relay saw a reset under TLS too").to.equal("ECONNRESET");
      const received = tap.conns[0].c2sBytes;
      expect(received, `less than the whole request reached the relay (${received} bytes of about 8 MB)`).to.be.below(8 * 1024 * 1024);
      await pause(300);
      expect(tap.conns[0].c2sBytes, "not one byte more later").to.equal(received);
      const tcp = socks.find((x) => x.layer === "tcp").tcp;
      expect(tcp.destroyed).to.equal(true);
    });

    it("21d. the plain deadline under TLS with a small request: the RST is seen and rst: true (the request itself was delivered in full)", async function () {
      if (why) return this.skip();
      const srv = track(await startHttp(() => {}, { secure: { key, cert } }));
      const tap = track(await startTap(srv.port));
      const conn = await bs.openBoundedConnection(`https://127.0.0.1:${tap.port}/`, { ca: cert });
      const res = await conn.sendOnce({ rawTx: RAW, expectedHash: HASH, check: () => {} });
      expect(res).to.include({ outcome: "unknown", rst: true, killedByDeadline: true, closeConfirmed: true });
      await pause(200);
      expect(tap.conns[0].clientEnd).to.equal("ECONNRESET");
    });
  });
});
