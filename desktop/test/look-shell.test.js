"use strict";
// The look of the two windows of the program: both are painted with the page's dark ground from the first frame (no white flash), the fallback page is dark with the same words, and the
// secret window's sheet is dark only, with system type, no file to load and one stylesheet, with the recovery code as a numbered grid of 1 to 7 and 8 to 14.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createFakeElectron } = require("./fake-electron");
const { createGuard } = require("../lib/hardening");
const { createMainWindow, GONE_PAGE, WINDOW_BACKGROUND } = require("../lib/window");
const { createSecretUi } = require("../lib/secretwin");

const SECRET = path.join(__dirname, "..", "secret");
const css = fs.readFileSync(path.join(SECRET, "secret.css"), "utf8");
const tick = () => new Promise((r) => setImmediate(r));

test("the ground of the page is one colour, the one of the stylesheet's own --bg", () => {
  assert.equal(WINDOW_BACKGROUND, "#050908");
  const uiCss = fs.readFileSync(path.join(__dirname, "..", "..", "ui", "app", "operator.css"), "utf8");
  assert.match(uiCss, /--bg: #050908;/);
  assert.match(css, /--bg: #050908;/);
});

test("the main window is created with the dark ground, and so is the secret window", async () => {
  const electron = createFakeElectron({ isPackaged: true });
  const guard = createGuard(electron);
  guard.install();
  const ctl = createMainWindow({ electron, guard, isPackaged: true, url: "no1d://app/#token=tok-abc", hidden: false, shouldHide: () => false });
  assert.equal(ctl.window.options.backgroundColor, "#050908");
  const ui = createSecretUi({ electron, guard, preloadPath: path.join(__dirname, "..", "preload-secret.js"), htmlPath: path.join(SECRET, "secret.html"), getParent: () => null });
  const p = ui.askText({ kind: "restore" });
  let w = null;
  for (let i = 0; i < 20 && !w; i++) {
    w = electron.windows.find((x) => x !== ctl.window && x.webContents.sent.length);
    await tick();
  }
  assert.ok(w, "the secret window opened");
  assert.equal(w.options.backgroundColor, "#050908");
  // the other options of that window are unchanged
  assert.equal(w.options.width, 540);
  assert.equal(w.options.height, 640);
  assert.equal(w.options.webPreferences.devTools, false);
  assert.equal(w.contentProtection, true);
  w.emit("closed");
  await p.catch(() => {});
});

test("the page shown after a second loss is dark, with the same words and no script", () => {
  const html = decodeURIComponent(GONE_PAGE);
  assert.match(html, /<h1>This window stopped working<\/h1><p>Quit No1d Swap from its tray icon or its menu, then open it again\.<\/p>/);
  assert.match(html, /background:#050908;color:#e6edea/);
  assert.doesNotMatch(html, /<script/i);
});

test("the secret window's sheet is dark only, in system type, with nothing to load and nothing for a light theme", () => {
  assert.match(css, /color-scheme: dark;/);
  assert.doesNotMatch(css, /color-scheme: light|prefers-color-scheme/);
  assert.ok(!/@import|url\(/i.test(css));
  assert.ok(!/https?:|\/\/[a-z]/i.test(css.replace(/\/\*[\s\S]*?\*\//g, "")));
  // every font family is a system one: no web font is named, and none can be loaded
  const families = [...css.matchAll(/font(?:-family)?:[^;]*;/g)].map((m) => m[0]);
  assert.ok(families.length >= 4);
  for (const f of families) assert.doesNotMatch(f, /Space Grotesk|JetBrains|@font-face/i);
  assert.doesNotMatch(css, /@font-face/);
  assert.match(css, /system-ui/);
  assert.match(css, /ui-monospace/);
  // one stylesheet, linked once
  const html = fs.readFileSync(path.join(SECRET, "secret.html"), "utf8");
  assert.equal((html.match(/<link /g) || []).length, 1);
  assert.match(html, /<link rel="stylesheet" href="secret\.css">/);
  assert.deepEqual(fs.readdirSync(SECRET).sort(), ["secret.css", "secret.html", "secret.js"]);
});

test("the recovery code is a grid of two columns filled down (1 to 7, then 8 to 14), numbered by a counter, and cannot be selected", () => {
  assert.match(css, /\.code \{[^}]*display: grid;[^}]*grid-auto-flow: column;[^}]*grid-template-rows: repeat\(7, auto\);/);
  assert.match(css, /\.code \{[^}]*counter-reset: g;/);
  assert.match(css, /\.group \{[^}]*counter-increment: g;/);
  assert.match(css, /\.group::before \{[^}]*content: counter\(g\);/);
  assert.match(css, /\.code \{[^}]*user-select: none;/);
  // the page draws the fourteen groups as fourteen spans of the one box, so the grid numbers them
  const page = require("../secret/secret.js");
  const model = page.buildModel({ type: "show", groups: Array.from({ length: 14 }, (_, i) => "g" + i) });
  assert.equal(model.code.length, 14);
});

test("the one button of the secret window is amber (the program waits on the person) and the other is quiet", () => {
  assert.match(css, /\nbutton \{[^}]*background: var\(--due\);[^}]*color: var\(--on-due\);/);
  assert.match(css, /button\.secondary \{[^}]*background: var\(--raise\);/);
  assert.match(css, /input:focus-visible, button:focus-visible \{\s*outline: 2px solid var\(--fg\);/);
});
