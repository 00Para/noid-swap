"use strict";
// Build spec #4: the invitation file (lib/invitation.js). It comes from another person, so every refusal is tested with its fixed words, and `parse` is tested to return the form's fields only.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const inv = require("../lib/invitation");
const { makeSettings, BOB_NOID, ALICE_NOID, BOB_ETH, ETH_PAYOUT } = require("./steps-fixtures/settings");

const CONTRACT = "0x48Ce4D6cf3c175737532017e82B9261b51F8E5eF";
const BOB = makeSettings({ role: "bob", contract: CONTRACT, alice_noid: null, alice_eth: null, bob_eth: null });
const GOOD = () => ({ kind: "no1d-swap-invitation", v: 1, network: "sepolia", contract: CONTRACT, contract_version: 1, noid_micronoid: "5000000", eth_wei: "1000000000000000", bob_noid: BOB_NOID, bob_eth: BOB_ETH });
const text = (o) => `${JSON.stringify(o, null, 2)}\n`;
const why = (t) => {
  const r = inv.parse(t);
  assert.equal(r.ok, false, `expected a refusal for ${String(t).slice(0, 80)}`);
  return r.why;
};

test("build: the nine keys in the spec's order, indented, one newline at the end", () => {
  const t = inv.build(BOB, BOB_ETH);
  assert.deepEqual(Object.keys(JSON.parse(t)), ["kind", "v", "network", "contract", "contract_version", "noid_micronoid", "eth_wei", "bob_noid", "bob_eth"]);
  assert.equal(t, text(GOOD()));
  assert.ok(t.endsWith("}\n") && !t.endsWith("\n\n"));
  const o = JSON.parse(t);
  assert.equal(typeof o.noid_micronoid, "string");
  assert.equal(typeof o.eth_wei, "string");
  assert.equal(o.contract_version, 1);
});

test("build refuses an Alice run.json, a rehearsal one, a missing value and a key address the reader would refuse", () => {
  assert.throws(() => inv.build(makeSettings({ role: "alice", contract: CONTRACT }), BOB_ETH), /sells ETH/);
  assert.throws(() => inv.build(makeSettings({ role: "bob", profile: "rehearsal", chain_id: 31337 }), BOB_ETH), /Sepolia/);
  assert.throws(() => inv.build(makeSettings({ role: "bob", profile: "production", chain_id: 1 }), BOB_ETH), /Sepolia/);
  assert.throws(() => inv.build(BOB, null), /key/);
  assert.throws(() => inv.build(BOB, ""), /key/);
  assert.throws(() => inv.build({ ...BOB, bob_noid: null }, BOB_ETH), /bob_noid/);
  assert.throws(() => inv.build({ ...BOB, amount_wei: null }, BOB_ETH), /amount_wei/);
  assert.throws(() => inv.build(BOB, "0x1234"));
  assert.throws(() => inv.build(null, BOB_ETH));
  // an amount above the test limit is not written either
  assert.throws(() => inv.build({ ...BOB, amount_micronoid: "20000001" }, BOB_ETH));
});

test("build then parse gives the fields back, exact decimals, and nothing else", () => {
  const r = inv.parse(inv.build(BOB, BOB_ETH));
  assert.equal(r.ok, true);
  assert.deepEqual(r.fields, { role: "alice", profile: "sepolia", contract_version: "1", noid_amount: "5", eth_amount: "0.001", contract: CONTRACT, bob_noid: BOB_NOID, bob_eth: BOB_ETH });
  // no payout, no node switch, no timing: the reader hands the form these keys and no other
  assert.deepEqual(Object.keys(r.fields).sort(), ["bob_eth", "bob_noid", "contract", "contract_version", "eth_amount", "noid_amount", "profile", "role"]);
  for (const k of ["noid_payout", "eth_payout", "single_node_ok", "hc_lead", "deploy_block", "gas_price_gwei", "priority_fee_gwei", "alice_noid", "alice_eth"]) assert.ok(!(k in r.fields), k);
});

test("amounts become exact decimals through BigInt", () => {
  const f = (m, w, v = 1) => inv.parse(text({ ...GOOD(), noid_micronoid: m, eth_wei: w, contract_version: v })).fields;
  assert.equal(f("5500000", "1000000000000000").noid_amount, "5.5");
  assert.equal(f("1", "1").noid_amount, "0.000001");
  assert.equal(f("1", "1").eth_amount, "0.000000000000000001");
  assert.equal(f("20000000", "10000000000000000").noid_amount, "20");
  assert.equal(f("20000000", "10000000000000000").eth_amount, "0.01");
  assert.equal(f("1234567", "1234567890123456").eth_amount, "0.001234567890123456");
  assert.equal(f("5000000", "1000000000000000", 2).contract_version, "2");
});

