"use strict";
// Build spec #3 and #4, the desktop side: `program.saveCopy(kind, bytes)` and `program.chooseInvitationFile()`. Real files in a temporary folder; the native dialogs are faked.
const test = require("node:test");
const assert = require("node:assert/strict");
const nodefs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createProgram, ProgramError } = require("../lib/program");

const BYTES = Buffer.from('{"params":{}}\n');

function make(over = {}) {
  const root = nodefs.realpathSync.native(nodefs.mkdtempSync(path.join(os.tmpdir(), "no1d-dlg-")));
  const dataDir = path.join(root, "data");
  const out = path.join(root, "out");
  nodefs.mkdirSync(path.join(dataDir, "runs", "swap1"), { recursive: true });
  nodefs.mkdirSync(out);
  const dataFile = path.join(dataDir, "runs", "swap1", "alice.swap.json");
  nodefs.writeFileSync(dataFile, "SECRET-OF-ANOTHER-SWAP");
  const calls = { save: [], open: 0 };
  const state = { saveAnswer: path.join(out, "copy.json"), openAnswer: null, gate: null };
  const fs = { ...nodefs, existsSync: () => true };
  const o = {
    version: "0.1.0",
    dataDir,
    platform: process.platform,
    env: { SystemRoot: process.env.SystemRoot || "C:\\Windows" },
    execPath: path.join(root, "app"),
    resourcesPath: path.join(root, "resources"),
    rootDir: root,
    isPackaged: false,
    homedir: root,
    fs,
    vault: {},
    folderGuard: () => ({ ok: true }),
    makeOwnerOnlyDir: () => {},
    programsettings: { load: () => ({}) },
    nodeCheck: { status: () => ({}) },
    notify: () => {},
    onAtStake: () => {},
    chooseFile: async () => null,
    saveFile: async (kind) => {
      calls.save.push(kind);
      if (state.gate) await state.gate;
      if (state.throws) throw new Error("the dialog broke");
      return typeof state.saveAnswer === "function" ? state.saveAnswer() : state.saveAnswer;
    },
    chooseInvitation: async () => {
      calls.open++;
      if (state.gate) await state.gate;
      if (state.throws) throw new Error("the dialog broke");
      return state.openAnswer;
    },
    ...over,
  };
  return {
    program: createProgram(o),
    calls,
    state,
    root,
    dataDir,
    out,
    dataFile,
    cleanup: () => nodefs.rmSync(root, { recursive: true, force: true }),
  };
}

const read = (f) => nodefs.readFileSync(f);
const dataUntouched = (e) => assert.equal(read(e.dataFile).toString(), "SECRET-OF-ANOTHER-SWAP");

test("saveCopy writes the bytes to the chosen path and says saved; the dialog is asked for the kind", async () => {
  const e = make();
  try {
    assert.equal(await e.program.saveCopy("bundle", BYTES), "saved");
    assert.deepEqual(e.calls.save, ["bundle"]);
    assert.ok(read(path.join(e.out, "copy.json")).equals(BYTES));
    e.state.saveAnswer = path.join(e.out, "invitation.json");
    assert.equal(await e.program.saveCopy("invitation", Buffer.from("x")), "saved");
    assert.deepEqual(e.calls.save, ["bundle", "invitation"]);
    assert.equal(read(path.join(e.out, "invitation.json")).toString(), "x");
    // an existing file the person chose in the save dialog is replaced (the dialog asked them)
    nodefs.writeFileSync(path.join(e.out, "old.json"), "old");
    e.state.saveAnswer = path.join(e.out, "old.json");
    assert.equal(await e.program.saveCopy("bundle", BYTES), "saved");
    assert.ok(read(path.join(e.out, "old.json")).equals(BYTES));
  } finally {
    e.cleanup();
  }
});

test("saveCopy: a cancelled dialog (null, empty, a throw) writes nothing and says cancelled", async () => {
  const e = make();
  try {
    for (const answer of [null, "", undefined, 5]) {
      e.state.saveAnswer = answer;
      assert.equal(await e.program.saveCopy("bundle", BYTES), "cancelled", String(answer));
    }
    e.state.throws = true;
    assert.equal(await e.program.saveCopy("bundle", BYTES), "cancelled");
    assert.deepEqual(nodefs.readdirSync(e.out), []);
    // and the flag is free again afterwards
    e.state.throws = false;
    e.state.saveAnswer = path.join(e.out, "copy.json");
    assert.equal(await e.program.saveCopy("bundle", BYTES), "saved");
  } finally {
    e.cleanup();
  }
});

