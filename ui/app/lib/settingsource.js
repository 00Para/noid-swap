"use strict";
/*
 * Where the action runner reads a swap's settings in program mode (spec 5.A.1): run.json of the swap's run folder, through the strict reader of lib/runsettings.js.
 * In terminal mode the runner reads env.local.sh through lib/walletrun.js, lib/production.js and lib/board/runmode.js; in program mode it asks this object instead.
 * Every method reads the file again (a few KB): a run.json changed by hand is seen at once, and a file that stops passing its schema refuses every action.
 *
 *   load()              { ok, settings, why }          the frozen settings, or why not (a text without any value)
 *   role()              "alice" | "bob" | null         run.json's role, null when it cannot be read: a missing or unreadable role refuses every entry (design 12.4)
 *   slotRole()          "alice" | "bob" | null         the role of a board slot, from board-slot.json (a board slot has no run.json until Bob's signed addresses are checked)
 *   walletRun()         the shape lib/walletrun.js envLocalWallet answers: every program run is a wallet run, so use_swap_wallet is true when run.json loads
 *   boardRun()          the shape lib/board/runmode.js boardRun answers: on when run.json says handover board, or the host's handover file is in the folder
 *   productionReason()  null, or the text that refuses every action: a production value anywhere in run.json, or a run.json that cannot be read safely or fails the schema
 *   roleBlock(entry)    null, or why this table entry is refused for this swap (the role rule of spec 5.A.6)
 */

const fs = require("fs");
const path = require("path");
const runsettings = require("./runsettings");
const { handoverFilePresent } = require("./board/runmode");

// the two host-only entries that run in a board slot before run.json exists (spec 5.A.8): offline, they start no sender
const SLOT_ENTRIES = new Set(["board-verify-addresses", "board-verify-checked"]);

function readSlot(dir) {
  try {
    const file = path.join(dir, "board-slot.json");
    const st = fs.lstatSync(file);
    if (!st.isFile() || st.isSymbolicLink() || st.size > 4096) return null;
    const j = JSON.parse(fs.readFileSync(file, "utf8"));
    if (j && j.v === 1 && /^[0-9a-f]{32}$/.test(String(j.run_id)) && (j.role === "alice" || j.role === "bob")) return { run_id: j.run_id, role: j.role };
  } catch {
    /* no slot */
  }
  return null;
}

function createRunJsonSource({ dir }) {
  const self = {
    dir,
    load() {
      try {
        return { ok: true, settings: runsettings.load(dir), why: null };
      } catch (e) {
        return { ok: false, settings: null, why: e instanceof runsettings.RunSettingsError ? e.message : "run.json cannot be read" };
      }
    },
    role() {
      const l = self.load();
      return l.ok && (l.settings.role === "alice" || l.settings.role === "bob") ? l.settings.role : null;
    },
    slot() {
      return readSlot(dir);
    },
    slotRole() {
      const s = readSlot(dir);
      return s ? s.role : null;
    },
    walletRun() {
      const l = self.load();
      return { found: l.ok, use_swap_wallet: l.ok, ambiguous: false, noid_payout: l.ok ? l.settings.noid_payout : null, eth_payout: l.ok ? l.settings.eth_payout : null };
    },
    boardRun() {
      const l = self.load();
      const declared = l.ok && l.settings.handover === "board";
      const file = handoverFilePresent(dir);
      return { on: declared || file, declared, file, ambiguous: false };
    },
    productionReason() {
      try {
        return runsettings.productionReason(dir);
      } catch {
        return "run.json cannot be read safely: every action is refused.";
      }
    },
    roleBlock(entry) {
      const id = entry && entry.id;
      const role = self.role();
      if (role === null) {
        // a board slot before run.json exists: only the two offline verify entries, and only for the slot's own role
        const sr = self.slotRole();
        if (SLOT_ENTRIES.has(id) && sr !== null && (!entry.role || entry.role === sr)) return null;
        if (sr !== null && !fs.existsSync(path.join(dir, runsettings.FILE))) return "this board slot has no run.json yet: nothing but the board's own signature checks runs";
        return "this swap has no readable role in run.json: every action is refused";
      }
      if (entry && entry.role && entry.role !== role) return `this swap is ${role}'s: ${id} belongs to ${entry.role}`;
      return null;
    },
  };
  return self;
}

module.exports = { createRunJsonSource, readSlot, SLOT_ENTRIES };
