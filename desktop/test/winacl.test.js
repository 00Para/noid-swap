"use strict";
// Owner-only folders (spec 6.7, 6.10 "Windows ACL (12.5)"): the pure decision against fixed SDDL fixtures, the command lines as argument vectors, the macOS check.
// No test changes any real folder's permissions: the commands are injected fakes (one read-only test runs the real read on Windows).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const acl = require("../lib/winacl");

const USER = "S-1-5-21-1111111111-2222222222-3333333333-1001";
const FIXDIR = path.join(__dirname, "fixtures", "sddl");
const fixture = (name) => fs.readFileSync(path.join(FIXDIR, `${name}.sddl`), "utf8").trim();

// name -> [ok with no protection required, ok with protection required (the data folder itself)]
const TABLE = {
  "protected-owner-only": [true, true],
  "protected-sid-forms": [true, true],
  "inherited-run-folder": [true, false],
  "inherited-users": [false, false],
  everyone: [false, false],
  "authenticated-users": [false, false],
  "interactive-users": [false, false],
  "another-user": [false, false],
  "owner-rights": [false, false],
  "deny-ace": [true, true],
  "creator-owner-inherit-only": [true, true],
  "creator-owner-no-inherit-only": [false, false],
  "owner-other-user": [false, false],
  "owner-administrators": [true, true],
  "owner-system": [false, false],
  "conditional-ace": [false, false],
  "conditional-ace-quoted-paren": [false, false],
  "object-ace": [false, false],
  "null-dacl": [false, false],
  "no-access-control": [false, false],
  "no-owner": [false, false],
  "with-sacl": [true, true],
  "empty-dacl": [true, true],
  "audit-in-dacl": [false, false],
  garbage: [false, false],
};

test("every fixture is in the table and every table entry has its fixture (the list of cases is the spec's and more)", () => {
  assert.deepEqual(fs.readdirSync(FIXDIR).map((n) => n.replace(/\.sddl$/, "")).sort(), Object.keys(TABLE).sort());
});

for (const [name, [plain, protectedToo]] of Object.entries(TABLE)) {
  test(`sddlOwnerOnly: ${name}: ${plain ? "ok" : "refused"}; as the data folder itself (protected from inheritance): ${protectedToo ? "ok" : "refused"}`, () => {
    const a = acl.sddlOwnerOnly(fixture(name), USER);
    assert.equal(a.ok, plain, a.why);
    const b = acl.sddlOwnerOnly(fixture(name), USER, { requireProtected: true });
    assert.equal(b.ok, protectedToo, b.why);
    for (const r of [a, b]) {
      if (r.ok) assert.equal(r.why, null);
      else {
        assert.equal(typeof r.why, "string");
        assert.ok(r.why.length > 10);
        assert.ok(!r.why.includes(USER) && !r.why.includes("S-1-5-21"), "no SID in the text");
      }
    }
  });
}

test("sddlOwnerOnly: the user's SID is matched without regard to case; another user's SID is not the user", () => {
  assert.equal(acl.sddlOwnerOnly(fixture("protected-owner-only"), USER.toLowerCase()).ok, true);
  assert.equal(acl.sddlOwnerOnly(fixture("protected-owner-only"), "S-1-5-21-1111111111-2222222222-3333333333-1002").ok, false);
  assert.equal(acl.sddlOwnerOnly(fixture("protected-owner-only"), "not a sid").ok, false);
  assert.equal(acl.sddlOwnerOnly("", USER).ok, false);
  assert.equal(acl.sddlOwnerOnly(null, USER).ok, false);
});

test("sddlParts: the parts are found outside parentheses and quotes only; a part twice or text before the first is not a descriptor", () => {
  const p = acl.sddlParts(fixture("conditional-ace-quoted-paren"));
  assert.ok(p.O.startsWith("S-1-5-21"));
  assert.ok(p.D.includes('"a)b"'));
  assert.equal(p.S, undefined);
  assert.equal(acl.sddlParts("D:P(A;;FA;;;SY)D:P"), null);
  assert.equal(acl.sddlParts("xO:BAD:P"), null);
  assert.equal(acl.sddlParts(""), null);
});

