"use strict";
// The clipboard read-back (launch spec 4.3, desktop side): the main process reads the clipboard through electron's clipboard.readText and the program
// answers a boolean or null, never the text. The page has no clipboard-read permission (hardening.js; checked in window.test.js).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createProgram } = require("../lib/program");
const { makeEnv } = require("./shell-fixture");

const ADDR = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const NOID = "o1lqvrmvsyl7mkt3cptkz3c965ujt5ce6mjawxwwxe7mgn36mjzt8sn69xw2";

function prog(readClipboard) {
  return createProgram({
    version: "0.1.5",
    dataDir: "/home/u/.local/share/No1d Swap",
    platform: "linux",
    env: {},
    execPath: "/opt/No1d Swap/no1d-swap",
    resourcesPath: "/opt/No1d Swap/resources",
    rootDir: "/stage",
    isPackaged: true,
    homedir: "/home/u",
    fs: { existsSync: () => true, readdirSync: () => [] },
    vault: {},
    folderGuard: () => ({ ok: true, why: null }),
    makeOwnerOnlyDir: () => {},
    programsettings: { load: () => ({}) },
    nodeCheck: { status: () => ({}) },
    notify: () => {},
    onAtStake: () => {},
    chooseFile: async () => null,
    readClipboard,
  });
}

test("true when the clipboard holds exactly the value; false when it holds anything else; the answer is a boolean and nothing more", async () => {
  let text = ADDR;
  const p = prog(() => text);
  assert.strictEqual(await p.clipboardMatches(ADDR), true);
  text = ADDR.toLowerCase();
  assert.strictEqual(await p.clipboardMatches(ADDR), false, "a changed letter case is a change");
  text = `${ADDR.slice(0, -1)}9`;
  assert.strictEqual(await p.clipboardMatches(ADDR), false);
  text = "o1" + "q".repeat(58);
  assert.strictEqual(await p.clipboardMatches(NOID), false);
  text = "";
  assert.strictEqual(await p.clipboardMatches(ADDR), false, "an emptied clipboard is a change");
  text = `${ADDR}${"x".repeat(100000)}`;
  assert.strictEqual(await p.clipboardMatches(ADDR), false);
  text = ` \t${NOID}\r\n`;
  assert.strictEqual(await p.clipboardMatches(NOID), true, "white space around the copy is not a change");
  text = "12.5";
  assert.strictEqual(await p.clipboardMatches("12.5"), true, "an amount works the same");
});

test("null when it cannot be checked: no reader, a reader that throws, a reader that gives no text, a value that is not text or is too long", async () => {
  assert.strictEqual(await prog(undefined).clipboardMatches(ADDR), null);
  assert.strictEqual(await prog(() => { throw new Error("no clipboard"); }).clipboardMatches(ADDR), null);
  for (const bad of [undefined, null, 5, {}, ["x"]]) assert.strictEqual(await prog(() => bad).clipboardMatches(ADDR), null);
  const p = prog(() => ADDR);
  for (const v of ["", undefined, null, 5, {}, "x".repeat(129)]) assert.strictEqual(await p.clipboardMatches(v), null);
});

test("the answer never holds the clipboard's text, in any state", async () => {
  const canary = "CLIPBOARD-CANARY-secret-text";
  const p = prog(() => canary);
  const seen = [await p.clipboardMatches(ADDR), await p.clipboardMatches(canary), await prog(() => { throw new Error(canary); }).clipboardMatches(ADDR)];
  assert.ok(seen.every((v) => v === true || v === false || v === null));
  assert.ok(!JSON.stringify(seen).includes("CANARY"));
  // the program object has no other function that returns what the clipboard holds
  const names = Object.keys(p).filter((k) => /clip/i.test(k));
  assert.deepEqual(names, ["clipboardMatches"]);
});

test("the shell hands the program electron's clipboard.readText and nothing else of the clipboard", async () => {
  const e = makeEnv({ electron: { clipboardText: ADDR } });
  try {
    await e.shell.start();
    const p = e.program();
    assert.strictEqual(await p.clipboardMatches(ADDR), true);
    e.electron.clipboard.text = NOID;
    assert.strictEqual(await p.clipboardMatches(ADDR), false);
    assert.equal(e.electron.clipboard.reads, 2, "one read for each question");
    assert.strictEqual(await p.clipboardMatches(NOID), true);
  } finally {
    e.cleanup();
  }
});

test("through the shell: a clipboard that throws, or an electron without one, answers null", async () => {
  const a = makeEnv({ electron: { clipboardThrows: true } });
  try {
    await a.shell.start();
    assert.strictEqual(await a.program().clipboardMatches(ADDR), null);
  } finally {
    a.cleanup();
  }
  const b = makeEnv();
  try {
    delete b.electron.clipboard;
    await b.shell.start();
    assert.strictEqual(await b.program().clipboardMatches(ADDR), null);
  } finally {
    b.cleanup();
  }
});

test("only the main process reads the clipboard: no library of the program names it except shell.js (the reader) and program.js (the check), and the pages' permission is still denied", () => {
  const lib = path.join(__dirname, "..", "lib");
  const users = fs.readdirSync(lib).filter((n) => n.endsWith(".js") && /clipboard/i.test(fs.readFileSync(path.join(lib, n), "utf8")));
  assert.deepEqual(users.sort(), ["hardening.js", "program.js", "shell.js"].filter((n) => users.includes(n)).sort());
  assert.ok(users.includes("shell.js") && users.includes("program.js"));
  const shellSrc = fs.readFileSync(path.join(lib, "shell.js"), "utf8");
  assert.ok(!/clipboard\.(writeText|write\(|readBuffer|readHTML|readRTF|clear)/.test(shellSrc), "shell.js only reads text");
  assert.ok(!/clipboard/.test(fs.readFileSync(path.join(lib, "secretwin.js"), "utf8")), "the secret window never touches the clipboard");
});
