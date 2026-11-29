/*
 * rpc-proxy.js refuses to relay transaction sends (decision D3): a relay has no deadline, and a claim handed to it could be forwarded after the reveal cutoff
 * that the claim's own time bound (scripts/bounded-send.js) enforces. Reads still pass. Local stubs on 127.0.0.1 only.
 */
const { expect } = require("chai");
const http = require("node:http");
const { startProxy, sendRequestsOf, judgeBody } = require("../scripts/rpc-proxy.js");

async function upstreamStub() {
  const seen = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      seen.push(body);
      let j;
      try {
        j = JSON.parse(body);
      } catch {
        res.writeHead(200, { "content-type": "application/json" });
        res.end("{}");
        return;
      }
      const one = (x) => ({ jsonrpc: "2.0", id: x.id, result: "0x1" });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(Array.isArray(j) ? j.map(one) : one(j)));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { seen, port: server.address().port, close: () => new Promise((r) => (server.close(r), server.closeAllConnections())) };
}

async function post(port, body) {
  const res = await fetch(`http://127.0.0.1:${port}/`, { method: "POST", headers: { "content-type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) });
  return { status: res.status, json: await res.json().catch(() => null) };
}

describe("rpc-proxy.js: transaction sends are never relayed", function () {
  let up;
  let proxy;
  let port;
  beforeEach(async () => {
    up = await upstreamStub();
    proxy = await startProxy({ listen: "127.0.0.1:0", upstream: `http://127.0.0.1:${up.port}/KEY`, log: () => {} });
    port = proxy.address().port;
  });
  afterEach(async () => {
    await new Promise((r) => (proxy.close(r), proxy.closeAllConnections()));
    await up.close();
  });

  it("eth_sendRawTransaction and eth_sendTransaction (and any eth_send*) alone: a JSON-RPC error with the request's id, nothing reaches the upstream", async () => {
    for (const method of ["eth_sendRawTransaction", "eth_sendTransaction", "eth_sendRawTransactionConditional", "ETH_SENDRAWTRANSACTION"]) {
      const r = await post(port, { jsonrpc: "2.0", id: 7, method, params: ["0x1234"] });
      expect(r.status, method).to.equal(200);
      expect(r.json.id, method).to.equal(7);
      expect(r.json.error.message, method).to.match(/transaction sends are never relayed/);
      expect(r.json.result, method).to.equal(undefined);
    }
    expect(up.seen, "the upstream saw nothing").to.deep.equal([]);
  });

  it("a batch with a send in it is refused whole, one error per request, and nothing is forwarded (the reads in it neither)", async () => {
    const r = await post(port, [
      { jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] },
      { jsonrpc: "2.0", id: 2, method: "eth_sendRawTransaction", params: ["0xabcd"] },
      { jsonrpc: "2.0", id: 3, method: "eth_chainId", params: [] },
    ]);
    expect(r.json).to.have.length(3);
    expect(r.json.map((x) => x.id)).to.deep.equal([1, 2, 3]);
    for (const x of r.json) expect(x.error.message).to.match(/never relayed/);
    expect(up.seen).to.deep.equal([]);
  });

  it("reads still pass, unchanged, alone and in a batch", async () => {
    const one = await post(port, { jsonrpc: "2.0", id: 5, method: "eth_blockNumber", params: [] });
    expect(one.json).to.deep.equal({ jsonrpc: "2.0", id: 5, result: "0x1" });
    const batch = await post(port, [
      { jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] },
      { jsonrpc: "2.0", id: 2, method: "eth_getBalance", params: ["0x0", "latest"] },
    ]);
    expect(batch.json.map((x) => x.result)).to.deep.equal(["0x1", "0x1"]);
    expect(up.seen).to.have.length(2);
  });

  it("a body that is not clean JSON is answered with HTTP 400 and NEVER forwarded: not JSON, a byte-order mark, trailing data, a non-object, no method, an empty batch", async () => {
    const good = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] });
    const send = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_sendRawTransaction", params: ["0x12"] });
    const cases = [
      ["not JSON", "not json"],
      ["a byte-order mark", "\uFEFF" + send],
      ["trailing data after the first value", send + " " + good],
      ["a number", "7"],
      ["null", "null"],
      ["an array with a non-object", "[1]"],
      ["no method", JSON.stringify({ jsonrpc: "2.0", id: 1 })],
      ["a method that is not a string", JSON.stringify({ jsonrpc: "2.0", id: 1, method: 5 })],
      ["an empty batch", "[]"],
    ];
    for (const [what, body] of cases) {
      const r = await post(port, body);
      expect(r.status, what).to.equal(400);
      expect(r.json.error.message, what).to.match(/request refused, not forwarded/);
    }
    expect(up.seen, "the upstream saw nothing").to.deep.equal([]);
  });

  it("a duplicate method key (the parser keeps the last one) and a backslash escape in a key are refused, not forwarded", async () => {
    const M = "method";
    const dup = `{"jsonrpc":"2.0","id":1,"${M}":"eth_sendRawTransaction","params":["0x12"],"${M}":"eth_blockNumber"}`;
    const dup2 = `{"jsonrpc":"2.0","id":1,"${M}":"eth_blockNumber","${M}":"eth_sendRawTransaction","params":["0x12"]}`;
    const BS = String.fromCharCode(92); // a backslash
    const esc = `{"jsonrpc":"2.0","id":1,"${BS}u006dethod":"eth_sendRawTransaction","${M}":"eth_blockNumber","params":[]}`;
    const esc2 = `{"jsonrpc":"2.0","id":1,"m${BS}u0065thod":"eth_sendRawTransaction","params":[]}`;
    for (const [what, body] of [["duplicate, send first", dup], ["duplicate, send last", dup2], ["escaped key plus a plain one", esc], ["escaped key only", esc2]]) {
      const r = await post(port, body);
      expect(r.status, what).to.equal(400);
    }
    expect(up.seen).to.deep.equal([]);
  });

  it("bundle and private-send methods are refused too (any name containing send or bundle, any case)", async () => {
    for (const method of ["eth_sendBundle", "mev_sendBundle", "eth_callBundle", "flashbots_sendPrivateTransaction", "private_SENDRAWTRANSACTION", "eth_cancelPrivateTransaction_bundle"]) {
      const r = await post(port, { jsonrpc: "2.0", id: 3, method, params: [] });
      expect(r.status, method).to.equal(200);
      expect(r.json.error.message, method).to.match(/never relayed/);
    }
    expect(up.seen).to.deep.equal([]);
  });

  it("sendRequestsOf: finds a send in an object or a batch, and nothing in a read or in garbage", () => {
    const b = (x) => Buffer.from(typeof x === "string" ? x : JSON.stringify(x));
    expect(sendRequestsOf(b({ method: "eth_sendRawTransaction" }))).to.include({ batch: false });
    expect(sendRequestsOf(b([{ method: "eth_call" }, { method: "eth_sendTransaction" }]))).to.include({ batch: true });
    expect(sendRequestsOf(b({ method: "eth_call" }))).to.equal(null);
    expect(sendRequestsOf(b("garbage"))).to.equal(null);
    expect(sendRequestsOf(b([null, 3, "x"]))).to.equal(null);
    expect(judgeBody(b("garbage")).kind).to.equal("bad");
    expect(judgeBody(b({ method: "eth_call" })).kind).to.equal("ok");
  });
});
