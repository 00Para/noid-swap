"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { makeEnv } = require("./shell-fixture");

test("a second instance quits at once and starts nothing", async () => {
  const e = makeEnv({ electron: { singleInstance: false } });
  try {
    const r = await e.shell.start();
    assert.equal(r.state, "second_instance");
    // the lock is asked for after userData is set, so the lock's own folder is the program's, not Electron's default one
    assert.deepEqual(e.shell.trace, ["cmdline", "setPath", "lock"]);
    assert.ok(e.electron.calls.some((c) => c.who === "app" && c.name === "quit"));
    assert.deepEqual(e.rec.filter((x) => x !== "defaultKnownFolder"), ["dataDirFor"], "only the data folder's name was worked out; nothing was made, opened or started");
    assert.equal(e.electron.windows.length, 0);
    assert.equal(e.electron.app.paths.userData, path.join(e.dataDir, "electron"));
    assert.ok(!fs.existsSync(e.dataDir), "no folder was made");
    assert.equal(e.electron.app.listenerCount("second-instance"), 0);
  } finally {
    e.cleanup();
  }
});

test("second-instance shows and focuses the existing window, also when it was started hidden", async () => {
  const e = makeEnv({ argv: ["x.exe", "--hidden"] });
  try {
    await e.shell.start();
    const w = e.electron.windows[0];
    assert.equal(w.visible, false);
    e.electron.app.emit("second-instance", {}, ["x.exe"], "C:\\", {});
    assert.equal(w.visible, true);
    assert.equal(w.focused, true);
  } finally {
    e.cleanup();
  }
});

test("second-instance before the window exists does nothing and does not throw", async () => {
  const e = makeEnv();
  try {
    const started = e.shell.start();
    e.electron.app.emit("second-instance");
    await started;
  } finally {
    e.cleanup();
  }
});
