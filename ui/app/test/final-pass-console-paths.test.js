"use strict";
// Program mode, 4.5-L10: the texts the console sends to the page show a path below the program's data folder relative to it and a path below the home folder as `~`, so a
// screenshot does not carry the account name. Files on disk keep their full paths. A fake data folder and home folder; nothing here touches a wallet, a node or a chain.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { pagePathRewriter } = require("../server");
const { makeEnv, until } = require("./program-harness");
const { statusText, WNA, WTX } = require("./wallet-harness");
const F = require("./actions-fixtures");

const WIN = { dataDir: "C:\\Users\\acct\\AppData\\Local\\No1d Swap", home: "C:\\Users\\acct" };
const MAC = { dataDir: "/Users/acct/Library/Application Support/No1d Swap", home: "/Users/acct" };

test("a path below the data folder is shown relative to it, a path below the home folder as ~, a path outside both is unchanged (Windows)", () => {
  const f = pagePathRewriter(WIN);
  assert.equal(f("bundle: C:\\Users\\acct\\AppData\\Local\\No1d Swap\\runs\\7247e276\\alice.bundle.json"), "bundle: runs\\7247e276\\alice.bundle.json");
  assert.equal(f("copied to C:\\Users\\acct\\Documents\\notes.txt now"), "copied to ~\\Documents\\notes.txt now");
  assert.equal(f("tool C:\\Program Files\\Tool\\x.exe"), "tool C:\\Program Files\\Tool\\x.exe");
  assert.equal(f("folder C:\\Users\\acct\\AppData\\Local\\No1d Swap is not private"), "folder the program's data folder is not private");
  assert.equal(f("home C:\\Users\\acct."), "home ~.");
  // forward slashes and another letter case are the same folder; two separators in a row (a doubled backslash in a quoted text) too
  assert.equal(f("c:/users/ACCT/appdata/local/no1d swap/runs/x/a.json"), "runs/x/a.json");
  assert.equal(f('"C:\\\\Users\\\\acct\\\\AppData\\\\Local\\\\No1d Swap\\\\runs\\\\x"'), '"runs\\\\x"');
  // a longer name that only starts like the root is not the root
  assert.equal(f("C:\\Users\\acctx\\file"), "C:\\Users\\acctx\\file");
  // two paths in one line
  assert.equal(f("from C:\\Users\\acct\\AppData\\Local\\No1d Swap\\runs\\x\\a to C:\\Users\\acct\\Desktop\\b"), "from runs\\x\\a to ~\\Desktop\\b");
});

test("the same on macOS and Linux paths (case matters there)", () => {
  const f = pagePathRewriter(MAC);
  assert.equal(f("bundle: /Users/acct/Library/Application Support/No1d Swap/runs/x/alice.bundle.json"), "bundle: runs/x/alice.bundle.json");
  assert.equal(f("saved /Users/acct/Downloads/a.json"), "saved ~/Downloads/a.json");
  assert.equal(f("/Users/acctx/Downloads/a.json"), "/Users/acctx/Downloads/a.json");
  assert.equal(f("/users/acct/Downloads/a.json"), "/users/acct/Downloads/a.json");
  assert.equal(f("/opt/tool/bin"), "/opt/tool/bin");
  assert.equal(f("see /x/Users/acct/Downloads"), "see /x/Users/acct/Downloads");
});

test("every string of a body is rewritten, keys and other values are not, and a Buffer is not touched", () => {
  const f = pagePathRewriter(WIN);
  const body = { error: "no C:\\Users\\acct\\x", reasons: [{ code: "c", text: "in C:\\Users\\acct\\AppData\\Local\\No1d Swap\\runs\\a" }], n: 3, ok: true, none: null, deep: { a: [{ b: ["C:\\Users\\acct\\z"] }] } };
  assert.deepEqual(f(body), { error: "no ~\\x", reasons: [{ code: "c", text: "in runs\\a" }], n: 3, ok: true, none: null, deep: { a: [{ b: ["~\\z"] }] } });
  assert.equal(body.error, "no C:\\Users\\acct\\x", "the original is not changed");
  const buf = Buffer.from("C:\\Users\\acct\\x");
  assert.equal(f(buf), buf);
  // a key named like the prototype stays a plain key
  const evil = JSON.parse('{"__proto__": {"x": "C:\\\\Users\\\\acct\\\\q"}}');
  assert.equal(Object.getPrototypeOf(f(evil)), Object.prototype);
  // no root known: nothing changes
  assert.equal(pagePathRewriter({})(body), body);
  assert.equal(pagePathRewriter({ dataDir: "C:\\", home: "" })(body), body);
});

