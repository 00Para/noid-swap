"use strict";
// lib/enginetext.js is the ONE place where the console reads meaning out of the engine's text. These tests pin each match, and (when the engine's
// source is next to this folder) look every phrase up in swap-cli/src: a reworded engine text fails here instead of silently changing what the page shows.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const E = require("../lib/enginetext");

test("the held tick's fresh decision: the engine's exact note, nothing that only resembles it", () => {
  assert.equal(E.heldFreshDecision(["x", "held: fresh decision was reveal_eth", "y"]), "reveal_eth");
  assert.equal(E.heldFreshDecision(["held: fresh decision was wait"]), "wait");
  for (const bad of [[], ["held: fresh decision was "], ["Held: fresh decision was wait"], ["note: held: fresh decision was wait"], ["held: fresh decision was wait; more"], ["held: a lock_eth is due, but a reveal_eth intent is still pending"], null, undefined, "held: fresh decision was wait"]) {
    assert.equal(E.heldFreshDecision(bad), null, JSON.stringify(bad));
  }
  // whitespace around the whole note is tolerated, inside it is not
  assert.equal(E.heldFreshDecision([" held: fresh decision was lock_eth "]), "lock_eth");
});

test("the held reveal whose cutoff has passed, the do-not-send wait and the lock-by notes", () => {
  assert.equal(E.revealCutoffHeld("intent reveal_eth pending since 1 (unix): the chain does not show it yet and its reveal cutoff has passed, so the printed parameters are not to be used; if nothing was sent, cancel it"), true);
  assert.equal(E.revealCutoffHeld("intent reveal_eth pending since 1 (unix): the chain does not show it yet; reuse the printed parameters"), false);
  assert.equal(E.revealCutoffHeld(null), false);
  assert.equal(E.doNotSend("... refuses to lock now (T21: x): do NOT send it; if nothing was sent"), true);
  assert.equal(E.doNotSend("reuse the printed parameters"), false);
  const notes = {
    "funding window: 26 blocks left before it is too late to fund (lock-by 1, tip 2)": "quiet",
    "funding window is short: 10 blocks left before it is too late to fund (lock-by 1, tip 2); see the action": "warn",
    "funding window is closed: the last height to fund was 5 (lock-by 6, tip 7)": "danger",
    "lock-by margin: 50 blocks (lock-by 1, tip 2); the last lock height is at most 9": "quiet",
    "lock-by margin is short: 8 blocks (lock-by 1, tip 2); see the action": "warn",
    "lock margin: 40 blocks to the last lock height 9 (nominal lock-by 1, tip 2)": "quiet",
    "lock margin is short: 8 blocks to the last lock height 9 (nominal lock-by 1, tip 2); see the action": "warn",
    "nominal lock-by 1 has passed (tip 2); the lock is still allowed until the hard limit 9": "danger",
    "lock-by 1 has passed: tip 2 is 1 blocks beyond it": "danger",
    "the tip is the last lock height 9 (nominal lock-by 1); see the action": "warn",
    "the last lock height 9 has passed (nominal lock-by 1, tip 12)": "danger",
  };
  for (const [n, level] of Object.entries(notes)) {
    assert.equal(E.lockByNote(["other", n]), n, n);
    assert.equal(E.lockByLevel(n), level, n);
  }
  assert.equal(E.lockByNote(["not a lock-by note", "the funding window of nobody"]), null);
  assert.equal(E.lockByLevel(null), "quiet");
});

test("alarms and alerts: whole texts; an ALERT is not an ALARM", () => {
  const tick = { notes: ["fine", "ALARM: x", "ALERT: y"], action: { action: "wait", reason: "ANOMALY in the reason" } };
  assert.equal(E.alarmText(tick), "ALARM: x");
  assert.equal(E.alertText(tick), "ALERT: y");
  assert.equal(E.alarmText({ notes: ["fine"], action: { reason: "ANOMALY: z" } }), "ANOMALY: z");
  assert.equal(E.alarmText({ notes: ["ALERT: only"], action: null }), null);
  assert.equal(E.alertText({ notes: ["see ALERT: in the middle"] }), null);
  assert.equal(E.alarmText(null), null);
  assert.equal(E.isCautionNote("not lock_eth: x (fail closed)"), true);
  assert.equal(E.isCautionNote("the observation is stale"), true);
  assert.equal(E.isCautionNote("all good"), false);
});

test("the phrases of lib/enginetext.js are still in the engine's source (swap-cli/src)", (t) => {
  const dir = path.join(__dirname, "..", "..", "..", "swap-cli", "src");
  if (!fs.existsSync(dir)) return t.skip("swap-cli/src is not next to ui/app");
  const src = {};
  for (const f of fs.readdirSync(dir)) if (f.endsWith(".rs")) src[f] = fs.readFileSync(path.join(dir, f), "utf8");
  assert.ok(E.ENGINE_PHRASES.length >= 14);
  for (const p of E.ENGINE_PHRASES) {
    for (const file of p.files) {
      assert.ok(src[file], `${file} exists`);
      assert.ok(src[file].includes(p.phrase), `the engine's ${file} no longer contains "${p.phrase}" (text #${p.id} of lib/enginetext.js): the engine's wording changed, change the match in lib/enginetext.js and its tests`);
    }
  }
});
