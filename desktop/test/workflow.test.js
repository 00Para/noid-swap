"use strict";
// Rules the packaging workflow and its builder configuration must keep (step 4.8). The workflow itself only runs on GitHub's
// machines; these tests read the files and fail when a rule is broken (an action not pinned, a publish step, a secret, a
// skipped check). They use js-yaml from eth/node_modules for the structure when it is installed, and plain text checks always.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const REPO = path.join(__dirname, "..", "..");
const WORKFLOW = path.join(REPO, ".github", "workflows", "build.yml");
const BUILDER = path.join(__dirname, "..", "electron-builder.yml");
const text = fs.readFileSync(WORKFLOW, "utf8");
const builderText = fs.readFileSync(BUILDER, "utf8");

let yaml = null;
try {
  yaml = require(path.join(REPO, "eth", "node_modules", "js-yaml"));
} catch {
  /* structure checks are skipped without it */
}
const doc = yaml ? yaml.load(text) : null;
const builder = yaml ? yaml.load(builderText) : null;
const needYaml = (ctx) => {
  if (yaml) return false;
  ctx.skip("js-yaml is not installed (eth/node_modules)");
  return true;
};

const ALLOWED_ACTIONS = new Map([
  ["actions/checkout", "11d5960a326750d5838078e36cf38b85af677262"],
  ["actions/setup-node", "49933ea5288caeca8642d1e84afbd3f7d6820020"],
  ["actions/upload-artifact", "ea165f8d65b6e75b540449e92b4886f43607fa02"],
  ["actions/download-artifact", "d3f86a106a0bac45b974a628896c90dbdf5c8093"],
  ["actions/attest-build-provenance", "4d101475d8b20a2381f78447822ac1eab6504dd8"],
]);

