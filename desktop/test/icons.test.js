"use strict";
// The program's icons: the files are valid PNG and ICO of the expected sizes, carry no metadata, have transparent corners, are named by
// the builder configuration and are shipped by the stage, and the windows are given the window icon.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const { createFakeElectron } = require("./fake-electron");
const { createGuard } = require("../lib/hardening");
const { createMainWindow } = require("../lib/window");
const { createSecretUi } = require("../lib/secretwin");
const { makeEnv } = require("./shell-fixture");

const DESKTOP = path.join(__dirname, "..");
const ASSETS = path.join(DESKTOP, "assets");
const BUILD = path.join(DESKTOP, "build");
const builderText = fs.readFileSync(path.join(DESKTOP, "electron-builder.yml"), "utf8");
const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

/** Chunk types and the decoded 8-bit RGBA pixels of a PNG (colour type 6, not interlaced). */
function readPng(buf) {
  assert.ok(buf.subarray(0, 8).equals(SIGNATURE), "PNG signature");
  let p = 8;
  const types = [];
  const idat = [];
  let w = 0;
  let h = 0;
  while (p < buf.length) {
    const len = buf.readUInt32BE(p);
    const type = buf.toString("latin1", p + 4, p + 8);
    const data = buf.subarray(p + 8, p + 8 + len);
    types.push(type);
    if (type === "IHDR") {
      w = data.readUInt32BE(0);
      h = data.readUInt32BE(4);
      assert.equal(data[8], 8, "8 bits per channel");
      assert.equal(data[9], 6, "RGBA");
      assert.equal(data[12], 0, "not interlaced");
    } else if (type === "IDAT") idat.push(data);
    p += 12 + len;
  }
  assert.equal(p, buf.length, "no trailing bytes");
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * 4;
  const px = Buffer.alloc(stride * h);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)];
    const line = Buffer.from(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)));
    for (let i = 0; i < stride; i++) {
      const a = i >= 4 ? line[i - 4] : 0;
      const b = prev[i];
      const c = i >= 4 ? prev[i - 4] : 0;
      if (f === 1) line[i] = (line[i] + a) & 255;
      else if (f === 2) line[i] = (line[i] + b) & 255;
      else if (f === 3) line[i] = (line[i] + ((a + b) >> 1)) & 255;
      else if (f === 4) {
        const q = a + b - c;
        const pa = Math.abs(q - a);
        const pb = Math.abs(q - b);
        const pc = Math.abs(q - c);
        line[i] = (line[i] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255;
      }
    }
    line.copy(px, y * stride);
    prev = line;
  }
  return { w, h, types, alpha: (x, y) => px[(y * w + x) * 4 + 3], rgb: (x, y) => [...px.subarray((y * w + x) * 4, (y * w + x) * 4 + 3)] };
}
const read = (...p) => fs.readFileSync(path.join(...p));

test("the icons exist at the expected sizes, carry no metadata chunks, and have transparent corners", () => {
  const specs = [
    [BUILD, "icon.png", 1024],
    [ASSETS, "icon.png", 256],
    [ASSETS, "tray.png", 32],
    [ASSETS, "trayTemplate.png", 16],
    [ASSETS, "trayTemplate@2x.png", 32],
  ];
  for (const [dir, name, size] of specs) {
    const img = readPng(read(dir, name));
    assert.equal(img.w, size, `${name} width`);
    assert.equal(img.h, size, `${name} height`);
    assert.deepEqual(img.types.filter((t, i) => t !== "IDAT" || i === 0 || img.types[i - 1] !== "IDAT"), ["IHDR", "IDAT", "IEND"], `${name}: only the three required chunks (no text, time or colour-profile chunk)`);
    for (const [x, y] of [[0, 0], [size - 1, 0], [0, size - 1], [size - 1, size - 1]]) assert.equal(img.alpha(x, y), 0, `${name}: corner (${x},${y}) is fully transparent`);
  }
});

test("the Mac icon is a 1024 canvas with the dark tile about 824 wide and centred, and the margin is transparent", () => {
  const img = readPng(read(BUILD, "icon.png"));
  assert.equal(img.alpha(512, 512) > 0, true);
  // the tile's left and right edges at mid height: opaque from 100 to 923, transparent well outside the soft shadow
  assert.equal(img.alpha(101, 512), 255);
  assert.equal(img.alpha(922, 512), 255);
  assert.equal(img.alpha(20, 512), 0);
  assert.equal(img.alpha(1003, 512), 0);
  assert.equal(img.alpha(512, 20), 0);
  // dark ground at a point inside the tile and away from the mark
  const [r, g, b] = img.rgb(160, 512);
  assert.ok(r < 40 && g < 40 && b < 40, "the tile is dark");
});

