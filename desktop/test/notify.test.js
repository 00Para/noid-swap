"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createFakeElectron } = require("./fake-electron");
const { createNotifier, TEXTS, CRASH_TEXT } = require("../lib/notify");

const ID = "d".repeat(32);

test("fixed texts only, one per kind per swap per ten minutes", () => {
  const electron = createFakeElectron();
  let t = 0;
  const n = createNotifier({ Notification: electron.Notification, now: () => t });
  assert.equal(n.notify("alert", ID), true);
  assert.equal(n.notify("alert", ID), false, "rate limited");
  assert.equal(n.notify("alarm", ID), true, "another kind");
  assert.equal(n.notify("alert", "e".repeat(32)), true, "another swap");
  t += 10 * 60 * 1000 - 1;
  assert.equal(n.notify("alert", ID), false);
  t += 1;
  assert.equal(n.notify("alert", ID), true);
  assert.deepEqual(electron.notifications.map((x) => x.options.body), [TEXTS.alert, TEXTS.alarm, TEXTS.alert, TEXTS.alert]);
  assert.equal(TEXTS.alert, "A swap needs a look.");
  assert.equal(TEXTS.alarm, "A swap needs you now.");
  assert.equal(TEXTS.needs_you, "A swap is waiting for you.");
  assert.equal(TEXTS.done, "A swap has finished.");
});

test("an unknown kind is ignored; a bad swap id never reaches the text", () => {
  const electron = createFakeElectron();
  const n = createNotifier({ Notification: electron.Notification, now: () => 0 });
  assert.equal(n.notify("tick line: 5 NOID", ID), false);
  assert.equal(n.notify("done", "../../x"), true);
  assert.equal(electron.notifications.length, 1);
  assert.ok(!JSON.stringify(electron.notifications[0].options).includes(".."));
});

test("a click calls back with the swap id; the notice is shown", () => {
  const electron = createFakeElectron();
  const clicks = [];
  const n = createNotifier({ Notification: electron.Notification, now: () => 0, onClick: (id) => clicks.push(id) });
  n.notify("needs_you", ID);
  const note = electron.notifications[0];
  assert.equal(note.shown, true);
  note.emit("click");
  assert.deepEqual(clicks, [ID]);
});

test("the crash notice is not rate limited and names no swap", () => {
  const electron = createFakeElectron();
  const n = createNotifier({ Notification: electron.Notification, now: () => 0 });
  n.crashNotice();
  n.crashNotice();
  assert.equal(electron.notifications.length, 2);
  assert.equal(electron.notifications[0].options.body, CRASH_TEXT);
});

test("no notification when the system does not support them", () => {
  const electron = createFakeElectron({ notificationsSupported: false });
  const n = createNotifier({ Notification: electron.Notification, now: () => 0 });
  assert.equal(n.notify("done", ID), false);
  assert.equal(electron.notifications.length, 0);
});

test("the tray notice is fixed text that names the tray's Quit", () => {
  const { TRAY_TEXT } = require("../lib/notify");
  const electron = createFakeElectron();
  const n = createNotifier({ Notification: electron.Notification, now: () => 0 });
  assert.equal(n.trayNotice(), true);
  assert.equal(electron.notifications[0].options.body, TRAY_TEXT);
  assert.match(TRAY_TEXT, /still running in the tray because a swap is in progress\. To quit, use Quit in the tray menu\./);
});
