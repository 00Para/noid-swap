"use strict";
/*
 * Quit confirmation (build spec 7.4). While any swap is active, quitting asks first and names every swap at stake and until when.
 * The system's own shutdown or log-off is never blocked. Takes the Electron module as an argument.
 */

function trimDecimal(int, frac) {
  const f = frac.replace(/0+$/, "");
  return f ? `${int}.${f}` : int;
}

/** "5000000" micro-NOID -> "5"; "1500000" -> "1.5". null on bad input. */
function formatNoid(micro) {
  if (typeof micro !== "string" || !/^\d+$/.test(micro)) return null;
  const n = BigInt(micro);
  return trimDecimal((n / 1000000n).toString(), (n % 1000000n).toString().padStart(6, "0"));
}

/** "1000000000000000" wei -> "0.001". null on bad input. */
function formatEth(wei) {
  if (typeof wei !== "string" || !/^\d+$/.test(wei)) return null;
  const n = BigInt(wei);
  return trimDecimal((n / 10n ** 18n).toString(), (n % 10n ** 18n).toString().padStart(18, "0"));
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

function untilPhrase(s) {
  if (typeof s.until_text === "string" && s.until_text.trim()) return `until ${s.until_text.trim()}`;
  if (Number.isFinite(s.until_unix)) {
    const d = new Date(s.until_unix * 1000);
    return `until about ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  }
  return "until a time the program cannot read now";
}

/** One line per swap, built only from the fixed AtStake fields: "You sell NOID: 5 NOID in the contract until about 14:20". */
function lineFor(s) {
  const role = s.role === "bob" ? "You sell ETH" : "You sell NOID";
  const coin = s.role === "bob" ? (formatEth(s.coins && s.coins.eth_wei) || null) : (formatNoid(s.coins && s.coins.noid_micronoid) || null);
  const unit = s.role === "bob" ? "ETH" : "NOID";
  const amount = coin ? `${coin} ${unit}` : "coins";
  const where = s.in_contract ? "in the contract" : "committed to this swap";
  return `${role}: ${amount} ${where} ${untilPhrase(s)}`;
}

function quitText(list) {
  const active = (Array.isArray(list) ? list : []).filter((s) => s && s.active === true);
  return {
    title: "A swap is still running",
    message: active.length === 1 ? "A swap is still running." : `${active.length} swaps are still running.`,
    detail:
      active.map(lineFor).join("\n") +
      "\n\nIf the program is closed, it cannot send what a swap needs while you are away. A swap that needs a step before its time can then lose coins.",
  };
}

/**
 * @param {object} o
 * @param {object} o.electron
 * @param {() => object[]} o.getList   the last AtStake list
 * @param {() => (object|null)} [o.getWindow]   parent window of the dialog
 * @param {() => void} [o.onAccepted]  called when a quit is let through
 */
function createQuitGuard({ electron, getList, getWindow, onAccepted }) {
  const { app, dialog } = electron;
  let confirmed = false;
  let systemShutdown = false;
  let asking = false;

  function beforeQuit(event) {
    if (confirmed || systemShutdown) {
      if (onAccepted) onAccepted();
      return;
    }
    const list = getList();
    const anyActive = Array.isArray(list) && list.some((s) => s && s.active === true);
    if (!anyActive) {
      if (onAccepted) onAccepted();
      return;
    }
    event.preventDefault();
    if (asking) return;
    asking = true;
    const text = quitText(list);
    const parent = getWindow ? getWindow() : null;
    const options = { type: "warning", buttons: ["Keep running", "Quit anyway"], defaultId: 0, cancelId: 0, noLink: true, title: text.title, message: text.message, detail: text.detail };
    const pending = parent ? dialog.showMessageBox(parent, options) : dialog.showMessageBox(options);
    Promise.resolve(pending).then(
      (r) => {
        asking = false;
        if (r && r.response === 1) {
          confirmed = true;
          app.quit();
        }
      },
      () => {
        asking = false;
      },
    );
  }

  return {
    install() {
      app.on("before-quit", beforeQuit);
    },
    /** The operating system is shutting down or logging off: never block it. */
    markSystemShutdown() {
      systemShutdown = true;
    },
    beforeQuit,
    isConfirmed: () => confirmed,
  };
}

module.exports = { createQuitGuard, quitText, lineFor, formatNoid, formatEth };
