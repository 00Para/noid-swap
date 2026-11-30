"use strict";
// The start screen's logic, without a DOM: when it shows instead of the swap page, which facts it reads, and which step is done, next or not yet.
// (actions.js is browser code in one closure; it only touches `window` and `document` when the page calls it, so a bare `window` is enough to load it.)
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");

global.window = global.window || {};
require("../actions.js");
const S = global.window.NoidActions.start;
const { readRun } = require("../lib/runfolder");

const job = (id, o = {}) => ({ job: 1, id, state: "done", ok: true, exit_code: 0, finished_at: 1_800_000_000, ...o });
/** An actions-mode payload before any swap exists (the console drives both roles; no tick of Alice's). */
function payload(o = {}) {
  return {
    role: o.role === undefined ? "both" : o.role,
    dirs: o.dirs || [{ path: "run", readable: true }, { path: "pub", readable: true }],
    errors: o.errors || [],
    roles: o.roles === undefined ? { alice: null, bob: null } : o.roles,
    bundle: o.bundle || null,
    bundle_file: o.bundle_file || null,
    object_file: o.object_file || null,
    terms: null,
    actions: {
      enabled: true,
      production: o.production || null,
      jobs: o.jobs || [],
      lock: o.lock === undefined ? null : o.lock,
      form: { env_local: o.env === undefined ? { exists: false } : o.env },
      funding: { object_check_ok: !!o.check, object_check_at: o.check ? 1_800_000_100 : null, marker_at: o.marker || null, acknowledged_at: o.ack || null, blocked_by: o.blocked || null },
    },
  };
}

// ------------------------------------------------------------------ the condition
test("the start screen shows for Alice in actions mode while nothing of her swap exists", () => {
  assert.equal(S.noSwapStarted(payload(), "alice"), true);
  assert.equal(S.noSwapStarted(payload({ role: "alice" }), "alice"), true);
  // the run folder does not exist yet: still the start screen (the folder lock says so)
  assert.equal(S.noSwapStarted(payload({ roles: {}, lock: { held: false, folder_missing: true } }), "alice"), true);
});

test("each fact that says a swap exists, or that this is not Alice's page, turns the start screen off", () => {
  assert.equal(S.noSwapStarted(null, "alice"), false, "no payload");
  assert.equal(S.noSwapStarted({ ...payload(), actions: { enabled: false } }, "alice"), false, "not the actions mode");
  assert.equal(S.noSwapStarted(payload(), "bob"), false, "Bob is selected");
  assert.equal(S.noSwapStarted(payload({ role: "bob" }), "alice"), false, "a console that drives Bob only");
  assert.equal(S.noSwapStarted(payload({ production: { text: "production" } }), "alice"), false, "a production run stays on the read-only page");
  // any file of Alice's (a tick, a tick that cannot be read, a loop file) makes `roles.alice` non-null
  assert.equal(S.noSwapStarted(payload({ roles: { alice: { tick: { phase: "created" } }, bob: null } }), "alice"), false, "a tick of Alice's");
  assert.equal(S.noSwapStarted(payload({ roles: { alice: { tick: null, tick_error: "bad", loop: null }, bob: null } }), "alice"), false, "a tick file that cannot be read");
  assert.equal(S.noSwapStarted(payload({ roles: { alice: { tick: null, loop: { entries: [] } }, bob: null } }), "alice"), false, "a loop file");
  assert.equal(S.noSwapStarted(payload({ marker: "2026-11-16T10:00:00Z" }), "alice"), false, "a funding marker");
  assert.equal(S.noSwapStarted(payload({ ack: 1_800_000_000 }), "alice"), false, "an acknowledged funding");
  assert.equal(S.noSwapStarted(payload({ blocked: "funded.marker in this run folder" }), "alice"), false, "funding closed for another reason");
  // a tick of Bob's: on a console for both roles the bundle was clearly handed over, so the swap page shows; on a console for Alice alone it is not hers
  assert.equal(S.noSwapStarted(payload({ roles: { alice: null, bob: { tick: { phase: "received" } } } }), "alice"), false);
  assert.equal(S.noSwapStarted(payload({ role: "alice", roles: { alice: null, bob: { tick: { phase: "received" } } } }), "alice"), true);
  // a folder that could not be read, or any read error: the old page (with its errors) shows
  assert.equal(S.noSwapStarted(payload({ dirs: [{ path: "run", readable: false, error: "ENOENT" }, { path: "pub", readable: true }], errors: ["run: ENOENT"] }), "alice"), false);
  assert.equal(S.noSwapStarted(payload({ errors: ["bundle: bad json"] }), "alice"), false);
  assert.equal(S.noSwapStarted(payload({ dirs: [] }), "alice"), false);
});

