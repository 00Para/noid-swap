"use strict";
// The help text: fixed words. The entry "Close a swap from a second computer" is there, says what the close can and cannot do, and ends with the program's own way to record it;
// one paragraph says what the address history is for and where it stops. The help dialog is the menu's Help item (shell-start.test.js clicks it).
const test = require("node:test");
const assert = require("node:assert/strict");
const { HELP_TITLE, HELP_PARAGRAPHS } = require("../lib/helptext");
const { helpMessage } = require("../lib/program");

const all = HELP_PARAGRAPHS.join("\n\n");

test("help: the entry on closing a swap from a second computer is there, in its parts", () => {
  const i = HELP_PARAGRAPHS.findIndex((p) => p.startsWith("Close a swap from a second computer\n"));
  assert.ok(i >= 0, "the entry has its title on the first line of its first paragraph");
  const entry = HELP_PARAGRAPHS.slice(i, i + 5).join("\n");
  assert.match(entry, /secret that opens the NOID lock is public on Ethereum/);
  assert.match(entry, /that close can pay only your own Parano1d address/);
  assert.match(entry, /whoever sends it cannot take the NOID or send it anywhere else/);
  assert.match(entry, /fee of the close \(about 0\.0058 NOID\) comes out of the locked NOID/);
  assert.match(entry, /Use it when this computer cannot claim in time: it is off, it has no network, or it cannot reach a Parano1d node\./);
  assert.match(entry, /needs the project's terminal tools, set up once there with scripts\/live\/setup\.sh \(it makes the passphrase file that claim\.sh asks for\), a synced Parano1d node, and a copy of this swap's folder/);
  assert.match(entry, /your swap file, which holds your Ethereum swap key sealed under the program's passphrase/);
  assert.doesNotMatch(entry, /neither holds a key|no password/, "the copy does hold the sealed key, and the setup makes a passphrase file");
  assert.match(entry, /The close needs no coins\./);
  assert.match(entry, /run one tick to read the secret from Ethereum; run claim\.sh and check that the recipient it prints is your own address; then run claim\.sh --submit\./);
  assert.match(entry, /open the swap and use Record a close made elsewhere; the program checks the close on the chain before it records it\./);
  assert.doesNotMatch(entry, /tick --closed-by|--apply/, "the terminal command is not what the program's help sends a person to");
});

test("help: the address history's limit is said in one paragraph", () => {
  const p = HELP_PARAGRAPHS.find((x) => /history of your payout addresses/.test(x));
  assert.ok(p);
  assert.match(p, /sealed with the same key store/);
  assert.match(p, /a check against slips, not against malware/);
});

test("help: the dialog carries every paragraph, in order, and the text names no person, place, tool or model", () => {
  const m = helpMessage();
  assert.equal(m.title, HELP_TITLE);
  assert.equal(m.detail, all);
  assert.doesNotMatch(all, /co-authored|C:\\Users|\/home\//i);
  for (const p of HELP_PARAGRAPHS) assert.equal(typeof p, "string");
});