test("saveCopy refuses an unknown kind, an empty buffer, an oversized buffer and bytes that are not a Buffer, without opening a dialog", async () => {
  const e = make();
  try {
    await assert.rejects(e.program.saveCopy("other", BYTES), (x) => x instanceof ProgramError && /unknown file kind/.test(x.message));
    await assert.rejects(e.program.saveCopy(undefined, BYTES), ProgramError);
    await assert.rejects(e.program.saveCopy("__proto__", BYTES), ProgramError);
    await assert.rejects(e.program.saveCopy("bundle", Buffer.alloc(0)), ProgramError);
    await assert.rejects(e.program.saveCopy("bundle", Buffer.alloc(1048577)), ProgramError);
    await assert.rejects(e.program.saveCopy("bundle", "text"), ProgramError);
    await assert.rejects(e.program.saveCopy("bundle", new Uint8Array(3)), ProgramError);
    await assert.rejects(e.program.saveCopy("bundle", null), ProgramError);
    assert.deepEqual(e.calls.save, []);
    // the limits themselves are allowed
    assert.equal(await e.program.saveCopy("bundle", Buffer.alloc(1)), "saved");
    e.state.saveAnswer = path.join(e.out, "big.json");
    assert.equal(await e.program.saveCopy("bundle", Buffer.alloc(1048576, 0x61)), "saved");
    assert.equal(nodefs.statSync(path.join(e.out, "big.json")).size, 1048576);
  } finally {
    e.cleanup();
  }
});

test("saveCopy refuses a relative path and writes nothing", async () => {
  const e = make();
  const name = `no1d-relative-${process.pid}.json`;
  try {
    for (const rel of [name, path.join("sub", name), `.${path.sep}${name}`, path.join("..", name)]) {
      e.state.saveAnswer = rel;
      assert.equal(await e.program.saveCopy("bundle", BYTES), "refused", rel);
      assert.ok(!nodefs.existsSync(path.resolve(rel)), `${rel} was not written relative to the working folder`);
    }
  } finally {
    nodefs.rmSync(path.resolve(name), { force: true });
    nodefs.rmSync(path.resolve("..", name), { force: true });
    e.cleanup();
  }
});

test("saveCopy refuses a place inside the program's data folder: a file of it, a new file in it, the folder itself; a sibling with a similar name is fine", async () => {
  const e = make();
  try {
    e.state.saveAnswer = e.dataFile;
    assert.equal(await e.program.saveCopy("bundle", BYTES), "refused");
    dataUntouched(e);
    e.state.saveAnswer = path.join(e.dataDir, "runs", "swap1", "new.json");
    assert.equal(await e.program.saveCopy("bundle", BYTES), "refused");
    assert.ok(!nodefs.existsSync(path.join(e.dataDir, "runs", "swap1", "new.json")));
    e.state.saveAnswer = path.join(e.dataDir, "settings.json");
    assert.equal(await e.program.saveCopy("bundle", BYTES), "refused");
    e.state.saveAnswer = path.join(e.dataDir, "runs", "..", "runs", "swap1", "x.json"); // a path that climbs and comes back
    assert.equal(await e.program.saveCopy("bundle", BYTES), "refused");
    e.state.saveAnswer = e.dataDir; // the folder itself (not a file: the write fails or it is refused, never saved)
    assert.notEqual(await e.program.saveCopy("bundle", BYTES), "saved");
    // a sibling that only shares the start of the name
    const sibling = `${e.dataDir}-other`;
    nodefs.mkdirSync(sibling);
    e.state.saveAnswer = path.join(sibling, "copy.json");
    assert.equal(await e.program.saveCopy("bundle", BYTES), "saved");
    // a path that merely starts with ".." in a file name is not a climb
    e.state.saveAnswer = path.join(e.out, "..copy.json");
    assert.equal(await e.program.saveCopy("bundle", BYTES), "saved");
    dataUntouched(e);
  } finally {
    e.cleanup();
  }
});

test("saveCopy compares without regard to letter case on Windows", { skip: process.platform !== "win32" }, async () => {
  const e = make();
  try {
    e.state.saveAnswer = path.join(e.dataDir.toUpperCase(), "runs", "swap1", "alice.swap.json");
    assert.equal(await e.program.saveCopy("bundle", BYTES), "refused");
    e.state.saveAnswer = path.join(e.dataDir.toLowerCase(), "runs", "swap1", "NEW.json");
    assert.equal(await e.program.saveCopy("bundle", BYTES), "refused");
    dataUntouched(e);
  } finally {
    e.cleanup();
  }
});

