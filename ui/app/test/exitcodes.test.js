"use strict";
// What a spending helper's exit status means (lib/exitcodes.js), and that ui/app/README.md lists exactly that table.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const X = require("../lib/exitcodes");

const clean = (script, o) => X.classifySpendExit(script, o);

test("only a documented 'nothing was sent' status, with output that agrees and no result file of the send, is a clean refusal", () => {
  const lock3 = "lock REFUSED, nothing sent: the fresh read-only tick right before the send does not show a lock to send.\n";
  assert.deepEqual(
    (({ outcome, nothing_sent, secret_may_be_public }) => ({ outcome, nothing_sent, secret_may_be_public }))(clean("lock.sh", { exitCode: 3, stdout: lock3 })),
    { outcome: "refused_nothing_sent", nothing_sent: true, secret_may_be_public: false }
  );
  assert.equal(clean("lock.sh", { exitCode: 2, stdout: "" }).nothing_sent, true);
  assert.equal(clean("reveal.sh", { exitCode: 2 }).nothing_sent, true);
  assert.equal(clean("refund-eth.sh", { exitCode: 2 }).nothing_sent, true);
  assert.equal(clean("claim.sh", { exitCode: 2 }).nothing_sent, true);
  assert.equal(clean("fund.sh", { exitCode: 2 }).nothing_sent, true);
  assert.equal(clean("fund.sh", { exitCode: 3, stdout: "REFUSED: the contract already has 1 instance(s)\n" }).nothing_sent, true);
  // not clean: the refusal line missing, a result file of the send, an undocumented status, no status, a signal, a timeout, no outcome at all
  assert.equal(clean("lock.sh", { exitCode: 3, stdout: "nothing sent" }).nothing_sent, false, "the line is needed");
  assert.equal(clean("lock.sh", { exitCode: 3, stdout: lock3, hasResult: true }).nothing_sent, false);
  assert.equal(clean("lock.sh", { exitCode: 1, stdout: lock3 }).nothing_sent, false);
  assert.equal(clean("lock.sh", { exitCode: 4, stdout: lock3 }).nothing_sent, false);
  assert.equal(clean("lock.sh", { exitCode: null, stdout: lock3 }).nothing_sent, false);
  assert.equal(clean("lock.sh", { exitCode: 3, stdout: lock3, signal: "SIGTERM" }).nothing_sent, false);
  assert.equal(clean("lock.sh", { exitCode: 3, stdout: lock3, timedOut: true }).nothing_sent, false);
  assert.equal(clean("lock.sh", undefined).nothing_sent, false);
  assert.equal(clean("lock.sh", { exitCode: "3", stdout: lock3 }).nothing_sent, false, "a status that is not a number is unknown");
  assert.equal(clean("refund-eth.sh", { exitCode: 3 }).nothing_sent, false, "refund-eth.sh documents no exit 3");
  assert.equal(clean("claim.sh", { exitCode: 1 }).nothing_sent, false);
  assert.equal(clean("unknown.sh", { exitCode: 2 }).nothing_sent, false);
  assert.equal(clean("constructor", { exitCode: 2 }).nothing_sent, false, "no prototype keys");
  assert.equal(clean("fund.sh", { exitCode: 3, stdout: "funding 5.000000 NOID (once) at 11:46:09 UTC\n" }).nothing_sent, false, "after the wallet call exit 3 is the wallet's");
  // fund.sh ends with the wallet CLI's own exit status, so a wallet that exits 2 after the call is not a clean refusal either
  assert.equal(clean("fund.sh", { exitCode: 2, stdout: "funding 5.000000 NOID (once) at 11:46:09 UTC\n" }).nothing_sent, false, "after the wallet call exit 2 is the wallet's");
  // exit 0 is ok, never 'refused'
  assert.equal(clean("lock.sh", { exitCode: 0 }).outcome, "ok");
});

test("reveal.sh: exit 3 is 'mined and reverted: the secret is public'; every unclean reveal outcome says the secret may be public", () => {
  const r3 = clean("reveal.sh", { exitCode: 3, stdout: "claim exit 3\n" });
  assert.equal(r3.outcome, "secret_public_reverted");
  assert.equal(r3.secret_may_be_public, true);
  assert.equal(r3.nothing_sent, false);
  for (const o of [{ exitCode: 1 }, { exitCode: 9 }, { exitCode: null }, { exitCode: 1, timedOut: true }, { exitCode: null, signal: "SIGKILL" }, undefined]) {
    const r = clean("reveal.sh", o);
    assert.equal(r.nothing_sent, false, JSON.stringify(o));
    assert.equal(r.secret_may_be_public, true, JSON.stringify(o));
  }
  // the other helpers never claim the secret may be public
  assert.equal(clean("lock.sh", { exitCode: 1 }).secret_may_be_public, false);
  assert.equal(clean("reveal.sh", { exitCode: 2 }).secret_may_be_public, false, "a refusal before live.js ran");
  assert.equal(clean("reveal.sh", { exitCode: 0 }).secret_may_be_public, false);
});

test("every documented status of the table has a row in ui/app/README.md (the table there is the one in lib/exitcodes.js)", () => {
  const readme = fs.readFileSync(path.join(__dirname, "..", "README.md"), "utf8");
  const i = readme.indexOf("### What a spending helper's exit status means");
  assert.ok(i >= 0, "the README has the section");
  const section = readme.slice(i, readme.indexOf("\n### ", i + 10) < 0 ? undefined : readme.indexOf("\n### ", i + 10));
  const rows = section.split("\n").filter((l) => l.startsWith("|"));
  for (const [script, byCode] of Object.entries(X.EXIT_TABLE)) {
    for (const code of Object.keys(byCode)) {
      assert.ok(rows.some((l) => l.includes("`" + script + "`") && new RegExp("\\|\\s*" + code + "\\s*\\|").test(l)), `README row for ${script} exit ${code}`);
    }
  }
  assert.match(section, /anything else/i);
  assert.match(section, /may have been sent/);
  for (const row of Object.values(X.EXIT_TABLE).flatMap((m) => Object.values(m))) assert.ok(row.source && row.why, "every entry says where the helper documents it");
});