// ------------------------------------------------------------------ the facts
test("startFacts reads only the payload's own fields", () => {
  const f = S.startFacts(payload({ jobs: [job("install"), job("setup", { ok: false, exit_code: 1 }), job("check-object")], env: { exists: true, bytes: 412, mtime: 1_800_000_050 }, bundle: { params: {} }, bundle_file: { path: "C:\\pub\\alice.bundle.json", name: "alice.bundle.json" }, object_file: { path: "C:\\pub\\swap.object.json" }, check: true }));
  assert.deepEqual(f.install, { at: 1_800_000_000 });
  assert.equal(f.setup, null, "a job with a bad result is not a fact");
  assert.deepEqual(f.env, { bytes: 412, mtime: 1_800_000_050 });
  assert.equal(f.bundle.path, "C:\\pub\\alice.bundle.json");
  assert.equal(f.object_file, true);
  assert.deepEqual(f.check, { at: 1_800_000_100 });
  assert.equal(f.folder_missing, false);
  assert.equal(S.startFacts(payload({ lock: { held: false, folder_missing: true } })).folder_missing, true);
  // a running job, a job without a result, a bundle file that could not be parsed, a missing settings file: none of them is a fact
  const none = S.startFacts(payload({ jobs: [job("install", { state: "running", ok: null }), job("setup", { ok: null })], bundle: null, bundle_file: { path: "x", name: "alice.bundle.json" } }));
  assert.equal(none.install, null);
  assert.equal(none.setup, null);
  assert.equal(none.bundle, null);
  assert.equal(none.env, null);
});

// ------------------------------------------------------------------ the steps
const states = (f) => S.startSteps(f).map((s) => `${s.id}:${s.state}`).join(" ");
const F0 = { folder_missing: false, install: null, env: null, setup: null, bundle: null, object_file: false, check: null };
const clean = { at: 1 };

test("six steps in this order, and exactly one is next", () => {
  const steps = S.startSteps(F0);
  assert.deepEqual(steps.map((s) => s.title), ["Install the helpers", "Enter the terms", "Set up", "Prepare the swap files", "Check the object file", "Send Bob the bundle file"]);
  assert.deepEqual(steps.map((s) => s.n), [1, 2, 3, 4, 5, 6]);
  assert.equal(steps.filter((s) => s.state === "now").length, 1);
});

test("no run folder: the install step is next, and the page knows it is not done", () => {
  const steps = S.startSteps({ ...F0, folder_missing: true });
  assert.equal(steps[0].state, "now");
  assert.equal(steps[0].known, true, "a missing folder is a fact");
  assert.ok(steps.slice(1).every((s) => s.state === "todo"));
});

test("no run folder: nothing else counts as done, whatever a file elsewhere holds", () => {
  const f = S.startFacts(payload({ lock: { held: false, folder_missing: true }, jobs: [job("install")], env: { exists: true, bytes: 3, mtime: 1 }, bundle: { params: {} }, bundle_file: { path: "p", name: "alice.bundle.json" }, check: true }));
  assert.deepEqual(f, { folder_missing: true, install: null, env: null, setup: null, bundle: null, object_file: false, check: null, states: {} });
  assert.equal(S.startSteps(f)[0].state, "now");
});

test("a folder with nothing in it: install is next but not known (no record that it ran)", () => {
  const steps = S.startSteps(F0);
  assert.equal(steps[0].state, "now");
  assert.equal(steps[0].known, false);
  assert.ok(steps.every((s) => s.state !== "done"));
});

