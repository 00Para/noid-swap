#!/usr/bin/env node
/*
 * Tiny loopback JSON-RPC forwarder.
 *
 *   node scripts/rpc-proxy.js --listen 127.0.0.1:8546 --upstream https://host/path
 *
 * Purpose: let a plain-HTTP JSON-RPC client (the Rust swap-cli has no TLS) talk
 * to an HTTPS endpoint. Each POST body is forwarded unchanged to the upstream;
 * the upstream's status and body come back unchanged. No auth, no caching, no
 * rewriting. Binds to 127.0.0.1 only. A redirect from the upstream is never
 * followed: it is answered with 502.
 *
 * Logs one line per request to stderr: method, status, ms. The upstream URL
 * path/query (which may carry an API key) is never logged.
 */
"use strict";
const http = require("http");

const MAX_BODY = 8 * 1024 * 1024;

function parseListen(s) {
  const m = /^([^:]+):(\d{1,5})$/.exec(s || "");
  if (!m) throw new Error(`--listen must look like 127.0.0.1:8546 (got ${JSON.stringify(s)})`);
  if (m[1] !== "127.0.0.1") throw new Error(`refusing to bind to ${m[1]}: only 127.0.0.1 is allowed`);
  const port = Number(m[2]);
  if (port > 65535) throw new Error("port out of range");
  return { host: m[1], port };
}

function methodsOf(buf) {
  try {
    const j = JSON.parse(buf.toString("utf8"));
    if (Array.isArray(j)) return "batch[" + j.map((x) => x && x.method).join(",") + "]";
    return (j && j.method) || "?";
  } catch {
    return "?";
  }
}

/** Start the proxy. Resolves to the listening http.Server. */
function startProxy({ listen, upstream, log = (line) => process.stderr.write(line + "\n") }) {
  let host, port, target;
  try {
    ({ host, port } = parseListen(listen));
    target = new URL(upstream);
  } catch (e) {
    return Promise.reject(e instanceof TypeError ? new Error(`--upstream is not a valid URL`) : e);
  }
  if (target.protocol !== "http:" && target.protocol !== "https:") {
    return Promise.reject(new Error("--upstream must be http:// or https://"));
  }

  const server = http.createServer((req, res) => {
    const t0 = Date.now();
    const finish = (method, status, headers, body) => {
      res.writeHead(status, headers);
      res.end(body);
      log(`${method} ${status} ${Date.now() - t0}ms`);
    };
    if (req.method !== "POST") {
      return finish(`${req.method}`, 405, { "content-type": "text/plain", allow: "POST" }, "POST only\n");
    }
    const chunks = [];
    let size = 0;
    let tooBig = false;
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY) tooBig = true;
      else chunks.push(c);
    });
    req.on("error", () => {});
    req.on("end", async () => {
      if (tooBig) return finish("?", 413, { "content-type": "text/plain" }, "body too large\n");
      const body = Buffer.concat(chunks);
      const method = methodsOf(body);
      try {
        const up = await fetch(target, {
          method: "POST",
          headers: { "content-type": req.headers["content-type"] || "application/json", accept: "application/json" },
          body,
          // A redirect is never followed (the node's own transports refuse every 3xx; a proxy that followed one would let an endpoint send the
          // request, and the answer, somewhere the operator never named). It is answered with 502.
          redirect: "manual",
        });
        if (up.type === "opaqueredirect" || (up.status >= 300 && up.status < 400)) {
          if (up.body) await up.body.cancel().catch(() => {});
          return finish(
            method,
            502,
            { "content-type": "application/json" },
            JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32603, message: `proxy: upstream answered a redirect (status ${up.status}); redirects are never followed` } })
          );
        }
        const out = Buffer.from(await up.arrayBuffer());
        finish(method, up.status, { "content-type": up.headers.get("content-type") || "application/json" }, out);
      } catch (e) {
        const msg = (e && e.cause && e.cause.code) || (e && e.message) || "upstream error";
        finish(
          method,
          502,
          { "content-type": "application/json" },
          JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32603, message: `proxy: upstream unreachable (${msg})` } })
        );
      }
    });
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve(server);
    });
  });
}

module.exports = { startProxy, parseListen };

if (require.main === module) {
  const argv = process.argv.slice(2);
  const get = (flag) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const listen = get("--listen") || "127.0.0.1:8546";
  const upstream = get("--upstream");
  if (!upstream) {
    process.stderr.write("usage: node scripts/rpc-proxy.js --listen 127.0.0.1:8546 --upstream URL\n");
    process.exit(2);
  }
  startProxy({ listen, upstream })
    .then((s) => {
      const a = s.address();
      const u = new URL(upstream);
      process.stderr.write(`rpc-proxy: listening on http://${a.address}:${a.port} -> ${u.protocol}//${u.host}/... (path hidden)\n`);
    })
    .catch((e) => {
      process.stderr.write(`error: ${e.message}\n`);
      process.exit(1);
    });
}