test("sddlOwnerOnly: SYSTEM and Administrators are fine by alias or by SID; their SIDs are exactly S-1-5-18 and S-1-5-32-544", () => {
  assert.equal(acl.SYSTEM_SID, "S-1-5-18");
  assert.equal(acl.ADMINS_SID, "S-1-5-32-544");
  const d = (a) => `O:${USER}G:BAD:P(A;OICI;FA;;;${a})`;
  for (const a of ["SY", "BA", "S-1-5-18", "S-1-5-32-544", USER]) assert.equal(acl.sddlOwnerOnly(d(a), USER).ok, true, a);
  for (const a of ["WD", "BU", "AU", "IU", "NS", "LS", "S-1-1-0", "S-1-5-32-545", "S-1-5-11", "S-1-5-21-1111111111-2222222222-3333333333-1002"]) assert.equal(acl.sddlOwnerOnly(d(a), USER).ok, false, a);
});

// ---------------------------------------------------------------------------------------------------------------------------------
// the commands, as argument vectors

const WINENV = { SystemRoot: "C:\\Windows", windir: "C:\\Windows", TEMP: "C:\\T", PATH: "C:\\evil", SOMETHING_SECRET: "x", NO1D_ACL_PATH: "wrong", NODE_OPTIONS: "--require x" };
const dirStat = { lstatSync: () => ({ isSymbolicLink: () => false, isDirectory: () => true }) };

