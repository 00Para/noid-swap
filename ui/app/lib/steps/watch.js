"use strict";
/*
 * The watch loop (scripts/live/watch.sh) as a timer object inside the program: every `intervalMs` it runs `tick(role, --apply)`, appends one line to
 * loop-ROLE.txt in the run folder, hands the tick's output to the ALERT and ALARM hooks, and ends by itself when every watched file is terminal.
 *
 *   const w = createWatch(ctx, { intervalMs: 30000 });
 *   const ended = w.start();     // a promise: { reason: "terminal" | "stopped" | "refused", ticks, message }
 *   await w.stop();              // after the tick in progress
 *
 * The loop line is the helper's: the time, then eight parts, each cut on its own, the last (`applied: .. phase_after: ..`) whole. The terminal rule
 * is watch.sh's: phase_after refunded, lost or aborted, or `done` unless the action or reason still names a leftover leg.
 * Injectable for tests: ctx.now (the clock of the line), opts.sleep(ms) (resolves when the pause is over), opts.tick (replaces the tick step).
 * `opts.apply` (default true): false makes every tick of Bob's an observe-only tick (`--apply --observe-only`, the tick step's `observeOnly`): it records the facts the chains show, never an
 * intent, an abort or a spend's parameters, and shows what the engine would decide (lib/firststeps.js, rule W). swap-cli refuses it while the file holds an intent or a pending action; the round
 * then reads with the plain read-only tick (never a full --apply) and `opts.onNote(text)` is told once per refusal streak. Alice's ticks in read mode stay plain read-only ticks (no --apply):
 * from `created` the engine adopts any fitting instance at her contract root, so an observe tick could move her file to `funded` on a deposit someone else made there, and rule W reads any
 * phase past `created` as her own act and would switch to apply before her approval and deposit.
 * `opts.lockEverSent` (a function, default none): Bob on production while his approval is off or lapsed, before any lock send of this swap ever started and while the last tick shows a held or
 * recorded lock_eth intent (the one state in which an applied tick without the acknowledgement writes the producer latch): an apply-mode round ticks read-only instead (no --apply), and its loop
 * line says so (common.js readingOnlyForAck). In every other case the loop is unchanged: a height abort is recorded as on a test network. The acknowledgement is decided once per round and the
 * same flags are handed to the tick (no second read).
 */

const fs = require("fs");
const path = require("path");
const C = require("./common");
const { tick: realTick } = require("./tick");

