"use strict";
// The fuses check (step 4.8, build spec 8.2 and 8.5): the fuse wire read from a binary and compared with what packaging asks for.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const F = require("../scripts/fuses-check.js");

const SCRIPT = path.join(__dirname, "..", "scripts", "fuses-check.js");
const ON = 0x31;
const OFF = 0x30;
const REMOVED = 0x72;
// RunAsNode, EnableCookieEncryption, NodeOptionsEnv, NodeCliInspect, EmbeddedAsarIntegrity, OnlyLoadAppFromAsar, BrowserV8Snapshot, FileProtocolExtra
const WANT = [ON, ON, OFF, OFF, ON, ON, OFF, OFF];

const wire = (states, version = 1) => Buffer.concat([F.SENTINEL, Buffer.from([version, states.length]), Buffer.from(states)]);
const binary = (...parts) => Buffer.concat([Buffer.from("MZ junk before"), ...parts, Buffer.from("junk after")]);

test("the required values are the ones of the packaging spec", () => {
  assert.deepEqual(
    F.FUSES_V1.map((f) => [f.name, f.want]),
    [
      ["RunAsNode", true],
      ["EnableCookieEncryption", true],
      ["EnableNodeOptionsEnvironmentVariable", false],
      ["EnableNodeCliInspectArguments", false],
      ["EnableEmbeddedAsarIntegrityValidation", true],
      ["OnlyLoadAppFromAsar", true],
      ["LoadBrowserProcessSpecificV8Snapshot", false],
      ["GrantFileProtocolExtraPrivileges", false],
    ]
  );
  assert.equal(F.SENTINEL.toString("latin1"), "dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX");
});

test("a binary with the required fuses passes and reports every fuse", () => {
  const r = F.checkFuses(binary(wire(WANT)));
  assert.deepEqual(r.problems, []);
  assert.equal(r.ok, true);
  assert.equal(r.fuses.RunAsNode, "on");
  assert.equal(r.fuses.EnableNodeOptionsEnvironmentVariable, "off");
  assert.equal(Object.keys(r.fuses).length, 8);
});

test("each fuse flipped on its own fails, and names that fuse", () => {
  WANT.forEach((v, i) => {
    const flipped = [...WANT];
    flipped[i] = v === ON ? OFF : ON;
    const r = F.checkFuses(binary(wire(flipped)));
    assert.equal(r.ok, false);
    assert.equal(r.problems.length, 1);
    assert.match(r.problems[0], new RegExp(`^${F.FUSES_V1[i].name} is ${v === ON ? "off" : "on"}, it must be ${v === ON ? "on" : "off"}$`));
  });
});

test("a removed or unreadable fuse fails", () => {
  const removed = [...WANT];
  removed[0] = REMOVED;
  assert.match(F.checkFuses(binary(wire(removed))).problems[0], /RunAsNode is removed/);
  const odd = [...WANT];
  odd[4] = 0x58;
  assert.match(F.checkFuses(binary(wire(odd))).problems[0], /EnableEmbeddedAsarIntegrityValidation is unreadable/);
});

test("more fuses than known are fine, fewer are not, and another wire version is refused", () => {
  assert.equal(F.checkFuses(binary(wire([...WANT, OFF, ON]))).ok, true);
  assert.match(F.checkFuses(binary(wire(WANT.slice(0, 6)))).problems.join(" "), /holds 6 fuses/);
  assert.match(F.checkFuses(binary(wire(WANT, 2))).problems.join(" "), /version 2/);
});

test("no wire, or a wire cut short, fails", () => {
  assert.deepEqual(F.checkFuses(Buffer.from("no sentinel here")).problems, ["no fuse wire found in this file"]);
  const cut = Buffer.concat([Buffer.from("x"), F.SENTINEL, Buffer.from([1, 8, ON, ON])]);
  assert.match(F.checkFuses(cut).problems.join(" "), /cut short/);
  assert.equal(F.checkFuses(Buffer.concat([Buffer.from("x"), F.SENTINEL])).ok, false);
});

test("two wires that agree pass; two that differ fail", () => {
  assert.equal(F.checkFuses(binary(wire(WANT), Buffer.from("between"), wire(WANT))).ok, true);
  const other = [...WANT];
  other[0] = OFF;
  const r = F.checkFuses(binary(wire(WANT), Buffer.from("between"), wire(other)));
  assert.equal(r.ok, false);
  assert.ok(r.problems.some((p) => /more than one fuse wire and they differ/.test(p)));
});

test("resolveBinary: a .app folder leads to the framework binary, anything else is used as given", () => {
  const fw = path.join("A.app", "Contents", "Frameworks", "Electron Framework.framework", "Versions", "A", "Electron Framework");
  assert.equal(F.resolveBinary("A.app"), fw);
  assert.equal(F.resolveBinary("A.app/"), path.join("A.app/", "Contents", "Frameworks", "Electron Framework.framework", "Versions", "A", "Electron Framework"));
  assert.equal(F.resolveBinary("No1d Swap.exe"), "No1d Swap.exe");
});

test("command line: exit 0 for good fuses, 1 for a bad one or a missing file, 2 without --binary", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "no1d-fuses-"));
  try {
    const good = path.join(dir, "good.exe");
    const bad = path.join(dir, "bad.exe");
    fs.writeFileSync(good, binary(wire(WANT)));
    fs.writeFileSync(bad, binary(wire([OFF, ...WANT.slice(1)])));
    const cli = (...a) => spawnSync(process.execPath, [SCRIPT, ...a], { encoding: "utf8" });
    const ok = cli("--binary", good);
    assert.equal(ok.status, 0, ok.stderr);
    assert.match(ok.stdout, /fuses are as required/);
    const no = cli("--binary", bad);
    assert.equal(no.status, 1);
    assert.match(no.stderr, /RunAsNode is off/);
    assert.equal(cli("--binary", path.join(dir, "missing.exe")).status, 1);
    assert.equal(cli().status, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
