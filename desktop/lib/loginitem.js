"use strict";
/*
 * Start at login (build spec 7.4): on while any swap is active, off when none is; only on a change. Started with --hidden the
 * program does not show its window. On a Mac the login item cannot pass an argument, so it asks to open hidden, and the start reads the
 * system's own answer (startedAtLogin) instead of the switch. An unpackaged run never touches the login items (its executable is the Electron binary).
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
        if (platform === "darwin") settings.openAsHidden = true;
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

/** True when the system says this start came from a login item (opened at login, or opened hidden). Anything else, or an error, is false. */
function startedAtLogin(app) {
  try {
    const s = app.getLoginItemSettings();
    return !!s && (s.wasOpenedAtLogin === true || s.wasOpenedAsHidden === true);
  } catch {
    return false;
  }
}

module.exports = { createLoginItem, startedAtLogin };