test("saveCopy refuses a place reached through a linked parent folder, and a destination that is a link or a second name of a data file", async (t) => {
  const e = make();
  try {
    // a folder link (a junction on Windows) that points into the data folder
    const link = path.join(e.out, "link");
    nodefs.symlinkSync(path.join(e.dataDir, "runs", "swap1"), link, "junction");
    e.state.saveAnswer = path.join(link, "alice.swap.json");
    assert.equal(await e.program.saveCopy("bundle", BYTES), "refused");
    e.state.saveAnswer = path.join(link, "fresh.json");
    assert.equal(await e.program.saveCopy("bundle", BYTES), "refused");
    assert.ok(!nodefs.existsSync(path.join(e.dataDir, "runs", "swap1", "fresh.json")));
    dataUntouched(e);
    // a second name (hard link) of a data file
    nodefs.linkSync(e.dataFile, path.join(e.out, "hard.json"));
    e.state.saveAnswer = path.join(e.out, "hard.json");
    assert.equal(await e.program.saveCopy("bundle", BYTES), "refused");
    dataUntouched(e);
    // a file link, where the system lets us make one
    try {
      nodefs.symlinkSync(e.dataFile, path.join(e.out, "soft.json"), "file");
    } catch {
      t.diagnostic("file symbolic links cannot be made here: that case was skipped");
      return;
    }
    e.state.saveAnswer = path.join(e.out, "soft.json");
    assert.equal(await e.program.saveCopy("bundle", BYTES), "refused");
    dataUntouched(e);
  } finally {
    e.cleanup();
  }
});

test("saveCopy: a parent folder that does not exist, a folder where the file should be, and a missing dialog are refused", async () => {
  const e = make();
  try {
    e.state.saveAnswer = path.join(e.out, "no-such-folder", "copy.json");
    assert.equal(await e.program.saveCopy("bundle", BYTES), "refused");
    nodefs.mkdirSync(path.join(e.out, "adir"));
    e.state.saveAnswer = path.join(e.out, "adir");
    assert.equal(await e.program.saveCopy("bundle", BYTES), "refused");
    const none = make({ saveFile: undefined });
    try {
      assert.equal(await none.program.saveCopy("bundle", BYTES), "refused");
    } finally {
      none.cleanup();
    }
  } finally {
    e.cleanup();
  }
});

test("a second call while a dialog is open answers busy and opens no dialog; the file dialogs share the one slot", async () => {
  const e = make();
  try {
    let release;
    e.state.gate = new Promise((r) => (release = r));
    const first = e.program.saveCopy("bundle", BYTES);
    assert.equal(await e.program.saveCopy("invitation", BYTES), "busy");
    assert.equal(await e.program.chooseInvitationFile(), null, "no second dialog of the other kind either");
    assert.deepEqual(e.calls.save, ["bundle"]);
    assert.equal(e.calls.open, 0);
    release();
    assert.equal(await first, "saved");
    assert.ok(!nodefs.existsSync(path.join(e.out, "invitation.json")));
    // free again
    e.state.gate = null;
    e.state.saveAnswer = path.join(e.out, "second.json");
    assert.equal(await e.program.saveCopy("bundle", BYTES), "saved");
    // and the other way round
    let release2;
    e.state.gate = new Promise((r) => (release2 = r));
    e.state.openAnswer = path.join(e.out, "copy.json");
    const open = e.program.chooseInvitationFile();
    assert.equal(await e.program.saveCopy("bundle", BYTES), "busy");
    release2();
    assert.equal(await open, e.state.openAnswer);
  } finally {
    e.cleanup();
  }
});

test("chooseInvitationFile: an absolute path from the dialog, else null (cancel, relative, a throw, no dialog)", async () => {
  const e = make();
  try {
    e.state.openAnswer = path.join(e.out, "bob.json");
    assert.equal(await e.program.chooseInvitationFile(), path.join(e.out, "bob.json"));
    for (const a of [null, "", "bob.json", path.join("sub", "bob.json"), 7, undefined]) {
      e.state.openAnswer = a;
      assert.equal(await e.program.chooseInvitationFile(), null, String(a));
    }
    e.state.throws = true;
    assert.equal(await e.program.chooseInvitationFile(), null);
    e.state.throws = false;
    e.state.openAnswer = path.join(e.out, "bob.json");
    assert.equal(await e.program.chooseInvitationFile(), path.join(e.out, "bob.json"), "the slot is free again after a throw");
    const none = make({ chooseInvitation: undefined });
    try {
      assert.equal(await none.program.chooseInvitationFile(), null);
    } finally {
      none.cleanup();
    }
  } finally {
    e.cleanup();
  }
});

test("saveCopy answers one of four words, never a path", async () => {
  const e = make();
  try {
    const seen = new Set();
    seen.add(await e.program.saveCopy("bundle", BYTES));
    e.state.saveAnswer = null;
    seen.add(await e.program.saveCopy("bundle", BYTES));
    e.state.saveAnswer = "relative.json";
    seen.add(await e.program.saveCopy("bundle", BYTES));
    for (const w of seen) assert.ok(["saved", "cancelled", "busy", "refused"].includes(w), w);
  } finally {
    e.cleanup();
  }
});
