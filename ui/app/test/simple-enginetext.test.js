"use strict";
// Build spec #6: `fundingBlocksLeft` reads Alice's funding-window note, for the page's deposit clock (display only). It matches the three forms the engine prints
// (swap-cli/src/engine.rs `lock_by_margin_note`) and is null for any other text. The texts below are checked against the engine's source, not only typed by hand.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const E = require("../lib/enginetext");

test("the three engine forms: blocks left (quiet), blocks left (short), closed", () => {
  assert.equal(E.fundingBlocksLeft("funding window: 30 blocks left before it is too late to fund (lock-by 1000, tip 940)"), 30);
  assert.equal(E.fundingBlocksLeft("funding window is short: 8 blocks left before it is too late to fund (lock-by 1000, tip 962); see the action"), 8);
  assert.equal(E.fundingBlocksLeft("funding window is short: 0 blocks left before it is too late to fund (lock-by 1000, tip 970); see the action"), 0, "0 blocks left is a real count");
  assert.equal(E.fundingBlocksLeft("funding window is closed: the last height to fund was 969 (lock-by 1000, tip 975)"), -1, "the closed window is -1, told apart from 0 blocks left");
  assert.equal(E.fundingBlocksLeft("  funding window: 12 blocks left before it is too late to fund (x)  "), 12, "the engine's text is trimmed like the other matches");
  assert.equal(E.fundingBlocksLeft("funding window: 100000 blocks left before it is too late to fund"), 100000);
});

test("any other text is null: the other lock-by notes, a number in another place, a made-up count, not a string", () => {
  for (const t of [
    "",
    "lock-by margin: 40 blocks (lock-by 1000, tip 960)",
    "lock margin: 5 blocks left",
    "nominal lock-by 1000 has passed (tip 1001)",
    "the last lock height 990 passed",
    "funding window: soon",
    "funding window: -3 blocks left before it is too late to fund",
    "funding window: 3.5 blocks left before it is too late to fund",
    "funding window: 12 blocks left before it is too late to funds",
    "funding window: 12 blocks left before it is late to fund",
    "xx funding window: 12 blocks left before it is too late to fund",
    "funding window is closed",
    "the funding window is closed",
    "funding window: 99999999999999999999 blocks left before it is too late to fund",
    "funding window: 12 blocks left before it is too late to fundamental",
  ]) {
    // "funding window is closed" without anything after it is still the closed form: -1
    const want = /^funding window is closed\b/.test(t) ? -1 : null;
    assert.equal(E.fundingBlocksLeft(t), want, JSON.stringify(t));
  }
  for (const v of [null, undefined, 5, {}, [], ["funding window is closed"], true]) assert.equal(E.fundingBlocksLeft(v), null, String(v));
});

test("the wording is the engine's: each form is built from the format strings of engine.rs, so a reworded note fails here", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "..", "..", "swap-cli", "src", "engine.rs"), "utf8");
  for (const phrase of ["funding window is closed: the last height to fund was", "blocks left before it is too late to fund (lock-by", '"funding window: {what}"', "funding window is short: {what}; see the action"]) {
    assert.ok(src.includes(phrase), `engine.rs no longer contains ${phrase}`);
  }
  // and the console's own phrase list names them, so the existing source check watches them
  assert.ok(E.ENGINE_PHRASES.some((p) => p.id === 9 && p.phrase === "blocks left before it is too late to fund"));
  assert.ok(E.ENGINE_PHRASES.some((p) => p.id === 9 && p.phrase === "funding window is closed"));
});

test("the other matches of the module are unchanged", () => {
  assert.equal(E.lockByNote(["funding window: 30 blocks left before it is too late to fund (x)"]) !== null, true);
  assert.equal(E.lockByLevel("funding window is short: 8 blocks left before it is too late to fund (x); see the action"), "warn");
  assert.equal(E.lockByLevel("funding window is closed: the last height to fund was 3"), "danger");
});
