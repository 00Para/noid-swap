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
  return `${time} ${PARTS.map(([re, max]) => part(lines, re, max)).join(" ")}`;
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
    this.ticks = 0;
    this.lastError = null;
    this.stopped = false;
    this.promise = null;
    this.timer = null;
    this.wake = null;
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

  async tickOnce(role) {
    const ctx = this.ctx;
    let res;
    try {
      res = await this.tickStep(ctx, role, { args: ["--apply"] });
    } catch (e) {
      this.lastError = String((e && e.message) || e);
      res = { code: null, stdout: "", stderr: "", files: [] };
    }
    this.ticks++;
    const outText = `${res.stderr || ""}${res.stdout || ""}`;
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
    await C.alertHook(ctx, outText);
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