test("the ACL read is one argument vector: an absolute PowerShell, a fixed command text, the path only in NO1D_ACL_PATH, an environment built from scratch", () => {
  const c = acl.aclReadCommand("C:\\Users\\x\\AppData\\Local\\No1d Swap\\runs\\a b", WINENV);
  assert.equal(c.file, "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
  assert.ok(path.win32.isAbsolute(c.file));
  assert.deepEqual(c.args, ["-NoProfile", "-NonInteractive", "-Command", acl.ACL_READ_TEXT]);
  assert.equal(c.env.NO1D_ACL_PATH, "C:\\Users\\x\\AppData\\Local\\No1d Swap\\runs\\a b");
  assert.ok(!c.args.join(" ").includes("Users"));
  assert.deepEqual(Object.keys(c.env).sort(), ["NO1D_ACL_PATH", "SystemRoot", "TEMP", "windir"].sort());
  // a hostile path stays in the variable
  const evil = acl.aclReadCommand("C:\\x'; Remove-Item C:\\ -Recurse #", WINENV);
  assert.deepEqual(evil.args, c.args);
});

test("the icacls command is one argument vector: absolute path, inheritance removed, full control for the user, SYSTEM and Administrators only", () => {
  const dir = "C:\\Users\\x\\AppData\\Local\\No1d Swap";
  const c = acl.icaclsCommand(dir, USER, WINENV);
  assert.equal(c.file, "C:\\Windows\\System32\\icacls.exe");
  assert.deepEqual(c.args, [dir, "/inheritance:r", "/grant:r", `*${USER}:(OI)(CI)F`, "*S-1-5-18:(OI)(CI)F", "*S-1-5-32-544:(OI)(CI)F"]);
  assert.ok(!("NO1D_ACL_PATH" in c.env));
  assert.deepEqual(Object.keys(c.env).sort(), ["SystemRoot", "TEMP", "windir"].sort());
});

test("a Windows folder that is not a local absolute path is refused before any command runs (a network path, a relative path, a long-path prefix)", () => {
  const calls = [];
  const exec = (...a) => (calls.push(a), "");
  for (const bad of ["\\\\server\\share\\x", "relative\\path", "\\\\?\\C:\\x", "/tmp/x", "", null]) {
    const r = acl.checkOwnerOnly(bad, { platform: "win32", env: WINENV, exec, fs: dirStat, userSid: USER });
    assert.equal(r.ok, false, String(bad));
    assert.throws(() => acl.makeOwnerOnlyDir(bad, { platform: "win32", env: WINENV, exec, fs: { ...dirStat, mkdirSync() {} }, userSid: USER }));
  }
  assert.deepEqual(calls, []);
});

test("checkOwnerOnly on Windows: reads the SDDL through PowerShell, takes the SID from whoami, decides; a link or a command that fails is not ok", () => {
  const calls = [];
  const exec = (file, args, o) => {
    calls.push({ file, args, env: o.env });
    if (file.endsWith("whoami.exe")) return `"DESKTOP\\me","${USER}"\r\n`;
    return `${fixture("protected-owner-only")}\r\n`;
  };
  const dir = "C:\\Users\\me\\AppData\\Local\\No1d Swap\\runs\\ab";
  const r = acl.checkOwnerOnly(dir, { platform: "win32", env: WINENV, exec, fs: dirStat });
  assert.deepEqual(r, { ok: true, why: null });
  assert.equal(calls.length, 2);
  const ps = calls.find((c) => c.file.endsWith("powershell.exe"));
  assert.deepEqual(ps.args, ["-NoProfile", "-NonInteractive", "-Command", acl.ACL_READ_TEXT]);
  assert.equal(ps.env.NO1D_ACL_PATH, dir);
  const who = calls.find((c) => c.file.endsWith("whoami.exe"));
  assert.deepEqual(who.args, ["/user", "/fo", "csv", "/nh"]);
  assert.ok(calls.every((c) => path.win32.isAbsolute(c.file) && Array.isArray(c.args)));
  assert.ok(calls.every((c) => !("PATH" in c.env) && !("NODE_OPTIONS" in c.env) && !("SOMETHING_SECRET" in c.env)));
  // a link, a file
  const link = { lstatSync: () => ({ isSymbolicLink: () => true, isDirectory: () => false }) };
  assert.equal(acl.checkOwnerOnly(dir, { platform: "win32", env: WINENV, exec, fs: link, userSid: USER }).ok, false);
  const file = { lstatSync: () => ({ isSymbolicLink: () => false, isDirectory: () => false }) };
  assert.equal(acl.checkOwnerOnly(dir, { platform: "win32", env: WINENV, exec, fs: file, userSid: USER }).ok, false);
  // PowerShell fails, whoami fails, the answer is empty
  const boom = () => { throw new Error("no"); };
  assert.equal(acl.checkOwnerOnly(dir, { platform: "win32", env: WINENV, exec: boom, fs: dirStat, userSid: USER }).ok, false);
  const noWho = (file2) => { if (file2.endsWith("whoami.exe")) throw new Error("no"); return fixture("protected-owner-only"); };
  assert.equal(acl.checkOwnerOnly(dir, { platform: "win32", env: WINENV, exec: noWho, fs: dirStat }).ok, false);
  assert.equal(acl.checkOwnerOnly(dir, { platform: "win32", env: WINENV, exec: () => "", fs: dirStat, userSid: USER }).ok, false);
  // a folder that is open to Users is refused
  const open = (file2) => (file2.endsWith("whoami.exe") ? `"X\\me","${USER}"` : fixture("inherited-users"));
  assert.equal(acl.checkOwnerOnly(dir, { platform: "win32", env: WINENV, exec: open, fs: dirStat }).ok, false);
});

test("makeOwnerOnlyDir on Windows: creates the folder, runs icacls with the exact vector, then checks the result as the data folder (protected); a failed icacls or a failed check throws", () => {
  const dir = "C:\\Users\\me\\AppData\\Local\\No1d Swap";
  const made = [];
  const fsFake = { ...dirStat, mkdirSync: (p, o) => made.push([p, o]) };
  const calls = [];
  const exec = (file, args) => {
    calls.push({ file, args });
    if (file.endsWith("whoami.exe")) return `"DESKTOP\\me","${USER}"`;
    if (file.endsWith("icacls.exe")) return "Successfully processed 1 files";
    return fixture("protected-owner-only");
  };
  acl.makeOwnerOnlyDir(dir, { platform: "win32", env: WINENV, exec, fs: fsFake });
  assert.deepEqual(made, [[dir, { recursive: true }]]);
  const ic = calls.find((c) => c.file.endsWith("icacls.exe"));
  assert.deepEqual(ic.args, [dir, "/inheritance:r", "/grant:r", `*${USER}:(OI)(CI)F`, "*S-1-5-18:(OI)(CI)F", "*S-1-5-32-544:(OI)(CI)F"]);
  assert.ok(calls.findIndex((c) => c.file.endsWith("icacls.exe")) < calls.findIndex((c) => c.file.endsWith("powershell.exe")), "the check comes after icacls");
  // icacls fails
  const noIcacls = (file, args) => { if (file.endsWith("icacls.exe")) throw new Error("denied"); return exec(file, args); };
  assert.throws(() => acl.makeOwnerOnlyDir(dir, { platform: "win32", env: WINENV, exec: noIcacls, fs: fsFake }), /could not be made owner-only/);
  // the result is still inherited (the data folder must be protected)
  const stillInherited = (file, args) => (file.endsWith("powershell.exe") ? fixture("inherited-run-folder") : exec(file, args));
  assert.throws(() => acl.makeOwnerOnlyDir(dir, { platform: "win32", env: WINENV, exec: stillInherited, fs: fsFake }), /not owner-only after/);
  // the folder is a link
  const link = { lstatSync: () => ({ isSymbolicLink: () => true, isDirectory: () => false }), mkdirSync() {} };
  assert.throws(() => acl.makeOwnerOnlyDir(dir, { platform: "win32", env: WINENV, exec, fs: link }), /not a plain folder/);
});

test("the ACL read loads no PowerShell module: a .NET call with a fixed text, no Get-Acl, no other command", () => {
  assert.ok(!/Get-Acl|Import-Module|;|\|/.test(acl.ACL_READ_TEXT));
  assert.match(acl.ACL_READ_TEXT, /^\[System\.IO\.Directory\]::GetAccessControl\(\$env:NO1D_ACL_PATH, 'Owner, Group, Access'\)\.GetSecurityDescriptorSddlForm\('Owner, Group, Access'\)$/);
});

test("a failed system command carries a short detail for the self-test (a timeout, an exit code and the first line of stderr); the reason stays the fixed sentence", () => {
  assert.equal(acl.execDetail(Object.assign(new Error("spawnSync powershell.exe ETIMEDOUT"), { code: "ETIMEDOUT" })), "timed out after 20 s");
  assert.equal(acl.execDetail({ killed: true, signal: "SIGTERM" }), "timed out after 20 s");
  assert.equal(acl.execDetail({ status: 1, stderr: "\r\n  Exception calling \"GetAccessControl\"  with \"2\"\r\nAt line:1\r\n" }), 'exit 1: Exception calling "GetAccessControl" with "2"');
  assert.equal(acl.execDetail({ code: "ENOENT" }), "ENOENT");
  assert.equal(acl.execDetail(null), "unknown");
  assert.ok(acl.execDetail({ status: 1, stderr: "x".repeat(500) }).length <= 200);
  const dir = "C:\\Users\\me\\AppData\\Local\\No1d Swap";
  const who = (file) => (file.endsWith("whoami.exe") ? `"X\\me","${USER}"` : null);
  const slow = (file) => who(file) || (() => { throw Object.assign(new Error("ETIMEDOUT"), { code: "ETIMEDOUT" }); })();
  const r = acl.checkOwnerOnly(dir, { platform: "win32", env: WINENV, exec: slow, fs: dirStat });
  assert.deepEqual(r, { ok: false, why: "the folder's access list could not be read", detail: "timed out after 20 s" });
  // makeOwnerOnlyDir passes the detail on with its error, after icacls and after the check
  const fsFake = { ...dirStat, mkdirSync() {} };
  const slowAfterIcacls = (file, args) => (file.endsWith("icacls.exe") ? "ok" : slow(file, args));
  assert.throws(() => acl.makeOwnerOnlyDir(dir, { platform: "win32", env: WINENV, exec: slowAfterIcacls, fs: fsFake }), (e) => /could not be read/.test(e.message) && e.detail === "timed out after 20 s");
  const noIcacls = (file) => who(file) || (() => { throw Object.assign(new Error("x"), { status: 5, stderr: "Access is denied." }); })();
  assert.throws(() => acl.makeOwnerOnlyDir(dir, { platform: "win32", env: WINENV, exec: noIcacls, fs: fsFake }), (e) => e.message === "the folder could not be made owner-only" && e.detail === "exit 5: Access is denied.");
});

test("windowsUserSid reads the SID from whoami's csv and refuses anything else", () => {
  const ok = (t) => acl.windowsUserSid({ env: WINENV, exec: () => t });
  assert.equal(ok(`"HOST\\user name","${USER}"\r\n`), USER);
  assert.throws(() => ok("garbage"));
  assert.throws(() => ok(""));
  assert.throws(() => ok('"a","not-a-sid"'));
});

test("createFolderGuard: cached 10 seconds for views, read fresh when asked, and only the data folder itself must be protected from inheritance", () => {
  let reads = 0;
  let t = 1000000;
  const exec = (file) => {
    if (file.endsWith("whoami.exe")) return `"X\\me","${USER}"`;
    reads++;
    return fixture("inherited-run-folder");
  };
  const dataDir = "C:\\Users\\me\\AppData\\Local\\No1d Swap";
  const guard = acl.createFolderGuard({ dataDir, platform: "win32", env: WINENV, exec, fs: dirStat, now: () => t });
  const run = `${dataDir}\\runs\\0123456789abcdef0123456789abcdef`;
  assert.equal(guard(run).ok, true, "a run folder may inherit");
  assert.equal(guard(dataDir).ok, false, "the data folder itself must be protected");
  assert.equal(guard(dataDir.toLowerCase() + "\\").ok, false, "the same folder by another spelling");
  assert.equal(reads, 2 + 0, "the same folder by another spelling is a cache hit");
  guard(run);
  guard(run);
  assert.equal(reads, 2);
  t += 9999;
  guard(run);
  assert.equal(reads, 2);
  t += 2;
  guard(run);
  assert.equal(reads, 3, "after 10 seconds it is read again");
  guard(run, { fresh: true });
  assert.equal(reads, 4, "fresh bypasses the cache");
  guard(run, { fresh: true });
  assert.equal(reads, 5);
});

test("a system this program does not support is refused, not guessed", () => {
  assert.equal(acl.checkOwnerOnly("/x", { platform: "linux" }).ok, false);
  assert.throws(() => acl.makeOwnerOnlyDir("/x", { platform: "linux" }), /not supported/);
});

// ---------------------------------------------------------------------------------------------------------------------------------
// macOS

const macStat = (o = {}) => ({ lstatSync: () => ({ isSymbolicLink: () => !!o.link, isDirectory: () => o.dir !== false, uid: o.uid === undefined ? 501 : o.uid, mode: o.mode === undefined ? 0o40700 : o.mode }) });
const LS_CLEAN = "drwx------  5 me  staff  160 Nov 18 10:00 /Users/me/Library/Application Support/No1d Swap\n";
const LS_PLUS = "drwx------+ 5 me  staff  160 Nov 18 10:00 /Users/me/Library/Application Support/No1d Swap\n 0: user:other allow list,search,readattr\n";
const LS_ACL_ONLY_LINE = "drwx------  5 me  staff  160 Nov 18 10:00 /x\n 0: group:everyone deny delete\n";
const mac = (o = {}, ls = LS_CLEAN, calls = []) => acl.checkOwnerOnly("/Users/me/Library/Application Support/No1d Swap", { platform: "darwin", fs: macStat(o), getuid: () => 501, exec: (f, a, op) => (calls.push({ f, a, op }), ls) });

test("macOS: a directory owned by the user with no group or other bits and no ACL entry is ok; the command is /bin/ls -lde as a vector", () => {
  const calls = [];
  assert.deepEqual(mac({}, LS_CLEAN, calls), { ok: true, why: null });
  assert.deepEqual(calls.map((c) => [c.f, c.a]), [["/bin/ls", ["-lde", "/Users/me/Library/Application Support/No1d Swap"]]]);
});

test("macOS: a link, a file, another owner, group or other bits, and any ACL entry (a plus sign or a numbered entry) are refused", () => {
  assert.equal(mac({ link: true }).ok, false);
  assert.equal(mac({ dir: false }).ok, false);
  assert.equal(mac({ uid: 502 }).ok, false);
  for (const m of [0o40750, 0o40705, 0o40755, 0o40770, 0o40777, 0o40707]) assert.equal(mac({ mode: m }).ok, false, m.toString(8));
  assert.equal(mac({}, LS_PLUS).ok, false);
  assert.equal(mac({}, LS_ACL_ONLY_LINE).ok, false);
  assert.equal(mac({}, "").ok, false);
  assert.equal(acl.checkOwnerOnly("relative", { platform: "darwin", fs: macStat(), getuid: () => 501, exec: () => LS_CLEAN }).ok, false);
  assert.equal(acl.checkOwnerOnly("/x", { platform: "darwin", fs: macStat(), getuid: () => 501, exec: () => { throw new Error("x"); } }).ok, false);
});

test("lsHasAcl reads the mode string's plus sign and the numbered entry lines", () => {
  assert.equal(acl.lsHasAcl(LS_CLEAN), false);
  assert.equal(acl.lsHasAcl(LS_PLUS), true);
  assert.equal(acl.lsHasAcl(LS_ACL_ONLY_LINE), true);
  assert.equal(acl.lsHasAcl("drwx------@ 5 me staff 160 Nov 18 10:00 /x\n"), false, "an extended attribute mark is not an ACL");
  assert.equal(acl.lsHasAcl(""), true);
});

test("makeOwnerOnlyDir on macOS: mode 0700 at creation, chmod 0700, then the check; a bad check throws", () => {
  const log = [];
  const fsFake = { ...macStat(), mkdirSync: (p, o) => log.push(["mkdir", p, o]), chmodSync: (p, m) => log.push(["chmod", p, m]) };
  acl.makeOwnerOnlyDir("/Users/me/Library/Application Support/No1d Swap", { platform: "darwin", fs: fsFake, getuid: () => 501, exec: () => LS_CLEAN });
  assert.deepEqual(log, [["mkdir", "/Users/me/Library/Application Support/No1d Swap", { recursive: true, mode: 0o700 }], ["chmod", "/Users/me/Library/Application Support/No1d Swap", 0o700]]);
  assert.throws(() => acl.makeOwnerOnlyDir("/Users/me/x", { platform: "darwin", fs: fsFake, getuid: () => 501, exec: () => LS_PLUS }), /not owner-only after/);
});

// ---------------------------------------------------------------------------------------------------------------------------------
// the real thing, read-only, on Windows

test("on Windows the real commands run: whoami gives a SID and the ACL of a temporary folder is read (nothing is changed)", { skip: process.platform !== "win32" }, () => {
  const sid = acl.windowsUserSid({});
  assert.match(sid, /^S-1-5-21-[0-9-]+$|^S-1-5-[0-9-]+$/);
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "no1d-acl-"));
  try {
    const r = acl.checkOwnerOnly(d, {});
    assert.equal(typeof r.ok, "boolean");
    assert.ok(r.ok || typeof r.why === "string");
    // the read itself works: an open temporary folder is refused for what it is, never because its list could not be read
    assert.notEqual(r.why, "the folder's access list could not be read", r.detail);
    const cmd = acl.aclReadCommand(d, process.env);
    const t0 = Date.now();
    const sddl = require("child_process").execFileSync(cmd.file, cmd.args, { env: cmd.env, encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }).trim();
    assert.match(sddl, /^O:[^]+G:[^]+D:/);
    assert.ok(Date.now() - t0 < acl.EXEC_TIMEOUT_MS, "well inside the limit");
    // the result of a real read is the same one the pure function gives for a protected, owner-only descriptor of this user
    assert.equal(acl.sddlOwnerOnly(`O:${sid}G:BAD:P(A;OICI;FA;;;${sid})(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)`, sid, { requireProtected: true }).ok, true);
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
});
