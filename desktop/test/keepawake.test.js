"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createFakeElectron } = require("./fake-electron");
const { createKeepAwake } = require("../lib/keepawake");

const S = (active, in_contract) => ({ swap_id: "b".repeat(32), role: "bob", phase: "p", active, in_contract, coins: { noid_micronoid: null, eth_wei: null }, until_unix: null, until_text: null, needs_you: false });

test("keep-awake: none, active-only, in-contract, and back; idempotent", () => {
  const electron = createFakeElectron();
  const k = createKeepAwake({ powerSaveBlocker: electron.powerSaveBlocker });
  const psb = electron.powerSaveBlocker;
  k.update([]);
  assert.equal(psb.started.length, 0);
  k.update([S(true, false)]);
  assert.equal(psb.started.length, 0, "active but not in a contract: no block");
  k.update([S(true, true)]);
  k.update([S(true, true)]);
  k.update([S(true, true), S(true, false)]);
  assert.equal(psb.started.length, 1, "one block, however often it is told");
  assert.equal(psb.started[0].kind, "prevent-app-suspension");
  assert.equal(k.held(), true);
  k.update([S(true, false)]);
  k.update([]);
  assert.deepEqual(psb.stopped, [psb.started[0].id], "stopped once, with the id it started");
  assert.equal(k.held(), false);
  k.update([S(true, true)]);
  assert.equal(psb.started.length, 2);
});

test("keep-awake tolerates a bad list", () => {
  const electron = createFakeElectron();
  const k = createKeepAwake({ powerSaveBlocker: electron.powerSaveBlocker });
  k.update(null);
  k.update(undefined);
  k.update([null, {}]);
  assert.equal(electron.powerSaveBlocker.started.length, 0);
});
