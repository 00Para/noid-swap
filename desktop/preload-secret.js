"use strict";
/*
 * Preload of the secret window ONLY (build spec 7.5). One of the two files of the program that may require("electron").
 * Exposes `window.no1dSecret = { onShow(cb), submit(values), cancel() }` and nothing else. Values go to the main process over one
 * channel; the main process accepts them only from this window's own webContents and only while a request is open.
 */

const { contextBridge, ipcRenderer } = require("electron");

let showCb = null;
let pending = null;

ipcRenderer.on("no1d-secret:show", (_event, payload) => {
  if (showCb) showCb(payload);
  else pending = payload;
});

contextBridge.exposeInMainWorld("no1dSecret", {
  onShow(cb) {
    if (typeof cb !== "function") return;
    showCb = cb;
    if (pending !== null) {
      const p = pending;
      pending = null;
      cb(p);
    }
  },
  submit(values) {
    return ipcRenderer.invoke("no1d-secret", { type: "submit", values });
  },
  cancel() {
    return ipcRenderer.invoke("no1d-secret", { type: "cancel" });
  },
});
