"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { keccak256Hex, lockIdOf, selectorOf } = require("../lib/keccak");
const { decodeBech32m } = require("../lib/bech32");

test("keccak-256: the Ethereum hash, not NIST SHA3 (known vectors)", () => {
  assert.equal(keccak256Hex(""), "0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470");
  assert.equal(keccak256Hex("abc"), "0x4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45");
  // longer than one 136-byte block
  assert.equal(keccak256Hex("a".repeat(200)).length, 66);
  assert.notEqual(keccak256Hex("a".repeat(135)), keccak256Hex("a".repeat(136)));
});

test("selectors and the lock id agree with ethers (values taken from eth/node_modules/ethers)", () => {
  assert.equal(selectorOf("transfer(address,uint256)"), "0xa9059cbb");
  assert.equal(selectorOf("newLock(bytes32,uint256,address)"), "0x5fa3d050");
  assert.equal(selectorOf("refund(bytes32)"), "0x7249fbb6");
  const id = lockIdOf("0x" + "11".repeat(20), "0x" + "22".repeat(20), "1000000000000000", "0x" + "d0".repeat(32), 1800000000);
  assert.equal(id, "0x0f02b7798caf35f2346c6e3b37516c18723be50052d7739749e8b6a13b63cdb0");
  assert.throws(() => lockIdOf("0x11", "0x" + "22".repeat(20), 1, "0x" + "d0".repeat(32), 1), /wrong width|invalid/i);
});

test("bech32m: the two project test-vector addresses decode, a typo or a wrong prefix does not", () => {
  const a = decodeBech32m("o1lqvrmvsyl7mkt3cptkz3c965ujt5ce6mjawxwwxe7mgn36mjzt8sn69xw2");
  assert.equal(a.ok, true);
  assert.equal(a.bytes.toString("hex"), "f8183db204ffb765c7015d851c1754e4974c675b975c6738d9f6d138eb7212cf");
  assert.equal(decodeBech32m("o125qayvgtmvqnlhqmqwe08dza3acaax5mct3u5h4uen3qtrds3jfset7wlk").ok, true);
  assert.equal(decodeBech32m("o1lqvrmvsyl7mkt3cptkz3c965ujt5ce6mjawxwwxe7mgn36mjzt8sn69xw3").ok, false, "one changed character");
  assert.equal(decodeBech32m("x1lqvrmvsyl7mkt3cptkz3c965ujt5ce6mjawxwwxe7mgn36mjzt8sn69xw2").ok, false, "wrong HRP");
  assert.equal(decodeBech32m("O1LQVRMVSYL7MKT3CPTKZ3C965UJT5CE6MJAWXWWXE7MGN36MJZT8SN69XW2").ok, false, "upper case");
  assert.equal(decodeBech32m("o1ALICE-PLACEHOLDER").ok, false);
  assert.equal(decodeBech32m("").ok, false);
  assert.equal(decodeBech32m(5).ok, false);
});