test("a file over 4,096 bytes is too large, before anything else is read", () => {
  const big = `${text(GOOD())}${" ".repeat(4096)}`;
  assert.equal(why(big), inv.WORDS.TOO_LARGE);
  assert.equal(why("x".repeat(4097)), inv.WORDS.TOO_LARGE);
  // the limit is in bytes: 2,049 two-byte characters
  assert.equal(why("é".repeat(2049)), inv.WORDS.TOO_LARGE);
  // exactly at the limit, a good file with trailing blanks still parses
  const t = text(GOOD());
  const padded = t + " ".repeat(4096 - Buffer.byteLength(t));
  assert.equal(Buffer.byteLength(padded), 4096);
  assert.equal(inv.parse(padded).ok, true);
});

test("not an invitation, or damaged: not JSON, a BOM, a root that is not an object, a missing, an extra and a duplicated key, a wrong kind or v", () => {
  const D = inv.WORDS.DAMAGED;
  assert.equal(why("not json"), D);
  assert.equal(why(""), D);
  assert.equal(why(`﻿${text(GOOD())}`), D);
  assert.equal(why("[]"), D);
  assert.equal(why("null"), D);
  assert.equal(why('"x"'), D);
  assert.equal(why(null), D);
  assert.equal(why(undefined), D);
  assert.equal(why({}), D);
  for (const k of Object.keys(GOOD())) {
    const o = GOOD();
    delete o[k];
    assert.equal(why(text(o)), D, `missing ${k}`);
  }
  for (const k of ["chain_id", "lock_kind", "variant", "noid_payout", "eth_payout", "single_node_ok", "hc_lead", "deploy_block", "extra"]) assert.equal(why(text({ ...GOOD(), [k]: "x" })), D, `extra ${k}`);
  // a duplicated key written the same way twice (JSON.parse would keep the last one)
  const dup = text(GOOD()).replace('"v": 1,', '"v": 1,\n  "v": 1,');
  assert.equal(why(dup), D);
  const dupNetwork = text(GOOD()).replace('"network": "sepolia",', '"network": "production",\n  "network": "sepolia",');
  assert.equal(why(dupNetwork), D);
  assert.equal(why(text({ ...GOOD(), kind: "something-else" })), D);
  assert.equal(why(text({ ...GOOD(), kind: null })), D);
  assert.equal(why(text({ ...GOOD(), v: 2 })), D);
  assert.equal(why(text({ ...GOOD(), v: "1" })), D);
  assert.equal(why(text({ ...GOOD(), v: 1.5 })), D);
});

test("a network other than sepolia is refused: rehearsal, production, mainnet, a number, a wrong case", () => {
  for (const n of ["rehearsal", "production", "mainnet", "Sepolia", "", 11155111, null]) assert.equal(why(text({ ...GOOD(), network: n })), inv.WORDS.NETWORK, String(n));
});

test("every value is checked, and the refusal names the field", () => {
  const V = inv.WORDS.value;
  const bad = (over, field) => assert.equal(why(text({ ...GOOD(), ...over })), V(field), JSON.stringify(over));
  // the version: the integer 1 or 2, never a string, a float or another number
  bad({ contract_version: 3 }, "contract_version");
  bad({ contract_version: 0 }, "contract_version");
  bad({ contract_version: "1" }, "contract_version");
  bad({ contract_version: 1.0000001 }, "contract_version");
  bad({ contract_version: null }, "contract_version");
  // the amounts are strings: a JSON number would lose precision above 2^53
  bad({ noid_micronoid: 5000000 }, "noid_micronoid");
  bad({ eth_wei: 1000000000000000 }, "eth_wei");
  bad({ eth_wei: 10000000000000001 }, "eth_wei");
  bad({ eth_wei: null }, "eth_wei");
  for (const a of ["0", "", "05", "-1", "1.5", "1e6", "0x10", " 5", "5 ", "5000000000000000000"]) bad({ noid_micronoid: a }, "noid_micronoid");
  for (const a of ["0", "", "01", "-1", "1.0", "1e15", "9".repeat(32)]) bad({ eth_wei: a }, "eth_wei");
  // addresses: strings with the form's own checks
  bad({ contract: 1 }, "contract");
  bad({ contract: "0x1234" }, "contract");
  bad({ contract: CONTRACT.replace("48Ce", "48cE") }, "contract"); // a mistyped capital: the checksum fails
  bad({ contract: `0x${"g".repeat(40)}` }, "contract");
  bad({ bob_noid: ALICE_NOID.slice(0, -1) + (ALICE_NOID.endsWith("q") ? "p" : "q") }, "bob_noid");
  bad({ bob_noid: "o1xyz" }, "bob_noid");
  bad({ bob_noid: 5 }, "bob_noid");
  bad({ bob_eth: "0x12" }, "bob_eth");
  bad({ bob_eth: null }, "bob_eth");
  bad({ bob_eth: ["x"] }, "bob_eth");
});