test("each step's own fact marks it done, and the next step is the first one that is not done", () => {
  assert.equal(states({ ...F0, install: clean }), "install:done terms:now setup:todo prepare:todo check:todo send:todo");
  assert.equal(states({ ...F0, install: clean, env: { bytes: 10, mtime: 1 } }), "install:done terms:done setup:now prepare:todo check:todo send:todo");
  assert.equal(states({ ...F0, install: clean, env: { bytes: 10, mtime: 1 }, setup: clean }), "install:done terms:done setup:done prepare:now check:todo send:todo");
  assert.equal(states({ ...F0, install: clean, env: { bytes: 10, mtime: 1 }, setup: clean, bundle: { path: "p" } }), "install:done terms:done setup:done prepare:done check:now send:todo");
  const all = { ...F0, install: clean, env: { bytes: 10, mtime: 1 }, setup: clean, bundle: { path: "p" }, check: clean };
  assert.equal(states(all), "install:done terms:done setup:done prepare:done check:done send:now");
});

test("the settings step is done by the saved file alone, and not by anything else", () => {
  assert.equal(S.startSteps({ ...F0, env: { bytes: 5, mtime: 1 } })[1].state, "done");
  assert.equal(S.startSteps({ ...F0, install: clean, setup: clean })[1].state, "now", "install and setup do not show that the terms were saved");
});

test("a later step's fact shows an earlier helper step ran (and says so), but never the other way round", () => {
  const steps = S.startSteps({ ...F0, bundle: { path: "p" }, env: { bytes: 5, mtime: 1 } });
  assert.equal(steps[0].state, "done");
  assert.equal(steps[0].done_by, "implied");
  assert.equal(steps[0].from, "prepare");
  assert.equal(steps[2].done_by, "implied");
  assert.equal(steps[3].done_by, "file");
  assert.equal(steps[4].state, "now");
  // a clean setup does not show the object was checked
  assert.equal(S.startSteps({ ...F0, setup: clean })[4].state, "todo");
  // a bundle without the saved settings file: prepare needed the settings, so they were there
  assert.equal(S.startSteps({ ...F0, bundle: { path: "p" } })[1].done_by, "implied");
});

test("the last step is never done: the page cannot see that Bob has the file", () => {
  const all = { ...F0, install: clean, env: { bytes: 10, mtime: 1 }, setup: clean, bundle: { path: "p" }, check: clean };
  const last = S.startSteps(all)[5];
  assert.equal(last.state, "now");
  assert.equal(last.done_by, null);
  assert.equal(last.known, false);
  // it is next exactly when the object check has its own fact (nothing implies the check; the check implies every step before it)
  assert.equal(S.startSteps({ ...all, check: null })[5].state, "todo");
  assert.equal(S.startSteps({ ...F0, check: clean })[5].state, "now");
});

test("a step is never done without its fact: every combination of the seven facts", () => {
  const keys = ["folder_missing", "install", "env", "setup", "bundle", "object_file", "check"];
  const val = { folder_missing: true, install: clean, env: { bytes: 1, mtime: 1 }, setup: clean, bundle: { path: "p" }, object_file: true, check: clean };
  for (let m = 0; m < 1 << keys.length; m++) {
    const f = { ...F0 };
    keys.forEach((k, i) => {
      if (m & (1 << i)) f[k] = val[k];
    });
    const steps = S.startSteps(f);
    assert.equal(steps.filter((s) => s.state === "now").length, 1, `one next step for ${m}`);
    const ownOf = { install: f.install, terms: f.env, setup: f.setup, prepare: f.bundle, check: f.check };
    const lateOwn = (ids) => ids.some((id) => ownOf[id]);
    for (const s of steps) {
      if (s.id === "send") {
        assert.notEqual(s.state, "done");
        continue;
      }
      if (s.state === "done") {
        assert.ok(s.done_by, `${s.id} is done: it names how`);
        if (s.done_by === "implied") assert.ok(ownOf[s.from], `${s.id} is implied by ${s.from}, which has its own fact`);
        else assert.ok(ownOf[s.id], `${s.id} done by ${s.done_by} needs its own fact`);
      } else assert.equal(s.done_by, null);
      // and a step with its own fact, or one that a later fact implies, is never left as not done
      const implied = { install: ["setup", "prepare", "check"], terms: ["prepare", "check"], setup: ["prepare", "check"], prepare: ["check"] }[s.id] || [];
      if (ownOf[s.id] || lateOwn(implied)) assert.equal(s.state, "done", `${s.id} for ${m}`);
    }
    // the next step is the first one that is not done
    const i = steps.findIndex((s) => s.state === "now");
    assert.ok(steps.slice(0, i).every((s) => s.state === "done"));
    assert.equal(steps[5].state === "now", !!f.check, "the last step is next exactly when the object check has its fact");
  }
});

