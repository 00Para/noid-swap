"use strict";
/*
 * The four POST routes of the actions mode, after server.js has done the transport checks (Host, Origin, token,
 * content type, body size). Each takes a parsed JSON object and answers { status, body }, or throws an error that
 * carries `status` (and `reasons` / `errors`).
 *
 *   POST /api/action  {"id": "..."}                    a setup, tick, dry-run or watch action of lib/actions.js (never a spend)
 *   POST /api/spend   {"id": "...", "typed": "...", "no_pending_funding": true, "bob_check_matches": true}   a spending action; lib/gate.js decides (the last two fields only for send-fund)
 *   POST /api/autopilot {"on": true, "role", "typed", "statements": {...}} | {"on": false, "role"} | {"clear_needs_you": "<spend id>", "role"}   lib/autopilot.js decides; the body never reaches a spend as `auto`
 *   POST /api/funded  {"checked": true}                the operator says Alice's wallet funding was done (only logged)
 *   POST /api/newswap {"fields": {...}, "replace": b}  the new-swap form -> $L/env.local.sh
 *   POST /api/board   {"op": "post", "noid_micro", "wei"} | {"op": "take", "offer_id"} | {"op": "cancel"}   the offer board (only with --board; lib/board/host.js): the answer is its view, enum codes only
 */

const { validateForm, writeEnvLocal } = require("./swapform");

const ACTION_POSTS = new Set(["/api/action", "/api/spend", "/api/autopilot", "/api/funded", "/api/newswap", "/api/board"]);

const bad = (status, message, extra) => Object.assign(new Error(message), { status }, extra || {});

function handleActionPost(p, body, { actions, runDir, board, startMeta }) {
  switch (p) {
    case "/api/action": {
      if (typeof body.id !== "string") throw bad(400, 'body must be {"id": "..."}');
      // startMeta is made by the server only (program mode: the file the shell's dialog chose for join); nothing of it comes from a request
      const job = actions.startAction(body.id, startMeta && typeof startMeta === "object" ? { ...startMeta } : {});
      return { status: 202, body: { accepted: true, job } };
    }
    case "/api/spend": {
      if (typeof body.id !== "string") throw bad(400, 'body must be {"id": "...", "typed": "..."}');
      if (typeof body.typed !== "string" || body.typed.length > 40) throw bad(400, "typed must be the confirmation text");
      // send-fund also needs the explicit second statement ("no funding of this contract is pending anywhere else"): required in the request, recorded in the audit log
      if (body.no_pending_funding !== undefined && typeof body.no_pending_funding !== "boolean") throw bad(400, "no_pending_funding must be true or false");
      // and the statement that Bob's check line was compared with Alice's own ("Bob's check line matches mine"): required and recorded the same way
      if (body.bob_check_matches !== undefined && typeof body.bob_check_matches !== "boolean") throw bad(400, "bob_check_matches must be true or false");
      const job = actions.startSpend(body.id, body.typed, { noPendingFunding: body.no_pending_funding === true, bobCheckMatches: body.bob_check_matches === true });
      return { status: 202, body: { accepted: true, job } };
    }
    case "/api/autopilot": {
      if (!actions.autopilot) throw bad(404, "the autopilot is not available on this console");
      return actions.autopilot.handle(body);
    }
    case "/api/funded": {
      if (body.checked !== true) throw bad(400, 'body must be {"checked": true}');
      return { status: 200, body: actions.acknowledgeFunding() };
    }
    case "/api/newswap": {
      actions.assertPendingLock("newswap");
      const v = validateForm(body.fields, { runNumber: actions.cfg.runNumber, serverRole: actions.cfg.role });
      if (!v.ok) {
        actions.audit.append({ action: "newswap", role: null, phase: "refused", result: `invalid: ${Object.keys(v.errors).join(",")}`.slice(0, 120) });
        throw bad(422, "the form has errors", { errors: v.errors });
      }
      if (body.replace !== undefined && typeof body.replace !== "boolean") throw bad(400, "replace must be true or false");
      // The settings of a run that has swap files or a running action are not touched: the loop sources this file on every tick,
      // and SINGLE_NODE_OK or a second node changes what the engine will accept.
      if (actions.busy) throw bad(409, "an action is running; change the settings when it is done");
      if (actions.swapFilesExist()) {
        actions.audit.append({ action: "newswap", role: null, phase: "refused", result: "refused: the run already has swap files" });
        throw bad(409, "this run already has swap files (or ticks): its settings are fixed. Start a new run for different settings");
      }
      // the line first: if it cannot be written, the file is not written either
      actions.audit.append({ action: "newswap", role: v.values.role, phase: "start", result: "writing env.local.sh", detail: `run ${v.values.run}, profile ${v.values.profile}, lock kind ${v.values.lock_kind}` });
      let w;
      try {
        w = writeEnvLocal(runDir, v.values, { replace: body.replace === true });
      } catch (e) {
        actions.audit.append({ action: "newswap", role: null, phase: "refused", result: `not written: ${e.message}`.slice(0, 120) });
        throw e;
      }
      // The audit lines name the run and what was set up, not the addresses.
      actions.audit.append({ action: "newswap", role: v.values.role, phase: "end", result: "env.local.sh written", detail: w.backup ? "old file kept" : null });
      return { status: 200, body: { ok: true, written: true, file: "env.local.sh", backup: !!w.backup, bytes: w.bytes } };
    }
    case "/api/board": {
      if (!board) throw bad(404, "the offer board is not available on this console (start with --board)");
      actions.assertPendingLock("board");
      if (body.op === "post") {
        if (typeof body.noid_micro !== "string" || !/^[1-9]\d{0,19}$/.test(body.noid_micro) || typeof body.wei !== "string" || !/^[1-9]\d{0,29}$/.test(body.wei)) throw bad(400, "noid_micro and wei are whole numbers as text");
        return { status: 200, body: { ok: true, board: board.postOffer({ noid_micro: body.noid_micro, wei: body.wei }) } };
      }
      if (body.op === "take") {
        if (typeof body.offer_id !== "string" || !/^[0-9a-f]{64}$/.test(body.offer_id)) throw bad(400, "offer_id is 64 lower-case hex characters");
        return { status: 200, body: { ok: true, board: board.takeOffer(body.offer_id) } };
      }
      if (body.op === "cancel") return { status: 200, body: { ok: true, board: board.cancel("user") } };
      throw bad(400, 'op is "post", "take" or "cancel"');
    }
    default:
      throw bad(404, "not found");
  }
}

module.exports = { handleActionPost, ACTION_POSTS };
