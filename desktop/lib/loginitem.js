"use strict";
/*
 * Start at login (build spec 7.4): on while any swap is active, off when none is; only on a change. Started with --hidden the
 * program does not show its window. An unpackaged run never touches the login items (its executable is the Electron binary).
 */

function createLoginItem({ app, platform, execPath, isPackaged }) {
  let state = null; // null = never set, then true | false
  return {
    update(list) {
      if (!isPackaged) return;
      const want = Array.isArray(list) && list.some((s) => s && s.active === true);
      if (want === state) return;
      state = want;
      if (want) {
        const settings = { openAtLogin: true, args: ["--hidden"] };
        if (platform === "win32") settings.path = execPath;
        app.setLoginItemSettings(settings);
      } else {
        const off = { openAtLogin: false };
        if (platform === "win32") off.path = execPath;
        app.setLoginItemSettings(off);
      }
    },
    current: () => state,
  };
}

module.exports = { createLoginItem };
