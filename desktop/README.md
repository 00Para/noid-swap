# desktop: the No1d Swap program (Electron shell)

The shell of the desktop program (piece 4, step 4.7). It runs the console server in its main process, shows it in one hardened
window, keeps the machine awake while coins are in a contract, comes back after a crash, and starts at login while a swap is
active. This version works on test networks only.

All logic lives in plain modules under `lib/` that take the Electron module (or the parts they need) as an argument and are tested
with `node --test` against a fake `electron` (`test/fake-electron.js`). **Only `main.js` and `preload-secret.js` may
`require("electron")`**, and no test loads either (`test/no-electron-require.test.js` checks both rules).

Electron is not installed on the development PC and must not be: nothing here runs `npm install`. The real program is built and
started only in the hosted build.

## Versions (exact pins, to be checked before the first hosted build)

`package.json` pins `electron` 45.2.3 and `electron-builder` 26.18.0 exactly (no ranges). Checked against the npm registry on
2026-11-18 by the rule: the newest patch of the newest stable line that is at least 14 days old, unless a newer patch fixes a
published Electron security advisory. Electron 45.2.3 (published 2026-11-04) is that patch; 45.3.0 to 45.3.4 (2026-11-10 to
2026-11-17) were younger than 14 days, and their notes list backported upstream fixes but no published advisory. electron-builder
26.18.0 (2026-10-20) is the registry's `latest`; 26.18.1 is published under the `v26` tag only. Check both again before the first
release. The `@electron/fuses` package is not listed: the builder's `electronFuses` setting applies the fuses (the packaging step
decides if it needs the package).

## Files

| File | What |
|---|---|
| `main.js` | entry point; hands `electron` to `lib/shell.js` |
| `preload-secret.js` | preload of the secret window only: `window.no1dSecret = { onShow, submit, cancel }` |
| `secret/` | the secret window's page (`secret.html`, `secret.js`, `secret.css`): the only place a secret is shown or typed |
| `assets/` | tray icons (`tray.png`, `trayTemplate.png`, `trayTemplate@2x.png`); the stage step must copy this folder |
| `lib/shell.js` | the start-up order (below), switch refusals, wiring |
| `lib/program.js` | builds the `program` object (build spec I1) from the pieces |
| `lib/window.js`, `lib/hardening.js` | the main window and the policy guard of every webContents |
| `lib/secretwin.js` | the secret window (I6) |
| `lib/keystore-electron.js` | the real key store (I5) over `safeStorage` |
| `lib/nodecheck.js` | the node check (I4) |
| `lib/tray.js`, `lib/keepawake.js`, `lib/loginitem.js`, `lib/quit.js` | tray and application menu, keep-awake, login item, quit text |
| `lib/crash.js`, `lib/notify.js` | crash relaunch, fixed-text notifications |
| `lib/manifest.js` | the runtime manifest: `build`, `write`, `verify` |
| `lib/selftest.js` | the `--self-test` switch |
| `lib/helptext.js` | the help text of the menu |

The vault, sealed files, derivation, recovery code, import and folder checks (`vault.js`, `sealed.js`, `derive.js`,
`recoverycode.js`, `migrate.js`, `winacl.js`, `datadirs.js`) belong to step 4.6; the update check (`updates.js`) and the stage and
build scripts belong to step 4.8.

## Start-up order (`lib/shell.js`, build spec 7.2)

0. A quiet handler for an uncaught error is put on first: it ends the program with exit 1 and no dialog. The crash handler (step 10)
   replaces it.
1. A command line is an allowlist: only `--hidden` (start at login) and `--self-test` are read, and any other argument written
   like a switch (`--x`, `-x`, and `/x` on Windows; on a Mac also `-psn_<digits>_<digits>` is let through) is refused with a dialog
   and exit 1, before anything starts. Chromium's own command line is also asked for the five debugging switches no fuse turns off.
