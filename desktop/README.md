# desktop: the No1d Swap program (Electron shell)

The shell of the desktop program (piece 4, step 4.7). It runs the console server in its main process, shows it in one hardened
window, keeps the machine awake while coins are in a contract, comes back after a crash, and starts at login while a swap is
active. This version works on the test networks and, within fixed limits per swap (0.5 ETH and 2,500 NOID), on Ethereum mainnet, where the coins are real.

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
| `lib/window.js`, `lib/hardening.js` | the main window (and its `openSettings`) and the policy guard of every webContents |
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

Both windows (the main one and the secret one) are created with `backgroundColor: "#050908"`, the page's own ground (`WINDOW_BACKGROUND` in `lib/window.js`), so no white shows before the page is drawn; the page shown after a second loss of the window has the same ground and ink and the same words, and no script.

Closing the window hides it while any swap is active; with none active it quits. Quitting with a swap active asks first and names
every swap at stake and until when. The system's own shutdown or log-off is never blocked.

## The secret window (build spec 7.5)

A separate modal window of the main process with its own in-memory partition and no API, with content protection on. Its page
is served on the private scheme at `no1d://secret/` by that partition's own session, and by no other: exactly `secret.html`,
`secret.css` and `secret.js`, GET only, read by the main process; anything else is 404, and the window may load nothing else.
It was first loaded from a `file://` URL, which never worked in an installed program: with the `grantFileProtocolExtraPrivileges`
fuse off, Chromium's own file loader serves `file://`, it cannot read inside `app.asar` (ERR_FILE_NOT_FOUND), and the window
closed at once, so the recovery code could not be shown (seen at the first start of the rehearsal's installers on both systems;
reproduced in Electron 45.2.3 with the build's fuses, where the new way loads with its script, stylesheet and preload). The
self-test now loads this page too (below). Its look (2026-11-20) is the page's own: the same ground, ink and amber, dark only (no light theme), system type on purpose (no web font: the sheet may hold no `url(` and no import, and the window may load nothing but its three files), one stylesheet. The recovery code is a box of 14 groups drawn as a grid of two columns filled downwards, 1 to 7 on the left and 8 to 14 on the right, numbered by a CSS counter, so that it can be copied onto paper in order; it still cannot be selected. The one button is amber (the program waits on the person), the other is quiet. `secret.js` was not changed. Values cross one IPC channel, accepted only from that window's own webContents and
only while a request is open. Requests are served one at a time. Closing the window ends a request as a cancel (`askGroups` and `askText` give `null`;
`show` rejects with `code: "CLOSED"`, which the vault reads as "the person never saw the code"). The vault asks for a new
fallback passphrase in two prompts (`fallback-new`, then again with `again: true`) and compares them itself.

## Self-test (`--self-test`, build spec 7.12)

For the hosted start-up test only. A fresh temporary data folder (used as the data folder before the single-instance lock so it cannot collide with a
real running program), no vault, a hidden window; it expects 401 for `/api/program` without the token and the expected window
preferences, asks the page whether its scripts ran and what a POST without the token gets, loads the secret window's page in a
window of that kind that is never shown (its script, its stylesheet and its preload's bridge must be there; no code or passphrase
exists in this mode), runs one node check and prints one JSON line:

```
{"selftest":"ok","node":"not_running","page":"loaded","prefs":{...},"no_token":401,"page_script":true,"page_post":403,"secret_page":true}
```

Exit 0 within 60 s; on any failure it prints `{"selftest":"failed","why":"..."}` and exits 1. The temporary folder is removed.
On Windows the program is a GUI-subsystem binary: capture its stdout through a pipe or a redirect.

A start-up failure under `--self-test` (a refused data folder, a second instance, a missing file) prints its reason as that same
`failed` line instead of opening a dialog, which no one could click on a hosted machine. Every start-up stage and every step of the
checks is written to stderr as `self-test: <stage> at <seconds since start> s`; nothing else writes those lines and a normal start
writes none. The line is printed before the program stops, and the stop gets at most 10 s (`STOP_MS`) before the program exits anyway,
so a stop that hangs cannot hide the result.

When `NO1D_SELFTEST_REPORT` names an absolute path, the self-test also appends every stage line and its result line to that file, because
the output of a packed GUI program may not reach a redirect on Windows; the hosted Windows job judges the result from that file. A
relative path is ignored, and a normal start never reads the variable. An error that is not a start-up failure (a throw no step
handled, an uncaught error or rejection while the self-test runs) also becomes the line, `an unexpected error ended the start:` and the
error's name and first 300 characters of its message on one line, and the program exits 1 with no dialog. Outside the self-test such an
error still ends in `main.js`'s dialog, which shows no error text. When a system command of the folder steps fails (`whoami`, `icacls`,
the read of the access list), the self-test's line adds `(detail: ...)`: a timeout, or the exit code and the first line of the
command's error; a normal start shows the fixed sentence alone.

