"use strict";
// The shared body of the two stub tools (stub-swap-cli.js, stub-live.js) of the step tests. Not a test file.
// A stub learns where to log and what to answer from the environment the step gives it through ctx.stubEnv (test-only):
//   STUB_LOG        a file the stub appends one JSON line per call to: argv, whether SWAP_PASSPHRASE was set (never its value), the names of all
//                   environment variables, a few harmless values, cwd, and the sha256, length and line count of stdin (never the bytes)
//   STUB_SCENARIO   a JSON file { "swapCli": { KEY: ENTRY }, "liveJs": { KEY: ENTRY } }; KEY is the first two arguments joined by a space ("wallet balance"),
//                   else the first ("tick"), else "*"; ENTRY (or an array of them, one per call of that key, the last repeating) is
//                   { stdout, stderr, code, delayMs, hang, touch }: `touch` creates the files named by --record-noid and --record-eth
//   STUB_PASS_SHA256  the sha256 of the passphrase the step should have given; the log then says `passMatches`
const fs = require("fs");
const crypto = require("crypto");

function pick(scenario, argv) {
  const k2 = argv.slice(0, 2).join(" ");
  if (argv.length > 1 && scenario[k2] !== undefined) return k2;
  if (argv.length > 0 && scenario[argv[0]] !== undefined) return argv[0];
  return scenario["*"] !== undefined ? "*" : null;
}

function run(name) {
  const argv = process.argv.slice(2);
  let all = {};
  try {
    all = JSON.parse(fs.readFileSync(process.env.STUB_SCENARIO, "utf8"));
  } catch {
    all = {};
  }
  const scenario = all[name] || {};
  const key = pick(scenario, argv);
  const hash = crypto.createHash("sha256");
  let length = 0;
  let nl = 0;
  process.stdin.on("data", (c) => {
    hash.update(c);
    length += c.length;
    for (const b of c) if (b === 10) nl++;
  });
  process.stdin.on("error", () => {});
  process.stdin.on("end", () => {
    let n = 0;
    try {
      for (const l of fs.readFileSync(process.env.STUB_LOG, "utf8").split("\n")) {
        if (!l) continue;
        const o = JSON.parse(l);
        if (o.tool === name && o.key === key) n++;
      }
    } catch {
      n = 0;
    }
    const names = Object.keys(process.env).filter((k) => !k.startsWith("=")).sort();
    const passSha = process.env.STUB_PASS_SHA256;
    const rec = {
      tool: name,
      key,
      n,
      argv,
      pass: !!process.env.SWAP_PASSPHRASE,
      passMatches: passSha && process.env.SWAP_PASSPHRASE ? crypto.createHash("sha256").update(process.env.SWAP_PASSPHRASE).digest("hex") === passSha : null,
      envNames: names,
      env: { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, NOID_SWAP_HOME: process.env.NOID_SWAP_HOME, ETH_RPC_URL: process.env.ETH_RPC_URL },
      cwd: process.cwd(),
      stdin: { sha256: hash.digest("hex"), length, lines: nl },
    };
    fs.appendFileSync(process.env.STUB_LOG, `${JSON.stringify(rec)}\n`);
    let entry = key === null ? {} : scenario[key];
    if (Array.isArray(entry)) entry = entry[Math.min(n, entry.length - 1)] || {};
    if (entry.touch) {
      for (let i = 0; i < argv.length - 1; i++) if (argv[i] === "--record-noid" || argv[i] === "--record-eth") fs.writeFileSync(argv[i + 1], "{}\n");
    }
    const finish = () => {
      if (entry.stdout) process.stdout.write(entry.stdout);
      if (entry.stderr) process.stderr.write(entry.stderr);
      process.exitCode = entry.code === undefined ? 0 : entry.code;
    };
    if (entry.hang) {
      setInterval(() => {}, 1000);
      return;
    }
    if (entry.delayMs) setTimeout(finish, entry.delayMs);
    else finish();
  });
}

module.exports = { run };