// [regex, most characters] of each part of the loop line, in the helper's order
const PARTS = [
  [/^\[/, 300],
  [/^noid:/, 600],
  [/^eth :/, 700],
  [/^ACTION/, 800],
  [/^notes:/, 1500],
  [/^ALERT:/, 700],
  [/^intent/, 700],
  [/^(applied|phase_after)/, 400],
];

const READING_ONLY_RE = /^Reading only:/;
const LEFTOVER = ["refund_", "still at the contract", "ETH lock is still open", "already submitted", "open past T_reveal", "taking it back"];

/** The lines of `lines` that match, the first eight, each cut to `max` characters, joined with a space (watch.sh `part`). */
function part(lines, re, max) {
  return lines
    .filter((l) => re.test(l))
    .slice(0, 8)
    .map((l) => Array.from(l).slice(0, max).join(""))
    .join(" ");
}

/** The loop line for a tick's output (without the newline). */
function loopLine(time, outText) {
  const lines = String(outText).split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  const parts = PARTS.map(([re, max]) => part(lines, re, max));
  // S1: a round that read only because Bob's approval is off says so, right after the "[role] tick exit" part (only then: the line otherwise keeps the helper's eight parts)
  const note = part(lines, READING_ONLY_RE, 300);
  if (note) parts.splice(1, 0, note);
  return `${time} ${parts.join(" ")}`;
}

/** 1 when the line says its file is terminal (watch.sh lines 28-31), else 0. */
function terminalOf(line) {
  if (line.includes("phase_after: done")) return LEFTOVER.some((k) => line.includes(k)) ? 0 : 1;
  if (line.includes("phase_after: refunded") || line.includes("phase_after: lost") || line.includes("phase_after: aborted")) return 1;
  return 0;
}

class Watch {
  constructor(ctx, opts = {}) {
    this.ctx = ctx;
    this.roles = opts.roles || [ctx.settings.role];
    this.intervalMs = opts.intervalMs === undefined ? 30000 : opts.intervalMs;
    this.tickStep = opts.tick || realTick;
    this.sleepFn = opts.sleep || null;
    this.onLine = opts.onLine || null;
    this.apply = opts.apply !== false;
    this.onNote = opts.onNote || null;
    this.lockEverSent = typeof opts.lockEverSent === "function" ? opts.lockEverSent : null;
    this.lastIntent = new Map(); // role -> did the last tick this loop read show a pending lock_eth intent (kept when the file cannot be read)
    this.refused = new Map(); // role -> the observe-only refusal streak is on (the note was given)
    this.ticks = 0;
    this.lastError = null;
    this.stopped = false;
    this.promise = null;
    this.timer = null;
    this.wake = null;
    this.alertStates = new Map(); // role -> what the alert hook keeps between ticks (a new ALERT notifies, one that persists does not)
  }

  get running() {
    return this.promise !== null && !this.finished;
  }

  start() {
    if (!this.promise) this.promise = this.run();
    return this.promise;
  }

  async stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.wake) this.wake();
    if (this.promise) await this.promise;
  }

  pause(ms) {
    if (this.sleepFn) return this.sleepFn(ms);
    return new Promise((resolve) => {
      this.wake = resolve;
      this.timer = setTimeout(resolve, ms);
    });
  }

  /**
   * S1 and L2: what this round's tick of `role` is told: `{ readOnly, ack }`. readOnly: Bob on production, no acknowledgement in force, before his lock, the last tick showing a held or
   * recorded lock_eth intent and no lock send ever started. ack: the producer-share flags, asked of the program ONCE here and handed to the tick. Never throws; an unreadable answer is
   * "not read-only" (the intent state is then the one the loop last saw).
   */
  decideRound(ctx, role) {
    let ack;
    try {
      ack = role === "bob" ? C.producerAckFlags(ctx) : [];
    } catch {
      ack = [];
    }
    try {
      if (role !== "bob" || !ctx.settings || ctx.settings.profile !== "production" || !this.lockEverSent) return { readOnly: false, ack };
      let phase = null;
      let pending = this.lastIntent.get(role) === true;
      const text = C.readTextCapped(path.join(ctx.runDir, `last-tick-${role}.json`), 64 * 1024 * 1024);
      if (text) {
        try {
          const v = JSON.parse(text);
          if (v && typeof v.phase_after === "string") phase = v.phase_after;
          if (v && typeof v === "object") {
            pending = C.lockIntentPendingIn(v);
            this.lastIntent.set(role, pending);
          }
        } catch {
          phase = null;
        }
      }
      return { readOnly: C.readingOnlyForAck(ctx, role, phase, this.lockEverSent() === true, pending, ack), ack };
    } catch {
      return { readOnly: false, ack };
    }
  }

  /** An observe-only tick that swap-cli refused (the file holds an intent): this round reads without recording, one note per streak. Never a full --apply. */
  async afterObserve(ctx, role, res, ack) {
    const text = `${(res && res.stderr) || ""}${(res && res.stdout) || ""}`;
    const refused = !!res && res.code === 1 && /observe-only is refused/.test(text);
    if (!refused) {
      this.refused.delete(role);
      return res;
    }
    if (!this.refused.has(role)) {
      this.refused.set(role, true);
      if (this.onNote) {
        try {
          this.onNote("observe-only was refused (the file holds an intent or a pending action): reading without recording until it is not");
        } catch {
          /* a listener cannot stop the loop */
        }
      }
    }
    return this.tickStep(ctx, role, { args: [], ackFlags: ack });
  }

  async tickOnce(role) {
    const ctx = this.ctx;
    let res;
    let readingOnly = false;
    try {
      const observe = !this.apply && role === "bob"; // Alice reads with the plain read-only tick (see the head of this file)
      const round = this.decideRound(ctx, role);
      readingOnly = this.apply && round.readOnly;
      // Bob's ticks carry the round's acknowledgement decision (L2); Alice's tick has no such flag and is asked for exactly as before
      const extra = role === "bob" ? { ackFlags: round.ack } : {};
      res = await this.tickStep(ctx, role, this.apply && !readingOnly ? { args: ["--apply"], ...extra } : observe ? { args: [], observeOnly: true, ...extra } : { args: [], ...extra });
      if (observe) res = await this.afterObserve(ctx, role, res, round.ack);
    } catch (e) {
      this.lastError = String((e && e.message) || e);
      res = { code: null, stdout: "", stderr: "", files: [] };
    }
    this.ticks++;
    const outText = `${readingOnly ? `${C.READING_ONLY_NOTE}\n` : ""}${res.stderr || ""}${res.stdout || ""}`;
    const line = loopLine(C.clock(C.nowMs(ctx), true), outText);
    try {
      fs.appendFileSync(path.join(ctx.runDir, `loop-${role}.txt`), `${line}\n`, { mode: 0o600 });
    } catch (e) {
      this.lastError = String((e && e.message) || e);
    }
    if (this.onLine) {
      try {
        this.onLine(role, line, res);
      } catch {
        /* a listener cannot stop the loop */
      }
    }
    if (!this.alertStates.has(role)) this.alertStates.set(role, {});
    await C.alertHook(ctx, outText, this.alertStates.get(role));
    await C.alarmHook(ctx, role, outText);
    return terminalOf(line);
  }

  async run() {
    for (const r of this.roles) {
      if (r !== "alice" && r !== "bob") return this.end("refused", "role must be alice or bob");
      if (r !== this.ctx.settings.role) return this.end("refused", `this run is ${this.ctx.settings.role}'s: the ${r} watch is refused`);
    }
    while (!this.stopped) {
      let terminal = 0;
      for (const role of this.roles) {
        if (this.stopped) break;
        terminal += await this.tickOnce(role);
      }
      if (this.stopped) break;
      if (terminal === this.roles.length) return this.end("terminal", `all watched files terminal at ${C.clock(C.nowMs(this.ctx), true)}`);
      await this.pause(this.intervalMs);
    }
    return this.end("stopped", "stopped");
  }

  end(reason, message) {
    this.finished = true;
    return { reason, ticks: this.ticks, message };
  }
}

function createWatch(ctx, opts) {
  return new Watch(ctx, opts);
}

module.exports = { createWatch, loopLine, terminalOf };
