"use strict";
/*
 * OS notifications (build spec 7.9). The texts are fixed: no line of a tick, no amount, no address and no error text ever
 * reaches a notification. One per kind per swap per 10 minutes. A click calls `onClick(swapId)`.
 */

const TEXTS = Object.freeze({
  alert: "A swap needs a look.",
  alarm: "A swap needs you now.",
  needs_you: "A swap is waiting for you.",
  done: "A swap has finished.",
});
const CRASH_TEXT = "No1d Swap stopped after a second error. Open it again when you can.";
const RATE_MS = 10 * 60 * 1000;
const SWAP_ID = /^[0-9a-f]{32}$/;

function createNotifier({ Notification, now = Date.now, onClick, title = "No1d Swap" }) {
  const last = new Map();
  const live = new Set(); // keeps a shown notification from being collected before the user clicks it

  function show(body, swapId) {
    if (!Notification || (typeof Notification.isSupported === "function" && !Notification.isSupported())) return false;
    const n = new Notification({ title, body, silent: false });
    live.add(n);
    const done = () => live.delete(n);
    if (typeof n.on === "function") {
      n.on("click", () => {
        done();
        if (onClick) onClick(swapId);
      });
      n.on("close", done);
      n.on("failed", done);
    }
    n.show();
    return true;
  }

  return {
    TEXTS,
    notify(kind, swapId) {
      if (!Object.prototype.hasOwnProperty.call(TEXTS, kind)) return false;
      const id = typeof swapId === "string" && SWAP_ID.test(swapId) ? swapId : null;
      const key = `${kind}|${id}`;
      const t = now();
      const prev = last.get(key);
      if (prev !== undefined && t - prev < RATE_MS) return false;
      last.set(key, t);
      return show(TEXTS[kind], id);
    },
    /** The second crash within ten minutes: not rate limited, no swap named. */
    crashNotice() {
      return show(CRASH_TEXT, null);
    },
  };
}

module.exports = { createNotifier, TEXTS, CRASH_TEXT, RATE_MS };