test("the tray icons: the Windows one is coloured, the macOS templates are black with alpha only", () => {
  const win = readPng(read(ASSETS, "tray.png"));
  let lime = false;
  for (let y = 0; y < 32 && !lime; y++) for (let x = 0; x < 32; x++) if (win.alpha(x, y) === 255) { const [r, g, b] = win.rgb(x, y); if (g > 200 && r > 120 && b < 140) { lime = true; break; } }
  assert.ok(lime, "tray.png holds the mark's own colour");
  for (const [name, size] of [["trayTemplate.png", 16], ["trayTemplate@2x.png", 32]]) {
    const img = readPng(read(ASSETS, name));
    let drawn = 0;
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      if (img.alpha(x, y) > 0) {
        drawn += 1;
        assert.deepEqual(img.rgb(x, y), [0, 0, 0], `${name}: every drawn pixel is black`);
      }
    }
    assert.ok(drawn > size * 2, `${name} draws the mark`);
  }
});

test("icon.ico holds a PNG entry for 16, 20, 24, 32, 40, 48, 64, 128 and 256, each of its declared size", () => {
  const ico = read(BUILD, "icon.ico");
  assert.equal(ico.readUInt16LE(0), 0);
  assert.equal(ico.readUInt16LE(2), 1);
  const n = ico.readUInt16LE(4);
  const sizes = [];
  for (let i = 0; i < n; i++) {
    const o = 6 + 16 * i;
    const w = ico[o] || 256;
    const h = ico[o + 1] || 256;
    assert.equal(w, h);
    assert.equal(ico.readUInt16LE(o + 6), 32, "32 bits per pixel");
    const len = ico.readUInt32LE(o + 8);
    const off = ico.readUInt32LE(o + 12);
    assert.ok(off + len <= ico.length);
    const img = readPng(ico.subarray(off, off + len));
    assert.equal(img.w, w);
    assert.equal(img.h, h);
    assert.deepEqual(img.types.filter((t, j) => t !== "IDAT" || j === 0 || img.types[j - 1] !== "IDAT"), ["IHDR", "IDAT", "IEND"]);
    // a rounded tile: the corner pixel is mostly transparent, the middle is opaque
    assert.ok(img.alpha(0, 0) < 128, `${w}: corner mostly transparent`);
    assert.ok(img.alpha(w >> 1, h >> 1) > 0);
    sizes.push(w);
  }
  assert.deepEqual(sizes, [16, 20, 24, 32, 40, 48, 64, 128, 256]);
  // the last entry ends the file: no stray bytes
  const last = 6 + 16 * (n - 1);
  assert.equal(ico.readUInt32LE(last + 12) + ico.readUInt32LE(last + 8), ico.length);
  // the 256 entry is the window icon, byte for byte
  assert.ok(ico.subarray(ico.readUInt32LE(last + 12)).equals(read(ASSETS, "icon.png")));
});

test("builder: the icons are named for the folder, Windows, the installer and the Mac disk image", () => {
  const body = builderText.replace(/^\s*#.*\n/gm, "");
  assert.match(body, /^ {2}buildResources: build$/m);
  assert.match(body, /^win:\n {2}icon: build\/icon\.ico$/m);
  assert.match(body, /^nsis:\n {2}installerIcon: build\/icon\.ico\n {2}uninstallerIcon: build\/icon\.ico$/m);
  assert.match(body, /^mac:\n {2}icon: build\/icon\.png$/m);
  for (const f of ["icon.png", "icon.ico"]) assert.ok(fs.existsSync(path.join(BUILD, f)), f);
});

test("stage: the window icon is staged with the assets, and the stage refuses to run without the three icon files", () => {
  const src = read(DESKTOP, "scripts", "stage.js").toString("utf8");
  assert.match(src, /copyTree\(R\("desktop", "assets"\)/);
  for (const f of ["desktop/assets/icon.png", "desktop/build/icon.png", "desktop/build/icon.ico"]) assert.ok(src.includes(f), f);
});

test("the main window and the secret window get the window icon when one is given, and none when it is not", async () => {
  const electron = createFakeElectron();
  const guard = createGuard(electron);
  guard.install();
  const icon = path.join(ASSETS, "icon.png");
  const win = createMainWindow({ electron, guard, isPackaged: true, url: "no1d://app/#token=t", shouldHide: () => false, iconPath: icon });
  assert.equal(win.window.options.icon, icon);
  const e3 = createFakeElectron();
  const g3 = createGuard(e3);
  g3.install();
  const bare = createMainWindow({ electron: e3, guard: g3, isPackaged: true, url: "no1d://app/#token=t", shouldHide: () => false });
  assert.equal("icon" in bare.window.options, false);

  const e2 = createFakeElectron();
  const g2 = createGuard(e2);
  g2.install();
  const ui = createSecretUi({ electron: e2, guard: g2, preloadPath: path.join(DESKTOP, "preload-secret.js"), htmlPath: path.join(DESKTOP, "secret", "secret.html"), getParent: () => null, iconPath: icon });
  assert.ok(ui);
  const src = read(DESKTOP, "lib", "secretwin.js").toString("utf8");
  assert.match(src, /\.\.\.\(typeof iconPath === "string" && iconPath \? \{ icon: iconPath \} : \{\}\)/);
});

test("the shell gives the main window the staged window icon", async () => {
  const e = makeEnv();
  try {
    await e.shell.start();
    const main = e.electron.windows[0];
    assert.ok(main, "a window was made");
    assert.equal(path.basename(main.options.icon), "icon.png");
    assert.equal(path.basename(path.dirname(main.options.icon)), "assets");
  } finally {
    e.cleanup();
  }
});
