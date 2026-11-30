"use strict";
/*
 * Reads what a live run leaves in its folder, read-only, from an ALLOWLIST of file names:
 *
 *   last-tick-ROLE.json   the last `swap-cli tick` (scripts/live/tick.sh)
 *   last-tick-ROLE.err    its stderr (first lines shown)
 *   loop-ROLE.txt         the watch loop's one-line-per-tick history (tail only)
 *   alice.bundle.json     Alice's public bundle (hashlock, authority, parameters; opening dropped)
 *   swap.object.json      the wallet's object file (public terms; opening dropped)
 *   eth-lock*.json, eth-claim*.json, eth-refund*.json, claim-N.out   dry-run outputs and receipts of the helpers
 *   verify.out            the equivalence-receipt verifier's output
 *
 * Anything else in the folder (`*.swap.json`, `passphrase.txt`, `keys/`, `*.receipt`, `rec/`, `bin/`, claim intents,
 * `env.local.sh`) is never opened; only the COUNT of such entries is reported, so the operator can see the reader
 * is not skipping silently. Every parsed JSON goes through `redactDeep` before it leaves this module.
 */

const fs = require("fs");
const path = require("path");
const { redactDeep, secretPathReason } = require("./secrets");
const { parseLoopText } = require("./looptext");
const { termsFrom } = require("./config");

const MAX_JSON = 4 * 1024 * 1024; // a tick with a busy mempool is tens of KB; refuse anything absurd
const LOOP_TAIL = 192 * 1024;
const ERR_LINES = 12;
const ERR_CHARS = 1600;

const ROLES = ["alice", "bob"];

// scripts/live/tick.sh truncates last-tick-ROLE.json, runs the tick for 10 to 20 s and only then writes the content: for that long a read
// sees an empty or half-written file. An empty / unparsable tick file whose own time is at most this old is "being written", not "broken".
const TICK_WRITING_S = 90;
const CLOCK_SKEW_S = 30;

/**
 * The last COMPLETE tick this process parsed for each tick file, with the file time it had. It is for display only: while the file is being
 * rewritten the page keeps showing that tick (labelled), and the gate of a spend does not use it (it refuses with `tick_writing`).
 */
class TickKeeper {
  constructor() {
    this.last = new Map();
  }
  remember(key, value, mtime) {
    this.last.set(key, { value, mtime, parsed_at: Math.floor(Date.now() / 1000) });
  }
  recall(key) {
    return this.last.get(key) || null;
  }
}
const defaultKeeper = new TickKeeper();

const PATTERNS = [
  ["tick", /^last-tick-(alice|bob)\.json$/],
  ["tick_err", /^last-tick-(alice|bob)\.err$/],
  ["loop", /^loop-(alice|bob)\.txt$/],
  ["bundle", /^(?:alice\.)?bundle\.json$/],
  ["object", /^swap\.object\.json$/],
  ["eth_lock", /^eth-lock(?:-\d+)?\.json$/],
  ["eth_claim", /^eth-claim(?:-dry-\d+)?\.json$/],
  ["eth_refund", /^eth-refund(?:-\d+)?\.json$/],
  ["claim_out", /^claim-\d+\.out$/],
  ["helper_err", /^(?:eth-lock(?:-\d+)?|eth-claim(?:-dry-\d+)?|eth-refund(?:-\d+)?|claim-\d+)\.err$/],
  ["verify", /^verify\.out$/],
];

/** `\\wsl.localhost\Distro\home\u\run` <-> `\\wsl$\Distro\...`. */
function pathCandidates(p) {
  const c = [p];
  // either slash style: //wsl.localhost/Distro/... works in node and survives a bash prompt
  const m = /^([\\/]{2})wsl(\.localhost|\$)([\\/])/i.exec(p);
  if (m) c.push(m[1] + "wsl" + (m[2] === "$" ? ".localhost" : "$") + m[3] + p.slice(m[0].length));
  return c;
}

/** `{distro, linux}` for a WSL share path (`\\wsl.localhost\Distro\home\u\run` or `//wsl.localhost/Distro/home/u/run`); null otherwise. */
function wslParts(p) {
  const m = /^[\\/]{2}wsl(?:\.localhost|\$)[\\/]([^\\/]+)[\\/](.*)$/i.exec(String(p || ""));
  if (!m) return null;
  return { distro: m[1], linux: "/" + m[2].split(/[\\/]+/).filter(Boolean).join("/") };
}