// ------------------------------------------------------------------ the one fact added to the payload
test("readRun names the bundle file (and its path) the bundle was read from, and null when there is none", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "noid-start-"));
  try {
    assert.equal(readRun([dir], 1_800_000_000).bundle_file, null);
    fs.writeFileSync(path.join(dir, "alice.bundle.json"), JSON.stringify({ hashlock: "0x" + "00".repeat(32), params: { amount_micronoid: 5000000 } }));
    const r = readRun([dir], 1_800_000_000);
    assert.equal(r.bundle_file.name, "alice.bundle.json");
    assert.equal(r.bundle_file.path, path.join(dir, "alice.bundle.json"));
    assert.ok(r.bundle, "the parsed bundle is still there");
    // a file that is not in the allowlist is not named
    fs.rmSync(path.join(dir, "alice.bundle.json"));
    fs.writeFileSync(path.join(dir, "other.json"), "{}");
    assert.equal(readRun([dir], 1_800_000_000).bundle_file, null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------------ the review's points
/** A payload as the server builds it, from a real readRun over the folders. */
function realPayload(dirs, o = {}) {
  const run = readRun(dirs, 1_800_000_000);
  return { ...run, role: o.role || "both", actions: { enabled: true, production: null, jobs: [], lock: o.lock || null, form: { env_local: { exists: false } }, funding: {} } };
}
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "noid-start-"));
const BUNDLE = JSON.stringify({ hashlock: "0x" + "00".repeat(32), params: { amount_micronoid: 5000000 } });