The access list of a folder is read through PowerShell with one .NET call (`[System.IO.Directory]::GetAccessControl`), not with
`Get-Acl`: that command's module is found by looking through every module folder PowerShell knows, which on a machine with many
modules took longer than the 20 s limit (build run 12). The decision accepts, besides the user, SYSTEM and Administrators, the built-in
Administrator account, which a descriptor string names "LA" (build run 13: the hosted machine runs as that account); it is always a member of
Administrators. A refused folder gives its descriptor as the self-test's detail.

## Tests

```sh
node --test "desktop/test/*.test.js"
```

`test/look-shell.test.js` checks the dark ground of both windows, the fallback page and the secret window's sheet (dark only, system type, nothing to load, the numbered grid, the buttons).

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
  `https://github.com/<repo>/releases/tag/<tag>`, and whose version is above the program's. `desktop/package.json` names the public repository; a build whose
  `updateRepo` is `null` (the tests run as one) never asks the first-start question, never checks, and its menu item says "This version cannot
  check for updates".
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
  token", which the handler gives only after the request was not refused as cross-origin. So the run proves that the page's POST
  reaches the handler through Chromium and that the CSP's `connect-src no1d://app` lets the fetch out. A 403 "cross-origin request
  refused" fails with its own words. The JSON line gains `page_script` (true) and `page_post` (403), and the start-up check requires
  both.
- The first packed program on a real window (a Mac build of the tree of 4.10) failed that probe: Chromium sends no `Origin`, no
  `Sec-Fetch-*` and no `Referer` on a request answered through `protocol.handle` (the request carried only `accept`,
  `content-type` and `user-agent`), with the scheme's `corsEnabled` false and true alike, and the handler required
  `Origin: no1d://app` on every POST. The handler now refuses an Origin or a `Sec-Fetch-Site` only when one is sent and names
  another origin. What binds a write in program mode: the adapter's mark, the handler attached to the main window's session only
  (held to `no1d://app` by the navigation guard), and the per-start token in the fragment of the URL that window was loaded with.