function classify(name) {
  for (const [kind, re] of PATTERNS) {
    const m = re.exec(name);
    if (m) return { kind, role: m[1] && ROLES.includes(m[1]) ? m[1] : null };
  }
  return null;
}

function listDir(dir) {
  let lastErr = null;
  for (const c of pathCandidates(dir)) {
    try {
      return { dir: c, names: fs.readdirSync(c) };
    } catch (e) {
      lastErr = e;
    }
  }
  return { dir, names: null, error: lastErr ? lastErr.code || lastErr.message : "unreadable" };
}

function statOf(full) {
  try {
    const st = fs.statSync(full);
    return st.isFile() ? { mtime: Math.floor(st.mtimeMs / 1000), size: st.size } : null;
  } catch {
    return null;
  }
}

function readCapped(full, max, tail) {
  const reason = secretPathReason(full);
  if (reason) throw new Error(`refusing to read ${full} (${reason})`);
  const st = fs.statSync(full);
  if (!tail && st.size > max) throw new Error(`file too large (${st.size} bytes)`);
  if (tail && st.size > max) {
    const fd = fs.openSync(full, "r");
    try {
      const buf = Buffer.alloc(max);
      fs.readSync(fd, buf, 0, max, st.size - max);
      const text = buf.toString("utf8");
      return text.slice(text.indexOf("\n") + 1); // drop the cut first line
    } finally {
      fs.closeSync(fd);
    }
  }
  return fs.readFileSync(full, "utf8");
}

/** Plain text scrub for stderr / outputs: no line that looks like it carries a secret value. */
function scrubText(text, maxChars = ERR_CHARS, maxLines = ERR_LINES) {
  const out = [];
  for (const raw of String(text || "").split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (!line) continue;
    if (/\b(preimage|secret|passphrase|master)\b[^\n]{0,24}(0x)?[0-9a-fA-F]{32,}/i.test(line)) {
      out.push("[line withheld: it looks like it carries a secret value]");
    } else out.push(line.length > 400 ? line.slice(0, 400) + "…" : line);
    if (out.length >= maxLines) break;
  }
  const s = out.join("\n");
  return s.length > maxChars ? s.slice(0, maxChars) + "…" : s;
}

const DROP_KEYS = new Set(["data", "intent_bytes_hex"]);
function dropLong(v, depth = 0) {
  if (depth > 12) return null;
  if (Array.isArray(v)) return v.slice(0, 40).map((x) => dropLong(x, depth + 1));
  if (v && typeof v === "object") {
    const o = {};
    for (const [k, x] of Object.entries(v)) if (!DROP_KEYS.has(k)) o[k] = dropLong(x, depth + 1);
    return o;
  }
  if (typeof v === "string" && v.length > 300) return v.slice(0, 300) + "…";
  return v;
}

/** One helper output file -> `{kind, file, mtime, dry, ok, summary}`; never throws. */
function readHelperFile(dir, name, kind, mtime) {
  const entry = { kind, file: name, mtime, dry: null, ok: false, summary: null, error: null };
  try {
    const text = readCapped(path.join(dir, name), MAX_JSON, false);
    if (!text.trim()) {
      entry.error = "empty (the helper failed before printing a result)";
      return entry;
    }
    const j = JSON.parse(text);
    const s = dropLong(redactDeep(j));
    entry.summary = s;
    if (kind === "claim_out") {
      entry.dry = s.mode === "dry_run" || (s.mode !== "submit" && s.submitted === false);
      entry.ok = s.mode === "dry_run" || s.mode === "submit";
      entry.claim = typeof s.claim === "string" ? s.claim : null;
    } else {
      entry.dry = j.dryRun === true || j.sent === false;
      entry.ok = true;
    }
  } catch (e) {
    entry.error = `unreadable: ${e.message}`;
  }
  return entry;
}

/** Public terms, without the 699-byte opening. */
function publicTerms(bundle, object) {
  if (!bundle && !object) return null;
  const t = termsFrom(object || null, bundle || null);
  delete t.opening_hex;
  const p = (bundle && bundle.params) || {};
  t.profile = p.profile || "production";
  t.profile_explicit = !!p.profile; // false: the bundle does not say, "production" is only the console's careful assumption for its margins
  t.contract_version = p.contract_version || 1;
  t.chain_id = t.eth && t.eth.chain_id;
  return redactDeep(t);
}

