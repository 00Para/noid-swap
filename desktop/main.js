"use strict";
/*
 * Entry point of the desktop program. One of the two files that may require("electron") (the other is preload-secret.js).
 * All logic lives in lib/ as plain modules that take the Electron module as an argument; this file only hands it over.
 */

const electron = require("electron");
const { createShell } = require("./lib/shell");

const shell = createShell({ electron, argv: process.argv, version: electron.app.getVersion(), proc: process });

shell.start().catch(() => {
  // A start-up failure that no module handled: say so in words and stop. No error text is shown (it could carry data).
  try {
    electron.dialog.showErrorBox("No1d Swap", "The program could not start.");
  } finally {
    electron.app.exit(1);
  }
});
