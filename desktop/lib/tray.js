"use strict";
/* Tray (Windows) or menu bar (macOS) and the application menu (build spec 7.3 and 7.4). Takes the Electron module as an argument. */

const path = require("node:path");

function activeCount(list) {
  return Array.isArray(list) ? list.filter((s) => s && s.active === true).length : 0;
}

function tooltipFor(list) {
  const n = activeCount(list);
  return `No1d Swap: ${n} active swap${n === 1 ? "" : "s"}`;
}

/**
 * @param {object} o
 * @param {object} o.electron
 * @param {string} o.platform
 * @param {string} o.assetsDir   folder with tray.png (Windows) and trayTemplate.png (+ @2x, macOS)
 * @param {() => void} o.onOpen
 * @param {() => void} o.onQuit
 */
function createTray({ electron, platform, assetsDir, onOpen, onQuit }) {
  const { Tray, Menu, nativeImage } = electron;
  const file = path.join(assetsDir, platform === "darwin" ? "trayTemplate.png" : "tray.png");
  const image = nativeImage && typeof nativeImage.createFromPath === "function" ? nativeImage.createFromPath(file) : undefined;
  if (platform === "darwin" && image && typeof image.setTemplateImage === "function") image.setTemplateImage(true);
  const tray = new Tray(image);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Open", click: () => onOpen() },
      { type: "separator" },
      { label: "Quit", click: () => onQuit() },
    ]),
  );
  tray.on("click", () => onOpen());
  tray.setToolTip(tooltipFor([]));
  return {
    tray,
    update(list) {
      tray.setToolTip(tooltipFor(list));
    },
    destroy() {
      if (typeof tray.destroy === "function") tray.destroy();
    },
  };
}

/**
 * The application menu: About, Settings, Recovery code, Help, (with `onCheckUpdate`) Check for a new version, Quit and the standard
 * Edit roles. No reload, no developer tools in the packaged program.
 */
function buildApplicationMenu({ electron, isPackaged, onSettings, onRecoveryCode, onHelp, onCheckUpdate, onQuit }) {
  const { Menu, app } = electron;
  const template = [
    {
      label: "No1d Swap",
      submenu: [
        { label: "About No1d Swap", click: () => app.showAboutPanel() },
        { label: "Settings", click: () => onSettings() },
        { label: "Recovery code", click: () => onRecoveryCode() },
        { label: "Help", click: () => onHelp() },
        ...(typeof onCheckUpdate === "function" ? [{ label: "Check for a new version", click: () => onCheckUpdate() }] : []),
        { type: "separator" },
        { label: "Quit", click: () => onQuit() },
      ],
    },
    {
      label: "Edit",
      submenu: [{ role: "undo" }, { role: "redo" }, { type: "separator" }, { role: "cut" }, { role: "copy" }, { role: "paste" }, { role: "selectAll" }],
    },
  ];
  if (!isPackaged) template.push({ label: "Develop", submenu: [{ role: "toggleDevTools" }, { role: "reload" }] });
  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
  return menu;
}

module.exports = { createTray, buildApplicationMenu, tooltipFor, activeCount };