/**
 * Read one or more directories (run folder first, then optional public copies).
 * @returns {{dirs, readable, files, withheld, roles, bundle, object, terms, helpers, verify, errors}}
 */
function readRun(dirs, now = Math.floor(Date.now() / 1000), opts = {}) {
  const keeper = opts.keeper || defaultKeeper;
  const out = {
    dirs: [],
    readable: false,
    generated_at: now,
    files: [],
    withheld: 0,
    errors: [],
    roles: { alice: null, bob: null },
    bundle: null,
    object: null,
    object_file: null,
    bundle_file: null,
    terms: null,
    helpers: [],
    verify: null,
    wsl: null,
  };
  const best = {}; // singleton kinds: newest wins
  const pick = (key, dir, name, st) => {
    if (!best[key] || st.mtime > best[key].mtime) best[key] = { dir, name, mtime: st.mtime, size: st.size };
  };
  const helperFiles = [];
  for (const d of dirs) {
    if (!d) continue;
    const listing = listDir(d);
    out.dirs.push({ path: listing.dir, readable: !!listing.names, error: listing.error || null });
    if (!out.wsl) out.wsl = wslParts(d);
    if (!listing.names) {
      out.errors.push(`${d}: ${listing.error}`);
      continue;
    }
    out.readable = true;
    for (const name of listing.names) {
      const c = classify(name);
      const full = path.join(listing.dir, name);
      if (!c) {
        out.withheld++;
        continue;
      }
      const st = statOf(full);
      if (!st) continue;
      if (c.kind === "tick" || c.kind === "tick_err" || c.kind === "loop") pick(`${c.kind}:${c.role}`, listing.dir, name, st);
      else if (c.kind === "bundle" || c.kind === "object" || c.kind === "verify") pick(c.kind, listing.dir, name, st);
      else helperFiles.push({ dir: listing.dir, name, kind: c.kind, st });
    }
  }

  const readJsonKey = (key) => {
    const b = best[key];
    if (!b) return null;
    try {
      const j = JSON.parse(readCapped(path.join(b.dir, b.name), MAX_JSON, false));
      out.files.push({ name: b.name, mtime: b.mtime, size: b.size });
      return { value: j, mtime: b.mtime };
    } catch (e) {
      out.files.push({ name: b.name, mtime: b.mtime, size: b.size, error: e.message });
      return { error: e.message, mtime: b.mtime };
    }
  };

  /**
   * One tick file. A complete tick is remembered. An empty or unparsable file whose own time is recent is "being written" (`writing`): the
   * caller gets the last complete tick (`cached`, with ITS file time) for display only. Never a partial tick as a valid one.
   */
  const readTick = (role) => {
    const b = best[`tick:${role}`];
    if (!b) return null;
    const full = path.join(b.dir, b.name);
    let text;
    let error = null;
    let partial = false;
    let value = null;
    try {
      text = readCapped(full, MAX_JSON, false);
      if (!text.trim()) {
        error = "the tick file is empty";
        partial = true;
      } else {
        try {
          const j = JSON.parse(text);
          if (j && typeof j === "object" && !Array.isArray(j)) value = j;
          else error = "the tick file is not a JSON object";
        } catch (e) {
          error = e.message;
          partial = true;
        }
      }
    } catch (e) {
      error = e.message;
    }
    if (value) {
      keeper.remember(full, redactDeep(value), b.mtime);
      out.files.push({ name: b.name, mtime: b.mtime, size: b.size });
      return { value, mtime: b.mtime };
    }
    out.files.push({ name: b.name, mtime: b.mtime, size: b.size, error });
    const age = now - b.mtime;
    if (partial && age <= TICK_WRITING_S && age >= -CLOCK_SKEW_S) {
      const kept = keeper.recall(full);
      return { error, mtime: b.mtime, writing: true, cached: kept ? { value: kept.value, mtime: kept.mtime } : null };
    }
    return { error, mtime: b.mtime };
  };

  const bundle = readJsonKey("bundle");
  const object = readJsonKey("object");
  // the file the terms were read from (the newest swap.object.json of all the folders): the console binds the funding dry run to THIS file
  out.object_file = best.object ? { dir: best.object.dir, name: best.object.name, path: path.join(best.object.dir, best.object.name) } : null;
  // the bundle file the bundle was read from (the newest of all the folders), by the same rule: the start screen shows where the file Bob needs is
  out.bundle_file = best.bundle ? { dir: best.bundle.dir, name: best.bundle.name, path: path.join(best.bundle.dir, best.bundle.name) } : null;
  if (bundle && bundle.error) out.errors.push(`bundle: ${bundle.error}`);
  if (object && object.error) out.errors.push(`object: ${object.error}`);
  const bundleValue = bundle && bundle.value ? bundle.value : null;
  const objectValue = object && object.value ? object.value : null;
  out.bundle = bundleValue ? redactDeep(Object.fromEntries(Object.entries(bundleValue).filter(([k]) => k !== "opening_hex"))) : null;
  out.object = objectValue ? redactDeep(Object.fromEntries(Object.entries(objectValue).filter(([k]) => !["opening_hex", "program"].includes(k)))) : null;
  out.terms = publicTerms(bundleValue, objectValue);

  for (const role of ROLES) {
    const t = readTick(role);
    const e = best[`tick_err:${role}`];
    const l = best[`loop:${role}`];
    if (!t && !e && !l) continue;
    const r = { tick: null, tick_mtime: t ? t.mtime : null, tick_error: null, tick_writing: false, tick_cached: false, err_text: null, loop: null, loop_mtime: null };
    if (t && t.value) r.tick = redactDeep(t.value);
    else if (t && t.writing) {
      // being rewritten right now: not an error. The page keeps the last complete tick (its own file time), the gate of a spend refuses.
      r.tick_writing = true;
      if (t.cached) {
        r.tick = t.cached.value;
        r.tick_mtime = t.cached.mtime;
        r.tick_cached = true;
      } else r.tick_mtime = null;
    } else if (t && t.error) r.tick_error = t.error;
    if (e) {
      try {
        r.err_text = scrubText(readCapped(path.join(e.dir, e.name), 64 * 1024, true));
        out.files.push({ name: e.name, mtime: e.mtime, size: e.size });
      } catch (err) {
        r.err_text = null;
      }
    }
    if (l) {
      try {
        r.loop = parseLoopText(readCapped(path.join(l.dir, l.name), LOOP_TAIL, true));
        r.loop_mtime = l.mtime;
        out.files.push({ name: l.name, mtime: l.mtime, size: l.size });
      } catch (err) {
        r.loop = { entries: [], total: 0, error: err.message };
      }
    }
    out.roles[role] = r;
  }

  // Helper outputs: newest 24 of all kinds; the .err beside a failed one explains the refusal.
  helperFiles.sort((a, b) => b.st.mtime - a.st.mtime);
  const errByStem = new Map();
  for (const f of helperFiles) if (f.kind === "helper_err") errByStem.set(f.name.replace(/\.err$/, ""), f);
  for (const f of helperFiles.filter((x) => x.kind !== "helper_err").slice(0, 24)) {
    const entry = readHelperFile(f.dir, f.name, f.kind, f.st.mtime);
    const stem = f.name.replace(/\.(json|out)$/, "");
    const ef = errByStem.get(stem);
    if (ef && (entry.error || !entry.ok || entry.dry !== null)) {
      try {
        entry.err_text = scrubText(readCapped(path.join(ef.dir, ef.name), 64 * 1024, true), 900, 6);
      } catch {
        /* optional */
      }
    }
    out.files.push({ name: f.name, mtime: f.st.mtime, size: f.st.size });
    out.helpers.push(entry);
  }

  if (best.verify) {
    try {
      const t = scrubText(readCapped(path.join(best.verify.dir, best.verify.name), 64 * 1024, true), 800, 8);
      out.verify = { file: best.verify.name, mtime: best.verify.mtime, ok: /\bOK\b/.test(t) && /sha256\(m\)\s*=\s*H/.test(t), text: t };
      out.files.push({ name: best.verify.name, mtime: best.verify.mtime, size: best.verify.size });
    } catch {
      /* optional */
    }
  }
  return out;
}

module.exports = { readRun, TickKeeper, TICK_WRITING_S, scrubText, classify, wslParts, pathCandidates, publicTerms, readHelperFile, PATTERNS };