async function idle(runner) {
  await until(() => runner.busy === null, "the action to end");
}

test("through the program's server: a step line, a refusal text and a job record reach the page without the account part; the files on disk and the job in memory keep the full path", async () => {
  const env = makeEnv();
  try {
    const a = env.addSwap({ role: "alice" });
    env.writeTerms(a, { aliceNoid: WNA });
    env.swapFile(a, "alice");
    env.writeTick(a, "alice", F.spendTick("fund_noid"));
    env.writeLoop(a, "alice");
    const bundle = path.join(a.dir, "alice.bundle.json");
    const homeFile = path.join(env.program.home, "Documents", "notes.txt");
    const outside = path.join(path.dirname(env.root), "elsewhere", "tool.exe");
    env.steps.results.walletStatus = { code: 0, stdout: statusText("alice"), stderr: "", files: [] };
    env.steps.results.walletFund = (ctx) => {
      fs.writeFileSync(path.join(ctx.runDir, "wallet-note.txt"), `bundle: ${bundle}\n`);
      return { code: 3, stdout: `wallet-fund: wallet ${WNA}\nbundle: ${bundle}\nsaved ${homeFile}\ntool ${outside}\nwallet-fund exit 3\n`, stderr: `error: cannot read ${bundle}\n`, files: ["wallet-note.txt"] };
    };
    const { srv, api } = await env.start();
    const sw = srv.swapSet.get(a.id);
    srv.swapSet.tick();
    await idle(sw.runner);
    const rel = path.join("runs", a.id, "alice.bundle.json");
    // the job record in the answer of the POST and in the run payload
    const post = await api("POST", "/api/action", { swap: a.id, id: "dry-fund" });
    assert.equal(post.status, 202, post.text);
    await idle(sw.runner);
    const run = await api("GET", `/api/run?swap=${a.id}`);
    for (const t of [post.text, run.text]) {
      assert.ok(!t.includes(env.dataDir.replace(/\\/g, "\\\\")) && !t.includes(env.dataDir), "no data folder path");
      assert.ok(!t.includes(env.program.home.replace(/\\/g, "\\\\")) && !t.includes(env.program.home), "no home path");
    }
    const job = run.body.actions.jobs.find((j) => j.id === "dry-fund");
    assert.ok(job, JSON.stringify(run.body.actions.jobs.map((j) => j.id)));
    assert.ok(job.stdout.includes(`bundle: ${rel}`), job.stdout);
    assert.ok(job.stdout.includes("saved ~"), job.stdout);
    assert.ok(job.stdout.includes(outside), "a path outside both folders is shown unchanged");
    assert.ok(job.stderr.includes(`cannot read ${rel}`), job.stderr);
    // the files on disk and the job in memory keep the full path
    assert.ok(fs.readFileSync(path.join(a.dir, "wallet-note.txt"), "utf8").includes(bundle), "the file on disk is not changed");
    assert.ok(sw.runner.jobs.find((j) => j.id === "dry-fund").stdout.includes(bundle), "the record in memory is not changed");
  } finally {
    await env.cleanup();
  }
});

test("through the program's server: a refusal text that names a folder reaches the page without the account part", async () => {
  const env = makeEnv();
  try {
    const a = env.addSwap({ role: "alice" });
    env.guard.ok = false;
    env.guard.why = `the access rules of ${a.dir} (and ${path.join(env.program.home, "Documents")}) are wrong`;
    const { api } = await env.start();
    const r = await api("POST", "/api/action", { swap: a.id, id: "tick-alice" });
    assert.equal(r.status, 409, r.text);
    assert.equal(r.body.error, `this folder is not private to you: the access rules of ${path.join("runs", a.id)} (and ~${path.sep}Documents) are wrong`);
    assert.ok(!r.text.includes(env.root) && !r.text.includes(env.root.split("\\").join("\\\\")), r.text);
  } finally {
    await env.cleanup();
  }
});
