"use strict";
// Fixtures for the program-mode page tests: the answers of the program API (I9 of the build specification) as the page reads them. Not a test file.
const SWAP_A = "a1".repeat(16); // an Alice swap
const SWAP_B = "b2".repeat(16); // a Bob swap
const TOKEN_HASH = "#token=" + "ab".repeat(16);

function summary(o = {}) {
  return { swap: SWAP_A, role: "alice", label: "You sell 5 NOID for 0.001 ETH", phase: null, active: false, in_contract: false, needs_you: false, until_text: null, refused: null, created_at: 1_800_000_000, ...o };
}

function prog(o = {}) {
  return {
    version: "0.1.0",
    network: "test",
    node: { noid: { state: "ok", tip: 280000, chain_checked: true, ok_since_start: true, checked_at: 1 }, eth: { state: "ok", chain_id: 11155111, endpoints: 2, checked_at: 1 } },
    vault: { ready: true, recovery_confirmed: true },
    new_swap_allowed: { ok: true, why: null },
    swaps: [summary({ swap: SWAP_A, active: true, phase: "created" }), summary({ swap: SWAP_B, role: "bob", label: "You sell 0.001 ETH for 5 NOID", created_at: 1_800_000_100 })],
    board: { enabled: false, slot: null },
    update: { state: "none", latest: null, url: null },
    ...o,
  };
}

/** A program-mode /api/run payload for a swap with no tick yet: the first screen shows. */
function runPayload(role, o = {}) {
  const ids = o.table || ["install", "setup", `wallet-setup-${role}`, "prepare", "join", "check-object", "watch-start", "watch-stop", `tick-${role}`, `wallet-status-${role}`];
  const wallet = o.wallet === null ? undefined : { on: true, ambiguous: false, noid_payout: "o1payoutxxxxxxxxxxxxxxxxxxxxxxxx", eth_payout: "0x" + "3c".repeat(20), funded_marker: null, swept: {}, recovered_txid: false, roles: { alice: { swap_file: false, addresses_file: false, status: null }, bob: { swap_file: false, addresses_file: false, status: null } }, ...(o.wallet || {}) };
  return {
    role,
    roles: { alice: null, bob: null, ...(o.roles || {}) },
    dirs: [{ path: "run", readable: true }],
    errors: [],
    terms: o.terms || null,
    helpers: [],
    commands: {},
    bundle: null,
    bundle_file: o.bundle_file || null, // the program serves { name } only: no path reaches the page
    board: o.board || null, // a board run carries the board's view
    program: o.program || { swap: null, own_noid: null }, // program mode: the swap's own facts (own_noid: Bob's Parano1d address of run.json)
    server_now: Math.floor(Date.now() / 1000),
    actions: {
      enabled: true,
      production: null,
      jobs: o.jobs || [],
      busy: o.busy || null,
      lock: { held: true, folder_missing: false },
      funding: {},
      watch: { started_here: false, some_loop_running: false, ...(o.watch || {}) },
      spends: {},
      audit: { tail: [], chain: { ok: true }, file: "ui-audit.jsonl" },
      autopilot: o.autopilot || null,
      first_steps: o.first_steps === undefined ? { running: null, failed: null, waiting: null } : o.first_steps, // what the program's first steps are doing
      check_line: o.check_line || null, // { hex, from } once the program has written check-line.json
      line_match: o.line_match || null, // { hex, at } once the person confirmed the other side's line
      table: ids.map((id) => ({ id, label: `label of ${id}`, group: "g", blocked: null, mode_blocked: null, note: "n", command: `cmd ${id}` })),
      ...(wallet ? { wallet } : {}),
      form: null,
    },
  };
}

const job = (id, o = {}) => ({ job: 1, id, label: id, state: "done", ok: true, exit_code: 0, started_at: 1_800_000_000, finished_at: 1_800_000_001, stdout: "", stderr: "", ...o });

/** A routing fetch for the page: `routes` maps "METHOD path" (path without the query) to a body or a function of the request. */
function router(routes, log) {
  return async (url, init = {}) => {
    const method = init.method || "GET";
    const p = url.split("?")[0];
    const key = `${method} ${p}`;
    const h = routes[key];
    if (log) log.push(key);
    if (h === undefined) return { status: 404, body: { error: "not found" } };
    const body = init.body ? JSON.parse(init.body) : null;
    return typeof h === "function" ? h(url, body, init) : { status: 200, body: h };
  };
}

module.exports = { SWAP_A, SWAP_B, TOKEN_HASH, summary, prog, runPayload, job, router };