test("an unreadable run folder beside a readable public folder with the bundle and the object file is not the start screen", () => {
  const base = tmp();
  try {
    const pub = path.join(base, "pub");
    fs.mkdirSync(pub);
    fs.writeFileSync(path.join(pub, "alice.bundle.json"), BUNDLE);
    fs.writeFileSync(path.join(pub, "swap.object.json"), JSON.stringify({ address: "o1x" }));
    const p = realPayload([path.join(base, "gone"), pub]);
    assert.equal(p.dirs[0].readable, false);
    assert.equal(S.noSwapStarted(p, "alice"), false, "the share to the run folder dropped: the old page with its errors");
    // the same folders, all readable: the start screen
    const run = path.join(base, "run");
    fs.mkdirSync(run);
    assert.equal(S.noSwapStarted(realPayload([run, pub]), "alice"), true);
    // the lazily missing run folder alone: still the start screen, step 1
    const lazy = realPayload([path.join(base, "gone")], { lock: { held: false, folder_missing: true } });
    assert.equal(lazy.readable, false);
    assert.equal(S.noSwapStarted(lazy, "alice"), true);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("a tick of Alice's in any form (empty, half written, only its .err file) is not the start screen", () => {
  const base = tmp();
  try {
    const run = path.join(base, "run");
    fs.mkdirSync(run);
    const check = () => S.noSwapStarted(realPayload([run]), "alice");
    assert.equal(check(), true, "nothing of hers");
    fs.writeFileSync(path.join(run, "last-tick-alice.err"), "warning: something\n");
    assert.equal(check(), false, "only the .err file");
    fs.rmSync(path.join(run, "last-tick-alice.err"));
    fs.writeFileSync(path.join(run, "last-tick-alice.json"), "");
    assert.equal(check(), false, "an empty tick file");
    fs.writeFileSync(path.join(run, "last-tick-alice.json"), '{"phase": "crea');
    assert.equal(check(), false, "a half written tick file");
    fs.rmSync(path.join(run, "last-tick-alice.json"));
    fs.writeFileSync(path.join(run, "loop-alice.txt"), "");
    assert.equal(check(), false, "a loop file");
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("a running or a failed prepare is not done, even with the bundle file there, and the strip stays on prepare", () => {
  const base = { env: { exists: true, bytes: 5, mtime: 1 }, bundle: { params: {} }, bundle_file: { path: "p", name: "alice.bundle.json" } };
  const steps = (jobs) => S.startSteps(S.startFacts(payload({ ...base, jobs })));
  const next = (st) => st.find((s) => s.state === "now");
  // no record of prepare: the bundle file shows it
  assert.equal(next(steps([job("install"), job("setup")])).id, "check");
  // running
  let st = steps([job("install"), job("setup"), job("prepare", { state: "running", ok: null, finished_at: null })]);
  assert.equal(next(st).id, "prepare");
  assert.equal(next(st).rec, "running");
  assert.equal(st[3].done_by, null);
  // failed after the bundle was written
  st = steps([job("install"), job("setup"), job("prepare", { ok: false, exit_code: 7 })]);
  assert.equal(next(st).id, "prepare");
  assert.equal(next(st).rec, "failed");
  // no inference from the bundle file then: only the clean records count
  st = steps([job("prepare", { ok: false })]);
  assert.equal(next(st).id, "install");
  // a clean prepare after a failed one: done
  st = steps([job("prepare", { ok: false }), job("prepare")]);
  assert.equal(next(st).id, "check");
  // the object check cannot move the strip past a failed prepare either
  st = S.startSteps(S.startFacts(payload({ ...base, check: true, jobs: [job("install"), job("setup"), job("prepare", { ok: false })] })));
  assert.equal(next(st).id, "prepare");
  assert.equal(st[4].state, "done", "the check has its own fact");
});

test("the newest record of an action decides: a clean setup followed by a failed or a running one is not done", () => {
  const f = (jobs) => S.startFacts(payload({ jobs, env: { exists: true, bytes: 5, mtime: 1 } }));
  assert.equal(f([job("setup"), job("setup", { ok: false })]).setup, null);
  assert.equal(f([job("setup"), job("setup", { state: "running", ok: null })]).setup, null);
  assert.deepEqual(f([job("setup", { ok: false }), job("setup")]).setup, { at: 1_800_000_000 });
  assert.equal(f([job("install"), job("setup"), job("setup", { ok: false })]).states.setup, "failed");
  const st = S.startSteps(f([job("install"), job("setup"), job("setup", { ok: false })]));
  assert.equal(st[2].state, "now");
});

test("the bundle check line is Alice's own: only the line with 'bundle copied to', from the newest clean prepare record", () => {
  const A = "bundle copied to /pub (send it as a file, not as pasted text) -- bundle check: one two three four";
  const out = ["== start", "bundle check: local new-bob line one two three", A].join("\n");
  assert.equal(S.bundleCheckLine([job("prepare", { stdout: out })]), "bundle check: one two three four", "not the first match");
  assert.equal(S.bundleCheckLine([job("prepare", { stdout: "bundle check: only the new-bob line" })]), null, "no line that can be told to be hers");
  assert.equal(S.bundleCheckLine([job("prepare", { stdout: "bundle copied to /pub (send it as a file, not as pasted text) -- no bundle check line in new-alice.err" })]), null);
  assert.equal(S.bundleCheckLine([job("prepare", { stdout: out }), job("prepare", { stdout: "x", ok: false })]), "bundle check: one two three four", "from the newest CLEAN record");
  assert.equal(S.bundleCheckLine([job("prepare", { stdout: A.replace("one", "old") }), job("prepare", { stdout: A })]), "bundle check: one two three four");
  assert.equal(S.bundleCheckLine([job("prepare", { stdout: out, ok: false })]), null);
  assert.equal(S.bundleCheckLine([]), null);
});

test("only the missing run folder is excused: any other folder that was not read, with or without an error entry, turns the start screen off", () => {
  const unread = [{ path: "run", readable: false }, { path: "pub", readable: true }];
  assert.equal(S.noSwapStarted(payload({ dirs: unread, errors: [] }), "alice"), false, "a folder marked unreadable, even with no error listed");
  const lazy = { held: false, folder_missing: true };
  assert.equal(S.noSwapStarted(payload({ lock: lazy, dirs: unread, errors: ["ENOENT run"] }), "alice"), true, "the lazily missing run folder with its own error");
  assert.equal(S.noSwapStarted(payload({ lock: lazy, dirs: [{ path: "run", readable: false }, { path: "pub", readable: false }], errors: ["ENOENT run", "EACCES pub"] }), "alice"), false, "the public folder unreadable too");
  assert.equal(S.noSwapStarted(payload({ lock: lazy, dirs: unread, errors: ["ENOENT run", "something else"] }), "alice"), false, "a second error");
});