**After the independent read of 4.9.** The read found one must-fix and eleven low points.
- Must-fix: the macOS half of the no-listening-port check read `lsof`'s exit status. `lsof` exits 1 when any process it is asked
  about has no listener, and every Electron helper process has none, so a listener of the main process would have been dropped and
  the step would have passed. The check now reads what `lsof` prints, never its exit status. Both OS steps now start with a positive
  control: they open a known listener (macOS: `python3 -m http.server 0`; Windows: a `TcpListener` in the step's own shell), ask the
  same query for it (on macOS together with a process that has none, the case that went wrong), and fail when it is not seen. A check
  that cannot see a known listener can no longer pass.
- Low 1 (the page never fetched through the handler) is done: the page probe above. Low 2 (Chromium might add no Origin through a
  scheme loader) was right: the probe caught it on the first real window, and the rule changed as said above.
- Low 5 is done: Windows now makes one `Get-NetTCPConnection -State Listen` query per sample and filters it by the set of process ids,
  instead of one slow query per process.
- Low 6 is done: when the scheme cannot be attached, the shell stops the server before it exits 1, with fixed words ("The program's
  console did not start on its private channel. Nothing was started.") and without the error's own text.
- The other low points are in the list "Low points of 4.9" below.

**Low points of 4.9 (left, for the final pass).**

- The CSP and the page's fetch are settled on a real window: a Mac build by hand of the 4.10 tree with the fixes above passed the
  self-test (`page_script` true, `page_post` 403), so a host source matches this scheme and the page's POST reaches the handler. The
  Origin is settled the other way: Chromium sends none through `protocol.handle`, and the handler no longer asks for one. The hosted
  start-up job has still to pass on both systems.
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
  handler's rule, not what Chromium sends; the page probe is the test of the latter. The test client and the fake page now send what
  Chromium was seen to send (no Origin).
- From the read of the Origin change (no must-fix): the self-test proves only that the page's POST without the token is refused for
  the token, not that a request of the page with the token gets through `protocol.handle`; requiring the page's program mode (set
  after its own token GET answered 200) would prove it. And "one renderer in the main session" rests on design: the hardening policy is
  looked up by session, so a second webContents in that session would get the page's allowed origin; looking it up by
  `webContentsId` and refusing a second webContents there in a packaged program would enforce it. Both for the final pass.
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

## Save a copy and open an invitation (2026-11-19)

Two dialogs of the program object (`lib/program.js`), used by the console's routes `/api/bundle/save`, `/api/invitation/save` and
`/api/invitation/open` (see `ui/app/README.md`, "Simpler swaps"):
- `saveCopy(kind, bytes)` -> `"saved" | "cancelled" | "busy" | "refused"`. `kind` is `bundle` (Alice's swap file for Bob, default name
  `alice.bundle.json`) or `invitation` (Bob's invitation for Alice, default name `no1d-invitation.json`); any other kind throws. The bytes are 1 to
  1,048,576. One dialog at a time: a second call while one is open answers `"busy"` and opens nothing. The chosen path must be absolute and, after
  resolving it and the real path of its parent folder, must not lie inside the program's data folder (compared without case on Windows); a file with a
  second name (a hard link) is refused too. Nothing is written when the person cancels.
- `chooseInvitationFile()` -> an absolute path or null, one dialog at a time (`showOpenDialog`, files only, filter `.json`). The console reads the
  file itself (a plain file, at most 4,096 bytes) and never shows the path.
- The shell gives both dialogs the main window as their parent when it has one (`saveFile`, `chooseInvitation`). Tests: `test/simple-dialogs.test.js`,
  `test/program.test.js`, `test/shell-start.test.js`.

## Launch screens, desktop side (2026-11-20)

Four small additions to the `program` object that the console reads (`program.payoutHistory`, `program.clipboardMatches`, `program.nodeStatus().eth.fee`
and the signed notice in `program.updateStatus()`). None sends anything and none changes what an approval hashes.

- **The signed notice.** `updateStatus()` already passes the update checker's answer through unchanged, `unsafeForNewSwaps` (a boolean) and
  `unsafeNote` (a string or null) included; a missing field reads as false or null. The program checks nothing more: the console re-checks the note.
- **The history of payout addresses** (`program.payoutHistory`, `lib/program.js`). One sealed file, `payout-history.sealed`, in the data folder
  (next to `vault/`, not inside it): AES-256-GCM under the key `K(S, "payout-history", "install")` = HMAC-SHA256 of the install secret with the message
  `no1d-swap/v1/payout-history/install` (`derive.historyKey`, test vector in `test/derive.test.js`; the sealed envelope's label is `payout-history`,
  its run id the word `install`, and the file name is bound into the tag, as for the board's files). The vault gives the sealer
  (`vault.historySealer()`, the shape of `boardSealer`). Plain text: `{ v: 1, entries: [{ kind: "noid"|"eth", addr, first_at, uses: [{ run, at }] }] }`
  with the newest 100 uses per address and 200 addresses at most (the least recently used address goes first; also when the plain text would pass
  900,000 bytes, the sealed envelope's limit is 1 MiB). Times are ISO-8601 in UTC.
  - `record(runId, entries)`: `entries` is `[{ kind, addr }]`; an address that is not of its kind's shape is skipped; a run counts once for an address;
    one write at a time; always resolves (a storage problem is logged in fixed words, never with an address).
  - `list()` gives `{ state, items: [{ kind, addr, first_at, count }] }`, newest use first; `forRun(runId, addrs)` gives `{ state, map }`, where `count`
    leaves out `runId` and an address seen only by that run is absent (so it reads as new). `0x` addresses are compared without regard to case, `o1`
    addresses exactly; the stored form is the first one recorded; `map` is keyed by the form the caller asked with.
  - `state` is `"ok"`, `"unreadable"` (the file is there and does not open: one flipped byte, a cut or edited file, a file of another installation or
    under another name, a folder in its place) or `"locked"` (the vault is not open, or the key store no longer opens the install secret, or the vault
    has no history sealer as in the self-test). In both other states the map and the items are empty, so every address reads as new, never as known.
  - A file that does not open (damaged, as opposed to a read error) is moved aside once, as `payout-history.sealed.unreadable`, by the next `record`,
    and a new history starts. A locked key store or a read error is never written over.
  - It is a check against slips and casual tampering, not against a program that runs as the same user and can read the key store: that one can seal a
    forged history. No step reads it.
- **The clipboard check** (`program.clipboardMatches(value)`). The shell passes `readClipboard`, electron's `clipboard.readText()` in the main
  process; the pages have no clipboard-read permission (`lib/hardening.js` denies all). The answer is `true` (the clipboard holds exactly `value`,
  white space around it ignored), `false` (anything else, an empty clipboard included) or `null` (no reader, a reader that throws or gives no text,
  a value that is empty or over 128 characters). It never returns the clipboard's text.
- **Ethereum's base fee** (`lib/nodecheck.js`). The latest-block read the node check already makes for its age test also gives `baseFeePerGas` and
  `number`; no new call. `eth.fees[profile] = { base_fee_wei, block, at, profile }` (a decimal string of wei, the block number, the time of the read in
  ms) for each profile read, and `eth.fee` is the one the page shows: Ethereum mainnet (`production`) when it has been read, else the first read
  profile. A node that is behind, on another chain or silent adds none; the last good one stays with its old `at`, so the console can call it stale
  after 120 s. The rehearsal chain reads no block and has no fee. Display only: no step reads it.
- Tests: `test/payout-history-vault.test.js`, `test/clipboard.test.js`, and additions to `test/nodecheck.test.js`, `test/derive.test.js`,
  `test/sealed.test.js`, `test/vault.test.js`, `test/program.test.js`. The fake electron has a `clipboard` stub (`opts.clipboardText`, `opts.clipboardThrows`).

## Low points (one line each)

- `eth.fee` is a pick (mainnet first when both networks were read): a swap on the other network should read `eth.fees[its profile]`, which carries the same fields, and compare `eth.fee.profile` before using `eth.fee`.

- The menu's "Settings" brings the window forward and then asks the page to open its settings screen (`openSettings` in `lib/window.js`): the main process runs one fixed line in the page that clicks the page's own menu item "Settings". It asks only while the window shows the program's own page (the private scheme), takes no argument and gives the page nothing; if the page has no such item (a page that is not in program mode, or one not drawn yet) the window is only shown. It depends on the item's text. Fixed 2026-11-19 (D-extra-1); the build info file (`DESKTOP-BUILD-INFO.txt`) now says "signature: none on Windows, ad hoc on macOS (no certificate, no notarization)" instead of "unsigned: yes".
- A notification click shows the window; it does not select the swap (the main window has no preload to be told which).
- The Ethereum node check looks at the `sepolia` endpoints always and at the `production` (Ethereum mainnet, chain 1) endpoints only while a run in the runs folder has profile `production` or within ten minutes after the page asked for the production fee (`GET /api/program?want=mainnet-fee`, sent by the new-swap form while its profile is mainnet; `program.wantMainnetFee()` -> `nodeCheck.wantMainnet()`); otherwise no request goes to the two mainnet operators and `status().eth.production` is `{ state: "idle" }` (with the endpoints asked: `{ state, endpoints, chain_id }`), and the overall `eth.state` is the worst of the profiles that were read. The rehearsal chain is not checked (the program has no list of profiles in use yet).
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

## The practice swap, desktop side (2026-11-23)

The application menu has "Practice swap" beside Help (`buildApplicationMenu` takes `onPractice`; the item exists only when it is given). The shell's `openPractice` shows the window and has the page click its own menu
item named "Practice swap" with a fixed script (`OPEN_PRACTICE_SCRIPT` in `lib/window.js`, the same way as `OPEN_SETTINGS_SCRIPT`: only while the page is the program's own, no argument, `false` when the item is
not there). The practice itself is the console's (`ui/app/README.md`, "The practice swap"): the shell requires nothing of it and the Help text says it needs no node, no coins, no network and no key store.
Tests: `test/practice-menu.test.js` (6).
