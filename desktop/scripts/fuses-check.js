#!/usr/bin/env node
"use strict";
/*
 * fuses-check.js: read the Electron fuses out of a built program and compare them with what the packaging asks for.
 *
 * A fuse is a switch that is flipped inside the program's own binary when it is packaged (Electron's "fuses"). They are
 * stored in one place, the "fuse wire": a fixed 32-character marker, then a version byte, a length byte, and one
 * character per fuse: '0' off, '1' on, 'r' removed. This script reads that wire directly, so no package is needed to
 * check the result, and the same code can be tested with a made-up buffer.
 *
 *   node desktop/scripts/fuses-check.js --binary "<path>"
 *
 * <path> is the main program on Windows ("No1d Swap.exe"), or on macOS the .app folder (the wire sits in the
 * Electron Framework binary inside it) or that framework binary itself.
 */

const fs = require("fs");
const path = require("path");

const SENTINEL = Buffer.from("dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX", "latin1");

/** The fuses of wire version 1, in wire order (Electron's FuseV1Options), and the value this program requires of each. */
const FUSES_V1 = [
  { name: "RunAsNode", want: true }, // live.js runs under the program's own binary with ELECTRON_RUN_AS_NODE=1
  { name: "EnableCookieEncryption", want: true },
  { name: "EnableNodeOptionsEnvironmentVariable", want: false },
  { name: "EnableNodeCliInspectArguments", want: false },
  { name: "EnableEmbeddedAsarIntegrityValidation", want: true },
  { name: "OnlyLoadAppFromAsar", want: true },
  { name: "LoadBrowserProcessSpecificV8Snapshot", want: false },
  { name: "GrantFileProtocolExtraPrivileges", want: false },
];

const ON = 0x31;
const OFF = 0x30;
const REMOVED = 0x72;

/** Every fuse wire in the buffer, as {offset, version, states:number[]}. */
function findWires(buf) {
  const wires = [];
  let from = 0;
  for (;;) {
    const at = buf.indexOf(SENTINEL, from);
    if (at < 0) break;
    from = at + 1;
    const head = at + SENTINEL.length;
    if (head + 2 > buf.length) {
      wires.push({ offset: at, version: null, states: [], truncated: true });
      continue;
    }
    const version = buf[head];
    const length = buf[head + 1];
    if (head + 2 + length > buf.length) {
      wires.push({ offset: at, version, states: [], truncated: true });
      continue;
    }
    wires.push({ offset: at, version, states: [...buf.subarray(head + 2, head + 2 + length)], truncated: false });
  }
  return wires;
}

/**
 * @param {Buffer} buf the whole binary
 * @returns {{ok:boolean, problems:string[], fuses:Object<string,string>}} fuses: name -> "on" | "off" | "removed"
 */
function checkFuses(buf) {
  const problems = [];
  const fuses = {};
  const wires = findWires(buf);
  if (wires.length === 0) return { ok: false, problems: ["no fuse wire found in this file"], fuses };
  const first = wires[0];
  for (const w of wires) {
    if (w.truncated) problems.push(`the fuse wire at byte ${w.offset} is cut short`);
    else if (JSON.stringify(w.states) !== JSON.stringify(first.states) || w.version !== first.version) problems.push("the file holds more than one fuse wire and they differ");
  }
  if (first.truncated) return { ok: false, problems, fuses };
  if (first.version !== 1) problems.push(`the fuse wire has version ${first.version}, this check knows version 1`);
  if (first.states.length < FUSES_V1.length) problems.push(`the fuse wire holds ${first.states.length} fuses, at least ${FUSES_V1.length} are expected`);
  FUSES_V1.forEach((f, i) => {
    const s = first.states[i];
    const word = s === ON ? "on" : s === OFF ? "off" : s === REMOVED ? "removed" : "unreadable";
    fuses[f.name] = word;
    if (word === "unreadable" || word === "removed") problems.push(`${f.name} is ${word}`);
    else if ((word === "on") !== f.want) problems.push(`${f.name} is ${word}, it must be ${f.want ? "on" : "off"}`);
  });
  return { ok: problems.length === 0, problems, fuses };
}

/** An .app folder (macOS) leads to the Electron Framework binary; anything else is used as given. */
function resolveBinary(p) {
  if (/\.app[\\/]?$/.test(p)) {
    return path.join(p, "Contents", "Frameworks", "Electron Framework.framework", "Versions", "A", "Electron Framework");
  }
  return p;
}

function main(argv) {
  const i = argv.indexOf("--binary");
  if (i < 0 || !argv[i + 1]) {
    process.stderr.write('usage: fuses-check.js --binary "<program, .app folder or framework binary>"\n');
    return 2;
  }
  const file = resolveBinary(argv[i + 1]);
  let buf;
  try {
    buf = fs.readFileSync(file);
  } catch (e) {
    process.stderr.write(`error: cannot read ${file}: ${e.code || e.message}\n`);
    return 1;
  }
  const r = checkFuses(buf);
  for (const [k, v] of Object.entries(r.fuses)) process.stdout.write(`${k}: ${v}\n`);
  if (!r.ok) {
    for (const p of r.problems) process.stderr.write(`error: ${p}\n`);
    return 1;
  }
  process.stdout.write("fuses are as required\n");
  return 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { checkFuses, findWires, resolveBinary, FUSES_V1, SENTINEL };
