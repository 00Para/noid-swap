# ui/app — read-only web console for the swap tool

A small local web page that shows, for each configured swap, what both chains say,
what the engine (`swap-cli tick` loop) decided, the timers that matter, and the
receipts. Plain Node (`http` module), no npm install, no build step. By default it reads; it
never writes to a chain, a wallet or a swap file. The optional, off-by-default **actions mode**
(`--allow-actions`, section "Actions mode" below) lets the page run the fixed steps of a swap, including the spending ones
behind a gate.

Plain words for the two timers it shows: `D` is the Parano1d height after which
Alice can take her NOID back (before it, only the secret's address can close the
contract, and only to Bob). `T_reveal` is the Ethereum time after which Bob can take
his ETH back; Alice must publish the secret (the *reveal*) well before it, which is
why the engine stops at `T_reveal − 1800 s` (the *reveal cutoff*).

## Run

```sh
node ui/app/server.js                 # live: Parano1d node at :9601, Hardhat at :8545, port 8787
node ui/app/server.js --mock          # no node needed: synthetic timelines of live run 1 and 2
node ui/app/server.js --port 9000 --config path/to/swaps.json
```

Then open the URL the server prints (`http://127.0.0.1:8787/#token=…`; the chain console is at `/console`, and the operator page links to it with the key). **The `#token=…` part is the per-start key that every `/api/` request needs, in every mode** (see "The key and the address" below). The chain console polls `/api/swaps` every 15 s; node
answers are cached 10 s. (`--mock` and `--config` belong to this console; the operator page at `/` ignores them.)

Tests (Node ≥ 21; fixtures are the real recordings in `swap-cli/fixtures/`):

```sh
node --test "ui/app/test/*.test.js"
```

## Endpoints

| Path | What |
|---|---|
| `GET /console` `/app.js` `/styles.css` `/tokens.css` | the chain console page (`tokens.css` is served from `ui/tokens.css` when it exists) |
| `GET /` `/operator.js` `/operator.css` `/phases.js` `/viewmodel.js` | the operator console |
| `GET /api/run` `/api/demo` `/api/demo/scenarios`; `POST /api/helper` (only with `--allow-run-readonly`, closed when `--allow-actions` is on) | the operator console's data, see above |
| `GET /actions.js`; `POST /api/action` `/api/spend` `/api/autopilot` `/api/funded` `/api/newswap` (only with `--allow-actions`) | the actions mode, see below (`/api/autopilot`: "Autopilot") |
| `GET /api/health` | mode (`live` / `mock`), uptime, node labels (`scheme://host:port` only), RPC counters |
| `GET /api/swaps` | every swap of `swaps.json`, aggregated (see below) |
| `GET /api/swaps/<id>` | one swap |

Anything else is 404; any method but GET/HEAD is 405 (except the guarded POST routes above). The server binds loopback only (`127.0.0.1`, `::1` or `localhost`); any other `--host` is refused at start, in every mode. Every `/api/` request needs the key (`x-swap-token`); a missing or wrong one is a plain `401`. The static files (the pages) need none.

### `/api/swaps` per swap

- `terms` — the public terms from the object file + bundle: amounts, `h_create`, `D`,
  lock-by height, hashlock, claim authority, recipients, contract root, ETH contract /
  chain id / amount; `checks` compare the object file with the bundle. The 699-byte
  opening itself is not served.
- `noid` — `ok`, `stale`, `age_s`, `observed_at`, `tip`, epoch anchor, fee estimate (1 in /
  1 out) and relay floor, mempool size, the instance (slot, creation id, amount),
  `matches_opening`, `active_authority`, the on-chain object (deadline, max fee, code id),
  and `fund_tx` / `close_tx` (from `getTx` when a txid is configured) with `fund_final` /
  `close_final` (tip ≥ inclusion + 18).
- `eth` — `ok`, `stale`, chain id, latest block (number, timestamp = the chain clock),
  finalized block, the lock (`state`: open / expired-unclaimed / claimed / refunded, sender,
  receiver, amount, timelock), `lock_finalized`, the `Locked` / `Claimed` / `Refunded`
  events (block, tx hash), `preimage_revealed` and `preimage_matches_hashlock`
  (the bytes are never served).
- `timers` — `blocks_to_D`, `eta_D_s` / `eta_D_at` (30 s per block), `blocks_to_lock_by`,
  funding and close finality heights, `t_reveal`, `reveal_cutoff` and the seconds to each on
  the chain clock (`seconds_to_t_reveal`, `seconds_to_reveal_cutoff`) and on the wall clock,
  `t_reveal_relevant` (false once the lock is claimed or refunded).