test("every action is one of the five known ones, pinned by its full commit id with the tag in a comment", () => {
  const uses = [...text.matchAll(/^\s*(?:-\s*)?uses:\s*(\S+)(.*)$/gm)];
  assert.ok(uses.length >= 10);
  for (const m of uses) {
    const [name, ref] = m[1].split("@");
    assert.ok(ALLOWED_ACTIONS.has(name), `${name} is not an allowed action`);
    assert.equal(ref, ALLOWED_ACTIONS.get(name), `${name} is pinned to the known commit`);
    assert.match(ref, /^[0-9a-f]{40}$/);
    assert.match(m[2], /#\s*v\d+\.\d+\.\d+/, `${name} names its tag in a comment`);
  }
});

test("nothing is published, signed or secret: no release step, no secrets, no signing variable, publish never", () => {
  assert.ok(!/\bsecrets\./.test(text.replace(/#.*$/gm, "")), "no secret of the repository is used");
  assert.ok(!/action-gh-release|softprops|gh release|--publish (always|onTag|onTagOrDraft)|npm publish|CSC_LINK|CSC_KEY_PASSWORD|WIN_CSC|APPLE_ID|notarize/i.test(text.replace(/#.*$/gm, "")));
  const builds = [...text.matchAll(/electron-builder [^\n]*/g)].map((m) => m[0]);
  assert.ok(builds.length >= 2);
  for (const b of builds) if (/--(win|mac|dir)/.test(b)) assert.match(b, /--publish never/);
  assert.match(text, /CSC_IDENTITY_AUTO_DISCOVERY: "false"/);
});

test("the tests stay strict: tests_may_fail is false everywhere and nothing may continue on error", () => {
  assert.ok(!/tests_may_fail:\s*true/.test(text));
  assert.equal((text.match(/tests_may_fail:\s*false/g) || []).length, 3);
  const noComments = text.replace(/#.*$/gm, "");
  assert.ok(!/continue-on-error:\s*true/.test(noComments));
  assert.ok(!/\|\|\s*true\b/.test(noComments), "no failure is swallowed with || true");
});

test("the workflow keeps read-only contents at the top; only the desktop job may write an attestation", (ctx) => {
  assert.match(text, /^permissions:\n {2}contents: read\n/m);
  if (needYaml(ctx)) return;
  assert.deepEqual(doc.permissions, { contents: "read" });
  for (const [name, job] of Object.entries(doc.jobs)) {
    if (name === "desktop") assert.deepEqual(job.permissions, { contents: "read", "id-token": "write", attestations: "write" });
    else assert.equal(job.permissions, undefined, `${name} keeps the top-level permissions`);
  }
});

test("job order: desktop needs the swap-cli and eth jobs, the start-up test needs desktop", (ctx) => {
  if (needYaml(ctx)) return;
  assert.deepEqual(Object.keys(doc.jobs), ["swap-cli", "eth", "desktop", "desktop-startup"]);
  assert.deepEqual([...doc.jobs.desktop.needs].sort(), ["eth", "swap-cli"]);
  assert.equal(doc.jobs["desktop-startup"].needs, "desktop");
  // each platform goes ahead without the other: not after a cancelled run, and the eth job is still required
  assert.equal(doc.jobs.desktop.if, "${{ !cancelled() && needs.eth.result == 'success' }}");
  assert.equal(doc.jobs["desktop-startup"].if, "${{ !cancelled() }}");
  // which is safe only while each artifact is uploaded after every step of its job (no condition on the upload steps) and each job
  // downloads its own platform's artifact
  const upload = (job, re) => doc.jobs[job].steps.find((s) => re.test(s.name || ""));
  assert.equal(upload("swap-cli", /^Upload the program/).if, undefined);
  assert.equal(upload("desktop", /^Upload the installer/).if, undefined);
  const download = (job) => doc.jobs[job].steps.filter((s) => /download-artifact/.test(s.uses || "")).map((s) => s.with.name);
  assert.deepEqual(download("desktop"), ["swap-cli-${{ matrix.platform }}"]);
  assert.deepEqual(download("desktop-startup"), ["desktop-${{ matrix.platform }}"]);
  const platforms = (j) => j.strategy.matrix.include.map((i) => i.os);
  assert.deepEqual(platforms(doc.jobs.desktop), ["windows-latest", "macos-latest"]);
  assert.deepEqual(platforms(doc.jobs["desktop-startup"]), ["windows-latest", "macos-latest"]);
});

test("swap-cli job: the contracts are compiled before cargo test, and a step fails the job when a code-hash test was skipped", (ctx) => {
  if (needYaml(ctx)) return;
  const steps = doc.jobs["swap-cli"].steps;
  const at = (re) => steps.findIndex((s) => re.test(s.name || ""));
  const install = at(/Install eth\/'s locked packages/);
  const compile = at(/Compile the contracts/);
  const test_ = at(/^Test swap-cli$/);
  const noskip = at(/code-hash tests ran and were not skipped/);
  const consoleTests = at(/Test the operator console/);
  assert.ok(install >= 0 && compile > install && test_ > compile && noskip > test_ && consoleTests > noskip, "install, compile, test, no-skip check, console");
  assert.match(steps[compile].run, /npx hardhat compile/);
  assert.equal(steps[compile]["working-directory"], "eth");
  const script = steps[noskip].run;
  assert.match(script, /SKIPPED:/);
  assert.match(script, /htlc_code_hash_is_the_local_artifacts_runtime_code_hash/);
  assert.match(script, /htlc_poseidon_v2_code_hash_is_the_local_artifacts_runtime_code_hash/);
  assert.equal(steps[noskip]["continue-on-error"], undefined);
  assert.equal(steps[test_]["continue-on-error"], "${{ matrix.tests_may_fail }}", "the swap-cli test step is unchanged");
});

test("the two test names the no-skip step looks for are the names of the real tests in params.rs", () => {
  const rs = fs.readFileSync(path.join(REPO, "swap-cli", "src", "params.rs"), "utf8");
  for (const name of ["htlc_code_hash_is_the_local_artifacts_runtime_code_hash", "htlc_poseidon_v2_code_hash_is_the_local_artifacts_runtime_code_hash"]) {
    assert.ok(rs.includes(`fn ${name}()`), name);
    assert.ok(name.includes("code_hash"), "matches the cargo test filter used by the step");
  }
  assert.ok(rs.includes("SKIPPED:"), "the skip message the step greps for still exists");
});

test("triggers: a push to main, a manual start, and one scheduled run a day at a quiet hour (UTC)", (ctx) => {
  if (needYaml(ctx)) return;
  const on = doc.on;
  assert.deepEqual(Object.keys(on).sort(), ["push", "schedule", "workflow_dispatch"]);
  assert.deepEqual(on.push, { branches: ["main"] });
  assert.equal(on.schedule.length, 1);
  const [min, hour, dom, mon, dow] = on.schedule[0].cron.split(" ");
  assert.deepEqual([dom, mon, dow], ["*", "*", "*"], "once a day");
  assert.ok(Number(hour) >= 1 && Number(hour) <= 5, "a quiet hour, when GitHub's macOS machines were free");
  assert.ok(Number(min) > 0 && Number(min) < 60, "not on the hour, when every schedule starts at once");
  assert.ok(!("pull_request" in on) && !("pull_request_target" in on), "no run for code from outside");
});

test("desktop job: a failing test is named in an annotation (readable without a login), right after the test step and only when it failed", (ctx) => {
  if (needYaml(ctx)) return;
  const steps = doc.jobs.desktop.steps;
  const i = steps.findIndex((s) => s.id === "desktoptest");
  assert.ok(i >= 0);
  assert.match(steps[i].run, /--test-reporter=tap --test-reporter-destination="\$RUNNER_TEMP\/desktop-test\.tap" "desktop\/test\/\*\.test\.js"/);
  assert.match(steps[i].run, /--test-reporter=spec --test-reporter-destination=stdout/);
  const n = steps[i + 1];
  assert.equal(n.if, "${{ !cancelled() && steps.desktoptest.outcome == 'failure' }}");
  assert.match(n.run, /desktop-test\.tap/);
  assert.match(n.run, /::error title=desktop tests/);
  assert.ok(!/continue-on-error/.test(JSON.stringify(steps[i])), "the test step still fails the job");
});

test("desktop job: the checks come in the order that protects the package", (ctx) => {
  if (needYaml(ctx)) return;
  const steps = doc.jobs.desktop.steps;
  const idx = (re) => {
    const i = steps.findIndex((s) => re.test((s.name || "") + "\n" + (s.run || "")));
    assert.ok(i >= 0, String(re));
    return i;
  };
  const order = [
    idx(/Compile the contracts/),
    idx(/modules and scripts/),
    idx(/Download this run's swap-cli/),
    idx(/make-runtime-lock\.js --check/),
    idx(/codehash-check\.js --artifacts eth\/artifacts .*--build-info swap-cli-dist\/BUILD-INFO\.txt --expect-commit "\$GITHUB_SHA"/),
    idx(/stage\.js stage /),
    idx(/npm ci --omit=dev --ignore-scripts/),
    idx(/stage\.js check/),
    idx(/codehash-check\.js --artifacts desktop\/stage\/eth\/artifacts/),
    idx(/pass 1/),
    idx(/stage\.js manifest/),
    idx(/pass 2/),
    idx(/stage\.js verify-packed .*--asar/),
    idx(/Collect the installer/),
    idx(/Build provenance/),
    idx(/Upload the installer/),
  ];
  assert.deepEqual(order, [...order].sort((a, b) => a - b));
  assert.equal(new Set(order).size, order.length);
  // the manifest is written only when the packed eth/node_modules holds the stage's packages (the builder can leave them out)
  assert.match(steps[idx(/stage\.js manifest/)].run, /stage\.js manifest --resources "desktop\/\$\{\{ matrix\.resources \}\}" --stage desktop\/stage /);
  const packed = steps[idx(/stage\.js verify-packed .*--asar/)].run;
  assert.match(packed, /fuses-check\.js --binary "desktop\/\$\{\{ matrix\.binary \}\}"/);
  assert.match(packed, /codehash-check\.js --artifacts "desktop\/\$\{\{ matrix\.resources \}\}\/app\.asar\.unpacked\/eth\/artifacts"/);
  const attest = steps[idx(/Build provenance/)];
  assert.equal(attest.uses.split("@")[0], "actions/attest-build-provenance");
  assert.equal(attest.with["subject-path"], "${{ steps.collect.outputs.installer }}");
  assert.equal(steps[idx(/Download this run's swap-cli/)].with.name, "swap-cli-${{ matrix.platform }}");
});

test("desktop job: the sha256 file, the build info and the manifest are uploaded with the installer, and nothing else is published", (ctx) => {
  if (needYaml(ctx)) return;
  const uploads = doc.jobs.desktop.steps.filter((s) => (s.uses || "").startsWith("actions/upload-artifact"));
  assert.equal(uploads.length, 1);
  assert.match(uploads[0].with.path, /SHA256SUMS\.txt/);
  assert.match(uploads[0].with.path, /DESKTOP-BUILD-INFO\.txt/);
  assert.match(uploads[0].with.path, /runtime-manifest\.json/);
  assert.equal(uploads[0].with["if-no-files-found"], "error");
});

test("start-up test: sha256 check first, the self-test, the fuses, the installed files, the live.js parity, and on Windows the uninstall", (ctx) => {
  if (needYaml(ctx)) return;
  const steps = doc.jobs["desktop-startup"].steps;
  const names = steps.map((s) => s.name);
  const idx = (re) => {
    const i = names.findIndex((n) => re.test(n));
    assert.ok(i >= 0, String(re));
    return i;
  };
  assert.ok(idx(/Download the installer/) < idx(/Check the installer against its sha256 file/));
  assert.ok(idx(/Check the installer against its sha256 file/) < idx(/Install silently \(Windows\)/));
  assert.match(steps[idx(/Check the installer against its sha256 file/)].run, /sha256sum -c SHA256SUMS\.txt/);
  const win = steps.filter((s) => /\(Windows\)$/.test(s.name));
  const mac = steps.filter((s) => /\(macOS\)$/.test(s.name));
  assert.equal(win.length, 5);
  assert.equal(mac.length, 4);
  // a one-click install for the current user goes to Programs\<package name> (build run 8 looked in Programs\No1d Swap)
  const pkgName = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8")).name;
  assert.equal(pkgName, "no1d-swap");
  assert.ok(steps[idx(/Install silently \(Windows\)/)].run.includes(`Join-Path $env:LOCALAPPDATA "Programs\\${pkgName}"`));
  assert.ok(!/"Programs\\No1d Swap"/.test(text), "no step looks for the program in Programs\\No1d Swap");
  // the self-test may take up to 240 s on a fresh machine; when it does not finish, its output and its last stage line are shown first
  // (build run 10: "did not finish within 90 seconds", with nothing printed)
  const winSelf = steps[idx(/Start the installed program with --self-test \(Windows\)/)].run;
  assert.match(winSelf, /AddSeconds\(240\)/);
  assert.ok(winSelf.indexOf("Get-Content $out") < winSelf.indexOf("did not finish within 240 seconds"), "Windows: the output is printed before the timeout's error");
  assert.match(winSelf, /Where-Object \{ \$_ -like "self-test: \*" \}/);
  // Windows: the program also writes its lines to a report file, and the result is judged from it (build run 11: exit code 1, selftest.out empty);
  // both errors carry the last stage, the line and how many lines reached stdout
  assert.match(winSelf, /\$env:NO1D_SELFTEST_REPORT = \$report/);
  assert.ok(winSelf.indexOf("$env:NO1D_SELFTEST_REPORT") < winSelf.indexOf("Start-Process"), "the report file is named before the program starts");
  assert.match(winSelf, /startup-check\.js selftest --file \$report --exit-code \$code/);
  assert.ok(!/startup-check\.js selftest --file \$out/.test(winSelf));
  assert.match(winSelf, /did not finish within 240 seconds \(\$summary\)/);
  assert.match(winSelf, /is not as required \(exit code \$code; \$summary\)/);
  assert.match(winSelf, /stdout lines: \$outLines/);
  const macSelf = steps[idx(/Start the app with --self-test \(macOS\)/)].run;
  assert.match(macSelf, /seq 1 240/);
  const macTimeout = macSelf.slice(macSelf.indexOf('if kill -0 "$pid"'));
  assert.ok(macTimeout.indexOf('cat "$out"') < macTimeout.indexOf("did not finish within 240 seconds"), "macOS: the output is printed before the timeout's error");
  assert.ok(!/within 90 seconds/.test(text));
  // every Windows step turns a thrown error into an annotation, and none ends on a bare exit 1
  for (const s of win) {
    assert.match(s.run, /trap \{ Write-Host "::error::\$\(\$_\.Exception\.Message\)"; break \}/, s.name);
    assert.ok(!/\{ exit 1 \}/.test(s.run), s.name);
  }
  assert.ok(win.every((s) => s.if === "runner.os == 'Windows'"));
  assert.ok(mac.every((s) => s.if === "runner.os == 'macOS'"));
  const all = (list) => list.map((s) => s.run).join("\n");
  for (const body of [all(win), all(mac)]) {
    assert.match(body, /--self-test/);
    assert.match(body, /startup-check\.js selftest/);
    assert.match(body, /fuses-check\.js --binary/);
    assert.match(body, /verify-packed/);
    assert.match(body, /startup-check\.js parity --electron/);
  }
  // the program opens no TCP port: the self-test is held up and every process of the program is asked for its listening sockets (build spec 9)
  assert.match(all(win), /NO1D_SELFTEST_HOLD_SECONDS/);
  assert.match(all(win), /Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue \| Where-Object \{ \$ids -contains \[int\]\$_\.OwningProcess \}/);
  assert.match(all(win), /the program opened a TCP port/);
  assert.match(all(win), /\$samples -lt 5/);
  // a positive control on each system: the same query must first see a listener opened on purpose, or the step fails
  assert.match(all(win), /TcpListener\]::new\(\[System\.Net\.IPAddress\]::Loopback, 0\)/);
  assert.match(all(win), /Get-Listeners @\(\$PID\)/);
  assert.match(all(win), /did not see a known listener/);
  assert.match(all(mac), /NO1D_SELFTEST_HOLD_SECONDS/);
  assert.match(all(mac), /lsof -nP -iTCP -sTCP:LISTEN -a -p "\$1" 2>\/dev\/null; :; \}/);
  assert.match(all(mac), /found="\$\(listeners "\$pids"\)"/);
  assert.match(all(mac), /python3 -m http\.server 0 --bind 127\.0\.0\.1/);
  assert.match(all(mac), /listeners "\$ctl,\$\$"/);
  assert.match(all(mac), /did not see a known listener/);
  // lsof's exit status is never trusted: it is 1 whenever one of the processes asked about has no listener
  assert.doesNotMatch(all(mac), /if found="\$\(lsof/);
  assert.match(all(mac), /pgrep -P "\$pid"/);
  assert.match(all(mac), /the program opened a TCP port/);
  assert.match(all(mac), /"\$samples" -lt 5/);
  assert.match(all(win), /\/S"/);
  assert.match(all(win), /Uninstall\*\.exe/);
  assert.match(all(win), /runs\\x\\run\.json/);
  assert.match(all(win), /the uninstaller deleted a run folder/);
  assert.match(all(mac), /hdiutil attach/);
  for (const s of win) assert.equal(s.shell, "pwsh");
});

test("no step passes a secret or a key on a command line, and the only key used is the public test key", () => {
  const body = text.replace(/#.*$/gm, "");
  assert.ok(!/0x[0-9a-fA-F]{64}/.test(body), "no key in the workflow");
  assert.ok(!/passphrase|private.?key|mnemonic/i.test(body));
});

// ---- electron-builder.yml ----

test("builder: asar with eth/ and equiv/ unpacked, eth/node_modules packed, swap-cli into bin/, only an ad-hoc Mac signature, no publishing", (ctx) => {
  if (needYaml(ctx)) return;
  assert.equal(builder.asar, true);
  assert.deepEqual(builder.asarUnpack, ["eth/**", "equiv/**"]);
  // without the second pattern the builder leaves eth/node_modules out (the first Mac build)
  assert.deepEqual(builder.files, ["**/*", "eth/node_modules/**/*"]);
  assert.deepEqual(builder.extraResources, [{ from: "stage-bin", to: "bin" }]);
  assert.equal(builder.directories.app, "stage");
  assert.equal(builder.publish, null);
  assert.equal(builder.productName, "No1d Swap");
  assert.match(builder.appId, /^[a-z0-9]+(\.[a-z0-9]+)+$/);
  assert.equal(builder.npmRebuild, false);
  assert.ok(!/certificate|signtool|signingHashAlgorithms|notariz|provisioningProfile/i.test(builderText.replace(/#.*$/gm, "")));
  // "-" is the ad-hoc signature (no certificate, no identity): with null the arm64 program was ended by macOS at start (the first Mac build)
  assert.equal(builder.mac.identity, "-");
  assert.equal(builder.win.certificateFile, undefined);
  assert.equal(builder.dmg.sign, false);
});

test("builder: appId equals the shell's APP_ID, and the stage script ships the tray icons", (ctx) => {
  const shellSrc = fs.readFileSync(path.join(__dirname, "..", "lib", "shell.js"), "utf8");
  const m = /const APP_ID = "([^"]+)"/.exec(shellSrc);
  assert.ok(m, "APP_ID found in shell.js");
  assert.match(builderText, new RegExp(`^appId: ${m[1].replace(/\./g, "\\.")}$`, "m"));
  const stageSrc = fs.readFileSync(path.join(__dirname, "..", "scripts", "stage.js"), "utf8");
  assert.match(stageSrc, /copyTree\(R\("desktop", "assets"\)/);
  for (const f of ["tray.png", "trayTemplate.png", "trayTemplate@2x.png"]) assert.ok(fs.existsSync(path.join(__dirname, "..", "assets", f)), f);
});

test("builder: Windows x64 NSIS per user without elevation, never deleting app data; macOS arm64 dmg", (ctx) => {
  if (needYaml(ctx)) return;
  assert.deepEqual(builder.win.target, [{ target: "nsis", arch: ["x64"] }]);
  assert.equal(builder.nsis.perMachine, false);
  assert.equal(builder.nsis.allowElevation, false);
  assert.equal(builder.nsis.oneClick, true);
  assert.equal(builder.nsis.deleteAppDataOnUninstall, false);
  assert.deepEqual(builder.mac.target, [{ target: "dmg", arch: ["arm64"] }]);
});

test("builder: the fuses are exactly the table of the packaging spec, and the fuse checker requires the same values", (ctx) => {
  if (needYaml(ctx)) return;
  const { FUSES_V1 } = require("../scripts/fuses-check.js");
  const wanted = Object.fromEntries(FUSES_V1.map((f) => [f.name[0].toLowerCase() + f.name.slice(1), f.want]));
  assert.deepEqual(builder.electronFuses, wanted);
  assert.equal(builder.electronFuses.runAsNode, true);
  assert.equal(builder.electronFuses.enableNodeOptionsEnvironmentVariable, false);
  assert.equal(builder.electronFuses.enableNodeCliInspectArguments, false);
});

test("the artifact names the workflow looks for are the ones the builder makes", (ctx) => {
  if (needYaml(ctx)) return;
  assert.equal(builder.artifactName, "No1d-Swap-${version}-${os}-${arch}.${ext}");
  for (const inc of doc.jobs.desktop.strategy.matrix.include) {
    const ext = inc.stage_platform === "win" ? "exe" : "dmg";
    const os_ = inc.stage_platform;
    const arch = inc.stage_platform === "win" ? "x64" : "arm64";
    assert.equal(inc.installer_glob, `No1d-Swap-*-${os_}-${arch}.${ext}`);
  }
});

test("the program's own package.json: exact build-tool versions, no runtime dependencies", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"));
  assert.ok(!pkg.dependencies || Object.keys(pkg.dependencies).length === 0);
  for (const name of ["electron", "electron-builder"]) assert.match(pkg.devDependencies[name], /^\d+\.\d+\.\d+$/, `${name} is pinned exactly`);
  assert.match(pkg.version, /^\d+\.\d+\.\d+$/);
});

test("no personal or tool name appears in the packaging files", () => {
  const banned = new RegExp(["cla" + "ude", "anthro" + "pic", "assist" + "ant", "chat" + "gpt", "open" + "ai", "co-?auth" + "ored", "gemi" + "ni", "copi" + "lot"].join("|"), "i");
  const files = [
    WORKFLOW,
    BUILDER,
    path.join(__dirname, "..", "lib", "updates.js"),
    ...["make-runtime-lock", "stage", "codehash-check", "fuses-check", "startup-check"].map((n) => path.join(__dirname, "..", "scripts", `${n}.js`)),
    path.join(__dirname, "..", "runtime", "package.json"),
    path.join(__dirname, "..", "runtime", "package-lock.json"),
    ...["runtime-lock", "stage", "codehash", "updates", "fuses", "startup-check", "workflow"].map((n) => path.join(__dirname, `${n}.test.js`)),
  ];
  for (const f of files) assert.ok(!banned.test(fs.readFileSync(f, "utf8")), path.relative(REPO, f));
});

test("desktop job: the build tools are installed from the committed lock file, and a missing lock file fails the job", (ctx) => {
  if (needYaml(ctx)) return;
  const step = doc.jobs.desktop.steps.find((x) => /Install the build tools/.test(x.name || ""));
  assert.ok(step, "the install step exists");
  assert.match(step.run, /npm ci --ignore-scripts/);
  assert.match(step.run, /\[ ! -f package-lock\.json \]/);
  assert.match(step.run, /exit 1/);
  assert.ok(!/npm install/.test(step.run), "no unlocked fallback");
  assert.ok(!/lock_generated/.test(JSON.stringify(doc)), "no generated-lock output or upload is left");
});
