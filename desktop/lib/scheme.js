"use strict";
/*
 * The private scheme (build spec 9). The console's page and API are served on `no1d://app` through the main window's own session; the program opens no port.
 *
 *   registerPrivileged(electron)   before the app is ready: tells Chromium what the scheme is (a standard, secure scheme that can be fetched, with no CORS
 *                                  and no service worker, that never bypasses the content policy). Called once.
 *   attach({ electron, adapter })  after ready: the adapter answers `no1d:` on the session of the main window's partition and on no other session.
 *   createAdapter({ handler, mark, maxBody })
 *                                  turns a Fetch `Request` into the small request object the console's handler reads (method, path and query, lower-case
 *                                  headers, a body stream) and the handler's answer into a `Response`.
 *
 * Takes the Electron module as an argument; requires nothing from it. Node's standard library only.
 */

const { Readable } = require("node:stream");
const { MAIN_PARTITION } = require("./window");

const SCHEME = "no1d";
const HOST = "app";
const ORIGIN = `${SCHEME}://${HOST}`;
/** The ceiling of a request body the adapter reads at all; the handler then applies its own, smaller limit per route. */
const DEFAULT_MAX_BODY = 16384;

// Exactly the spec's privileges. `bypassCSP` stays false and no service worker is allowed.
const PRIVILEGES = Object.freeze({ standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: false, bypassCSP: false, allowServiceWorkers: false });

/** Before `ready`. */
function registerPrivileged(electron) {
  electron.protocol.registerSchemesAsPrivileged([{ scheme: SCHEME, privileges: { ...PRIVILEGES } }]);
}

/** After `ready`: the scheme is answered on the main window's session only (the secret window and the default session answer nothing on it). */
function attach({ electron, adapter }) {
  if (typeof adapter !== "function") throw new Error("scheme: an adapter is needed");
  const ses = electron.session.fromPartition(MAIN_PARTITION);
  ses.protocol.handle(SCHEME, adapter);
  return ses;
}

function plain(status, text) {
  return new Response(JSON.stringify({ error: text }), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" },
  });
}

class TooLarge extends Error {}

/** The body of a request, read to the end, never above `max` bytes (the reader is cancelled as soon as it is over). */
async function readLimited(body, max) {
  const reader = body.getReader();
  const chunks = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.byteLength;
    if (n > max) {
      try {
        await reader.cancel();
      } catch {
        /* already closed */
      }
      throw new TooLarge("body too large");
    }
    chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
  }
  return Buffer.concat(chunks);
}

/** The part of a Node `ServerResponse` that the console's handler uses, collecting what it writes. */
function createResponseSink() {
  let status = 200;
  const headers = new Map(); // lower-case name -> value (string or array)
  const chunks = [];
  let ended = false;
  let resolveDone;
  const done = new Promise((r) => (resolveDone = r));
  const add = (obj) => {
    for (const [k, v] of Object.entries(obj || {})) headers.set(String(k).toLowerCase(), v);
  };
  const res = {
    get statusCode() {
      return status;
    },
    set statusCode(v) {
      status = v;
    },
    headersSent: false,
    setHeader(k, v) {
      headers.set(String(k).toLowerCase(), v);
      return res;
    },
    getHeader: (k) => headers.get(String(k).toLowerCase()),
    removeHeader: (k) => void headers.delete(String(k).toLowerCase()),
    writeHead(s, h) {
      status = s;
      if (h && typeof h === "object") add(h);
      res.headersSent = true;
      return res;
    },
    write(c) {
      if (!ended && c !== undefined && c !== null) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
      return true;
    },
    end(c) {
      if (ended) return res;
      if (c !== undefined && c !== null && typeof c !== "function") chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
      ended = true;
      res.headersSent = true;
      resolveDone();
      return res;
    },
  };
  return {
    res,
    done,
    get ended() {
      return ended;
    },
    toResponse(method) {
      const h = new Headers();
      for (const [k, v] of headers) {
        if (Array.isArray(v)) for (const x of v) h.append(k, String(x));
        else h.set(k, String(v));
      }
      const noBody = method === "HEAD" || status === 204 || status === 205 || status === 304;
      return new Response(noBody ? null : Buffer.concat(chunks), { status, headers: h });
    },
  };
}

/**
 * @param {object} o
 * @param {(req:object,res:object)=>Promise<void>} o.handler  the console's request function (startProgramServer's `handler`)
 * @param {(req:object)=>object} o.mark                       startProgramServer's `mark`: says the request came through this adapter
 * @param {number} [o.maxBody]
 * @returns {(request: Request) => Promise<Response>}
 */
function createAdapter({ handler, mark, maxBody = DEFAULT_MAX_BODY }) {
  if (typeof handler !== "function" || typeof mark !== "function") throw new Error("scheme: a handler and its mark function are needed");
  const ceiling = Number.isInteger(maxBody) && maxBody > 0 ? maxBody : DEFAULT_MAX_BODY;
  return async function adapter(request) {
    try {
      let url;
      try {
        url = new URL(request.url);
      } catch {
        return plain(400, "bad address");
      }
      // Only this one address is answered: any other host of the scheme (or a user name, a port) never reaches the handler.
      if (url.protocol !== `${SCHEME}:` || url.host !== HOST || url.username !== "" || url.password !== "") return plain(403, "unknown address");
      const method = String(request.method || "GET").toUpperCase();

      // Lower-case header names; the Host is written from the URL checked above, whatever the request says.
      const headers = {};
      for (const [k, v] of request.headers) headers[k.toLowerCase()] = v;
      headers.host = HOST;

      let body = Buffer.alloc(0);
      if (method !== "GET" && method !== "HEAD" && request.body) {
        const declared = Number(headers["content-length"]);
        if (Number.isFinite(declared) && declared > ceiling) return plain(413, "body too large");
        try {
          body = await readLimited(request.body, ceiling);
        } catch (e) {
          if (e instanceof TooLarge) return plain(413, "body too large");
          return plain(400, "the request body could not be read");
        }
      }

      const req = new Readable({ read() {} });
      if (body.length) req.push(body);
      req.push(null);
      req.method = method;
      req.url = url.pathname + url.search;
      req.headers = headers;
      mark(req);

      const sink = createResponseSink();
      try {
        await handler(req, sink.res);
      } catch {
        return plain(500, "the program could not answer this request");
      }
      if (!sink.ended) return plain(500, "the program could not answer this request");
      return sink.toResponse(method);
    } catch {
      return plain(500, "the program could not answer this request");
    }
  };
}

module.exports = { registerPrivileged, attach, createAdapter, SCHEME, HOST, ORIGIN, PRIVILEGES, DEFAULT_MAX_BODY };