- `engine` — the engine's own view parsed from `status_file`: phase, action with its plain
  words label, reason, notes, events, tick time, exit code, file age (`stale` after 300 s,
  the loop polls every 2 min); or `connected: false` with the reason ("engine view not
  connected").
- `phase` — `source: "engine"` (the engine's phase, with `chain_only` beside it for
  comparison) or `source: "chain-only"` (derived by the console from the two chains only,
  labelled as such). `stale` when the data behind it is.
- `steps` — the timeline: created → funded → final → ETH locked → revealed or ETH refunded →
  NOID claimed / recovered, each `done` / `current` / `pending` / `skipped`.
- `checks` — on-chain values against the terms (instance matches opening, deadline, hashlock,
  amount, parties, chain id, preimage hashes to H, engine tip vs console tip).
- `receipts` — txids, addresses and ids with a truncated form (first 8 / last 6).

Fail-closed, display side: an observation that failed, or is older than 120 s, is `stale`
and shown as such; a stale input makes the phase stale. The console never upgrades
anything to "fine" on its own.

## `swaps.json`

```json
{ "swaps": [ {
  "id": "run-2", "label": "…", "role": "alice",
  "object_file": "C:\\…\\swap.object.json",          // the wallet's object file (opening + terms)
  "bundle_file": "C:\\…\\alice.bundle.json",         // Alice's bundle for Bob (no secret in it)
  "noid_rpc": "http://127.0.0.1:9601",
  "eth": { "rpc": "http://127.0.0.1:8545", "contract": "0x…", "lock_id": "0x…", "from_block": 0 },
  "status_file": "\\\\wsl.localhost\\Ubuntu-24.04\\home\\USER\\live-run-2\\loop-alice.txt",
  "fund_txid": "…", "close_txid": "…"               // optional, looked up with getTx
} ] }
```

`status_file` is the text a tick loop writes (`[alice] tick exit 0 at …`, `noid: …`,
`eth : …`, `events:`, `ACTION:`, `notes:`, `applied: … phase_after: …`); the last block
in the file is used. A `\\wsl.localhost\…` path is retried as `\\wsl$\…` and vice versa.
Several swaps on the same node share one cache.

## Mock mode

`--mock` replays `ui/app/mock/<id>.json` for each swap in `swaps.json`: node answers in the
`swap-cli` fixture format for both chains, the public terms, and the engine text. Heights
and timestamps advance with wall time so the countdowns move. `run-1` is the settled swap
(chain-only phase `settled`, no engine file); `run-2` is the refund path (engine `lock_final`
/ `wait`, chain-only `eth_refunded`, counting down to `D`). Regenerate with
`node ui/app/mock/generate.js`. Run 1's hashlock and preimage in the mock are synthetic
(the real secret is not public); heights, NOID txids and addresses are the real ones.

## What it never does

- Never calls anything but these methods, enforced by an allowlist in `lib/rpc.js` that
  refuses the call before any socket is opened (tested): Parano1d `paranoid_blockCount`,
  `getEpochAnchor`, `estimateFeeDetailed`, `getMempoolInfo`, `getObjectInstances`,
  `getObjectStatus`, `getTx`; Ethereum `eth_chainId`, `eth_blockNumber`,
  `eth_getBlockByNumber`, `eth_getLogs`, `eth_call`. No `submitTxIntent`, `createObject`,
  `wallet*`, `getMempoolEntry`, `eth_send*`, `eth_accounts`.
- Never reads a `*.swap.json` (sealed secret), a key file, or `eth/keys/`; the config loader
  refuses such paths (tested). It reads only the configured object, bundle and status files.
- Never serves the revealed preimage, the opening bytes, or a full node URL (an API key may be
  in the path).
- Never sends a transaction, never signs, never funds, **unless started with `--allow-actions`** (below). Without that flag the only POST handler is the optional, off-by-default read-only runner.

## Known limits

- Without `getMempoolEntry` the console cannot tell whether a mempool entry is a call on our
  contract; it shows the mempool size and fee floor only. The engine view has that detail.
- Chain-only finality of the funding needs `fund_txid`; without it the phase says "finality
  unknown".
- The chain-only phase is a reading of public state, not the engine's decision: it does not
  know what the engine has already sent. When the engine file is connected, its phase is
  shown first and the chain-only one beside it.
- Public Ethereum nodes cap `eth_getLogs` ranges; set `eth.from_block` near the lock there.

## Actions mode (`--allow-actions`)

Off by default. With the flag the page performs the steps of a swap: the same helpers of `scripts/live` that the owner types in a
terminal, behind buttons, with the checks of a spend done by the server.

```sh
node ui/app/server.js --allow-actions \
  --run //wsl.localhost/Ubuntu-24.04/home/USER/live-run-N   --run C:/Users/USER/Documents/live-run-N
#   first --run: the WSL run folder ($L); the second: the public copy folder ($PUB), where the audit log goes (or --audit-dir DIR)
#   --run-number N (default: from the folder name live-run-N, and it must match it)  --wsl-distro D  --helpers-dir /abs/bin  --wsl-run-dir /abs/run
#   --repo-live-dir /abs/scripts/live (WSL path of this repository's scripts/live, for install.sh; default derived from this checkout)
#   --role alice|bob|both (default both): the role THIS machine drives, see "One role per machine" below
```

It prints a URL with `#token=…`. Open that URL (the token lives in the fragment, is kept in memory and is removed from the address bar).
`--allow-actions` implies the read-only runner's guards: loopback only, the per-start random token on every POST (and, as in every mode, on every `/api/` GET), same-origin, the Host
check, one action at a time. `POST /api/helper` is closed in this mode (one runner, one busy flag, one audit log).
The read-only runner (`--allow-run-readonly`) starts its helpers through `wsl.exe -e` like the actions runner, passes `RUN=N`, and refuses to start when no
run number can be derived (a folder named `live-run-N`, or `--run-number N`): there is no silent fallback to the helpers' default run.

**One console per run folder, and the same folder.** At start the console takes `ui-console.lock` in the run folder (created exclusively; it holds the pid, the
start time and the role; removed on a clean exit); a second console on that folder refuses to start ("another console is already running on this run folder").
A lock whose process is gone (a crash) is replaced, and the start says so (after a takeover the console waits a moment, reads the file again and gives up if it
does not hold its own pid and start time: two consoles that found the same stale lock cannot both go on); a lock that cannot be read is not replaced (remove it by
hand). The refusal says "if no console is running, delete <file>". **A run folder that does not exist yet.** The table's "install" action creates the run folder, so the console can start before it
exists: it says so at start and on the page (a banner, "the run folder does not exist yet: run "1. Install helpers""), takes NO lock, and runs nothing
but `install` (every other action, every spend, the funding acknowledgement and the settings form answer 409). The lock is taken as soon as the folder exists
(the page's poll and every action look again; `lib/runlock.js` `LazyRunLock`); until it is held nothing but install runs, and a folder that exists but whose lock
a live console holds is refused for install too. The audit folder (the second `--run` / `--audit-dir`) is made at start when it is missing in this case. A path that
cannot be read for any other reason (a wrong distro name, no permission) stops the start with the folder and the error code. **Every state-changing route re-reads the lock file right
before it does anything** (spends, the funding acknowledgement, the setup / prepare / tick / dry-run / watch actions and the settings form; only the page's read-only GETs do not): a console whose pid and start time are not in the file does nothing (409, the same text for all, and an audit line `refused: run lock not ours`, or `refused: run folder does not exist yet` before the folder exists; if the audit log cannot be written the refusal is still returned). The folder the
console READS (the first `--run`: ticks, gate evidence, markers) must be shown to be the folder the helpers get as `L`: a `\\wsl.localhost\DISTRO\…` read folder
and the derived `/home/…` are the same; explicit `--wsl-run-dir` / `--wsl-distro` that do not match, or a read path that cannot be mapped, refuse to enable the
actions mode. The latches and the funding guards are rebuilt from the WHOLE audit log (no line cap).

### What the page can do

| group | actions (fixed table in `lib/actions.js`) | sends anything? |
|---|---|---|
| setup | install the helpers (`install.sh N`; refused once the run has swap files or a loop is running), setup, prepare (both roles' files; seconds with the proof-free lock kind), check-object, **join** (Bob's first step: `join.sh`, Alice's bundle file checked against Bob's own terms, Bob's swap file written; Bob's role only, see "Join a swap") | no |
| settings | the new-swap form writes `$L/env.local.sh` from a fixed template | no |
| tick | read-only tick of either role (of this machine's role under `--role`) | no |
| watch | start (detached, keeps running when the page is closed) and stop (only a loop this console started) `watch.sh ROLE 30`, ROLE being the console's `--role` (three fixed scripts: `alice`, `bob`, `both`); the page shows whether it is alive | no (records facts and intents) |
| dry | every dry run: funding (`fund.sh --dry-run`), lock, reveal, refund, NOID claim, and the dry runs of the two `--replace` re-sends | no |
| spend | `fund.sh`, `lock.sh`, `reveal.sh`, `claim.sh --submit`, `refund-eth.sh`, and `--replace` of the reveal and the ETH refund | **yes** |
| wallet run only | `wallet-setup.sh`, `wallet-status.sh` (read-only), the recording of the recovery close, and the spends `wallet-fund.sh` (in place of `fund.sh`), `wallet-recover.sh`, `wallet-sweep.sh`: see "The tool's own wallets" | the spends **yes** |

### Funding (`fund.sh`)

Alice's NOID funding is a spend like the others, through `fund.sh`. The helper's own guards all fail closed (a check that cannot be made refuses):
check-object must exit 0 AND print the anchored line `object file OK: … fund exactly this address: o1…` (that address is the contract root); the amount
funded is compared with the swap file's amount (`swap-cli status`); the wallet CLI's `contract instances` is read with its exit status kept apart (a
failure, or any output that is not empty or `Slot N  incarnation M …` lines, refuses; one instance line refuses); it works on a private copy of the object file
(one per process, in a folder `$L/fund-object.XXXXXX/` of its own, mode 600, removed when the helper ends: the file that was checked is the file that is funded); and THREE markers are written atomically BEFORE the wallet CLI is called:
`$HOME/.noid-swap/funded/<contract root>` (this user, any run folder), `funded-<contract root>.marker` next to the ORIGINAL object file (any run folder that uses it)
and `$L/funded.marker` (this run folder). The run folder's marker records the stage (`stage: calling wallet CLI`), the wallet CLI's output (the txid) and
`wallet exit <code>`. A second funding makes a second instance and stops the swap (run 9). Two steps in the page:

1. **Dry run** (`dry-fund` = `fund.sh --dry-run`). The helper prints text, not JSON; its shapes (checked against the real helper on a copy of a finished
   run) are `object file OK: …`, `object: <absolute path of the original object file> sha256 <hex of the private copy>`, `amount: N micro-NOID (swap file and AMOUNT agree)`, then
   `dry run: would fund 5.000000 NOID once with: <wallet CLI> contract fund <the private copy> 5.000000` (exit 0), or a refusal (exit 3): the instance, marker,
   amount, listing and object-check refusals, each shown as the helper printed it, and the dry run is recorded as failed. A marker refusal adds the lines
   `markers: …` (the three paths) and `recorded (…): stage: calling wallet CLI` / `Funding submitted: <txid>` / `wallet exit N`: the page shows what the marker
   recorded. The rows: the helper would fund once;
   the object file is OK (once, on its own line); **the contract address in that line is the terms' contract root** (red on a mismatch); the amount equals the terms' amount and the engine's intent, and the `amount:` line equals the terms'
   amount; **the file fund.sh read is the file the terms came from** (its sha256 equals the sha256 of the `swap.object.json` the console reads, normally the
   public copy given as the second `--run`, or the newest `swap.object.json` of the folders: the same file `readRun` took the terms from, AND fund.sh's path maps to that same file: `/mnt/c/…` is `C:\…`, a WSL share is the Linux path in its distro; otherwise
   red with both paths shown, and without a visible object file nothing passes); and **the wallet program is exactly the platform default**
   (`/mnt/c/Parano1d/bin/parano1d-cli.exe` under wsl, `parano1d-cli` natively), so a `NOID_CLI` set in `env.local.sh` (hand-edit only, see the settings form)
   turns the dry run red.
2. **Send** (`send-fund` = `fund.sh`, role alice). The gate (below) with these specifics: a fresh applied Alice tick whose action is `fund_noid` (a ledger
   intent, recorded or held); the amount in it equal to the terms' amount; no marker present (the run folder's, and the contract-keyed one next to the
   object file, whose name comes from the terms' contract root; an acknowledgement of an outside funding writes them too, below); no instance at the root and the file still at
   `created`; the typed confirmation in NOID (`5 NOID`); **a second, explicit statement**, sent as `no_pending_funding: true` and ticked in the dialog:
   "No funding of this contract is pending: I have not run the wallet's fund command or fund.sh for it anywhere else" (a pending funding shows no instance, no
   marker here and no tick yet, so only the operator knows); **a third statement** (2026-11-17), sent as `bob_check_matches: true` and ticked in the same dialog:
   "Bob's check line matches mine: the 16 digits of his bundle check line are the ones of my line, compared over a second channel" (the dialog shows Alice's own
   line under it when the newest clean Prepare record has it; a funding sent before Bob's check locks the NOID until `D` for a swap he may never join, which costs
   time, not coins, and the tool cannot see Bob's machine); only the boolean `true` counts for either statement, a missing or false one is the gate's refusal
   (`statement`, `statement_bob_check`), another type is a bad request; one send per intent. The audit start line records
   `statement=no_pending_funding; statement=bob_check_line_matches`. The result is the
   markers, not a transaction hash: the `end` line carries `funded.marker <time>`. After a send, or whenever either marker exists, funding is never offered again.
   A failed `fund.sh` leaves the markers on purpose (the funding may be pending): look at the mempool and `contract instances` before deleting them.

**Fund from here, right after Bob's check** (since 2026-11-17 the engine offers the funding from `H_create - D_offset` on, so the button above no longer
waits for `h_create`; see "The funding opens before `H_create`" in `swap-cli/README.md`. Until then the button opened only at `h_create`, which in run 13 left Bob
6 blocks for his lock, and the funding was done from a terminal.) Order: Bob's check done on his machine (`join.sh`, or `new-bob`) and the two `bundle check`
lines compared, then the dry run and Send in the box "Do it from here", once; the "I have funded" box is only for a funding made outside this console. The page
says this at the top of Alice's first card from the start, while the file is at `created` and neither a marker nor an acknowledgement exists (also before the
engine offers the funding: the engine's reason "too early to fund: the funding opens at height X" is shown above it as printed). `fund.sh --dry-run` and `fund.sh`
in a terminal, then the "I have funded" box, is named as the alternative; one way, not both. Not run live: a funding sent with this button well before `h_create`.
Ticking "I have funded" does not post at once: a confirmation dialog says what it writes (the two markers, an audit line) and that it closes the button for good; Cancel
unticks the box and writes nothing.

**A funding done outside this console** (the wallet's own fund command, or `fund.sh` in a terminal or under another folder) is told to the console with the
"I have funded" box (enabled after a good `check-object`; `POST /api/funded`). The acknowledgement is **persistent in the markers**, the same ones
`fund.sh` uses: the console creates `$L/funded.marker` exclusively (first line the time, second line `acknowledged: funded outside fund.sh`) and
`funded-<contract root>.marker` next to the object file. When the terms carry no contract root, or no object file is visible to the console, the acknowledgement is
**refused** (409, and a `refused` line in the audit log): the second marker cannot be named, and a half acknowledgement would not stop `fund.sh` elsewhere. So `fund.sh`
in a terminal, another console, or a console started with another audit folder refuses too, as long as it uses this run folder or this object folder (it prints the
acknowledgement line). It does **not** block `fund.sh` started under ANOTHER run folder with a COPY of the object file in another folder: the console does not write
the per-user marker, and until an instance is visible nothing else stops that run. The response and the page say so. The audit line stays (`detail: marker=none; wrote funded.marker …`; an older
acknowledgement that is only in the log still closes `send-fund`). It is refused (409) once a marker exists, and on a console for Bob. A `send-fund` start line
alone does NOT close the acknowledgement: a `fund.sh` that refused before it wrote a marker funded nothing. The per-user marker (`$HOME/.noid-swap/funded/…`) lives in
the helpers' home (the WSL user's), which the console does not write. The page says which path applies: the button
once the engine has recorded the funding step, the box when you funded elsewhere; use one, not both. The recovery after D shows `recover-noid.sh` in the terminal.

### The first card leads with the step (and the page's banners)

When a spend of this console's role is relevant (`spends[id].relevant`), the first card is titled by the step and is laid out in this order. The title depends on what the engine has decided: a fresh intent
(or the NOID claim, which has none) reads "Next: reveal the secret" / "Next: lock 0.001 ETH" with the "your move" chip (a stale tick says "stale tick" instead);
a HELD intent (decided on an earlier tick; it may already have been sent) reads "Reveal: decided earlier" with the chip "decided earlier: send only if you have not" and
no "Next:"; the funding reads "Funding" in both cases, never "your move" (it may have been done outside the console, which it cannot see), with the funding order
above the box and the sentence "Use this button only if you have NOT already funded (fund.sh in a terminal, or the wallet)." in it. The order: the engine's reason, the box "Do it
from here" (the funding order above it for the funding), the held-intent warning (it says to use the box only if the step was not already sent from a terminal;
sending twice pays twice), notes and events, and last, folded into a `<details>` ("The same step as terminal commands"), the grey command blocks. The texts that
would contradict an open step ("Nothing to do now") are not shown while the button exists. When the step is not offered here, the card is as before.
Pure logic: `leadAction`, `fundingGuide`, `lockByNote` in `lib/viewmodel.js`.

The page also shows, above every other alarm and only in actions mode: **"This page lost its key (a reload drops it). Open the start URL printed in the console's
terminal again."** when the page has no token (the token lives only in the URL fragment), with the same sentence as visible text next to the setup, watch, spend and
funding buttons (a hover title alone is not seen); and the banner for a run folder that does not exist yet or whose lock is not held (above).

**The lock-by is the engine's note, not a number of the console's.** Bob's real last lock height depends on when Alice's funding became final, which only the engine knows;
the console used to count "N blocks left" down from the bundle's nominal lock-by and could say "passed" while the lock was still allowed. It no longer computes anything: the
first card and the deadlines card show the engine's own note (`funding window …`, `lock-by margin …`, `lock margin …`, `nominal lock-by N has passed …`, `the last lock height …`),
whole, beside the nominal height ("Lock-by height (nominal)", with no countdown). The note is coloured by the engine's own words ("is short" warns, "has passed" / "is closed" is red).
When the tick has no such note nothing is shown (`view.lock_by_note`).

**A step the engine does not offer is not offered.** A HELD intent prints as `wait`, so the engine's fresh decision of the same tick is only in the note
`held: fresh decision was KIND`. The console offers the step (box, dry run, commands, frozen parameters) only when that fresh decision is the held step itself.
Otherwise the card is titled "A step is held, and the engine does not offer it now", leads with the engine's own reason (for a held reveal whose cutoff has passed that is
"… its reveal cutoff has passed, so the printed parameters are not to be used; if nothing was sent, cancel it with `swap-cli intent FILE --cancel` …"), and shows no send box
and no command, and lists no frozen parameters of its own (the engine's notes are shown as it printed them). The gate refuses the same case (`engine_not_offering`), and `do NOT send it` in the wait reason (a pending lock the producer screen refuses) is refused too.
A fresh intent (`recorded`: the printed action is the step) needs no note. A **re-send** (`--replace`) has no fresh decision to compare with (the engine's fresh decision
beside a pending claim is a wait, and it never offers a re-send itself), so it keeps its own conditions (a held intent and evidence of the transaction) and is withheld while the
engine says the held reveal's cutoff has passed (`engine_cutoff`). Where the console still needs a text for this, it is in `lib/enginetext.js` (below).

**The reveal cutoff comes from the intent.** The engine freezes `cutoff` (first reveal) and `late_cutoff` (a re-send once the secret may be public) into the reveal intent; the deadlines
card shows both rows from there ("frozen in the engine's intent"). Only while no reveal intent exists does it show `T_reveal − M_A` from the console's copy of the profile table,
labelled "estimate from the profile table". The console no longer says what the engine will do after the cutoff.

**Loud notes.** `ALERT:`, `ALARM` and `ANOMALY` notes are alarms (red), shown whole and never cut, and again above the card's reason in a bordered block (`loud_notes`).
**An aborted file** leads with the engine's reason and notes (large, not muted) and never says "nothing is at risk" or "nothing is on chain" by itself: the "If the swap stops now" card
lists **"Coins at the contract"** from the tick's `noid.instances` (amount, slot, creation, "does not match the opening" as the node says), says that they are taken back after D
with the recovery helper in a terminal (`recover-noid.sh --dry-run`, `recover-noid.sh`, `tick.sh alice --closed-by TXID --apply`; the console cannot start it yet), and raises an alarm.
A tick that lists no instance says "lists no instance at the contract root. That is what the node said then"; a tick with no instance information says "the console does not know".
**The producer screen** (Bob, threat T21): `noid.producers`, `producer_marker` and `accept_producer_concentration` are restated as plain figures (shares of the windows, the second node's check,
the marker), under "Producer screen" in the first card, with no verdict of the console's own.

### The key and the address

The console binds loopback only (`127.0.0.1`, `::1`, `localhost`): any other `--host` is refused at start, in **every** mode (read-only too). Every start makes a random 48-hex key and prints a URL that ends in
`#token=…`; **every request to `/api/` (GET and POST) must send it in `x-swap-token`**, and a missing or wrong key is a plain `401` (so another local account cannot read `/api/run` through the port).
The operator page reads the key from the URL fragment, keeps it in memory and removes it from the address bar; the chain console (`/console`) leaves it in the fragment so that a reload keeps it.
The static pages need no key and contain none. Opening the plain address shows "missing or wrong token: open the start URL printed in the console's terminal".

### Production is read-only

The settings form offers the test profiles only (`sepolia`, `rehearsal`); `production` (Ethereum mainnet) and the mainnet fee cap `MAX_FEE_GWEI` are gone from it. A run folder that says production
is shown **read-only** with the sentence "This swap is on the production profile (Ethereum mainnet). This console does not act on a production swap …", and **every action is refused** (403, an audit line):
setup, ticks, dry runs, the watch loop, every spend and the funding acknowledgement, and the table's buttons are all marked blocked. "Says production" means any of: the bundle's profile (when it states one),
a chain id 1 in the terms, in the tick's Ethereum observation or in the swap file's own terms (`swap_terms.eth.chain_id`), or a `PROFILE` / `CHAIN` line of the folder's `env.local.sh` that says production / 1
(only those two lines of that file are read, by a strict pattern; a later line cannot take it back). `lib/production.js`.

### What the console reads from the engine's text (`lib/enginetext.js`)

Wherever the tick has a structured field the console uses it (the action and its parameters, `intent`, `noid.instances`, `noid.producers`, the chain ids, `phase_after`). The matches on note and reason TEXT are all in
`lib/enginetext.js`, each with the engine source that produces it, so that a structured display block printed by the engine can replace them in one place. They are: the held tick's `held: fresh decision was KIND`
(engine.rs `tick_apply`), the held reveal's `its reveal cutoff has passed, so the printed parameters are not to be used` (`reveal_cutoff_wait_reason`), `do NOT send it` (producer_gate.rs), the words
`ALARM` / `ANOMALY` and the prefix `ALERT:` (engine.rs, producer_gate.rs), the lock-by notes (`lock_by_margin_note`), the leftover-leg words of a wait reason, and the `fail closed` / `stale` words (amber only).
`test/enginetext.test.js` looks each phrase up in `swap-cli/src` and fails when the engine rewords one.

### One role per machine (`--role`)

`--role alice|bob|both` (default `both`, so a one-machine run behaves as before). With `alice` or `bob`:

- `watch-start` runs `watch.sh ROLE 30` (one of three fixed scripts), so the other role's local swap file (for example the unused Bob copy that
  `prepare.sh` writes on Alice's machine) is never ticked.
- The other role's tick, dry-run and spend ids answer **403** ("started with --role alice: … belongs to bob, which runs on another machine") before
  anything is logged or run, are marked `blocked` in the table and are not offered by the page; the watch status looks only at this role's loop file.
- `/api/run` hides the other role's files (`roles.<other>` is null) and carries `role`; the page has one active tab, the other is disabled and
  says "other machine".
- `prepare`, `check-object`, the funding dry run and spend, and `POST /api/funded` are Alice's: a `--role bob` console refuses them (403) too.
- Every audit line carries `srv_role`, the role the server was started with. The read-only runner (`--allow-run-readonly`) takes the same flag.

The page also says "the other role runs on another machine" (an info note, not a problem; status "Runs on another machine" instead of "No data") when
only one role has tick or loop data in the run folder, even without `--role` (worded "probably"). A role that IS driven here and is behind the chain
still raises `file-behind-chain`.

Every command is `wsl.exe -d DISTRO -e env RUN=N L=RUNDIR bash SCRIPT ARGS` with a cleared environment and an argument vector
(`-e`: no shell on the way in). A request carries an id from the table, never a command. The only values substituted into an
argument vector are the run number and, for `--replace`, a transaction hash that the **server** read from the engine's tick (the
pending claim) or from a helper's own stderr (`sent: 0x…`) and that matches `0x` + 64 hex.

### The tick file while it is being rewritten

`scripts/live/tick.sh` truncates `last-tick-ROLE.json`, runs the tick for 10 to 20 s and only then writes the content, so a read in that window sees an empty or
half-written file (live run 13: `dry-reveal` ok, `send-reveal` refused 10 s later with `tick_missing, dry_mismatch`, accepted 7 s after that). Cause: `readRun` parsed the
file, got `tick: null`, and the gate then said `tick_missing`; the dry run's comparison (`checkDryRun`) ran against that null tick too, so every row that compares with the
engine (the lock id) was red: `dry_mismatch`. The dry run itself was never used up (it is dropped only when a spend starts), which is why the next click worked.
Now: `readRun` remembers the last COMPLETE tick it parsed per file (`TickKeeper`, in memory, with that file's own time). An empty or unparsable file whose own time
is at most 90 s old is "being written" (`tick_writing`, not `tick_error`): the page keeps showing the last complete tick, labelled, with its true age (an info alarm),
and the gate answers a spend with the one reason **`tick_writing`: "A tick is being written right now: try again in a few seconds."** (no `tick_missing`, no
`dry_mismatch`); the refused click is logged and does not use up the dry run. A file that has been broken for longer than that, or is no JSON object, is still an
error (`tick_missing` with the parse error). A partial tick is never a valid one, and the freshness rule (a fresh applied tick naming the step) is unchanged.

### The gate in front of a spend (`lib/gate.js`, re-checked by the server on the POST)

1. The engine's last tick for that role is applied, fresh (at most 120 s by the file time and by the tick's own clock) and holds the step.
   A ledger spend (lock, reveal, refund) needs its frozen intent `recorded` or `held`: the engine turns a recorded intent into a held
   one on the very next tick, whether or not anything was sent, so a recorded-only rule would leave one watch period to act. A held
   first send is allowed once per intent and only while nothing shows it was sent (no lock, pending claim or refund in the tick, no
   `sent:` line in the run folder), **and only while the engine's own fresh decision of that tick was that step** (the note `held: fresh decision was KIND`; otherwise `engine_not_offering`,
   with the engine's reason quoted). The NOID claim has no intent: the tick must say `claim_noid` and show no close of ours. A
   `--replace` needs the intent held and evidence of the transaction to replace, and is refused while the engine says the held reveal's cutoff has passed (`engine_cutoff`).
   No terminal phase. **The alarm rule:** an `ANOMALY` / `ALARM` text in the tick (the engine prints an ALARM on every tick while a late lock of Bob's is open) refuses the steps that put coins
   in or publish the secret and the claim (`fund_noid`, `lock_eth`, `reveal_eth`, `claim_noid`, re-sends included) with the whole alarm text, but **not** the two steps that only return coins to their
   owner and that the engine itself offers (`refund_eth`, its re-send, and the NOID recovery): for those the alarm text is shown beside the send box and every other gate stays. An `ALERT:` note
   additionally refuses `fund_noid`, `lock_eth` and `reveal_eth` (`engine_alert`), never the claim or a refund. A kind the table does not know is refused.
2. A dry run of the **same helper with the same flags**, made by this server less than 90 s ago, exited 0, whose result fields are all
   green when compared (on the server) with the swap terms and the tick: chain id, contract, sender, amount, lock kind (from the
   bundle); for the lock the decoded call data (hashlock, receiver, T_reveal) and the lock id recomputed with an independent
   Keccak-256; for the reveal the lock id, receiver, amount, no secret given and the cutoff still ahead; for the refund the call data;
   for the NOID claim the recipient, self-verification, call height before D, fee within the cap, amounts adding up. The page shows
   every row, green or red, the result file (call data and secrets stripped) and the sha256 of the file. A dry run authorizes
   one start and is dropped when it begins.
3. A confirmation dialog in plain words (what moves, from where, to whom, the risk) and a typed confirmation of the amount and
   unit (for example `0.001 ETH`, `10 NOID`), compared as numbers.
4. A latch: not started from this console for the same intent, and not twice on the same tick (compared tick clock to tick clock);
   rebuilt from the audit log after a restart.

After a send the page shows the job, the result file, the transaction hash and what to expect next. How a spend ended is read from the exit status **exactly as the helper documents it**
(next section): only a status the helper documents as "nothing was sent", with output that agrees, is shown as "refused, nothing sent" and releases the latch; a timeout, a signal, a status that is not in the table
or output that could not be read says the transaction may have been sent and tells the operator not to repeat it. A reveal that was mined and reverted (the secret is public) is flagged in red.

### What a spending helper's exit status means

`lib/exitcodes.js` (pinned by `test/exitcodes.test.js`, which also checks this table). "Clean" needs three things: the status is in the table, the output agrees (a refusal line where one is named), and the
helper's send left **no fresh result file** (live.js was not run). A clean refusal is shown as "refused, nothing sent", its latch is released (the audit end line reads `refused, nothing sent (HELPER exit N)`, which a restart
also reads), and the step can be tried again after a fresh dry run. Nothing else is ever released.

| helper | exit | meaning | counts as |
|---|---|---|---|
| `lock.sh` | 3 | `lock REFUSED, nothing sent`: the fresh read-only tick before the send did not offer the lock (or did not finish, or could not be read). Needs that line on stdout. | refused, nothing sent |
| `lock.sh` | 2 | stopped before the tick and live.js ran (usage, fee settings, passphrase, run folder, `LOCK_PRECHECK_TIMEOUT`) | refused, nothing sent |
| `reveal.sh` | 2 | stopped before live.js ran (usage, fee settings, passphrase, run folder) | refused, nothing sent |
| `reveal.sh` | 3 | the claim was mined **and reverted**: it paid nobody and the secret is public | secret public (red) |
| `refund-eth.sh` | 2 | stopped before live.js ran (usage, fee settings, run folder) | refused, nothing sent |
| `claim.sh` | 2 | stopped before swap-cli ran (no passphrase file) | refused, nothing sent |
| `fund.sh` | 2 | a setting is wrong or a folder cannot be written; before any marker or wallet call. Counts only while the output has no `funding N NOID (once) at …` line: the helper ends with the wallet CLI's own status, so after the wallet call exit 2 is the wallet's | refused, nothing sent |
| `fund.sh` | 3 | a guard refused before the wallet CLI was called (or a marker exists). Counts only while the output has no `funding N NOID (once) at …` line: after the wallet call exit 3 is the wallet's own status | refused, nothing sent |
| `wallet-fund.sh` | 2 | a setting or a tool is wrong, before swap-cli built anything (wallet run only). Counts only while the output has no `wallet-fund: outcome` line | refused, nothing sent |
| `wallet-fund.sh` | 3 | refused: the reveal's fee reserve is not covered, or swap-cli refused or could not submit. Counts only while the output shows no `outcome sent`, `maybe_sent`, `done` or `hold` | refused, nothing sent |
| `wallet-fund.sh` | 4 | nothing sent by this run: the tool says to wait (the deposit is too young, the window) or that the funding is already at the contract. Needs the line `wallet-fund: outcome hold` or `done` | nothing to send now (nothing sent) |
| `wallet-fund.sh` | 6 | the funding MAY have been sent; running it again sends the same recorded bytes, never a second funding. Needs the line `wallet-fund: outcome maybe_sent` | may have been sent, run again is safe |
| `wallet-recover.sh` | 2 | as `wallet-fund.sh` exit 2, for the recovery close after D (a setting or a tool is wrong). Counts only while the output has no `wallet-recover: outcome` line | refused, nothing sent |
| `wallet-recover.sh` | 3 | refused: swap-cli refused or could not submit the close. Counts only while the output shows no `outcome sent`, `maybe_sent`, `done` or `hold` | refused, nothing sent |
| `wallet-recover.sh` | 4 | nothing sent by this run: the tool says to wait (before D, the instance is not at the contract) or that there is nothing to recover. Needs `wallet-recover: outcome hold` or `done` | nothing to send now (nothing sent) |
| `wallet-recover.sh` | 6 | the close MAY have been sent; running it again sends the same recorded bytes, never a second close. Needs `wallet-recover: outcome maybe_sent` | may have been sent, run again is safe |
| `wallet-sweep.sh` | 2 | a setting or a tool is wrong, before anything was built. Counts only while the output has no `wallet-sweep: outcome` line | refused, nothing sent |
| `wallet-sweep.sh` | 3 | refused: the payout addresses differ, or the tool refused ("lock still open", "instance not closed"), or live.js refused an Ethereum sweep before it broadcast anything. Counts only while the output shows no `outcome sent`, `maybe_sent`, `done` or `hold` and no result file was left | refused, nothing sent |
| `wallet-sweep.sh` | 4 | NOID sweep only: nothing sent by this run (the tool says to wait, or that the sweep is done). Needs `wallet-sweep: outcome hold` or `done` | nothing to send now (nothing sent) |
| `wallet-sweep.sh` | 6 | NOID sweep: may have been sent, running it again sends the same recorded bytes. Needs `wallet-sweep: outcome maybe_sent`; an Ethereum sweep that live.js broadcast and did not finish is exit 6 without that line, which counts as may have been sent | may have been sent, run again is safe (NOID only) |
| any of them | 0 | success | ok |
| any of them | anything else (1, an undocumented status, no status), a signal, a timeout, a launch error, an unreadable output, a result file of the send beside a refusal status | not documented as "nothing was sent" | **may have been sent** (latched) |

For `reveal.sh` the careful reading is stronger: every ending that is not a success or a clean refusal (an `unknown` or `delivered_rejected` outcome of the claim's time-bounded send, a timeout, a signal, an exit 1,
a status that is not in the table, an exit 0 with no readable result) says **the secret may be public** (red; audit result `SECRET MAY BE PUBLIC: …`): run a tick with `--apply` at once and let the engine judge.
The console never re-sends a reveal by itself: the first send stays latched, and the re-send is its own button with its own gate (the engine's held intent, a pending claim as evidence, a fresh dry run,
your typed amount). The helper's final texts for the new outcomes are not matched at all.

### The audit log

`<public copy dir>/ui-audit.jsonl`, opened with the append flag only, one JSON line per event: time (UTC), action, role, phase
(start / end / refused / note), result, hash of the dry run it was confirmed against, transaction hash, and `prev` (the SHA-256 of the
previous line). A line is written before an action starts; if it cannot be written, the action does not run. Refused spends and
settings writes are logged too; requests that fail the transport checks (no token, foreign origin) are not (a foreign page must not be
able to fill the log). The chain detects accidental edits and cuts in the middle; it has no key, so someone with write access to the
folder can rewrite it consistently.
The log is not where a funding is remembered: the markers are (`funded.marker`, the contract's marker, see Funding); an older acknowledgement that exists only as a log line still closes `send-fund`.

### The settings form

Strict patterns, no free text: role / profile (`sepolia` or `rehearsal`: test networks only, no `production`) / lock kind from short lists, amounts as decimals converted to integers and capped
(20 NOID, 0.01 ETH for both profiles until the external review), the four wallet addresses (bech32m checksum for `o1…`, `0x` + 40 hex),
the contract (`0x` + 40 hex), the run number fixed to this console's run, the variant (`raw` or `stock`; `stock` is refused with the `poseidon` lock kind) and the contract version (`1` or `2`); both are optional in a request (absent or empty means the helpers' default, `raw` and `1`) and **are written**, so that the saved file assigns each of the ten terms `scripts/live/join.sh` requires (`BOB_NOID`, `BOB_ETH`, `CONTRACT`, `AMOUNT`, `WEI`, `CHAIN`, `PROFILE`, `CONTRACT_VERSION`, `LOCK_KIND`, `VARIANT`). `CONTRACT_VERSION` is now a template key, so an older file that sets it no longer stops a replace. Every value is written single-quoted from a fixed template.
Optional fields, written only when filled in (empty = the helpers' default): `DEPLOY_BLOCK` (the helpers' default is an old deployment's block:
set it to this contract's), `HC_LEAD`, `BOB_KEY` / `ALICE_KEY` (`keys/NAME`, no path walking), the fee flags `GAS_PRICE_GWEI` (test chains) / `PRIORITY_FEE_GWEI` (needs the gas price, not above it; `MAX_FEE_GWEI`, the mainnet cap, is not a field any more), `LIVE_PLATFORM` (`wsl` / `native`),
(`NOID_CLI` and `OBJ` are NOT fields: `fund.sh` and `recover-noid.sh` execute `NOID_CLI`, so a form that could set it would make a token holder run any file; set them by hand in `env.local.sh`, and a file that has them is never replaced by the form). The form's role must be the console's `--role` (any role on a console started with `both`). It refuses once the run has swap files or ticks, never overwrites silently (the old file is kept
under a dated name), refuses to replace a file that sets variables it cannot write (second nodes `NOID_RPC2` / `ETH_RPC2`, another RPC: edit
by hand) and a file whose optional lines the submission leaves empty (the file is replaced, not merged: nothing vanishes silently), and
writes through a temp file and a rename. It does not echo the values back. `rehearsal` needs a local `ETH_RPC` the form cannot write: add it
by hand after the form.

### Threat model

Why it is off by default: the flag turns a read-only page into one that can spend the owner's ETH and publish the secret. The extra
exposure is exactly the six spending ids plus the setup writes above.

A malicious web page in the same browser **could not**: read `/api/*` (Host check against DNS rebinding, no CORS headers, `Sec-Fetch-Site`
and `Origin` refused when not same-origin, `frame-ancestors 'none'`); POST anything (no token: it lives only in the URL fragment of the
page the operator opened, never in a response; the Origin must equal the Host; a JSON content type is required, so a form post is
refused); name a command (ids only); fake the dry run or the tick (the server reads both itself); or spend without the typed text.

**What it could do if it got the token** (for example from a screen share of the printed URL, or a history entry made before the
fragment was removed): run any table action, and a spend only if every gate condition holds at that moment, including the engine's tick
naming the step, a dry run it has to run first and a typed amount it could read from the page. So the token is as sensitive as the swap
itself: do not paste the URL. Anything running as the same Windows user can read the swap files directly; this console does not defend
against that.

### Not covered

Exercised against a real WSL run folder (a copy of a finished run: ticks, check-object, the dry runs including `fund.sh --dry-run` with and without its markers,
the watch loop, the audit chain, the lock), never against a live swap: the spending flow past the dry run, a dry run that passes with real helper output for
lock, reveal, refund and claim, and `--replace` have only the tests (injected launcher, recorded shapes). The timeout kills `wsl.exe`, not necessarily the Windows `node.exe` it
started, so a timed-out spend must be treated as possibly sent. The form does not check EIP-55 capitalisation of Ethereum addresses. Without `--role` a role that is driven from another machine and also has a local file shows the stale view of that file (the `file-behind-chain` alarm says so
when the chain contradicts it). `send-fund` has been exercised only through its dry run against the real helper; the real funding path is the tests' fake (and `selftest.sh`'s stubs for `fund.sh`). A read-only tick button
overwrites the last tick with a version that withholds spend parameters: the next spend waits for the watch loop's next tick.
`ui/app/test/serve-fake.js [lock|reveal|claim|refund|fund|wait-created|held|near|missing] [port]` serves the page over a temporary folder with a fake launcher, to look at it;
it touches no WSL, wallet or chain (`fund`: Alice with the funding recorded; `wait-created`: the funding order before the engine offers anything; `held`: a held reveal;
`near`: the engine's "lock margin is short" note; `held-cutoff`, `aborted` (coins at the contract) and `refund-alarm` show the repairs of 2026-11-16; `missing`: no run folder yet). Open its URL without `#token=…` to see the lost-key banner.

The loop history (`lib/looptext.js`): the helper now cuts each part of a loop line on its own and always ends it with `applied: … phase_after: …`. A phase name is read from a
line only when it is a phase the console knows or the line is too short to have been cut at the old 1,200 characters; otherwise the line has no phase (it is listed
as "(line cut)") and takes no part in the phase changes, so "lock_final → re" cannot appear.

### Low findings of the review of the join screen, 2026-11-17 (written down, not fixed)

- Bob can start the watch loop, and later lock, without having compared the check line with Alice: the page asks in a sentence and does not hold the button. Since 2026-11-17 the line stays on his swap page until his lock is sent (phases `received`, `funded`, `funding_final`): a box above the lock's send box shows the line of the newest clean `join` record, or says where the line is when this console has no such record, and says not to lock if the digits differ or were not compared. It is still a sentence, not a hold: the lock's confirmation asks for no statement about it. On Alice's side the funding does ask for one (above).
- A drive path is given to the helper as `/mnt/<letter>/...`, which assumes the usual mount point inside WSL; with another mount point the helper finds no file and refuses.
- The page's drawing code has no test of its own with hostile text (a search of the source covers the sinks).

### Low findings of the review of the start screen, 2026-11-17 (written down, not fixed)

- The server sends the page only its last 8 job records (`lib/actions.js`), so a failed Prepare followed by 8 other jobs drops out of the page's view and the bundle file alone marks the step done again (with the words "no record that Prepare finished").
- After a failed object check the step's own line says the page has no record, while the job box below it shows the failed record.
- A funding made with the wallet before any tick, followed by a restart of the console, leaves nothing this screen can read: it then shows the sentence about an earlier funding and the watch-loop button, and the swap page appears at the first tick.
- A settings file replaced after Prepare is not noticed: the trade line still comes from the older bundle.

### Low findings of the review of 2026-11-16 (written down, not fixed)

An independent review of the repairs found two points that had to be fixed and were (the `fund.sh` exit 2 row above; a `--host` with an empty or missing value,
which was checked as the default address and then bound to every interface) and one small one that was fixed with them (a tick whose `notes` are not a list
now refuses every spend). Left open on purpose:

- **The production check fails open when it cannot tell.** `lib/production.js` treats an error and an unreadable `env.local.sh` as "not production", misses a
  chain id written as the text `"1"` or `"0x1"`, and does not count a bundle without a profile although the engine's default profile is production. A list of
  the allowed test chain ids (11155111, 31337) would fail closed. The helpers and the engine do not rely on this check.
- **The `env.local.sh` line reader is simple.** It misses `PROFILE=production; …`, `export PROFILE=production CHAIN=1`, `PROFILE=${PROFILE:-production}` and
  `declare PROFILE=production`. This matters only before a bundle exists, so for the setup actions.
- **`lib/swapform.js` accepts an inherited name as a profile** (`constructor` passes the check, skips the caps and writes `CHAIN='undefined'`); older than the repairs.
- **The exit 2 rows of `lock.sh`, `reveal.sh`, `refund-eth.sh` and `claim.sh` assume that `live.js` and `swap-cli` never exit 2.** True today (0, 1 or 3); no test pins it.
- **The old `/console` page keeps `#token=` in the address bar** (and so in the history); the operator page removes it.
- **The latch is rebuilt from the text of the audit log's end lines**, so whoever can write to the public-copy folder can release a latch.

### What the console still does not know (after the repairs of 2026-11-16)

- **No contract test against the real engine.** The tests use ticks shaped by hand from the engine's code and the note texts of `swap-cli/src` (`test/actions-fixtures.js` `spendTick` copies the held-intent texts); only the phrases of
  `lib/enginetext.js` are looked up in the engine's source. A field or a text that the engine renames is found by that test or not at all.
- **A held tick does not say its fresh decision in a field.** The console reads it from the note `held: fresh decision was KIND`; whether the reveal cutoff passed is only in the wait reason's words. A re-send has no fresh decision at all.
- **The recovery, `tick --closed-by` and `swap-cli intent --cancel` are terminal steps.** The page shows the commands for the recovery of an aborted file's instances; it cannot start them, and it cannot cancel a held intent.
- **Without a tick the console knows nothing about the contract.** Coins at the contract are what the last tick lists; a stale tick says so only through its age.
- **The production check by `env.local.sh` needs the actions mode** (the read-only console sees the bundle, the tick and the swap file's terms only).
- **The page's rendering is not unit tested** (`operator.js` and `actions.js` are DOM code); the repairs were looked at through `test/serve-fake.js` (`aborted`, `held-cutoff`, `refund-alarm`, `near`).

### Start a swap

In actions mode, while Alice is selected and nothing of her swap exists yet, the first screen is "Start a swap" instead of the empty swap page: the setup of the "Run controls" panel as one guided sequence, in the look of the other screens (the due strip first, then the steps, the terms, the file for Bob, "What happens if it stops here"). It adds **no action, no endpoint and no request**: its buttons are the table's own `install`, `setup`, `prepare` and `check-object`, and the settings form's own save (the strip's "Save the terms" runs the form's save handler; the form's own button is hidden while that is the step). A button is disabled for the same reason as today (`actionWhy` in `actions.js`, the one function `actionButton` uses too) and the reason is shown under it.

**When it shows** (`noSwapStarted` in `actions.js`, one function): actions mode, not a production run, the console drives Alice (`--role alice` or `both`), Alice is the selected tab, `roles.alice` is null (no tick, tick error or loop file of hers exists: as soon as a tick of hers exists the normal swap page shows), and no funding of the run is recorded (no marker, no acknowledgement). On a console for both roles a tick of Bob's also turns it off (the bundle was handed over). **Every folder the console reads must have been read without an error** (`payload.dirs[i].readable` and an empty `payload.errors`): a share that dropped must not look like "nothing yet", so the old page shows then. The one exception is the run folder that does not exist yet (the lazy lock says so): step 1. Before a bundle exists the alarm "No tick file yet" is not shown on this screen (the screen is that state); once a bundle exists it is shown, with every other alarm. The banners (lost key, run folder missing, no lock) and a running job always show.

**What marks a step done** (`startFacts` and `startSteps`, pure and tested in `test/start.test.js`): **The newest record of an action decides** (a clean setup followed by a failed or running one is not done). 1 install: a clean newest `install` record (state done, exit 0); 2 terms: `env.local.sh` exists (`form.env_local`); 3 set up: a clean newest `setup` record; 4 prepare: the bundle file exists and parsed (`bundle` and `bundle_file`) **and no `prepare` record is running or failed** (prepare.sh writes the bundle before the proof, Bob's file and the definition and can still fail after it; a running or failed prepare shows in the strip with its job box and never moves it on to step 5); 5 check: `funding.object_check_ok` (a clean `check-object` in this console's records whose output has the `object file OK` line); 6 give Bob the file: never done, the page cannot see it. A later fact shows that an earlier helper step ran (the bundle shows install, terms and setup, the object check shows all of them), and the row says "seen from ..."; the reverse never holds, and nothing is inferred from a bundle file of a running or failed prepare. With no run folder nothing counts as done. The records are this console's memory since it started: a step that is next and has no fact either way says "not known: the page has no record" (install with an existing folder, setup, the check), and the strip says that running it again is up to you (the helpers refuse what they must not repeat). The next step is the first one that is not done.

**Added to `/api/run`:** `bundle_file` = `{dir, name, path}` of the bundle file the bundle was read from (the newest of the folders, the same rule as `object_file`), or null; from `readRun`, a file name of the existing allowlist. The page uses it for "Send Bob the bundle file" (the path, with a copy button). Nothing else was added.

**Text that is not new:** the funding line reuses `NoidView.fundingGuide`'s title ("Funding comes later, on the swap page: fund from here, right after Bob's check"); Bob's part is the README's order (his `new-bob`, then the two `bundle check` lines compared) and "send it as a file, not as pasted text" is `prepare.sh`'s own sentence; the line "Your line, as Prepare printed it" is the `bundle check:` line of a clean `prepare` job in this console's records, unedited (without such a record the screen says where it is). The object file is made by the wallet, which the table has no action for: while none is visible the check step says what `prepare.sh` itself prints as its next step. Once step 5 is done the section "Send Bob the bundle file" also carries the table's own `watch-start` (the same button and reasons as in the panel, with the loop's state), because a funding made from a terminal or with the wallet leaves nothing this screen reads and the first tick is the only way off it; the block "What happens if it stops here" says what is known ("These steps lock nothing and send nothing to either chain") and, from step 5 on, that a funding already made cannot be seen until the first tick. The "bundle check:" line is shown only when it is Alice's own: the line that carries "bundle copied to" in the newest clean `prepare` record, never the first match. The technical panel stays at the bottom, folded in a `<details>` while this screen shows (its summary says whether the watch loop runs), without the settings form (that is step 2 here; the panel says so). The form is one element that moves between the screen and the panel.

Looked at through `serve-fake.js` (`missing`, `unreadable`, `start-prepare-running`, `start-install`, `start-terms`, `start-setup`, `start-prepare`, `start-check`, `start-send`; the earlier steps are run once through the console's own action route with the fake launcher). The rendering is DOM code and not unit tested.

### Join a swap

The first screen for Bob, the mirror of "Start a swap": in actions mode, while the console drives Bob (`--role bob`, or `both` with Bob selected) and nothing of his swap exists, the page shows six steps instead of the empty swap page. It adds **no endpoint and no request of its own**; its buttons are the table's `install`, `setup`, **`join`** and `watch-start`, the settings form's save, and a copy of the run folder's path. Nothing on it sends anything to a chain or touches a key.

**The table entry `join`** (`lib/actions.js`): group setup, role `bob` (a console started with `--role alice` answers 403 and the table marks it blocked), script `join.sh` from the frozen `bin/`, timeout 10 minutes. It goes through the same guards as `prepare`: the role check, the production refusal (403 and an audit line), the run folder's lock, one job at a time, the minimum gap, the audit start and end lines, and the output scrubbing. The page posts `{"id": "join"}` and nothing else; the route reads only the id.

**The argument rule.** The table's argument slot is `{BUNDLE?}`. `join.sh` takes `$L/alice.bundle.json` with no argument. When the run folder has **no file of that name** and the console's second folder (the public copy folder, `runDirs[1]`) has a good one, the server passes that file's path as the single argument. It is built on the server from its own configuration (`helperPathOf` in `lib/actions.js`): a `\\wsl.localhost\DISTRO\...` share of the console's own distro becomes the Linux path, a `C:\...` drive path becomes `/mnt/c/...` (only with a distro), a plain absolute path stays (a console without a distro, a Mac); anything else, a path with a space or a `..`, another distro's share, gets **no argument**. The caller can only switch it on (`bundleFromPublic`, set by `startAction` after it looked at the files); no value from a request is ever used. A bad file in the run folder (empty, a link, not JSON) is not papered over by the public one: no argument, and the helper refuses with its own words. The audit start line says "bundle from the public copy folder". For the sha256 lock kind the receipt is not passed: `alice.receipt` must be in the run folder (without it the helper exits 7 and says so).

**Added to the `actions` part of `/api/run`:** `join` = `{run_bundle, public_bundle, public_arg, receipt_in_run, bob_file, alice_file}`, from the server's own look at the folders (`ActionRunner.joinView`). A bundle fact is `{ok, size, mtime, problem}` for the exact name `alice.bundle.json`, by `lstat`: a plain file, not a link, not empty, at most 1 MB, a JSON object; the content never leaves. `readRun`'s `bundle_file` could not be used: it names the newest of both folders (and also `bundle.json`), so it can hide the run folder's own file.

**When it shows** (`noJoinStarted` in `actions.js`, built on the same `quietRun` as the start screen): actions mode and the server's `join` facts present; not a production run; the console drives Bob and Bob is selected; `roles.bob` is null (no tick, tick error, half-written tick or loop file of his); with both roles, no tick of Alice's either; no helper result file; no funding marker, acknowledgement or block; no `alice.swap.json` in the run folder; every folder read without an error (only the lazily missing run folder is excused); and **Bob's swap file is not there unless this console's own `join` made it** (the newest `join` record is clean or running). A swap file with no such record (one made in a terminal, by `prepare`, or before a restart of the console) turns the screen off, and the old page shows.

**What marks a step done** (`joinFacts` and `joinSteps`, pure, tested in `test/join.test.js`; the newest record of an action decides): 1 install: a clean newest `install` record; 2 terms: `env.local.sh` exists; 3 set up: a clean newest `setup` record; 4 Alice's file: an `alice.bundle.json` in the run folder that the server could read as above, or, with none there, one in the public copy folder whose path can be named to the helper (the line says which); 5 check: a clean newest `join` record **and** Bob's swap file on disk; a running or a failed newest `join` is never done, and the strip stays on this step with the job box and the helper's text; 6 watch loop: the table's loop started by this console is alive (`watch.started_here`). The check implies steps 1 to 4 ("seen from the check that passed"); nothing implies the check or the loop. With no record the line says "not known: the page has no record" (never a check mark). With all six done there is no next step.

**After a clean check** the page shows the `Your terms, as this machine will state them` block and the `bundle check: <16 hex> ok` line of the newest clean `join` record, as the helper printed them (the ten lines in the helper's order, else the block is not shown and the page says so; the check line only as a whole line of exactly that form and only when it is the only one). The two amounts also get a reading in coin colours beside the helper's figures (`5000000 micro-NOID` and `(5 NOID)`), and the big trade line shows the amounts of that block. With it: compare this line with the one Alice's side shows, over a second channel such as a call; if they differ, stop. "What happens if it stops here": the steps lock nothing and send nothing to either chain; nothing of Bob's is locked until he locks ETH, which the tool offers only after Alice's funding is final.

**Not on the screen, although the mock shows it:** choosing the file on a page (the page cannot read a file from the browser's side; Bob puts it in the folder), the three separate check sentences (the tool compares the contract byte for byte and prints one line), the four-word form of the check line, the timelines and "three ways this can end". Before a trade is typed, the big trade line shows the amounts typed in the form (never Alice's file: these are Bob's terms). The form's role select shows the screen's own role until it is changed by hand.

Looked at through `test/serve-fake.js` (`join-install`, `join-terms`, `join-setup`, `join-file`, `join-public`, `join-check`, `join-failed`, `join-done`; a console started with `--role bob`; the fake `join.sh` prints the helper's wording). The rendering is DOM code and not unit tested.

Low findings, written down and not fixed:

- A console that was restarted after a clean `join` has no record of it: Bob's swap file then turns the screen off and the old page shows "No tick file yet" until the watch loop's first tick (start the loop from the panel).
- The server sends the page only its last 8 job records: a clean `join` followed by 8 other jobs drops out of the page's view.
- The form asks for Alice's four addresses although `join.sh` uses only Bob's; Bob enters what Alice told him.
- On a console for both roles the watch loop the table starts ticks both roles; a Bob machine should be started with `--role bob` so the loop ticks his file only.
- The `bundle_file` fact (start screen) can still name a file in the public folder while the run folder's own is the one the helper uses; the join screen does not use it.

### Autopilot (2026-11-17)

**What it is.** In actions mode the swap page has one box, "Run this swap for me". After **one approval per swap and per role** the console server does the coin-moving steps of that role by itself, with no click per step: Alice's funding and reveal, Bob's lock, claim and ETH refund. It is not a second send path. It drives the same path a person drives: the table's dry run, then `startSpend`, whose gate (`lib/gate.js`) is unchanged. Every manual box stays, and a manual send and an automatic one meet the same busy flag, latch and `already_sent` checks, so they cannot double. **Test networks only, and not run live yet**: it is tested on the fake helpers (`test/autopilot*.test.js`), nothing has been sent through it. Like every action it is refused on a production run.

**The approval** (`POST /api/autopilot {"on": true, "role", "typed", "statements": {...}}`, same transport checks as the other action posts). Refused unless: actions mode; the role is this console's (`--role`); not production; the run lock is ours; the terms are readable; the typed amount is the role's own amount in the terms (`10 NOID` for Alice, `0.001 ETH` for Bob, compared as numbers); and every statement is the boolean `true`: `stay_on` (this computer stays on and awake until the swap is over), `no_manual_steps` (no step of this swap is sent by hand outside this console while it is on) and, for Alice, the two funding statements of the manual funding (`no_pending_funding`, `bob_check_matches`). For Alice the engine must also offer her funding at that moment, so she approves after Bob's check; **an Alice who funded by hand cannot turn the autopilot on for the reveal** (a limit of the design note, not lifted here). The server writes `autopilot-ROLE.json` in the run folder through a temporary file: `{v, role, terms_sha256, approved_at, statements, funding_statements_at, console_pid_start, needs_you}`.

**When an approval is in force.** Only while the file exists, names the role and its `terms_sha256` equals the hash of what the console reads **now** (recomputed on every use, from the same `readRun` snapshot `startSpend` evaluates): the contract root, both amounts, the chain, the HTLC contract, both ETH and both NOID addresses, the hashlock, `D`, `h_create`, the profile, contract version, lock kind and variant, `claim_authority`, the fee cap, the contract's code hash, the sha256 of the object file, `terms.consistent`, the sha256 of `env.local.sh` and one sha256 over the names and contents of everything in `$L/bin`. A change of any of them switches the autopilot off by itself and the page says so (`terms_changed`). The console reads `env.local.sh` and `bin/` for this hash only (nothing of them is shown). The approval survives a restart of the console (the reveal and the claim are time-critical); the funding statements do not (below). `{"on": false, "role"}` deletes the file; if the file cannot be deleted this process stops using it and says so.

**The funding statements** are single use and short: they count only for an automatic `send-fund` started within 300 s of the approval, by the console process that received them (a restart voids them); the first automatic funding start uses them up, and any stop on the funding voids them. Not used in time: `needs_you` for the funding ("confirm the two funding statements again"); a new `POST /api/autopilot` with fresh statements (allowed because the funding is on offer) answers it.

**The loop** (`lib/autopilot.js`, `step()`, a timer in `server.js` every 3 s that exists only in actions mode and skips while an action runs). One step, for each role with an approval in force:

1. No watch loop: when no loop file was updated for 180 s and this console knows of no loop it started that is still alive, it starts `watch-start`.
2. It takes the first step of the role the engine offers (the page's own `relevant`): fund, lock, reveal, claim, ETH refund, in that order.
3. `factsReady` (`lib/gate.js`: `evaluateSpend` without the typed text, setting aside every `dry_*` reason): any other reason is shown as what it waits for.
4. No usable stored dry run (under 90 s, single use, rows green against the tick current at send time): it starts the dry run. After a dry run that failed or had a red row the next one waits for a newer tick (one dry run per tick). A send refused only for the tick being written or stale is tried again with the same dry run.
5. It starts the spend through `startSpend(id, null, {auto})`. `meta.auto` is a private object of the autopilot module: a request body cannot carry it (`lib/actionroutes.js` never reads it, and a forged value is refused as `autopilot_off`). With an approval in force for the spend's role the typed text is the terms' amount text and the funding statements are the approval's; **every other check of the gate runs unchanged**. The audit start line says `auto=1; approval=<first 12 hex of terms_sha256>`.

**The stop rules.** A step that stops is written down as `needs_you` (in the approval file, and rebuilt from the audit log after a restart: a spend start with no end line, or an end line that is neither `ok` nor `refused, nothing sent`; a `cleared:` note forgets it) and is not touched again until the person clicks "I have dealt with it": a spend that did not end as a clean success (exit 0 **and** a result file **and** no warning; the funding also needs `Funding submitted` in `funded.marker`); an engine ALARM or ALERT at the step, an engine that says not to send a held step, or a held reveal whose cutoff has passed (reported once); a step latched by this console that is not the claim; a gate refusal three times in a row (the helper's clean refusals count; refusals for the tick or the dry run being old do not); a re-send (`--replace`) becoming relevant. A held step the engine does not offer is only waited for. **The claim** is retried on later ticks while the engine still names it and no close of ours is pending (a close is retry-safe), but the page alarm is up from the first failure.

**What it does not do** (a wallet run adds the recovery and the sweeps: see "The tool's own wallets"). No `--replace` (a stuck reveal or refund is the person's, it says so), no NOID recovery after `D` in a classic run (no console action exists there; a wallet run does it, see "The tool's own wallets"), no production, nothing outside the table's helpers. It does not keep the computer awake or start the console again: `stay_on` is a statement, and an Alice or a Bob that is down in a time-critical window loses what the swap's own rules say it loses.

**Added to `/api/run`:** `actions.autopilot` = `{alice, bob}`, each `{available, on, approved_at, terms_changed, doing, waiting_reason, needs_you: [{spend, label, reason, at, retrying?}], funding_statements_valid_until, expected_typed, statements: [{id, text}], funding_offered}` (read-only; the hash is not in it). `sentHashFor` now reads every helper error file (kept by path, time and size) instead of the newest eight, because the autopilot's dry runs leave one each and a real `sent:` line must not fall out of a window. Looked at through `test/serve-fake.js autopilot` (Bob, the box in its on state with a "Needs you" entry); the box is DOM code and its facts are tested without a DOM in `test/autopilot-page.test.js`.

### The tool's own wallets: a wallet run (swap wallet piece 2c, 2026-11-17)

**Not run against a real node or a public network.** Everything below is tested on fake helpers (`test/wallet-*.test.js`) and, for the shell layer, on stub tools (`scripts/live/selftest.sh` section 18). The pieces it rests on are `swap-cli`'s NOID swap wallet and Ethereum key (their READMEs) and `live.js`'s key commands (`eth/README.md`); none of them has been run on a public network either.

**Two kinds of run, fixed in `env.local.sh`.** `USE_SWAP_WALLET='1'` makes a **wallet run**; absent or `0` is a **classic run**, which behaves exactly as before (`fund.sh`, the object check, the "I have funded" box, key files). A run is one or the other: in a wallet run the classic `fund.sh`, `recover-noid.sh`, `check-object.sh`, the object check, the "I have funded" box (`POST /api/funded`: 409) refuse, and in a classic run every wallet action and spend refuses (409, an audit line `refused: run mode`). The console reads only three lines of the file (`USE_SWAP_WALLET`, `NOID_PAYOUT`, `ETH_PAYOUT`, `lib/walletrun.js`, a strict pattern like the production check); a line that mentions one of them in a way it cannot read (an indented assignment, a variable, a value that is not 0 or 1) makes the run **ambiguous**, and an ambiguous run refuses every wallet step, every funding, prepare, join, every dry run and the approval. The environment is ignored by the helpers for these three names. A wallet run is one role per machine (start the console with `--role alice` or `--role bob`).

**The settings form** has one tick, "Use the tool's own wallets" (on for a new run), and two fields, `NOID_PAYOUT` and `ETH_PAYOUT`: the user's own addresses what is left is swept to. They are required in a wallet run (the NOID one for Alice; optional for Bob) and refused in a classic one; a Parano1d address is checked by its bech32m checksum, an Ethereum address by its EIP-55 checksum when it is written in mixed case, and neither may be the contract or the counterparty's address. With the tick on, the addresses the tool makes (Alice's NOID wallet and Ethereum key, Bob's Ethereum key) are not asked and must be left empty; Bob's two addresses stay terms Alice states. Replacing a file never changes the mode silently.

**Setup** (`wallet-setup-alice`, `wallet-setup-bob`: `wallet-setup.sh ROLE`, nothing sent): makes the NOID wallet (`swap-cli wallet new`) and the Ethereum key (`live.js keygen --stdout | swap-cli ethkey new`), checks the key against its address (`swap-cli ethkey emit | live.js address --key-stdin --expect`), and only then writes `wallet-addresses.txt` (the swap's own addresses; `env.sh` reads them as `ALICE_NOID`, `ALICE_ETH` or `BOB_ETH`). `prepare.sh` / `join.sh` then build the swap file with them and delete the two standalone sealed files once the file shows the wallet, the key and both payouts. The order on the screens: install, terms, set up, make the wallets, prepare (Alice) / put Alice's file, check it (Bob).

**Deposits** (rule 3). `ActionRunner.walletPoll()` (called by the server's 3 s timer) starts the read-only `wallet-status-ROLE` (`wallet-status.sh ROLE`) for each role this console drives whose swap file exists, at most every 40 s per role (the table's own minimum gap is 30 s), never while another action runs, and not any more once the funding (Alice: `wallet-funded.marker`) or the lock (Bob: a phase after `funding_final`) is on its way. The helper prints validated `key=value` lines (the NOID balance of the swap wallet, and `live.js reserve` with the swap key piped from `swap-cli ethkey emit`, which recomputes the Ethereum address from the key and refuses before it prints any amount unless the key owns the address). The console keeps the newest result of each role in memory (a restart forgets it, and the gate then refuses until a new one is read) and shows a deposit address **only** from a status that ended with `wallet-status: done`, said `key_checked=true`, and is about this swap's own addresses (`terms.alice_noid`, `alice_receiver`, `bob_sender`). The box shows the address with a copy button, the exact amount (Alice: the swap's amount plus the funding's fee reserve in NOID, and the reveal's fee reserve in ETH; Bob: the amount plus the lock's and the refund's fee reserve in ETH), "seen" or "not yet", how old the reading is, and the warning that an exchange withdrawal may arrive later than the swap's window. It is drawn on the Start screen after Prepare, on the Join screen after the check, and on the swap page while the step it pays for is not sent. `actions.wallet` in `/api/run` carries the mode, the two payout addresses of the settings, the file facts, the markers and, per role, the status facts; never a key.

**The funding gate** (amendment C). Both the manual Send and the autopilot refuse the NOID funding unless the newest status of Alice's key is covered and younger than 120 s and the NOID wallet covers the amount and its fee; Bob's lock refuses unless his status is covered. New reasons: `reserve_missing` (no clean status of this run, one about other addresses, or one that did not check the key), `reserve_stale` (older than 120 s), `reserve_short` (the Ethereum reserve is not covered), `deposit_short` (the NOID deposit does not cover the amount and fee; for Bob, the key does not even hold the amount). The helper `wallet-fund.sh` checks the reveal's reserve itself too, right before it builds anything.

**Funding** (rule 5). In a wallet run `dry-fund` / `send-fund` run `wallet-fund.sh --dry-run` / `wallet-fund.sh` (the same ids and the same spend). The dry-run rows: the target is the terms' contract root, the amount is the terms' amount and the engine's intent, the wallet's address is the terms' Alice address, the reveal's reserve is covered for `alice_receiver`, and every line appears exactly once. **A deviation from the specification, on purpose:** the classic statement "no funding of this contract is pending elsewhere" is not asked (the wallet holds one funding and the tool refuses a funding submitted by another path), but **Bob's check line statement is still asked** (the specification says the two funding statements are not asked; dropping the second one would weaken an existing check, so it stays, as a durable part of the approval and one tick in the manual dialog). An unknown outcome is no longer a stop for the funding: `wallet-fund.sh` exit 6 ("may have been sent, the same command sends the same recorded bytes") keeps the tick latch and drops the intent latch, so the autopilot runs it again on a later tick, never twice on one tick; the audit end line reads `may have been sent, the same bytes may be sent again` and is not a stop after a restart either. Any other unclear ending is a stop as before. `wallet-funded.marker` (written by the helper when it sent, or found the funding at the contract) closes the funding button.

**Lock, reveal, ETH refund** (rule 6): the same table entries and helpers; inside each helper `USE_SWAP_WALLET` selects the key path (`swap-cli ethkey emit FILE | live.js ... --key-stdin`; for the reveal the secret follows on a second line), never a key file, an argument or a temporary file. A key that cannot be emitted is that helper's exit 2 ("nothing sent").

**Recovery** (rule 7). `send-recover` (dry run `dry-recover`): offered when the engine's action is `refund_noid` (a ledger intent, like the others); `wallet-recover.sh` closes the swap's own instance to the swap wallet. Rows: the close pays the terms' Alice address, amount plus fee is the swap amount, the fee is within the cap (exactly `max_fee` for contract version 2), the height is at or after D. **A deviation:** the recording of the close in the swap file (`tick --closed-by TXID --apply`) cannot succeed right after the send (the tool takes a close only once it is confirmed and the instance is gone), so the helper reports its attempt and the table has a second action, `wallet-record-close` (`wallet-recover.sh --record`, sends nothing), which the autopilot starts about once a minute while a recovery txid is on file and the file is not ended, and which has a button in the panel.

**Sweeps** (rule 8). `send-sweep-noid` (`wallet-sweep.sh noid`), `send-sweep-eth-alice` and `send-sweep-eth-bob` (`wallet-sweep.sh eth ROLE`; **a deviation: one id per role instead of one `send-sweep-eth`**, because a spend belongs to one role), each with its dry run. Offered only when the role's file is in an ended phase (`refunded`, `lost`, `aborted`, `done`) with no engine step on offer (a `done` whose action still names a leftover leg is not over). The NOID sweep's rows compare the target with `NOID_PAYOUT` of the settings and with the payout the swap file seals (the helper prints both, and refuses unless they are equal); the Ethereum sweep's rows compare the sender with the swap's own key, the target with `ETH_PAYOUT`, and show the payout live.js read (live.js refuses unless it is the one sealed in the swap file). The typed confirmation of a sweep is the swap's amount (the leftover is not known in advance). `wallet-swept-noid.marker` / `wallet-swept-eth-ROLE.marker` close each sweep.

**The autopilot in a wallet run.** The same loop, with the same dry run, gate, latch and audit line; the order Alice: fund, reveal, recover, sweep NOID, sweep ETH; Bob: lock, claim, refund, sweep ETH. Alice's statements are `stay_on`, `no_manual_steps` and `bob_check_matches` (no 300 s funding window, no funding statement); she may approve before the engine offers the funding (the gate waits for the deposit and for Bob). Both payout addresses must be set to approve, and the approval hash also covers `USE_SWAP_WALLET` and the two payout addresses (a classic run's hash is unchanged). A helper that says "nothing to send now" (exit 4: the deposit is too young, before D, already done) is asked again only for a newer tick and is not a refusal that counts; a sweep the tool refuses ("lock still open", "instance not closed") is a wait, tried again after 5 minutes, and so is a sweep whose dry run fails for any other reason, so the other sweep is never held back behind it (rehearsal 4.10 found Alice's ETH sweep waiting forever behind an empty NOID wallet: R410-1, fixed). **An empty swap wallet is an end, not a wait (R410-7, R410-4, fixed 2026-11-19):** the funding spends the wallet's one coin with no change, so every swap that went through leaves the NOID sweep with nothing to send, and the tool refuses its dry run (exit 3) with "the wallet holds no plain coin worth more than the fee of spending it". The console matches that TEXT (`isNothingToSweep` in `lib/gate.js`; exit 3 alone also means "lock still open", "instance not closed", which keep the 5-minute wait) and marks the job `nothing_left`; the audit line reads `nothing to sweep (exit 3)` instead of `failed (exit 3)`. The autopilot then stops trying that sweep (in memory, per run folder: a restart tries it once more), the page shows the plain line "Nothing is left in the swap wallet to send back." (the view's `finished_notes`) and no waiting text, and once the file is over and every sweep is done or "nothing left" the swap reads "This swap is finished" and the autopilot starts no more watch loops for that role (before, it restarted one about every 3 minutes for a tick nobody needed). A wallet status read AFTER the refusal that is clean and shows a plain coin brings the sweep back (its dry run then decides); the status is read only while a deposit matters, so in practice this is a manual refresh. The manual "Do it from here" sweep is unchanged. Tests: `test/wallet-autopilot.test.js` (the four "rule 8, an empty NOID wallet" tests), `test/autopilot-page.test.js`. An Ethereum sweep that live.js broadcast and did not finish is a stop (not repeated). A classic run's autopilot is unchanged.

**Not built (rule 11).** There is no button that exports a key: a key must never reach the page. **Back up this swap's keys** in a terminal: the swap file (`alice.swap.json`, `bob/bob.swap.json`) holds them sealed, so copy it; to read them out, `swap-cli wallet export FILE --i-understand-this-is-the-key` prints the NOID wallet's master secret and the contract opening once (import the secret into a fresh stock-wallet data folder), and `swap-cli ethkey emit FILE` writes the Ethereum key to a pipe only. Never paste either into a page, a chat or a log.

**Low findings, written down and not fixed.**
- A funding that was sent, whose transaction never lands, is not offered again by the console (the marker closes the funding); it is finished in a terminal with `wallet-fund.sh`, which sends or rebuilds by the tool's own rules.
- The deposit status is read about every 40 s while it matters; between two readings a deposit that was spent elsewhere still shows as seen (the helper's own reserve check right before a funding, and the 120 s rule, bound the window).
- The status helper's raw output (`wallet-status-ROLE.*`) stays in the run folder.
- "Nothing left" for the NOID sweep is judged from the tool's refusal text only and kept in memory; a coin under the sweep's fee that a newer status shows is tried once (the dry run is refused and the sweep is marked again). A classic (non-wallet) run still gets a watch loop restarted after its swap ended; only a wallet run reads as finished.
- The Ethereum sweep's classification of "refused before it broadcast" rests on live.js printing no `sent:` line; a response lost after a broadcast would be reported as a refusal (the next sweep then finds a pending transaction and refuses).
- The Start screen asks for no approval: the approval box is on the swap page, which appears at the tool's first tick (the watch loop makes it).
- `dry-fund`'s dry run in a wallet run is not bound to a copy of an object file (there is none): it is bound to the helper's own lines and the terms.

### The look of the operator page (2026-11-17)

`operator.css` carries the design tokens on `:root` (dark only; the page no longer links `/tokens.css`, which stays for the chain console) and one token of its own, `--alarm`, used only for the engine's loud notes, the alarms section and the lost / danger states. The two typefaces (Space Grotesk, JetBrains Mono) are files of this server: `ui/app/fonts/` (sources, commits, hashes and licences in its `README.md`), served at `/fonts/…` and loaded by `@font-face`; no external link. The mark in the header and the tab icon is `ui/app/mark.svg` (the small version of the logo: the two locks as two arcs, the shared secret as a diamond), served at `/mark.svg`; the name is written with that diamond between its two words.

- **Order, one column:** top bar (wordmark, which swap, role switch, Refresh), alarms, the due strip (`#next-action`, always first, a 6 px edge on its left), the step row (`view.timeline.main` as one horizontal row, the recovery path as a second, quieter row; a vertical list under 820 px), deadlines, "If the swap stops now", receipts, the run controls of the actions mode, then three folded blocks (the plain-words explainer, the loop history, "What this page read").
- **The strip:** the engine's loud notes run across its top, then the title (its chip is the state word, read first), the engine's reason verbatim and the notes; the buttons of the actions mode sit beside them. The parameters table, the terminal commands and the dry-run rows are folded under one "Details" while the console has a button for the step; with no button (no actions mode) they stay open. A "Details" block that was opened stays open when the page is redrawn.
- **Colour meaning:** amber only on the strip when it carries the class `act` (the same condition as before), on the step row's current step while it does, and on the primary button of that step and of its confirmation dialog; mint for done and passed; NOID and ETH amounts and names in their coin's colour (the page's own sentences only, never the engine's words); `--alarm` for danger. The level the view model gives a state decides its colour, the page does not re-rank it: a stale tick at the level `attn` is a strong hairline edge and its plain words, and the danger-level cases (a tick so old or unreadable that the page is blind, the status chip "Stale: loop stopped?") are drawn in `--alarm`.
- **The clock** (inside the strip, only while it carries the class `act`): a big mono figure with its marks. `view.clock` (`lib/viewmodel.js` `clockFor`) reads the finished deadline rows and the kind of the step the strip offers (a spend, or a held step the tick still offers) and nothing else. A reveal is clocked to the row `reveal_start_by`, "Last moment to start the reveal": the reveal helper (`eth/scripts/live.js`) refuses a first reveal when now + S is past its cutoff, so the row is min(the engine's frozen cutoff, T_reveal − 30 min) − 30 s, counted against the later of this machine's clock and the chain's clock. The two numbers are named constants in `viewmodel.js` (`SENDER_MARGIN_S`, `SENDER_SEND_BUDGET_S`) and `test/picture.test.js` reads the helper's source and fails when they change there. The row exists only when the reveal intent froze a cutoff and T_reveal is known; the engine's cutoff and the re-send cutoff stay in Deadlines, never on the clock. The figure is `mm:ss` (`h:mm:ss` above an hour) with one amber mark per minute (at most 60, "more than an hour" beside them; spent marks only where the row's own window is known). A claim is clocked to `claim_target`, a height row, so the figure is the number of blocks left ("283 blocks"), with "about 2 h 21 min at 30 s a block; blocks can come faster" under it and one mark per block (at most 60, "more than 60 blocks"). No clock on a stale row, a row without a countdown, or one that is met, not relevant, unknown or info. A passed row gives `over`: `0:00` (`0 blocks`), no marks left and the sentence "Too late to start the reveal: the helper refuses it." (for the claim target: a claim sent now is still valid until D − 1, but a rollback could undo it). It says "the same number as …" because it is that row.
- **The two locks, from now** (a section under the step row): both locks on one axis that starts at now and runs to the farthest mark, linear, no axis break, relative ticks only (at most 12; no clock time, no timezone). `view.picture` (`pictureFor`) takes the rows `reveal_start_by` ("Start the reveal by"), `t_reveal`, `reveal_cutoff`, `reveal_resend_cutoff`, `claim_target` and `d` that are far or closing with a positive countdown; a mark that comes from the profile table is drawn dashed and called "expected". The Parano1d track ends at `d`, the Ethereum track at `t_reveal`. A track's state comes from the engine's phase id (the table `TRACK_STATE`, for both roles); a phase that is not in the table (unknown, a recovery phase, lost, aborted) has no picture, and neither has a span above seven days. States: none (dashed outline, "not locked yet"), sent (dashed outline, "sent, not confirmed yet"), pending (dotted 1.5 px), final (solid 3 px), secret_public (no line: "the secret is public: this lock can be claimed at any moment"), closing ("being closed, not final yet") and closed ("closed"); for the last three the track's end mark (`d` or `t_reveal`) is not drawn and no end is claimed (the row stays in Deadlines). Once the Ethereum track is in one of those three states, the two deadlines of a first reveal (`reveal_start_by`, `reveal_cutoff`) are not drawn either: the secret is already public; the re-send cutoff still is. The amber band (now to the clock's row) is drawn only while the strip is "your move". A stale tick draws the picture without the band and with "from an old tick". Under 720 px (900 px for the main view's copy, below) the SVG and its legend are replaced by a list in time order with the two lock lines running down beside it; the SVG has `role="img"` and a label that says the same in a sentence. Both are redrawn every second from the same rows as the Deadlines list. Since 2026-11-20 the labels are placed by `placeMarks` of the view model (see "The new look" below): no two label boxes overlap and no leader line runs through one, and a track's second label goes to the other side of its line.
- **Tidy (2026-11-17):** an engine alarm is shown at most twice: as a loud note across the top of the strip and beside the send button (the strip's notes list and the alarms section leave out a text that the loud-notes box shows whole, only when it is exactly equal); the page's own labels are sentence case and use commas or brackets, not capitals and middle dots (the engine's words are unchanged; the contract-instance receipt line and the fee-check labels still carry middle dots, they come from `lib/viewmodel.js`); the funding acknowledgement dialog has a neutral primary button (`dialog.confirm.neutral`), amber stays for a step's send and its confirmation; the clock box is a `role="timer"` with `aria-live="off"` and a label in words that changes at most once a minute (the figure and the marks are not announced).
- **Not in this batch:** the demo bar and the run-controls panel keep their old structure (restyled only). The two new drawings (`fillClock`, `renderPicture` in `operator.js`) are DOM code and are looked at through `test/serve-fake.js` (`reveal`, `claim`, `lock`, `aborted`); their view-model fields are tested in `test/picture.test.js`.

**The new look (program mode, 2026-11-20).** The page was redrawn in thirteen steps, each one commit and one set of tests (`test/look-*.test.js`): classes and CSS first, then the few data fields the drawing needed. It added no served file, no dependency and no change to the content policy, and it moved no id; every safety text is where it was. The terminal console (`node ui/app/server.js --allow-actions`) keeps its own layout: every rule of the Details tables and of the forms is scoped to program mode (`.pg-details-body`, `.pg-form`), and a test reads the stylesheet to check it.

- **Tokens and base (step 1).** Three surface steps (`--bg` `#050908`, `--panel`, `--raise`), two hairlines for parting (`--rule`, `--rule-2`) and `--edge` for the edge of a control (3:1 on its ground), three tint pairs (amber for "the swap waits on you", mint for "checked or done", the alarm colour for danger), the two coin colours, one focus ring, the motion tokens, and one reduced-motion rule. A chip is a dot and words, never a pill; a tag is a mode in a hairline box. Amber is used only where the swap waits on the person or a clock runs against them; mint only for what was checked or is done; coin colours only where the coin is data (a coin name in a headline keeps the headline's colour).
- **Icons (step 2, `actions.js`).** One frozen table of seventeen icons on a 16 px grid and the two coin glyphs, built with `createElementNS` (no text node, `aria-hidden`), handed to the other scripts as `H.icon(name)` and `H.coinGlyph("noid" | "eth")`.
- **Top bar and list (steps 3 and 4).** A 56 px sticky bar; the list rows draw the pair (glyph, figure, arrow, glyph, figure) from the summary's `give` and `get`, with the label kept as words for a screen reader; an "Ended" divider; an empty state; skeleton rows while the list loads.
- **The stage card's frame, the tones (step 5).** `plan()` chooses one tone for the frame: `act` (a 3 px amber edge and an amber "now" node while the swap waits on the person: an action of the card, the approval, the deposit, or a step that needs an answer), `done` (mint, a tick before the headline), `look` (the alarm colour, no stage marked) and none for a calm stage. The progress line is six nodes on a rail; the foot line says what the program is doing and how old its reading is ("Chains read 4 s ago", one figure from the view model, redrawn each second). Safety boxes have an icon and four looks: danger, needs, warn, info.
- **The card's boxes (step 6).** The hand-over, the invitation and the check line are numbered parts with file rows; the check line is four cells to read aloud; the approval is a caption row, the convert blocks, a facts list (fees, where the coins go, what happens if the swap stops), three short lines, the statements and the typed amount beside its button; the deposit is a block of three lines for each coin with copy icons and a clock.
- **The ticket (step 7).** `#pg-ticket`, outside the card and outside the fold: the two legs of the swap, what you give and what you get, each with the amount, the state of its lock in words and as a line (3 px solid in the coin's colour once final, dotted while pending, dashed while only sent or not locked, mint once closed), where your coins go, the check line once the two sides compared it, and one line of trust. The states come from `legsFor(view, role)` in the view model, which reads the same track table as the picture (`TRACK_STATE`), never the page's own reasoning; a phase it does not know, or a card that says "needs a look", gives "Not known" for both legs and never a locked state. When the swap is done it is "Receipts": the transaction ids, shortened, each with a copy button.
- **The two locks on the main view (step 8).** `#pg-picture` under the card: drawn at the Swap stage only, and only once a lock is seen on either chain (a track in a state other than "not locked yet"), or while an approval that lapsed in flight is asked for again (the progress line stays on Swap); before that the picture is under Details only. The card's `plan().picture` says so (`{ act }` or null). One drawing serves both copies (`drawPicture` in `operator.js`); the main view's copy uses plain words by role ("Reveal by", "Bob's refund opens", "Your NOID can come back", "Collect the NOID by", "Alice's refund opens"), leaves out the two cutoffs of the reveal while the reveal's own "start by" is drawn (they stay in Details and in Deadlines), and its heading is `pg-h-picture`: it shares no id with the Details copy (`h-picture`). Each mark names its chain (`chain` on the view model's marks). Labels are two lines (what happens, and when), above the Parano1d line or below the Ethereum line; `placeMarks` (view model, positions only) picks the cheapest arrangement with no overlap: the outer side starting at the mark, the outer side ending at it, the same two between the tracks, then a further row with a leader line that may not run through a nearer box; if nothing fits within its budget it falls back to one row each (boxes still never overlap) and says `clean: false`. The amber band (26 %) runs on the track of the step that is due, from now to its deadline, with the line on top and the due label in amber; it is drawn only while the card is amber. Under 900 px the drawing is the list with a rail for each live track, each rail ending at its own mark.
- **Details as hairline tables (step 9).** Section headings of 13.5 px with one strong hairline and a hint at the right, the swap's facts as a strip, the engine's words in a mono block, deadlines as a table (name, place and plain words, countdown), the two ends of the swap as a table, receipts with copy icons, a chevron and a hint on the Details row (the hint is CSS: the summary stays exactly "Details"). The advice "Back up the whole run folder … The swap file alone is not enough." is the first line of Details, not a line above the card, and the swap bar has no role chip (the title already says what is sold).
- **New swap and settings (step 10, `program.js`).** The side comes first, on its own; the two amounts are the two blocks of a convert (the label says "You give" or "You get" by the side and the block of the coin given is on the left; the coin's glyph, its ticker and its chain are beside the figure); Bob's addresses are a section of their own for Alice only, and Bob's own Parano1d address moves into "Your own addresses" with the side; the invitation is a box that turns mint once a file is read; the form ends with the one bright button and the sentence of what it does. The settings are sections with a title and one line on the left and the fields on the right (no fieldset), with the same end row. The ids, the labels (one for each input), the hints, the posts and the prefill rules did not change.
- **Toasts (step 11).** `H.toast(text)` puts a paragraph with a tick into the polite live region `#toasts` for 2.4 s: "Amount copied: 5.009", "Address copied" or "Copied" after a copy (the button's own "copied" flash stays), "Saved a copy for Bob" or "Saved the invitation", "Settings saved". At most three at a time; never a warning (a warning is a safety box) and never anything but the figure already on the page.
- **The desktop windows (step 12)** are painted with the same dark ground from the first frame and the secret window's sheet is dark only: see `desktop/README.md`.

What was not matched to the mocks: the picture's labels use the view model's rows, so the wall-clock times of the mocks ("about 15:12" beside "in 52 min") are in the card's status line and the ticket's notes, not in the drawing; the group lines of the settings are the words the form already had (split from the old legends and hints) except "The program never installs anything by itself.", which is new and true (the update check only notifies); the form's hints stay inside each convert block; the page was checked in headless Edge at 1280, 920 and 380 px and in no real window yet.

### Low findings of the review of the autopilot, 2026-11-17 (written down, not fixed)

An independent read of the code found no way to send without an approval in force, to send a step twice for one intent, or to send what the manual path would refuse. Left as they are:
- The helpers' hash covers `<run folder>/bin`; with `--helpers-dir` the helpers that really run are not covered.
- After a console crash in the middle of a claim, the rebuilt stop for `send-claim` is not retried by itself: Bob's claim waits for a click.
- The "three refusals in a row" counter is reset only by a clean end, a stop or a clear, so refusals hours apart can add up.
- A funding stop rebuilt from the audit log while the autopilot is being turned on does not void the fresh funding statements.
- Without the run lock every step adds audit lines "refused: run lock not ours", and turning the autopilot off is refused too.
- After a terminal phase the watch loop is started again about every 180 s while the approval file exists.
- A console on both roles always steps Alice first.
- Not pinned by a test: a foreign or corrupt approval file counting as off, `clear_needs_you` not re-arming the funding statements, the statements being used up when the start fails after the gate, an approval file that cannot be removed.

### Low findings of the review of the wallet runs, 2026-11-17 (written down, not fixed)

An independent read found that every send of a wallet run still goes through the same start, dry run, gate, latch and audit line, that the deposit address shown comes only from a result that proved the key owns it, and that classic runs keep their checks. One must-fix point was fixed: a recovery close that had to be built again left the older txid on file, so the close was never recorded and nothing was swept; the newest txid now replaces it. Left as they are:
- An Ethereum sweep whose answer is lost after the node took the bytes is read as "refused, nothing sent"; the target is the sealed payout and a second run is refused while the transaction is pending.
- A funding record deleted or left behind when the swap file is moved, while a funding is pending, allows a fresh funding on other coins if the deposit came in several coins.
- The 120 s age of a deposit status is counted from the end of the helper, not from its read of the chain.
- The standalone key files are deleted after a check of the sealed addresses only, not after a test that the sealed copies open; a bad seal costs a new setup, since nothing can be deposited before the status opens them.
- The Ethereum sweep's dry-run row compares the target with itself; the check against the sealed payout is the helper's and the tool's.
- The reserve is read again before a re-send of the same funding bytes, so a failed read delays it.
- The deposit poll can hold the one action slot for up to three minutes, which can delay a step.
- The NOID amount shown assumes one coin; a deposit in several coins can be short of the fee while the page says seen.
- Not known from reading: how a wallet run's terms are read without an object file on a real run, whether a tick shows the wallet's own pending recovery, and the pipe from the key into the Windows Node through WSL. Not run against a real node or a public network.

### Board (offer board and automatic handover, piece 3, step P3.6, 2026-11-17)

**Not run against a real relay, a node or a public network.** Everything below is tested offline: the board's core (`lib/board/note|nip44|giftwrap|pow|relay|offer|privboard|handover.js`, `test/board-*.test.js`) against an in-process fake relay that drops, delays, repeats, reorders and replaces notes; the host, the gate and the approval (`test/board-host.test.js`, `test/board-gate.test.js`, `test/board-e2e.test.js`, `test/board-server.test.js`) against fake helpers; the four new helpers (`scripts/live/board-sign.sh`, `board-verify.sh`, `board-balance.sh`, `board-digest.sh`) against stub tools (`scripts/live/selftest.sh` section 19). The screens (offers, take and deposit and approval, progress, done and refunded) are described in "The board's screens" below (step P3.7).

**What it does.** With `--board` (and `--allow-actions`, `--role alice|bob`, `--board-config FILE`: relays, the pinned HTLC contract per chain, your own addresses, optionally an invite secret and the Parano1d node's address for the tip) the console (which then needs Node 22 or newer: the relay client uses the built-in WebSocket) carries ONE swap through the open relays: an offer (`POST /api/board {"op":"post","noid_micro","wei"}`; the side follows from the role) or a take (`{"op":"take","offer_id"}`), then Bob's wallet and signed addresses, Alice's wallet and `prepare.sh`, the bundle, Bob's `join.sh` against his own terms, both deposits, Bob's signed `checked` answer, and Alice's funding through the console's own gate. The run folder must be fresh (no swap files, no `env.local.sh`); the board writes `env.local.sh` itself (`HANDOVER='board'`, a wallet run) and keeps `handover-ROLE.json` and `board-keys.json` beside it. The config file is one JSON object: `relays` (two to five `wss://` URLs), `pinned_htlc` (`{"11155111": "0x…"}`), `eth_payout`, `noid_payout` (Alice) or `bob_noid` (Bob), and optionally `profile`, `lead_blocks` (default 60: the deposit window), `fund_k`, `reserve_wei`, `invite_secret` (64 hex; without one the board is public and `allow_public` must be set), `noid_rpc` (an `http://` address on this machine, read for the tip). A board run is a wallet run, test profiles only, never production (`--board` is refused on a production run), and `lock` is `poseidon`, the variant `raw`, the contract the app's own pinned one, within the profile's caps (`lib/board/offer.js`).

**What a relay can do and what a message can do.** A relay can drop, delay, repeat, reorder or re-serve genuine notes and see who connects and when; it cannot forge a note or read a message. A message is data, never an instruction: it can set no term, no amount, no path and no flag, and it sends nothing. What a message can change is exactly this: the two values `BOB_NOID` and `BOB_ETH` that go into Alice's `env.local.sh` (each checked first by the machine with the terms form's own patterns, then by `validateForm` through the form's own writer: a quote, a newline, `$(...)`, padding, an address equal to Alice's payout, the contract or her own address is rejected, never cleaned, and nothing is written), the bundle Bob's own `new-bob` checks against his own terms, the signed `checked` answer Alice's gate reads as a fact, and the end of the BOARD side of a swap before any funding. Every message of Bob that carries a signature (`bob_addresses`, `checked`) is verified by `board-verify.sh` (`live.js verify-message`) over the exact text the machine expects, by the key that will lock (`bob_sender`); a helper that does not say `valid true` over that text's own sha256 is a refusal. Bob signs through `board-sign.sh`, which builds the text itself from files of the run folder, signs it with `swap-cli ethkey emit | live.js sign-message --key-stdin` and prints the text's sha256, which the console compares with the text it asked for.

**The gate in a board run (P3.6).** The funding (manual and automatic) is refused unless the host's facts say all of this (reason codes in brackets): Bob's signed `checked` answer was verified against `bob_sender` and comes from this swap's counterparty (`handover_check_missing`, `handover_check_sender`); its digest equals the digest `swap-cli bundle` prints for `alice.swap.json`, read again less than 120 s ago and not older than the last change of a terms file (`handover_digest_missing`, `handover_digest_stale`, `handover_digest_mismatch`); and the bundle files the console reads as terms are, byte for byte, that bundle, the console reading `alice.bundle.json` and no other file (`handover_terms_file_mismatch`; `board-digest.sh` compares with `cmp`, the console never re-implements the canonical JSON); a fresh read that `bob_sender` holds the ETH amount plus a reserve (`counterparty_deposit_missing|stale|address|short`; **a screen, not a guarantee**: the balance can be moved away afterwards and one balance can back many takes; the reserve is a fixed `reserve_wei`, default 0.002 ETH, not Bob's live fee reserve); and the tip is at most `fund_k` (default 30) blocks past `h_create` (`handover_funding_late`, `handover_tip_unknown`; amendment E: no "prepare again", a missed height means nobody funds, both engines end their files by themselves and the existing sweep rules return the deposits). The human tick "Bob's check line matches mine" is neither asked nor accepted in a board run (the approval's statements are `stay_on` and `no_manual_steps`); in a classic run and in a wallet run that is not a board run it stays required exactly as before. A run folder with a handover file is a board run even when the `HANDOVER` line was removed, and a `HANDOVER` line the console cannot read refuses what puts coins in. The approval hash also covers `HANDOVER`, the offer note id and the counterparty's messaging key (no board identity, nothing can be approved). Bob's message 6 is sent only once his deposit is covered, fresh and for his own address, and his approval is in force.

**Stops (amendment F).** A `cancel`, a refusal or a missed time limit stops the board for that swap and, for the two steps that put coins in and have not started (the funding and the lock), refuses them (`board_stopped`). It never stops the watch loop, the autopilot's recovery or the sweeps, never removes an approval file, never marks a file ended, and the machine's stop result says so (`keepWatching`, `keepRecovery`). "Nothing funded" is: no funding start line in the audit log, no `wallet-funded.marker` or recorded funding transaction of the wallet, and (from the tick) a file still at `created` / `received`; it is read afresh before anything that can stop the board, and once the machine has been told something may be funded it never takes that back.

**Host-only table entries.** `board-sign-*`, `board-verify-*`, `board-balance`, `board-digest-*` and `board-join` are started only by the host with its private token; a request that names one is refused (403), none is listed on the page, and in a board run a click on `prepare`, `join` or the wallet setups is refused (409) because the board runs them in its own order. `board-join` hands `join.sh` the bundle the board saved ONCE at `board/bundle-in.json` inside the run folder (an exclusive write; a different second bundle is refused); never the public copy folder, never a file the console reads as terms. The only fields of a message that reach a helper are the lines of `board/verify.in`, which `board-verify.sh` checks again against fixed patterns and builds the text from itself. A request cannot make a run a board run: `handover` is not a field of the settings form (only the host's own call may write `HANDOVER`).

**Restart.** The state machine's snapshot, the outbox, the results of the helper steps (signature, digest, bundle) and the verified check are written to `handover-ROLE.json` after every change (a temporary file and a rename, mode 0600; no key in it). A restart rebuilds the machine, publishes again what was not acknowledged, and resumes from artifacts (`wallet-addresses.txt`, `alice.swap.json`, `bob/bob.swap.json`, `board/bundle-in.json`) and the stored results, so no helper that ran is run again; tested with a restart in each step of both roles.

**The payload.** `GET /api/run` carries `board`: the state, the offer's terms, what the board waits for, why it stopped, whether anything is funded, relay states and the number of messages not yet acknowledged: enum codes and numbers only. No key, no secret, no free text of a message is ever in it, in the audit log or in a file the console reads.

**Known gaps of this step.**
- **The messaging keys and the invite secret are stored in `board-keys.json` in the run folder, NOT sealed.** No swap-cli command seals an arbitrary secret (the sealing is inside the swap files and needs the run's passphrase, which the console never holds), so the file is written with owner-only permissions where the platform has them (mode 0600 on POSIX; on Windows the folder's own access rules apply) through a temporary file and a rename. A messaging key controls no coins (it can only talk inside one swap); the invite secret admits to a small trusted test group. The installer piece moves both to the operating system's key store. A deleted or overwritten file is not securely erased.
- No forward secrecy and no padding beyond NIP-44's: a later leak of a messaging key decrypts recorded traffic (addresses and a bundle: public values).
- Relay authentication (NIP-42) is not implemented; the relay list is the operator's own configuration, not chosen here; the relays' limits (kind 1059, size, retention, proof of work) are only known from a real run.
- The counterparty screen's reserve is a constant of the board's settings, not Bob's live fee reserve; Bob's own tool still checks his real one.
- One console, one run folder, ONE open offer or take per app (amendment H); a second needs a second console and run folder.
- The page's screens are built (step P3.7, "The board's screens" below); none of them has been looked at against a real relay.
- The host's timer is the console's 3 s tick; helper steps share the console's one action slot with the autopilot and the deposit poll, so a slow helper delays the others.
- A message that arrives while a signature is being verified waits behind it; at most six verifications are made per swap, a seventh message is dropped.
- Whether real relays accept the offer kind and kind 1059 wraps, their delay and loss, and the proof-of-work level are not known (design section 9).

### Review of the board, 2026-11-17

An independent read found that a relay or an outsider cannot move or misdirect coins and cannot get a file or a setting written with its own content. Two must-fix points were found and fixed:
- A counterparty could crash the console, again on every restart: messages ahead of their turn were held before their type was checked and twice over, so eight large ones made the handover file too big to write, and the error left the relay's handler and ended the process (the relays serve the same notes again after a restart). A message ahead of its turn is now held only when its type belongs at that step, once, under a 128 KB cap on the held total; nothing a relay message, a timer or a helper step raises can leave the host (it is recorded as an error code, shown on the board line, and the host goes on); a message whose state cannot be saved is not acted on, the state is put back, and it is tried again up to three times; the relay client also catches what a listener raises.
- A stopped board did not revoke Bob's lock: the board counted Alice's funding as proof that Bob had started, so after his stop his autopilot could still lock, and an unreadable audit log or wallet record counted as "started" for Alice's funding. A spend now counts as started only from the role's own send evidence (a `send-lock` or `send-fund` start line in the audit log, Bob's own tick at `lock_submitted` or later, the wallet's own funding record), and "unknown" is not started.

Left as they are (written down, not fixed):
- A counterparty's `done` is accepted early and makes the page say the swap is over before anything was funded (no coins move).
- After a restart during Bob's join, an existing Bob file counts as a passed join, which skips two late refusals of `join.sh`; the address check of the signing helper limits it.
- The 120 s digest read is bound to the terms files, not to `alice.swap.json`, and on a network share the file times may be too coarse to show a change.
- An edit of `handover-alice.json` on the same machine passes the gate after a restart, because the check is not verified again.
- The take sends only the offer id, and the terms were first shown at the approval. Closed by step P3.7: the payload lists the offers and the page shows every term at the review of an offer, before the take is sent, with the same function that draws them at the approval.
- A taker takes the offer's contract version; the taker's own setting is not compared.
- Relay addresses from an offer are checked by name only; a name can still resolve to a private address.
- The counterparty's balance read does not check the chain id of the node that answered.
- At most six verifications per process, and later messages are dropped without a word.
- A stop while a verification is queued can leave the inbox frozen (the swap is stopped anyway).
- The messaging keys are not removed at the end of a swap, and `board-keys.json` is not sealed: someone who reads it can speak for that side in the handover and join the private board, and cannot move coins (sealing moves to the operating system's key store with the installer).
- The relay client's reconnect delay uses an ordinary random number; every key and nonce comes from the system's generator.
- Not pinned by a test: a replaced `alice.swap.json` inside the 120 s window, a tampered `handover-alice.json`, a take with another contract version, a balance from another chain. Not run against a real relay or the real WebSocket of Node.

### The board's screens (step P3.7, 2026-11-17)

**Not run against a real relay, a node or a public network.** The screens are built from four mock screens (not in this repository) and are tested offline: the pure logic (`lib/boardview.js`, `test/boardview.test.js`), the page with a small stand-in for the DOM (`board.js`, `test/board-page.test.js`), the server side (`test/board-screens-host.test.js`, against the in-process fake relays and fake helpers) and eight preview scenarios (`test/serve-fake.js`, below). The figures, addresses and records in the scenarios are made up.

**What it is.** With `--board` the page draws the board's screens above the operator page, in the same look (the tokens, the two typefaces and the mark are `operator.css` and `fonts/`; `board.css` adds only rules under `.bd`). The operator page is still all there, unchanged, behind one button "Details" (the tool's own words, the manual boxes, the audit log) so a person can always see what the tool says and take over; "Hide details" folds it again. A console started without `--board` shows the operator page exactly as before. The screens add **no way to send**: they post only to `/api/board` (post, take, cancel) and `/api/autopilot` (the one approval), and everything the server decides about those (the approval, the typed amount, the gate, the dry run, the latch, the audit line) is unchanged. The page never receives a key or a secret: the board payload carries the person's own public addresses and the offer's terms only.

**Files.** `lib/boardview.js` (pure, loaded by the page as `window.NoidBoardView` and by the host), `board.js` (the page code, `window.NoidBoard`), `board.css`, and the changes to `index.html` (one `bd-root` above the operator page, which is now inside `op-view`), `operator.js` (it calls the board's `render` first, and the board's tab title wins), `lib/viewmodel.js` (two fields: `finished` and `leftover`), `lib/board/host.js` (the payload) and `server.js` (three static routes).

**The payload.** `board` (lib/board/host.js `view()`) gained: `offers` (the offers the board accepts now, at most 50, only while this console carries no swap), `offer_id` (the note this swap is for), `payouts` (`{noid, eth}`: the person's own addresses from the settings; an Alice's NOID address is where leftovers go, a Bob's is where his NOID arrives), `limits` (`noid_min_micro`, `noid_max_micro`, `wei_max` as whole numbers in text), `can_start` and `start_blocked` (`null`, `has_swap`, `run_not_fresh`, `board_closed`, `not_running`), `step` (the handover's step as one word: `choose`, `waiting_take`, `waiting_accept`, `getting_ready`, `deposit`, `running`, `stopped`, `over`, `unknown`; from the machine's state and the console's role by `handoverStep`), `deposit_window_blocks` and `fund_k`. **An offer in `offers` has exactly these fields and nothing else:** `id`, `side`, `noid_micro` and `wei` (whole numbers in the smallest unit, as text), `chain_id`, `profile`, `htlc` (the app's own pinned contract), `contract_version`, `lock`, `variant`, `price_wei_per_noid` (computed by the app) and `expires_at` (seconds). It is copied field by field from the offer the validator passed (`lib/board/offer.js`); the poster's key, the relays, the daily tag, the encrypted payload and every other tag are not in it, and a test fills the parsed offer with extra fields and checks that none arrives. The page checks every field again (`offerOf`): one field that is not what the validator would pass (a letter in an amount, a wrong side, an address that is not a hex address) drops the offer, it is never cleaned. The deposit status, the approval state and the autopilot's `doing`, `waiting_reason` and `needs_you` are read from `actions.wallet` and `actions.autopilot`, as before, and are not copied into `board`.

**The screens and when each shows** (`screenOf`, one pure function; an Alice's console and a Bob's use the same screens):

| Screen | When | What it has |
|---|---|---|
| Offers | no swap on this console, or the person pressed "Offers" | the list (smallest first: what the poster does, "you give" and "you get" for this person, the price in ETH for each NOID, minutes still open, "Take"), "Post an offer", the notice (private test board by invitation, the caps, the Sepolia test network, the NOID is real), the empty state, the limits |
| Take review | "Take" was pressed | every term, then the one button "Take this offer"; it sends only the take |
| Your offer | the person posted an offer and nobody took it | the terms, "Withdraw the offer" |
| Take, deposit, approval | a swap exists and nothing of it is in play | the four steps, every term again (the same function), the app getting ready, the deposit rows, the one approval |
| Progress | the approval holds, or the swap's coins are in play | "Your swap is running", the steps, the two locks, the swap's own end time, "Needs you" |
| Done, refunded, stopped, lost, ended | the swap ended, or the board ended before anything was funded | what was received and where, the records, "Back to offers" |

**Every term before the take and at the approval.** The review of an offer shows: what is given and got, the price, where the coins arrive (the person's own address from the settings; for an Alice's ETH it says the ETH is first taken by the swap's own key and then sent on), where leftovers go, the network and chain, the settings profile, the swap contract, the contract version, the kind of lock, the key variant, the offer's short id and what happens if the swap does not complete. The take button is off until those are drawn from a listed offer, the person's own address is set, the key is there and this console can start a swap. The approval screen shows the same terms from the board's own offer with the same function (`termRows`); a test checks that the words at the take equal the words at the approval, and that the values equal the files the approval's hash is built from (`PROFILE`, `LOCK_KIND`, `VARIANT`, `CONTRACT_VERSION`, `CONTRACT` and `ETH_PAYOUT` of `env.local.sh`, the bundle's amounts, chain and contract). A take is refused by the server unless the offer id is one the payload listed (404, nothing starts).

**The deposit rows** follow the operator page's rule: an address is shown only from a wallet status that ended clean and proved that the key owns it (`show`); any other state says why and "do not deposit anywhere". The amounts are the status's own (the NOID the swap needs plus the fee reserve, the ETH the swap needs plus the reserve), as words from integers, with "seen" or "waiting". The time left for the deposit is shown only when the swap's start height and the latest block are known: `h_create + fund_k - tip` blocks at 30 s a block, labelled an estimate; otherwise the page says it does not know yet.

**The one approval** is the existing `POST /api/autopilot` with the typed amount (the person types the number, the page adds the unit and compares it as the server does), the server's statements as ticks in plain words (`stay_on`, `no_manual_steps`), and one more tick the page asks for itself: that the address receiving the coins is the person's. In a board run the "Bob's check line" tick is not shown (the gate does not accept it there; the server's list of statements is what is drawn, and any statement the page has no wording for is shown with the server's own text). The button is off, with its reason in words, until the key is there, the terms are readable, the deposit is seen, the amount matches and every box is ticked. The server's refusal is shown as text.

**Progress.** `PHASE_STEP` in `lib/boardview.js` maps every phase of both roles (a test checks it against `lib/phases.js`: the same phase ids, no more and no fewer) to exactly one step in the person's words, one plain sentence about now, and whether it is on the main way, the way back, or an end. Steps before the current one are done, after it to do; on the way back the steps never reached are not drawn as to do. A phase that is not in the table, or no tick yet, shows "The app is checking where your swap is" with no step. The time: the approval's time ("approved at ..." and the minutes since), "a normal swap takes about 50 minutes" (a fixed sentence from the live runs, not an estimate for this swap) and the swap's own end time from the deadline rows the view model already has (an Alice's NOID come back at `D`, a Bob's ETH at `T_reveal`, shown as a time of day and "in about ..."). No estimate of the time left is made, and with no row nothing is shown. The sentence about closing is: "Keep this app open and the computer on until the swap is over. If anything goes wrong your coins come back by themselves once the app is running." **Needs you** is drawn from the autopilot's `needs_you` (a stopped step), an approval that went off by itself, a tick the page cannot see, or a board error, each as fixed words ("The app stopped taking your ETH ..."). The tool's own sentence is kept in a folded "The tool's own words" box, as text. The box has one button, "Open details": clearing a stopped step stays in Details behind its own confirmation, because it lets the autopilot try a step that may already have been sent.

**Done and refunded** are drawn from the terminal phase and what the app recorded: the amounts agreed and where they arrive, "sent on to your own address" only when the wallet's sweep marker says so, the transaction hashes the engine tracked (only values of the exact form of a hash, as plain text with the explorer's name, never links), and for a refund the reason "the other side did not lock their ETH" only when the tick read Ethereum and shows no lock (otherwise no reason is given). "Back to offers" shows the list again; this console carries one swap, so Take and Post are off with the reason ("start the app again on a fresh run folder"), as the host's own rule says.

**Placeholders and what the app does not know** (nothing below is invented; it is left out or labelled):
- No duration is shown on the done screen and no fee total (no file the page reads holds either). The fee floor of the close (at least 0.0058 NOID) is stated as a rule, and the screen says "the app does not total them yet".
- No minutes-left figure: the engine gives cutoffs, not an estimate of the end. "About 50 minutes" is a fixed sentence from the live runs.
- The producer-share sentence for a person receiving NOID is a fixed text (one address was measured producing close to half of the blocks in early November 2026), not a live figure: before a swap file exists the app has no reading.
- Times are shown as hours and minutes in this computer's own time, with no zone name. The engine's own times of day (the loop's lines) are not used, because they carry no zone.
- The picture of the two locks is words from the view model's picture, not the mock's drawn bars.
- "Back to offers" cannot start a second swap on the same console.
- What the board waits for while it gets the swap ready is a fixed sentence per code.
- A deposit shown as "seen" is the newest reading (about every 40 s), not a promise that the coins are still there.
- Not run against a real relay, so how many offers a real relay shows, how fast and how stale, is not known.

**Standards kept.** Real headings (one `h1` per screen), a `nav` with a name, labelled inputs and a fieldset with a legend, `role="status"` on each deposit's state and `role="alert"` on "Needs you" and on server refusals, nothing by colour alone (every state has a word or an icon), the focus goes to a new screen's heading, a visible focus ring everywhere, text at least 4.5:1 on the dark ground (the mock's computed pairs), no horizontal scroll at 380 px (checked in a browser window at that width for the offers, take, progress and done screens), sentence case, no emoji, no exclamation mark, and none of "HTLC", "intent", "tick", "phase" or "dry run" on the screens (a test draws every scenario and searches the text; the folded tool's own words are the one labelled exception). **Hostile text:** every string from the server is put in with `textContent` through the page's `el` helper; there is no `innerHTML`, `outerHTML`, `insertAdjacentHTML`, `document.write` or `eval` in `board.js` or `lib/boardview.js` (a test searches the code without its comments), and tests put markup in every server-supplied field (a stopped step's label and reason, `doing`, `waiting_reason`, the board's error, stop and state codes, the payout addresses, the wallet status) and check that no element, no handler attribute and no style comes out.

**Preview.** `node ui/app/test/serve-fake.js board-offers` (or `board-empty`, `board-take` (the NOID deposit not seen yet), `board-approve` (both deposits seen: type 5, mark the boxes, press the button), `board-progress`, `board-needs-you`, `board-done`, `board-refunded`) starts an Alice console with `--board` whose board answers, deposit status and approval are made up (`test/board-scenarios.js`, which the page tests share). "Take" moves to the take screen, "Post an offer" to "Your offer", the approval button to the progress screen; nothing reaches a relay, a helper or a chain.

**Tests added:** `boardview.test.js` (18), `board-page.test.js` (28), `board-screens-host.test.js` (7). The whole console suite: 644 tests.

Low points, written down and not fixed:
- A redraw after a poll that changed the payload rebuilds the board's DOM (the typed amount and the ticks are kept; a text selection is not).
- The deposit countdown uses 30 s a block and the tip from the last tick; with no tick it says it does not know.
- A person who asks for the offers list in the middle of a swap sees the list with Take off; the offer of the swap in play is only in the "Your swap" place.
- The page's `offerOf` drops an offer silently; the count "N open now" is of the offers the page could draw.
- Only an Alice's preview scenarios exist; the Bob screens are covered by the page tests with made-up payloads and by the host tests, not by a preview.

## Program mode (piece 4, step 4.5, server part)

Bottom line: the desktop shell calls `startProgramServer(program)` (`server.js`) and gets a second kind of console. Every action runs a step of `lib/steps` **in-process**
(`lib/stepexec.js`), a swap's settings are its `run.json` (`lib/settingsource.js`), the watch loop is a timer of the program, and several swaps run side by side
(`lib/swapset.js`): one folder `<runs>/<swap id>/` is one swap with its own action runner, autopilot, audit log (`pub/ui-audit.jsonl`), run lock, step executor and (for a
board slot) board host. **Terminal mode** (`node ui/app/server.js ...`, WSL helpers, `env.local.sh`) is unchanged: `ActionRunner` takes `deps.executor` and
`deps.settingsSource`, and without them it is today's code.

| File | What |
|---|---|
| `server.js` | `startProgramServer(program, deps)` -> `{ scheme, token, swapSet, handler, mark, maxBody, stop }` since 4.9 (no port; see "Program mode on the private scheme"; before 4.9 it listened on 127.0.0.1 port 0), prints nothing; the same Host, Origin, same-origin, token and CSP checks as terminal mode |
| `lib/swapset.js` | `SwapSet`: `scan`, `open` (the folder rules), `create(fields)` (the new-swap form), `createBoardSlot(role)`, `list`, `atStake`, `tick` (the 3 s timer), `stopAll` |
| `lib/stepexec.js` | `createStepExecutor`: table id to step (`resolve`), `precheck` (the checks before every entry), `run`, the in-process watch (`watchStart`, `watchStop`, `watchStatus`, `supervise`) |
| `lib/settingsource.js` | the run.json answers the runner asks instead of `env.local.sh`: `role`, `walletRun`, `boardRun`, `productionReason`, `roleBlock` |
| `lib/programsettings.js` | `<data>/settings.json` v1 (strict, no secret), `view` (addresses cut, alert URL as `"set"`), `merge`, `save` |
| `lib/toolhash.js` | the nine tool files and the step code, hashed with a metadata cache for views; `fresh: true` reads every byte again |
| `lib/exitcodes.js` | `classifyStepExit(step, { code, stdout, files, kind })` (Appendix B); `classifySpendExit` and `EXIT_TABLE` are the bash helpers' and unchanged |

**Rules (each has a test, `test/program-*.test.js`).**
- Before every entry, in this order, a refusal is 409 with an audit line (not repeated within 60 s) and no step is called: run.json loads and is not production; the role rule;
  the folder guard (read fresh before a spend through the program's `folderGuardFresh` / `folderGuard(dir, { fresh: true })`, cached 10 s otherwise); the vault is open (and
  for funding, locks and wallet setup the recovery code is confirmed); then the run lock (the runner's own `verify`).
- The role is run.json's, `alice` or `bob`; a missing or unreadable role refuses every entry; the other role's entries and a folder holding the other role's swap file are refused.
  The only entries a board slot (no run.json yet) runs are `board-verify-addresses` and `board-verify-checked`.
- A spend step's result is read by `classifyStepExit`, never `classifySpendExit`: a rejected promise is code null (may have been sent; the reveal: the secret may be public), a 2 or 3
  counts as "nothing sent" only with the step's own fixed line, and a send result file in the step's files turns it back into "may have been sent". A running spend is never abandoned
  (no signal, no kill); past the entry's time limit the payload shows `busy.warning`. A step that sends nothing gets `ctx.signal` and is aborted at the limit.
- `install`, `check-object` and `/api/funded` are terminal-only (409 / 404). The program refuses a production run folder (read-only, every action 403).
- The autopilot's approval (`Autopilot.programTermsHash`) binds every item of the terminal hash but `env.local.sh` and `bin/`, plus the canonical bytes of run.json, the program's version,
  the nine tool files and one hash over the step code; an input that cannot be read gives null and nothing is in force (the word "none" never enters the hash). `authorize` hashes every
  input again, bypassing the cache. A step that may have been sent stops the autopilot for that swap (needs you), even where the step says the same bytes would go.
- No secret in an API answer, audit line, job record or notification: the step asks the vault for the passphrase per call; the executor keeps none.

**The two context fields** `ctx.signal` and `ctx.notify` of `steps/common.js`: `startTool` kills its child when the signal aborts; `alertHook` and `alarmHook` call `ctx.notify("alert" | "alarm")`
each time they fire, before any POST, with or without an alert URL (the latch rules do not change); the watch passes the ALERT hook what it saw on the last tick, so an ALERT line that stays on the next ticks notifies once, not every tick. `childEnv` sets `ETH_RPC_URL` only when `ctx.settings` has a string `eth_rpc`.

**API** (all `/api/` requests keep the token, Host, Origin and CSP checks): `GET /api/program`, `GET /api/run?swap=ID`, `POST /api/action|spend|autopilot|board|helper` with `"swap": ID`
(a missing or malformed id is 400, an unknown one 404), `POST /api/newswap {fields}` -> `{ ok, swap }` or 422 `{ ok:false, errors }`, `GET|POST /api/settings`, `POST /api/program/open {what}`,
`POST /api/board/slot {role}`. `join` asks the shell's dialog for the bundle file (`program.chooseBundleFile`); no file is 409.

**Board slot.** `createBoardSlot(role)` makes `runs/<id>/` with `board-slot.json`, `written-by.json` and `vault-check.json`; the host writes `run.json` itself (`BoardHost.writeRunJson`,
`runsettings.newSettings(fields, { runId })`) and Alice's order is run.json, `setup`, the balance check, her wallet. One slot at a time (an idle slot is replaced; an ended slot with no swap
file and no wallet is moved to `runs/.ended/`, never deleted). The host needs the vault's sealer for its keys (`deps.boardSealer`); without it the host does not start in program mode.

**Low points (left).** `needs_you` of a swap counts a spend that may have been sent until a later clean run of the same step: this process's jobs, and for a spend not run since the start the
last lines of the audit log (a start line with no end line counts), so a restart no longer forgets one. `/api/program` rescans `runs/` at most every 5 s. A refused folder is listed with its reason but has no runner (its actions answer 409). The board settings carry three keys
beyond the spec (`profile`, `contract_version`, `pinned_htlc`). The node gate of the autopilot reads `ok_since_start` of the program's node status.

**After the independent read of 4.5 (2026-11-18).** Its one must-fix is fixed: a settings body with a key named `__proto__`, `constructor` or `prototype` could change
`Object.prototype` for the whole server, because `merge` walked the body's own keys before `validate` ran. Now every program-mode POST body is parsed with a reviver that refuses
those three names at any depth (400, nothing done), and `programsettings.merge` refuses them again (`ProgramSettingsError`, 422 from `/api/settings`); two tests in
`test/program-server.test.js` fail without the fix. Its first low point is fixed too: the autopilot form (ticks and typed amount) belongs to one swap and one role and is
forgotten when you leave the swap, so swap B no longer opens with swap A's statements ticked (`test/autopilot-page.test.js`).

**Low points of that read.** Fixed 2026-11-18 (each has a test that fails without the fix): the code-1 advice now says that a missing `sent:` line does not prove that nothing was
sent and to look at the swap's phase and the contract before trying again (no "cancel the intent", which program mode does not have); `needs_you` after a restart reads the last audit
lines of each spend (a start line with no end line counts; `RERUN_SAFE` is not counted) for a spend not run since the start; the view and the loop read every input of an approval again
(no cache) once a minute, so a tool file changed with its metadata kept stops showing "on" before the next spend; an ALERT line that stays on later ticks makes one operating-system
notification (the POST is unchanged); a save over a broken `settings.json` first keeps a copy as `settings.json.broken-STAMP` (mode 0600; no copy, no save); the board host takes
`http://[::1]` as `programsettings` does; `/api/demo` and `/api/demo/scenarios` answer 404 in program mode; a `pub/` that is a link or a file refuses the folder; `runsettings.write`
in update mode keeps `run_id`, `role`, `profile` and both payout addresses as they are (an unreadable file is not updated); `hc_lead` is capped at 1,000 as the form is; the migration
refuses a folder that holds the other role's swap file (Bob's terms were already required in every case). Checked, no change: `program.codeFiles` hashes `<rootDir>/ui/app/lib/...`
and the shell requires `../../ui/app/server` from the same root, so it is the copy the server loads; integration only has to keep the two paths under one root. Left:
- A non-spend step killed at its limit can leave half-made files (`wallet-setup/`, `prepare`, `join`) that the steps then refuse; the program has no terminal to clean them. A safe
  "start again" needs its own table entry, role rule, page button and tests (for `wallet-setup/` it would move the sealed files aside, since no address was shown from them; for
  `prepare` and `join` a swap file may be funded, so a person must decide).
- ~~Error texts and step output on the page carry absolute paths of the data folder, which contain the account's name~~ **Fixed 2026-11-19 (4.5-L10).** In program mode every answer of the console to the page goes through `pagePathRewriter` (`server.js`, in the program handler's `send`): a path below `program.dataDir` is shown relative to it (`runs\ID\alice.bundle.json`), a path below `program.home` as `~` plus the rest, a path outside both unchanged; both separators and, for a drive path, any letter case are read; every string of the body is rewritten (step lines, job records, refusal and error texts, the autopilot's words), keys and numbers are not. The logs, the audit lines, the steps' own files and the job records in memory keep full paths; only the answer to the page is changed. Tests: `test/final-pass-console-paths.test.js`. Left: a path that reaches the page through a Windows short name (8.3) or a link, and one in a text the page builds from two answers, is not recognised; the data folder and the home folder are the only two roots.
- The window does not block reload yet; a reload loses the token (integration).
- Test gaps: "the WSL path is never reached" is shown for one funding plus the static test, not every entry.
- `stop()` waits for each watch's current tick, so quitting can wait up to one tick's limit.

**After the independent read of those fixes (2026-11-18).** No must-fix. Fixed, each with a test that fails without it: a swap that is over never
shows "needs you" because of an old "may have been sent" line in its audit log (nothing could clear it); a spend run by this process records its
own ending, so once its job leaves the 30 kept ones the audit log's older verdict does not come back (it gave a false "A swap is waiting for you").
Left (the final pass decides):
- The two "may have been sent" rules differ for one kind of reveal: a reveal that ended 0 with a warning (`SECRET MAY BE PUBLIC: ok (exit 0)`,
  or `SECRET PUBLIC: ...` for a reverted claim) counts after a restart but not in the process that ran it. It errs on the careful side.
- The stricter checks refuse files that were accepted before: a `run.json` with `hc_lead` between 1,001 and 10,000 no longer loads (every action
  on that swap is refused, refunds included), and a `settings.json` whose node is `http://localhost` fails the node check, which holds the
  autopilot until the settings are saved again. Low only because nothing has been released: accept old values on load and refuse them only
  on create, if a release ever follows a build that wrote them.
- An ALERT line's notification is matched by its exact text: the same text on two ticks in a row (a second reorg) gives no second notification
  from the operating system (the POST is still sent).

## Program mode on the private scheme (step 4.9)

`startProgramServer(program, deps)` no longer listens. It resolves to `{ scheme: "no1d", token, swapSet, handler, mark, maxBody, stop }`:
`handler(req, res)` is the program mode's request function (what `programRequestHandler` returns), `mark(req)` marks a request as one
that came through the desktop shell's scheme adapter, `maxBody` is the adapter's ceiling for a request body (the largest route limit,
16384). The shell gives these to `desktop/lib/scheme.js`; the server opens no socket and prints nothing.

- Terminal mode (`node ui/app/server.js ...`) is unchanged: same listener, `hostOk` and `originOk` as before, same policy header, same
  tests. Only its request function got a name (`requestHandler`, also kept as `server.requestHandler`) and `send` got an optional
  policy argument. Program mode's handler is a separate function (as it already was), so there is no shared "createRequestHandler";
  the two routes differ and sharing one function would have changed terminal mode.
- In program mode: a request without the adapter's mark is refused (403) before anything else; the Host must be exactly `app`
  (`schemeHostOk`); a POST with an `Origin` other than `no1d://app`, or a `Sec-Fetch-Site` other than `same-origin`, is refused
  (`schemeOriginOk`). A POST with neither is accepted by this check: Chromium sends no `Origin`, no `Sec-Fetch-*` and no `Referer`
  on a request answered through `protocol.handle` (seen on a real window under macOS, with `corsEnabled` false and true), so requiring
  one refused the program's own page. A write is bound by the adapter's mark, the main window's session (the only one with the
  handler, held to `no1d://app` by the navigation guard) and the per-start token;
  a GET on `/api/` is refused when `Sec-Fetch-Site` is cross-site or the Origin is another (`crossSiteRead` with the scheme origin).
  The per-start token stays as the second lock on every `/api/` request. After `stop()` the handler answers a fixed 503.
- Every answer of program mode carries the policy `default-src no1d://app; style-src no1d://app; script-src no1d://app;
  connect-src no1d://app; img-src no1d://app data:; frame-ancestors 'none'; form-action 'none'; base-uri 'none'` (terminal mode keeps
  `'self'`). The body caps (512 bytes, 4096 for a new swap, 16384 for settings) and the refusal of the keys `__proto__`, `constructor`
  and `prototype` anywhere in a body are unchanged.
- Tests: `test/server-scheme.test.js` (the security checks through the real adapter: pure checks, token, address and Host, Origin,
  same-origin reads, the policy on every status, the pages, secret paths, reserved keys and caps, one action route, one spend route, a
  static check that no socket is opened). `test/program-harness.js`'s client now goes through the adapter (`request(srv, token, ...)`
  takes the started server, not a port); every assertion of `program-server.test.js` is still made (the Host-header cases became
  "another address of the scheme is refused by the adapter" and "the handler refuses a Host that is not app"; the loopback-bound test
  became "no listening socket is made" and "the handler refuses an unmarked request").

**Low points of 4.9 (left).**

- The adapter reads a whole request body into memory (at most 16384 bytes) before the handler runs; the handler's own streaming reader
  then sees it at once. Fine for these routes, not for large uploads.
- `Sec-Fetch-Site` and `Origin` are accepted when absent in program mode (Chromium sends neither through `protocol.handle`); the
  token, the adapter's mark and the main window's session are what bind a write. Terminal mode still requires the Origin on a POST.
- The old terminal-mode console pages (`/console`, `/app.js`, `/styles.css`) are still not served in program mode.

**Deviations from the build specification, section 9.**

1. `createRequestHandler(state)` as one function for both modes was not done: terminal mode's handler (an inline arrow inside
   `createServer`) became the named `requestHandler` without any other change, and program mode keeps `programRequestHandler`. Reason:
   the spec's other rule, that terminal mode must not change behaviour, and the two functions serve different routes and checks.
2. `startProgramServer` also returns `mark` and `maxBody` (besides `handler`), because the adapter, which lives in `desktop/`, has to be
   able to mark requests with a Symbol private to the server module, and the ceiling of the largest route is the server's to name.
3. A hold in the self-test through an environment variable (`NO1D_SELFTEST_HOLD_SECONDS`) was added so the hosted job can look for
   listening sockets while the program is up; the spec's acceptance did not say how.

## Simpler swaps (2026-11-19)

Bottom line: in program mode a person presses one step button per role, confirms that the two check lines match, approves once, and then deposits; the
program does the rest under the same dry runs, gate, latch and audit lines as before. Nothing here sends by itself, the engine still decides every spend,
and payouts still go only to the person's own addresses. The terminal console and board runs keep their screens unless a line below says otherwise.

**First steps by themselves (`lib/firststeps.js`, `FirstSteps`).** On the program's 3 s timer, a form swap gets Set up and then the wallet setup
(`wallet-setup-ROLE`) through the usual table actions, precheck, busy flag and audit lines (with "started by the program"). A step that fails waits for
the person's "Try again"; a closed key store or an unconfirmed recovery code is a wait with no audit line; a start that throws backs off from 60 s,
doubling up to 15 minutes. Board slots, read-only folders and folders that already hold the role's swap file get no setup step. The page shows two steps
per role: Alice "Make this swap's own wallets" (by itself) and "Prepare the swap file"; Bob "Make this swap's own Ethereum key" (by itself) and
"Choose and check Alice's file".

**The watch rule W (`watchWanted`).** Two kinds of watch loop: a read loop runs `tick` without `--apply` and records nothing; an apply loop runs
`tick --apply`. A swap gets an apply loop, in this order, when: (1) an intent is held or recorded; (2) this role has acted (Alice past `created`, Bob
from `lock_submitted` on); (3) a height abort that cannot turn back (Alice "too late to fund"; Bob "last lock height … passed", past his lock-by height
or past `B_bob`; either role "recovery branch") was seen on two read ticks in a row, read from `action.action || action.kind`; (4) it has applied
once already; (5) the approval is in force and the deposit is seen. Otherwise it reads. An apply loop never goes back to reading; an upgrade waits for
the tick in progress (`upgrading`), so there is one loop at a time; a person's Stop holds until a program start or a `turnOn`. The abort patterns are
taken from the engine's own texts, and a test fails if `swap-cli/src/engine.rs` or `params.rs` stops printing one of them. Why: before this, the
applied watch started right after Prepare, so the engine could record a funding intent before the person had approved or deposited.

**Reading without recording (2026-11-20).** Bob's read loop no longer runs the plain read-only tick: it runs `swap-cli tick --apply --observe-only` (the tick step's
`observeOnly`, `lib/steps/tick.js`; the loop, `lib/steps/watch.js`). That tick writes the facts the chains show (Bob's `received`, `funded`, `funding_final` from the
first sighting of Alice's funding, an instance gone, a lock seen) and never an intent, an abort or a spend's parameters (`swap-cli/README.md`, "tick --apply
--observe-only"). Before, Bob's file recorded Alice's funding only when his approval and deposit switched the loop to apply, so the 18 blocks of finality were
counted from then; now they are counted from the first sighting, and the first apply tick finds `funding_final` and offers `lock_eth` at once. swap-cli refuses
an observe-only tick while the file holds an intent or a pending action (exit 1, "observe-only is refused"): that round reads with the plain read-only tick, never
with a full `--apply`, and the audit log gets one `watch` note per refusal streak, not one per tick. Rule W is unchanged and reads `phase_after` and `intent` as
before: an observe tick shows the phase the read-only tick showed (it only keeps it), and Bob's `received`, `funded` and `funding_final` are still not his act, so no
observe tick turns the loop to apply. Alice's read loop keeps the plain read-only tick: from `created` the engine adopts any fitting instance at her contract root, so an
observe tick could move her file to `funded` on a deposit someone else made there (Bob knows the opening), and rule W reads any phase past `created` as her own act and
would switch to apply before her approval and deposit (found by the independent read; her own funding starts the apply loop anyway, so she loses no wait). The tick JSON carries `observe_only: true`: every send gate (ledger spends, the claim, the sweeps, the re-sends) refuses such a tick
(`tick_observe_only`, "An observe-only tick cannot open a send: the loop must run a full tick first."), the status capsule shows it as a read-only tick, the withheld-parameters
note says "Observing only: …", and the loop line reads `applied: observe-only` (`scripts/live/tick.sh` never passes `--observe-only` and is unchanged). swap-cli also refuses an
observe-only tick once the file's history holds an `intent_decided:` entry (a cancelled or resolved intent too): that state reads with the plain read-only tick until a full
tick takes over. Rule W returns "read" in one such state (an intent cancelled before the role acted, with no approval and deposit in force): the loop then falls back
each round, with one audit note. The console's operator mode (non-program) is a different path (`lib/runner.js`, `tick-ROLE`) and still runs the read-only tick without `--apply`.
Tests: `test/observe-read.test.js` (argv in read and apply mode, the refusal fallback and its single note, rule W for both roles, the gate, and Bob's file reaching
`funding_final` before the approval with the first apply tick offering `lock_eth` with no new wait, against a model of swap-cli; the tool itself is tested in
`swap-cli/tests/observe_only.rs`). Not run against a real node.

**The check line and the line match.** `check-line.json` (`{"v":1,"from":"prepare"|"join","hex":…,"at":…}`, mode 0600, written once, never
replaced) is taken from the step's own output on disk, and only once the step reached its clean end: Alice's `new-alice.err`
(`bundle check: <16 hex> (opening_hex …`), once `alice.swap.json` exists; Bob's `join-new-bob.out` (`bundle check: <16 hex> ok`), once
`bob/bob.swap.json` exists; exactly one distinct line, else nothing is written. The page shows it as four groups of four digits.
`POST /api/checkline/confirm {"swap", "hex", "matches": true}` records that the other side read the same line: one audit note and `line-match.json`
(written once; asked again it answers the same, with no second line). Refusals: 400 without `matches: true`, 404 on the terminal console, 409 for a
board run, no check line, another hex or a read-only folder, 403 for production. In program mode outside a board run, the approval (`turnOn`) is
refused with `line_match_missing` until that record exists for the current line, while the role has not acted yet, and the gate refuses a funding or a
lock sent by hand for the same reason. Bob's approval has a third statement, "Alice's check line matches mine", and the gate refuses his lock without it
(`statement_alice_check`), by hand or by the autopilot.

**Approve before the deposit.** The approval's terms hash comes from the bundle, run.json, the tools and the code, never from a tick, so an approval
given before the first tick stays in force. The approval box says "You give X. You get Y." With the approval in force and no deposit seen, only a read
loop runs and nothing is sent; once the deposit is seen the loop records and the funding or lock goes through the usual dry run and gate, once.

**The deposit box (program mode).** The amount in plain units (NOID exact; ETH rounded up to six decimals, never below the wei needed), a Copy amount
button (the figure without the unit), the exact figure underneath, and for Alice a clock read from the engine's funding-window note
(`enginetext.fundingBlocksLeft`): "Deposit before about HH:MM", counted with 20 s blocks and four blocks kept in hand. The terminal console's wallet runs
keep their words.

**Files for the other side.** `POST /api/bundle/save {"swap"}` (Alice) saves the bytes of the run folder's `alice.bundle.json` through the program's
own save dialog (`program.saveCopy`); `POST /api/invitation/save {"swap"}` (Bob) saves an invitation the same way. Answers are `{ ok, saved }` and
never a path; one audit note per save or cancel. Refused (409, with fixed words): the wrong role, a read-only folder, a board run, production, a missing
or unusable file, a dialog already open, a place inside the program's own data folder.

**The invitation (`lib/invitation.js`).** A small JSON file Bob saves and Alice opens, so neither types the other's terms or addresses:

```json
{ "kind": "no1d-swap-invitation", "v": 1, "network": "sepolia",
  "contract": "0x48Ce4D6cf3c175737532017e82B9261b51F8E5eF", "contract_version": 1,
  "noid_micronoid": "5000000", "eth_wei": "1000000000000000", "bob_noid": "o1…", "bob_eth": "0x…" }
```

Exactly these nine keys, Sepolia only, at most 4,096 bytes, amounts and addresses as strings, never a payout, a path, a node or a fee setting.
`POST /api/invitation/open {}` opens the program's open dialog, reads the chosen plain file once (no link, strict UTF-8, strict JSON with no duplicate
key) and answers only the form's fields (never a path, no audit line). The form then shows every value; Alice still checks each one.

Why a changed or forged invitation is caught before any coin is at risk:
1. Alice's program only checks form and range; she reads every value in her form, and her approval names both amounts.
2. Her bundle carries those terms; Bob's `new-bob` checks it against his own run.json and key (`check_bob_terms`): a changed amount, contract,
   version, address or key address is refused, so Bob gets no swap file and no check line.
3. Alice cannot approve before she records that Bob read her his line and it matches hers, and the autopilot funds only with that approval; a refused
   bundle gives Bob no line to read.
4. Before the funding nothing of hers is locked; under W a swap that does not start records its abort, and the deposit can be sent back to her own
   addresses.
5. An impostor who swapped both files meets the real Bob's line, which differs.
6. A different contract cannot run other code: `live.js` and `swap-cli` check its code hash.

**Defaults.** One pin per network (`swapform.PINNED_CONTRACT`, `pinFor`): the program's own Sepolia contract
`0x48Ce4D6cf3c175737532017e82B9261b51F8E5eF` (its code hash is still checked before any lock), none for the rehearsal chain; the settings'
`board.pinned_htlc` overrides it, for the form and the board alike. `POST /api/newswap {fields, remember}`: with `remember: true` (the tick "Use these
addresses for my next swaps", on by default) the person's own payout addresses are saved to the settings after the swap is made; a failed save never
undoes the swap. The form keeps network, contract version and contract under "Optional". Settings are grouped, with the rehearsal chain and the offer
board under a closed "Advanced" fold. An empty swap list shows "Before your first swap": six things to have ready, with the live node word and no link.

**If a swap cannot end.** An intent recorded after the approval and a seen deposit that is then never sent still needs `swap-cli intent --cancel`,
which the program has no step for. W makes it rare. When the engine's note shows it, the autopilot raises one needs-you entry pointing to the help
paragraph "If a swap cannot end", which gives the steps by hand.

Tests: `test/simple-*.test.js` (first steps, the watch rule with real tick output, the line match, Bob's statement, approving early, the invitation,
the dialogs and file routes, the engine texts, the form, the page's start screen, the deposit box, the guide).

**After the independent read (2026-11-19).** No path was found that moves coins without the one approval or around the dry run, the gate, the latch
or the audit line, and none that puts an invitation value or a settings address into a payout. Fixed, each with a test that fails without it
(`test/simple-review-fixes.test.js` unless named):
- A Prepare that ended with exit 6, or Bob's check with exit 9 or 10, leaves its swap file and one check line behind; the check line was written
  anyway, so the page offered Confirm and the approval on a step that had said "stop and look". `check-line.json` is now written only when the
  step's sealed standalone files are gone (Alice: `wallet-setup/noid-wallet.json` and `eth-key.json`; Bob: `eth-key.json`), which the steps delete
  only after every check passed; a link or a folder there counts as present.
- A swap made before this release and already funded or locked could not be approved again (the release raises the version, so its approval lapses),
  because the approval asked for a line match the page no longer offers past the handover. The approval asks for it only while the page can offer
  its Confirm box (`lineConfirmable`: Alice with no tick or at `created` and no funding marker; Bob with no tick or at `received`, `funded` or
  `funding_final`); a test checks for every phase that the page and the approval agree. The gate's rule for a funding or lock sent by hand is unchanged.
- The strict JSON reader (`programsettings.strictParse`, used by the invitation and the settings) compared raw keys, so a key written with a `\u`
  escape counted as new and the last value won; it now compares decoded keys (and keeps the hex digits of a `\u` escape it used to drop).
- `fundingBlocksLeft` gave 0 both for "0 blocks left" and for "closed", so the page said the window had closed while the engine could still fund;
  closed is now -1.
- The deposit box's "about to close" text and the first screen's "what happens if it stops here" promised that deposited coins go back by themselves;
  the sweeps and the recovery run by themselves only while the approval is in force. Both now say the coins can be sent back from the swap's page, and
  that the program does it by itself while it runs the swap (`test/program-page-boot.test.js` for the second).
- The deposit box showed as soon as the swap file existed, before the lines were confirmed; it now shows once the line match exists or the approval
  is in force.

Left (low):
- The needs-you entry "This swap cannot end by itself" is raised only while the approval is in force; with the autopilot off, or stopped on another
  needs-you after an intent was recorded, the page gives no pointer to the help. The apply loop also keeps running after a turnOff once it has
  applied (rule 4, by design).
- A settings `bob_noid` saved under the earlier label "Bob's Parano1d address (optional)" may hold the other person's address; it now prefills Bob's
  own "where the NOID you buy goes" (the Bob form prefilled from it before too). Nothing has been released with the old label.

## One card per stage (2026-11-19)

Bottom line: in program mode the swap page is one card with a progress line, one headline, one status line and at most one action. Today's page, whole,
is in a closed "Details" fold under it. Folding is drawing only: no request, server check, dry run, latch, audit line or coin path changed. The terminal
console and a board run keep their pages; a production run and a run without actions get no card either.

**What the card shows (`stagecard.js`, `window.NoidStage`).** Six stages in the progress line: Set up, Check, Approve, Deposit, Swap, Done. Alice's
card says, in turn: setting up; "Prepare the swap when Bob is ready" (the 25 minutes) with the Prepare button; "Send Bob your file, then compare check
lines" with the file for Bob and the check-line box; "Approve this swap" with the approval box; "Deposit 5.009 NOID and 0.001 ETH" with two rows (the
figure with Copy amount, the address with its copy button, seen or not yet) and her clock; "Deposit received"; "Waiting for Bob to lock his ETH"; "Bob
locked. Collecting your ETH"; and at the end "Swap complete", "The swap did not go through" or "This swap did not start". Bob's card is the same in his
words: his invitation (and Alice's file, both buttons kept), "Compare check lines with Alice", the approval, "Deposit 0.0012 ETH", "Waiting for
Alice's funding", "Your ETH is locked", "Collecting your NOID" and the same ends. The times in the status lines come from the view model's own deadline
rows ("about 14:32"); the card counts nothing anew. `plan(input)` is data only (no DOM, tested without a browser); `draw(plan, payload)` builds the elements.

**What is in Details.** Today's page as it was: its header (legs, capsules, profile), the alarms, the due strip with the engine's reason, notes and clock,
the timeline, the picture, "Plain words", the deadlines, "If the swap stops now", the receipts, the loop history, the run controls and the audit log.
Also the full deposit box (the exact figures, the leftovers line, "Read N s ago", the re-read button) and the approval box while it is on. When the
approval is off, the manual send boxes stay in Details (the expert path); only a step left at the end (a sweep, a recovery) with no approval in force is
drawn on the card, once.

**The boxes the card draws are the page's own.** The check-line box (with its handover), the approval box and the deposit rows come from the builders
that already exist (`checkLineBlock` and `handoverBlock`, `autopilotBlock`, `depositCompact`), so the statements, the typed amount and the gates do not
move. A box on the card is not drawn a second time in Details (it carries element ids, which must be on the page once): `plan().claims` names them and
`programFirstCard(view, payload, claims)` skips them.

**Safety boxes, always open above the headline** (never folded): the page's banners (key lost, the run folder's lock, a step still running with "quitting
now counts as may have been sent"), the autopilot's needs-you entries and "terms changed: approve again" (the approval box itself), the engine's loud
notes (ALERT, ALARM, ANOMALY) and danger alarms, a held step ("do not send it", and a decided step that must not be sent twice), and the newest send's
result when it has a warning, a refusal, a timeout or exit code 1 (with the advice), and the engine's lock-by or funding-window note when the view model
gives it the level "warn" ("is short"). The read-only alarm and the way back are in the swap bar, outside Details. The deposit's "do not deposit" words (no
clean status) stay in the deposit box. A coin that holds something but not enough has an alert line under its row on the card: "Short: this key holds 0.0011 ETH
of 0.0019 ETH; send 0.0008 ETH more."; when Bob's funding is final, or Alice's funding window is running, the status says the step waits only for this
deposit, with the engine's own note. While the approval is on, the autopilot's "Waiting for: …" is on the status line.

**Something needs a look.** When the card cannot place the swap it never shows a calm stage: it says "Something needs a look", gives the plain reasons,
marks no stage, offers no action and opens Details (once per set of reasons; a person who closes it is not overridden). Reasons: a swap that cannot be
read, a phase the page does not know, a lost swap, a reading that is stale or missing, two nodes that disagree or lag, a held step the engine does not
offer, an engine alarm, no approval in force after the lock or funding, an approval the program cannot offer, a deadline that has passed while the step
is still open (the reveal cutoff, the last moment to start the reveal, the claim target), the engine's lock-by or funding-window note at the level "danger" ("has
passed", "is closed"), and an aborted Bob whose lock is still open. A failed first step opens Details too. A lapsed approval in flight keeps the progress
line on Swap and shows the deadline of the step. If the card cannot be drawn, nothing is claimed and Details draws every box.

**The deposit once it is seen.** In Details the box becomes one line ("Deposit received: 5.009 NOID and 0.001 ETH.", chip "seen") and the full box sits in
a closed fold "Deposit details". A status that is no longer clean, or a coin that is short, draws the full box again in Details, and the card shows the stage "Deposit" with the short alert
(a headline "Wait before you deposit" when there is no clean status). The exact lines read "Exact amount
needed: 5,009,000 micro-NOID (the swap's 5 NOID and 0.009 NOID for the funding fee). This wallet holds … micro-NOID now."; the digits are grouped by one
helper (`groupAtoms`); Copy amount still copies the plain unit figure. The figures the join helper prints in "Your terms" are shown as it printed them.

**The width fix.** `.spend-box`, `.wallet-funding` and `.confirm-body` are one `minmax(0, 1fr)` column and their paragraphs break anywhere, so a 62-character
address no longer widens the box or the approval dialog (`test/simple-stagecard.test.js` checks the rule).

**The tones, the ticket and the picture (2026-11-20).** The card's frame has a tone chosen in `plan()` and tested there (`m.tone`): amber (`act`) while the swap waits on the person, mint (`done`) when it is settled, the alarm colour (`look`) for "needs a look", none while it is calm; an amber card has exactly one amber control or none. Beside the card (under it under 900 px) the ticket shows the two legs of the swap and the state of each lock, and under the card, from the Swap stage on and once a lock is seen on either chain, "The two locks, from now" shows both locks against the clock (an approval that lapsed in flight draws it too, with the amber band on the clock). Neither is a decision: the ticket reads `legsFor` and the picture reads `view.picture`, both from the view model's tables, and a card that says "needs a look" shows "Not known" for both legs and no picture. The ticket and the picture have their own headings and are outside `#pg-card`, which still holds exactly one `h2`. In Details the picture keeps its place with its own ids, and the advice about the run folder opens the fold. Details of the drawing and of each box are in "The look of the operator page" above.

Known low points, left as they are: a refused send with nothing sent shows as a red "last step" box on the card until another send replaces it (and a timed-out
step that later settled keeps its "may still have sent" line); the deadline warnings (`closing-*`), `tick-err`, `loop-exit` and the engine's caution notes are
in Details only, as the plan said; the working copy of `index.html` has CRLF line endings, which `.gitattributes` turns into LF on commit. For Alice waiting at `funding_final`, Bob's "lock-by … has passed" note is a look whose only reason is the engine's raw words about Bob's lock-by; one plain line ("Bob did not lock in time: your NOID comes back after about HH:MM") would say what it means for her. Also: a board run has no card (the board's own screens lead it); Bob's two first buttons (invitation, Alice's file) are both on the card, because
the page cannot tell whether the invitation was sent; the card reads the facts of the last reading, so for a moment after a step the headline can lag
the chain by one reading; the page is not looked at in a real window yet.

Tests: `test/simple-stagecard.test.js` (each stage per role, each safety box, never a calm stage on data it cannot place, the deposit collapse and its
exceptions, the wording and the grouped digits, the CSS rule); `test/simple-split.test.js` pins the script order, and the program-page tests load
`stagecard.js` like the page does.

## A short deposit after the approval (2026-11-20)

Bottom line: once a role's approval is in force, a deposit that is short or missing is a "needs you" entry. It is shown on the page and in the tray, and the
audit log gets one line. Before, a short deposit after the approval stopped the swap without a word: in rehearsal 4.11 Bob's first ETH deposit was short of
the reserve and the swap waited about 40 minutes. Nothing in this changes a send: the watcher (`lib/autopilot.js`, `watchDeposits`) reads the wallet status
and the tick, and writes only audit notes.

**When an entry is raised.** A wallet run only. The approval is in force and the role's first spend (Alice's funding, Bob's lock) still waits for the
deposit. A coin that holds something but not enough raises "Your ETH deposit is short: this swap's key holds 0.0011 ETH of 0.0019 ETH. Send 0.0008 ETH
more to 0x…." at once. A coin that holds nothing raises "Deposit now: …" only when the engine's own lock-by or funding-window note is short. The amounts and the
address come from the wallet status the deposit box shows (`FS.depositReasonsFor`).

**When it goes.** Only when the coin is covered, the role's first spend has started (Bob's `send-lock` latch; Alice's `send-fund` latch or her funding
marker), a known later phase is seen, or the approval ends. A stale, broken or missing tick, a wallet status that is not clean, or a node that is down
keeps the entry as it is, with no new line (no flapping). After the first spend has started the balance no longer means a missing deposit, so no "send
more" is raised then.

**When the engine has given up.** A height abort, a closed funding window or a last lock height that has passed gives no instruction to send coins. An
open entry becomes one line: "The engine says it is too late for this swap: do not send coins to it.", with the engine's note and no amount or address.
That line goes only when a fresh, readable tick no longer says it, or with the phase or the approval. The engine's "nominal lock-by … has passed; still
allowed until …" forms are a warning: the entry stays.

**The time left.** An entry stores the seconds the engine's note gives (its block count at 20 s a block) and the time of the tick it came from. The page
draws it as its own line, outside the alert box, and counts it down. It shows only while that tick is under 120 s old, only for the funding window, the
lock margin or a lock-by note with an exact last lock height; "Under a minute left." below one minute. The board shows the reason without the time.

Tests: `test/simple-short-deposit.test.js` (Bob's live case, Alice's short NOID, after the lock, clearing, the approval withdrawn or lapsed, stale and broken
ticks, the node down and back, the closed line, the time line and its countdown).

After rehearsal 4.12 (where this entry ran live: raised 13 s after a short deposit's block, cleared when the top-up was seen) the entry names the
deposit address whole, as the deposit box does (it was shortened to 6 + 5 characters). Where an entry lives: in memory and in the audit only (one
"needs you: deposit-…" line when raised, one "cleared: deposit-…" line when it goes); `autopilot-ROLE.json` keeps `needs_you` for the spends only, so it
shows `[]` while a deposit entry is open, and after a restart the entry comes back with the next clean wallet status.

Known low points, left as they are: the watcher reads the run folder once more
on each 3 s step; the time is an estimate at 20 s a block, as the engine's own notes are; the observe-only refusal is recognised by its text (a changed
wording would show as an error, never as an apply); on a board run, Bob's "nothing funded" turns false as soon as Alice's funding is observed, which only
makes the board more careful.

## Fix round 1 of the new look (2026-11-20)

Two independent checks of the new look gave must-fix, should-fix and low points; this is what changed, in the page's own terms. Nothing here sends or decides; `test/fix-round-1.test.js`
holds the new tests, and the existing tests that pinned the old words were updated.

- **The ticket and a secret that may be public.** The view carries `secret_may_be_public` (Alice at `lock_seen` or `lock_final` with a reveal in the mempool, a held reveal or a claim
  seen on the lock: the same fields the picture already used). `legsFor` then gives her NOID leg "Bob can take it" with a note that she can lose both legs if she stops, never "comes back
  to you", and her ETH leg "Not known"; the key under the legs says "secret may be public". Before the first reading the ticket's amounts come from the list's summary of the swap
  (`give` and `get`, read from `run.json`), never from a figure made up; with neither source there is no amount line. The trust line no longer promises both-or-neither: "Non-custodial:
  your coins are held by this swap's own wallet and contracts, never by a third party." An aborted swap's ticket says what the card says (the NOID comes back, or nothing was locked),
  only from the view's own coins at the contract.
- **One amber control.** While the card holds a step's button (`plan().claims.step`: Prepare, Try again, the invitation, Choose Alice's file) Details has no strip with a button, no list of
  steps and no button in Bob's invitation box (the addresses and the warning stay); the strip keeps only the last result of a failed step. A test walks the stages and checks that Details
  holds no primary button whenever the card does.
- **Deposit address.** Shown whole on the deposit rows, wrapped at any character in the mono face, with its copy button (the payout addresses of the ticket stay shortened; the full ones
  are in the approval's facts and under Details).
- **Forms.** An amount field's accessible name is its label and its coin ("You give NOID", kept right when the side changes), a field with an error is `aria-invalid`, and the
  placeholders are a faint "0".
- **Focus.** Opening a swap puts focus on its title in the breadcrumb (no ring). The approval's dialog opens on its title, not on the confirm button, and in program mode says "Approve
  this swap", "Yes, approve", "the program" and "a step sent by hand"; the terminal console keeps its words.
- **The engine's words on the main view** (display only; Details keeps the raw text): `plainEngine` drops a leading ALERT:, ALARM: or ANOMALY: in the safety boxes, leaves "(lock-by N, tip M)"
  out of the deposit status line, and says "before the deadline" for "before D" (not for an expression such as "D - 19"); the foot names a running step by its plain name ("Locking your ETH")
  from the board's table when the program has no record's label; the needs-you line reads "Lock the ETH: the dry run does not match the terms".
- **The done card** has the two blocks "You gave" and "You got", and two rows (the amount left over and the fee of that transfer) only when an Ethereum sweep's own result file has the
  figures; the NOID sweep's result has none in the payload, so it has no row. Receipts are called by what they are ("Bob's lock, on Ethereum", "Your reveal, on Ethereum", "Your funding, on
  Parano1d", "Sweep to your address, on Ethereum"), from a `kind` on each receipt of the view model, and keep their ids.
- **Smaller:** a lapsed approval's Approve node wears the amber ring and the rail into it is the done rail (`data-due`, not a new class on the `li`); the list's state and chip columns are
  fixed tracks and a swap that ended but still needs the person stays above "Ended"; the folds under Details wear the page's chevron, the strip no longer indents the boxes in it, and the
  advice about the run folder is said once; copy buttons draw the copy icon (never a text glyph), at least 24 px tall; the foot says "Nothing for you to do." only while the program is
  driving; Details' picture draws the amber band whenever the strip is "your move" again; `.chip.warn` has its colour in a box; quiet buttons' edge is `--edge`; dead code removed.

Low points, left (the NOID row was added later, see "Leftovers of the new look"): the done card has no total of the fees paid (the mock's "Network fees paid"); the lock-by
box and the "Held" box still carry the engine's words about heights and "lock-by" (they are boxes of facts, and Details has the same text); the amber rail of the "your move" strip under
Details stays while the card holds the action in flight (it is a rail, not a control); the focus on a swap's title is taken once, when it opens, and a later full redraw of the bar drops it.

## Leftovers of the new look (2026-11-20)

Display only; `test/leftovers-1.test.js` holds the tests, and two older tests that pinned "so the autopilot is off" now say "so it is off". Nothing here decides or sends.

- **The program's words.** Every answer of the program's request handler (`server.js`, the one place on the way out that also hides the data and home folders) now goes through `lib/programwords.js`: in string values, "this console", "the console" and "the autopilot" read "the program", and the approval statement "No step of this swap is sent by hand outside this console while the autopilot is on." reads "... outside the program while it is approved.". Keys, file names (a phrase followed by `-`, `/`, `` or `.x` is never rewritten) and the files on disk are not touched; the audit lines are rewritten on the page (the payload's audit tail passes the rewriter) and kept as they are in the file on disk. The terminal console never passes through it. The statement phrase is replaced as a whole first, so the refusal that quotes it reads like the checkbox. The module also loads in the page (`window.NoidProgramWords`, `/programwords.js`), where it rewrites the texts the page's own view model builds (the coins box and the abort rows said "the console"). The page's own texts for the needs-you box, the "I have dealt with it" dialog, the Turn off hint, the "approve again" lines and the "funding is not offered yet" line have a program variant in `actions.js`.
- **Automatic steps.** Where the autopilot's own switch is meant, program mode says "automatic steps" so that nothing reads as quitting the app: "Stops the automatic steps.", "so automatic steps are off", "automatic steps are already on for Bob: turn them off first".
- **No alarm box twice under Details.** The same engine note twice in one tick is one loud note (`viewmodel.js`); the alarms list drops an alarm that repeats an earlier one, and, in program mode, one made of the engine's reason (the strip quotes the reason whole) or the "Intent ... is held" alarm (the strip has its own box for the intent), and only when the stage card is really drawn (`state.cardShows`: a board or production run has no card, so its red boxes stay); the card does not list the same danger alarm twice. Details keeps the engine's own text; the card still says the same in plain words above it, by design.
- **The done card's NOID row.** The figures were already in the payload: the job's output of Alice's NOID sweep holds the step's report lines (`amount_micronoid`, `fee_micronoid`, `payout_swap_file`, `outcome sent`). The done card reads them (`noidSweepOf` in `stagecard.js`) and shows "Left over, sent to you (confirming)" (the node has accepted the sweep; it is not known to be mined) with the NOID amount and the address of the tool's own `target` line, and "Network fee of that transfer"; when an Ethereum sweep has rows too, the NOID ones read "Left over NOID, sent to you" and "Network fee of the NOID transfer". A sweep that sent nothing, or found it done, gives no row. No change to `swap-cli` or `eth/`.
- **The page-wide note** is not a low point any more: it is inside Details once on a swap's page and the footer of the list and the forms (fix round 1, `test/look-card.test.js`).

Left: the total of the fees paid over the whole swap is still not shown (no figure for the lock, reveal and claim fees reaches the card); the figures come from the job records in memory, so after a restart of the program the done card has no leftover rows (the Ethereum rows are the same); the two drops apply only in program mode with a card; the words of the lock-by and "Held" boxes still carry the engine's heights.

## Mainnet in program mode (2026-11-20)

Program mode (and only program mode) now acts on `production`: Ethereum mainnet, chain 1. Built and tested offline; nothing of it has run on a network.

**What opened.** run.json's profile `production` with chain 1 (`lib/runsettings.js`, `productionRules`), the new-swap form's "Ethereum mainnet" choice, the mainnet chip ("Ethereum mainnet: real funds" in the bar, "Mainnet: real funds" on a swap's row), the mainnet fee settings on the Ethereum spend steps, the invitation file for mainnet (`"network": "mainnet"`, contract version 1 only), and `eth.production` in the program settings (defaults `https://ethereum-rpc.publicnode.com` and `https://rpc.mevblocker.io`; a settings.json written before it loads with those filled in; the settings page says what each endpoint sees).

**Caps.** At most 2,500 NOID and 0.5 ETH per swap (`lib/swapform.js` `PRODUCTION`). They are enforced by run.json's schema on the server, at creation and on every load of the file (the form only shows them); swap-cli's production profile carries the same two caps as a second layer.

**The same rules as the schema.** On production run.json needs a fee cap (`gas_price_gwei` is the mainnet fee cap, default 1 gwei, tip 0.05 gwei, both in the approved bytes), contract version 1, `eth_rpc2` (two Ethereum nodes), `single_node_ok` false, no board handover, and for Bob a `noid_rpc2` unless his `noid_rpc` is on this machine. The Ethereum spend steps pass `--mainnet --max-fee-gwei CAP` (+ `--priority-fee-gwei TIP`), never `--gas-price-gwei` (`lib/steps/common.js`).

**The check that replaced "any production refuses".** `lib/production.js` `programNetworkReason`, used by `ActionRunner.productionBlock` in program mode: run.json, the bundle's terms (profile and chain) and every tick (`eth.chain_id`, `swap_terms.eth.chain_id`) must name the same network. A Sepolia run.json with a chain-1 bundle or tick, and the reverse, is refused. A file that fails the schema and says production (or chain 1) anywhere is still refused with the production text. The page no longer draws its own production read-only box in program mode (`input.program`); the server's refusal text is shown.

**The acknowledgement (Bob).** Bob's approval on production adds the statement "One address mined N % of Parano1d's recent blocks; I accept a share up to 65 %. If Alice controls most of the mining she can take both sides. I swap only with someone I have a reason to trust." with the measured share filled in. The approval is refused up front (422, `producer_screen`) when the tick he last wrote shows a reason the flag cannot waive: no reading yet or incomplete, a stale reading, a second node that disagrees or cannot be read, a remembered disagreement, a share above 65 %, or no second Parano1d node when his node is not on this machine (`lib/producerscreen.js`, structured tick fields only; anything missing is a refusal). While the approval is in force and holds the statement, `Autopilot.producerAckPermille()` answers 650 and Bob's ticks and his lock step pass `--acknowledge-producer-share 650` (`ctx.producerAck`); never on the claim, never for Alice, never on a test network. The flag is swap-cli's (added separately); until it exists a production tick of Bob's is refused by swap-cli.

**Still refused.** The board on production (`BoardHost.onMainnet` in the three places, the board settings, the autopilot's board check, and the schema's "no handover"), the terminal console (actions mode without program mode: `production.js` `productionReason`, unchanged), migration of an old production `env.local.sh`, contract version 2, the stock variant and the sha256 lock kind. The production contract pin (`PINNED_CONTRACT.production`) is the mainnet deployment of the committed poseidon artifact (2026-11-20, `0x4e364cC86EdBF307CC6F336F3a72e1a24d284D70`, block 26,459,748, from a deploy key used for nothing else); no setting overrides it, and swap-cli and live.js check its code hash as for any contract. Version 0.1.5: an approval given under 0.1.4 lapses and is asked again.

**Fix round 1 (review of the opening).**

- **A stuck reveal or ETH refund can be re-sent at a higher fee cap (M1).** A re-send needs a cap above the one it replaces, so the same cap is refused by live.js whatever the base fee is. The four re-send ids (`dry-reveal-replace`, `send-reveal-replace`, `dry-refund-eth-replace`, `send-refund-eth-replace`) now carry `new_cap_gwei` in the body of `POST /api/action` and `POST /api/spend`: a decimal string in gwei, REQUIRED for those four ids in program mode and refused (400) for every other id and in the terminal console. The server (`ActionRunner.newCapFor`) decides: strictly above run.json's cap, at most 300 gwei on mainnet and 1,000 on a test network (fix round 2: the first version's "at most 20 times it" rule is gone) (a test run with no cap: only the ceiling); anything else is a plain 422. The step gets the new cap in place of `gas_price_gwei` for that step only (`--max-fee-gwei NEW` on mainnet, `--gas-price-gwei NEW` on a test network); run.json's tip and run.json itself are never written (live.js raises a replacement's tip by itself, see fix round 2), the first send and every other step keep the approved cap. The dry run and the send are bound by their words (`step ID replacing HASH at fee cap N gwei`): a dry run made at one cap never authorizes a send at another. The audit lines of both say `fee cap: approved A gwei, new N gwei`. The typed amount rule and the dry-run hash rule of the gate are unchanged. The autopilot never raises a cap. `view()` gives each re-send spend `new_cap: { approved_gwei, min_exclusive_gwei, max_gwei }` (what the page needs to draw its field; the server decides) and `dry_new_cap_gwei` (the cap the held dry run was made at). The swap key must hold gas limit times the new cap: the page says so from the launch facts; the dry run's own refusal reaches the page as before.
- **Bob's ticks before his lock write no producer latch (S1).** In the watch loop (`steps/watch.js`, `common.js` `readingOnlyForAck`), for Bob on production while his approval is off or lapsed (no acknowledgement flag), his phase is `received`, `funded` or `funding_final` (no tick read yet counts as before) and no lock send was ever started for this swap, the round runs the tick read-only (no `--apply`) and its loop line says "Reading only: your approval is off, so nothing is recorded until you approve again." A lock send counts as started when the program's audit has a `send-lock` start line that a clean "refused, nothing sent" end line did not close, or when `bob/bob.swap.json.lock-sent` exists (`stepexec.js` `lockEverSentIn`); an audit that cannot be read counts as started. Once a lock send was started the loop keeps its applied ticks, so a swap whose lock was sent (or may have been) is recorded: there a latch from a tick without the flag is a false alarm at worst, and it would also refuse a re-send of a dropped lock.
- **Smaller points.** `isLoopbackUrl` accepts `http://` only (swap-cli's rule); Bob's statement now names the 65 % ceiling; on mainnet the tip is at most 2 gwei and at most the cap (schema and form); the desktop node check asks the Ethereum mainnet endpoints only while a run of the runs folder has profile `production` or within ten minutes after the page asked for the production fee (`GET /api/program?want=mainnet-fee`, sent by the new-swap form while its profile is mainnet; `program.wantMainnetFee()`), otherwise `nodeStatus().eth.production` is `{ state: "idle" }` and the Sepolia chip no longer depends on the mainnet operators; `release-key.js sign` refuses a key file whose public key differs from the one compiled into `releasekey.js` (when set) and a notice whose version differs from `desktop/package.json`, and warns when a listed hash is not in a `SHA256SUMS.txt` beside the notice.
- **Known limits, not fixed.** (L6) The update check reads only the notice of the highest release tag: a higher tag that carries no valid signature (anyone who controls the release page can list one) shows "unverified" and hides a signed notice, with its raised `oldest_safe_version`, of a lower one; `docs/release-key.md` already says the hosting account can hide a release. Walking down to the highest tag with a valid notice would narrow it. No way was found to announce a version, hashes or a note without the key, or to lower the kept floor. (L7) With one local Parano1d node (the default on mainnet, where the schema forces `single_node_ok` false) the engine's rare paths that want a second node cannot be met: the `lost` verdict, the alive-at-`D` trace and the adoption of a re-created instance for Alice's recovery (its note tells the person to pass `--single-node-ok`, which the schema forbids). D2's waiver covers Bob's lock only. The normal settle and abort paths do not pass through them.

**Fix round 2 (second review of the opening and the launch screens).**

- **A stuck or unknown reveal is never "Safe" (M1).** `lib/needtext.js`: for `send-reveal` and `send-reveal-replace` with kind `stuck` or `outcome` the entry's coins line is at the danger level: "Not safe yet. The secret may already be public. Your reveal must be in a block before about HH:MM, or Bob can take the NOID as well as his ETH back." (the time is the `t_reveal` row, not the reveal cutoff; without the row the clause reads "in a block in time"; no second until line repeats the time), the entry has a button "Show the re-send box" that opens Details and puts the cursor in the box's fee field, and for kind `stuck` the steps are: re-send now from the box at a higher cap, send more ETH to the swap key first if the box asks, press I have dealt with it after it is mined (kind `outcome` keeps its steps: there is no known transaction to replace). A lock or funding entry of kind `outcome` no longer says "nothing is locked yet": it says the coin is either in the swap's own wallet or key or locked in the contract, and that both can come back.
- **The read-only round is narrow again (S1, L2).** `common.js` `readingOnlyForAck` is true only while the last tick the loop read shows a held or recorded `lock_eth` intent (`"intent": {"status": "held"|"recorded", "intent": {"action": "lock_eth"}}`: the one state in which the engine writes the producer latch) and the other conditions of fix round 1 hold (Bob on production, no acknowledgement, phase before the lock, no lock send ever started). In every other case the applied tick runs as on a test network, so Rule W's height abort is recorded and a swap whose lock-by passed ends and can be swept. If the last tick cannot be read, the intent state the loop last saw is used. The acknowledgement is asked of the program once per round (`Watch.decideRound`) and the same flags are handed to the tick step (`opts.ackFlags`: only the empty list or the one flag pair is taken), so an approval removed between two reads cannot give an applied tick without the flag.
- **A re-send prefill that can pass (S2).** The re-send box (`ui/app/actions.js` `resendCap`) fills the larger of the approved cap times 1.25 and (2 x the swap's fresh base fee + the re-send's tip) plus 10 %, rounded up to two decimals and clamped into the server's bounds (1.25 x alone when the base fee is not known or old). Before the first dry run it says what the swap key must hold and, when the wallet status is known, what it holds now. It says that the transaction pays Ethereum's fee level plus the tip, never the cap.
- **The re-send's tip (L3).** `live.js` raises the tip of a replacement to the larger of min(cap, 1 gwei), the given tip and the old tip plus 12.5 %; the box says "A re-send also raises the tip to about N gwei". The step still gets the new cap only; run.json's tip is not changed.
- **The new cap's bounds (L4).** The new cap must be strictly above the approved cap and at most 300 gwei on mainnet, 1,000 on a test network; the old "at most 20 times" rule is gone (a high cap costs nothing beyond the balance the key must hold). New mainnet swaps are made with a cap of at most 100 gwei (checked when the swap is made, see L8).
- **The payout history counts settled swaps (L5).** The history of the person's own addresses is written when the swap is done (`SwapSet.noteSettled`), not when it is made; "Used for N swaps" counts settled swaps. Writing is idempotent per swap.
- **The receipt read (L6).** `lib/settlement.js`: the node is asked with `redirect: "error"`, its answer is read to at most 64 KiB, and each receipt's fee is kept in `settlement.json` beside the swap (written beside and renamed over, owner-only; read before the node is asked again), so a restart sends no hash again.
- **Schema rules at create only (L8).** The `http://` only to a loopback node, the mainnet tip of at most 2 gwei and the mainnet cap of at most 100 gwei are checked when a swap is made (`runsettings.validate(obj, { create: true })`, `newSettings`, `write` with `create`), never when a `run.json` is loaded: a file that passed before a tightening can still be opened, refunded and swept.
- **Record a close (batch D).** After "Recorded" the page loads the swap again at once.

**The look of the launch screens (a read of the screenshots at 1280 and 380 px, one fix round).** Tests: `test/visual-fix.test.js`.

- **No calm footer beside a danger box.** The card's footer says "Nothing for you to do." only when nothing on the card needs the person; Bob's late claim counts, and the footer's dot takes the alarm colour while a late claim, a danger alarm, a loud note or a failed last step is on the card.
- **A stuck reveal's entry** has a button "Show the re-send box" that opens Details and puts the cursor in the box's fee field; its coins line says "Your reveal must be in a block before about HH:MM" once (no second line repeats the time); an entry's title has no colon.
- **The ticket at the end.** Alice's ETH leg at `done` says "In this swap's key, sending to you", with no tick, until the ETH sweep's marker exists; her NOID leg says "Taken by Bob" once Bob's claim is final and the contract is read empty.
- **One "back by" time.** The card, the approval, the ticket and the list row use the same "back by about HH:MM" (`needtext` `backFrom`, `bobBack`); the Details timeline keeps its block counts.
- **Fees.** The approval's deposit row is "Kept back for fees" (what is not used comes back with the sweep), not a second "Network fees"; the done card says the amounts are the swap itself and where the fees came from, and Alice's sweep row is "Reached your address".
- **Above half of the blocks**, Bob's lock line on the Check stage adds a sentence in the warning style: more than half means someone who controls most of the mining can take both sides; nothing is refused by it.
- **Smaller points.** The full stop after a whole address stays with its last group; display copies of amounts are grouped (the typed line keeps the digits the field accepts); the compare tick sits next to its label; the record-close button has a hairline edge, its not-final refusal says "Try again once it is final.", and after "Recorded." the dialog hides its label; the rate row is joined with "; "; the list's "Read only" is a warn chip; the new-swap form's estimate on a test network with no gas price uses the default cap of 1 gwei and says so; the network names are shorter so the select fits at 380 px; "Approved HH:MM" without seconds in program mode.