test("amounts above the Sepolia test limits are refused with their own words; the limit itself is allowed", () => {
  const C = inv.WORDS.CAPS;
  assert.equal(why(text({ ...GOOD(), noid_micronoid: "20000001" })), C);
  assert.equal(why(text({ ...GOOD(), eth_wei: "10000000000000001" })), C);
  assert.equal(why(text({ ...GOOD(), noid_micronoid: "9999999999999999" })), C);
  assert.equal(inv.parse(text({ ...GOOD(), noid_micronoid: "20000000", eth_wei: "10000000000000000" })).ok, true);
});

test("the refusal words are exactly the spec's", () => {
  assert.equal(inv.WORDS.TOO_LARGE, "That file is too large to be an invitation. Nothing was filled.");
  assert.equal(inv.WORDS.DAMAGED, "That file is not an invitation of this program, or it is damaged. Nothing was filled.");
  assert.equal(inv.WORDS.NETWORK, "This invitation is for a network this program does not use for invitations (Sepolia only). Nothing was filled.");
  assert.equal(inv.WORDS.value("contract"), "That invitation has a value this program cannot use (contract). Nothing was filled.");
  assert.equal(inv.WORDS.CAPS, "The amounts in this invitation are above this program's test limit. Nothing was filled.");
});

// ---- readBobKeyAddress

function withDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "no1d-inv-"));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
const ADDR = path.join.bind(path);

test("readBobKeyAddress: ROLE=bob and BOB_ETH, a plain small file, nothing else", () => {
  withDir((dir) => {
    const f = ADDR(dir, "wallet-addresses.txt");
    assert.equal(inv.readBobKeyAddress(dir), null, "no file");
    fs.writeFileSync(f, `ROLE=bob\nBOB_ETH=${BOB_ETH}\n`);
    assert.equal(inv.readBobKeyAddress(dir), BOB_ETH);
    fs.writeFileSync(f, `ROLE=bob\r\nBOB_ETH=${BOB_ETH}\r\n`);
    assert.equal(inv.readBobKeyAddress(dir), BOB_ETH, "CRLF is read");
    for (const bad of [
      `ROLE=alice\nBOB_ETH=${BOB_ETH}\n`,
      `BOB_ETH=${BOB_ETH}\n`,
      "ROLE=bob\n",
      `ROLE=bob\nBOB_ETH=${BOB_ETH}\nALICE_ETH=${ETH_PAYOUT}\n`,
      `ROLE=bob\nBOB_ETH=${BOB_ETH}\nBOB_ETH=${ETH_PAYOUT}\n`,
      `ROLE=bob\nROLE=bob\nBOB_ETH=${BOB_ETH}\n`,
      "ROLE=bob\nBOB_ETH=0x1234\n",
      `ROLE=bob\nBOB_ETH=${BOB_ETH} \n`,
      `ROLE=bob\nBOB_ETH=${BOB_ETH}x\n`,
      `ROLE=bob\nBOB_ETH=${BOB_ETH}\n${"#".repeat(1100)}\n`,
      "",
    ]) {
      fs.writeFileSync(f, bad);
      assert.equal(inv.readBobKeyAddress(dir), null, JSON.stringify(bad.slice(0, 60)));
    }
    // a folder in its place
    fs.rmSync(f);
    fs.mkdirSync(f);
    assert.equal(inv.readBobKeyAddress(dir), null);
    assert.equal(inv.readBobKeyAddress(path.join(dir, "no-such-folder")), null);
  });
});

test("readBobKeyAddress: a link is not read", (t) => {
  withDir((dir) => {
    const real = ADDR(dir, "real.txt");
    fs.writeFileSync(real, `ROLE=bob\nBOB_ETH=${BOB_ETH}\n`);
    try {
      fs.symlinkSync(real, ADDR(dir, "wallet-addresses.txt"));
    } catch {
      t.skip("symbolic links cannot be made here");
      return;
    }
    assert.equal(inv.readBobKeyAddress(dir), null);
  });
});