2. `userData` and `sessionData` go to `<data>/electron` (the data folder's name is worked out first, nothing is made yet), before the lock
   and before `ready`.
3. `requestSingleInstanceLock()`. A second instance quits at once; `second-instance` shows and focuses the window. Then sandbox on for every
   renderer, and the policy guard (`hardening.js`) installed for every webContents: it sets `setProxy({ mode: "direct" })` once on each session
   it sees and `disable_non_proxied_udp` as the WebRTC policy of every webContents, before anything is loaded.
4. Packaged only: the runtime manifest is verified. A failure shows "This installation is damaged: reinstall it." and quits.
5. The data folder is made owner-only and its guard is read fresh; a failure shows the reason and quits.
6. After `ready`: the key store, `vault.open()` (the recovery code and passphrase prompts use the secret window). A vault that
   throws stops the start with a fixed sentence; a locked vault still starts (the page says why).
7. The node check loop starts.
8. `startProgramServer(program)`; only after it resolves, and after its handler is attached to the private scheme, does the main window load `no1d://app/#token=TOKEN` (step 4.9; until then it loaded `http://127.0.0.1:PORT/#token=TOKEN`).
9. Tray, keep-awake, login item and quit text follow `atStakeChanged`.
10. Crash handlers.

The token appears only in the argument of `loadURL` (tested).

## The window (build spec 7.3)

`contextIsolation`, `sandbox`, no Node anywhere, `webSecurity`, no webview, no spell check, `devTools` only when not packaged, an
in-memory partition `no1d-main` (never `persist:`). The guard refuses new windows, navigation other than the page's own URL
(fragment ignored), webviews, downloads, every permission, device pickers, and every request whose origin is not the server's
(inline `data:` URLs are let through: they never touch the network). The server's own content security policy stays.

Closing the window hides it while any swap is active; with none active it quits. Quitting with a swap active asks first and names
every swap at stake and until when. The system's own shutdown or log-off is never blocked.

## The secret window (build spec 7.5)

A separate modal window of the main process with its own in-memory partition, loaded from a file (no server, no API), with
content protection on. Values cross one IPC channel, accepted only from that window's own webContents and only while a request is
open. Requests are served one at a time. Closing the window ends a request as a cancel (`askGroups` and `askText` give `null`;
`show` rejects with `code: "CLOSED"`, which the vault reads as "the person never saw the code"). The vault asks for a new
fallback passphrase in two prompts (`fallback-new`, then again with `again: true`) and compares them itself.

## Self-test (`--self-test`, build spec 7.12)

For the hosted start-up test only. A fresh temporary data folder (used as the data folder before the single-instance lock so it cannot collide with a
real running program), no vault, a hidden window; it expects 401 for `/api/program` without the token and the expected window
preferences, runs one node check and prints one JSON line:

```
{"selftest":"ok","node":"not_running","page":"loaded","prefs":{...},"no_token":401}
```

Exit 0 within 60 s; on any failure it prints `{"selftest":"failed","why":"..."}` and exits 1. The temporary folder is removed.
On Windows the program is a GUI-subsystem binary: capture its stdout through a pipe or a redirect.

## Tests

```sh
node --test "desktop/test/*.test.js"
```

`test/shell-fixture.js` builds a shell over a fake electron, fake step 4.6 and 4.5 modules and a fake process. The real vault is
driven through the real secret-window logic in `test/vault-wiring.test.js`.

## What only the hosted build can prove

The real Electron module and its `safeStorage`; that `webPreferences` are really applied (the self-test reads them back); the
fuses; the tray and menu on both systems; keep-awake; the login item; notifications; `ELECTRON_RUN_AS_NODE=1` for `live.js`
including the stdin pipe from a GUI-subsystem binary on Windows; `app.asar` integrity and the runtime manifest on a real install;
`will-quit` with a real server; the secret window's sandboxed preload and content protection.

## The update check (notify-only, build spec 8.6)

Bottom line: the program can tell you that a newer version exists. It never downloads or installs anything; you read the release page,
check its sha256 and build provenance, and install by hand.

- `lib/updates.js` asks GitHub's public list of releases of the repository named in `package.json` (`no1d.updateRepo`) once: one
  https request, no redirect, no cookie, status 200 only, a size cap, a timeout, and a generic User-Agent. It answers "newer" only for a
  release that is neither a draft nor a pre-release, whose tag is `vX.Y.Z`, whose page is exactly
  `https://github.com/<repo>/releases/tag/<tag>`, and whose version is above the program's. Every test build has `updateRepo: null`:
  it never asks the first-start question, never checks, and its menu item says "This version cannot check for updates".
- `lib/updatecheck.js` decides when. The setting `update_check` (Settings) is `ask` at first, then `daily` or `off`. With `ask`, the
  program asks once after its page has loaded ("Once a day", "Never", "Ask me later"; Esc is "Ask me later"); a start at login
  (`--hidden`) asks nothing and a later start asks. With `daily` it checks at a start when the last check is a day old. Nothing is
  asked or checked while a swap is active, and then no time is kept, so the next start tries again. The last answer and its time are
  kept in `state.json` beside the crash times.
- The menu item "Check for a new version" (application menu and the page's menu) checks whatever the setting is, except while a swap is
  active, and shows the answer in a box: the version and its release page with the sha256 and provenance notice, "You have the newest
  version", "Not checked: a swap is active", "This version cannot check for updates", or "The check did not work". `/api/program`
  shows the last answer to the page.
- The self-test never checks, whatever the settings say.
- What GitHub learns: the computer's internet address and that a No1d Swap program asked; the request names nothing else.

## The private scheme (step 4.9)

The program opens no port. The console's page and API are served on the private scheme `no1d://app`, through the main window's own
session. The window loads `no1d://app/#token=<token>`; the token still appears in that one `loadURL` argument and nowhere else.

- `lib/scheme.js` has three functions. `registerPrivileged(electron)` calls `protocol.registerSchemesAsPrivileged` once, before `ready`
  (the shell does it right after the hardening guard is installed), with exactly `standard`, `secure`, `supportFetchAPI`, `stream`
  and, off, `corsEnabled`, `bypassCSP` and `allowServiceWorkers`. `attach({ electron, adapter })` calls
  `session.fromPartition("no1d-main").protocol.handle("no1d", adapter)` after `ready`: the main window's session only, so the secret
  window and the default session answer nothing on the scheme. `createAdapter({ handler, mark, maxBody })` turns a Fetch `Request`
  into the small request object the console's handler reads and the handler's answer into a `Response`.
- The adapter refuses, before the handler, every address that is not exactly `no1d://app` (another host, a user name, a port, another
  scheme): a fixed 403. It writes the `host` header itself from the checked URL (a Host the request names is overwritten), lower-cases
  header names, reads a POST body to the end but never above `maxBody` (16384, the largest route limit; above it a fixed 413 and the
  stream is cancelled at once; the handler still applies its own smaller limit per route), and answers a fixed 500 sentence with no text
  of its own when the handler throws, rejects or ends nothing.
- How a request is marked: the server module keeps a private Symbol. `startProgramServer` returns `mark(req)`, which defines that
  Symbol on a request object; the shell hands `handler` and `mark` to the adapter, and the adapter marks every request it builds. The
  handler refuses (403) any request without the mark, so a header, a path or a body cannot make one, and the handler is not usable by a
  plain HTTP server by mistake.
- Hardening compares origins by hand. In Node the `.origin` of a `no1d:` URL is the string `null`, so `hardening.originOf(url)` gives
  `http(s)` origins as usual and `protocol//host` for any other scheme, and no origin at all for a URL with a user name, a password or
  no host. The window's `allowedOrigin` is `no1d://app`; a request or navigation to `no1d://other`, `no1d://app:80`, `no1d://u@app`
  or `http://app` is refused. `createMainWindow` throws if its URL is not on `no1d://app`.
- Reload is blocked, because a reload loses the token (it lives in the fragment, and the page removes it from the address bar):
  `before-input-event` prevents Ctrl+R, Ctrl+Shift+R, Cmd+R, F5 (with any modifier) and the browser refresh key. When the page's
  process is lost (`render-process-gone`, except `clean-exit`) the window loads the original URL again once, with its fragment; a
  second loss (and every later one) loads a fixed `data:` page with the words "This window stopped working" and no script, and does not
  reload again.
- The self-test goes through the adapter instead of a port: its no-token `/api/program` request is a Fetch `Request` to
  `no1d://app/api/program` answered with 401. `NO1D_SELFTEST_HOLD_SECONDS` (a whole number from 1 to 30, otherwise ignored) keeps the
  self-test running, with its window and its scheme handler up, for that long after its checks and before it stops; the hosted
  start-up job sets 15 and, meanwhile, asks every process of the program for its listening TCP sockets about twice a second
  (Windows: `Get-NetTCPConnection -State Listen -OwningProcess <pid>` for every process named `No1d Swap`; macOS: `lsof -nP -iTCP
  -sTCP:LISTEN -a -p <pid>,<children>` once a second). One listener fails the step; so does a check that saw the program fewer than five
  times. After the self-test the program has exited, so the check could not run later; this was chosen over printing a listening
  state from inside the program (that would mean the program running `netstat` or `lsof` itself).
- The self-test also asks the page itself, through `webContents.executeJavaScript`, to say whether its scripts ran and to send one
  POST without the token to `/api/program/open` with its own `fetch`. The POST goes the real way: Chromium, the session's
  `protocol.handle`, the adapter, the handler. The self-test passes only when the scripts ran and the answer is 403 "missing or wrong
  token", which the handler gives only after the request passed its Origin check. So the hosted run proves that Chromium sends
  `Origin: no1d://app` on a page's POST through the handler and that the CSP's `connect-src no1d://app` lets the fetch out. A 403
  "cross-origin or missing Origin" fails with its own words. The JSON line gains `page_script` (true) and `page_post` (403), and the
  start-up check requires both.

**After the independent read of 4.9.** The read found one must-fix and eleven low points.
- Must-fix: the macOS half of the no-listening-port check read `lsof`'s exit status. `lsof` exits 1 when any process it is asked
  about has no listener, and every Electron helper process has none, so a listener of the main process would have been dropped and
  the step would have passed. The check now reads what `lsof` prints, never its exit status. Both OS steps now start with a positive
  control: they open a known listener (macOS: `python3 -m http.server 0`; Windows: a `TcpListener` in the step's own shell), ask the
  same query for it (on macOS together with a process that has none, the case that went wrong), and fail when it is not seen. A check
  that cannot see a known listener can no longer pass.
- Low 1 (the page never fetched through the handler) is done: the page probe above. Low 2 (Chromium might add no Origin through a
  scheme loader) is caught by it on the hosted run, before any release.
- Low 5 is done: Windows now makes one `Get-NetTCPConnection -State Listen` query per sample and filters it by the set of process ids,
  instead of one slow query per process.
- Low 6 is done: when the scheme cannot be attached, the shell stops the server before it exits 1, with fixed words ("The program's
  console did not start on its private channel. Nothing was started.") and without the error's own text.
- The other low points are in the list "Low points of 4.9" below.

**Low points of 4.9 (left, for the final pass).**

- Not one of these has run in a real window yet; the hosted start-up job is the first place, and its page probe is what settles the
  Origin and the CSP. Until it has run green, both stay unproved: that the page sends `Origin: no1d://app` on its POSTs (and a
  `Sec-Fetch-Site` of `same-origin` or none), and that a host source matches this scheme.
- The CSP is written with the explicit origin (`default-src no1d://app; ...`) rather than `'self'`, as the spec says. If a Chromium
  version did not match a host source for this scheme, the page would load blank and the page probe would fail.
- `hardening.js`: `webRequest.onBeforeRequest` may not fire for a custom scheme at all, so the `no1d` branch of `requestAllowed` may
  never run. The boundary does not depend on it: the scheme is answered on the main window's session only, and the adapter and the
  handler refuse every other address.
- `window.js`: the fixed page after a second lost renderer relies on `will-frame-navigate` not firing for a `loadURL` from the main
  process, as Electron documents. If it fired, the guard would block the `data:` page and the window would stay blank. First run on a
  real window: kill the renderer twice.
- `scheme.js`: the early 413 on a declared `content-length` now has its own test (done after the read); the cap on the stream still applies.
- `scheme.js` and `server.js`: the adapter parses the address with the rules of a non-special scheme, where a backslash is not a
  separator, and the handler parses it again as `http:`, where it is. Harmless, because every route and token decision uses the
  handler's parse; no check may ever be made on the adapter's `url.pathname`.
- `scheme.js`: the adapter has no timeout. A handler that waits on a dialog (`join`'s file chooser, `/api/program/open`) keeps the
  page's fetch open for as long as the dialog is up. By design.
- The Origin and `Sec-Fetch-Site` tests of `server-scheme.test.js` set headers that a browser forbids a page to set, so they test the
  handler's rule, not what Chromium sends; the page probe is the test of the latter.
- The window reloads its page once per window lifetime on a lost process. The counter is never reset, so a loss after a long quiet
  period still counts as the second one.
- The "Develop" menu of an unpackaged build (`lib/tray.js`) still has a `reload` role; Ctrl+R is stopped by the key handler, a click on
  the menu item is not. A packaged program has no such item.
- `selftest.js`: the hold is read from the environment, not from a command-line switch, so `parseCommandLine` and its tests stay as
  they were. Setting it only delays the exit of `--self-test`.
- Window navigation with the keyboard's back and forward keys is not blocked by a key handler; the guard refuses any navigation
  away from the page itself.
- `desktop/test/scheme.test.js` and the console's harness use the real adapter (the harness requires `desktop/lib/scheme.js`), so
  `ui/app` tests now depend on a file of `desktop/`.

## By hand, without the program

Bottom line: with your recovery code and a whole run folder you can open a swap with `swap-cli` alone, so a program that no longer starts, or
was uninstalled, does not keep coins in a contract.

You need:
- the recovery code (on paper);
- the whole run folder, `runs/<swap id>/` in the data folder: `%LOCALAPPDATA%\No1d Swap\runs` on Windows,
  `~/Library/Application Support/No1d Swap/runs` on a Mac (the uninstaller never deletes it);
- `swap-cli`: the program's own copy (`resources\bin\swap-cli.exe` in the install folder on Windows,
  `No1d Swap.app/Contents/Resources/bin/swap-cli` on a Mac), or one built from the public source;
- the public source of this repository (for `desktop/tools/recovery.js` and the three files of `desktop/lib/` it loads) and Node 22 or
  later. The program carries the same tool inside its archive, but running it with the program's own binary is not proven yet.

The advised way (Git Bash on Windows, or a terminal on a Mac). `REPO` is the public source, `RUN` the run folder:

```sh
REPO=/path/to/noid-swap
RUN="/path/to/runs/<swap id>"
export SWAP_PASSPHRASE="$(node "$REPO/desktop/tools/recovery.js" passphrase "$RUN")"
# type the recovery code, then Enter and Ctrl+D (in a Windows console window: Ctrl+Z, then Enter)
```

`recovery.js` reads the code from standard input only, never from an argument, so it is not left in the shell's history. It reads the run id
from `run.json`, refuses a folder whose `vault-check.json` belongs to another code, and opens `passphrase.sealed` when the folder has one (a
swap imported from the terminal console). After that, every `swap-cli` command for this swap opens its files with `SWAP_PASSPHRASE`; the
commands are in `swap-cli/README.md` (sections "The NOID swap wallet" and "The Ethereum swap key"). Close the shell when you are done: the
passphrase is in its environment.

The second half can be checked with `openssl` (the code is still turned into the secret by `recovery.js`), for a folder the program made
(no `passphrase.sealed`); this form gives the public test vector of the build specification:

```sh
SECRET_HEX="$(node "$REPO/desktop/tools/recovery.js" secret)"     # the code on standard input; prints the install secret
RUN_ID="$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).run_id)' "$RUN/run.json")"
printf '%s' "no1d-swap/v1/swap-passphrase/$RUN_ID" | openssl dgst -sha256 -mac HMAC -macopt "hexkey:$SECRET_HEX" | awk '{print $NF}'
```

Two limits of that form: it puts the install secret in `openssl`'s argument list, which other programs of the same machine can read while it
runs, and it gives a wrong passphrase for an imported folder (one with `passphrase.sealed`). Use it only to check the advised way.

## Low points (one line each)

- The menu's "Settings" only shows the window; the page's own menu opens its settings screen.
- A notification click shows the window; it does not select the swap (the main window has no preload to be told which).
- The Ethereum node check looks at the `sepolia` endpoints only (the program has no list of profiles in use yet).
- The Parano1d checkpoint (height 279,370) was read from one node only; the second node's read is still to be done at the first two-machine run.
- `tray.png` and the template images are drawn by a small script as plain diamonds; the logo work replaces them.
- The crash handler stores only times; no error text is kept anywhere, so a crash leaves no diagnostics.
- Not run in a real window yet, and so unproved: that no real start gets an extra switch from the system that the allowlist would refuse
  (a start that is refused for one says its name in the dialog); that `setProxy` and the WebRTC policy are accepted by the real session and
  webContents; that a Mac login start reports `wasOpenedAtLogin` and opens hidden. The hosted start-up job covers the first of these (it
  starts the program with `--self-test` only), the two-machine rehearsal the others.

**After the independent read of the window settings.** One point was fixed: the listener for "every window closed" is now
registered before any window exists. Without it, Electron quit when the secret window, the only window while the vault opens,
closed: the first start ended after "I have written it down", and every start in fallback mode ended after its passphrase prompt.
A test closes the secret window during the vault's opening and checks that the program keeps going; the fake electron now quits
like the real one when no listener is registered.

Fixed after the read (each with a test that fails without it):
- A crash state file that cannot be written (a full disk) no longer makes every crash relaunch: the program says so and stops.
- The command line is an allowlist (`--hidden`, `--self-test`; `-x` and, on Windows, `/x` count as switches too; a Mac's `-psn_*` passes). A
  proxy, a net log, logging or host-resolver switch is refused like a debugging one.
- Every session is told `setProxy({ mode: "direct" })` once, when it is first seen (before its first request), and every webContents gets
  the WebRTC policy `disable_non_proxied_udp`.
- The secret window is a sheet of the main window only while the main window is visible.
- A Mac login item asks to open hidden, and the start reads the system's `wasOpenedAtLogin` / `wasOpenedAsHidden` (a Mac login item cannot pass `--hidden`).
- A quiet handler for an uncaught error is installed first, so Electron's own error dialog never shows before the crash handler exists.
- `userData` and `sessionData` are set before the single-instance lock, so the lock's folder is the program's, not the default one in the roaming profile.
- The node check accepts `127.0.0.1` and `[::1]` only, not the name `localhost`. (`ui/app/lib/programsettings.js` now writes the same rule for the
  node setting; `ui/app/lib/runsettings.js` still accepts `localhost` as an http host for a swap's endpoints.)
- The lost-renderer reload and the reload keys were done in 4.9 (see "The private scheme").

Low points of the read (left; the final pass decides):
- `data:` is allowed for every session, the secret window's too (harmless: the server's policy allows it only for images).
- The permission check probably refuses `clipboard-sanitized-write`, so the copy buttons would fall back to their text.
- The secret window's message check compares the sender, not the sender frame (fine today: its policy allows no frames).
- The self-test checks five window preferences; it could check more, and inside the page that `require` and `process` are absent. Left: the
  hosted start-up check compares only what it knows (it is outside the files of this change), and a preference that real Electron reads back
  differently from how it was written would fail the hosted run, which only the real binary can show.
- `curl.exe` is found from the environment's `SystemRoot`, not a known-folder lookup.
- The versions must be checked again before the first release; `desktop/package-lock.json` is made by the first hosted run.

**After the independent read of the fixes above (2026-11-18).** No must-fix. Fixed, each with a test that fails without it:
- A Mac login start reads the system's answer after ready, not before: on macOS 13 and later the answer comes with the launch event, which is
  handled only by then (the fake electron now answers "no" before ready, as the system does).
- The secret window is not a sheet of a minimized main window either (Windows calls a minimized window visible), so it is never hidden with it.

Left (the final pass decides):
- The single-instance lock's folder moved to `<data>/electron` (it was the roaming `No1d Swap` folder on Windows and the data folder on a Mac):
  an instance of an older build and one of this build do not see each other (the run locks then make the second one read-only), and every
  second instance runs PowerShell (`dataDirFor`) before it asks for the lock, so focusing the first window is slower, and an error box shows
  in its place if PowerShell fails.
- On a real first start Electron makes `<data>` and `<data>/electron` before `ensureDataDirs` and `icacls` run (on Windows its lock file is
  open in it then). Harmless by reading (the inheritance change needs only the right to change the folder's permissions; a Mac makes them 0700),
  but `single-instance.test.js` checks "no folder was made", which only the fake shows; the hosted Windows start-up job is the proof.
