"use strict";
// The invitation code routes through the real program server: the paste route has its own body limit (the default is 512 bytes). A plain
// code's request is about 450 bytes, so the default would leave a margin of about 60 bytes: a code pasted with spaces or line breaks
// around it, or one more key in the invitation later, would be refused with "too large" and no word of what was wrong.
const test = require("node:test");
const assert = require("node:assert/strict");
const { makeEnv } = require("./program-harness");
const inv = require("../lib/invitation");
const { makeSettings, BOB_ETH } = require("./steps-fixtures/settings");

const CONTRACT = "0x48Ce4D6cf3c175737532017e82B9261b51F8E5eF";
const BOB = makeSettings({ role: "bob", contract: CONTRACT, alice_noid: null, alice_eth: null, bob_eth: null });

test("POST /api/invitation/parse: a code and the invitation file's text both parse, a body over the limit is 413, a damaged code is 422", async () => {
  const env = makeEnv();
  try {
    const { api } = await env.start();
    const code = inv.encodeCode(BOB, BOB_ETH);
    const want = inv.parseCode(code).fields;

    let r = await api("POST", "/api/invitation/parse", { code });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.fields, want);

    // the invitation file's own text parses too
    const file = inv.build(BOB, BOB_ETH);
    r = await api("POST", "/api/invitation/parse", { code: file });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.fields, want);

    // a code padded with the spaces and line breaks a chat or a document adds around it: the request is then longer than the 512-byte
    // default (a plain code's request is about 450 bytes, so the default leaves only a thin margin)
    const padded = `\n${" ".repeat(150)}${code}${" ".repeat(150)}\r\n`;
    assert.ok(JSON.stringify({ code: padded }).length > 512, "the padded request is longer than the default body limit");
    r = await api("POST", "/api/invitation/parse", { code: padded });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.fields, want);

    // damaged: one character changed, then nothing at all
    const bad = code.slice(0, -1) + (code.endsWith("A") ? "B" : "A");
    r = await api("POST", "/api/invitation/parse", { code: bad });
    assert.equal(r.status, 422);
    assert.equal(r.body.ok, false);
    r = await api("POST", "/api/invitation/parse", {});
    assert.equal(r.status, 422);

    // far over the code limit: refused by the body limit before anything is parsed
    r = await api("POST", "/api/invitation/parse", { code: "x".repeat(20000) });
    assert.equal(r.status, 413);
  } finally {
    env.cleanup();
  }
});
