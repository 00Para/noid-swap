"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { makeEnv } = require("./shell-fixture");

test("a second instance quits at once and starts nothing", async () => {
  const e = makeEnv({ electron: { singleInstance: false } });
  try {
    const r = await e.shell.start();
    assert.equal(r.state, "second_instance");
    assert.deepEqual(e.shell.trace, ["lock"]);
    assert.ok(e.electron.calls.some((c) => c.who === "app" && c.name === "quit"));
    assert.equal(e.rec.length, 0, "no module of the program was touched");
    assert.equal(e.electron.windows.length, 0);
    assert.equal(e.electron.app.paths.userData, undefined);
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
